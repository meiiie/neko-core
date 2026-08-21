/**
 * Neko's completion sound is synthesized from a tiny deterministic score instead of shipping a
 * copied/canned asset. On Windows it is played straight from memory through winmm, so completing a
 * turn never opens a media player, writes a cache file, or starts a helper process. Other platforms
 * deliberately fall back to the terminal bell until they have an equally small native backend.
 */

const SAMPLE_RATE = 48_000;
const DURATION_SECONDS = 0.23;
const TARGET_PEAK = 0.66;
const SND_ASYNC = 0x0001;
const SND_NODEFAULT = 0x0002;
const SND_MEMORY = 0x0004;

export interface WindowsMemorySound {
  play(wav: Uint8Array): boolean;
}

export interface CompletionSoundOptions {
  platform?: NodeJS.Platform;
  loadWindowsSound?: () => Promise<WindowsMemorySound>;
}

/** The selected Neko Bubble v6 score: one short, rounded, accelerating bubble. */
export function buildNekoCompletionWav(): Buffer {
  const frames = Math.floor(SAMPLE_RATE * DURATION_SECONDS);
  const samples = new Float64Array(frames);
  let phase = 0;

  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE;
    const attack = Math.sin(Math.min(1, t / 0.016) * Math.PI / 2) ** 2;
    const decay = Math.exp(-Math.max(0, t - 0.012) / 0.055);
    const endFade = Math.sin(Math.min(1, (DURATION_SECONDS - t) / 0.022) * Math.PI / 2) ** 2;
    const envelope = attack * decay * endFade;
    const frequency = 390 + 860 * (1 - Math.exp(-t / 0.060));
    phase += 2 * Math.PI * frequency / SAMPLE_RATE;
    const bubble = Math.sin(phase + 0.045 * Math.sin(2 * Math.PI * 5.0 * t));
    const membrane = 0.035 * Math.sin(2 * phase + 0.50);
    samples[i] = envelope * (bubble + membrane);
  }

  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const gain = peak > 0 ? TARGET_PEAK / peak : 1;
  const dataBytes = frames * 4; // signed 16-bit stereo
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8);
  wav.write("fmt ", 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20); // PCM
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(SAMPLE_RATE, 24);
  wav.writeUInt32LE(SAMPLE_RATE * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(dataBytes, 40);

  let offset = 44;
  for (const value of samples) {
    const sample = Math.round(Math.max(-1, Math.min(1, value * gain)) * 32767);
    wav.writeInt16LE(sample, offset);
    wav.writeInt16LE(sample, offset + 2);
    offset += 4;
  }
  return wav;
}

async function loadWindowsMemorySound(): Promise<WindowsMemorySound> {
  const { dlopen, FFIType, ptr } = await import("bun:ffi");
  const library = dlopen("winmm.dll", {
    PlaySoundW: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
      returns: FFIType.bool,
    },
  });
  return {
    play(wav) {
      // The library and WAV both remain strongly referenced by the returned alert closure while
      // winmm owns the asynchronous playback.
      return Boolean(library.symbols.PlaySoundW(ptr(wav), 0, SND_ASYNC | SND_NODEFAULT | SND_MEMORY));
    },
  };
}

/**
 * Prepare a non-blocking native completion alert. `undefined` means the caller should use its
 * terminal-bell fallback. Playback failure is reported as `false` for the same reason.
 */
export async function prepareCompletionAlert(options: CompletionSoundOptions = {}): Promise<(() => boolean) | undefined> {
  if ((options.platform ?? process.platform) !== "win32") return undefined;
  try {
    const sound = await (options.loadWindowsSound ?? loadWindowsMemorySound)();
    const wav = buildNekoCompletionWav();
    return () => {
      try { return sound.play(wav); }
      catch { return false; }
    };
  } catch {
    return undefined;
  }
}
