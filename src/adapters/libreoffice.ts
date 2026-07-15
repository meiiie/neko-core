/** Optional LibreOffice backend for independent, headless Office evidence. */
import { execFile, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, extname, join, win32 } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const MAX_OUTPUT_CHARS = 32_000;
const PDF_FILTERS = new Map([
  [".docx", "writer_pdf_Export"],
  [".xlsx", "calc_pdf_Export"],
  [".pptx", "impress_pdf_Export"],
]);

export interface LibreOfficeExecutable {
  path: string;
  source: "configured" | "path" | "system";
  version?: string;
}

export interface LibreOfficeStatus {
  state: "ready" | "missing" | "broken";
  detail: string;
  executable?: LibreOfficeExecutable;
}

export interface LibreOfficeRunResult {
  stdout: string;
  stderr: string;
}

export type LibreOfficeRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs: number },
) => Promise<LibreOfficeRunResult>;

interface DiscoveryOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  which?: (name: string) => string | null;
  exists?: (path: string) => boolean;
  versionOf?: (path: string) => string | null;
}

export function resolveLibreOfficeExecutable(options: DiscoveryOptions = {}): LibreOfficeExecutable | null {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const configured = env.NEKO_LIBREOFFICE_PATH?.trim();
  if (configured) return exists(configured) ? { path: configured, source: "configured" } : null;
  const which = options.which ?? ((name: string) => Bun.which(name));
  const platform = options.platform ?? process.platform;
  // Windows ships both launch-only soffice.exe and waitable soffice.com. The .exe can detach and leave
  // spawnSync/timeout unable to observe completion, so select the console entry point explicitly first.
  for (const name of platform === "win32" ? ["soffice.com"] : ["soffice", "libreoffice"]) {
    const path = which(name);
    if (path) return { path, source: "path" };
  }

  for (const path of systemCandidates(platform, env)) {
    if (exists(path)) return { path, source: "system" };
  }
  return null;
}

export function discoverLibreOffice(options: DiscoveryOptions = {}): LibreOfficeStatus {
  const env = options.env ?? process.env;
  const configured = env.NEKO_LIBREOFFICE_PATH?.trim();
  if (configured && !(options.exists ?? existsSync)(configured)) return {
    state: "broken",
    detail: `NEKO_LIBREOFFICE_PATH does not point to a file: ${configured}`,
  };
  const executable = resolveLibreOfficeExecutable(options);
  if (!executable) return {
    state: "missing",
    detail: "LibreOffice is not installed; PDF cross-rendering remains optional",
  };
  const version = (options.versionOf ?? libreOfficeVersion)(executable.path) ?? undefined;
  if (!version) return {
    state: "broken",
    detail: `${executable.source} LibreOffice did not pass the version probe`,
    executable,
  };
  return {
    state: "ready",
    detail: `LibreOffice ${version} (${executable.source === "configured" ? "configured executable" : executable.source === "path" ? "existing PATH install" : "existing system install"})`,
    executable: { ...executable, version },
  };
}

export async function renderPdfWithLibreOffice(options: {
  executable: LibreOfficeExecutable;
  input: string;
  destination: string;
  runner?: LibreOfficeRunner;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<LibreOfficeRunResult> {
  const filter = PDF_FILTERS.get(extname(options.input).toLowerCase());
  if (!filter) throw new Error("LibreOffice PDF export supports only .docx, .xlsx, and .pptx");
  if (!existsSync(options.input) || !statSync(options.input).isFile()) throw new Error("LibreOffice PDF source does not exist");

  const job = mkdtempSync(join(tmpdir(), "neko-libreoffice-"));
  const profile = join(job, "profile");
  const output = join(job, "output");
  mkdirSync(profile, { mode: 0o700 });
  mkdirSync(output, { mode: 0o700 });
  const expected = join(output, `${basename(options.input, extname(options.input))}.pdf`);
  let published = false;
  try {
    const args = [
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      "--headless",
      "--nologo",
      "--nodefault",
      "--norestore",
      "--convert-to",
      `pdf:${filter}`,
      "--outdir",
      output,
      options.input,
    ];
    const result = await (options.runner ?? runLibreOffice)(options.executable.path, args, {
      cwd: dirname(options.input),
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? 240_000,
    });
    if (!existsSync(expected) || !statSync(expected).isFile() || statSync(expected).size === 0) {
      const detail = cap(`${result.stderr}\n${result.stdout}`.trim());
      throw new Error(`LibreOffice completed without producing a non-empty PDF${detail ? `: ${detail}` : ""}`);
    }
    copyFileSync(expected, options.destination);
    if (!existsSync(options.destination) || statSync(options.destination).size === 0) {
      throw new Error("LibreOffice PDF could not be staged for publication");
    }
    published = true;
    return result;
  } finally {
    if (!published) rmSync(options.destination, { force: true });
    rmSync(job, { recursive: true, force: true });
  }
}

function systemCandidates(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
  if (platform === "win32") {
    const roots = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]]
      .filter((value): value is string => Boolean(value));
    const candidates: string[] = [];
    for (const root of roots) {
      const base = win32.join(root, "LibreOffice", "program");
      candidates.push(win32.join(base, "soffice.com"));
    }
    if (env.LOCALAPPDATA) {
      const base = win32.join(env.LOCALAPPDATA, "Programs", "LibreOffice", "program");
      candidates.push(win32.join(base, "soffice.com"));
    }
    return [...new Set(candidates)];
  }
  if (platform === "darwin") return ["/Applications/LibreOffice.app/Contents/MacOS/soffice"];
  if (platform === "linux") return ["/usr/bin/libreoffice", "/usr/bin/soffice", "/snap/bin/libreoffice"];
  return [];
}

function libreOfficeVersion(path: string): string | null {
  const result = spawnSync(path, ["--headless", "--version"], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.status !== 0) return null;
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.match(/\bLibreOffice\s+(\d+(?:\.\d+){1,3})\b/i)?.[1] ?? null;
}

async function runLibreOffice(
  executable: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs: number },
): Promise<LibreOfficeRunResult> {
  return await new Promise((resolvePromise, reject) => {
    execFile(executable, args, {
      cwd: options.cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      signal: options.signal,
      env: process.platform === "linux" ? { ...process.env, SAL_USE_VCLPLUGIN: "svp" } : process.env,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = cap(String(stderr || stdout || error.message).trim());
        return reject(new Error(`LibreOffice PDF export failed: ${detail || error.message}`));
      }
      resolvePromise({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function cap(value: string): string {
  return value.length > MAX_OUTPUT_CHARS ? `${value.slice(0, MAX_OUTPUT_CHARS)}\n... (truncated)` : value;
}
