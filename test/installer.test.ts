import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const windows = readFileSync("install.ps1", "utf8");
const unix = readFileSync("install.sh", "utf8");
const release = readFileSync(".github/workflows/release.yml", "utf8");

test("one-line installers hand optional browser setup to the installed Neko app", () => {
  for (const installer of [windows, unix]) {
    expect(installer).toContain("Run 'neko' to get started.");
    expect(installer).toContain("Inside Neko: /login");
    expect(installer).toContain("/browser");
    expect(installer).toContain("no Bun command needed");
    expect(installer).not.toContain("bun bin/neko.ts browser install");
  }
});

test("Windows one-line installer verifies metadata, digest, and version before atomic replacement", () => {
  const download = windows.indexOf("Get-NekoBinary $url $stage");
  const digest = windows.indexOf("Get-FileHash -LiteralPath $candidate -Algorithm SHA256");
  const version = windows.indexOf("& $candidate version");
  const replace = windows.indexOf("[System.IO.File]::Replace($candidate, $dest, $backup, $true)");
  expect(windows).toContain("/releases/tags/$tag");
  expect(windows).toContain("$assetMeta.digest");
  expect(windows).toContain("Resolve-NekoLatestTag");
  expect(windows).toContain('"$url.sha256"');
  expect(windows).toContain("verified-release fallback active");
  expect(windows).toContain("the previous Neko install was preserved");
  expect(windows).toContain("InfiniteTimeSpan");
  expect(windows).toContain("bytes=$offset-");
  expect(windows).toContain('"$asset.gz"');
  expect(windows).toContain("run the installer again to resume");
  expect(windows).not.toContain("Get-NekoBinary $url $dest");
  expect(download).toBeGreaterThan(0);
  expect(digest).toBeGreaterThan(download);
  expect(version).toBeGreaterThan(digest);
  expect(replace).toBeGreaterThan(version);
});

test("Unix one-line installer stages and verifies v0.10+ before atomic rename", () => {
  const download = unix.indexOf('"$DOWNLOAD_URL" -o "$STAGE"');
  const digest = unix.indexOf('ACTUAL="$(sha256sum "$CANDIDATE"');
  const version = unix.indexOf('VER="$("$CANDIDATE" version');
  const replace = unix.indexOf('mv -f "$CANDIDATE" "$TARGET"');
  expect(unix).toContain("release $TAG is missing its required checksum asset");
  expect(unix).toContain("-w '%{url_effective}'");
  expect(unix).toContain("/releases/tag/");
  expect(unix).toContain("--continue-at -");
  expect(unix).toContain("--retry-all-errors");
  expect(unix).toContain('DOWNLOAD_URL="$URL.gz"');
  expect(unix).toContain("Run the installer again to resume");
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
  expect(release).toContain('gzip -9 -c "${{ matrix.asset }}"');
  expect(release).toContain('"${{ matrix.asset }}.gz"');
  expect(release).toContain("Compress-Archive");
  expect(release).toContain('"${{ matrix.asset }}.zip"');
});

test("release workflow keeps a tag draft until the complete asset set exists", () => {
  const createDraft = release.indexOf("--draft --generate-notes");
  const uploadBinary = release.indexOf('gh release upload "$GITHUB_REF_NAME" "${assets[@]}"');
  const publish = release.indexOf('--draft=false --latest');
  expect(createDraft).toBeGreaterThan(0);
  expect(uploadBinary).toBeGreaterThan(createDraft);
  expect(publish).toBeGreaterThan(uploadBinary);
  expect(release).toContain('test "$count" -eq 17');
  expect(release).toContain("needs: publish");
});
