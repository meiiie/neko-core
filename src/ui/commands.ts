/**
 * Slash-command handling for the REPL, separated from the React component. Each command acts
 * on the REPL through CommandCtx (the command API surface), so chat.tsx stays the lifecycle +
 * render, and this file owns "what the commands do".
 */
import type { Agent } from "../core/agent.ts";
import type { NekoConfig } from "../adapters/config.ts";
import { initProject } from "../adapters/project.ts";
import { listModels } from "../adapters/providers.ts";
import { listSessions, loadSession, sessionTitle, type Session } from "../adapters/session.ts";
import { listSkills, loadSkill } from "../adapters/skills.ts";
import type { ToolRegistry } from "../core/tool-runtime.ts";
import { listTools } from "../core/tools.ts";
import { fmtBytes, relativeTime, trunc } from "./format.ts";
import type { Overlay } from "./select-list.tsx";
import type { Line, LineKind } from "./transcript.tsx";

export const HELP = [
  "Commands:",
  "  /help /cost /model /profiles /tools /skill(s) /init /clear /compact /reset /exit",
  "  /goal <text> · /loop <n> <task> · /sessions · /resume · /effort · /context",
  "Input: Up/Down history; end a line with \\ to continue (multiline); @path adds a file to context.",
  "Shift+Tab: cycle permission mode (default -> accept-edits -> plan -> auto).",
  "Esc: interrupt a running turn (or close a picker). Ctrl-C twice: quit.",
].join("\n");

export const SLASH: { name: string; desc: string }[] = [
  { name: "/help", desc: "show help" },
  { name: "/cost", desc: "token usage this session" },
  { name: "/model", desc: "show / list / switch model (/model list · /model <id>)" },
  { name: "/profiles", desc: "list profiles" },
  { name: "/tools", desc: "list / toggle tools (/tools bash)" },
  { name: "/skill", desc: "load a skill (/skill name) · /skills to list" },
  { name: "/init", desc: "scaffold ./.neko-core/config.json" },
  { name: "/clear", desc: "clear transcript + context" },
  { name: "/compact", desc: "summarize the conversation to free context" },
  { name: "/goal", desc: "set an ongoing goal (/goal <text>)" },
  { name: "/loop", desc: "run a task N times (/loop <n> <task>)" },
  { name: "/sessions", desc: "list saved sessions here" },
  { name: "/resume", desc: "resume a session (/resume [id])" },
  { name: "/effort", desc: "reasoning effort (/effort low|medium|high|off)" },
  { name: "/context", desc: "context window usage" },
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
        return addLine("info", `model -> ${arg}`);
      }
      ctx.setBusy(true);
      try {
        const models = await listModels(cfg);
        ctx.setBusy(false);
        if (!models.length) return addLine("info", "no models returned by the endpoint");
        ctx.setOverlay({
          title: "Select model",
          items: models.map((m) => ({ id: m, label: m, detail: m === cfg.model ? "(current)" : undefined })),
          onSelect: (it) => {
            ctx.setOverlay(null);
            cfg.data.model = it.id;
            addLine("info", `model -> ${it.id}`);
          },
        });
      } catch (error) {
        ctx.setBusy(false);
        addLine("info", `error listing models: ${error instanceof Error ? error.message : error}`);
      }
      return;
    }
    case "/profiles":
      return addLine("info", "profiles: " + Object.keys(cfg.profiles).sort().join(", "));
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
        addLine("info", `error: ${error instanceof Error ? error.message : error}`);
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
      const list = listSessions().filter((s) => s.cwd === process.cwd());
      if (!list.length) return addLine("info", "no saved sessions here - /sessions to list");
      return ctx.setOverlay({
        title: "Resume session",
        items: list.map((s) => ({
          id: s.id,
          label: sessionTitle(s),
          detail: `${relativeTime(s.updatedAt)} · ${s.messages.length} msgs` +
            (s.branch ? ` · ${s.branch}` : "") + (s.bytes ? ` · ${fmtBytes(s.bytes)}` : ""),
        })),
        onSelect: (it) => {
          ctx.setOverlay(null);
          const target = loadSession(it.id);
          if (target) ctx.resumeInto(target);
        },
      });
    }
    case "/effort": {
      const lvl = input.split(/\s+/)[1]?.toLowerCase();
      if (!lvl) return addLine("info", `effort: ${cfg.effort || "off"} (use /effort low|medium|high|off)`);
      if (lvl === "off") delete cfg.data.reasoning_effort;
      else cfg.data.reasoning_effort = lvl;
      return addLine("info", `effort -> ${cfg.effort || "off"}`);
    }
    case "/context": {
      const win = cfg.contextWindow;
      const used = agent.cost.lastPrompt;
      const pct = Math.max(0, Math.round((100 * (win - used)) / win));
      return addLine("info", `context: ~${used} / ${win} tokens (${pct}% free; auto-compacts past 85%)`);
    }
    default:
      return addLine("info", `unknown command ${cmd} - try /help`);
  }
}
