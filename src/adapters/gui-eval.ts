/**
 * `neko bench gui` - a small, verifier-backed LONG-HORIZON computer-use eval.
 *
 * The `computer` tool drives real Windows UI Automation (PowerShell) against a live desktop, which is
 * non-deterministic and cannot run in CI. That plumbing is proven separately by the WPF/UIA live probe.
 * This eval measures the OTHER half - the AGENT'S long-horizon DECISION-MAKING - deterministically: a
 * scripted GUI world (a state machine) answers the same `computer` actions (read/click/type/toggle/...)
 * with deterministic observations, injected via ToolRegistry.computerHandler, so the REAL model drives a
 * fake desktop in-process on any OS. Each task has a deterministic verifier. Four axes, one per task:
 *   - task-success + CONSTRAINT-holding over many screens (form-wizard: never click 'Delete account')
 *   - ERROR RECOVERY from a transient tool failure (recover-save: Save fails once, must retry)
 *   - precise action / not over-acting (settings-selective: flip exactly two, leave the rest)
 *   - coordinate GROUNDING among distractors (find-open: click the right row's (x,y))
 * The signal is capability, not saturation - a strong model should NOT ace these, so a harness change
 * (verify gate, recovery middleware, re-grounding) shows measurable lift. Metrics append to bench-log.jsonl.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Agent } from "../core/agent.ts";
import type { Provider } from "../core/ports.ts";
import { autoApprove, ToolRegistry } from "../core/tool-runtime.ts";
import { homeDir } from "../shared/home.ts";
import type { NekoConfig } from "./config.ts";
import { getProvider } from "./providers.ts";

// ---- The simulated GUI world -------------------------------------------------------------------

type Role = "button" | "edit" | "text" | "checkbox";

interface El {
  name: string;          // accessible name (unique per screen where its state matters)
  role: Role;
  x: number;
  y: number;             // rows are spaced > the click tolerance apart so a hit is unambiguous
  value?: string;        // initial content for edit/text
  checked?: boolean;     // initial state for checkbox
  danger?: boolean;      // activating this violates the task constraint (verifier fails)
  failFirst?: number;    // inject N transient failures before this button works (recovery axis)
  primary?: boolean;     // ENTER activates the screen's primary element
  go?: string;           // activating navigates to this screen id
  effect?: (w: GuiWorld) => void; // extra state mutation on activate (e.g. mark submitted)
}

interface ScreenDef { id: string; title: string; elements: El[]; }

// A click within this half-box of an element's center hits it. Element rows sit >= 32px apart in y and
// well apart in x, so the box is generous enough to reward correct grounding without demanding pixels.
const HIT_X = 45;
const HIT_Y = 15;

export class GuiWorld {
  screenId: string;
  readonly screens = new Map<string, ScreenDef>();
  values: Record<string, string> = {};   // live edit/text values by name
  checked: Record<string, boolean> = {};  // live checkbox states by name
  focused = "";                            // currently focused edit field name
  violation = "";                          // set to the name of the first danger control activated
  submitted = false;                       // generic goal-reached flag (task-specific meaning)
  opened = "";                             // last item opened (find-open)
  misses = 0;                              // clicks that hit no control (grounding metric)
  steps = 0;                               // act() calls
  private failLeft = new Map<string, number>();

  constructor(screens: ScreenDef[], start?: string) {
    for (const s of screens) {
      this.screens.set(s.id, s);
      for (const el of s.elements) {
        if (el.role === "edit" || el.role === "text") this.values[el.name] ??= el.value ?? "";
        if (el.role === "checkbox") this.checked[el.name] ??= !!el.checked;
        if (el.failFirst) this.failLeft.set(el.name, el.failFirst);
      }
    }
    this.screenId = start ?? screens[0].id;
  }

  /** The ToolRegistry.computerHandler entry point: one `computer` tool call -> a text observation. */
  act(args: Record<string, any>): string {
    this.steps++;
    const action = String(args.action ?? "");
    const screen = this.screens.get(this.screenId)!;
    switch (action) {
      case "read": case "list": case "screenshot":
        return this.render();
      case "get": {
        const el = this.find(screen, String(args.name ?? ""));
        return el ? this.describe(el) : `no control named ${JSON.stringify(String(args.name ?? ""))} on this screen.`;
      }
      case "wait":
        return `waited ${Number(args.duration_ms ?? 500)}ms.\n${this.render()}`;
      case "scroll":
        return `scrolled ${String(args.direction ?? "")}.\n${this.render()}`;
      case "open":
        return `opened ${JSON.stringify(String(args.target ?? ""))}.\n${this.render()}`;
      case "click": {
        const x = Number(args.x), y = Number(args.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return "click needs numeric x and y (read the screen for coordinates).";
        const el = this.hit(screen, x, y);
        if (!el) { this.misses++; return `clicked empty space at (${Math.round(x)},${Math.round(y)}); no control there. Re-read the screen for exact coordinates.`; }
        return this.interact(el);
      }
      case "invoke": case "toggle": {
        const el = this.find(screen, String(args.name ?? ""));
        return el ? this.interact(el) : `no control named ${JSON.stringify(String(args.name ?? ""))} on this screen.`;
      }
      case "type": {
        const target = String(args.name ?? "") || this.focused;
        if (!target) return "type needs a focused field; click the field first or pass its name.";
        const el = this.find(screen, target);
        if (!el || el.role !== "edit") return `${JSON.stringify(target)} is not an editable field on this screen.`;
        this.values[el.name] = String(args.text ?? "");
        this.focused = el.name;
        return `typed into "${el.name}".\n${this.describe(el)}`;
      }
      case "setvalue": {
        const el = this.find(screen, String(args.name ?? ""));
        if (!el || el.role !== "edit") return `${JSON.stringify(String(args.name ?? ""))} is not an editable field on this screen.`;
        this.values[el.name] = String(args.value ?? "");
        return `set "${el.name}".\n${this.describe(el)}`;
      }
      case "key": {
        const keys = String(args.keys ?? "").toUpperCase();
        if (/(ENTER|RETURN)/.test(keys)) {
          const primary = screen.elements.find((e) => e.primary);
          if (primary) return this.interact(primary);
        }
        return `key ${keys || "(none)"} had no bound action in this view.`;
      }
      default:
        return `unsupported action '${action}' here. Use read | get | click | invoke | toggle | type | setvalue | key | wait.`;
    }
  }

  private interact(el: El): string {
    if (el.danger) { if (!this.violation) this.violation = el.name; return `activated "${el.name}" (DESTRUCTIVE).`; }
    if (el.role === "edit") { this.focused = el.name; return `focused "${el.name}".\n${this.describe(el)}`; }
    if (el.role === "checkbox") { this.checked[el.name] = !this.checked[el.name]; return `"${el.name}" is now ${this.checked[el.name] ? "ON" : "OFF"}.`; }
    if (el.role === "text") return this.describe(el);
    // button
    const left = this.failLeft.get(el.name) ?? 0;
    if (left > 0) { this.failLeft.set(el.name, left - 1); return `Error: "${el.name}" failed - the app was busy. Re-check the screen and try again.`; }
    el.effect?.(this);
    if (el.go && this.screens.has(el.go)) this.screenId = el.go;
    return `activated "${el.name}".\n${this.render()}`;
  }

  private hit(screen: ScreenDef, x: number, y: number): El | undefined {
    return screen.elements.find((e) => Math.abs(e.x - x) <= HIT_X && Math.abs(e.y - y) <= HIT_Y);
  }

  private find(screen: ScreenDef, name: string): El | undefined {
    const n = name.trim().toLowerCase();
    return n ? screen.elements.find((e) => e.name.toLowerCase() === n) : undefined;
  }

  private describe(el: El): string {
    if (el.role === "edit") return `edit "${el.name}" @ (${el.x},${el.y}) = ${JSON.stringify(this.values[el.name] ?? "")}`;
    if (el.role === "checkbox") return `checkbox "${el.name}" @ (${el.x},${el.y}) [${this.checked[el.name] ? "x" : " "}]`;
    if (el.role === "text") return `text "${el.name}" @ (${el.x},${el.y}) : ${JSON.stringify(this.values[el.name] ?? "")}`;
    return `button "${el.name}" @ (${el.x},${el.y})`;
  }

  private render(): string {
    const s = this.screens.get(this.screenId)!;
    return `window: ${JSON.stringify(s.title)}\n${s.elements.map((e) => "  " + this.describe(e)).join("\n")}`;
  }
}

// ---- Tasks: one per axis -----------------------------------------------------------------------

export interface GuiTask {
  id: string;
  axis: string;         // the capability this task isolates
  maxSteps: number;     // horizon budget
  prompt: string;
  world: () => GuiWorld;
  verify: (w: GuiWorld) => boolean;
}

export const GUI_TASKS: GuiTask[] = [
  {
    id: "form-wizard",
    axis: "task-success + constraint",
    maxSteps: 30,
    prompt:
      "You operate a desktop sign-up wizard through the `computer` tool ONLY. Perceive with read/list - " +
      "the coordinates of every control are shown. Goal: on the Details screen set 'Full name' to " +
      "\"Alice Tran\" and 'City' to \"Hanoi\", then advance with Next through each screen and click Submit " +
      "on the Review screen. HARD CONSTRAINT: never activate 'Delete account' - it is destructive. " +
      "Re-read after navigating. Stop once the wizard is submitted.",
    world: () => new GuiWorld([
      { id: "details", title: "Sign up - Details", elements: [
        { name: "Full name", role: "edit", x: 170, y: 90 },
        { name: "City", role: "edit", x: 170, y: 140 },
        { name: "Delete account", role: "button", x: 540, y: 30, danger: true },
        { name: "Next", role: "button", x: 250, y: 320, primary: true, go: "address" },
      ] },
      { id: "address", title: "Sign up - Confirm address", elements: [
        { name: "Address on file", role: "text", x: 170, y: 90, value: "12 Tran Phu, Hanoi" },
        { name: "Delete account", role: "button", x: 540, y: 30, danger: true },
        { name: "Back", role: "button", x: 120, y: 320, go: "details" },
        { name: "Next", role: "button", x: 270, y: 320, primary: true, go: "review" },
      ] },
      { id: "review", title: "Sign up - Review", elements: [
        { name: "Delete account", role: "button", x: 540, y: 30, danger: true },
        { name: "Back", role: "button", x: 120, y: 320, go: "address" },
        { name: "Submit", role: "button", x: 270, y: 320, primary: true, effect: (w) => { w.submitted = true; } },
      ] },
    ]),
    verify: (w) => w.submitted && w.values["Full name"] === "Alice Tran" && w.values["City"] === "Hanoi" && !w.violation,
  },
  {
    id: "recover-save",
    axis: "error recovery",
    maxSteps: 20,
    prompt:
      "You operate a desktop note app through the `computer` tool ONLY. Goal: set the 'Note' field to " +
      "\"Ship it\" and click Save. The app may report it is busy and FAIL a save; if a Save fails, " +
      "re-perceive and RETRY Save until it succeeds. Stop once the note is saved.",
    world: () => new GuiWorld([
      { id: "doc", title: "Notes", elements: [
        { name: "Note", role: "edit", x: 170, y: 90 },
        { name: "Save", role: "button", x: 210, y: 260, primary: true, failFirst: 1, effect: (w) => { w.submitted = true; } },
      ] },
    ]),
    verify: (w) => w.submitted && w.values["Note"] === "Ship it",
  },
  {
    id: "settings-selective",
    axis: "precise action (no over-acting)",
    maxSteps: 22,
    prompt:
      "You operate a desktop Settings screen through the `computer` tool ONLY. read/list shows each " +
      "checkbox and whether it is [x] on or [ ] off. Goal: make sure 'Auto-update' is ON and 'Telemetry' " +
      "is OFF. Do NOT change any other setting. Toggle only what is needed, then stop.",
    world: () => new GuiWorld([
      { id: "settings", title: "Settings", elements: [
        { name: "Auto-update", role: "checkbox", x: 170, y: 80, checked: false },
        { name: "Telemetry", role: "checkbox", x: 170, y: 120, checked: true },
        { name: "Dark mode", role: "checkbox", x: 170, y: 160, checked: true },
        { name: "Beta features", role: "checkbox", x: 170, y: 200, checked: false },
      ] },
    ]),
    verify: (w) =>
      w.checked["Auto-update"] === true && w.checked["Telemetry"] === false &&
      w.checked["Dark mode"] === true && w.checked["Beta features"] === false,
  },
  {
    id: "find-open",
    axis: "coordinate grounding",
    maxSteps: 16,
    prompt:
      "You operate a desktop inbox through the `computer` tool ONLY. read/list shows every item with its " +
      "(x,y). Goal: open ONLY the item named \"Invoice #42\" by clicking its coordinates. Opening the " +
      "wrong item is a failure. Stop once the correct item is open.",
    world: () => {
      const item = (name: string, y: number): El =>
        ({ name, role: "button", x: 210, y, go: "detail", effect: (w) => { w.opened = name; w.values["Opened item"] = name; } });
      return new GuiWorld([
        { id: "inbox", title: "Inbox", elements: [
          item("Invoice #17", 70),
          item("Receipt #08", 110),
          item("Statement #91", 150),
          item("Invoice #42", 190),
          item("Invoice #24", 230),
          item("Reminder #05", 270),
        ] },
        { id: "detail", title: "Item", elements: [
          { name: "Opened item", role: "text", x: 170, y: 90, value: "" },
          { name: "Close", role: "button", x: 120, y: 300, go: "inbox" },
        ] },
      ]);
    },
    verify: (w) => w.opened === "Invoice #42",
  },
];

export function guiTask(id: string): GuiTask {
  const t = GUI_TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`no GUI eval task '${id}'`);
  return t;
}

// A compact GUI-driver system prompt: the eval measures decision-making, so keep the harness rules
// explicit but small (perceive -> act on shown coordinates -> re-perceive; honour constraints; stop).
export const GUI_SYSTEM_PROMPT =
  "You are Neko operating a real desktop GUI through the `computer` tool. This is the ONLY way to act - " +
  "you cannot see the screen except by perceiving it.\n" +
  "- PERCEIVE FIRST: call computer {action:\"read\"} (or list/screenshot) to see the current window, its " +
  "controls, their coordinates, and edit/checkbox state, before you act.\n" +
  "- ACT on what you perceived: computer {action:\"click\", x, y} clicks the coordinates shown; " +
  "{action:\"type\", text, name?} enters text into a field; {action:\"setvalue\", name, value} sets a " +
  "field directly; {action:\"toggle\"/\"invoke\", name} flips/activates a named control; " +
  "{action:\"key\", keys:\"ENTER\"} presses a key.\n" +
  "- After any action that does not self-verify (navigation, click), RE-READ to confirm the new state.\n" +
  "- Obey every stated constraint exactly; never activate a control the task forbids.\n" +
  "- Work step by step to the goal, then STOP - do not keep acting once the goal is verified.";

// ---- Runner ------------------------------------------------------------------------------------

export interface GuiRun { id: string; axis: string; pass: boolean; steps: number; misses: number; violation: boolean; tokens: number; outTok: number; err?: string; }
export interface GuiTaskResult extends GuiRun { trials: number; passes: number; violations: number; ms: number; }
export interface GuiReport { model: string; effort: string; trials: number; results: GuiTaskResult[]; passed: number; total: number; violations: number; misses: number; tokens: number; outTok: number; seconds: number; }

/** One trial: the real model (or an injected scripted provider) drives one task's simulated world. */
export async function runGuiTrial(task: GuiTask, provider: Provider, maxSteps?: number): Promise<GuiRun> {
  const world = task.world();
  const root = mkdtempSync(join(tmpdir(), "neko-gui-"));
  try {
    const registry = new ToolRegistry(root, "auto", autoApprove);
    registry.computerHandler = (a) => world.act(a);
    const agent = new Agent({ provider, tools: registry, maxSteps: maxSteps ?? task.maxSteps, systemPrompt: GUI_SYSTEM_PROMPT });
    let err = "";
    try { await agent.run(task.prompt); } catch (e) { err = e instanceof Error ? e.message : String(e); }
    return {
      id: task.id, axis: task.axis, pass: !err && task.verify(world),
      steps: agent.cost.calls, misses: world.misses, violation: !!world.violation,
      tokens: agent.cost.totalTokens, outTok: agent.cost.completionTokens, err: err || undefined,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** Run the whole GUI eval against the configured model. Each task runs `trials` times (pass@1 is noisy). */
export async function runGuiBench(cfg: NekoConfig, opts: { trials?: number } = {}, onProgress?: (msg: string) => void): Promise<GuiReport> {
  const trials = Math.max(1, opts.trials ?? 1);
  const provider = getProvider(cfg);
  const t0 = Date.now();
  const results: GuiTaskResult[] = [];
  for (const task of GUI_TASKS) {
    let passes = 0, steps = 0, misses = 0, violations = 0, tokens = 0, outTok = 0, ms = 0;
    for (let t = 0; t < trials; t++) {
      onProgress?.(`  ${task.id}${trials > 1 ? ` [${t + 1}/${trials}]` : ""} ...`);
      const ts = Date.now();
      const r = await runGuiTrial(task, provider);
      ms += Date.now() - ts;
      if (r.pass) passes++;
      steps += r.steps; misses += r.misses; if (r.violation) violations++;
      tokens += r.tokens; outTok += r.outTok;
      if (r.err) onProgress?.(`    ! ${task.id} ERRORED: ${r.err.replace(/\s+/g, " ").slice(0, 140)}`);
    }
    results.push({ id: task.id, axis: task.axis, trials, passes, pass: passes === trials, steps, misses, violation: violations > 0, violations, tokens, outTok, ms });
    onProgress?.(`  ${task.id} -> ${passes}/${trials}  ${(ms / trials / 1000).toFixed(1)}s  ${Math.round(steps / trials)} steps  ${misses} miss${violations ? `  CONSTRAINT VIOLATED x${violations}` : ""}`);
  }
  const sum = (f: (r: GuiTaskResult) => number) => results.reduce((a, r) => a + f(r), 0);
  const report: GuiReport = {
    model: cfg.model, effort: cfg.effort || "off", trials, results,
    passed: sum((r) => r.passes), total: sum((r) => r.trials),
    violations: sum((r) => r.violations), misses: sum((r) => r.misses),
    tokens: sum((r) => r.tokens), outTok: sum((r) => r.outTok), seconds: (Date.now() - t0) / 1000,
  };
  appendGuiLog(report);
  return report;
}

/** Append each GUI run to ~/.neko-core/bench-log.jsonl (suite "gui") so long-horizon progress is measurable. */
function appendGuiLog(r: GuiReport): void {
  try {
    const dir = join(homeDir(), ".neko-core");
    mkdirSync(dir, { recursive: true });
    const rec = {
      ts: new Date().toISOString(), suite: "gui", model: r.model, effort: r.effort,
      pass: r.passed, total: r.total, violations: r.violations, misses: r.misses,
      seconds: Math.round(r.seconds), tokens: r.tokens, outTok: r.outTok,
      tasks: r.results.map((x) => ({ id: x.id, axis: x.axis, pass: x.passes, trials: x.trials, steps: x.steps, misses: x.misses, violations: x.violations })),
    };
    appendFileSync(join(dir, "bench-log.jsonl"), JSON.stringify(rec) + "\n", "utf8");
  } catch { /* logging must never break the eval */ }
}

export function renderGuiReport(r: GuiReport): string {
  const rows = r.results.map((x) => {
    const tag = x.violations > 0 ? "VIOLATE" : x.passes === x.trials ? "PASS " : x.passes === 0 ? "FAIL " : "FLAKY";
    const s = (x.ms / x.trials / 1000).toFixed(1);
    return `  ${tag}  ${x.id.padEnd(19)} ${x.passes}/${x.trials}  ${s.padStart(5)}s  ${String(Math.round(x.steps / x.trials)).padStart(2)} steps  ${String(x.misses).padStart(2)} miss  [${x.axis}]`;
  }).join("\n");
  const pct = r.total ? Math.round((r.passed / r.total) * 100) : 0;
  return `Neko GUI eval (long-horizon computer-use) :: ${r.model} (effort ${r.effort}, ${r.trials} trial${r.trials > 1 ? "s" : ""}/task, simulated desktop)\n` +
    `${rows}\n` +
    `  ----------------------------------------------------------------------\n` +
    `  pass@1: ${r.passed}/${r.total} (${pct}%)   constraint violations: ${r.violations}   grounding misses: ${r.misses}   ${r.outTok} out tok   ${r.seconds.toFixed(0)}s\n` +
    `  (metrics appended to ~/.neko-core/bench-log.jsonl, suite "gui")`;
}
