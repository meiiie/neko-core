import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runAcpServer } from "../../src/adapters/acp.ts";
import { loadConfig } from "../../src/adapters/config.ts";
import { setSessionsDir } from "../../src/adapters/session.ts";
import { Agent } from "../../src/core/agent.ts";
import type { Provider } from "../../src/core/ports.ts";
import { ToolRegistry } from "../../src/core/tool-runtime.ts";

const root = process.env.NEKO_TEST_ACP_ROOT!;
const store = process.env.NEKO_TEST_ACP_STORE!;
const home = process.env.NEKO_TEST_ACP_HOME!;
const mode = process.env.NEKO_TEST_ACP_CHILD_MODE;
if (!root || !store || !home || !new Set(["mutate", "resume"]).has(String(mode))) process.exit(64);

setSessionsDir(store);
const cfg = loadConfig({ cwd: root, home });
cfg.data.mode = "auto";

const provider: Provider = mode === "mutate"
  ? {
      complete: async () => ({
        content: null,
        tool_calls: [{
          id: "mutation-once",
          name: "write_file",
          arguments: { path: "mutation.txt", content: "must run once" },
        }],
      }),
    }
  : {
      complete: async (messages) => {
        writeFileSync(join(root, "resumed-messages.json"), JSON.stringify(messages), "utf8");
        return { content: "resumed after inspecting unknown outcome", tool_calls: [] };
      },
    };

await runAcpServer({
  config: cfg,
  buildRuntime: async (runtimeConfig, options) => {
    const registry = new ToolRegistry(options.root, options.mode, options.approval);
    if (mode === "mutate") {
      registry.execute = async (name) => {
        if (name !== "write_file") return "unexpected tool";
        appendFileSync(join(root, "mutation-count.txt"), "x", "utf8");
        writeFileSync(join(root, "mutation-started"), "ready", "utf8");
        return await new Promise<string>(() => {});
      };
    }
    return {
      agent: new Agent({
        provider,
        tools: registry,
        maxSteps: 3,
        onCheckpoint: options.onCheckpoint,
        onDelta: options.onDelta,
        onEvent: options.onEvent,
        verifyBeforeExit: false,
        verifyStateChangesBeforeExit: false,
      }),
      registry,
      config: runtimeConfig,
      close: async () => {},
    };
  },
});
