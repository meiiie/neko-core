#!/usr/bin/env node
/**
 * Cross-platform source bootstrap. Node does not auto-execute cwd .env/bunfig files, so it can
 * resolve a trusted absolute Bun + config before the Bun runtime starts. Release users run the
 * compiled binary and never need this file.
 */
const { existsSync, realpathSync } = require("node:fs");
const { homedir } = require("node:os");
const { delimiter, isAbsolute, join, relative, resolve, sep } = require("node:path");
const { spawnSync } = require("node:child_process");

const root = resolve(__dirname, "..");
const cwd = process.cwd();
const executableName = process.platform === "win32" ? "bun.exe" : "bun";

function inside(base, candidate) {
  const rel = relative(base, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function candidatePaths() {
  const explicit = String(process.env.NEKO_BUN_PATH || "").trim();
  if (explicit) return [explicit];
  const found = [];
  const install = String(process.env.BUN_INSTALL || "").trim();
  if (install && isAbsolute(install)) found.push(join(install, "bin", executableName));
  found.push(join(homedir(), ".bun", "bin", executableName));
  for (const entry of String(process.env.PATH || "").split(delimiter)) {
    if (!entry || !isAbsolute(entry)) continue;
    for (const candidate of [
      join(entry, executableName),
      ...(process.platform === "win32" ? [join(entry, "node_modules", "bun", "bin", executableName)] : []),
    ]) {
      if (!inside(cwd, resolve(candidate))) found.push(candidate);
    }
  }
  return found;
}

let bun = "";
for (const candidate of candidatePaths()) {
  try {
    if (!isAbsolute(candidate) || !existsSync(candidate)) continue;
    const real = realpathSync(candidate);
    if (process.env.NEKO_BUN_PATH || !inside(cwd, real)) { bun = real; break; }
  } catch { /* try the next trusted absolute candidate */ }
}
if (!bun) {
  console.error("neko: safe source launch could not find Bun outside the project. Set NEKO_BUN_PATH or BUN_INSTALL to an absolute trusted installation.");
  process.exit(2);
}

const env = { ...process.env, __NEKO_SAFE_SOURCE_CWD: cwd };
delete env.NEKO_BUN_PATH;
delete env.BUN_OPTIONS;
delete env.NODE_OPTIONS;
const result = spawnSync(bun, [
  "--no-env-file",
  "--no-install",
  `--config=${join(root, "bunfig.neko.toml")}`,
  join(root, "bin", "neko.ts"),
  ...process.argv.slice(2),
], { cwd: root, env, stdio: "inherit" });
if (result.error) {
  console.error(`neko: safe source launch failed: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
