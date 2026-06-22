/**
 * `neko chat` — the Ink (React-for-terminal) REPL. The "Neko Code" UX surface.
 *
 * Clean-room reimplementation of the terminal-coding-agent UX (welcome box, markdown
 * streaming, tool-call lines, inline approval with a diff preview, spinner + elapsed,
 * Esc-to-interrupt, slash commands, history, multiline, Shift+Tab modes). Reuses one Agent
 * for conversation memory. Kept ASCII-safe so it renders on any Windows console codepage.
 */
import { Box, render, Static, Text, useApp, useInput, useStdout } from "ink";
import { useEffect, useRef, useState } from "react";

import { ApprovalBox, type Approval } from "./approval-box.tsx";
import { runSlashCommand, SLASH } from "./commands.ts";
import { trunc } from "./format.ts";
import { Markdown } from "./markdown.tsx";
import { SelectList, type Overlay } from "./select-list.tsx";
import { TextInput } from "./text-input.tsx";
import { ThinkingLine, VERBS } from "./thinking-line.tsx";
import { TranscriptLine, type Line, type LineKind } from "./transcript.tsx";

import { Agent, DEFAULT_SYSTEM_PROMPT } from "../core/agent.ts";
import { loadConfig } from "../adapters/config.ts";
import { projectContextBlock } from "../adapters/context.ts";
import { buildMcpHub, type McpHub } from "../adapters/mcp.ts";
import { nextMode, type PermissionMode } from "../core/permissions.ts";
import { getProvider, type Provider } from "../adapters/providers.ts";
import { latestSession, newSessionId, saveSession, type Session } from "../adapters/session.ts";
import { ToolRegistry } from "../core/tool-runtime.ts";
import { describeToolCall } from "../core/tools.ts";

export { ApprovalBox, type Approval }; // re-exported for tests

const MODE_COLOR: Record<PermissionMode, string> = {
  default: "gray",
  "accept-edits": "yellow",
  plan: "blue",
  auto: "red",
};

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
  const verbRef = useRef(VERBS[0]); // playful "thinking" verb, repicked each turn
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
  const [overlay, setOverlay] = useState<Overlay | null>(null);

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
    registryRef.current.hooks = cfg.hooks;
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
          addLine("tool_call", describeToolCall(data.name, data.arguments));
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

  // Load a session's history into the live agent (used by /resume and the picker).
  const resumeInto = (target: Session) => {
    agentRef.current!.messages = [...target.messages];
    sessionIdRef.current = target.id;
    createdAtRef.current = target.createdAt;
    addLine("info", `(resumed ${target.id} - ${target.messages.length} messages; context restored)`);
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
      // Approving a plan exits plan mode into accept-edits so the agent can implement it.
      const approvePlan = () => {
        if (approval.toolName === "exit_plan_mode" && registryRef.current!.mode === "plan") {
          registryRef.current!.mode = "accept-edits";
          setMode("accept-edits");
        }
      };
      if (c === "y") {
        approvePlan();
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
    { isActive: !busy && approval === null && overlay === null },
  );

  const handle = async (text: string) => {
    if (text.startsWith("/")) {
      await runSlashCommand(text, {
        cfg,
        agent: agentRef.current!,
        registry: registryRef.current!,
        busy,
        queue: queueRef.current,
        addLine,
        setLines,
        nextId: () => idRef.current++,
        setOverlay,
        setBusy,
        setQueued,
        resumeInto,
        runText: handle,
        exit,
      });
      return;
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
    verbRef.current = VERBS[Math.floor(Math.random() * VERBS.length)];
    setBusy(true);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const result = await agentRef.current!.run(toSend, controller.signal);
      const streamed = streamRef.current.trim().length > 0;
      flushStream();
      if (result === "[interrupted]") addLine("info", "(interrupted)");
      else if (!streamed && result.trim()) addLine("assistant", result); // non-streaming provider
      // Auto-compact when the context window is nearly full (Claude-style).
      if (result !== "[interrupted]" && agentRef.current!.cost.lastPrompt > 0.85 * cfg.contextWindow) {
        addLine("info", "(context nearly full - auto-compacting)");
        await agentRef.current!.compact();
      }
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

  return (
    <Box flexDirection="column">
      <Static items={lines}>{(line) => <TranscriptLine key={line.id} line={line} cfg={cfg} />}</Static>

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

      {busy && !approval ? (
        <Box marginTop={1}>
          <ThinkingLine
            verb={todos.find((t) => t.status === "in_progress")?.content ?? verbRef.current}
            elapsed={elapsed}
            tokens={agentRef.current!.cost.totalTokens}
            step={step}
            queued={queued}
          />
        </Box>
      ) : null}

      {overlay ? (
        <SelectList
          title={overlay.title}
          items={overlay.items}
          cols={cols}
          onSelect={overlay.onSelect}
          onCancel={() => {
            setOverlay(null);
            addLine("info", "(cancelled)");
          }}
        />
      ) : approval ? (
        <ApprovalBox approval={approval} />
      ) : (
        <Box flexDirection="column">
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
          <Text dimColor>{"─".repeat(Math.max(10, cols - 1))}</Text>
          {input.startsWith("/") ? (
            <Box flexDirection="column" paddingLeft={2}>
              {SLASH.filter((c) => c.name.startsWith(input.split(/\s+/)[0])).map((c) => (
                <Text key={c.name} color="gray">{c.name}  <Text dimColor>{c.desc}</Text></Text>
              ))}
            </Box>
          ) : (
            <Box justifyContent="space-between">
              <Text>
                <Text color={MODE_COLOR[mode]}>{mode}</Text>
                <Text dimColor> · shift+tab to cycle</Text>
              </Text>
              <Text color="#9a9a9a">
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
