#!/usr/bin/env bun
/**
 * Vision sub-call for computer-use: send an image + a question to a vision model and print the answer.
 * The text-only driver (e.g. gpt-oss, which tool-calls but can't see) calls this via `bash` to "see" a
 * screenshot and get grounded coordinates. Uses the configured provider/key; the provider auto-converts
 * the image to the NVIDIA <img> format. Vision model: $NEKO_VISION_MODEL, else a sane NVIDIA default.
 *
 * Usage:  bun see.ts <image-path> [question...]
 *   bun see.ts screen.jpg "Give ONLY x,y of the Start button. Image is 1024 wide."
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../../../src/adapters/config.ts";
import { getProvider } from "../../../src/adapters/providers.ts";

const [imagePath, ...rest] = process.argv.slice(2);
if (!imagePath) {
  console.error('usage: bun see.ts <image-path> ["question"]');
  process.exit(1);
}
const question =
  rest.join(" ").trim() ||
  "Describe this screen. List each visible UI element (windows, buttons, fields, icons, text) with its approximate pixel coordinates x,y.";
const model = process.env.NEKO_VISION_MODEL || "microsoft/phi-3-vision-128k-instruct";
const ext = imagePath.toLowerCase().endsWith(".png") ? "png" : "jpeg";
const b64 = readFileSync(imagePath).toString("base64");
const cfg = loadConfig({ overrides: { model, vision: true } as any });
const res = await getProvider(cfg).complete([
  { role: "user", content: [
    { type: "text", text: question },
    { type: "image_url", image_url: { url: `data:image/${ext};base64,${b64}` } },
  ] },
]);
console.log(res.content ?? "(no answer)");
