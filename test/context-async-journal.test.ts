import {expect, test} from "bun:test";
import {mkdtempSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {PagedSources} from "../src/adapters/context/paged-sources.ts";
import {captureSourceGroup} from "../src/core/context/structured-sources.ts";
import {createTaskScope, revokeTaskScope} from "../src/core/task-scope.ts";

test("an asynchronous append cannot overwrite a newer synchronous journal head", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-async-race-"));
  const scope = createTaskScope("race", home), journal = new PagedSources(home, scope);
  const source = (n: number) => captureSourceGroup(scope, n, [{role: "user", content: `request ${n}`}]);
  try {
    const pending = journal.appendAsync(source(1));
    const committed = journal.append(source(2));
    await expect(pending).rejects.toThrow("changed during append");
    expect(journal.reference()).toEqual(committed);
    expect(journal.stats().sources).toBe(1);
    expect(new PagedSources(home, scope, committed).nextSequence()).toBe(3);
  } finally { revokeTaskScope(scope); }
});

test("cancellation and filesystem failure leave the selected asynchronous journal head unchanged", async () => {
  for (const failure of ["cancel", "filesystem"] as const) {
    const home = mkdtempSync(join(tmpdir(), "neko-async-failure-"));
    const scope = createTaskScope("failure", home), journal = new PagedSources(home, scope);
    const source = captureSourceGroup(scope, 1, [{role: "user", content: "preserve original"}]);
    const before = journal.reference(), controller = new AbortController();
    try {
      if (failure === "filesystem") writeFileSync(join(home, ".neko-core"), "not a directory");
      const pending = journal.appendAsync(source, controller.signal);
      if (failure === "cancel") controller.abort();
      await expect(pending).rejects.toThrow();
      expect(journal.reference()).toEqual(before);
      expect(journal.stats().sources).toBe(0);
    } finally { revokeTaskScope(scope); }
  }
});

test("retiring an activation during asynchronous append cannot publish an active head", async () => {
  const home = mkdtempSync(join(tmpdir(), "neko-async-retire-"));
  const scope = createTaskScope("retire", home), journal = new PagedSources(home, scope);
  const pending = journal.appendAsync(captureSourceGroup(scope, 1, [{role: "user", content: "old activation"}]));
  revokeTaskScope(scope);
  await expect(pending).rejects.toThrow("active runtime");
  expect(() => journal.reference()).toThrow("active runtime");
});
