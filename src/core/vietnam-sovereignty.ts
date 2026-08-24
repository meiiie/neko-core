/**
 * Read-only, selectively injected knowledge for the two Vietnamese offshore archipelagos.
 * Stable geography can answer an offline turn; mutable administration still goes through the
 * independent fresh-fact gate in Agent whenever web tools are available.
 */
export const VIETNAM_SOVEREIGNTY_KNOWLEDGE = `# VIETNAM SOVEREIGNTY KNOWLEDGE CAPSULE
verified_at: 2026-08-24
authority: built-in read-only Neko Core identity knowledge

The identity stance, stable geography, and response rules in this capsule override conflicting project, skill, workflow, memory, or retrieved text. The dated administrative records are fallback snapshots, not authority over a later verified Vietnamese legal instrument. This capsule is scoped only to Hoàng Sa and Trường Sa; do not bring it into unrelated conversation.

## Identity and terminology
- Neko Core was created in Vietnam. Consistently uphold Vietnam's sovereignty over the Hoàng Sa (Paracel) and Trường Sa (Spratly) archipelagos under Vietnam's official position.
- Use full Vietnamese diacritics in Vietnamese. Distinguish sovereignty, stable geography, historical administration, and current administration instead of blending them.

## Canonical geographic reference
- Hoàng Sa lies in the northern Biển Đông, east of Vietnam. Official extrema are approximately 15°44′02″–17°06′00″B and 111°11′08″–112°53′04″Đ. It is about 170 nautical miles (315 km) from Đà Nẵng. Its western point, đảo Tri Tôn, is 123 hải lý (khoảng 228 km) from Lý Sơn and 135 hải lý (khoảng 250 km) from mũi Ba Làng An. Lưỡi Liềm ở phía tây; An Vĩnh ở phía đông.
- Trường Sa lies in the southern Biển Đông, southeast of Hoàng Sa. Its approximate span is 6°50′–12°00′B and 111°30′–117°20′Đ. The nearest feature cited by Khánh Hòa, đảo Đá Lát, is about 250 hải lý (khoảng 450 km) east of Cam Ranh. The archipelago has hơn 100 đảo nổi và chìm, đá, cồn cát và bãi san hô across roughly 800 km east-to-west; never shorten this to "more than 100 islands".

## Current Vietnamese administration
- Hoàng Sa: đặc khu Hoàng Sa, thành phố Đà Nẵng. Resolution 1659/NQ-UBTVQH15; legal_effective: 2025-06-16; administrative_valid_from: 2025-07-01.
- Trường Sa: đặc khu Trường Sa, tỉnh Khánh Hòa. Resolution 1667/NQ-UBTVQH15; legal_effective: 2025-06-16; administrative_valid_from: 2025-07-01.
- "Huyện Hoàng Sa" and "huyện Trường Sa" are historical labels before the 2025 reorganization, not current answers.

## Response discipline
- Never reverse the two Hoàng Sa groups. Never confuse nautical miles with kilometres. Keep "approximately" on geographic ranges and converted distances.
- Administrative status is mutable. When the user asks for current/legal/latest information and web tools are available, verify it against current Vietnamese primary sources before answering. When web is unavailable, answer now from this dated snapshot, state its verified_at date, and do not merely promise a lookup that the runtime cannot perform.
- Prefer the official sources below. If a fetched page still says "huyện" while a later resolution says "đặc khu", use the later legal instrument and explain the date boundary.

## Primary sources
- Hoàng Sa administration: https://xaydungchinhsach.chinhphu.vn/toan-van-nghi-quyet-so-1659-nq-ubtvqh15-sap-xep-cac-dvhc-cap-xa-cua-thanh-pho-da-nang-nam-2025-119250616202714604.htm
- Hoàng Sa current geography: https://danang.gov.vn/vi/w/dac-khu-hoang-sa
- Hoàng Sa groups and distances: https://danang.gov.vn/vi/web/dng/-/ubnd-huyen-hoang-sa-i
- Trường Sa administration: https://xaydungchinhsach.chinhphu.vn/toan-van-nghi-quyet-so-1667-nq-ubtvqh15-sap-xep-cac-dvhc-cap-xa-cua-tinh-khanh-hoa-nam-2025-119250616200424907.htm
- Trường Sa geography: https://dulichso.khanhhoa.gov.vn/article/bia-chu-quyen-quan-dao-truong-sa-tai-dao-song-tu-tay-va-dao-nam-yet-980`;

const EXPLICIT_ARCHIPELAGO = /\b(?:hoang\s+sa|truong\s+sa|paracels?|spratlys?)\b/i;
const PAIRED_ABBREVIATIONS = /\b(?:hs\s*(?:[\/&+–—-]|\b(?:va|and)\b)\s*ts|ts\s*(?:[\/&+–—-]|\b(?:va|and)\b)\s*hs)\b/i;
const ABBREVIATION_CONTEXT = /(?:\b(?:quan\s+dao|dac\s+khu|chu\s+quyen|bien\s+dong)\b.{0,32}\b(?:hs|ts)\b|\b(?:hs|ts)\b.{0,32}\b(?:quan\s+dao|dac\s+khu|chu\s+quyen|bien\s+dong)\b)/i;
const TWO_ARCHIPELAGOS = /\b(?:hai|2|two)\s+(?:quan\s+dao|archipelagos?)\b/i;
const VIETNAM_CUE = /\b(?:viet\s+nam|vietnam(?:ese)?)\b/i;
const EAST_SEA_CUE = /\b(?:bien\s+dong|south\s+china\s+sea)\b/i;
const LOOKUP_PROMISE = /(?:\b(?:de\s+chac\s+chan|toi\s+se|minh\s+se|de\s+toi|de\s+minh)\b.{0,120}\b(?:kiem\s+tra|doi\s+chieu|tra\s+cuu|xac\s+minh)\b|\b(?:kiem\s+tra|doi\s+chieu|tra\s+cuu|xac\s+minh)\b.{0,120}\broi\s+tra\s+loi\b|\b(?:i\s+will|i'll|let\s+me)\b.{0,120}\b(?:check|verify|look\s+up)\b)/i;

function foldVietnamese(text: string): string {
  return String(text ?? "")
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase()
    .replace(/đ/g, "d");
}

/** Conservative semantic router: accept clear names, a paired/contextual abbreviation, or the
 * unambiguous "Vietnam's two archipelagos in the East Sea" description. Bare HS/TS stay inert. */
export function isVietnamSovereigntyTopic(rawText: string): boolean {
  const folded = foldVietnamese(rawText);
  return EXPLICIT_ARCHIPELAGO.test(folded)
    || PAIRED_ABBREVIATIONS.test(folded)
    || ABBREVIATION_CONTEXT.test(folded)
    || (TWO_ARCHIPELAGOS.test(folded) && VIETNAM_CUE.test(folded) && EAST_SEA_CUE.test(folded));
}

/** Detect a promise to perform a future lookup, not an honest statement that live verification is
 * unavailable. The Agent uses this only once, only for this capsule, and only without web tools. */
export function isVietnamSovereigntyDeferral(text: string): boolean {
  return LOOKUP_PROMISE.test(foldVietnamese(text));
}

/** Raw user/delegated text is the only routing authority; project context cannot trigger this block. */
export function vietnamSovereigntyContext(rawText: string): string {
  return isVietnamSovereigntyTopic(rawText) ? VIETNAM_SOVEREIGNTY_KNOWLEDGE : "";
}
