/**
 * Image generation over the ChatGPT subscription, through the official local Codex App Server.
 *
 * Why this route (research: docs/research/imagegen-chatgpt-2026-07-28.md): a ChatGPT Plus/Pro plan
 * carries NO OpenAI API quota, and wrapping chatgpt.com's private backend violates the Terms. The
 * one published, subscription-backed surface a terminal client may drive is Codex - its app-server
 * exposes a real image tool (capability flag `imageGeneration`; results arrive as
 * `item/completed` with an `imageGeneration` thread item carrying base64 + a saved path), billed
 * against the plan's Codex usage. So Neko starts a short-lived thread, asks for the picture, and
 * copies the result where the user asked. No API key, no cookies, no silent paid fallback.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import { type JsonValue } from "../shared/wire.ts";
import { validChatGptCredentials, hasChatGptCredentials } from "./chatgpt-auth.ts";
import { discoverCodexSupport, startCodexAppServer, type CodexAppServerHandlers } from "./codex-app-server.ts";

interface RpcClient {
  initialize(timeoutMs?: number): Promise<JsonValue>;
  /** Outgoing params are call-site payloads; they must be JSON-serializable. */
  request(method: string, params?: any, timeoutMs?: number): Promise<any>;
  close(): void;
}

export type ImageClientFactory = (handlers: CodexAppServerHandlers) => RpcClient;

export interface ImageGenResult {
  path: string;
  revisedPrompt?: string;
}

/** Is the subscription image route available on this machine? (No network probe - binary + login.) */
export function imageGenerationAvailable(): { ok: boolean; detail: string } {
  const support = discoverCodexSupport();
  if (support.state !== "ready" || !support.executable) {
    return { ok: false, detail: `image_gen needs the Codex support component (${support.detail}). Install Codex CLI >= 0.144.0 or the Neko GPT-5.6 Support Pack.` };
  }
  if (!hasChatGptCredentials()) {
    return { ok: false, detail: "image_gen uses the ChatGPT subscription - type /login to connect ChatGPT first (no API billing)." };
  }
  return { ok: true, detail: "codex app-server + ChatGPT login" };
}

function defaultFactory(handlers: CodexAppServerHandlers): RpcClient {
  const support = discoverCodexSupport();
  if (support.state !== "ready" || !support.executable) throw new Error(imageGenerationAvailable().detail);
  return startCodexAppServer(support.executable, handlers, { allowImageGeneration: true });
}

/**
 * Generate one image and save it under `root`. A dedicated ephemeral thread per call: image turns
 * are rare and expensive (the Codex rate card burns included usage ~3-5x faster than a text turn),
 * so a stray thread must never linger. Capability is read FIRST and the call fails closed with an
 * honest message when the account/model cannot generate images.
 */
export async function generateImage(
  root: string,
  prompt: string,
  outPath?: string,
  clientFactory: ImageClientFactory = defaultFactory,
  timeoutMs = 300_000,
): Promise<ImageGenResult> {
  if (!prompt.trim()) throw new Error("image_gen needs a prompt.");
  const target = resolveOut(root, outPath);
  let done!: (item: any) => void;
  let fail!: (error: Error) => void;
  const itemPromise = new Promise<any>((ok, no) => { done = ok; fail = no; });
  let threadId = "";
  const client = clientFactory({
    onNotification: (method, params: any) => {
      if (params?.threadId && threadId && params.threadId !== threadId) return;
      if (method === "item/completed" && params?.item?.type === "imageGeneration") {
        const status = String(params.item.status ?? "");
        if (/fail|error/i.test(status)) fail(new Error(`image generation failed (status: ${status})`));
        else done(params.item);
        return;
      }
      if (method === "error" && params?.willRetry !== true) {
        fail(new Error(String(params?.error?.message ?? "Codex App Server image turn failed")));
        return;
      }
      if (method === "turn/completed") {
        const status = String(params?.turn?.status ?? "");
        if (status !== "completed") fail(new Error(params?.turn?.error?.message ?? `Codex turn ${status || "failed"}`));
        // A completed turn WITHOUT an image item settles below via the race timeout guard.
      }
    },
    onRequest: async (method) => {
      if (method === "account/chatgptAuthTokens/refresh") {
        const credentials = await validChatGptCredentials(fetch, undefined, true);
        if (!credentials.accountId) throw new Error("refreshed ChatGPT credentials do not include an account id");
        return { accessToken: credentials.accessToken, chatgptAccountId: credentials.accountId, chatgptPlanType: null };
      }
      throw new Error(`Unsupported Codex server request: ${method}`);
    },
  });
  try {
    await client.initialize();
    const credentials = await validChatGptCredentials();
    if (!credentials.accountId) throw new Error("ChatGPT credentials do not include an account id; run /login again");
    await client.request("account/login/start", {
      type: "chatgptAuthTokens",
      accessToken: credentials.accessToken,
      chatgptAccountId: credentials.accountId,
      chatgptPlanType: null,
    });
    // Fail closed BEFORE spending anything: the account/model must advertise the capability.
    const caps = await client.request("modelProvider/capabilities/read", {}, 30_000).catch(() => null);
    if (caps && caps.imageGeneration === false) {
      throw new Error("This ChatGPT account/model does not advertise image generation through Codex. Update Codex CLI (`neko support`) or check the plan.");
    }
    const started = await client.request("thread/start", {
      cwd: root,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      environments: [],
    }, 60_000);
    threadId = String(started?.thread?.id ?? "");
    if (!threadId) throw new Error("Codex App Server did not return a thread id");
    await client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: `Use your image generation tool to create exactly one image: ${prompt}\nDo not write code or files; only generate the image.`, text_elements: [] }],
    }, 60_000);
    const item: any = await Promise.race([
      itemPromise,
      new Promise((_, no) => setTimeout(() => no(new Error("image generation timed out")), timeoutMs)),
    ]);
    let saved: string = typeof item.savedPath === "string" ? item.savedPath : "";
    if (typeof item.result === "string" && item.result.length) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, Buffer.from(item.result, "base64"));
      saved = target;
    } else if (saved && saved !== target && existsSync(saved)) {
      writeFileSync(target, readFileSync(saved));
      saved = target;
    }
    if (!saved) throw new Error("Codex returned an image item without data");
    return { path: saved, revisedPrompt: item.revisedPrompt ? String(item.revisedPrompt) : undefined };
  } finally {
    client.close();
  }
}

/** Output path: caller's (inside root), else `neko-image-<stamp>.png` in root. */
function resolveOut(root: string, outPath?: string): string {
  const fallback = join(root, `neko-image-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.png`);
  if (!outPath) return fallback;
  const resolved = isAbsolute(outPath) ? outPath : resolve(root, outPath);
  const rootResolved = resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + sep)) {
    throw new Error(`image_gen writes inside the project only (got: ${outPath})`);
  }
  return resolved;
}
