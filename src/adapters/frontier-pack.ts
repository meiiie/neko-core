/**
 * Read-only loader for sealed Frontier v2 benchmark packs.
 *
 * This module validates and snapshots pack bytes. It deliberately does not extract a
 * workspace, launch a candidate, or run verifier code. Portable Node filesystem APIs
 * cannot prove the absence of a privileged same-device bind mount, so the eventual runner
 * must still supply a private read-only pack mount.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  type Stats,
} from "node:fs";
import { basename, dirname, isAbsolute, join, parse as parsePath, relative, resolve, sep } from "node:path";

export const FRONTIER_PACK_SCHEMA = "neko.eval.frontier-pack.v2" as const;

export const FRONTIER_TASK_FAMILIES = Object.freeze([
  "release-evolution",
  "recovery-durable-state",
  "concurrency-effect-integrity",
  "interface-safety-evolution",
] as const);

const CONTENT_ROLES = Object.freeze([
  "source",
  "seededWorkspace",
  "prompt",
  "publicChecks",
  "hiddenVerifier",
  "invariants",
  "referenceRepair",
] as const);

export const FRONTIER_PACK_LIMITS = Object.freeze({
  manifestBytes: 1024 * 1024,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 512 * 1024 * 1024,
  entries: 512,
  depth: 16,
  tasks: 63,
  relativePathBytes: 240,
} as const);

export const FRONTIER_RESOURCE_MAXIMA = Object.freeze({
  wallTimeMs: 24 * 60 * 60 * 1000,
  maxSteps: 10_000,
  maxModelCalls: 10_000,
  maxToolCalls: 100_000,
  maxInputTokens: 1_000_000_000,
  maxOutputTokens: 100_000_000,
  maxWorkspaceBytes: 16 * 1024 * 1024 * 1024,
} as const);

export type FrontierTaskFamily = typeof FRONTIER_TASK_FAMILIES[number];
export type FrontierContentRole = typeof CONTENT_ROLES[number];

export interface FrontierContentRef {
  readonly path: string;
  readonly sha256: string;
}

export interface FrontierResourceCeiling {
  readonly wallTimeMs: number;
  readonly maxSteps: number;
  readonly maxModelCalls: number;
  readonly maxToolCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxWorkspaceBytes: number;
}

export interface FrontierPackTask {
  readonly id: string;
  readonly family: FrontierTaskFamily;
  readonly lineage: string;
  readonly seed: number;
  /** A manifest declaration, never authority to allocate beyond runner-owned hard caps. */
  readonly resources: FrontierResourceCeiling;
  readonly sandboxPolicy: string;
  readonly verifierRuntime: string;
  readonly files: Readonly<Record<FrontierContentRole, FrontierContentRef>>;
}

export interface FrontierPackManifest {
  readonly schema: typeof FRONTIER_PACK_SCHEMA;
  readonly packVersion: string;
  readonly tasks: readonly FrontierPackTask[];
}

export interface LoadedFrontierContent {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
  /** Return a caller-owned copy; the verified snapshot remains private and immutable. */
  readonly readBytes: () => Uint8Array;
}

export interface LoadedFrontierPack {
  readonly rawManifest: string;
  readonly manifestSha256: string;
  /** Integrity identity only; a scored runner must compare an out-of-band trusted pin. */
  readonly fingerprint: string;
  readonly manifest: FrontierPackManifest;
  readonly contents: Readonly<Record<string, LoadedFrontierContent>>;
}

interface TreeEntry {
  relativePath: string;
  kind: "directory" | "file";
  identity: string;
  size: number;
}

interface TreeSnapshot {
  entries: TreeEntry[];
  totalBytes: number;
  rootIdentity: string;
}

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const PATH_SEGMENT_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const WINDOWS_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const SnapshotByteArray = Uint8Array;
const RESOURCE_KEYS = Object.freeze([
  "wallTimeMs",
  "maxSteps",
  "maxModelCalls",
  "maxToolCalls",
  "maxInputTokens",
  "maxOutputTokens",
  "maxWorkspaceBytes",
] as const);

/**
 * Load, validate, hash, and retain an immutable byte snapshot of one external pack.
 * The returned fingerprint identifies bytes but does not authenticate their curator.
 */
export function loadFrontierPack(manifestPath: string): LoadedFrontierPack {
  if (typeof manifestPath !== "string" || manifestPath.length === 0 || manifestPath.includes("\0")) {
    throw new Error("Frontier pack manifest path is invalid");
  }
  const requestedManifest = resolve(manifestPath);
  const requestedRoot = dirname(requestedManifest);
  assertCanonicalDirectory(requestedRoot, "Frontier pack root");
  assertNoLinkedAncestor(requestedManifest);
  const root = realpathSync.native(requestedRoot);
  const canonicalManifest = realpathSync.native(requestedManifest);
  if (!samePath(requestedManifest, canonicalManifest)) {
    throw new Error("Frontier pack manifest path is not canonical");
  }

  const before = scanTree(root);
  const manifestName = basename(requestedManifest);
  if (!PATH_SEGMENT_PATTERN.test(manifestName) || !portableName(manifestName)) {
    throw new Error("Frontier pack manifest filename is not portable");
  }
  const manifestEntry = before.entries.find((entry) => entry.relativePath === manifestName);
  if (!manifestEntry || manifestEntry.kind !== "file") throw new Error("Frontier pack manifest is not a regular file");
  if (manifestEntry.size > FRONTIER_PACK_LIMITS.manifestBytes) throw new Error("Frontier pack manifest exceeds 1 MiB");

  const manifestBytes = readStableFile(requestedManifest, FRONTIER_PACK_LIMITS.manifestBytes);
  const rawManifest = decodeUtf8(manifestBytes, "Frontier pack manifest is not valid UTF-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawManifest);
  } catch {
    throw new Error("Frontier pack manifest is not valid JSON");
  }
  assertUniqueJsonObjectKeys(rawManifest);
  const manifest = parseManifest(parsed, manifestName);
  const refs = referencedFiles(manifest);
  assertClosedTree(before, manifestName, refs.map((ref) => ref.path));

  const retained = new Map<string, Buffer>();
  let retainedBytes = manifestBytes.length;
  for (const ref of [...refs].sort((left, right) => compareText(left.path, right.path))) {
    const canonicalPath = resolveContentPath(root, ref.path);
    const bytes = readStableFile(canonicalPath, FRONTIER_PACK_LIMITS.fileBytes);
    retainedBytes += bytes.length;
    if (retainedBytes > FRONTIER_PACK_LIMITS.totalBytes) throw new Error("Frontier pack exceeds 512 MiB");
    const actual = sha256(bytes);
    if (actual !== ref.sha256) throw new Error(`Frontier pack content digest mismatch: ${ref.path}`);
    retained.set(ref.path, bytes);
  }

  const after = scanTree(root);
  if (treeSignature(before) !== treeSignature(after)) throw new Error("Frontier pack changed while loading");

  const manifestSha256 = sha256(manifestBytes);
  const contents = Object.create(null) as Record<string, LoadedFrontierContent>;
  for (const ref of [...refs].sort((left, right) => compareText(left.path, right.path))) {
    const snapshot = retained.get(ref.path);
    if (!snapshot) throw new Error("Frontier pack snapshot is incomplete");
    const size = snapshot.length;
    contents[ref.path] = {
      path: ref.path,
      sha256: ref.sha256,
      size,
      readBytes: () => copySnapshot(snapshot, size),
    };
  }

  const fingerprint = packFingerprint(manifestSha256, refs);
  return deepFreeze({
    rawManifest,
    manifestSha256,
    fingerprint,
    manifest,
    contents,
  });
}

function parseManifest(value: unknown, manifestName: string): FrontierPackManifest {
  const root = objectValue(value, "Frontier pack manifest");
  exactKeys(root, ["schema", "packVersion", "tasks"], "Frontier pack manifest");
  if (root.schema !== FRONTIER_PACK_SCHEMA) throw new Error(`Frontier pack schema must be ${FRONTIER_PACK_SCHEMA}`);
  const packVersion = slugValue(root.packVersion, "Frontier pack version");
  if (!Array.isArray(root.tasks) || root.tasks.length < 12 || root.tasks.length > FRONTIER_PACK_LIMITS.tasks) {
    throw new Error("Frontier pack must contain between 12 and 63 tasks");
  }

  const taskIds = new Set<string>();
  const contentPaths = new Set<string>([manifestName]);
  const tasks = root.tasks.map((task, index) => parseTask(task, index, taskIds, contentPaths));
  validateComposition(tasks);
  return deepFreeze({ schema: FRONTIER_PACK_SCHEMA, packVersion, tasks });
}

function parseTask(
  value: unknown,
  index: number,
  taskIds: Set<string>,
  contentPaths: Set<string>,
): FrontierPackTask {
  const label = `Frontier pack task ${index + 1}`;
  const task = objectValue(value, label);
  exactKeys(task, ["id", "family", "lineage", "seed", "resources", "sandboxPolicy", "verifierRuntime", "files"], label);
  const id = slugValue(task.id, `${label} id`);
  if (taskIds.has(id)) throw new Error(`Frontier pack has duplicate task id: ${id}`);
  taskIds.add(id);

  if (typeof task.family !== "string" || !FRONTIER_TASK_FAMILIES.includes(task.family as FrontierTaskFamily)) {
    throw new Error(`${label} family is invalid`);
  }
  const family = task.family as FrontierTaskFamily;
  const lineage = slugValue(task.lineage, `${label} lineage`);
  const seed = integerValue(task.seed, `${label} seed`, true);
  if (seed > 0xffff_ffff) throw new Error(`${label} seed exceeds uint32`);
  const resources = parseResources(task.resources, label);
  const sandboxPolicy = identityValue(task.sandboxPolicy, `${label} sandbox policy`);
  const verifierRuntime = identityValue(task.verifierRuntime, `${label} verifier runtime`);

  const fileObject = objectValue(task.files, `${label} files`);
  exactKeys(fileObject, CONTENT_ROLES, `${label} files`);
  const files = Object.create(null) as Record<FrontierContentRole, FrontierContentRef>;
  for (const role of CONTENT_ROLES) {
    const ref = parseContentRef(fileObject[role], `${label} ${role}`);
    if (contentPaths.has(ref.path)) throw new Error(`Frontier pack has duplicate content path: ${ref.path}`);
    contentPaths.add(ref.path);
    files[role] = ref;
  }

  return deepFreeze({ id, family, lineage, seed, resources, sandboxPolicy, verifierRuntime, files });
}

function parseResources(value: unknown, taskLabel: string): FrontierResourceCeiling {
  const resources = objectValue(value, `${taskLabel} resources`);
  exactKeys(resources, RESOURCE_KEYS, `${taskLabel} resources`);
  const parsed = Object.create(null) as Record<typeof RESOURCE_KEYS[number], number>;
  for (const key of RESOURCE_KEYS) {
    const declared = integerValue(resources[key], `${taskLabel} resources.${key}`, false);
    if (declared > FRONTIER_RESOURCE_MAXIMA[key]) throw new Error(`${taskLabel} resources.${key} exceeds its hard maximum`);
    parsed[key] = declared;
  }
  return deepFreeze(parsed) as unknown as FrontierResourceCeiling;
}

function parseContentRef(value: unknown, label: string): FrontierContentRef {
  const ref = objectValue(value, label);
  exactKeys(ref, ["path", "sha256"], label);
  const path = safeRelativePath(ref.path, `${label} path`);
  if (typeof ref.sha256 !== "string" || !DIGEST_PATTERN.test(ref.sha256)) {
    throw new Error(`${label} SHA-256 is invalid`);
  }
  return Object.freeze({ path, sha256: ref.sha256 });
}

function validateComposition(tasks: readonly FrontierPackTask[]): void {
  const families = new Map<FrontierTaskFamily, number>();
  const lineages = new Map<string, number>();
  const fixtureLineages = new Map<string, string>();
  const taskPayloads = new Set<string>();
  for (const task of tasks) {
    families.set(task.family, (families.get(task.family) ?? 0) + 1);
    lineages.set(task.lineage, (lineages.get(task.lineage) ?? 0) + 1);
    bindFixtureLineage(fixtureLineages, `source:${task.files.source.sha256}`, task.lineage);
    bindFixtureLineage(fixtureLineages, `workspace:${task.files.seededWorkspace.sha256}`, task.lineage);
    const payload = CONTENT_ROLES.map((role) => task.files[role].sha256).join("\0");
    if (taskPayloads.has(payload)) throw new Error(`Frontier pack has duplicate task payload: ${task.id}`);
    taskPayloads.add(payload);
  }
  for (const family of FRONTIER_TASK_FAMILIES) {
    const count = families.get(family) ?? 0;
    if (count < 3) throw new Error(`Frontier pack family ${family} has fewer than three tasks`);
    if (count * 3 > tasks.length) throw new Error(`Frontier pack family ${family} exceeds one third of the pack`);
  }
  for (const [lineage, count] of lineages) {
    if (count * 4 > tasks.length) throw new Error(`Frontier pack lineage ${lineage} exceeds one quarter of the pack`);
  }
}

function bindFixtureLineage(identities: Map<string, string>, identity: string, lineage: string): void {
  const existing = identities.get(identity);
  if (existing !== undefined && existing !== lineage) {
    throw new Error("Frontier pack assigns one fixture identity to multiple lineages");
  }
  identities.set(identity, lineage);
}

function referencedFiles(manifest: FrontierPackManifest): FrontierContentRef[] {
  return manifest.tasks.flatMap((task) => CONTENT_ROLES.map((role) => task.files[role]));
}

function scanTree(root: string): TreeSnapshot {
  const entries: TreeEntry[] = [];
  let totalBytes = 0;
  let entryCount = 0;
  const rootStat = lstatSync(root);
  const rootIdentity = directoryIdentity(rootStat);

  const visit = (directory: string, relativeDirectory: string, depth: number): void => {
    if (depth > FRONTIER_PACK_LIMITS.depth) throw new Error("Frontier pack directory nesting exceeds 16 levels");
    const before = lstatSync(directory);
    if (!before.isDirectory() || before.isSymbolicLink()) throw new Error("Frontier pack contains an invalid directory");
    if (before.dev !== rootStat.dev) throw new Error("Frontier pack contains a cross-device mount");
    assertCanonicalPath(directory, root);
    const names = boundedDirectoryNames(directory, FRONTIER_PACK_LIMITS.entries - entryCount);
    for (const name of names) {
      if (++entryCount > FRONTIER_PACK_LIMITS.entries) throw new Error("Frontier pack has more than 512 entries");
      const path = join(directory, name);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`Frontier pack contains a symlink or junction: ${relativePath}`);
      if (stat.dev !== rootStat.dev) throw new Error(`Frontier pack contains a cross-device mount: ${relativePath}`);
      assertCanonicalPath(path, root);
      if (stat.isDirectory()) {
        entries.push({ relativePath, kind: "directory", identity: directoryIdentity(stat), size: 0 });
        visit(path, relativePath, depth + 1);
      } else if (stat.isFile()) {
        if (stat.nlink !== 1) throw new Error(`Frontier pack file is hard-linked: ${relativePath}`);
        if (stat.size > FRONTIER_PACK_LIMITS.fileBytes) throw new Error(`Frontier pack file exceeds 64 MiB: ${relativePath}`);
        totalBytes += stat.size;
        if (totalBytes > FRONTIER_PACK_LIMITS.totalBytes) throw new Error("Frontier pack exceeds 512 MiB");
        entries.push({ relativePath, kind: "file", identity: fileObjectIdentity(stat), size: stat.size });
      } else {
        throw new Error(`Frontier pack contains a non-regular entry: ${relativePath}`);
      }
    }
    const after = lstatSync(directory);
    const namesAfter = boundedDirectoryNames(directory, FRONTIER_PACK_LIMITS.entries);
    if (directoryIdentity(before) !== directoryIdentity(after) || names.join("\0") !== namesAfter.join("\0")) {
      throw new Error("Frontier pack changed while scanning");
    }
  };

  visit(root, "", 0);
  entries.sort((left, right) => compareText(left.relativePath, right.relativePath));
  return { entries, totalBytes, rootIdentity };
}

function boundedDirectoryNames(path: string, limit: number): string[] {
  const directory = opendirSync(path);
  const names: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (!entry) break;
      if (names.length >= limit) throw new Error("Frontier pack has more than 512 entries");
      names.push(entry.name);
    }
  } finally {
    directory.closeSync();
  }
  return names.sort();
}

function assertClosedTree(snapshot: TreeSnapshot, manifestName: string, refs: readonly string[]): void {
  const expectedFiles = new Set([manifestName, ...refs]);
  const expectedDirectories = new Set<string>();
  for (const path of refs) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++) expectedDirectories.add(parts.slice(0, index).join("/"));
  }
  const actualFiles = new Set(snapshot.entries.filter((entry) => entry.kind === "file").map((entry) => entry.relativePath));
  const actualDirectories = new Set(snapshot.entries.filter((entry) => entry.kind === "directory").map((entry) => entry.relativePath));
  const missing = [...expectedFiles].find((path) => !actualFiles.has(path));
  if (missing) throw new Error(`Frontier pack referenced content is missing: ${missing}`);
  const extraFile = [...actualFiles].find((path) => !expectedFiles.has(path));
  if (extraFile) throw new Error(`Frontier pack contains unreferenced file: ${extraFile}`);
  const extraDirectory = [...actualDirectories].find((path) => !expectedDirectories.has(path));
  if (extraDirectory) throw new Error(`Frontier pack contains unreferenced directory: ${extraDirectory}`);
  const missingDirectory = [...expectedDirectories].find((path) => !actualDirectories.has(path));
  if (missingDirectory) throw new Error(`Frontier pack referenced directory is missing: ${missingDirectory}`);
}

function resolveContentPath(root: string, relativePath: string): string {
  const candidate = resolve(root, ...relativePath.split("/"));
  if (!inside(root, candidate)) throw new Error(`Frontier pack content escapes its root: ${relativePath}`);
  assertCanonicalPath(candidate, root);
  return candidate;
}

function readStableFile(path: string, maxBytes: number): Buffer {
  const before = lstatSync(path);
  assertSingleLinkFile(before, path, maxBytes);
  const flags = fsConstants.O_RDONLY | (process.platform === "win32"
    ? 0
    : (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0));
  let fd: number | undefined;
  try {
    fd = openSync(path, flags);
    const opened = fstatSync(fd);
    assertSingleLinkFile(opened, path, maxBytes);
    if (!sameFileObject(before, opened)) throw new Error("Frontier pack file changed before it was opened");
    const bytes = Buffer.allocUnsafe(opened.size);
    let used = 0;
    while (used < bytes.length) {
      const count = readSync(fd, bytes, used, bytes.length - used, null);
      if (count === 0) break;
      used += count;
    }
    const after = fstatSync(fd);
    const pathAfter = lstatSync(path);
    assertSingleLinkFile(after, path, maxBytes);
    assertSingleLinkFile(pathAfter, path, maxBytes);
    if (used !== opened.size || statIdentity(opened) !== statIdentity(after)
      || !sameFileObject(before, pathAfter) || !sameFileObject(opened, pathAfter)) {
      throw new Error("Frontier pack file changed while reading");
    }
    const realAfter = realpathSync.native(path);
    if (!samePath(path, realAfter)) throw new Error("Frontier pack file path changed while reading");
    return bytes;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function assertSingleLinkFile(stat: Stats, path: string, maxBytes: number): void {
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Frontier pack path is not a regular file: ${path}`);
  if (stat.nlink !== 1) throw new Error(`Frontier pack path is hard-linked: ${path}`);
  if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) throw new Error(`Frontier pack file exceeds its size limit: ${path}`);
}

function assertCanonicalDirectory(path: string, label: string): void {
  assertNoLinkedAncestor(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} is not a canonical directory`);
  const real = realpathSync.native(path);
  if (!samePath(path, real)) throw new Error(`${label} is not canonical`);
}

function assertNoLinkedAncestor(path: string): void {
  const absolute = resolve(path);
  const volumeRoot = parsePath(absolute).root;
  let current = volumeRoot;
  for (const part of relative(volumeRoot, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("Frontier pack path has a symlink or junction ancestor");
  }
}

function assertCanonicalPath(path: string, root: string): void {
  if (!inside(root, path)) throw new Error("Frontier pack path escapes its root");
  const real = realpathSync.native(path);
  if (!inside(root, real) || !samePath(path, real)) throw new Error("Frontier pack path is not canonical");
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function samePath(left: string, right: string): boolean {
  return relative(left, right) === "";
}

function sameFileObject(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.nlink === right.nlink && left.size === right.size;
}

function statIdentity(stat: Stats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
}

function directoryIdentity(stat: Stats): string {
  return [stat.dev, stat.ino].join(":");
}

function fileObjectIdentity(stat: Stats): string {
  return [stat.dev, stat.ino, stat.nlink, stat.size].join(":");
}

function treeSignature(snapshot: TreeSnapshot): string {
  return `${snapshot.rootIdentity}\n${snapshot.entries.map((entry) => `${entry.relativePath}\0${entry.kind}\0${entry.identity}`).join("\n")}`;
}

function packFingerprint(manifestSha256: string, refs: readonly FrontierContentRef[]): string {
  const hash = createHash("sha256");
  hash.update("neko.eval.frontier-pack.fingerprint.v2\0");
  hash.update(manifestSha256);
  for (const ref of [...refs].sort((left, right) => compareText(left.path, right.path))) {
    hash.update("\0");
    hash.update(ref.path);
    hash.update("\0");
    hash.update(ref.sha256);
  }
  return `sha256:${hash.digest("hex")}`;
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function copySnapshot(snapshot: Uint8Array, size: number): Uint8Array {
  const copy = new SnapshotByteArray(size);
  for (let index = 0; index < size; index++) copy[index] = snapshot[index]!;
  return copy;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertUniqueJsonObjectKeys(source: string): void {
  let position = 0;
  const skipWhitespace = (): void => {
    while (position < source.length && /[\t\n\r ]/.test(source[position]!)) position++;
  };
  const scanString = (): string => {
    const start = position++;
    while (position < source.length) {
      const character = source[position++]!;
      if (character === "\\") position++;
      else if (character === "\"") return JSON.parse(source.slice(start, position)) as string;
    }
    throw new Error("Frontier pack manifest is not valid JSON");
  };
  const scanValue = (depth: number): void => {
    if (depth > 32) throw new Error("Frontier pack manifest nesting exceeds 32 levels");
    skipWhitespace();
    const character = source[position];
    if (character === "{") {
      position++;
      const keys = new Set<string>();
      skipWhitespace();
      if (source[position] === "}") { position++; return; }
      for (;;) {
        skipWhitespace();
        if (source[position] !== "\"") throw new Error("Frontier pack manifest is not valid JSON");
        const key = scanString();
        if (keys.has(key)) throw new Error(`Frontier pack manifest has duplicate JSON member: ${key}`);
        keys.add(key);
        skipWhitespace();
        if (source[position++] !== ":") throw new Error("Frontier pack manifest is not valid JSON");
        scanValue(depth + 1);
        skipWhitespace();
        const delimiter = source[position++];
        if (delimiter === "}") return;
        if (delimiter !== ",") throw new Error("Frontier pack manifest is not valid JSON");
      }
    }
    if (character === "[") {
      position++;
      skipWhitespace();
      if (source[position] === "]") { position++; return; }
      for (;;) {
        scanValue(depth + 1);
        skipWhitespace();
        const delimiter = source[position++];
        if (delimiter === "]") return;
        if (delimiter !== ",") throw new Error("Frontier pack manifest is not valid JSON");
      }
    }
    if (character === "\"") {
      scanString();
      return;
    }
    const start = position;
    while (position < source.length && !/[\t\n\r ,}\]]/.test(source[position]!)) position++;
    if (position === start) throw new Error("Frontier pack manifest is not valid JSON");
  };

  scanValue(0);
  skipWhitespace();
  if (position !== source.length) throw new Error("Frontier pack manifest is not valid JSON");
}

function decodeUtf8(bytes: Uint8Array, message: string): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error("Frontier pack manifest must not start with a UTF-8 BOM");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(message);
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (actual.length !== sortedExpected.length || actual.some((key, index) => key !== sortedExpected[index])) {
    throw new Error(`${label} has unknown or missing fields`);
  }
}

function slugValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !SLUG_PATTERN.test(value) || !portableName(value)) throw new Error(`${label} is invalid`);
  return value;
}

function identityValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || !/^[\x20-\x7e]+$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function integerValue(value: unknown, label: string, allowZero: boolean): number {
  if (!Number.isSafeInteger(value) || typeof value !== "number" || (allowZero ? value < 0 : value <= 0)) {
    throw new Error(`${label} must be ${allowZero ? "a non-negative" : "a positive"} safe integer`);
  }
  return value;
}

function safeRelativePath(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > FRONTIER_PACK_LIMITS.relativePathBytes || value.includes("\\")
    || isAbsolute(value) || /^(?:[A-Za-z]:|\/\/)/.test(value) || /[\0-\x1f\x7f]/.test(value)) {
    throw new Error(`${label} is not a safe relative path`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !PATH_SEGMENT_PATTERN.test(part) || !portableName(part) || part === "." || part === "..")) {
    throw new Error(`${label} is not a safe relative path`);
  }
  return parts.join("/");
}

function portableName(value: string): boolean {
  return !value.endsWith(".") && !WINDOWS_DEVICE_PATTERN.test(value);
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}
