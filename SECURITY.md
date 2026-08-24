# Security Policy

## Supported versions

Neko Core 1.x is the stable product line. Security fixes land on `main` and ship in a new tagged stable
release; users should run the latest release with `neko update`. The broader compatibility commitment is in
[docs/process/STABILITY.md](docs/process/STABILITY.md).

| Version | Supported |
| ------- | --------- |
| latest stable 1.x release | Yes |
| older 1.x releases | No backports; retained for rollback |
| `main` and pre-release builds | Development only |
| pre-1.0 releases | No |

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

- Neko is **consequence-gated**. Trusted workspace work can proceed in the default `auto` mode, while host
  computer control, policy changes, credential/system paths, work outside trusted roots, and catastrophic
  shell commands remain explicitly governed or refused. A way to exceed the active authority, bypass a hard
  seatbelt, or turn `plan` mode into mutation is in scope.
- `/remote-control` binds to loopback and `/relay` is end-to-end encrypted; a way to reach either without
  the per-session token, or to read relayed messages, is in scope.
