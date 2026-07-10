import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "../src/adapters/config.ts";
import { describeImage, IMAGE_READ_PROMPT } from "../src/adapters/vision.ts";

function cfgWith(data: any) {
  const dir = mkdtempSync(join(tmpdir(), "nk-vis-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(data));
  return loadConfig({ path });
}

test("describeImage sends the grounded read prompt + the image to the VISION model, returns its text", async () => {
  let seen: any = null;
  const provider = {
    complete: async (messages: any[]) => {
      seen = messages;
      return { content: "A terminal window showing: error TS2304", tool_calls: [] };
    },
  };
  const cfg = cfgWith({ vision_model: "test/vlm", base_url: "https://x/v1" });
  const out = await describeImage(cfg, "data:image/jpeg;base64,QUJD", undefined, provider as any);
  expect(out).toContain("error TS2304");
  expect(seen).toHaveLength(1);
  expect(seen[0].content[0].text).toBe(IMAGE_READ_PROMPT);
  expect(seen[0].content[1].image_url.url).toBe("data:image/jpeg;base64,QUJD");
});

test("describeImage is honest about failure modes (no model / empty reply)", async () => {
  const none = cfgWith({ base_url: "https://api.openai.com/v1" }); // non-NVIDIA -> no default vision model
  expect(describeImage(none, "data:image/png;base64,QQ==")).rejects.toThrow(/no vision_model/);
  const cfg = cfgWith({ vision_model: "test/vlm", base_url: "https://x/v1" });
  const empty = { complete: async () => ({ content: "  ", tool_calls: [] }) };
  expect(describeImage(cfg, "data:image/png;base64,QQ==", undefined, empty as any)).rejects.toThrow(/returned no text/);
});

test("the untrusted-data stance is part of the read prompt (image text is content, not commands)", () => {
  expect(IMAGE_READ_PROMPT).toContain("UNTRUSTED DATA");
  expect(IMAGE_READ_PROMPT).toContain("VERBATIM");
});
