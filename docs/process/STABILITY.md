# Stability and support

Neko Core 1.x is the stable product line. Version 1.0.0 established the first supported baseline for the
standalone CLI, the package-root SDK, and the ACP v1 server. "Stable" means that users can update within 1.x
without surprise migrations or undocumented contract breaks; it does not mean that the software, operating
system, or upstream model providers can never have bugs.

## Compatibility commitments

| Surface | 1.x commitment |
|---|---|
| CLI | Existing commands, documented flags, exit behavior, and non-interactive use remain compatible. |
| Configuration | Existing profiles, precedence rules, provider routes, and supported environment variables remain readable. |
| Durable data | Sessions, skills, recipes, memory, and auth metadata are migrated or read compatibly; they are never silently discarded. |
| SDK | Exports from the package root and the Apache-licensed `sdk/` boundary change only through documented deprecation. |
| ACP | Neko remains an ACP v1 server until clients and Neko can migrate without losing durable continuity. |
| Authority | Named permission modes keep their meaning. Security boundaries may become stricter, but never silently weaker. |
| Delivery | The updater, one-line installers, SHA-256 sidecars, and exact-version rollback remain supported. |

If a safe data migration cannot be completed, Neko must preserve the original data and stop with an actionable
error. A release may not reinterpret a stored permission grant as broader authority.

## Versioning

Neko Core follows [Semantic Versioning](https://semver.org/):

- **Patch releases** contain compatible bug and security fixes. A security fix may tighten a previously unsafe
  behavior.
- **Minor releases** add compatible features and may introduce deprecation warnings.
- **Major releases** may remove deprecated behavior or intentionally change a public contract, with an explicit
  migration guide.

A normal removal is announced through at least one minor release before the next major release. An actively
exploitable security issue may require a faster change; the release notes must name the exception and the user
action required.

## What is outside the promise

Neko cannot freeze services it does not control. Model availability, pricing, quotas, provider-side OAuth,
third-party MCP servers and skills, and operating-system sandbox primitives may change independently. Neko
keeps these behind adapters, discovers capabilities where possible, and fails explicitly when an upstream
contract disappears. A provider catalog changing is not itself a Neko compatibility break.

Experimental or lab surfaces are labeled as such in the UI or their capability guide and are not covered by
the same API guarantee until promoted to stable. Security, privacy, and credential-handling invariants still
apply to experimental code.

## Supported releases

The latest stable 1.x release receives bug and security fixes. Older 1.x binaries and checksums stay available
for reproducible rollback, but fixes are not normally backported to every previous patch. Users should run
`neko update` to return to the supported release after a rollback investigation.

`main` is the development branch. It must pass CI, but it is not a substitute for a tagged release and is not
the recommended installation source.

## Evidence and reporting

Each release is built for five targets and passes type, lint, unit/integration, policy, compiled-render,
real-terminal input, ACP, and startup/exit gates where the target can run natively. Published binaries have
SHA-256 sidecars, and a public tag is never rewritten. The complete delivery procedure is in
[RELEASE.md](RELEASE.md).

Compatibility regressions belong in the public issue tracker. Suspected vulnerabilities must use the private
reporting route described in [SECURITY.md](../../SECURITY.md).
