# Provider incidents and feedback — 2026-09-07

Historical incident analysis. The initial catalog/feedback follow-up had 53 targeted
tests passing but a non-green full-suite run. Subsequent fixes, backend deployment
and the v1.6.0 release gate are tracked in [WORKLOG](../process/WORKLOG.md) and
[ROADMAP](../process/ROADMAP.md), not inferred from this dated checkpoint.
No ProgramBench campaign is part of this work.

Initial verification: four sequential CI-style shards, 1,592 pass / 14 skip / 0 fail;
typecheck, lint, doctor/policy, production build, PTY input, ACP and startup/exit
probes completed. Doctor/policy retain expected local configuration warnings.
A single-process run first hit the existing fullscreen timing assertion; no assertion
or timeout was weakened. A real Codex 0.145.0 transport initialized from user-home cwd
without a model request. The local live account catalog was unavailable, so Astra
entitlement and end-to-end inference on the reported account remain unverified.

## Z.AI HTTP 404 `/v4/v1/messages`

The screenshot proves a Messages request reached an OpenAI-compatible `/v4` route;
it does not prove an invalid API key or unavailable GLM model. Without the friend's
redacted config we cannot identify which file or environment variable supplied it.

Code inspection found that `/login` changed the active profile and cleared model/key,
but left top-level endpoint/protocol/key-env overrides able to contaminate the new
profile. A regression now reproduces paid Z.AI -> B.AI -> Coding Plan switching.
Profile changes retain legacy connection settings with their previous owner, and
previewing another stored profile no longer borrows its connection overrides.
Unscoped legacy connections are retained in a non-colliding legacy profile on activation.

For the built-in `zai` Anthropic route, an exact legacy official `/api/paas/v4` or
`/api/coding/v4` file setting is normalized to `/api/anthropic` in effective config.
Custom hosts, paid `zai-openai`, and explicit environment overrides are unchanged.
An incompatible explicit Messages endpoint fails before credentials are resolved or
a request is sent, with instructions to repair the selected route. No billing fallback.

Official endpoint: [Z.AI Coding Plan / Claude Code](https://docs.z.ai/devpack/tool/claude).

## ChatGPT transport when cwd is the user's home

The original lexical boundary rejected `~/.neko-core/codex-home` because the user had
launched Neko from `~`. GPT-5.5 used the direct transport, explaining why switching
to it avoided the failure.

The exception is narrowly scoped to cwd exactly equal to the resolved user home and
the canonical built-in Neko control directory. Drive roots, arbitrary ancestor
workspaces, project-local overrides, and junction redirects remain denied. Codex
still receives isolated HOME/CODEX_HOME, no ambient project instructions or ancestor
project traversal, disabled native execution features and skills, `environments: []`,
and Neko-owned dynamic tool callbacks. This is transport configuration isolation,
not a new OS sandbox or permission bypass. No GUI automation is needed.

## GPT-6 Astra

Two independent gates excluded it: a live-catalog allowlist limited sidecar models
to `gpt-5.6-*`, and the hybrid transport used the same family check. The follow-up
removes the live name allowlist. Model transport, effort, context and minimum client
version come from account-catalog metadata; successful empty catalogs stay empty.
The client-version query uses the newer of installed Codex and the tested 0.153.4
compatibility baseline. That is not proof of compatibility with a future protocol.

The routing cache lasts five minutes and is invalidated by bearer or account changes.
Known direct bootstrap models do not require an extra catalog request before their
first turn; newly selected/unknown models resolve metadata before transport dispatch.
Legacy native names remain only as a catalog-unavailable fallback, with GPT-5.6's
older supported minimum retained and Astra requiring Codex 0.153.4. No default
upgrade, invented entitlement, or silent substitution for Astra is introduced.

The native bridge regression exercises both Luna and Astra with the same auth,
tool-callback, image, streaming and usage contract. A hypothetical never-coded model
tests discovery, metadata-driven routing, and minimum client-version gating. Live
account availability is a separate observation, not proven by a mock or the bundled
Codex catalog. Catalog discovery can be cancelled; a cancelled refresh waiter does
not cancel another operation sharing that refresh.

Sources: [Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra),
[Codex/ChatGPT changelog](https://learn.chatgpt.com/docs/changelog),
[workspace model availability](https://learn.chatgpt.com/docs/enterprise/workspace-model-availability),
[Codex configuration](https://learn.chatgpt.com/docs/config-file/config-reference).

## Feedback

The owner selected `meiiiekhp888@gmail.com`. The command now has a separate notes
editor, explicit current-session log choice, complete scrubbed-attachment preview,
and email-draft/JSON export. No hidden reasoning, images, credential stores, other
sessions or unrestricted config dump is bundled. Notes do not enter model context.
Scrubbing is best-effort, not an anonymity guarantee; the preview is mandatory.

The official Codex CLI 0.153.4 feedback menu was exercised in an isolated temporary
home without a model request: category selection followed by optional session logs
and diagnostics. It was cancelled before upload. No report was submitted to OpenAI.

At the initial checkpoint, Cloudflare Email Sending returned Unauthorized and the
chosen address was not verified. The owner subsequently verified it; the dedicated
Email Routing Worker now accepts synthetic email with deduplicated receipts.
Service acceptance still does not establish Inbox placement. A saved `.eml` is not
automatic delivery. See the [feedback privacy and delivery contract](../process/FEEDBACK.md).
