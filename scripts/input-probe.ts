/**
 * INPUT smoke probe: prove the compiled binary can HEAR the keyboard.
 *
 * Spawns `neko doctor keys` under a real PTY (Bun.Terminal - ConPTY on Windows, forkpty elsewhere),
 * types "h" then "q" into the master side, and asserts the probe (a) saw the 0x68 byte and (b) issued
 * its "input arrives normally" verdict. This is the gate the Bun-1.3.14 field bug taught us to build:
 * a runtime whose Windows raw-stdin bridge drops keys renders PERFECTLY (stdout is fine, `__uiprobe`
 * passes) and fails only here - so this runs in CI and in release right next to `__uiprobe`.
 *
 * Usage: bun scripts/input-probe.ts [path-to-binary]   (default: dist/neko + .exe on Windows)
 * Exit 0 = input path alive; exit 1 = keys never arrived (runtime/stdin regression).
 */
const target = process.argv[2] ?? (process.platform === "win32" ? "dist/neko.exe" : "dist/neko");

const Terminal = (Bun as any).Terminal;
if (typeof Terminal !== "function") {
  console.error("input-probe: this Bun has no Bun.Terminal (PTY) API - cannot probe. Failing closed.");
  process.exit(1);
}

let screen = "";
const term = new Terminal({
  cols: 100,
  rows: 30,
  data(_t: unknown, chunk: Uint8Array) {
    screen += new TextDecoder().decode(chunk);
  },
});

const proc = Bun.spawn({ cmd: [target, "doctor", "keys"], terminal: term } as any);

// Wait for a screen condition with a deadline (the child renders asynchronously through the PTY).
async function waitFor(what: string, test: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (test()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  console.error(`input-probe: timed out waiting for ${what}. Screen so far:\n${screen.slice(-2000)}`);
  return false;
}

let ok = false;
// The probe banner means raw mode is on and the child is listening.
if (await waitFor("the key-probe banner", () => screen.includes("Key probe:"), 15000)) {
  term.write("h");
  // 68 = 'h' echoed back as hex by `doctor keys` - the byte made the full round trip
  // (our write -> PTY -> child raw stdin -> child stdout -> PTY -> us).
  if (await waitFor('the echoed 68 "h" byte', () => screen.includes("68"), 10000)) {
    term.write("q"); // stops the probe early -> verdict prints
    ok = await waitFor("the verdict", () => screen.includes("input arrives normally"), 10000);
  }
}

// Teardown: kill first if needed, then close the PTY.
const exited = await Promise.race([proc.exited, new Promise((r) => setTimeout(() => r(null), 3000))]);
if (exited === null) proc.kill();
term.close();

if (ok) {
  console.log(`input-probe: OK - ${target} hears the keyboard through a real PTY (h -> 68 -> verdict).`);
  process.exit(0);
}
console.error(`input-probe: FAILED - keys do not reach ${target}. This is the runtime raw-stdin regression class.`);
process.exit(1);
