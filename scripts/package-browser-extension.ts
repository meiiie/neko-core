import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

const mode = process.argv.includes("--store-first-upload") ? "store-first-upload" : "developer";
const root = resolve(import.meta.dir, "..");
const source = join(root, "browser-extension");
const manifest = JSON.parse(await readFile(join(source, "manifest.json"), "utf8"));
const outputDir = join(root, "dist");
const output = join(outputDir, `neko-browser-extension-${manifest.version}-${mode}.zip`);
const stage = join(tmpdir(), `neko-browser-extension-${crypto.randomUUID()}`);
const tempRoot = resolve(tmpdir()) + sep;
if (!resolve(stage).startsWith(tempRoot) || !basename(stage).startsWith("neko-browser-extension-")) {
  throw new Error("refusing unsafe extension staging path");
}

await mkdir(outputDir, { recursive: true });
try {
  await cp(source, stage, { recursive: true });
  for (const name of ["README.md", "PRIVACY.md", "PUBLISHING.md", "STORE-LISTING.md"]) {
    await rm(join(stage, name), { force: true });
  }
  if (mode === "store-first-upload") {
    const stagedManifest = JSON.parse(await readFile(join(stage, "manifest.json"), "utf8"));
    delete stagedManifest.key;
    await writeFile(join(stage, "manifest.json"), JSON.stringify(stagedManifest, null, 2) + "\n");
  }

  await rm(output, { force: true });
  const proc = process.platform === "win32"
    ? Bun.spawn(["powershell", "-NoProfile", "-Command",
      `Compress-Archive -Path '${stage.replaceAll("'", "''")}\\*' -DestinationPath '${output.replaceAll("'", "''")}' -Force`],
      { stdout: "inherit", stderr: "inherit" })
    : Bun.spawn(["zip", "-qr", output, "."], { cwd: stage, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`Compress-Archive exited with ${code}`);
  console.log(output);
} finally {
  await rm(stage, { recursive: true, force: true });
}
