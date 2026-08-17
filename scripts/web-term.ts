/**
 * Temporary web-terminal bridge for live UX testing of the compiled neko binary:
 * serves an xterm.js page and pipes its WebSocket to a real ConPTY running `neko --yolo`.
 * Manual tool; delete after use.
 *
 *   bun scripts/__web-term.ts [port] [cwd]
 */
import { resolve } from "node:path";

import { VirtualTerminal } from "../test/vt.ts";

const port = Number(process.argv[2] ?? 7767);
const cwd = resolve(process.argv[3] ?? ".");

const decoder = new TextDecoder();
const state = new WeakMap<any, { proc: any; term: any; vt: VirtualTerminal }>();
let screenOf: (() => string) | null = null;

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>neko --yolo (live)</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<style>
  html,body{margin:0;height:100%;background:#0b0b0e}
  #term{height:100vh;padding:6px;box-sizing:border-box}
  #bar{position:fixed;top:0;right:8px;font:12px monospace;color:#888;z-index:9}
</style></head>
<body><div id="bar"></div><div id="term"></div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script>
const term = new Terminal({ fontSize: 13, cols: 120, rows: 34, theme: { background: "#0b0b0e" }, scrollback: 2000, allowProposedApi: true });
window.term = term;
let outTail = "";
term.open(document.getElementById("term"));
const ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
ws.binaryType = "arraybuffer";
const enc = new TextEncoder();
term.onData((d) => ws.send(enc.encode(d)));
ws.onmessage = (ev) => { const s = new TextDecoder().decode(new Uint8Array(ev.data)); outTail = (outTail + s).slice(-12000); term.write(s); };
ws.onclose = () => { term.write("\\r\\n[bridge] connection closed"); bar("disconnected"); };
const bar = (s) => document.getElementById("bar").textContent = s;
window.outTail = () => outTail;
window.screenText = () => { const rows = []; for (let i = 0; i < term.rows; i++) rows.push(term.buffer.active.getLine(i).translateToString(true)); return rows.join("\\n"); };
bar("connected");
</script></body></html>`;

const server = Bun.serve({
  port,
  hostname: "127.0.0.1",
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/screen") {
      return new Response(screenOf ? screenOf() : "(no session yet)", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }
    if (url.pathname === "/ws") {
      if (server.upgrade(request)) return;
      return new Response("expected websocket", { status: 400 });
    }
    return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
  },
  websocket: {
    open(ws) {
      const vt = new VirtualTerminal(120, 34);
      screenOf = () => vt.text();
      // SAFETY: test-built PTY bridge; only this manual tool constructs it.
      const term = new (Bun as any).Terminal({
        cols: 120,
        rows: 34,
        data(_t: any, chunk: Uint8Array) {
          const s = decoder.decode(chunk);
          try { vt.write(s); } catch { /* keep the bridge alive */ }
          ws.send(chunk);
        },
        close() { try { ws.close(); } catch { /* already gone */ } },
      });
      // SAFETY: Bun.Terminal spawn options are typed loosely; this manual tool constructs them.
      const proc = Bun.spawn({ cmd: [resolve("dist/neko.exe"), "--yolo"], cwd, terminal: term, env: process.env } as any);
      state.set(ws, { proc, term, vt });
      proc.exited.then(() => { try { ws.close(); } catch { /* fine */ } });
    },
    message(ws, message) {
      // SAFETY: the page sends UTF-8 terminal keystrokes as binary WebSocket frames.
      state.get(ws)?.term?.write(decoder.decode(message as ArrayBuffer));
    },
    close(ws) {
      const d = state.get(ws);
      try { d?.proc?.kill(); } catch { /* fine */ }
    },
  },
});
console.log(`web-term: http://127.0.0.1:${server.port}/ (cwd=${cwd})`);
