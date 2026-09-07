---
description: Scan release content for secrets before an authorized public push
---

Use the canonical redacted scan in `docs/process/RELEASE.md`:

1. `gitleaks git . --config .gitleaks.toml --redact`
2. Pipe `git diff --no-ext-diff --unified=0` into
   `gitleaks stdin --config .gitleaks.toml --redact`.
3. Inspect the intended staged/new-file set too; unstaged diff alone misses new files.
   Ensure auth stores, private data, and ignored dependency caches are not being published.

Report only rule and `file:line`, never the matched credential. If gitleaks is unavailable,
report the missing gate rather than treating a plain-text search as equivalent. Do not
push while a finding is unresolved. The scan itself does not authorize publication.
