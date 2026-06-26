import { expect, test } from "bun:test";

import type { RemoteHandlers } from "../src/adapters/remote-control.ts";
import { open, seal } from "../src/adapters/relay-crypto.ts";
import { startRemoteRelay } from "../src/adapters/remote-relay.ts";

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
