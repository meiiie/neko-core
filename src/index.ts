/**
 * Public Bun/TypeScript library surface for Neko Core.
 *
 * Keep this entrypoint intentionally small: hosts provide adapters through the
 * core ports, while CLI, UI, configuration, credentials, and provider adapters
 * remain private implementation details.
 */
export { Agent } from "./core/agent.ts";
export type {
  AgentCompletionStatus,
  AgentOptions,
  EventHook,
  ImageAttachment,
  NumberedImageAttachment,
} from "./core/agent.ts";

export { CostTracker } from "./core/cost.ts";
export type { Usage } from "./core/cost.ts";

export type {
  CompleteOptions,
  DeltaHook,
  McpTools,
  Provider,
  ProviderResponse,
  ToolCall,
  WebPort,
} from "./core/ports.ts";

export { ToolRegistry, autoApprove, denyAll } from "./core/tool-runtime.ts";
export type { ApprovalGate } from "./core/tool-runtime.ts";
export type { PermissionMode } from "./core/permissions.ts";

export {
  GATED,
  SAFE,
  TOOL_SPECS,
  describeToolCall,
  listTools,
  toolSchemas,
} from "./core/tools.ts";
export type { ToolSpec } from "./core/tools.ts";
