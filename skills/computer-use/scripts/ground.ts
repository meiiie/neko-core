#!/usr/bin/env bun
/**
 * SOTA 2-pass GUI grounding (ScreenSpot-Pro / iterative focus refinement). Returns PRECISE real-screen
 * "x,y" for a described target -- far tighter than a single pass on a downscaled screenshot.
 *   pass 1: rough location on a small GIF of the whole screen
 *   pass 2: crop a high-res region around the rough point, re-ask (target is now large + centred)
 * The text driver (gpt-oss) calls `bun ground.ts "<target>"`, then `mouse.ps1 click <x> <y>`.
 *
 * Usage:  bun ground.ts "<target description>" [full-screenshot.png]
 * (Capture scans clean as a simple CopyFromScreen->PNG; resize/crop are FILE ops; nothing uses the
 *  JPEG encoder that trips antivirus. Vision model: $NEKO_VISION_MODEL, default phi-3-vision.)
 */
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { see, parseXY } from "./vision.ts";

function ps(script: string): string {
  const r = spawnSync("powershell", ["-NoProfile", "-Command", script], { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
  if (r.status !== 0) throw new Error("powershell failed: " + ((r.stderr || r.stdout || "").trim().slice(0, 300)));
  return (r.stdout || "").trim();
}

/** Ask the vision model for a pixel location, retrying once with a stricter format (replies vary). */
async function locate(image: string, q: string): Promise<[number, number] | null> {
  for (const prompt of [q, `${q}\nRespond with EXACTLY two integers: x,y -- comma-separated, nothing else.`]) {
    const xy = parseXY(await see(image, prompt));
    if (xy) return xy;
  }
  return null;
}

const target = process.argv[2];
if (!target) { console.error('usage: bun ground.ts "<target description>" [full-screenshot.png]'); process.exit(1); }

const VIEW = 768;          // pass-1 downscale width
const CW = 480, CH = 360;  // zoom-crop size in full-res pixels
const full = process.argv[3] || join(tmpdir(), "_ground_full.png");
const fullGif = join(tmpdir(), "_ground_full.gif");
const cropGif = join(tmpdir(), "_ground_crop.gif");

// 1. Full screen -> PNG (simple capture scans clean) + report screen WxH.
const dims = process.argv[3]
  ? ps(`Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile('${full}'); Write-Output ("$($i.Width) $($i.Height)"); $i.Dispose()`)
  : ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $b=New-Object System.Drawing.Bitmap $s.Width,$s.Height; ([System.Drawing.Graphics]::FromImage($b)).CopyFromScreen(0,0,0,0,$b.Size); $b.Save('${full}'); $b.Dispose(); Write-Output ("$($s.Width) $($s.Height)")`);
const [SW, SH] = dims.split(/\s+/).map(Number);

// 2. Downscale -> small GIF for the rough pass.
ps(`Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile('${full}'); $w=${VIEW}; $h=[int]($i.Height*$w/$i.Width); $b=New-Object System.Drawing.Bitmap $w,$h; ([System.Drawing.Graphics]::FromImage($b)).DrawImage($i,0,0,$w,$h); $b.Save('${fullGif}',[System.Drawing.Imaging.ImageFormat]::Gif); $i.Dispose(); $b.Dispose()`);

// 3. Pass 1 — rough.
const r1 = await locate(fullGif, `Reply with ONLY two numbers "x,y": the pixel location of ${target}. The image is ${VIEW} pixels wide.`);
if (!r1) { console.error("pass1: could not parse coordinates from the vision reply"); process.exit(2); }
const scale1 = VIEW / SW;
const rx = Math.round(r1[0] / scale1), ry = Math.round(r1[1] / scale1);
console.error(`[ground] pass1 rough -> ${rx},${ry} (real)`);

// 4. Crop a high-res region around the rough point (clamped).
const ox = Math.max(0, Math.min(SW - CW, rx - Math.round(CW / 2)));
const oy = Math.max(0, Math.min(SH - CH, ry - Math.round(CH / 2)));
ps(`Add-Type -AssemblyName System.Drawing; $i=[System.Drawing.Image]::FromFile('${full}'); $b=New-Object System.Drawing.Bitmap ${CW},${CH}; $g=[System.Drawing.Graphics]::FromImage($b); $dst=New-Object System.Drawing.Rectangle 0,0,${CW},${CH}; $src=New-Object System.Drawing.Rectangle ${ox},${oy},${CW},${CH}; $g.DrawImage($i,$dst,$src,[System.Drawing.GraphicsUnit]::Pixel); $b.Save('${cropGif}',[System.Drawing.Imaging.ImageFormat]::Gif); $i.Dispose(); $b.Dispose()`);

// 5. Pass 2 — precise (crop is full-res, so coords are real crop pixels).
const r2 = await locate(cropGif, `Reply with ONLY two numbers "x,y": the pixel location of ${target} in this ${CW}x${CH} image.`);
if (!r2) { console.log(`${rx},${ry}`); process.exit(0); } // fall back to the rough point

// 6. Map crop-local -> real screen.
console.log(`${ox + r2[0]},${oy + r2[1]}`);
