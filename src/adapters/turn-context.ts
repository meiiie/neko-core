/** Turn-scoped model context. Catalog text is coupled to the exact executable tool surface so a
 * narrowed turn never advertises an action the registry will reject. */
import { agentsContextBlock } from "./agents.ts";
import { environmentBlock, projectContextBlock } from "./context.ts";
import { matchSkills, skillsContextBlock } from "./skills.ts";
import { dynamicToolRuntimeBlock } from "./tool-registry.ts";
import { coreMemoryBlock, memoryIndexBlock } from "../core/memory.ts";
import { playbookContextBlock } from "../core/playbook.ts";
import type { ToolRegistry } from "../core/tool-runtime.ts";
import { todosContextBlock } from "../core/tool-runtime.ts";
import { vietnamSovereigntyContext } from "../core/vietnam-sovereignty.ts";
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
    dynamicToolRuntimeBlock(registry),
    environmentBlock({ model: options.model, provider: options.provider }, registry.root),
    projectContextBlock(registry.root, options.home),
    coreMemoryBlock(options.home),
    registry.isToolAvailable("task") ? agentsContextBlock(registry.root, options.home) : "",
    registry.isToolAvailable("skill") ? skillsContextBlock(registry, registry.root, options.home) : "",
    registry.isToolAvailable("memory") ? memoryIndexBlock() : "",
    registry.isToolAvailable("workflow") ? workflowsContextBlock() : "",
    registry.isToolAvailable("playbook") ? playbookContextBlock() : "",
    options.includeTodos && registry.isToolAvailable("todo_write") ? todosContextBlock(registry.todos) : "",
    hasAvailableExternalTool(registry) ? registry.mcp?.indexBlock?.() ?? "" : "",
  ];
  return blocks.filter(Boolean).join("\n\n");
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
