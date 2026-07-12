import { expect, test } from "bun:test";

import { VoiceInteractionPolicy } from "../src/adapters/voice-interaction.ts";

test("voice interaction emits at most one non-content backchannel per turn", () => {
  const policy = new VoiceInteractionPolicy();
  policy.speechStarted(1_000);

  expect(policy.speechProgress("mình đang kể một câu chuyện", 4_499)).toBeNull();
  expect(policy.speechProgress("mình đang kể một câu chuyện khá dài", 4_500)).toBe("ừm");
  expect(policy.speechProgress("và mình vẫn còn đang nói tiếp", 8_000)).toBeNull();
});

test("voice interaction enforces cooldown across turns", () => {
  const policy = new VoiceInteractionPolicy({ minSpeechMs: 100, cooldownMs: 1_000 });
  policy.speechStarted(1_000);
  expect(policy.speechProgress("đây là nội dung đủ dài để phản hồi", 1_100)).toBe("ừm");
  policy.turnCompleted();
  policy.speechStarted(1_200);
  expect(policy.speechProgress("đây là lượt tiếp theo nhưng quá gần", 1_500)).toBeNull();
  expect(policy.speechProgress("đây là lượt tiếp theo sau khoảng nghỉ", 2_100)).toBe("mình đang nghe");
});

test("voice interaction stays silent for secrets, long numbers, URLs, and questions", () => {
  const samples = [
    "mật khẩu của mình là neko voice",
    "số điện thoại của mình là 090 123 4567",
    "hãy mở https://example.com/path",
    "bạn có hiểu điều mình vừa nói không?",
  ];
  for (const sample of samples) {
    const policy = new VoiceInteractionPolicy({ minSpeechMs: 0, cooldownMs: 0, minCharacters: 1 });
    policy.speechStarted(1);
    expect(policy.speechProgress(sample, 2)).toBeNull();
  }
});
