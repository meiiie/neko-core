/** Explicit browser identities. These configure an MCP backend, not a live connection or a sandbox. */
import { join } from "node:path";
import type { McpServerConfig } from "./mcp.ts";

export const CHROME_MCP_PACKAGE = "chrome-devtools-mcp@1.13.0";
export const PLAYWRIGHT_MCP_PACKAGE = "@playwright/mcp@0.0.85";
export type BrowserMode = "managed" | "personal" | "persistent" | "attach" | "isolated";
export const BROWSER_MODES = "managed | personal | persistent | attach | isolated";

export function browserMode(value: string): BrowserMode | null {
  const mode = (value || "managed").toLowerCase();
  if (mode === "managed" || mode === "personal" || mode === "persistent" || mode === "attach" || mode === "isolated") return mode;
  if (mode === "extension") return "attach";
  if (mode === "sandbox") return "isolated"; // historical alias, not a security claim
  return null;
}

export function browserBackend(mode: BrowserMode, runner: "bunx" | "npx", configDir: string): McpServerConfig {
  const modern = mode === "managed" || mode === "personal";
  const args = modern
    ? [CHROME_MCP_PACKAGE, "--page-id-routing", "--no-usage-statistics", "--no-performance-crux",
      "--no-javascript-evaluation", "--no-file-navigations", "--no-category-network",
      "--no-category-memory", "--no-category-performance",
      "--redact-network-headers",
      ...(mode === "personal" ? ["--autoConnect"] : [`--user-data-dir=${join(configDir, "browser", "managed")}`])]
    : mode === "attach" ? [PLAYWRIGHT_MCP_PACKAGE, "--extension"]
    : mode === "isolated" ? [PLAYWRIGHT_MCP_PACKAGE, "--isolated", "--browser", "chrome"]
    : [PLAYWRIGHT_MCP_PACKAGE, "--browser", "chrome", "--user-data-dir", join(configDir, "browser", "default")];
  const config: McpServerConfig = { command: runner, args: runner === "npx" ? ["-y", ...args] : args };
  if (modern) config.env = { CHROME_DEVTOOLS_MCP_NO_CONFIG_DISCOVERY: "1", CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: "1" };
  return config;
}
