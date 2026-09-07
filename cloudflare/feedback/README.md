# Private feedback intake

A dedicated Worker, not a public feedback board. Contract and privacy policy:
[FEEDBACK.md](../../docs/process/FEEDBACK.md). This package and its development
dependencies are separate from the Neko CLI runtime. No core/provider/tool authority
changes are needed for delivery.

## Deployed state

- Endpoint: `https://neko-feedback.holilihu.online/v1/feedback`
- Worker: `neko-feedback`; version `c3da976c-c51b-4884-8d81-ba17e2e230e9` (2026-09-07).
- D1: `neko-feedback`, APAC; only deduplication/quota metadata, not email payloads.
- Receiver: `meiiiekhp888@gmail.com`, verified Email Routing destination.
- Required Worker secret: `IP_HASH_KEY`; never put its value in this repo or CLI.
- Workers Free / verified-destination route; no paid-plan upgrade.

The real email binding accepted synthetic reports `e973d74d-d6f4-4c39-8013-f01fa9618a53`
(454 bytes) and `a5168056-820f-49b1-889d-2272b0631b74` (500,512 bytes). Repeating each
payload returned the existing receipt. There are two accepted D1 rows, not four.
This is not independent verification of Gmail Inbox placement.

## Verify and deploy

Install root development dependencies first. Then, from this directory:

```sh
bun install --frozen-lockfile
bun run check
bun run test:integration
```

Integration uses local workerd/D1/Email bindings through the Miniflare version
resolved by the pinned Wrangler package; it sends no real email. It verifies
concurrent admission/deduplication, unknown outcomes, malformed/oversized reports,
fixed-recipient boundaries, exact daily quotas, and absence of payloads in D1.
Node 22+ is required; the verified workstation used Node 25.9.0 and Bun 1.4.0.

For an authorized deployment only:

```sh
bunx wrangler d1 migrations apply neko-feedback --remote
bun run deploy
```

The migration targets the dedicated database in `wrangler.jsonc`. The secret already
exists remotely; do not regenerate it on ordinary deploys. A fresh installation needs
a cryptographically random `IP_HASH_KEY` supplied to `wrangler secret put` via stdin,
not an argument, source file, transcript, or CLI credential. Keep email restrictions,
the D1 binding, custom domain and scheduled cleanup enabled. Do not point this config
at an unrelated existing Worker or change the site's general email-routing rules.

An explicit live smoke test sends one synthetic email per invocation, not a user log:

```sh
bun smoke.ts --send-synthetic
bun smoke.ts --send-synthetic --large
```

Each also resubmits the identical payload to check the existing receipt. Do not rerun
automatically after an unknown outcome: each invocation creates a new report ID.
Do not put live smoke in CI. Confirm the received email/attachment separately.

## Operations

`GET /health` only proves the handler is running, not that email/D1 are healthy.
`POST /v1/feedback/status` requires the report ID and SHA-256 of its exact compact
JSON body. Responses never include the payload. `accepted` means the Email binding
resolved successfully, not that an end user read the message.

Pending/unknown receipts must not be replayed automatically or deleted to force retry.
There is no persistent email payload queue. Service interruption may require manual
handling of the user's saved report after checking whether the original arrived.

For an incident, remove the dedicated Worker custom-domain route to stop intake;
local exports still work. Preserve receipts until their retention period expires.
Inspect constant event names and receipt state, never turn on body/header logging
to diagnose user reports. Any change to recipient, retention, log inclusion or abuse
limits must update the user-facing disclosure and privacy contract.
