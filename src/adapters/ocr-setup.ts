/**
 * `neko setup ocr` — install the Windows Vietnamese OCR language pack so `computer ocr` reads
 * accented Vietnamese correctly (without it, en-US still reads Vietnamese as unaccented Latin).
 * One UAC prompt; the elevated step finds the exact vi OCR capability (its version suffix varies by
 * Windows build) and installs it. Idempotent: reports "already installed" and does nothing if present.
 */
import { spawnSync } from "node:child_process";

/** PowerShell's -EncodedCommand contract is UTF-16LE. This keeps `$` expressions literal across UAC. */
export function encodePowerShellCommand(command: string): string {
  return Buffer.from(command, "utf16le").toString("base64");
}

/** OCR recognizer language tags currently available (no elevation needed). Empty on failure. */
function ocrLanguages(): string[] {
  const ps = [
    "$ErrorActionPreference='Stop'",
    "try { [void][Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]",
    "[Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object { $_.LanguageTag } } catch {}",
  ].join("; ");
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps], { encoding: "utf-8", timeout: 20_000, windowsHide: true });
  return (r.stdout || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
}

/** True once the OCR engine exposes a Vietnamese recognizer. */
function hasVietnameseOcr(): boolean {
  return ocrLanguages().some((tag) => /^vi/i.test(tag));
}

/** Install the Vietnamese OCR language pack (one UAC prompt). Returns 0 on success. */
export function setupOcr(log: (m: string) => void): number {
  if (process.platform !== "win32") {
    log("setup ocr installs the Windows OCR language pack (win32 only). On macOS/Linux, computer OCR is not the perception path.");
    return 2;
  }
  const before = ocrLanguages();
  log(`Current OCR languages: ${before.length ? before.join(", ") : "(none / OCR engine unavailable)"}`);
  if (hasVietnameseOcr()) {
    log("Vietnamese OCR is already installed - `computer ocr` reads accented Vietnamese. Nothing to do.");
    return 0;
  }
  log("Installing the Vietnamese OCR pack - Windows will show ONE administrator (UAC) prompt. Approve it.");
  // Elevated step: find the exact vi OCR capability (version suffix differs by build) and install it.
  const elevated = [
    "$c = Get-WindowsCapability -Online | Where-Object { $_.Name -like 'Language.OCR~~~vi*' } | Select-Object -First 1;",
    "if (-not $c) { Write-Host 'no-vi-capability'; exit 3 }",
    "if ($c.State -eq 'Installed') { Write-Host 'already'; exit 0 }",
    "Add-WindowsCapability -Online -Name $c.Name | Out-Null; Write-Host 'installed'",
  ].join(" ");
  // Start-Process -Verb RunAs triggers the UAC prompt; -Wait blocks until the install finishes.
  const encoded = encodePowerShellCommand(elevated);
  const runner = `Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'`;
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", runner], { encoding: "utf-8", timeout: 300_000, windowsHide: true });
  if (r.status !== 0) {
    log(`The elevated install did not complete (${(r.stderr || r.stdout || "cancelled or failed").trim().slice(0, 200)}).`);
    log('If the UAC prompt was declined, re-run `neko setup ocr` and approve it.');
    return 1;
  }
  if (hasVietnameseOcr()) {
    log("Done. Vietnamese OCR installed - `computer ocr` now reads accented Vietnamese. (Reopen neko so the resident host reloads the recognizer.)");
    return 0;
  }
  log("The install ran but a Vietnamese recognizer is still not available. Your Windows edition may not offer the vi-VN OCR pack; en-US still reads unaccented Vietnamese, which is usually enough to locate and click a label.");
  return 1;
}
