/**
 * /remote-control: a small LOCAL (127.0.0.1 only) HTTP control API for the running session — drive Neko
 * from another shell/device on your machine. No external exposure (loopback). Professional surface:
 *   POST /message    {"message":"..."}   -> {"reply","tokens","ms","interrupted"}   (one turn)
 *                    with `Accept: text/event-stream` -> SSE: data:{delta} ... event:done {reply,...}
 *   GET  /status                          -> {"busy","model","messages","inFlight"}
 *   POST /interrupt                       -> {"interrupted": bool}   (abort the running turn)
 * Auth: `Authorization: Bearer <token>` (per-session token; never in the URL). Body capped at 1 MB.
 * Turns are serialized (a second concurrent request gets 409). The endpoint is written to
 * ~/.neko-core/remote.json on start (and removed on stop) so local tools can discover it.
 */
import { createServer, type Server } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homeDir } from "../shared/home.ts";
import { join } from "node:path";

export interface RunResult {
  reply: string;
  tokens?: number;
  ms?: number;
  interrupted?: boolean;
}
export interface RemoteHandlers {
  /** Run one turn. `onDelta` (when given) streams output chunks as they arrive; `onAct` streams
   * one-line tool activity (the same "Read(src/agent.ts)" lines the terminal shows). */
  run: (text: string, onDelta?: (chunk: string) => void, onAct?: (line: string) => void) => Promise<RunResult>;
  status: () => { busy: boolean; model?: string; messages?: number; title?: string; cwd?: string; sessionId?: string };
  interrupt: () => boolean;
}
export interface RemoteControl {
  url: string;
  token: string;
  stop: () => void;
}

const MAX_PORT_HOPS = 10;
const MAX_BODY = 1_000_000; // 1 MB cap on request bodies (a buggy/hostile local process can't OOM us)

/** Constant-time token check (no early-exit timing leak), Bearer header only. */
function authorized(req: { headers: Record<string, any> }, token: string): boolean {
  const auth = req.headers.authorization as string | undefined;
  const provided = auth?.startsWith("Bearer ") ? auth.slice(7) : (req.headers["x-neko-token"] as string | undefined);
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startRemoteControl(handlers: RemoteHandlers, port = 4517, host = "127.0.0.1"): Promise<RemoteControl> {
  const token = randomUUID();
  let inFlight = false; // the agent runs one turn at a time; serialize so concurrent POSTs can't overlap.
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    if (!authorized(req, token)) {
      res.statusCode = 401;
      res.end("unauthorized");
      return;
    }
    const json = (code: number, obj: unknown) => {
      res.statusCode = code;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(obj));
    };

    if (req.method === "GET" && url.pathname === "/status") return json(200, { ...handlers.status(), inFlight });
    if (req.method === "POST" && url.pathname === "/interrupt") return json(200, { interrupted: handlers.interrupt() });

    if (req.method === "POST" && url.pathname === "/message") {
      let body = "";
      let tooBig = false;
      req.on("data", (c) => {
        if (body.length + c.length > MAX_BODY) tooBig = true; // stop storing (no OOM) but keep draining
        else body += c;
      });
      req.on("end", async () => {
        if (tooBig) return json(413, { error: "body too large" });
        if (inFlight) return json(409, { error: "busy: a message is already being processed" });
        inFlight = true;
        let text = body;
        try { text = JSON.parse(body).message ?? body; } catch { /* treat body as raw text */ }
        const wantsStream = String(req.headers.accept ?? "").includes("text/event-stream");
        try {
          if (wantsStream) {
            res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
            const result = await handlers.run(
              String(text),
              (d) => res.write(`data: ${JSON.stringify({ delta: d })}\n\n`),
              (line) => res.write(`data: ${JSON.stringify({ act: line })}\n\n`),
            );
            res.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
            res.end();
          } else {
            json(200, await handlers.run(String(text)));
          }
        } catch (e) {
          // A failing turn must not hang the client or bubble an unhandled rejection.
          const msg = e instanceof Error ? e.message : String(e);
          if (res.headersSent) res.end(`event: error\ndata: ${JSON.stringify({ error: msg })}\n\n`);
          else json(500, { error: msg });
        } finally {
          inFlight = false;
        }
      });
      return;
    }
    res.setHeader("content-type", "text/plain");
    res.end("Neko remote control (local). POST /message | GET /status | POST /interrupt. Auth: Authorization: Bearer <token>");
  });

  // Bind to loopback, hopping ports if one is busy (a stale server, or another Neko) rather than
  // crashing on an unhandled EADDRINUSE 'error' event.
  const bound = await new Promise<number>((resolve, reject) => {
    let p = port;
    const attempt = () => {
      const onErr = (e: NodeJS.ErrnoException) => {
        server.removeListener("error", onErr);
        if (e.code === "EADDRINUSE" && p < port + MAX_PORT_HOPS) { p += 1; attempt(); }
        else reject(e);
      };
      server.once("error", onErr);
      server.listen(p, host, () => { server.removeListener("error", onErr); resolve(p); });
    };
    attempt();
  });
  server.on("error", () => { /* swallow post-bind socket errors so a late one can't throw */ });

  // Discovery: write the endpoint so local tools/CLIs can find it; remove it on stop.
  const url = `http://${host}:${bound}`;
  const discPath = join(homeDir(), ".neko-core", "remote.json");
  try {
    mkdirSync(join(homeDir(), ".neko-core"), { recursive: true });
    writeFileSync(discPath, JSON.stringify({ url, token, pid: process.pid }, null, 2), "utf-8");
  } catch { /* discovery is best-effort */ }

  return {
    url,
    token,
    stop: () => {
      server.close();
      try { rmSync(discPath); } catch { /* already gone */ }
    },
  };
}
