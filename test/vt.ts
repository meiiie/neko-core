/**
 * VirtualTerminal - a small VT interpreter for tests: replay EVERY byte the app writes and inspect the
 * resulting grid. Supports what Neko's pipeline emits (Ink standard frames + the FrameDiffer's output +
 * alt-screen/mouse/OSC control): text, \r\n, CUU/CUD/CUF/CUB, CHA(G), CUP(H/f), ED(J 0/2/3), EL(K 0/1/2),
 * SU/SD(S/T), DECSTBM(r), SGR(m, ignored), private set/reset (?..h/l, ignored), DECSC/DECRC (ESC 7/8),
 * OSC (skipped to BEL/ST). Bottom-of-region \n scrolls, like a real terminal. No line wrap (Ink
 * pre-wraps; overflow is clipped) - good enough to detect black screens and misplaced content.
 */
export class VirtualTerminal {
  grid: string[] = [];
  r = 0; c = 0;
  top = 0; bottom: number;
  private saved: { r: number; c: number } | null = null;

  constructor(public cols: number, public rows: number) {
    this.grid = Array.from({ length: rows }, () => "");
    this.bottom = rows - 1;
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    while (this.grid.length < rows) this.grid.push("");
    this.grid.length = rows;
    this.rows = rows;
    this.top = 0; this.bottom = rows - 1;
    this.r = Math.min(this.r, rows - 1);
  }

  private scrollUp(n: number): void {
    for (let k = 0; k < n; k++) { this.grid.splice(this.top, 1); this.grid.splice(this.bottom, 0, ""); }
  }
  private scrollDown(n: number): void {
    for (let k = 0; k < n; k++) { this.grid.splice(this.bottom, 1); this.grid.splice(this.top, 0, ""); }
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
        if ((m = /^\x1b\[([0-9;]*)([A-Za-z])/.exec(rest))) {
          const nums = m[1].split(";").map((x) => parseInt(x, 10));
          const n = Number.isFinite(nums[0]) ? nums[0] : 1;
          const fin = m[2];
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
            if (mode === 2 || mode === 3) { for (let k = 0; k < this.rows; k++) this.grid[k] = ""; }
            else if (mode === 0) { this.grid[this.r] = this.grid[this.r].slice(0, this.c); for (let k = this.r + 1; k < this.rows; k++) this.grid[k] = ""; }
          } else if (fin === "K") {
            const mode = Number.isFinite(nums[0]) ? nums[0] : 0;
            if (mode === 2) this.grid[this.r] = "";
            else if (mode === 1) this.grid[this.r] = " ".repeat(Math.min(this.c + 1, this.grid[this.r].length)) + this.grid[this.r].slice(this.c + 1);
            else this.grid[this.r] = this.grid[this.r].slice(0, this.c);
          } else if (fin === "X") { // ECH: blank n chars at the cursor, no move (ConPTY emits these)
            const count = Math.max(1, n);
            const line = this.grid[this.r].padEnd(this.c, " ");
            this.grid[this.r] = line.slice(0, this.c) + " ".repeat(count) + line.slice(this.c + count);
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
        if (this.r === this.bottom) this.scrollUp(1);
        else this.r = Math.min(this.rows - 1, this.r + 1);
        this.c = 0;
      } else if (ch === "\r") this.c = 0;
      else if (ch >= " ") {
        if (this.c < this.cols) {
          const line = this.grid[this.r].padEnd(this.c, " ");
          this.grid[this.r] = line.slice(0, this.c) + ch + line.slice(this.c + 1);
        }
        this.c++;
      }
      i++;
    }
  }

  /** Rendered rows, trailing-space-trimmed. */
  lines(): string[] { return this.grid.map((l) => l.replace(/\s+$/, "")); }
  text(): string { return this.lines().join("\n"); }
  /** True when nothing at all is on screen - the "black screen" detector. */
  isBlank(): boolean { return this.lines().every((l) => l === ""); }
}
