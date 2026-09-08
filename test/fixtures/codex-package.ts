import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { codexPackageFiles } from "../../src/adapters/codex-package.ts";

export function writeCodexPackageFixture(root: string, version: string, platform = process.platform): string {
  const files = codexPackageFiles(platform);
  for (const file of files) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), "synthetic binary");
  }
  writeFileSync(join(root, "codex-package.json"), JSON.stringify({
    layoutVersion: 1, version, target: "x86_64-pc-windows-msvc", variant: "codex-app-server",
    entrypoint: files[1], resourcesDir: "codex-resources", pathDir: "codex-path",
  }));
  writeFileSync(join(root, "support-pack.json"), JSON.stringify({ protocolVersion: version, executable: files[1] }));
  return join(root, files[1]);
}
