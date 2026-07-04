import { expect, test } from "bun:test";
import { detectShift, FrameDiffer, parseInkPayload } from "../src/ui/frame-diff.ts";

/** Minimal virtual terminal: interprets exactly the sequences the differ emits (CUP/CUU/CUD/CR-col1/
 * EL/2K/SU/SD/DECSTBM) plus plain text + newlines, so tests can PROVE the optimized bytes reproduce
 * the same screen a full rewrite would. */
class Screen {
  grid: string[];
  r = 0; c = 0; // 0-based cursor
  top = 0; bottom: number;
  constructor(public h: number) { this.grid = Array.from({ length: h }, () => ""); this.bottom = h - 1; }
  write(s: string): void {
    let i = 0;
    while (i < s.length) {
      const csi = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(s.slice(i));
      if (csi) {
        const [seq, params, fin] = [csi[0], csi[1], csi[2]];
        const nums = params.split(";").map((x) => parseInt(x, 10));
        const n = Number.isFinite(nums[0]) ? nums[0] : 1;
        if (fin === "A") this.r = Math.max(0, this.r - n);
        else if (fin === "B") this.r = Math.min(this.h - 1, this.r + n);
        else if (fin === "G") this.c = 0;
        else if (fin === "H") { this.r = Math.max(0, (Number.isFinite(nums[0]) ? nums[0] : 1) - 1); this.c = Math.max(0, (Number.isFinite(nums[1]) ? nums[1] : 1) - 1); }
        else if (fin === "K") { if (params === "2") { this.grid[this.r] = ""; } else { this.grid[this.r] = this.grid[this.r].slice(0, this.c); } }
        else if (fin === "S") { for (let k = 0; k < n; k++) { this.grid.splice(this.top, 1); this.grid.splice(this.bottom, 0, ""); } }
        else if (fin === "T") { for (let k = 0; k < n; k++) { this.grid.splice(this.bottom, 1); this.grid.splice(this.top, 0, ""); } }
        else if (fin === "r") { this.top = Number.isFinite(nums[0]) ? nums[0] - 1 : 0; this.bottom = Number.isFinite(nums[1]) ? nums[1] - 1 : this.h - 1; this.r = 0; this.c = 0; }
        else if (fin === "m") { /* SGR: tests use plain text */ }
        i += seq.length;
        continue;
      }
      const ch = s[i];
      if (ch === "\n") { this.r = Math.min(this.h - 1, this.r + 1); this.c = 0; }
      else if (ch === "\r") this.c = 0;
      else {
        const line = this.grid[this.r].padEnd(this.c, " ");
        this.grid[this.r] = line.slice(0, this.c) + ch + line.slice(this.c + 1);
        this.c++;
      }
      i++;
    }
  }
  lines(n: number): string[] { return this.grid.slice(0, n).map((l) => l.replace(/\s+$/, "")); }
}

const erase = (n: number) => ("\x1b[2K" + "\x1b[1A\x1b[2K".repeat(Math.max(0, n - 1))) + "\x1b[G";
const payload = (prevCount: number, frame: string[]) => erase(prevCount) + frame.join("\n");

/** Drive the differ through seed frames, then return the optimized bytes for `next`. */
function seedAndProcess(d: FrameDiffer, a: string[], b: string[], next: string[]): string | null {
  expect(d.process(payload(0, a) === payload(0, a) ? a.join("\n") : "")).toBe(null); // first render: no erase prefix -> passthrough
  expect(d.process(payload(a.length, b))).toBe(null); // seeds the baseline
  return d.process(payload(b.length, next));
}

test("parseInkPayload accepts the standard shape, rejects everything else", () => {
  expect(parseInkPayload(erase(3) + "a\nb\nc")).toEqual({ eraseCount: 3, frame: "a\nb\nc" });
  expect(parseInkPayload("\x1b[2J\x1b[H")).toBe(null);            // wipe
  expect(parseInkPayload("plain first frame")).toBe(null);         // no erase prefix
  expect(parseInkPayload(erase(2) + "x\x1b[3Ay")).toBe(null);      // cursor moves inside a "frame"
});

test("line-diff: only the changed line is rewritten, and the screen matches a full rewrite", () => {
  const d = new FrameDiffer();
  const A = ["r0", "r1", "r2", "r3"];
  const B = ["r0", "r1", "r2", "> input"];
  const C = ["r0", "r1", "r2", "> inputX"];
  const out = seedAndProcess(d, A, B, C)!;
  expect(out).not.toBe(null);
  expect(out.length).toBeLessThan(payload(4, C).length / 2); // far smaller than the full rewrite
  expect(out).not.toContain("r1");                            // unchanged lines are not resent
  const scr = new Screen(10);
  for (const [i, l] of B.entries()) { scr.r = i; scr.c = 0; scr.write(l); } // screen currently shows B
  scr.r = B.length - 1; scr.c = B[B.length - 1].length;       // cursor where Ink leaves it
  scr.write(out);
  expect(scr.lines(4)).toEqual(C);
  expect(scr.r).toBe(C.length - 1);                            // ends on the last frame line (Ink's assumption)
});

test("fullscreen scroll: emitted as DECSTBM hardware shift + only revealed rows painted", () => {
  const d = new FrameDiffer();
  d.setBand({ top: 1, height: 10 });
  const mk = (start: number) => Array.from({ length: 10 }, (_, i) => `line-${start + i}`).concat(["chrome", "> input"]);
  const A = mk(0), B = mk(0), C = mk(3); // scroll down by 3: content moved up
  const out = seedAndProcess(d, A, B, C)!;
  expect(out).toContain("\x1b[1;10r"); // scroll region = the band
  expect(out).toContain("\x1b[3S");    // hardware scroll up by 3
  expect(out).not.toContain("line-4"); // surviving rows are NOT rewritten...
  expect(out).toContain("line-12");    // ...only the revealed ones are
  const scr = new Screen(14);
  for (const [i, l] of B.entries()) { scr.r = i; scr.c = 0; scr.write(l); }
  scr.r = B.length - 1; scr.c = B[B.length - 1].length;
  scr.write(out);
  expect(scr.lines(12)).toEqual(C);
});

test("fullscreen scroll UP uses SD and paints the top rows", () => {
  const d = new FrameDiffer();
  d.setBand({ top: 1, height: 10 });
  const mk = (start: number) => Array.from({ length: 10 }, (_, i) => `ln-${start + i}`).concat(["chrome"]);
  const B = mk(5), C = mk(2); // user scrolled up by 3: content moved down
  const out = seedAndProcess(d, mk(5), B, C)!;
  expect(out).toContain("\x1b[3T");
  const scr = new Screen(12);
  for (const [i, l] of B.entries()) { scr.r = i; scr.c = 0; scr.write(l); }
  scr.r = B.length - 1; scr.c = B[B.length - 1].length;
  scr.write(out);
  expect(scr.lines(11)).toEqual(C);
});

test("neutral control writes (Ink's own BSU/ESU, cursor hide/show) do NOT reset the baseline", () => {
  const d = new FrameDiffer();
  const A = ["x", "y"], B = ["x", "y2"];
  d.process(A.join("\n"));                 // first render -> passthrough
  d.process(payload(2, A));                // seed baseline
  expect(d.process("\x1b[?2026h")).toBe(null); // Ink's BSU as its own write - must be neutral
  expect(d.process("\x1b[?25l")).toBe(null);   // cursor hide - neutral too
  const out = d.process(payload(2, B));    // baseline SURVIVED -> this optimizes
  expect(out).not.toBe(null);
  expect(out!.length).toBeLessThan(payload(2, B).length / 2);
});

test("compose-at-write-layer: blank Ink band gets the real rows; scroll repaints via hardware shift with NO Ink frame", () => {
  const d = new FrameDiffer();
  const emitted: string[] = [];
  d.setWriter((s) => emitted.push(s));
  d.setBand({ top: 1, height: 6 });
  const rows = Array.from({ length: 30 }, (_, i) => `content-${i}`);
  d.setBandContent(rows, 0);
  const blankBand = ["", "", "", "", "", ""];
  const chrome = ["chrome-a", "> input"];
  const F = (extra: string) => blankBand.concat([chrome[0], chrome[1] + extra]);
  // Seed: first frame (no erase prefix) -> passthrough raw; second frame -> composed FULL repaint.
  expect(d.process(F("").join("\n"))).toBe(null);
  const seeded = d.process(payload(8, F("")))!;
  expect(seeded).toContain("content-29"); // the "blank" band went out with real content spliced in
  // Screen state after the seed:
  const scr = new Screen(10);
  scr.write(seeded.replace(/^(\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G/, "")); // apply the frame body from row 0
  expect(scr.lines(6)).toEqual(rows.slice(24, 30));
  scr.r = 7; scr.c = ("> input").length; // cursor at Ink's last line
  // Keystroke: Ink frame changes ONLY the chrome; band lines stay blank in the payload.
  const key = d.process(payload(8, F("X")))!;
  expect(key).not.toContain("content-"); // band untouched - the write is ~just the input line
  scr.write(key);
  expect(scr.lines(8)).toEqual(rows.slice(24, 30).concat(["chrome-a", "> inputX"]));
  // Scroll: NO Ink frame at all - setBandContent repaints imperatively with a hardware shift.
  // (k=2 on a 6-row band: the shift detector needs span >= 4 surviving rows to be confident.)
  emitted.length = 0;
  d.setBandContent(rows, 2); // view moves up by 2 -> content shifts down -> SD
  expect(emitted.length).toBe(1);
  expect(emitted[0]).toContain("\x1b[2T");
  scr.write(emitted[0]);
  expect(scr.lines(6)).toEqual(rows.slice(22, 28));
  expect(scr.r).toBe(7); // cursor restored to Ink's assumed row
});

test("short band content is TOP-anchored (fresh session welcome at the top, not floating at the bottom)", () => {
  const d = new FrameDiffer();
  d.setBand({ top: 1, height: 6 });
  d.setBandContent(["w1", "w2", "w3"], 0); // only 3 rows of content in a 6-row band
  const blank = ["", "", "", "", "", "", "chrome"];
  d.process(blank.join("\n"));            // first render -> passthrough (seeds nothing)
  const seeded = d.process(payload(7, blank))!;
  const body = seeded.replace(/^(\x1b\[2K\x1b\[1A)*\x1b\[2K\x1b\[G/, "").split("\n");
  expect(body.slice(0, 3)).toEqual(["w1", "w2", "w3"]); // content at the TOP of the band
  expect(body.slice(3, 6)).toEqual(["", "", ""]);        // blanks BELOW it
});

test("identical frame skips the write; height change and weird payloads pass through", () => {
  const d = new FrameDiffer();
  const A = ["a", "b"], B = ["a", "b"];
  d.process(A.join("\n"));                      // first render (unparseable) -> passthrough
  d.process(payload(2, A));                     // seed
  expect(d.process(payload(2, B))).toBe("");    // identical -> skip entirely
  expect(d.process(payload(2, ["a", "b", "c"]))).toBe(null); // height change -> full rewrite
  expect(d.process("\x1b]52;c;abc\x07")).toBe(null);          // OSC (clipboard) -> untouched
});
