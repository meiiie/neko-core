import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

const modulePath = join(import.meta.dir, "..", "skills", "procurement", "scripts", "source-plan.ts");

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
  expect(plan.coverage.incompleteClaim).toContain("cao nhất đã xác minh trong các nguồn đã khảo sát");
});

test("exact-identifier cascade accepts a numeric GTIN", async () => {
  expect(existsSync(modulePath)).toBe(true);
  if (!existsSync(modulePath)) return;

  const { buildSkuSourcePlan } = await import(modulePath);
  const plan = buildSkuSourcePlan("8806098697152", "generic");
  expect(plan.sku).toBe("8806098697152");
  expect(plan.indexUrl).toBe("https://websosanh.vn/s/8806098697152.htm");
});

test("source plan rejects an empty or non-identifier SKU", async () => {
  expect(existsSync(modulePath)).toBe(true);
  if (!existsSync(modulePath)) return;

  const { buildSkuSourcePlan } = await import(modulePath);
  for (const value of ["", "   ", "laptop", "RTX5070"]) {
    expect(() => buildSkuSourcePlan(value, "laptop")).toThrow("SKU");
  }
  expect(() => buildSkuSourcePlan("83KY001VVN", "__proto__" as never)).toThrow("Danh mục");
});
