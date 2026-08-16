/**
 * The oracle as a tool the running agent can reach for when it is stuck.
 *
 * Deliberately composed through the MCP seam rather than added to core's tool list, because MCP tools
 * default to GATED: consulting the oracle ships source code off this machine, so it asks first, every
 * time, exactly like `write_file` and `bash` do. Reading past consultations is safe and stays safe.
 */
import type { McpTools } from "../core/ports.ts";
import type { NekoConfig } from "./config.ts";
import { composeMcpTools } from "./mcp-compose.ts";
import {
  consultOracle,
  describeBundle,
  listOracleSessions,
  readOracleSession,
  resolveOracle,
} from "./oracle.ts";

const PREFIX = "mcp__neko_oracle__";

const SCHEMAS = [
  {
    name: "consult",
    description:
      "Ask the oracle - a stronger, separate model - for a second opinion, with a bundle of project files attached. It has no tools and cannot act; it returns a diagnosis, a plan keyed to real paths, how to verify it, and what it could not determine. Use it when you are stuck, when two designs look equally good, or before committing to an expensive direction - not for routine work. Gated: the selected files leave this machine.",
    properties: {
      question: { type: "string", description: "The full question, including what you already tried and what you are deciding between. The oracle sees nothing except this and the files you attach." },
      files: {
        type: "array",
        items: { type: "string" },
        description: "Glob patterns relative to the project root, such as 'src/adapters/*.ts'. Prefix with '!' to exclude. Attach what the answer depends on; credential stores are refused automatically.",
      },
      followup: { type: "string", description: "An earlier oracle session id to continue. Its bundle and answer become prior turns, so you can push back on the reply." },
    },
    required: ["question"],
  },
  {
    name: "sessions",
    description: "List past oracle consultations, or read one back in full (question, what was sent, and the answer). Read-only and local.",
    properties: {
      operation: { type: "string", enum: ["list", "read"] },
      id: { type: "string", description: "Session id for read." },
    },
    required: ["operation"],
  },
].map((tool) => ({
  type: "function",
  function: {
    name: `${PREFIX}${tool.name}`,
    description: tool.description,
    parameters: { type: "object", properties: tool.properties, required: tool.required, additionalProperties: false },
  },
}));

class OracleTools implements McpTools {
  constructor(private readonly cfg: NekoConfig, private readonly root: string) {}

  toolSchemas(): any[] { return SCHEMAS; }
  has(name: string): boolean { return SCHEMAS.some((schema) => schema.function.name === name); }
  permission(name: string): "safe" | "gated" { return name === `${PREFIX}sessions` ? "safe" : "gated"; }
  indexBlock(): string {
    const profile = this.cfg.oracle.profile;
    return profile
      ? `Neko Oracle asks a separate stronger model (profile '${profile}') for a second opinion on a curated bundle of files. It cannot act - it advises. Consulting is gated because the files leave this machine; reading past consultations is safe.`
      : "Neko Oracle (second opinion from a stronger model) is present but not configured; consulting it will report how to turn it on.";
  }

  async call(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<string> {
    const action = name.slice(PREFIX.length);
    try {
      if (action === "sessions") return this.sessions(args);
      if (action === "consult") return await this.consult(args, signal);
      return `Error: unknown oracle tool ${name}`;
    } catch (error) {
      // SAFETY: contract of the Error type is established by the surrounding validation/boundary.
      return `Error: ${(error as Error).message}`;
    }
  }

  private sessions(args: Record<string, any>): string {
    const operation = String(args.operation ?? "");
    if (operation === "list") {
      const sessions = listOracleSessions();
      if (!sessions.length) return "No oracle consultations yet.";
      return sessions
        .slice(0, 20)
        .map((session) => `${session.id}  ${session.createdAt.slice(0, 16).replace("T", " ")}  ${session.profile}/${session.model}  ${session.files.length} file(s)\n  ${session.question.replace(/\s+/g, " ").slice(0, 160)}`)
        .join("\n");
    }
    if (operation === "read") {
      const session = readOracleSession(String(args.id ?? ""));
      if (!session) return `Error: no oracle session '${args.id ?? ""}'`;
      return [
        `Session ${session.meta.id} - ${session.meta.profile}/${session.meta.model}`,
        `Files sent: ${session.meta.files.join(", ") || "(none)"}`,
        "",
        `Question: ${session.meta.question}`,
        "",
        session.answer,
      ].join("\n");
    }
    return "Error: operation must be 'list' or 'read'";
  }

  private async consult(args: Record<string, any>, signal?: AbortSignal): Promise<string> {
    const oracle = resolveOracle(this.cfg);
    const files = Array.isArray(args.files) ? args.files.map(String).filter(Boolean) : [];
    const consultation = await consultOracle(oracle.provider, { profile: oracle.profile, model: oracle.model }, {
      root: this.root,
      question: String(args.question ?? ""),
      files,
      limits: oracle.limits,
      followup: args.followup ? String(args.followup) : undefined,
      signal,
    });
    return [
      `Oracle ${consultation.profile}/${consultation.model} - session ${consultation.id}`,
      describeBundle(consultation.bundle),
      "",
      consultation.answer,
      "",
      "This is advice from a model that cannot see the rest of your machine. Verify its claims against the",
      `real files before acting; continue the thread with followup: "${consultation.id}".`,
    ].join("\n");
  }
}

export function createOracleTools(cfg: NekoConfig, root: string): McpTools { return new OracleTools(cfg, root); }

export function withOracleTools(source: McpTools | undefined, cfg: NekoConfig, root: string): McpTools {
  return composeMcpTools(source, createOracleTools(cfg, root))!;
}
