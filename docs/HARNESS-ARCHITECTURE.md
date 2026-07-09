# Neko Core Harness Architecture

Status: Historical (Python contest harness; not the shipped TypeScript runtime)
Last updated: 2026-06-08

Current architecture: [`process/ARCHITECTURE.md`](process/ARCHITECTURE.md).

## Operating Thesis

This project is not a prompt collection. It is a small inference harness with
contracts, configuration, profiling, model invocation, validation, and traceable
development artifacts.

The design follows lessons from:

- Wiii's self-harness and mode/workflow direction;
- Codex-style task harnesses and typed protocol boundaries;
- Odysseus/Goose-style provider inventory and workflow-pack thinking;
- Anthropic's Claude Code large-codebase guidance on working through explicit
  entry points, subproblems, and reusable project context.

Reference:

- https://claude.com/blog/how-claude-code-works-in-large-codebases-best-practices-and-where-to-start

## Architecture

```text
configs/default.json
  -> loader
  -> schema
  -> configurable profiler
  -> prompt strategy
  -> provider-neutral chat client
  -> answer normalizer
  -> optional verifier/tournament
  -> validation summary
  -> pred.csv
  -> dev trace/session artifacts
```

Runtime modules:

- `agents.py`: documents named harness roles, tool boundaries, artifact reads,
  artifact writes, and handoff contracts for runtime and development roles.
- `branding.py`: owns Neko Core identity, version string, and ASCII banner.
- `capabilities.py`: lists runtime and development-only capabilities in one
  registry.
- `command_registry.py`: documents CLI/script command surfaces, examples, and
  guardrails.
- `doctor.py`: runs lightweight diagnostics similar to CLI doctor/status
  workflows.
- `project.py`: initializes project-local configuration under `.neko-core/`
  so teams can tune workflows and markers without editing source files.
- `workflows.py`: resolves named workflow profiles from config.
- `scripts/verify.ps1`: dev-only verification runner that emits
  command/output/result evidence and a final verdict.
- `scripts/evaluate.ps1`: dev-only workflow comparison runner for stability,
  trace review, trace comparison, harness-score review, and eval summary
  artifacts.
- `checkpoint.py`: writes qid-level checkpoints plus metadata so large runs can
  resume without trusting stale input or config state.
- `compare.py`: compares two trace-enabled runs using manifests and prediction
  trace rows.
- `config.py`: loads schema-versioned harness config, project-local config,
  named runtime profiles, and CLI/env profile overrides.
- `loader.py`: reads CSV/JSON input and maps it to `Problem`.
- `manifest.py`: writes reproducible run metadata for trace-enabled runs.
- `model_inventory.py`: probes provider model inventory and filters Bang C
  eligible LLM plus embedding/rerank models from config.
- `schema.py`: owns shared dataclasses.
- `classifier.py`: profiles item shape using config markers and thresholds.
- `prompting.py`: builds prompt variants from the profile.
- `model_client.py`: provider factory and shared chat-client protocol.
- `local_client.py`: local `llama.cpp`/GGUF provider for the self-contained
  Gemma contest image.
- `nvidia_client.py`: optional NVIDIA/OpenAI-compatible API provider for
  development and future extension.
- `policy.py`: audits runtime/development boundaries across command, tool, and
  agent registries.
- `solver.py`: strategy orchestration.
- `tool_registry.py`: documents named tool contracts, permission class,
  inputs, outputs, and safety guardrails.
- `normalize.py`: strict answer-letter extraction.
- `evaluation.py`: validates predictions and computes harness score.
- `exporter.py`: writes contest output and dev traces.
- `review.py`: reads dev traces after a run and reports reviewer findings
  without invoking a model.
- `risk.py`: collects deterministic prediction-risk signals from trace rows,
  including tournament ties, agent disagreement, broad-marker guards, compound
  profiles, and review-target confidence gaps.

Dev traces are structured as agent steps on each prediction. Current roles are
`classifier`, `solver`, `repair`, `synthesizer`, `tie-breaker`, `verifier`,
and deterministic adjudicators. This gives the team a Claude Code-like review
timeline without changing the contest artifact: `pred.csv` remains only
`qid,answer`.

Trace review is intentionally separate from solving. `--review-trace` can be
run after any trace-enabled workflow to catch low confidence, fallback paths,
trace warnings, missing roles, blocked steps, and deterministic risk signals.
This mirrors the execute-then-verify split from coding agents while keeping the
contest runtime simple.

Run manifests are written as `run-manifest.json` only for trace-enabled
development runs. They capture config/input hashes and selected runtime options,
so experiments can be compared without relying on memory or hidden local state.
`--compare-traces` uses those manifests plus prediction trace rows to flag
changed answers, input/config drift, confidence drift, and fallback drift.

`--run-dir <path>` creates a development run session. The CLI writes
`output/pred.csv`, `traces/`, `run-report.md`, `review-tasks.md`, and
`review-tasks.json` under that directory, then runs the trace reviewer against
the session trace. It also writes `events.jsonl`, a structured timeline of run
lifecycle events that future UI, task watchers, or subagents can consume without
parsing prose reports. This gives the team one portable folder per experiment
while keeping the final `/data` to `/output` contest contract unchanged.
`--list-runs` and `--session <run-dir>` are read-only resume surfaces inspired
by Claude Code's `/resume` and `/session`: they rediscover run folders from
disk, summarize workflow/model/contract/review state, and print the next
review or resolve command without relying on hidden process state. `--events`
renders the run's event log as a compact timeline.

For larger public/private files, trace-enabled runs checkpoint each newly
solved qid to `traces/predictions.checkpoint.jsonl`. `--resume` verifies the
checkpoint metadata against the current input/config/workflow before reusing
saved qids. The final `pred.csv` remains a validated full-run artifact, not a
partial checkpoint.

`--review-tasks <trace-dir>` turns trace-review findings into an action queue.
It is intentionally deterministic and model-free: subagents or teammates can
pick up those tasks later, while the submission artifact stays unchanged.
`scripts/resolve-tasks.ps1` is the first deterministic task runner: it reads
that queue, reruns the qid-scoped tasks with a stronger workflow, records a
task-resolution report plus JSON lifecycle artifact, and compares only the
queued qids against the source run when baseline traces are available.

`--agents` and `--agent <name>` expose a read-only role registry inspired by
Claude Code-style agent surfaces. The registry names the current runner,
classifier, solver, verifier, trace reviewer, task resolver, session inspector,
and model inventory roles, but it does not spawn processes or mutate outputs.
Its purpose is to make handoff boundaries explicit before adding heavier
subagent workflows.

`--tools` and `--tool <name>` expose a read-only tool contract registry inspired
by Claude Code's explicit tool registry. Runtime tools such as loader,
classifier, solver, verifier, and exporter are separated from development tools
such as trace review, model inventory, web research, and subagent review. The
web and subagent entries are intentionally marked external and quarantined:
they may inform tests or config, but they cannot directly write the contest
artifact or perform privileged actions.

`--commands` and `--command <name>` expose a read-only command registry inspired
by Claude Code's slash-command surface. This registry is the map of how humans
operate the harness: identity checks, local config, diagnostics, registries,
runtime solving, run sessions, trace review, task resolution, verification, and
evals. It gives contributors a stable command vocabulary before the project
adds heavier interactive or subagent orchestration.

`--policy` audits the registry boundary itself. It verifies that runtime tools
are not external or quarantined, development-only outputs do not leak into
runtime tools, web research and subagent review remain quarantined, and the run
command/exporter preserve the contest artifact contract. The command is
read-only, and the solve path enforces the same policy before loading input or
model state. This is the first Claude Code-style permission layer for richer
workflows.

`--yolo` is the first bounded autonomous mode. It adapts the same lesson from
Codex/Claude-style agents: autonomy is a named permission/workflow state, not
an invisible prompt behavior. The preset selects `contest-strict` when no
workflow is provided, enables compatible auto-resume, keeps checkpointing on,
and writes review/session artifacts. It still runs the same policy gate, model
eligibility check, prediction validator, and exporter contract. It does not
submit leaderboard files, push git changes, delete files, or allow development
tools such as web research/subagent review to write `pred.csv`.

`scripts/evaluate.ps1` composes those run sessions into a higher-level eval
session. Each workflow repeat gets its own run folder, then the eval report
records trace review, trace comparison, and a selected candidate. This mirrors
the agent pattern of separating execution, verification, and synthesis.

## Why Config First

Public test data is not the real problem. Private test can vary by language,
wording, option count, context shape, or question style. Rules that assume one
public-test format are fragile.

The config layer stores:

- input filename candidates;
- output contract;
- provider registry, runtime profiles, local Gemma model path, and optional API
  model defaults;
- allowed LLM and embedding/rerank families;
- retry/timeout policy;
- multilingual profiling markers;
- classifier thresholds;
- harness scoring weights.

`neko --init` copies the canonical config to `.neko-core/config.json`.
When no `--config` path is provided, the loader checks this project-local
config before `configs/default.json`. This mirrors agent CLI practice: runtime
source stays stable while a team can tune local harness profiles.

Runtime profiles are also config-owned. The current config exposes
`gemma26b-q4-local` for the self-contained contest image and
`nvidia-gemma31b-api` for explicit API-based development. Select them through
`--profile <name>` or `HACKC_PROFILE=<name>`, and inspect them through
`--profiles`. This follows the same direction seen in Codex/Claude-style
systems: base config, named profiles, local project config, environment/CLI
overrides, and read-only doctor/status commands to show the effective runtime.

When a new language or question marker appears, update config first. Only change
code when the runtime contract itself needs a new capability.

## Runtime Boundary

Final submission runtime must remain narrow:

```text
read /data
write /output/pred.csv
```

It must not depend on:

- web browsing;
- Wiii backend services;
- database/vector sidecars;
- browser automation;
- subagents;
- local notebooks;
- hidden trace state;
- API keys committed to source.

For the current Bang C direction, the final scoring image should prefer
`provider=local_llamacpp` with `Gemma 4 26B A4B QAT Q4_0 GGUF` already present
under `/models`. The NVIDIA provider remains an explicit development/API
extension, not a hidden scoring dependency.

Development may use those tools to improve the harness, but the final container
must be able to reproduce from source plus the allowed runtime environment.

## Extension Rules

Add a new technique only through one of these extension points:

1. Config marker/threshold/model/rubric update.
2. New runtime profile or provider-registry entry in config.
3. New prompt variant in `prompting.py`.
4. New profile rule in `classifier.py` backed by config.
5. New strategy in `solver.py`.
6. New validation or scoring check in `evaluation.py`.

Avoid adding cross-cutting branches inside unrelated modules.

## Claude Code Patterns Adapted

Useful patterns from the local Claude Code snapshot:

- Keep the bootstrap/entrypoint thin and fast.
- Put commands such as version, doctor, and status before the expensive solve
  path.
- Treat tool/workflow registries as explicit capability lists, not scattered
  conditionals.
- Separate diagnostics, runtime execution, and UI rendering.
- Use feature/config gates for optional capabilities instead of hard-coding
  private-test assumptions.

For Neko Core, the first adapted slices are `--doctor`, `--capabilities`,
`--agents`, `--agent`, `--tools`, `--tool`, `--commands`, `--command`,
`--policy`, `--list-workflows`, `--yolo`, `scripts/verify.ps1`, and
`scripts/evaluate.ps1`.
They prove config, contract, model, key presence, input discovery, the
runtime/development boundary, role handoffs, tool guardrails, command
guardrails, policy boundaries, verification evidence, and workflow stability
without running inference unless explicitly requested. Future work should add
subagent-style evaluation reviewers in the same style, while keeping the final
Docker contract narrow.

## Wiii Reuse Path

If this harness proves useful, Wiii should import the pattern, not the contest
logic:

- schema-versioned workflow config;
- domain-independent profiling contracts;
- strict output validators;
- dev-only trace summaries;
- runtime boundaries that keep UI, tools, memory, and model calls explicit.
