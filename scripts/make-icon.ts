/**
 * Generate assets/neko.ico from the EXACT mascot pixels of the banner (ハ・・マ) - owner call: the
 * kaomoji is the brand, keep it verbatim (image #68). assets/mascot-art.txt is a 1:1 dump of the
 * banner's mascot region (192x52, '#' = glyph), extracted once from assets/neko-core-banner.png; this
 * script renders it in brand orange (#e6932e, src/ui/logo.tsx) on transparency at every icon size.
 *
 * Downscaling uses COVERAGE sampling, not nearest-neighbor: the mascot's strokes are 7-12px in a
 * 192px-wide art, so at 16px NN would skip entire strokes (sampling every ~14px) - a cell lights up
 * when >=18% of the art it covers is glyph, which keeps every stroke present at 1px instead.
 *
 *   bun scripts/make-icon.ts   -> assets/neko.ico (16/32/48/64/128/256) + assets/neko-icon.png (256)
 */
import { deflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";

const ART = readFileSync("assets/mascot-art.txt", "utf-8").split("\n").filter((l) => l.length > 0);
const AW = ART[0].length, AH = ART.length;
for (const [i, row] of ART.entries()) if (row.length !== AW) throw new Error(`mascot-art row ${i}: ${row.length} chars, want ${AW}`);
const ORANGE: [number, number, number, number] = [0xe6, 0x93, 0x2e, 0xff];

/** Render the mascot centered on a size x size transparent canvas (content ~87% of width). */
function raster(size: number): Uint8Array {
  const px = new Uint8Array(size * size * 4);
  const cw = Math.max(1, Math.round(size * 0.875));         // content width
  const ch = Math.max(1, Math.round((cw * AH) / AW));       // keep the mascot's aspect
  const x0 = Math.floor((size - cw) / 2), y0 = Math.floor((size - ch) / 2);
  for (let y = 0; y < ch; y++) {
    const ay0 = Math.floor((y * AH) / ch), ay1 = Math.max(ay0 + 1, Math.floor(((y + 1) * AH) / ch));
    for (let x = 0; x < cw; x++) {
      const ax0 = Math.floor((x * AW) / cw), ax1 = Math.max(ax0 + 1, Math.floor(((x + 1) * AW) / cw));
      let dark = 0, total = 0;
      for (let ay = ay0; ay < ay1; ay++) for (let ax = ax0; ax < ax1; ax++) { total++; if (ART[ay][ax] === "#") dark++; }
      if (dark / total >= 0.18) {
        const o = ((y0 + y) * size + (x0 + x)) * 4;
        px[o] = ORANGE[0]; px[o + 1] = ORANGE[1]; px[o + 2] = ORANGE[2]; px[o + 3] = 255;
      }
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
