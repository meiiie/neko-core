# Release Rules — how a Neko Code version ships

Every rule here was paid for by a real incident (v0.7.0–v0.7.7, 2026-07-06/07). Follow the order;
skipping a gate is how field bugs happen.

## 1. Gates — ALL green before the tag exists

Run on the exact commit that will be tagged, with the runtime that will ship (see §5):

| Gate | Command | What it catches |
|---|---|---|
| Types (both compilers) | `bun run typecheck` + `bun run typecheck:stable` | tsgo/tsc divergence |
| Full suite, ship runtime | `bun test` under the pinned runtime | logic + sims (incl. the differ-less fallback sim) |
| Policy audit | `bun bin/neko.ts policy` | safe/gated boundary drift |
| Build + render smoke | `bun run build` (compiles, then `__uiprobe`) | artifact-only breakage (the jsxDEV class) |
| Input smoke | part of `bun run build` (`scripts/input-probe.ts`) | a runtime that renders but drops stdin (the Bun-1.3.14 class) |
| Ghost + typing e2e | `bun scripts/e2e-conpty-ghost.ts dist/neko.exe` ×3 | ConPTY displacement AND dead input, on a REAL terminal (typed-echo asserted — "clean" without input is hollow) |
| Scroll bench (render changes only) | `bun scripts/bench-scroll-conpty.ts` | feel regressions; compare the baselines in the script header |
| Secret scan | `/secret-scan` | leaked keys before a public push |

## 2. Docs — part of the release, not an afterthought

- `CHANGELOG.md`: a dated section, written for USERS (what changed for them, with measurements where
  claims are made). No marketing adjectives without a number behind them.
- `docs/process/WORKLOG.md`: the engineering story (what broke, how it was proven, what it cost).
- `docs/process/ROADMAP.md`: status line reflects the new release.
- Version bumped in BOTH `src/shared/version.ts` and `package.json`.

## 3. Tag → watch → verify (never tag-and-walk-away)

1. Commit, push `self-improve`, fast-forward `main`, push, tag `vX.Y.Z`, push the tag.
2. WATCH the release workflow to completion (a monitor, not hope).
3. Verify, every time: **5/5 assets** attached · `releases/latest` resolves to the new tag ·
   `isDraft: false` · install one-liner fetches the new version end-to-end when the change warrants it.

## 4. Release notes — curated, for humans

`gh release edit vX.Y.Z --notes-file ...` replaces the auto-generated commit list with: 2-4 highlight
bullets (user language, numbers included), the install one-liner, upgrade notes (who needs to act),
and a link to the CHANGELOG section for detail.

## 5. Runtime discipline

- The embedded runtime is pinned in `ci.yml`/`release.yml` (currently bun **canary** — stable 1.3.14
  drops Windows stdin; `bun-stable-watch` files the revert issue the day a newer stable ships).
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

- One release at a time is the **known-good baseline** (currently **v0.7.7**). New features target
  the next minor; only field-driven fixes may move the baseline pointer.
- **Rollback is first-class and it STICKS.** Two public paths, both pin so auto-update can't undo them:
  - In-app: `neko update 0.7.7` — downloads that exact version (up OR down) and pauses auto-update
    (`neko update` with no version returns to latest and resumes it).
  - Installer (version as an ARGUMENT — the rustup/uv-style form, cleaner than an env line):
    - Windows: `& ([scriptblock]::Create((irm https://neko.holilihu.online/install.ps1))) -Version 0.7.7`
    - Unix: `curl -fsSL https://neko.holilihu.online/install.sh | sh -s -- --version 0.7.7`
    - `NEKO_VERSION=v0.7.7` before the one-liner still works as a fallback. Either way the installer
      installs + pins.
  - The pin is `auto_update: false` in `~/.neko-core/config.json`, NOT a new field: it must be
    honored by the version being rolled back TO. Every release ≥ 0.7.4 honors it, so a rollback to
    0.7.7 holds; a new pin field would be ignored by the old binary and the user would be dragged
    forward on the next launch. A baseline nobody can *stay* on is a label, not a guarantee.

## 8. LTS / 1.0 bar

The 1.0 (long-term stable) designation waits for BOTH: the runtime pin retired onto a stable bun,
AND a field soak with no new incident class. Until then "stable" means: the recommended,
evidence-backed, returnable baseline — exactly what §1–§7 produce.
