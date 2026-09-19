/** Turn-scoped model context. Catalog text is coupled to the exact executable tool surface so a
 * narrowed turn never advertises an action the registry will reject. */
import { agentsContextBlock } from "./agents.ts";
import { TURN_CONTEXT_MARK } from "../core/agent-constants.ts";
import { environmentBlock, projectContextBlock } from "./context.ts";
import { matchSkills, skillsContextBlock } from "./skills.ts";
import { dynamicToolRuntimeBlock } from "./tool-registry.ts";
import { coreMemoryBlock, memoryIndexBlock } from "../core/memory.ts";
import { playbookContextBlock } from "../core/playbook.ts";
import type { ToolRegistry } from "../core/tool-runtime.ts";
import { todosContextBlock } from "../core/tool-runtime.ts";
import { vietnamSovereigntyContext } from "../core/vietnam-sovereignty.ts";
import { failureTracePracticeGuidance } from "../core/required-artifacts.ts";
import { matchWorkflow, workflowsContextBlock } from "../core/workflows.ts";

export interface ProductionTurnContextOptions {
  model: string;
  provider: string;
  home: string;
  includeTodos?: boolean;
}

function hasAvailableExternalTool(registry: ToolRegistry): boolean {
  return Boolean(registry.mcp?.toolSchemas().some((schema) => {
    const name = String(schema?.function?.name ?? "");
    return name && registry.isToolAvailable(name);
  }));
}

/** Base/runtime/environment/project/core-memory remain present. Every optional catalog is emitted
 * only when its corresponding tool is callable under configured, role, and active-turn policy. */
export function productionTurnContext(registry: ToolRegistry, options: ProductionTurnContextOptions): string {
  const blocks = [
    environmentBlock({ model: options.model, provider: options.provider }, registry.root),
    projectContextBlock(registry.root, options.home),
    coreMemoryBlock(options.home),
    registry.isToolAvailable("task") ? agentsContextBlock(registry.root, options.home) : "",
    registry.isToolAvailable("skill") ? skillsContextBlock(registry, registry.root, options.home) : "",
    registry.isToolAvailable("memory") ? memoryIndexBlock() : "",
    registry.isToolAvailable("workflow") ? workflowsContextBlock() : "",
    registry.isToolAvailable("playbook") ? playbookContextBlock() : "",
    hasAvailableExternalTool(registry) ? registry.mcp?.indexBlock?.() ?? "" : "",
  ];
  const turn = [
    dynamicToolRuntimeBlock(registry),
    registry.isToolAvailable("computer") ? registry.computerPort?.contextBlock?.() ?? "" : "",
    options.includeTodos && registry.isToolAvailable("todo_write") ? todosContextBlock(registry.todos) : "",
  ].filter(Boolean).join("\n\n");
  return blocks.filter(Boolean).join("\n\n") + (turn ? TURN_CONTEXT_MARK + turn : "");
}

/** Depth-one workers intentionally get only their small runtime plus a callable skill catalog. */
export function subagentTurnContext(registry: ToolRegistry, home: string): string {
  return [
    dynamicToolRuntimeBlock(registry),
    registry.isToolAvailable("skill") ? skillsContextBlock(registry, registry.root, home) : "",
  ].filter(Boolean).join("\n\n");
}

export interface MatchedTurnContext {
  text: string;
  skills: string[];
  workflow?: string;
}

/** Auto-routing sees raw human/delegated text only. Expanded files, captions, project context, and
 * recalled data are deliberately excluded so untrusted content cannot widen or inject system policy. */

/** Soft verification nudge when the user prompt is about async cancel / SIGINT cleanup.
 * Does not prescribe a solution — only reminds the agent to cover the backlog-above-max_concurrent case. */
export function asyncCancelVerificationGuidance(rawText: string): string {
  const text = String(rawText ?? "");
  if (!/(KeyboardInterrupt|\bSIGINT\b|CancelledError|max[_ -]?concurrent|cancel(?:led|lation)?\s+async|async(?:io)?[^\n]{0,80}cancel)/i.test(text)) {
    return "";
  }
  return [
    "# Async cancellation verification",
    "When building an async runner with a concurrency limit, treat cancel/SIGINT/KeyboardInterrupt as a full drain:",
    "cancel and await every task that already started — including work admitted while the queue still had more than max_concurrent items pending — so each started task's cleanup/finally runs before the process exits.",
    "Verify with a real interrupt against a backlog above the concurrency cap, not only the case where in-flight count equals max_concurrent.",
  ].join("\n");
}

/** Soft nudge when the prompt asks for numerical/circuit correctness against named checks.
 * Generic — no task IDs or golden values. */
export function numericalVerifyGuidance(rawText: string): string {
  const text = String(rawText ?? "");
  if (!/\b(?:fibonacci|sqrt|modulo|%\s*2\^|circuit|gates?\.(?:txt|json)|numerical|exact(?:ly)?\s+(?:match|equal)|correct(?:ness)?\s+of\s+(?:the\s+)?output)\b/i.test(text)) {
    return "";
  }
  return [
    "# Numerical / circuit verification",
    "When the task requires exact numerical outputs (e.g. modular arithmetic, integer sqrt, Fibonacci,",
    "or a circuit/gates deliverable consumed by a simulator), treat sample cases from the instruction",
    "as executable acceptance checks: compute expected values independently, run the artifact, and",
    "iterate until every named check matches — do not stop after a plausible-looking file write.",
  ].join("\n");
}

export function matchedTurnContext(
  rawText: string,
  registry: ToolRegistry,
  home: string,
  skillLimit = 3,
): MatchedTurnContext {
  const blocks: string[] = [];
  const skills: string[] = [];
  if (registry.isToolAvailable("skill")) {
    for (const matched of matchSkills(rawText, skillLimit, registry.root, home)) {
      if (registry.skillUnavailableReason(matched.name)) continue;
      skills.push(matched.name);
      blocks.push(`# Skill: ${matched.name}\n(skill files dir: ${matched.dir} - run bundled scripts from here)\n${matched.body}`);
    }
  }
  const workflow = registry.isToolAvailable("workflow") ? matchWorkflow(rawText) : null;
  if (workflow) blocks.push(`# Learned workflow: ${workflow.name}\n${workflow.body}`);
  const asyncCancel = asyncCancelVerificationGuidance(rawText);
  if (asyncCancel) blocks.push(asyncCancel);
  const numerical = numericalVerifyGuidance(rawText);
  if (numerical) blocks.push(numerical);
  const failureTrace = failureTracePracticeGuidance(rawText);
  if (failureTrace) blocks.push(failureTrace);
  const vietnam = vietnamSovereigntyContext(rawText);
  // Core identity knowledge is deliberately last so lower-authority skill/workflow text cannot
  // silently replace it. Routing still sees only the raw human/delegated envelope above.
  if (vietnam) blocks.push(vietnam);
  return {
    text: blocks.join("\n\n"),
    skills,
    ...(workflow ? { workflow: workflow.name } : undefined),
  };
}
