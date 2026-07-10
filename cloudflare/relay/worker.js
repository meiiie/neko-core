/**
 * Neko remote-relay Worker — a SELF-HOSTED rendezvous so you can drive your local Neko from any phone or
 * browser (no Tailscale, no open port on your machine). Your local Neko dials OUT; your phone POSTs
 * instructions here; this Worker just routes them. Because it's YOUR Worker (not a vendor's), it sees
 * only what passes through — and with end-to-end encryption (see README) it sees only ciphertext.
 *
 * v2 transport: the host connects a WebSocket (hibernatable - the Durable Object SLEEPS between
 * messages, so an idle relay costs ~nothing on the free plan, where the old 1s long-poll kept it awake
 * 24/7). Jobs push to the host instantly; the host streams PARTIAL replies back so the phone watches
 * the answer grow; an /interrupt from the phone reaches the host mid-turn. The v1 long-poll endpoints
 * (/pull, /reply) are kept so an older Neko binary still works against this Worker.
 *
 * One Durable Object per session. Token + job queue + results live in DO storage, so an eviction
 * (laptop asleep, quiet hours) no longer silently kills the session. Endpoints (all require
 * `Authorization: Bearer <token>` except `/` and the host's /ws which authenticates via subprotocol):
 *   POST /register {session}              host announces a session (first token wins; binds durably)
 *   GET  /ws?session=...                  host WebSocket (subprotocol "t.<token>"); jobs/replies as JSON
 *   POST /send  {session,message} -> {id} client submits an instruction
 *   GET  /result?session=&id=&seen=<seq>  client long-polls; 200 {reply,done,seq} on any NEW state
 *   GET  /alive?session=...               {online} - is a host connected (or v1-polling) right now?
 *   POST /interrupt {session}             ask the host to abort the running turn (v2 hosts only)
 *   GET  /pull · POST /reply              v1 host long-poll (compat)
 *   GET  /                                minimal phone web client (client.html)
 */
import CLIENT_HTML from "./client.html";

const LONG_POLL_MS = 25_000;
const KEEP_RESULTS = 20; // ring of stored results per session (a phone may re-poll after a reconnect)

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/client") {
      return new Response(CLIENT_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    const session = url.searchParams.get("session") || (await peekSession(request));
    if (!session) return json(400, { error: "missing session" });
    const id = env.RELAY.idFromName(session);
    return env.RELAY.get(id).fetch(request);
  },
};

async function peekSession(request) {
  // /register and POST bodies carry the session in the body; clone to read it without consuming.
  if (request.method !== "POST") return null;
  try {
    return (await request.clone().json()).session ?? null;
  } catch {
    return null;
  }
}

function json(status, obj) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}

/** Per-session routing. Durable state (token, queue, results) in storage; waiters in memory (they
 * only exist while a request is in flight, which keeps the DO awake anyway). */
export class RelaySession {
  constructor(ctx) {
    this.ctx = ctx;
    this.hostWaiters = []; // v1: resolve fns for GET /pull
    this.clientWaiters = new Map(); // id -> [resolve fns] for GET /result
  }

  async boundToken() {
    return (await this.ctx.storage.get("token")) ?? null;
  }

  async authed(request) {
    const a = request.headers.get("authorization") || "";
    const tok = a.startsWith("Bearer ") ? a.slice(7) : "";
    const bound = await this.boundToken();
    return !!(tok && bound && tok === bound);
  }

  hostSocket() {
    const ws = this.ctx.getWebSockets("host");
    return ws.length ? ws[0] : null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const tok = (request.headers.get("authorization") || "").replace(/^Bearer /, "");

    if (path === "/register" && request.method === "POST") {
      const bound = await this.boundToken();
      if (!bound) await this.ctx.storage.put("token", tok); // first registration binds - durably
      else if (bound !== tok) return json(401, { error: "session bound to a different token" });
      // kid = the E2E secret's public fingerprint; the client compares it to ITS secret's fingerprint
      // via /alive and can flag a stale/mistyped secret BEFORE sending anything.
      const { kid } = await request.clone().json().catch(() => ({}));
      if (kid) await this.ctx.storage.put("kid", String(kid).slice(0, 16));
      return json(200, { ok: true, v: 2 }); // v:2 tells the host the WebSocket channel exists
    }

    // Host WebSocket: token rides the subprotocol ("t.<token>") - portable (no custom headers needed)
    // and never in the URL. Hibernatable: the DO sleeps between frames.
    if (path === "/ws") {
      if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
        return json(426, { error: "expected websocket" });
      }
      const protos = (request.headers.get("sec-websocket-protocol") || "").split(",").map((s) => s.trim());
      const t = (protos.find((p) => p.startsWith("t.")) || "").slice(2);
      const bound = await this.boundToken();
      if (!bound || t !== bound) return json(401, { error: "unauthorized" });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], ["host"]);
      await this.flushQueueTo(pair[1]); // anything sent while the host was away
      return new Response(null, { status: 101, webSocket: pair[0], headers: { "sec-websocket-protocol": "neko-relay" } });
    }

    if (!(await this.authed(request))) return json(401, { error: "unauthorized" });

    if (path === "/alive") {
      const lastPull = (await this.ctx.storage.get("lastPull")) ?? 0;
      const kid = (await this.ctx.storage.get("kid")) ?? null;
      return json(200, { online: !!this.hostSocket() || Date.now() - lastPull < 40_000, kid });
    }

    if (path === "/send" && request.method === "POST") {
      const { message } = await request.json();
      const n = ((await this.ctx.storage.get("counter")) ?? 0) + 1;
      await this.ctx.storage.put("counter", n);
      const job = { id: `j${n}`, message };
      const ws = this.hostSocket();
      const w = this.hostWaiters.shift();
      let delivered = false;
      if (ws) {
        try { ws.send(JSON.stringify(job)); delivered = true; } catch { /* socket died mid-send */ }
      }
      if (!delivered && w) delivered = (w(job), true);
      if (!delivered) {
        // Host away: queue durably so the instruction survives an eviction and lands on reconnect.
        const q = (await this.ctx.storage.get("queue")) ?? [];
        q.push(job);
        await this.ctx.storage.put("queue", q);
      }
      return json(200, { id: job.id });
    }

    if (path === "/interrupt" && request.method === "POST") {
      const ws = this.hostSocket();
      if (ws) ws.send(JSON.stringify({ t: "interrupt" }));
      return json(200, { sent: !!ws }); // v1 hosts poll serially - nothing can reach them mid-turn
    }

    if (path === "/result") {
      const id = url.searchParams.get("id") || "";
      const seen = Number(url.searchParams.get("seen") || 0);
      const r = await this.ctx.storage.get(`r:${id}`);
      if (r && r.seq > seen) return json(200, r);
      return new Promise((resolve) => {
        const arr = this.clientWaiters.get(id) || [];
        const t = setTimeout(() => { remove(arr, give); resolve(new Response("", { status: 204 })); }, LONG_POLL_MS);
        const give = (result) => { clearTimeout(t); resolve(json(200, result)); };
        arr.push(give);
        this.clientWaiters.set(id, arr);
      });
    }

    // ---- v1 host long-poll (compat: an older Neko binary keeps working against this Worker) ----
    if (path === "/pull") {
      await this.ctx.storage.put("lastPull", Date.now());
      const q = (await this.ctx.storage.get("queue")) ?? [];
      const job = q.shift();
      if (job) {
        await this.ctx.storage.put("queue", q);
        return json(200, job);
      }
      return new Promise((resolve) => {
        const t = setTimeout(() => { remove(this.hostWaiters, give); resolve(json(200, {})); }, LONG_POLL_MS);
        const give = (j) => { clearTimeout(t); resolve(json(200, j)); };
        this.hostWaiters.push(give);
      });
    }
    if (path === "/reply" && request.method === "POST") {
      const { id, ...rest } = await request.json();
      await this.storeResult(id, rest.reply ?? rest, true, rest);
      return json(200, { ok: true });
    }

    return json(404, { error: "not found" });
  }

  /** Host WebSocket frames: {t:"reply"|"partial", id, reply, tokens?, ms?}. */
  async webSocketMessage(ws, raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || !m.id) return;
    if (m.t === "reply") await this.storeResult(m.id, m.reply, true, m);
    else if (m.t === "partial") await this.storeResult(m.id, m.reply, false, m);
  }

  webSocketClose() { /* nothing held per-socket; getWebSockets() simply stops listing it */ }
  webSocketError() { /* ditto */ }

  /** Store a result update (seq bumps every time) and wake any /result long-pollers. */
  async storeResult(id, reply, done, extra = {}) {
    const prev = (await this.ctx.storage.get(`r:${id}`)) ?? { seq: 0 };
    const r = { reply, done: !!done, seq: prev.seq + 1 };
    if (extra.tokens !== undefined) r.tokens = extra.tokens;
    if (extra.ms !== undefined) r.ms = extra.ms;
    await this.ctx.storage.put(`r:${id}`, r);
    if (!prev.seq) await this.trimResults(id); // first write for this id -> maintain the ring
    const ws = this.clientWaiters.get(id) || [];
    ws.forEach((give) => give(r));
    this.clientWaiters.delete(id);
  }

  /** Keep only the newest KEEP_RESULTS result ids (a phone may re-poll finals after a reconnect). */
  async trimResults(newId) {
    const ids = (await this.ctx.storage.get("rids")) ?? [];
    ids.push(newId);
    while (ids.length > KEEP_RESULTS) {
      const old = ids.shift();
      await this.ctx.storage.delete(`r:${old}`);
    }
    await this.ctx.storage.put("rids", ids);
  }

  /** On host (re)connect: deliver everything queued while it was away (keep what fails to send). */
  async flushQueueTo(ws) {
    const q = (await this.ctx.storage.get("queue")) ?? [];
    if (!q.length) return;
    const undelivered = [];
    for (const job of q) {
      if (undelivered.length) { undelivered.push(job); continue; }
      try { ws.send(JSON.stringify(job)); } catch { undelivered.push(job); }
    }
    if (undelivered.length) await this.ctx.storage.put("queue", undelivered);
    else await this.ctx.storage.delete("queue");
  }
}

function remove(arr, fn) {
  const i = arr.indexOf(fn);
  if (i >= 0) arr.splice(i, 1);
}
