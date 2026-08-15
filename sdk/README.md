<!-- SPDX-License-Identifier: Apache-2.0 -->

# Neko Core SDK boundary

This directory is the only reserved Apache-2.0 SDK boundary in this
repository. It currently contains no published SDK implementation.

Future code placed here must be an independently usable client or protocol
library, must not import Neko Core implementation modules, and must carry an
Apache-2.0 SPDX header. Re-exporting or linking the AGPL core does not turn it
into Apache-licensed SDK code.

See `LICENSE` and `NOTICE` in this directory and `../LICENSING.md` for the
repository-wide license map.
