import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  codexSupportRoot,
  codexSupportTarget,
  installCodexSupportPack,
  readCodexSupportPack,
  removeCodexSupportPack,
} from "../src/adapters/codex-support-pack.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Codex Support Pack", () => {
  test("maps supported OS and CPU pairs to official standalone assets", () => {
    expect(codexSupportTarget("win32", "x64").archiveName).toBe("codex-app-server-x86_64-pc-windows-msvc.exe.tar.gz");
    expect(codexSupportTarget("darwin", "arm64").archiveName).toBe("codex-app-server-aarch64-apple-darwin.tar.gz");
    expect(codexSupportTarget("linux", "x64").archiveName).toBe("codex-app-server-x86_64-unknown-linux-musl.tar.gz");
    expect(() => codexSupportTarget("freebsd", "x64")).toThrow("does not support freebsd");
  });

  test("installs atomically from the official release metadata and skips an identical reinstall", async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-support-test-"));
    homes.push(home);
    const archive = Buffer.from("synthetic archive");
    const digest = createHash("sha256").update(archive).digest("hex");
    let assetDownloads = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.github.com")) return Response.json({
        tag_name: "rust-v0.144.1",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/openai/codex/releases/tag/rust-v0.144.1",
        assets: [{
          name: "codex-app-server-x86_64-pc-windows-msvc.exe.tar.gz",
          size: archive.length,
          digest: `sha256:${digest}`,
          browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-app-server-x86_64-pc-windows-msvc.exe.tar.gz",
        }],
      });
      assetDownloads++;
      return new Response(archive, { headers: { "content-length": String(archive.length) } });
    }) as typeof fetch;
    const extractArchive = (_archive: string, staging: string, entry: string) => writeFileSync(join(staging, entry), "binary");

    const installed = await installCodexSupportPack({
      home,
      platform: "win32",
      arch: "x64",
      fetchImpl,
      extractArchive,
      verifyBinary: () => {},
      versionOf: () => "0.144.1",
      verifyProtocol: async () => {},
    });
    expect(installed.protocolVersion).toBe("0.144.1");
    expect(installed.archiveBytes).toBe(archive.length);
    expect(existsSync(installed.path)).toBe(true);
    expect(readCodexSupportPack(home)?.assetDigest).toBe(`sha256:${digest}`);

    const repeated = await installCodexSupportPack({ home, platform: "win32", arch: "x64", fetchImpl });
    expect(repeated.alreadyInstalled).toBe(true);
    expect(assetDownloads).toBe(1);
    expect(removeCodexSupportPack(home)).toBe(true);
    expect(removeCodexSupportPack(home)).toBe(false);
    expect(existsSync(codexSupportRoot(home))).toBe(false);
  });

  test("a feature-specific minimum rejects an older latest release before download", async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-support-test-"));
    homes.push(home);
    let assetDownloads = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes("api.github.com")) return Response.json({
        tag_name: "rust-v0.144.1",
        assets: [{
          name: "codex-app-server-x86_64-pc-windows-msvc.exe.tar.gz",
          size: 1,
          digest: `sha256:${"0".repeat(64)}`,
          browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-app-server-x86_64-pc-windows-msvc.exe.tar.gz",
        }],
      });
      assetDownloads++;
      return new Response("x");
    }) as typeof fetch;
    await expect(installCodexSupportPack({
      home,
      platform: "win32",
      arch: "x64",
      fetchImpl,
      minimumVersion: "0.145.0",
    })).rejects.toThrow("required App Server >= 0.145.0");
    expect(assetDownloads).toBe(0);
  });

  test("a checksum failure preserves the previous working pack", async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-support-test-"));
    homes.push(home);
    const root = codexSupportRoot(home);
    const previous = await installFixture(home, "0.144.0");
    const archive = Buffer.from("tampered");
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes("api.github.com")) return Response.json({
        tag_name: "rust-v0.144.1",
        assets: [{
          name: "codex-app-server-x86_64-pc-windows-msvc.exe.tar.gz",
          size: archive.length,
          digest: `sha256:${"0".repeat(64)}`,
          browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-app-server-x86_64-pc-windows-msvc.exe.tar.gz",
        }],
      });
      return new Response(archive, { headers: { "content-length": String(archive.length) } });
    }) as typeof fetch;
    await expect(installCodexSupportPack({ home, platform: "win32", arch: "x64", fetchImpl })).rejects.toThrow("checksum mismatch");
    expect(readFileSync(join(root, "codex-app-server.exe"), "utf8")).toBe(previous);
    expect(readCodexSupportPack(home)?.protocolVersion).toBe("0.144.0");
  });

  test("rejects a managed manifest that tries to escape the support directory", async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-support-test-"));
    homes.push(home);
    await installFixture(home, "0.144.1");
    const manifestPath = join(codexSupportRoot(home), "support-pack.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.executable = "..\\outside.exe";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    expect(readCodexSupportPack(home)).toBeNull();
  });

  test("a protocol handshake failure never replaces the previous pack", async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-support-test-"));
    homes.push(home);
    const previous = await installFixture(home, "0.144.0");
    const archive = Buffer.from("valid synthetic archive");
    const digest = createHash("sha256").update(archive).digest("hex");
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes("api.github.com")) return Response.json({
        tag_name: "rust-v0.144.1",
        assets: [{
          name: "codex-app-server-x86_64-pc-windows-msvc.exe.tar.gz",
          size: archive.length,
          digest: `sha256:${digest}`,
          browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-app-server-x86_64-pc-windows-msvc.exe.tar.gz",
        }],
      });
      return new Response(archive, { headers: { "content-length": String(archive.length) } });
    }) as typeof fetch;
    await expect(installCodexSupportPack({
      home,
      platform: "win32",
      arch: "x64",
      fetchImpl,
      extractArchive: (_path, staging, entry) => writeFileSync(join(staging, entry), "new binary"),
      verifyBinary: () => {},
      versionOf: () => "0.144.1",
      verifyProtocol: async () => { throw new Error("incompatible protocol"); },
    })).rejects.toThrow("incompatible protocol");
    expect(readFileSync(join(codexSupportRoot(home), "codex-app-server.exe"), "utf8")).toBe(previous);
    expect(readCodexSupportPack(home)?.protocolVersion).toBe("0.144.0");
  });

  test("retries a transient Windows lock while publishing the verified pack", async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-support-test-"));
    homes.push(home);
    const archive = Buffer.from("valid synthetic archive");
    const digest = createHash("sha256").update(archive).digest("hex");
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes("api.github.com")) return Response.json({
        tag_name: "rust-v0.144.1",
        assets: [{
          name: "codex-app-server-x86_64-pc-windows-msvc.exe.tar.gz",
          size: archive.length,
          digest: `sha256:${digest}`,
          browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-app-server-x86_64-pc-windows-msvc.exe.tar.gz",
        }],
      });
      return new Response(archive, { headers: { "content-length": String(archive.length) } });
    }) as typeof fetch;
    let publishAttempts = 0;
    const installed = await installCodexSupportPack({
      home,
      platform: "win32",
      arch: "x64",
      fetchImpl,
      extractArchive: (_path, staging, entry) => writeFileSync(join(staging, entry), "new binary"),
      verifyBinary: () => {},
      versionOf: () => "0.144.1",
      verifyProtocol: async () => {},
      renamePath: (from, to) => {
        if (to === codexSupportRoot(home) && publishAttempts++ === 0) {
          throw Object.assign(new Error("temporarily locked"), { code: "EPERM" });
        }
        renameSync(from, to);
      },
    });
    expect(publishAttempts).toBe(2);
    expect(existsSync(installed.path)).toBe(true);
    expect(readCodexSupportPack(home)?.protocolVersion).toBe("0.144.1");
  });

  test("retries rollback without masking the original publish error", async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-support-test-"));
    homes.push(home);
    const previous = await installFixture(home, "0.144.0");
    const archive = Buffer.from("valid synthetic archive");
    const digest = createHash("sha256").update(archive).digest("hex");
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes("api.github.com")) return Response.json({
        tag_name: "rust-v0.144.1",
        assets: [{
          name: "codex-app-server-x86_64-pc-windows-msvc.exe.tar.gz",
          size: archive.length,
          digest: `sha256:${digest}`,
          browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-app-server-x86_64-pc-windows-msvc.exe.tar.gz",
        }],
      });
      return new Response(archive, { headers: { "content-length": String(archive.length) } });
    }) as typeof fetch;
    let rollbackAttempts = 0;
    await expect(installCodexSupportPack({
      home,
      platform: "win32",
      arch: "x64",
      fetchImpl,
      extractArchive: (_path, staging, entry) => writeFileSync(join(staging, entry), "new binary"),
      verifyBinary: () => {},
      versionOf: () => "0.144.1",
      verifyProtocol: async () => {},
      renamePath: (from, to) => {
        if (from.includes(".codex-support-install-") && to === codexSupportRoot(home)) {
          throw Object.assign(new Error("publish failed"), { code: "EACCES" });
        }
        if (from.includes(".codex-support-backup-") && to === codexSupportRoot(home) && rollbackAttempts++ === 0) {
          throw Object.assign(new Error("rollback temporarily locked"), { code: "EPERM" });
        }
        renameSync(from, to);
      },
    })).rejects.toThrow("publish failed");
    expect(rollbackAttempts).toBe(2);
    expect(readFileSync(join(codexSupportRoot(home), "codex-app-server.exe"), "utf8")).toBe(previous);
    expect(readCodexSupportPack(home)?.protocolVersion).toBe("0.144.0");
  });
});

async function installFixture(home: string, version: string): Promise<string> {
  const root = codexSupportRoot(home);
  const content = "previous binary";
  mkdirSync(root, { recursive: true });
  await Bun.write(join(root, "codex-app-server.exe"), content);
  await Bun.write(join(root, "support-pack.json"), JSON.stringify({
    protocolVersion: version,
    releaseTag: `rust-v${version}`,
    assetName: "old.tar.gz",
    assetDigest: `sha256:${"1".repeat(64)}`,
    archiveBytes: 1,
    installedBytes: content.length,
    installedAt: new Date().toISOString(),
    executable: "codex-app-server.exe",
    sourceUrl: "https://github.com/openai/codex/releases",
  }));
  return content;
}
