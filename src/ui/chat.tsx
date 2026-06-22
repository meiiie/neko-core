/**
 * `neko chat` — the Ink (React-for-terminal) REPL. The "Neko Code" UX surface.
 *
 * Clean-room reimplementation of the terminal-coding-agent UX pattern: streaming render,
 * interleaved tool-call lines, inline approval prompt, thinking spinner, slash commands,
 * input history (up/down), and multiline (trailing `\` continuation). Reuses one Agent
 * across turns for conversation memory.
 */
import { Box, render, Static, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { useRef, useState } from "react";

import { Agent, DEFAULT_SYSTEM_PROMPT } from "../agent.ts";
import { loadConfig } from "../config.ts";
import { projectContextBlock } from "../context.ts";
import { nextMode, type PermissionMode } from "../permissions.ts";
import { initProject } from "../project.ts";
import { getProvider } from "../providers.ts";
import { latestSession, newSessionId, saveSession, type Session } from "../session.ts";
import { ToolRegistry } from "../tool-runtime.ts";
import { VERSION } from "../version.ts";

type LineKind = "user" | "assistant" | "tool" | "info";
interface Line {
  id: number;
  kind: LineKind;
  text: string;
}
interface Approval {
  toolName: string;
  action: string;
  resolve: (ok: boolean) => void;
}

const COLOR: Record<LineKind, string> = { user: "cyan", assistant: "white", tool: "gray", info: "gray" };
const PREFIX: Record<LineKind, string> = { user: "› ", assistant: "", tool: "  ", info: "" };

const HELP = [
  "Commands:",
  "  /help            show this help",
  "  /cost            show token usage this session",
  "  /model           show the active provider/model/profile",
  "  /profiles        list configured profiles",
  "  /init            scaffold ./.neko-core/config.json",
  "  /clear           clear the transcript + conversation context",
  "  /reset           clear conversation context (keep transcript)",
  "  /exit            quit (also Ctrl-C)",
  "Input: ↑/↓ history · end a line with \\ to continue (multiline).",
  "Shift+Tab: cycle permission mode (default → accept-edits → plan → auto).",
].join("\n");

interface ChatProps {
  profile?: string;
  yolo: boolean;
  resume?: boolean;
}

function ChatApp({ profile, yolo, resume }: ChatProps) {
  const { exit } = useApp();
  const cfg = useRef(loadConfig({ profile })).current;
  const idRef = useRef(0);
  const streamRef = useRef("");
  const alwaysApproved = useRef<Set<string>>(new Set());
  const historyRef = useRef<string[]>([]);
  const historyPos = useRef(0);
  const multilineRef = useRef("");
  const resumedRef = useRef<Session | null>(resume ? latestSession(process.cwd()) : null);
  const sessionIdRef = useRef(resumedRef.current?.id ?? newSessionId());
  const createdAtRef = useRef(resumedRef.current?.createdAt ?? new Date().toISOString());

  const [lines, setLines] = useState<Line[]>(() => {
    const banner: Line = {
      id: idRef.current++,
      kind: "info",
      text:
        `Neko Code ${VERSION}  provider=${cfg.provider} model=${cfg.model || "(unset)"} ` +
        `profile=${cfg.profile ?? "none"} mode=${yolo ? "auto" : cfg.mode}\n` +
        "Type a task, or /help for commands. Shift+Tab cycles permission mode.",
    };
    if (!resumedRef.current) return [banner];
    return [
      banner,
      {
        id: idRef.current++,
        kind: "info",
        text: `(resumed session ${resumedRef.current.id} — ${resumedRef.current.messages.length} messages)`,
      },
    ];
  });
  const [stream, setStream] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [pendingMulti, setPendingMulti] = useState(false);
  const [mode, setMode] = useState<PermissionMode>(yolo ? "auto" : cfg.mode);

  const addLine = (kind: LineKind, text: string) =>
    setLines((prev) => [...prev, { id: idRef.current++, kind, text }]);

  const flushStream = () => {
    if (streamRef.current.trim()) addLine("assistant", streamRef.current.trimEnd());
    streamRef.current = "";
    setStream("");
  };

  const gate = (toolName: string, action: string): boolean | Promise<boolean> => {
    if (alwaysApproved.current.has(toolName)) return true;
    return new Promise<boolean>((resolve) => setApproval({ toolName, action, resolve }));
  };

  const registryRef = useRef<ToolRegistry | null>(null);
  if (!registryRef.current) {
    registryRef.current = new ToolRegistry(process.cwd(), yolo ? "auto" : cfg.mode, gate);
  }

  const agentRef = useRef<Agent | null>(null);
  if (!agentRef.current) {
    const block = projectContextBlock();
    agentRef.current = new Agent({
      provider: getProvider(cfg),
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
          addLine("tool", `→ ${data.name}(${a.command ?? a.path ?? a.pattern ?? ""})`);
        } else if (kind === "tool_result") {
          let obs = String(data.observation).replace(/\s+/g, " ");
          if (obs.length > 160) obs = obs.slice(0, 160) + "…";
          addLine("tool", `  ${obs}`);
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

  // Approval keys (y / a=always / n), active only while an approval is pending.
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

  // History navigation (↑/↓) + Shift+Tab mode cycling, active while the input box shows.
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
          addLine(
            "info",
            `provider=${cfg.provider} model=${cfg.model || "(unset)"} profile=${cfg.profile ?? "none"} ` +
              "(switch with --profile NAME at launch, or edit ~/.neko-core/config.json)",
          );
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
          addLine("info", `unknown command ${cmd} — try /help`);
          return;
      }
    }

    addLine("user", text);
    setBusy(true);
    try {
      await agentRef.current!.run(text);
      flushStream();
    } catch (error) {
      flushStream();
      addLine("info", `error: ${error instanceof Error ? error.message : error}`);
    } finally {
      setBusy(false);
      persist(); // save the conversation after each turn
    }
  };

  const onSubmit = (value: string) => {
    setInput("");
    // Multiline: a trailing backslash continues input on the next line.
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

  return (
    <Box flexDirection="column">
      <Static items={lines}>
        {(line) => (
          <Text key={line.id} color={COLOR[line.kind]}>
            {PREFIX[line.kind]}
            {line.text}
          </Text>
        )}
      </Static>
      {stream ? <Text>{stream}</Text> : null}
      {busy && !approval ? (
        <Text color="gray">
          <Spinner type="dots" /> thinking…
        </Text>
      ) : null}
      {approval ? (
        <Text color="yellow">
          approve {approval.toolName}: {approval.action}?  [y]es / [a]lways / [n]o
        </Text>
      ) : (
        <Box>
          <Text color="cyan">{pendingMulti ? "…> " : `neko [${mode}]> `}</Text>
          <TextInput value={input} onChange={setInput} onSubmit={onSubmit} />
        </Box>
      )}
    </Box>
  );
}

export async function runChat(opts: { profile?: string; yolo: boolean; resume?: boolean }): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('neko chat needs an interactive terminal (TTY). Use `neko run "<task>"` for one-shot.');
    return;
  }
  const app = render(<ChatApp profile={opts.profile} yolo={opts.yolo} resume={opts.resume} />);
  await app.waitUntilExit();
}
