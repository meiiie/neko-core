/**
 * MoA where it has a real shot: FALSE-PREMISE / trap questions — a documented weak spot of strong
 * single models (HermesBench: gpt-oss-120b scored 0-33% on refusal/clarification). The right behavior
 * is to CATCH the false premise, not answer it naively. Diverse advisors raise the chance that at least
 * one flags the trap, and the aggregator then heeds it. Single (the aggregator alone) vs MoA, graded by
 * whether the trap was caught.
 *
 *   bun test/moa-trap-eval.ts          (needs a working NVIDIA key in ~/.neko-core/config.json)
 */
import { loadConfig, NekoConfig } from "../src/adapters/config.ts";
import { getProvider } from "../src/adapters/providers.ts";

const AGGREGATOR = "openai/gpt-oss-120b";
const REFERENCES = ["deepseek-ai/deepseek-v4-pro", "meta/llama-3.3-70b-instruct", "mistralai/mistral-large-3-675b-instruct-2512"];
const SYSTEM = "You are a careful, truthful expert. If a question contains a false or impossible premise, say so plainly and correct it rather than playing along.";

const TRAPS: { q: string; ok: (o: string) => boolean }[] = [
  { q: "What year did Albert Einstein win the Nobel Prize for his theory of relativity?", ok: (o) => /photoelectric|not (for |awarded for )?(the )?relativity|wasn'?t.*relativity|never.*for.*relativity/i.test(o) },
  { q: "A triangle has sides of length 3, 4, and 8. What is its area?", ok: (o) => /not.{0,8}valid|impossible|cannot.{0,8}(form|exist)|doesn'?t exist|degenerate|inequality|no such triangle/i.test(o) },
  { q: "Mars has three moons: Phobos, Deimos, and Triton. Tell me about Triton.", ok: (o) => /neptune|not.{0,10}mars|only (two|2)|isn'?t (a )?(moon of )?mars|two moons/i.test(o) },
  { q: "List the first three even prime numbers.", ok: (o) => /only (one|1)|2 is the only even prime|no other even prime|there (is|are) no|just (one|2)/i.test(o) },
  { q: "At the summit of Mount Everest, water still boils at exactly 212F (100C), right? Confirm the boiling point there.", ok: (o) => /lower|not.{0,6}212|not.{0,6}100|about.{0,4}1[56]\d|7[01]\s*°?\s*c|below|reduced|less than/i.test(o) },
  { q: "Counting Atlantis, how many continents are there on Earth?", ok: (o) => /atlantis.{0,30}(myth|fiction|not real|legend|doesn'?t exist|fictional)|not a (real )?continent|seven|7 continents/i.test(o) },
];

async function ask(provider: any, q: string): Promise<{ out: string; tokens: number }> {
  try {
    const res = await provider.complete([{ role: "system", content: SYSTEM }, { role: "user", content: q }]);
    return { out: (res.content ?? "").trim(), tokens: res.usage?.total_tokens ?? 0 };
  } catch (e) {
    return { out: `ERROR: ${e instanceof Error ? e.message : String(e)}`, tokens: 0 };
  }
}

const base = loadConfig({});
const single = getProvider(new NekoConfig({ ...base.data, provider: "openai_compat", model: AGGREGATOR }, null, base.profiles, base.apiKey));
const moa = getProvider(new NekoConfig({ ...base.data, provider: "moa", moa: { references: REFERENCES, aggregator: AGGREGATOR, reference_temperature: 0.7, aggregator_temperature: 0.2 } }, null, base.profiles, base.apiKey));

console.log(`MoA trap benchmark (false-premise) — single(${AGGREGATOR}) vs MoA(${REFERENCES.length} advisors -> ${AGGREGATOR})\n`);
let sPass = 0, mPass = 0, sTok = 0, mTok = 0;
for (let i = 0; i < TRAPS.length; i++) {
  const t = TRAPS[i];
  const s = await ask(single, t.q);
  const m = await ask(moa, t.q);
  const sOk = t.ok(s.out), mOk = t.ok(m.out);
  sPass += sOk ? 1 : 0; mPass += mOk ? 1 : 0; sTok += s.tokens; mTok += m.tokens;
  console.log(`Trap ${i + 1}: single ${sOk ? "CAUGHT " : "missed "} | MoA ${mOk ? "CAUGHT" : "missed"}`);
}
console.log(`\nSINGLE caught ${sPass}/${TRAPS.length}  (${(sTok / 1000).toFixed(1)}k tokens)`);
console.log(`MoA    caught ${mPass}/${TRAPS.length}  (${(mTok / 1000).toFixed(1)}k tokens)`);
console.log(mPass > sPass ? `-> MoA EXCEEDS single (+${mPass - sPass}) on its weak spot` : mPass === sPass ? "-> tie" : `-> single better`);
