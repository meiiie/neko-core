/**
 * Build the single-binary neko with platform-correct branding - the ONE source of truth for compile
 * flags (package.json `build` and release.yml both call this).
 *
 * Why a script instead of an inline package.json command:
 *  - The --windows-* PE metadata flags (icon, Task Manager name, publisher, version) are only accepted
 *    when COMPILING ON Windows - bun errors otherwise ("only available when compiling on Windows"), so
 *    an unconditional inline command broke `bun run build` on the ubuntu/macos CI jobs and every
 *    non-Windows release target. Here they're added only when host+target are Windows.
 *  - Passing args as separate argv elements (no shell) ends the cross-runner quoting fragility around
 *    --define that release.yml previously handled with shell:bash comments.
 *
 * Usage:
 *   bun scripts/build.ts                                   # local: dist/neko for this platform
 *   bun scripts/build.ts --target=bun-linux-x64 --outfile=neko-linux-x64   # release matrix
 */
import { spawnSync } from "node:child_process";
import { VERSION } from "../src/shared/version.ts";

const extra = process.argv.slice(2);
const target = extra.find((a) => a.startsWith("--target="))?.slice("--target=".length);
const targetIsWindows = target ? target.includes("windows") : process.platform === "win32";

const args = [
  "build", "--compile",
  "--tsconfig-override", "tsconfig.build.json", // repo jsx:react-jsx emits DEV jsxDEV calls that crash production React
  "--define", 'process.env.NODE_ENV="production"', // without it the binary ships React dev mode (~5x per frame, measured)
];
if (process.platform === "win32" && targetIsWindows) {
  // PE branding: Task Manager shows FileDescription ("Neko Core", not "Bun"), Explorer shows the cat
  // icon, file properties carry publisher/version/copyright. Windows-host-only by bun's rules.
  args.push(
    "--windows-icon=assets/neko.ico",
    "--windows-title=Neko Core",
    "--windows-publisher=The Wiii Lab",
    `--windows-version=${VERSION}`,
    "--windows-description=Neko Core",
    "--windows-copyright=MIT (c) 2026 The Wiii Lab",
  );
}
args.push(...extra);
if (!extra.some((a) => a.startsWith("--outfile"))) args.push("--outfile", "dist/neko");
args.push("bin/neko.ts");

// process.execPath = the bun binary RUNNING this script - always resolvable, no PATH lookup surprises.
const r = spawnSync(process.execPath, args, { stdio: "inherit" });
if (r.error) console.error("build spawn failed:", r.error);
process.exit(r.status ?? 1);
