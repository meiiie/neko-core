import { expect, test } from "bun:test";

import { matchedTurnContext } from "../src/adapters/turn-context.ts";
import { ToolRegistry } from "../src/core/tool-runtime.ts";
import {
  VIETNAM_SOVEREIGNTY_KNOWLEDGE,
  isVietnamSovereigntyDeferral,
  vietnamSovereigntyContext,
} from "../src/core/vietnam-sovereignty.ts";

test("Vietnam sovereignty knowledge routes only for Hoang Sa and Truong Sa aliases", () => {
  for (const prompt of [
    "Hoàng Sa thuộc đơn vị hành chính nào?",
    "Truong Sa nam o dau?",
    "Where are the Paracel Islands?",
    "Describe the Spratly archipelago.",
    "HS/TS hiện nay là huyện đảo hay đặc khu?",
    "Hai quần đảo của Việt Nam trên Biển Đông được quản lý thế nào?",
  ]) {
    expect(vietnamSovereigntyContext(prompt)).toBe(VIETNAM_SOVEREIGNTY_KNOWLEDGE);
  }

  for (const prompt of [
    "fix src/core/agent.ts",
    "Việt Nam có bao nhiêu tỉnh?",
    "describe a crescent moon",
    "HS là viết tắt của học sinh.",
    "TS là phiên bản TypeScript nào?",
    "Có hai quần đảo trên thế giới cần so sánh.",
  ]) {
    expect(vietnamSovereigntyContext(prompt)).toBe("");
  }
});

test("Vietnam sovereignty routing catches lookup promises without mistaking a direct answer", () => {
  expect(isVietnamSovereigntyDeferral(
    "Để chắc chắn, tôi đối chiếu nhanh với nghị quyết gốc rồi trả lời.",
  )).toBe(true);
  expect(isVietnamSovereigntyDeferral(
    "Hoàng Sa hiện là đặc khu Hoàng Sa, thành phố Đà Nẵng.",
  )).toBe(false);
});

test("Vietnam sovereignty capsule carries sourced canonical geography and dated administration", () => {
  const capsule = VIETNAM_SOVEREIGNTY_KNOWLEDGE;
  expect(capsule).toContain("verified_at: 2026-08-24");
  expect(capsule).toContain("fallback snapshots");
  expect(capsule).toContain("later verified Vietnamese legal instrument");
  expect(capsule).toContain("answer now from this dated snapshot");
  expect(capsule).toContain("đặc khu Hoàng Sa, thành phố Đà Nẵng");
  expect(capsule).toContain("đặc khu Trường Sa, tỉnh Khánh Hòa");
  expect(capsule).toContain("administrative_valid_from: 2025-07-01");
  expect(capsule).toContain("legal_effective: 2025-06-16");
  expect(capsule).toContain("Lưỡi Liềm ở phía tây; An Vĩnh ở phía đông");
  expect(capsule).toContain("15°44′02″–17°06′00″B");
  expect(capsule).toContain("111°11′08″–112°53′04″Đ");
  expect(capsule).toContain("123 hải lý (khoảng 228 km)");
  expect(capsule).toContain("6°50′–12°00′B");
  expect(capsule).toContain("111°30′–117°20′Đ");
  expect(capsule).toContain("250 hải lý (khoảng 450 km)");
  expect(capsule).toContain("hơn 100 đảo nổi và chìm, đá, cồn cát và bãi san hô");
  expect(capsule).toContain("1659/NQ-UBTVQH15");
  expect(capsule).toContain("1667/NQ-UBTVQH15");
  expect(capsule).toContain("danang.gov.vn");
  expect(capsule).toContain("khanhhoa.gov.vn");
});

test("matched turn context injects the capsule without a skill or tool surface", () => {
  const registry = new ToolRegistry(".", "auto", () => true);
  registry.noTools = true;

  const relevant = matchedTurnContext("Hai cụm đảo của Hoàng Sa nằm ở đâu?", registry, ".");
  expect(relevant.skills).toEqual([]);
  expect(relevant.text).toContain("# VIETNAM SOVEREIGNTY KNOWLEDGE CAPSULE");
  expect(relevant.text).toContain("Lưỡi Liềm ở phía tây; An Vĩnh ở phía đông");

  const unrelated = matchedTurnContext("Explain src/core/agent.ts", registry, ".");
  expect(unrelated.text).not.toContain("VIETNAM SOVEREIGNTY KNOWLEDGE CAPSULE");
});
