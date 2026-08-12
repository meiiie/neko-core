import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  FRONTIER_PACK_LIMITS,
  FRONTIER_PACK_SCHEMA,
  FRONTIER_RESOURCE_MAXIMA,
  FRONTIER_TASK_FAMILIES,
  loadFrontierPack,
  type FrontierContentRole,
  type FrontierTaskFamily,
} from "../src/adapters/frontier-pack.ts";

const ROLES: readonly FrontierContentRole[] = [
  "source",
  "seededWorkspace",
  "prompt",
  "publicChecks",
  "hiddenVerifier",
  "invariants",
  "referenceRepair",
];

interface SyntheticRef {
  path: string;
  sha256: string;
}

interface SyntheticTask {
  id: string;
  family: FrontierTaskFamily;
  lineage: string;
  seed: number;
  resources: {
    wallTimeMs: number;
    maxSteps: number;
    maxModelCalls: number;
    maxToolCalls: number;
    maxInputTokens: number;
    maxOutputTokens: number;
    maxWorkspaceBytes: number;
  };
  sandboxPolicy: string;
  verifierRuntime: string;
  files: Record<FrontierContentRole, SyntheticRef>;
}

interface SyntheticManifest {
  schema: typeof FRONTIER_PACK_SCHEMA;
  packVersion: string;
  tasks: SyntheticTask[];
}

interface PackFixture {
  root: string;
  manifestPath: string;
  manifest: SyntheticManifest;
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("loads a closed 12-task pack into a deeply frozen immutable snapshot", () => {
  const fixture = makePack();
  const loaded = loadFrontierPack(fixture.manifestPath);

  expect(loaded.manifest.schema).toBe(FRONTIER_PACK_SCHEMA);
  expect(loaded.manifest.tasks).toHaveLength(12);
  expect(Object.keys(loaded.contents)).toHaveLength(12 * ROLES.length);
  expect(loaded.manifestSha256).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(loaded.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(Object.isFrozen(loaded)).toBe(true);
  expect(Object.isFrozen(loaded.manifest)).toBe(true);
  expect(Object.isFrozen(loaded.manifest.tasks)).toBe(true);
  expect(Object.isFrozen(loaded.manifest.tasks[0]?.files)).toBe(true);
  expect(Object.isFrozen(loaded.contents)).toBe(true);

  const promptPath = fixture.manifest.tasks[0]!.files.prompt.path;
  const content = loaded.contents[promptPath]!;
  expect(Object.isFrozen(content)).toBe(true);
  expect(Object.isFrozen(content.readBytes)).toBe(true);
  const firstRead = content.readBytes();
  const originalText = Buffer.from(firstRead).toString("utf8");
  const original = firstRead[0]!;
  firstRead[0] = original ^ 0xff;
  expect(content.readBytes()[0]).toBe(original);
  writeFileSync(join(fixture.root, ...promptPath.split("/")), "changed after the pack was loaded");
  expect(Buffer.from(content.readBytes()).toString("utf8")).toBe(originalText);

  const originalFrom = Uint8Array.from;
  const originalBufferLength = Object.getOwnPropertyDescriptor(Buffer.prototype, "length");
  let intercepted = false;
  let capturedSnapshot: unknown;
  let safeLength = 0;
  Object.defineProperty(Uint8Array, "from", {
    configurable: true,
    writable: true,
    value: () => { intercepted = true; throw new Error("poisoned Uint8Array.from"); },
  });
  Object.defineProperty(Buffer.prototype, "length", {
    configurable: true,
    get: function(this: unknown) { capturedSnapshot = this; return content.size; },
  });
  try {
    safeLength = content.readBytes().length;
  } finally {
    Object.defineProperty(Uint8Array, "from", { configurable: true, writable: true, value: originalFrom });
    if (originalBufferLength) Object.defineProperty(Buffer.prototype, "length", originalBufferLength);
    else delete (Buffer.prototype as unknown as Record<string, unknown>).length;
  }
  expect(intercepted).toBe(false);
  expect(capturedSnapshot).toBeUndefined();
  expect(safeLength).toBe(content.size);
});

test("binds the fingerprint to raw manifest bytes as well as referenced bytes", () => {
  const fixture = makePack();
  const first = loadFrontierPack(fixture.manifestPath);
  writeFileSync(fixture.manifestPath, `\n${JSON.stringify(fixture.manifest)}\n`);
  const second = loadFrontierPack(fixture.manifestPath);

  expect(second.manifest).toEqual(first.manifest);
  expect(second.manifestSha256).not.toBe(first.manifestSha256);
  expect(second.fingerprint).not.toBe(first.fingerprint);
});

test("fingerprinting is independent of absolute root and filesystem creation identity", () => {
  const first = loadFrontierPack(makePack().manifestPath);
  const second = loadFrontierPack(makePack().manifestPath);
  expect(second.manifestSha256).toBe(first.manifestSha256);
  expect(second.fingerprint).toBe(first.fingerprint);
  expect(first.fingerprint).toBe("sha256:de18b07d87c711189023b81942d0c24833283ec95e092a928e0479114d333ecb");
});

test("rejects referenced content that no longer matches its declared SHA-256", () => {
  const fixture = makePack();
  const promptPath = fixture.manifest.tasks[0]!.files.prompt.path;
  writeFileSync(join(fixture.root, ...promptPath.split("/")), "mutated after manifest freeze");

  expect(() => loadFrontierPack(fixture.manifestPath)).toThrow("content digest mismatch");
});

test("rejects unknown manifest fields and unsafe content paths", () => {
  const unknown = makePack();
  const withUnknown = unknown.manifest as SyntheticManifest & { unexpected?: boolean };
  withUnknown.unexpected = true;
  writeManifest(unknown);
  expect(() => loadFrontierPack(unknown.manifestPath)).toThrow("unknown or missing fields");

  const escaped = makePack();
  escaped.manifest.tasks[0]!.files.prompt.path = "../outside.txt";
  writeManifest(escaped);
  expect(() => loadFrontierPack(escaped.manifestPath)).toThrow("safe relative path");
});

test("rejects ambiguous JSON encodings and duplicate member names", () => {
  const bom = makePack();
  const manifestBytes = Buffer.from(`${JSON.stringify(bom.manifest)}\n`, "utf8");
  writeFileSync(bom.manifestPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), manifestBytes]));
  expect(() => loadFrontierPack(bom.manifestPath)).toThrow("must not start with a UTF-8 BOM");

  const duplicate = makePack();
  const canonical = `${JSON.stringify(duplicate.manifest, null, 2)}\n`;
  const schemaLine = `  "schema": "${FRONTIER_PACK_SCHEMA}",`;
  writeFileSync(duplicate.manifestPath, canonical.replace(schemaLine, `  "schema": "ignored",\n${schemaLine}`));
  expect(() => loadFrontierPack(duplicate.manifestPath)).toThrow("duplicate JSON member: schema");
});

test("rejects Windows device aliases, trailing dots, and overlong portable paths on every host", () => {
  const device = makePack();
  device.manifest.tasks[0]!.files.prompt.path = "tasks/task-01/CON.txt";
  writeManifest(device);
  expect(() => loadFrontierPack(device.manifestPath)).toThrow("safe relative path");

  const trailingDot = makePack();
  trailingDot.manifest.tasks[0]!.files.prompt.path = "tasks/task-01/prompt.";
  writeManifest(trailingDot);
  expect(() => loadFrontierPack(trailingDot.manifestPath)).toThrow("safe relative path");

  const overlong = makePack();
  const segment = `a${"b".repeat(99)}`;
  overlong.manifest.tasks[0]!.files.prompt.path = `${segment}/${segment}/${segment}`;
  writeManifest(overlong);
  expect(() => loadFrontierPack(overlong.manifestPath)).toThrow("safe relative path");

  const caseCollision = makePack();
  caseCollision.manifest.tasks[0]!.files.prompt.path = "TASKS/TASK-01/PROMPT.BIN";
  writeManifest(caseCollision);
  expect(() => loadFrontierPack(caseCollision.manifestPath)).toThrow("safe relative path");

  const prefixCasing = makePack();
  prefixCasing.manifest.tasks[0]!.files.prompt.path = "Tasks/task-01/prompt.bin";
  writeManifest(prefixCasing);
  expect(() => loadFrontierPack(prefixCasing.manifestPath)).toThrow("safe relative path");

  const manifestName = makePack();
  const renamedManifest = join(manifestName.root, "frontier pack.json");
  renameSync(manifestName.manifestPath, renamedManifest);
  manifestName.manifestPath = renamedManifest;
  expect(() => loadFrontierPack(manifestName.manifestPath)).toThrow("manifest filename is not portable");
});

test("rejects duplicate task IDs and duplicate referenced paths", () => {
  const duplicateId = makePack();
  duplicateId.manifest.tasks[1]!.id = duplicateId.manifest.tasks[0]!.id;
  writeManifest(duplicateId);
  expect(() => loadFrontierPack(duplicateId.manifestPath)).toThrow("duplicate task id");

  const duplicatePath = makePack();
  duplicatePath.manifest.tasks[1]!.files.prompt = { ...duplicatePath.manifest.tasks[0]!.files.prompt };
  writeManifest(duplicatePath);
  expect(() => loadFrontierPack(duplicatePath.manifestPath)).toThrow("duplicate content path");
});

test("enforces family balance and fixture-lineage diversity", () => {
  const unbalanced = makePack();
  unbalanced.manifest.tasks[0]!.family = unbalanced.manifest.tasks[1]!.family;
  writeManifest(unbalanced);
  expect(() => loadFrontierPack(unbalanced.manifestPath)).toThrow("family");

  const repeatedLineage = makePack();
  for (let index = 0; index < 4; index++) repeatedLineage.manifest.tasks[index]!.lineage = "shared-lineage";
  writeManifest(repeatedLineage);
  expect(() => loadFrontierPack(repeatedLineage.manifestPath)).toThrow("exceeds one quarter");
});

test("bounds every declared resource ceiling before a runner can consume it", () => {
  const keys = Object.keys(FRONTIER_RESOURCE_MAXIMA) as Array<keyof typeof FRONTIER_RESOURCE_MAXIMA>;
  const atLimit = makePack();
  for (const key of keys) atLimit.manifest.tasks[0]!.resources[key] = FRONTIER_RESOURCE_MAXIMA[key];
  writeManifest(atLimit);
  expect(loadFrontierPack(atLimit.manifestPath).manifest.tasks[0]!.resources).toEqual(FRONTIER_RESOURCE_MAXIMA);

  for (const key of keys) {
    const excessive = makePack();
    excessive.manifest.tasks[0]!.resources[key] = FRONTIER_RESOURCE_MAXIMA[key] + 1;
    writeManifest(excessive);
    expect(() => loadFrontierPack(excessive.manifestPath)).toThrow(`resources.${key} exceeds its hard maximum`);
  }
});

test("does not let relabeling or renamed copies bypass duplicate-fixture checks", () => {
  const relabeled = makePack();
  shareRoleBytes(relabeled, [0, 1, 2, 3], "source", "shared source");
  shareRoleBytes(relabeled, [0, 1, 2, 3], "seededWorkspace", "shared workspace");
  writeManifest(relabeled);
  expect(() => loadFrontierPack(relabeled.manifestPath)).toThrow("fixture identity to multiple lineages");

  const duplicatePayload = makePack();
  duplicatePayload.manifest.tasks[1]!.lineage = duplicatePayload.manifest.tasks[0]!.lineage;
  for (const role of ROLES) shareRoleBytes(duplicatePayload, [0, 1], role, `shared ${role}`);
  writeManifest(duplicatePayload);
  expect(() => loadFrontierPack(duplicatePayload.manifestPath)).toThrow("duplicate task payload");
});

test("rejects unreferenced pack-tree entries and excessive nesting", () => {
  const extra = makePack();
  writeFileSync(join(extra.root, "unreferenced.txt"), "not bound by the manifest");
  expect(() => loadFrontierPack(extra.manifestPath)).toThrow("unreferenced file");

  const deep = makePack();
  const ref = deep.manifest.tasks[0]!.files.prompt;
  const deepPath = [...Array.from({ length: FRONTIER_PACK_LIMITS.depth + 1 }, (_, index) => `d${index}`), "prompt.bin"].join("/");
  const destination = join(deep.root, ...deepPath.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(join(deep.root, ...ref.path.split("/")), destination);
  ref.path = deepPath;
  writeManifest(deep);
  expect(() => loadFrontierPack(deep.manifestPath)).toThrow("nesting exceeds 16 levels");
});

test("rejects pack trees that exceed the entry bound", () => {
  const fixture = makePack();
  for (let index = 0; index < FRONTIER_PACK_LIMITS.entries; index++) {
    mkdirSync(join(fixture.root, `extra-${index}`));
  }
  expect(() => loadFrontierPack(fixture.manifestPath)).toThrow("more than 512 entries");
});

test("enforces manifest, per-file, and aggregate byte bounds before content reads", () => {
  const manifest = makePack();
  truncateSync(manifest.manifestPath, FRONTIER_PACK_LIMITS.manifestBytes + 1);
  expect(() => loadFrontierPack(manifest.manifestPath)).toThrow("manifest exceeds 1 MiB");

  const singleFile = makePack();
  const singleRef = singleFile.manifest.tasks[0]!.files.prompt;
  truncateSync(join(singleFile.root, ...singleRef.path.split("/")), FRONTIER_PACK_LIMITS.fileBytes + 1);
  expect(() => loadFrontierPack(singleFile.manifestPath)).toThrow("file exceeds 64 MiB");

  const aggregate = makePack();
  const refs = aggregate.manifest.tasks.flatMap((task) => ROLES.map((role) => task.files[role]));
  for (const ref of refs.slice(0, 8)) {
    truncateSync(join(aggregate.root, ...ref.path.split("/")), FRONTIER_PACK_LIMITS.fileBytes);
  }
  expect(() => loadFrontierPack(aggregate.manifestPath)).toThrow("pack exceeds 512 MiB");
});

test("the maximum advertised task count fits the bounded natural pack layout", () => {
  const fixture = makePack(FRONTIER_PACK_LIMITS.tasks);
  expect(loadFrontierPack(fixture.manifestPath).manifest.tasks).toHaveLength(FRONTIER_PACK_LIMITS.tasks);
});

test("rejects a symlink or junction in the canonical pack path", () => {
  const fixture = makePack();
  const alias = join(dirname(fixture.root), "pack-alias");
  symlinkSync(fixture.root, alias, process.platform === "win32" ? "junction" : "dir");

  expect(() => loadFrontierPack(join(alias, "frontier-pack.json"))).toThrow("symlink or junction ancestor");
});

test("rejects a symlink or junction inside the pack tree", () => {
  const fixture = makePack();
  const taskDirectory = join(fixture.root, "tasks", "task-01");
  const externalDirectory = join(dirname(fixture.root), "linked-task");
  renameSync(taskDirectory, externalDirectory);
  symlinkSync(externalDirectory, taskDirectory, process.platform === "win32" ? "junction" : "dir");

  expect(() => loadFrontierPack(fixture.manifestPath)).toThrow("contains a symlink or junction");
});

test("rejects hard-linked referenced files", () => {
  const fixture = makePack();
  const ref = fixture.manifest.tasks[0]!.files.prompt;
  const target = join(fixture.root, ...ref.path.split("/"));
  const external = join(dirname(fixture.root), "external-content.bin");
  writeFileSync(external, "external hard-link source");
  unlinkSync(target);
  linkSync(external, target);

  expect(() => loadFrontierPack(fixture.manifestPath)).toThrow("hard-linked");
});

function makePack(taskCount = 12): PackFixture {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "neko-frontier-pack-")));
  tempDirs.push(base);
  const root = join(base, "pack");
  mkdirSync(root);
  const tasks: SyntheticTask[] = [];
  for (let index = 0; index < taskCount; index++) {
    const id = `task-${String(index + 1).padStart(2, "0")}`;
    const files = Object.create(null) as Record<FrontierContentRole, SyntheticRef>;
    for (const role of ROLES) {
      const fileRole = role.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      const path = `tasks/${id}/${fileRole}.bin`;
      const bytes = Buffer.from(`${id}\0${role}\0${index}`, "utf8");
      const fullPath = join(root, ...path.split("/"));
      mkdirSync(dirname(fullPath), { recursive: true });
      writeFileSync(fullPath, bytes);
      files[role] = { path, sha256: digest(bytes) };
    }
    tasks.push({
      id,
      family: FRONTIER_TASK_FAMILIES[index % FRONTIER_TASK_FAMILIES.length]!,
      lineage: `fixture-${String(index + 1).padStart(2, "0")}`,
      seed: index + 1,
      resources: {
        wallTimeMs: 60_000,
        maxSteps: 100,
        maxModelCalls: 100,
        maxToolCalls: 500,
        maxInputTokens: 1_000_000,
        maxOutputTokens: 100_000,
        maxWorkspaceBytes: 512 * 1024 * 1024,
      },
      sandboxPolicy: `sandbox-v1@sha256:${"1".repeat(64)}`,
      verifierRuntime: `verifier-v1@sha256:${"2".repeat(64)}`,
      files,
    });
  }
  const fixture: PackFixture = {
    root,
    manifestPath: join(root, "frontier-pack.json"),
    manifest: { schema: FRONTIER_PACK_SCHEMA, packVersion: "2026-08-10-v1", tasks },
  };
  writeManifest(fixture);
  return fixture;
}

function writeManifest(fixture: PackFixture): void {
  writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.manifest, null, 2)}\n`);
}

function shareRoleBytes(fixture: PackFixture, taskIndexes: readonly number[], role: FrontierContentRole, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  for (const index of taskIndexes) {
    const ref = fixture.manifest.tasks[index]!.files[role];
    writeFileSync(join(fixture.root, ...ref.path.split("/")), bytes);
    ref.sha256 = digest(bytes);
  }
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
