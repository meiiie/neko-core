# Neko remote-relay (self-hosted) — drive Neko from any phone, no Tailscale, no open port

The professional cross-device pattern (how Claude Code Remote Control works): your local Neko **dials OUT**
to a relay — it never opens a listening port, so it works behind any NAT/firewall. Your phone talks to the
relay; the relay routes instructions to the agent and the reply back. Unlike a vendor cloud, **the relay is
YOUR Cloudflare Worker** — so you own the rendezvous, and it is end-to-end encrypted (a blind forwarder
that never reads your messages).

```
[phone/browser] --HTTPS--> [your Cloudflare Worker (relay)] <--outbound WebSocket-- [your machine: neko /relay]
```

**v3 multi-session hub (2026-07-11).** One durable pairing now controls every Neko terminal that has
`/relay` enabled. Each running process registers an opaque host id; the phone lists session title,
project path, model, online/busy state, keeps a separate draft + transcript per session, and can run
turns concurrently or Stop exactly one session. Title/path/model/busy metadata is E2E-sealed too, so
the Worker sees only opaque ids, timestamps, and ciphertext. Offline queues are isolated per host.

**v2 transport (2026-07-10, retained underneath).** Each host holds a hibernation-friendly **WebSocket** to the Worker: jobs
push instantly, the phone **watches the reply stream live** (throttled partial frames, still E2E-sealed),
and the phone's **Stop button interrupts a running turn**. The Durable Object **sleeps between messages**
(the old 1s long-poll kept it awake 24/7 — real duty-cycle on the free plan). Session state (token
binding, queued jobs, results) lives in **DO storage**, so an eviction no longer silently kills the
session; a message sent while your machine is offline is queued and runs on reconnect. The v1 long-poll
endpoints are kept: an older Neko binary still works against this Worker, and a v2/v3 Neko degrades to
long-poll against an older Worker (it reads the `/register` response's `v` field).

**Durable pairing.** `/relay` persists session/token/secret in `~/.neko-core/relay.json` (gitignored) —
restart Neko and an already-paired phone reconnects by itself, no re-scanning. `/relay new` rotates the
pairing (old phones disconnect).

v3 controls sessions that are already running with `/relay` enabled; it does not silently spawn a new
shell or privileged process on the computer. Remote process creation belongs in a future explicit
server mode with its own capacity, workspace, approval, and sandbox policy.

## Deploy the relay (once)
Needs a free Cloudflare account + [wrangler](https://developers.cloudflare.com/workers/wrangler/). Durable
Objects are used for per-session state (available on the free Workers plan).

```bash
cd cloudflare/relay
npx wrangler login
npx wrangler deploy      # prints your URL, e.g. https://neko-relay.<you>.workers.dev
```

## Use it
1. On your machine: `neko chat`, then `/relay https://neko-relay.<you>.workers.dev`.
   It prints a one-tap **pairing URL** (`…/#s=…&t=…&k=…`) plus the **session** + **token** + **secret**.
   Neko now dials out and waits — no open port. The **secret** is the E2E key; it rides in the URL
   fragment, which browsers never send to the server.
2. On your phone: open the pairing URL (or open the Worker URL and paste session/token/secret), then
   type. Each message runs as a real turn on your machine (your files, tools, MCP) and the reply comes
   back — end-to-end encrypted the whole way.
3. Enable `/relay` in another Neko terminal with the same persisted pairing. The session count appears
   in the header; switch sessions without losing either draft or transcript. Running one session does
   not block another.

`/relay new` revokes the old hub before writing replacement keys: old phones lose access and every old
host socket is closed. Other running terminals must toggle `/relay` once to join the new pairing. If an
older v2 Worker lacks revocation, Neko warns instead of pretending the other terminals were rotated.

Or from any shell (no app):
```bash
ID=$(curl -s -H "Authorization: Bearer $TOKEN" $RELAY/send -d "{\"session\":\"$SESSION\",\"message\":\"run the tests\"}" | jq -r .id)
curl -s -H "Authorization: Bearer $TOKEN" "$RELAY/result?session=$SESSION&id=$ID" | jq -r .reply
# v3: GET /sessions lists hostId values; include hostId in /send and /interrupt
# more: GET /alive?host=... (is that host connected?) · POST /interrupt (stop that host's turn)
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
- v3 session metadata (title, cwd, model, busy state) is sealed at the host and decrypted only by the
  paired browser. The Worker stores an opaque `hostId` solely to route traffic.

## End-to-end encryption (zero-knowledge relay) — beyond the vendor model
A vendor relay (e.g. Claude Code's) sees your messages + tool results in plaintext. **This one does not.**
`/relay` derives an AES-256-GCM key from the pairing **secret** (which never leaves your machine + phone),
and seals every message and reply before it reaches the Worker. The Worker forwards **only ciphertext** —
it cannot read anything, even in transit. The host (Neko, `src/adapters/relay-crypto.ts`) and the phone
client (WebCrypto in `client.html`) interoperate; tampered or wrong-secret payloads fail GCM authentication.

Proven by `test/relay-crypto.test.ts` (node ↔ browser interop, tamper/wrong-secret rejected),
`test/remote-relay.test.ts` (payload + metadata are sealed), and `test/relay-worker.test.ts`
(multi-host routing/queues stay isolated). This makes the
rendezvous a true blind forwarder: **more private than the vendor model**, where the platform reads your
messages.
