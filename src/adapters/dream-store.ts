/** Candidate/audit storage is outside memory admission; only one atomic note is published per pass. */
/* eslint-disable anti-slop/no-unknown-parameters, anti-slop/no-runtime-typeof -- Persisted candidates are untrusted JSON validated at the storage boundary. */
import { randomUUID } from "node:crypto";
import { constants, closeSync, fsyncSync, renameSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isJsonObject } from "../shared/wire.ts";
import { taskMemoryDirectory, withTaskMemoryWriter } from "../core/memory.ts";
import type { TaskScope } from "../core/task-scope.ts";
import { assertDreamTextSafe, DREAM_INPUT_BYTES, DREAM_NOTE, dreamDigest, parseDreamInput, parseDreamProposal, renderDreamMemory, type DreamInput, type DreamMemory, type DreamProposal } from "../core/dream.ts";

const HASH = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 512_000;
export interface DreamCandidate {
  version: 1;
  id: string;
  createdAt: string;
  taskId: string;
  root: string;
  input: DreamInput;
  proposal: DreamProposal;
  provider: string;
  model: string;
  before: string | null;
  after: string;
}

/** Read exact regular single-link bytes, not symlink/hardlink content or a swapped inode. */
export function readDreamFile(path: string, maxBytes = MAX_RECORD_BYTES): string | null {
  const before = lstatSync(path, { throwIfNoEntry: false });
  if (!before) return null;
  if (!before.isFile() || before.nlink !== 1 || before.size > maxBytes) throw new Error("Unsafe or oversized dream/memory file");
  const fd = openSync(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error("Dream file changed while opening");
    const text = readFileSync(fd, "utf8");
    if (Buffer.byteLength(text) > maxBytes) throw new Error("Dream file exceeds budget");
    return text;
  } finally { closeSync(fd); }
}

export function snapshotDreamMemories(home: string, scope: TaskScope): DreamMemory[] {
  const dir = taskMemoryDirectory(home, scope);
  if (!lstatSync(dir, { throwIfNoEntry: false })) return [];
  const result: DreamMemory[] = [];
  let bytes = 0;
  for (const name of readdirSync(dir).filter(name => name.endsWith(".md")).sort()) {
    const content = readDreamFile(join(dir, name), 64_000);
    if (content === null) throw new Error("Memory changed during dream snapshot");
    bytes += Buffer.byteLength(content);
    if (bytes > 96_000 || result.length >= 100) throw new Error("Task memory exceeds dream budget; reduce the selected task memory first");
    result.push({ name, content, digest: dreamDigest(content) });
  }
  return result;
}
function memoryRevision(memories: DreamMemory[]): string {
  return dreamDigest(JSON.stringify(memories.map(({ name, digest }) => [name, digest])));
}

export class DreamStore {
  constructor(private readonly home: string, private readonly scope: TaskScope) {}
  private directory(create = false): string {
    const parent = taskMemoryDirectory(this.home, this.scope, create), dir = join(parent, ".dreams");
    if (create && !lstatSync(dir, { throwIfNoEntry: false })) mkdirSync(dir, { mode: 0o700 });
    const stat = lstatSync(dir, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw new Error("Unsafe dream record directory");
    return dir;
  }
  private path(id: string): string {
    if (!HASH.test(id)) throw new Error("Invalid dream candidate id");
    return join(this.directory(), `${id}.json`);
  }
  private target(): string { return join(taskMemoryDirectory(this.home, this.scope), DREAM_NOTE); }

  /** Claim before spending. Same evidence is not retried after failure, crash, or rollback. */
  claimAutomatic(evidenceDigest: string): boolean {
    if (!HASH.test(evidenceDigest)) throw new Error("Invalid automatic Dream evidence");
    return withTaskMemoryWriter(this.home, this.scope, () => {
      const path = join(this.directory(true), "automatic.json");
      const previous = readDreamFile(path);
      if (previous === evidenceDigest) return false;
      writeDreamFile(path, evidenceDigest);
      return true;
    });
  }


  prepare(input: DreamInput, proposal: DreamProposal, identity: { provider: string; model: string }): DreamCandidate {
    return withTaskMemoryWriter(this.home, this.scope, () => {
      if (input.taskId !== this.scope.id || input.root !== this.scope.canonicalRoot) throw new Error("Dream belongs to another task/root");
      if (memoryRevision(snapshotDreamMemories(this.home, this.scope)) !== memoryRevision(input.memories)) throw new Error("Task memories changed during dreaming");
      input = parseDreamInput(JSON.parse(JSON.stringify(input)));
      const checked = parseDreamProposal(JSON.stringify(proposal), input);
      const id = dreamDigest(JSON.stringify([input, checked, identity]));
      const candidate: DreamCandidate = { version: 1, id, taskId: this.scope.id, root: this.scope.canonicalRoot,
        createdAt: new Date().toISOString(), input, proposal: checked, ...identity,
        before: readDreamFile(this.target()), after: renderDreamMemory(checked, input, id) };
      const cited = new Set(checked.claims.flatMap(claim => claim.citations.map(citation => citation.sourceId)));
      const carry = input.sources.filter(source => cited.has(source.id));
      const nextMemories = [...input.memories.filter(memory => memory.name !== DREAM_NOTE),
        { name: DREAM_NOTE, content: candidate.after, digest: dreamDigest(candidate.after) }];
      const nextBytes = Buffer.byteLength(JSON.stringify(nextMemories)) + carry.reduce((sum, source) => sum + Buffer.byteLength(JSON.stringify(source)), 0);
      if (nextBytes > DREAM_INPUT_BYTES - 8000) throw new Error("Dream candidate exceeds the next-pass retained-evidence budget; no candidate activated");
      const dir = this.directory(true), path = join(dir, `${id}.json`);
      if (readDreamFile(path) !== null) {
        if (this.status(id) === "rolled_back" || this.status(id) === "rollback_pending") throw new Error("Dream candidate was rolled back; source or proposal must change");
        return this.read(id);
      }
      const raw = JSON.stringify(candidate);
      assertDreamTextSafe(raw);
      if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) throw new Error("Dream candidate exceeds storage budget");
      // Complete immutable record is published before activation is even possible.
      // Process-interruption guarantee only; directory metadata is not power-loss durable on every platform.
      writeDreamFile(path, raw);
      return candidate;
    });
  }

  read(id: string): DreamCandidate {
    const raw = readDreamFile(this.path(id));
    if (raw === null) throw new Error("Dream candidate not found in this task");
    const value: unknown = JSON.parse(raw);
    if (!isJsonObject(value) || value.version !== 1 || value.id !== id || value.taskId !== this.scope.id
      || value.root !== this.scope.canonicalRoot || typeof value.createdAt !== "string"
      || typeof value.provider !== "string" || typeof value.model !== "string"
      || (value.before !== null && typeof value.before !== "string") || typeof value.after !== "string"
      || !isJsonObject(value.input) || value.input.taskId !== this.scope.id || value.input.root !== this.scope.canonicalRoot
      || !Array.isArray(value.input.sources) || !Array.isArray(value.input.memories) || !isJsonObject(value.input.coverage)) throw new Error("Invalid dream candidate record");
    const input = parseDreamInput(value.input);
    const parsed = parseDreamProposal(JSON.stringify(value.proposal), input);
    const candidate: DreamCandidate = { version: 1, id, taskId: this.scope.id, root: this.scope.canonicalRoot,
      createdAt: value.createdAt, input, proposal: parsed, provider: value.provider, model: value.model,
      before: value.before, after: value.after };
    if (dreamDigest(JSON.stringify([candidate.input, parsed, { provider: candidate.provider, model: candidate.model }])) !== id
      || renderDreamMemory(parsed, candidate.input, id) !== candidate.after
      || (candidate.input.memories.find(memory => memory.name === DREAM_NOTE)?.content ?? null) !== candidate.before) throw new Error("Dream candidate integrity mismatch");
    assertDreamTextSafe(raw);
    return candidate;
  }

  status(id: string): "prepared" | "applied" | "conflict" | "rolled_back" | "rollback_pending" {
    const candidate = this.read(id), current = readDreamFile(this.target());
    if (readDreamFile(join(this.directory(), `${id}.rollback`)) !== null) {
      return current === candidate.before ? "rolled_back" : current === candidate.after ? "rollback_pending" : "conflict";
    }
    if (current === candidate.after) return "applied";
    return current === candidate.before ? "prepared" : "conflict";
  }

  apply(id: string, currentInput: DreamInput, automaticEvidence?: string): "applied" | "already_applied" {
    return withTaskMemoryWriter(this.home, this.scope, () => {
      const candidate = this.read(id);
      if (automaticEvidence !== undefined && readDreamFile(join(this.directory(), "automatic.json")) !== automaticEvidence) throw new Error("Automatic Dream was superseded by a newer turn");
      if (readDreamFile(join(this.directory(), `${id}.rollback`)) !== null) throw new Error("Dream rollback requested; finish rollback before preparing a new candidate");
      if (readDreamFile(this.target()) === candidate.after) return "already_applied";
      if (currentInput.taskId !== this.scope.id || currentInput.root !== this.scope.canonicalRoot
        || currentInput.evidenceDigest !== candidate.input.evidenceDigest) throw new Error("Dream source snapshot changed; prepare again");
      if (memoryRevision(snapshotDreamMemories(this.home, this.scope)) !== memoryRevision(candidate.input.memories)) throw new Error("Task memories changed; dream candidate is stale");
      // Receipt exists first; after a crash exact target bytes distinguish not-applied/applied.
      writeDreamFile(this.target(), candidate.after);
      return "applied";
    });
  }

  rollback(id: string): void {
    withTaskMemoryWriter(this.home, this.scope, () => {
      const candidate = this.read(id), current = readDreamFile(this.target());
      if (current !== candidate.after && !(current === candidate.before && this.status(id) === "rolled_back")) throw new Error("Memory changed since activation; rollback would overwrite new work");
      // Intent first makes an interrupted rollback resumable, never an implicit replay of apply.
      const marker = join(this.directory(), `${id}.rollback`);
      if (readDreamFile(marker) === null) writeFileSync(marker, "Rollback requested\n", { flag: "wx", mode: 0o600 });
      if (candidate.before === null) { if (current !== null) rmSync(this.target()); }
      else writeDreamFile(this.target(), candidate.before);
    });
  }
}

/** Exclusive random staging prevents temporary-path links; rename publishes one complete note. */
function writeDreamFile(path: string, text: string): void {
  const temporary = `${path}.stage-${randomUUID()}`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, text, "utf8"); fsyncSync(fd); }
  catch (error) { closeSync(fd); rmSync(temporary); throw error; }
  closeSync(fd);
  try { renameSync(temporary, path); }
  catch (error) { rmSync(temporary); throw error; }
}
