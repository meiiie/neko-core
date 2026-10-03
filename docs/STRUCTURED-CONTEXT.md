# Structured context (opt-in)

The structured context path connects the same host-owned compaction transaction to
scoped task sessions in the terminal, CLI and ACP. It does not change ordinary
legacy chat or permission defaults.

## Enable and resume

Start `neko --context-memory`, then `/task new <label>`. Use `/compact` to compact
an eligible historical head, `/task status` to inspect the active mode and
`/task resume <session-id>` to reopen it. Launch with `--context-memory` again when
resuming a structured session. The same flag applies to scoped `neko run` and ACP;
ACP advertises `/compact`. A profile may instead set `"context_mode": "structured"`.

Structured sessions use schema 3. The effective configuration identity includes the
mode and response-token reserve. A legacy client, wrong root, changed configuration
or missing opt-in rejects resume rather than rewriting provenance. Existing schema 2
sessions remain unchanged. There is no automatic migration; `import-v1` continues
to create legacy sessions and is rejected when structured mode is selected.

## What is retained

Before replacing model context, the host writes immutable source groups, validates a
bounded candidate, and synchronously publishes its working messages and journal
reference in one revision-controlled parent checkpoint. Only then does the Agent
install those messages, without yielding between publication and installation.
A canceled preparation leaves the prior active state. Uncertain publication halts
further work until the saved session is reopened; shutdown cannot overwrite it with
stale messages. Stale writer locks are not automatically cleared.

The compact note is an explicitly unverified assistant message, never a system
instruction. `source_lookup` can page an exact source ID from the active task's
committed branch. These are historical working snapshots: earlier observation
masking may already have shortened tool content. They are not universal original
file-byte archives, and a valid citation does not prove a summary is semantically
correct. Tool outcomes marked unknown remain unknown.

User-visible display history is separate from model context. Older prompts remain
reachable through history navigation after compaction and resume. Home/End edit the
draft; Ctrl+Home/Ctrl+End navigate the transcript.

## Bounds and verification limits

- The existing exact read-file ledger remains limited to 256 events / 8 MiB. At its
  limit, unsafe compaction is blocked and raw working history is retained. This is
  not an unlimited-session guarantee.
- Source objects, active source views and caches remain bounded. Disk archives can
  grow; there is no automatic garbage collection. Repeated compaction may archive
  overlapping retained tails.
- Final publication and bounded parsing perform synchronous work. Paging is not a
  claim of constant total RSS or a measured improvement in end-to-end latency.
- Exact source lookup is available; automatic fact extraction, semantic retrieval,
  and user-editable pinning are not enabled by this flag.
- Integration mechanism tests use scripted providers and real local runtime/tools.
  The earlier Z.ai trial completed 200 of 320 planned turns before an environment
  network-policy block. It predates this integration and does not validate it.

Do not enable this path on an irreplaceable session expecting an automatic downgrade.
Keep ordinary legacy sessions for workflows that require older Neko clients.
