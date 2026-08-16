/** Exact-snapshot trust gate for every project-local control surface. */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";

import { deniedCredentialPath } from "../core/read-policy.ts";
import { atomicWriteFileSync } from "../shared/atomic.ts";
import { homeDir } from "../shared/home.ts";

const SCHEMA_VERSION = 1;
const MAX_CONTROL_FILE_BYTES = 1024 * 1024;
const MAX_MANIFEST_FILE_BYTES = 4 * 1024 * 1024;
const MAX_MANIFEST_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_MANIFEST_ENTRIES = 512;
const MAX_DIRECTORY_DEPTH = 16;
export const PROJECT_TRUST_RECORD_LIMIT = 128;
const MAX_TRUST_RECORD_OVERFLOW = 32;
const MAX_TRUST_RECORD_BYTES = 1024 * 1024;

export const PROJECT_CONTROL_FILES = [
  ".neko-core/config.json",
  "neko.json",
  ".mcp.json",
  "NEKO.md",
  "AGENTS.md",
  "CLAUDE.md",
] as const;

export const PROJECT_CONTROL_DIRS = [
  ".neko-core/skills",
  ".neko-core/agents",
  ".neko-core/recipes",
] as const;

export type ProjectTrustState = "none" | "trusted" | "untrusted" | "changed" | "error";

export interface ProjectTrustSummary {
  state: ProjectTrustState;
  root?: string;
  projectId?: string;
  fingerprint?: string;
  /** Present top-level control surfaces only; never every nested filename. */
  files: string[];
  reason?: string;
}

interface TrustRecord {
  root: string;
  fingerprint: string;
  files: Record<string, string>;
  trustedAt: string;
}

interface TrustStore {
  version: 1;
  projects: Record<string, TrustRecord>;
}

export interface ProjectSnapshotFile {
  relative: string;
  path: string;
  bytes: Buffer;
}

export interface ProjectTrustInspection extends ProjectTrustSummary {
  configEntries: { path: string; data: Record<string, any> }[];
  mcpServers: Record<string, any>;
  /** Full bounded manifest used for the fingerprint, including missing markers. */
  fileDigests: Record<string, string>;
  /** Bytes read through the verified descriptor; loaders must not reopen project controls. */
  projectFiles: Record<string, ProjectSnapshotFile>;
}

interface SnapshotState {
  root: string;
  projectId: string;
  surfaces: string[];
  fileDigests: Record<string, string>;
  projectFiles: Record<string, ProjectSnapshotFile>;
  totalBytes: number;
  rootIdentity: string;
}

class MissingControl extends Error {}

const sha256 = (value: string | Buffer): string => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const projectIdFor = (root: string): string => createHash("sha256").update(`neko-project-trust/v1\0${root}`).digest("hex");
const fingerprintFor = (root: string, files: Record<string, string>): string => sha256([
  "neko-project-controls/v1",
  root,
  ...Object.entries(files).sort(([a], [b]) => a.localeCompare(b)).map(([name, digest]) => `${name}\0${digest}`),
].join("\0"));
const dirMarker = (dir: string): string => `${dir}/`;
const emptyInspection = (state: ProjectTrustState, reason?: string): ProjectTrustInspection => ({
  state,
  files: [],
  configEntries: [],
  mcpServers: {},
  fileDigests: {},
  projectFiles: {},
  ...(reason ? { reason } : undefined),
});

function trustStorePath(home: string): string {
  return join(home, ".neko-core", "trusted-projects.json");
}

function trustStoreDir(home: string): string {
  return join(home, ".neko-core", "trusted-projects.d");
}

function trustRecordPath(home: string, projectId: string): string {
  return join(trustStoreDir(home), `${projectId}.json`);
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyExecutableMap(value: unknown): boolean {
  return value !== undefined && (!isObject(value) || Object.keys(value).length > 0);
}

function hasUnsafeConfigStructure(root: unknown): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  let visited = 0;
  while (stack.length) {
    const { value, depth } = stack.pop()!;
    if (typeof value !== "object" || value === null) continue;
    if (++visited > 10_000 || depth > 64) return true;
    for (const key of Object.keys(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") return true;
      stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
    }
  }
  return false;
}

function hasExecutableProjectConfig(data: Record<string, any>): boolean {
  if (hasUnsafeConfigStructure(data)) return true;
  // A checkout may tune declarative model behavior after exact-cwd trust, but it must never grant
  // itself write authority elsewhere on the host. External write roots are user-global/env policy.
  if (Object.hasOwn(data, "additional_write_roots")) return true;
  if (nonEmptyExecutableMap(Object.hasOwn(data, "hooks") ? data.hooks : undefined)
    || nonEmptyExecutableMap(Object.hasOwn(data, "mcp_servers") ? data.mcp_servers : undefined)
    || nonEmptyExecutableMap(Object.hasOwn(data, "mcpServers") ? data.mcpServers : undefined)) return true;
  const profiles = Object.hasOwn(data, "profiles") ? data.profiles : undefined;
  if (profiles !== undefined && !isObject(profiles)) return true;
  return isObject(profiles) && Object.values(profiles).some((profile) => isObject(profile)
    && (Object.hasOwn(profile, "additional_write_roots")
      || nonEmptyExecutableMap(profile.hooks) || nonEmptyExecutableMap(profile.mcp_servers)
      || nonEmptyExecutableMap(profile.mcpServers)));
}

function hasExactKeys(value: Record<string, any>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafeRelative(value: string): boolean {
  return value.length > 0 && value.length <= 1024 && !value.endsWith("/")
    && !/[\0-\x1f\x7f]/.test(value)
    && value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function validManifest(files: Record<string, any>): files is Record<string, string> {
  const keys = Object.keys(files);
  if (keys.length > MAX_MANIFEST_ENTRIES) return false;
  for (const name of PROJECT_CONTROL_FILES) {
    const digest = files[name];
    if (digest !== "missing" && !/^sha256:[a-f0-9]{64}$/.test(String(digest))) return false;
  }
  for (const dir of PROJECT_CONTROL_DIRS) {
    if (files[dirMarker(dir)] !== "missing" && files[dirMarker(dir)] !== "directory") return false;
  }
  for (const [name, digest] of Object.entries(files)) {
    if (PROJECT_CONTROL_FILES.includes(name as typeof PROJECT_CONTROL_FILES[number])) continue;
    if (PROJECT_CONTROL_DIRS.some((dir) => name === dirMarker(dir))) continue;
    const directoryFile = PROJECT_CONTROL_DIRS.some((dir) => name.startsWith(`${dir}/`) && isSafeRelative(name.slice(dir.length + 1)));
    const nestedDirectory = name.endsWith("/") && PROJECT_CONTROL_DIRS.some((dir) => {
      const prefix = `${dir}/`;
      return name.startsWith(prefix) && isSafeRelative(name.slice(prefix.length, -1));
    });
    const contextImport = name.startsWith("@context/") && isSafeRelative(name.slice("@context/".length));
    if (!directoryFile && !nestedDirectory && !contextImport) return false;
    if (nestedDirectory) {
      if (digest !== "directory") return false;
    } else if ((digest !== "missing" && !/^sha256:[a-f0-9]{64}$/.test(String(digest)))
      || (directoryFile && digest === "missing")) return false;
  }
  return true;
}

function validateRecord(id: string, raw: unknown): TrustRecord {
  if (!/^[a-f0-9]{64}$/.test(id) || !isObject(raw)
    || !hasExactKeys(raw, ["root", "fingerprint", "files", "trustedAt"])
    || typeof raw.root !== "string" || typeof raw.fingerprint !== "string"
    || typeof raw.trustedAt !== "string" || !isObject(raw.files) || !validManifest(raw.files)
    || projectIdFor(raw.root) !== id || fingerprintFor(raw.root, raw.files) !== raw.fingerprint
    || Number.isNaN(Date.parse(raw.trustedAt)) || new Date(raw.trustedAt).toISOString() !== raw.trustedAt) {
    throw new Error("Project trust store contains an invalid record");
  }
  return raw as TrustRecord;
}

function rejectLegacyStore(home: string): void {
  const path = trustStorePath(home);
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_TRUST_RECORD_BYTES) {
    throw new Error("Project trust store has an unsupported shape or version");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf-8")); }
  catch { throw new Error("Project trust store is invalid JSON"); }
  if (!isObject(parsed) || !hasExactKeys(parsed, ["version", "projects"])
    || parsed.version !== SCHEMA_VERSION || !isObject(parsed.projects)) {
    throw new Error("Project trust store has an unsupported shape or version");
  }
  for (const [id, raw] of Object.entries(parsed.projects)) {
    validateRecord(id, raw);
  }
  throw new Error("Legacy aggregate project trust store is unsupported; re-trust projects with this version");
}

function boundedDirectoryNames(path: string, limit: number, errorMessage: string): string[] {
  const dir = opendirSync(path);
  const names: string[] = [];
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) break;
      if (names.length >= limit) throw new Error(errorMessage);
      names.push(entry.name);
    }
  } finally {
    dir.closeSync();
  }
  return names.sort();
}

function readStore(home: string): TrustStore {
  rejectLegacyStore(home);
  const dir = trustStoreDir(home);
  if (!existsSync(dir)) return { version: 1, projects: {} };
  const dirStat = lstatSync(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error("Project trust store directory is invalid");
  const projects: Record<string, TrustRecord> = {};
  const hardRecordLimit = PROJECT_TRUST_RECORD_LIMIT + MAX_TRUST_RECORD_OVERFLOW;
  for (const name of boundedDirectoryNames(dir, hardRecordLimit * 2, "Project trust store contains too many entries")) {
    if (/\.tmp-\d+-\d+$/.test(name)) continue;
    const match = name.match(/^([a-f0-9]{64})\.json$/);
    if (!match) throw new Error("Project trust store contains an unexpected entry");
    if (Object.keys(projects).length >= hardRecordLimit) throw new Error("Project trust store contains too many records");
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_TRUST_RECORD_BYTES) {
      throw new Error("Project trust store contains an invalid record");
    }
    let raw: unknown;
    try { raw = JSON.parse(readFileSync(path, "utf-8")); }
    catch { throw new Error("Project trust store is invalid JSON"); }
    projects[match[1]] = validateRecord(match[1], raw);
  }
  return { version: 1, projects };
}

function ensureStoreDir(home: string): string {
  rejectLegacyStore(home);
  const dir = trustStoreDir(home);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Project trust store directory is invalid");
  return dir;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function normalizeRelative(root: string, path: string): string {
  const rel = relative(root, path);
  if (!isContained(root, path) || !rel) throw new Error("Project control path escapes its root");
  return rel.split(sep).join("/");
}

function setManifestDigest(state: SnapshotState, name: string, digest: string): void {
  if (!(name in state.fileDigests) && Object.keys(state.fileDigests).length >= MAX_MANIFEST_ENTRIES) {
    throw new Error("Project control manifest has too many entries");
  }
  state.fileDigests[name] = digest;
}

function statIdentity(stat: Stats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

function assertDirectAncestors(path: string): void {
  const resolved = resolve(path);
  const volumeRoot = parsePath(resolved).root;
  let current = volumeRoot;
  for (const part of relative(volumeRoot, resolved).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("Project root has a symlink or junction ancestor");
  }
}

function assertRootIdentity(root: string, expectedIdentity: string): Stats {
  const stat = lstatSync(root) as Stats;
  if (stat.isSymbolicLink() || !stat.isDirectory() || statIdentity(stat) !== expectedIdentity
    || realpathSync.native(root) !== root) throw new Error("Project root changed while being inspected");
  return stat;
}

function verifiedLstat(root: string, rootIdentity: string, path: string): Stats {
  assertRootIdentity(root, rootIdentity);
  if (!isContained(root, resolve(path))) throw new Error("Project control path escapes its root");
  const rel = relative(root, resolve(path));
  let current = root;
  let result: Stats | undefined;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    let stat: Stats;
    try { stat = lstatSync(current) as Stats; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new MissingControl();
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error("Project control path contains a symlink or junction");
    const real = realpathSync.native(current);
    if (!isContained(root, real)) throw new Error("Project control path resolves outside its root");
    result = stat;
  }
  assertRootIdentity(root, rootIdentity);
  return result ?? lstatSync(root) as Stats;
}

function readVerifiedFile(state: SnapshotState, path: string, maxBytes: number): Buffer {
  const before = verifiedLstat(state.root, state.rootIdentity, path);
  if (!before.isFile() || before.nlink !== 1) throw new Error("Project control is not a single-link regular file");
  if (before.size > maxBytes) throw new Error("Project control exceeds its size limit");
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || statIdentity(opened) !== statIdentity(before)) {
      throw new Error("Project control changed while opening");
    }
    const buffer = Buffer.allocUnsafe(Math.max(1, opened.size + 1));
    let used = 0;
    while (used < buffer.length) {
      const count = readSync(fd, buffer, used, buffer.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used > maxBytes) throw new Error("Project control exceeds its size limit");
    const after = fstatSync(fd);
    const pathAfter = verifiedLstat(state.root, state.rootIdentity, path);
    const realAfter = realpathSync.native(path);
    if (!isContained(state.root, realAfter) || after.nlink !== 1 || pathAfter.nlink !== 1
      || statIdentity(opened) !== statIdentity(after)
      || statIdentity(opened) !== statIdentity(pathAfter) || used !== opened.size) {
      throw new Error("Project control changed while reading");
    }
    return Buffer.from(buffer.subarray(0, used));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function addSnapshotFile(state: SnapshotState, relativePath: string, manifestName = relativePath, maxBytes = MAX_MANIFEST_FILE_BYTES): void {
  if (!(manifestName in state.fileDigests) && Object.keys(state.fileDigests).length >= MAX_MANIFEST_ENTRIES) {
    throw new Error("Project control manifest exceeds 512 entries");
  }
  const path = join(state.root, ...relativePath.split("/"));
  const bytes = readVerifiedFile(state, path, maxBytes);
  state.totalBytes += bytes.length;
  if (state.totalBytes > MAX_MANIFEST_TOTAL_BYTES) throw new Error("Project control manifest exceeds 32 MiB");
  setManifestDigest(state, manifestName, sha256(bytes));
  state.projectFiles[relativePath] = { relative: relativePath, path, bytes };
}

function stableDirectoryEntries(state: SnapshotState, path: string): string[] {
  const before = verifiedLstat(state.root, state.rootIdentity, path);
  if (!before.isDirectory()) throw new Error("Project control directory is not a directory");
  const names = boundedDirectoryNames(path, MAX_MANIFEST_ENTRIES, "Project control directory has too many entries");
  const after = verifiedLstat(state.root, state.rootIdentity, path);
  const namesAfter = boundedDirectoryNames(path, MAX_MANIFEST_ENTRIES, "Project control directory has too many entries");
  if (statIdentity(before) !== statIdentity(after) || names.join("\0") !== namesAfter.join("\0")) {
    throw new Error("Project control directory changed while reading");
  }
  return names;
}

function scanDirectory(state: SnapshotState, relativeDir: string, depth = 0): void {
  if (depth > MAX_DIRECTORY_DEPTH) throw new Error("Project control directory nesting exceeds 16 levels");
  const dirPath = join(state.root, ...relativeDir.split("/"));
  const names = stableDirectoryEntries(state, dirPath);
  for (const name of names) {
    const path = join(dirPath, name);
    const rel = normalizeRelative(state.root, path);
    const stat = verifiedLstat(state.root, state.rootIdentity, path);
    if (stat.isDirectory()) {
      setManifestDigest(state, dirMarker(rel), "directory");
      scanDirectory(state, rel, depth + 1);
    }
    else if (stat.isFile()) addSnapshotFile(state, rel);
    else throw new Error("Project control directory contains a non-regular entry");
  }
  const namesAfter = stableDirectoryEntries(state, dirPath);
  if (names.join("\0") !== namesAfter.join("\0")) throw new Error("Project control directory changed while reading");
}

function addContextImports(state: SnapshotState): void {
  const seen = new Set<string>();
  const visit = (sourceRelative: string, depth: number) => {
    if (depth > 3 || seen.has(sourceRelative)) return;
    seen.add(sourceRelative);
    const source = state.projectFiles[sourceRelative];
    if (!source) return;
    const text = source.bytes.toString("utf-8");
    for (const match of text.matchAll(/@([\w./-]+\.\w+)/g)) {
      const candidate = resolve(dirname(source.path), match[1]);
      if (!isContained(state.root, candidate) || deniedCredentialPath(candidate)) continue;
      const rel = normalizeRelative(state.root, candidate);
      const manifestName = `@context/${rel}`;
      if (manifestName in state.fileDigests) continue;
      try {
        addSnapshotFile(state, rel, manifestName, MAX_CONTROL_FILE_BYTES);
        visit(rel, depth + 1);
      } catch (error) {
        if (error instanceof MissingControl) setManifestDigest(state, manifestName, "missing");
        else throw error;
      }
    }
  };
  for (const name of ["NEKO.md", "AGENTS.md", "CLAUDE.md"]) visit(name, 0);
}

function snapshotProject(cwd: string): ProjectTrustInspection {
  let root: string;
  let rootIdentity: string;
  try {
    const requested = resolve(cwd);
    assertDirectAncestors(requested);
    const rootStat = lstatSync(requested);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return emptyInspection("error", "Project root is not a direct regular directory");
    root = realpathSync.native(requested);
    rootIdentity = statIdentity(rootStat as Stats);
    assertRootIdentity(root, rootIdentity);
  } catch {
    return emptyInspection("error", "Cannot resolve project root");
  }

  const projectId = projectIdFor(root);
  const state: SnapshotState = {
    root,
    projectId,
    surfaces: [],
    fileDigests: {},
    projectFiles: {},
    totalBytes: 0,
    rootIdentity,
  };

  try {
    for (const relativePath of PROJECT_CONTROL_FILES) {
      try {
        addSnapshotFile(state, relativePath, relativePath, MAX_CONTROL_FILE_BYTES);
        state.surfaces.push(relativePath);
      } catch (error) {
        if (error instanceof MissingControl) setManifestDigest(state, relativePath, "missing");
        else throw error;
      }
    }
    for (const relativeDir of PROJECT_CONTROL_DIRS) {
      const marker = dirMarker(relativeDir);
      const path = join(root, ...relativeDir.split("/"));
      try {
        const stat = verifiedLstat(root, rootIdentity, path);
        if (!stat.isDirectory()) throw new Error("Project control directory is not a directory");
        setManifestDigest(state, marker, "directory");
        state.surfaces.push(relativeDir);
        scanDirectory(state, relativeDir);
      } catch (error) {
        if (error instanceof MissingControl) setManifestDigest(state, marker, "missing");
        else throw error;
      }
    }
    addContextImports(state);
    assertRootIdentity(root, rootIdentity);
    if (!validManifest(state.fileDigests)) throw new Error("Project control manifest is invalid");
  } catch {
    return {
      ...emptyInspection("error", "Cannot safely snapshot project control surfaces"),
      root,
      projectId,
      files: [...state.surfaces],
    };
  }

  if (!state.surfaces.length) {
    return { ...emptyInspection("none"), root, projectId, fileDigests: state.fileDigests };
  }

  const configEntries: { path: string; data: Record<string, any> }[] = [];
  let mcpServers: Record<string, any> = {};
  try {
    for (const relativePath of [".neko-core/config.json", "neko.json"] as const) {
      const file = state.projectFiles[relativePath];
      if (!file) continue;
      const parsed = JSON.parse(file.bytes.toString("utf-8").replace(/^\uFEFF/, ""));
      if (!isObject(parsed)) throw new Error("Project config must contain a JSON object");
      if (hasExecutableProjectConfig(parsed)) throw new Error("Project executable extensions must be configured globally");
      configEntries.push({ path: file.path, data: parsed });
    }
    const mcp = state.projectFiles[".mcp.json"];
    if (mcp) {
      const parsed = JSON.parse(mcp.bytes.toString("utf-8").replace(/^\uFEFF/, ""));
      if (!isObject(parsed)) throw new Error("Project MCP config must contain a JSON object");
      if (hasUnsafeConfigStructure(parsed)) throw new Error("Project executable extensions must be configured globally");
      const servers = parsed.mcpServers ?? parsed.mcp_servers;
      if (servers !== undefined && !isObject(servers)) throw new Error("Project MCP servers must be an object");
      if (servers && Object.keys(servers).length) throw new Error("Project MCP servers must be configured globally");
      mcpServers = {};
    }
  } catch (error) {
    return {
      ...emptyInspection("error", (error as Error).message.includes("configured globally")
        ? "Project-local hooks, MCP servers, and external write roots are not authoritative; configure them globally"
        : "Cannot safely parse project control configuration"),
      root,
      projectId,
      files: [...state.surfaces],
    };
  }

  const fingerprint = fingerprintFor(root, state.fileDigests);
  return {
    state: "untrusted",
    root,
    projectId,
    fingerprint,
    files: [...state.surfaces],
    fileDigests: state.fileDigests,
    projectFiles: state.projectFiles,
    configEntries,
    mcpServers,
  };
}

export function inspectProjectTrust(cwd = process.cwd(), home = homeDir()): ProjectTrustInspection {
  const snapshot = snapshotProject(cwd);
  if (snapshot.state === "none" || snapshot.state === "error") return snapshot;
  let store: TrustStore;
  try { store = readStore(home); }
  catch (error) { return { ...snapshot, state: "error", reason: (error as Error).message }; }
  const record = store.projects[snapshot.projectId!];
  if (!record) return snapshot;
  return {
    ...snapshot,
    state: record.root === snapshot.root && record.fingerprint === snapshot.fingerprint ? "trusted" : "changed",
  };
}

export function trustProject(cwd = process.cwd(), home = homeDir()): ProjectTrustSummary {
  const snapshot = snapshotProject(cwd);
  if (snapshot.state === "error") throw new Error(snapshot.reason);
  if (snapshot.state === "none") throw new Error("No project control surfaces to trust");
  const store = readStore(home); // strict: never write beside a corrupt security store
  if (!store.projects[snapshot.projectId!] && Object.keys(store.projects).length >= PROJECT_TRUST_RECORD_LIMIT) {
    throw new Error(`Project trust store has reached its ${PROJECT_TRUST_RECORD_LIMIT}-project limit`);
  }
  ensureStoreDir(home);
  const record: TrustRecord = {
    root: snapshot.root!,
    fingerprint: snapshot.fingerprint!,
    files: snapshot.fileDigests,
    trustedAt: new Date().toISOString(),
  };
  atomicWriteFileSync(trustRecordPath(home, snapshot.projectId!), JSON.stringify(record, null, 2), 0o600);
  return { state: "trusted", root: snapshot.root, projectId: snapshot.projectId, fingerprint: snapshot.fingerprint, files: snapshot.files };
}

export function revokeProjectTrust(cwd = process.cwd(), home = homeDir()): boolean {
  const snapshot = snapshotProject(cwd);
  if (!snapshot.projectId) return false;
  const store = readStore(home);
  if (!store.projects[snapshot.projectId]) return false;
  rmSync(trustRecordPath(home, snapshot.projectId));
  return true;
}

export function listTrustedProjects(home = homeDir()): ProjectTrustSummary[] {
  const store = readStore(home);
  return Object.entries(store.projects).map(([projectId, record]) => ({
    state: "trusted",
    projectId,
    root: record.root,
    fingerprint: record.fingerprint,
    files: [
      ...PROJECT_CONTROL_FILES.filter((name) => record.files[name] !== "missing"),
      ...PROJECT_CONTROL_DIRS.filter((dir) => record.files[dirMarker(dir)] === "directory"),
    ],
  }));
}
