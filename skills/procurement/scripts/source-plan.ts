#!/usr/bin/env bun
/**
 * Deterministic exact-identifier query planner.
 *
 * Broad search discovers candidates; this helper makes the identifier-triggered pivot executable:
 * one exact open-web query, one identifier index URL, and one query per independent retailer domain.
 * It deliberately emits no multi-domain OR query because weak fallback engines often return no results.
 *
 * Usage: bun source-plan.ts <identifier> [--kind auto|sku|mpn|gtin] [--category laptop|phone|pc|generic] [--domain example.vn ...]
 */

export type ProcurementCategory = "laptop" | "phone" | "pc" | "generic";
export type ProcurementIdentifierKind = "auto" | "sku" | "mpn" | "gtin";
type ResolvedIdentifierKind = Exclude<ProcurementIdentifierKind, "auto">;

export interface SourceQuery {
  channel: "open_web" | "retailer";
  query: string;
  domain?: string;
}

export interface SkuSourcePlan {
  sku: string;
  identifierKind: ResolvedIdentifierKind;
  category: ProcurementCategory;
  indexUrl: string;
  queries: SourceQuery[];
  coverage: {
    requiredChannels: ["index", "open_web", "retailer"];
    receiptFields: ["channel", "target", "status", "evidence"];
    incompleteClaims: {
      highest: string;
      lowest: string;
    };
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

function isValidGtin(value: string): boolean {
  if (!/^(?:\d{8}|\d{12}|\d{13}|\d{14})$/.test(value)) return false;
  const digits = [...value].map(Number);
  const checkDigit = digits.pop()!;
  let sum = 0;
  for (let i = digits.length - 1, weight = 3; i >= 0; i--, weight = weight === 3 ? 1 : 3) {
    sum += digits[i] * weight;
  }
  return (10 - (sum % 10)) % 10 === checkDigit;
}

const IDENTIFIER_KINDS: readonly ProcurementIdentifierKind[] = ["auto", "sku", "mpn", "gtin"];

function normalizeIdentifier(
  raw: string,
  requestedKind: ProcurementIdentifierKind,
): { value: string; kind: ResolvedIdentifierKind } {
  if (!IDENTIFIER_KINDS.includes(requestedKind)) {
    throw new Error(`Loại định danh không hợp lệ: ${requestedKind}`);
  }

  const value = raw.trim().toUpperCase();
  const kind: ResolvedIdentifierKind = requestedKind === "auto"
    ? (/^\d+$/.test(value) ? "gtin" : "sku")
    : requestedKind;
  const compact = value.replace(/[ ._/#()+-]+/g, "");
  const componentOnly = /^(?:(?:RTX|GTX|U)\d+[A-Z]*|CORE(?:I[3579]|ULTRA)?\d+[A-Z]*|RYZEN[3579]?\d+[A-Z]*)$/.test(compact);

  const skuShape = /^[A-Z0-9][A-Z0-9._/-]{2,63}$/.test(value);
  const valid = kind === "gtin"
    ? isValidGtin(value)
    : kind === "mpn"
      ? /^[A-Z0-9][A-Z0-9 ._/#()+-]{0,63}$/.test(value)
      : skuShape && (requestedKind === "sku" || (/[A-Z]/.test(value) && /\d/.test(value)));
  if (!valid || (kind !== "gtin" && componentOnly)) {
    throw new Error(`SKU/MPN/GTIN không hợp lệ: ${raw || "(trống)"}`);
  }
  return { value, kind };
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
  identifierKind: ProcurementIdentifierKind = "auto",
): SkuSourcePlan {
  if (!Object.hasOwn(CATEGORY_DOMAINS, category)) throw new Error(`Danh mục không hợp lệ: ${category}`);
  const normalized = normalizeIdentifier(rawSku, identifierKind);
  const sku = normalized.value;
  const domains = [...new Set(
    [...CATEGORY_DOMAINS[category], ...extraDomains]
      .map(normalizeDomain)
      .filter((domain): domain is string => domain != null),
  )];

  return {
    sku,
    identifierKind: normalized.kind,
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
      incompleteClaims: {
        highest: "cao nhất đã xác minh trong các nguồn đã khảo sát",
        lowest: "thấp nhất đã xác minh trong các nguồn đã khảo sát",
      },
    },
  };
}

function asciiSafe(value: string, preserveFormatting = false): string {
  const unsafe = preserveFormatting ? /[^\x09\x0a\x0d\x20-\x7e]/g : /[^\x20-\x7e]/g;
  return value.replace(unsafe, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function serializePlan(plan: SkuSourcePlan): string {
  return asciiSafe(JSON.stringify(plan, null, 2), true);
}

export function formatCliError(error: unknown): string {
  return asciiSafe(error instanceof Error ? error.message : String(error));
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
    console.error("usage: bun source-plan.ts <identifier> [--kind auto|sku|mpn|gtin] [--category laptop|phone|pc|generic] [--domain example.vn ...]");
    process.exit(2);
  }
  const category = (flag("--category")[0] ?? "generic") as ProcurementCategory;
  try {
    const identifierKind = (flag("--kind")[0] ?? "auto") as ProcurementIdentifierKind;
    console.log(serializePlan(buildSkuSourcePlan(sku, category, flag("--domain"), identifierKind)));
  } catch (error) {
    console.error(formatCliError(error));
    process.exit(2);
  }
}
