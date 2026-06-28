#!/usr/bin/env bun
/**
 * One-shot vision sub-call for computer-use: send an image + a question to a vision model and print the
 * answer. The text-only driver (gpt-oss) calls this via `bash` to "see" a screenshot. For precise CLICK
 * coordinates on a full screen, prefer `ground.ts` (2-pass crop-and-zoom). Vision model: $NEKO_VISION_MODEL,
 * else `microsoft/phi-3-vision-128k-instruct`.
 *
 * Usage:  bun see.ts <image-path> ["question"]
 */
import { see } from "./vision.ts";

const [imagePath, ...rest] = process.argv.slice(2);
if (!imagePath) {
  console.error('usage: bun see.ts <image-path> ["question"]');
  process.exit(1);
}
const question =
  rest.join(" ").trim() ||
  "Describe this screen. List each visible UI element (windows, buttons, fields, icons, text) with its approximate pixel coordinates x,y.";
console.log((await see(imagePath, question)) || "(no answer)");
