/**
 * Neko remote-relay Worker — a SELF-HOSTED rendezvous so you can drive your local Neko from any phone or
 * browser (no Tailscale, no open port on your machine). Your local Neko dials OUT and long-polls; your
 * phone POSTs instructions here; this Worker just routes them. Because it's YOUR Worker (not a vendor's),
 * it sees only what passes through — and with end-to-end encryption (see README) it sees only ciphertext.
 *
 * One Durable Object per session holds the instruction queue + replies + long-poll waiters.
 * Endpoints (all require `Authorization: Bearer <token>` except the static client page at `/`):
 *   POST /register {session}                 host announces a session (first token wins; binds it)
 *   GET  /pull?session=...   -> {id,message} host long-polls for the next instruction ({} after ~25s)
 *   POST /reply {session,id,reply,...}        host returns a turn's result (wakes the client)
 *   POST /send  {session,message} -> {id}     client submits an instruction (wakes the host)
 *   GET  /result?session=&id=...  -> {reply}  client long-polls for the matching reply
 *   GET  /                                    minimal phone web client (client.html)
 */
import CLIENT_HTML from "./client.html";

const LONG_POLL_MS = 25_000;

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

/** Per-session state + long-poll waiters. */
export class RelaySession {
  constructor() {
    this.token = null;
    this.queue = []; // {id, message} pending for the host
    this.replies = new Map(); // id -> reply
    this.hostWaiters = []; // resolve fns for GET /pull
    this.clientWaiters = new Map(); // id -> [resolve fns] for GET /result
    this.counter = 0;
  }

  authed(request) {
    const a = request.headers.get("authorization") || "";
    const tok = a.startsWith("Bearer ") ? a.slice(7) : "";
    return tok && this.token && tok === this.token;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const tok = (request.headers.get("authorization") || "").replace(/^Bearer /, "");

    if (path === "/register" && request.method === "POST") {
      if (!this.token) this.token = tok; // first registration binds the token
      if (this.token !== tok) return json(401, { error: "session bound to a different token" });
      return json(200, { ok: true });
    }
    if (!this.authed(request)) return json(401, { error: "unauthorized" });

    if (path === "/pull") {
      const job = this.queue.shift();
      if (job) return json(200, job);
      return new Promise((resolve) => {
        const t = setTimeout(() => { remove(this.hostWaiters, give); resolve(json(200, {})); }, LONG_POLL_MS);
        const give = (j) => { clearTimeout(t); resolve(json(200, j)); };
        this.hostWaiters.push(give);
      });
    }
    if (path === "/send" && request.method === "POST") {
      const { message } = await request.json();
      const id = `j${++this.counter}`;
      const job = { id, message };
      const w = this.hostWaiters.shift();
      if (w) w(job); else this.queue.push(job);
      return json(200, { id });
    }
    if (path === "/reply" && request.method === "POST") {
      const { id, ...rest } = await request.json();
      this.replies.set(id, rest.reply ?? rest);
      const ws = this.clientWaiters.get(id) || [];
      ws.forEach((give) => give(this.replies.get(id)));
      this.clientWaiters.delete(id);
      return json(200, { ok: true });
    }
    if (path === "/result") {
      const id = url.searchParams.get("id") || "";
      if (this.replies.has(id)) return json(200, { reply: this.replies.get(id) });
      return new Promise((resolve) => {
        const arr = this.clientWaiters.get(id) || [];
        const t = setTimeout(() => { remove(arr, give); resolve(new Response("", { status: 204 })); }, LONG_POLL_MS);
        const give = (reply) => { clearTimeout(t); resolve(json(200, { reply })); };
        arr.push(give);
        this.clientWaiters.set(id, arr);
      });
    }
    return json(404, { error: "not found" });
  }
}

function remove(arr, fn) {
  const i = arr.indexOf(fn);
  if (i >= 0) arr.splice(i, 1);
}
