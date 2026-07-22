import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  discoverOfficeCli,
  installOfficeSupportPack,
  officeSupportRoot,
  officeSupportTarget,
  readOfficeSupportPack,
  removeOfficeSupportPack,
} from "../src/adapters/office-support-pack.ts";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("Office Support Pack", () => {
  test("maps supported OS, CPU, and libc pairs to official standalone assets", () => {
    expect(officeSupportTarget("win32", "x64").assetName).toBe("officecli-win-x64.exe");
    expect(officeSupportTarget("darwin", "arm64").assetName).toBe("officecli-mac-arm64");
    expect(officeSupportTarget("linux", "x64", true).assetName).toBe("officecli-linux-alpine-x64");
    expect(() => officeSupportTarget("freebsd", "x64")).toThrow("does not support freebsd");
    expect(() => officeSupportTarget("linux", "ia32")).toThrow("does not support CPU architecture");
  });

  test("installs atomically from official digest metadata and skips an identical reinstall", async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-office-support-"));
    homes.push(home);
    const binary = Buffer.from("synthetic office binary");
    const digest = createHash("sha256").update(binary).digest("hex");
    let downloads = 0;
    const fetchImpl = fixtureFetch(binary, digest, () => downloads++);

    const installed = await installOfficeSupportPack({
      home, platform: "win32", arch: "x64", fetchImpl,
      verifyBinary: () => {}, versionOf: () => "1.0.136", verifyProtocol: () => {},
    });
    expect(installed.officeVersion).toBe("1.0.136");
    expect(installed.license).toBe("Apache-2.0");
    expect(installed.archiveBytes).toBe(binary.length);
    expect(existsSync(installed.path)).toBe(true);
    expect(readOfficeSupportPack(home)?.assetDigest).toBe(`sha256:${digest}`);

    const repeated = await installOfficeSupportPack({ home, platform: "win32", arch: "x64", fetchImpl });
    expect(repeated.alreadyInstalled).toBe(true);
    expect(downloads).toBe(1);
    expect(removeOfficeSupportPack(home)).toBe(true);
    expect(removeOfficeSupportPack(home)).toBe(false);
  });

  test("a null version probe does NOT fail the install (checksum already proves identity)", async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-office-support-"));
    homes.push(home);
    const binary = Buffer.from("synthetic office binary");
    const digest = createHash("sha256").update(binary).digest("hex");
    // The binary exposes no parseable --version (probe returns null) - the real "version unknown" case.
    const installed = await installOfficeSupportPack({
      home, platform: "win32", arch: "x64", fetchImpl: fixtureFetch(binary, digest),
      verifyBinary: () => {}, versionOf: () => null, verifyProtocol: () => {},
    });
    expect(installed.officeVersion).toBe("1.0.136"); // recorded from the checksum-verified release tag
    expect(existsSync(installed.path)).toBe(true);
  });

  test("a NON-null version that disagrees with the release still fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-office-support-"));
    homes.push(home);
    const binary = Buffer.from("synthetic office binary");
    const digest = createHash("sha256").update(binary).digest("hex");
    await expect(installOfficeSupportPack({
      home, platform: "win32", arch: "x64", fetchImpl: fixtureFetch(binary, digest),
      verifyBinary: () => {}, versionOf: () => "9.9.9", verifyProtocol: () => {},
    })).rejects.toThrow("does not match release");
  });

  test("checksum failure preserves the previous working pack", async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-office-support-"));
    homes.push(home);
    installFixture(home, "1.0.135", "working binary");
    const binary = Buffer.from("tampered");
    const fetchImpl = fixtureFetch(binary, "0".repeat(64));

    await expect(installOfficeSupportPack({ home, platform: "win32", arch: "x64", fetchImpl })).rejects.toThrow("checksum mismatch");
    expect(readFileSync(join(officeSupportRoot(home), "officecli.exe"), "utf8")).toBe("working binary");
    expect(readOfficeSupportPack(home)?.officeVersion).toBe("1.0.135");
  });

  test("an identical-version install repairs same-size binary tampering", async () => {
    const home = mkdtempSync(join(tmpdir(), "neko-office-support-"));
    homes.push(home);
    const binary = Buffer.from("synthetic office binary");
    const digest = createHash("sha256").update(binary).digest("hex");
    let downloads = 0;
    const options = {
      home, platform: "win32" as const, arch: "x64" as const,
      fetchImpl: fixtureFetch(binary, digest, () => downloads++),
      verifyBinary: () => {}, versionOf: () => "1.0.136", verifyProtocol: () => {},
    };
    const installed = await installOfficeSupportPack(options);
    writeFileSync(installed.path, "x".repeat(binary.length));

    const repaired = await installOfficeSupportPack(options);
    expect(downloads).toBe(2);
    expect(repaired.alreadyInstalled).toBeUndefined();
    expect(readFileSync(repaired.path)).toEqual(binary);
  });

  test("rejects an escaping manifest and reports existing PATH ownership honestly", () => {
    const home = mkdtempSync(join(tmpdir(), "neko-office-support-"));
    homes.push(home);
    const root = officeSupportRoot(home);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "support-pack.json"), JSON.stringify({ officeVersion: "1.0.136", executable: "../outside.exe", license: "Apache-2.0" }));
    expect(readOfficeSupportPack(home)).toBeNull();

    const status = discoverOfficeCli(home, { which: () => "C:\\Tools\\officecli.exe", versionOf: () => "1.0.136" });
    expect(status.state).toBe("ready");
    expect(status.detail).toContain("existing PATH install");
  });
});

function fixtureFetch(binary: Buffer, digest: string, onDownload: () => void = () => {}): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("api.github.com")) return Response.json({
      tag_name: "v1.0.136", draft: false, prerelease: false,
      html_url: "https://github.com/iOfficeAI/OfficeCLI/releases/tag/v1.0.136",
      assets: [{
        name: "officecli-win-x64.exe", size: binary.length, digest: `sha256:${digest}`,
        browser_download_url: "https://github.com/iOfficeAI/OfficeCLI/releases/download/v1.0.136/officecli-win-x64.exe",
      }],
    });
    onDownload();
    return new Response(binary.toString("utf8"), { headers: { "content-length": String(binary.length) } });
  }) as typeof fetch;
}

function installFixture(home: string, version: string, binary: string): void {
  const root = officeSupportRoot(home);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "officecli.exe"), binary);
  writeFileSync(join(root, "support-pack.json"), JSON.stringify({
    officeVersion: version, releaseTag: `v${version}`, assetName: "officecli-win-x64.exe",
    assetDigest: `sha256:${"1".repeat(64)}`, archiveBytes: binary.length, installedBytes: binary.length,
    installedAt: new Date().toISOString(), executable: "officecli.exe",
    sourceUrl: `https://github.com/iOfficeAI/OfficeCLI/releases/tag/v${version}`, license: "Apache-2.0",
  }));
}
