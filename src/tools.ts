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
  parameters: Record<string, { type: string; description: string }>;
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
    name: "bash",
    permission: GATED,
    summary: "Run a shell command in the project root (approval-gated).",
    parameters: { command: { type: "string", description: "The shell command to run." } },
    required: ["command"],
  },
];

export function listTools(): ToolSpec[] {
  return TOOL_SPECS;
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
