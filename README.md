# Neko Core

> A **config-first, offline-first** local LLM inference harness — runs a single **≤5B** model in one self-contained Docker container, engineered to **never score zero**.

**By [The Wiii Lab](https://github.com/meiiie).** Built for **HackAIthon 2026 — Bảng C (Innovator)** by team **Neko Core**, Vietnam Maritime University (VMU).

---

## What it is

Neko Core packages a single small language model (**Qwen3-4B-Instruct-2507**, ≤5B params) into one **offline, self-contained** runtime: it reads multiple-choice questions from `/data`, lets the model reason, and writes answers to `/output/pred.csv` — with the engineering discipline of a production system.

Three ideas drive it:

- **Config-first harness.** Strategies (self-consistency, tiered, tool-use, reading, RAG…) are typed, swappable processors selected by a policy gate. Adapting to a rule change is a *data* edit, not a code change.
- **Choose-by-measurement.** Every "lever" (fine-tune, RAG, tool-use) is built, measured on held-out data, and shipped *only if it provably helps*. We keep the receipts — including what we rejected and why.
- **Never-zero engineering.** Architecture-portable across every NVIDIA GPU (≥ Pascal) with a CPU fallback, an inviolable output contract, and per-question checkpoint/resume — so a single failure can never zero a whole 2000-question run.

## Status

🚧 This repository is the home of Neko Core.

The competition submission is **frozen** at [`meiiie/bang_c`](https://github.com/meiiie/bang_c) until **2026-06-23**. The cleaned engine source, the `neko` CLI, and the Docker image land here right after submission.

## Quick start *(arrives with the engine)*

```bash
# CLI
pip install neko-core
neko run --data ./data --output ./output      # /data/*_test.csv → /output/pred.csv (qid,answer)
```

```bash
# or the self-contained offline container
docker run --rm --gpus all \
  -v "$PWD/data:/data" -v "$PWD/output:/output" \
  hacamy12345/neko-core:latest
```

## Team

Team **Neko Core** — Vietnam Maritime University (VMU):

| Name | Role |
|---|---|
| Nguyễn Mạnh Hùng | Team lead |
| Bùi Việt Hoàng | Member |
| Phạm Thị Minh Hồng | Member |
| Phạm Thị Thu Thảo | Member |
| Nghiêm Thị Mỹ Linh | Member |

## License

MIT © 2026 The Wiii Lab — see [LICENSE](LICENSE).
