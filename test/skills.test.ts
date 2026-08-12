import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinSkillsDir } from "../src/adapters/builtin-skills.ts";
import { Agent } from "../src/core/agent.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import {
  applySkillPolicyForTurn,
  isSingleFileMicrotask,
  loadSkill,
  matchesSkill,
  matchSkill,
  matchSkills,
  skillsContextBlock,
} from "../src/adapters/skills.ts";

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

test("a folded YAML block scalar becomes the skill description instead of its marker", () => {
  const home = mkdtempSync(join(tmpdir(), "nk-skills-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const dir = join(home, ".neko-core", "skills", "prose-editor");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    [
      "---",
      "name: prose-editor",
      "description: >-",
      "  Write or edit prose that does not",
      "  read like generated filler.",
      "match: prose",
      "---",
      "",
      "# Prose editor",
      "Body.",
    ].join("\n"),
    "utf-8",
  );

  const skill = loadSkill("prose-editor");
  expect(skill?.description).toBe("Write or edit prose that does not read like generated filler.");
});

test("YAML block scalar descriptions accept indentation indicators and trailing comments", () => {
  const home = mkdtempSync(join(tmpdir(), "nk-skills-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const cases = [
    ["folded-comment", ">2- # folded"],
    ["literal-comment", "|-2 # literal"],
    ["tagged-folded", "!!str >-"],
    ["anchored-folded", "&summary >-"],
  ] as const;

  for (const [name, header] of cases) {
    const dir = join(home, ".neko-core", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      [
        "---",
        `name: ${name}`,
        `description: ${header}`,
        "  Complete YAML header.",
        " # maintainer-only note outside the scalar",
        "---",
        "",
        "Body.",
      ].join("\n"),
      "utf-8",
    );
  }

  for (const [name] of cases) expect(loadSkill(name)?.description).toBe("Complete YAML header.");
});

test("inferred block indentation preserves an indented leading hash line as content", () => {
  const home = mkdtempSync(join(tmpdir(), "nk-skills-"));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const dir = join(home, ".neko-core", "skills", "cpp-tools");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    ["---", "name: cpp-tools", "description: |-", "  # C++ development", "  Build native tools.", "---", "", "Body."].join("\n"),
    "utf-8",
  );

  expect(loadSkill("cpp-tools")?.description).toBe("# C++ development Build native tools.");
});

test("skills context distinguishes Neko skills from provider-located skills", () => {
  const context = skillsContextBlock();
  expect(context).toContain("# NEKO SKILL CATALOG");
  expect(context).toContain("MUST call the `skill` tool to load it BEFORE planning or acting");
  expect(context).toContain("single-file microtask");
  expect(context).toContain("skip generic debugging/TDD skills");
  expect(context).toContain("Provider-native skill names are a separate catalog");
  expect(context).toContain("not callable through this tool");
});

test("an exact single-file microtask skips generic process skills through Agent and ToolRegistry", async () => {
  const root = mkdtempSync(join(tmpdir(), "nk-skill-turn-"));
  const home = mkdtempSync(join(tmpdir(), "nk-skill-home-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, "test"), { recursive: true });
  writeFileSync(join(root, "src", "chunk.ts"), "export const chunk = () => 'WRONG';\n", "utf8");
  writeFileSync(
    join(root, "test", "chunk.test.ts"),
    "import { expect, test } from 'bun:test'; import { chunk } from '../src/chunk'; test('chunk', () => expect(chunk()).toBe('RIGHT'));\n",
    "utf8",
  );

  const instruction =
    "Fix the bug in src/chunk.ts so all existing tests pass. Make the smallest correct change. " +
    "Run the tests. Do not change tests or add dependencies. When done, briefly report the changed file and test result.";
  expect(isSingleFileMicrotask(instruction)).toBe(true);

  const registry = new ToolRegistry(root, "auto", () => true);
  registry.loadSkill = (name) => {
    const skill = loadSkill(name, root, home);
    return skill ? { body: skill.body, dir: skill.dir } : null;
  };
  applySkillPolicyForTurn(registry, instruction, root, home);

  const calls: string[] = [];
  let firstSchemas: string[] = [];
  let firstContext = "";
  let phase = 0;
  const provider = {
    async complete(messages: any[], schemas: any[]) {
      if (phase === 0) {
        firstContext = messages
          .filter((message) => message.role === "system")
          .map((message) => String(message.content))
          .join("\n");
        firstSchemas = schemas.map((schema) => schema.function.name);
        if (firstSchemas.includes("skill") || firstContext.includes("# NEKO SKILL CATALOG")) {
          phase = 1;
          calls.push("skill");
          return { content: null, tool_calls: [{ id: "s1", name: "skill", arguments: { name: "systematic-debugging" } }] };
        }
        phase = 2;
        calls.push("read_file");
        return { content: null, tool_calls: [{ id: "r1", name: "read_file", arguments: { path: "src/chunk.ts" } }] };
      }
      if (phase === 1) {
        phase = 2;
        calls.push("read_file");
        return { content: null, tool_calls: [{ id: "r1", name: "read_file", arguments: { path: "src/chunk.ts" } }] };
      }
      if (phase === 2) {
        phase = 3;
        calls.push("edit");
        return { content: null, tool_calls: [{ id: "e1", name: "edit", arguments: { path: "src/chunk.ts", old: "WRONG", new: "RIGHT" } }] };
      }
      if (phase === 3) {
        phase = 4;
        calls.push("bash");
        return { content: null, tool_calls: [{ id: "b1", name: "bash", arguments: { command: "bun test" } }] };
      }
      return { content: "Changed src/chunk.ts; bun test passed.", tool_calls: [] };
    },
  };
  const agent = new Agent({
    provider: provider as any,
    tools: registry,
    dynamicContext: () => skillsContextBlock(registry, root, home),
    maxSteps: 8,
  });

  expect(await agent.run(instruction)).toContain("bun test passed");
  expect(firstSchemas).not.toContain("skill");
  expect(firstContext).not.toContain("# NEKO SKILL CATALOG");
  expect(calls).toEqual(["read_file", "edit", "bash"]);
  expect(String(await registry.execute("skill", { name: "systematic-debugging" }))).toContain("unavailable for this turn");
}, { timeout: 15_000 });

test("explicit and domain work keep the skill tool, catalog, and direct loader available", async () => {
  const root = mkdtempSync(join(tmpdir(), "nk-skill-domain-"));
  const home = mkdtempSync(join(tmpdir(), "nk-skill-domain-home-"));
  const registry = new ToolRegistry(root, "auto", () => true);
  registry.loadSkill = (name) => {
    const skill = loadSkill(name, root, home);
    return skill ? { body: skill.body, dir: skill.dir } : null;
  };
  const suffix =
    "Fix the bug in src/chunk.ts so tests pass. Make the smallest correct change and run the tests.";
  const prompts = [
    `Use the systematic-debugging skill. ${suffix}`,
    `Use systematic-debugging. ${suffix}`,
    `Load test-driven-development. ${suffix}`,
    `Audit the security vulnerability carefully. ${suffix}`,
    "Fix the authentication bypass in src/auth.ts with the smallest correct change and run tests.",
    `Fix the SQL database query. ${suffix}`,
    `Verify the browser GUI visually with a screenshot. ${suffix}`,
    "Fix the UI rendering bug in src/view.tsx with the smallest correct change and run tests.",
    `Fix the Word document artifact generation. ${suffix}`,
    "Fix CSV artifact generation in src/export.ts with the smallest correct change and run tests.",
    `Research the latest approach before changing code. ${suffix}`,
    "Look up authoritative docs, then fix src/client.ts with the smallest correct change and run tests.",
  ];

  for (const prompt of prompts) {
    expect(isSingleFileMicrotask(prompt)).toBe(false);
    applySkillPolicyForTurn(registry, prompt, root, home);
    expect(registry.schemas().map((schema) => schema.function.name)).toContain("skill");
    expect(skillsContextBlock(registry, root, home)).toContain("# NEKO SKILL CATALOG");
  }
  expect(isSingleFileMicrotask(`Do not load the systematic-debugging skill. ${suffix}`)).toBe(true);
  for (const ambiguous of [
    "Fix src/one.ts and src/two.ts, make the smallest changes, then run tests.",
    "Fix the bug in src/one.ts with the smallest change.",
    "Run the tests for src/one.ts.",
    "Refactor src/one.ts and run tests.",
  ]) expect(isSingleFileMicrotask(ambiguous)).toBe(false);
  expect(String(await registry.execute("skill", { name: "systematic-debugging" }))).toContain("# Skill: systematic-debugging");

  applySkillPolicyForTurn(registry, suffix, root, home);
  expect(registry.schemas().map((schema) => schema.function.name)).not.toContain("skill");
  applySkillPolicyForTurn(registry, "Refactor the whole codebase without changing behavior.", root, home);
  expect(registry.schemas().map((schema) => schema.function.name)).toContain("skill");

  const custom = join(home, ".neko-core", "skills", "custom-chunk-domain");
  mkdirSync(custom, { recursive: true });
  writeFileSync(
    join(custom, "SKILL.md"),
    "---\nname: custom-chunk-domain\ndescription: Required custom rules for chunk work\nmatch: src/chunk\\.ts\n---\nCustom domain instructions.\n",
    "utf8",
  );
  applySkillPolicyForTurn(registry, suffix, root, home);
  expect(registry.schemas().map((schema) => schema.function.name)).toContain("skill");
  expect(skillsContextBlock(registry, root, home)).toContain("custom-chunk-domain");

  const customExplicit = join(home, ".neko-core", "skills", "custom-process");
  mkdirSync(customExplicit, { recursive: true });
  writeFileSync(
    join(customExplicit, "SKILL.md"),
    "---\nname: custom-process\ndescription: Private procedure with unrelated words\n---\nCustom process instructions.\n",
    "utf8",
  );
  applySkillPolicyForTurn(registry, `Use custom-process. ${suffix}`, root, home);
  expect(registry.schemas().map((schema) => schema.function.name)).toContain("skill");
});

test("the bundled web-app skill points to resources that resolve from its own directory", () => {
  const dir = join(builtinSkillsDir(), "web-app");
  const body = readFileSync(join(dir, "SKILL.md"), "utf8");
  const references = [
    "../hackathon-engine/references/golden-stacks.md",
    "../hackathon-engine/references/design-engine.md",
    "../hackathon-engine/references/motion.md",
    "../hackathon-engine/references/backend.md",
    "../hackathon-engine/references/mobile.md",
    "../hackathon-engine/references/testing-strategy.md",
    "../hackathon-engine/references/security.md",
    "../hackathon-engine/references/devops.md",
    "../hackathon-engine/references/seo.md",
  ];
  for (const reference of references) {
    expect(body).toContain(`\`${reference}\``);
    expect(existsSync(join(dir, reference))).toBe(true);
  }
});

// The bundled `procurement` skill ships in the repo's skills/ dir, so it's discoverable here.
test("matchSkill auto-loads the procurement skill for a clear sourcing task (diacritics handled)", () => {
  const m = matchSkill("Tìm mua Google Pixel giá rẻ, so sánh nguồn bán, sắp xếp giá, ship Bắc Giang, xuất Excel");
  expect(m?.name).toBe("procurement");
});

test("procurement makes the exact-SKU cascade executable before detailed tactics", () => {
  const skill = loadSkill("procurement")!;
  const contract = skill.body.indexOf("## HỢP ĐỒNG THỰC THI");
  const tactics = skill.body.indexOf("## Nguyên tắc CỐT LÕI");
  expect(contract).toBeGreaterThan(-1);
  expect(contract).toBeLessThan(tactics);
  expect(skill.body).toContain("83KY001VVN");
  expect(skill.body).toContain("KHÔNG gộp nhiều `site:` bằng `OR`");
  expect(skill.body).toContain("cao nhất đã xác minh trong các nguồn đã khảo sát");
  expect(skill.body).toContain('neko procurement source-plan "<IDENTIFIER>"');
  expect(skill.body).toContain('node bin/neko-source.cjs procurement source-plan "<IDENTIFIER>"');
  expect(skill.body).not.toContain('bun "<skill files dir>/scripts/source-plan.ts"');
  expect(skill.body).toContain("--kind sku");
  expect(skill.body).toContain("--kind mpn");
  expect(skill.body).toContain("neko run --profile nvidia --image");
  expect(skill.body).toContain("node bin/neko-source.cjs run --profile nvidia --image");
  expect(skill.body).not.toContain("env NEKO_MODEL=");
  expect(skill.body).toContain("tối đa 3–5");
  expect(skill.body).toContain("nếu chỉ có 1–2");
  expect(existsSync(join(skill.dir, "scripts", "source-plan.ts"))).toBe(true);
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
