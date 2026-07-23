import { expect, test } from "bun:test";
import { CARET_SENTINEL, detectShift, FrameDiffer, HIT_SENTINEL, parseInkPayload } from "../src/ui/frame-diff.ts";
import { hitIndexAt, setHitTargets } from "../src/ui/hit-targets.ts";

// The hardware-scroll MECHANISM stays exercised here even though its default is platform-gated
// (off on Windows - ConPTY displaces region scrolls at live cadence; see chat.tsx differ note).
process.env.NEKO_HWSCROLL = "1";

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
      // Private-mode set/reset (cursor show/hide `?25h`/`?25l`, etc.): no effect on grid content.
      const priv = /^\x1b\[\?[0-9;]*[a-zA-Z]/.exec(s.slice(i));
      if (priv) { i += priv[0].length; continue; }
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
  d.process(a.join("\n"));            // first render (no erase prefix) seeds the baseline now
  d.process(payload(a.length, b));    // second frame diffs/updates the baseline
  return d.process(payload(b.length, next));
}

test("parseInkPayload accepts the standard shape (erase prefix OPTIONAL), rejects control writes", () => {
  expect(parseInkPayload(erase(3) + "a\nb\nc")).toEqual({ eraseCount: 3, frame: "a\nb\nc" });
  expect(parseInkPayload("plain first frame")).toEqual({ eraseCount: 0, frame: "plain first frame" }); // Ink's very first frame
  expect(parseInkPayload("\x1b[2J\x1b[H")).toBe(null);            // wipe
  expect(parseInkPayload(erase(2) + "x\x1b[3Ay")).toBe(null);      // cursor moves inside a "frame"
});

test("fullscreen full repaint erases a stale trailing spare row", () => {
  const d = new FrameDiffer();
  d.setBand({ top: 1, height: 15 });
  // Production fullscreen owns rows-1; row 20 is the physical spare that prevents bottom-right scroll.
  const frame = ["top", ...Array.from({ length: 18 }, () => "")];
  const screen = new Screen(20);
  screen.r = 19;
  screen.write("STALE STATUS"); // terminal resize/reflow can leave content in the reserved last row
  screen.write(d.process(frame.join("\n"))!);
  expect(screen.lines(20)[19]).toBe("");
});

test("caret hides when an overlay owns the screen (no lingering bar cursor over a picker)", () => {
  const d = new FrameDiffer();
  // Accumulate BOTH the writer path (seed/imperative) and the returned diff bytes.
  const all: string[] = [];
  d.setWriter((s) => all.push(s));
  d.setBand({ top: 1, height: 6 });
  // Input frame: the caret sentinel is present -> the hardware cursor is SHOWN + positioned.
  const r1 = d.process([`> hi${CARET_SENTINEL}`, "", "", "", "", ""].join("\n"));
  if (r1) all.push(r1);
  expect(all.join("")).toContain("\x1b[?25h"); // show cursor
  // Overlay frame: no sentinel (a picker replaced the input row) -> the cursor must be HIDDEN,
  // not left blinking in the corner (the stray `|` under the browser-setup picker).
  const r2 = d.process(payload(6, ["  Connect Neko Browser", "> Open Chrome setup again", "  Continue", "", "", ""]));
  const overlayBytes = (r2 ?? "") + all.slice(all.length).join("");
  expect(overlayBytes).toContain("\x1b[?25l");        // hide cursor
  expect(overlayBytes).not.toContain("\x1b[?25h");    // ...and NOT re-show it
});

test("resize wipe composes the new frame and never replays the stale pre-wipe frame", () => {
  const d = new FrameDiffer();
  const writes: string[] = [];
  d.setWriter((s) => writes.push(s));
  d.setBand({ top: 1, height: 26 });
  d.process(Array.from({ length: 32 }, (_, i) => i === 28 ? "> OLD PROMPT" : `old-${i}`).join("\n"));
  writes.length = 0;

  // Ink can resize through an explicit clear + full frame. The differ must compose THIS new frame (its
  // band is blank in Ink), not pass the blank band through and not retain the old 32-row lastRaw.
  const resized = d.process("\x1b[2J\x1b[H" + Array.from({ length: 20 }, (_, i) => i === 16 ? "> " : `new-${i}`).join("\n"));
  expect(resized).not.toBeNull();
  expect(resized).toContain("new-0");
  expect(resized).not.toContain("OLD PROMPT");
  d.setBand({ top: 1, height: 14 });
  writes.length = 0;
  d.forceFullRepaint();
  expect(writes.join("")).toContain("new-0");
  expect(writes.join("")).not.toContain("OLD PROMPT");
});

test("a skipped geometry refresh cannot publish hit targets from an unpainted frame", () => {
  const d = new FrameDiffer() as any;
  d.setWriter(() => {});
  d.prev = ["painted"];
  d.lastRaw = [`unpainted ${HIT_SENTINEL}action`, "extra row"];
  setHitTargets([{ row: 7, col: 3 }]);
  d.refreshCompose(); // dimensions differ: must return before extracting/publishing the new marker
  expect(hitIndexAt(3, 7)).toBe(0);
  expect(hitIndexAt(20, 1)).toBe(-1);
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

test("parseInkPayload rejects an OSC 52 clipboard write (must pass through, not be spliced into the band)", () => {
  expect(parseInkPayload("\x1b]52;c;" + Buffer.from("Nga - Ukraine").toString("base64") + "\x07")).toBe(null);
});

test("selection: screenText extracts on-screen text; setSelection highlights the region (inverse)", () => {
  const d = new FrameDiffer();
  const writes: string[] = [];
  d.setWriter((s) => writes.push(s));
  d.setBand({ top: 1, height: 3 });
  d.setBandContent(["  hello world", "  second line", "  third row"], 0); // 2-space gutter + content
  d.process(["", "", "", "> input"].join("\n"));  // Ink renders the band BLANK; compose splices the real rows into prev
  // screenText reads the COMPOSED screen (1-based rows), stripped of SGR - what a copy should see.
  expect(d.screenText(1, 1)[0]).toBe("  hello world");
  expect(d.screenText(1, 3)).toEqual(["  hello world", "  second line", "  third row"]);
  // A selection over CONTENT row 0, screen cols 3..7 = "hello" (after the 2-col gutter) paints the
  // UNIFORM selection colour (solid blue bg + white fg), not per-char inverse. (dist 0 -> content row 0
  // shows at screen row 1.)
  writes.length = 0;
  d.setSelection({ r0: 0, c0: 3, r1: 0, c1: 7 });
  const out = writes.join("");
  expect(out).toContain("\x1b[48;5;25m"); // solid blue background opened at the selection start
  expect(out).toContain("\x1b[97m");       // bright-white text
  expect(out).toContain("\x1b[0m");        // block reset at its end
  // A MULTI-row selection with a width fills spanned rows out to a SOLID rectangle (not ragged): content
  // row 0 as the first row of a 2-row selection extends past its "hello world" text to the right edge.
  writes.length = 0;
  d.setSelection({ r0: 0, c0: 1, r1: 1, c1: 5 }, 30);
  expect(writes.join("")).toMatch(/hello world {10,}/); // content followed by a long run of padded spaces
  // Clearing repaints the row WITHOUT the selection colour.
  writes.length = 0;
  d.setSelection(null);
  expect(writes.join("")).toContain("hello world");
  expect(writes.join("")).not.toContain("\x1b[48;5;25m");
});

test("selection is CONTENT-anchored: it follows the text as the band scrolls (drag-past-fold)", () => {
  const d = new FrameDiffer();
  const writes: string[] = [];
  d.setWriter((s) => writes.push(s));
  d.setBand({ top: 1, height: 3 });
  // 6 content rows, viewport shows 3. Select CONTENT row 0 ("line-0") - which is ABOVE the fold when
  // scrolled to the tail (dist 0 shows rows 3,4,5). Scrolling up must bring the highlight into view.
  const rows = Array.from({ length: 6 }, (_, i) => `  line-${i}`);
  d.setBandContent(rows, 0);
  d.process(["", "", "", "> input"].join("\n"));
  d.setSelection({ r0: 0, c0: 1, r1: 0, c1: 8 }); // content row 0
  // At dist 0 the window is rows 3..5 - row 0 is off-screen, so NO highlight is painted.
  writes.length = 0;
  d.setBandContent(rows, 0);
  expect(writes.join("")).not.toContain("\x1b[48;5;25m");
  // Scroll all the way up (dist 3 -> window rows 0..2): content row 0 is now the top screen row and the
  // SAME selection now highlights it - the highlight followed the text, no re-anchoring by the caller.
  writes.length = 0;
  d.setBandContent(rows, 3);
  const up = writes.join("");
  expect(up).toContain("\x1b[48;5;25m"); // the selection is visible again after scrolling to it
  expect(up).toContain("line-0");
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
  // The very FIRST frame (no erase prefix) already goes out COMPOSED - a fullscreen start paints the
  // band immediately instead of leaving it blank until render #2 (the startup-black regression).
  const seeded = d.process(F("").join("\n"))!;
  expect(seeded).toContain("content-29"); // the "blank" band went out with real content spliced in
  // Screen state after the seed:
  const scr = new Screen(10);
  scr.write(seeded); // no erase prefix on a first frame - applies from row 0
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
  const seeded = d.process(blank.join("\n"))!; // first frame goes out composed (absolute rows now)
  const scr = new Screen(8);
  scr.write(seeded);
  expect(scr.lines(7)).toEqual(["w1", "w2", "w3", "", "", "", "chrome"]); // content at the TOP, blanks below
});

test("fullscreen seed/resync is DRIFT-PROOF: correct even when the cursor is NOT where Ink assumes", () => {
  // Image #63: at real-terminal entry (or right after a resize) the cursor row is unreliable; the old
  // seed used a RELATIVE erase + "\n" joins, so the whole frame slid one row - a ghosted duplicate input
  // line that persisted. The absolute seed must paint the same screen no matter where the cursor starts.
  const d = new FrameDiffer();
  d.setBand({ top: 1, height: 3 });
  d.setBandContent(["b0", "b1", "b2"], 0);
  const frame = ["", "", "", "rule", "> input", "status"];
  const seeded = d.process(frame.join("\n"))!;
  const want = ["b0", "b1", "b2", "rule", "> input", "status"];
  for (const startRow of [0, 3, 5]) { // wherever the cursor happens to be, the result is identical
    const scr = new Screen(7);
    scr.write("> input\n"); // stale junk a drifted first paint could have left
    scr.r = startRow; scr.c = 2;
    scr.write(seeded);
    expect(scr.lines(6)).toEqual(want);
  }
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

test("fullscreen line-diff uses ABSOLUTE addressing (row-shift/cursor-drift ghost-proof); inline stays relative", () => {
  // Fullscreen (band set): a changed chrome line is rewritten at an absolute CUP - immune to cursor
  // drift and to the chrome shifting rows (the startup double-input-box ghost).
  const dFS = new FrameDiffer();
  dFS.setBand({ top: 1, height: 3 });
  const A = ["b0", "b1", "b2", "chrome", "> "];       // band(3) + chrome
  const B = ["b0", "b1", "b2", "chrome", "> hi"];     // only the input line changed
  dFS.process(A.join("\n"));                           // seed
  const outFS = dFS.process(payload(5, B))!;
  expect(outFS).toMatch(/\x1b\[5;1H/);                 // absolute CUP to row 5 (the input)
  expect(outFS).not.toMatch(/\x1b\[\d+[AB]/);          // NO relative up/down moves
  // Apply to a screen and confirm exactness.
  const scr = new Screen(6);
  for (const [i, l] of A.entries()) { scr.r = i; scr.c = 0; scr.write(l); }
  scr.r = 4; scr.c = 2; scr.write(outFS);
  expect(scr.lines(5)).toEqual(B);

  // Inline (no band): relative addressing, as before (frame floats in scrollback). Change a NON-last
  // line so a relative up/down move is actually emitted.
  const dIn = new FrameDiffer();
  const outIn = seedAndProcess(dIn, ["r0", "r1", "r2"], ["r0", "r1", "r2"], ["r0X", "r1", "r2"])!;
  expect(outIn).toMatch(/\x1b\[\d+[AB]/);              // relative move present
  expect(outIn).not.toMatch(/\x1b\[\d+;1H/);           // ...and NOT absolute
});

test("streaming tail composes INTO the band right under the committed rows (top-down, in place)", () => {
  const d = new FrameDiffer();
  const emitted: string[] = [];
  d.setWriter((s) => emitted.push(s));
  d.setBand({ top: 1, height: 6 });
  d.setBandContent(["  cau hoi", "  tra loi cu"], 0, []);
  const blank = ["", "", "", "", "", "", "chrome"];
  const first = d.process(blank.join("\n"))!; // seed goes out composed (absolute rows)
  {
    const s0 = new Screen(8);
    s0.write(first);
    expect(s0.lines(2)).toEqual(["  cau hoi", "  tra loi cu"]);
  }
  // Stream arrives: the tail appends UNDER the committed rows - no jump, no bottom-up growth.
  emitted.length = 0;
  d.setBandContent(["  cau hoi", "  tra loi cu"], 0, ["", "  dang go..."]);
  expect(emitted.length).toBe(1);
  const scr = new Screen(8);
  scr.write(first);
  scr.r = 6; scr.c = 6; // cursor on Ink's last line
  scr.write(emitted[0]);
  expect(scr.lines(4)).toEqual(["  cau hoi", "  tra loi cu", "", "  dang go..."]);
});

test("hardware caret: the CARET_SENTINEL is stripped and drives a cursor at its column", async () => {
  const { CARET_SENTINEL } = await import("../src/ui/frame-diff.ts");
  const d = new FrameDiffer();
  const writes: string[] = [];
  d.setWriter((s) => writes.push(s));
  d.setBand({ top: 1, height: 3 });
  d.setBandContent(["  row a", "  row b", "  row c"], 0);
  // A frame whose INPUT row (row 5, 1-based) carries the sentinel between "xin ch" and "ao".
  const inputRow = "  > xin ch" + CARET_SENTINEL + "ao";
  const out = d.process(["", "", "", "", inputRow].join("\n"))!;
  // The sentinel never reaches the screen...
  expect(out).not.toContain(CARET_SENTINEL);
  // ...it shows the cursor (a bar) at row 5, at the sentinel's display column. "  > xin ch" = 10 cells,
  // so the cursor sits at column 11 (just before "a").
  expect(out).toContain("\x1b[?25h");   // cursor shown
  expect(out).toMatch(/\x1b\[\d+ q/);    // DECSCUSR shape (a bar by default)
  expect(out).toContain("\x1b[5;11H");   // CUP: row 5, col 11
  // Feed a frame with NO sentinel (a menu owns the screen) -> no cursor control is appended.
  const out2 = d.process(["", "", "", "", "  no caret here"].join("\n"))!;
  expect(out2).not.toContain("\x1b[?25h");
});

test("caret-only move (same visible text, cursor shifts) STILL repositions the hardware cursor", async () => {
  const { CARET_SENTINEL } = await import("../src/ui/frame-diff.ts");
  const d = new FrameDiffer();
  d.setWriter(() => {});
  d.setBand({ top: 1, height: 3 });
  d.setBandContent(["  a", "  b", "  c"], 0);
  const S = CARET_SENTINEL;
  const eol = ["", "", "", "  > xin chao" + S];
  const mid = ["", "", "", "  > xin cha" + S + "o"];
  d.process(eol.join("\n"));       // first render seeds (no erase prefix)
  d.process(payload(4, eol));      // settle the baseline with the erase prefix Ink really sends
  // Left arrow: the VISIBLE text is identical ("  > xin chao"), only the zero-width sentinel moved one
  // char earlier. The stripped rows are identical, so the diff is "" - but the cursor MUST still move.
  const out = d.process(payload(4, mid))!;
  expect(out).not.toBe("");               // NOT skipped despite identical visible text
  expect(out).toContain("\x1b[?25h");     // cursor shown + repositioned
  expect(out).toMatch(/\x1b\[\d+;\d+H/);  // an absolute CUP (the new caret column)
  // Sentinel didn't move again -> a truly identical frame IS skipped.
  expect(d.process(payload(4, mid))).toBe("");
});

test("parseInkPayload ACCEPTS a frame containing an OSC 8 hyperlink (zero-width text attribute, like SGR)", () => {
  const linked = "xem \x1b]8;;https://tiki.vn/p/1\x07https://tiki.vn/p/1\x1b]8;;\x07 nhe";
  expect(parseInkPayload(linked)).toEqual({ eraseCount: 0, frame: linked });
  // ...while OSC 52 (clipboard) and other OSC writes still pass through untouched (null).
  expect(parseInkPayload("\x1b]52;c;YQ==\x07")).toBe(null);
  expect(parseInkPayload("\x1b]0;title\x07")).toBe(null);
});

test("selection + links: screenText strips OSC 8 (copy yields the visible url), and the highlight never swallows the URI", () => {
  const d = new FrameDiffer();
  const writes: string[] = [];
  d.setWriter((s) => writes.push(s));
  d.setBand({ top: 1, height: 2 });
  const url = "https://tiki.vn/p/123";
  const linkedRow = "  xem \x1b]8;;" + url + "\x07" + url + "\x1b]8;;\x07 nhe";
  d.setBandContent([linkedRow, "  plain row"], 0);
  d.process(["", "", "> input"].join("\n"));
  // Copy: OSC wrappers stripped, the VISIBLE url remains (a copied link is still a link).
  expect(d.screenText(1, 1)[0]).toBe("  xem " + url + " nhe");
  // Selection over cols 3..9 ("xem " + start of the url): the block closes any open hyperlink FIRST
  // and drops link sequences inside, so the URI bytes never render as selected text.
  writes.length = 0;
  d.setSelection({ r0: 0, c0: 3, r1: 0, c1: 9 });
  const out = writes.join("");
  expect(out).toContain("\x1b]8;;\x07\x1b[48;5;25m"); // hyperlink closed, then the highlight opens
  const inside = out.slice(out.indexOf("\x1b[48;5;25m"));
  expect(inside).not.toContain("\x1b]8;;https"); // no link OPEN inside/after the selection block on this row
  // Column math skipped the zero-width OSC: the selected run starts at the same screen text ("em " + url head).
  expect(d.screenText(1, 1)[0].slice(2, 9)).toBe("xem htt");
});
