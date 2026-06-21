---
description: Scan the working tree for secrets before any public push
---

Before pushing Neko Core publicly, scan for leaked secrets and excluded artifacts
(`docs/PORTING.md` "Hard exclusions"). Be thorough; report `file:line` for every hit,
and if clean, say so explicitly.

1. Enumerate tracked files with `rtk git ls-files` (do NOT scan ignored/scratch dirs).
2. Search those files for credential patterns:
   - API keys/tokens: `nvapi-`, `sk-`, `AKIA`, `ghp_`, `xox[baprs]-`
   - Inline keys: `api_key"\s*:\s*"[^"]+"`, `Authorization: Bearer `
   - Private keys: `BEGIN [A-Z ]*PRIVATE KEY`
3. Confirm none of these are tracked: `.env*`, `*.gguf`/`*.bin`/`*.safetensors`,
   any `.neko-core/config.json`, `run-*/`, `output-*/`, `traces-*/`, finetune data/scripts,
   or competition-only docs.
4. Summarize: CLEAN or a list of findings to fix before pushing.
