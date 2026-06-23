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

export function startRemoteControl(onMessage: (text: string) => Promise<string>, port = 4517): RemoteControl {
  const token = randomUUID();
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
        let text = body;
        try { text = JSON.parse(body).message ?? body; } catch { /* treat body as raw text */ }
        const reply = await onMessage(String(text));
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ reply }));
      });
      return;
    }
    res.end(`Neko remote control active. POST /message?token=${token}  {"message":"..."}`);
  });
  server.listen(port, "127.0.0.1");
  return { url: `http://127.0.0.1:${port}`, token, stop: () => server.close() };
}
