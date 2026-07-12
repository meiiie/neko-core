/** Experimental ChatGPT-subscription realtime voice over Codex App Server WebRTC. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";

import { validChatGptCredentials } from "./chatgpt-auth.ts";
import {
  discoverCodexSupport,
  compareCodexVersions,
  encodeCodexDynamicTools,
  startCodexAppServer,
  type CodexAppServerHandlers,
} from "./codex-app-server.ts";

export const CODEX_VOICE_MIN_VERSION = "0.144.1";

interface RpcClient {
  initialize(timeoutMs?: number): Promise<unknown>;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<any>;
  close(): void;
}

export type VoiceCodexClientFactory = (handlers: CodexAppServerHandlers) => RpcClient;

export type VoiceState = "starting" | "waiting" | "connecting" | "live" | "muted" | "stopped" | "error";

export interface VoiceSnapshot {
  state: VoiceState;
  startedAt?: number;
  muted: boolean;
  error?: string;
}

export type VoiceEvent =
  | { type: "state"; snapshot: VoiceSnapshot }
  | { type: "transcript-delta"; role: string; delta: string }
  | { type: "transcript-done"; role: string; text: string };

export interface VoiceUsage {
  active: boolean;
  durationMs: number;
  lastError?: string;
}

export interface ChatGptVoiceOptions {
  model: string;
  tools?: any[];
  executeTool?: (call: { id: string; name: string; arguments: Record<string, any> }) => Promise<string | any[]>;
  onEvent?: (event: VoiceEvent) => void;
  clientFactory?: VoiceCodexClientFactory;
  openUrl?: (url: string) => void;
  now?: () => number;
}

export interface ChatGptVoiceControl {
  snapshot(): VoiceSnapshot;
  start(): Promise<{ url: string }>;
  setMuted(muted: boolean): void;
  stop(reason?: string): Promise<void>;
}

interface VoiceSocketData {
  authenticated: boolean;
}

let lastUsage: VoiceUsage | null = null;

export function getChatGptVoiceUsage(now = Date.now()): VoiceUsage | null {
  if (!lastUsage) return null;
  if (!lastUsage.active) return { ...lastUsage };
  return { ...lastUsage, durationMs: Math.max(0, now - voiceStartedAt) };
}

let voiceStartedAt = 0;

function defaultClientFactory(handlers: CodexAppServerHandlers): RpcClient {
  const status = discoverCodexSupport();
  if (status.state !== "ready" || !status.executable?.version || compareCodexVersions(status.executable.version, CODEX_VOICE_MIN_VERSION) < 0) {
    throw new Error(`ChatGPT voice needs Codex Support Pack >= ${CODEX_VOICE_MIN_VERSION} (${status.detail})`);
  }
  return startCodexAppServer(status.executable, handlers, {
    forbidApiBilling: true,
    enableRealtimeConversation: true,
  });
}

function defaultOpenUrl(url: string): void {
  const command = process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

export class ChatGptVoiceSession implements ChatGptVoiceControl {
  private client: RpcClient | null = null;
  private server: Bun.Server<VoiceSocketData> | null = null;
  private socket: Bun.ServerWebSocket<VoiceSocketData> | null = null;
  private threadId = "";
  private realtimeStarted = false;
  private stopping = false;
  private token = "";
  private origin = "";
  private startedAt = 0;
  private muted = false;
  private state: VoiceState = "starting";
  private sdpWaiter: { resolve: (sdp: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeat = 0;
  private readonly toolResults = new Map<string, Promise<{ contentItems: any[]; success: boolean }>>();
  private dynamicToolNames = new Map<string, string>();

  constructor(private readonly options: ChatGptVoiceOptions) {}

  snapshot(): VoiceSnapshot {
    return {
      state: this.state,
      startedAt: this.startedAt || undefined,
      muted: this.muted,
      error: this.state === "error" ? lastUsage?.lastError : undefined,
    };
  }

  async start(): Promise<{ url: string }> {
    if (this.client || this.server) throw new Error("voice session is already started");
    this.emitState("starting");
    const clientFactory = this.options.clientFactory ?? defaultClientFactory;
    let client: RpcClient | null = null;
    try {
      client = clientFactory({
        onNotification: (method, params) => this.onNotification(method, params as any),
        onRequest: (method, params) => this.onRequest(method, params as any),
      });
      this.client = client;
      await client.initialize(30_000);
      const credentials = await validChatGptCredentials();
      if (!credentials.accountId) throw new Error("ChatGPT credentials do not include an account id; run /login again");
      await client.request("account/login/start", {
        type: "chatgptAuthTokens",
        accessToken: credentials.accessToken,
        chatgptAccountId: credentials.accountId,
        chatgptPlanType: null,
      }, 30_000);
      const dynamicTools = encodeCodexDynamicTools(this.options.tools ?? []);
      this.dynamicToolNames = dynamicTools.originalNames;
      const started = await client.request("thread/start", {
        model: /^gpt-/i.test(this.options.model) ? this.options.model : "gpt-5.5",
        allowProviderModelFallback: false,
        cwd: process.cwd(),
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        developerInstructions: VOICE_AGENT_INSTRUCTIONS,
        dynamicTools: dynamicTools.tools,
      }, 60_000);
      this.threadId = String(started?.thread?.id ?? "");
      if (!this.threadId) throw new Error("Codex App Server did not return a voice thread id");
      await client.request("thread/realtime/listVoices", {}, 10_000);
      const url = this.startBridge();
      this.emitState("waiting");
      (this.options.openUrl ?? defaultOpenUrl)(url);
      return { url };
    } catch (error) {
      client?.close();
      this.client = null;
      this.closeBridge();
      const friendly = friendlyVoiceError(error);
      this.recordError(friendly);
      throw new Error(friendly);
    }
  }

  setMuted(muted: boolean): void {
    if (!this.socket || (this.state !== "live" && this.state !== "muted")) throw new Error("voice is not live yet");
    this.socket.send(JSON.stringify({ type: "set-muted", muted }));
  }

  async stop(reason = "user"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    const client = this.client;
    this.client = null;
    this.sdpWaiter?.reject(new Error("voice session stopped"));
    if (this.sdpWaiter) clearTimeout(this.sdpWaiter.timer);
    this.sdpWaiter = null;
    try { this.socket?.send(JSON.stringify({ type: "stop", reason })); } catch { /* already closed */ }
    this.socket?.close(1000, reason);
    this.socket = null;
    if (client && this.realtimeStarted && this.threadId) {
      try { await client.request("thread/realtime/stop", { threadId: this.threadId }, 5_000); } catch { /* best effort */ }
    }
    if (client && this.threadId) {
      try { await client.request("thread/unsubscribe", { threadId: this.threadId }, 5_000); } catch { /* best effort */ }
    }
    client?.close();
    this.server?.stop(true);
    this.server = null;
    this.realtimeStarted = false;
    const durationMs = this.startedAt ? Math.max(0, (this.options.now ?? Date.now)() - this.startedAt) : 0;
    lastUsage = { active: false, durationMs, lastError: lastUsage?.lastError };
    this.emitState("stopped");
  }

  private startBridge(): string {
    this.token = randomBytes(32).toString("base64url");
    this.lastHeartbeat = (this.options.now ?? Date.now)();
    const server = Bun.serve<VoiceSocketData>({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request, bunServer) => this.handleHttp(request, bunServer),
      websocket: {
        message: (ws, raw) => this.onSocketMessage(ws, raw),
        close: (ws) => {
          if (this.socket !== ws) return;
          this.socket = null;
          if (!this.stopping) void this.stop("browser closed");
        },
      },
    });
    this.server = server;
    this.origin = `http://127.0.0.1:${server.port}`;
    this.heartbeat = setInterval(() => {
      if (!this.socket) return;
      const now = (this.options.now ?? Date.now)();
      if (now - this.lastHeartbeat > 20_000) { void this.stop("browser heartbeat lost"); return; }
      this.socket.send(JSON.stringify({ type: "ping" }));
    }, 5_000);
    (this.heartbeat as any).unref?.();
    return `${this.origin}/#${this.token}`;
  }

  private async handleHttp(request: Request, bunServer: Bun.Server<VoiceSocketData>): Promise<Response | undefined> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(VOICE_PAGE, { headers: PAGE_HEADERS });
    }
    if (url.pathname === "/bridge") {
      if (request.headers.get("origin") !== this.origin) return new Response("forbidden origin", { status: 403 });
      return bunServer.upgrade(request, { data: { authenticated: false } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    if (request.method === "POST" && url.pathname === "/offer") {
      if (!this.authorized(request)) return new Response("unauthorized", { status: 401 });
      if (Number(request.headers.get("content-length") ?? 0) > 1_000_000) return new Response("offer too large", { status: 413 });
      const raw = await request.text();
      if (raw.length > 1_000_000) return new Response("offer too large", { status: 413 });
      let sdp = "";
      try { sdp = String(JSON.parse(raw)?.sdp ?? ""); } catch { return new Response("invalid JSON", { status: 400 }); }
      if (!sdp.startsWith("v=0") || sdp.length < 20) return new Response("invalid SDP offer", { status: 400 });
      try {
        const answer = await this.startRealtime(sdp);
        return Response.json({ sdp: answer });
      } catch (error) {
        const friendly = friendlyVoiceError(error);
        this.recordError(friendly);
        setTimeout(() => { void this.stop("realtime start failed"); }, 50);
        return new Response(friendly, { status: 409 });
      }
    }
    return new Response("not found", { status: 404 });
  }

  private authorized(request: Request): boolean {
    const auth = request.headers.get("authorization") ?? "";
    return safeEqual(auth, `Bearer ${this.token}`);
  }

  private onSocketMessage(ws: Bun.ServerWebSocket<VoiceSocketData>, raw: string | Buffer): void {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    if (text.length > 16_384) { ws.close(1009, "message too large"); return; }
    let message: any;
    try { message = JSON.parse(text); } catch { ws.close(1003, "invalid JSON"); return; }
    if (!ws.data.authenticated) {
      if (message?.type !== "hello" || !safeEqual(String(message.token ?? ""), this.token)) { ws.close(1008, "authentication failed"); return; }
      ws.data.authenticated = true;
      this.socket?.close(1000, "replaced");
      this.socket = ws;
      this.lastHeartbeat = (this.options.now ?? Date.now)();
      ws.send(JSON.stringify({ type: "ready" }));
      return;
    }
    if (this.socket !== ws) return;
    if (message?.type === "heartbeat" || message?.type === "pong") {
      this.lastHeartbeat = (this.options.now ?? Date.now)();
    } else if (message?.type === "connecting") {
      this.emitState("connecting");
    } else if (message?.type === "live") {
      if (!this.startedAt) {
        this.startedAt = (this.options.now ?? Date.now)();
        voiceStartedAt = this.startedAt;
        lastUsage = { active: true, durationMs: 0 };
      }
      this.emitState(this.muted ? "muted" : "live");
    } else if (message?.type === "muted") {
      this.muted = Boolean(message.muted);
      this.emitState(this.muted ? "muted" : "live");
    } else if (message?.type === "error") {
      this.recordError(friendlyVoiceError(new Error(String(message.message ?? "browser voice failed"))));
      setTimeout(() => { void this.stop("browser voice error"); }, 50);
    } else if (message?.type === "stop") {
      void this.stop("browser stop");
    }
  }

  private async startRealtime(sdp: string): Promise<string> {
    if (!this.client || !this.threadId) throw new Error("voice preflight is not ready");
    if (this.realtimeStarted || this.sdpWaiter) throw new Error("a realtime voice call is already starting");
    this.emitState("connecting");
    const answer = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.sdpWaiter = null;
        reject(new Error("voice WebRTC answer timed out"));
      }, 30_000);
      this.sdpWaiter = { resolve, reject, timer };
    });
    void answer.catch(() => {}); // stop/close may reject while the start request is still in flight
    this.realtimeStarted = true;
    try {
      await this.client.request("thread/realtime/start", {
        threadId: this.threadId,
        outputModality: "audio",
        includeStartupContext: true,
        flushTranscriptTailOnSessionEnd: true,
        prompt: VOICE_REALTIME_PROMPT,
        transport: { type: "webrtc", sdp },
      }, 30_000);
      return await answer;
    } catch (error) {
      this.realtimeStarted = false;
      const waiter = this.sdpWaiter as ChatGptVoiceSession["sdpWaiter"];
      if (waiter) clearTimeout(waiter.timer);
      this.sdpWaiter = null;
      throw error;
    }
  }

  private async onRequest(method: string, params: any): Promise<unknown> {
    if (method === "account/chatgptAuthTokens/refresh") {
      const credentials = await validChatGptCredentials(fetch, undefined, true);
      if (!credentials.accountId) throw new Error("refreshed ChatGPT credentials do not include an account id");
      return { accessToken: credentials.accessToken, chatgptAccountId: credentials.accountId, chatgptPlanType: null };
    }
    if (method !== "item/tool/call") throw new Error(`Unsupported Codex voice request: ${method}`);
    if (!this.options.executeTool) throw new Error("No Neko tool executor is available to voice");
    if (params?.threadId !== this.threadId) throw new Error("Voice tool request belongs to a different thread");
    const wireName = String(params?.tool ?? "");
    const call = {
      id: String(params?.callId ?? ""),
      name: this.dynamicToolNames.get(wireName) ?? "",
      arguments: isObject(params?.arguments) ? params.arguments : {},
    };
    if (!call.id || !call.name) throw new Error("Codex voice returned an invalid tool call");
    let result = this.toolResults.get(call.id);
    if (!result) {
      result = this.options.executeTool(call).then(toolResultContent);
      this.toolResults.set(call.id, result);
    }
    return await result;
  }

  private onNotification(method: string, params: any): void {
    if (params?.threadId && params.threadId !== this.threadId) return;
    if (method === "thread/realtime/sdp") {
      const waiter = this.sdpWaiter;
      this.sdpWaiter = null;
      if (!waiter) return;
      clearTimeout(waiter.timer);
      waiter.resolve(String(params?.sdp ?? ""));
    } else if (method === "thread/realtime/transcript/delta") {
      this.options.onEvent?.({ type: "transcript-delta", role: String(params?.role ?? "assistant"), delta: String(params?.delta ?? "") });
    } else if (method === "thread/realtime/transcript/done") {
      this.options.onEvent?.({ type: "transcript-done", role: String(params?.role ?? "assistant"), text: String(params?.text ?? "") });
    } else if (method === "thread/realtime/error") {
      const friendly = friendlyVoiceError(new Error(String(params?.message ?? "ChatGPT realtime voice failed")));
      const waiter = this.sdpWaiter;
      this.sdpWaiter = null;
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error(friendly));
      }
      this.recordError(friendly);
      // The HTTP /offer handler owns teardown while it is awaiting SDP; let it return the backend
      // reason to the consent page before closing the loopback server.
      if (!waiter) queueMicrotask(() => { void this.stop("backend error"); });
    } else if (method === "thread/realtime/closed" && !this.stopping) {
      void this.stop(String(params?.reason ?? "backend closed"));
    }
  }

  private recordError(message: string): void {
    const durationMs = this.startedAt ? Math.max(0, (this.options.now ?? Date.now)() - this.startedAt) : 0;
    lastUsage = { active: false, durationMs, lastError: message };
    this.state = "error";
    this.options.onEvent?.({ type: "state", snapshot: this.snapshot() });
  }

  private emitState(state: VoiceState): void {
    this.state = state;
    this.options.onEvent?.({ type: "state", snapshot: this.snapshot() });
  }

  private closeBridge(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    this.server?.stop(true);
    this.server = null;
  }
}

function toolResultContent(observation: string | any[]): { contentItems: any[]; success: boolean } {
  const failed = typeof observation === "string" && (/^Error running\b/.test(observation) || /^\[denied\]/.test(observation) || /^Denied by user:/i.test(observation));
  if (typeof observation === "string") return { contentItems: [{ type: "inputText", text: observation || "(no output)" }], success: !failed };
  const contentItems: any[] = [];
  for (const part of observation) {
    if (part?.type === "text") contentItems.push({ type: "inputText", text: String(part.text ?? "") });
    else if (part?.type === "image_url" && part.image_url?.url) contentItems.push({ type: "inputImage", imageUrl: String(part.image_url.url) });
  }
  return { contentItems: contentItems.length ? contentItems : [{ type: "inputText", text: "(no output)" }], success: true };
}

function isObject(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function friendlyVoiceError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (/microphone|permission|notallowederror|denied/i.test(raw)) return "Microphone permission was denied. Allow microphone access in the voice tab, then run /voice again.";
  if (/401|unauthori|credential|sign.?in|account id/i.test(raw)) return "ChatGPT sign-in expired or is unavailable. Run /login > OpenAI > ChatGPT Plus/Pro, then retry /voice.";
  if (/403|not eligible|entitlement|workspace/i.test(raw)) return "This ChatGPT account is not currently eligible for Codex subscription voice.";
  if (/429|rate.?limit|quota|usage limit/i.test(raw)) return "ChatGPT voice limit was reached. Neko did not switch to paid API billing.";
  if (/404|model not found|not available/i.test(raw)) return "Codex's experimental ChatGPT subscription voice endpoint is not enabled for this client or account. Neko did not switch to paid API billing; use OS Dictation or an explicitly configured Realtime API instead.";
  if (/Support Pack|0\.144/i.test(raw)) return `${raw}. Install or update it with /support chatgpt install.`;
  return raw;
}

const VOICE_AGENT_INSTRUCTIONS = [
  "You are Neko Core in a realtime voice conversation.",
  "Reply in the user's language and keep spoken responses concise unless detail is requested.",
  "For coding or computer tasks, use the provided Neko tools. Tool denials are final and must be explained.",
  "Never claim a tool action succeeded until its result confirms it.",
].join(" ");

const VOICE_REALTIME_PROMPT = [
  "You are Neko Core's realtime voice interface.",
  "Speak naturally, allow interruption, and use Vietnamese when the user speaks Vietnamese.",
  "Delegate coding and tool work to the background Codex agent; summarize tool results clearly.",
].join(" ");

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*; media-src blob:",
};

const VOICE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Neko Core Voice</title><style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#0e1116;color:#e8edf5}body{margin:0;min-height:100vh;display:grid;place-items:center}.card{width:min(560px,calc(100vw - 40px));background:#171c24;border:1px solid #2c3440;border-radius:20px;padding:28px;box-shadow:0 24px 80px #0008}.brand{color:#67e8d4;font-weight:700}.live{display:flex;align-items:center;gap:10px;margin:24px 0;font-size:22px}.dot{width:12px;height:12px;border-radius:50%;background:#6b7280}.dot.on{background:#ff4d5e;box-shadow:0 0 0 7px #ff4d5e22}button{border:0;border-radius:12px;padding:12px 18px;font:inherit;font-weight:650;cursor:pointer;background:#67e8d4;color:#07110f;margin-right:8px}button.secondary{background:#2b3441;color:#e8edf5}button:disabled{opacity:.45;cursor:not-allowed}.hint{color:#9ba8b8;line-height:1.55}.error{color:#ff8c98;white-space:pre-wrap}.hidden{display:none}</style></head>
<body><main class="card"><div class="brand">NEKO CORE</div><h1>ChatGPT Subscription Voice</h1><p class="hint">Experimental. Your microphone stays off until you press Start voice. Neko never falls back to paid API billing.</p>
<div class="live"><span id="dot" class="dot"></span><strong id="status">Ready - microphone off</strong></div>
<button id="start">Start voice</button><button id="mute" class="secondary hidden">Mute</button><button id="stop" class="secondary hidden">Stop</button><p id="error" class="error"></p><p class="hint">Closing this tab stops the voice session. Return to the terminal for the live transcript and tool approvals.</p><audio id="audio" autoplay></audio></main>
<script>
const token=location.hash.slice(1),statusEl=document.getElementById('status'),dot=document.getElementById('dot'),start=document.getElementById('start'),mute=document.getElementById('mute'),stop=document.getElementById('stop'),errorEl=document.getElementById('error'),audio=document.getElementById('audio');history.replaceState(null,'',location.pathname);let ws,pc,stream,muted=false,ended=false;
const send=(m)=>{if(ws&&ws.readyState===1)ws.send(JSON.stringify(m))};const setStatus=(s,on=false)=>{statusEl.textContent=s;dot.classList.toggle('on',on)};
function connect(){ws=new WebSocket('ws://'+location.host+'/bridge');ws.onopen=()=>send({type:'hello',token});ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.type==='ping')send({type:'pong'});if(m.type==='set-muted')applyMute(!!m.muted);if(m.type==='stop')cleanup(false)};ws.onclose=()=>{if(!ended)cleanup(false)}}connect();setInterval(()=>send({type:'heartbeat'}),5000);
function applyMute(value){muted=value;if(stream)for(const t of stream.getAudioTracks())t.enabled=!muted;mute.textContent=muted?'Unmute':'Mute';setStatus(muted?'LIVE - muted':'LIVE',true);send({type:'muted',muted})}
async function begin(){start.disabled=true;errorEl.textContent='';setStatus('Requesting microphone...');try{stream=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}});send({type:'connecting'});setStatus('Connecting...');pc=new RTCPeerConnection();pc.ontrack=(e)=>{audio.srcObject=e.streams[0];audio.play().catch(()=>{})};pc.addTrack(stream.getAudioTracks()[0],stream);pc.createDataChannel('oai-events');pc.onconnectionstatechange=()=>{if(pc.connectionState==='connected'){setStatus('LIVE',true);start.classList.add('hidden');mute.classList.remove('hidden');stop.classList.remove('hidden');send({type:'live'})}else if(['failed','disconnected'].includes(pc.connectionState)){fail('Voice connection '+pc.connectionState)}};const offer=await pc.createOffer();await pc.setLocalDescription(offer);const res=await fetch('/offer',{method:'POST',headers:{'authorization':'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({sdp:offer.sdp})});if(!res.ok)throw new Error(await res.text());const answer=await res.json();await pc.setRemoteDescription({type:'answer',sdp:answer.sdp})}catch(e){fail(e&&e.message?e.message:String(e))}}
function fail(message){errorEl.textContent=message;setStatus('Voice unavailable');send({type:'error',message});cleanup(false);start.disabled=true}
function cleanup(notify=true){if(ended)return;ended=true;if(notify)send({type:'stop'});if(pc)pc.close();if(stream)for(const t of stream.getTracks())t.stop();setStatus('Stopped');dot.classList.remove('on');mute.classList.add('hidden');stop.classList.add('hidden')}
start.onclick=begin;mute.onclick=()=>applyMute(!muted);stop.onclick=()=>cleanup(true);addEventListener('pagehide',()=>cleanup(true));
</script></body></html>`;
