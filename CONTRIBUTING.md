# Contributing to Neko Code

Thanks for being here — Neko is a small, friendly codebase and contributions of every size are welcome:
bug fixes, a new provider profile, a skill, docs, tests, or just a sharp issue.

## Get set up

You need [Bun](https://bun.sh) (the runtime + bundler + test runner).

```bash
git clone https://github.com/meiiie/neko-core
cd neko-core
bun install
bun bin/neko.ts doctor     # run directly via Bun — no build needed for development
```

## The verify loop (must stay green)

Before you open a PR, all of these should pass:

```bash
bun run typecheck          # tsc --noEmit
bun test                   # the test suite
bun bin/neko.ts policy     # audits the safe/gated tool boundary
bun run build              # bun build --compile -> dist/neko (the shipped single binary)
```

Add a test for anything you change — the suite is fast and the bar is "a reviewer can trust it without
re-running it by hand". Match the style of the code around you (naming, comment density, idiom).

## How it's built

Ports & Adapters — dependencies point **inward**, enforced by `test/architecture.test.ts`:

- `src/core/` — pure domain (the agent loop, tools, permissions). No I/O, no adapters.
- `src/adapters/` — the edges (providers, config, MCP, sessions, …).
- `src/ui/` — the Ink terminal UI.
- `bin/neko.ts` — the CLI entry point.

A **new model or endpoint is a config profile, not code** (`src/adapters/config.ts`). The full map is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the roadmap and working notes live under
[`docs/process/`](docs/process/) (start with `ROADMAP.md` and `RULES.md`).

## Ground rules

- **Secrets never get committed or printed.** API keys come from env (`NEKO_API_KEY` /
  `OPENAI_API_KEY` / `NVIDIA_API_KEY`) or a gitignored `~/.neko-core/config.json`. Scan before you push.
- **Clean-room.** Study other agents for *ideas*, never copy proprietary code into this repo.
- **Safe-by-default.** `write_file` / `edit` / `bash` are approval-gated; keep that boundary
  (`bun bin/neko.ts policy` must stay PASS).
- **Windows-friendly output.** Printed (non-TUI) strings should be ASCII — the Windows console is cp1252,
  so an em-dash or fancy quote can mojibake.

## Sending a PR

1. Branch off `main`.
2. Make the change + a test; keep the verify loop green.
3. Use a clear commit message (we like Conventional Commits: `fix(ui): …`, `feat(core): …`).
4. Open the PR describing **what** and **why**. CI runs typecheck + tests on every push.

Not sure where to start? Open an issue describing what you'd like to do, or look for `good first issue`.
Small, focused PRs get reviewed fastest. Thank you! 🐾
