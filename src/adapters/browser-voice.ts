/** Consent-first browser voice preview. Recognition/TTS may be supplied by the browser vendor. */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";

import type { ChatGptVoiceControl, VoiceEvent, VoiceSnapshot, VoiceState } from "./chatgpt-voice.ts";
import { VoiceInteractionPolicy } from "./voice-interaction.ts";

export interface BrowserVoiceOptions {
  onUtterance: (text: string) => Promise<string>;
  onInterrupt?: () => void;
  onEvent?: (event: VoiceEvent) => void;
  openUrl?: (url: string) => void;
  now?: () => number;
  policy?: VoiceInteractionPolicy;
}

interface BrowserVoiceSocketData {
  authenticated: boolean;
}

function defaultOpenUrl(url: string): void {
  const command = process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

export class BrowserVoiceSession implements ChatGptVoiceControl {
  private server: Bun.Server<BrowserVoiceSocketData> | null = null;
  private socket: Bun.ServerWebSocket<BrowserVoiceSocketData> | null = null;
  private state: VoiceState = "starting";
  private startedAt = 0;
  private muted = false;
  private stopping = false;
  private speaking = false;
  private turnRunning = false;
  private token = "";
  private origin = "";
  private lastHeartbeat = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private turnChain: Promise<void> = Promise.resolve();
  private readonly policy: VoiceInteractionPolicy;

  constructor(private readonly options: BrowserVoiceOptions) {
    this.policy = options.policy ?? new VoiceInteractionPolicy();
  }

  snapshot(): VoiceSnapshot {
    return { state: this.state, startedAt: this.startedAt || undefined, muted: this.muted };
  }

  async start(): Promise<{ transport: "browser"; url: string }> {
    if (this.server) throw new Error("browser voice session is already started");
    this.emitState("starting");
    this.token = randomBytes(32).toString("base64url");
    this.lastHeartbeat = this.now();
    const server = Bun.serve<BrowserVoiceSocketData>({
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
      if (this.now() - this.lastHeartbeat > 20_000) { void this.stop("browser heartbeat lost"); return; }
      this.socket.send(JSON.stringify({ type: "ping" }));
    }, 5_000);
    (this.heartbeat as any).unref?.();
    const url = `${this.origin}/#${this.token}`;
    this.emitState("waiting");
    (this.options.openUrl ?? defaultOpenUrl)(url);
    return { transport: "browser", url };
  }

  setMuted(muted: boolean): void {
    if (!this.socket || (this.state !== "live" && this.state !== "muted")) throw new Error("browser voice is not live yet");
    this.socket.send(JSON.stringify({ type: "set-muted", muted }));
  }

  async stop(reason = "user"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    try { this.socket?.send(JSON.stringify({ type: "stop", reason })); } catch { /* already closed */ }
    this.socket?.close(1000, reason);
    this.socket = null;
    this.server?.stop(true);
    this.server = null;
    this.speaking = false;
    this.turnRunning = false;
    this.emitState("stopped");
  }

  private handleHttp(request: Request, bunServer: Bun.Server<BrowserVoiceSocketData>): Response | undefined {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") return new Response(BROWSER_VOICE_PAGE, { headers: PAGE_HEADERS });
    if (url.pathname === "/bridge") {
      if (request.headers.get("origin") !== this.origin) return new Response("forbidden origin", { status: 403 });
      return bunServer.upgrade(request, { data: { authenticated: false } }) ? undefined : new Response("upgrade failed", { status: 400 });
    }
    return new Response("not found", { status: 404 });
  }

  private onSocketMessage(ws: Bun.ServerWebSocket<BrowserVoiceSocketData>, raw: string | Buffer): void {
    const text = typeof raw === "string" ? raw : raw.toString("utf8");
    if (text.length > 32_768) { ws.close(1009, "message too large"); return; }
    let message: any;
    try { message = JSON.parse(text); } catch { ws.close(1003, "invalid JSON"); return; }
    if (!ws.data.authenticated) {
      if (message?.type !== "hello" || !safeEqual(String(message.token ?? ""), this.token)) { ws.close(1008, "authentication failed"); return; }
      ws.data.authenticated = true;
      this.socket?.close(1000, "replaced");
      this.socket = ws;
      this.lastHeartbeat = this.now();
      ws.send(JSON.stringify({ type: "ready" }));
      return;
    }
    if (this.socket !== ws) return;
    if (message?.type === "heartbeat" || message?.type === "pong") {
      this.lastHeartbeat = this.now();
    } else if (message?.type === "live") {
      if (!this.startedAt) this.startedAt = this.now();
      this.emitState(this.muted ? "muted" : "live");
    } else if (message?.type === "muted") {
      this.muted = Boolean(message.muted);
      this.emitState(this.muted ? "muted" : "live");
    } else if (message?.type === "speech-start") {
      if (this.speaking || this.turnRunning) {
        const wasSpeaking = this.speaking;
        this.speaking = false;
        this.options.onInterrupt?.();
        if (wasSpeaking) ws.send(JSON.stringify({ type: "cancel-speech" }));
      }
      this.policy.speechStarted(this.now());
    } else if (message?.type === "partial") {
      const partial = boundedText(message.text, 8_000);
      if (!partial) return;
      this.options.onEvent?.({ type: "transcript-delta", role: "user", delta: partial });
      const backchannel = this.policy.speechProgress(partial, this.now());
      if (backchannel) ws.send(JSON.stringify({ type: "backchannel", text: backchannel }));
    } else if (message?.type === "utterance") {
      const utterance = boundedText(message.text, 16_000);
      if (!utterance) return;
      this.policy.turnCompleted();
      this.options.onEvent?.({ type: "transcript-done", role: "user", text: utterance });
      this.turnChain = this.turnChain.then(() => this.runTurn(utterance));
    } else if (message?.type === "speaking-done") {
      this.speaking = false;
    } else if (message?.type === "stop") {
      void this.stop("browser stop");
    }
  }

  private async runTurn(utterance: string): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    socket.send(JSON.stringify({ type: "thinking" }));
    this.turnRunning = true;
    try {
      const response = boundedText(await this.options.onUtterance(utterance), 24_000);
      if (!response || !this.socket) return;
      this.speaking = true;
      this.socket.send(JSON.stringify({ type: "response", text: response }));
      this.options.onEvent?.({ type: "transcript-done", role: "assistant", text: response });
    } catch (error) {
      if (!this.socket) return;
      const message = error instanceof Error ? error.message : String(error);
      this.socket.send(JSON.stringify({ type: "turn-error", message }));
    } finally {
      this.turnRunning = false;
    }
  }

  private emitState(state: VoiceState): void {
    this.state = state;
    this.options.onEvent?.({ type: "state", snapshot: this.snapshot() });
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }
}

function boundedText(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ws://127.0.0.1:*",
};

const BROWSER_VOICE_PAGE = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Neko Conversational Voice</title><style>
:root{color-scheme:dark;font-family:ui-sans-serif,system-ui,sans-serif;background:#0e1116;color:#e8edf5}body{margin:0;min-height:100vh;display:grid;place-items:center}.card{width:min(620px,calc(100vw - 40px));background:#171c24;border:1px solid #2c3440;border-radius:20px;padding:28px;box-shadow:0 24px 80px #0008}.brand{color:#67e8d4;font-weight:700}.live{display:flex;align-items:center;gap:10px;margin:22px 0;font-size:22px}.dot{width:12px;height:12px;border-radius:50%;background:#6b7280}.dot.on{background:#ff4d5e;box-shadow:0 0 0 7px #ff4d5e22}button{border:0;border-radius:12px;padding:12px 18px;font:inherit;font-weight:650;cursor:pointer;background:#67e8d4;color:#07110f;margin-right:8px}button.secondary{background:#2b3441;color:#e8edf5}button:disabled{opacity:.45;cursor:not-allowed}.hint{color:#9ba8b8;line-height:1.55}.privacy{padding:12px 14px;border:1px solid #7c5c22;background:#2a2112;border-radius:12px;color:#f5d38b}.transcript{min-height:48px;color:#c7d2e0;font-style:italic}.error{color:#ff8c98;white-space:pre-wrap}.hidden{display:none}</style></head>
<body><main class="card"><div class="brand">NEKO CORE</div><h1>Conversational Voice - Browser Preview</h1><p class="hint">Hands-free conversation with backchannels and interruption. Microphone access starts only after you press Start.</p>
<p class="privacy"><strong>Privacy:</strong> speech recognition and speech synthesis are supplied by your browser and may use its online service. Neko receives transcript text only. Paid Realtime API is never selected automatically.</p>
<div class="live"><span id="dot" class="dot"></span><strong id="status">Ready - microphone off</strong></div><p id="transcript" class="transcript"></p>
<button id="start">Start</button><button id="mute" class="secondary hidden">Mute</button><button id="stop" class="secondary hidden">Stop</button><p id="error" class="error"></p><p class="hint">Speak Vietnamese or English. Closing this tab, /voice stop, /logout, or exiting Neko releases the session.</p></main>
<script>
const token=location.hash.slice(1),statusEl=document.getElementById('status'),transcriptEl=document.getElementById('transcript'),dot=document.getElementById('dot'),start=document.getElementById('start'),mute=document.getElementById('mute'),stop=document.getElementById('stop'),errorEl=document.getElementById('error');history.replaceState(null,'',location.pathname);let ws,recognition,active=false,muted=false,ended=false,restarting=false,speechKind='';
const send=(m)=>{if(ws&&ws.readyState===1)ws.send(JSON.stringify(m))};const setStatus=(s,on=false)=>{statusEl.textContent=s;dot.classList.toggle('on',on)};
function connect(){ws=new WebSocket('ws://'+location.host+'/bridge');ws.onopen=()=>send({type:'hello',token});ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.type==='ping')send({type:'pong'});else if(m.type==='set-muted')applyMute(!!m.muted);else if(m.type==='backchannel')speak(m.text,true);else if(m.type==='thinking')setStatus('Thinking...',true);else if(m.type==='response')speak(m.text,false);else if(m.type==='cancel-speech')speechSynthesis.cancel();else if(m.type==='turn-error'){errorEl.textContent=m.message;setStatus('Listening',true)}else if(m.type==='stop')cleanup(false)};ws.onclose=()=>{if(!ended)cleanup(false)}}connect();setInterval(()=>send({type:'heartbeat'}),5000);
function voiceFor(lang){const voices=speechSynthesis.getVoices();return voices.find(v=>v.lang.toLowerCase().startsWith(lang))||voices.find(v=>v.lang.toLowerCase().startsWith('vi'))||null}
function spoken(text){return text.replace(/\\x60{3}[\\s\\S]*?\\x60{3}/g,' đoạn mã ').replace(/https?:\\/\\/\\S+/g,' đường dẫn ').replace(/[*_#>\\x60~|]/g,' ').replace(/\\s+/g,' ').trim().slice(0,12000)}
function speak(text,backchannel){const clean=spoken(text);if(!clean||ended)return;if(!backchannel)speechSynthesis.cancel();const u=new SpeechSynthesisUtterance(clean);u.lang='vi-VN';u.voice=voiceFor('vi');u.volume=backchannel ? 0.72 : 1;u.rate=backchannel ? 1.08 : 1.02;speechKind=backchannel?'backchannel':'response';if(!backchannel)setStatus('Speaking - you can interrupt',true);u.onend=()=>{if(speechKind==='response'){send({type:'speaking-done'});setStatus('Listening',true)}speechKind=''};u.onerror=()=>{speechKind='';if(!backchannel)setStatus('Listening',true)};speechSynthesis.speak(u)}
function createRecognition(){const R=window.SpeechRecognition||window.webkitSpeechRecognition;if(!R)throw new Error('This browser does not provide Speech Recognition. Use current Chrome/Edge or choose OS Dictation.');const r=new R();r.continuous=true;r.interimResults=true;r.lang='vi-VN';r.onstart=()=>{restarting=false;setStatus(muted?'Muted':'Listening',!muted);send({type:'live'})};r.onspeechstart=()=>{if(speechSynthesis.speaking&&speechKind==='response')speechSynthesis.cancel();send({type:'speech-start'});setStatus('Listening',true)};r.onresult=(e)=>{let partial='',finalText='';for(let i=e.resultIndex;i<e.results.length;i++){const t=e.results[i][0].transcript;if(e.results[i].isFinal)finalText+=t;else partial+=t}const shown=(partial||finalText).trim();if(shown)transcriptEl.textContent='> '+shown;if(partial.trim())send({type:'partial',text:partial});if(finalText.trim())send({type:'utterance',text:finalText})};r.onerror=(e)=>{if(e.error!=='aborted'&&e.error!=='no-speech'){errorEl.textContent='Speech recognition: '+e.error;setStatus('Voice unavailable')}};r.onend=()=>{if(active&&!muted&&!ended&&!restarting){restarting=true;setTimeout(()=>{try{r.start()}catch{}},180)}};return r}
function applyMute(value){muted=value;mute.textContent=muted?'Unmute':'Mute';if(!recognition)return;if(muted){recognition.stop();setStatus('Muted');dot.classList.remove('on')}else{try{recognition.start()}catch{}setStatus('Listening',true)}send({type:'muted',muted})}
async function begin(){start.disabled=true;errorEl.textContent='';setStatus('Requesting microphone...');try{recognition=createRecognition();active=true;recognition.start();start.classList.add('hidden');mute.classList.remove('hidden');stop.classList.remove('hidden')}catch(e){errorEl.textContent=e&&e.message?e.message:String(e);setStatus('Voice unavailable');start.disabled=false}}
function cleanup(notify=true){if(ended)return;ended=true;active=false;if(notify)send({type:'stop'});try{recognition&&recognition.abort()}catch{}speechSynthesis.cancel();setStatus('Stopped');dot.classList.remove('on');mute.classList.add('hidden');stop.classList.add('hidden')}
start.onclick=begin;mute.onclick=()=>applyMute(!muted);stop.onclick=()=>cleanup(true);addEventListener('pagehide',()=>cleanup(true));
</script></body></html>`;
