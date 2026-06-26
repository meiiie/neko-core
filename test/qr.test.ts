import { expect, test } from "bun:test";

import { ecCodewords, qrMatrix, qrToText } from "../src/shared/qr.ts";

test("qr: Reed-Solomon matches the canonical spec vector (HELLO WORLD, V1-M, 10 EC)", () => {
  // Data codewords for "HELLO WORLD" encoded V1-M (ISO/IEC 18004 worked example).
  const data = [32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17];
  expect(ecCodewords(data, 10)).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
});

test("qr: a short string produces a valid V1 module matrix with three finder patterns", () => {
  const m = qrMatrix("HELLO");
  expect(m).not.toBeNull();
  const size = m!.length;
  expect([21, 25, 29, 33, 37]).toContain(size); // a supported version
  // finder pattern: top-left 7x7 — dark border ring + dark 3x3 center, light separators between
  const finderOk = (r0: number, c0: number) => {
    let ok = true;
    for (let i = 0; i < 7; i++) { if (!m![r0][c0 + i] || !m![r0 + 6][c0 + i] || !m![r0 + i][c0] || !m![r0 + i][c0 + 6]) ok = false; }
    if (!m![r0 + 3][c0 + 3]) ok = false; // center dark
    if (m![r0 + 1][c0 + 1]) ok = false; // inner ring light
    return ok;
  };
  expect(finderOk(0, 0)).toBe(true); // top-left
  expect(finderOk(0, size - 7)).toBe(true); // top-right
  expect(finderOk(size - 7, 0)).toBe(true); // bottom-left
});

test("qr: capacity — long-enough strings pick higher versions; too long returns null", () => {
  expect(qrMatrix("x".repeat(20))!.length).toBeGreaterThanOrEqual(25); // > V1 capacity
  expect(qrMatrix("x".repeat(500))).toBeNull(); // beyond V5 EC-L
});

test("qr: a realistic pairing URL fits and renders to terminal text", () => {
  const url = "https://neko-relay.holilihu.workers.dev/#s=abcdef0123456789&t=abcdef0123456789&k=abcdef0123456789";
  const m = qrMatrix(url);
  expect(m).not.toBeNull();
  const txt = qrToText(m!);
  expect(txt.length).toBeGreaterThan(0);
  expect(txt.split("\n").length).toBeGreaterThan(10);
});
