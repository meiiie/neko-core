/**
 * /remote-control: a tiny LOCAL (127.0.0.1 only) HTTP server that injects messages into the running
 * session and returns the reply — so you can drive Neko from another shell/device on your machine.
 * Auth by a per-session token. No external exposure (bound to loopback).
 *
 *   POST /message?token=<t>   body: {"message":"..."}  -> {"reply":"..."}
 *   GET  /?token=<t>                                    -> status text
 */
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

export interface RemoteControl {
  url: string;
  token: string;
  stop: () => void;
}

const MAX_PORT_HOPS = 10;

export async function startRemoteControl(
  onMessage: (text: string) => Promise<string>,
  port = 4517,
): Promise<RemoteControl> {
  const token = randomUUID();
  let inFlight = false; // the agent runs one turn at a time; serialize so two concurrent POSTs can't
  // start overlapping turns on the same session (which corrupts its state).
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    if (url.searchParams.get("token") !== token && req.headers["x-neko-token"] !== token) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }
    if (req.method === "POST" && url.pathname === "/message") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", async () => {
        if (inFlight) {
          // Already processing a turn — reject rather than race a second overlapping run.
          res.statusCode = 409;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: "busy: a message is already being processed" }));
          return;
        }
        inFlight = true;
        try {
          let text = body;
          try { text = JSON.parse(body).message ?? body; } catch { /* treat body as raw text */ }
          const reply = await onMessage(String(text));
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ reply }));
        } catch (e) {
          // A failing agent turn must not hang the client (or bubble an unhandled rejection).
          res.statusCode = 500;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
        } finally {
          inFlight = false;
        }
      });
      return;
    }
    res.end(`Neko remote control active. POST /message?token=${token}  {"message":"..."}`);
  });

  // Bind to loopback, hopping to the next port if one is busy (a stale server from a crashed
  // session, or another Neko) instead of crashing on an unhandled EADDRINUSE 'error' event.
  const bound = await new Promise<number>((resolve, reject) => {
    let p = port;
    const attempt = () => {
      const onErr = (e: NodeJS.ErrnoException) => {
        server.removeListener("error", onErr);
        if (e.code === "EADDRINUSE" && p < port + MAX_PORT_HOPS) { p += 1; attempt(); }
        else reject(e);
      };
      server.once("error", onErr);
      server.listen(p, "127.0.0.1", () => { server.removeListener("error", onErr); resolve(p); });
    };
    attempt();
  });
  // Keep a permanent handler so a late socket error can never throw an unhandled 'error' event.
  server.on("error", () => { /* swallow post-bind socket errors */ });

  return { url: `http://127.0.0.1:${bound}`, token, stop: () => server.close() };
}
