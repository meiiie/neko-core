import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  geminiSupportRoot,
  geminiSupportTarget,
  installGeminiSupportPack,
  readGeminiSupportPack,
  removeGeminiSupportPack,
} from "../src/adapters/gemini-support-pack.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Gemini Support Pack", () => {
  test("maps supported OS and CPU pairs to portable Node assets", () => {
    expect(geminiSupportTarget("v24.18.0", "win32", "x64").nodeArchive).toBe("node-v24.18.0-win-x64.zip");
    expect(geminiSupportTarget("v24.18.0", "linux", "arm64").nodeArchive).toBe("node-v24.18.0-linux-arm64.tar.gz");
    expect(geminiSupportTarget("v24.18.0", "darwin", "arm64").nodeArchive).toBe("node-v24.18.0-darwin-arm64.tar.gz");
    expect(() => geminiSupportTarget("v24.18.0", "freebsd", "x64")).toThrow("does not support freebsd");
  });

  test("installs official bundle and Node atomically, then skips an identical reinstall", async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-gemini-support-"));
    homes.push(home);
    const bundle = Buffer.from("bundle archive");
    const node = Buffer.from("node archive");
    const bundleDigest = sha(bundle);
    const nodeDigest = sha(node);
    let downloads = 0;
    const fetchImpl = fixtureFetch(bundle, node, bundleDigest, nodeDigest, () => downloads++);
    const extractBundle = (_archive: string, destination: string) => {
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, "gemini.js"), "bundle");
    };
    const extractNode = (_archive: string, destination: string) => {
      mkdirSync(destination, { recursive: true });
      writeFileSync(join(destination, "node.exe"), "runtime");
    };

    const installed = await installGeminiSupportPack({
      home,
      platform: "win32",
      arch: "x64",
      fetchImpl,
      extractBundle,
      extractNode,
      versionsOf: () => ({ gemini: "0.50.0", node: "24.18.0" }),
      verifyProtocol: async () => {},
    });
    expect(installed.geminiVersion).toBe("0.50.0");
    expect(installed.nodeVersion).toBe("24.18.0");
    expect(existsSync(installed.entryPath)).toBe(true);
    expect(existsSync(installed.runtimePath)).toBe(true);
    expect(readGeminiSupportPack(home)?.bundleDigest).toBe(`sha256:${bundleDigest}`);

    const repeated = await installGeminiSupportPack({ home, platform: "win32", arch: "x64", fetchImpl });
    expect(repeated.alreadyInstalled).toBe(true);
    expect(downloads).toBe(2);
    expect(removeGeminiSupportPack(home)).toBe(true);
    expect(removeGeminiSupportPack(home)).toBe(false);
  });

  test("a checksum failure preserves the previous working pack", async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-gemini-support-"));
    homes.push(home);
    installFixture(home);
    const bundle = Buffer.from("tampered bundle");
    const node = Buffer.from("node archive");
    const fetchImpl = fixtureFetch(bundle, node, "0".repeat(64), sha(node));
    await expect(installGeminiSupportPack({ home, platform: "win32", arch: "x64", fetchImpl })).rejects.toThrow("checksum mismatch");
    expect(readFileSync(join(geminiSupportRoot(home), "gemini", "gemini.js"), "utf8")).toBe("previous bundle");
    expect(readGeminiSupportPack(home)?.geminiVersion).toBe("0.49.0");
  });

  test("rejects a manifest that escapes the managed support directory", () => {
    const home = mkdtempSync(join(tmpdir(), "neko-gemini-support-"));
    homes.push(home);
    installFixture(home);
    const path = join(geminiSupportRoot(home), "support-pack.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    manifest.entry = "../outside.js";
    writeFileSync(path, JSON.stringify(manifest));
    expect(readGeminiSupportPack(home)).toBeNull();
  });
});

function fixtureFetch(bundle: Buffer, node: Buffer, bundleDigest: string, nodeDigest: string, onDownload = () => {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) return Response.json({
      tag_name: "v0.50.0",
      draft: false,
      prerelease: false,
      html_url: "https://github.com/google-gemini/gemini-cli/releases/tag/v0.50.0",
      assets: [{
        name: "gemini-cli-bundle.zip",
        size: bundle.length,
        digest: `sha256:${bundleDigest}`,
        browser_download_url: "https://github.com/google-gemini/gemini-cli/releases/download/v0.50.0/gemini-cli-bundle.zip",
      }],
    });
    if (url.endsWith("/index.json")) return Response.json([{ version: "v24.18.0", lts: "Krypton", files: ["win-x64-zip"] }]);
    if (url.endsWith("/SHASUMS256.txt")) return new Response(`${nodeDigest}  node-v24.18.0-win-x64.zip\n`);
    onDownload();
    if (url.endsWith("gemini-cli-bundle.zip")) return new Response(new Uint8Array(bundle), { headers: { "content-length": String(bundle.length) } });
    if (url.endsWith("node-v24.18.0-win-x64.zip")) return new Response(new Uint8Array(node), { headers: { "content-length": String(node.length) } });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

function installFixture(home: string): void {
  const root = geminiSupportRoot(home);
  mkdirSync(join(root, "gemini"), { recursive: true });
  mkdirSync(join(root, "node"), { recursive: true });
  writeFileSync(join(root, "gemini", "gemini.js"), "previous bundle");
  writeFileSync(join(root, "node", "node.exe"), "previous runtime");
  writeFileSync(join(root, "support-pack.json"), JSON.stringify({
    protocolVersion: "1",
    geminiVersion: "0.49.0",
    nodeVersion: "24.18.0",
    releaseTag: "v0.49.0",
    bundleAsset: "gemini-cli-bundle.zip",
    bundleDigest: `sha256:${"1".repeat(64)}`,
    bundleArchiveBytes: 1,
    nodeAsset: "node-v24.18.0-win-x64.zip",
    nodeDigest: `sha256:${"2".repeat(64)}`,
    nodeArchiveBytes: 1,
    installedBytes: 32,
    installedAt: new Date().toISOString(),
    entry: "gemini/gemini.js",
    runtime: "node/node.exe",
    sourceUrl: "https://github.com/google-gemini/gemini-cli/releases/tag/v0.49.0",
    nodeSourceUrl: "https://nodejs.org/dist/v24.18.0/",
  }));
}

function sha(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
