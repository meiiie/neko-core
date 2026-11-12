import { afterEach, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { memoryTool, setMemoryEnabled } from "../src/core/memory.ts";
import { journalSession } from "../src/core/living-memory.ts";
import { createTaskScope } from "../src/core/task-scope.ts";

const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }); });
function setup(): string {
  const home = mkdtempSync(join(tmpdir(), "neko-journal-scope-")); homes.push(home);
  const file = journalSession({ id: "private-session", cwd: home, createdAt: "2026-11-12T00:00:00Z", updatedAt: "2026-11-12T00:01:00Z",
    messages: [{ role: "user", content: "PRIVATE_PROJECT_RECORD" }, { role: "assistant", content: "looking" },
      { role: "user", content: "continue" }, { role: "assistant", content: "unverified result" }],
  }, home);
  assert.ok(file, "fixture must exist before scope rejection is tested");
  return home;
}
for (const action of ["journal", "journal_search", "journal_read"]) {
  test(`scoped memory ${action} cannot access the global journal`, () => {
    const home = setup(); const scope = createTaskScope("isolated-task", home);
    const result = memoryTool({ action, query: action === "journal_read" ? "private-session" : "PRIVATE_PROJECT_RECORD", scope: null }, home, scope);
    assert.match(result, /unavailable in task scope/);
    assert.doesNotMatch(result, /PRIVATE_PROJECT_RECORD/);
  });
}
test("master off is enforced through the real memory tool dispatcher", () => {
  const home = setup(); setMemoryEnabled(false, home);
  assert.match(memoryTool({ action: "journal_read", name: "private-session" }, home), /off/i);
});
