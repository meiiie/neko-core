/** Build the single-binary CLI with platform-correct metadata. */
import { spawnSync } from "node:child_process";
import { VERSION } from "../src/shared/version.ts";

const extra = process.argv.slice(2);
const target = extra.find((a) => a.startsWith("--target="))?.slice("--target=".length);
const targetIsWindows = target ? target.includes("windows") : process.platform === "win32";

const args = [
  "build", "--compile",
  // Startup configuration must not bypass Neko's project-trust gate.
  "--no-compile-autoload-dotenv",
  "--no-compile-autoload-bunfig",
  "--define", 'process.env.NODE_ENV="production"',
];
if (process.platform === "win32" && targetIsWindows) {
  // Bun accepts PE metadata only while compiling a Windows target on Windows.
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

const r = spawnSync(process.execPath, args, { stdio: "inherit" });
if (r.error) console.error("build spawn failed:", r.error);
process.exit(r.status ?? 1);
