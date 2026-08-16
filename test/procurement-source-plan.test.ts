import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const modulePath = join(import.meta.dir, "..", "skills", "procurement", "scripts", "source-plan.ts");
const commandPath = join(import.meta.dir, "..", "src", "adapters", "procurement-cli.ts");
const nekoCliPath = join(import.meta.dir, "..", "bin", "neko.ts");

test("exact-SKU cascade expands 83KY001VVN across independent laptop sources", async () => {
  // Keep the first RED run an assertion failure for the missing feature instead of a module-loader error.
  expect(existsSync(modulePath)).toBe(true);
  if (!existsSync(modulePath)) return;

  const { buildSkuSourcePlan } = await import(modulePath);
  const plan = buildSkuSourcePlan(" 83ky001vvn ", "laptop", [
    "FPTSHOP.COM.VN",
    "https://www.ankhang.vn/laptop-lenovo-legion-7-16iax10-83ky001vvn.html",
  ]);

  expect(plan.sku).toBe("83KY001VVN");
  expect(plan.indexUrl).toBe("https://websosanh.vn/s/83ky001vvn.htm");
  expect(plan.queries[0]).toEqual({ channel: "open_web", query: '"83KY001VVN" giá' });

  const retailerQueries = plan.queries.filter((row: { channel: string }) => row.channel === "retailer");
  expect(retailerQueries).toContainEqual({
    channel: "retailer",
    domain: "fptshop.com.vn",
    query: 'site:fptshop.com.vn "83KY001VVN"',
  });
  expect(retailerQueries).toContainEqual({
    channel: "retailer",
    domain: "ankhang.vn",
    query: 'site:ankhang.vn "83KY001VVN"',
  });
  expect(new Set(retailerQueries.map((row: { domain: string }) => row.domain)).size).toBe(retailerQueries.length);
  expect(plan.queries.every((row: { query: string }) => !/\sOR\s/i.test(row.query))).toBe(true);
  expect(plan.coverage.requiredChannels).toEqual(["index", "open_web", "retailer"]);
  expect(plan.coverage.incompleteClaims.highest).toContain("cao nhất đã xác minh trong các nguồn đã khảo sát");
  expect(plan.coverage.incompleteClaims.lowest).toContain("thấp nhất đã xác minh trong các nguồn đã khảo sát");
});

test("exact-identifier cascade accepts a numeric GTIN", async () => {
  expect(existsSync(modulePath)).toBe(true);
  if (!existsSync(modulePath)) return;

  const { buildSkuSourcePlan } = await import(modulePath);
  for (const gtin of ["96385074", "036000291452", "4006381333931", "10012345000017"]) {
    const plan = buildSkuSourcePlan(gtin, "generic");
    expect(plan.sku).toBe(gtin);
    expect(plan.indexUrl).toBe(`https://websosanh.vn/s/${gtin}.htm`);
  }
});

test("exact-identifier cascade accepts an explicitly typed numeric SKU", async () => {
  const { buildSkuSourcePlan } = await import(modulePath);
  const plan = buildSkuSourcePlan("123456", "generic", [], "sku");
  expect(plan.sku).toBe("123456");
  expect(plan.identifierKind).toBe("sku");
  expect(() => buildSkuSourcePlan("123456", "generic")).toThrow("SKU/MPN/GTIN");
});

test("exact-identifier cascade accepts explicitly typed MPN formats", async () => {
  const { buildSkuSourcePlan } = await import(modulePath);
  for (const mpn of ["LASERJET", "C9363W#140"]) {
    const plan = buildSkuSourcePlan(mpn, "generic", [], "mpn");
    expect(plan.sku).toBe(mpn);
    expect(plan.identifierKind).toBe("mpn");
    expect(plan.queries[0].query).toBe(`"${mpn}" giá`);
  }
  expect(() => buildSkuSourcePlan("LASERJET", "generic")).toThrow("SKU");
});

test("source plan rejects an empty or non-identifier SKU", async () => {
  expect(existsSync(modulePath)).toBe(true);
  if (!existsSync(modulePath)) return;

  const { buildSkuSourcePlan } = await import(modulePath);
  for (const value of ["", "   ", "laptop", "RTX5070", "RTX-5070-TI", "CORE-I7-14700K", "12345678", "31990000"]) {
    expect(() => buildSkuSourcePlan(value, "laptop")).toThrow("SKU");
  }
  // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
  expect(() => buildSkuSourcePlan("83KY001VVN", "__proto__" as never)).toThrow("Danh mục");
  // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
  expect(() => buildSkuSourcePlan("83KY001VVN", "laptop", [], "__proto__" as never)).toThrow("Loại định danh");
  expect(() => buildSkuSourcePlan("RTX-5070-TI", "laptop", [], "mpn")).toThrow("SKU/MPN/GTIN");
});

test("source-plan CLI formatters are ASCII-safe while parsed JSON preserves Unicode", async () => {
  const { buildSkuSourcePlan, formatCliError, serializePlan } = await import(modulePath);
  const stdout = serializePlan(buildSkuSourcePlan("83KY001VVN", "laptop"));
  expect([...stdout].every((char) => char.charCodeAt(0) <= 0x7f)).toBe(true);
  expect(JSON.parse(stdout).queries[0].query).toBe('"83KY001VVN" giá');

  const stderr = formatCliError(new Error("SKU/GTIN không hợp lệ: BAD\u001bSKU"));
  expect([...stderr].every((char) => char.charCodeAt(0) <= 0x7f)).toBe(true);
  expect(stderr).not.toContain("\u001b");
  expect(stderr).toContain("\\u001b");
});

test("source-tree planner usage does not depend on the repo-only rtk wrapper", () => {
  const source = readFileSync(modulePath, "utf8");
  expect(source).toContain("Usage: bun source-plan.ts");
  expect(source).toContain("usage: bun source-plan.ts");
  expect(source).toContain("--kind auto|sku|mpn|gtin");
  expect(source).not.toContain("Usage: rtk bun source-plan.ts");
  expect(source).not.toContain("usage: rtk bun source-plan.ts");
});

test("standalone Neko exposes the deterministic source planner without Bun", async () => {
  expect(existsSync(commandPath)).toBe(true);
  if (!existsSync(commandPath)) return;

  const { procurementSourcePlanCommand } = await import(commandPath);
  const result = procurementSourcePlanCommand({
    identifier: "83KY001VVN",
    category: "laptop",
    kind: "auto",
    domains: ["ankhang.vn"],
  });
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout ?? "{}").sku).toBe("83KY001VVN");
  const missing = procurementSourcePlanCommand({});
  expect(missing.exitCode).toBe(2);
  expect(missing.stderr).toContain("neko procurement source-plan");

  const { listCommands } = await import(join(import.meta.dir, "..", "src", "adapters", "registry.ts"));
  expect(listCommands().some((command: { name: string }) => command.name === "procurement")).toBe(true);
  const cli = readFileSync(nekoCliPath, "utf8");
  expect(cli).toContain('case "procurement"');
  expect(cli).toContain("procurementSourcePlanCommand");
});
