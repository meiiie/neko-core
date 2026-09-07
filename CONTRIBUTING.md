# Contributing to Neko Core

Thanks for being here — Neko is a small, friendly codebase and contributions of every size are welcome:
bug fixes, a new provider profile, a skill, docs, tests, or just a sharp issue.

Neko Core uses a dual-licensing model. Before a contribution to the core can
be merged, its licensing authority must satisfy
[CONTRIBUTOR-LICENSE-POLICY.md](CONTRIBUTOR-LICENSE-POLICY.md). Apache SDK
contributions are accepted only inside the explicit `sdk/` boundary.

## Get set up

You need [Bun](https://bun.sh) (the runtime + bundler + test runner).

```bash
git clone https://github.com/meiiie/neko-core
cd neko-core
bun install --frozen-lockfile
node bin/neko-source.cjs doctor # safe no-build source launcher (requires Node.js)
```

## The verify loop (must stay green)

Choose the checks in [the testing contract](docs/process/TESTING.md) for your change.
Documentation-only PRs need link/path checks and diff review. The full code/release gate is:

```bash
bun run typecheck          # tsc --noEmit
bun run lint               # anti-slop and trust-boundary checks
bun test                   # the test suite
node bin/neko-source.cjs doctor # read-only resolved setup diagnostics
node bin/neko-source.cjs policy # audits the safe/gated tool boundary
bun run build              # bun build --compile -> dist/neko (the shipped single binary)
```

Add meaningful regressions for behavior changes. Avoid tests that mirror prose or implementation;
do not repeat a passing check without a relevant change or unresolved concern. Match the surrounding style.

## How it's built

Ports & Adapters — dependencies point **inward**, enforced by `test/architecture.test.ts`:

- `src/core/` — pure domain (the agent loop, tools, permissions). No I/O, no adapters.
- `src/adapters/` — the edges (providers, config, MCP, sessions, …).
- `src/ui/` — the Ink terminal UI.
- `bin/neko.ts` — the CLI entry point.

A **new model or endpoint is a config profile, not code** (`src/adapters/config.ts`). The full map is in
[`docs/process/ARCHITECTURE.md`](docs/process/ARCHITECTURE.md); the roadmap and working notes live under
[`docs/process/`](docs/process/) (start with `ROADMAP.md` and `RULES.md`).

## Ground rules

- **Secrets never get committed or printed.** API keys come from env (`NEKO_API_KEY` /
  `OPENAI_API_KEY` / `NVIDIA_API_KEY`) or a gitignored `~/.neko-core/config.json`. Scan before you push.
- **Clean-room.** Study other agents for *ideas*, never copy proprietary code into this repo.
- **Consequence-gated.** Host Bash is the default; optional OS sandboxing fails closed.
  Preserve mode, structured-file, credential, seatbelt, and ACP host boundaries as defined in
  [SANDBOX.md](docs/process/SANDBOX.md). Host shell execution is not filesystem containment.
- **Windows-friendly output.** Keep legacy plain CLI diagnostics ASCII-compatible. Source/docs use
  UTF-8; the Unicode TUI and Vietnamese text must retain their correct characters.

## Sending a PR

1. Branch off `main`.
2. Make a focused change and run its required checks.
3. Use a clear commit message (we like Conventional Commits: `fix(ui): …`, `feat(core): …`).
4. Open the PR describing **what** and **why**. CI runs typecheck + tests on every push.

Not sure where to start? Open an issue describing what you'd like to do, or look for `good first issue`.
Small, focused PRs get reviewed fastest. Thank you!
