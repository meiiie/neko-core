import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexPackageFiles, validateCodexPackageEntries } from "../src/adapters/codex-package.ts";
import { prepareCodexSupport } from "../src/adapters/codex-support-repair.ts";
import type { InstallCodexSupportOptions } from "../src/adapters/codex-support-pack.ts";

import {
  codexSupportRoot,
  codexSupportTarget,
  installCodexSupportPack,
  readCodexSupportPack,
  removeCodexSupportPack,
} from "../src/adapters/codex-support-pack.ts";

const homes: string[] = [];
function repairFixture() {
  const home = mkdtempSync(join(tmpdir(), "neko-support-repair-"));
  homes.push(home);
  const archive = Buffer.from("synthetic complete package");
  let downloads = 0;
  const options: InstallCodexSupportOptions = {
    home, platform: "win32", arch: "x64", minimumVersion: "0.153.4",
    fetchImpl: Object.assign(async (input: string | URL | Request) => {
      if (String(input).includes("api.github.com")) return Response.json({
        tag_name: "rust-v0.153.4", assets: [{
          name: "codex-app-server-package-x86_64-pc-windows-msvc.tar.gz", size: archive.length,
          digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
          browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.153.4/codex-app-server-package-x86_64-pc-windows-msvc.tar.gz",
        }],
      });
      downloads++;
      return new Response(archive);
    }, { preconnect: fetch.preconnect }),
    extractArchive: (_archive, staging) => writePackageFixture(staging, "0.153.4"),
    verifyBinary: () => {}, versionOf: () => "0.153.4", verifyProtocol: async () => {},
  };
  return { home, options, downloads: () => downloads };
}
function writePackageFixture(root: string, version: string): void {
  for (const file of codexPackageFiles("win32")) {
    mkdirSync(join(root, file, ".."), { recursive: true });
    writeFileSync(join(root, file), "synthetic binary");
  }
  writeFileSync(join(root, "codex-package.json"), JSON.stringify({
    layoutVersion: 1, version, target: "x86_64-pc-windows-msvc", variant: "codex-app-server",
    entrypoint: "bin/codex-app-server.exe", resourcesDir: "codex-resources", pathDir: "codex-path",
  }));
}
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Codex Support Pack", () => {
  test("automatic repair restores an owned pack before use, reuses it, and never installs for a new account or external CLI", async () => {
    const { home, options, downloads } = repairFixture();
    const broken = () => ({ state: "invalid" as const, detail: "incomplete" });
    await expect(prepareCodexSupport(options, broken)).rejects.toThrow("one-time setup");
    expect(downloads()).toBe(0);
    await installFixture(home, "0.153.4");
    rmSync(join(codexSupportRoot(home), "codex-app-server.exe"));
    expect(readCodexSupportPack(home)?.complete).toBe(false);
    await prepareCodexSupport(options, broken);
    await prepareCodexSupport(options, broken);
    expect(readCodexSupportPack(home)?.complete).toBe(true);
    expect(downloads()).toBe(1);
    await prepareCodexSupport({ ...options, fetchImpl: Object.assign(() => { throw new Error("unexpected network"); }, { preconnect: fetch.preconnect }) },
      () => ({ state: "ready", detail: "external", executable: { path: "external", kind: "cli", source: "path", version: "0.153.4" } }));
  });

  test("concurrent repair waits cancellably and reuses the first verified package", async () => {
    const { home, options, downloads } = repairFixture();
    await installFixture(home, "0.153.4");
    let finish!: () => void;
    let entered!: () => void;
    const probing = new Promise<void>((resolve) => { entered = resolve; });
    const first = installCodexSupportPack({ ...options, repairOnly: true,
      verifyProtocol: () => { entered(); return new Promise<void>((resolve) => { finish = resolve; }); } });
    await probing;
    const controller = new AbortController();
    const waiting = installCodexSupportPack({ ...options, repairOnly: true, signal: controller.signal });
    controller.abort();
    await expect(waiting).rejects.toHaveProperty("name", "AbortError");
    const second = installCodexSupportPack({ ...options, repairOnly: true });
    finish();
    await Promise.all([first, second]);
    expect(downloads()).toBe(1);
    expect(existsSync(join(home, ".neko-core", ".codex-support.lock"))).toBe(false);
  });

  test("cancel during verification preserves the prior pack, removes staging and permits retry", async () => {
    const { home, options } = repairFixture();
    const previous = await installFixture(home, "0.144.0");
    const controller = new AbortController();
    await expect(installCodexSupportPack({ ...options, signal: controller.signal,
      verifyProtocol: async () => { controller.abort(); },
    })).rejects.toHaveProperty("name", "AbortError");
    expect(readFileSync(join(codexSupportRoot(home), "codex-app-server.exe"), "utf8")).toBe(previous);
    expect(readdirSync(join(home, ".neko-core"))).toEqual(["codex-support"]);
    await installCodexSupportPack(options);
    expect(readCodexSupportPack(home)?.complete).toBe(true);
  });

  test("cancel a streaming download without hanging or replacing the old pack", async () => {
    const { home, options } = repairFixture();
    await installFixture(home, "0.144.0");
    const controller = new AbortController();
    const fetchImpl: typeof fetch = Object.assign(async (input: string | URL | Request) => {
      if (String(input).includes("api.github.com")) return options.fetchImpl!(input);
      return new Response(new ReadableStream({ start(stream) {
        stream.enqueue(new Uint8Array([1]));
        setTimeout(() => controller.abort(), 20);
      } }));
    }, { preconnect: fetch.preconnect });
    await expect(installCodexSupportPack({ ...options, fetchImpl, signal: controller.signal })).rejects.toHaveProperty("name", "AbortError");
    expect(readCodexSupportPack(home)?.protocolVersion).toBe("0.144.0");
    expect(readdirSync(join(home, ".neko-core"))).toEqual(["codex-support"]);
  });
  test("archive layout rejects omitted hosts, traversal, links, duplicates and unexpected files", () => {
    const entries = [...codexPackageFiles("win32"), "bin/", "codex-resources/", "codex-path/"];
    const types = entries.map((entry) => entry.endsWith("/") ? "d" : "-");
    expect(() => validateCodexPackageEntries(entries, types, "win32")).not.toThrow();
    const hostIndex = entries.indexOf("bin/codex-code-mode-host.exe");
    for (const bad of ["../host.exe", "C:/host.exe", "/host.exe", "bin/unknown.exe", entries[0]]) {
      expect(() => validateCodexPackageEntries(entries.map((entry, i) => i === hostIndex ? bad : entry), types, "win32")).toThrow();
    }
    for (const type of ["l", "h", "d"]) {
      expect(() => validateCodexPackageEntries(entries, types.map((value, i) => i === hostIndex ? type : value), "win32")).toThrow();
    }
  });
  test("maps supported OS and CPU pairs to official standalone assets", () => {
    expect(codexSupportTarget("win32", "x64").archiveName).toBe("codex-app-server-package-x86_64-pc-windows-msvc.tar.gz");
    expect(codexSupportTarget("darwin", "arm64").archiveName).toBe("codex-app-server-package-aarch64-apple-darwin.tar.gz");
    expect(codexSupportTarget("linux", "x64").archiveName).toBe("codex-app-server-package-x86_64-unknown-linux-musl.tar.gz");
    expect(() => codexSupportTarget("freebsd", "x64")).toThrow("does not support freebsd");
  });

  test("installs atomically from the official release metadata and skips an identical reinstall", async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-support-test-"));
    homes.push(home);
    const archive = Buffer.from("synthetic archive");
    const digest = createHash("sha256").update(archive).digest("hex");
    let assetDownloads = 0;
    // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("api.github.com")) return Response.json({
        tag_name: "rust-v0.144.1",
        draft: false,
        prerelease: false,
        html_url: "https://github.com/openai/codex/releases/tag/rust-v0.144.1",
        assets: [{
          name: "codex-app-server-package-x86_64-pc-windows-msvc.tar.gz",
          size: archive.length,
          digest: `sha256:${digest}`,
          browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-app-server-package-x86_64-pc-windows-msvc.tar.gz",
        }],
      });
      assetDownloads++;
      return new Response(archive, { headers: { "content-length": String(archive.length) } });
    }) as typeof fetch;
    const extractArchive = (_archive: string, staging: string) => writePackageFixture(staging, "0.144.1");

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
    expect(installed.complete).toBe(true);
    expect(existsSync(join(codexSupportRoot(home), "bin/codex-code-mode-host.exe"))).toBe(true);

    const repeated = await installCodexSupportPack({ home, platform: "win32", arch: "x64", fetchImpl });
    expect(repeated.alreadyInstalled).toBe(true);
    expect(assetDownloads).toBe(1);
    rmSync(join(codexSupportRoot(home), "bin/codex-code-mode-host.exe"));
    let probes = 0;
    await expect(installCodexSupportPack({ home, platform: "win32", arch: "x64", fetchImpl,
      extractArchive: (_archive, staging) => {
        writePackageFixture(staging, "0.144.1");
        rmSync(join(staging, "bin/codex-code-mode-host.exe"));
      }, verifyBinary: () => {}, versionOf: () => "0.144.1", verifyProtocol: async () => { probes++; },
    })).rejects.toThrow("missing bin/codex-code-mode-host.exe");
    expect(probes).toBe(0);
    expect(existsSync(installed.path)).toBe(true);
    expect(readCodexSupportPack(home)?.complete).toBe(false);
    const repaired = await installCodexSupportPack({ home, platform: "win32", arch: "x64", fetchImpl,
      extractArchive, verifyBinary: () => {}, versionOf: () => "0.144.1", verifyProtocol: async () => {} });
    expect(repaired.alreadyInstalled).not.toBe(true);
    expect(assetDownloads).toBe(3);
    expect(readCodexSupportPack(home)?.complete).toBe(true);
    expect(removeCodexSupportPack(home)).toBe(true);
    expect(removeCodexSupportPack(home)).toBe(false);
    expect(existsSync(codexSupportRoot(home))).toBe(false);
  });

  test("a feature-specific minimum rejects an older latest release before download", async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-support-test-"));
    homes.push(home);
    let assetDownloads = 0;
    // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes("api.github.com")) return Response.json({
        tag_name: "rust-v0.144.1",
        assets: [{
          name: "codex-app-server-package-x86_64-pc-windows-msvc.tar.gz",
          size: 1,
          digest: `sha256:${"0".repeat(64)}`,
          browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-app-server-package-x86_64-pc-windows-msvc.tar.gz",
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
    // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes("api.github.com")) return Response.json({
        tag_name: "rust-v0.144.1",
        assets: [{
          name: "codex-app-server-package-x86_64-pc-windows-msvc.tar.gz",
          size: archive.length,
          digest: `sha256:${"0".repeat(64)}`,
          browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-app-server-package-x86_64-pc-windows-msvc.tar.gz",
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
    // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes("api.github.com")) return Response.json({
        tag_name: "rust-v0.144.1",
        assets: [{
          name: "codex-app-server-package-x86_64-pc-windows-msvc.tar.gz",
          size: archive.length,
          digest: `sha256:${digest}`,
          browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-app-server-package-x86_64-pc-windows-msvc.tar.gz",
        }],
      });
      return new Response(archive, { headers: { "content-length": String(archive.length) } });
    }) as typeof fetch;
    await expect(installCodexSupportPack({
      home,
      platform: "win32",
      arch: "x64",
      fetchImpl,
      extractArchive: (_path, staging) => writePackageFixture(staging, "0.144.1"),
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
    // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes("api.github.com")) return Response.json({
        tag_name: "rust-v0.144.1",
        assets: [{
          name: "codex-app-server-package-x86_64-pc-windows-msvc.tar.gz",
          size: archive.length,
          digest: `sha256:${digest}`,
          browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-app-server-package-x86_64-pc-windows-msvc.tar.gz",
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
      extractArchive: (_path, staging) => writePackageFixture(staging, "0.144.1"),
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
    // SAFETY: test-built fixture; the asserted shape is exactly what this test constructs.
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).includes("api.github.com")) return Response.json({
        tag_name: "rust-v0.144.1",
        assets: [{
          name: "codex-app-server-package-x86_64-pc-windows-msvc.tar.gz",
          size: archive.length,
          digest: `sha256:${digest}`,
          browser_download_url: "https://github.com/openai/codex/releases/download/rust-v0.144.1/codex-app-server-package-x86_64-pc-windows-msvc.tar.gz",
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
      extractArchive: (_path, staging) => writePackageFixture(staging, "0.144.1"),
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
