import { lstatSync } from "node:fs";
import { win32 } from "node:path";

/** Resolve a security-relevant Windows inbox executable without consulting cwd or PATH. */
export function resolveWindowsSystemExecutable(
  relative: string,
  systemRoot?: string,
  isRegularFile: (path: string) => boolean = (path) => {
    try {
      const stat = lstatSync(path);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  },
): string | null {
  const root = arguments.length >= 2 ? systemRoot : process.env.SystemRoot ?? process.env.WINDIR;
  if (!root || root.includes("\0") || !/^[A-Za-z]:[\\/]/.test(root)) return null;
  if (!relative || win32.isAbsolute(relative) || relative.includes("\0")) return null;
  const normalizedRelative = win32.normalize(relative);
  if (normalizedRelative === ".." || normalizedRelative.startsWith(`..${win32.sep}`)) return null;
  const system32 = win32.join(win32.normalize(root), "System32");
  const candidate = win32.join(system32, normalizedRelative);
  const rel = win32.relative(system32, candidate);
  if (!rel || rel === ".." || rel.startsWith(`..${win32.sep}`) || win32.isAbsolute(rel)) return null;
  return isRegularFile(candidate) ? candidate : null;
}

/** Minimal environment for trusted Windows inbox utilities; provider credentials are not inherited. */
export function minimalWindowsSystemEnv(): NodeJS.ProcessEnv {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  const env: NodeJS.ProcessEnv = {};
  if (systemRoot) {
    env.SystemRoot = systemRoot;
    env.WINDIR = systemRoot;
    env.PATH = win32.join(systemRoot, "System32");
  }
  for (const name of ["TEMP", "TMP", "COMSPEC"] as const) if (process.env[name]) env[name] = process.env[name];
  return env;
}
