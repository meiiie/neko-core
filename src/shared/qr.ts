/**
 * Tiny zero-dependency QR encoder (byte mode, EC level L, versions 1-5) + a terminal renderer.
 * Used by /relay to print a scannable pairing code so you point your phone's camera at the terminal
 * and it opens the pairing URL — no copying a long string. Generated 100% locally (the URL carries the
 * E2E secret, so it must NEVER go to an online QR service).
 *
 * Scope is deliberately small: versions 1-5 are single-block in EC-L (no codeword interleaving), which
 * keeps the encoder simple and robust. That holds ~106 bytes — enough for a workers.dev pairing URL.
 * Longer payloads return null (the caller falls back to printing the URL). Spec: ISO/IEC 18004.
 */

// ---- GF(256) arithmetic (primitive polynomial 0x11d) ----
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();
const gmul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** Reed-Solomon EC codewords for `data` (deg = number of EC codewords). */
export function ecCodewords(data: number[], deg: number): number[] {
  // generator polynomial (gen[0] = highest degree = 1)
  let gen = [1];
  for (let i = 0; i < deg; i++) {
    const next = new Array(gen.length + 1).fill(0);
    for (let j = 0; j < gen.length; j++) {
      next[j] ^= gen[j];
      next[j + 1] ^= gmul(gen[j], EXP[i]);
    }
    gen = next;
  }
  // polynomial division; remainder = EC codewords
  const rem = new Array(deg).fill(0);
  for (const d of data) {
    const factor = d ^ rem[0];
    rem.shift();
    rem.push(0);
    for (let i = 0; i < deg; i++) rem[i] ^= gmul(gen[i + 1], factor);
  }
  return rem;
}

// ---- version table (EC-L, single block): size, data codewords, EC codewords, alignment center ----
interface Ver { size: number; data: number; ec: number; align: number }
const VERSIONS: Ver[] = [
  { size: 21, data: 19, ec: 7, align: 0 },
  { size: 25, data: 34, ec: 10, align: 18 },
  { size: 29, data: 55, ec: 15, align: 22 },
  { size: 33, data: 80, ec: 20, align: 26 },
  { size: 37, data: 108, ec: 26, align: 30 },
];

/** BCH(15,5) format info for EC level + mask, masked with 0x5412. */
function formatInfo(ecBits: number, mask: number): number {
  const data = (ecBits << 3) | mask; // 5 bits
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >> 9) & 1 ? 0x537 : 0);
  return (((data << 10) | (rem & 0x3ff)) ^ 0x5412) & 0x7fff;
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

type Grid = Int8Array[]; // -1 unset, 0 light, 1 dark

function blank(size: number): Grid {
  return Array.from({ length: size }, () => new Int8Array(size).fill(-1));
}

function placeFinder(m: Grid, fn: boolean[][], r: number, c: number) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= m.length || cc >= m.length) continue;
      const inRing = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const isDark = inRing && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      m[rr][cc] = isDark ? 1 : 0;
      fn[rr][cc] = true;
    }
  }
}

function placeAlign(m: Grid, fn: boolean[][], cr: number, cc: number) {
  for (let dr = -2; dr <= 2; dr++) {
    for (let dc = -2; dc <= 2; dc++) {
      const isDark = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
      m[cr + dr][cc + dc] = isDark ? 1 : 0;
      fn[cr + dr][cc + dc] = true;
    }
  }
}

function buildFunctionPatterns(v: Ver): { m: Grid; fn: boolean[][] } {
  const size = v.size;
  const m = blank(size);
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  placeFinder(m, fn, 0, 0);
  placeFinder(m, fn, 0, size - 7);
  placeFinder(m, fn, size - 7, 0);
  // timing patterns
  for (let i = 8; i < size - 8; i++) {
    const bit = i % 2 === 0 ? 1 : 0;
    if (m[6][i] === -1) { m[6][i] = bit; fn[6][i] = true; }
    if (m[i][6] === -1) { m[i][6] = bit; fn[i][6] = true; }
  }
  if (v.align) placeAlign(m, fn, v.align, v.align);
  // dark module
  m[size - 8][8] = 1;
  fn[size - 8][8] = true;
  // reserve format areas (filled later) so data placement skips them
  for (let i = 0; i < 9; i++) {
    if (!fn[8][i]) fn[8][i] = true;
    if (!fn[i][8]) fn[i][8] = true;
  }
  for (let i = 0; i < 8; i++) {
    fn[8][size - 1 - i] = true;
    fn[size - 1 - i][8] = true;
  }
  return { m, fn };
}

function placeData(m: Grid, fn: boolean[][], bits: number[]) {
  const size = m.length;
  let bi = 0;
  let upward = true;
  for (let col = size - 1; col >= 1; col -= 2) {
    const c0 = col === 6 ? 5 : col; // skip the vertical timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let c = 0; c < 2; c++) {
        const cc = c0 - c;
        if (!fn[row][cc]) {
          m[row][cc] = bi < bits.length ? bits[bi++] : 0;
        }
      }
    }
    upward = !upward;
  }
}

function penalty(m: Grid): number {
  const size = m.length;
  let p = 0;
  // rule 1: runs of 5+ same color in rows/cols
  for (let r = 0; r < size; r++) {
    for (let dir = 0; dir < 2; dir++) {
      let run = 1;
      for (let c = 1; c < size; c++) {
        const a = dir ? m[c][r] : m[r][c];
        const b = dir ? m[c - 1][r] : m[r][c - 1];
        if (a === b) { run++; if (run === 5) p += 3; else if (run > 5) p += 1; }
        else run = 1;
      }
    }
  }
  // rule 2: 2x2 blocks of same color
  for (let r = 0; r < size - 1; r++)
    for (let c = 0; c < size - 1; c++)
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) p += 3;
  // rule 3: finder-like pattern 1:1:3:1:1
  const pat1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
  const pat2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c <= size - 11; c++) {
      let m1 = true;
      let m2 = true;
      let v1 = true;
      let v2 = true;
      for (let k = 0; k < 11; k++) {
        if (m[r][c + k] !== pat1[k]) m1 = false;
        if (m[r][c + k] !== pat2[k]) m2 = false;
        if (m[c + k][r] !== pat1[k]) v1 = false;
        if (m[c + k][r] !== pat2[k]) v2 = false;
      }
      if (m1 || m2) p += 40;
      if (v1 || v2) p += 40;
    }
  }
  // rule 4: dark/light balance
  let dark = 0;
  for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) if (m[r][c] === 1) dark++;
  const ratio = (dark * 100) / (size * size);
  p += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return p;
}

function applyFormat(m: Grid, ecBits: number, mask: number) {
  const size = m.length;
  const bits = formatInfo(ecBits, mask);
  const get = (i: number) => (bits >> i) & 1;
  // copy 1: around top-left finder
  for (let i = 0; i <= 5; i++) m[8][i] = get(i);
  m[8][7] = get(6);
  m[8][8] = get(7);
  m[7][8] = get(8);
  for (let i = 9; i < 15; i++) m[14 - i][8] = get(i);
  // copy 2: split across top-right + bottom-left
  for (let i = 0; i <= 7; i++) m[size - 1 - i][8] = get(i);
  for (let i = 8; i < 15; i++) m[8][size - 15 + i] = get(i);
  m[size - 8][8] = 1; // dark module (re-assert)
}

/** Encode `text` (UTF-8, byte mode) to a boolean module matrix, or null if it doesn't fit V1-5 EC-L. */
export function qrMatrix(text: string): boolean[][] | null {
  const bytes = Array.from(new TextEncoder().encode(text));
  const v = VERSIONS.find((ver) => bytes.length + 2 <= ver.data); // +2: mode nibble + 8-bit count + terminator headroom
  if (!v) return null;

  // bit stream: mode(0100) + count(8 bits) + data bytes
  const bitbuf: number[] = [];
  const push = (val: number, len: number) => { for (let i = len - 1; i >= 0; i--) bitbuf.push((val >> i) & 1); };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  // terminator + pad to byte boundary
  const cap = v.data * 8;
  for (let i = 0; i < 4 && bitbuf.length < cap; i++) bitbuf.push(0);
  while (bitbuf.length % 8 !== 0) bitbuf.push(0);
  // pad codewords
  const padBytes = [0xec, 0x11];
  let pi = 0;
  while (bitbuf.length < cap) { push(padBytes[pi++ % 2], 8); }

  // to codewords
  const dataCw: number[] = [];
  for (let i = 0; i < bitbuf.length; i += 8) {
    let b = 0;
    for (let k = 0; k < 8; k++) b = (b << 1) | bitbuf[i + k];
    dataCw.push(b);
  }
  const ecCw = ecCodewords(dataCw, v.ec);
  const allCw = [...dataCw, ...ecCw];
  const bits: number[] = [];
  for (const cw of allCw) for (let i = 7; i >= 0; i--) bits.push((cw >> i) & 1);

  // build, place data, pick best mask
  const base = buildFunctionPatterns(v);
  let best: Grid | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = base.m.map((row) => Int8Array.from(row));
    placeData(m, base.fn, bits);
    for (let r = 0; r < v.size; r++)
      for (let c = 0; c < v.size; c++)
        if (!base.fn[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1;
    applyFormat(m, 0b01 /* EC-L */, mask);
    const score = penalty(m);
    if (score < bestScore) { bestScore = score; best = m; }
  }
  return best!.map((row) => Array.from(row, (x) => x === 1));
}

/** Render a module matrix to a compact terminal string (2 rows per line via half-blocks, quiet zone). */
export function qrToText(matrix: boolean[][], quiet = 2): string {
  const size = matrix.length;
  const dark = (r: number, c: number) => r >= 0 && c >= 0 && r < size && c < size && matrix[r][c];
  const lines: string[] = [];
  const total = size + quiet * 2;
  // light module -> filled block (bright on a dark terminal), dark module -> space => dark-on-light look
  for (let r = -quiet; r < size + quiet; r += 2) {
    let line = "";
    for (let c = -quiet; c < size + quiet; c++) {
      const top = !dark(r, c); // light = filled
      const bot = !dark(r + 1, c);
      line += top && bot ? "█" : top ? "▀" : bot ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}
