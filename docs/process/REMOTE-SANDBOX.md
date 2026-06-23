# Remote sandbox backend (deferred design note)

**Status: NOT built. YAGNI.** This sketches how to add a *remote* execution sandbox (E2B /
Namespace / Superserve / GKE …) IF Neko ever needs cloud execution. Local sandboxing
(`bwrap`/`sandbox-exec`, see [SANDBOX.md](SANDBOX.md)) is the right tier for a local-first CLI today.

## When this would matter
- A **cloud/hosted Neko** (run tasks server-side, on a weak machine, or headless at scale).
- A **Windows sandbox without WSL** — bash runs in a remote Linux microVM instead.
- None of these is a current need. Until one is concrete, don't build it.

## The pattern (from Anthropic's Managed Agents, 6/2026)
Separate **orchestration** (the agent loop — stays in Neko) from **execution** (bash/code/fs —
moves into a sandbox you control). The execution backend is swappable: local, your infra, or a
provider. The providers (E2B etc.) have their own SDKs and are usable **independently of** Claude
Managed Agents — Neko would call the provider SDK directly, not Anthropic.

## What's already in place
`src/core/tool-runtime.ts` `runBash()` has exactly one execution decision point:

```ts
const sb = wrapBash(command, this.root, { enabled: this.sandboxBash, allowNetwork: ... });
const child = spawn(sb.file, sb.args, { shell: sb.shell, cwd: this.root });
```

`SandboxKind` in `src/core/sandbox.ts` is the seam. That's the *honest* extent of the readiness.

## What a remote backend additionally needs (the real cost)
A remote sandbox is **async** and **not a local process**, so it does NOT fit `SpawnTarget`. You'd add:

1. A small port (in `core/ports.ts`), implemented by an adapter (`adapters/remote-sandbox.ts`):
   ```ts
   interface RemoteSandbox {
     ensure(): Promise<void>;           // create/reuse the sandbox
     syncUp(root: string): Promise<void>;   // upload workspace (skip .git, node_modules, large/binary)
     exec(cmd: string, o: { network: boolean }): Promise<{ out: string; code: number }>;
     syncDown(root: string): Promise<void>; // pull back changed files
     dispose(): Promise<void>;
   }
   ```
2. A branch in `runBash`: when the backend is remote, `await remote.exec(...)` instead of `spawn`
   (so `runBash`'s body becomes executor-aware — today it's spawn-only). Keep Ctrl+B/background +
   the seatbelt + the output cap working over the remote path.
3. Config: `"sandbox": "e2b"` (string, not just bool) + `E2B_API_KEY` **via env only** — never
   stored/printed (see RULES + run `/secret-scan` before any push).

## The footguns (why it's heavy, not a quick win)
- **Workspace sync** is the bulk of the work and the main trap: large repos, `.git`, binaries,
  symlinks, ignore rules, and "which files changed" detection. Mounting (where supported) sidesteps
  some of it.
- **Env mismatch**: bash runs in the provider's **Linux** image, but Neko's file tools run locally.
  Mixed environment → path/toolchain surprises (same reason we point Windows users at WSL).
- **Network + cost + latency** per command; an account per provider.
- **Secrets**: provider keys are new secret surface.

## Provider fit (if/when)
| Provider | Shape | Good for |
|----------|-------|----------|
| **E2B** | isolated microVM, OSS SDK | general code-exec, easiest to start |
| **Namespace** | ephemeral per-task devbox | clean throwaway runs, no leftover state |
| **Superserve** | Firecracker, persistent versioned fs | durable workspaces across runs |
| **GKE Agent Sandbox** | K8s, gVisor/Kata, huge scale | many agents (platform scale, overkill for a CLI) |

## Rough effort
~A day for a working E2B backend behind a flag; most of it is workspace sync + making background
bash / interrupts behave over the network. Revisit only when a concrete cloud need lands.
