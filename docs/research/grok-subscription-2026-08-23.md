# Grok subscription integration research - 2026-08-23

## Decision

Neko may support Grok subscription login directly because SpaceXAI now publishes the complete public-client
contract in its official Grok Build repository. This is different from reverse-engineering browser cookies
or copying another CLI's private token store. The integration remains a separate auth and billing route from
the xAI API key.

## Primary evidence

- Official source: [`xai-org/grok-build` at `07b2f71`](https://github.com/xai-org/grok-build/tree/07b2f7144fd5c5c9d3dd1966937a87852d2dbdb8).
- The official [authentication guide](https://github.com/xai-org/grok-build/blob/07b2f7144fd5c5c9d3dd1966937a87852d2dbdb8/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md)
  documents browser/device OAuth, durable refresh, the API-key fallback boundary, and direct use of the
  stored bearer with `https://cli-chat-proxy.grok.com/v1`.
- The official [device flow implementation](https://github.com/xai-org/grok-build/blob/07b2f7144fd5c5c9d3dd1966937a87852d2dbdb8/crates/codegen/xai-grok-shell/src/auth/device_code.rs)
  fixes the issuer, public client id, RFC 8628 grant, polling behavior, and xAI scopes.
- The issuer's [OIDC discovery document](https://auth.x.ai/.well-known/openid-configuration) publishes the
  device authorization and token endpoints and accepts public clients without a client secret.
- The official [embedded catalog](https://github.com/xai-org/grok-build/blob/07b2f7144fd5c5c9d3dd1966937a87852d2dbdb8/crates/codegen/xai-grok-models/default_models.json)
  identifies `grok-4.6` as the default Responses model and provides current context/effort metadata.

OpenCode's xAI plugin independently implements the same device grant, and Clay demonstrates that a small C
harness can consume it. They are useful corroboration and product inspiration, but Neko's protocol authority
is the official SpaceXAI source above; no code or credentials are copied from either project.

## Neko boundary

- `grok`: subscription OAuth and `cli-chat-proxy`; no API-key fallback.
- `xai` / `grok-build`: `XAI_API_KEY` and `api.x.ai`; no OAuth token fallback.
- Neko requests and stores its own token at `~/.neko-core/grok-auth.json` with atomic owner-only writes where
  the OS supports POSIX modes. Model-facing read/search/context surfaces deny this path and write variants.
- Tokens, device codes, and refresh tokens are never printed. Only the human user code and allowlisted HTTPS
  verification URL are shown.
- A fresh access token is resolved before a request. HTTP 401 triggers one refresh and one replay before any
  semantic stream output; it cannot loop indefinitely or duplicate a partially emitted turn.
- The proxy receives the documented token-auth, model override, account identity, and client-mode headers.
  The client version and User-Agent identify Neko Core rather than impersonating Grok Build.
- Remote catalog entries are untrusted and bounded. Neko exposes only entries declaring the Responses wire;
  unsupported backends stay hidden instead of failing later during a turn.
