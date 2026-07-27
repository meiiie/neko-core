# The Oracle — a second opinion, on purpose

Neko is the executor: it has the tools, the machine, and the short leash. The **oracle** is the opposite
kind of thing — one expensive question to a *different, stronger* model, which gets a curated slice of the
project and **no tools at all**. It cannot read, write, or run anything. It reads what you send and
returns judgement.

This is the split that makes the "big model plans, executor builds" loop work. If the advisor also had
tools it would just be a second agent, and you would be paying twice for the same context.

## Turning it on

Which model is "the strong one" is your call, so there is no default:

```json
// ~/.neko-core/config.json  (or ./neko.json for one project)
{ "oracle": { "profile": "claude" } }
```

Any profile works — `neko profiles` lists them. Pick a **different family** from the one you code with;
an oracle that shares your model's blind spots has nothing to add. Optional knobs, with their defaults:

```json
{ "oracle": { "profile": "claude", "model": "", "max_bytes": 400000, "max_file_bytes": 128000, "max_files": 80 } }
```

## Asking

```bash
neko oracle -p "why does the live transcript stall when one channel is silent?" \
            -f "src/adapters/meeting-live.ts" -f "src/adapters/meeting-*.ts" -f "!**/*.test.ts"

neko oracle --dry-run -p "..." -f "src/**/*.ts"     # print exactly what would be sent, send nothing
neko oracle --profile gemini -p "..."               # use that profile as the oracle just this once
neko oracle --followup orc_...  -p "I tried that."  # push back; the thread is replayed
neko oracle sessions                                # what you have asked before
neko oracle show orc_...                            # question, files sent, and the answer
```

Inside a session, Neko can consult the oracle itself when it is stuck
(`mcp__neko_oracle__consult`). That call is **approval-gated**, because it ships source code off the
machine — the same bar as `write_file` and `bash`. Reading past consultations is safe and ungated.

## What leaves the machine, and what does not

The manifest prints before anything is sent, with or without `--dry-run`:

```
Bundle: 2 file(s), 25 KB, about 6k tokens.
  + src/adapters/oracle.ts (19 KB, 1 masked)
  + src/adapters/oracle-tools.ts (6 KB)
  - .env: refused: looks like a credential store
```

Three rules, all enforced in `src/adapters/oracle.ts`:

- **Secret stores are refused whole.** `.env*`, `*.pem`/`*.key`/`*.p12`, `id_rsa`, `.npmrc`, `.netrc`,
  anything under `.neko-core/`, and any file containing a `BEGIN … PRIVATE KEY` block. Masking those
  would leave nothing worth reading anyway.
- **Credential-shaped literals are masked in place**, so an ordinary source file stays useful. Only
  string *values* are touched: `apiKey = "sk-live-…"` becomes `<redacted>`, while
  `key = process.env.OPENAI_API_KEY` and `` `Bearer ${token}` `` are left exactly as written — masking
  those would corrupt the very code the oracle is being asked to reason about.
- **Over budget drops whole files and names them.** The oracle is never handed half a module without
  being told it is half; every exclusion is listed in the payload under `<not-included>` so a
  dependent answer says "I need that file" instead of guessing.

Consultations are stored under `~/.neko-core/oracle/<id>/` as `meta.json`, `bundle.md` (the exact bytes
sent), and `answer.md`.

## What it is not

The oracle sees **only** the bundle. It does not know your git history, your other files, your runtime,
or anything you did not attach. Its plan is a hypothesis from a partial view — verify against the real
files before acting. The tool output says so on every call, and the system prompt tells the oracle to
list what it could not determine rather than invent a path.

Note on model naming: "Pro" in a ChatGPT plan is not an API model id. On the surfaces Neko can reach the
GPT-5.6 family is `gpt-5.6-sol` / `-terra` / `-luna`, with reasoning effort up to `xhigh`. If you want a
genuinely independent opinion, change **family**, not effort.
