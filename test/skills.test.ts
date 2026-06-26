import { expect, test } from "bun:test";
import { matchSkill } from "../src/adapters/skills.ts";

// The bundled `procurement` skill ships in the repo's skills/ dir, so it's discoverable here.
test("matchSkill auto-loads the procurement skill for a clear sourcing task (diacritics handled)", () => {
  const m = matchSkill("Tìm mua Google Pixel giá rẻ, so sánh nguồn bán, sắp xếp giá, ship Bắc Giang, xuất Excel");
  expect(m?.name).toBe("procurement");
});

test("matchSkill returns null for unrelated work (no false trigger)", () => {
  expect(matchSkill("fix the typescript compile error in the build pipeline")).toBeNull();
  expect(matchSkill("hello")).toBeNull(); // too short to match anything
});
