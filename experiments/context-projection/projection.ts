/** Experimental, in-memory working-context view. Not wired into Agent or enabled by default.
 * The runtime supplies authority and original evidence; model proposals select/annotate a view.
 * A source citation is an identity check, not proof that a generated note is semantically true.
 */
import { assertTaskScope, type TaskScope } from "../../src/core/task-scope.ts";
import { isJsonObject, isText, type JsonValue } from "../../src/shared/wire.ts";

export interface EvidenceChunk { readonly id: string; readonly text: string }
export type ViewPart = { readonly kind: "source"; readonly id: string }
  | { readonly kind: "note"; readonly text: string; readonly sources: readonly string[] };
interface ViewState { revision: number; parts: readonly ViewPart[] }
const MAX_PARTS = 512;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const validId = (id: string) => /^[A-Za-z0-9_-]{1,128}$/.test(id);

/** Trust boundary is the branded runtime scope, not a task id/root inside model JSON. */
export class ContextProjection {
  private readonly archive = new Map<string, Readonly<EvidenceChunk>>();
  private archiveBytes = 0;
  private state: ViewState = { revision: 0, parts: Object.freeze([]) };
  private readonly undoStates: Array<readonly ViewPart[]> = [];
  private readonly prefix: readonly string[];

  constructor(
    private readonly scope: TaskScope,
    protectedPrefix: readonly string[],
    private readonly maxViewBytes: number,
    private readonly assertQuiescent: () => void,
  ) {
    assertTaskScope(scope);
    if (!Number.isSafeInteger(maxViewBytes) || maxViewBytes < 1 || maxViewBytes > MAX_ARCHIVE_BYTES) {
      throw new Error("Invalid context-view byte budget");
    }
    if (protectedPrefix.some((s) => !isText(s))) throw new Error("Invalid protected prefix");
    this.prefix = Object.freeze([...protectedPrefix]);
    this.checkBudget([]);
  }

  private admit(scope: TaskScope, revision?: number): void {
    assertTaskScope(this.scope);
    if (scope !== this.scope) throw new Error("Context view belongs to another runtime activation");
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision !== this.state.revision)) {
      throw new Error("Stale context-view revision");
    }
    this.assertQuiescent();
  }

  private checkBudget(parts: readonly ViewPart[]): number {
    if (parts.length > MAX_PARTS) throw new Error("Too many context-view parts");
    const text = JSON.stringify({ prefix: this.prefix, parts: parts.map((p) => p.kind === "source"
      ? { kind: p.kind, id: p.id, text: this.archive.get(p.id)!.text }
      : p) });
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes > this.maxViewBytes) throw new Error("Context-view byte budget exceeded");
    return bytes;
  }

  /** Host-only admission of new original evidence. Never accepts model-proposed originals. */
  append(scope: TaskScope, chunk: EvidenceChunk): void {
    this.admit(scope);
    if (!isText(chunk.id) || !validId(chunk.id) || !isText(chunk.text)
      || this.archive.has(chunk.id)) throw new Error("Invalid or duplicate evidence id");
    const bytes = Buffer.byteLength(chunk.text, "utf8");
    if (this.archive.size >= MAX_PARTS || this.archiveBytes + bytes > MAX_ARCHIVE_BYTES) {
      throw new Error("Evidence archive budget exceeded");
    }
    const copy = Object.freeze({ id: chunk.id, text: chunk.text });
    this.archive.set(copy.id, copy);
    const parts: readonly ViewPart[] = [...this.state.parts, Object.freeze({ kind: "source", id: copy.id } as const)];
    try { this.checkBudget(parts); }
    catch (error) { this.archive.delete(copy.id); throw error; }
    this.archiveBytes += bytes;
    this.state = { revision: this.state.revision + 1, parts: Object.freeze(parts) };
    // An undo from before a new observation must not silently hide the newer evidence.
    this.undoStates.length = 0;
  }

  /** Complete replacement of the editable view, validated before a single state assignment. */
  apply(scope: TaskScope, expectedRevision: number, proposal: JsonValue): void {
    this.admit(scope, expectedRevision);
    if (!Array.isArray(proposal) || proposal.length > MAX_PARTS) throw new Error("Invalid context-view proposal");
    const seen = new Set<string>();
    let proposedBytes = this.checkBudget([]), count = 0;
    const admitPart = <T extends ViewPart>(part: T): T => {
      const rendered = part.kind === "source" ? { ...part, text: this.archive.get(part.id)!.text } : part;
      proposedBytes += Buffer.byteLength(JSON.stringify(rendered), "utf8") + (count++ > 0 ? 1 : 0);
      if (proposedBytes > this.maxViewBytes) throw new Error("Context-view byte budget exceeded");
      return part;
    };
    const parts: ViewPart[] = proposal.map((part) => {
      if (!isJsonObject(part)) throw new Error("Invalid context-view part");
      if (part.kind === "source" && Object.keys(part).sort().join(",") === "id,kind"
        && isText(part.id) && this.archive.has(part.id) && !seen.has(part.id)) {
        seen.add(part.id);
        return admitPart(Object.freeze({ kind: "source", id: part.id }));
      }
      if (part.kind === "note" && Object.keys(part).sort().join(",") === "kind,sources,text"
        && isText(part.text) && Buffer.byteLength(part.text, "utf8") <= this.maxViewBytes
        && Array.isArray(part.sources) && part.sources.length > 0
        && part.sources.length <= MAX_PARTS
        && part.sources.every((id) => isText(id) && this.archive.has(id))) {
        // JsonValue narrowing above proves each source is a string present in the host archive.
        const sources = part.sources.map((id) => String(id));
        if (new Set(sources).size !== sources.length) throw new Error("Duplicate note sources");
        return admitPart(Object.freeze({ kind: "note", text: part.text, sources: Object.freeze(sources) }));
      }
      throw new Error("Unknown evidence, role or context-view fields");
    });
    this.checkBudget(parts);
    this.undoStates.push(this.state.parts);
    if (this.undoStates.length > 16) this.undoStates.shift();
    this.state = { revision: this.state.revision + 1, parts: Object.freeze(parts) };
  }

  undo(scope: TaskScope, expectedRevision: number): void {
    this.admit(scope, expectedRevision);
    const parts = this.undoStates.at(-1);
    if (!parts) throw new Error("No context edit to undo");
    this.checkBudget(parts);
    this.undoStates.pop();
    this.state = { revision: this.state.revision + 1, parts };
  }

  snapshot(scope: TaskScope) {
    this.admit(scope);
    return Object.freeze({ revision: this.state.revision, protectedPrefix: this.prefix,
      parts: this.state.parts, bytes: this.checkBudget(this.state.parts), evidenceCount: this.archive.size });
  }

  evidence(scope: TaskScope, id: string): Readonly<EvidenceChunk> {
    this.admit(scope);
    const source = this.archive.get(id);
    if (!source) throw new Error("Unknown evidence id");
    return source;
  }
}
