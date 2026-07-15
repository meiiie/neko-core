import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createOfficeTools, type OfficeRunner } from "../src/adapters/office-tools.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("typed Office tools", () => {
  test("separates safe inspection from gated writes and reports guided setup", async () => {
    const root = workspace();
    const missing = createOfficeTools(root, { executable: null, libreOffice: null });
    expect(missing.permission?.("mcp__neko_office__inspect")).toBe("safe");
    expect(missing.permission?.("mcp__neko_office__apply")).toBe("gated");
    expect(missing.permission?.("mcp__neko_office__render")).toBe("gated");
    const status = await missing.call("mcp__neko_office__inspect", { operation: "status" });
    expect(status).toContain("neko support office install");
    expect(status).toContain("LibreOffice PDF verifier is not installed");
  });

  test("inspection is targeted, workspace-bounded, and returns a fresh file digest", async () => {
    const root = workspace();
    writeFileSync(join(root, "report.docx"), "source");
    const calls: string[][] = [];
    const tools = createOfficeTools(root, { executable: executable(), runner: async (_exe, args) => {
      calls.push(args);
      return { stdout: '{"data":{"results":[{"path":"/body/p[1]"}]}}', stderr: "" };
    } });
    const result = await tools.call("mcp__neko_office__inspect", { operation: "get", file: "report.docx", selector: "/body/p[1]", depth: 2 });
    expect(calls[0][0]).toBe("get");
    expect(calls[0][1]).not.toBe(join(root, "report.docx"));
    expect(calls[0][1]).toEndWith("report.docx");
    expect(calls[0].slice(2)).toEqual(["/body/p[1]", "--depth", "2", "--json"]);
    expect(existsSync(calls[0][1])).toBe(false);
    expect(result).toContain(createHash("sha256").update("source").digest("hex"));
    expect(result).toContain("/body/p[1]");
    await expect(tools.call("mcp__neko_office__inspect", { operation: "outline", file: "../secret.docx" })).rejects.toThrow("escapes project root");
  });

  test("batch edits a staged derivative, validates it, and leaves the source unchanged", async () => {
    const root = workspace();
    const source = join(root, "source.docx");
    writeFileSync(source, "original");
    let observedBatch: unknown;
    const runner: OfficeRunner = async (_exe, args) => {
      if (args[0] === "batch") {
        const input = args[args.indexOf("--input") + 1];
        observedBatch = JSON.parse(readFileSync(input, "utf8"));
        writeFileSync(args[1], `${readFileSync(args[1], "utf8")}:edited`);
        return { stdout: '{"success":true}', stderr: "" };
      }
      if (args[0] === "validate") return { stdout: '{"valid":true}', stderr: "" };
      return { stdout: '{"success":true}', stderr: "" };
    };
    const tools = createOfficeTools(root, { executable: executable(), runner });
    const result = await tools.call("mcp__neko_office__apply", {
      source: "source.docx", output: "out/report.docx",
      commands: [{ op: "set", path: "/body/p[1]", props: { text: "Use ../ literally", hyperlink: "https://example.com" } }],
    });
    expect(readFileSync(source, "utf8")).toBe("original");
    expect(readFileSync(join(root, "out", "report.docx"), "utf8")).toBe("original:edited");
    expect(observedBatch).toEqual([{ op: "set", path: "/body/p[1]", props: { text: "Use ../ literally", hyperlink: "https://example.com" } }]);
    expect(result).toContain("Freshly inspect changed targets");
  });

  test("same-file edits require a hash and failures never replace the original", async () => {
    const root = workspace();
    const source = join(root, "source.xlsx");
    writeFileSync(source, "original");
    const failing: OfficeRunner = async (_exe, args) => {
      if (args[0] === "batch") throw new Error("synthetic batch failure");
      return { stdout: "{}", stderr: "" };
    };
    const tools = createOfficeTools(root, { executable: executable(), runner: failing });
    const command = [{ op: "set", path: "/Sheet1/A1", props: { value: 42 } }];
    await expect(tools.call("mcp__neko_office__apply", { source: "source.xlsx", output: "source.xlsx", commands: command, overwrite: true })).rejects.toThrow("expected_source_sha256");
    const digest = createHash("sha256").update("original").digest("hex");
    await expect(tools.call("mcp__neko_office__apply", {
      source: "source.xlsx", output: "source.xlsx", commands: command, overwrite: true, expected_source_sha256: digest,
    })).rejects.toThrow("synthetic batch failure");
    expect(readFileSync(source, "utf8")).toBe("original");
  });

  test("render writes bounded visual evidence for a later vision pass", async () => {
    const root = workspace();
    writeFileSync(join(root, "deck.pptx"), "deck");
    const tools = createOfficeTools(root, { executable: executable(), runner: async (_exe, args) => {
      const output = args[args.indexOf("-o") + 1];
      writeFileSync(output, "png");
      return { stdout: '{"success":true}', stderr: "" };
    } });
    const result = await tools.call("mcp__neko_office__render", { file: "deck.pptx", mode: "screenshot", output: "evidence/deck.png", page: "1-2" });
    expect(existsSync(join(root, "evidence", "deck.png"))).toBe(true);
    expect(result).toContain("Open every listed PNG");
  });

  test("render never reports success without a non-empty evidence file", async () => {
    const root = workspace();
    writeFileSync(join(root, "deck.pptx"), "deck");
    const tools = createOfficeTools(root, { executable: executable(), runner: async () => ({ stdout: '{"success":true}', stderr: "" }) });
    await expect(tools.call("mcp__neko_office__render", {
      file: "deck.pptx", mode: "screenshot", output: "evidence/missing.png",
    })).rejects.toThrow("without producing non-empty evidence");
    writeFileSync(join(root, "evidence", "missing.png"), "previous evidence");
    await expect(tools.call("mcp__neko_office__render", {
      file: "deck.pptx", mode: "screenshot", output: "evidence/missing.png", overwrite: true,
    })).rejects.toThrow("without producing non-empty evidence");
    expect(readFileSync(join(root, "evidence", "missing.png"), "utf8")).toBe("previous evidence");
  });

  test("LibreOffice cross-renders a whole PDF without requiring OfficeCLI", async () => {
    const root = workspace();
    const source = join(root, "deck.pptx");
    writeFileSync(source, "deck");
    let profile = "";
    let snapshot = "";
    const tools = createOfficeTools(root, {
      executable: null,
      libreOffice: { path: "soffice-test", source: "system", version: "26.2.4" },
      libreOfficeRunner: async (_exe, args) => {
        profile = fileURLToPath(args[0].slice("-env:UserInstallation=".length));
        snapshot = args.at(-1)!;
        expect(args).toContain("--headless");
        expect(args).toContain("pdf:impress_pdf_Export");
        const outDir = args[args.indexOf("--outdir") + 1];
        writeFileSync(join(outDir, `${basename(snapshot, extname(snapshot))}.pdf`), "pdf evidence");
        return { stdout: "convert ok", stderr: "" };
      },
    });
    const result = await tools.call("mcp__neko_office__render", {
      file: "deck.pptx", mode: "pdf", output: "evidence/deck.pdf",
    });
    expect(readFileSync(join(root, "evidence", "deck.pdf"), "utf8")).toBe("pdf evidence");
    expect(snapshot).not.toBe(source);
    expect(existsSync(snapshot)).toBe(false);
    expect(existsSync(profile)).toBe(false);
    expect(result).toContain("LibreOffice 26.2.4 (system; isolated profile)");
    expect(result).toContain("cross-renderability");
  });

  test("LibreOffice PDF failure preserves existing evidence and rejects page subsets", async () => {
    const root = workspace();
    writeFileSync(join(root, "book.xlsx"), "book");
    const evidence = join(root, "book.pdf");
    writeFileSync(evidence, "previous evidence");
    let calls = 0;
    const tools = createOfficeTools(root, {
      executable: null,
      libreOffice: { path: "soffice-test", source: "path" },
      libreOfficeRunner: async () => { calls++; return { stdout: "", stderr: "synthetic failure" }; },
    });
    await expect(tools.call("mcp__neko_office__render", {
      file: "book.xlsx", mode: "pdf", output: "book.pdf", overwrite: true,
    })).rejects.toThrow("without producing a non-empty PDF");
    expect(readFileSync(evidence, "utf8")).toBe("previous evidence");
    await expect(tools.call("mcp__neko_office__render", {
      file: "book.xlsx", mode: "pdf", output: "other.pdf", page: "1",
    })).rejects.toThrow("exports the complete artifact");
    expect(calls).toBe(1);
  });

  test("PDF evidence explains how to add LibreOffice instead of installing it silently", async () => {
    const root = workspace();
    writeFileSync(join(root, "report.docx"), "report");
    const tools = createOfficeTools(root, { executable: null, libreOffice: null });
    await expect(tools.call("mcp__neko_office__render", {
      file: "report.docx", mode: "pdf", output: "report.pdf",
    })).rejects.toThrow("libreoffice.org/download");
  });

  test("rejects raw/network mutations before executing the third-party engine", async () => {
    const root = workspace();
    let calls = 0;
    const tools = createOfficeTools(root, { executable: executable(), runner: async () => { calls++; return { stdout: "{}", stderr: "" }; } });
    await expect(tools.call("mcp__neko_office__apply", {
      output: "deck.pptx", commands: [{ op: "raw-set", path: "/", props: {} }],
    })).rejects.toThrow("forbidden operation");
    await expect(tools.call("mcp__neko_office__apply", {
      output: "deck.pptx", commands: [{ op: "add", parent: "/slide[1]", type: "picture", props: { src: "https://example.com/x.png" } }],
    })).rejects.toThrow("cannot fetch remote resources");
    expect(calls).toBe(0);
  });

  test("rechecks a managed binary digest before the first execution", async () => {
    const root = workspace();
    const binary = join(root, "officecli.exe");
    writeFileSync(binary, "tampered");
    let calls = 0;
    const tools = createOfficeTools(root, {
      executable: { path: binary, source: "managed", version: "1.0.136", digest: `sha256:${"0".repeat(64)}` },
      runner: async () => { calls++; return { stdout: "{}", stderr: "" }; },
    });
    await expect(tools.call("mcp__neko_office__inspect", { operation: "help", format: "docx" })).rejects.toThrow("failed its integrity check");
    expect(calls).toBe(0);
  });

  test("a missing pack can be installed and retried without restarting Neko", async () => {
    const root = workspace();
    const options: any = {
      executable: null,
      runner: async () => ({ stdout: '{"ok":true}', stderr: "" }),
    };
    const tools = createOfficeTools(root, options);
    await expect(tools.call("mcp__neko_office__inspect", { operation: "help", format: "docx" })).rejects.toThrow("not installed");
    options.executable = { path: "officecli-test", source: "path", version: "1.0.136" };
    expect(await tools.call("mcp__neko_office__inspect", { operation: "help", format: "docx" })).toContain('"ok": true');
  });

  test("an atomically updated managed pack is re-resolved and re-hashed in the same session", async () => {
    const root = workspace();
    const binary = join(root, "officecli.exe");
    writeFileSync(binary, "old");
    const options: any = {
      executable: {
        path: binary, source: "managed", version: "1.0.135",
        digest: `sha256:${createHash("sha256").update("old").digest("hex")}`,
      },
      runner: async () => ({ stdout: '{"ok":true}', stderr: "" }),
    };
    const tools = createOfficeTools(root, options);
    expect(await tools.call("mcp__neko_office__inspect", { operation: "help", format: "docx" })).toContain("1.0.135");

    writeFileSync(binary, "new managed binary");
    options.executable = {
      path: binary, source: "managed", version: "1.0.136",
      digest: `sha256:${createHash("sha256").update("new managed binary").digest("hex")}`,
    };
    expect(await tools.call("mcp__neko_office__inspect", { operation: "help", format: "docx" })).toContain("1.0.136");
  });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), "neko-office-tools-"));
  roots.push(root);
  return root;
}

function executable() {
  return { path: "officecli-test", source: "managed" as const, version: "1.0.136" };
}
