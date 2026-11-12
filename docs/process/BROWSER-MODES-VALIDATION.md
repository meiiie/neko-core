# Browser modes validation (1.9.1 candidate)

## Changes
- Explicit managed Chrome with a dedicated persistent profile and personal Chrome via official autoConnect session consent. Chrome DevTools MCP 1.13.0 and legacy Playwright MCP 0.0.85 are pinned.
- No automatic personal fallback, cookie copying, or remote-debugging setting changes. Existing MCP permission modes are unchanged.
- Interactive browser requests no longer force extension onboarding when a browser MCP is configured.
- Sensitive field values no longer become snapshot labels. This is not universal page or backend redaction.

## Evidence
- Configuration, CLI, privacy, and UI regression tests were observed failing before the change and passing afterward.
- Full suite before the final UI routing addition: 2109 passed, 40 skipped, 0 failed (Bun 1.4.0).
- Final focused suite: 102 passed, 0 failed. Typecheck and lint passed. Release-diff secret scan found no leaks.
- Actual pinned MCP package tool discovery verified tab tools, snapshots and screenshots. Arbitrary JS evaluation and network tools are disabled.
- Cloud Chromium page launch was blocked by host socket restrictions. No browser sandbox weakening was attempted.

## Remaining acceptance
Windows managed multi-tab/persistence and personal consent/denial/revocation smoke are separate evidence requirements. Tool discovery and unit tests do not prove end-to-end browser operation. No Browser Use speed or quality advantage is claimed here.
