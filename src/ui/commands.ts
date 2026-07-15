/**
 * Slash-command handling for the REPL, separated from the React component. Each command acts
 * on the REPL through CommandCtx (the command API surface), so chat.tsx stays the lifecycle +
 * render, and this file owns "what the commands do".
 */
import type { Agent } from "../core/agent.ts";
import { COMPACT_AT, estimateTokens } from "../core/agent.ts";
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
import { deleteMemoryFile, listMemories, memoryEnabled, readMemoryFile, setMemoryEnabled } from "../core/memory.ts";
import { fmtBytes, relativeTime, trunc } from "./format.ts";
import type { Overlay } from "./select-list.tsx";
import type { Line, LineKind } from "./transcript.tsx";
import { clearChatGptCredentials, hasChatGptCredentials } from "../adapters/chatgpt-auth.ts";
import { authChoices, profileDisplayName, providerChoices } from "../adapters/provider-choice.ts";
import { getChatGptUsage, type ChatGptUsageReport, type ChatGptUsageWindow } from "../adapters/chatgpt-provider.ts";
import { discoverCodexSupport } from "../adapters/codex-app-server.ts";
import { installCodexSupportPack, readCodexSupportPack, removeCodexSupportPack } from "../adapters/codex-support-pack.ts";
import { clearGeminiCredentials, discoverGeminiCli, hasGeminiCredentials } from "../adapters/gemini-cli.ts";
import { hasKimiCredentials } from "../adapters/kimi-auth.ts";
import { installGeminiSupportPack, readGeminiSupportPack, removeGeminiSupportPack } from "../adapters/gemini-support-pack.ts";
import { getLastGeminiUsage } from "../adapters/gemini-provider.ts";
import { getChatGptVoiceUsage } from "../adapters/chatgpt-voice.ts";
import { clampEffort, effortSuggestions, isEffortName, resolveEffort } from "../adapters/effort.ts";
import { browserBridgeStage, readBrowserCapability, readBrowserBridgeStatus, withBrowserBridge } from "../adapters/browser-bridge.ts";

export const HELP = [
  "Commands:",
  "  /help /cost /usage /voice /model /provider /support /browser /tools /skill(s) /init /clear /compact /transcript /reset /exit",
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
  { name: "/cost", desc: "session cumulative tokens vs the last model request" },
  { name: "/usage", desc: "subscription/session quota and token usage for the active account" },
  { name: "/voice", desc: "conversational browser voice, ChatGPT, lab bridge, or dictation" },
  { name: "/model", desc: "show / list / switch model (/model list · /model <id>)" },
  { name: "/provider", desc: "switch provider (account) then pick its model - picker or /provider <name>" },
  { name: "/support", desc: "install, update, or remove optional subscription components" },
  { name: "/browser", desc: "connect a signed-in Chrome tab (guided setup/status)" },
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
  { name: "/effort", desc: "model-aware reasoning preference (/effort <level>|default|list)" },
  { name: "/context", desc: "window capacity, last request, and next-request estimate" },
  { name: "/memory", desc: "inspect/control local memory (/memory [on|off|list|read|forget|identity])" },
  { name: "/remember", desc: "save a project note or explicit cross-project user observation" },
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

/** Conservative, model-free routing for tasks that need an interactive or signed-in browser tab. */
export function isInteractiveBrowserRequest(input: string): boolean {
  const text = input
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!text || text.startsWith("/")) return false;

  const signedInSite = /\b(facebook|x\.com|twitter|gmail|zalo|wechat|linkedin|instagram|tiktok|notion|google (?:docs|drive))\b/.test(text);
  const browserTarget = /\b(browser|chrome|chromium|edge|trinh duyet|tab|website|trang web)\b/.test(text);
  const browserAction = /\b(browse|open|use|control|navigate|visit|read|check|sign in|login|duyet|luot|mo|dung|dieu khien|truy cap|doc|kiem tra|dang nhap)\b/.test(text);
  const explicitWebBrowse = /\b(?:browse (?:the )?web|duyet web|luot web)\b/.test(text);
  return explicitWebBrowse || (browserAction && (browserTarget || signedInSite));
}

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
  setupBrowser?: () => Promise<string>; // /browser: open consented Store/local setup and start the bridge
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
  if (cfg.usesGeminiAuth && !hasGeminiCredentials()) {
    addLine("info", `note: provider "${name}" needs Google sign-in - type /login.`);
    return false;
  }
  if (cfg.usesKimiAuth && !hasKimiCredentials()) {
    addLine("info", `note: provider "${name}" needs Kimi Code sign-in - type /login.`);
    return false;
  }
  if (!cfg.usesChatGptAuth && !cfg.usesGeminiAuth && !cfg.usesKimiAuth && !cfg.apiKey && !cfg.isLocalEndpoint) {
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
  const resolved = resolveEffort(before, selected);
  if (before && before !== "off" && resolved !== before) {
    addLine("info", `model -> ${selected.id}; effort preference ${before} -> ${resolved} for this model`);
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
        .then(() => {
          applyModelSelection(ctx, { ...selected, available: true });
          ctx.addLine("info", "Manage, update, or remove this optional component anytime with /support.");
        })
        .catch((error) => ctx.addLine("error", `GPT-5.6 Support Pack failed: ${error instanceof Error ? error.message : error}. Retry with /support chatgpt install.`))
        .finally(() => ctx.setBusy(false));
    },
  });
}

type SupportKind = "chatgpt" | "gemini";

/** A discoverable owner-aware management surface. Neko only offers Remove for files it installed. */
function openSupportCenter(ctx: CommandCtx): void {
  const codex = discoverCodexSupport();
  const codexManaged = readCodexSupportPack();
  const gemini = discoverGeminiCli();
  const geminiManaged = readGeminiSupportPack();
  ctx.setOverlay({
    title: "Manage optional support components",
    items: [
      {
        id: "chatgpt",
        label: "ChatGPT GPT-5.6 Support Pack",
        detail: supportDetail("chatgpt", codex.state, codex.detail, codex.executable?.source === "managed", codexManaged?.installedBytes),
      },
      {
        id: "gemini",
        label: "Gemini CLI Support Pack",
        detail: supportDetail("gemini", gemini.state, gemini.detail, gemini.executable?.source === "managed", geminiManaged?.installedBytes),
      },
      { id: "close", label: "Close", detail: "No changes" },
    ],
    onSelect: (item) => {
      if (item.id === "close") return ctx.setOverlay(null);
      openSupportManager(ctx, item.id as SupportKind);
    },
  });
}

function supportDetail(kind: SupportKind, state: string, detail: string, activeManaged: boolean, bytes?: number): string {
  if (bytes != null) return `installed by Neko - ${formatMiB(bytes)} on disk - ${activeManaged ? state : `available; active bridge ${detail}`}`;
  if (state === "ready") return `using an existing ${kind === "chatgpt" ? "Codex" : "Gemini"} CLI - Neko installed nothing`;
  return `not installed - ${kind === "chatgpt" ? "GPT-5.5/API/Ollama still work" : "required only for Code Assist Standard/Enterprise ACP"}`;
}

function openSupportManager(ctx: CommandCtx, kind: SupportKind): void {
  const managed = kind === "chatgpt" ? readCodexSupportPack() : readGeminiSupportPack();
  const status = kind === "chatgpt" ? discoverCodexSupport() : discoverGeminiCli();
  const title = kind === "chatgpt" ? "ChatGPT GPT-5.6 Support Pack" : "Gemini CLI Support Pack";
  const items = managed ? [
    { id: "update", label: "Update or repair", detail: `verify and replace the ${formatMiB(managed.installedBytes)} Neko-managed component` },
    { id: "remove", label: "Remove support pack", detail: kind === "chatgpt"
      ? `free ${formatMiB(managed.installedBytes)}; ChatGPT sign-in stays and GPT-5.5 still works`
      : `free ${formatMiB(managed.installedBytes)}; enterprise sign-in stays for a quick reinstall` },
    { id: "back", label: "Back", detail: "Return to all support components" },
  ] : status.state === "ready" ? [
    { id: "back", label: "Back", detail: `Using an existing ${kind === "chatgpt" ? "Codex" : "Gemini"} CLI. Neko did not install it and will not remove it.` },
  ] : [
    { id: "install", label: "Install support pack", detail: kind === "chatgpt" ? "about 95 MiB download / 270 MiB disk" : "about 55 MiB download / 200 MiB disk; no administrator access" },
    { id: "back", label: "Back", detail: "Download nothing" },
  ];
  ctx.setOverlay({
    title: `Manage ${title}`,
    items,
    onSelect: (item) => {
      if (item.id === "back") return openSupportCenter(ctx);
      if (item.id === "remove") return openSupportRemoveConfirm(ctx, kind, managed!.installedBytes);
      ctx.setOverlay(null);
      ctx.setBusy(true);
      void (kind === "chatgpt"
        ? installCodexSupportPack({ force: item.id === "update", notify: (message) => ctx.addLine("info", message) })
        : installGeminiSupportPack({ force: item.id === "update", notify: (message) => ctx.addLine("info", message) }))
        .then(() => ctx.addLine("info", `${title} is ready. Return to /support anytime to update or remove it.`))
        .catch((error) => ctx.addLine("error", `${title} failed: ${error instanceof Error ? error.message : error}. Check the connection and retry.`))
        .finally(() => { ctx.setBusy(false); openSupportCenter(ctx); });
    },
  });
}

function openSupportRemoveConfirm(ctx: CommandCtx, kind: SupportKind, bytes: number): void {
  const title = kind === "chatgpt" ? "ChatGPT GPT-5.6 Support Pack" : "Gemini CLI Support Pack";
  ctx.setOverlay({
    title: `Remove ${title}?`,
    items: [
      { id: "keep", label: "Keep installed", detail: "Recommended if you still use this subscription route" },
      { id: "remove", label: `Remove and free ${formatMiB(bytes)}`, detail: kind === "chatgpt"
        ? "ChatGPT sign-in stays; GPT-5.5/API/Ollama are unaffected"
        : "Enterprise sign-in stays; reinstall the pack to use Code Assist again" },
      { id: "remove-and-signout", label: "Remove and sign out", detail: kind === "chatgpt"
        ? `free ${formatMiB(bytes)} and remove Neko's ChatGPT session; API keys stay`
        : `free ${formatMiB(bytes)} and remove Neko's Google session; API keys stay` },
    ],
    onSelect: (item) => {
      if (item.id !== "remove" && item.id !== "remove-and-signout") return openSupportManager(ctx, kind);
      ctx.setOverlay(null);
      ctx.agent.setProvider(getProvider(ctx.cfg)); // dispose the hidden process before Windows removes it
      const removed = kind === "chatgpt" ? removeCodexSupportPack() : removeGeminiSupportPack();
      const signedOut = item.id === "remove-and-signout";
      if (signedOut) (kind === "chatgpt" ? clearChatGptCredentials : clearGeminiCredentials)();
      ctx.addLine(removed ? "info" : "error", removed
        ? `${title} removed; freed ${formatMiB(bytes)}. ${signedOut ? "Neko also signed this account out." : "Your sign-in was kept."} Reinstall anytime from /support.`
        : `${title} was already absent; no files were removed.`);
      openSupportCenter(ctx);
    },
  });
}

function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
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
      if (profile.auth === "chatgpt_oauth" || profile.auth === "gemini_oauth" || profile.auth === "kimi_oauth" || profile.auth === "none") continue;
      try { if (loadConfig({ profile: name }).apiKey) apiProfiles.add(name); } catch { /* status only */ }
    }
    const routes = authChoices(cfg, family, { chatgpt: hasChatGptCredentials(), gemini: hasGeminiCredentials(), kimi: hasKimiCredentials(), apiProfiles });
    if (routes.length === 1) {
      if (switchProfile(ctx, routes[0].id)) void openModelPicker(ctx);
      return;
    }
    ctx.setOverlay({
      title: `${family === "openai" ? "OpenAI" : family === "google" ? "Google" : family} - choose account`,
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
      const voice = formatVoiceUsage();
      if (cfg.usesGeminiAuth) {
        const usage = getLastGeminiUsage();
        const lines = ["Gemini usage (Code Assist Standard/Enterprise)"];
        if (usage) {
          lines.push(`last turn: ${usage.inputTokens} input / ${usage.outputTokens} output tokens`);
          for (const model of usage.models) lines.push(`${model.model}: ${model.inputTokens} input / ${model.outputTokens} output`);
        } else lines.push("last turn: no Gemini turn recorded in this Neko session");
        lines.push("Limits depend on the Code Assist license. Google does not expose remaining requests through ACP.");
        lines.push("Neko will show a clear retry/reset message if Google reports a limit.");
        if (voice) lines.push("", voice);
        return addLine("info", lines.join("\n"));
      }
      if (!cfg.usesChatGptAuth) return addLine("info", ["subscription quota is available for ChatGPT or Gemini login; use /cost for this session's tokens", voice].filter(Boolean).join("\n\n"));
      ctx.setBusy(true);
      try { addLine("info", [formatChatGptUsage(await getChatGptUsage()), voice].filter(Boolean).join("\n\n")); }
      catch (error) { addLine("error", `reading usage: ${error instanceof Error ? error.message : error}`); }
      finally { ctx.setBusy(false); }
      return;
    }
    case "/browser": {
      const action = input.slice("/browser".length).trim().toLowerCase();
      if (action && action !== "install" && action !== "setup" && action !== "status") {
        return addLine("info", "usage: /browser [setup|status]");
      }
      const capability = readBrowserCapability();
      const status = capability ? readBrowserBridgeStatus() : undefined;
      if (action === "status" || (!action && capability)) {
        if (!capability) return addLine("info", "browser control is not set up yet - type /browser setup to start guided setup");
        const stage = browserBridgeStage(capability, status);
        const state = stage === "tab_attached"
          ? "ready - one Chrome tab is attached"
          : stage === "extension_connected"
            ? "extension connected - open a target tab and attach it"
            : stage === "bridge_online"
              ? "bridge online, but the Chrome extension is not connected - type /browser setup"
              : "configured, but no live Chrome connection is verified - type /browser setup";
        return addLine("info", `browser: ${state}\nBrowser access stays local and only the tab you explicitly attach is controllable.`);
      }
      if (!ctx.setupBrowser) return addLine("error", "browser setup is unavailable in this host; run `neko browser install`");
      ctx.setBusy(true);
      const hadCapability = !!capability;
      try {
        const message = await ctx.setupBrowser();
        addLine("info", message);
      } catch (error) {
        addLine("error", `browser setup failed: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        // setup creates the local capability before opening Chrome. Keep the live agent/tool index in
        // sync even if Chrome itself could not be opened; the user can still attach it manually.
        if (!hadCapability && readBrowserCapability()) {
          ctx.registry.mcp = withBrowserBridge(ctx.registry.mcp);
          ctx.agent.refreshSystemPrompt();
        }
        ctx.setBusy(false);
      }
      return;
    }
    case "/support": {
      const action = input.slice("/support".length).trim().toLowerCase();
      if (!action) { openSupportCenter(ctx); return; }
      if (action === "gemini") { openSupportManager(ctx, "gemini"); return; }
      if (action === "chatgpt" || action === "codex") { openSupportManager(ctx, "chatgpt"); return; }
      const geminiAction = action.startsWith("gemini ") ? action.slice("gemini ".length).trim() : null;
      if (geminiAction === "status") {
        const status = discoverGeminiCli();
        const managed = readGeminiSupportPack();
        const disk = managed ? `; ${(managed.installedBytes / 1024 / 1024).toFixed(1)} MiB on disk` : "";
        return addLine("info", `Gemini CLI support: ${status.state} (${status.detail})${disk}. Only Code Assist Standard/Enterprise uses it; Gemini API keys connect directly to Google.`);
      }
      if (geminiAction === "remove" || geminiAction === "uninstall") {
        agent.setProvider(getProvider(cfg));
        const removed = removeGeminiSupportPack();
        const fallback = discoverGeminiCli();
        return addLine("info", removed
          ? `Gemini CLI Support Pack removed. Bridge status: ${fallback.state} (${fallback.detail}). Your enterprise sign-in remains until /logout.`
          : "No Neko-managed Gemini CLI Support Pack is installed; an existing Gemini CLI was not changed.");
      }
      if (geminiAction === "install" || geminiAction === "update") {
        ctx.setBusy(true);
        try { await installGeminiSupportPack({ force: geminiAction === "update", notify: (message) => addLine("info", message) }); }
        catch (error) { addLine("error", `Gemini Support Pack failed: ${error instanceof Error ? error.message : error}. Check the connection and retry.`); }
        finally { ctx.setBusy(false); }
        return;
      }
      if (geminiAction) return addLine("info", "usage: /support gemini [status|install|update|remove]");
      if (action === "status") {
        const codex = discoverCodexSupport();
        const codexManaged = readCodexSupportPack();
        const codexDisk = codexManaged ? `; ${(codexManaged.installedBytes / 1024 / 1024).toFixed(1)} MiB on disk` : "";
        const gemini = discoverGeminiCli();
        const geminiManaged = readGeminiSupportPack();
        const geminiDisk = geminiManaged ? `; ${(geminiManaged.installedBytes / 1024 / 1024).toFixed(1)} MiB on disk` : "";
        return addLine("info", [
          `ChatGPT GPT-5.6 support: ${codex.state} (${codex.detail})${codexDisk}`,
          `Gemini CLI support: ${gemini.state} (${gemini.detail})${geminiDisk}`,
          "GPT-5.5, Gemini API keys, other API providers, and Ollama do not require these components.",
        ].join("\n"));
      }
      const codexAction = action.startsWith("chatgpt ") ? action.slice("chatgpt ".length).trim()
          : action.startsWith("codex ") ? action.slice("codex ".length).trim()
            : action;
      if (codexAction === "status") {
        const status = discoverCodexSupport();
        const managed = readCodexSupportPack();
        const disk = managed ? `; ${(managed.installedBytes / 1024 / 1024).toFixed(1)} MiB on disk` : "";
        return addLine("info", `ChatGPT GPT-5.6 support: ${status.state} (${status.detail})${disk}. GPT-5.5/API/Ollama do not require it.`);
      }
      if (codexAction === "remove" || codexAction === "uninstall") {
        agent.setProvider(getProvider(cfg)); // release an idle App Server before Windows removes it
        const removed = removeCodexSupportPack();
        const fallback = discoverCodexSupport();
        return addLine("info", removed
          ? `GPT-5.6 Support Pack removed. Bridge status: ${fallback.state} (${fallback.detail}). ChatGPT sign-in was kept; GPT-5.5/API/Ollama are unaffected.`
          : "No Neko-managed Support Pack is installed; an existing Codex CLI is never removed by Neko.");
      }
      if (codexAction !== "install" && codexAction !== "update") return addLine("info", "usage: /support [status|chatgpt|gemini] [status|install|update|remove]");
      ctx.setBusy(true);
      try { await installCodexSupportPack({ force: codexAction === "update", notify: (message) => addLine("info", message) }); }
      catch (error) { addLine("error", `GPT-5.6 Support Pack failed: ${error instanceof Error ? error.message : error}. Check the connection and retry.`); }
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
        if (cfg.usesChatGptAuth || cfg.usesGeminiCli) {
          ctx.setBusy(true);
          try {
            const selected = (await listModelOptions(cfg)).find((model) => model.id === arg);
            if (!selected) return addLine("error", `unknown ${cfg.usesChatGptAuth ? "ChatGPT" : "Gemini"} model '${arg}' - use /model list`);
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
      if (cfg.usesGeminiCli) return addLine("info", "Gemini manages thinking adaptively for the selected model; OpenAI-style effort tiers do not apply.");
      let arg = input.slice("/effort".length).trim().toLowerCase();
      if (arg === "default") arg = "off";
      let option: ModelOption | undefined;
      if (cfg.usesChatGptAuth || cfg.provider === "kimi") {
        ctx.setBusy(true);
        try { option = (await listModelOptions(cfg)).find((model) => model.id === cfg.model); }
        catch { /* fallback suggestions remain usable while the model catalog is offline */ }
        finally { ctx.setBusy(false); }
      }
      const advertised = option?.efforts?.map((level) => level.effort).filter(Boolean);
      const negotiate = (level: string) => {
        const modelLevel = advertised?.length ? resolveEffort(level, option) : level;
        return cfg.usesChatGptAuth ? modelLevel : clampEffort(modelLevel, cfg.effortCeiling);
      };
      const supported = advertised?.length
        ? [...new Set(advertised)].filter((level) => negotiate(level) === level)
        : effortSuggestions(cfg.effortCeiling, cfg.effort);
      if (cfg.effort && !supported.includes(cfg.effort)) supported.push(cfg.effort);
      const levels = ["off", ...supported];
      const apply = (lvl: string) => {
        if (lvl === "off") delete cfg.data.reasoning_effort;
        else cfg.data.reasoning_effort = lvl;
        setEffort(lvl); // persist across sessions
        const shown = cfg.effort || `default${option?.defaultEffort ? ` (${option.defaultEffort})` : ""}`;
        if (!cfg.effort) return addLine("info", `effort preference -> ${shown}`);
        const effective = negotiate(cfg.effort);
        addLine("info", effective === cfg.effort
          ? `effort preference -> ${shown}`
          : `effort preference -> ${shown}; ${cfg.model} uses ${effective}`);
      };
      if (arg === "list") {
        const effective = cfg.effort
          ? negotiate(cfg.effort)
          : option?.defaultEffort || "model default";
        return addLine("info", `${cfg.model} effort: default, ${supported.join(", ")}  (preference: ${cfg.effort || "default"}; effective: ${effective})`);
      }
      if (arg) {
        if (arg !== "off" && !isEffortName(arg)) return addLine("error", "effort must be one provider tier name (letters, digits, '.', '_' or '-')");
        return apply(arg);
      }
      // No arg -> interactive picker (Faster -> Smarter), Claude-style.
      ctx.setOverlay({
        title: `Reasoning effort for ${cfg.model}  (Faster -> Smarter)`,
        items: levels.map((level) => {
          const metadata = option?.efforts?.find((candidate) => candidate.effort === level);
          const effective = level === "off" ? "" : negotiate(level);
          const description = level === "off"
            ? `use model default${option?.defaultEffort ? ` (${option.defaultEffort})` : ""}`
            : metadata?.description || (effective !== level ? `${cfg.model} uses ${effective}` : "");
          return { id: level, label: level === "off" ? "default" : level, detail: [level === (cfg.effort || "off") ? "current preference" : "", description].filter(Boolean).join(" - ") };
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
      const last = agent.cost.lastPrompt;
      const next = estimateTokens(agent.messages);
      const used = last || next;
      const pct = Math.min(100, Math.max(0, Math.round((100 * used) / win)));
      return addLine(
        "info",
        `context window capacity: ${win} tokens\n` +
        (last ? `last request: ${last} input / ${agent.cost.lastCompletion} output (${pct}% of capacity)\n` : "") +
        `next request estimate: ~${next} tokens${last ? " (multimodal-safe estimate; provider usage above is authoritative)" : ` (${pct}% of capacity)`}\n` +
        `auto-compacts past ${Math.round(COMPACT_AT * 100)}%`,
      );
    }
    case "/remember": {
      const rest = input.slice("/remember".length).trim();
      const userScope = rest.startsWith("--user");
      const note = userScope ? rest.slice("--user".length).trim() : rest;
      if (!note) return addLine("info", "usage: /remember [--user] <note>   (or just start a line with #)");
      return addLine("info", rememberNote(note, userScope ? "user" : "project"));
    }
    case "/memory": {
      const rest = input.slice("/memory".length).trim();
      const [action = "status", ...parts] = rest.split(/\s+/);
      const name = parts.join(" ").trim();
      if (action === "on") return addLine("info", setMemoryEnabled(true));
      if (action === "off") return addLine("info", setMemoryEnabled(false));
      if (action === "identity") return addLine("info", renderContext());
      if (action === "list") {
        const memories = listMemories();
        return addLine("info", memories.length ? memories.map((memory) => `- ${memory.name}: ${memory.summary}`).join("\n") : "(no memories yet)");
      }
      if (action === "read") {
        if (!name) return addLine("info", "usage: /memory read <name>");
        return addLine("info", readMemoryFile(name));
      }
      if (action === "forget" || action === "delete") {
        if (!name) return addLine("info", "usage: /memory forget <name>");
        return addLine("info", deleteMemoryFile(name));
      }
      if (action !== "status" && action !== "help") {
        return addLine("info", "usage: /memory [on|off|list|read <name>|forget <name>|identity]");
      }
      const memories = listMemories();
      return addLine("info", [
        `Neko memory: ${memoryEnabled() ? "on" : "off"}`,
        "identity: ~/.neko-core/NEKO.md (create once; always user-owned)",
        "core profiles: ~/.neko-core/memory/user.md + self.md (bounded in context)",
        `saved memory files: ${memories.length}`,
        "episodes: ~/.neko-core/sessions (raw history; not injected wholesale)",
        "procedures: ~/.neko-core/workflows + playbook.md",
        "controls: /memory list | read <name> | forget <name> | off | on | identity",
        "save an explicit preference: /remember --user <note>",
      ].join("\n"));
    }
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

function formatVoiceUsage(): string {
  const usage = getChatGptVoiceUsage();
  if (!usage) return "";
  const seconds = Math.floor(usage.durationMs / 1000);
  const duration = `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return [
    "ChatGPT subscription voice (experimental)",
    `session: ${usage.active ? "LIVE" : "stopped"} - ${duration}`,
    "remaining voice quota: not exposed by the Codex realtime integration",
    usage.lastError ? `last limit/error: ${usage.lastError}` : "",
  ].filter(Boolean).join("\n");
}
