# Neko Code — sandboxing

Neko has layered safety for the gated tools:

1. **Permission modes** (default/accept-edits/plan/auto) + the inline approval gate.
2. **Path confinement** — `write_file`/`edit`/`multi_edit` refuse to touch anything outside the
   workspace root.
3. **Catastrophic-command seatbelt** — `bash` refuses `rm -rf /`, `mkfs`, fork bombs, `format c:`,
   `> /dev/sd*`, etc. (unless `allow_dangerous_bash: true`).
4. **Adversarial check** (opt-in) — a model pass vets auto-approved mutating actions.
5. **OS sandbox for bash** (opt-in) — described below.

## Bash OS sandbox (opt-in)

Like Claude Code / Codex CLI, when enabled Neko runs `bash` under an OS sandbox: the filesystem is
**read-only except the workspace** (+ `/tmp`), and network egress is blocked by default.

```json
// ~/.neko-core/config.json (or ./neko.json)
{ "sandbox": true, "sandbox_network": false }
```

| OS | Primitive | Status |
|----|-----------|--------|
| Linux | **bubblewrap** (`bwrap`) — unprivileged namespaces | full fs + network confinement |
| macOS | **sandbox-exec** (Seatbelt) — SBPL profile | full fs + network confinement (Apple deprecates the binary but it works) |
| Windows | — | **no lightweight primitive**: bash runs unconfined, but layers 1–4 still apply |

`neko doctor` shows the resolved state, e.g. `bash_sandbox: on (bwrap)` or
`off (available: none)`.

### Windows
There's no equivalent of bwrap/Seatbelt as a simple primitive. For real isolation on Windows, run
Neko **inside WSL** (bwrap works there) or in a container/dev-container. Without that, rely on the
seatbelt + permission gate + `adversarial_check`. (This matches the ecosystem: Claude Code/Codex
sandboxes are macOS/Linux-only; Windows users use WSL or a VM.)

### Notes
- This sandbox is OS-process level — it does **not** defend against kernel exploits (same caveat as
  every tool in this class). For untrusted code at scale, use a VM/microVM.
- File tools are already path-confined regardless of this setting; the sandbox is what contains
  `bash`, which can otherwise write anywhere.
