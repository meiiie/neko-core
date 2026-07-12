export interface VoiceInteractionOptions {
  minSpeechMs?: number;
  cooldownMs?: number;
  minCharacters?: number;
}

const SENSITIVE_SPEECH = /(?:password|passcode|secret|token|api[ _-]?key|mat khau|mật khẩu|ma otp|mã otp|https?:\/\/|```)|(?:\d[\s.-]*){4,}/i;
const QUESTION_END = /[?？]\s*$/;

/** Small deterministic policy for non-content-bearing listener feedback. */
export class VoiceInteractionPolicy {
  private readonly minSpeechMs: number;
  private readonly cooldownMs: number;
  private readonly minCharacters: number;
  private turnStartedAt = 0;
  private lastBackchannelAt = Number.NEGATIVE_INFINITY;
  private backchannelUsed = false;
  private nextBackchannel = 0;

  constructor(options: VoiceInteractionOptions = {}) {
    this.minSpeechMs = options.minSpeechMs ?? 3_500;
    this.cooldownMs = options.cooldownMs ?? 8_000;
    this.minCharacters = options.minCharacters ?? 16;
  }

  speechStarted(now: number): void {
    this.turnStartedAt = now;
    this.backchannelUsed = false;
  }

  speechProgress(text: string, now: number): string | null {
    const normalized = text.trim();
    if (!this.turnStartedAt || this.backchannelUsed) return null;
    if (now - this.turnStartedAt < this.minSpeechMs || now - this.lastBackchannelAt < this.cooldownMs) return null;
    if (normalized.length < this.minCharacters || SENSITIVE_SPEECH.test(normalized) || QUESTION_END.test(normalized)) return null;

    const choices = ["ừm", "mình đang nghe"];
    const response = choices[this.nextBackchannel % choices.length];
    this.nextBackchannel++;
    this.backchannelUsed = true;
    this.lastBackchannelAt = now;
    return response;
  }

  turnCompleted(): void {
    this.turnStartedAt = 0;
    this.backchannelUsed = false;
  }
}
