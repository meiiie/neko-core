import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { VirtualTerminal } from "../test/vt.ts";

const repo = resolve(import.meta.dir, "..");
const exe = resolve(repo, "dist/neko.exe");
if (!existsSync(exe)) throw new Error("missing dist/neko.exe; run bun run build first");

const home = mkdtempSync(join(tmpdir(), "neko-anchor-e2e-"));
const sessions = join(home, ".neko-core", "sessions");
const trace = join(home, "frames.ndjson");
mkdirSync(sessions, { recursive: true });

const id = "20260730-230000-anchor-e2e";
const now = new Date().toISOString();
const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
for (let i = 0; i < 50; i++) {
  messages.push({ role: "user", content: `ANCHOR PROMPT ${i}` });
  messages.push({
    role: "assistant",
    content: Array.from({ length: (i % 3) + 1 }, (_, line) => `answer ${i} line ${line + 1}`).join("\n"),
  });
}
writeFileSync(join(sessions, `${id}.json`), JSON.stringify({
  id,
  createdAt: now,
  updatedAt: now,
  cwd: repo,
  model: "m",
  messages,
}));

const cols = 118;
const rows = 30;
const vt = new VirtualTerminal(cols, rows);
// SAFETY: test-built fixture/bridge; fields are exactly what this test controls.
const term = new (Bun as any).Terminal({
  cols,
  rows,
  data(_terminal: any, chunk: Uint8Array) {
    vt.write(new TextDecoder().decode(chunk));
  },
});
// SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
const proc = Bun.spawn({
  cmd: [exe, "--yolo", "--resume", id],
  cwd: repo,
  terminal: term,
  env: {
    ...process.env,
    USERPROFILE: home,
    HOME: home,
    WT_SESSION: "anchor-e2e",
    NEKO_AUTO_UPDATE: "0",
    NEKO_TRACE_FRAMES: trace,
  },
} as any);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (predicate: () => boolean, timeoutMs = 10_000) => {
  for (let waited = 0; waited < timeoutMs && !predicate(); waited += 25) await sleep(25);
  return predicate();
};
const bandEvents = (): Array<{ ev?: string; top?: number; h?: number }> => {
  if (!existsSync(trace)) return [];
  return readFileSync(trace, "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    })
    .filter((event) => event.ev === "setBand");
};
const stableStickyHeader = async (stableMs = 800, timeoutMs = 8_000): Promise<string | null> => {
  const deadline = performance.now() + timeoutMs;
  let last = vt.lines()[0]?.trim() ?? "";
  let unchangedSince = performance.now();
  while (performance.now() < deadline) {
    await sleep(20);
    const current = vt.lines()[0]?.trim() ?? "";
    if (current !== last) { last = current; unchangedSince = performance.now(); }
    if (bandEvents().at(-1)?.top === 2 && /^> ANCHOR PROMPT \d+$/.test(current) && performance.now() - unchangedSince >= stableMs) {
      return current;
    }
  }
  return null;
};

let ok = false;
try {
  if (!(await waitFor(() => vt.text().includes("shift+tab to cycle") && vt.text().includes("answer 49"), 15_000))) {
    throw new Error("startup/resume hydration timeout");
  }
  await sleep(250); // let the initial ANSI viewport projection settle before navigation

  term.write("\x1b[<64;5;5M".repeat(8)); // real SGR wheel-up burst: leave the live tail
  await sleep(250);
  let anchor = "";
  for (let step = 0; step < 10; step++) {
    await waitFor(() => bandEvents().at(-1)?.top === 2, 600);
    anchor = vt.lines()[0]?.trim() ?? "";
    if (bandEvents().at(-1)?.top === 2 && /^> ANCHOR PROMPT \d+$/.test(anchor)) break;
    term.write("\x1b[<64;5;5M"); // one more wheel tick toward older content
  }
  const settledAnchor = await stableStickyHeader();
  if (!settledAnchor) {
    throw new Error(`sticky header missing or still moving: top=${bandEvents().at(-1)?.top}, row1=${JSON.stringify(anchor)}`);
  }
  anchor = settledAnchor;

  const beforeClick = bandEvents().length;
  term.write("\x1b[<0;5;1M"); // left press on the sticky first row
  const jumped = await waitFor(() => {
    const later = bandEvents().slice(beforeClick);
    return later.some((event) => event.top === 1) && vt.lines()[0]?.trim() === anchor;
  }, 5_000);
  if (!jumped) {
    const later = bandEvents().slice(beforeClick);
    throw new Error(`click did not jump to ${anchor}; later bands=${JSON.stringify(later)}; rows=${JSON.stringify(vt.lines().slice(0, 5))}`);
  }

  ok = true;
  console.log(`prompt-anchor-e2e: sticky=${anchor}; band top 2 -> 1; exact-row=true`);
  console.log("prompt-anchor-e2e: OK");
} finally {
  term.write("\x03");
  await sleep(100);
  term.write("\x03");
  await Promise.race([proc.exited, sleep(2_000)]);
  try { proc.kill(); } catch {}
  term.close();
  rmSync(home, { recursive: true, force: true });
}

process.exit(ok ? 0 : 1);
