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
- Linux gate results are recorded in [WORKLOG](WORKLOG.md). Cross-platform CI,
  three real Windows ConPTY ghost/typing runs, publication and all 17 release
  assets must be verified before calling this published. No scroll benchmark is
  required for this non-rendering patch.
