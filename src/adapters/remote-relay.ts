/**
 * /remote-relay — drive Neko from ANY device (phone/browser, no Tailscale, no open port) the way Claude
 * Code Remote Control works: the local agent dials OUT to a relay you host (your own Cloudflare Worker),
 * registers a session, and LONG-POLLS for instructions — it never opens a listening port, so it works
 * behind any NAT/firewall. A client (your phone) sends instructions to the same relay; the relay routes
 * them to the polling agent and returns the reply. Because the relay is YOURS (not a vendor's) and
 * payloads can be end-to-end encrypted, the relay is a blind forwarder — more private than a vendor
 * cloud that sees your messages. This module is the host (agent) side; it reuses RemoteHandlers.
 *
 * Relay protocol (the Worker implements these; all authed with `Authorization: Bearer <token>`):
 *   POST /register {session}                       host announces a session
 *   GET  /pull?session=...        -> {id,message}  host long-polls for the next instruction ({} = none)
 *   POST /reply {session,id,...}                   host returns a turn's result
 *   POST /send {session,message}  -> {id}          client submits an instruction (queued for the host)
 *   GET  /result?session=&id=...                   client long-polls for the matching reply
 */
import { randomUUID } from "node:crypto";
import type { RemoteHandlers } from "./remote-control.ts";

export interface RemoteRelay {
  session: string;
  token: string;
  stop: () => void;
}

export async function startRemoteRelay(
  relayUrl: string,
  handlers: RemoteHandlers,
  opts: { session?: string; token?: string; pollMs?: number } = {},
): Promise<RemoteRelay> {
  const base = relayUrl.replace(/\/+$/, "");
  const session = opts.session ?? randomUUID();
  const token = opts.token ?? randomUUID();
  const headers = { "content-type": "application/json", authorization: `Bearer ${token}` };

  // Register (outbound). Throw if the relay is unreachable so /relay can report it to the user.
  const reg = await fetch(`${base}/register`, { method: "POST", headers, body: JSON.stringify({ session }) });
  if (!reg.ok) throw new Error(`relay register failed: HTTP ${reg.status}`);

  let running = true;
  const ctrl = new AbortController();
  const idleMs = opts.pollMs ?? 1000;

  const loop = async () => {
    while (running) {
      let job: { id?: string; message?: string } | null = null;
      try {
        const r = await fetch(`${base}/pull?session=${encodeURIComponent(session)}`, { headers, signal: ctrl.signal });
        if (!running) break;
        if (r.ok) job = (await r.json()) as { id?: string; message?: string };
      } catch {
        if (!running) break;
        await new Promise((res) => setTimeout(res, idleMs)); // backoff on a network error
        continue;
      }
      if (job?.id) {
        // One instruction at a time (the loop is naturally serialized — no overlapping turns).
        let result;
        try {
          result = await handlers.run(String(job.message ?? ""));
        } catch (e) {
          result = { reply: `error: ${e instanceof Error ? e.message : String(e)}` };
        }
        try {
          await fetch(`${base}/reply`, { method: "POST", headers, body: JSON.stringify({ session, id: job.id, ...result }) });
        } catch {
          /* relay dropped the reply — keep polling rather than crash */
        }
      } else if (running) {
        await new Promise((res) => setTimeout(res, idleMs)); // no job (relay returned immediately) — pace re-polls
      }
    }
  };
  loop();

  return {
    session,
    token,
    stop: () => {
      running = false;
      ctrl.abort();
    },
  };
}
