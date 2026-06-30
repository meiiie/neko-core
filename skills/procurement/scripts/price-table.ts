#!/usr/bin/env bun
/**
 * price-table.ts — DETERMINISTIC price-table processor.
 *
 * Principle (SOTA 2026 consensus on reliable extraction — see docs/process/WEB.md): an LLM is unreliable at
 * exact number transcription and arithmetic, so it must NOT do them. The LLM's only job is to EXTRACT each
 * offer VERBATIM (the price exactly as written on the page + its condition + source + link). THIS CODE then
 * deterministically parses the numbers, sorts, and computes min / max / sum / avg / median, and flags
 * outliers. That makes the whole class of bugs IMPOSSIBLE: "31.990.000đ" read as 31, picking a pricier
 * source when a cheaper one was seen, a wrong total. Extend by adding a parser branch or a stat — not a prompt rule.
 *
 * Usage:  bun price-table.ts <rows.json> [--col Giá] [--normalized out.json]
 *   rows.json : [{ "Mặt hàng":"...", "Giá":"31.990.000đ" | 31990000, "Tình trạng":"Mới", "Nguồn":"...", "Link":"https://..." }, ...]
 *   --col       which column holds the price (default "Giá")
 *   --normalized write a copy with the price column replaced by the parsed integer (feed to make-sheet.ts)
 */
import { readFileSync, writeFileSync } from "node:fs";

/** Parse a Vietnamese price (verbatim string or number) to an integer VND. Deterministic, no LLM.
 *  Handles: "31.990.000đ" / "31.990.000 ₫" (dots/commas = THOUSANDS separators) · "12,5 triệu" / "12tr" /
 *  "990k" (unit multipliers) · "12 - 14 triệu" (range -> LOW end) · numbers. Returns null if no price. */
export function parseVnd(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? Math.round(raw) : null;
  if (raw == null) return null;
  let s = String(raw).toLowerCase().trim().replace(/['"]/g, "");
  if (!s) return null;
  s = s.replace(/[đ₫]|vn[dđ]|vnđ/g, " ").trim();          // drop currency marks
  const dash = s.split(/\s*[-–—~]\s*/);                    // "a - b" range -> low end
  if (dash.length > 1 && /\d/.test(dash[0])) s = dash[0].trim();
  const unit = s.match(/^([\d.,]+)\s*(triệu|trieu|tr|củ|cu|nghìn|nghin|ngàn|ngan|k)\b/);
  if (unit) {
    const num = parseFloat(unit[1].replace(/\./g, "").replace(",", "."));
    if (!Number.isFinite(num)) return null;
    const mult = /triệu|trieu|tr|củ|cu/.test(unit[2]) ? 1_000_000 : 1_000;
    return Math.round(num * mult);
  }
  const digits = s.replace(/[^\d]/g, "");                  // plain integer: separators are thousands
  return digits ? parseInt(digits, 10) : null;
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const vnd = (n: number) => n.toLocaleString("vi-VN") + " ₫";

if (import.meta.main) {
const path = process.argv[2];
if (!path) { console.error('usage: bun price-table.ts <rows.json> [--col Giá] [--normalized out.json]'); process.exit(2); }
const col = flag("--col") ?? "Giá";
const json = JSON.parse(readFileSync(path, "utf8"));
// Accept a bare array OR a common wrapper ({items|rows|data|baogia: [...]}) so a slightly-shaped JSON
// from the model doesn't cost a retry.
const rows: Record<string, any>[] = Array.isArray(json) ? json : (json.items ?? json.rows ?? json.data ?? json.baogia ?? []);
if (!Array.isArray(rows) || rows.length === 0) { console.error('price-table: no rows (expected a JSON array, or { items|rows|data: [...] })'); process.exit(2); }

const parsed = rows.map((r) => ({ row: r, vnd: parseVnd(r[col]), raw: r[col] }));
const valid = parsed.filter((p) => p.vnd != null && p.vnd > 0) as { row: Record<string, any>; vnd: number; raw: any }[];
const failed = parsed.filter((p) => p.vnd == null || (p.vnd ?? 0) <= 0);

const median = (arr: number[]): number => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
const medianAll = median(valid.map((p) => p.vnd));
// Outlier flag = far from the median (likely a misparse / wrong segment / accessory / strikethrough),
// computed PER PRODUCT GROUP ("Mặt hàng") -- a mixed table (USB + phones) must NOT flag cheap USBs against a
// phone-dominated median. A group needs >=4 prices to judge an outlier; smaller groups aren't flagged.
const groups = new Map<string, { row: Record<string, any>; vnd: number; raw: any; flag?: string }[]>();
for (const p of valid) { const k = String(p.row["Mặt hàng"] ?? "_all"); (groups.get(k) ?? (groups.set(k, []), groups.get(k)!)).push(p); }
for (const members of groups.values()) {
  if (members.length < 4) { for (const p of members) (p as any).flag = ""; continue; }
  const med = median(members.map((m) => m.vnd));
  for (const p of members) (p as any).flag = (p.vnd < med / 4 || p.vnd > med * 4) ? "⚠️ lệch xa median nhóm — kiểm lại nhãn/nguồn" : "";
}

const colsToShow = ["Mặt hàng", "Cấu hình", "Tình trạng", "Nguồn", "Link"].filter((c) => rows.some((r) => r[c] != null));
function table(list: typeof valid): string {
  const head = ["Giá (₫)", ...colsToShow, "Ghi chú"];
  const lines = [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`];
  for (const p of list) lines.push(`| ${vnd(p.vnd)} | ${colsToShow.map((c) => String(p.row[c] ?? "")).join(" | ")} | ${(p as any).flag ?? ""} |`);
  return lines.join("\n");
}

const asc = [...valid].sort((a, b) => a.vnd - b.vnd);
const desc = [...valid].sort((a, b) => b.vnd - a.vnd);
const sum = valid.reduce((a, p) => a + p.vnd, 0);
const out: string[] = [];
out.push(`PRICE TABLE (deterministic) — ${valid.length} giá đọc được${failed.length ? `, ${failed.length} dòng KHÔNG đọc được giá` : ""}`);
out.push("");
out.push("### Thấp → cao");
out.push(table(asc));
out.push("");
out.push("### Cao → thấp");
out.push(table(desc));
out.push("");
out.push("### Thống kê (tính bằng code, không phải LLM)");
out.push(`- THẤP NHẤT: ${vnd(asc[0]?.vnd ?? 0)}${asc[0] ? ` (${asc[0].row["Nguồn"] ?? ""}${asc[0].row["Tình trạng"] ? ", " + asc[0].row["Tình trạng"] : ""})` : ""}`);
out.push(`- CAO NHẤT:  ${vnd(desc[0]?.vnd ?? 0)}${desc[0] ? ` (${desc[0].row["Nguồn"] ?? ""})` : ""}`);
out.push(`- TỔNG: ${vnd(sum)}   ·   TRUNG BÌNH: ${vnd(Math.round(sum / (valid.length || 1)))}   ·   MEDIAN: ${vnd(medianAll)}`);
const flagged = valid.filter((p) => (p as any).flag);
if (flagged.length) out.push(`- ⚠️ ${flagged.length} giá nghi sai (lệch xa median) — RE-CHECK trước khi kết luận: ${flagged.map((p) => `${vnd(p.vnd)} (${p.row["Nguồn"] ?? "?"})`).join("; ")}`);
if (failed.length) out.push(`- ⚠️ KHÔNG đọc được giá ở: ${failed.map((p) => p.row["Nguồn"] ?? JSON.stringify(p.raw)).join("; ")}`);
console.log(out.join("\n"));

const normPath = flag("--normalized");
if (normPath) {
  writeFileSync(normPath, JSON.stringify(asc.map((p) => ({ ...p.row, [col]: p.vnd })), null, 2), "utf8");
  console.log(`\n(normalized JSON -> ${normPath}; feed to make-sheet.ts for Excel)`);
}
}
