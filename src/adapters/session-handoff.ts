/**
 * Immutable, summary-only messages between saved local sessions.
 *
 * This adapter is intentionally only a pending spool. It does not inject into a transcript,
 * acknowledge, consume, or delete a handoff; those operations need a separate exactly-once design.
 */
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";

import { homeDir } from "../shared/home.ts";
import { isJsonObject, isText, type JsonObject } from "../shared/wire.ts";
import { isValidSessionId, loadSession, type Session } from "./session.ts";

const SCHEMA = "neko.session-handoff/v1" as const;
const KIND = "summary" as const;
const PROVENANCE = "local-unverified" as const;
const MAX_SUMMARY_BYTES = 16 * 1024;
const MAX_ENVELOPE_BYTES = 64 * 1024;
const MAX_SCAN_ENTRIES = 1024;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const ENVELOPE_KEYS = [
  "schema", "id", "createdAt", "source", "targetSessionId", "kind", "summary", "provenance",
] as const;
const SOURCE_KEYS = ["sessionId", "updatedAt", "cwd", "model", "messageCount"] as const;

export interface SessionHandoff {
  readonly schema: typeof SCHEMA;
  readonly id: string;
  readonly createdAt: string;
  readonly source: Readonly<{
    sessionId: string;
    updatedAt: string;
    cwd: string;
    model: string;
    messageCount: number;
  }>;
  readonly targetSessionId: string;
  readonly kind: typeof KIND;
  readonly summary: string;
  readonly provenance: typeof PROVENANCE;
}

export interface RejectedSessionHandoff {
  file: string;
  reason: string;
}

export interface PendingSessionHandoffs {
  items: SessionHandoff[];
  rejected: RejectedSessionHandoff[];
  truncated: boolean;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function safeMetadata(value: string): boolean {
  return value.length > 0 && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

function validTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function exactKeys(value: any, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isWriterTemp(file: string): boolean {
  const match = /^(.+)\.json\.(.+)\.tmp$/.exec(file);
  return !!match && UUID_V4.test(match[1]) && UUID_V4.test(match[2]);
}

function parseEnvelope(value: any, expectedId: string): SessionHandoff | null {
  const envelope = isJsonObject(value) ? value : null;
  if (envelope === null) return null;
  if (!exactKeys(envelope, ENVELOPE_KEYS)) return null;
  if (envelope.schema !== SCHEMA || envelope.kind !== KIND || envelope.provenance !== PROVENANCE) return null;
  if (envelope.id !== expectedId || !isText(envelope.id) || !UUID_V4.test(envelope.id)) return null;
  if (!isText(envelope.createdAt) || !validTimestamp(envelope.createdAt)) return null;
  if (!isText(envelope.targetSessionId) || !isValidSessionId(envelope.targetSessionId)) return null;
  const source = envelope.source;
  if (!isJsonObject(source)) return null;
  if (!exactKeys(source, SOURCE_KEYS)) return null;
  if (!isText(source.sessionId) || !isValidSessionId(source.sessionId)) return null;
  if (source.sessionId === envelope.targetSessionId) return null;
  if (!isText(source.updatedAt) || !validTimestamp(source.updatedAt)) return null;
  if (!isText(source.cwd) || !safeMetadata(source.cwd)) return null;
  if (!isText(source.model) || !safeMetadata(source.model)) return null;
  if (!Number.isSafeInteger(source.messageCount) || Number(source.messageCount) < 0) return null;
  if (!isText(envelope.summary) || envelope.summary.trim().length === 0) return null;
  if (UNSAFE_CONTROL.test(envelope.summary) || utf8Bytes(envelope.summary) > MAX_SUMMARY_BYTES) return null;
  // SAFETY: exactKeys plus the per-field validations above establish the SessionHandoff contract.
  return value as SessionHandoff;
}

function requireSession(id: string, role: "source" | "target"): Session {
  if (!isValidSessionId(id)) throw new Error(`Invalid ${role} session ID`);
  const session = loadSession(id);
  if (!session) throw new Error(`${role === "source" ? "Source" : "Target"} session is unavailable`);
  if (!safeMetadata(session.cwd)) throw new Error(`${role === "source" ? "Source" : "Target"} session metadata is unsafe`);
  return session;
}

function validateSourceMetadata(source: Session): void {
  if (!validTimestamp(source.updatedAt) || !safeMetadata(source.cwd) || !safeMetadata(source.model)) {
    throw new Error("Source session metadata is unsafe");
  }
}

type BoundedRead = { data: Buffer } | { reason: string };

function readBoundedRegularFile(path: string): BoundedRead {
  let initial;
  try {
    initial = lstatSync(path);
  } catch {
    return { reason: "lstat-failed" };
  }
  if (!initial.isFile()) return { reason: "not-regular-file" };
  if (initial.size > MAX_ENVELOPE_BYTES) return { reason: "envelope-too-large" };

  let fd: number;
  try {
    let flags = constants.O_RDONLY;
    if (process.platform !== "win32") flags |= constants.O_NOFOLLOW | constants.O_NONBLOCK;
    fd = openSync(path, flags);
  } catch {
    return { reason: "open-failed" };
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile()) return { reason: "not-regular-file" };
    if (opened.dev !== initial.dev || opened.ino !== initial.ino) return { reason: "entry-changed" };
    if (opened.size > MAX_ENVELOPE_BYTES) return { reason: "envelope-too-large" };

    const chunks: Buffer[] = [];
    const buffer = Buffer.allocUnsafe(8192);
    let total = 0;
    while (total <= MAX_ENVELOPE_BYTES) {
      const limit = Math.min(buffer.length, MAX_ENVELOPE_BYTES + 1 - total);
      const count = readSync(fd, buffer, 0, limit, null);
      if (count === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, count)));
      total += count;
    }
    if (total > MAX_ENVELOPE_BYTES) return { reason: "envelope-too-large" };

    const after = fstatSync(fd);
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) return { reason: "entry-changed" };
    return { data: Buffer.concat(chunks, total) };
  } catch {
    return { reason: "read-failed" };
  } finally {
    try { closeSync(fd); } catch { /* best effort */ }
  }
}

function decodeEnvelope(data: Buffer, expectedId: string): { envelope: SessionHandoff } | { reason: string } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return { reason: "invalid-utf8" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { reason: "invalid-json" };
  }
  const envelope = parseEnvelope(value, expectedId);
  return envelope ? { envelope } : { reason: "invalid-envelope" };
}

export class SessionHandoffStore {
  private readonly home: string;
  private readonly privateDirs: readonly string[];
  private readonly pendingDir: string;

  constructor(home: string = homeDir()) {
    this.home = realpathSync(home);
    const nekoDir = join(this.home, ".neko-core");
    const handoffsDir = join(nekoDir, "handoffs");
    const versionDir = join(handoffsDir, "v1");
    this.pendingDir = join(versionDir, "pending");
    this.privateDirs = [nekoDir, handoffsDir, versionDir, this.pendingDir];
  }

  private ensurePendingDir(): void {
    for (const dir of this.privateDirs) {
      if (!existsSync(dir)) {
        try { mkdirSync(dir, { mode: 0o700 }); }
        catch (error) {
          // SAFETY: fs errors from this module's own typed calls carry the errno contract.
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      this.validatePrivateDir(dir);
      try { chmodSync(dir, 0o700); } catch { /* Windows ACLs do not implement POSIX modes. */ }
    }
  }

  private validatePrivateDir(dir: string): void {
    const stat = lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe handoff directory");
    const rel = relative(this.home, realpathSync(dir));
    if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
      throw new Error("Handoff directory escapes the user home");
    }
  }

  private writeImmutable(path: string, serialized: string): void {
    const temp = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, serialized, { encoding: "utf8", flag: "wx", mode: 0o600 });
      // Hard-link publication is atomic and refuses an existing destination. renameSync would
      // replace an existing envelope on POSIX, violating the immutable-spool contract.
      linkSync(temp, path);
      try { rmSync(temp); } catch { /* The published link is authoritative; stale temp is ignored. */ }
      try { chmodSync(path, 0o600); } catch { /* Windows ACLs do not implement POSIX modes. */ }
    } catch (error) {
      try { rmSync(temp, { force: true }); } catch { /* best effort cleanup */ }
      throw error;
    }
  }

  send(sourceSessionId: string, targetSessionId: string, summary: string): SessionHandoff {
    if (sourceSessionId === targetSessionId) throw new Error("Source and target sessions must differ");
    const source = requireSession(sourceSessionId, "source");
    const target = requireSession(targetSessionId, "target");
    validateSourceMetadata(source);
    if (!isText(summary) || summary.trim().length === 0) throw new Error("Handoff summary is required");
    if (UNSAFE_CONTROL.test(summary)) throw new Error("Handoff summary contains unsafe control characters");
    if (utf8Bytes(summary) > MAX_SUMMARY_BYTES) throw new Error("Handoff summary exceeds 16 KiB");

    this.ensurePendingDir();
    let id = randomUUID();
    let path = join(this.pendingDir, `${id}.json`);
    for (let attempts = 0; existsSync(path) && attempts < 8; attempts++) {
      id = randomUUID();
      path = join(this.pendingDir, `${id}.json`);
    }
    if (existsSync(path)) throw new Error("Could not allocate a unique handoff ID");

    const envelope: SessionHandoff = {
      schema: SCHEMA,
      id,
      createdAt: new Date().toISOString(),
      source: {
        sessionId: source.id,
        updatedAt: source.updatedAt,
        cwd: source.cwd,
        model: source.model,
        messageCount: source.messages.length,
      },
      targetSessionId: target.id,
      kind: KIND,
      summary,
      provenance: PROVENANCE,
    };
    const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
    if (utf8Bytes(serialized) > MAX_ENVELOPE_BYTES) throw new Error("Handoff envelope exceeds 64 KiB");
    this.writeImmutable(path, serialized);
    return envelope;
  }

  listPending(targetSessionId: string): PendingSessionHandoffs {
    requireSession(targetSessionId, "target");
    if (!existsSync(this.pendingDir)) return { items: [], rejected: [], truncated: false };
    for (const dir of this.privateDirs) this.validatePrivateDir(dir);

    const items: SessionHandoff[] = [];
    const rejected: RejectedSessionHandoff[] = [];
    let truncated = false;
    let scanned = 0;
    const dir = opendirSync(this.pendingDir);
    try {
      for (;;) {
        const entry = dir.readSync();
        if (!entry) break;
        if (scanned++ >= MAX_SCAN_ENTRIES) {
          truncated = true;
          break;
        }
        const file = entry.name;
        if (isWriterTemp(file)) continue;
        const match = /^([0-9a-f-]+)\.json$/.exec(file);
        if (!match || !UUID_V4.test(match[1])) {
          rejected.push({ file, reason: "invalid-file-name" });
          continue;
        }
        const read = readBoundedRegularFile(join(this.pendingDir, file));
        if ("reason" in read) {
          rejected.push({ file, reason: read.reason });
          continue;
        }
        const decoded = decodeEnvelope(read.data, match[1]);
        if ("reason" in decoded) {
          rejected.push({ file, reason: decoded.reason });
          continue;
        }
        const envelope = decoded.envelope;
        if (envelope.targetSessionId === targetSessionId) items.push(envelope);
      }
    } finally {
      try { dir.closeSync(); } catch { /* best effort */ }
    }
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    rejected.sort((a, b) => a.file.localeCompare(b.file));
    return { items, rejected, truncated };
  }
}
