/**
 * Networked release/value gate. Not part of `bun test`.
 * Downloads the official checksummed Office Support Pack into a temp home, then exercises the exact
 * Neko adapter against real DOCX/XLSX/PPTX packages. Set NEKO_OFFICE_KEEP=1 to retain visual evidence.
 */
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createOfficeTools } from "../src/adapters/office-tools.ts";
import { discoverLibreOffice } from "../src/adapters/libreoffice.ts";
import { installOfficeSupportPack, readOfficeSupportPack } from "../src/adapters/office-support-pack.ts";

const ownsHome = !process.env.NEKO_OFFICE_HOME;
const home = process.env.NEKO_OFFICE_HOME || mkdtempSync(join(tmpdir(), "neko-office-eval-home-"));
const root = mkdtempSync(join(tmpdir(), "neko-office-eval-work-"));
let ok = false;
try {
  const installed = readOfficeSupportPack(home) ?? await installOfficeSupportPack({ home, notify: (message) => console.log(message) });
  const libreOffice = discoverLibreOffice();
  if (process.env.NEKO_OFFICE_REQUIRE_LIBREOFFICE === "1" && libreOffice.state !== "ready") {
    throw new Error(`LibreOffice evidence gate is required but unavailable: ${libreOffice.detail}`);
  }
  const tools = createOfficeTools(root, {
    executable: { path: installed.path, source: "managed", version: installed.officeVersion, digest: installed.assetDigest },
    libreOffice: libreOffice.state === "ready" ? libreOffice.executable : null,
  });

  await tools.call("mcp__neko_office__apply", {
    output: "neko-office.docx",
    commands: [
      { command: "add", parent: "/body", type: "paragraph", props: { text: "Neko Core Office verification", bold: true, size: "18pt", color: "1F4E79" } },
      { command: "add", parent: "/body", type: "paragraph", props: { text: "Typed batch, fresh reopen, structural validation, and visual evidence." } },
    ],
  });
  await tools.call("mcp__neko_office__apply", {
    output: "neko-office.xlsx",
    commands: [
      { command: "set", path: "/Sheet1/A1", props: { text: "Metric", bold: true } },
      { command: "set", path: "/Sheet1/B1", props: { text: "Value", bold: true } },
      { command: "set", path: "/Sheet1/A2", props: { text: "Verified" } },
      { command: "set", path: "/Sheet1/B2", props: { text: "1" } },
    ],
  });
  await tools.call("mcp__neko_office__apply", {
    output: "neko-office.pptx",
    commands: [
      { command: "add", parent: "/", type: "slide", props: { background: "111827" } },
      { command: "add", parent: "/slide[1]", type: "shape", props: { text: "Neko Core Office", x: "2cm", y: "1.2cm", w: "20cm", h: "2cm", size: 32, bold: true, color: "FFFFFF", fill: "none", line: "none" } },
      { command: "add", parent: "/slide[1]", type: "shape", props: { text: "Verified artifact workflow", x: "2cm", y: "5cm", w: "20cm", h: "2cm", size: 24, color: "FFFFFF", fill: "none", line: "none" } },
    ],
  });

  const expectedText: Record<string, string[]> = {
    "neko-office.docx": ["Neko Core Office verification", "Typed batch"],
    "neko-office.xlsx": ["Metric", "Value", "Verified"],
    "neko-office.pptx": ["Neko Core Office", "Verified artifact workflow"],
  };
  const evidence: Record<string, unknown> = {};
  for (const file of ["neko-office.docx", "neko-office.xlsx", "neko-office.pptx"]) {
    const validate = JSON.parse(await tools.call("mcp__neko_office__inspect", { operation: "validate", file }));
    const outline = JSON.parse(await tools.call("mcp__neko_office__inspect", { operation: "outline", file }));
    const text = JSON.parse(await tools.call("mcp__neko_office__inspect", { operation: "text", file, max_lines: 100 }));
    const semantic = JSON.stringify(text.result);
    if (!validate.success || !outline.success || !existsSync(join(root, file)) || statSync(join(root, file)).size < 1000) {
      throw new Error(`real Office gate failed for ${file}`);
    }
    for (const expected of expectedText[file] ?? []) {
      if (!semantic.includes(expected)) throw new Error(`fresh semantic readback for ${file} missed ${expected}`);
    }
    evidence[file] = { sha256: validate.sha256, bytes: statSync(join(root, file)).size, semantic: expectedText[file] };
  }
  const renders: Record<string, unknown> = {};
  for (const file of ["neko-office.docx", "neko-office.xlsx", "neko-office.pptx"]) {
    const stem = file.slice(0, file.lastIndexOf("."));
    const png = join(root, "evidence", `${stem}-${file.slice(-4)}.png`);
    const render = JSON.parse(await tools.call("mcp__neko_office__render", {
      file, mode: "screenshot", output: png, page: "1", overwrite: true,
    }));
    if (!render.success || !existsSync(png) || statSync(png).size < 1000) throw new Error(`real visual evidence gate failed for ${file}`);
    renders[file] = { file: png, bytes: statSync(png).size };
  }
  evidence.render = renders;
  const crossRenders: Record<string, unknown> = {};
  if (libreOffice.state === "ready") {
    for (const file of ["neko-office.docx", "neko-office.xlsx", "neko-office.pptx"]) {
      const stem = file.slice(0, file.lastIndexOf("."));
      const pdf = join(root, "evidence", `${stem}-${file.slice(-4)}-libreoffice.pdf`);
      const render = JSON.parse(await tools.call("mcp__neko_office__render", {
        file, mode: "pdf", output: pdf, overwrite: true,
      }));
      if (!render.success || !existsSync(pdf) || statSync(pdf).size < 1000) throw new Error(`LibreOffice cross-render gate failed for ${file}`);
      crossRenders[file] = { file: pdf, bytes: statSync(pdf).size };
    }
  }
  evidence.libreoffice = { status: libreOffice, render: crossRenders };
  ok = true;
  console.log(JSON.stringify({ success: true, officeVersion: installed.officeVersion, home, root, evidence }, null, 2));
} finally {
  if (process.env.NEKO_OFFICE_KEEP !== "1" || !ok) {
    if (ownsHome) rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}
