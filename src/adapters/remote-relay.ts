/**
 * /relay — drive Neko from ANY device (phone/browser, no Tailscale, no open port) the way Claude Code
 * Remote Control works: the local agent dials OUT to a relay you host (your own Cloudflare Worker),
 * registers a session, and receives instructions — it never opens a listening port, so it works behind
 * any NAT/firewall. A client (your phone) sends instructions to the same relay; the relay routes them
 * to the agent and returns the reply. Because the relay is YOURS (not a vendor's) and payloads are
 * end-to-end encrypted, the relay is a blind forwarder. This module is the host (agent) side.
 *
 * One durable pairing is a hub: every running Neko process registers an opaque host id, so a paired
 * phone can list, switch, stream, queue, and interrupt several local sessions independently. Session
 * title/cwd/model/busy metadata is sealed with the same E2E key; the Worker cannot read it.
 *
 * Transport, newest first (the /register response advertises what the Worker speaks):
 *   v3  v2 WebSocket transport + multi-host routing and encrypted presence metadata.
 *   v2  WebSocket (`GET /ws`, token in the "t.<token>" subprotocol): jobs push instantly, PARTIAL
 *       replies stream to the phone while the turn runs, and a phone-side Stop reaches the host
 *       mid-turn as an {t:"interrupt"} frame. Reconnects with backoff; if the socket never opens
 *       (a proxy that blocks WSS), it degrades honestly to v1.
 *   v1  long-poll (GET /pull -> run -> POST /reply), kept for an older deployed Worker.
 *
 * All HTTP is authed with `Authorization: Bearer <token>`; the WS authenticates via subprotocol
 * (portable - browser WebSocket can't set headers - and never in the URL).
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homeDir } from "../shared/home.ts";
import { atomicWriteFileSync } from "../shared/atomic.ts";
import { isSealed, open, seal } from "./relay-crypto.ts";
import type { RemoteHandlers } from "./remote-control.ts";

export interface RemoteRelay {
  session: string;
  token: string;
  /** Opaque id for this running Neko process inside the paired relay hub. */
  hostId: string;
  /** Live transport: "ws" (streaming + interrupt) or "poll" (v1 compat). May downgrade at runtime. */
  transport: () => "ws" | "poll";
  /** Push the latest E2E-sealed title/model/busy metadata to paired clients. */
  refresh: () => void;
  /** Publish one semantic TUI event. Durable events replay after reconnect; reset starts a fresh mirror. */
  publish: (event: unknown, opts?: { durable?: boolean; reset?: boolean }) => void;
  stop: () => void;
}

export interface RelayPairing { session: string; token: string; secret: string; fresh: boolean }

const makePairing = (): RelayPairing => {
  const id = () => randomBytes(12).toString("base64url");
  return { session: id(), token: id(), secret: id(), fresh: true };
};

function readPairing(path: string): RelayPairing | null {
  if (!existsSync(path)) return null;
  try {
    const p = JSON.parse(readFileSync(path, "utf-8"));
    if (p.session && p.token && p.secret) {
      return { session: String(p.session), token: String(p.token), secret: String(p.secret), fresh: false };
    }
  } catch { /* corrupt -> regenerate */ }
  return null;
}

function persistPairing(path: string, pairing: RelayPairing): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    atomicWriteFileSync(path, JSON.stringify({ session: pairing.session, token: pairing.token, secret: pairing.secret }, null, 2) + "\n");
  } catch { /* an unwritable HOME means a one-shot pairing */ }
}

/** Durable pairing (~/.neko-core/relay.json, gitignored - same trust as api_key): /relay reuses it so
 * the phone STAYS paired across Neko restarts (no re-scanning QR codes); `/relay new` rotates it. */
export function loadOrCreatePairing(rotate = false, dir = join(homeDir(), ".neko-core")): RelayPairing {
  const path = join(dir, "relay.json");
  if (!rotate) {
    const existing = readPairing(path);
    if (existing) return existing;
  }
  const made = makePairing();
  persistPairing(path, made);
  return made;
}

/** Default relay identity: one capability URL per Neko conversation. Separate files avoid cross-process
 * write races and make a leaked link least-privilege. The old global pairing remains opt-in as /relay hub. */
export function loadOrCreateSessionPairing(
  localSessionId: string,
  rotate = false,
  dir = join(homeDir(), ".neko-core"),
): RelayPairing {
  const key = createHash("sha256").update(localSessionId).digest("hex").slice(0, 24);
  const path = join(dir, "relay-sessions", `${key}.json`);
  if (!rotate) {
    const existing = readPairing(path);
    if (existing) return existing;
  }
  const made = makePairing();
  persistPairing(path, made);
  return made;
}

export function relaySessionCode(session: string): string {
  return session.replace(/[^A-Za-z0-9]/g, "").slice(0, 12).toUpperCase().match(/.{1,4}/g)?.join("-") ?? session;
}

/** Public fingerprint of the E2E secret (8 hex chars of SHA-256). The relay stores it so the CLIENT
 * can detect a stale/mistyped secret BEFORE sending (a mismatched key otherwise only surfaces as an
 * unreadable reply). Reveals nothing useful: the secret is 96 random bits. */
export function secretKid(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 8);
}

/** Revoke the old hub before `/relay new` persists replacement keys. v2 Workers return false; the
 * caller can still rotate this process but must warn that other already-running hosts remain old. */
export async function revokeRemoteRelay(relayUrl: string, pairing: Pick<RelayPairing, "session" | "token">): Promise<boolean> {
  try {
    const response = await fetch(relayUrl.replace(/\/+$/, "") + "/revoke", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${pairing.token}` },
      body: JSON.stringify({ session: pairing.session }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

export async function startRemoteRelay(
  relayUrl: string,
  handlers: RemoteHandlers,
  opts: { session?: string; token?: string; hostId?: string; pollMs?: number; secret?: string; partialMs?: number; backoffMs?: number } = {},
): Promise<RemoteRelay> {
  const base = relayUrl.replace(/\/+$/, "");
  const session = opts.session ?? randomUUID();
  const token = opts.token ?? randomUUID();
  const hostId = opts.hostId ?? randomBytes(12).toString("base64url");
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };
  const sealedMeta = (busy?: boolean) => {
    if (!opts.secret) return undefined; // keep cwd/title opaque; paired /relay always has a secret
    return seal(opts.secret, JSON.stringify({ ...handlers.status(), ...(busy === undefined ? {} : { busy }), updatedAt: Date.now() }));
  };

  // Register (outbound). Throw if the relay is unreachable so /relay can report it to the user.
  // `kid` = the secret's public fingerprint, so the phone can flag a stale secret before sending.
  const reg = await fetch(`${base}/register`, { method: "POST", headers, body: JSON.stringify({
    session,
    kid: opts.secret ? secretKid(opts.secret) : undefined,
    hostId,
    meta: sealedMeta(),
  }) });
  if (!reg.ok) throw new Error(`relay register failed: HTTP ${reg.status}${reg.status === 401 ? " (session bound to another token - try /relay new)" : ""}`);
  const v2 = Number(((await reg.json().catch(() => ({}))) as { v?: number }).v ?? 1) >= 2;

  let running = true;
  const ctrl = new AbortController();
  const idleMs = opts.pollMs ?? 1000;
  let mode: "ws" | "poll" = v2 ? "ws" : "poll";
  let ws: WebSocket | null = null;

  const decrypt = (payload: unknown): string | null => {
    // E2E: the client encrypts with the shared secret; decrypt here so the relay never saw plaintext.
    try {
      return opts.secret && isSealed(payload) ? open(opts.secret, payload) : String(payload ?? "");
    } catch {
      return null; // wrong secret or tampered - can't run it
    }
  };
  const sealMaybe = (text: string) => (opts.secret ? seal(opts.secret, text) : text);

  // One instruction at a time regardless of transport: every job enters a FIFO and a single drainer
  // runs them (WS frames can arrive mid-turn; they must queue, not overlap the running turn).
  const jobs: { id: string; message: unknown }[] = [];
  let send: (frame: Record<string, unknown>) => void = () => {};
  let draining = false;
  const drain = async () => {
    if (draining) return;
    draining = true;
    while (running) {
      const job = jobs.shift();
      if (!job) break;
      const message = decrypt(job.message);
      if (message === null) {
        // Key mismatch: reply in PLAINTEXT on purpose - sealing an error about the wrong key with
        // that same wrong key would make it unreadable exactly when the user needs it most.
        send({ t: "reply", id: job.id, reply: "error: could not decrypt - the pairing secret doesn't match. On your machine run /relay (or /relay new) and re-scan the QR." });
        continue;
      }
      // Stream the terminal experience (ws only): assistant text deltas grow `buf`, tool calls land in
      // `act` (the same lines the terminal shows). Throttled PARTIAL frames carry both, sealed like the
      // final - the phone watches Neko WORK instead of staring at typing dots for minutes.
      let buf = "";
      const act: string[] = [];
      let timer: ReturnType<typeof setTimeout> | null = null;
      let ended = false;
      send({ t: "presence", meta: sealedMeta(true) });
      const envelope = () => sealMaybe(JSON.stringify({ text: buf, act: act.slice(-200) }));
      const flush = () => { timer = null; if (!ended) send({ t: "partial", id: job.id, reply: envelope() }); };
      const bump = () => { if (!timer) timer = setTimeout(flush, opts.partialMs ?? 600); };
      const onDelta = mode === "ws" ? (d: string) => { buf += d; bump(); } : undefined;
      const onAct = mode === "ws" ? (line: string) => { act.push(line); bump(); } : undefined;
      let result: { reply?: string; tokens?: number; ms?: number };
      try {
        result = await handlers.run(message, onDelta, onAct);
      } catch (e) {
        result = { reply: `error: ${e instanceof Error ? e.message : String(e)}` };
      }
      ended = true;
      if (timer) clearTimeout(timer);
      // Final frame: ws carries the same {text,act} envelope (the client keeps the process log) plus
      // the active model for the client's status bar; v1 poll stays a plain string (the old Worker's
      // client understands only that).
      buf = String(result.reply ?? "");
      const model = handlers.status?.().model;
      const finalEnvelope = () => sealMaybe(JSON.stringify({ text: buf, act: act.slice(-200), model }));
      send({ t: "reply", id: job.id, reply: mode === "ws" ? finalEnvelope() : sealMaybe(buf), tokens: result.tokens, ms: result.ms });
      send({ t: "presence", meta: sealedMeta(false) });
    }
    draining = false;
  };

  // ---- v1 transport: long-poll pull -> run -> reply (also the WSS-blocked fallback) ----
  const startPoll = () => {
    mode = "poll";
    send = (f) => {
      if (f.t !== "reply") return; // no partial channel in v1
      fetch(`${base}/reply`, { method: "POST", headers, body: JSON.stringify({ session, id: f.id, reply: f.reply, tokens: f.tokens, ms: f.ms }) })
        .catch(() => { /* relay dropped the reply - keep polling rather than crash */ });
    };
    const loop = async () => {
      while (running) {
        let job: { id?: string; message?: unknown } | null = null;
        try {
          const r = await fetch(`${base}/pull?session=${encodeURIComponent(session)}&host=${encodeURIComponent(hostId)}`, { headers, signal: ctrl.signal });
          if (!running) break;
          if (r.status === 401) { running = false; break; } // hub was revoked/rotated; do not poll forever
          if (r.ok) job = (await r.json()) as { id?: string; message?: unknown };
        } catch {
          if (!running) break;
          await sleep(idleMs); // backoff on a network error
          continue;
        }
        if (job?.id) {
          jobs.push(job as { id: string; message: unknown });
          await drain();
        } else if (running) {
          await sleep(idleMs); // no job (relay returned immediately) - pace re-polls
        }
      }
    };
    void loop();
  };

  // ---- v2 transport: hibernation-friendly WebSocket with reconnect ----
  const outbox: Record<string, unknown>[] = []; // frames to deliver once the socket is back
  let failures = 0; // consecutive connects that never opened
  const wsSend = (f: Record<string, unknown>) => {
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify(f)); return; } catch { /* fall through to outbox */ }
    }
    if (outbox.length < 200) outbox.push(f); // a reply must survive a mid-turn reconnect
  };
  const connect = () => {
    if (!running) return;
    let opened = false;
    const sock = new WebSocket(base.replace(/^http/, "ws") + `/ws?session=${encodeURIComponent(session)}&host=${encodeURIComponent(hostId)}`, ["neko-relay", `t.${token}`]);
    ws = sock;
    sock.onopen = () => {
      opened = true;
      failures = 0;
      try { sock.send(JSON.stringify({ t: "presence", meta: sealedMeta() })); } catch { /* reconnect will retry */ }
      for (const f of outbox.splice(0)) { try { sock.send(JSON.stringify(f)); } catch { break; } }
    };
    sock.onmessage = (ev) => {
      let m: any;
      try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m?.t === "interrupt") { handlers.interrupt(); return; } // phone Stop, mid-turn
      if (m?.id) { jobs.push(m); void drain(); }
    };
    sock.onerror = () => { /* the close event follows and handles it */ };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      if (!running) return;
      if (!opened && ++failures >= 3) { startPoll(); return; } // WSS blocked here - degrade honestly
      const backoff = opts.backoffMs ?? 1000;
      const delay = opened ? backoff : Math.min(backoff * 2 ** failures, 30_000);
      const t = setTimeout(connect, delay);
      (t as { unref?: () => void }).unref?.();
    };
  };

  if (v2) {
    send = wsSend;
    connect();
  } else {
    startPoll();
  }

  return {
    session,
    token,
    hostId,
    transport: () => mode,
    refresh: () => send({ t: "presence", meta: sealedMeta() }),
    publish: (event, publishOpts = {}) => send({
      t: "event",
      event: sealMaybe(JSON.stringify(event)),
      durable: !!publishOpts.durable,
      reset: !!publishOpts.reset,
    }),
    stop: () => {
      running = false;
      ctrl.abort();
      try { ws?.close(); } catch { /* already closed */ }
    },
  };
}
