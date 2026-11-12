# Browser modes implementation plan

**Goal:** explicit managed and personal Chrome modes, multi-tab tools through the existing governed MCP boundary, and a safe extension fallback.
**Architecture:** reuse Chrome DevTools MCP with pinned version and page-ID routing. Managed owns a separate persistent profile; personal uses Chrome's autoConnect consent, never changes browser settings. Keep existing Playwright modes and bridge compatible. No new agent loop or arbitrary REPL.
**Constraints:** no automatic fallback into personal Chrome; no cookie copying; preserve auto/default/plan and ACP policy; no claims of OS sandboxing or perfect redaction. User approved these two product modes and instructed implementation.

- [ ] Regression tests for mode configuration, aliases, telemetry off, unsupported mode/no mutation and idempotent setup.
- [ ] Implement a small pure browser backend config builder and integrate setup/CLI help.
- [ ] Reproduce snapshot sensitive value leak with DOM fixtures; redact sensitive values and editable text before serialization.
- [ ] Test policy denials/cancel at existing MCP boundary; document authority and all-tab scope for personal Chrome.
- [ ] Run relevant tests, typecheck, lint, full suite, package checks and independent security review.
- [ ] Open draft PR; no merge or tag from this worker. Live Windows smoke is coordinated by parent and must be recorded separately.
