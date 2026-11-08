# Domain runtime and task-local working notes

`src/adapters/domain-runtime.ts` composes Neko's Agent, provider port and tool registry for one domain task. The caller supplies the system policy, exact MCP tools, trusted read/write/ask effects and receipt classifier. The generic coding verifier is replaced by actual domain receipts; no-op tasks can finish without an extra read.

Following [EXTENDING](EXTENDING.md), domain schemas, prompts and receipt interpretation stay in the embedding application. The installed CLI and shared coding composition are unchanged. This adapter exposes no file, shell, computer, personal-memory or delegation tools and owns its provider/transport lifetime.

Create a fresh runtime per independent task. Native calls still pass through the registry. A successful ask ends the turn; an unknown write outcome preserves the receipt and stops automatic continuation. `semanticSuccess` remains unknown until the application evaluates the outcome. A receipt proves execution, not correct intent.

Receipt classifiers can return `noop` for a known execution with no effect, separately from `succeeded`, `failed` or `unknown`. A no-op does not prove the requested goal was completed and does not block correction. In LifeMate, top-level `ok=true, done=false` is the executor's explicit no-op contract; a nested `item.done=false` on a newly created task is different and remains a successful creation.

Failed asks remain repairable; successful asks also prevent later actions in the same native batch. Plain-text questions do not count as executed asks. Explicit tool-call JSON/XML in a final response can trigger one optional native-protocol repair within the original request/deadline budget; prose is never executed or trusted as a receipt. Persistent malformed output remains `unresolved_tool_text`.

`nativeDomainHistory` preserves trusted historical call/result pairs with a separate ID namespace. System policy is seeded before preloading history, avoiding the Agent's empty-message initialization branch. Neither native history nor text-tool repair has demonstrated a reliable quality benefit in the earlier LifeMate144-run comparison; its records remain in `artifacts/neko-domain-train-20261107` in the embedding workspace.

## Optional working note

`workingNote: true` enables `DomainWorkingMemory`. The model writes a brief `<task_note>` in its normal assistant response, then uses the original native tools. There is no additional planner request, note-writing business tool, or execution of note text.

The provider-facing context adds a bounded view containing the host's exact original request, the latest model-authored note and recent execution receipt identities/outcomes. Complete observations and arguments remain in the canonical trajectory. The memory view is data, not an authorization source. It does not overwrite the stored system policy, user messages, tool results or opaque provider continuation. Only well-formed bounded notes replace the last usable note; rejected notes are counted without an automatic repair loop.

The returned result includes `workingMemory`, and `domain_working_note` events expose concise note revisions for auditing. The final display answer omits well-formed note tags, while canonical messages keep them. Notes are ephemeral to this runtime: no personal/global memory store is read and no task can reuse an already-started runtime.

## Offline consolidation

A product may curate workflow lessons from prior development traces, including successful examples, failures and counterconditions. Review the resulting bundle, then pass its concise applicable guidance as part of the domain policy. The core does not autonomously read experiment labels, update skills, schedule background jobs or promote candidate guidance.

The LifeMate integration in the sibling repository implements this as an explicit offline `dream.ts` step and a reviewed `lessons.json` bundle. This is an adaptation of memory consolidation using Neko's configured provider, not Anthropic's Managed Agents Dreams service.

## Evidence and limits

`test/domain-runtime.test.ts` covers preserved native calls/continuation, ask stop, missing observations, no-op completion and isolation. `test/domain-memory.test.ts` covers immutable source messages, rejection of malformed notes, fallible-note separation from receipts and cross-task isolation. Passing these checks does not establish task-quality improvement; compare notes on/off using the same model, data and budget.

A note can confidently preserve a wrong plan. It can also duplicate context or add latency. Keep the feature optional until domain measurements justify it; retain original request and raw tool observations so a later decision can contradict the note.

## Decision review options (2026-11-08)

`decisionReview: "terminal"` permits one bounded end-of-turn review against actual receipts.
`"prewrite"` holds draft writes before execution; `decisionEvidence` and
`clarificationReview` are separate experimental switches. All consume the same request
budget. A held proposal is not an executed receipt and cannot authorize a mutation.
Quarantined tool text is never converted into tool calls. Successful native clarification
still ends the turn. Fresh independent tasks require fresh runtime instances.

The host must evaluate quality separately: fewer writes or more questions alone do not
prove a better agent. Defaults of the installed Neko CLI are unchanged.
