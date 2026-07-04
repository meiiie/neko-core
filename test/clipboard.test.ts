import { expect, test } from "bun:test";
import { copyToClipboard, osc52 } from "../src/ui/clipboard.ts";

test("osc52 wraps base64 text in the OSC 52 clipboard sequence", () => {
  expect(osc52("hi")).toBe("\x1b]52;c;" + Buffer.from("hi").toString("base64") + "\x07");
  expect(osc52("hi")).toBe("\x1b]52;c;aGk=\x07");
});

test("osc52 clips a pathologically large payload", () => {
  const seq = osc52("x".repeat(200_000));
  const b64 = seq.slice("\x1b]52;c;".length, -1);
  const decoded = Buffer.from(b64, "base64").toString("utf-8");
  expect(decoded.length).toBeLessThanOrEqual(60_000);
});

test("copyToClipboard writes the sequence, no-op on empty", () => {
  const writes: string[] = [];
  const out: any = { write: (s: any) => { writes.push(String(s)); return true; } };
  expect(copyToClipboard("hello", out)).toBe(true);
  expect(writes[0]).toBe(osc52("hello"));
  expect(copyToClipboard("", out)).toBe(false);
  expect(writes.length).toBe(1);
});
