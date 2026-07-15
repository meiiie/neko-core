import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkill, matchesSkill, matchSkill, matchSkills } from "../src/adapters/skills.ts";

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

test("meeting-notes routes Vietnamese and English meeting capture requests without generic chat false positives", () => {
  for (const prompt of [
    "Nghe va chep loi cuoc hop Teams nay, sau do tom tat bien ban va viec can lam",
    "Record this Zoom meeting and produce timestamped action items",
    "Tom tat cuoc hop online dang phat tren may tinh",
  ]) expect(matchesSkill("meeting-notes", prompt)).toBe(true);
  for (const prompt of ["xin chao", "tom tat file README", "mo Zoom de kiem tra cap nhat"])
    expect(matchesSkill("meeting-notes", prompt)).toBe(false);
});

test("office artifacts route in English and Vietnamese and require saved-result verification", () => {
  const prompts = [
    "tạo mới một file mới đi word mô tả đầy đủ về bài thơ Kiều",
    "làm cho tôi một file Word",
    "tạo PowerPoint giới thiệu Neko Core",
    "làm một bảng Excel chi tiêu",
    "Chỉnh tài liệu Word và kiểm tra lại định dạng",
    "đọc rồi tóm tắt báo-cáo.docx",
    "create a Word document about Neko",
    "make an Excel spreadsheet",
    "create a PowerPoint presentation and verify the pptx file",
    "tao tai lieu Word docx va kiem tra dinh dang",
    "sua file bao-cao.docx",
  ];
  for (const prompt of prompts) {
    expect(matchesSkill("office-artifacts", prompt)).toBe(true);
    expect(matchSkills(prompt).map((skill) => skill.name)).toContain("office-artifacts");
  }

  const unrelated = [
    "Microsoft Word là gì?",
    "từ word này nghĩa là gì?",
    "I excel at sports",
    "PowerPoint có miễn phí không?",
    "compare Word Excel PowerPoint files",
    "mở Excel",
    "fix the word spacing in markdown",
  ];
  for (const prompt of unrelated) expect(matchesSkill("office-artifacts", prompt)).toBe(false);

  const compositional = matchSkills("Tìm mua laptop ở Việt Nam rồi tạo file Excel so sánh giá").map((skill) => skill.name);
  expect(compositional).toContain("office-artifacts");
  expect(compositional).toContain("procurement");

  const skill = loadSkill("office-artifacts");
  expect(skill?.body).toContain("fresh on-disk reopen");
  expect(skill?.body).toContain("mcp__neko_office__apply");
  expect(skill?.body).toContain("Never silently install");
  expect(skill?.body).toContain("Do not claim calculated values are current");
  expect(skill?.body).toContain("Read every returned PNG through Neko's vision bridge");
});

test("the bundled computer-use skill includes its executable input helper", () => {
  const skill = loadSkill("computer-use");
  expect(skill?.body).toContain("computer type");
  const input = join(skill!.dir, "scripts", "input.ps1");
  expect(existsSync(input)).toBe(true);
  const source = readFileSync(input, "utf8");
  expect(source).toContain("-RedirectStandardOutput");
  expect(source).toContain("-RedirectStandardError");
  expect(source).toContain("SetProcessDpiAwarenessContext");
  const display = join(skill!.dir, "scripts", "display.ps1");
  expect(existsSync(display)).toBe(true);
  expect(readFileSync(display, "utf8")).toContain("coordinate_space=physical_px");
  expect(skill!.body).toContain('computer({action:"display"})');
  expect(skill!.body).toContain("Completion is an observed state");
});

test("bundled messaging skills route Zalo/WeChat/Messenger tasks and keep send behind verification", () => {
  const cases = [
    ["use-zalo", "dung Zalo gui tin nhan cho mot lien he"],
    ["use-wechat", "dung WeChat gui tin nhan cho mot lien he"],
    ["use-messenger", "theo doi Messenger va tra loi tin nhan moi"],
  ] as const;
  for (const [name, prompt] of cases) {
    const skill = loadSkill(name);
    expect(skill).not.toBeNull();
    expect(skill!.body).toContain("`computer-use` skill");
    expect(skill!.body).toContain("exact, unambiguous");
    expect(skill!.body).toContain("Sending is a separate commit");
    expect(skill!.body).toMatch(/(?:never|do not) (?:blind-)?retry/i);
    expect(matchSkill(prompt)?.name).toBe(name);
  }

  const messenger = loadSkill("use-messenger")!;
  expect(messenger.body).toContain("computer watch");
  expect(messenger.body).toContain("last_seen");
  expect(messenger.body).toContain("Pre-send race gate");
  expect(messenger.body).toContain("one outbound for one stable inbound");
  expect(messenger.body).toContain("elapsed_ms");
});

test("web-reading supports large virtualized feeds without keeping every post in model context", () => {
  const skill = loadSkill("web-reading");
  expect(skill?.body).toContain("capture BEFORE every scroll");
  expect(skill?.body).toContain("session JSONL/JSON artifact");
  expect(skill?.body).toContain("scripts/collect-feed.js");
  expect(skill?.body).toContain("three consecutive no-growth cycles");
  expect(skill?.body).not.toContain('"Latest 5-7 posts from the loaded view" is');
  const routed = matchSkill("dùng Chrome lướt Facebook gom 100 tin mới nhất rồi tổng kết");
  expect(routed?.name).toBe("web-reach");
  expect(routed?.body).toContain("load the `web-reading` skill");
  const collector = readFileSync(join(skill!.dir, "scripts", "collect-feed.js"), "utf8");
  expect(() => new Function(`return (${collector})`)).not.toThrow();
  expect(collector).toContain('page.locator("article, [role=article], [data-virtualized]")');
  expect(collector).toContain("const target = 20");
  expect(collector).not.toContain("document.cookie");
});
