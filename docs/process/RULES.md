# Neko Core — Working Rules

Conventions for anyone (human or AI) developing Neko Core. Start at
[AGENTS.md](../../AGENTS.md); `CLAUDE.md` points to the same instructions.
Current state lives in [ROADMAP.md](ROADMAP.md), engineering history in
[WORKLOG.md](WORKLOG.md), and benchmark evidence in [EVALUATION.md](EVALUATION.md).

## Process
- **Solo by default.** Do the work directly unless the owner explicitly requests
  delegation. Background commands are allowed within scope; an autonomous campaign
  requires separate owner direction.
- **Run + commit incrementally.** One logical change per commit, a clear message, and
  verify *before* committing.
- **Ask before large architecture decisions.** Surface the tradeoffs; never pick silently
  (e.g. the language/runtime choice). The owner decides.
- **Karpathy guidelines:** think before coding (state assumptions, surface tradeoffs);
  simplest code that solves it; surgical changes (touch only what's needed); goal-driven
  (define success, verify by running).

## Product & code
- **Config-first.** Behaviour lives in config (`DEFAULTS` + profiles + overlays), not code.
  A new model/endpoint is a profile, not a code change.
- **Provider-agnostic, auto-by-default.** The default mode is `auto`. Ordinary auto
  still asks for host Computer control; explicit `--yolo` pre-authorizes approval
  prompts while auto remains active. Hard denials and host-profile restrictions
  remain independent. `plan` is read-only. Set `"mode": "default"` for prompt-first
  behavior. Read [SANDBOX.md](SANDBOX.md) before changing these boundaries.
- **Bash-first host routing (owner, 2026-09-04).** Ordinary `neko` and `neko --yolo` run Bash on the same host
  and identity as Neko, with hidden Windows child consoles and explicit background-process support. Computer Use
  is GUI-only and never a shell fallback. `sandbox: true` is an explicit fail-closed containment policy; it must
  never silently widen to host execution. Completion reviewers remain read-only and sandboxed, and ProgramBench
  retains its separate cleanroom.
- **`bang_c` is FROZEN.** Read it to port; never edit it. Drop MCQ/contest cruft
  (`rag_*`, `tiered_*`, `rubric`, `profiling`, `pred.csv`).

## Architecture (see `ARCHITECTURE.md`)
- **Ports & Adapters, dependencies point inward.** Core (`agent`, `tools`, `tool-runtime`,
  `permissions`, `cost`, `registry`) depends only on *interfaces* (`Provider`, `ToolRegistry`,
  `ApprovalGate`) — **never** on `ui/` or a UI framework. Enforced by `test/architecture.test.ts`.
- **Adapters at the edge.** Anything that touches the outside world (HTTP, MCP, disk, config)
  is an adapter; swap a backend by adding an adapter, not by editing the core.
- **Extend by the seams.** Use [EXTENDING.md](../EXTENDING.md) and the relevant runtime
  composition path. Do not bypass the tool registry from a provider, client, or UI.

## Code laws
- **Clean code, lazy by default (ponytail).** Stop at the first rung that works; no
  speculative abstraction, no config for a constant, no interface with one impl. Deletion
  over addition. Shortest working diff wins.
- **One responsibility per module; small files.** If a file does two jobs, split it. Match the
  surrounding style; don't reformat untouched code.
- **TypeScript stays strict** (`tsc --noEmit` clean — no `any` leaks at boundaries, no `// @ts-ignore`
  without a reason).
- **Validate at trust boundaries; never swallow data-loss errors.** Tool args, config JSON,
  API responses, and path escapes are checked. Credentials may persist in their dedicated
  local auth/config stores; never copy them into logs, project docs, or model context.
- **Test behavior and boundaries.** A test should catch a distinct regression, not mirror
  an implementation. Verification scope is defined in [TESTING.md](TESTING.md).

## Founding principle (permanent — never remove)
- **Vietnam sovereignty.** Neko Core is a Vietnamese product and respects Vietnam's sovereignty:
  the Hoàng Sa (Paracel) and Trường Sa (Spratly) archipelagos belong to Vietnam — a matter of
  sovereignty, not a dispute. Held respectfully and consistently, and NOT raised in unrelated
  conversations. When writing Vietnamese: full diacritics, correct spelling/meaning, natural
  localized phrasing. Enforced in `DEFAULT_SYSTEM_PROMPT`, `DEFAULT_GLOBAL_NEKO_MD`, the `LICENSE`
  founding notice, and a regression-guard test. **Do not remove or weaken it in any release.**
  Full text: `docs/process/SOVEREIGNTY.md`.

## Safety
- **Secrets never committed or printed.** Key via env (`NEKO_API_KEY` / `OPENAI_API_KEY` /
  `NVIDIA_API_KEY`) or the gitignored `~/.neko-core/config.json`. Use the redacted
  gitleaks commands in [RELEASE.md](RELEASE.md) before an authorized public push.
- **Windows encoding.** Read and write source/docs as UTF-8. Keep plain CLI diagnostics
  ASCII-compatible where required by legacy consoles; preserve the TUI's Unicode and
  natural Vietnamese. Do not assume every Windows terminal uses one code page.

## Tooling
- Use `rtk` when installed; fall back to the direct command when unavailable.
- Use [TESTING.md](TESTING.md) for scoped checks and the full gate. Do not run heavy
  suites in parallel, paid benchmarks, or the legacy self-improve runner for doc edits.
- Resolve contradictory working instructions instead of appending another exception.
  Keep reusable rules here, current status in ROADMAP, and dated research non-normative.

## Releasing
- Follow `docs/process/RELEASE.md` — gates, docs, tag-watch-verify, curated notes, the re-tag
  drill, and the stable-baseline/rollback contract. Every rule there was paid for by an incident.
