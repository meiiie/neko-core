import { expect, test } from "bun:test";
import * as acp from "@agentclientprotocol/sdk";
import { render } from "ink-testing-library";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../src/core/agent.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import { parseDreamInput } from "../src/core/dream.ts";
import type { Provider } from "../src/core/ports.ts";
import { loadConfig } from "../src/adapters/config.ts";
import { createNekoAcpAgent } from "../src/adapters/acp.ts";
import { ChatApp } from "../src/ui/chat.tsx";

function dreamProvider(called: () => void): Provider {
  return { complete: async (messages, tools) => {
    called(); expect(tools).toEqual([]);
    const input = parseDreamInput(JSON.parse(String(messages[1].content)));
    const source = input.sources.find(item => item.kind === "user" && item.text.includes("Use bun to run tests."))!;
    return { content: JSON.stringify({ summary: "Tests", claims: [{ title: "Use Bun", text: "Use bun to run tests.", status: "observed", citations: [{ sourceId: source.id, quote: "Use bun to run tests." }], corrects: [], related: [] }] }), tool_calls: [] };
  } };
}
const tick = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check: () => boolean) => { for (let i = 0; i < 160 && !check(); i++) await tick(); return check(); };

test("TUI default auto Dream completes without /task or prepare/apply and is recalled next turn", async () => {
  const home = mkdtempSync(join(tmpdir(), "auto-dream-ui-")), root = join(home, "root");
  mkdirSync(root); mkdirSync(join(home, ".neko-core"));
  writeFileSync(join(home, ".neko-core/config.json"), JSON.stringify({ auto_update: false, auto_update_check: false, verify_before_exit: false, completion_sound: false }));
  const old = { home: process.env.HOME, profile: process.env.USERPROFILE, root: process.cwd() };
  process.env.HOME = home; process.env.USERPROFILE = home; process.chdir(root);
  let dreams = 0; const contexts: string[] = [];
  const provider: Provider = { complete: async messages => { contexts.push(JSON.stringify(messages)); return { content: "Noted.", tool_calls: [] }; } };
  const app = render(<ChatApp yolo={false} fullscreen={false} profile="local" provider={provider} automaticDreamProvider={() => dreamProvider(() => dreams++)} />);
  try {
    await tick(50); app.stdin.write("Use bun to run tests."); await tick(); app.stdin.write("\r");
    expect(await until(() => (app.lastFrame() ?? "").includes("Dream: applied"))).toBe(true);
    expect(dreams).toBe(1);
    app.stdin.write("What do you remember?"); await tick(); app.stdin.write("\r");
    expect(await until(() => contexts.some(text => text.includes("Dreamed task memory")))).toBe(true);
    await until(() => dreams === 2); await tick(50);
  } finally {
    app.unmount(); await tick(50);
    process.chdir(old.root);
    if (old.home === undefined) delete process.env.HOME; else process.env.HOME = old.home;
    if (old.profile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = old.profile;
    rmSync(home, { recursive: true, force: true });
  }
});

test("ACP standard session host runs default automatic Dream; injected runtime opts in explicitly", async () => {
  const home = mkdtempSync(join(tmpdir(), "auto-dream-acp-")), root = join(home, "root"); mkdirSync(root);
  let calls = 0; const updates: string[] = [];
  const cfg = loadConfig({ home, cwd: root });
  const app = createNekoAcpAgent({ config: cfg,
    automaticDreamProvider: () => dreamProvider(() => calls++),
    buildRuntime: async (config, options) => {
      const registry = new ToolRegistry(root, options.mode, options.approval); registry.memoryHome = home;
      registry.sandboxBash = config.sandbox; registry.computerInputPolicy = config.computerUseInputPolicy;
      if (options.computer === false) registry.disabled.add("computer");
      if (options.taskScope) registry.bindTaskScope(options.taskScope);
      const agent = new Agent({ provider: { complete: async () => ({ content: "Noted.", tool_calls: [] }) }, tools: registry,
        onCheckpoint: options.onCheckpoint, onEvent: options.onEvent, verifyBeforeExit: false, verifyStateChangesBeforeExit: false });
      return { config, registry, agent, close: async () => {} };
    } });
  try {
    await acp.client({ name: "auto-dream-client" }).onNotification(acp.methods.client.session.update, ({ params }) => { updates.push(JSON.stringify(params)); }).connectWith(app, async ctx => {
      await ctx.request(acp.methods.agent.initialize, { protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const created = await ctx.request(acp.methods.agent.session.new, { cwd: root, mcpServers: [] });
      const result = await ctx.request(acp.methods.agent.session.prompt, { sessionId: created.sessionId, prompt: [{ type: "text", text: "Use bun to run tests." }] });
      expect(result.stopReason).toBe("end_turn"); expect(calls).toBe(1);
      expect(updates.some(text => text.includes("Dream: applied"))).toBe(true);
      await ctx.request(acp.methods.agent.session.close, { sessionId: created.sessionId });
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
