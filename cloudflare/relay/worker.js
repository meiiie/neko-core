/**
 * Neko remote-relay Worker — a SELF-HOSTED rendezvous so you can drive your local Neko from any phone or
 * browser (no Tailscale, no open port on your machine). Your local Neko dials OUT; your phone POSTs
 * instructions here; this Worker just routes them. Because it's YOUR Worker (not a vendor's), it sees
 * only what passes through — and with end-to-end encryption (see README) it sees only ciphertext.
 *
 * v4 mirror: the default pairing is scoped to one Neko conversation and the browser replays its
 * durable semantic transcript, then receives live stream/activity events. The v3 multi-session hub
 * remains available explicitly; all content and metadata stays E2E ciphertext to this Worker.
 * v2 transport remains underneath: each host connects a WebSocket (hibernatable - the Durable Object SLEEPS between
 * messages, so an idle relay costs ~nothing on the free plan, where the old 1s long-poll kept it awake
 * 24/7). Jobs push to the host instantly; the host streams PARTIAL replies back so the phone watches
 * the answer grow; an /interrupt from the phone reaches the host mid-turn. The v1 long-poll endpoints
 * (/pull, /reply) are kept so an older Neko binary still works against this Worker.
 *
 * One Durable Object per paired capability. Token + per-host queues + results + bounded mirror events live
 * in DO storage, so an eviction
 * (laptop asleep, quiet hours) no longer silently kills the session. Endpoints (all require
 * `Authorization: Bearer <token>` except `/` and the host's /ws which authenticates via subprotocol):
 *   POST /register {session,hostId,meta}   host announces a session (first token wins; meta is ciphertext)
 *   GET  /ws?session=...&host=...         host WebSocket (subprotocol "t.<token>"); jobs/replies as JSON
 *   GET  /client-ws?session=...&host=...  read-only browser mirror WebSocket; replay then live events
 *   GET  /sessions?session=...            list opaque host ids, encrypted metadata, and online state
 *   POST /send  {session,hostId,message}  client submits an instruction to one host
 *   GET  /result?session=&id=&seen=<seq>  client long-polls; 200 {reply,done,seq} on any NEW state
 *   GET  /alive?session=...&host=...      {online} - is that host connected (or v1-polling)?
 *   POST /interrupt {session,hostId}      abort that host's running turn (v2+ hosts only)
 *   POST /revoke {session}                invalidate a rotated capability and close every socket
 *   GET  /pull · POST /reply              v1 host long-poll (compat)
 *   GET  /                                minimal phone web client (client.html)
 */
import CLIENT_HTML from "./client.html";

const LONG_POLL_MS = 25_000;
const KEEP_RESULTS = 20; // ring of stored results per session (a phone may re-poll after a reconnect)
const KEEP_MIRROR_EVENTS = 400;
const MAX_MIRROR_BYTES = 1_500_000; // SQLite-backed DO values cap at 2 MB; leave serialization headroom.
const MAX_HOSTS = 32;
const DEFAULT_HOST = "default";
const RELAY_VERSION = 4;

function hostId(value) {
  return String(value || DEFAULT_HOST).replace(/[^A-Za-z0-9._-]/g, "").slice(0, 80) || DEFAULT_HOST;
}
const hostTag = (id) => `host:${hostId(id)}`;
const clientTag = (id) => `client:${hostId(id)}`;
const validSession = (value) => /^[A-Za-z0-9._~-]{1,128}$/.test(String(value || ""));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/healthz" && request.method === "GET") {
      return json(200, { ok: true, service: "neko-relay", version: RELAY_VERSION });
    }
    if (url.pathname === "/" || url.pathname === "/client" || /^\/(?:session|hub)\/[^/]+\/?$/.test(url.pathname)) {
      return clientResponse(request);
    }
    const session = url.searchParams.get("session") || (await peekSession(request));
    if (!validSession(session)) return json(400, { error: "invalid session" });
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
  return new Response(JSON.stringify(obj), { status, headers: {
    "content-type": "application/json",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  } });
}

function clientResponse(request) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const url = new URL(request.url);
  const socketOrigin = `${url.protocol === "https:" ? "wss:" : "ws:"}//${url.host}`;
  return new Response(CLIENT_HTML.replaceAll("__CSP_NONCE__", nonce), { headers: {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self' ${socketOrigin}; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "referrer-policy": "no-referrer",
    "strict-transport-security": "max-age=31536000",
    "x-content-type-options": "nosniff",
  } });
}

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const [ah, bh] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(a || ""))),
    crypto.subtle.digest("SHA-256", enc.encode(String(b || ""))),
  ]);
  const av = new Uint8Array(ah), bv = new Uint8Array(bh);
  if (typeof crypto.subtle.timingSafeEqual === "function") {
    return crypto.subtle.timingSafeEqual(av, bv) && !!a && !!b;
  }
  // Bun/older local runtimes may not expose the Workers-only primitive yet.
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0 && !!a && !!b;
}

/** Per-session routing. Durable state (token, queue, results) in storage; waiters in memory (they
 * only exist while a request is in flight, which keeps the DO awake anyway). */
export class RelaySession {
  constructor(ctx) {
    this.ctx = ctx;
    this.hostWaiters = new Map(); // v1: host id -> resolve fns for GET /pull
    this.clientWaiters = new Map(); // id -> [resolve fns] for GET /result
  }

  async boundToken() {
    return (await this.ctx.storage.get("token")) ?? null;
  }

  async authed(request) {
    const a = request.headers.get("authorization") || "";
    const tok = a.startsWith("Bearer ") ? a.slice(7) : "";
    const bound = await this.boundToken();
    return safeEqual(tok, bound);
  }

  hostSocket(id) {
    const ws = this.ctx.getWebSockets(id ? hostTag(id) : "host");
    return ws.length ? ws[0] : null;
  }

  async touchHost(id, meta) {
    id = hostId(id);
    const hosts = (await this.ctx.storage.get("hosts")) ?? {};
    const previous = hosts[id] ?? { id };
    hosts[id] = { ...previous, id, ...(meta !== undefined ? { meta } : {}), lastSeen: Date.now() };
    const ordered = Object.values(hosts).sort((a, b) => (b.lastSeen ?? 0) - (a.lastSeen ?? 0));
    for (const stale of ordered.slice(MAX_HOSTS)) {
      delete hosts[stale.id];
      await this.ctx.storage.delete(`q:${stale.id}`);
    }
    await this.ctx.storage.put("hosts", hosts);
    await this.ctx.storage.put("defaultHost", id); // old clients without hostId follow the latest live session
    return id;
  }

  async resolveHost(value) {
    if (value) return hostId(value);
    const live = this.ctx.getWebSockets("host")[0];
    const attachment = live?.deserializeAttachment?.();
    if (attachment?.hostId) return hostId(attachment.hostId);
    return hostId((await this.ctx.storage.get("defaultHost")) ?? DEFAULT_HOST);
  }

  async readQueue(id) {
    const key = `q:${hostId(id)}`;
    const own = await this.ctx.storage.get(key);
    if (own) return own;
    return hostId(id) === DEFAULT_HOST ? ((await this.ctx.storage.get("queue")) ?? []) : [];
  }

  async writeQueue(id, queue) {
    const key = `q:${hostId(id)}`;
    if (queue.length) await this.ctx.storage.put(key, queue);
    else await this.ctx.storage.delete(key);
    if (hostId(id) === DEFAULT_HOST) await this.ctx.storage.delete("queue");
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const tok = (request.headers.get("authorization") || "").replace(/^Bearer /, "");

    if (path === "/register" && request.method === "POST") {
      if (!tok) return json(401, { error: "missing token" });
      const bound = await this.boundToken();
      if (!bound) await this.ctx.storage.put("token", tok); // first registration binds - durably
      else if (!(await safeEqual(tok, bound))) return json(401, { error: "session bound to a different token" });
      // kid = the E2E secret's public fingerprint; the client compares it to ITS secret's fingerprint
      // via /alive and can flag a stale/mistyped secret BEFORE sending anything.
      const { kid, hostId: requestedHost, meta } = await request.clone().json().catch(() => ({}));
      if (kid) await this.ctx.storage.put("kid", String(kid).slice(0, 16));
      const registeredHost = await this.touchHost(requestedHost, meta);
      return json(200, { ok: true, v: RELAY_VERSION, hostId: registeredHost });
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
      if (!(await safeEqual(t, bound))) return json(401, { error: "unauthorized" });
      const id = await this.resolveHost(url.searchParams.get("host"));
      const pair = new WebSocketPair();
      for (const old of this.ctx.getWebSockets(hostTag(id))) {
        try { old.close(1000, "replaced by reconnect"); } catch { /* already closed */ }
      }
      pair[1].serializeAttachment({ role: "host", hostId: id });
      this.ctx.acceptWebSocket(pair[1], ["host", hostTag(id)]);
      await this.touchHost(id);
      await this.flushQueueTo(pair[1], id); // anything sent while this host was away
      return new Response(null, { status: 101, webSocket: pair[0], headers: { "sec-websocket-protocol": "neko-relay" } });
    }

    // Browser mirror socket: same session capability, but read-only at the transport layer. It gets
    // durable semantic TUI events on connect, then live events as the authoritative host emits them.
    if (path === "/client-ws") {
      if ((request.headers.get("upgrade") || "").toLowerCase() !== "websocket") {
        return json(426, { error: "expected websocket" });
      }
      const protos = (request.headers.get("sec-websocket-protocol") || "").split(",").map((s) => s.trim());
      const t = (protos.find((p) => p.startsWith("t.")) || "").slice(2);
      if (!(await safeEqual(t, await this.boundToken()))) return json(401, { error: "unauthorized" });
      const id = await this.resolveHost(url.searchParams.get("host"));
      const pair = new WebSocketPair();
      pair[1].serializeAttachment({ role: "client", hostId: id });
      this.ctx.acceptWebSocket(pair[1], ["client", clientTag(id)]);
      pair[1].send(JSON.stringify({ t: "mirror_reset" }));
      for (const event of await this.readMirrorEvents(id)) pair[1].send(JSON.stringify(event));
      pair[1].send(JSON.stringify({ t: "mirror_ready" }));
      return new Response(null, { status: 101, webSocket: pair[0], headers: { "sec-websocket-protocol": "neko-relay" } });
    }

    if (!(await this.authed(request))) return json(401, { error: "unauthorized" });

    if (path === "/revoke" && request.method === "POST") {
      for (const ws of this.ctx.getWebSockets()) {
        try { ws.close(1000, "pairing revoked"); } catch { /* already closed */ }
      }
      await this.ctx.storage.deleteAll();
      return json(200, { revoked: true });
    }

    if (path === "/alive") {
      const requested = url.searchParams.get("host");
      const id = requested ? await this.resolveHost(requested) : null;
      const lastPull = id
        ? ((await this.ctx.storage.get(`lastPull:${id}`)) ?? 0)
        : ((await this.ctx.storage.get("lastPull")) ?? 0);
      const kid = (await this.ctx.storage.get("kid")) ?? null;
      return json(200, { online: !!this.hostSocket(id) || Date.now() - lastPull < 40_000, kid, hostId: id });
    }

    if (path === "/sessions") {
      const hosts = (await this.ctx.storage.get("hosts")) ?? {};
      const rows = [];
      for (const host of Object.values(hosts)) {
        const id = hostId(host.id);
        const lastPull = (await this.ctx.storage.get(`lastPull:${id}`)) ?? 0;
        rows.push({ ...host, id, online: !!this.hostSocket(id) || Date.now() - lastPull < 40_000 });
      }
      return json(200, { hosts: rows });
    }

    if (path === "/send" && request.method === "POST") {
      const { message, hostId: requestedHost } = await request.json();
      const id = await this.resolveHost(requestedHost);
      const n = ((await this.ctx.storage.get("counter")) ?? 0) + 1;
      await this.ctx.storage.put("counter", n);
      const job = { id: `j${n}`, message, hostId: id };
      const ws = this.hostSocket(id);
      const waiters = this.hostWaiters.get(id) ?? [];
      const w = waiters.shift();
      let delivered = false;
      if (ws) {
        try { ws.send(JSON.stringify(job)); delivered = true; } catch { /* socket died mid-send */ }
      }
      if (!delivered && w) delivered = (w(job), true);
      if (!delivered) {
        // Host away: queue durably so the instruction survives an eviction and lands on reconnect.
        const q = await this.readQueue(id);
        q.push(job);
        await this.writeQueue(id, q);
      }
      return json(200, { id: job.id, hostId: id });
    }

    if (path === "/interrupt" && request.method === "POST") {
      const { hostId: requestedHost } = await request.clone().json().catch(() => ({}));
      const id = await this.resolveHost(requestedHost);
      const ws = this.hostSocket(id);
      if (ws) ws.send(JSON.stringify({ t: "interrupt" }));
      return json(200, { sent: !!ws, hostId: id }); // v1 hosts poll serially - nothing can reach them mid-turn
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
      const id = await this.resolveHost(url.searchParams.get("host"));
      await this.ctx.storage.put("lastPull", Date.now());
      await this.ctx.storage.put(`lastPull:${id}`, Date.now());
      const q = await this.readQueue(id);
      const job = q.shift();
      if (job) {
        await this.writeQueue(id, q);
        return json(200, job);
      }
      return new Promise((resolve) => {
        const waiters = this.hostWaiters.get(id) ?? [];
        const t = setTimeout(() => { remove(waiters, give); resolve(json(200, {})); }, LONG_POLL_MS);
        const give = (j) => { clearTimeout(t); resolve(json(200, j)); };
        waiters.push(give);
        this.hostWaiters.set(id, waiters);
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
    const attachment = ws.deserializeAttachment?.() ?? {};
    if (attachment.role === "client") return; // browser sockets are receive-only; commands use /send
    if (m?.t === "presence") {
      await this.touchHost(attachment.hostId, m.meta);
      return;
    }
    if (m?.t === "event" && m.event) {
      const id = hostId(attachment.hostId);
      if (m.reset) {
        await this.ctx.storage.delete(`mirror:${id}`);
        this.broadcastMirror(id, { t: "mirror_reset" });
      }
      let frame = { t: "event", event: m.event };
      if (m.durable) frame = await this.storeMirrorEvent(id, m.event);
      this.broadcastMirror(id, frame);
      return;
    }
    if (!m || !m.id) return;
    if (m.t === "reply") await this.storeResult(m.id, m.reply, true, m);
    else if (m.t === "partial") await this.storeResult(m.id, m.reply, false, m);
  }

  webSocketClose() { /* nothing held per-socket; getWebSockets() simply stops listing it */ }
  webSocketError() { /* ditto */ }

  async readMirrorEvents(id) {
    return (await this.ctx.storage.get(`mirror:${hostId(id)}`)) ?? [];
  }

  async storeMirrorEvent(id, event) {
    id = hostId(id);
    const key = `mirror:${id}`;
    const events = await this.readMirrorEvents(id);
    const seq = ((await this.ctx.storage.get(`mirrorSeq:${id}`)) ?? 0) + 1;
    const frame = { t: "event", seq, event };
    events.push(frame);
    while (events.length > KEEP_MIRROR_EVENTS || JSON.stringify(events).length > MAX_MIRROR_BYTES) events.shift();
    await this.ctx.storage.put(key, events);
    await this.ctx.storage.put(`mirrorSeq:${id}`, seq);
    return frame;
  }

  broadcastMirror(id, frame) {
    const raw = JSON.stringify(frame);
    for (const client of this.ctx.getWebSockets(clientTag(id))) {
      try { client.send(raw); } catch { /* stale sockets disappear from getWebSockets after close */ }
    }
  }

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
  async flushQueueTo(ws, id = DEFAULT_HOST) {
    const q = await this.readQueue(id);
    if (!q.length) return;
    const undelivered = [];
    for (const job of q) {
      if (undelivered.length) { undelivered.push(job); continue; }
      try { ws.send(JSON.stringify(job)); } catch { undelivered.push(job); }
    }
    await this.writeQueue(id, undelivered);
  }
}

function remove(arr, fn) {
  const i = arr.indexOf(fn);
  if (i >= 0) arr.splice(i, 1);
}
