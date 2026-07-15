import { describe, expect, test } from "bun:test";

import { discoverLibreOffice, resolveLibreOfficeExecutable } from "../src/adapters/libreoffice.ts";

describe("LibreOffice discovery", () => {
  test("prefers an existing PATH command", () => {
    const executable = resolveLibreOfficeExecutable({
      platform: "win32",
      which: (name) => name === "soffice.com" ? "C:\\tools\\soffice.com" : name === "soffice" ? "C:\\tools\\soffice.exe" : null,
      exists: () => false,
    });
    expect(executable).toEqual({ path: "C:\\tools\\soffice.com", source: "path" });
  });

  test("finds the standard Windows console executable without PATH", () => {
    const executable = resolveLibreOfficeExecutable({
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files" },
      which: () => null,
      exists: (path) => path === "C:\\Program Files\\LibreOffice\\program\\soffice.com",
    });
    expect(executable).toEqual({
      path: "C:\\Program Files\\LibreOffice\\program\\soffice.com",
      source: "system",
    });
  });

  test("reports a verified version and a broken executable honestly", () => {
    const ready = discoverLibreOffice({
      which: () => "/usr/bin/libreoffice",
      versionOf: () => "26.2.4",
    });
    expect(ready.state).toBe("ready");
    expect(ready.detail).toContain("26.2.4");

    const broken = discoverLibreOffice({
      which: () => "/usr/bin/libreoffice",
      versionOf: () => null,
    });
    expect(broken.state).toBe("broken");
  });

  test("supports an explicit verifier path for portable CI without mutating PATH", () => {
    const ready = discoverLibreOffice({
      env: { NEKO_LIBREOFFICE_PATH: "C:\\ci\\LibreOffice\\program\\soffice.com" },
      exists: () => true,
      which: () => null,
      versionOf: () => "26.2.4.2",
    });
    expect(ready.executable).toEqual({
      path: "C:\\ci\\LibreOffice\\program\\soffice.com",
      source: "configured",
      version: "26.2.4.2",
    });

    const broken = discoverLibreOffice({
      env: { NEKO_LIBREOFFICE_PATH: "C:\\missing\\soffice.com" },
      exists: () => false,
    });
    expect(broken.state).toBe("broken");
    expect(broken.detail).toContain("NEKO_LIBREOFFICE_PATH");
  });
});
