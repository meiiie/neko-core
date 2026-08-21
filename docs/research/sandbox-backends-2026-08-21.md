# Stateful sandbox backends - 2026-08-21

## Decision

Keep Neko's local Bash sandbox enabled by default. Do not make `auto` or `--yolo` mean an
unconfined host shell. Add narrow host-owned capabilities for host-specific work, and evaluate a
stateful microVM backend separately for long-running or untrusted workloads.

The immediate host-network gap is closed by `network_probe`: bounded DNS plus connect-only TCP
checks for one target and at most 16 ports. It is a governed native tool, not a shell escape. Bash
egress remains deny-by-default and domain-allowlisted.

## What the upstream systems imply

Claude separates permission automation from sandbox containment. Its Managed Agents self-hosted
sandbox feature moves execution onto customer infrastructure; the session/event system and sandbox
checkpointing make work durable. That is a persistence and placement model, not a reason to remove
network or filesystem boundaries.

CubeSandbox is a strong candidate for an optional remote/self-hosted backend: its published design
uses RustVMM/KVM microVMs, exposes an E2B-compatible API, and includes snapshots, volume persistence,
network policy, and credential injection. It requires Linux/KVM (or the documented WSL2 path) and its
network viewpoint is the guest. It therefore cannot replace a bounded host probe when the user asks
about the Windows host or its LAN.

Primary sources:

- [Claude Managed Agents: self-hosted sandboxes](https://platform.claude.com/docs/en/managed-agents/self-hosted-sandboxes)
- [Claude Managed Agents architecture and persistence](https://claude.com/blog/building-with-claude-managed-agents)
- [Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)
- [Tencent Cloud CubeSandbox](https://github.com/TencentCloud/CubeSandbox)
- [Anthropic sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime)

## Optional backend contract

A future `cube`/E2B-compatible adapter should be admitted only behind an explicit configuration
profile and should implement:

1. create, reconnect, checkpoint, resume, and destroy with stable sandbox identity;
2. a persistent volume whose checkpoint identity is stored in Neko's session journal, never an
   implicit promise that a live process lasts forever;
3. runner-owned CPU, memory, wall, output, and process-tree bounds with proof of quiescence before a
   tool result is accepted;
4. explicit filesystem mounts and network policy, with the narrower of Neko policy and backend
   policy winning;
5. short-lived credential injection without credentials entering the workspace, transcript, logs,
   snapshots, or model-visible output;
6. immutable backend/runtime/image fingerprints in session and evaluation artifacts;
7. crash tests at intent, side effect, result, checkpoint, and reconnect boundaries, including
   outcome-unknown mutations that are never retried automatically.

Admission also requires no-model conformance tests, Linux/KVM CI, a local opt-in smoke test, cleanup
proof after cancellation, and a documented distinction between host-local tools and guest tools.
Until those gates exist, CubeSandbox is research/backlog rather than a release dependency.
