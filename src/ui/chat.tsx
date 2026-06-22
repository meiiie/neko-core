/**
 * `neko chat` — the Ink (React-for-terminal) REPL. The "Neko Code" UX surface.
 *
 * Clean-room reimplementation of the terminal-coding-agent UX (welcome box, markdown
 * streaming, tool-call lines, inline approval with a diff preview, spinner + elapsed,
 * Esc-to-interrupt, slash commands, history, multiline, Shift+Tab modes). Reuses one Agent
 * for conversation memory. Kept ASCII-safe so it renders on any Windows console codepage.
 */
import { Box, render, Static, Text, useApp, useInput, useStdout } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useRef, useState } from "react";

import { Logo } from "./logo.tsx";
import { TextInput } from "./text-input.tsx";

import { Agent, DEFAULT_SYSTEM_PROMPT } from "../agent.ts";
import { loadConfig } from "../config.ts";
import { projectContextBlock } from "../context.ts";
import { buildMcpHub, type McpHub } from "../mcp.ts";
import { nextMode, type PermissionMode } from "../permissions.ts";
import { initProject } from "../project.ts";
import { getProvider, type Provider } from "../providers.ts";
import { latestSession, newSessionId, saveSession, type Session } from "../session.ts";
import { ToolRegistry } from "../tool-runtime.ts";
import { listSkills, loadSkill } from "../skills.ts";
import { listTools } from "../tools.ts";
import { VERSION } from "../version.ts";
import { Markdown } from "./markdown.tsx";

type LineKind = "welcome" | "user" | "assistant" | "tool_call" | "tool_result" | "info";
interface Line {
  id: number;
  kind: LineKind;
  text: string;
}
export interface Approval {
  toolName: string;
  args: Record<string, any>;
  resolve: (ok: boolean) => void;
}

const HELP = [
  "Commands:",
  "  /help  /cost  /model  /profiles  /init  /clear  /reset  /exit",
  "Input: Up/Down history; end a line with \\ to continue (multiline); @path adds a file to context.",
  "Shift+Tab: cycle permission mode (default -> accept-edits -> plan -> auto).",
  "Esc: interrupt a running turn. Ctrl-C: quit.",
].join("\n");

function trunc(s: string, n = 120): string {
  const one = String(s).replace(/\s+/g, " ");
  return one.length > n ? one.slice(0, n) + "..." : one;
}

const MODE_COLOR: Record<PermissionMode, string> = {
  default: "gray",
  "accept-edits": "yellow",
  plan: "blue",
  auto: "red",
};

const SLASH: { name: string; desc: string }[] = [
  { name: "/help", desc: "show help" },
  { name: "/cost", desc: "token usage this session" },
  { name: "/model", desc: "active provider/model/mode" },
  { name: "/profiles", desc: "list profiles" },
  { name: "/tools", desc: "list / toggle tools (/tools bash)" },
  { name: "/skill", desc: "load a skill (/skill name) · /skills to list" },
  { name: "/init", desc: "scaffold ./.neko-core/config.json" },
  { name: "/clear", desc: "clear transcript + context" },
  { name: "/compact", desc: "summarize the conversation to free context" },
  { name: "/reset", desc: "reset conversation context" },
  { name: "/exit", desc: "quit" },
];

interface ChatProps {
  profile?: string;
  yolo: boolean;
  resume?: boolean;
  mcpHub?: McpHub;
  provider?: Provider; // injected in tests; production uses getProvider(cfg)
}

export function ChatApp({ profile, yolo, resume, mcpHub, provider }: ChatProps) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const cols = stdout?.columns ?? 80;
  const cfg = useRef(loadConfig({ profile })).current;
  const idRef = useRef(0);
  const streamRef = useRef("");
  const alwaysApproved = useRef<Set<string>>(new Set());
  const historyRef = useRef<string[]>([]);
  const historyPos = useRef(0);
  const multilineRef = useRef("");
  const queueRef = useRef<string[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const startRef = useRef(0);
  const resumedRef = useRef<Session | null>(resume ? latestSession(process.cwd()) : null);
  const sessionIdRef = useRef(resumedRef.current?.id ?? newSessionId());
  const createdAtRef = useRef(resumedRef.current?.createdAt ?? new Date().toISOString());

  const [lines, setLines] = useState<Line[]>(() => {
    const welcome: Line = { id: idRef.current++, kind: "welcome", text: "" };
    if (!resumedRef.current) return [welcome];
    return [
      welcome,
      {
        id: idRef.current++,
        kind: "info",
        text: `(resumed session ${resumedRef.current.id} - ${resumedRef.current.messages.length} messages)`,
      },
    ];
  });
  const [stream, setStream] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [pendingMulti, setPendingMulti] = useState(false);
  const [mode, setMode] = useState<PermissionMode>(yolo ? "auto" : cfg.mode);
  const [elapsed, setElapsed] = useState(0);
  const [queued, setQueued] = useState(0);
  const [step, setStep] = useState(0);
  const [todos, setTodos] = useState<{ content: string; status: string }[]>([]);

  const addLine = (kind: LineKind, text: string) =>
    setLines((prev) => [...prev, { id: idRef.current++, kind, text }]);

  const flushStream = () => {
    if (streamRef.current.trim()) addLine("assistant", streamRef.current.trimEnd());
    streamRef.current = "";
    setStream("");
  };

  const gate = (toolName: string, args: Record<string, any>): boolean | Promise<boolean> => {
    if (alwaysApproved.current.has(toolName)) return true;
    return new Promise<boolean>((resolve) => setApproval({ toolName, args, resolve }));
  };

  const registryRef = useRef<ToolRegistry | null>(null);
  if (!registryRef.current) {
    registryRef.current = new ToolRegistry(process.cwd(), yolo ? "auto" : cfg.mode, gate, mcpHub);
  }

  const agentRef = useRef<Agent | null>(null);
  if (!agentRef.current) {
    const block = projectContextBlock();
    agentRef.current = new Agent({
      provider: provider ?? getProvider(cfg),
      tools: registryRef.current,
      maxSteps: cfg.maxSteps,
      systemPrompt: block ? `${DEFAULT_SYSTEM_PROMPT}\n\n${block}` : DEFAULT_SYSTEM_PROMPT,
      onDelta: (t) => {
        streamRef.current += t;
        setStream((s) => s + t);
      },
      onEvent: (kind, data) => {
        if (kind === "tool_call") {
          flushStream();
          const a = data.arguments ?? {};
          addLine("tool_call", `${data.name}(${trunc(a.command ?? a.path ?? a.pattern ?? "", 80)})`);
        } else if (kind === "tool_result") {
          const obs = String(data.observation)
            .split("\n")
            .slice(0, 8)
            .map((l) => (l.length > 200 ? l.slice(0, 200) + "…" : l))
            .join("\n");
          addLine("tool_result", obs);
          setTodos([...registryRef.current!.todos]); // reflect todo_write changes
        } else if (kind === "step") {
          setStep(data);
        }
      },
    });
    if (resumedRef.current) agentRef.current.messages = [...resumedRef.current.messages];
  }

  const persist = () => {
    saveSession({
      id: sessionIdRef.current,
      createdAt: createdAtRef.current,
      updatedAt: new Date().toISOString(),
      cwd: process.cwd(),
      model: cfg.model,
      messages: agentRef.current!.messages,
    });
  };

  // Elapsed timer while a turn runs.
  useEffect(() => {
    if (!busy) return;
    startRef.current = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Math.floor((Date.now() - startRef.current) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [busy]);

  // Ctrl-C twice to exit (always active).
  const ctrlC = useRef(false);
  useInput((input, key) => {
    if (key.ctrl && input === "c") {
      if (ctrlC.current) return exit();
      ctrlC.current = true;
      addLine("info", "(press Ctrl-C again to exit)");
      setTimeout(() => {
        ctrlC.current = false;
      }, 2000);
    }
  });

  // Approval keys.
  useInput(
    (char, key) => {
      if (!approval) return;
      const c = char.toLowerCase();
      if (c === "y") {
        approval.resolve(true);
        setApproval(null);
      } else if (c === "a") {
        alwaysApproved.current.add(approval.toolName);
        approval.resolve(true);
        setApproval(null);
      } else if (c === "n" || key.escape) {
        approval.resolve(false);
        setApproval(null);
      }
    },
    { isActive: approval !== null },
  );

  // Esc interrupts a running turn.
  useInput(
    (_char, key) => {
      if (key.escape) controllerRef.current?.abort();
    },
    { isActive: busy && approval === null },
  );

  // History (Up/Down) + Shift+Tab mode cycling, while the input box shows.
  useInput(
    (_char, key) => {
      if (key.tab && key.shift) {
        const nm = nextMode(registryRef.current!.mode);
        registryRef.current!.mode = nm;
        setMode(nm);
        return;
      }
      const h = historyRef.current;
      if (key.upArrow && historyPos.current > 0) {
        historyPos.current -= 1;
        setInput(h[historyPos.current]);
      } else if (key.downArrow) {
        if (historyPos.current < h.length - 1) {
          historyPos.current += 1;
          setInput(h[historyPos.current]);
        } else {
          historyPos.current = h.length;
          setInput("");
        }
      }
    },
    { isActive: !busy && approval === null },
  );

  const handle = async (text: string) => {
    if (text.startsWith("/")) {
      const cmd = text.split(/\s+/)[0];
      switch (cmd) {
        case "/exit":
        case "/quit":
          exit();
          return;
        case "/help":
          addLine("info", HELP);
          return;
        case "/cost":
          addLine("info", agentRef.current!.cost.summary());
          return;
        case "/model":
          addLine("info", `provider=${cfg.provider} model=${cfg.model || "(unset)"} profile=${cfg.profile ?? "none"} mode=${mode}`);
          return;
        case "/profiles":
          addLine("info", "profiles: " + Object.keys(cfg.profiles).sort().join(", "));
          return;
        case "/tools": {
          const reg = registryRef.current!;
          const arg = text.split(/\s+/)[1];
          if (arg) {
            if (reg.disabled.has(arg)) reg.disabled.delete(arg);
            else reg.disabled.add(arg);
            addLine("info", `${arg} -> ${reg.disabled.has(arg) ? "off" : "on"}`);
          } else {
            addLine("info", "tools: " + listTools().map((t) => `${t.name}[${reg.disabled.has(t.name) ? "off" : "on"}]`).join("  "));
          }
          return;
        }
        case "/init":
          addLine("info", initProject());
          return;
        case "/skills":
          addLine("info", "skills: " + (listSkills().map((s) => s.name).join(", ") || "(none in ~/.neko-core/skills)"));
          return;
        case "/skill": {
          const name = text.split(/\s+/)[1];
          if (!name) {
            addLine("info", "usage: /skill <name>  ·  /skills to list");
            return;
          }
          const skill = loadSkill(name);
          if (!skill) {
            addLine("info", `unknown skill '${name}' - /skills to list`);
            return;
          }
          agentRef.current!.appendSystem(`# Skill: ${skill.name}\n${skill.body}`);
          addLine("info", `loaded skill: ${skill.name}`);
          return;
        }
        case "/clear":
          agentRef.current!.messages = [];
          setLines([{ id: idRef.current++, kind: "info", text: "(cleared)" }]);
          return;
        case "/compact": {
          setBusy(true);
          try {
            await agentRef.current!.compact();
            addLine("info", "(context compacted)");
          } catch (error) {
            addLine("info", `error: ${error instanceof Error ? error.message : error}`);
          } finally {
            setBusy(false);
          }
          return;
        }
        case "/reset":
          agentRef.current!.messages = [];
          addLine("info", "(conversation reset)");
          return;
        default:
          addLine("info", `unknown command ${cmd} - try /help`);
          return;
      }
    }

    // @file mentions: expand @path into file context (read_file is safe).
    let toSend = text;
    const mentions = text.match(/@\S+/g);
    if (mentions) {
      for (const m of [...new Set(mentions)]) {
        const p = m.slice(1).replace(/[)\].,;:]+$/, "");
        if (p) toSend += `\n\n[@${p}]\n${await registryRef.current!.execute("read_file", { path: p })}`;
      }
    }
    addLine("user", text);
    setBusy(true);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const result = await agentRef.current!.run(toSend, controller.signal);
      const streamed = streamRef.current.trim().length > 0;
      flushStream();
      if (result === "[interrupted]") addLine("info", "(interrupted)");
      else if (!streamed && result.trim()) addLine("assistant", result); // non-streaming provider
    } catch (error) {
      flushStream();
      addLine("info", `error: ${error instanceof Error ? error.message : error}`);
    } finally {
      setBusy(false);
      controllerRef.current = null;
      persist();
      const next = queueRef.current.shift();
      setQueued(queueRef.current.length);
      if (next !== undefined) void handle(next); // drain queued input
    }
  };

  const onSubmit = (value: string) => {
    setInput("");
    if (value.endsWith("\\")) {
      multilineRef.current += value.slice(0, -1) + "\n";
      setPendingMulti(true);
      return;
    }
    const text = (multilineRef.current + value).trim();
    multilineRef.current = "";
    setPendingMulti(false);
    if (!text) return;
    historyRef.current.push(text);
    historyPos.current = historyRef.current.length;
    if (busy) {
      // Queue input typed while a turn is running; drained when it finishes.
      queueRef.current.push(text);
      setQueued(queueRef.current.length);
      addLine("info", `queued: ${trunc(text, 60)}`);
      return;
    }
    void handle(text);
  };

  const renderLine = (line: Line) => {
    switch (line.kind) {
      case "welcome":
        return (
          <Box key={line.id} flexDirection="column" marginBottom={1}>
            <Text>
              <Logo />  <Text bold>Neko Code</Text> <Text dimColor>v{VERSION}</Text>
            </Text>
            <Text dimColor>{(cfg.model || "no model").split("/").pop()} · {cfg.provider} · {cfg.profile ?? "no profile"}</Text>
            <Text dimColor>{process.cwd()}</Text>
          </Box>
        );
      case "user":
        return <Text key={line.id} color="cyan">{"> "}{line.text}</Text>;
      case "assistant":
        return (
          <Box key={line.id} flexDirection="column" marginTop={1} marginBottom={1}>
            <Markdown text={line.text} />
          </Box>
        );
      case "tool_call":
        return <Text key={line.id}><Text color="green">● </Text>{line.text}</Text>;
      case "tool_result": {
        const resultLines = line.text.split("\n");
        return (
          <Box key={line.id} flexDirection="column">
            {resultLines.map((l, i) => {
              const add = l.startsWith("+");
              const del = l.startsWith("-");
              return (
                <Text key={i} color={add ? "green" : del ? "red" : undefined} dimColor={!add && !del}>
                  {(i === 0 ? "  ⎿ " : "     ") + l}
                </Text>
              );
            })}
          </Box>
        );
      }
      default:
        return <Text key={line.id} color="gray">{line.text}</Text>;
    }
  };

  return (
    <Box flexDirection="column">
      <Static items={lines}>{renderLine}</Static>

      {stream ? <Markdown text={stream} /> : null}

      {todos.length ? (
        <Box flexDirection="column" marginTop={1}>
          {todos.map((t, i) => (
            <Text key={i} color={t.status === "completed" ? "green" : t.status === "in_progress" ? "yellow" : "gray"}>
              {t.status === "completed" ? " [x] " : t.status === "in_progress" ? " [~] " : " [ ] "}
              {t.content}
            </Text>
          ))}
        </Box>
      ) : null}

      {approval ? (
        <ApprovalBox approval={approval} />
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>{"─".repeat(Math.max(10, cols - 1))}</Text>
          <Box>
            <Text color={busy ? "gray" : "cyan"}>{pendingMulti ? "... " : "> "}</Text>
            <TextInput
              value={input}
              onChange={setInput}
              onSubmit={onSubmit}
              placeholder={busy ? "type to queue while it works..." : 'Try: "explain src/agent.ts"   or   /help'}
            />
          </Box>
          {input.startsWith("/") ? (
            <Box flexDirection="column" paddingLeft={2}>
              {SLASH.filter((c) => c.name.startsWith(input.split(/\s+/)[0])).map((c) => (
                <Text key={c.name} color="gray">{c.name}  <Text dimColor>{c.desc}</Text></Text>
              ))}
            </Box>
          ) : (
            <Box justifyContent="space-between">
              {busy ? (
                <Text color="gray">
                  <Spinner type="line" /> working {elapsed}s{step > 1 ? ` · step ${step}` : ""}
                  {queued > 0 ? ` · ${queued} queued` : ""} · esc to interrupt
                </Text>
              ) : (
                <Text color={MODE_COLOR[mode]}>{mode} · shift+tab to cycle</Text>
              )}
              <Text dimColor>
                {(cfg.model || "").split("/").pop()} · {agentRef.current!.cost.totalTokens} tok ·{" "}
                {Math.max(0, Math.round((100 * (cfg.contextWindow - agentRef.current!.cost.lastPrompt)) / cfg.contextWindow))}% ctx
              </Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

export function ApprovalBox({ approval }: { approval: Approval }) {
  const { toolName, args } = approval;
  const preview: any[] = [];
  if (toolName === "bash") {
    preview.push(<Text key="c" color="white">{"$ "}{trunc(args.command, 200)}</Text>);
  } else if (toolName === "write_file") {
    const content = String(args.content ?? "");
    preview.push(<Text key="p" color="gray">write {args.path} ({content.length} chars)</Text>);
    content.split("\n").slice(0, 8).forEach((l, i) => preview.push(<Text key={`l${i}`} color="green">{"+ "}{l}</Text>));
  } else if (toolName === "edit") {
    preview.push(<Text key="p" color="gray">edit {args.path}</Text>);
    preview.push(<Text key="o" color="red">{"- "}{trunc(args.old_string, 160)}</Text>);
    preview.push(<Text key="n" color="green">{"+ "}{trunc(args.new_string, 160)}</Text>);
  } else {
    preview.push(<Text key="a" color="gray">{trunc(JSON.stringify(args), 200)}</Text>);
  }
  return (
    <Box borderStyle="classic" borderColor="yellow" paddingX={1} flexDirection="column">
      <Text bold color="yellow">Approve {toolName}?</Text>
      {preview}
      <Text color="gray">[y]es   [a]lways allow {toolName}   [n]o / Esc</Text>
    </Box>
  );
}

export async function runChat(opts: { profile?: string; yolo: boolean; resume?: boolean }): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('neko needs an interactive terminal (TTY) for the session. Use `neko run "<task>"` for one-shot.');
    return;
  }
  const cfg = loadConfig({ profile: opts.profile });
  const hub = await buildMcpHub(cfg.mcpServers);
  const app = render(<ChatApp profile={opts.profile} yolo={opts.yolo} resume={opts.resume} mcpHub={hub} />, {
    exitOnCtrlC: false, // we require a double Ctrl-C
  });
  try {
    await app.waitUntilExit();
  } finally {
    await hub.close();
  }
}
