/** Typed, workspace-bounded Office artifact tools backed by an optional OfficeCLI binary. */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import type { McpTools } from "../core/ports.ts";
import { composeMcpTools } from "./mcp-compose.ts";
import {
  discoverLibreOffice,
  renderPdfWithLibreOffice,
  type LibreOfficeExecutable,
  type LibreOfficeRunner,
} from "./libreoffice.ts";
import { discoverOfficeCli, resolveOfficeExecutable, type OfficeExecutable } from "./office-support-pack.ts";

const TOOL_PREFIX = "mcp__neko_office__";
const MAX_FILE_BYTES = 512 * 1024 * 1024;
const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_RESULT_CHARS = 200_000;
const ALLOWED_BATCH_OPS = new Set(["add", "set", "remove", "move", "swap"]);
const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".pptx"]);

const OFFICE_SCHEMAS = [
  {
    name: "inspect",
    description: "Read or validate a Word, Excel, or PowerPoint artifact without changing it. Use status before first use; inspect targeted structure before editing.",
    properties: {
      operation: { type: "string", enum: ["status", "help", "outline", "text", "annotated", "stats", "issues", "get", "query", "validate"] },
      file: { type: "string", description: "Workspace-relative .docx, .xlsx, or .pptx path; omitted only for status/help." },
      selector: { type: "string", description: "Stable OfficeCLI path for get, or selector expression for query." },
      format: { type: "string", enum: ["docx", "xlsx", "pptx"], description: "Required by help." },
      element: { type: "string", description: "Optional element/property name for help." },
      depth: { type: "integer", minimum: 0, maximum: 8 },
      max_lines: { type: "integer", minimum: 1, maximum: 5000 },
      columns: { type: "string", description: "Optional comma-separated Excel columns for text view, e.g. A,B,C." },
    },
    required: ["operation"],
  },
  {
    name: "apply",
    description: "Create or transactionally edit an Office artifact with one typed batch. Existing sources are copied to a derivative by default; same-file overwrite requires an explicit hash precondition. Gated.",
    properties: {
      source: { type: "string", description: "Optional existing workspace-relative source artifact. Omit to create a new artifact." },
      output: { type: "string", description: "Workspace-relative output artifact (.docx/.xlsx/.pptx)." },
      commands: {
        type: "array", minItems: 1, maxItems: 500,
        description: "OfficeCLI batch objects. Each must use only add/set/remove/move/swap; raw XML and arbitrary commands are excluded from this adapter.",
        items: { type: "object", additionalProperties: true },
      },
      expected_source_sha256: { type: "string", pattern: "^[0-9a-fA-F]{64}$", description: "Optimistic concurrency check; mandatory for same-file overwrite." },
      overwrite: { type: "boolean", description: "Replace an existing output only after the staged artifact validates." },
    },
    required: ["output", "commands"],
  },
  {
    name: "render",
    description: "Render an Office artifact to PNG or standalone HTML with the typed engine, or cross-render a whole-file PDF with an installed LibreOffice. This writes evidence inside the workspace and is gated.",
    properties: {
      file: { type: "string", description: "Workspace-relative Office artifact." },
      mode: { type: "string", enum: ["screenshot", "html", "pdf"] },
      output: { type: "string", description: "Workspace-relative .png, .html, or .pdf evidence path." },
      page: { type: "string", pattern: "^[0-9]+(?:-[0-9]+)?$", description: "Optional page/slide number or inclusive range for screenshot/html. PDF always exports the complete artifact." },
      overwrite: { type: "boolean" },
    },
    required: ["file", "mode", "output"],
  },
].map((tool) => ({
  type: "function",
  function: {
    name: `${TOOL_PREFIX}${tool.name}`,
    description: tool.description,
    parameters: { type: "object", properties: tool.properties, required: tool.required, additionalProperties: false },
  },
}));

export interface OfficeRunResult { stdout: string; stderr: string; }
export type OfficeRunner = (
  executable: string,
  args: string[],
  options: { cwd: string; signal?: AbortSignal; timeoutMs: number },
) => Promise<OfficeRunResult>;

export interface OfficeToolsOptions {
  executable?: OfficeExecutable | null;
  runner?: OfficeRunner;
  libreOffice?: LibreOfficeExecutable | null;
  libreOfficeRunner?: LibreOfficeRunner;
}

class OfficeTools implements McpTools {
  private verifiedManaged?: { key: string; check: Promise<void> };
  private resolvedLibreOffice?: LibreOfficeExecutable;

  constructor(
    private readonly root: string,
    private readonly options: OfficeToolsOptions = {},
  ) {}

  toolSchemas(): any[] { return OFFICE_SCHEMAS; }
  has(name: string): boolean { return OFFICE_SCHEMAS.some((schema) => schema.function.name === name); }
  permission(name: string): "safe" | "gated" { return name === `${TOOL_PREFIX}inspect` ? "safe" : "gated"; }
  indexBlock(): string {
    return "Neko Office tools are local, workspace-bounded, and optional. Load the office-artifacts skill before Office work. Read/validate is safe; apply/render remains approval-gated. PDF render uses an isolated installed LibreOffice as independent evidence.";
  }

  async call(name: string, args: Record<string, any>, signal?: AbortSignal): Promise<string> {
    const action = name.slice(TOOL_PREFIX.length);
    if (action === "inspect") return await this.inspect(args, signal);
    if (action === "apply") return await this.apply(args, signal);
    if (action === "render") return await this.render(args, signal);
    throw new Error(`unknown Office tool ${name}`);
  }

  private async executable(): Promise<OfficeExecutable> {
    const executable = this.options.executable === undefined ? resolveOfficeExecutable() : this.options.executable;
    if (!executable) throw new Error("Office support is not installed. Open /support office or run `neko support office install`; Neko never installs it silently.");
    if (executable.source === "managed" && executable.digest) {
      let stamp: ReturnType<typeof statSync>;
      try { stamp = statSync(executable.path); }
      catch { throw new Error("Neko-managed OfficeCLI is missing; repair it from /support office"); }
      const key = `${executable.path}\0${executable.digest}\0${stamp.size}\0${stamp.mtimeMs}`;
      if (this.verifiedManaged?.key !== key) {
        const check = (async () => {
          const actual = `sha256:${await sha256File(executable.path)}`;
          if (actual !== executable.digest) throw new Error(`Neko-managed OfficeCLI failed its integrity check (expected ${executable.digest}, got ${actual}); repair it from /support office`);
        })();
        this.verifiedManaged = { key, check };
      }
      try { await this.verifiedManaged.check; }
      catch (error) {
        if (this.verifiedManaged?.key === key) this.verifiedManaged = undefined;
        throw error;
      }
    }
    return executable;
  }

  private libreOffice(): LibreOfficeExecutable {
    const status = this.libreOfficeStatus();
    if (status.state === "ready") return status.executable!;
    if (status.state === "broken") throw new Error(`LibreOffice verifier is unavailable: ${status.detail}`);
    throw new Error("LibreOffice is not installed. Install it from https://www.libreoffice.org/download/download-libreoffice/ to enable independent PDF cross-rendering; Neko does not silently install the full suite.");
  }

  private libreOfficeStatus() {
    if (this.options.libreOffice !== undefined) return this.options.libreOffice
      ? { state: "ready" as const, detail: `LibreOffice ${this.options.libreOffice.version ?? "test"} (${this.options.libreOffice.source})`, executable: this.options.libreOffice }
      : { state: "missing" as const, detail: "LibreOffice PDF verifier is not installed" };
    if (this.resolvedLibreOffice) return {
      state: "ready" as const,
      detail: `LibreOffice ${this.resolvedLibreOffice.version ?? "verified"} (${this.resolvedLibreOffice.source})`,
      executable: this.resolvedLibreOffice,
    };
    const status = discoverLibreOffice();
    if (status.state === "ready") this.resolvedLibreOffice = status.executable;
    return status;
  }

  private async inspect(args: Record<string, any>, signal?: AbortSignal): Promise<string> {
    const operation = String(args.operation ?? "");
    if (operation === "status") {
      const status = this.options.executable === undefined
        ? discoverOfficeCli()
        : this.options.executable
          ? { state: "ready", detail: `OfficeCLI ${this.options.executable.version ?? "test"} (${this.options.executable.source})`, executable: this.options.executable }
          : { state: "missing", detail: "optional Office engine is not installed" };
      const libreOffice = this.libreOfficeStatus();
      return JSON.stringify({
        ...status,
        libreoffice: libreOffice,
        roles: {
          typed_engine: "OfficeCLI performs bounded structure inspection and mutation",
          independent_renderer: "LibreOffice exports whole-file PDF evidence on a private per-job profile",
        },
        install: "neko support office install",
        tui: "/support office",
      }, null, 2);
    }
    const executable = await this.executable();
    if (operation === "help") {
      const format = String(args.format ?? "");
      if (!new Set(["docx", "xlsx", "pptx"]).has(format)) throw new Error("Office help requires format=docx, xlsx, or pptx");
      const command = ["help", format];
      if (args.element) {
        const element = String(args.element);
        if (!/^[a-z0-9][a-z0-9_.-]*$/i.test(element)) throw new Error("Office help element contains invalid characters");
        command.push(element);
      }
      command.push("--json");
      return this.resultEnvelope(executable, operation, undefined, await this.run(executable, command, signal));
    }

    const file = this.officeFile(String(args.file ?? ""), true);
    const snapshot = copyOfficeSnapshot(file);
    try {
      const command: string[] = [];
      if (new Set(["outline", "text", "annotated", "stats", "issues"]).has(operation)) {
        command.push("view", snapshot.file, operation);
        if (args.max_lines != null) command.push("--max-lines", boundedInteger(args.max_lines, 1, 5000, "max_lines"));
        if (args.columns) {
          const columns = String(args.columns);
          if (!/^[a-z]{1,3}(?:,[a-z]{1,3})*$/i.test(columns)) throw new Error("columns must be a comma-separated list such as A,B,C");
          command.push("--cols", columns);
        }
      } else if (operation === "get" || operation === "query") {
        const selector = String(args.selector ?? "");
        if (!selector) throw new Error(`${operation} requires selector`);
        if (selector.length > 4096) throw new Error("Office selector exceeds 4096 characters");
        if (selector.startsWith("-")) throw new Error("Office selector cannot start with '-'");
        command.push(operation, snapshot.file, selector);
        if (operation === "get" && args.depth != null) command.push("--depth", boundedInteger(args.depth, 0, 8, "depth"));
      } else if (operation === "validate") {
        command.push("validate", snapshot.file);
      } else {
        throw new Error(`unsupported Office inspect operation: ${operation || "missing"}`);
      }
      command.push("--json");
      const output = logicalizeRunResult(await this.run(executable, command, signal), snapshot.file, file);
      return this.resultEnvelope(executable, operation, file, output, await sha256File(snapshot.file));
    } finally {
      rmSync(snapshot.dir, { recursive: true, force: true });
    }
  }

  private async apply(args: Record<string, any>, signal?: AbortSignal): Promise<string> {
    const executable = await this.executable();
    const output = this.officeFile(String(args.output ?? ""), false);
    const source = args.source ? this.officeFile(String(args.source), true) : undefined;
    if (source && extname(source).toLowerCase() !== extname(output).toLowerCase()) throw new Error("Office source and output formats must match");
    const overwrite = args.overwrite === true;
    const sameFile = !!source && source === output;
    if (existsSync(output) && !overwrite && !sameFile) throw new Error(`Office output already exists: ${relative(this.root, output)}; set overwrite=true explicitly`);
    if (sameFile && (!overwrite || !args.expected_source_sha256)) {
      throw new Error("Same-file Office editing requires overwrite=true and expected_source_sha256 from a fresh inspect");
    }
    if (source && args.expected_source_sha256) {
      const expected = String(args.expected_source_sha256).toLowerCase();
      const actual = await sha256File(source);
      if (expected !== actual) throw new Error(`Office source changed since inspection (expected ${expected}, got ${actual}); inspect again before editing`);
    }

    const commands = normalizeCommands(args.commands, this.root);
    const encoded = `${JSON.stringify(commands)}\n`;
    if (Buffer.byteLength(encoded) > MAX_COMMAND_BYTES) throw new Error(`Office batch exceeds ${MAX_COMMAND_BYTES} bytes; split it into verified stages`);
    mkdirSync(dirname(output), { recursive: true });
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const stage = join(dirname(output), `.${basename(output, extname(output))}.neko-stage-${suffix}${extname(output)}`);
    const batchDir = join(tmpdir(), `neko-office-${suffix}`);
    const batchFile = join(batchDir, "commands.json");
    mkdirSync(batchDir, { recursive: false, mode: 0o700 });
    try {
      if (source) copyFileSync(source, stage);
      else await this.run(executable, ["create", stage, "--json"], signal);
      writeFileSync(batchFile, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
      const applied = await this.run(executable, ["batch", stage, "--input", batchFile, "--stop-on-error", "--json"], signal);
      await this.run(executable, ["close", stage, "--json"], signal).catch(() => ({ stdout: "", stderr: "" }));
      const validated = await this.run(executable, ["validate", stage, "--json"], signal);
      if (!existsSync(stage) || statSync(stage).size === 0) throw new Error("Office batch did not produce a saved artifact");
      const digest = await sha256File(stage);
      atomicReplace(stage, output, overwrite || sameFile);
      return JSON.stringify({
        success: true,
        backend: backendLabel(executable),
        output: relative(this.root, output),
        sha256: digest,
        commands: commands.length,
        apply: parseOutput(applied.stdout),
        validation: parseOutput(validated.stdout),
        next: "Freshly inspect changed targets, then render and visually review every affected page/slide/sheet before claiming completion.",
      }, null, 2);
    } finally {
      rmSync(stage, { force: true });
      rmSync(batchDir, { recursive: true, force: true });
    }
  }

  private async render(args: Record<string, any>, signal?: AbortSignal): Promise<string> {
    const file = this.officeFile(String(args.file ?? ""), true);
    const mode = String(args.mode ?? "");
    if (mode !== "screenshot" && mode !== "html" && mode !== "pdf") throw new Error("Office render mode must be screenshot, html, or pdf");
    const executable = mode === "pdf" ? undefined : await this.executable();
    const libreOffice = mode === "pdf" ? this.libreOffice() : undefined;
    const output = resolveInRoot(this.root, String(args.output ?? ""));
    const requiredExt = mode === "screenshot" ? ".png" : mode === "html" ? ".html" : ".pdf";
    if (extname(output).toLowerCase() !== requiredExt) throw new Error(`Office ${mode} output must end in ${requiredExt}`);
    const overwrite = args.overwrite === true;
    if (existsSync(output) && !overwrite) throw new Error(`Render output already exists: ${relative(this.root, output)}; set overwrite=true explicitly`);
    let page: string | undefined;
    if (args.page != null) {
      if (mode === "pdf") throw new Error("LibreOffice PDF evidence exports the complete artifact; omit page");
      page = String(args.page);
      if (!/^\d+(?:-\d+)?$/.test(page)) throw new Error("Office render page must be N or N-M");
      const [first, last = first] = page.split("-").map(Number);
      if (first < 1 || last < first || last > 10_000) throw new Error("Office render page range must be between 1 and 10000 in ascending order");
    }
    mkdirSync(dirname(output), { recursive: true });
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const stage = join(dirname(output), `.${basename(output, requiredExt)}.neko-render-${suffix}${requiredExt}`);
    const snapshot = copyOfficeSnapshot(file);
    try {
      let rendered: OfficeRunResult;
      if (mode === "pdf") {
        rendered = await renderPdfWithLibreOffice({
          executable: libreOffice!,
          input: snapshot.file,
          destination: stage,
          runner: this.options.libreOfficeRunner,
          signal,
        });
      } else {
        const command = ["view", snapshot.file, mode, "-o", stage];
        if (page) command.push("--page", page);
        rendered = await this.run(executable!, command, signal, 180_000);
      }
      if (!existsSync(stage) || !statSync(stage).isFile() || statSync(stage).size === 0) {
        throw new Error(`Office ${mode} completed without producing non-empty evidence at ${relative(this.root, output)}`);
      }
      atomicReplace(stage, output, overwrite);
      return JSON.stringify({
        success: true,
        backend: mode === "pdf" ? libreOfficeLabel(libreOffice!) : backendLabel(executable!),
        source: relative(this.root, file),
        evidence: [relative(this.root, output)],
        result: mode === "pdf" ? { exported: true } : parseOutput(rendered.stdout.split(stage).join(output)),
        ...(rendered.stderr.trim() ? { warnings: cap(rendered.stderr.trim()) } : {}),
        next: mode === "screenshot"
          ? "Open every listed PNG with the vision tool; schema validation alone is not visual proof."
          : mode === "html"
            ? "Open the HTML preview and inspect layout, clipping, contrast, and overflow."
            : "Open the PDF and review every affected page/slide. This independent LibreOffice export proves cross-renderability, not semantic correctness.",
      }, null, 2);
    } finally {
      rmSync(stage, { force: true });
      rmSync(snapshot.dir, { recursive: true, force: true });
    }
  }

  private officeFile(raw: string, mustExist: boolean): string {
    if (!raw) throw new Error("missing Office file path");
    const path = resolveInRoot(this.root, raw);
    if (!OFFICE_EXTENSIONS.has(extname(path).toLowerCase())) throw new Error("Office tools support only .docx, .xlsx, and .pptx (macro-enabled files are preserved, not rewritten)");
    if (mustExist) {
      if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Office file not found: ${raw}`);
      if (statSync(path).size > MAX_FILE_BYTES) throw new Error(`Office file exceeds ${MAX_FILE_BYTES} bytes`);
    }
    return path;
  }

  private async run(executable: OfficeExecutable, args: string[], signal?: AbortSignal, timeoutMs = 120_000): Promise<OfficeRunResult> {
    return await (this.options.runner ?? runOffice)(executable.path, args, { cwd: this.root, signal, timeoutMs });
  }

  private resultEnvelope(executable: OfficeExecutable, operation: string, file: string | undefined, result: OfficeRunResult, sha256?: string): string {
    return JSON.stringify({
      success: true,
      backend: backendLabel(executable),
      operation,
      ...(file ? { file: relative(this.root, file), sha256 } : {}),
      result: parseOutput(result.stdout),
      ...(result.stderr.trim() ? { warnings: cap(result.stderr.trim()) } : {}),
    }, null, 2);
  }
}

export function createOfficeTools(root: string, options: OfficeToolsOptions = {}): McpTools {
  return new OfficeTools(resolve(root), options);
}

export function withOfficeTools(root: string, source?: McpTools, options: OfficeToolsOptions = {}): McpTools {
  return composeMcpTools(source, createOfficeTools(root, options))!;
}

async function runOffice(executable: string, args: string[], options: { cwd: string; signal?: AbortSignal; timeoutMs: number }): Promise<OfficeRunResult> {
  return await new Promise((resolvePromise, reject) => {
    execFile(executable, args, {
      cwd: options.cwd,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
      signal: options.signal,
      env: {
        ...process.env,
        OFFICECLI_SKIP_UPDATE: "1",
        OFFICECLI_NO_AUTO_INSTALL: "1",
        OFFICECLI_NO_AUTO_RESIDENT: "1",
      },
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = cap(String(stderr || stdout || error.message).trim());
        return reject(new Error(`OfficeCLI ${args[0] ?? "command"} failed: ${detail || error.message}`));
      }
      resolvePromise({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function normalizeCommands(value: unknown, root: string): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 500) throw new Error("Office commands must contain 1 to 500 batch objects");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`Office command ${index + 1} must be an object`);
    const command = structuredClone(entry) as Record<string, unknown>;
    const op = String(command.op ?? command.command ?? "").toLowerCase();
    if (!ALLOWED_BATCH_OPS.has(op)) throw new Error(`Office command ${index + 1} uses forbidden operation '${op || "missing"}'; allowed: add, set, remove, move, swap`);
    validateNestedResources(command, root);
    return command;
  });
}

function validateNestedResources(value: unknown, root: string, key = "", parentKey = ""): void {
  if (typeof value === "string") {
    const resource = key === "src" || key === "poster" || (parentKey === "props" && key === "path");
    if (!resource || /^data:/i.test(value)) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) {
      throw new Error("Office mutations cannot fetch remote resources; download them into the workspace first");
    }
    const path = resolveInRoot(root, value);
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`Office resource not found in workspace: ${value}`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((item) => validateNestedResources(item, root, key, parentKey));
  if (value && typeof value === "object") {
    for (const [childKey, child] of Object.entries(value as Record<string, unknown>)) validateNestedResources(child, root, childKey, key);
  }
}

function atomicReplace(stage: string, output: string, overwrite: boolean): void {
  if (!existsSync(output)) return renameSync(stage, output);
  if (!overwrite) throw new Error(`Office output already exists: ${output}`);
  const backup = `${output}.neko-backup-${process.pid}-${Date.now()}`;
  renameSync(output, backup);
  try { renameSync(stage, output); }
  catch (error) { if (!existsSync(output)) renameSync(backup, output); throw error; }
  rmSync(backup, { force: true });
}

function resolveInRoot(root: string, raw: string): string {
  if (!raw) throw new Error("missing workspace path");
  const rootResolved = resolve(root);
  const resolved = resolve(rootResolved, raw);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) throw new Error(`path escapes project root: ${raw}`);
  const rootReal = realpathNearest(rootResolved);
  const real = realpathNearest(resolved);
  if (real !== rootReal && !real.startsWith(rootReal + sep)) throw new Error(`path escapes project root via a symlink: ${raw}`);
  return resolved;
}

function realpathNearest(path: string): string {
  let probe = path;
  while (probe !== dirname(probe) && !existsSync(probe)) probe = dirname(probe);
  try {
    const real = realpathSync(probe);
    return probe === path ? real : real + path.slice(probe.length);
  } catch { return path; }
}

function copyOfficeSnapshot(file: string): { dir: string; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "neko-office-snapshot-"));
  const snapshot = join(dir, basename(file));
  try {
    copyFileSync(file, snapshot);
    return { dir, file: snapshot };
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function logicalizeRunResult(result: OfficeRunResult, snapshot: string, source: string): OfficeRunResult {
  return {
    stdout: result.stdout.split(snapshot).join(source),
    stderr: result.stderr.split(snapshot).join(source),
  };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function boundedInteger(value: unknown, min: number, max: number, label: string): string {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${label} must be an integer from ${min} to ${max}`);
  return String(number);
}

function parseOutput(stdout: string): unknown {
  const text = cap(stdout.trim());
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

function cap(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n... (truncated at ${MAX_RESULT_CHARS} chars)` : text;
}

function backendLabel(executable: OfficeExecutable): string {
  return `OfficeCLI${executable.version ? ` ${executable.version}` : ""} (${executable.source})`;
}

function libreOfficeLabel(executable: LibreOfficeExecutable): string {
  return `LibreOffice${executable.version ? ` ${executable.version}` : ""} (${executable.source}; isolated profile)`;
}
