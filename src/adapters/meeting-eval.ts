/** Reproducible, model-independent ASR evaluation. Scores user-owned/reference corpora without uploading them. */
export interface MeetingEvalCase {
  id: string;
  reference: string;
  hypothesis: string;
  audioDurationMs?: number;
  processingMs?: number;
  referenceSources?: string[];
  hypothesisSources?: string[];
}

export interface MeetingEvalCaseResult {
  id: string;
  words: number;
  wordErrors: number;
  wer: number;
  characters: number;
  characterErrors: number;
  cer: number;
  rtf?: number;
  sourceAccuracy?: number;
}

export interface MeetingEvalReport {
  schemaVersion: 1;
  cases: MeetingEvalCaseResult[];
  totals: {
    cases: number;
    words: number;
    wordErrors: number;
    wer: number;
    characters: number;
    characterErrors: number;
    cer: number;
    audioDurationMs?: number;
    processingMs?: number;
    rtf?: number;
    sourceLabels?: number;
    sourceCorrect?: number;
    sourceAccuracy?: number;
  };
}

export function evaluateMeetingAsr(input: unknown): MeetingEvalReport {
  if (!Array.isArray(input) || input.length < 1 || input.length > 10_000) throw new Error("meeting eval requires an array of 1 to 10000 cases");
  const seen = new Set<string>();
  const cases: MeetingEvalCaseResult[] = [];
  let words = 0, wordErrors = 0, characters = 0, characterErrors = 0;
  let audioDurationMs = 0, processingMs = 0, timingCases = 0;
  let sourceLabels = 0, sourceCorrect = 0;
  for (const [index, raw] of input.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`meeting eval case ${index + 1} must be an object`);
    const value = raw as Record<string, unknown>;
    const id = String(value.id ?? `case-${index + 1}`).trim().slice(0, 200);
    if (!id || seen.has(id)) throw new Error(`meeting eval case id is missing or duplicated: ${id || index + 1}`);
    seen.add(id);
    const reference = boundedText(value.reference, "reference");
    const hypothesis = boundedText(value.hypothesis, "hypothesis");
    const referenceWords = normalizeWords(reference);
    const hypothesisWords = normalizeWords(hypothesis);
    const referenceChars = normalizeCharacters(reference);
    const hypothesisChars = normalizeCharacters(hypothesis);
    const caseWordErrors = editDistance(referenceWords, hypothesisWords);
    const caseCharacterErrors = editDistance(referenceChars, hypothesisChars);
    const result: MeetingEvalCaseResult = {
      id,
      words: referenceWords.length,
      wordErrors: caseWordErrors,
      wer: ratio(caseWordErrors, referenceWords.length),
      characters: referenceChars.length,
      characterErrors: caseCharacterErrors,
      cer: ratio(caseCharacterErrors, referenceChars.length),
    };
    words += referenceWords.length;
    wordErrors += caseWordErrors;
    characters += referenceChars.length;
    characterErrors += caseCharacterErrors;

    const audio = optionalPositive(value.audioDurationMs, "audioDurationMs");
    const processing = optionalPositive(value.processingMs, "processingMs", true);
    if (audio != null && processing != null) {
      result.rtf = processing / audio;
      audioDurationMs += audio;
      processingMs += processing;
      timingCases++;
    }
    if (value.referenceSources != null || value.hypothesisSources != null) {
      if (!Array.isArray(value.referenceSources) || !Array.isArray(value.hypothesisSources)) throw new Error(`meeting eval case ${id} source labels must be arrays`);
      const expected = value.referenceSources.map(normalizeSource);
      const actual = value.hypothesisSources.map(normalizeSource);
      if (!expected.length) throw new Error(`meeting eval case ${id} has no reference source labels`);
      const compared = Math.max(expected.length, actual.length);
      let correct = 0;
      for (let i = 0; i < compared; i++) if (actual[i] === expected[i]) correct++;
      result.sourceAccuracy = correct / compared;
      sourceLabels += compared;
      sourceCorrect += correct;
    }
    cases.push(result);
  }
  return {
    schemaVersion: 1,
    cases,
    totals: {
      cases: cases.length,
      words,
      wordErrors,
      wer: ratio(wordErrors, words),
      characters,
      characterErrors,
      cer: ratio(characterErrors, characters),
      ...(timingCases ? { audioDurationMs, processingMs, rtf: processingMs / audioDurationMs } : {}),
      ...(sourceLabels ? { sourceLabels, sourceCorrect, sourceAccuracy: sourceCorrect / sourceLabels } : {}),
    },
  };
}

export function renderMeetingEval(report: MeetingEvalReport): string {
  const percent = (value: number) => `${(value * 100).toFixed(2)}%`;
  const lines = [
    `Meeting ASR eval: ${report.totals.cases} case(s)`,
    `WER ${percent(report.totals.wer)} (${report.totals.wordErrors}/${report.totals.words} word edits)`,
    `CER ${percent(report.totals.cer)} (${report.totals.characterErrors}/${report.totals.characters} character edits)`,
  ];
  if (report.totals.rtf != null) lines.push(`RTF ${report.totals.rtf.toFixed(3)} (${Math.round(report.totals.processingMs!)} ms / ${Math.round(report.totals.audioDurationMs!)} ms audio)`);
  if (report.totals.sourceAccuracy != null) lines.push(`Channel-source accuracy ${percent(report.totals.sourceAccuracy)} (${report.totals.sourceCorrect}/${report.totals.sourceLabels})`);
  lines.push("WER/CER compare only supplied references. They do not prove speaker identity, semantic summary quality, or SOTA status.");
  return lines.join("\n");
}

function normalizeWords(value: string): string[] {
  return normalize(value).split(/\s+/).filter(Boolean);
}

function normalizeCharacters(value: string): string[] {
  return Array.from(normalize(value).replace(/\s+/g, ""));
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("vi").replace(/[\p{P}\p{S}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function editDistance<T>(left: T[], right: T[]): number {
  if (left.length > right.length) return editDistance(right, left);
  let previous = Array.from({ length: left.length + 1 }, (_, index) => index);
  for (let r = 1; r <= right.length; r++) {
    const current = [r];
    for (let l = 1; l <= left.length; l++) {
      current[l] = left[l - 1] === right[r - 1]
        ? previous[l - 1]
        : 1 + Math.min(previous[l - 1], previous[l], current[l - 1]);
    }
    previous = current;
  }
  return previous[left.length];
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length > 2_000_000) throw new Error(`meeting eval ${label} must be a string up to 2000000 characters`);
  return value;
}

function optionalPositive(value: unknown, label: string, zeroAllowed = false): number | undefined {
  if (value == null) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < (zeroAllowed ? 0 : Number.EPSILON)) throw new Error(`meeting eval ${label} must be a positive finite number`);
  return number;
}

function normalizeSource(value: unknown): string {
  const source = String(value ?? "").trim().toLowerCase();
  if (!new Set(["microphone", "system", "unknown"]).has(source)) throw new Error(`invalid meeting source label: ${source || "missing"}`);
  return source;
}

function ratio(errors: number, reference: number): number {
  return reference ? errors / reference : errors ? 1 : 0;
}
