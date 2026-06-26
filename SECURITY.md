# Security Policy

## Supported versions

Neko Code is pre-1.0 and ships from `main`. Security fixes land on `main` and in the next tagged release;
please run the latest version (`neko update`).

| Version | Supported |
| ------- | --------- |
| latest release / `main` | ✅ |
| older releases | ❌ |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's **[Report a vulnerability](https://github.com/meiiie/neko-core/security/advisories/new)**
(repository → **Security** tab → **Report a vulnerability**). This opens a private advisory visible only
to you and the maintainers.

When reporting, please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal proof of concept if possible),
- affected version / commit, and OS.

We aim to acknowledge a report within a few days and will keep you updated on the fix. Once a fix is
released, we're happy to credit you (unless you prefer to stay anonymous).

## Handling secrets

Neko never commits or prints API keys: they come from environment variables (`NEKO_API_KEY` /
`OPENAI_API_KEY` / `NVIDIA_API_KEY`) or a gitignored `~/.neko-core/config.json`. If you find a path where
a key could leak into logs, the terminal, or a committed file, treat it as a vulnerability and report it
privately as above.

## Scope notes

- `bash` / `write_file` / `edit` are **approval-gated** by design; a way to bypass that gate (or the
  catastrophic-command seatbelt) without user approval is in scope.
- `/remote-control` binds to loopback and `/relay` is end-to-end encrypted; a way to reach either without
  the per-session token, or to read relayed messages, is in scope.
