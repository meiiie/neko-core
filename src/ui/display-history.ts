import { DisplayHistory, displayCheckpointDigest, type DisplayScope } from "../adapters/display-history.ts";
import type { DisplayEntrySeed, DisplayHistoryRef } from "../core/display-history.ts";
import type { Session } from "../adapters/session.ts";
import { buildReplayLines } from "./chat-lines.ts";

/** Seed only the public checkpoint projection when upgrading a legacy session. */
export async function createDisplayHistory(home: string, scope: DisplayScope, messages: Session["messages"], reference?: DisplayHistoryRef, pending: DisplayEntrySeed[] = []): Promise<DisplayHistory> {
  const checkpointMessages = messages;
  const history = new DisplayHistory(home, scope, reference);
  if (reference?.head) {
    for (const entry of pending) history.append(entry.kind, entry.text, entry.summary, entry.failed);
    const covered = reference.checkpoint;
    if (covered && covered.count <= messages.length
      && displayCheckpointDigest(messages.slice(0, covered.count)) === covered.digest) {
      if (covered.count === messages.length) {
        if (pending.length) await history.flush();
        return history;
      }
      messages = messages.slice(covered.count);
    } else {
      // Another client may have compacted or rewritten its checkpoint. Keep the immutable archive
      // and label the available snapshot; never guess an overlap and silently drop repeated text.
      history.append("info", "Recovered saved checkpoint. Earlier archived history is retained; this snapshot may overlap it. Content discarded before saving cannot be reconstructed.");
    }
  }
  let id = 0;
  const lines = buildReplayLines(messages, () => ++id, {mode: "resume", preserveContent: true});
  let count = 0;
  for (const line of lines) {
    if (line.kind === "user" || line.kind === "assistant" || line.kind === "tool_call" || line.kind === "tool_result" || (line.kind === "info" && line.text.includes("intermediate progress update"))) {
      history.append(line.kind, line.text, line.summary, line.failed);
    }
    if (++count % 64 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  await history.flush();
  history.captureCheckpoint(checkpointMessages);
  return history;
}
