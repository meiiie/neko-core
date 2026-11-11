/* eslint-disable anti-slop/no-unknown-type-aliases -- Task snapshots cross an existing unknown-valued persistence boundary. */
/** Bounded original-evidence extraction. Does not scan another task or reconstruct truth from compaction. */
import { assertTaskScope } from "../core/task-scope.ts";
import { assertDreamTextSafe, DREAM_INPUT_BYTES, DREAM_NOTE, dreamDigest, type DreamInput, type DreamSource } from "../core/dream.ts";
import { isJsonObject, isText } from "../shared/wire.ts";
import { memoryEnabled } from "../core/memory.ts";
import type { TaskRuntimeInput } from "./task-session.ts";
import { PagedSources } from "./context/paged-sources.ts";
import { parseGroup } from "../core/context/structured-sources.ts";
import { isInternalUserMessage } from "../core/message-origin.ts";
import { DisplayHistory, displayCheckpointDigest } from "./display-history.ts";
import { DreamStore, snapshotDreamMemories } from "./dream-store.ts";

export async function buildDreamInput(home: string, task: TaskRuntimeInput, secrets: readonly string[] = []): Promise<DreamInput> {
  assertTaskScope(task.scope);
  if (!memoryEnabled(home)) throw new Error("Memory is off");
  if (task.taskId !== task.scope.id || task.root !== task.scope.canonicalRoot) throw new Error("Dream task binding mismatch");
  const memories = snapshotDreamMemories(home, task.scope);
  const sources: DreamSource[] = [];
  const retained: DreamSource[] = [];
  const seen = new Set<string>();
  let bytes = Buffer.byteLength(JSON.stringify(memories)), omitted = 0, hasOlder = false;
  let origin: DreamInput["coverage"]["origin"] = "messages";
  const previousNote = memories.find(memory => memory.name === DREAM_NOTE);
  if (previousNote) {
    const id = previousNote.content.match(/<!-- neko-dream:v1:([a-f0-9]{64}) -->/)?.[1];
    const store = new DreamStore(home, task.scope);
    if (!id || store.status(id) !== "applied") throw new Error("Existing dream memory needs review before consolidation");
    const previous = store.read(id);
    const cited = new Set(previous.proposal.claims.flatMap(claim => claim.citations.map(citation => citation.sourceId)));
    for (const source of previous.input.sources.filter(source => cited.has(source.id))) {
      assertDreamTextSafe(source.text, secrets);
      bytes += Buffer.byteLength(JSON.stringify(source));
      if (bytes > DREAM_INPUT_BYTES - 8000) throw new Error("Prior cited dream evidence exceeds the next-pass budget; review/prune it explicitly first");
      retained.push(source);
    }
  }
  const add = (kind: DreamSource["kind"], text: string, locator: string) => {
    // Check before omission: a secret-bearing source is not quietly treated as a successful pass.
    assertDreamTextSafe(text, secrets);
    if (!text.trim()) return;
    const key = dreamDigest(JSON.stringify([kind, text]));
    if (seen.has(key)) return;
    seen.add(key);
    const source: DreamSource = { id: `${locator}:${dreamDigest(text)}`, kind, text };
    const size = Buffer.byteLength(JSON.stringify(source));
    if (sources.length + retained.length >= 128 || bytes + size > DREAM_INPUT_BYTES - 4000) { omitted++; return; }
    sources.push(source); bytes += size;
  };
  const messages = (values: readonly unknown[], prefix: string) => {
    const tools = new Map<string, { name: string; path: string }>();
    for (const value of values) {
      if (!isJsonObject(value) || value.role !== "assistant" || !Array.isArray(value.tool_calls)) continue;
      for (const call of value.tool_calls) {
        if (!isJsonObject(call) || !isText(call.id) || !isJsonObject(call.function) || !isText(call.function.name)) continue;
        let args = call.function.arguments;
        if (isText(args)) { try { args = JSON.parse(args); } catch { continue; } }
        tools.set(call.id, { name: call.function.name, path: isJsonObject(args) && isText(args.path) ? args.path : "" });
      }
    }
    for (let i = values.length - 1; i >= 0; i--) {
      const message = values[i];
      if (!isJsonObject(message) || isInternalUserMessage(message) || message._neko_internal === true || message._neko_source_clipped === true) continue;
      if (message.role !== "user" && message.role !== "assistant" && message.role !== "tool") continue;
      const text = isText(message.content) ? message.content : Array.isArray(message.content)
        ? message.content.filter(isJsonObject).filter(part => part.type === "text" && isText(part.text)).map(part => part.text).join("\n") : "";
      if (message.role === "tool") {
        const call = isText(message.tool_call_id) ? tools.get(message.tool_call_id) : undefined;
        if (!call || ["memory", "workflow", "playbook", "context_source"].includes(call.name)
          || /(?:^|[\\/])(?:memory|workflows|playbook|\.dreams)(?:[\\/]|$)/i.test(call.path)) { omitted++; continue; }
        add("tool", text, `${prefix}-${i}-${call.name.slice(0, 32)}`);
      } else add(message.role, text, `${prefix}-${i}`);
    }
  };
  if (task.contextState?.journal.head) {
    origin = "journal";
    messages(task.messages, "current");
    const journal = new PagedSources(home, task.scope, task.contextState.journal);
    let cursor: string | null = task.contextState.journal.head;
    let groups = 0;
    while (cursor && groups < 64 && sources.length + retained.length < 128 && bytes < DREAM_INPUT_BYTES - 4000) {
      const page = journal.page(cursor, 1);
      for (const chunk of page.sources) {
        const group = parseGroup(task.scope, chunk);
        // Runtime-origin summaries cannot acquire the authority of original user speech.
        if (group.origin === "user") messages(group.messages, `journal-${group.sequence}`);
        else omitted += group.messages.length;
        groups++;
      }
      cursor = page.older;
    }
    hasOlder = cursor !== null;
  } else if (task.displayHistory?.head) {
    origin = "display";
    const covered = task.displayHistory.checkpoint;
    const exactPrefix = covered && covered.count <= task.messages.length
      && displayCheckpointDigest(task.messages.slice(0, covered.count)) === covered.digest;
    // CLI/ACP may append after the last UI checkpoint. Include that tail; if history was rewritten,
    // retain the available native snapshot as well rather than silently losing a new correction.
    messages(exactPrefix ? task.messages.slice(covered.count) : task.messages, "current");
    for (let i = (task.displayPending?.length ?? 0) - 1; i >= 0; i--) {
      const entry = task.displayPending![i];
      if (entry.kind === "user" || entry.kind === "assistant") {
        if (!isInternalUserMessage({ role: entry.kind, content: entry.text })) add(entry.kind, entry.text, `pending-${i}`);
      } else if (entry.kind === "tool_result") omitted++;
    }
    const history = new DisplayHistory(home, { sessionId: task.sessionId, taskId: task.taskId, root: task.root }, task.displayHistory);
    const page = await history.page(undefined, 128);
    for (const entry of [...page.entries].reverse()) {
      if (entry.kind === "user" || entry.kind === "assistant") {
        if (!isInternalUserMessage({ role: entry.kind, content: entry.text })) add(entry.kind, entry.text, `display-${entry.id}`);
      } else if (entry.kind === "tool_result") omitted++; // Display records lack a native tool/path binding.
    }
    hasOlder = page.older !== null;
  } else {
    messages(task.messages, "message");
    // Original successful/failed read observations remain useful even after working-history compaction.
    for (const event of [...task.sourceEvents].reverse()) {
      if (event.taskId !== task.taskId || event.canonicalRoot !== task.root) throw new Error("Foreign dream source event");
      if (!event.verifiedPath || /(?:^|[\\/])(?:memory|workflows|playbook|\.dreams)(?:[\\/]|$)/i.test(event.verifiedPath)) { omitted++; continue; }
      if (isText(event.result.content)) add("tool", event.result.content, `read-${event.id}`);
    }
  }
  const recent = sources.reverse();
  const recentKeys = new Set(recent.map(source => dreamDigest(JSON.stringify([source.kind, source.text]))));
  const older = retained.filter(source => !recentKeys.has(dreamDigest(JSON.stringify([source.kind, source.text]))));
  const combined = [...older, ...recent];
  const input: DreamInput = { version: 1, taskId: task.taskId, root: task.root,
    // Capture the complete selected task revision, not just the bounded visible window or timestamps.
    evidenceDigest: dreamDigest(JSON.stringify([task.messages, task.sourceEvents, task.contextState ?? null,
      task.displayHistory ?? null, task.displayPending ?? null])),
    sources: combined, memories, coverage: { origin, included: combined.length, omitted, hasOlder, retained: older.length } };
  assertDreamTextSafe(JSON.stringify(input), secrets);
  if (Buffer.byteLength(JSON.stringify(input)) > DREAM_INPUT_BYTES) throw new Error("Dream input exceeds budget");
  assertTaskScope(task.scope);
  if (!memoryEnabled(home)) throw new Error("Memory is off");
  return input;
}
