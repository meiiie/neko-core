/**
 * Coding-agent tool contracts — the registry the model sees and the policy gate audits.
 *
 * Two permission classes (the coding-agent analog of a runtime/development boundary):
 *   - "safe"  : read-only, runs without approval (read_file, search)
 *   - "gated" : writes files or runs commands, approval-gated (write_file, bash)
 *
 * This module is the declarative source of truth (contracts + JSON schema for the model);
 * tool-runtime.ts attaches the executable callables + the approval gate.
 */
export const SAFE = "safe";
export const GATED = "gated";

export interface ToolSpec {
  name: string;
  permission: typeof SAFE | typeof GATED;
  summary: string;
  parameters: Record<string, any>; // JSON-schema properties (type/description, plus items/enum)
  required: string[];
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "read_file",
    permission: SAFE,
    summary: "Read a UTF-8 text file from the project.",
    parameters: { path: { type: "string", description: "File path, relative to the project root." } },
    required: ["path"],
  },
  {
    name: "search",
    permission: SAFE,
    summary: "Search file contents by regular expression across the project.",
    parameters: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "Directory to search (default: project root)." },
    },
    required: ["pattern"],
  },
  {
    name: "glob",
    permission: SAFE,
    summary: "Find files by glob pattern (e.g. src/**/*.ts).",
    parameters: {
      pattern: { type: "string", description: "Glob pattern, e.g. **/*.ts." },
      path: { type: "string", description: "Base directory to search (default: project root)." },
    },
    required: ["pattern"],
  },
  {
    name: "ls",
    permission: SAFE,
    summary: "List the entries of a directory.",
    parameters: {
      path: { type: "string", description: "Directory to list (default: project root)." },
    },
    required: [],
  },
  {
    name: "write_file",
    permission: GATED,
    summary: "Create or overwrite a file with new contents (approval-gated).",
    parameters: {
      path: { type: "string", description: "File path to write, relative to the project root." },
      content: { type: "string", description: "The full new file contents." },
    },
    required: ["path", "content"],
  },
  {
    name: "edit",
    permission: GATED,
    summary: "Replace one exact occurrence of a string in a file (approval-gated).",
    parameters: {
      path: { type: "string", description: "File path to edit." },
      old_string: { type: "string", description: "Exact text to replace (must occur exactly once)." },
      new_string: { type: "string", description: "Replacement text." },
    },
    required: ["path", "old_string", "new_string"],
  },
  {
    name: "multi_edit",
    permission: GATED,
    summary: "Apply several exact-match edits to one file atomically (all-or-nothing, approval-gated).",
    parameters: {
      path: { type: "string", description: "File path to edit." },
      edits: {
        type: "array",
        description: "Edits applied in order; each old_string must occur exactly once at its turn.",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "Exact text to replace." },
            new_string: { type: "string", description: "Replacement text." },
          },
        },
      },
    },
    required: ["path", "edits"],
  },
  {
    name: "bash",
    permission: GATED,
    summary: "Run a shell command in the project root (approval-gated).",
    parameters: { command: { type: "string", description: "The shell command to run." } },
    required: ["command"],
  },
  {
    name: "todo_write",
    permission: SAFE,
    summary: "Record/update the task todo list. Use it to plan multi-step work and track progress.",
    parameters: {
      todos: {
        type: "array",
        description: "The full todo list (replaces the previous one).",
        items: {
          type: "object",
          properties: {
            content: { type: "string", description: "Task description." },
            status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Task status." },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  {
    name: "web_search",
    permission: SAFE,
    summary: "Search the web (DuckDuckGo) and return the top results (title + url + snippet).",
    parameters: { query: { type: "string", description: "Search query." } },
    required: ["query"],
  },
  {
    name: "web_fetch",
    permission: SAFE,
    summary: "Fetch a URL (HTML stripped to text). With `prompt`, a fast pass extracts just what you asked, instead of returning the whole page.",
    parameters: {
      url: { type: "string", description: "Absolute http(s) URL." },
      prompt: { type: "string", description: "Optional: what to extract from the page." },
    },
    required: ["url"],
  },
  {
    name: "exit_plan_mode",
    permission: SAFE,
    summary: "In plan mode, present your implementation plan for the user to approve before you edit anything.",
    parameters: { plan: { type: "string", description: "The plan to implement, as concise markdown." } },
    required: ["plan"],
  },
  {
    name: "task",
    permission: SAFE,
    summary: "Delegate a self-contained subtask to a fresh sub-agent (isolated context); it returns a result. Use it to research or do focused work without cluttering this conversation.",
    parameters: {
      description: { type: "string", description: "Short (3-5 word) task label." },
      prompt: { type: "string", description: "The full instruction for the sub-agent." },
      subagent_type: { type: "string", description: "Optional named agent type (see the available subagent types in context) to give the sub-agent a specialized role." },
    },
    required: ["description", "prompt"],
  },
  {
    name: "memory",
    permission: SAFE,
    summary: "Your persistent cross-session memory (~/.neko-core/memory/*.md). list | read | write | delete | search. Record durable facts/preferences/learnings; recall relevant ones before working.",
    parameters: {
      action: { type: "string", enum: ["list", "read", "write", "delete", "search"], description: "What to do." },
      name: { type: "string", description: "Memory file name (for read/write/delete)." },
      content: { type: "string", description: "Content to store (for write)." },
      query: { type: "string", description: "Text to find across memories (for search)." },
    },
    required: ["action"],
  },
  {
    name: "skill",
    permission: SAFE,
    summary: "Load a domain skill's full instructions on demand. The available skills (name + one-line description) are listed in your context; when a task matches one, call this with its name FIRST, then follow the instructions it returns. Keeps you general while letting you go deep on a domain.",
    parameters: {
      name: { type: "string", description: "The skill name to load (exactly as listed under 'Available skills')." },
    },
    required: ["name"],
  },
];

export function listTools(): ToolSpec[] {
  return TOOL_SPECS;
}

/** Human-facing verb for each tool in the transcript (Claude-style: Read/Update/Search...). */
const TOOL_LABELS: Record<string, string> = {
  read_file: "Read",
  write_file: "Write",
  edit: "Update",
  multi_edit: "Update",
  search: "Search",
  glob: "Glob",
  ls: "List",
  bash: "Bash",
  todo_write: "Update Todos",
  web_search: "WebSearch",
  web_fetch: "Fetch",
  exit_plan_mode: "Plan",
  task: "Task",
  memory: "Memory",
  skill: "Skill",
};

/** A compact "Label(primary-arg)" for a tool call, e.g. `Read(src/app.ts)` or `Bash(bun test)`. */
export function describeToolCall(name: string, args: Record<string, any>): string {
  const label = TOOL_LABELS[name] ?? name;
  const a = args ?? {};
  const primary = name === "memory"
    ? [a.action, a.name ?? a.query].filter(Boolean).join(" ")
    : name === "skill"
    ? (a.name ?? "")
    : (a.path ?? a.command ?? a.query ?? a.url ?? a.pattern ?? a.description ?? "");
  const s = String(primary).replace(/\s+/g, " ").trim();
  const shown = s.length > 80 ? s.slice(0, 80) + "…" : s;
  return shown ? `${label}(${shown})` : label;
}

export function resolveTool(name: string): ToolSpec {
  const spec = TOOL_SPECS.find((t) => t.name === name);
  if (!spec) {
    const available = TOOL_SPECS.map((t) => t.name).join(", ") || "none";
    throw new Error(`Unknown tool '${name}'. Available tools: ${available}`);
  }
  return spec;
}

/** Render a ToolSpec as an OpenAI-style function tool (for the provider call). */
export function toOpenAISchema(spec: ToolSpec): Record<string, any> {
  return {
    type: "function",
    function: {
      name: spec.name,
      description: spec.summary,
      parameters: { type: "object", properties: spec.parameters, required: spec.required },
    },
  };
}

export function toolSchemas(): Record<string, any>[] {
  return TOOL_SPECS.map(toOpenAISchema);
}

export function renderTools(specs: ToolSpec[]): string {
  return ["Neko Core tools", ...specs.map((s) => `[${s.permission}] ${s.name}: ${s.summary}`)].join("\n");
}

export function renderToolDetail(spec: ToolSpec): string {
  const lines = [
    "Neko Core Tool",
    `Name: ${spec.name}`,
    `Permission: ${spec.permission}`,
    `Summary: ${spec.summary}`,
    "",
    "Parameters:",
  ];
  for (const [name, def] of Object.entries(spec.parameters)) {
    const flag = spec.required.includes(name) ? " (required)" : "";
    lines.push(`- ${name}: ${def.type}${flag} - ${def.description}`);
  }
  return lines.join("\n");
}
