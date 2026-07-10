import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RemoteHandlers } from "../src/adapters/remote-control.ts";
import { open, seal } from "../src/adapters/relay-crypto.ts";
import { loadOrCreatePairing, startRemoteRelay } from "../src/adapters/remote-relay.ts";

/** A tiny in-memory relay double standing in for the Cloudflare Worker, so we can prove the host
 * (agent) side end-to-end: the host dials OUT and long-polls; a client submits an instruction; the
 * relay routes it to the host; the host's reply comes back to the client. The host opens NO port. */
function makeRelayDouble(port: number) {
  type Sess = { token: string; queue: { id: string; message: string }[]; replies: Map<string, string> };
  const sessions = new Map<string, Sess>();
  let counter = 0;
  const server = Bun.serve({
    port,
    async fetch(req) {
      const u = new URL(req.url);
      const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      const sid = u.searchParams.get("session") ?? "";
      if (u.pathname === "/register" && req.method === "POST") {
        const { session } = await req.json();
        sessions.set(session, { token: tok, queue: [], replies: new Map() });
        return Response.json({ ok: true });
      }
      if (u.pathname === "/pull") {
        const s = sessions.get(sid);
        if (!s || s.token !== tok) return new Response("unauthorized", { status: 401 });
        return Response.json(s.queue.shift() ?? {});
      }
      if (u.pathname === "/reply" && req.method === "POST") {
        const { session, id, reply } = await req.json();
        sessions.get(session)?.replies.set(id, reply);
        return Response.json({ ok: true });
      }
      if (u.pathname === "/send" && req.method === "POST") {
        const { session, message } = await req.json();
        const s = sessions.get(session);
        if (!s || s.token !== tok) return new Response("unauthorized", { status: 401 });
        const id = `j${++counter}`;
        s.queue.push({ id, message });
        return Response.json({ id });
      }
      if (u.pathname === "/result") {
        const s = sessions.get(sid);
        const id = u.searchParams.get("id") ?? "";
        const reply = s?.replies.get(id);
        return reply !== undefined ? Response.json({ reply }) : new Response("", { status: 204 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, url: `http://127.0.0.1:${port}` };
}

const handlers = (run: RemoteHandlers["run"]): RemoteHandlers => ({ run, status: () => ({ busy: false }), interrupt: () => true });

test("remote-relay: outbound dial-out + long-poll routes a client instruction to the host and back (no open port)", async () => {
  const relay = makeRelayDouble(4701);
  let opened = false; // the host must never call server.listen — it only dials OUT
  try {
    const rc = await startRemoteRelay(relay.url, handlers(async (m: string) => ({ reply: `ok:${m}` })), { pollMs: 30 });
    try {
      // A "phone" client submits an instruction to the relay (same session+token).
      const headers = { "content-type": "application/json", authorization: `Bearer ${rc.token}` };
      const sent = await (await fetch(`${relay.url}/send`, { method: "POST", headers, body: JSON.stringify({ session: rc.session, message: "hi there" }) })).json();
      expect(sent.id).toBeTruthy();
      // Poll for the host's reply (the host pulled it, ran it, posted the reply).
      let reply: string | undefined;
      for (let i = 0; i < 50 && reply === undefined; i++) {
        const res = await fetch(`${relay.url}/result?session=${rc.session}&id=${sent.id}`, { headers });
        if (res.status === 200) reply = (await res.json()).reply;
        else await new Promise((r) => setTimeout(r, 30));
      }
      expect(reply).toBe("ok:hi there");
      expect(opened).toBe(false); // the host never opened a listening port
    } finally {
      rc.stop();
    }
  } finally {
    relay.server.stop();
  }
});

test("remote-relay E2E: the relay only ever sees ciphertext (zero-knowledge)", async () => {
  const seen: string[] = []; // everything that passed through the relay
  const sessions = new Map<string, { queue: any[]; replies: Map<string, any> }>();
  const server = Bun.serve({
    port: 4703,
    async fetch(req) {
      const u = new URL(req.url);
      const sid = u.searchParams.get("session") ?? "";
      if (u.pathname === "/register" && req.method === "POST") { const { session } = await req.json(); sessions.set(session, { queue: [], replies: new Map() }); return Response.json({ ok: true }); }
      const s = sessions.get(sid);
      if (u.pathname === "/pull") return Response.json(s?.queue.shift() ?? {});
      if (u.pathname === "/reply" && req.method === "POST") { const { session, id, reply } = await req.json(); seen.push(JSON.stringify(reply)); sessions.get(session)?.replies.set(id, reply); return Response.json({ ok: true }); }
      if (u.pathname === "/send" && req.method === "POST") { const { session, message } = await req.json(); seen.push(JSON.stringify(message)); sessions.get(session)?.queue.push({ id: "j1", message }); return Response.json({ id: "j1" }); }
      if (u.pathname === "/result") { const r = s?.replies.get(u.searchParams.get("id") ?? ""); return r !== undefined ? Response.json({ reply: r }) : new Response("", { status: 204 }); }
      return new Response("nf", { status: 404 });
    },
  });
  const url = "http://127.0.0.1:4703";
  const secret = "pair-9988";
  let received = "";
  try {
    const rc = await startRemoteRelay(url, handlers(async (m: string) => { received = m; return { reply: "your password is hunter2" }; }), { pollMs: 30, secret });
    try {
      const headers = { "content-type": "application/json", authorization: `Bearer ${rc.token}` };
      // The client seals with the shared secret (node seal == what the browser sends, proven interoperable).
      const sealed = seal(secret, "what is my bank password");
      const { id } = await (await fetch(`${url}/send`, { method: "POST", headers, body: JSON.stringify({ session: rc.session, message: sealed }) })).json();
      let reply: any;
      for (let i = 0; i < 50 && reply === undefined; i++) {
        const res = await fetch(`${url}/result?session=${rc.session}&id=${id}`, { headers });
        if (res.status === 200) reply = (await res.json()).reply;
        else await new Promise((r) => setTimeout(r, 30));
      }
      expect(received).toBe("what is my bank password"); // the host decrypted + ran it
      expect(open(secret, reply)).toBe("your password is hunter2"); // the reply was sealed; unseal it
      const all = seen.join(" "); // CRUCIAL: the relay saw only ciphertext, never the plaintext
      expect(all).not.toContain("bank password");
      expect(all).not.toContain("hunter2");
    } finally {
      rc.stop();
    }
  } finally {
    server.stop();
  }
});

/** A v2 relay double: /register advertises v:2 and the host connects a WebSocket (token in the
 * subprotocol). Mirrors the Cloudflare Worker's /ws contract so the WS path is proven end-to-end. */
function makeWsDouble(port: number, opts: { refuseWs?: boolean } = {}) {
  const state = { connections: 0, frames: [] as any[], sockets: [] as any[], token: "", queue: [] as any[], replies: new Map<string, any>() };
  let counter = 0;
  const server = Bun.serve({
    port,
    fetch(req, srv) {
      const u = new URL(req.url);
      const tok = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
      if (u.pathname === "/register" && req.method === "POST") { state.token = tok; return Response.json({ ok: true, v: 2 }); }
      if (u.pathname === "/ws") {
        if (opts.refuseWs) return new Response("nope", { status: 404 });
        const protos = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim());
        const t = (protos.find((p) => p.startsWith("t.")) ?? "").slice(2);
        if (t !== state.token) return new Response("unauthorized", { status: 401 });
        if (srv.upgrade(req, { headers: { "sec-websocket-protocol": "neko-relay" } })) return undefined as any;
        return new Response("no upgrade", { status: 426 });
      }
      // v1 endpoints (the WSS-blocked fallback lands here)
      if (u.pathname === "/pull") return Response.json(state.queue.shift() ?? {});
      if (u.pathname === "/reply" && req.method === "POST") { return req.json().then((b: any) => { state.replies.set(b.id, b.reply); return Response.json({ ok: true }); }); }
      return new Response("nf", { status: 404 });
    },
    websocket: {
      open(ws) { state.connections++; state.sockets.push(ws); },
      message(_ws, raw) { state.frames.push(JSON.parse(String(raw))); },
      close() {},
    },
  });
  return { server, state, url: `http://127.0.0.1:${port}` };
}

const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};

test("remote-relay v2: WebSocket transport streams PARTIAL frames then the final reply", async () => {
  const relay = makeWsDouble(4704);
  try {
    const rc = await startRemoteRelay(relay.url, handlers(async (m, onDelta) => {
      onDelta?.("thinking about " + m);
      await new Promise((r) => setTimeout(r, 200)); // let the 50ms partial throttle fire
      onDelta?.(" ...more");
      return { reply: "final:" + m, tokens: 7, ms: 5 };
    }), { partialMs: 50 });
    try {
      expect(rc.transport()).toBe("ws");
      await until(() => relay.state.connections === 1);
      relay.state.sockets[0].send(JSON.stringify({ id: "j1", message: "hi" }));
      await until(() => relay.state.frames.some((f) => f.t === "reply"));
      const partials = relay.state.frames.filter((f) => f.t === "partial");
      expect(partials.length).toBeGreaterThan(0);
      expect(partials[0].reply).toContain("thinking about hi");
      const final = relay.state.frames.find((f) => f.t === "reply");
      expect(final.reply).toBe("final:hi");
      expect(final.tokens).toBe(7);
    } finally { rc.stop(); }
  } finally { relay.server.stop(); }
});

test("remote-relay v2: an {t:interrupt} frame reaches handlers.interrupt MID-TURN (phone Stop)", async () => {
  const relay = makeWsDouble(4705);
  let interrupted = false;
  let release: () => void = () => {};
  const h: RemoteHandlers = {
    run: async () => { await new Promise<void>((r) => { release = r; }); return { reply: "done" }; },
    status: () => ({ busy: true }),
    interrupt: () => { interrupted = true; release(); return true; },
  };
  try {
    const rc = await startRemoteRelay(relay.url, h, {});
    try {
      await until(() => relay.state.connections === 1);
      relay.state.sockets[0].send(JSON.stringify({ id: "j1", message: "long task" }));
      await new Promise((r) => setTimeout(r, 100)); // the turn is now running (blocked on `release`)
      relay.state.sockets[0].send(JSON.stringify({ t: "interrupt" }));
      await until(() => interrupted); // reached the host WHILE the turn was in flight
      await until(() => relay.state.frames.some((f) => f.t === "reply")); // and the turn still replied
    } finally { rc.stop(); }
  } finally { relay.server.stop(); }
});

test("remote-relay v2: WSS blocked (socket never opens) degrades honestly to the v1 poll loop", async () => {
  const relay = makeWsDouble(4706, { refuseWs: true });
  relay.state.queue.push({ id: "j9", message: "via poll" });
  try {
    const rc = await startRemoteRelay(relay.url, handlers(async (m) => ({ reply: "ok:" + m })), { pollMs: 20, backoffMs: 10 });
    try {
      await until(() => rc.transport() === "poll");
      await until(() => relay.state.replies.get("j9") === "ok:via poll");
    } finally { rc.stop(); }
  } finally { relay.server.stop(); }
});

test("remote-relay v2: reconnects after a dropped socket and keeps serving jobs", async () => {
  const relay = makeWsDouble(4707);
  try {
    const rc = await startRemoteRelay(relay.url, handlers(async (m) => ({ reply: "ok:" + m })), { backoffMs: 20 });
    try {
      await until(() => relay.state.connections === 1);
      relay.state.sockets[0].close(); // relay hiccup / DO eviction
      await until(() => relay.state.connections === 2); // host came back by itself
      relay.state.sockets[1].send(JSON.stringify({ id: "j2", message: "after reconnect" }));
      await until(() => relay.state.frames.some((f) => f.t === "reply" && f.reply === "ok:after reconnect"));
    } finally { rc.stop(); }
  } finally { relay.server.stop(); }
});

test("pairing persists across restarts (same QR, phone stays paired) and `new` rotates it", () => {
  const dir = mkdtempSync(join(tmpdir(), "nk-relay-"));
  const a = loadOrCreatePairing(false, dir);
  const b = loadOrCreatePairing(false, dir);
  expect(b).toEqual(a); // a restart reuses the pairing - the phone reconnects with no re-scan
  const c = loadOrCreatePairing(true, dir);
  expect(c.session).not.toBe(a.session); // /relay new = a genuinely fresh pairing
  expect(loadOrCreatePairing(false, dir)).toEqual(c); // ...which then persists too
});

test("remote-relay: a wrong token can't submit to the session", async () => {
  const relay = makeRelayDouble(4702);
  try {
    const rc = await startRemoteRelay(relay.url, handlers(async (m: string) => ({ reply: m })), { pollMs: 30 });
    try {
      const res = await fetch(`${relay.url}/send`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong" }, body: JSON.stringify({ session: rc.session, message: "x" }) });
      expect(res.status).toBe(401);
    } finally {
      rc.stop();
    }
  } finally {
    relay.server.stop();
  }
});
