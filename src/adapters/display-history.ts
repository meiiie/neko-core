/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Decode and validate untrusted on-disk transcript chunks at the I/O boundary. */
/** Immutable content-addressed display chunks, read backwards without parsing the full transcript. */
import { createHash, randomUUID } from "node:crypto";
import { constants, existsSync, lstatSync, mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { validDisplayHistoryRef, type DisplayEntry, type DisplayHistoryCursor, type DisplayHistoryPage, type DisplayHistoryRef, type DisplayKind } from "../core/display-history.ts";

const HASH = /^[a-f0-9]{64}$/;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
const TARGET_CHUNK_BYTES = 256 * 1024;
const KINDS = new Set<DisplayKind>(["user", "assistant", "tool_call", "tool_result", "info"]);
interface Chunk { version: 1; scope: string; parent: string | null; entries: DisplayEntry[] }
export interface DisplayScope { sessionId: string; taskId?: string; root: string }
const hash = (raw: string | Buffer) => createHash("sha256").update(raw).digest("hex");

export class DisplayHistory {
  private readonly directory: string;
  private readonly scope: string;
  private head: string | null;
  private checkpoint: DisplayHistoryRef["checkpoint"];
  private pending: DisplayEntry[] = [];
  private pendingBytes = 0;
  private queue: Promise<void> = Promise.resolve();
  private failure: Error | null = null;

  constructor(private readonly home: string, identity: DisplayScope, reference?: DisplayHistoryRef) {
    if (!isAbsolute(home) || !isAbsolute(identity.root) || !identity.sessionId
      || identity.sessionId.length > 128 || (identity.taskId?.length ?? 0) > 128) throw new Error("Invalid display history scope");
    this.scope = hash(JSON.stringify([identity.sessionId, identity.taskId ?? null, resolve(identity.root)]));
    if (reference && (!validDisplayHistoryRef(reference) || reference.scope !== this.scope)) throw new Error("Display history belongs to another session, task or root");
    this.head = reference?.head ?? null;
    this.checkpoint = reference?.checkpoint ? {...reference.checkpoint} : undefined;
    this.directory = join(resolve(home), ".neko-core", "display-history");
  }

  reference(): DisplayHistoryRef {
    const reference: DisplayHistoryRef = {version: 1, scope: this.scope, head: this.head};
    if (this.checkpoint) reference.checkpoint = {...this.checkpoint};
    return reference;
  }

  /** Call only after display flush and capture this reference with the same working messages. */
  captureCheckpoint(messages: unknown[], complete = true): DisplayHistoryRef {
    this.checkpoint = complete ? {count: messages.length, digest: displayCheckpointDigest(messages)} : undefined;
    return this.reference();
  }

  /** Capture immutable text before rendering or working-context compaction can shorten it. */
  append(kind: DisplayKind, text: string, summary?: string, failed?: boolean): void {
    if (this.failure) throw this.failure;
    if (!KINDS.has(kind) || typeof text !== "string") throw new Error("Invalid display entry");
    const entry: DisplayEntry = { id: randomUUID(), kind, text };
    if (summary !== undefined) entry.summary = summary;
    if (failed) entry.failed = true;
    const bytes = Buffer.byteLength(JSON.stringify(entry));
    if (bytes > MAX_CHUNK_BYTES - 512) throw new Error("Display entry exceeds the history storage limit; text was not truncated");
    if (this.pending.length && (this.pendingBytes + bytes > TARGET_CHUNK_BYTES || this.pending.length >= 32)) this.enqueue();
    this.pending.push(entry);
    this.pendingBytes += bytes;
  }

  /** Persist chunks first. The caller stores this reference atomically with its working checkpoint. */
  async flush(): Promise<DisplayHistoryRef> {
    this.enqueue();
    await this.queue;
    if (this.failure) throw this.failure;
    return this.reference();
  }

  async reset(): Promise<void> { await this.flush(); this.head = null; this.checkpoint = undefined; }

  private enqueue(): void {
    if (!this.pending.length) return;
    const entries = this.pending;
    this.pending = [];
    this.pendingBytes = 0;
    this.queue = this.queue.then(async () => {
      if (this.failure) return;
      try {
        this.checkDirectory(true);
        const chunk: Chunk = { version: 1, scope: this.scope, parent: this.head, entries };
        const raw = JSON.stringify(chunk);
        if (Buffer.byteLength(raw) > MAX_CHUNK_BYTES) throw new Error("Display chunk exceeds storage limit");
        const id = hash(raw);
        const path = join(this.directory, `${id}.json`);
        const file = await open(path, "wx", 0o600);
        try { await file.writeFile(raw, "utf8"); await file.sync(); }
        finally { await file.close(); }
        this.head = id;
      } catch (error) {
        this.failure = error instanceof Error ? error : new Error(String(error));
      }
    });
  }

  /** A page is in chronological order. The cursor retains the exact frozen chunk boundary. */
  async page(cursor: DisplayHistoryCursor | null = this.head ? { chunk: this.head } : null, limit = 64): Promise<DisplayHistoryPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw new Error("Invalid history page size");
    const backwards: DisplayEntry[] = [];
    const seen = new Set<string>();
    let at = cursor;
    let bytes = 0;
    while (at && backwards.length < limit) {
      if (!HASH.test(at.chunk) || seen.has(at.chunk)) throw new Error("Invalid or cyclic history cursor");
      seen.add(at.chunk);
      const chunk = await this.read(at.chunk);
      const before = at.before ?? chunk.entries.length;
      if (!Number.isSafeInteger(before) || before < 0 || before > chunk.entries.length) throw new Error("Invalid history entry cursor");
      let i = before - 1;
      for (; i >= 0 && backwards.length < limit; i--) {
        const entry = chunk.entries[i];
        const size = Buffer.byteLength(entry.text) + Buffer.byteLength(entry.summary ?? "");
        if (backwards.length && bytes + size > TARGET_CHUNK_BYTES) break;
        backwards.push({ ...entry }); bytes += size;
      }
      at = i >= 0 ? { chunk: at.chunk, before: i + 1 } : chunk.parent ? { chunk: chunk.parent } : null;
      if (bytes >= TARGET_CHUNK_BYTES || (at && at.chunk === cursor?.chunk && at.before === before)) break;
      // A byte-limited partial chunk must return, not be mistaken for a cycle next iteration.
      if (i >= 0) break;
    }
    return { entries: backwards.reverse(), older: at };
  }

  private checkDirectory(create: boolean): void {
    for (const path of [resolve(this.home), join(resolve(this.home), ".neko-core"), this.directory]) {
      if (create && !existsSync(path)) mkdirSync(path, { mode: 0o700 });
      if (!lstatSync(path).isDirectory()) throw new Error("Display history directory cannot be a link or non-directory");
    }
  }

  private async read(id: string): Promise<Chunk> {
    this.checkDirectory(false);
    const path = join(this.directory, `${id}.json`);
    const before = lstatSync(path);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_CHUNK_BYTES) throw new Error("Unsafe display history file");
    const file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    let raw: string;
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error("Display history changed during read");
      raw = await file.readFile("utf8");
      if (hash(raw) !== id) throw new Error("Display history integrity check failed");
    } finally { await file.close(); }
    const value: unknown = JSON.parse(raw);
    if (!validChunk(value, this.scope)) throw new Error("Invalid or cross-task display history chunk");
    return value;
  }
}

function validChunk(value: unknown, scope: string): value is Chunk {
  if (!value || typeof value !== "object") return false;
  // SAFETY: value is an object; all chunk and entry fields are validated below.
  const chunk = value as Chunk;
  return chunk.version === 1 && chunk.scope === scope && (chunk.parent === null || (typeof chunk.parent === "string" && HASH.test(chunk.parent)))
    && Array.isArray(chunk.entries) && chunk.entries.length > 0 && chunk.entries.length <= 32
    && chunk.entries.every((entry) => entry && typeof entry.id === "string" && /^[a-f0-9-]{36}$/.test(entry.id)
      && KINDS.has(entry.kind) && typeof entry.text === "string"
      && (entry.summary === undefined || typeof entry.summary === "string") && (entry.failed === undefined || typeof entry.failed === "boolean"));
}

/** A digest is coverage metadata, never recovered model context or source authority. */
export function displayCheckpointDigest(messages: unknown[]): string {
  return hash(JSON.stringify(messages));
}
