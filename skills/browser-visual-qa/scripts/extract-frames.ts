#!/usr/bin/env bun
/**
 * Split a recorded browser video into PNG frames for vision analysis (read_file each frame, frame by
 * frame). Screenshots via browser_take_screenshot are the primary path; this is for dense timelines
 * (animations / transient bugs). Degrades clearly when ffmpeg isn't installed.
 *
 *   bun extract-frames.ts <video> [outDir=.neko-browser/frames] [fps=2]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const [video, outDir = ".neko-browser/frames", fpsArg = "2"] = process.argv.slice(2);

if (!video) {
  console.error("usage: bun extract-frames.ts <video> [outDir] [fps]");
  process.exit(2);
}
if (!existsSync(video)) {
  console.error(`no such video: ${video}`);
  process.exit(2);
}
const ffmpeg = Bun.which("ffmpeg");
if (!ffmpeg) {
  console.error("ffmpeg not found on PATH - capture states with browser_take_screenshot instead, or install ffmpeg for video frames.");
  process.exit(3);
}

mkdirSync(outDir, { recursive: true });
const fps = Math.max(0.1, Math.min(10, Number(fpsArg) || 2));
const r = spawnSync(ffmpeg, ["-i", video, "-vf", `fps=${fps}`, "-y", `${outDir}/frame-%04d.png`], { encoding: "utf-8" });
if (r.status !== 0) {
  console.error(`ffmpeg failed: ${String(r.stderr || "").slice(-300)}`);
  process.exit(1);
}
const frames = readdirSync(outDir).filter((f) => f.startsWith("frame-") && f.endsWith(".png")).sort();
console.log(`Extracted ${frames.length} frame(s) to ${resolve(outDir)} at ${fps} fps:`);
for (const f of frames.slice(0, 50)) console.log(`  ${outDir}/${f}`);
console.log("Read each with read_file (needs vision) to analyze frame by frame.");
