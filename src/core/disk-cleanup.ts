/** Bounded, metadata-only Windows cleanup inventory. This deliberately does not execute a shell,
 * open file contents, follow links, or delete anything. */
import { opendir, lstat, statfs } from "node:fs/promises";
import { lstatSync, readdirSync } from "node:fs";
import { join as fsJoin, win32 as winPath } from "node:path";

export type CleanupClassification =
  | "safe-cache"
  | "redownload-cache"
  | "windows-managed"
  | "manual-review"
  | "do-not-delete";

export interface CleanupTarget {
  name: string;
  location: string;
  classification: CleanupClassification;
  paths: string[];
}

export interface CleanupScanRow extends Omit<CleanupTarget, "paths"> {
  bytes: number;
  complete: boolean;
  accessErrors: number;
  skippedLinks: number;
}

export interface CleanupScanReport {
  rows: CleanupScanRow[];
  entries: number;
  accessErrors: number;
  skippedLinks: number;
  elapsedMs: number;
  deadlineReached: boolean;
  limitReached: boolean;
  interrupted: boolean;
}

interface CleanupScanOptions {
  deadlineMs?: number;
  maxEntries?: number;
  signal?: AbortSignal;
}

const DEFAULT_SCAN_DEADLINE_MS = 60_000;
const DEFAULT_MAX_ENTRIES = 500_000;

function immediateDirectories(path: string): string[] {
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => winPath.join(path, entry.name));
  } catch {
    return [];
  }
}

function existingFileUnderImmediateDirectories(parent: string, ...child: string[]): string[] {
  return immediateDirectories(parent)
    .map((directory) => winPath.join(directory, ...child))
    .filter((path) => {
      try { return lstatSync(path).isFile(); } catch { return false; }
    });
}

/** Build non-overlapping, allowlisted locations. Returned display paths never contain a username. */
export function windowsCleanupTargets(env: Readonly<Record<string, string | undefined>> = process.env): CleanupTarget[] {
  const systemDrive = String(env.SystemDrive || (/^[A-Za-z]:/.exec(String(env.WINDIR || ""))?.[0]) || "C:");
  const windows = env.WINDIR || winPath.join(systemDrive, "Windows");
  const local = env.LOCALAPPDATA || "";
  const roaming = env.APPDATA || "";
  const user = env.USERPROFILE || "";
  const temp = env.TEMP || env.TMP || "";
  const at = (base: string, ...parts: string[]): string[] => base ? [winPath.join(base, ...parts)] : [];
  const browserCaches = (base: string): string[] => immediateDirectories(base)
    .flatMap((profile) => ["Cache", "Code Cache", "GPUCache"].map((name) => winPath.join(profile, name)));

  const targets: CleanupTarget[] = [
    { name: "User TEMP", location: "%TEMP%", classification: "safe-cache", paths: temp ? [temp] : [] },
    { name: "Windows TEMP", location: "%WINDIR%\\Temp", classification: "windows-managed", paths: at(windows, "Temp") },
    { name: "Windows Update downloads", location: "%WINDIR%\\SoftwareDistribution\\Download", classification: "windows-managed", paths: at(windows, "SoftwareDistribution", "Download") },
    { name: "Delivery Optimization cache", location: "%WINDIR% service cache", classification: "windows-managed", paths: at(windows, "ServiceProfiles", "NetworkService", "AppData", "Local", "Microsoft", "Windows", "DeliveryOptimization", "Cache") },
    { name: "Recycle Bin", location: `${systemDrive}\\$Recycle.Bin`, classification: "windows-managed", paths: [winPath.join(`${systemDrive}\\`, "$Recycle.Bin")] },
    { name: "Crash dumps", location: "%LOCALAPPDATA%\\CrashDumps + %WINDIR%\\Minidump", classification: "safe-cache", paths: [...at(local, "CrashDumps"), ...at(windows, "Minidump")] },
    { name: "Windows memory dump", location: "%WINDIR%\\MEMORY.DMP", classification: "manual-review", paths: at(windows, "MEMORY.DMP") },
    { name: "Windows.old", location: `${systemDrive}\\Windows.old`, classification: "windows-managed", paths: [winPath.join(`${systemDrive}\\`, "Windows.old")] },
    { name: "Chrome caches", location: "%LOCALAPPDATA%\\Google\\Chrome\\User Data\\*\\{Cache,Code Cache,GPUCache}", classification: "safe-cache", paths: local ? browserCaches(winPath.join(local, "Google", "Chrome", "User Data")) : [] },
    { name: "Edge caches", location: "%LOCALAPPDATA%\\Microsoft\\Edge\\User Data\\*\\{Cache,Code Cache,GPUCache}", classification: "safe-cache", paths: local ? browserCaches(winPath.join(local, "Microsoft", "Edge", "User Data")) : [] },
    { name: "Shader caches", location: "%LOCALAPPDATA%\\{D3DSCache,NVIDIA\\DXCache,NVIDIA\\GLCache}", classification: "safe-cache", paths: [...at(local, "D3DSCache"), ...at(local, "NVIDIA", "DXCache"), ...at(local, "NVIDIA", "GLCache")] },
    { name: "Python and JS package caches", location: "pip/npm/Yarn/pnpm/uv caches", classification: "redownload-cache", paths: [...at(local, "pip", "cache"), ...at(roaming, "npm-cache"), ...at(local, "npm-cache"), ...at(local, "Yarn", "Cache"), ...at(local, "pnpm", "store"), ...at(local, "uv", "cache")] },
    { name: "Build dependency caches", location: "%USERPROFILE%\\{.nuget,.gradle,.m2,.cache}", classification: "redownload-cache", paths: [...at(user, ".nuget", "packages"), ...at(user, ".gradle", "caches"), ...at(user, ".m2", "repository"), ...at(user, ".cache", "huggingface"), ...at(user, ".cache", "torch")] },
    { name: "Conda package cache", location: "%USERPROFILE%\\.conda\\pkgs", classification: "manual-review", paths: at(user, ".conda", "pkgs") },
    { name: "VS Code caches", location: "%APPDATA%\\Code\\{Cache,CachedData,Code Cache,GPUCache}", classification: "safe-cache", paths: ["Cache", "CachedData", "Code Cache", "GPUCache"].flatMap((name) => at(roaming, "Code", name)) },
    { name: "Windows Installer cache", location: "%WINDIR%\\Installer", classification: "do-not-delete", paths: at(windows, "Installer") },
    { name: "Installer package cache", location: "%ProgramData%\\Package Cache", classification: "manual-review", paths: at(env.ProgramData || winPath.join(systemDrive, "ProgramData"), "Package Cache") },
    { name: "System paging and hibernation files", location: `${systemDrive}\\{hiberfil.sys,pagefile.sys,swapfile.sys}`, classification: "do-not-delete", paths: ["hiberfil.sys", "pagefile.sys", "swapfile.sys"].map((name) => winPath.join(`${systemDrive}\\`, name)) },
    { name: "WSL virtual disks", location: "%LOCALAPPDATA%\\Packages\\*\\LocalState\\ext4.vhdx", classification: "manual-review", paths: local ? existingFileUnderImmediateDirectories(winPath.join(local, "Packages"), "LocalState", "ext4.vhdx") : [] },
    { name: "Docker Desktop data", location: "%LOCALAPPDATA%\\Docker\\wsl", classification: "manual-review", paths: at(local, "Docker", "wsl") },
    { name: "Downloads", location: "%USERPROFILE%\\Downloads", classification: "manual-review", paths: at(user, "Downloads") },
  ];

  const seen = new Set<string>();
  return targets.map((target) => ({
    ...target,
    paths: target.paths.filter((path) => {
      const key = winPath.normalize(path).toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }),
  }));
}

export async function scanCleanupTargets(targets: readonly CleanupTarget[], options: CleanupScanOptions = {}): Promise<CleanupScanReport> {
  const startedAt = Date.now();
  const deadlineAt = startedAt + Math.min(120_000, Math.max(100, Math.floor(options.deadlineMs ?? DEFAULT_SCAN_DEADLINE_MS)));
  const maxEntries = Math.min(2_000_000, Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_MAX_ENTRIES)));
  const rows: CleanupScanRow[] = [];
  const hardlinks = new Set<string>();
  let entries = 0;
  let accessErrors = 0;
  let skippedLinks = 0;
  let deadlineReached = false;
  let limitReached = false;
  let interrupted = false;

  const stopped = (): boolean => {
    if (options.signal?.aborted) interrupted = true;
    if (Date.now() >= deadlineAt) deadlineReached = true;
    return interrupted || deadlineReached || limitReached;
  };

  for (const target of targets) {
    if (stopped()) break;
    const { paths, ...metadata } = target;
    const row: CleanupScanRow = { ...metadata, bytes: 0, complete: true, accessErrors: 0, skippedLinks: 0 };
    let found = false;
    for (const root of paths) {
      if (stopped()) { row.complete = false; break; }
      let rootStat;
      try { rootStat = await lstat(root); found = true; }
      catch (error) {
        // SAFETY: fs errors from this module's own typed calls carry the errno contract.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") { row.accessErrors++; accessErrors++; row.complete = false; }
        continue;
      }
      if (rootStat.isSymbolicLink()) { row.skippedLinks++; skippedLinks++; continue; }
      const stack = rootStat.isDirectory() ? [root] : [];
      if (!rootStat.isDirectory()) {
        const identity = rootStat.nlink > 1 && rootStat.ino ? `${rootStat.dev}:${rootStat.ino}` : "";
        if (!identity || !hardlinks.has(identity)) { row.bytes += rootStat.size; if (identity) hardlinks.add(identity); }
      }
      while (stack.length && !stopped()) {
        const directory = stack.pop()!;
        try {
          const handle = await opendir(directory);
          for await (const entry of handle) {
            if (entries >= maxEntries) { limitReached = true; row.complete = false; break; }
            entries++;
            if (stopped()) { row.complete = false; break; }
            // `scanCleanupTargets` is also exercised with native POSIX fixture paths in CI.
            // Target discovery is Windows-specific, but walking must use the host path rules.
            const path = fsJoin(directory, entry.name);
            if (entry.isSymbolicLink()) { row.skippedLinks++; skippedLinks++; continue; }
            if (entry.isDirectory()) { stack.push(path); continue; }
            try {
              const stat = await lstat(path);
              if (stat.isSymbolicLink()) { row.skippedLinks++; skippedLinks++; continue; }
              if (stat.isDirectory()) { stack.push(path); continue; }
              if (!stat.isFile()) continue;
              const identity = stat.nlink > 1 && stat.ino ? `${stat.dev}:${stat.ino}` : "";
              if (identity && hardlinks.has(identity)) continue;
              row.bytes += stat.size;
              if (identity) hardlinks.add(identity);
            } catch {
              row.accessErrors++; accessErrors++; row.complete = false;
            }
          }
        } catch {
          row.accessErrors++; accessErrors++; row.complete = false;
        }
      }
    }
    if (stopped()) row.complete = false;
    if (found) rows.push(row);
  }

  return {
    rows,
    entries,
    accessErrors,
    skippedLinks,
    elapsedMs: Date.now() - startedAt,
    deadlineReached,
    limitReached,
    interrupted,
  };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

export function renderDiskCleanupScan(report: CleanupScanReport, drive?: { total: number; free: number }): string {
  if (report.interrupted) return "(interrupted)";
  const incomplete = report.deadlineReached || report.limitReached || report.rows.some((row) => !row.complete);
  const lines = [
    "Windows disk cleanup scan (read-only; no file contents opened; nothing deleted)",
    "Measured values are candidate bytes, not promised reclaimable space. Use Windows/app cleanup for windows-managed items.",
  ];
  if (drive) lines.push(`System drive: total=${formatBytes(drive.total)} free=${formatBytes(drive.free)} used=${formatBytes(Math.max(0, drive.total - drive.free))}`);
  for (const row of [...report.rows].sort((a, b) => b.bytes - a.bytes)) {
    lines.push(`${formatBytes(row.bytes).padStart(10)} [${row.classification}; ${row.complete ? "complete" : "partial lower bound"}] ${row.name} - ${row.location}`);
  }
  for (const classification of ["safe-cache", "redownload-cache"] as const) {
    const bytes = report.rows.filter((row) => row.classification === classification).reduce((sum, row) => sum + row.bytes, 0);
    lines.push(`${classification} candidate ${incomplete ? "lower bound" : "total"}: ${formatBytes(bytes)}`);
  }
  lines.push(`Scan: entries=${report.entries} access_errors=${report.accessErrors} skipped_links=${report.skippedLinks} elapsed_ms=${report.elapsedMs} deadline=${report.deadlineReached} entry_limit=${report.limitReached}`);
  lines.push("No delete action is provided by this tool. Review active apps, retention needs, and Windows-managed cleanup before removing anything.");
  return lines.join("\n");
}

export async function runDiskCleanupScan(signal?: AbortSignal): Promise<string> {
  if (process.platform !== "win32") return "Error: disk_cleanup_scan is Windows-only.";
  if (signal?.aborted) return "(interrupted)";
  const systemDrive = String(process.env.SystemDrive || "C:");
  let drive: { total: number; free: number } | undefined;
  try {
    const stats = await statfs(`${systemDrive}\\`);
    drive = { total: stats.blocks * stats.bsize, free: stats.bavail * stats.bsize };
  } catch { /* candidate scan remains useful without capacity metadata */ }
  const report = await scanCleanupTargets(windowsCleanupTargets(), { signal });
  return renderDiskCleanupScan(report, drive);
}
