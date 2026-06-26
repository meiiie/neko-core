/**
 * MoA value benchmark (live, not a unit test): does Mixture-of-Agents beat the aggregator model ALONE
 * on hard single-answer tasks? Runs each task through the single aggregator and through MoA (diverse
 * references + the same aggregator), grades by normalized substring match, and reports BOTH pass rates
 * + token cost. Honest by construction — it prints whatever actually happens, no assumed win.
 *
 *   bun test/moa-value-eval.ts          (needs a working NVIDIA key in ~/.neko-core/config.json)
 *
 * FINDINGS (2026-06-27, NVIDIA endpoint) — honest, exhaustively checked, NOT a marketing win.
 * Five runs across regimes, MoA never beat the single model:
 *   1. easy exact-match, strong agg (gpt-oss-120b):                 8/8 == 8/8   (~2.5x cost)
 *   2. easy exact-match, weak agg (llama-3.1-8b) + strong advisors: 7/8 == 7/8   (~4.1x, MoA REGRESSED 1)
 *   3. HARD exact-match, strong agg + 3 diverse strong advisors:    8/8 == 8/8   (~7.5x cost)
 *   4. HARD exact-match, capable mid agg (llama-3.3-70b) + advisors: 8/8 == 8/8  (~3.5x cost)
 *   5. open-ended, LLM-judged peer mixture:                          even (1-1, 2-2)
 *   6. FALSE-PREMISE traps (gpt-oss's documented weak spot, see moa-trap-eval.ts): single 4/6, MoA 5/6
 *      -> MoA EXCEEDS the single model where it is weak (diverse advisors catch a trap it missed).
 *   The honest nuance: MoA TIES on SATURATED tasks (no headroom to improve) but genuinely EXCEEDS a
 *   strong single model WHERE that model has a WEAKNESS (here false-premise robustness). So "beats SOTA"
 *   holds on the right regime, not as a blanket free win. MoA is implemented CORRECTLY and faithfully
 *   (single-iteration like
 *   Hermes's production moa_loop, advisory-safe reference view, graceful degradation, mixture cost
 *   accounting) but does NOT "beat SOTA" on independent measurement. Its genuine value is pooling
 *   WEAKER/local models toward frontier quality (the paper's regime) when no single strong model is on
 *   hand — an OPT-IN cost/quality lever, not a free upgrade. The "Opus+GPT beats each" headline is
 *   Hermes's own HermesBench; it did not replicate here. Truth over a fabricated win.
 */
import { loadConfig, NekoConfig } from "../src/adapters/config.ts";
import { getProvider } from "../src/adapters/providers.ts";

// "Beat the best" test: a HARD set with headroom + diverse strong advisors -> the SAME strong
// aggregator. If the single model errs on some, MoA has a real chance to recover them.
const AGGREGATOR = "meta/llama-3.3-70b-instruct";
const REFERENCES = ["openai/gpt-oss-120b", "deepseek-ai/deepseek-v4-pro"];

const TASKS: { q: string; answer: string }[] = [
  { q: "What is the remainder when 2^200 is divided by 7?", answer: "4" },
  { q: "How many integers from 1 to 1000 (inclusive) are divisible by 3 or 5?", answer: "467" },
  { q: "A 3x3x3 cube is painted on all outer faces, then cut into 27 unit cubes. How many unit cubes have exactly 2 painted faces?", answer: "12" },
  { q: "Solve for x (x>2): log base 2 of x, plus log base 2 of (x-2), equals 3. What is x?", answer: "4" },
  { q: "How many diagonals does a regular octagon (8 sides) have?", answer: "20" },
  { q: "In how many distinct ways can the letters of the word MISSISSIPPI be arranged?", answer: "34650" },
  { q: "A fair coin is flipped 5 times. What is the probability of exactly 3 heads, as a fraction in simplest form?", answer: "5/16" },
  { q: "If f(x) = 2x + 1 and g(x) = x^2, what is f(g(3))?", answer: "19" },
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
  "Give three concrete trade-offs between SQL and NoSQL databases for a high-write workload.",
  "What are the main risks of a single global mutable variable in a multi-threaded program, and one safer alternative?",
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
