import { expect, test } from "bun:test";

import { clampEffort, effortLevelsFromError, effortSuggestions, isEffortName, requestEffort, resolveEffort } from "../src/adapters/effort.ts";

test("effort negotiation accepts arbitrary model tiers and only orders vocabulary Neko understands", () => {
  const future = { defaultEffort: "balanced", efforts: ["eco", "balanced", "frontier"].map((effort) => ({ effort })) };
  expect(resolveEffort("frontier", future)).toBe("frontier");
  expect(resolveEffort("unknown", future)).toBe("balanced");
  expect(resolveEffort("ultra", { efforts: ["low", "medium", "xhigh"].map((effort) => ({ effort })) })).toBe("xhigh");
  expect(resolveEffort("new-tier")).toBe("new-tier");
});

test("configured ceilings shape fallback suggestions without hiding a saved cross-model preference", () => {
  expect(clampEffort("ultra", "high")).toBe("high");
  expect(clampEffort("frontier", "high")).toBe("frontier");
  expect(clampEffort("off", "high")).toBe("");
  expect(effortSuggestions("high", "ultra")).toEqual(["minimal", "low", "medium", "high", "ultra"]);
});

test("effort names and validation errors support future provider enums safely", () => {
  expect(isEffortName("frontier-v2")).toBe(true);
  expect(isEffortName("frontier v2")).toBe(false);
  expect(effortLevelsFromError(`validation: reasoning_effort should be 'eco', 'balanced' or 'frontier'`)).toEqual(["eco", "balanced", "frontier"]);
  expect(effortLevelsFromError("allowed levels: eco, balanced, frontier-v2")).toEqual(["eco", "balanced", "frontier-v2"]);
});

test("adaptive request effort can lower but never raise the saved preference", () => {
  expect(requestEffort("high", "low")).toBe("low");
  expect(requestEffort("minimal", "low")).toBe("minimal");
  expect(requestEffort("off", "low")).toBe("");
  expect(requestEffort("high")).toBe("high");
});
