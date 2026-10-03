/** Immutable on-disk source journal. The parent checkpoint owns the head; no mutable global tip. */
/* eslint-disable anti-slop/no-unknown-parameters -- Disk references and active-fact indexes are validated at this storage boundary. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { lstat as lstatAsync, open as openAsync, mkdir as mkdirAsync, rename as renameAsync, unlink as unlinkAsync } from "node:fs/promises";
import { assertTaskScope, type TaskScope } from "../../core/task-scope.ts";
import { isJsonObject, isText } from "../../shared/wire.ts";
import type { EvidenceChunk } from "../../core/context/projection.ts";
import { advanceStructuredFacts, parseGroup, type CurrentFact } from "../../core/context/structured-sources.ts";

const HASH = /^[a-f0-9]{64}$/;
const MAX_OBJECT_BYTES = 4 * 1024 * 1024;
const CACHE_BYTES = 2 * 1024 * 1024;
const MAX_ACTIVE_FACTS = 512;
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export interface SourceJournalRef { version: 1; scope: string; head: string | null }
export interface SourceJournalPage { sources: EvidenceChunk[]; older: string | null }
export function validSourceJournalRef(value: unknown): value is SourceJournalRef {
  return isJsonObject(value) && value.version === 1 && isText(value.scope) && HASH.test(value.scope)
    && (value.head === null || (isText(value.head) && HASH.test(value.head)));
}
interface Head { version: 1; scope: string; previous: string | null; sourceId: string; revision: number; sequence: number; facts: CurrentFact[] }

export class PagedSources {
  private readonly scopeId: string;
  private readonly folder: string;
  private head: string | null;
  private state: Head | null = null;
  private readonly cache = new Map<string, {chunk: EvidenceChunk; bytes: number}>();
  private cacheBytes = 0;

  constructor(private readonly home: string, private readonly scope: TaskScope, reference?: SourceJournalRef) {
    assertTaskScope(scope);
    if (!isAbsolute(home)) throw new Error("Source journal home must be absolute");
    this.scopeId = hash(JSON.stringify([scope.id, scope.canonicalRoot, scope.executionAuthorityId ?? null]));
    if (reference && (!validSourceJournalRef(reference) || reference.scope !== this.scopeId)) throw new Error("Foreign source journal reference");
    this.head = reference?.head ?? null;
    this.folder = join(resolve(home), ".neko-core", "context-source-journal", this.scopeId);
    if (this.head) {
      this.state = this.readHead(this.head);
      const last = parseGroup(scope, this.read(this.state.sourceId));
      if (last.sequence !== this.state.sequence) throw new Error("Source journal sequence mismatch");
      this.verifyFacts(this.state.facts);
    }
  }

  private admit(scope: TaskScope = this.scope): void {
    assertTaskScope(this.scope);
    if (scope !== this.scope) throw new Error("Source journal belongs to another activation");
  }

  reference(): SourceJournalRef { this.admit(); return {version: 1, scope: this.scopeId, head: this.head}; }
  facts(scope: TaskScope): readonly CurrentFact[] { this.admit(scope); return structuredClone(this.state?.facts ?? []); }
  stats() { this.admit(); return {sources: this.state?.revision ?? 0, cachedObjects: this.cache.size, cachedBytes: this.cacheBytes}; }

  private checkDirectory(create: boolean): void {
    const paths = [resolve(this.home), join(resolve(this.home), ".neko-core"), join(resolve(this.home), ".neko-core", "context-source-journal"), this.folder];
    for (const path of paths) {
      if (create && !existsSync(path)) mkdirSync(path, {mode: 0o700});
      if (!lstatSync(path).isDirectory()) throw new Error("Unsafe source journal directory");
    }
  }

  private readObject(id: string): string {
    if (!HASH.test(id)) throw new Error("Invalid source object ID");
    this.checkDirectory(false);
    const path = join(this.folder, `${id}.json`), before = lstatSync(path);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_OBJECT_BYTES) throw new Error("Unsafe source journal object");
    const fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      const opened = fstatSync(fd);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error("Source journal object changed during read");
      const raw = readFileSync(fd, "utf8");
      if (hash(raw) !== id) throw new Error("Source journal integrity mismatch");
      return raw;
    } finally { closeSync(fd); }
  }

  private putObject(raw: string): string {
    if (Buffer.byteLength(raw) > MAX_OBJECT_BYTES) throw new Error("Source journal object exceeds budget");
    this.checkDirectory(true);
    const id = hash(raw), path = join(this.folder, `${id}.json`);
    if (existsSync(path)) { if (this.readObject(id) !== raw) throw new Error("Source journal object collision"); }
    else {
      const temporary = join(this.folder, `temporary-${randomUUID()}`);
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, raw, "utf8"); fsyncSync(fd);
      } catch (error) {
        closeSync(fd); unlinkSync(temporary); throw error;
      }
      closeSync(fd);
      try { renameSync(temporary, path); }
      catch (error) { unlinkSync(temporary); throw error; }
    }
    if (process.platform !== "win32") {
      const parent = openSync(this.folder, constants.O_RDONLY);
      try { fsyncSync(parent); } finally { closeSync(parent); }
    }
    return id;
  }

  nextSequence(): number {
    this.admit();
    const sequence = (this.state?.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error("Source journal sequence exhausted");
    return sequence;
  }

  private prepareAppend(source: EvidenceChunk) {
    this.admit();
    const group = parseGroup(this.scope, source);
    if (group.sequence <= (this.state?.sequence ?? 0)) throw new Error("Source sequence must advance");
    const facts = advanceStructuredFacts(this.state?.facts ?? [], source.id, group);
    if (facts.reduce((count, fact) => count + fact.alternatives.length, 0) > MAX_ACTIVE_FACTS) throw new Error("Active fact index exceeds budget; original history retained");
    const revision = (this.state?.revision ?? 0) + 1;
    if (!Number.isSafeInteger(revision)) throw new Error("Source journal revision exhausted");
    const candidate: Head = {version: 1, scope: this.scopeId, previous: this.head, sourceId: source.id, revision, sequence: group.sequence, facts};
    const raw = JSON.stringify(candidate);
    if (Buffer.byteLength(raw) > MAX_OBJECT_BYTES) throw new Error("Source journal head exceeds budget");
    return {candidate, raw};
  }

  /** Completed groups are durable before publishing a new head. Failure leaves this instance's prior head intact. */
  append(source: EvidenceChunk): SourceJournalRef {
    const {candidate, raw} = this.prepareAppend(source);
    this.putObject(source.text);
    const head = this.putObject(raw);
    this.head = head; this.state = candidate;
    return this.reference();
  }

  async appendAsync(source: EvidenceChunk, signal?: AbortSignal): Promise<SourceJournalRef> {
    signal?.throwIfAborted();
    const previous = this.head, {candidate, raw} = this.prepareAppend(source);
    const check = () => {
      this.admit(); signal?.throwIfAborted();
      if (this.head !== previous) throw new Error("Source journal changed during append preparation");
    };
    await this.putObjectAsync(source.text, signal); check();
    const head = await this.putObjectAsync(raw, signal); check();
    this.head = head; this.state = candidate;
    return this.reference();
  }

  private async putObjectAsync(raw: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (Buffer.byteLength(raw) > MAX_OBJECT_BYTES) throw new Error("Source journal object exceeds budget");
    for (const path of [resolve(this.home), join(resolve(this.home), ".neko-core"), join(resolve(this.home), ".neko-core", "context-source-journal"), this.folder]) {
      try { await mkdirAsync(path, {mode: 0o700}); }
      catch (error) {
        // SAFETY: filesystem errors expose a code; only an existing path may proceed to lstat.
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      if (!(await lstatAsync(path)).isDirectory()) throw new Error("Unsafe source journal directory");
      signal?.throwIfAborted();
    }
    const id = hash(raw), path = join(this.folder, `${id}.json`);
    try {
      await lstatAsync(path);
      if (await this.readObjectAsync(id, signal) !== raw) throw new Error("Source journal object collision");
    } catch (error) {
      // SAFETY: only an absent immutable object can enter the creation path.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temporary = join(this.folder, `temporary-${randomUUID()}`);
      const output = await openAsync(temporary, "wx", 0o600);
      try {
        try { await output.writeFile(raw, "utf8"); await output.sync(); }
        finally { await output.close(); }
        signal?.throwIfAborted();
        await renameAsync(temporary, path);
      } catch (failure) {
        try { await unlinkAsync(temporary); } catch { /* immutable orphan is never an active head */ }
        throw failure;
      }
    }
    if (process.platform !== "win32") {
      const parent = await openAsync(this.folder, constants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
    }
    return id;
  }

  read(id: string): EvidenceChunk {
    this.admit();
    const cached = this.cache.get(id);
    if (cached) { this.cache.delete(id); this.cache.set(id, cached); return cached.chunk; }
    const text = this.readObject(id), chunk = Object.freeze({id, text});
    parseGroup(this.scope, chunk);
    const bytes = Buffer.byteLength(text);
    this.cache.set(id, {chunk, bytes}); this.cacheBytes += bytes;
    while (this.cache.size > 64 || this.cacheBytes > CACHE_BYTES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cacheBytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
    }
    return chunk;
  }

  /** Selected working sources must belong to this frozen branch, not just share a task/root. */
  assertContains(ids: readonly string[]): void {
    this.admit();
    const remaining = new Set(ids);
    let at = this.head, revision = this.state?.revision ?? 0;
    while (at && remaining.size) {
      const head = this.readHead(at);
      if (head.revision !== revision--) throw new Error("Source journal ancestry mismatch");
      remaining.delete(head.sourceId);
      at = head.previous;
    }
    if (remaining.size) throw new Error("Working source is outside the selected journal branch");
  }

  /** Read-only asynchronous ancestry validation. A concurrent branch change or retired activation
   * invalidates the result; callers must still keep their final commit quiescent and revision-checked. */
  async assertContainsAsync(ids: readonly string[], signal?: AbortSignal): Promise<void> {
    this.admit();
    const frozenHead = this.head;
    const remaining = new Set(ids);
    const check = () => {
      signal?.throwIfAborted();
      this.admit();
      if (this.head !== frozenHead) throw new Error("Source journal changed during ancestry validation");
    };
    let at = frozenHead, revision = this.state?.revision ?? 0;
    while (at && remaining.size) {
      check();
      const head = this.decodeHead(JSON.parse(await this.readObjectAsync(at, signal)));
      check();
      if (head.revision !== revision--) throw new Error("Source journal ancestry mismatch");
      remaining.delete(head.sourceId);
      at = head.previous;
    }
    check();
    if (remaining.size) throw new Error("Working source is outside the selected journal branch");
  }

  private async readObjectAsync(id: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (!HASH.test(id)) throw new Error("Invalid source object ID");
    for (const path of [resolve(this.home), join(resolve(this.home), ".neko-core"), join(resolve(this.home), ".neko-core", "context-source-journal"), this.folder]) {
      if (!(await lstatAsync(path)).isDirectory()) throw new Error("Unsafe source journal directory");
      signal?.throwIfAborted();
    }
    const path = join(this.folder, `${id}.json`), before = await lstatAsync(path);
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_OBJECT_BYTES) throw new Error("Unsafe source journal object");
    const file = await openAsync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
    try {
      signal?.throwIfAborted();
      const opened = await file.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error("Source journal object changed during read");
      const raw = await file.readFile({encoding: "utf8", signal});
      signal?.throwIfAborted();
      if (hash(raw) !== id) throw new Error("Source journal integrity mismatch");
      return raw;
    } finally { await file.close(); }
  }

  /** A frozen backward cursor remains stable while newer heads or independent branches are appended. */
  page(cursor: string | null = this.head, limit = 32): SourceJournalPage {
    this.admit();
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error("Invalid source page size");
    const result: EvidenceChunk[] = [], seen = new Set<string>();
    let at = cursor, revision: number | undefined, bytes = 0;
    while (at && result.length < limit) {
      if (seen.has(at)) throw new Error("Cyclic source journal");
      seen.add(at);
      const head = this.readHead(at);
      if (revision !== undefined && head.revision !== revision - 1) throw new Error("Source journal ancestry mismatch");
      const source = this.read(head.sourceId);
      if (parseGroup(this.scope, source).sequence !== head.sequence) throw new Error("Source journal sequence mismatch");
      const size = Buffer.byteLength(source.text);
      if (result.length && bytes + size > CACHE_BYTES) break;
      result.push(source); bytes += size;
      at = head.previous; revision = head.revision;
    }
    return {sources: result.reverse(), older: at};
  }

  private readHead(id: string): Head {
    return this.decodeHead(JSON.parse(this.readObject(id)));
  }

  private decodeHead(value: unknown): Head {
    if (!isJsonObject(value) || value.version !== 1 || value.scope !== this.scopeId
      || (value.previous !== null && (!isText(value.previous) || !HASH.test(value.previous)))
      || !isText(value.sourceId) || !HASH.test(value.sourceId) || !Number.isSafeInteger(value.revision) || Number(value.revision) < 1
      || !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 || !Array.isArray(value.facts)) throw new Error("Invalid or foreign source journal head");
    if ((Number(value.revision) === 1) !== (value.previous === null) || Number(value.sequence) < Number(value.revision)) throw new Error("Invalid source journal ancestry");
    const facts = decodeFacts(value.facts, Number(value.sequence));
    return {version: 1, scope: this.scopeId, previous: value.previous, sourceId: value.sourceId, revision: Number(value.revision), sequence: Number(value.sequence), facts};
  }

  private verifyFacts(facts: readonly CurrentFact[]): void {
    for (const fact of facts) for (const alternative of fact.alternatives) {
      const group = parseGroup(this.scope, this.read(alternative.sourceId));
      const index = Number(alternative.id.slice(alternative.sourceId.length + 1));
      const annotation = group.facts[index];
      if (!annotation || annotation.key !== fact.key || group.sequence !== alternative.sequence
        || String(group.messages[annotation.messageIndex].content).slice(annotation.start, annotation.end) !== alternative.value) throw new Error("Active fact index does not match original source");
    }
  }
}

function decodeFacts(values: unknown[], sequence: number): CurrentFact[] {
  let count = 0;
  const keys = new Set<string>();
  return values.map(value => {
    if (!isJsonObject(value) || !isText(value.key) || !/^[a-zA-Z0-9_.-]{1,128}$/.test(value.key) || keys.has(value.key)
      || !Array.isArray(value.alternatives) || !value.alternatives.length || (value.state !== "current" && value.state !== "conflict")) throw new Error("Invalid active fact index");
    keys.add(value.key);
    const ids = new Set<string>();
    const alternatives = value.alternatives.map(alternative => {
      if (++count > MAX_ACTIVE_FACTS || !isJsonObject(alternative) || !isText(alternative.id) || ids.has(alternative.id)
        || !isText(alternative.sourceId) || !HASH.test(alternative.sourceId) || !new RegExp(`^${alternative.sourceId}_[0-9]+$`).test(alternative.id)
        || !isText(alternative.value) || alternative.value.length > 4096 || !Number.isSafeInteger(alternative.sequence)
        || Number(alternative.sequence) < 1 || Number(alternative.sequence) > sequence) throw new Error("Invalid active fact source");
      ids.add(alternative.id);
      return {id: alternative.id, sourceId: alternative.sourceId, value: alternative.value, sequence: Number(alternative.sequence)};
    });
    const state = new Set(alternatives.map(item => item.value)).size > 1 ? "conflict" : "current";
    if (state !== value.state) throw new Error("Active fact conflict state mismatch");
    return {key: value.key, state, alternatives};
  });
}
