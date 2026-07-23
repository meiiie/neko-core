import { expect, test } from "bun:test";

import { encodePowerShellCommand } from "../src/adapters/ocr-setup.ts";

test("OCR setup preserves PowerShell variables through the elevated boundary", () => {
  const command = "$c = Get-WindowsCapability | Where-Object { $_.Name -like 'Language.OCR~~~vi*' }";
  const encoded = encodePowerShellCommand(command);
  expect(encoded).toMatch(/^[A-Za-z0-9+/=]+$/);
  expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(command);
});
