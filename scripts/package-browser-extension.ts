import { cp, mkdir, readFile, rm, stat, readdir, utimes, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { verifyBrowserExtension } from "./verify-browser-extension.ts";

const mode = process.argv.includes("--store-first-upload") ? "store-first-upload" : "developer";
const root = resolve(import.meta.dir, "..");
const source = join(root, "browser-extension");
const sourceManifest = join(source, "manifest.json");
const manifest = JSON.parse(await readFile(sourceManifest, "utf8"));
const manifestTimes = await stat(sourceManifest);
const outputDir = join(root, "dist");
const outputArg = process.argv.indexOf("--output");
if (outputArg >= 0 && !process.argv[outputArg + 1]) throw new Error("--output requires a ZIP path");
const output = outputArg >= 0 ? resolve(process.argv[outputArg + 1]!) : join(outputDir, `neko-browser-extension-${manifest.version}-${mode}.zip`);
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
    const stagedManifestPath = join(stage, "manifest.json");
    const stagedManifest = JSON.parse(await readFile(stagedManifestPath, "utf8"));
    delete stagedManifest.key;
    await writeFile(stagedManifestPath, JSON.stringify(stagedManifest, null, 2) + "\n");
    // Compress-Archive records file timestamps. Preserve the source time after rewriting the key-free
    // manifest so two packages from the same commit produce the same bytes and SHA-256.
    await utimes(stagedManifestPath, manifestTimes.atime, manifestTimes.mtime);
  }

  await verifyBrowserExtension(stage);
  await rm(output, { force: true });
  const proc = process.platform === "win32"
    ? Bun.spawn(["powershell", "-NoProfile", "-Command",
      `Compress-Archive -Path '${stage.replaceAll("'", "''")}\\*' -DestinationPath '${output.replaceAll("'", "''")}' -Force`],
      { stdout: "inherit", stderr: "inherit" })
    : Bun.spawn(["zip", "-qr", output, "."], { cwd: stage, stdout: "inherit", stderr: "inherit" });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`Compress-Archive exited with ${code}`);
  // Check the emitted artifact, not just the staging directory. Compression tools can omit files.
  const unpacked = `${stage}-verify`;
  try {
    const extract = process.platform === "win32"
      ? Bun.spawn(["powershell", "-NoProfile", "-Command",
        `Expand-Archive -LiteralPath '${output.replaceAll("'", "''")}' -DestinationPath '${unpacked.replaceAll("'", "''")}'`],
        { stdout: "inherit", stderr: "inherit" })
      : Bun.spawn(["unzip", "-q", output, "-d", unpacked], { stdout: "inherit", stderr: "inherit" });
    if (await extract.exited !== 0) throw new Error("could not verify extension ZIP");
    await verifyBrowserExtension(unpacked);
    async function compare(dir = ""): Promise<void> {
      const expected = (await readdir(join(stage, dir))).sort();
      const actual = (await readdir(join(unpacked, dir))).sort();
      if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error(`extension ZIP inventory mismatch: ${dir}`);
      for (const name of expected) {
        const path = join(dir, name);
        if ((await stat(join(stage, path))).isDirectory()) await compare(path);
        else if (!(await readFile(join(stage, path))).equals(await readFile(join(unpacked, path)))) {
          throw new Error(`extension ZIP bytes differ: ${path}`);
        }
      }
    }
    await compare();
  } finally {
    await rm(unpacked, { recursive: true, force: true });
  }
  console.log(output);
} finally {
  await rm(stage, { recursive: true, force: true });
}
