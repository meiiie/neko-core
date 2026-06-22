/**
 * `neko chat` — the Ink (React-for-terminal) REPL. The "Neko Code" UX surface.
 *
 * Clean-room reimplementation of the terminal-coding-agent UX pattern (streaming render,
 * interleaved tool-call lines, inline approval prompt, thinking spinner). Reuses one Agent
 * across turns for conversation memory.
 */
import { Box, render, Static, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import TextInput from "ink-text-input";
import { useRef, useState } from "react";

import { Agent } from "../agent.ts";
import { loadConfig } from "../config.ts";
import { getProvider } from "../providers.ts";
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

const COLOR: Record<LineKind, string> = {
  user: "cyan",
  assistant: "white",
  tool: "gray",
  info: "gray",
};
const PREFIX: Record<LineKind, string> = { user: "› ", assistant: "", tool: "  ", info: "" };

interface ChatProps {
  profile?: string;
  yolo: boolean;
}

function ChatApp({ profile, yolo }: ChatProps) {
  const { exit } = useApp();
  const cfg = useRef(loadConfig({ profile })).current;
  const idRef = useRef(1);
  const streamRef = useRef("");
  const alwaysApproved = useRef<Set<string>>(new Set());

  const [lines, setLines] = useState<Line[]>(() => [
    {
      id: 0,
      kind: "info",
      text:
        `Neko Code ${VERSION}  provider=${cfg.provider} model=${cfg.model || "(unset)"} ` +
        `profile=${cfg.profile ?? "none"} approval=${yolo ? "auto" : cfg.approval}\n` +
        "Type a task. /reset new conversation · /exit quit · Ctrl-C quit.",
    },
  ]);
  const [stream, setStream] = useState("");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<Approval | null>(null);

  const addLine = (kind: LineKind, text: string) =>
    setLines((prev) => [...prev, { id: idRef.current++, kind, text }]);

  const flushStream = () => {
    if (streamRef.current.trim()) addLine("assistant", streamRef.current.trimEnd());
    streamRef.current = "";
    setStream("");
  };

  // The approval gate: resolves when the user presses y/a/n (or auto under --yolo).
  const gate = (toolName: string, action: string): boolean | Promise<boolean> => {
    if (yolo || alwaysApproved.current.has(toolName)) return true;
    return new Promise<boolean>((resolve) => setApproval({ toolName, action, resolve }));
  };

  const agentRef = useRef<Agent | null>(null);
  if (!agentRef.current) {
    agentRef.current = new Agent({
      provider: getProvider(cfg),
      tools: new ToolRegistry(process.cwd(), gate),
      maxSteps: cfg.maxSteps,
      onDelta: (t) => {
        streamRef.current += t;
        setStream((s) => s + t);
      },
      onEvent: (kind, data) => {
        if (kind === "tool_call") {
          flushStream(); // commit any pre-tool text first (keeps transcript order)
          const a = data.arguments ?? {};
          addLine("tool", `→ ${data.name}(${a.command ?? a.path ?? a.pattern ?? ""})`);
        } else if (kind === "tool_result") {
          let obs = String(data.observation).replace(/\s+/g, " ");
          if (obs.length > 160) obs = obs.slice(0, 160) + "…";
          addLine("tool", `  ${obs}`);
        }
      },
    });
  }

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

  const submit = async (value: string) => {
    const text = value.trim();
    setInput("");
    if (!text || busy) return;
    if (text === "/exit" || text === "/quit") {
      exit();
      return;
    }
    if (text === "/reset") {
      agentRef.current!.messages = [];
      addLine("info", "(conversation reset)");
      return;
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
    }
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
          <Text color="cyan">neko&gt; </Text>
          <TextInput value={input} onChange={setInput} onSubmit={submit} />
        </Box>
      )}
    </Box>
  );
}

export async function runChat(opts: { profile?: string; yolo: boolean }): Promise<void> {
  if (!process.stdin.isTTY) {
    console.error('neko chat needs an interactive terminal (TTY). Use `neko run "<task>"` for one-shot.');
    return;
  }
  const app = render(<ChatApp profile={opts.profile} yolo={opts.yolo} />);
  await app.waitUntilExit();
}
