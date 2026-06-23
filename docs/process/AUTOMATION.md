# Neko Code — scheduling & automation

Neko is a local-first CLI, so it does **not** ship a background scheduler daemon (that would mean a
long-running process + its own cron engine — the wrong shape for a CLI). The schedulable unit is the
non-interactive one-shot:

```bash
neko run --yolo "your task"        # runs to completion, prints the result, exits
```

Let the OS scheduler trigger it — it already does scheduling well:

- **Windows (Task Scheduler)**
  ```powershell
  schtasks /create /tn "neko-nightly" /tr "neko run --yolo \"summarize today's git log\"" /sc DAILY /st 02:00
  ```
- **macOS / Linux (cron)**
  ```cron
  0 2 * * *  cd /path/to/repo && neko run --yolo "summarize today's git log" >> ~/neko-cron.log 2>&1
  ```

Tips:
- Pick the model/endpoint with `--profile` (or a `./neko.json`); the key comes from env or
  `~/.neko-core/config.json` (no interactive `/login` in a scheduled run).
- `--yolo` auto-approves gated tools (the seatbelt + optional `adversarial_check` still apply).
- For recurring *workflows*, save a recipe and run it: `neko run --yolo "$(cat task.md)"` or a recipe.
