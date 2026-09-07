# Feedback and privacy

## Destination and delivery status (2026-09-07)

The owner selected **meiiiekhp888@gmail.com** as the private feedback inbox on
2026-09-07. There is no public feedback website or public report listing.

The Cloudflare receiver is verified and the dedicated email Worker is deployed at
`https://neko-feedback.holilihu.online/v1/feedback`. Two synthetic reports (454 and
500,512 bytes) were accepted by the real email binding; identical submissions
returned the existing receipt. This verifies service acceptance, not Gmail Inbox
placement. The CLI workflow is included from **v1.6.0**; it is not present in v1.5.1.

`/feedback` opens this local workflow:

1. Choose a category.
2. Enter optional notes in a dedicated editor, up to 4,000 characters. Notes do not
   enter the model conversation or normal prompt history.
3. Choose whether to include the current session's text and tool log.
4. Review the exact scrubbed JSON in an unabridged, scrollable viewer.
5. Choose **Send reviewed feedback** to submit that snapshot through Cloudflare to
   the private inbox. Alternatively save an email draft (`.eml`, report attached)
   or the report (`.json`) for manual attachment.

Files are saved under `~/.neko-core/feedback/` with exclusive creation; existing
reports are never overwritten. Cancelling the form saves and sends nothing. Sending
first saves a JSON copy; if this fails, nothing is uploaded. A saved draft is not a
submitted report. Mail-client support for editable `.eml` files varies; JSON is the
fallback. Feedback can be sent before login or model selection and never calls the model.

Esc/Ctrl+C abort waiting; closing the TUI aborts its request. An already uploaded
report may still be delivered. Neither client nor server automatically repeats an
upload with an unknown outcome. Queued CLI input resumes when the operation settles.

## What is included

Basic diagnostics are allowlisted: random report ID (not the session ID), timestamp,
category, Neko version, OS family, architecture, and known provider/model identifiers.
Custom provider/model names become `custom`. Optional session content consists of
user/assistant text, tool calls/results, and displayed errors/information. Tool logs
do not inherit the normal transcript UI's folding or 400-line truncation.

The log budget is 512 KiB, with recent entries prioritized and omitted entries
counted in the preview. This is the current in-memory session, not every session on
disk, not all process logs, and not history already removed by compaction.

Not read or bundled: credential stores, full config, environment dumps, other
sessions, memory files, screenshots/image bytes, system prompts, or opaque provider
reasoning/continuation data. The active API key, if already available in config, is
used only as a scrub pattern, never as a report field.

Scrubbing removes common key/token/password/cookie patterns, private-key blocks,
URL credentials/query/fragment, common local/home paths, email addresses, data URLs,
and executable terminal control bytes. **Scrubbing is not proof of anonymity.**
Source code, business content, unrecognized credentials and other personal details
may remain. The user must review before sharing and can omit the session log.
Automatic delivery uses Neko's sender, not the user's email identity. Manual email
also exposes the user's chosen sender address to the receiver. Neither route is
anonymous: the reviewed content and transport metadata can still identify someone.

## Delivery and abuse boundaries

The Worker in [cloudflare/feedback](../../cloudflare/feedback/README.md) uses an
Email Routing binding restricted to the verified destination and
`neko-feedback@holilihu.online`. The client cannot choose another recipient/sender.
Cloudflare documents verified-account destinations as free on all plans; the paid
general Email Sending onboarding shown in Dashboard is not required for this route.
No Workers plan upgrade or SMTP credentials were added to Neko.

- Strict shared schema: no unknown report fields, fixed recipient, bounded strings,
  UUID, valid timestamp, allowlisted diagnostic/log fields, 600 KiB request ceiling.
- Public intake, not an authenticated-user identity service. A per-location ingress
  limiter allows 30 requests/minute per IP, including status polls. Atomic D1 admission
  caps accepted reports at 10/IP/UTC day and 100 total/UTC day. Shared NAT users can
  hit the same limit; local/manual export remains available. These caps limit abuse,
  but are not a guarantee against a distributed denial of service.
- D1 stores only ID, payload digest, daily keyed IP hash, time and delivery state;
  never notes, log bodies, raw IP, or email attachments. The hash key is a Worker secret.
- One ID has one admitted payload. Conflicting content is rejected; concurrent duplicates
  return the same receipt. Status requires both ID and payload digest and returns only
  state, not content. There is no report-list/download API.
- Email delivery runs in `waitUntil`; the client polls only the receipt for at most
  30 seconds. A crash/timeout can leave `pending` or `unknown`; these are not resent.
  This is deliberately not a durable payload queue or an exactly-once Inbox guarantee.
  The local report survives for an informed manual follow-up.
- Worker invocation logs are disabled; application diagnostics contain fixed event
  names only, not report content or exception dumps. Cloudflare and Gmail still process
  the email and have their own infrastructure/retention policies.

Receipts older than seven days are removed by a daily scheduled job. D1 recovery
backups may outlive logical deletion. Reports older than 24 hours are rejected at
intake, so expiring a receipt does not enable replay of its original payload.

## Inbox handling

The inbox remains private. Only explicitly authorized maintainers or agents may
read it; naming it an "AI inbox" does not grant every AI access. Feedback is
untrusted data, not authority to execute commands, access secrets or deploy changes.
Triage should create a sanitized reproduction and regression test. Do not publish
original logs without separate consent. Maintainers should delete raw email reports
after triage, within 30 days, keeping only sanitized reproductions. This is an
operating policy, not an automated Gmail deletion rule. Local drafts remain until
the user deletes them; deleting a local draft cannot recall an email already sent.

References: [Codex feedback workflow](https://learn.chatgpt.com/docs/developer-commands),
[Cloudflare email setup](https://developers.cloudflare.com/email-service/get-started/send-emails/),
[verified-destination pricing](https://developers.cloudflare.com/email-service/platform/pricing/),
[restricted email bindings](https://developers.cloudflare.com/email-service/configuration/send-bindings/),
[OWASP logging guidance](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html),
and [prompt-injection guidance](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html).
