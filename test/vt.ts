/**
 * VirtualTerminal - a small VT interpreter for tests: replay EVERY byte the app writes and inspect the
 * resulting grid. Supports what Neko's pipeline emits (Ink standard frames + the FrameDiffer's output +
 * alt-screen/mouse/OSC control): text, \r\n, CUU/CUD/CUF/CUB, CHA(G), CUP(H/f), ED(J 0/2/3), EL(K 0/1/2),
 * SU/SD(S/T), DECSTBM(r), SGR(m, ignored), private set/reset (?..h/l, ignored), DECSC/DECRC (ESC 7/8),
 * OSC (skipped to BEL/ST). Bottom-of-region \n scrolls, like a real terminal. LAZY autowrap (xterm
 * DECAWM): a char at the last column sets pending-wrap; the NEXT printable char wraps (scrolls at the
 * bottom). The grid is display-cell based (Bun.stringWidth + grapheme segmentation), so Vietnamese
 * combining marks, CJK, and emoji occupy the same columns as the real terminal.
 */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class VirtualTerminal {
  grid: string[][] = [];
  r = 0; c = 0;
  top = 0; bottom: number;
  private saved: { r: number; c: number } | null = null;
  private pendingWrap = false;

  constructor(public cols: number, public rows: number) {
    this.grid = Array.from({ length: rows }, () => this.blankRow());
    this.bottom = rows - 1;
  }

  private blankRow(): string[] { return Array.from({ length: this.cols }, () => " "); }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    for (const row of this.grid) {
      while (row.length < cols) row.push(" ");
      row.length = cols;
    }
    while (this.grid.length < rows) this.grid.push(this.blankRow());
    this.grid.length = rows;
    this.rows = rows;
    this.top = 0; this.bottom = rows - 1;
    this.r = Math.min(this.r, rows - 1);
    this.c = Math.min(this.c, cols - 1);
    this.pendingWrap = false;
  }

  private scrollUp(n: number): void {
    for (let k = 0; k < n; k++) { this.grid.splice(this.top, 1); this.grid.splice(this.bottom, 0, this.blankRow()); }
  }
  private scrollDown(n: number): void {
    for (let k = 0; k < n; k++) { this.grid.splice(this.bottom, 1); this.grid.splice(this.top, 0, this.blankRow()); }
  }

  private clearCell(row: number, col: number): void {
    if (col < 0 || col >= this.cols) return;
    const line = this.grid[row];
    if (line[col] === "" && col > 0) line[col - 1] = " "; // second cell of a wide glyph
    if (col + 1 < this.cols && line[col + 1] === "") line[col + 1] = " ";
    line[col] = " ";
  }

  private clearRange(row: number, start: number, end: number): void {
    for (let col = Math.max(0, start); col < Math.min(this.cols, end); col++) this.clearCell(row, col);
  }

  private lineFeed(): void {
    this.pendingWrap = false;
    if (this.r === this.bottom) this.scrollUp(1);
    else this.r = Math.min(this.rows - 1, this.r + 1);
    this.c = 0;
  }

  private writeGlyph(glyph: string): void {
    const width = Math.min(this.cols, Math.max(0, Bun.stringWidth(glyph)));
    if (width === 0) {
      let col = Math.min(this.cols - 1, this.c - 1);
      while (col > 0 && this.grid[this.r][col] === "") col--;
      if (col >= 0) this.grid[this.r][col] += glyph;
      return;
    }
    if (this.pendingWrap || this.c + width > this.cols) this.lineFeed();
    this.clearRange(this.r, this.c, this.c + width);
    this.grid[this.r][this.c] = glyph;
    for (let k = 1; k < width; k++) this.grid[this.r][this.c + k] = "";
    this.c += width;
    if (this.c >= this.cols) { this.c = this.cols - 1; this.pendingWrap = true; }
  }

  write(s: string): void {
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === "\x1b") {
        const rest = s.slice(i);
        let m: RegExpExecArray | null;
        if ((m = /^\x1b\[\?[0-9;]*[hl]/.exec(rest))) { i += m[0].length; continue; }       // private modes
        if ((m = /^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/.exec(rest))) { i += m[0].length; continue; } // OSC
        if (rest.startsWith("\x1b7")) { this.saved = { r: this.r, c: this.c }; i += 2; continue; }
        if (rest.startsWith("\x1b8")) { if (this.saved) { this.r = this.saved.r; this.c = this.saved.c; } i += 2; continue; }
        if ((m = /^\x1b\[([0-9;]*)([ -/]*)([@-~])/.exec(rest))) {
          const nums = m[1].split(";").map((x) => parseInt(x, 10));
          const n = Number.isFinite(nums[0]) ? nums[0] : 1;
          const fin = m[3];
          this.pendingWrap = false; // any CSI (cursor moves, erases) clears the deferred-wrap state
          if (fin === "A") this.r = Math.max(0, this.r - Math.max(1, n));
          else if (fin === "B") this.r = Math.min(this.rows - 1, this.r + Math.max(1, n));
          else if (fin === "C") this.c = Math.min(this.cols - 1, this.c + Math.max(1, n));
          else if (fin === "D") this.c = Math.max(0, this.c - Math.max(1, n));
          else if (fin === "G") this.c = Math.max(0, (Number.isFinite(nums[0]) ? nums[0] : 1) - 1);
          else if (fin === "H" || fin === "f") {
            this.r = Math.min(this.rows - 1, Math.max(0, (Number.isFinite(nums[0]) ? nums[0] : 1) - 1));
            this.c = Math.max(0, (Number.isFinite(nums[1]) ? nums[1] : 1) - 1);
          } else if (fin === "J") {
            const mode = Number.isFinite(nums[0]) ? nums[0] : 0;
            if (mode === 2 || mode === 3) { for (let k = 0; k < this.rows; k++) this.grid[k] = this.blankRow(); }
            else if (mode === 0) { this.clearRange(this.r, this.c, this.cols); for (let k = this.r + 1; k < this.rows; k++) this.grid[k] = this.blankRow(); }
          } else if (fin === "K") {
            const mode = Number.isFinite(nums[0]) ? nums[0] : 0;
            if (mode === 2) this.grid[this.r] = this.blankRow();
            else if (mode === 1) this.clearRange(this.r, 0, this.c + 1);
            else this.clearRange(this.r, this.c, this.cols);
          } else if (fin === "X") { // ECH: blank n chars at the cursor, no move (ConPTY emits these)
            const count = Math.max(1, n);
            this.clearRange(this.r, this.c, this.c + count);
          } else if (fin === "S") this.scrollUp(Math.max(1, n));
          else if (fin === "T") this.scrollDown(Math.max(1, n));
          else if (fin === "r") {
            this.top = Math.max(0, (Number.isFinite(nums[0]) ? nums[0] : 1) - 1);
            this.bottom = Math.min(this.rows - 1, (Number.isFinite(nums[1]) ? nums[1] : this.rows) - 1);
            this.r = 0; this.c = 0;
          }
          // m (SGR) and anything else: ignore
          i += m[0].length;
          continue;
        }
        i++; // lone ESC or unknown: skip
        continue;
      }
      if (ch === "\n") {
        this.lineFeed();
      } else if (ch === "\r") { this.c = 0; this.pendingWrap = false; }
      else if (ch >= " ") {
        let end = i;
        while (end < s.length && s[end] !== "\x1b" && s[end] !== "\n" && s[end] !== "\r" && s[end] >= " ") end++;
        const run = s.slice(i, end);
        for (const part of GRAPHEMES.segment(run)) this.writeGlyph(part.segment);
        i = end;
        continue;
      }
      i++;
    }
  }

  /** Rendered rows, trailing-space-trimmed. */
  lines(): string[] { return this.grid.map((row) => row.join("").replace(/\s+$/, "")); }
  text(): string { return this.lines().join("\n"); }
  /** True when nothing at all is on screen - the "black screen" detector. */
  isBlank(): boolean { return this.lines().every((l) => l === ""); }
}
