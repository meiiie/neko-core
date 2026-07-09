import { expect, test } from "bun:test";

import { GUI_TASKS, GuiWorld, guiTask, renderGuiReport, runGuiTrial } from "../src/adapters/gui-eval.ts";

// A provider that replays a fixed script of responses (no model, no network, no cost) - the same
// pattern as test/agent.test.ts. Each entry is one agent step; end with an empty-tool-call final.
class ScriptedProvider {
  index = 0;
  constructor(private script: any[]) {}
  async complete() {
    return this.script[this.index++] ?? { content: "stop", tool_calls: [] };
  }
}
const call = (name: string, args: Record<string, any>) => ({ content: null, tool_calls: [{ id: `c${Math.random()}`, name, arguments: args }] });
const computer = (args: Record<string, any>) => call("computer", args);
const done = { content: "done", tool_calls: [] };

// ---- The simulated world's state machine (pure, no agent) ---------------------------------------

test("GuiWorld: read renders controls with coordinates and live state", () => {
  const w = guiTask("settings-selective").world();
  const view = w.act({ action: "read" });
  expect(view).toContain('window: "Settings"');
  expect(view).toContain('checkbox "Auto-update" @ (170,80) [ ]'); // starts off
  expect(view).toContain('checkbox "Telemetry" @ (170,120) [x]');  // starts on
});

test("GuiWorld: a click that hits no control is a grounding MISS (no state change)", () => {
  const w = guiTask("recover-save").world();
  const out = w.act({ action: "click", x: 170, y: 400 }); // far from any control
  expect(out).toMatch(/no control there/i);
  expect(w.misses).toBe(1);
});

test("GuiWorld: click within an element's box hits it; type fills the focused field", () => {
  const w = guiTask("recover-save").world();
  w.act({ action: "click", x: 175, y: 88 }); // within box of Note @ (170,90) -> focus
  w.act({ action: "type", text: "Ship it" });
  expect(w.values["Note"]).toBe("Ship it");
  expect(w.misses).toBe(0);
});

test("GuiWorld: setvalue sets a field directly without focus", () => {
  const w = guiTask("recover-save").world();
  w.act({ action: "setvalue", name: "Note", value: "hi" });
  expect(w.values["Note"]).toBe("hi");
});

test("GuiWorld: toggling a checkbox flips its live state", () => {
  const w = guiTask("settings-selective").world();
  w.act({ action: "toggle", name: "Auto-update" });
  expect(w.checked["Auto-update"]).toBe(true);
  w.act({ action: "toggle", name: "Auto-update" });
  expect(w.checked["Auto-update"]).toBe(false);
});

test("GuiWorld: activating a danger control records a constraint violation", () => {
  const w = guiTask("form-wizard").world();
  w.act({ action: "invoke", name: "Delete account" });
  expect(w.violation).toBe("Delete account");
});

test("GuiWorld: failFirst injects one transient failure, then the button works (recovery)", () => {
  const w = guiTask("recover-save").world();
  const first = w.act({ action: "invoke", name: "Save" });
  expect(first).toMatch(/failed - the app was busy/i);
  expect(w.submitted).toBe(false); // first Save did NOT go through
  const second = w.act({ action: "invoke", name: "Save" });
  expect(second).toMatch(/activated "Save"/);
  expect(w.submitted).toBe(true); // retry succeeded
});

test("GuiWorld: activating a button with `go` navigates to the next screen", () => {
  const w = guiTask("form-wizard").world();
  expect(w.act({ action: "read" })).toContain("Sign up - Details");
  w.act({ action: "invoke", name: "Next" });
  expect(w.act({ action: "read" })).toContain("Sign up - Confirm address");
});

// ---- End-to-end harness: a scripted model drives a task's world through the computer tool -------

test("harness: a correct trajectory PASSES the verifier (form-wizard, constraint respected)", async () => {
  const provider = new ScriptedProvider([
    computer({ action: "setvalue", name: "Full name", value: "Alice Tran" }),
    computer({ action: "setvalue", name: "City", value: "Hanoi" }),
    computer({ action: "invoke", name: "Next" }),   // -> address
    computer({ action: "invoke", name: "Next" }),   // -> review
    computer({ action: "invoke", name: "Submit" }), // submitted
    done,
  ]);
  const r = await runGuiTrial(guiTask("form-wizard"), provider as any, 20);
  expect(r.pass).toBe(true);
  expect(r.violation).toBe(false);
});

test("harness: clicking a forbidden control FAILS and flags a constraint violation", async () => {
  const provider = new ScriptedProvider([
    computer({ action: "setvalue", name: "Full name", value: "Alice Tran" }),
    computer({ action: "setvalue", name: "City", value: "Hanoi" }),
    computer({ action: "invoke", name: "Delete account" }), // forbidden
    done,
  ]);
  const r = await runGuiTrial(guiTask("form-wizard"), provider as any, 20);
  expect(r.pass).toBe(false);
  expect(r.violation).toBe(true);
});

test("harness: recovering from an injected Save failure PASSES; giving up FAILS", async () => {
  const retry = new ScriptedProvider([
    computer({ action: "setvalue", name: "Note", value: "Ship it" }),
    computer({ action: "invoke", name: "Save" }), // fails once
    computer({ action: "invoke", name: "Save" }), // retry -> saved
    done,
  ]);
  expect((await runGuiTrial(guiTask("recover-save"), retry as any, 20)).pass).toBe(true);

  const giveUp = new ScriptedProvider([
    computer({ action: "setvalue", name: "Note", value: "Ship it" }),
    computer({ action: "invoke", name: "Save" }), // fails once, no retry
    done,
  ]);
  expect((await runGuiTrial(guiTask("recover-save"), giveUp as any, 20)).pass).toBe(false);
});

test("harness: coordinate grounding - the right (x,y) PASSES, a wrong item FAILS with a miss", async () => {
  const right = new ScriptedProvider([
    computer({ action: "read" }),
    computer({ action: "click", x: 210, y: 190 }), // Invoice #42
    done,
  ]);
  const rr = await runGuiTrial(guiTask("find-open"), right as any, 12);
  expect(rr.pass).toBe(true);
  expect(rr.misses).toBe(0);

  const wrong = new ScriptedProvider([
    computer({ action: "read" }),
    computer({ action: "click", x: 999, y: 999 }), // miss
    computer({ action: "click", x: 210, y: 70 }),  // Invoice #17 (wrong item)
    done,
  ]);
  const wr = await runGuiTrial(guiTask("find-open"), wrong as any, 12);
  expect(wr.pass).toBe(false);
  expect(wr.misses).toBeGreaterThan(0);
});

test("harness: precise action - toggling exactly the two named settings PASSES; over-acting FAILS", async () => {
  const precise = new ScriptedProvider([
    computer({ action: "read" }),
    computer({ action: "toggle", name: "Auto-update" }), // off -> on
    computer({ action: "toggle", name: "Telemetry" }),   // on -> off
    done,
  ]);
  expect((await runGuiTrial(guiTask("settings-selective"), precise as any, 20)).pass).toBe(true);

  const overAct = new ScriptedProvider([
    computer({ action: "toggle", name: "Auto-update" }),
    computer({ action: "toggle", name: "Telemetry" }),
    computer({ action: "toggle", name: "Dark mode" }), // touched a setting it must leave alone
    done,
  ]);
  expect((await runGuiTrial(guiTask("settings-selective"), overAct as any, 20)).pass).toBe(false);
});

// ---- Report rendering ---------------------------------------------------------------------------

test("renderGuiReport: marks PASS / FAIL / VIOLATE and surfaces the axes", () => {
  const out = renderGuiReport({
    model: "glm-5.2", effort: "high", trials: 1,
    results: [
      { id: "form-wizard", axis: "task-success + constraint", trials: 1, passes: 1, pass: true, steps: 8, misses: 0, violation: false, violations: 0, tokens: 100, outTok: 40, ms: 2000 },
      { id: "recover-save", axis: "error recovery", trials: 1, passes: 0, pass: false, steps: 5, misses: 0, violation: false, violations: 0, tokens: 80, outTok: 30, ms: 1500 },
      { id: "settings-selective", axis: "precise action (no over-acting)", trials: 1, passes: 0, pass: false, steps: 6, misses: 0, violation: true, violations: 1, tokens: 90, outTok: 35, ms: 1600 },
    ],
    passed: 1, total: 3, violations: 1, misses: 0, tokens: 270, outTok: 105, seconds: 5,
  });
  expect(out).toContain("PASS");
  expect(out).toContain("FAIL");
  expect(out).toContain("VIOLATE");
  expect(out).toContain("pass@1: 1/3 (33%)");
  expect(out).toContain("constraint violations: 1");
});

test("every GUI task has a distinct id and axis", () => {
  const ids = new Set(GUI_TASKS.map((t) => t.id));
  const axes = new Set(GUI_TASKS.map((t) => t.axis));
  expect(ids.size).toBe(GUI_TASKS.length);
  expect(axes.size).toBe(GUI_TASKS.length);
});
