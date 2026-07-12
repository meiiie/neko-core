import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const windows = readFileSync("install.ps1", "utf8");
const unix = readFileSync("install.sh", "utf8");
const release = readFileSync(".github/workflows/release.yml", "utf8");

test("Windows one-line installer verifies metadata, digest, and version before atomic replacement", () => {
  const download = windows.indexOf("Get-NekoBinary $url $stage");
  const digest = windows.indexOf("Get-FileHash -LiteralPath $stage -Algorithm SHA256");
  const version = windows.indexOf("& $stage version");
  const replace = windows.indexOf("[System.IO.File]::Replace($stage, $dest, $backup, $true)");
  expect(windows).toContain("/releases/tags/$tag");
  expect(windows).toContain("$assetMeta.digest");
  expect(windows).toContain("Resolve-NekoLatestTag");
  expect(windows).toContain('"$url.sha256"');
  expect(windows).toContain("verified-release fallback active");
  expect(windows).toContain("the previous Neko install was preserved");
  expect(windows).not.toContain("Get-NekoBinary $url $dest");
  expect(download).toBeGreaterThan(0);
  expect(digest).toBeGreaterThan(download);
  expect(version).toBeGreaterThan(digest);
  expect(replace).toBeGreaterThan(version);
});

test("Unix one-line installer stages and verifies v0.10+ before atomic rename", () => {
  const download = unix.indexOf('"$URL" -o "$STAGE"');
  const digest = unix.indexOf('ACTUAL="$(sha256sum "$STAGE"');
  const version = unix.indexOf('VER="$("$STAGE" version');
  const replace = unix.indexOf('mv -f "$STAGE" "$TARGET"');
  expect(unix).toContain("release $TAG is missing its required checksum asset");
  expect(unix).toContain("-w '%{url_effective}'");
  expect(unix).toContain("/releases/tag/");
  expect(unix).not.toContain('"$URL" -o "$TARGET"');
  expect(download).toBeGreaterThan(0);
  expect(digest).toBeGreaterThan(download);
  expect(version).toBeGreaterThan(digest);
  expect(replace).toBeGreaterThan(version);
});

test("release workflow publishes one SHA-256 sidecar with every platform binary", () => {
  expect(release).toContain('"${{ matrix.asset }}.sha256"');
  expect(release).toContain('sha256sum "${{ matrix.asset }}"');
  expect(release).toContain('shasum -a 256 "${{ matrix.asset }}"');
});
