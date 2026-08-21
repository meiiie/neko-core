# Neko Core — sandboxing

Neko has layered safety for the gated tools:

1. **Permission modes** (default/accept-edits/plan/auto) + the inline approval gate.
2. **Structured-write confinement** — `write_file`/`edit`/`multi_edit` refuse paths outside the
   workspace or an exact `additional_write_roots` capability and reject outside credential paths, link
   escapes, and existing multiply-linked regular files before approval or hooks.
3. **Catastrophic-command seatbelt** — `bash` refuses `rm -rf /`, `mkfs`, fork bombs, `format c:`,
   `> /dev/sd*`, etc. (unless `allow_dangerous_bash: true`).
4. **Adversarial check** (opt-in) — a model pass vets auto-approved mutating actions.
5. **OS sandbox for bash** (ON by default) — described below.

## Bash OS sandbox (ON by default)

Like Claude Code / Codex CLI, Neko runs ordinary/full-turn `bash` under an OS sandbox: the
filesystem is **read-only except the workspace, explicit additional write roots** (+ `/tmp`), and
network egress is blocked by default.
Default ON since 2026-07-22 (owner decision): machines with a primitive confine bash out of the
box; machines without one fall back to the seatbelt + gate unchanged (doctor shows which).

Proof-grade exact-file turns are stricter. They expose only `read_file`, target-bound `edit`, and
foreground-validator `bash`. The validator accepts test/typecheck/lint/check/verify shapes only and
requires every `&&` segment to qualify, then mounts the original project read-only. Its sole ordinary
writable location is one unpredictable temporary directory outside the project; `TEMP`, `TMP`, and
`TMPDIR` point there, and cleanup removes
it after launch. Build targets, writing/fixing flags, shell masking/redirection/substitution, and
background execution are unavailable. If no live OS primitive exists, validation fails closed before
approval or hooks rather than widening to ordinary/full-turn bash.

```json
// ~/.neko-core/config.json (or ./neko.json) - to opt OUT or open egress:
{ "sandbox": false }
{ "sandbox": true, "sandbox_network": true, "sandbox_domains": ["github.com", "*.npmjs.org"] }
```

(Env rollback: `NEKO_SANDBOX=0`.)

### Outside-workspace autonomy is path-scoped

Neko reads ordinary host files outside the project by default (`read_outside_root: true`), while its
credential/device deny policy remains active. `auto`/`--yolo` removes routine in-scope approval prompts;
it does not silently turn that read reach into a machine-wide write grant. Structured file tools and
all three ordinary Bash sandbox backends share an explicit write-capability list:

```json
{
  "additional_write_roots": ["D:\\Research", "E:\\Shared\\Reports"]
}
```

`NEKO_ADDITIONAL_WRITE_ROOTS` accepts the operating system's PATH delimiter (`;` on Windows, `:` on
POSIX). This capability may be set only by user-global config or environment; a project config cannot
grant itself authority outside its checkout, even after project trust. Roots must be existing canonical
directories. Filesystem roots, the user home, and agent or
credential control directories such as `.ssh`, `.codex`, `.agents`, and non-research `.neko-core`
state are refused. Neko always provisions one narrow built-in capability:
`~/.neko-core/research`. A cross-project research ledger can therefore continue without granting
write access to the rest of the user profile.

When the user explicitly asks for an ordinary file elsewhere on the host, `write_file`, `edit`, and
`multi_edit` may request one confirmation for that exact target and operation. This is a transient
capability: it is not inherited by another path or later turn. `plan` still denies it. System locations,
credential/browser stores, symlink or junction escapes, and multiply-linked files refuse before the
prompt. A durable directory workflow should use `additional_write_roots` instead. Bash remains confined
to its sandbox write roots and never inherits this structured-file exception.

This mirrors the current Claude Code posture rather than an unrestricted shell: its official
[permissions](https://code.claude.com/docs/en/permissions) and
[sandboxing](https://code.claude.com/docs/en/sandboxing) documentation likewise separate approval
automation from filesystem containment and use additional writable directories as explicit policy.

### Sandboxed bash still asks by default

The sandbox confines writes and usually egress, but deliberately retains broad host reads. Command
stdout is returned to the model, so a sandboxed `cat` of a credential is still a confidentiality
failure. For that reason `sandbox_auto_approve` defaults to `false`: `bash` prompts in `default` and
`accept-edits` even when a primitive is live. An informed user may opt into prompt-free contained
bash with `"sandbox_auto_approve": true`; `neko doctor` and the runtime block then disclose that host
reads remain available. `plan` always denies and `--yolo` remains an explicit autonomy choice.

**Ordinary/full-turn exception — workspace-destructive commands still confirm.** The sandbox contains the blast radius
to the workspace, but the workspace itself (your code + `.git`) is writable, so a command that
*irreversibly destroys data there* — recursive/force/wildcard `rm`, `git clean -f`, `git reset
--hard`, `git checkout -- .`, `find -delete`, script-driven deletion, `shred`/`truncate` — is
**withheld from auto-approve and asks once** (the approval box shows a `⚠` reason). A plain
single-file `rm file.txt` does not, so everyday cleanup stays convenient. This is a "should we still
ask?" heuristic, not a containment (the sandbox already is that): a miss just means a contained
command ran, a false positive costs one prompt. Want zero prompts anyway? `always allow bash` in the
box, or `--yolo`. See `destructiveInWorkspace()` and `bun scripts/wren-audit.ts` (a hands-on probe
of the whole posture, framed by the wren.wtf "Stop Using OpenCode" critique).

| OS | Primitive | Status |
|----|-----------|--------|
| Linux | **bubblewrap** (`bwrap`) — unprivileged namespaces | write + network confinement; broad host reads |
| macOS | **sandbox-exec** (Seatbelt) — SBPL profile | write + network confinement; broad host reads |
| Windows | **Anthropic sandbox-runtime** (`srt`) — dedicated `srt-sandbox` user, restricted token in a job object, NTFS ACLs, WFP egress fence | write + allowlist egress confinement; broad permitted reads; Windows support is alpha |

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

With `"sandbox": true`, ordinary/full-turn bash runs as `srt` -> git-bash -> the command: filesystem
read-only except the workspace and exact additional roots, network hard-blocked unless `"sandbox_network": true`. If `srt` is on PATH
but provisioning hasn't run, bash fails closed with srt's own actionable error (and `neko doctor`
warns). The same no-fallback rule applies when SRT is installed and provisioned but its behavioral
health probe fails for a provisioning/credential/runtime reason: `doctor` and `policy` report that
bash **fails closed**, not `UNCONFINED AUTO`. A health probe that itself reaches its bounded timeout
under host load is treated differently: Neko attempts the real command once through the same exact
`srt.exe` + settings boundary. That attempt either succeeds or reports its own failure; it never falls
back to a host shell.
That latter label is reserved for auto mode with the sandbox disabled or with no primitive detected.
Alternatives remain: run Neko inside WSL (bwrap) or a container/dev-container.

Mechanics worth knowing (verified on Windows 11 Home, srt 1.0.0):

- **Network is always an allowlist.** srt has no allow-all egress (its proxy denies unmatched
  hosts), so `"sandbox_network": true` exposes only `"sandbox_domains": ["github.com",
  "*.npmjs.org", ...]`. False = hard deny-all (`deniedDomains: ["*"]`).
- **Command bytes never ride a shell command line.** srt's CLI re-parses its command through the
  sandbox account's cmd.exe, whose quoting hostile text can escape. Neko writes each command to an
  unpredictable, exclusive per-launch directory under `%TEMP%`, grants that directory only the
  access needed by `srt-sandbox`, and removes it when the process closes. The srt command line carries
  only `"<git-bash>" "<script>"`.
- **Per-user Bun stays least-authority.** The `srt-sandbox` account normally cannot execute tools
  below your profile. When Neko itself is source-run by a canonical `bun.exe`, Neko puts only that
  exact regular file in SRT's session-level `filesystem.allowRead` and makes bare `bun` resolve to
  the same immutable path inside Git Bash. SRT refcounts overlapping holders and removes the read
  ACE after the final launch resets; Neko
  never grants the containing package, npm tree, or user profile. A compiled Neko binary instead
  bridges a real external `bun.exe` only when one resolves outside the workspace on trusted PATH.
  `neko doctor` names which state is active. An npm `.cmd` shim alone is not enough; install a real
  Bun executable machine-wide/on trusted PATH if the standalone binary must run sandboxed Bun jobs.
- **Exact-file validation reverses workspace authority.** SRT receives explicit project read and
  project write-deny rules plus one unique external temp write grant; the configured network allowlist
  remains unchanged. A nested validator such as `npm test` gets a launch-local, read/execute-only
  `bun.cmd` shim. Its Bun target is passed through canonical environment indirection, current-directory
  executable lookup is disabled, and no containing package, parent, or user-profile grant is inferred.
  The shim, temporary ACLs, settings, and writable temp are removed when the launch settles.
- The Secondary Logon service (`seclogon`) must be running (it is by default; srt's error names
  it if not).

### Notes
- This sandbox is OS-process level — it does **not** defend against kernel exploits (same caveat as
  every tool in this class). For untrusted code at scale, use a VM/microVM.
- Read confinement is not complete: do not treat a live sandbox as permission to expose arbitrary
  host files. Keep approval on unless the host is disposable or a stronger outer boundary exists.
- File tools are project-plus-explicit-root confined regardless of this setting. Existing structured-write targets must
  also have exactly one hard link, closing static same-volume aliases; new-file creation remains
  available. This identity check still has a check-to-write race.
- After a Neko structured write, later byte divergence on the same path taints its checkpoint,
  refuses another structured mutation, and makes `/rewind` preserve/report the conflict. This is not
  read-to-write digest/generation CAS or filesystem transactional isolation.
- The sandbox is what keeps ordinary/full-turn `bash` on the same workspace-plus-explicit-roots
  boundary; disabling it makes Bash host-unconfined and is reported as such.
