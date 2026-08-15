# Neko Core licensing

Effective for source distributions made from this repository on or after
2026-08-15, Neko Core uses a split-license model.

## License map

| Scope | Public license |
| --- | --- |
| Original project material outside `sdk/`, unless a file says otherwise | GNU Affero General Public License v3.0 only (`AGPL-3.0-only`) |
| Material inside `sdk/` with an Apache SPDX header or covered by `sdk/LICENSE` | Apache License 2.0 (`Apache-2.0`) |
| Third-party, vendored, generated, reference, or externally sourced material | Its own license and notices |

The `sdk/` path is a hard licensing boundary. A file is not Apache-licensed
merely because it is called an SDK, is exported by the main package, or calls
the core. The current `neko-core` package and its `src/index.ts` exports load
the AGPL-covered core and are therefore AGPL-covered. There is no separately
published Apache SDK yet.

Future Apache SDK code must be independently usable as a client/protocol
library, must not import core implementation code, must carry
`SPDX-License-Identifier: Apache-2.0`, and must ship its own `LICENSE` and
`NOTICE` files.

## AGPL source availability

If you modify the AGPL-covered program and let users interact with that
modified version over a network, AGPL section 13 requires a prominent offer
of the Corresponding Source. Official builds should point to the exact source
tag or commit used for the build, not merely to a moving branch.

## Commercial dual licensing

The AGPL-covered material may also be offered under a separate written
commercial agreement by the applicable copyright holder or an authorized
licensor. The public repository does not itself grant that commercial
license. See [COMMERCIAL-LICENSE.md](COMMERCIAL-LICENSE.md).

The Apache SDK does not require a commercial license for uses already allowed
by Apache-2.0.

## Earlier MIT releases

Releases and copies that were validly received under the MIT License remain
licensed under that MIT grant. This change is prospective and does not revoke
rights already granted. The historical MIT text is retained in
[`LICENSES/MIT.txt`](LICENSES/MIT.txt).

## Contributions and trademarks

Contributions to the dual-licensed core must follow
[CONTRIBUTOR-LICENSE-POLICY.md](CONTRIBUTOR-LICENSE-POLICY.md). Code licenses
do not grant rights to Neko Core or The Wiii Lab names, logos, or branding;
see [TRADEMARKS.md](TRADEMARKS.md).
