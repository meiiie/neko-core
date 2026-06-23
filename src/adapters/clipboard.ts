/**
 * Read an image off the system clipboard (for paste-image, Alt+V / /paste). Returns a temp PNG
 * path, or null if the clipboard holds no image. Per-OS: Windows uses .NET via PowerShell; macOS
 * uses pngpaste (if installed); Linux uses xclip. Best-effort — returns null on any failure.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function readClipboardImage(): string | null {
  const dest = join(tmpdir(), `neko-paste-${Date.now()}.png`);
  try {
    if (process.platform === "win32") {
      const ps = `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $i=[System.Windows.Forms.Clipboard]::GetImage(); if($i){ $i.Save('${dest}'); 'ok' } else { '' }`;
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf-8" });
      return r.stdout?.trim() === "ok" && existsSync(dest) ? dest : null;
    }
    if (process.platform === "darwin") {
      const r = spawnSync("pngpaste", [dest], { encoding: "utf-8" }); // brew install pngpaste
      return r.status === 0 && existsSync(dest) ? dest : null;
    }
    spawnSync("bash", ["-c", `xclip -selection clipboard -t image/png -o > '${dest}'`], { encoding: "utf-8" });
    return existsSync(dest) && statSync(dest).size > 0 ? dest : null;
  } catch {
    return null;
  }
}
