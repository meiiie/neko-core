# Neko Core — Vision

Neko Core is growing into a **local-first agentic CLI** — a coding / automation
assistant in the spirit of **Claude Code** and **Codex CLI**, but **offline-capable**
and **config-first**.

## Why

- **Local-first / offline-capable.** Run a small open model (e.g. Qwen3-4B) on your
  own machine with no API key — and optionally point at a hosted model when you want.
- **Config-first.** Behaviour is data: swap model, provider, or policy with an edit,
  not a code change. (DNA inherited from the Neko Core inference harness.)
- **Single, sharp tool.** One `neko` command: chat with an agent that can read, edit,
  run, and search inside your project.

## Heritage

Neko Core began as a config-first inference harness for HackAIthon 2026 — Bảng C
(the competition entry lives, frozen, at `meiiie/bang_c`). This repository is the
**standalone product** that grows beyond the contest.

## North star

`neko chat` → an agent that helps you build software locally, **safely** (approval
gates on destructive actions) and **cheaply** (small local models first, hosted models
only when needed).
