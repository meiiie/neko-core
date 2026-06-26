#!/usr/bin/env bun
/**
 * make-sheet.ts — turn a JSON array of offer rows into a real .xlsx with CLICKABLE hyperlinks,
 * a bold header, and an auto-filter (so the user sorts/filters in Excel). Zero dependencies:
 * hand-rolled OOXML inside a STORED (uncompressed) zip — opens in Excel/LibreOffice with no warning.
 *
 * Usage:  bun make-sheet.ts <rows.json> <out.xlsx> [--sheet "Name"]
 *   rows.json = [{ "Mặt hàng": "...", "Giá": 27990000, "Nguồn": "TGDĐ", "Link": "https://..." }, ...]
 *   Any column whose header is link/url/nguồn-link or whose value starts with http:// becomes a hyperlink
 *   (label = a sibling "*_text"/"Tên" column if present, else the URL).
 */
import { writeFileSync, readFileSync } from "node:fs";

// ---- CRC32 (required by zip even for STORED entries) ----
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- minimal STORED zip ----
type Entry = { name: string; data: Uint8Array };
function u16(n: number) { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]); }
function u32(n: number) { return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]); }
function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function zip(entries: Entry[]): Uint8Array {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const local = concat([
      u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(e.data.length), u32(e.data.length), u16(name.length), u16(0), name, e.data,
    ]);
    locals.push(local);
    centrals.push(concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
      u32(crc), u32(e.data.length), u32(e.data.length),
      u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name,
    ]));
    offset += local.length;
  }
  const cd = concat(centrals);
  const eocd = concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return concat([...locals, cd, eocd]);
}

// ---- xlsx building ----
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const colName = (i: number) => { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
const isUrl = (v: any) => typeof v === "string" && /^https?:\/\//i.test(v.trim());
const looksLink = (h: string) => /(^|[^a-z])(link|url)([^a-z]|$)|nguon.?link|đường dẫn/i.test(h);

function buildXlsx(rows: Record<string, any>[], sheetName: string): Uint8Array {
  const headers = Array.from(rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set<string>()));
  const linkCols = new Set(headers.filter((h, i) => looksLink(h) || rows.some((r) => isUrl(r[h]))));
  const nCols = headers.length;
  const nRows = rows.length + 1;

  const hyperlinks: string[] = [];
  const rels: string[] = [];
  let rId = 0;

  const cell = (rowI: number, colI: number, value: any, isHeader: boolean): string => {
    const ref = `${colName(colI)}${rowI + 1}`;
    const h = headers[colI];
    if (!isHeader && linkCols.has(h) && isUrl(value)) {
      rId++;
      hyperlinks.push(`<hyperlink ref="${ref}" r:id="rId${rId}"/>`);
      rels.push(`<Relationship Id="rId${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEsc(String(value))}" TargetMode="External"/>`);
      const label = String(value).length > 60 ? "mở link" : String(value);
      return `<c r="${ref}" t="inlineStr" s="2"><is><t>${xmlEsc(label)}</t></is></c>`;
    }
    if (!isHeader && typeof value === "number" && isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
    const text = value == null ? "" : String(value);
    return `<c r="${ref}" t="inlineStr"${isHeader ? ' s="1"' : ""}><is><t>${xmlEsc(text)}</t></is></c>`;
  };

  const rowsXml: string[] = [];
  rowsXml.push(`<row r="1">${headers.map((h, c) => cell(0, c, h, true)).join("")}</row>`);
  rows.forEach((r, ri) => {
    rowsXml.push(`<row r="${ri + 2}">${headers.map((h, c) => cell(ri + 1, c, r[h], false)).join("")}</row>`);
  });

  const dim = `A1:${colName(Math.max(0, nCols - 1))}${nRows}`;
  const sheet =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<dimension ref="${dim}"/><sheetData>${rowsXml.join("")}</sheetData>` +
    `<autoFilter ref="${dim}"/>` +
    (hyperlinks.length ? `<hyperlinks>${hyperlinks.join("")}</hyperlinks>` : "") +
    `</worksheet>`;

  const styles =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<fonts count="3"><font><sz val="11"/><name val="Calibri"/></font>` +
    `<font><b/><sz val="11"/><name val="Calibri"/></font>` +
    `<font><u/><color rgb="FF0563C1"/><sz val="11"/><name val="Calibri"/></font></fonts>` +
    `<fills count="1"><fill><patternFill patternType="none"/></fill></fills>` +
    `<borders count="1"><border/></borders>` +
    `<cellStyleXfs count="1"><xf/></cellStyleXfs>` +
    `<cellXfs count="3"><xf/><xf fontId="1" applyFont="1"/><xf fontId="2" applyFont="1"/></cellXfs>` +
    `</styleSheet>`;

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    `</Types>`;
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;
  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="${xmlEsc(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const wbRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;
  const sheetRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;

  const enc = new TextEncoder();
  const entries: Entry[] = [
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rootRels) },
    { name: "xl/workbook.xml", data: enc.encode(workbook) },
    { name: "xl/_rels/workbook.xml.rels", data: enc.encode(wbRels) },
    { name: "xl/styles.xml", data: enc.encode(styles) },
    { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheet) },
  ];
  if (rels.length) entries.push({ name: "xl/worksheets/_rels/sheet1.xml.rels", data: enc.encode(sheetRels) });
  return zip(entries);
}

// ---- CLI ----
function main() {
  const args = process.argv.slice(2);
  const sheetIx = args.indexOf("--sheet");
  const sheetName = sheetIx >= 0 ? args[sheetIx + 1] : "Bao gia";
  const positional = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--sheet");
  const [inPath, outPath] = positional;
  if (!inPath || !outPath) {
    console.error('Usage: bun make-sheet.ts <rows.json> <out.xlsx> [--sheet "Name"]');
    process.exit(2);
  }
  let rows: Record<string, any>[];
  try {
    rows = JSON.parse(readFileSync(inPath, "utf-8"));
    if (!Array.isArray(rows)) throw new Error("JSON root must be an array of row objects");
  } catch (e) {
    console.error(`Bad input: ${(e as Error).message}`);
    process.exit(2);
  }
  const xlsx = buildXlsx(rows, sheetName);
  writeFileSync(outPath, xlsx);
  console.log(`Wrote ${outPath} (${rows.length} rows, ${(xlsx.length / 1024).toFixed(1)} KB)`);
}
main();
