# Neko Core — sandboxing

Neko has layered safety for the gated tools:

1. **Permission modes** (default/accept-edits/plan/auto) + the inline approval gate.
2. **Path confinement** — `write_file`/`edit`/`multi_edit` refuse to touch anything outside the
   workspace root.
3. **Catastrophic-command seatbelt** — `bash` refuses `rm -rf /`, `mkfs`, fork bombs, `format c:`,
   `> /dev/sd*`, etc. (unless `allow_dangerous_bash: true`).
4. **Adversarial check** (opt-in) — a model pass vets auto-approved mutating actions.
5. **OS sandbox for bash** (ON by default) — described below.

## Bash OS sandbox (ON by default)

Like Claude Code / Codex CLI, Neko runs `bash` under an OS sandbox: the filesystem is
**read-only except the workspace** (+ `/tmp`), and network egress is blocked by default.
Default ON since 2026-07-22 (owner decision): machines with a primitive confine bash out of the
box; machines without one fall back to the seatbelt + gate unchanged (doctor shows which).

```json
// ~/.neko-core/config.json (or ./neko.json) - to opt OUT or open egress:
{ "sandbox": false }
{ "sandbox": true, "sandbox_network": true, "sandbox_domains": ["github.com", "*.npmjs.org"] }
```

(Env rollback: `NEKO_SANDBOX=0`.)

### Sandboxed bash runs without a prompt

When the sandbox is **live** (a primitive is present and, for srt, provisioned), gated `bash`
auto-approves in `default` and `accept-edits` mode — the OS sandbox is the containment, so a
per-command prompt adds no safety (this is Claude Code's sandbox rationale). This is a *named*
state, surfaced by `neko doctor` (`bash auto-approved…`) and `neko policy`; it is NOT `--yolo`
(writes still prompt, `plan` still denies everything, and the catastrophic-command seatbelt still
applies). Keying is on LIVE confinement, never config intent: `"sandbox": true` on a machine with
no primitive still prompts. Opt back into prompting with `"sandbox_auto_approve": false`.

| OS | Primitive | Status |
|----|-----------|--------|
| Linux | **bubblewrap** (`bwrap`) — unprivileged namespaces | full fs + network confinement |
| macOS | **sandbox-exec** (Seatbelt) — SBPL profile | full fs + network confinement (Apple deprecates the binary but it works) |
| Windows | **Anthropic sandbox-runtime** (`srt`) — dedicated `srt-sandbox` user, restricted token in a job object, NTFS ACLs, WFP egress fence | full fs + network confinement (one-time provisioning) |

`neko doctor` shows the resolved state, e.g. `bash_sandbox: on (bwrap)` or
`off (available: none)`.

### Windows
Windows has no bwrap/Seatbelt-style namespace primitive; the ecosystem answer (Codex CLI's
May-2026 sandbox, Anthropic's sandbox-runtime) is user-identity isolation: run the command as a
dedicated low-privilege local account, confine writes with NTFS ACLs, and fence network egress
per-account with the Windows Filtering Platform. Neko rides Anthropic's open-source
[sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) for this rather than
reimplementing it:

```powershell
bun add -g @anthropic-ai/sandbox-runtime   # installs the srt.exe shim (the .exe is required;
                                           # npm's .cmd shims are ignored - cmd.exe quoting is escapable)
srt windows-install                        # one-time: provisions srt-sandbox + WFP filters (one UAC prompt)
```

With `"sandbox": true`, bash then runs as `srt` -> git-bash -> the command: filesystem read-only
except the workspace, network hard-blocked unless `"sandbox_network": true`. If `srt` is on PATH
but provisioning hasn't run, bash fails closed with srt's own actionable error (and `neko doctor`
warns). Alternatives remain: run Neko inside WSL (bwrap) or a container/dev-container.

Mechanics worth knowing (verified on Windows 11 Home, srt 0.0.66):

- **Network is always an allowlist.** srt has no allow-all egress (its proxy denies unmatched
  hosts), so `"sandbox_network": true` exposes only `"sandbox_domains": ["github.com",
  "*.npmjs.org", ...]`. False = hard deny-all (`deniedDomains: ["*"]`).
- **Command bytes never ride a shell command line.** srt's CLI re-parses its command through the
  sandbox account's cmd.exe, whose quoting hostile text can escape. Neko writes each bash command
  to a content-addressed script under `%TEMP%\neko-srt\` (that subdir gets a one-time additive
  read ACE for `srt-sandbox` - TEMP itself is unreadable across local users) and the srt command
  line carries only `"<git-bash>" "<script>"`.
- **Known srt gotcha:** with a bun-global install the `srt-win.exe` vendor binary sits inside
  your user profile, which the `srt-sandbox` account cannot read -> every run fails with
  `CreateProcessWithLogonW ... Access is denied`. One-time fix until upstream grants it at
  install:
  `icacls "%USERPROFILE%\.bun\install\global\node_modules\@anthropic-ai\sandbox-runtime" /grant "srt-sandbox:(OI)(CI)(RX)"`
- The Secondary Logon service (`seclogon`) must be running (it is by default; srt's error names
  it if not).

### Notes
- This sandbox is OS-process level — it does **not** defend against kernel exploits (same caveat as
  every tool in this class). For untrusted code at scale, use a VM/microVM.
- File tools are already path-confined regardless of this setting; the sandbox is what contains
  `bash`, which can otherwise write anywhere.
