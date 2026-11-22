# 1.9.4 release candidate record

- Base: main `d725b202009b2420dc9977378017de65badf7537`, including #106
  (tool-free pre-finish verification) and #107 (session writer-lock recovery).
- Tool-free turns no longer enter pre-finish verification. Linux session leases
  track boot, PID namespace and process start identity with a 10-second heartbeat
  and 60-second stale window. ACP checkpoints reject a writer that lost its lease.
- Live legacy locks without process identity are not automatically taken over.
  Remove a reported legacy lock manually only after confirming no Neko writer
  remains. Real Wiii/bwrap crash-and-reload acceptance is not claimed.
- Includes plain ACP session titles and structured post-turn Dream notices from
  #104; provider configuration, durable session format and 1.x CLI stay compatible.
- Version and baked site fallback are prepared together; final artifact sizes
  require measurement. No Cloudflare deployment, public tag or release is implied.
- PR #108 CI passed on Ubuntu, macOS and Windows for `0800687`, including the
  real-binary Wiii ACP contract. Linux gate results are in [WORKLOG](WORKLOG.md).
- Owner-supplied Windows Server 2022 / Bun 1.4.0 evidence at `0800687`:
  `e2e-conpty-ghost.ts dist/neko.exe` passed three times on a loopback SSE fixture;
  footer-copies=1 at every checkpoint, typed-echo 127/127/179 ms. Local build
  failed only startup-lifecycle ("terminal restore did not finish before the
  resume handoff", 4/4; no `ESC[?1049l` in that VM's ConPTY stream). The same
  step passed on windows-latest (Server 2025). A Server 2022 ConPTY difference
  remains unproven; this is not a full local Windows build pass.
- Publication and all 17 release assets still require verification. No scroll
  benchmark is required for this non-rendering patch.
