/**
 * MoA value benchmark (live, not a unit test): does Mixture-of-Agents beat the aggregator model ALONE
 * on hard single-answer tasks? Runs each task through the single aggregator and through MoA (diverse
 * references + the same aggregator), grades by normalized substring match, and reports BOTH pass rates
 * + token cost. Honest by construction — it prints whatever actually happens, no assumed win.
 *
 *   bun test/moa-value-eval.ts          (needs a working NVIDIA key in ~/.neko-core/config.json)
 *
 * FINDINGS (2026-06-27, NVIDIA endpoint) — honest, not a marketing win:
 *   - exact-match, strong aggregator (gpt-oss-120b): single 8/8 == MoA 8/8, MoA ~2.5x cost (no headroom).
 *   - exact-match, weak aggregator (llama-3.1-8b) + strong advisors: 7/8 == 7/8, ~4.1x cost, and MoA
 *     even REGRESSED one task (a weak aggregator can mis-synthesize good advice).
 *   - open-ended, LLM-judged peer mixture: 2-2 even.
 *   Takeaway: MoA is implemented correctly but does NOT beat a strong single model here; its real value
 *   is pooling WEAKER/local models toward frontier quality (the paper's regime) and combining models
 *   when no single strong one is on hand. It is an OPT-IN cost/quality lever, not a free upgrade. The
 *   "Opus+GPT beats each" claim is Hermes's own HermesBench; independent here it ties.
 */
import { loadConfig, NekoConfig } from "../src/adapters/config.ts";
import { getProvider } from "../src/adapters/providers.ts";

// Scenario that EXPOSES MoA's value: a weak/cheap aggregator, lifted by strong diverse advisors.
// (A peer-level mixture where the aggregator is already strong just ties + costs more — verified
// separately with aggregator=gpt-oss-120b: single 8/8, MoA 8/8.)
const AGGREGATOR = "meta/llama-3.1-8b-instruct";
const REFERENCES = ["openai/gpt-oss-120b", "deepseek-ai/deepseek-v4-pro"];

const TASKS: { q: string; answer: string }[] = [
  { q: "How many times does the letter 'r' appear in the word 'strawberry'?", answer: "3" },
  { q: "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost, in cents?", answer: "5" },
  { q: "Next number in the sequence: 2, 6, 12, 20, 30, ___?", answer: "42" },
  { q: "A farmer has 17 sheep. All but 9 die. How many sheep are left?", answer: "9" },
  { q: "Which weighs more: a pound of feathers or a pound of bricks? Answer 'same', 'feathers', or 'bricks'.", answer: "same" },
  { q: "What is 3/4 + 1/8 as a fraction in simplest form?", answer: "7/8" },
  { q: "In the classic Monty Hall problem (3 doors, host opens a goat door), to maximize your chance should you 'switch' or 'stay'?", answer: "switch" },
  { q: "A clock shows 3:15. What is the smaller angle, in degrees, between the hour and minute hands?", answer: "7.5" },
];

const SYSTEM = "You are a careful problem solver. Think it through, then give ONLY the final answer on the last line, as briefly as possible.";

function graded(out: string, answer: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s,]/g, "");
  return norm(out).includes(norm(answer));
}

async function ask(provider: any, q: string): Promise<{ ok: boolean; out: string; tokens: number }> {
  try {
    const res = await provider.complete([{ role: "system", content: SYSTEM }, { role: "user", content: q }]);
    const out = (res.content ?? "").trim();
    return { ok: true, out, tokens: res.usage?.total_tokens ?? 0 };
  } catch (e) {
    return { ok: false, out: `ERROR: ${e instanceof Error ? e.message : String(e)}`, tokens: 0 };
  }
}

const base = loadConfig({});
const single = getProvider(new NekoConfig({ ...base.data, provider: "openai_compat", model: AGGREGATOR }, null, base.profiles, base.apiKey));
const moa = getProvider(new NekoConfig(
  { ...base.data, provider: "moa", moa: { references: REFERENCES, aggregator: AGGREGATOR, reference_temperature: 0.6, aggregator_temperature: 0.2 } },
  null, base.profiles, base.apiKey,
));

console.log(`MoA benchmark — single(${AGGREGATOR}) vs MoA(${REFERENCES.join(" + ")} -> ${AGGREGATOR})\n`);
let sPass = 0, mPass = 0, sTok = 0, mTok = 0;
for (const t of TASKS) {
  const s = await ask(single, t.q);
  const m = await ask(moa, t.q);
  const sOk = graded(s.out, t.answer);
  const mOk = graded(m.out, t.answer);
  sPass += sOk ? 1 : 0; mPass += mOk ? 1 : 0; sTok += s.tokens; mTok += m.tokens;
  const last = (x: string) => x.split("\n").pop()!.slice(0, 40);
  console.log(`[${t.answer.padEnd(6)}] single ${sOk ? "OK " : "XX "}(${last(s.out)})  |  MoA ${mOk ? "OK " : "XX "}(${last(m.out)})`);
}
console.log(`\nSINGLE: ${sPass}/${TASKS.length}  (${(sTok / 1000).toFixed(1)}k tokens)`);
console.log(`MoA   : ${mPass}/${TASKS.length}  (${(mTok / 1000).toFixed(1)}k tokens, ${(mTok / Math.max(1, sTok)).toFixed(1)}x cost)`);
console.log(mPass > sPass ? "-> MoA wins" : mPass === sPass ? "-> tie (single already strong here)" : "-> single wins (MoA didn't help on this set)");

// --- Part 2: open-ended quality, LLM-judged (MoA's actual regime per the paper) ---
// Peer-level mixture: strong-but-different advisors -> a strong aggregator, judged against the
// aggregator alone on answer quality. This is where MoA's "collective intelligence" is meant to show.
const STRONG_AGG = "openai/gpt-oss-120b";
const PEER_REFS = ["deepseek-ai/deepseek-v4-pro", "meta/llama-3.3-70b-instruct"];
const singleStrong = getProvider(new NekoConfig({ ...base.data, provider: "openai_compat", model: STRONG_AGG }, null, base.profiles, base.apiKey));
const moaPeer = getProvider(new NekoConfig({ ...base.data, provider: "moa", moa: { references: PEER_REFS, aggregator: STRONG_AGG, reference_temperature: 0.7, aggregator_temperature: 0.3 } }, null, base.profiles, base.apiKey));
const judge = getProvider(new NekoConfig({ ...base.data, provider: "openai_compat", model: "deepseek-ai/deepseek-v4-pro", temperature: 0 }, null, base.profiles, base.apiKey));

const OPEN: string[] = [
  "Explain why the sky is blue, and name one common misconception about it.",
  "Give three concrete trade-offs between SQL and NoSQL databases for a high-write workload.",
  "What are the main risks of a single global mutable variable in a multi-threaded program, and one safer alternative?",
  "Outline a concise spec for a token-bucket rate limiter: inputs, outputs, and two edge cases.",
];

console.log(`\nOpen-ended quality (LLM-judged by deepseek-v4-pro) — single(${STRONG_AGG}) vs MoA(${PEER_REFS.join(" + ")} -> ${STRONG_AGG})\n`);
let moaWins = 0, singleWins = 0, ties = 0;
for (let i = 0; i < OPEN.length; i++) {
  const q = OPEN[i];
  const a = (await ask(singleStrong, q)).out;
  const b = (await ask(moaPeer, q)).out;
  const swap = i % 2 === 1; // alternate A/B order to blunt position bias
  const [A, B] = swap ? [b, a] : [a, b];
  const verdict = (await ask(judge,
    `Question: ${q}\n\n--- Answer A ---\n${A}\n\n--- Answer B ---\n${B}\n\n` +
    `Which answer is more correct, complete, and clear? Reply with EXACTLY one token: "A", "B", or "TIE".`)).out.toUpperCase();
  const pickedMoA = (verdict.includes("A") && swap) || (verdict.includes("B") && !swap);
  const pickedSingle = (verdict.includes("A") && !swap) || (verdict.includes("B") && swap);
  if (verdict.includes("TIE") || (!pickedMoA && !pickedSingle)) { ties++; console.log(`  Q${i + 1}: TIE`); }
  else if (pickedMoA) { moaWins++; console.log(`  Q${i + 1}: MoA better`); }
  else { singleWins++; console.log(`  Q${i + 1}: single better`); }
}
console.log(`\nJUDGED: MoA ${moaWins} · single ${singleWins} · tie ${ties}  (of ${OPEN.length})`);
console.log(moaWins > singleWins ? "-> MoA wins on open-ended quality (its real regime)" : moaWins === singleWins ? "-> even on quality too" : "-> single still better");
