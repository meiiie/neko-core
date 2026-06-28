// Shared vision sub-call used by see.ts (one-shot) and ground.ts (2-pass). Sends an image + a question
// to a vision model and returns the text reply. The provider auto-converts to NVIDIA's <img> format.
import { readFileSync } from "node:fs";
import { loadConfig } from "../../../src/adapters/config.ts";
import { getProvider } from "../../../src/adapters/providers.ts";

export async function see(imagePath: string, question: string): Promise<string> {
  const lower = imagePath.toLowerCase();
  const ext = lower.endsWith(".png") ? "png" : lower.endsWith(".gif") ? "gif" : "jpeg"; // NVIDIA NIM takes png/gif/jpeg
  const b64 = readFileSync(imagePath).toString("base64");
  const model = process.env.NEKO_VISION_MODEL || "microsoft/phi-3-vision-128k-instruct";
  const cfg = loadConfig({ overrides: { model, vision: true } as any });
  const res = await getProvider(cfg).complete([
    { role: "user", content: [
      { type: "text", text: question },
      { type: "image_url", image_url: { url: `data:image/${ext};base64,${b64}` } },
    ] },
  ]);
  return res.content ?? "";
}

/** Pull the first "x,y" pixel pair out of a vision model's reply ("752,12", "x=752 y=12", "(752, 12)"). */
export function parseXY(text: string): [number, number] | null {
  const m = text.match(/(-?\d{1,5})\s*,\s*(-?\d{1,5})/) || text.match(/(\d{1,5})\D{1,6}(\d{1,5})/);
  return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}
