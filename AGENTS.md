# Neko Core — repository instructions

Neko Core is a local-first coding agent: TypeScript + Bun + Ink, package `neko-core`,
command `neko`. This file governs work on the repository; it does not select Neko's
runtime model or grant its tools permissions.

## Start and finish

- Read [working rules](docs/process/RULES.md) and [current state](docs/process/ROADMAP.md),
  then only the subsystem documents needed for the task. [Docs index](docs/README.md).
- Check `git status --short` and recent commits before editing. Preserve existing work.
  Verify release claims against GitHub; a version string alone does not prove publication.
- Follow the latest user request. Continue authorized work with reasonable assumptions;
  ask when a missing choice changes scope, authority, or a major architectural decision.
- Work solo unless the owner explicitly requests delegation. Batch independent reads
  when useful; keep resource-heavy checks sequential on this workstation.
- Define the observable outcome, make a focused change, verify it, and review the diff.
  Report results and remaining blockers concisely in the user's language.
- Skills guide execution within the task. Explicit user instructions take precedence
  over skill guidelines, subject to system/developer constraints. Identify the exact
  skill instruction if it causes a pause or change of direction.

## Where to work

| Concern | Entry points |
|---|---|
| Loop, tools, authority | `src/core/agent.ts`, `ports.ts`, `tools.ts`, `tool-runtime.ts`, `permissions.ts` |
| Runtime, profiles, transport | `src/adapters/agent-runtime.ts`, `tool-registry.ts`, `config.ts`, `providers.ts` |
| Completion experiments | `src/adapters/completion-supervisor.ts`, [evaluation policy](docs/process/EVALUATION.md) |
| Sessions, clients, Wiii | `src/adapters/session.ts`, `acp.ts`, `acp-computer.ts`, [ACP](docs/process/ACP.md) |
| Terminal | `src/ui/`, `bin/neko-source.cjs`, `bin/neko.ts` |
| Delivery | `src/adapters/update.ts`, `install.ps1`, `install.sh`, `.github/workflows/` |

See [harness architecture](docs/HARNESS-ARCHITECTURE.md) for context, persistence,
extension seams, and lifecycle. Dependencies point inward; core must not import adapters/UI.

## Non-negotiables

- `E:\Sach\Sua\bang_c` is frozen. Reference clones in `../neko-refs/` and `reference/python/`
  are study material. Never copy proprietary implementation into this public repo.
- Keep secrets out of prompts, transcripts, logs, commits, and reports. The redacted
  pre-push scan is specified in [RELEASE.md](docs/process/RELEASE.md).
- Prefer config profiles for compatible endpoints; new protocols belong in adapters.
- Normal Neko uses host Bash by default. Explicit sandboxing must fail closed. Keep
  permission modes, structured-file bounds, ACP host isolation, and secret/seatbelt
  checks intact; [SANDBOX.md](docs/process/SANDBOX.md) defines their distinct scopes.
- Preserve the founding principle in [SOVEREIGNTY.md](docs/process/SOVEREIGNTY.md).
- ProgramBench is paused until the owner explicitly resumes it. Never launch a paid
  campaign or `scripts/self-improve.ts` as routine verification. Preserve frozen evidence.

## Verification

Use `rtk` if available; otherwise run the underlying command directly. Read/write docs
as UTF-8. Follow [TESTING.md](docs/process/TESTING.md) for the check scope:
docs-only changes need link/path checks, stale-guidance review, and `git diff --check`;
behavior changes need relevant regressions; releases require the complete gate.
Once sufficient checks pass, repeat or broaden only for new changes or unresolved risk.

Full gate: `bun run typecheck`, `bun run lint`, `bun test`,
`node bin/neko-source.cjs doctor`, `node bin/neko-source.cjs policy`, `bun run build`.
Use the Bun version pinned in CI. Do not substitute the frozen Python reference tests.
Commit/push/release only within the user's requested scope; follow [RELEASE.md](docs/process/RELEASE.md).
