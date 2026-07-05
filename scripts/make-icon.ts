/**
 * Generate assets/neko.ico deterministically from pixel art - the Neko Core mascot (the banner's
 * ハ・・マ cat face) as a Windows executable icon, in the brand orange (#e6932e, src/ui/logo.tsx).
 *
 * Why generated, not drawn: the icon is CODE - reviewable, diffable, re-renderable at any size with
 * crisp nearest-neighbor pixels (on-brand with the pixel banner), and no binary-blob provenance
 * questions in a public repo. ICO entries are PNG-compressed (supported since Vista), so this needs
 * only a tiny PNG encoder (zlib deflate + crc32) and the ICO directory format.
 *
 *   bun scripts/make-icon.ts      -> assets/neko.ico (16/32/48/64/128/256) + assets/neko-icon.png (256)
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";

// 16x16 pixel art of the mascot ハ・・マ itself (owner: the kaomoji IS the brand - keep it verbatim,
// not a filled cat head). Thin 1px strokes + negative space = the refined look of the banner/logo:
//   ハ  two strokes splaying outward     ・・  two dot eyes      マ  top bar + diagonal
// o = brand orange, . = transparent. Rows are 16 chars, asserted below.
const ART = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "...oo......oooo.", // ハ apex               マ top bar
  "..o..o.......o..", // ハ splays             マ diagonal
  "..o..o.o.o..o...", // ハ        ・ ・       マ diagonal end
  ".o....o.........", // ハ
  ".o....o.........", // ハ feet
  "................",
  "................",
  "................",
  "................",
  "................",
];
const COLORS: Record<string, [number, number, number, number]> = {
  o: [0xe6, 0x93, 0x2e, 0xff], // brand orange (logo.tsx)
  k: [0x1e, 0x1e, 0x26, 0xff], // (unused in the kaomoji art; kept for future variants)
  ".": [0, 0, 0, 0],           // transparent
};
for (const [i, row] of ART.entries()) if (row.length !== 16) throw new Error(`ART row ${i} is ${row.length} chars, want 16`);

/** Render the 16x16 art to an RGBA buffer at `size` (nearest-neighbor - crisp pixel look). */
function raster(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const ay = Math.floor((y * 16) / size);
    for (let x = 0; x < size; x++) {
      const ax = Math.floor((x * 16) / size);
      const [r, g, b, a] = COLORS[ART[ay][ax]] ?? COLORS["."];
      const o = (y * size + x) * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = a;
    }
  }
  return px;
}

// --- minimal PNG encoder (RGBA8, filter 0 per row) ---
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function png(size: number): Uint8Array {
  const px = raster(size);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, size); dv.setUint32(4, size);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = new Uint8Array(size * (size * 4 + 1)); // filter byte 0 + row
  for (let y = 0; y < size; y++) raw.set(px.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// --- ICO container (PNG entries) ---
const SIZES = [16, 32, 48, 64, 128, 256];
const pngs = SIZES.map((s) => png(s));
const header = new Uint8Array(6 + SIZES.length * 16);
{
  const dv = new DataView(header.buffer);
  dv.setUint16(2, 1, true);              // type: icon
  dv.setUint16(4, SIZES.length, true);   // count
  let offset = header.length;
  SIZES.forEach((s, i) => {
    const e = 6 + i * 16;
    header[e] = s === 256 ? 0 : s;       // width (0 = 256)
    header[e + 1] = s === 256 ? 0 : s;   // height
    dv.setUint16(e + 4, 1, true);        // planes
    dv.setUint16(e + 6, 32, true);       // bpp
    dv.setUint32(e + 8, pngs[i].length, true);
    dv.setUint32(e + 12, offset, true);
    offset += pngs[i].length;
  });
}
const ico = new Uint8Array(header.length + pngs.reduce((n, p) => n + p.length, 0));
ico.set(header, 0);
{
  let off = header.length;
  for (const p of pngs) { ico.set(p, off); off += p.length; }
}
writeFileSync("assets/neko.ico", ico);
writeFileSync("assets/neko-icon.png", png(256)); // preview / docs
console.log(`assets/neko.ico written (${ico.length} bytes, sizes ${SIZES.join("/")}) + assets/neko-icon.png`);
