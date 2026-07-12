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
  /** Actions that mutate state when the tool otherwise has read-only actions. */
  gatedActions?: string[];
  summary: string;
  parameters: Record<string, any>; // JSON-schema properties (type/description, plus items/enum)
  required: string[];
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: "read_file",
    permission: SAFE,
    summary: "Read a UTF-8 text file from the project. Use offset+limit to read a slice of a large file.",
    parameters: {
      path: { type: "string", description: "File path, relative to the project root." },
      offset: { type: "number", description: "1-based line number to start from (for paging large files)." },
      limit: { type: "number", description: "Maximum number of lines to return from offset." },
    },
    required: ["path"],
  },
  {
    name: "search",
    permission: SAFE,
    summary: "Search file contents by regular expression across the project (ripgrep when available, honoring .gitignore; otherwise a built-in walk).",
    parameters: {
      pattern: { type: "string", description: "Regular expression to search for." },
      path: { type: "string", description: "Directory to search (default: project root)." },
      glob: { type: "string", description: "Optional glob to limit files, e.g. *.ts or src/**/*.js." },
      case_insensitive: { type: "boolean", description: "Case-insensitive match (default false)." },
      context: { type: "number", description: "Lines of context to show around each match (0-5, default 0)." },
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
    summary: "Run a shell command in the project root (approval-gated). Set a longer timeout for slow builds/tests, or run_in_background for long-lived processes (servers, watchers).",
    parameters: {
      command: { type: "string", description: "The shell command to run." },
      timeout: { type: "number", description: "Timeout in milliseconds (default 60000, max 600000)." },
      run_in_background: { type: "boolean", description: "Start it in the background and return immediately; read its output later with /bashes. Use for servers/watchers or anything long-running." },
    },
    required: ["command"],
  },
  {
    name: "computer",
    permission: GATED,
    summary:
      "Drive the Windows desktop/GUI through the accessibility tree plus human input. Use bash first for files, downloads, installs, and other programmatic work; use this for apps that require a GUI. Set `window` to a title substring; omit = foreground. Pointer acts use touch injection and do not move the user's mouse. Re-perceive after actions that cannot self-verify.",
    parameters: {
      action: {
        type: "string",
        enum: ["list", "read", "get", "display", "invoke", "setvalue", "toggle", "click", "stroke", "type", "key", "scroll", "wait", "open", "screenshot"],
        description:
          "list/read/get perceive; display reports physical monitor bounds, work areas, DPI and scale; invoke/setvalue/toggle act by accessible name; click/stroke use touch; type enters Unicode text into the focused control; key sends a shortcut such as CTRL+L or ENTER; scroll moves the target window; wait lets dynamic UI settle; open launches an app/file/URL; screenshot captures the physical virtual desktop and returns it directly when vision is enabled, with frame/delta metadata when the resident host is on. setvalue/toggle self-verify; after other actions call list/read/get/screenshot to verify. Pixel delta proves change, not the requested outcome. If bash/C#/PowerShell computes screen coordinates, set PerMonitorV2 BEFORE reading geometry; legacy SetProcessDPIAware is only system-aware.",
      },
      window: { type: "string", description: "Distinctive target window title substring (e.g. 'Paint'). Omit = foreground window; type/key refuse ambiguous matches." },
      name: { type: "string", description: "Element NAME for get/invoke/setvalue/toggle, or an optional exact focus target for type/key (copy it from `list`/`read`)." },
      value: { type: "string", description: "Text to set, for setvalue." },
      x: { type: "number", description: "X pixel, for click." },
      y: { type: "number", description: "Y pixel, for click." },
      points: { type: "array", description: "Flat [x1,y1,x2,y2,...] screen pixels for stroke (drag/draw).", items: { type: "number" } },
      text: { type: "string", description: "Unicode text to enter, for type. Pass name when a specific field should receive it. Never use for secrets; hand control to the user." },
      keys: { type: "string", description: "Key or shortcut, for key (e.g. ENTER, CTRL+L, ALT+TAB). Pass name to focus a specific control first." },
      direction: { type: "string", enum: ["up", "down", "left", "right"], description: "Content direction, for scroll." },
      amount: { type: "number", description: "Scroll gestures, 1-10 (default 1)." },
      duration_ms: { type: "number", description: "Delay in milliseconds, 0-10000 (default 500), for wait." },
      target: { type: "string", description: "Executable, file path, or URL to launch, for open. Use bash when arguments are needed." },
    },
    required: ["action"],
  },
  {
    name: "todo_write",
    permission: SAFE,
    summary: "Record/update the full task todo list. Keep exactly one item in_progress until every item is completed; mark completed only after verification.",
    parameters: {
      todos: {
        type: "array",
        description: "The full todo list (replaces the previous one). Items must be unique and non-empty. Exactly one item is in_progress while pending work remains; all-completed lists have none.",
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
    summary: "Fetch a URL as clean Markdown (headings/links/lists kept). A small page comes back whole with no model call (fast + cheap); a large one is paginated - use `page` to read more. With `prompt`, a fast pass extracts just what you asked; with `schema` (a JSON Schema), extraction is schema-constrained and returns validated JSON - best to enumerate repeated data (e.g. every product variant/price).",
    parameters: {
      url: { type: "string", description: "Absolute http(s) URL." },
      prompt: { type: "string", description: "Optional: what to extract from the page." },
      schema: { type: "object", description: "Optional JSON Schema. When set, the page is extracted into JSON matching this shape (constrained output) - best for lists/tables like price variants." },
      page: { type: "number", description: "Optional: which page of a large fetched page to return (1-based). The footer tells you the total and the next page." },
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
    gatedActions: ["write", "delete"],
    summary: "Your persistent cross-session memory (~/.neko-core/memory/*.md). list | read | write | delete | search. Mutating actions are approval-gated.",
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
  {
    name: "workflow",
    permission: SAFE,
    gatedActions: ["write", "delete"],
    summary: "Your learned procedural memory (~/.neko-core/workflows/*.md). list | read | write | delete | search. Mutating actions are approval-gated.",
    parameters: {
      action: { type: "string", enum: ["list", "read", "write", "delete", "search"], description: "What to do." },
      name: { type: "string", description: "Workflow file name (for read/write/delete)." },
      content: { type: "string", description: "The procedure to store (for write): when-to-use on line 1, then steps/tools/gotchas." },
      query: { type: "string", description: "Text to find across workflows (for search)." },
    },
    required: ["action"],
  },
  {
    name: "playbook",
    permission: SAFE,
    gatedActions: ["add", "revise", "remove"],
    summary: "Your evolving operating playbook (always in your context). read | add | revise | remove. Mutating actions are approval-gated.",
    parameters: {
      action: { type: "string", enum: ["read", "add", "revise", "remove"], description: "What to do." },
      content: { type: "string", description: "The lesson/strategy bullet (for add, or the refined text for revise)." },
      find: { type: "string", description: "Text identifying the bullet to revise/remove." },
    },
    required: ["action"],
  },
];

export function listTools(platform: NodeJS.Platform = process.platform): ToolSpec[] {
  // The computer tool drives Windows UI Automation (PowerShell scripts) - on other platforms the model
  // should never even SEE it in the schema, rather than call it and get a refusal. (tool-runtime keeps
  // a runtime guard as the backstop for anything that slips through, e.g. a resumed session replaying.)
  if (platform !== "win32") return TOOL_SPECS.filter((t) => t.name !== "computer");
  return TOOL_SPECS;
}

/** Resolve action-sensitive permission without making read/list operations prompt. */
export function effectivePermission(spec: ToolSpec, args: Record<string, any> = {}): typeof SAFE | typeof GATED {
  if (spec.permission === GATED) return GATED;
  return spec.gatedActions?.includes(String(args.action ?? "")) ? GATED : SAFE;
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
  computer: "Computer",
  todo_write: "Update Todos",
  web_search: "WebSearch",
  web_fetch: "Fetch",
  exit_plan_mode: "Plan",
  task: "Task",
  memory: "Memory",
  skill: "Skill",
  workflow: "Workflow",
  playbook: "Playbook",
};

/** A compact "Label(primary-arg)" for a tool call, e.g. `Read(src/app.ts)` or `Bash(bun test)`. */
export function describeToolCall(name: string, args: Record<string, any>): string {
  const label = TOOL_LABELS[name] ?? name;
  const a = args ?? {};
  const primary = name === "memory" || name === "workflow" || name === "playbook"
    ? [a.action, a.name ?? a.find ?? a.query].filter(Boolean).join(" ")
    : name === "computer"
    ? [a.action, a.name ?? a.window ?? (a.x !== undefined ? `${a.x},${a.y}` : "")].filter(Boolean).join(" ")
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

export function toolSchemas(platform: NodeJS.Platform = process.platform): Record<string, any>[] {
  return listTools(platform).map(toOpenAISchema);
}

export function renderTools(specs: ToolSpec[]): string {
  return ["Neko Core tools", ...specs.map((s) => `[${s.permission}${s.gatedActions?.length ? `; gated: ${s.gatedActions.join("/")}` : ""}] ${s.name}: ${s.summary}`)].join("\n");
}

export function renderToolDetail(spec: ToolSpec): string {
  const lines = [
    "Neko Core Tool",
    `Name: ${spec.name}`,
    `Permission: ${spec.permission}`,
    ...(spec.gatedActions?.length ? [`Gated actions: ${spec.gatedActions.join(", ")}`] : []),
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
