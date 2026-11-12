import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";

const worker = readFileSync(join(import.meta.dir, "..", "browser-extension", "service-worker.js"), "utf8");
const snapshot = worker.slice(worker.indexOf("function snapshotPage("), worker.indexOf("\nfunction waitForVisibleChange("));

function observe(attrs: Record<string, string | undefined>, value: string, innerText = "", tagName = "INPUT") {
  const element = {
    dataset: {}, tagName, value, innerText,
    getAttribute: (name: string) => attrs[name] ?? null,
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 100, height: 30, bottom: 30, top: 0 }),
  };
  return runInNewContext(`${snapshot}; snapshotPage(20)`, {
    document: { title: "fixture", body: {}, querySelectorAll: () => [element], createTreeWalker: () => ({ nextNode: () => false }) },
    location: { origin: "https://example.test", pathname: "/" }, innerHeight: 800,
    getComputedStyle: () => ({ visibility: "visible", display: "block" }), NodeFilter: { SHOW_TEXT: 4 },
  });
}

for (const attrs of [{ type: "password" }, { autocomplete: "one-time-code" }, { autocomplete: "cc-number" }, { name: "cvv" }]) {
  test(`snapshot never serializes sensitive input value ${JSON.stringify(attrs)}`, () => {
    const result = observe(attrs, "SYNTHETIC-PRIVATE-VALUE");
    expect(JSON.stringify(result)).not.toContain("SYNTHETIC-PRIVATE-VALUE");
    expect(result.items[0].sensitive).toBe(true);
    expect(result.items[0].name).toBe("[redacted]");
  });
}

test("snapshot does not use editable content or ordinary form values as labels", () => {
  for (const [attrs, tag] of [[{}, "TEXTAREA"], [{ contenteditable: "true" }, "DIV"], [{ role: "textbox" }, "DIV"], [{ type: "text" }, "INPUT"]] as const) {
    expect(JSON.stringify(observe(attrs, "SYNTHETIC-VALUE", "SYNTHETIC-TEXT", tag))).not.toMatch(/SYNTHETIC/);
  }
});

test("snapshot retains semantic labels and visible non-editable button text", () => {
  expect(observe({ "aria-label": "Email" }, "private@example.test").items[0].name).toBe("Email");
  expect(observe({}, "", "Continue", "BUTTON").items[0].name).toBe("Continue");
});
