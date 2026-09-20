import { expect, test } from "bun:test";
import {
  chromeDenyPrefix,
  chromeGlyph,
  chromeModeChip,
  chromeOkPrefix,
  chromeTreePrefix,
  chromeWarnPrefix,
  useAsciiChrome,
} from "../src/ui/chrome-glyphs.ts";

test("NEKO_ASCII_CHROME=1 forces ASCII chrome map", () => {
  const prev = process.env.NEKO_ASCII_CHROME;
  try {
    process.env.NEKO_ASCII_CHROME = "1";
    expect(useAsciiChrome()).toBe(true);
    expect(chromeGlyph("warn")).toBe("!");
    expect(chromeGlyph("ok")).toBe("+");
    expect(chromeGlyph("deny")).toBe("X");
    expect(chromeGlyph("mode")).toBe(">>");
    expect(chromeGlyph("tree")).toBe("|-");
    expect(chromeWarnPrefix()).toBe("! ");
    expect(chromeOkPrefix()).toBe("+ ");
    expect(chromeDenyPrefix()).toBe("X ");
    expect(chromeModeChip()).toBe(" >> ");
    expect(chromeTreePrefix()).toContain("|-");
    // Never emit literal ?? replacement tofu from our map.
    for (const kind of ["warn", "ok", "deny", "mode", "tree"] as const) {
      expect(chromeGlyph(kind)).not.toContain("?");
    }
  } finally {
    if (prev === undefined) delete process.env.NEKO_ASCII_CHROME;
    else process.env.NEKO_ASCII_CHROME = prev;
  }
});

test("NEKO_ASCII_CHROME=0 keeps Unicode chrome on UTF-8 locale", () => {
  const prev = process.env.NEKO_ASCII_CHROME;
  const prevLang = process.env.LANG;
  try {
    process.env.NEKO_ASCII_CHROME = "0";
    process.env.LANG = "C.UTF-8";
    expect(useAsciiChrome()).toBe(false);
    expect(chromeGlyph("warn")).toBe("⚠");
    expect(chromeGlyph("mode")).toBe(">>"); // U+23F5 removed — tofu/?? on Linux CSR
    expect(chromeGlyph("deny")).toBe("✗");
    expect(chromeWarnPrefix()).toBe("⚠ ");
    expect(chromeModeChip()).toBe(" >> ");
  } finally {
    if (prev === undefined) delete process.env.NEKO_ASCII_CHROME;
    else process.env.NEKO_ASCII_CHROME = prev;
    if (prevLang === undefined) delete process.env.LANG;
    else process.env.LANG = prevLang;
  }
});

test("non-UTF-8 locale auto-selects ASCII chrome when env unset", () => {
  const prev = process.env.NEKO_ASCII_CHROME;
  const prevAll = process.env.LC_ALL;
  const prevLang = process.env.LANG;
  const prevCtype = process.env.LC_CTYPE;
  try {
    delete process.env.NEKO_ASCII_CHROME;
    process.env.LC_ALL = "C";
    delete process.env.LANG;
    delete process.env.LC_CTYPE;
    expect(useAsciiChrome({ ...process.env, LC_ALL: "C", LANG: undefined, LC_CTYPE: undefined, NEKO_ASCII_CHROME: undefined })).toBe(true);
  } finally {
    if (prev === undefined) delete process.env.NEKO_ASCII_CHROME;
    else process.env.NEKO_ASCII_CHROME = prev;
    if (prevAll === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = prevAll;
    if (prevLang === undefined) delete process.env.LANG;
    else process.env.LANG = prevLang;
    if (prevCtype === undefined) delete process.env.LC_CTYPE;
    else process.env.LC_CTYPE = prevCtype;
  }
});
