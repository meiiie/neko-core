# Deploy the Neko relay to Cloudflare Workers — runbook for an agent (Codex)

This is a **self-contained deployment task**. Follow it end-to-end and report the resulting URL.
You are deploying a small Cloudflare Worker that acts as a **rendezvous relay** so the user can drive
their local Neko coding agent from a phone (no open port on their machine). The local agent dials OUT and
long-polls; the phone POSTs instructions; this Worker routes them. Payloads are end-to-end encrypted, so
the Worker only ever forwards ciphertext — **do not add any logging of message bodies.**

---

## 0. Where the code is

Repo: `https://github.com/meiiie/neko-core` (branch `main`). All files for this task are in
**`cloudflare/relay/`**. If you are working in your own sandbox, clone the repo first:

```bash
git clone https://github.com/meiiie/neko-core
cd neko-core/cloudflare/relay
```

If you are connected to the user's machine, the repo is at `E:/Sach/Sua/NekoCore`; the files are in
`E:/Sach/Sua/NekoCore/cloudflare/relay`.

**Do not modify** `worker.js`, `client.html`, or `wrangler.toml` — they are complete and correct. Your
job is only to authenticate and deploy.

Files present (for your reference):
- `worker.js` — the relay Worker. Exports a `fetch` handler + a `RelaySession` Durable Object class.
- `client.html` — a mobile web client served at `/` (imported into the Worker as a text module).
- `wrangler.toml` — the deploy config. It already declares the Durable Object as **SQLite-backed**
  (`new_sqlite_classes`), which is required for the **free** Workers plan. Do not change this to
  `new_classes` (that needs a paid plan).

Expected `wrangler.toml` (verify it matches before deploying):
```toml
name = "neko-relay"
main = "worker.js"
compatibility_date = "2026-01-01"

[[rules]]
type = "Text"
globs = ["**/*.html"]
fallthrough = true

[[durable_objects.bindings]]
name = "RELAY"
class_name = "RelaySession"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["RelaySession"]
```

---

## 1. Prerequisites

- **Node.js 18+** (check: `node --version`). `wrangler` is run via `npx`, no global install needed.
- A **Cloudflare account** (the free plan is sufficient). The account must have a **workers.dev
  subdomain** enabled (see Troubleshooting if the first deploy complains about this).

---

## 2. Authenticate (choose ONE)

### Option A — API token (preferred for an agent; non-interactive)

1. The user creates a token at <https://dash.cloudflare.com/profile/api-tokens> →
   **Create Token** → use the **"Edit Cloudflare Workers"** template → **Continue** →
   under *Account Resources* pick their account → **Continue** → **Create Token** → copy it.
   (That template grants `Account › Workers Scripts › Edit`, which covers Durable Object deploys.)
2. Export it in the shell you will run wrangler from (do **not** print it back, do **not** commit it):
   ```bash
   export CLOUDFLARE_API_TOKEN="<the token>"
   # If the account has more than one account ID, also:
   # export CLOUDFLARE_ACCOUNT_ID="<account id from the dashboard URL or `npx wrangler whoami`>"
   ```
3. Verify:
   ```bash
   npx --yes wrangler whoami
   ```
   It should print the account name/id. If it errors, the token is wrong or lacks permissions.

### Option B — Interactive login (only if a human with a browser is present)

```bash
npx --yes wrangler login   # opens a browser; click "Allow"
```

---

## 3. Deploy

```bash
cd cloudflare/relay      # the directory containing wrangler.toml
npx --yes wrangler deploy
```

Expected tail of the output (the exact subdomain depends on the account):
```
Uploaded neko-relay (x.xx sec)
Deployed neko-relay triggers (x.xx sec)
  https://neko-relay.<account-subdomain>.workers.dev
Current Version ID: ...
```

**Record that `https://neko-relay.<...>.workers.dev` URL — it is the deliverable.**

---

## 4. Verify it is live

```bash
# 4a. The root serves the mobile web client (HTML, HTTP 200):
curl -s -o /dev/null -w "%{http_code}\n" https://neko-relay.<...>.workers.dev/        # expect 200

# 4b. An unauthenticated control call is rejected (HTTP 401):
curl -s -o /dev/null -w "%{http_code}\n" https://neko-relay.<...>.workers.dev/alive?session=test   # expect 401
```

If 4a returns 200 and 4b returns 401, the relay is deployed and working.

> A full round-trip (a real instruction) also needs the user's local `neko chat` → `/relay` to be
> running; you do not need to test that — just confirm the two curls above.

---

## 5. Report back

Reply with exactly:
- the deployed URL: `https://neko-relay.<...>.workers.dev`
- the results of the two curls in step 4 (the HTTP codes)
- any errors encountered

The user will then set `relay_url` to that URL in `~/.neko-core/config.json` and pair their phone.

---

## Troubleshooting

- **"You need to register a workers.dev subdomain"** — the account has no subdomain yet. The user opens
  <https://dash.cloudflare.com> → **Workers & Pages** → **Overview**, and sets a subdomain once (e.g.
  `account-name`). Then re-run `npx --yes wrangler deploy`.
- **Durable Object / migration error** (e.g. "Durable Objects on the free plan must use SQLite storage")
  — confirm `wrangler.toml` uses `new_sqlite_classes = ["RelaySession"]` (NOT `new_classes`). It already
  does; do not change it.
- **`Authentication error [code: 10000]`** — the API token is missing/expired or lacks `Workers
  Scripts:Edit`. Recreate it with the "Edit Cloudflare Workers" template.
- **Multiple accounts / "more than one account"** — set `CLOUDFLARE_ACCOUNT_ID` (find it via
  `npx wrangler whoami` or the dashboard URL `dash.cloudflare.com/<account-id>`).
- **`wrangler` version prompt / Node too old** — use Node 18+; `npx --yes wrangler@latest deploy`.
- **Text module / `import CLIENT_HTML from "./client.html"` fails** — ensure the `[[rules]] type="Text"`
  block is present in `wrangler.toml` (it is, in the expected content above).

## Security (must follow)
- **Never commit or print the `CLOUDFLARE_API_TOKEN`.** It grants deploy access to the account.
- **Do not add request/response body logging to `worker.js`.** The relay is intentionally a blind
  forwarder (payloads are end-to-end encrypted); logging bodies would defeat that — and they are
  ciphertext anyway.
- Deleting the Worker later: `npx --yes wrangler delete` from this directory.
