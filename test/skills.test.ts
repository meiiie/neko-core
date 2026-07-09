import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkill, matchSkill } from "../src/adapters/skills.ts";

const ORIG = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
afterEach(() => {
  for (const k of ["HOME", "USERPROFILE"] as const) {
    if (ORIG[k] === undefined) delete process.env[k];
    else process.env[k] = ORIG[k];
  }
});

test("a CRLF-authored skill (Windows Notepad) still parses its frontmatter name + description", () => {
  const home = mkdtempSync(join(tmpdir(), "nk-skills-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const dir = join(home, ".neko-core", "skills");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "widget-maker.md"), "---\r\nname: widget-maker\r\ndescription: Builds widgets for the foo workflow\r\n---\r\n\r\n# Widget Maker\r\nBody.\r\n", "utf-8");
  const s = loadSkill("widget-maker");
  expect(s?.name).toBe("widget-maker");
  expect(s?.description).toContain("Builds widgets"); // lost (empty) before the CRLF-tolerant frontmatter fix
});

// The bundled `procurement` skill ships in the repo's skills/ dir, so it's discoverable here.
test("matchSkill auto-loads the procurement skill for a clear sourcing task (diacritics handled)", () => {
  const m = matchSkill("Tìm mua Google Pixel giá rẻ, so sánh nguồn bán, sắp xếp giá, ship Bắc Giang, xuất Excel");
  expect(m?.name).toBe("procurement");
});

test("matchSkill returns null for unrelated work (no false trigger)", () => {
  expect(matchSkill("fix the typescript compile error in the build pipeline")).toBeNull();
  expect(matchSkill("hello")).toBeNull(); // too short to match anything
});

test("the bundled computer-use skill includes its executable input helper", () => {
  const skill = loadSkill("computer-use");
  expect(skill?.body).toContain("computer type");
  expect(existsSync(join(skill!.dir, "scripts", "input.ps1"))).toBe(true);
});
