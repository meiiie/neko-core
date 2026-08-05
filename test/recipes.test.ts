import { expect, test } from "bun:test";

import { BUNDLED_RECIPES, bundledRecipes, fillRecipe, mergeRecipes } from "../src/adapters/recipes.ts";

test("fillRecipe substitutes $ARGUMENTS and positional $1..$n", () => {
  expect(fillRecipe("deploy $1 to $2 (all: $ARGUMENTS)", "app prod")).toBe("deploy app to prod (all: app prod)");
  expect(fillRecipe("no args here", "")).toBe("no args here");
  expect(fillRecipe("missing $3", "only one")).toBe("missing "); // out-of-range -> empty
});

test("bundled recipes ship the review/verify family as defaults", () => {
  const names = bundledRecipes().map((r) => r.name).sort();
  expect(names).toEqual(["code-review", "review", "security-review", "verify"]);
  for (const r of bundledRecipes()) {
    expect(r.description.length, `${r.name}: description required`).toBeGreaterThan(0);
    expect(r.description.length, `${r.name}: description must be <= 120`).toBeLessThanOrEqual(120);
    expect(r.body.length, `${r.name}: body required`).toBeGreaterThan(20);
  }
});

test("argument-taking bundled templates reference $ARGUMENTS", () => {
  for (const name of ["review", "verify", "code-review", "security-review"]) {
    const r = BUNDLED_RECIPES.find((x) => x.name === name)!;
    expect(r.body, `${name} should reference $ARGUMENTS`).toContain("$ARGUMENTS");
  }
});

test("mergeRecipes: filesystem overrides bundled by name; bundled fills the gaps", () => {
  // No filesystem recipes -> exactly the bundled set.
  expect(mergeRecipes([]).map((r) => r.name).sort()).toEqual(["code-review", "review", "security-review", "verify"]);
  // A user recipe named "verify" overrides the bundled one; the others stay bundled.
  const merged = mergeRecipes([{ name: "verify", description: "mine", body: "do it my way $ARGUMENTS" }]);
  const v = merged.find((r) => r.name === "verify")!;
  expect(v.description).toBe("mine");
  expect(v.body).toBe("do it my way $ARGUMENTS");
  expect(merged.some((r) => r.name === "code-review")).toBe(true);
});
