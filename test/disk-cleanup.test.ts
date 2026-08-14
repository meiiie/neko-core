import { expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renderDiskCleanupScan, scanCleanupTargets, windowsCleanupTargets } from "../src/core/disk-cleanup.ts";

test("cleanup scan counts bytes without following links or exposing child names", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-cleanup-scan-"));
  try {
    const cache = join(root, "cache");
    mkdirSync(join(cache, "nested"), { recursive: true });
    writeFileSync(join(cache, "nested", "private-name.bin"), Buffer.alloc(1536));
    let linked = false;
    try { symlinkSync(root, join(cache, "loop"), "junction"); linked = true; } catch { /* platform policy */ }
    const report = await scanCleanupTargets([
      { name: "Test cache", location: "%TEST%\\cache", classification: "safe-cache", paths: [cache] },
    ], { maxEntries: 100, deadlineMs: 5_000 });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].bytes).toBe(1536);
    expect(report.rows[0].complete).toBe(true);
    expect(report.rows[0].skippedLinks).toBe(linked ? 1 : 0);
    const rendered = renderDiskCleanupScan(report);
    expect(rendered).toContain("read-only");
    expect(rendered).toContain("candidate bytes");
    expect(rendered).not.toContain("private-name.bin");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup scan de-duplicates hard-linked bytes and reports bounded partial results", async () => {
  const root = mkdtempSync(join(tmpdir(), "neko-cleanup-bounds-"));
  try {
    const cache = join(root, "cache");
    mkdirSync(cache);
    const first = join(cache, "first.bin");
    writeFileSync(first, Buffer.alloc(2048));
    try { linkSync(first, join(cache, "second.bin")); } catch { /* filesystem may reject hard links */ }
    writeFileSync(join(cache, "third.bin"), Buffer.alloc(1024));
    const complete = await scanCleanupTargets([
      { name: "Cache", location: "%TEST%", classification: "redownload-cache", paths: [cache] },
    ], { maxEntries: 100, deadlineMs: 5_000 });
    expect(complete.rows[0].bytes).toBeLessThanOrEqual(3072);

    const partial = await scanCleanupTargets([
      { name: "Cache", location: "%TEST%", classification: "redownload-cache", paths: [cache] },
    ], { maxEntries: 1, deadlineMs: 5_000 });
    expect(partial.rows[0].complete).toBe(false);
    expect(partial.limitReached).toBe(true);
    expect(renderDiskCleanupScan(partial)).toContain("lower bound");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Windows cleanup targets contain no overlapping VS Code CachedData entry", () => {
  const root = mkdtempSync(join(tmpdir(), "neko-cleanup-targets-"));
  try {
    const local = join(root, "Local");
    const roaming = join(root, "Roaming");
    const user = join(root, "User");
    mkdirSync(join(roaming, "Code", "CachedData"), { recursive: true });
    const targets = windowsCleanupTargets({
      SystemDrive: "C:", WINDIR: "C:\\Windows", TEMP: join(root, "Temp"),
      LOCALAPPDATA: local, APPDATA: roaming, USERPROFILE: user,
    });
    const paths = targets.flatMap((target) => target.paths.map((path) => path.replaceAll("\\", "/").toLowerCase()));
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths.filter((path) => path.endsWith("code/cacheddata"))).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
