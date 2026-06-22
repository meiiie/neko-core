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
    summary: "Fetch a URL and return its readable text (HTML stripped).",
    parameters: { url: { type: "string", description: "Absolute http(s) URL." } },
    required: ["url"],
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
  search: "Search",
  glob: "Glob",
  ls: "List",
  bash: "Bash",
  todo_write: "Update Todos",
  web_search: "WebSearch",
  web_fetch: "Fetch",
};

/** A compact "Label(primary-arg)" for a tool call, e.g. `Read(src/app.ts)` or `Bash(bun test)`. */
export function describeToolCall(name: string, args: Record<string, any>): string {
  const label = TOOL_LABELS[name] ?? name;
  const a = args ?? {};
  const primary = a.path ?? a.command ?? a.query ?? a.url ?? a.pattern ?? "";
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
