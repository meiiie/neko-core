# 1.9.1 release record

This record contains only technical release evidence; existing WORKLOG history
is unchanged.

- Browser PR #95: dedicated managed profile, explicit personal consent mode,
  extension fallback and snapshot label privacy. Cross-platform CI passed;
  Windows cleanup EBUSY in the first run did not recur on the one retry.
- Windows managed backend: multi-tab lifecycle and dedicated-profile persistence
  passed. Neko wrapper: 10 operations passed with the generated pinned backend.
- Personal Chrome grant/deny/revoke remains unverified; do not claim otherwise.
- Dream PR #96: automatic bounded post-turn consolidation, manual/off controls,
  session-scoped notes and fail-closed runtime authority checks.
- Candidate version and site fallback updated together. Source changes do not
  establish a Cloudflare deployment.
- Published 2026-11-12 from commit
  `c454a3c75b3113b9f2125fb2093cba3502ae8b1d`, tree
  `49f2060c54548364bb3fb38eb0329ebd3b4fa879`. PR #97 and main
  cross-platform CI passed; release workflow
  [43225952277](https://github.com/meiiie/neko-core/actions/runs/43225952277)
  completed successfully.
- GitHub latest resolves to [v1.9.1](https://github.com/meiiie/neko-core/releases/tag/v1.9.1),
  with draft=false and prerelease=false. All 17 assets are present: five binaries,
  five SHA-256 sidecars, five gzip files, one Windows ZIP and one extension ZIP.
- Downloaded Windows binary reports version 1.9.1 and matches its published
  SHA-256 sidecar. The extension ZIP includes its required sidepanel files.
  These checks do not establish an end-to-end installer run on every platform.
- Final local code tree: 2,124 tests passed, 40 skipped, zero failures.
  Typecheck, lint, policy, build, PTY input, ACP and startup lifecycle/input
  probes passed. Windows real-terminal ConPTY ghost/typing passed three runs
  on the same source tree.
- Release diff secret scan was clean. Full historical scan reported three
  reviewed noncredential matches in synthetic Dream test fixtures from commit
  `394beb6a2c567032ca9cf95ca1e6a85c9e2af199`; no broad ignore was added.
- Release notes disclose automatic Dream's extra provider request, latency and
  manual/off choices, and the remaining personal Chrome verification limits.
  Deterministic tests do not measure live model quality.
- This post-release record does not change or recreate the v1.9.1 tag.
