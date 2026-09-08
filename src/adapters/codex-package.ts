import { readFileSync, realpathSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";
import { isJsonObject } from "../shared/wire.ts";

export function codexPackageFiles(platform: NodeJS.Platform): string[] {
  const suffix = platform === "win32" ? ".exe" : "";
  return [
    "codex-package.json", `bin/codex-app-server${suffix}`, `bin/codex-code-mode-host${suffix}`,
    `codex-path/rg${suffix}`,
    ...(platform === "win32" ? ["codex-resources/codex-command-runner.exe", "codex-resources/codex-windows-sandbox-setup.exe"] : []),
    ...(platform === "linux" ? ["codex-resources/bwrap"] : []),
  ];
}

export interface CodexPackageIO {
  readText: (path: string) => string;
  realpath: (path: string) => string;
  isRegularFile: (path: string) => boolean;
}

export const codexPackageIO: CodexPackageIO = {
  readText: (path) => readFileSync(path, "utf8"),
  realpath: (path) => realpathSync.native(path),
  isRegularFile: (path) => { try { return statSync(path).isFile(); } catch { return false; } },
};

export function codexPackageProblem(root: string, platform: NodeJS.Platform, version: string,
  io: CodexPackageIO = codexPackageIO, target?: string): string | null {
  const paths = win32.isAbsolute(root) && !posix.isAbsolute(root) ? win32 : posix;
  try {
    const canonicalRoot = io.realpath(root);
    const files = codexPackageFiles(platform);
    for (const file of [files[2], ...files.filter((file) => file !== files[2])]) {
      const path = paths.join(root, file);
      if (!io.isRegularFile(path)) return `missing ${file}`;
      if (paths.relative(paths.join(canonicalRoot, file), io.realpath(path)) !== "") return `redirected ${file}`;
    }
    const manifest = JSON.parse(io.readText(paths.join(root, "codex-package.json")));
    if (!isJsonObject(manifest) || manifest.layoutVersion !== 1 || manifest.version !== version
      || manifest.variant !== "codex-app-server" || manifest.entrypoint !== codexPackageFiles(platform)[1]
      || manifest.resourcesDir !== "codex-resources" || manifest.pathDir !== "codex-path"
      || (target !== undefined && manifest.target !== target)) return "invalid package metadata";
    return null;
  } catch { return "unreadable package metadata"; }
}

export function validateCodexPackageEntries(entries: string[], types: string[], platform: NodeJS.Platform): void {
  const required = codexPackageFiles(platform);
  const allowed = new Set([...required, "bin/", "codex-path/", "codex-resources/",
    ...(platform !== "win32" ? ["codex-resources/zsh/", "codex-resources/zsh/bin/", "codex-resources/zsh/bin/zsh"] : [])]);
  if (entries.length !== types.length || new Set(entries).size !== entries.length
    || entries.some((entry, i) => !allowed.has(entry) || types[i] !== (entry.endsWith("/") ? "d" : "-"))
    || required.some((file) => !entries.includes(file))) throw new Error("Codex package contains missing, unsafe or unexpected entries");
}
