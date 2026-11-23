# 1.9.5 release candidate record

- Base: main `8f5044123aa9a73823239be11c439bc42d6768e1`. Scope since v1.9.4:
  #109 (CI shard parallelism and test cleanup only), #110 (ACP task writer locks
  released on clean SIGTERM/SIGINT/SIGHUP shutdown) and #111 (hidden current-fact
  verification turn removed; the Hoàng Sa/Trường Sa web freshness gate remains).
- A failed close or SIGKILL still leaves the task writer lock in place on purpose.
  Provider configuration, durable session format and the 1.x CLI stay compatible;
  no configuration migration is required.
- Version and baked site fallback are prepared together. No Cloudflare deployment
  is implied by this record.
- Linux gate results are in [WORKLOG](WORKLOG.md). No scroll benchmark is
  required for this non-rendering patch. Publication and all 17 release assets
  still require verification.
