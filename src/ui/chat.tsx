/**
 * `neko chat` — the Ink (React-for-terminal) REPL. The "Neko Code" UX surface.
 *
 * Clean-room reimplementation of the terminal-coding-agent UX (welcome box, markdown
 * streaming, tool-call lines, inline approval with a diff preview, spinner + elapsed,
 * Esc-to-interrupt, slash commands, history, multiline, Shift+Tab modes). Reuses one Agent
 * for conversation memory. Kept ASCII-safe so it renders on any Windows console codepage.
 */
import { Box, render, Static, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { useEffect, useRef, useState } from "react";

import { Agent, DEFAULT_SYSTEM_PROMPT } from "../agent.ts";
import { loadConfig } from "../config.ts";
import { projectContextBlock } from "../context.ts";
import { buildMcpHub, type McpHub } from "../mcp.ts";
import { nextMode, type PermissionMode } from "../permissions.ts";
import { initProject } from "../project.ts";
import { getProvider, type Provider } from "../providers.ts";
import { latestSession, newSessionId, saveSession, type Session } from "../session.ts";
import { ToolRegistry } from "../tool-runtime.ts";
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
  "Input: Up/Down history; end a line with \\ to continue (multiline).",
  "Shift+Tab: cycle permission mode (default -> accept-edits -> plan -> auto).",
  "Esc: interrupt a running turn. Ctrl-C: quit.",
].join("\n");

function trunc(s: string, n = 120): string {
  const one = String(s).replace(/\s+/g, " ");
  return one.length > n ? one.slice(0, n) + "..." : one;
}

const SLASH: { name: string; desc: string }[] = [
  { name: "/help", desc: "show help" },
  { name: "/cost", desc: "token usage this session" },
  { name: "/model", desc: "active provider/model/mode" },
  { name: "/profiles", desc: "list profiles" },
  { name: "/init", desc: "scaffold ./.neko-core/config.json" },
  { name: "/clear", desc: "clear transcript + context" },
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
  const cfg = useRef(loadConfig({ profile })).current;
  const idRef = useRef(0);
  const streamRef = useRef("");
  const alwaysApproved = useRef<Set<string>>(new Set());
  const historyRef = useRef<string[]>([]);
  const historyPos = useRef(0);
  const multilineRef = useRef("");
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
          addLine("tool_result", trunc(data.observation, 160));
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
        case "/init":
          addLine("info", initProject());
          return;
        case "/clear":
          agentRef.current!.messages = [];
          setLines([{ id: idRef.current++, kind: "info", text: "(cleared)" }]);
          return;
        case "/reset":
          agentRef.current!.messages = [];
          addLine("info", "(conversation reset)");
          return;
        default:
          addLine("info", `unknown command ${cmd} - try /help`);
          return;
      }
    }

    addLine("user", text);
    setBusy(true);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const result = await agentRef.current!.run(text, controller.signal);
      flushStream();
      if (result === "[interrupted]") addLine("info", "(interrupted)");
    } catch (error) {
      flushStream();
      addLine("info", `error: ${error instanceof Error ? error.message : error}`);
    } finally {
      setBusy(false);
      controllerRef.current = null;
      persist();
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
    if (!text || busy) return;
    historyRef.current.push(text);
    historyPos.current = historyRef.current.length;
    void handle(text);
  };

  const renderLine = (line: Line) => {
    switch (line.kind) {
      case "welcome":
        return (
          <Box key={line.id} borderStyle="classic" borderColor="magenta" paddingX={1} flexDirection="column" marginBottom={1}>
            <Text bold>Neko Code {VERSION}</Text>
            <Text color="gray">provider={cfg.provider} model={cfg.model || "(unset)"} profile={cfg.profile ?? "none"} mode={yolo ? "auto" : cfg.mode}</Text>
            <Text color="gray">/help for commands - Shift+Tab modes - Esc interrupt - Ctrl-C quit</Text>
          </Box>
        );
      case "user":
        return <Text key={line.id} color="cyan">{"> "}{line.text}</Text>;
      case "assistant":
        return (
          <Box key={line.id} flexDirection="column">
            <Markdown text={line.text} />
          </Box>
        );
      case "tool_call":
        return <Text key={line.id}><Text color="green">{"* "}</Text>{line.text}</Text>;
      case "tool_result":
        return <Text key={line.id} color="gray">{"    "}{line.text}</Text>;
      default:
        return <Text key={line.id} color="gray">{line.text}</Text>;
    }
  };

  return (
    <Box flexDirection="column">
      <Static items={lines}>{renderLine}</Static>

      {stream ? <Text>{stream}</Text> : null}

      {approval ? (
        <ApprovalBox approval={approval} />
      ) : busy ? (
        <Text color="gray">
          <Spinner type="line" /> working {elapsed}s - {agentRef.current!.cost.totalTokens} tok - esc to interrupt
        </Text>
      ) : (
        <Box flexDirection="column">
          <Box borderStyle="classic" borderColor="cyan" paddingX={1}>
            <Text color="cyan">{pendingMulti ? "... " : `[${mode}] > `}</Text>
            <TextInput value={input} onChange={setInput} onSubmit={onSubmit} placeholder="Type a task, or /help" />
          </Box>
          {input.startsWith("/") ? (
            <Box flexDirection="column" paddingLeft={2}>
              {SLASH.filter((c) => c.name.startsWith(input.split(/\s+/)[0])).map((c) => (
                <Text key={c.name} color="gray">{c.name}  - {c.desc}</Text>
              ))}
            </Box>
          ) : null}
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
  const app = render(<ChatApp profile={opts.profile} yolo={opts.yolo} resume={opts.resume} mcpHub={hub} />);
  try {
    await app.waitUntilExit();
  } finally {
    await hub.close();
  }
}
