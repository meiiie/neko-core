---
description: Port a module from the frozen bang_c heritage into neko-core
argument-hint: <heritage-module-name e.g. session.py>
---

Port `$1` from the FROZEN heritage repo into `src/neko_core/`, following
`docs/PORTING.md`.

1. READ `E:\Sach\Sua\bang_c\src\hackaithon_c\$1` (and any module it depends on). Never
   edit anything under `bang_c` — it is the frozen submission.
2. Adapt it to the coding-agent product. DROP MCQ/contest cruft (`rag_*`, `tiered_*`,
   `rubric`, `profiling`, `pred.csv`/exporter, classifier/solver MCQ logic). Keep the
   reusable pattern only.
3. Stay config-first, provider-agnostic, and safe-by-default. Keep printed strings ASCII.
4. Add or extend tests under `tests/`, run `rtk python -m pytest -q`, then commit with a
   clear message that references the PORTING step.
