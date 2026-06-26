#!/usr/bin/env bun
/**
 * Extraction benchmark: feed a FIXED real-style product page (fixtures/product-page.html) to the
 * schema-guided web_fetch extractor and verify it enumerates EVERY variant + the true lowest — the
 * exact capability that freeform extraction kept failing (collapsing a 7-variant table to one number,
 * or grabbing the 36.99M "listed" price). Deterministic input; measures the extractor + model.
 *
 * Run:  bun skills/procurement/evals/extract-eval.ts [--trials N]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../../src/adapters/config.ts";
import { getProvider } from "../../../src/adapters/providers.ts";
import { WEB_EXTRACT_PROMPT } from "../../../src/core/tool-runtime.ts";

// Ground truth for the 12GB/256GB config on the fixture page.
const EXPECTED_PRICES = [24099000, 25999000, 26999000, 26999000, 27099000, 28199000, 28199000];
const EXPECTED_DISTINCT = [...new Set(EXPECTED_PRICES)]; // 5 distinct
const TRUE_LOWEST = 24099000;
const NOT_VARIANTS = [36990000, 29699000, 37699000]; // listed price + other-config (must not be the lowest)

const SCHEMA = {
  type: "object",
  properties: {
    variants: { type: "array", items: { type: "object", properties: { label: { type: "string" }, price_vnd: { type: "integer" } }, required: ["label", "price_vnd"] } },
    lowest: { type: "object", properties: { label: { type: "string" }, price_vnd: { type: "integer" } }, required: ["label", "price_vnd"] },
  },
  required: ["variants", "lowest"],
};

const html = readFileSync(join(import.meta.dir, "fixtures", "product-page.html"), "utf-8");
const pageText = html.replace(/<[^>]+>/g, " ").replace(/&[a-z]+;/gi, " ").replace(/\s+/g, " ").trim();
const provider = getProvider(loadConfig({}));

async function oneTrial(): Promise<{ pass: boolean; detail: string }> {
  let content = "";
  try {
    const res = await provider.complete(
      [
        { role: "system", content: WEB_EXTRACT_PROMPT },
        { role: "user", content: `List EVERY price variant (color/trade-in) for the Samsung S26 Ultra 12GB/256GB config, and the single lowest.\n\n<page>\n${pageText}\n</page>` },
      ],
      undefined, undefined, undefined, { responseSchema: SCHEMA },
    );
    content = res.content ?? "";
  } catch (e) {
    return { pass: false, detail: `provider error: ${(e as Error).message}` };
  }
  let parsed: any;
  try { parsed = JSON.parse(content); } catch { return { pass: false, detail: `not JSON: ${content.slice(0, 80)}` }; }
  const got: number[] = (parsed.variants ?? []).map((v: any) => Number(v.price_vnd)).filter((n: number) => isFinite(n));
  const found = EXPECTED_DISTINCT.filter((p) => got.includes(p));
  const recall = found.length / EXPECTED_DISTINCT.length;
  const lowestOk = Number(parsed.lowest?.price_vnd) === TRUE_LOWEST;
  const badLowest = NOT_VARIANTS.includes(Number(parsed.lowest?.price_vnd));
  const detail = `recall=${found.length}/${EXPECTED_DISTINCT.length} variants=${got.length} lowest=${parsed.lowest?.price_vnd}`;
  if (badLowest) return { pass: false, detail: `${detail} (lowest is a listed/other-config price!)` };
  if (!lowestOk) return { pass: false, detail: `${detail} (lowest != ${TRUE_LOWEST})` };
  if (recall < 1) return { pass: false, detail: `${detail} (missed variants)` };
  return { pass: true, detail };
}

const trialsIx = process.argv.indexOf("--trials");
const trials = trialsIx >= 0 ? Math.max(1, parseInt(process.argv[trialsIx + 1] || "1", 10)) : 2;
console.log(`extraction benchmark — schema-guided variant enumeration x ${trials} trial(s)\n`);
let pass = 0;
for (let t = 0; t < trials; t++) {
  const r = await oneTrial();
  if (r.pass) pass++;
  console.log(`  trial ${t + 1}: ${r.pass ? "PASS" : "FAIL"}  ${r.detail}`);
}
const verdict = pass === trials ? "PASS" : pass === 0 ? "FAIL" : "FLAKY";
console.log(`\n${verdict} — ${pass}/${trials} trials enumerated all variants + found the true lowest`);
process.exit(pass === trials ? 0 : 1);
