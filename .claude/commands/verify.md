---
description: Run the Neko Core verification loop (tests, compile, doctor, policy)
---

Run the project verification loop and report each result concisely. Stop and show the
failing output if any step fails.

1. `rtk python -m pytest -q`
2. `rtk python -m compileall -q src`
3. `PYTHONPATH=src python -m neko_core doctor`
4. `PYTHONPATH=src python -m neko_core policy`

Report PASS/FAIL per step. `policy` exits non-zero on a FAIL verdict — treat that as a
failure.
