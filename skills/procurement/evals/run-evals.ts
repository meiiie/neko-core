#!/usr/bin/env bun
/**
 * Deterministic eval for the `procurement` skill: feed a FIXED offer table (no web, so it's
 * reproducible) and check the agent does the data op correctly — lowest/highest price, sort,
 * filter, and a real Excel export with links. Measures the skill + model, not the network.
 *
 * Run:  bun skills/procurement/evals/run-evals.ts          (all)
 *       bun skills/procurement/evals/run-evals.ts export    (one, by id substring)
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";

/** Read every entry of a zip via its central directory and return all parts as text — handles both
 * STORED and DEFLATE, so we can inspect xlsx XML regardless of how the agent wrote it. */
function unzipText(buf: Buffer): string {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) return buf.toString("latin1");
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  let out = "";
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const data = buf.subarray(dataStart, dataStart + compSize);
    try { out += method === 8 ? inflateRawSync(data).toString("latin1") : data.toString("latin1"); } catch { /* skip */ }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const NEKO = join(import.meta.dir, "..", "..", "..", "bin", "neko.ts");

// Fixed offer table given to the agent in every prompt (so no web lookups -> deterministic).
const OFFERS = `| Mặt hàng | Cấu hình | Giá (VND) | Nguồn | Loại người bán | Link |
|---|---|---|---|---|---|
| iPhone 16 Pro | 256GB | 22390000 | TGDD | chính hãng | https://www.thegioididong.com/dtdd/iphone-16-pro-256gb |
| iPhone 16 Pro | 256GB | 27990000 | CellphoneS | chính hãng | https://cellphones.com.vn/iphone-16-pro-256gb.html |
| iPhone 16 Pro | 256GB | 19990000 | ShopRe247 | chợ/trôi nổi | https://shopre247.example/ip16pro |
| MacBook Air M4 | 13in 256GB | 26990000 | FPT Shop | chính hãng | https://fptshop.com.vn/macbook-air-m4 |
| MacBook Air M4 | 13in 256GB | 25490000 | ShopDunk | chính hãng | https://shopdunk.com/macbook-air-m4 |`;

const preamble = `Dưới đây là BẢNG CHÀO GIÁ đã có sẵn. KHÔNG tra web, KHÔNG dùng web_search/web_fetch — chỉ dùng đúng bảng này.\n\n${OFFERS}\n\nYêu cầu: `;

type Eval = { id: string; ask: string; check: (out: string, dir: string) => string | null };
const norm = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").replace(/[,.\s₫đ]/g, "").toLowerCase();
const before = (out: string, a: string, b: string) => out.indexOf(a) >= 0 && out.indexOf(a) < out.indexOf(b);

const EVALS: Eval[] = [
  {
    id: "lowest",
    ask: "Giá THẤP NHẤT cho iPhone 16 Pro 256GB trong bảng là nguồn nào, bao nhiêu? Trả lời ngắn gọn.",
    check: (out) => (norm(out).includes("19990000") && /shopre247/i.test(out) ? null : "không nêu đúng nguồn rẻ nhất (ShopRe247 / 19.990.000)"),
  },
  {
    id: "highest",
    ask: "Giá CAO NHẤT cho iPhone 16 Pro 256GB trong bảng là nguồn nào, bao nhiêu? Trả lời ngắn gọn.",
    check: (out) => (norm(out).includes("27990000") && /cellphones/i.test(out) ? null : "không nêu đúng nguồn đắt nhất (CellphoneS / 27.990.000)"),
  },
  {
    id: "sort-desc",
    ask: "Sắp xếp 3 nguồn iPhone 16 Pro theo GIÁ GIẢM DẦN (cao -> thấp). Liệt kê theo thứ tự.",
    check: (out) => {
      const n = norm(out);
      return before(n, "27990000", "22390000") && before(n, "22390000", "19990000")
        ? null : "thứ tự giảm dần sai (đúng: 27.99tr -> 22.39tr -> 19.99tr)";
    },
  },
  {
    id: "filter-official",
    ask: "Chỉ giữ các nguồn CHÍNH HÃNG cho iPhone 16 Pro (loại bỏ chợ/trôi nổi). Liệt kê.",
    check: (out) => (/(tgdd|thế giới|the gioi)/i.test(out) && /cellphones/i.test(out) && !/shopre247/i.test(out)
      ? null : "lọc chính hãng sai (phải còn TGDD + CellphoneS, bỏ ShopRe247)"),
  },
  {
    id: "export",
    ask: "Tôi cần MUA những món trong bảng trên và gửi sếp duyệt. Lập bảng giá mua hàng rồi XUẤT RA FILE EXCEL 'baogia.xlsx' (cột Link bấm được) lưu vào thư mục hiện tại.",
    check: (_out, dir) => {
      const f = join(dir, "baogia.xlsx");
      if (!existsSync(f)) return "không tạo baogia.xlsx";
      const buf = readFileSync(f);
      if (buf[0] !== 0x50 || buf[1] !== 0x4b) return "baogia.xlsx không phải file zip/xlsx hợp lệ";
      const txt = unzipText(buf); // inflate -> read sheet XML regardless of STORED/DEFLATE
      if (!/hyperlink/i.test(txt)) return "xlsx không có hyperlink (cột Link không bấm được)";
      if (!/https?:\/\//.test(txt)) return "xlsx không nhúng URL link";
      return null;
    },
  },
];

function runOne(e: Eval): { id: string; pass: boolean; detail: string } {
  const dir = mkdtempSync(join(tmpdir(), "neko-proc-"));
  try {
    const r = spawnSync(process.execPath, [NEKO, "run", preamble + e.ask, "--yolo"], { cwd: dir, encoding: "utf-8", timeout: 180000 });
    const out = (r.stdout || "") + (r.stderr || "");
    const fail = e.check(out, dir);
    return { id: e.id, pass: !fail, detail: fail || "ok" };
  } catch (err) {
    return { id: e.id, pass: false, detail: `crashed: ${(err as Error).message}` };
  } finally {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// `--trials N` runs each eval N times and reports PASS (all) / FLAKY (some) / FAIL (none) — LLM runs
// vary, so a single pass hides reliability. A positional arg filters evals by id substring.
const args = process.argv.slice(2);
const trialsIx = args.indexOf("--trials");
const trials = trialsIx >= 0 ? Math.max(1, parseInt(args[trialsIx + 1] || "1", 10)) : 1;
const filter = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--trials");
const todo = EVALS.filter((e) => !filter || e.id.includes(filter));
console.log(`procurement evals — ${todo.length} eval(s) x ${trials} trial(s)\n`);
let solid = 0;
for (const e of todo) {
  let p = 0;
  let lastDetail = "ok";
  for (let t = 0; t < trials; t++) {
    const res = runOne(e);
    if (res.pass) p++;
    else lastDetail = res.detail;
  }
  const verdict = p === trials ? "PASS" : p === 0 ? "FAIL" : "FLAKY";
  if (verdict === "PASS") solid++;
  console.log(`  ${verdict.padEnd(5)} ${e.id}  (${p}/${trials})${verdict === "PASS" ? "" : "  -> " + lastDetail}`);
}
console.log(`\n${solid}/${todo.length} solid (passed every trial)`);
process.exit(solid === todo.length ? 0 : 1);
