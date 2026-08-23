/**
 * Read an image off the system clipboard (for paste-image, Alt+V / /paste). Returns a temp image
 * path, or null if the clipboard holds no image. Windows keeps one warm STA PowerShell worker so an
 * Alt+V never starts .NET or blocks Ink's input loop. macOS/Linux retain their platform helpers.
 */
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
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

type PendingClipboardRead = {
  resolve: (path: string | null) => void;
  timer: ReturnType<typeof setTimeout>;
};

type WindowsClipboardWorker = {
  child: ChildProcessWithoutNullStreams;
  ready: Promise<boolean>;
  pending: PendingClipboardRead[];
  buffer: string;
  isReady: boolean;
};

let windowsWorker: WindowsClipboardWorker | null = null;

// One process startup cost per Neko session instead of per paste. Keeping image conversion inside the
// STA worker also avoids a native clipboard dependency that would break the single-binary build.
const WINDOWS_CLIPBOARD_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
[Console]::Out.WriteLine('ready')
while (($line=[Console]::In.ReadLine()) -ne $null) {
  try {
    $edge=[Math]::Min(4096,[Math]::Max(512,[int]$line))
    $i=[System.Windows.Forms.Clipboard]::GetImage()
    if ($null -eq $i) { [Console]::Out.WriteLine('-'); continue }
    $s=[Math]::Min(1.0,$edge/[double][Math]::Max($i.Width,$i.Height))
    $w=[int][Math]::Max(1,$i.Width*$s); $h=[int][Math]::Max(1,$i.Height*$s)
    $b=New-Object System.Drawing.Bitmap($w,$h)
    $g=[System.Drawing.Graphics]::FromImage($b)
    $g.CompositingQuality=[System.Drawing.Drawing2D.CompositingQuality]::HighSpeed
    $g.InterpolationMode=[System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode=[System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.DrawImage($i,0,0,$w,$h); $g.Dispose(); $i.Dispose()
    $dest=[IO.Path]::Combine([IO.Path]::GetTempPath(),'neko-paste-'+[Guid]::NewGuid().ToString('N')+'.jpg')
    $c=[System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders()|Where-Object{$_.MimeType -eq 'image/jpeg'}
    $p=New-Object System.Drawing.Imaging.EncoderParameters(1)
    $p.Param[0]=New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality,[long]82)
    $b.Save($dest,$c,$p); $p.Dispose(); $b.Dispose()
    [Console]::Out.WriteLine($dest)
  } catch { [Console]::Out.WriteLine('-') }
}`;

function stopWindowsWorker(worker: WindowsClipboardWorker): void {
  if (windowsWorker === worker) windowsWorker = null;
  for (const request of worker.pending.splice(0)) {
    clearTimeout(request.timer);
    request.resolve(null);
  }
  try { worker.child.kill(); } catch { /* already gone */ }
}

function startWindowsWorker(): WindowsClipboardWorker {
  if (windowsWorker && windowsWorker.child.exitCode === null) return windowsWorker;
  const encoded = Buffer.from(WINDOWS_CLIPBOARD_SCRIPT, "utf16le").toString("base64");
  const child = spawn("powershell", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Sta", "-EncodedCommand", encoded], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let settleReady: (ok: boolean) => void = () => {};
  const ready = new Promise<boolean>((resolve) => { settleReady = resolve; });
  const worker: WindowsClipboardWorker = { child, ready, pending: [], buffer: "", isReady: false };
  windowsWorker = worker;
  const startupTimer = setTimeout(() => { settleReady(false); stopWindowsWorker(worker); }, 4000);
  // The worker reports recoverable clipboard misses on stdout. Drain PowerShell diagnostics so an
  // unexpected repeated warning can never fill stderr's pipe and stall a long-running TUI session.
  child.stderr.resume();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    worker.buffer += chunk;
    const lines = worker.buffer.split(/\r?\n/);
    worker.buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!worker.isReady) {
        if (line.trim() !== "ready") continue;
        worker.isReady = true;
        clearTimeout(startupTimer);
        settleReady(true);
        continue;
      }
      const request = worker.pending.shift();
      if (!request) continue;
      clearTimeout(request.timer);
      const path = line.trim();
      request.resolve(path && path !== "-" && existsSync(path) ? path : null);
    }
  });
  const fail = () => {
    clearTimeout(startupTimer);
    settleReady(false);
    stopWindowsWorker(worker);
  };
  child.once("error", fail);
  child.once("exit", fail);
  return worker;
}

/** Start the Windows clipboard worker while the user is reading the first frame. */
export function warmClipboardImageReader(): void {
  if (process.platform === "win32") void startWindowsWorker().ready;
}

/** Stop the session-owned clipboard worker; safe to call from every teardown path. */
export function disposeClipboardImageReader(): void {
  if (windowsWorker) stopWindowsWorker(windowsWorker);
}

async function readWindowsClipboardImage(edge: number): Promise<string | null> {
  const worker = startWindowsWorker();
  if (!(await worker.ready) || windowsWorker !== worker || worker.child.exitCode !== null) return null;
  return new Promise<string | null>((resolve) => {
    const request: PendingClipboardRead = {
      resolve,
      timer: setTimeout(() => { stopWindowsWorker(worker); }, 5000),
    };
    worker.pending.push(request);
    try { worker.child.stdin.write(`${edge}\n`); }
    catch { stopWindowsWorker(worker); }
  });
}

export async function readClipboardImage(maxLongEdge = 1568): Promise<string | null> {
  try {
    const edge = Math.min(4096, Math.max(512, Math.round(maxLongEdge) || 1568));
    if (process.platform === "win32") {
      // Normalize at the source: cap the longest side and encode JPEG q82. The persistent child keeps
      // PowerShell/.NET startup off this hot path; awaiting it also leaves Ink free to paint and type.
      return await readWindowsClipboardImage(edge);
    }
    const raw = join(tmpdir(), `neko-paste-${Date.now()}.png`);
    const dest = join(tmpdir(), `neko-paste-${Date.now()}.jpg`);
    if (process.platform === "darwin") {
      const copied = spawnSync("pngpaste", [raw], { encoding: "utf-8" }); // brew install pngpaste
      if (copied.status !== 0 || !existsSync(raw)) return null;
      const resized = spawnSync("sips", ["--resampleHeightWidthMax", String(edge), "--setProperty", "format", "jpeg", "--setProperty", "formatOptions", "82", raw, "--out", dest], { encoding: "utf-8" });
      try { rmSync(raw, { force: true }); } catch { /* best effort */ }
      return resized.status === 0 && existsSync(dest) ? dest : null;
    }
    spawnSync("bash", ["-c", `xclip -selection clipboard -t image/png -o > '${raw}'`], { encoding: "utf-8" });
    if (!existsSync(raw) || statSync(raw).size === 0) return null;
    const args = [raw, "-resize", `${edge}x${edge}>`, "-quality", "82", dest];
    let resized = spawnSync("magick", args, { encoding: "utf-8" });
    if (resized.status !== 0) resized = spawnSync("convert", args, { encoding: "utf-8" });
    if (resized.status === 0 && existsSync(dest)) {
      try { rmSync(raw, { force: true }); } catch { /* best effort */ }
      return dest;
    }
    return raw; // optional ImageMagick missing: the UI byte gate still refuses unsafe payloads
  } catch {
    return null;
  }
}
