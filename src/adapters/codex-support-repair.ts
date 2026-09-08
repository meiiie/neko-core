import { throwIfAborted } from "../shared/abort.ts";
import { discoverCodexSupport, compareCodexVersions } from "./codex-app-server.ts";
import { installCodexSupportPack, readCodexSupportPack, type InstallCodexSupportOptions } from "./codex-support-pack.ts";
import { chatGptMinimumCodexVersion, needsCodexTransport, resolveChatGptModelInfo } from "./chatgpt-provider.ts";
import type { NekoConfig } from "./config.ts";

export async function prepareChatGptRequest(cfg: NekoConfig, signal: AbortSignal, notify: (message: string) => void): Promise<void> {
  if (cfg.provider !== "chatgpt") return;
  const info = await resolveChatGptModelInfo(cfg, signal);
  if (!needsCodexTransport(cfg.model, info)) return;
  await prepareCodexSupport({ home: cfg.resolvedHome, minimumVersion: chatGptMinimumCodexVersion(cfg.model, info), signal, notify });
}

export async function prepareCodexSupport(options: InstallCodexSupportOptions, discover = discoverCodexSupport): Promise<void> {
  throwIfAborted(options.signal);
  const status = discover({ home: options.home });
  if (status.state === "ready" && status.executable
    && compareCodexVersions(status.executable.version ?? "0.0.0", options.minimumVersion ?? "0.0.0") >= 0) return;
  if (!readCodexSupportPack(options.home)) {
    throw new Error("ChatGPT needs a one-time setup. Select this model in /model and choose Set up ChatGPT; your sign-in is kept.");
  }
  options.notify?.("Repairing ChatGPT automatically. Your request is kept; Esc cancels.");
  try {
    await installCodexSupportPack({ ...options, force: false, repairOnly: true });
    throwIfAborted(options.signal);
  } catch (error) {
    throwIfAborted(options.signal);
    throw new Error("Could not prepare ChatGPT yet. Your request and sign-in are kept. Please try again when your connection is ready, or use /feedback.", { cause: error });
  }
}
