# Public evaluation

Internal Neko benchmarks are regression tests. They are not evidence that Neko is
state of the art. Public claims use the official Harbor runner and an unmodified
Terminal-Bench 2.1 dataset/verifier.

## Credential-safe host boundary

The Harbor adapter keeps the model provider, credentials, and optional Codex App
Server on the host. The task environment receives only bounded native-tool requests
through Harbor's `BaseEnvironment`; it never receives a Neko executable, Codex
executable, OAuth file, API key, provider configuration, host daemon socket, or
Harbor agent environment variable.

Before every run, the launcher compiles `evals/harbor/host_runner.ts` with the current
Bun into a temporary artifact whose basename is fixed as `neko-harbor-host` (or
`neko-harbor-host.exe` on Windows). It refuses a non-canonical, non-regular, or
multi-link artifact and hashes the exact bytes. For the `chatgpt` profile it uses the
same resolver as the host runner to select the installed Codex executable, then
passes only that executable's SHA-256 digest. The host runner independently resolves
and verifies the digest before a GPT-5.6 session can start.

The launcher does not trust an ambient environment, `PATH`, or `PYTHONPATH`. It resolves
Git, Docker, `uvx`, Bun, and required Windows system tools to canonical regular
executables outside the workspace, uses absolute paths for its own spawns, and gives
Harbor a default-deny environment with an isolated non-credential home. Random ambient
variables, API keys, arbitrary `NEKO_*`, `GIT_*`, `UV_*`, and Python controls do not
cross that process boundary. On Windows, the only additional system locator is the
canonical `ProgramFiles` root after the selected Docker executable and its system
Compose plugin are validated outside the workspace; `docker compose version` is then
preflighted before any credential is staged.

Immediately before `uvx`, the launcher refreshes the durable ChatGPT credential and
derives a separate access-token-only lease with its real expiry and account id but an
empty refresh token. The lease, a canonical Codex path/digest manifest, and digest-pinned
copies of the Python bridge/control files live under a random staging root outside the
repository. On Windows, inheritance is removed and the DACL is verified to grant only
the current SID and SYSTEM before credential bytes are written; POSIX uses mode 0700.
No user config is copied.

Only the one `uvx` spawn receives `NEKO_HARBOR_RUNNER_HOME` plus the private bridge
`PYTHONPATH`. The first statement of `NekoHostAgent.__init__` consumes both locators.
Harbor 0.20 constructs that agent before its Docker environment, so later task-env and
Compose interpolation cannot resolve either path. The host runner receives a fixed OS
bootstrap, `HOME`/`USERPROFILE` pointed at the staged lease, and runner-only
`NEKO_CODEX_PATH`; it never inherits Harbor's environment. The launcher removes the
private root in `finally` on success or failure.

Harbor 0.20 schedules concurrent trials as asyncio tasks in the same CLI process, so
the adapter caches the already-claimed home for later trials after the one-shot locator
is gone. A future Harbor process-worker topology is outside this pinned contract: a
worker created after the pop receives no locator and fails closed instead of falling
back to an ambient home.

The official verifier/infrastructure path can be checked without a model or secret:

```powershell
rtk uvx --isolated --no-env-file --no-config --from harbor==0.20.0 harbor run -d terminal-bench/terminal-bench-2-1@sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a -a oracle -l 1 -n 1 --include-task-name terminal-bench/make-mips-interpreter --yes
```

## Frozen host-runner recipe

Docker Desktop must be running, the `chatgpt` host profile must already be signed in,
and a compatible Codex App Server must be installed or selected on the host. The
default model is `openai/gpt-5.6-sol`, and the default limit is one to prevent an
accidental expensive 89-task run. No Codex path is uploaded or accepted by the
launcher:

```powershell
rtk bun run eval:terminal -- --profile chatgpt --model openai/gpt-5.6-sol --effort max --max-steps 40 --no-adaptive-effort --loop --limit 1
```

Only include/exclude task selection, attempts, concurrency, and confirmation may
follow `--`: `--include-task-name`/`-i`, `--exclude-task-name`/`-x`,
`--n-attempts`/`-k`, `--n-concurrent`/`-n`, `--n-concurrent-agents`, and
`--yes`/`-y`. Both `--task`/`-t` and `--dataset` are rejected; the dataset digest and
Harbor version are source constants, not CLI options. The launcher also rejects
config, model, agent/agent-kwarg, agent-env, environment,
network-authority, timeout, retry, resource, verifier, and other budget overrides
through the passthrough channel. Set profile, model, limit, effort, max steps,
adaptive effort, and loop mode before `--`.

Repeat a named task before attributing a score change to the harness:

```powershell
rtk bun run eval:terminal -- --profile chatgpt --model openai/gpt-5.6-sol --effort max --max-steps 40 --no-adaptive-effort --loop --limit 1 -- --include-task-name make-mips-interpreter --n-attempts 3 --n-concurrent 1 --yes
```

For Terminal-Bench 2.1, the launcher expands a short task selector to the registry's
`terminal-bench/<name>` form. Each attempt still receives a fresh task container and
isolated home. Validation must begin from clean state; if the deliverable is a
program, remove runtime outputs that a clean execution recreates before handing the
container to the verifier. Stale outputs can short-circuit process-based checks and
create both false passes and false failures.

The launcher invokes `uvx --isolated --no-env-file --no-config` before the exact
`--from harbor==0.20.0` request, so an ambient installed tool, uv config, or env file
cannot take precedence. It pins the Terminal-Bench 2.1 dataset ref
`sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a`.
The official references are the
[Terminal-Bench 2.1 leaderboard](https://www.tbench.ai/leaderboard/terminal-bench/2.1),
[run guide](https://www.harborframework.com/docs/tutorials/running-terminal-bench), and
[Harbor](https://www.harborframework.com/). Pin the dataset/task digest recorded by
Harbor; do not replace its verifier with an internal approximation.

The launcher freezes reasoning effort, `max_steps`, adaptive effort, and loop mode as
explicit agent kwargs. These are behavior settings, not a hard aggregate budget:
`max_steps` bounds Neko's outer loop, while one Codex App Server completion may make
multiple internal model calls.

The current public pilot permits only the fixed `chatgpt` -> provider `chatgpt` binding
with an `openai/` Harbor model. API-key and Kimi profiles fail closed until they have an
equally bounded, non-refreshing host-only lease; they never fall back to the real home or
ambient credentials. A user config that changes the provider, or a model with the wrong
prefix, fails before Harbor starts. The validated profile/model reaches only the compiled
host runner through fixed agent settings.

`neko-host-eval-identity.json` in the Harbor agent logs records the runner artifact
and SHA-256, the TypeScript runner source, launcher source, both Python bridge files,
source revision/dirty bit, Bun version, Harbor version, pinned dataset, selected
model/profile, frozen behavior settings, and selected Codex digest when applicable.
`neko-host-run.json` records host-runner completion without stderr contents. Harbor's
job lock remains the source of truth for the resolved dataset and per-task digests.

The host runner starts in an isolated temporary working directory and temporary Codex
home. Its access lease must have at least 35 minutes remaining at runner start, while the
Python host bridge enforces a 30-minute hard deadline. Any Codex refresh request fails
locally because the lease contains no refresh token; the durable credential cannot be
rotated by the bounded task. The remote-tool bridge confines structured writes to the canonical task root,
disables background bash, bounds observations and deadlines, and requires quiescent
process cleanup before cancellation is acknowledged. If it cannot prove quiescence,
it destroys the task environment and fails closed.

## Claim gate

A SOTA claim requires all 89 Terminal-Bench 2.1 tasks, the official task resource
limits and verifier, multiple attempts, published job artifacts, and confidence
intervals. A one-task smoke pass proves only that the integration works. Record model,
Neko commit/dirty state, Harbor version, dataset version, attempts, score, exceptions,
tokens, cost, and wall time for every comparison.
