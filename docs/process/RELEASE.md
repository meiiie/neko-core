# Release Rules — how a Neko Core version ships

Every rule here was paid for by a real incident (v0.7.0–v0.7.7, 2026-07-06/07). Follow the order;
skipping a gate is how field bugs happen.

## 1. Gates — ALL green before the tag exists

Run on the exact commit that will be tagged, with the runtime that will ship (see §5):

| Gate | Command | What it catches |
|---|---|---|
| Types | `bun run typecheck` | native TypeScript 7 diagnostics |
| Lint | `bun run lint` | anti-slop and trust-boundary mistakes |
| Full suite, ship runtime | `bun test` under the pinned runtime | logic + sims (incl. the differ-less fallback sim) |
| Policy audit | `node bin/neko-source.cjs policy` | safe source bootstrap + boundary drift |
| Build + render smoke | `bun run build` (compiles, then `__uiprobe`) | artifact-only breakage (the jsxDEV class) |
| Input smoke | part of `bun run build` (`scripts/input-probe.ts`) | a runtime that renders but drops stdin (the Bun-1.3.14 class) |
| Startup + exit e2e | `bun scripts/e2e-startup-lifecycle.ts` | incomplete first frame and terminal-restore byte races |
| Ghost + typing e2e | `bun scripts/e2e-conpty-ghost.ts dist/neko.exe` ×3 | ConPTY displacement AND dead input, on a REAL terminal (typed-echo asserted — "clean" without input is hollow) |
| Scroll bench (render changes only) | `bun scripts/bench-scroll-conpty.ts` | feel regressions; compare the baselines in the script header |
| Secret scan | `gitleaks git . --config .gitleaks.toml --redact`, then pipe `git diff --no-ext-diff --unified=0` into `gitleaks stdin --config .gitleaks.toml --redact` | leaked keys in tracked history or the release diff, without treating ignored dependency caches as release content |

## 2. Docs — part of the release, not an afterthought

- `CHANGELOG.md`: a dated section, written for USERS (what changed for them, with measurements where
  claims are made). No marketing adjectives without a number behind them.
- `docs/process/WORKLOG.md`: the engineering story (what broke, how it was proven, what it cost).
- `docs/process/ROADMAP.md`: BOTH the `## Current status` heading and the `**Current release:**`
  bullet under it. Missing the second one shipped a roadmap claiming v0.17.1 after v0.18.1 was out.
- `README.md` carries no version number by design — the release badge is the live one. If a number
  ever creeps back in, delete it rather than maintain it.
- `cloudflare/site/public/index.html`: the baked `data-release` values are the FAIL-OPEN fallback,
  shown when the GitHub API is unreachable. Refresh them at release time and redeploy the site;
  the live path needs no deploy, this one does.
- Version bumped in BOTH `src/shared/version.ts` and `package.json`.

## 3. Tag -> draft -> publish -> verify (never tag-and-walk-away)

1. Commit the exact candidate and push/fast-forward `main`.
2. WATCH the cross-platform `ci` workflow to completion. Only then create and push `vX.Y.Z`.
3. The release workflow creates one **draft**, attaches the browser bundle, five binaries, five SHA-256
   sidecars, five gzip transfer artifacts, and one user-friendly Windows ZIP, and publishes only after the complete 17-asset set exists. Users and installers never see a
   half-built release.
4. WATCH the release workflow to completion (a monitor, not hope).
5. Verify, every time: **5/5 binaries + 5/5 SHA-256 sidecars + 5/5 gzip transfer artifacts + the Windows ZIP** attached · the browser-extension ZIP when
   that workflow step exists · `releases/latest` resolves to the new tag · `isDraft: false` · install
   one-liner fetches the new version end-to-end when the change warrants it.

## 4. Release notes — curated, for humans

`gh release edit vX.Y.Z --notes-file ...` replaces the auto-generated commit list with: 2-4 highlight
bullets (user language, numbers included), the install one-liner, upgrade notes (who needs to act),
the 1.x compatibility impact, supported platforms/checksums, and a link to the CHANGELOG section for detail.
Major milestones open with what the stability designation means; they do not bury the contract below a raw
commit list.

## 5. Runtime discipline

- The embedded runtime is pinned exactly in `ci.yml`/`release.yml` (currently stable Bun **1.4.0**).
  Bun 1.4.0 includes the native Windows IOCP/TTY engine that replaced the 1.3.14 raw-stdin failure path;
  Neko's real PTY input and lifecycle probes remain mandatory so a future runtime regression cannot pass on
  version identity alone.
- `bun --revision` is logged at every release compile: the exact embedded runtime commit is always
  on record for forensics.

## 6. Re-tag drill (and when NOT to)

- Deleting a git tag DEMOTES its GitHub release to **draft** → `releases/latest` silently falls back
  and the installer serves the old version. After any re-tag: `gh release edit vX.Y.Z --draft=false
  --latest`, then verify `releases/latest`.
- **Never re-tag a version that has lived publicly** (auto-update compares version strings — users
  already on it will silently keep the old bytes forever). Bump instead. The only exception: the tag
  is minutes old AND the owner explicitly orders the re-tag; then announce that affected users must
  re-run the installer once (it overwrites same-version installs).

## 7. Stable baseline + rollback

- One release at a time is the **known-good baseline** (currently **v1.0.0**). New features target
  the next minor; only field-driven fixes may move the baseline pointer.
- **Rollback is first-class and it STICKS.** Two public paths, both pin so auto-update can't undo them:
  - In-app: `neko update 1.0.0` — downloads that exact version (up OR down) and pauses auto-update
    (`neko update` with no version returns to latest and resumes it).
  - Installer (version as an ARGUMENT — the rustup/uv-style form, cleaner than an env line):
    - Windows: `& ([scriptblock]::Create((irm https://neko.holilihu.online/install.ps1))) -Version 1.0.0`
    - Unix: `curl -fsSL https://neko.holilihu.online/install.sh | sh -s -- --version 1.0.0`
    - `NEKO_VERSION=v1.0.0` before the one-liner still works as a fallback. Either way the installer
      installs + pins.
  - The pin is `auto_update: false` in `~/.neko-core/config.json`, NOT a new field: it must be
  honored by the version being rolled back TO. Every release ≥ 0.7.4 honors it, so a rollback to
  1.0.0 holds; a new pin field would be ignored by the old binary and the user would be dragged
    forward on the next launch. A baseline nobody can *stay* on is a label, not a guarantee.

## 8. LTS / 1.0 bar

The 1.0 designation requires BOTH a stable embedded Bun and owner-accepted field soak with no open incident
class. The v1.0.0 baseline satisfied this on 2026-08-24: Bun 1.4.0 carried the native Windows stdin fix, the
owner confirmed the current interactive build stable after the storage reboot, and the startup/exit lifecycle
regression joined the existing input, fullscreen, sandbox, updater, provider-stream, and crash-recovery gates.

This is a compatibility and rollback promise, not a claim that bugs are impossible. A new incident class ships
as a new patch version after the same gates; a public tag is never rewritten.

## 9. Release integrity

Repository release immutability applies to releases published after the policy is enabled. The workflow must
therefore keep every release in draft state until all assets are attached. Publication locks the tag and assets
and lets GitHub issue release provenance; a failed build leaves a repairable draft rather than a public partial
release. Older releases, including any version published before the policy was enabled, retain their explicit
SHA-256 sidecars and the never-retag rule but cannot be made retroactively immutable by GitHub.
