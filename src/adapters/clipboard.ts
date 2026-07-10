/**
 * Read an image off the system clipboard (for paste-image, Alt+V / /paste). Returns a temp PNG
 * path, or null if the clipboard holds no image. Per-OS: Windows uses .NET via PowerShell; macOS
 * uses pngpaste (if installed); Linux uses xclip. Best-effort — returns null on any failure.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Write plain TEXT to the system clipboard via the OS's native tool. This is the LOCAL copy path (the OSC
 * 52 escape only works when the terminal implements it - notably NOT legacy Windows conhost). Returns
 * whether the write succeeded. Windows: clip.exe fed UTF-16LE (round-trips Vietnamese/em-dash reliably;
 * the console codepage does not). macOS: pbcopy. Linux: wl-copy (Wayland) then xclip. Best-effort.
 */
export function writeClipboardText(text: string): boolean {
  try {
    if (process.platform === "win32") {
      // windowsHide: keep console children off OUR console so they can't clobber its (tab) title.
      return spawnSync("clip", [], { input: Buffer.from(text, "utf16le"), windowsHide: true }).status === 0;
    }
    if (process.platform === "darwin") {
      return spawnSync("pbcopy", [], { input: text }).status === 0;
    }
    if (spawnSync("wl-copy", [], { input: text }).status === 0) return true;
    return spawnSync("xclip", ["-selection", "clipboard"], { input: text }).status === 0;
  } catch {
    return false;
  }
}

export function readClipboardImage(): string | null {
  try {
    if (process.platform === "win32") {
      // Normalize at the source (what Claude Code does): cap the longest side at 1568px and encode
      // JPEG q82. A raw 4K screenshot PNG is multi-MB -> ~1M base64 chars -> an instant context-window
      // overflow (HTTP 400, negative max_tokens) on ANY model; resized JPEG is ~100-300KB and every
      // vision API reads JPEG. Vision models don't resolve beyond ~1.5k px anyway - nothing is lost.
      const dest = join(tmpdir(), `neko-paste-${Date.now()}.jpg`);
      const ps =
        `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $i=[System.Windows.Forms.Clipboard]::GetImage(); ` +
        `if($i){ $s=[Math]::Min(1.0, 1568.0/[Math]::Max($i.Width,$i.Height)); ` + // 1.0 forces the double overload (Min(int,int) truncates 0.49 -> 0 -> a 1x1 image)
        `$w=[int][Math]::Max(1,$i.Width*$s); $h=[int][Math]::Max(1,$i.Height*$s); ` +
        `$b=New-Object System.Drawing.Bitmap($w,$h); $g=[System.Drawing.Graphics]::FromImage($b); ` +
        `$g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic; ` +
        `$g.DrawImage($i,0,0,$w,$h); $g.Dispose(); ` +
        `$c=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object{$_.MimeType -eq 'image/jpeg'}; ` +
        `$p=New-Object System.Drawing.Imaging.EncoderParameters(1); ` +
        `$p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]82); ` +
        `$b.Save('${dest}',$c,$p); $b.Dispose(); 'ok' } else { '' }`;
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf-8", windowsHide: true });
      return r.stdout?.trim() === "ok" && existsSync(dest) ? dest : null;
    }
    const dest = join(tmpdir(), `neko-paste-${Date.now()}.png`);
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
