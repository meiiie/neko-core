# Neko remote-relay (self-hosted) — drive Neko from any phone, no Tailscale, no open port

The professional cross-device pattern (how Claude Code Remote Control works): your local Neko **dials OUT**
to a relay — it never opens a listening port, so it works behind any NAT/firewall. Your phone talks to the
relay; the relay routes instructions to the agent and the reply back. Unlike a vendor cloud, **the relay is
YOUR Cloudflare Worker** — so you own the rendezvous, and it is end-to-end encrypted (a blind forwarder
that never reads your messages).

```
[phone/browser] --HTTPS--> [your Cloudflare Worker (relay)] <--outbound WebSocket-- [your machine: neko /relay]
```

**v5 controlled mirror (2026-07-11).** The browser now receives the same live state that drives Ink:
working/compacting state, current step, queued count, concurrent tool activity, permission mode, and
approval requests. Approval decisions use a separate E2E-sealed `/control` path, so they remain
responsive while the agent turn is blocked waiting for consent; stale/offline decisions are never
queued. Ink pickers for `/model`, `/provider`, `/effort`, `/resume`, and `/fps` reuse their existing
host callbacks through the same sealed control path; no second browser-side command state machine is
introduced. Up/Down prompt history and local-device `/copy` close the highest-impact terminal parity
gaps. Mirror sequence cursors detect duplicate or
missing durable frames, and public bodies, WebSocket frames, and offline queues are bounded.

**v4 session mirror (2026-07-11).** Bare `/relay` creates one durable capability for the current Neko
conversation. Its opaque session code and direct `/session/<id>` URL are distinct from every other
conversation. The browser first replays a bounded semantic transcript, then mirrors new user,
assistant, tool, and streaming activity live. The local TUI remains authoritative; reconnecting a
phone reconstructs the same conversation instead of a browser-only history. `/relay hub` explicitly
opts into the broader v3 multi-session switcher when that is actually wanted.

**v2 transport (2026-07-10, retained underneath).** Each host holds a hibernation-friendly **WebSocket** to the Worker: jobs
push instantly, the phone **watches the reply stream live** (throttled partial frames, still E2E-sealed),
and the phone's **Stop button interrupts a running turn**. The Durable Object **sleeps between messages**
(the old 1s long-poll kept it awake 24/7 — real duty-cycle on the free plan). Session state (token
binding, queued jobs, results) lives in **DO storage**, so an eviction no longer silently kills the
session; a message sent while your machine is offline is queued and runs on reconnect. The v1 long-poll
endpoints are kept: an older Neko binary still works against this Worker, and a v2/v3/v4/v5 Neko degrades to
long-poll against an older Worker (it reads the `/register` response's `v` field).

**Durable, least-privilege pairing.** `/relay` persists one session/token/secret under
`~/.neko-core/relay-sessions/` for each local conversation (gitignored). Restart or resume that
conversation and the same phone reconnects; sharing one conversation does not expose another.
`/relay new` revokes and rotates only the current capability. The legacy broad pairing lives in
`~/.neko-core/relay.json` and is used only by `/relay hub`.

Relay controls sessions that are already running with `/relay` enabled; it does not silently spawn a new
shell or privileged process on the computer. Remote process creation belongs in a future explicit
server mode with its own capacity, workspace, approval, and sandbox policy.

## Deploy the relay (once)
Needs a free Cloudflare account + [wrangler](https://developers.cloudflare.com/workers/wrangler/). Durable
Objects are used for per-session state (available on the free Workers plan).

```bash
cd cloudflare/relay
npx wrangler login
npx wrangler deploy      # prints the universal workers.dev bootstrap/rollback URL
```

## Use it
For production, attach a short [Workers Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
and keep `workers.dev` as a rollback endpoint. This Neko installation uses `https://relay.holilihu.online`.

1. On your machine: `neko chat`, then `/relay https://<your-relay-domain>`.
   It prints a short display code and a one-tap **session URL**
   (`…/session/<id>#t=…&k=…`). The token and E2E secret stay in the URL fragment.
   Neko now dials out and waits — no open port. The **secret** is the E2E key; it rides in the URL
   fragment, which browsers never send to the server.
2. On your phone: open the pairing URL (or open the Worker URL and paste session/token/secret), then
   type. Each message runs as a real turn on your machine (your files, tools, MCP) and the reply comes
   back — end-to-end encrypted the whole way.
3. Reload or reopen the URL: durable mirror events reconstruct the transcript before live events resume.
   If you intentionally want one link that can switch among several running terminals, enable each with
   `/relay hub`; drafts, transcripts, queues, and interrupts remain isolated per host.

`/relay new` revokes the current session capability before writing replacement keys, so its old link
loses access. `/relay hub new` rotates the broad hub and closes every joined host/client socket. If an
older v2 Worker lacks revocation, Neko warns instead of pretending rotation succeeded.

Or from any shell (no app):
```bash
ID=$(curl -s -H "Authorization: Bearer $TOKEN" $RELAY/send -d "{\"session\":\"$SESSION\",\"message\":\"run the tests\"}" | jq -r .id)
curl -s -H "Authorization: Bearer $TOKEN" "$RELAY/result?session=$SESSION&id=$ID" | jq -r .reply
# hub mode: GET /sessions lists hostId values; include hostId in /send and /interrupt
# more: GET /alive?host=... (is that host connected?) · POST /interrupt (stop) · POST /control (E2E approval)
# /result returns {reply,done,seq}; pass &seen=<seq> to long-poll only for NEWER state (partials stream)
```

## Upgrading from v1/v2
Just redeploy: `cd cloudflare/relay && npx wrangler deploy`. No migration needed (same Durable Object
class; state moves into DO storage on first use). Your phone's saved pairing keeps working — the client
page is served by the Worker, so it updates together.

## Security
- The host binds the session to the **first token** it registers; only that token can pull/send.
- Use a strong token (Neko generates a UUID). Anyone with the token + session can run code on your
  machine — treat it like an SSH key.
- The relay is yours, so only you control retention/logging. For zero-knowledge (the relay can't read
  your messages even in transit), see **end-to-end encryption** below.
- Session metadata, v4 mirror events, and v5 UI/control state are sealed at the host and decrypted only by the paired
  browser. The Worker stores an opaque `hostId`, ordering metadata, and a bounded ciphertext replay
  window solely to route and reconnect the session.

## End-to-end encryption (zero-knowledge relay)
Neko does not require trusting the relay operator with conversation plaintext.
`/relay` derives an AES-256-GCM key from the pairing **secret** (which never leaves your machine + phone),
and seals every message and reply before it reaches the Worker. The Worker forwards **only ciphertext** —
it cannot read anything, even in transit. The host (Neko, `src/adapters/relay-crypto.ts`) and the phone
client (WebCrypto in `client.html`) interoperate; tampered or wrong-secret payloads fail GCM authentication.

Proven by `test/relay-crypto.test.ts` (node ↔ browser interop, tamper/wrong-secret rejected),
`test/remote-relay.test.ts` (payload + metadata are sealed), and `test/relay-worker.test.ts`
(multi-host routing/queues and mirror replay stay isolated). This makes the rendezvous a blind
forwarder even when it stores encrypted reconnect state.
