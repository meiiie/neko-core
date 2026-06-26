# Neko remote-relay (self-hosted) — drive Neko from any phone, no Tailscale, no open port

The professional cross-device pattern (how Claude Code Remote Control works): your local Neko **dials OUT**
to a relay and long-polls for instructions — it never opens a listening port, so it works behind any
NAT/firewall. Your phone talks to the relay; the relay routes instructions to the polling agent and the
reply back. Unlike a vendor cloud, **the relay is YOUR Cloudflare Worker** — so you own the rendezvous,
and it can be made end-to-end encrypted (a blind forwarder that never reads your messages).

```
[phone/browser] --HTTPS--> [your Cloudflare Worker (relay)] <--outbound long-poll-- [your machine: neko /relay]
```

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
   It prints a **session** + **token** (and the phone URL). Neko now dials out and waits — no open port.
2. On your phone: open the Worker URL in a browser, enter the **session** + **token**, and type. Each
   message runs as a real turn on your machine (your files, tools, MCP) and the reply comes back.

Or from any shell (no app):
```bash
ID=$(curl -s -H "Authorization: Bearer $TOKEN" $RELAY/send -d "{\"session\":\"$SESSION\",\"message\":\"run the tests\"}" | jq -r .id)
curl -s -H "Authorization: Bearer $TOKEN" "$RELAY/result?session=$SESSION&id=$ID" | jq -r .reply
```

## Security
- The host binds the session to the **first token** it registers; only that token can pull/send.
- Use a strong token (Neko generates a UUID). Anyone with the token + session can run code on your
  machine — treat it like an SSH key.
- The relay is yours, so only you control retention/logging. For zero-knowledge (the relay can't read
  your messages even in transit), see **end-to-end encryption** below.

## End-to-end encryption (zero-knowledge relay) — beyond the vendor model
A vendor relay (e.g. Claude Code's) sees your messages + tool results in plaintext. Because this relay is
yours AND the protocol carries opaque payloads, you can encrypt each message with a shared secret (a
pairing code) so the Worker only ever forwards ciphertext — it cannot read anything. The host (Neko) and
the phone client share the secret; the relay is a blind forwarder. (Roadmap: G-series — the host side
encrypts/decrypts with AES-GCM derived from the pairing secret; the web client uses WebCrypto.)
