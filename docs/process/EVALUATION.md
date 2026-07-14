# Public evaluation

Internal Neko benchmarks are regression tests. They are not evidence that Neko is
state of the art. Public claims use the official Harbor runner and an unmodified
Terminal-Bench 2 dataset/verifier.

## Safe smoke run

Docker Desktop must be running and the selected OAuth profile must already be
signed in. The launcher builds the current working tree as a Linux executable,
uploads that exact executable to the task container, and runs the public CLI:

```powershell
bun run eval:terminal -- --profile kimi --limit 1
```

The default limit is one to prevent an accidental expensive 89-task run. Raw
Harbor options go after `--`:

```powershell
bun run eval:terminal -- --profile kimi --limit 5 -- --n-concurrent 1
```

For ChatGPT OAuth:

```powershell
bun run eval:terminal -- --profile chatgpt --model openai/gpt-5.5 --limit 1
```

Repeat a named task before attributing a score change to the harness:

```powershell
bun run eval:terminal -- --profile chatgpt --model openai/gpt-5.5 --limit 1 -- --include-task-name make-mips-interpreter --n-attempts 3 --n-concurrent 1
```

For Terminal-Bench 2, the launcher expands a short `--include-task-name` value to the registry's
`terminal-bench/<name>` form. Each attempt still receives a fresh task container and isolated home.
Validation must begin from clean state; if the deliverable is a program, remove runtime outputs that a
clean execution recreates before handing the container to the verifier. Stale outputs can short-circuit
process-based checks and create both false passes and false failures.

The official references are the [Terminal-Bench 2 leaderboard](https://www.tbench.ai/leaderboard/terminal-bench/2.0),
[run guide](https://www.tbench.ai/docs/run-terminal-bench-2-0), and
[Harbor](https://www.harborframework.com/). Pin the dataset/task digest recorded by Harbor; do not replace its
verifier with an internal approximation.

The adapter sets `NEKO_AUTO_UPDATE=0`, runs `neko run --yolo --loop`, and copies
only the selected OAuth file into the ephemeral task container. It never writes
credential contents to the command line or repository, and deletes the remote
OAuth file as soon as the agent exits, before verification and artifact collection.
Neko runs in a dedicated process group. The adapter terminates that whole group
and removes OAuth state in `finally`, including when Harbor cancels a timed-out
agent, so an orphan cannot keep mutating the task while the verifier runs.
It also caps one foreground shell call at 180 seconds inside the official 30-minute
agent budget; known long-lived processes must use the background path instead of
silently consuming a third of the trial on one bad diagnostic run.
The host auth path is passed only through the launcher's process environment, so
Harbor job configs and process arguments do not record the user's local path.
API-key profiles should use Harbor's explicit agent environment mechanism; never
commit a key.

## Claim gate

A SOTA claim requires all 89 Terminal-Bench 2 tasks, the official task resource
limits and verifier, multiple attempts, published job artifacts, and confidence
intervals. A one-task smoke pass proves only that the integration works. Record
model, Neko commit/dirty state, Harbor version, dataset version, attempts, score,
exceptions, tokens, cost, and wall time for every comparison.
