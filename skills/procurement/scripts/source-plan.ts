#!/usr/bin/env bun
/**
 * Deterministic exact-SKU query planner.
 *
 * Broad search discovers candidates; this helper makes the identifier-triggered pivot executable:
 * one exact open-web query, one SKU index URL, and one query per independent retailer domain.
 * It deliberately emits no multi-domain OR query because weak fallback engines often return no results.
 *
 * Usage: bun source-plan.ts <sku> [--category laptop|phone|pc|generic] [--domain example.vn ...]
 */

export type ProcurementCategory = "laptop" | "phone" | "pc" | "generic";

export interface SourceQuery {
  channel: "open_web" | "retailer";
  query: string;
  domain?: string;
}

export interface SkuSourcePlan {
  sku: string;
  category: ProcurementCategory;
  indexUrl: string;
  queries: SourceQuery[];
  coverage: {
    requiredChannels: ["index", "open_web", "retailer"];
    receiptFields: ["channel", "target", "status", "evidence"];
    incompleteClaim: string;
  };
}

const CATEGORY_DOMAINS: Record<ProcurementCategory, readonly string[]> = {
  laptop: [
    "fptshop.com.vn",
    "thegioididong.com",
    "cellphones.com.vn",
    "hacom.vn",
    "phongvu.vn",
    "anphatpc.com.vn",
    "phucanh.vn",
    "tnc.com.vn",
    "laptopworld.vn",
    "nguyencongpc.vn",
    "ankhang.vn",
    "xgear.net",
  ],
  phone: [
    "fptshop.com.vn",
    "thegioididong.com",
    "cellphones.com.vn",
    "hoanghamobile.com",
    "didongviet.vn",
    "clickbuy.com.vn",
    "viettablet.com",
    "24hstore.vn",
    "minhtuanmobile.com",
    "xtmobile.vn",
    "bachlongmobile.com",
    "chotot.com",
  ],
  pc: [
    "hacom.vn",
    "phongvu.vn",
    "gearvn.com",
    "anphatpc.com.vn",
    "phucanh.vn",
    "tnc.com.vn",
    "nguyencongpc.vn",
    "laptopworld.vn",
    "memoryzone.com.vn",
    "maihoang.com.vn",
  ],
  generic: [
    "fptshop.com.vn",
    "thegioididong.com",
    "shopee.vn",
    "lazada.vn",
    "tiki.vn",
  ],
};

function normalizeSku(raw: string): string {
  const sku = raw.trim().toUpperCase();
  const alphaNumericId = /^[A-Z0-9][A-Z0-9._/-]{2,63}$/.test(sku) && /[A-Z]/.test(sku) && /\d/.test(sku);
  const numericGtin = /^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(sku);
  const componentOnly = /^(?:RTX|GTX|U|CORE|RYZEN)\s*-?\d+[A-Z]*$/i.test(sku);
  if (!(alphaNumericId || numericGtin) || componentOnly) {
    throw new Error(`SKU/GTIN không hợp lệ: ${raw || "(trống)"}`);
  }
  return sku;
}

function normalizeDomain(raw: string): string | null {
  let candidate = raw.trim().toLowerCase().replace(/^site:/, "");
  if (!candidate) return null;
  try {
    if (/^https?:\/\//.test(candidate)) candidate = new URL(candidate).hostname;
    else candidate = candidate.split("/")[0];
  } catch {
    return null;
  }
  candidate = candidate.replace(/^www\./, "").replace(/\.$/, "");
  return /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/.test(candidate) ? candidate : null;
}

export function buildSkuSourcePlan(
  rawSku: string,
  category: ProcurementCategory = "generic",
  extraDomains: readonly string[] = [],
): SkuSourcePlan {
  if (!Object.hasOwn(CATEGORY_DOMAINS, category)) throw new Error(`Danh mục không hợp lệ: ${category}`);
  const sku = normalizeSku(rawSku);
  const domains = [...new Set(
    [...CATEGORY_DOMAINS[category], ...extraDomains]
      .map(normalizeDomain)
      .filter((domain): domain is string => domain != null),
  )];

  return {
    sku,
    category,
    indexUrl: `https://websosanh.vn/s/${encodeURIComponent(sku.toLowerCase())}.htm`,
    queries: [
      { channel: "open_web", query: `"${sku}" giá` },
      ...domains.map((domain): SourceQuery => ({
        channel: "retailer",
        domain,
        query: `site:${domain} "${sku}"`,
      })),
    ],
    coverage: {
      requiredChannels: ["index", "open_web", "retailer"],
      receiptFields: ["channel", "target", "status", "evidence"],
      incompleteClaim: "cao nhất đã xác minh trong các nguồn đã khảo sát",
    },
  };
}

function flag(name: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === name && process.argv[i + 1]) values.push(process.argv[++i]);
  }
  return values;
}

if (import.meta.main) {
  const sku = process.argv[2];
  if (!sku) {
    console.error("usage: bun source-plan.ts <sku> [--category laptop|phone|pc|generic] [--domain example.vn ...]");
    process.exit(2);
  }
  const category = (flag("--category")[0] ?? "generic") as ProcurementCategory;
  try {
    console.log(JSON.stringify(buildSkuSourcePlan(sku, category, flag("--domain")), null, 2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }
}
