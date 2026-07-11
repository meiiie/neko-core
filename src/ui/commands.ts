/**
 * Slash-command handling for the REPL, separated from the React component. Each command acts
 * on the REPL through CommandCtx (the command API surface), so chat.tsx stays the lifecycle +
 * render, and this file owns "what the commands do".
 */
import type { Agent } from "../core/agent.ts";
import { COMPACT_AT } from "../core/agent.ts";
import { loadConfig, type NekoConfig } from "../adapters/config.ts";
import { rememberNote, renderContext } from "../adapters/context.ts";
import { initProject } from "../adapters/project.ts";
import { getProvider, listModelOptions, type ModelOption } from "../adapters/providers.ts";
import { setActiveProfile, setEffort, setModel } from "../adapters/project.ts";
import { fillRecipe, listRecipes, loadRecipe } from "../adapters/recipes.ts";
import { listSessionMetas, loadSession, renameSession, sessionTitle, type Session } from "../adapters/session.ts";
import { listSkills, loadSkill } from "../adapters/skills.ts";
import type { ToolRegistry } from "../core/tool-runtime.ts";
import { listTools } from "../core/tools.ts";
import { fmtBytes, relativeTime, trunc } from "./format.ts";
import type { Overlay } from "./select-list.tsx";
import type { Line, LineKind } from "./transcript.tsx";
import { hasChatGptCredentials } from "../adapters/chatgpt-auth.ts";
import { authChoices, profileDisplayName, providerChoices } from "../adapters/provider-choice.ts";
import { getChatGptUsage, resolveChatGptEffort, type ChatGptUsageReport, type ChatGptUsageWindow } from "../adapters/chatgpt-provider.ts";
import { discoverCodexSupport } from "../adapters/codex-app-server.ts";
import { installCodexSupportPack, readCodexSupportPack, removeCodexSupportPack } from "../adapters/codex-support-pack.ts";

export const HELP = [
  "Commands:",
  "  /help /cost /usage /model /provider /support /tools /skill(s) /init /clear /compact /transcript /reset /exit",
  "  /goal <text> · /loop <n> <task> · /auto <goal> · /sessions · /resume · /continue · /retry · /effort · /context",
  "  /mcp · /mcp-prompt · /recipe(s) · /memory · /remember · /paste · /rc · /login · /logout",
  "Input: @path adds a file; end a line with \\ for multiline; # saves a memory note.",
    "Editing: Left/Right move the cursor, Ctrl+A/Ctrl+E start/end, Ctrl+W delete word, Ctrl+U clear line, Ctrl+G external editor.",
    "Keys: Shift+Tab cycle mode · Up/Down history · Alt+C copy draft · Alt+V paste image · Ctrl+O expand · Ctrl+B bash to background · Ctrl+L clear.",
    "Esc: clear input (idle) or interrupt a running turn. Ctrl+C: clear input, then again to quit.",
    "Caret: set caret_glyph (bar/block/underline/thin-block) or NEKO_CARET if the cursor glyph looks offset.",
].join("\n");

export const SLASH: { name: string; desc: string }[] = [
  { name: "/help", desc: "show help" },
  { name: "/cost", desc: "token usage this session" },
  { name: "/usage", desc: "ChatGPT plan quota, reset windows, and credits" },
  { name: "/model", desc: "show / list / switch model (/model list · /model <id>)" },
  { name: "/provider", desc: "switch provider (account) then pick its model - picker or /provider <name>" },
  { name: "/support", desc: "GPT-5.6 bridge status/install/remove (optional; other models do not need it)" },
  { name: "/tools", desc: "list / toggle tools (/tools bash)" },
  { name: "/skill", desc: "load a skill (/skill name) · /skills to list" },
  { name: "/init", desc: "scaffold ./.neko-core/config.json" },
  { name: "/clear", desc: "clear transcript + context" },
  { name: "/compact", desc: "summarize the conversation to free context" },
  { name: "/transcript", desc: "scroll + search the full conversation (incl. earlier resumed lines)" },
  { name: "/copy", desc: "copy the last response to the clipboard (/copy all = whole conversation)" },
  { name: "/fps", desc: "UI frame rate: auto-follow your display or set 30..240 (/fps [auto|n])" },
  { name: "/title", desc: "name this session + pin the terminal tab title (/title <name>)" },
  { name: "/goal", desc: "set an ongoing goal (/goal <text>)" },
  { name: "/loop", desc: "run a task N times (/loop <n> <task>)" },
  { name: "/auto", desc: "closed loop: work + self-review until done (/auto <goal>)" },
  { name: "/sessions", desc: "list saved sessions here" },
  { name: "/resume", desc: "resume a session (/resume [id])" },
  { name: "/continue", desc: "pick up an interrupted task where it left off" },
  { name: "/retry", desc: "re-run the last message (e.g. after an error)" },
  { name: "/effort", desc: "model-aware reasoning effort picker (/effort low..ultra|off)" },
  { name: "/context", desc: "context window usage" },
  { name: "/memory", desc: "show NEKO.md memory/context files" },
  { name: "/remember", desc: "save a note to NEKO.md (or start a line with #)" },
  { name: "/recipe", desc: "run a saved recipe (/recipe <name> [args])" },
  { name: "/recipes", desc: "list saved recipes" },
  { name: "/mcp", desc: "list connected MCP tools + prompts" },
  { name: "/mcp-prompt", desc: "run an MCP prompt (/mcp-prompt <server> <name> [k=v])" },
  { name: "/paste", desc: "attach an image from the clipboard (or Alt+V)" },
  { name: "/remote-control", desc: "toggle a local HTTP control server (/rc) - drive Neko from elsewhere" },
  { name: "/relay", desc: "drive multiple Neko sessions from your phone (live + E2E; /relay new rotates)" },
  { name: "/login", desc: "connect ChatGPT or save a provider API key" },
  { name: "/logout", desc: "sign out the active auth route only" },
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
  compact: (reason: "manual" | "auto" | "resume") => Promise<string>; // shows the compacting progress bar
  openTranscript: () => void; // open the full-thread scroll+search viewer (/transcript)
  copy: (arg: string) => void; // copy last response / whole conversation to the clipboard (OSC 52)
  setFps: (choice: number | "auto") => void; // /fps: persist + apply the UI frame rate
  setTitle: (name: string) => void; // /title: name the session + pin the tab title
  exit: () => void;
}

/** Open the resume picker for a scope; Ctrl+A flips between this project and all projects. */
function openResumePicker(ctx: CommandCtx, scope: "cwd" | "all"): void {
  // Metadata only (no full transcript parse) - listing 2860 sessions this way is ~50ms of stat calls
  // vs ~600ms of JSON parsing, which is what made the picker lag ~1s to open.
  const all = listSessionMetas();
  const list = scope === "cwd" ? all.filter((s) => s.cwd === process.cwd()) : all;
  if (!list.length) {
    // This directory has no sessions. If OTHER projects do, open the all-projects picker directly
    // (don't dead-end on a "Ctrl+A" hint when there's no picker on screen to press it on - which read
    // as a freeze). Only when nothing exists anywhere is an info line the right answer.
    if (scope === "cwd" && all.length) return openResumePicker(ctx, "all");
    return ctx.addLine("info", "no saved sessions yet");
  }
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
      detail: `${relativeTime(s.updatedAt)} · ${s.msgCount} msgs` +
        (s.branch ? ` · ${s.branch}` : "") + (s.bytes ? ` · ${fmtBytes(s.bytes)}` : "") +
        (scope === "all" ? ` · ${s.cwd.replace(/\\/g, "/").split("/").pop()}` : ""),
    })),
    // Preview is built LAZILY (Space on the highlighted item) - only THEN is that one transcript loaded.
    getPreview: (it) => {
      const s = loadSession(it.id);
      if (!s) return "(could not load)";
      return s.messages
        .filter((m: any) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-4)
        .map((m: any) => (m.role === "user" ? "> " : "  ") + trunc(String(m.content), 100))
        .join("\n") || "(no text messages)";
    },
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
  agent.setMaxContextTokens(cfg.contextWindow);
  addLine("info", `provider -> ${name}  (${cfg.provider} · ${cfg.model})`);
  if (cfg.usesChatGptAuth && !hasChatGptCredentials()) {
    addLine("info", `note: provider "${name}" needs ChatGPT sign-in - type /login.`);
    return false;
  }
  if (!cfg.usesChatGptAuth && !cfg.apiKey && !cfg.isLocalEndpoint) {
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
    const models = await listModelOptions(cfg);
    ctx.setBusy(false);
    if (!models.length) return addLine("info", "no models returned by this provider");
    ctx.setOverlay({
      title: `Select model  (${profileDisplayName(cfg)})`,
      items: models.map((model) => ({ id: model.id, label: model.label, detail: modelDetail(model, cfg.model) })),
      onSelect: (it) => {
        ctx.setOverlay(null);
        const selected = models.find((model) => model.id === it.id);
        if (selected?.available === false) {
          openCodexInstallPrompt(ctx, selected);
          return;
        }
        if (selected) applyModelSelection(ctx, selected);
      },
    });
  } catch (error) {
    ctx.setBusy(false);
    addLine("error", `listing models: ${error instanceof Error ? error.message : error}`);
  }
}

function applyModelSelection(ctx: CommandCtx, selected: ModelOption): void {
  const { cfg, addLine } = ctx;
  cfg.data.model = selected.id;
  if (selected.contextWindow) cfg.data.model_context = { ...(cfg.data.model_context ?? {}), [selected.id]: selected.contextWindow };
  if (typeof selected.vision === "boolean") cfg.data.vision = selected.vision;
  setModel(selected.id, cfg.profile, selected.contextWindow, selected.vision);
  ctx.agent.setMaxContextTokens(cfg.contextWindow);
  const before = cfg.effort;
  const resolved = resolveChatGptEffort(before, selected);
  if (before && before !== "off" && resolved !== before) {
    cfg.data.reasoning_effort = resolved;
    setEffort(resolved);
    addLine("info", `model -> ${selected.id}; effort ${before} -> ${resolved} (highest supported)`);
  } else {
    const defaultNote = !before && selected.defaultEffort ? `; default effort ${selected.defaultEffort}` : "";
    addLine("info", `model -> ${selected.id}${defaultNote}`);
  }
}

function openCodexInstallPrompt(ctx: CommandCtx, selected: ModelOption): void {
  ctx.setOverlay({
    title: `${selected.id} needs the optional GPT-5.6 Support Pack. GPT-5.5/API/Ollama are unchanged.`,
    items: [
      { id: "install", label: "Install support pack", detail: "official OpenAI App Server; about 95 MiB download / 270 MiB disk" },
      { id: "cancel", label: "Not now", detail: "keep the current model; download nothing" },
    ],
    onSelect: (choice) => {
      ctx.setOverlay(null);
      if (choice.id !== "install") return ctx.addLine("info", "Support Pack installation cancelled; current model unchanged.");
      ctx.setBusy(true);
      void installCodexSupportPack({ notify: (message) => ctx.addLine("info", message) })
        .then(() => applyModelSelection(ctx, { ...selected, available: true }))
        .catch((error) => ctx.addLine("error", `installing GPT-5.6 support: ${error instanceof Error ? error.message : error}`))
        .finally(() => ctx.setBusy(false));
    },
  });
}

function modelDetail(model: ModelOption, current: string): string {
  const parts: string[] = [];
  if (model.id === current) parts.push("current");
  if (model.description) parts.push(model.description);
  if (model.defaultEffort) parts.push(`default ${model.defaultEffort}`);
  if (model.efforts?.length) parts.push(`effort ${model.efforts.map((level) => level.effort).join("/")}`);
  if (model.contextWindow) parts.push(`${Math.round(model.contextWindow / 1000)}k ctx`);
  if (model.requiresCodexSupport) parts.push(model.available === false ? "support pack required" : "Codex bridge ready");
  return parts.join(" - ");
}

export function formatChatGptUsage(report: ChatGptUsageReport, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const lines = [`ChatGPT usage (${report.planType || "unknown"})`];
  for (const [index, limit] of report.limits.entries()) {
    if (index > 0) lines.push(`${limit.name}:`);
    const prefix = index === 0 ? "" : "  ";
    if (limit.primary) lines.push(`${prefix}${formatUsageWindow(limit.primary, nowSeconds)}${limit.limitReached || !limit.allowed ? " - LIMIT REACHED" : ""}`);
    if (limit.secondary) lines.push(`${prefix}${formatUsageWindow(limit.secondary, nowSeconds)}`);
  }
  if (report.credits) {
    const value = report.credits.unlimited ? "unlimited" : report.credits.hasCredits ? `balance ${report.credits.balance ?? "available"}` : "none";
    lines.push(`credits: ${value}`);
  }
  return lines.join("\n");
}

function formatUsageWindow(window: ChatGptUsageWindow, nowSeconds: number): string {
  const label = window.windowSeconds >= 6 * 24 * 3600 ? `${Math.round(window.windowSeconds / 86400)}d`
    : window.windowSeconds >= 3600 ? `${Math.round(window.windowSeconds / 3600)}h`
    : `${Math.round(window.windowSeconds / 60)}m`;
  const left = Math.max(0, Math.round(100 - window.usedPercent));
  const reset = window.resetsAt ? ` - resets in ${formatDuration(Math.max(0, window.resetsAt - nowSeconds))}` : "";
  return `${label}: ${Math.round(window.usedPercent)}% used, ${left}% left${reset}`;
}

function formatDuration(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.ceil((seconds % 3600) / 60);
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", !days && minutes ? `${minutes}m` : ""].filter(Boolean).join(" ") || "now";
}

/** Provider picker (account first). On select, switch to it and CHAIN straight into its model picker, so the
 * flow is one smooth "pick account -> pick its model" — provider stays the primary axis (it's the account /
 * quota that costs money), and the same model name on two providers never gets confused. */
function openProviderPicker(ctx: CommandCtx, initialFamily?: string): void {
  const { cfg } = ctx;
  const chooseFamily = (family: string) => {
    const apiProfiles = new Set<string>();
    for (const [name, profile] of Object.entries(cfg.profiles)) {
      if (profile.auth === "chatgpt_oauth" || profile.auth === "none") continue;
      try { if (loadConfig({ profile: name }).apiKey) apiProfiles.add(name); } catch { /* status only */ }
    }
    const routes = authChoices(cfg, family, { chatgpt: hasChatGptCredentials(), apiProfiles });
    if (routes.length === 1) {
      if (switchProfile(ctx, routes[0].id)) void openModelPicker(ctx);
      return;
    }
    ctx.setOverlay({
      title: `${routes[0]?.label?.startsWith("ChatGPT") ? "OpenAI" : family} - choose account`,
      items: routes,
      onSelect: async (route) => {
        ctx.setOverlay(null);
        if (switchProfile(ctx, route.id)) await openModelPicker(ctx);
      },
    });
  };
  if (initialFamily) return chooseFamily(initialFamily);
  ctx.setOverlay({
    title: "Select provider (account) - then pick its model",
    items: providerChoices(cfg),
    onSelect: (it) => {
      ctx.setOverlay(null);
      chooseFamily(it.id);
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
    case "/usage": {
      if (!cfg.usesChatGptAuth) return addLine("info", "subscription quota is available for ChatGPT login; use /cost for this session's tokens");
      ctx.setBusy(true);
      try { addLine("info", formatChatGptUsage(await getChatGptUsage())); }
      catch (error) { addLine("error", `reading usage: ${error instanceof Error ? error.message : error}`); }
      finally { ctx.setBusy(false); }
      return;
    }
    case "/support": {
      const action = input.slice("/support".length).trim().toLowerCase() || "status";
      if (action === "status") {
        const status = discoverCodexSupport();
        const managed = readCodexSupportPack();
        const disk = managed ? `; ${(managed.installedBytes / 1024 / 1024).toFixed(1)} MiB on disk` : "";
        return addLine("info", `GPT-5.6 support: ${status.state} (${status.detail})${disk}. GPT-5.5/API/Ollama do not require it.`);
      }
      if (action === "remove" || action === "uninstall") {
        agent.setProvider(getProvider(cfg)); // release an idle App Server before Windows removes it
        const removed = removeCodexSupportPack();
        const fallback = discoverCodexSupport();
        return addLine("info", removed
          ? `GPT-5.6 Support Pack removed. Bridge status: ${fallback.state} (${fallback.detail}).`
          : "No Neko-managed Support Pack is installed; an existing Codex CLI is never removed by Neko.");
      }
      if (action !== "install" && action !== "update") return addLine("info", "usage: /support [status|install|update|remove]");
      ctx.setBusy(true);
      try { await installCodexSupportPack({ force: action === "update", notify: (message) => addLine("info", message) }); }
      catch (error) { addLine("error", `installing GPT-5.6 support: ${error instanceof Error ? error.message : error}`); }
      finally { ctx.setBusy(false); }
      return;
    }
    case "/model": {
      const arg = input.slice("/model".length).trim();
      if (arg === "list") {
        ctx.setBusy(true);
        try {
          const models = await listModelOptions(cfg);
          return addLine("info", "models: " + (models.map((model) => model.id + (model.id === cfg.model ? " (current)" : "")).join(", ") || cfg.model || "(none)"));
        } finally {
          ctx.setBusy(false);
        }
      }
      if (arg) {
        if (cfg.usesChatGptAuth) {
          ctx.setBusy(true);
          try {
            const selected = (await listModelOptions(cfg)).find((model) => model.id === arg);
            if (!selected) return addLine("error", `unknown ChatGPT model '${arg}' - use /model list`);
            if (selected.available === false) { openCodexInstallPrompt(ctx, selected); return; }
            applyModelSelection(ctx, selected);
            return;
          } finally {
            ctx.setBusy(false);
          }
        }
        cfg.data.model = arg;
        setModel(arg, cfg.profile); // remember it for the next session/folder too - in the ACTIVE profile
        return addLine("info", `model -> ${arg}`);
      }
      await openModelPicker(ctx); // model of the CURRENT provider (quick swap without changing account)
      return;
    }
    case "/provider":
    case "/providers":
    case "/profiles": {
      const arg = input.slice(cmd.length).trim();
      if (arg === "list") return addLine("info", "providers: " + providerChoices(cfg).map((choice) => choice.label).join(", "));
      if (arg === "openai") { openProviderPicker(ctx, "openai"); return; }
      if (arg) { switchProfile(ctx, arg); return; } // explicit internal profile remains available
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
    case "/transcript":
    case "/history":
      ctx.openTranscript();
      return;
    case "/copy":
      ctx.copy(input.slice("/copy".length).trim());
      return;
    case "/title":
      ctx.setTitle(input.slice("/title".length).trim());
      return;
    case "/fps": {
      const arg = input.slice("/fps".length).trim().toLowerCase();
      if (arg === "auto") return ctx.setFps("auto");
      if (arg) {
        const n = parseInt(arg, 10);
        if (!Number.isFinite(n) || n < 30 || n > 240) return addLine("info", "usage: /fps [auto|30..240]   (auto follows your display's refresh rate)");
        return ctx.setFps(n);
      }
      // No argument: a picker with a machine-aware recommendation.
      const { resolveUiFps } = await import("../adapters/display.ts");
      const r = resolveUiFps(cfg.uiFpsConfig);
      const auto = r.detected ? `follow your display (~${r.detected}Hz)` : "follow your display (probing runs in background)";
      ctx.setOverlay({
        title: `UI frame rate - currently ${r.fps}fps via ${r.source}. Higher than your display's refresh shows nothing extra.`,
        items: [
          { id: "auto", label: "auto (recommended)", detail: auto },
          { id: "60", label: "60 fps", detail: "standard displays - lowest overhead" },
          { id: "120", label: "120 fps", detail: "high-refresh displays (120Hz+)" },
          { id: "144", label: "144 fps", detail: "144Hz displays" },
        ],
        onSelect: (it) => { ctx.setOverlay(null); ctx.setFps(it.id === "auto" ? "auto" : parseInt(it.id, 10)); },
      });
      return;
    }
    case "/compact":
      // Route through the REPL's compaction runner so it shows the progress bar + a "freed ~Nk" line.
      try {
        await ctx.compact("manual");
      } catch (error) {
        addLine("error", `${error instanceof Error ? error.message : error}`);
      }
      return;
    case "/reset":
      agent.messages = [];
      return addLine("info", "(conversation reset)");
    case "/sessions": {
      const mine = listSessionMetas().filter((s) => s.cwd === process.cwd());
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
      if (!listSessionMetas().length) return addLine("info", "no saved sessions yet");
      return openResumePicker(ctx, "cwd");
    }
    case "/continue": {
      // Pick up an interrupted/incomplete task. The trajectory (sealed) + the todo list are already in
      // context - so tell the agent to resume the first unfinished todo and keep going, not restart.
      // A single run() naturally loops through steps until the work is done (or it needs you again).
      ctx.runText(
        "Continue the task from where it was interrupted. Review your current todo list and the recent " +
        "tool results above, then resume the FIRST incomplete todo and keep working until every todo is " +
        "done. If a tool call was cut off, re-run it. Do NOT restart from scratch or re-ask what the task " +
        "is - it is already established above.",
      );
      return;
    }
    case "/retry": {
      // Re-run the last user turn (after a transient error / a bad result). rewind() drops that turn and
      // its response from context, then we resubmit the same text so it runs fresh.
      const lastUser = [...agent.messages].reverse().find((m) => m.role === "user");
      const text = typeof lastUser?.content === "string" ? lastUser.content
        : Array.isArray(lastUser?.content) ? lastUser!.content.map((p: any) => p?.text ?? "").join("") : "";
      if (!text.trim()) return addLine("info", "nothing to retry");
      agent.rewind();
      ctx.runText(text);
      return;
    }
    case "/effort": {
      let arg = input.split(/\s+/)[1]?.toLowerCase();
      if (arg === "default") arg = "off";
      let option: ModelOption | undefined;
      if (cfg.usesChatGptAuth) {
        ctx.setBusy(true);
        try { option = (await listModelOptions(cfg)).find((model) => model.id === cfg.model); }
        finally { ctx.setBusy(false); }
      }
      const supported = option?.efforts?.map((level) => level.effort) ?? ["low", "medium", "high", "xhigh", "max", "ultra"];
      const levels = ["off", ...supported];
      const apply = (lvl: string) => {
        if (lvl === "off") delete cfg.data.reasoning_effort;
        else cfg.data.reasoning_effort = lvl;
        setEffort(lvl); // persist across sessions
        const shown = cfg.effort || `default${option?.defaultEffort ? ` (${option.defaultEffort})` : ""}`;
        addLine("info", `effort -> ${shown}`);
      };
      if (arg === "list") return addLine("info", `${cfg.model} effort: default, ${supported.join(", ")}  (current: ${cfg.effort || "default"})`);
      if (arg) {
        if (!levels.includes(arg)) return addLine("error", `${cfg.model} supports: default, ${supported.join(", ")}`);
        return apply(arg);
      }
      // No arg -> interactive picker (Faster -> Smarter), Claude-style.
      ctx.setOverlay({
        title: `Reasoning effort for ${cfg.model}  (Faster -> Smarter)`,
        items: levels.map((level) => {
          const metadata = option?.efforts?.find((candidate) => candidate.effort === level);
          const description = level === "off" ? `use model default${option?.defaultEffort ? ` (${option.defaultEffort})` : ""}` : metadata?.description;
          return { id: level, label: level === "off" ? "default" : level, detail: [level === (cfg.effort || "off") ? "current" : "", description ?? ""].filter(Boolean).join(" - ") };
        }),
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
        `context: ${used} / ${win} tokens used (${pct}%; auto-compacts past ${Math.round(COMPACT_AT * 100)}%) · last turn ${agent.cost.lastPrompt} in / ${agent.cost.lastCompletion} out`,
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
