import { expect, test } from "bun:test";
// @ts-expect-error Cloudflare Worker is deployed as JavaScript; this test supplies its runtime doubles.
import { RelaySession } from "../cloudflare/relay/worker.js";
const workerSource = await Bun.file(new URL("../cloudflare/relay/worker.js", import.meta.url)).text();

class MemoryStorage {
  data = new Map<string, any>();
  async get(key: string) { return this.data.get(key); }
  async put(key: string, value: any) { this.data.set(key, value); }
  async delete(key: string) { this.data.delete(key); }
  async deleteAll() { this.data.clear(); }
}

class SocketDouble {
  sent: any[] = [];
  attachment: any;
  closed = false;
  constructor(public tags: string[]) {}
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  serializeAttachment(value: any) { this.attachment = value; }
  deserializeAttachment() { return this.attachment; }
  close() { this.closed = true; }
}

function makeContext() {
  const sockets: SocketDouble[] = [];
  const storage = new MemoryStorage();
  return {
    storage,
    sockets,
    getWebSockets(tag?: string) { return tag ? sockets.filter((s) => s.tags.includes(tag)) : sockets; },
    acceptWebSocket() {},
  };
}

const token = "hub-token";
const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
const post = (path: string, body: any) => new Request(`https://relay.test${path}`, { method: "POST", headers, body: JSON.stringify(body) });

test("relay hub lists and independently routes multiple encrypted Neko sessions", async () => {
  const ctx = makeContext();
  const relay = new RelaySession(ctx as any);
  await relay.fetch(post("/register", { session: "hub", hostId: "alpha", meta: { iv: "a", ct: "A" } }));
  await relay.fetch(post("/register", { session: "hub", hostId: "beta", meta: { iv: "b", ct: "B" } }));

  const alpha = new SocketDouble(["host", "host:alpha"]); alpha.attachment = { hostId: "alpha" };
  const beta = new SocketDouble(["host", "host:beta"]); beta.attachment = { hostId: "beta" };
  ctx.sockets.push(alpha, beta);

  const listed = await relay.fetch(new Request("https://relay.test/sessions?session=hub", { headers }));
  expect(listed.status).toBe(200);
  expect((await listed.json()).hosts).toEqual([
    expect.objectContaining({ id: "alpha", online: true, meta: { iv: "a", ct: "A" } }),
    expect.objectContaining({ id: "beta", online: true, meta: { iv: "b", ct: "B" } }),
  ]);

  const sent = await relay.fetch(post("/send", { session: "hub", hostId: "beta", message: "ciphertext" }));
  expect(sent.status).toBe(200);
  expect(alpha.sent).toEqual([]);
  expect(beta.sent[0]).toEqual(expect.objectContaining({ id: "j1", message: "ciphertext" }));

  await relay.fetch(post("/interrupt", { session: "hub", hostId: "alpha" }));
  expect(alpha.sent).toEqual([{ t: "interrupt" }]);
  expect(beta.sent).toHaveLength(1);
});

test("relay hub keeps offline queues isolated per host", async () => {
  const ctx = makeContext();
  const relay = new RelaySession(ctx as any);
  await relay.fetch(post("/register", { session: "hub", hostId: "alpha" }));
  await relay.fetch(post("/register", { session: "hub", hostId: "beta" }));
  await relay.fetch(post("/send", { session: "hub", hostId: "alpha", message: "A" }));
  await relay.fetch(post("/send", { session: "hub", hostId: "beta", message: "B" }));
  expect((await ctx.storage.get("q:alpha"))[0].message).toBe("A");
  expect((await ctx.storage.get("q:beta"))[0].message).toBe("B");
});

test("relay refuses to bind a capability without a token", async () => {
  const relay = new RelaySession(makeContext() as any);
  const request = new Request("https://relay.test/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ session: "unbound", hostId: "alpha" }),
  });
  expect((await relay.fetch(request)).status).toBe(401);
});

test("relay public client is non-cacheable and locked to a per-response CSP nonce", () => {
  expect(workerSource).toContain('url.pathname === "/healthz"');
  expect(workerSource).toContain('"cache-control": "no-store"');
  expect(workerSource).toContain("script-src 'nonce-${nonce}'");
  expect(workerSource).toContain("frame-ancestors 'none'");
});

test("relay v4 persists and broadcasts opaque mirror events per host", async () => {
  const ctx = makeContext();
  const relay = new RelaySession(ctx as any);
  await relay.fetch(post("/register", { session: "hub", hostId: "alpha" }));
  const host = new SocketDouble(["host", "host:alpha"]); host.attachment = { role: "host", hostId: "alpha" };
  const client = new SocketDouble(["client", "client:alpha"]); client.attachment = { role: "client", hostId: "alpha" };
  ctx.sockets.push(host, client);

  const ciphertext = { iv: "opaque-iv", ct: "opaque-event" };
  await relay.webSocketMessage(host as any, JSON.stringify({ t: "event", event: ciphertext, durable: true, reset: true }));
  expect(client.sent).toEqual([{ t: "mirror_reset" }, expect.objectContaining({ t: "event", seq: 1, event: ciphertext })]);
  expect(await ctx.storage.get("mirror:alpha")).toEqual([expect.objectContaining({ seq: 1, event: ciphertext })]);

  await relay.webSocketMessage(client as any, JSON.stringify({ t: "event", event: "client-must-not-publish", durable: true }));
  expect(await ctx.storage.get("mirror:alpha")).toHaveLength(1);
});

test("relay hub revocation closes every host and invalidates the old phone token", async () => {
  const ctx = makeContext();
  const relay = new RelaySession(ctx as any);
  await relay.fetch(post("/register", { session: "hub", hostId: "alpha" }));
  const socket = new SocketDouble(["host", "host:alpha"]);
  const client = new SocketDouble(["client", "client:alpha"]); ctx.sockets.push(socket, client);
  const revoked = await relay.fetch(post("/revoke", { session: "hub" }));
  expect(revoked.status).toBe(200);
  expect(socket.closed).toBe(true);
  expect(client.closed).toBe(true);
  expect(ctx.storage.data.size).toBe(0);
  expect((await relay.fetch(post("/send", { session: "hub", hostId: "alpha", message: "stale" }))).status).toBe(401);
});
