/**
 * Self-inspection: run the REAL ChatApp through production wiring (fake TTY -> FrameDiffer -> BSU/ESU
 * wrapper) into a VirtualTerminal, driving realistic flows and PRINTING the resulting screen grid at
 * each step. This is the deterministic equivalent of screenshotting the live UI - I can read exactly
 * what the terminal would show and spot layout/UX bugs, plus time the hot paths.
 *   bun scripts/inspect-ui.ts
 */
import { EventEmitter } from "node:events";
import { render } from "ink";
import React from "react";

import { ChatApp } from "../src/ui/chat.tsx";
import { FrameDiffer } from "../src/ui/frame-diff.ts";
import { installAltScreenGuard } from "../src/ui/altscreen.ts";
import { wrapStdoutForSync } from "../src/ui/sync-stdout.ts";
import { VirtualTerminal } from "../test/vt.ts";

class Out extends EventEmitter { isTTY = true; bytes = 0; constructor(public columns: number, public rows: number, private vt: VirtualTerminal) { super(); } write(s: string) { this.bytes += String(s).length; this.vt.write(String(s)); return true; } setSize(c: number, r: number) { this.columns = c; this.rows = r; this.vt.resize(c, r); this.emit("resize"); } }
class In extends EventEmitter { isTTY = true; data: string | null = null; setRawMode() {} setEncoding() {} ref() {} unref() {} pause() {} resume() {} read() { const d = this.data; this.data = null; return d; } push(s: string) { this.data = s; this.emit("readable"); this.emit("data", s); } }
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function dump(label: string, vt: VirtualTerminal) {
  console.log(`\n===== ${label} =====`);
  vt.lines().forEach((l, i) => { if (l.trim() !== "" || (i > 0 && vt.lines()[i - 1].trim() !== "")) console.log(String(i).padStart(2, " ") + "|" + l); });
}

// A provider that streams a markdown reply token-by-token (to inspect live formatting + measure cost).
const MD = "Đây là **tổng hợp** hôm nay:\n\n## Nga - Ukraine\n\n- Cuộc gọi **Trump - Putin** (90 phút)\n- Bối cảnh: tuần tới\n\n| Chỉ số | Số liệu |\n|---|---|\n| Người chết | **150.000** |\n| Di tản | ~12 triệu |\n\nBạn muốn đi sâu vào đâu?";
class MdStream {
  async complete(_m: any, _t: any, onDelta?: (t: string, k?: any) => void) {
    for (const tok of MD.match(/\S+\s*|\n/g) ?? []) { onDelta?.(tok); await tick(15); }
    return { content: MD, tool_calls: [], usage: { prompt_tokens: 500, completion_tokens: 200, total_tokens: 700 } };
  }
}

const vt = new VirtualTerminal(110, 32);
const out = new Out(110, 32, vt);
const stdin = new In();
const differ = new FrameDiffer();
process.env.NEKO_FULLSCREEN = "1";
const preAltDispose = installAltScreenGuard(out as any, { mouse: false });
const app = render(
  React.createElement(ChatApp as any, { yolo: true, provider: new MdStream(), sessionId: "inspect", frameDiffer: differ, preAltDispose }),
  { stdout: wrapStdoutForSync(out as any, { supported: true, differ }) as any, stdin: stdin as any, patchConsole: false, exitOnCtrlC: false },
);
await tick(300);
dump("STARTUP (fullscreen, fresh)", vt);

stdin.push("tin chiến tranh hôm nay"); await tick(120);
dump("AFTER TYPING", vt);

// Submit -> the markdown reply streams. Sample mid-stream and at the end; time the deltas.
stdin.push("\r");
const t0 = performance.now();
await tick(400);
dump("MID-STREAM (markdown should be FORMATTED live, no raw ** or ##)", vt);
await tick(2500);
const streamMs = performance.now() - t0;
dump("AFTER COMMIT", vt);
console.log(`\nstream wall time: ${streamMs.toFixed(0)}ms for ${MD.length} chars, ${out.bytes} total bytes written`);

// Scroll up, then jump back.
stdin.push("\x1b[<64;5;5M\x1b[<64;5;5M\x1b[<64;5;5M"); await tick(200);
dump("SCROLLED UP (pill should show; content shifted)", vt);
stdin.push("\x1b[F"); await tick(200); // End -> tail
dump("AFTER End (back to tail)", vt);

app.unmount();
await tick(50);
process.exit(0);
