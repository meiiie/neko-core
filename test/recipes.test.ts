import { expect, test } from "bun:test";

import { fillRecipe } from "../src/adapters/recipes.ts";

test("fillRecipe substitutes $ARGUMENTS and positional $1..$n", () => {
  expect(fillRecipe("deploy $1 to $2 (all: $ARGUMENTS)", "app prod")).toBe("deploy app to prod (all: app prod)");
  expect(fillRecipe("no args here", "")).toBe("no args here");
  expect(fillRecipe("missing $3", "only one")).toBe("missing "); // out-of-range -> empty
});
