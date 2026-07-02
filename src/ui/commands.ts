/**
 * Slash-command handling for the REPL, separated from the React component. Each command acts
 * on the REPL through CommandCtx (the command API surface), so chat.tsx stays the lifecycle +
 * render, and this file owns "what the commands do".
 */
import type { Agent } from "../core/agent.ts";
import { loadConfig, type NekoConfig } from "../adapters/config.ts";
import { rememberNote, renderContext } from "../adapters/context.ts";
import { initProject } from "../adapters/project.ts";
import { getProvider, listModels } from "../adapters/providers.ts";
import { setActiveProfile, setEffort, setModel } from "../adapters/project.ts";
import { fillRecipe, listRecipes, loadRecipe } from "../adapters/recipes.ts";
import { listSessions, loadSession, renameSession, sessionTitle, type Session } from "../adapters/session.ts";
import { listSkills, loadSkill } from "../adapters/skills.ts";
import type { ToolRegistry } from "../core/tool-runtime.ts";
import { listTools } from "../core/tools.ts";
import { fmtBytes, relativeTime, trunc } from "./format.ts";
import type { Overlay } from "./select-list.tsx";
import type { Line, LineKind } from "./transcript.tsx";

export const HELP = [
  "Commands:",
  "  /help /cost /model /provider /tools /skill(s) /init /clear /compact /reset /exit",
  "  /goal <text> · /loop <n> <task> · /auto <goal> · /sessions · /resume · /effort · /context",
  "  /mcp · /mcp-prompt · /recipe(s) · /memory · /remember · /paste · /rc · /login · /logout",
  "Input: @path adds a file; end a line with \\ for multiline; # saves a memory note.",
  "Editing: Left/Right move the cursor, Ctrl+A/Ctrl+E start/end, Ctrl+W delete word, Ctrl+U clear line.",
  "Keys: Shift+Tab cycle mode · Up/Down history · Alt+V paste image · Ctrl+O expand · Ctrl+B bash to background · Ctrl+L clear.",
  "Esc: clear input (idle) or interrupt a running turn. Ctrl+C: clear input, then again to quit.",
].join("\n");

export const SLASH: { name: string; desc: string }[] = [
  { name: "/help", desc: "show help" },
  { name: "/cost", desc: "token usage this session" },
  { name: "/model", desc: "show / list / switch model (/model list · /model <id>)" },
  { name: "/provider", desc: "switch provider (account) then pick its model - picker or /provider <name>" },
  { name: "/tools", desc: "list / toggle tools (/tools bash)" },
  { name: "/skill", desc: "load a skill (/skill name) · /skills to list" },
  { name: "/init", desc: "scaffold ./.neko-core/config.json" },
  { name: "/clear", desc: "clear transcript + context" },
  { name: "/compact", desc: "summarize the conversation to free context" },
  { name: "/goal", desc: "set an ongoing goal (/goal <text>)" },
  { name: "/loop", desc: "run a task N times (/loop <n> <task>)" },
  { name: "/auto", desc: "closed loop: work + self-review until done (/auto <goal>)" },
  { name: "/sessions", desc: "list saved sessions here" },
  { name: "/resume", desc: "resume a session (/resume [id])" },
  { name: "/effort", desc: "reasoning effort (/effort low|medium|high|off)" },
  { name: "/context", desc: "context window usage" },
  { name: "/memory", desc: "show NEKO.md memory/context files" },
  { name: "/remember", desc: "save a note to NEKO.md (or start a line with #)" },
  { name: "/recipe", desc: "run a saved recipe (/recipe <name> [args])" },
  { name: "/recipes", desc: "list saved recipes" },
  { name: "/mcp", desc: "list connected MCP tools + prompts" },
  { name: "/mcp-prompt", desc: "run an MCP prompt (/mcp-prompt <server> <name> [k=v])" },
  { name: "/paste", desc: "attach an image from the clipboard (or Alt+V)" },
  { name: "/fullscreen", desc: "scroll mode: read back while it streams (PageUp/PageDown · Home/End) · alias /fs" },
  { name: "/remote-control", desc: "toggle a local HTTP control server (/rc) - drive Neko from elsewhere" },
  { name: "/relay", desc: "/relay <url> - drive Neko from any phone via your relay (no open port)" },
  { name: "/login", desc: "enter + save your API key" },
  { name: "/logout", desc: "remove the saved API key" },
  { name: "/rewind", desc: "undo the last turn (restore context + revert this turn's file edits)" },
  { name: "/bashes", desc: "list background bash tasks (Ctrl+B to background a running one)" },
  { name: "/reset", desc: "reset conversation context" },
  { name: "/exit", desc: "quit" },
];

/** What a command may do to the REPL. */
export interface CommandCtx {
  cfg: NekoConfig;
  agent: Agent;
  registry: ToolRegistry;
  busy: boolean;
  queue: string[];
  addLine: (kind: LineKind, text: string) => void;
  setLines: (lines: Line[]) => void;
  nextId: () => number;
  setOverlay: (o: Overlay | null) => void;
  setBusy: (b: boolean) => void;
  setQueued: (n: number) => void;
  resumeInto: (s: Session) => void;
  runText: (text: string) => void;
  exit: () => void;
}

/** Open the resume picker for a scope; Ctrl+A flips between this project and all projects. */
function openResumePicker(ctx: CommandCtx, scope: "cwd" | "all"): void {
  const all = listSessions();
  const list = scope === "cwd" ? all.filter((s) => s.cwd === process.cwd()) : all;
  if (!list.length) return ctx.addLine("info", "no saved sessions here - Ctrl+A shows all projects");
  ctx.setOverlay({
    title: scope === "all" ? "Resume session (all projects)" : "Resume session",
    ctrlAHint: scope === "all" ? "this project" : "all projects",
    onCtrlA: () => openResumePicker(ctx, scope === "cwd" ? "all" : "cwd"),
    onRename: (it, name) => {
      renameSession(it.id, name);
      openResumePicker(ctx, scope); // refresh the list with the new title
    },
    items: list.map((s) => ({
      id: s.id,
      label: sessionTitle(s),
      detail: `${relativeTime(s.updatedAt)} · ${s.messages.length} msgs` +
        (s.branch ? ` · ${s.branch}` : "") + (s.bytes ? ` · ${fmtBytes(s.bytes)}` : "") +
        (scope === "all" ? ` · ${s.cwd.replace(/\\/g, "/").split("/").pop()}` : ""),
      preview: s.messages
        .filter((m: any) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-4)
        .map((m: any) => (m.role === "user" ? "> " : "  ") + trunc(String(m.content), 100))
        .join("\n"),
    })),
    onSelect: (it) => {
      ctx.setOverlay(null);
      const target = loadSession(it.id);
      if (target) ctx.resumeInto(target);
    },
  });
}

/** Switch the active provider profile LIVE: persist it as the default (no --profile flag, no config edit),
 * rebuild the provider (new endpoint + key + model), swap it into the running agent, and adopt the settings
 * into the in-session cfg. Returns true when the new provider HAS a key (so the caller may chain the model
 * picker); false when it errored or the provider still needs /login. */
function switchProfile(ctx: CommandCtx, name: string): boolean {
  const { cfg, agent, addLine } = ctx;
  if (!cfg.profiles[name]) {
    addLine("error", `no provider "${name}". Known: ${Object.keys(cfg.profiles).sort().join(", ")}`);
    return false;
  }
  setActiveProfile(name); // persist as default for next session too
  cfg.adopt(loadConfig({ profile: name })); // in-session cfg now = the new provider (endpoint+model+key)
  agent.setProvider(getProvider(cfg)); // the running agent calls the new endpoint from the next turn
  addLine("info", `provider -> ${name}  (${cfg.provider} · ${cfg.model})`);
  if (!cfg.apiKey) {
    addLine("info", `note: provider "${name}" has no API key yet - type /login to add it (it saves to this provider).`);
    return false;
  }
  return true;
}

/** Open the model picker for the CURRENT provider (lists that endpoint's models; selecting persists it). */
async function openModelPicker(ctx: CommandCtx): Promise<void> {
  const { cfg, addLine } = ctx;
  ctx.setBusy(true);
  try {
    const models = await listModels(cfg);
    ctx.setBusy(false);
    if (!models.length) return addLine("info", "no models returned by this provider");
    ctx.setOverlay({
      title: `Select model  (${cfg.profile ?? cfg.provider})`,
      items: models.map((m) => ({ id: m, label: m, detail: m === cfg.model ? "(current)" : undefined })),
      onSelect: (it) => {
        ctx.setOverlay(null);
        cfg.data.model = it.id;
        setModel(it.id); // persist across sessions
        addLine("info", `model -> ${it.id}`);
      },
    });
  } catch (error) {
    ctx.setBusy(false);
    addLine("error", `listing models: ${error instanceof Error ? error.message : error}`);
  }
}

/** Provider picker (account first). On select, switch to it and CHAIN straight into its model picker, so the
 * flow is one smooth "pick account -> pick its model" — provider stays the primary axis (it's the account /
 * quota that costs money), and the same model name on two providers never gets confused. */
function openProviderPicker(ctx: CommandCtx): void {
  const { cfg } = ctx;
  const names = Object.keys(cfg.profiles).sort();
  ctx.setOverlay({
    title: "Select provider (account) - then pick its model",
    items: names.map((n) => {
      const p: any = cfg.profiles[n] ?? {};
      const cur = n === cfg.profile ? "  (current)" : "";
      return { id: n, label: n, detail: `${p.provider ?? "?"} · ${p.model ?? "?"}${cur}` };
    }),
    onSelect: async (it) => {
      ctx.setOverlay(null);
      if (switchProfile(ctx, it.id)) await openModelPicker(ctx); // account -> its model, one flow
    },
  });
}

/** Run a "/..." command. Returns when done; the caller returns from its turn afterwards. */
export async function runSlashCommand(input: string, ctx: CommandCtx): Promise<void> {
  const { cfg, agent, addLine } = ctx;
  const cmd = input.split(/\s+/)[0];
  switch (cmd) {
    case "/exit":
    case "/quit":
      return ctx.exit();
    case "/help":
      return addLine("info", HELP);
    case "/cost":
      return addLine("info", agent.cost.summary());
    case "/model": {
      const arg = input.slice("/model".length).trim();
      if (arg && arg !== "list") {
        cfg.data.model = arg;
        setModel(arg); // remember it for the next session/folder too
        return addLine("info", `model -> ${arg}`);
      }
      await openModelPicker(ctx); // model of the CURRENT provider (quick swap without changing account)
      return;
    }
    case "/provider":
    case "/providers":
    case "/profiles": {
      const arg = input.slice(cmd.length).trim();
      if (arg === "list") return addLine("info", "providers: " + Object.keys(cfg.profiles).sort().join(", "));
      if (arg) { switchProfile(ctx, arg); return; } // /provider zai  -> switch directly (no model picker)
      openProviderPicker(ctx); // /provider  -> guided picker: account -> its model
      return;
    }
    case "/tools": {
      const reg = ctx.registry;
      const arg = input.split(/\s+/)[1];
      if (arg) {
        if (reg.disabled.has(arg)) reg.disabled.delete(arg);
        else reg.disabled.add(arg);
        return addLine("info", `${arg} -> ${reg.disabled.has(arg) ? "off" : "on"}`);
      }
      return addLine("info", "tools: " + listTools().map((t) => `${t.name}[${reg.disabled.has(t.name) ? "off" : "on"}]`).join("  "));
    }
    case "/init":
      return addLine("info", initProject());
    case "/skills":
      return addLine("info", "skills: " + (listSkills().map((s) => s.name).join(", ") || "(none in ~/.neko-core/skills)"));
    case "/skill": {
      const name = input.split(/\s+/)[1];
      if (!name) return addLine("info", "usage: /skill <name>  ·  /skills to list");
      const skill = loadSkill(name);
      if (!skill) return addLine("info", `unknown skill '${name}' - /skills to list`);
      agent.appendSystem(`# Skill: ${skill.name}\n${skill.body}`);
      return addLine("info", `loaded skill: ${skill.name}`);
    }
    case "/clear":
      agent.messages = [];
      return ctx.setLines([{ id: ctx.nextId(), kind: "info", text: "(cleared)" }]);
    case "/rewind": {
      const undone = agent.rewind();
      const files = ctx.registry.restoreCheckpoint();
      if (!undone && !files) return addLine("info", "nothing to rewind");
      return addLine("info", `(rewound last turn - context restored${files ? `, ${files} file(s) reverted` : ""})`);
    }
    case "/bashes": {
      const bg = ctx.registry.backgrounds;
      if (!bg.length) return addLine("info", "no background tasks (Ctrl+B moves a running bash to the background)");
      for (const b of bg) addLine("info", `[${b.id}] ${b.done ? `done (exit ${b.code ?? "?"})` : "running"}: ${b.command}\n${b.output.slice(-800) || "(no output yet)"}`);
      return;
    }
    case "/goal": {
      const goal = input.slice("/goal".length).trim();
      if (!goal) return addLine("info", "usage: /goal <text>  (keeps the agent focused on a goal)");
      agent.appendSystem(`Ongoing goal (keep working toward it every turn): ${goal}`);
      return addLine("info", `goal set: ${goal}`);
    }
    case "/loop": {
      const m = input.match(/^\/loop\s+(\d+)\s+([\s\S]+)$/);
      if (!m) return addLine("info", "usage: /loop <count> <task>  (runs the task N times)");
      const n = Math.min(20, Math.max(1, parseInt(m[1], 10)));
      const task = m[2].trim();
      for (let i = 0; i < n; i++) ctx.queue.push(task);
      ctx.setQueued(ctx.queue.length);
      addLine("info", `looping '${trunc(task, 60)}' x${n}`);
      if (!ctx.busy) {
        const first = ctx.queue.shift();
        ctx.setQueued(ctx.queue.length);
        if (first !== undefined) ctx.runText(first);
      }
      return;
    }
    case "/compact":
      ctx.setBusy(true);
      try {
        await agent.compact();
        addLine("info", "(context compacted)");
      } catch (error) {
        addLine("error", `${error instanceof Error ? error.message : error}`);
      } finally {
        ctx.setBusy(false);
      }
      return;
    case "/reset":
      agent.messages = [];
      return addLine("info", "(conversation reset)");
    case "/sessions": {
      const mine = listSessions().filter((s) => s.cwd === process.cwd());
      return addLine(
        "info",
        mine.length
          ? "sessions (newest first):\n" + mine.slice(0, 10).map((s) => `  ${s.id}  "${sessionTitle(s)}"`).join("\n")
          : "no saved sessions for this directory",
      );
    }
    case "/resume": {
      const arg = input.split(/\s+/)[1];
      if (arg) {
        const target = loadSession(arg);
        if (!target) addLine("info", `no session '${arg}'`);
        else ctx.resumeInto(target);
        return;
      }
      if (!listSessions().length) return addLine("info", "no saved sessions yet");
      return openResumePicker(ctx, "cwd");
    }
    case "/effort": {
      const arg = input.split(/\s+/)[1]?.toLowerCase();
      const apply = (lvl: string) => {
        if (lvl === "off") delete cfg.data.reasoning_effort;
        else cfg.data.reasoning_effort = lvl;
        setEffort(lvl); // persist across sessions
        addLine("info", `effort -> ${cfg.effort || "off"}`);
      };
      if (arg) return apply(arg); // /effort high
      // No arg -> interactive picker (Faster -> Smarter), Claude-style.
      const levels = ["off", "low", "medium", "high", "xhigh", "max"];
      ctx.setOverlay({
        title: "Reasoning effort  (Faster -> Smarter)",
        items: levels.map((l) => ({ id: l, label: l, detail: l === (cfg.effort || "off") ? "(current)" : undefined })),
        onSelect: (it) => {
          ctx.setOverlay(null);
          apply(it.id);
        },
      });
      return;
    }
    case "/context": {
      const win = cfg.contextWindow;
      const used = agent.cost.lastPrompt;
      const pct = Math.min(100, Math.max(0, Math.round((100 * used) / win)));
      return addLine(
        "info",
        `context: ${used} / ${win} tokens used (${pct}%; auto-compacts past 85%) · last turn ${agent.cost.lastPrompt} in / ${agent.cost.lastCompletion} out`,
      );
    }
    case "/remember": {
      const rest = input.slice("/remember".length).trim();
      const userScope = rest.startsWith("--user");
      const note = userScope ? rest.slice("--user".length).trim() : rest;
      if (!note) return addLine("info", "usage: /remember [--user] <note>   (or just start a line with #)");
      return addLine("info", rememberNote(note, userScope ? "user" : "project"));
    }
    case "/memory":
      return addLine("info", renderContext() + "\n(edit NEKO.md for project memory, ~/.neko-core/NEKO.md for global; or use /remember / #note)");
    case "/mcp": {
      const mcp = ctx.registry.mcp;
      if (!mcp) return addLine("info", "no MCP servers connected (configure mcp_servers / neko mcp add)");
      const tools = mcp.toolSchemas().map((s: any) => s.function.name);
      const prompts = mcp.promptList?.() ?? [];
      return addLine(
        "info",
        `MCP tools: ${tools.join(", ") || "(none)"}\nMCP prompts: ${prompts.map((p) => `${p.server}:${p.name}`).join(", ") || "(none)"}`,
      );
    }
    case "/mcp-prompt": {
      const [, server, name, ...rest] = input.split(/\s+/);
      const mcp = ctx.registry.mcp;
      if (!server || !name) return addLine("info", "usage: /mcp-prompt <server> <name> [key=val ...]  ·  /mcp to list");
      if (!mcp?.getPrompt) return addLine("info", "no MCP prompts available");
      const promptArgs: Record<string, string> = {};
      for (const kv of rest) {
        const i = kv.indexOf("=");
        if (i > 0) promptArgs[kv.slice(0, i)] = kv.slice(i + 1);
      }
      addLine("info", `running MCP prompt ${server}:${name}`);
      ctx.runText(await mcp.getPrompt(server, name, promptArgs));
      return;
    }
    case "/recipes":
      return addLine("info", "recipes: " + (listRecipes().map((r) => r.name).join(", ") || "(none in ~/.neko-core/recipes)"));
    case "/recipe": {
      const rest = input.slice("/recipe".length).trim();
      const name = rest.split(/\s+/)[0];
      if (!name) return addLine("info", "usage: /recipe <name> [args]  ·  /recipes to list");
      const r = loadRecipe(name);
      if (!r) return addLine("info", `unknown recipe '${name}' - /recipes to list`);
      addLine("info", `running recipe: ${name}`);
      ctx.runText(fillRecipe(r.body, rest.slice(name.length).trim())); // runs as a turn
      return;
    }
    default:
      return addLine("info", `unknown command ${cmd} - try /help`);
  }
}
