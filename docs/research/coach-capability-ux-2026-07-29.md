# Coach capability isolation and UX research

**As of:** 2026-07-29  
**Accessed:** 2026-07-29  
**Status:** final design checkpoint; keep as a living ledger when evidence changes

## Research question

Neko Core currently uses `/relay` as a full remote-control channel: the remote
client can send prompts and approve gated tool calls. The `/camera` coach surface
appears to reuse the same session, token, and shared secret. This research asks:

1. **A — Security/architecture:** how should a narrow coach capability (send
   frames, negotiate voice, receive cues) be isolated from full machine control?
2. **B — UX:** how should a user intentionally start, understand, share, and stop
   coach mode?

## Acceptance criteria

- Inspect the actual authorization and routing paths in
  `cloudflare/relay/worker.js` and `src/adapters/remote-relay.ts`.
- Compare primary sources for Jitsi roles, Signal call links, Zoom host roles,
  Cloudflare Access service tokens, WebRTC authorization, OAuth scopes,
  Macaroons, and Biscuits.
- Specify an implementable authorization model, wire format, backward-compatible
  migration, rejection semantics, and tests.
- Specify a natural CLI onboarding/offboarding flow, including a dedicated
  command, QR/link copy, clear safety language, expiry, and shutdown behavior.
- End with `Quyet dinh de xuat`, split into A/B and prioritized P0/P1.
- Every factual claim must include a source and date. Design choices must be
  labeled `[inference]` and cite the evidence they derive from.

## Evidence convention

- `[verified]`: the core claim is supported by at least two independent sources
  or by source code plus a direct test.
- `[supported]`: one authoritative primary source or direct source-code
  inspection supports the claim.
- `[inference]`: a proposed Neko design derived from cited evidence; it is not a
  claim that another product implements the same design.
- `[open]`: not yet verified.
- `[rejected]`: a considered design alternative not selected; retained with the
  evidence and failure mode so the unsafe option is not reintroduced.
- `[refuted]` / `[superseded]`: a factual finding disproven or replaced; record the
  reason during investigation, then remove it at the final cleanup checkpoint.

For repository evidence, the source is a stable path and line range from the
working tree inspected on 2026-07-29. For web evidence, the source includes the
publisher URL, published/updated date when available (`n.d.` otherwise), and
access date.

## Initial ledger

- [supported] The current camera link carries the exact same `session`, bearer
  `token`, and E2E `secret` as the full relay-control link. The camera page uses
  that token for `/frame`, `/voice-offer`, `/alive`, and `/client-ws`; the Worker
  uses one DO-level bound token for every authenticated HTTP route.
  - Confidence: high.
  - Sources: `src/ui/chat.tsx:1685-1690,1723-1744`;
    `cloudflare/relay/camera.html:90-125,149-151,193-200,253-255`;
    `cloudflare/relay/worker.js:185-194,238-298` (working tree, 2026-07-29).
- [supported] Possession of a coach URL currently implies full session authority,
  independent of what buttons `camera.html` renders. A link holder can seal a
  prompt with the shared secret and call `/send`; the host decrypts the job and
  passes it to `handlers.run()`. The same credential pair can send approval or
  overlay actions through `/control` and can decrypt the full mirrored transcript.
  - Confidence: high.
  - Sources: `cloudflare/relay/worker.js:278-298,308-317,340-361,440-469`;
    `src/adapters/remote-relay.ts:167-181,183-228,286-309`;
    `src/adapters/remote-control.ts:24-46,63-65` (working tree, 2026-07-29).
- [supported] Bearer-token possession alone is enough to call `/interrupt` and
  `/revoke`; those operations contain no E2E-sealed payload. Thus separating only
  the E2E secret would still leave denial-of-service and revocation authority.
  - Confidence: high.
  - Source: `cloudflare/relay/worker.js:298-305,390-395` (working tree,
    2026-07-29).
- [inference] Route-specific authorization must be enforced by the Worker before
  routing, and the host must independently reject out-of-scope inbound frame
  types. UI hiding and payload-type validation are defense-in-depth, not an
  authorization boundary.
  - Confidence: high.
  - Derived from: the route and host traces above, RFC 9700 §2.3, and the
    role/grant systems compared in section A (accessed 2026-07-29).
- [inference] A dedicated `/coach` lifecycle should mint an independently
  revocable, short-lived, least-privilege link. It should stop media immediately
  when capture ends and revoke authority on explicit off, host exit, or hard expiry.
  - Confidence: high on the lifecycle; medium on the exact timeout.
  - Derived from: the code trace below and the Claude Code, Tailscale, Cloudflare,
    and Signal lifecycle sources in section B (accessed 2026-07-29).

## A. Security and architecture

### Current Neko authorization path

- [supported] The public `/camera/<session>` response itself is not authenticated;
  the secret material is read from the URL fragment or prior local storage. URL
  fragments are removed from the visible URL after being saved locally.
  - Confidence: high.
  - Sources: `cloudflare/relay/worker.js:66-73,138-157`;
    `cloudflare/relay/camera.html:90-95` (working tree, 2026-07-29).
- [supported] `/register` implements first-token-wins binding and stores one
  `token` plus one public E2E-key fingerprint (`kid`) in the session Durable
  Object. It does not store a role, scope set, expiry, token identifier, or
  per-client credential record.
  - Confidence: high.
  - Source: `cloudflare/relay/worker.js:185-194,243-253` (working tree,
    2026-07-29).
- [supported] `/ws` and `/client-ws` both compare their `t.<token>` WebSocket
  subprotocol value with the same stored token. The `role: "client"` attachment
  only prevents browser-originated WebSocket messages; it does not constrain
  HTTP requests made with the same bearer token.
  - Confidence: high.
  - Source: `cloudflare/relay/worker.js:256-295,440-450` (working tree,
    2026-07-29).

| Route | Current effect | Current authority check | Needed coach access | Source (working tree, 2026-07-29) |
|---|---|---|---|---|
| `POST /send` | Queue/forward an agent instruction | Shared bearer token; message decrypted with shared secret at host | No | `worker.js:340-361`; `remote-relay.ts:183-228` |
| `POST /control` | Forward approval/overlay decision | Shared bearer token; action decrypted with shared secret at host | No | `worker.js:308-317`; `remote-relay.ts:303-307`; `remote-control.ts:34-36` |
| `POST /interrupt` | Interrupt running turn | Shared bearer token only | No | `worker.js:390-395`; `remote-relay.ts:286-290` |
| `POST /revoke` | Delete the entire pairing and close all sockets | Shared bearer token only | No | `worker.js:298-305` |
| `GET /client-ws` | Replay and stream all mirror events for a host | Shared bearer token; page has shared secret | Cue-only receive, not transcript/presence | `worker.js:278-295,475-497`; `camera.html:193-205` |
| `POST /frame` | Forward an ephemeral sealed camera frame | Shared bearer token; frame decrypted/typed at host | Yes | `worker.js:377-388`; `remote-relay.ts:297-301` |
| `POST /voice-offer` | Forward sealed SDP offer | Shared bearer token; offer decrypted/typed at host | Yes | `worker.js:364-375`; `remote-relay.ts:290-295` |
| `GET /alive` | Return online status, `kid`, selected host | Shared bearer token | Yes, with reduced response | `worker.js:319-327` |
| `GET /sessions` | List encrypted metadata and online state | Shared bearer token; page has shared secret | No for session-scoped coach | `worker.js:329-338` |
| `GET /pull`, `POST /reply`, `GET /result` | Legacy host jobs/results | Shared bearer token | No | `worker.js:398-435` |

### Threat model

- [supported] **Credential exposure:** anyone who receives or captures the current
  coach URL obtains both authentication factors used by the relay (`token`) and
  host (`secret`). The secret is protected from the relay by living in the URL
  fragment, but it is intentionally disclosed to the person who receives the
  link.
  - Confidence: high.
  - Sources: `src/ui/chat.tsx:1689-1690,1743-1744`;
    `cloudflare/relay/camera.html:90-125` (working tree, 2026-07-29).
- [supported] **Full-control escalation:** the link holder can use the published
  protocol directly, even if the coach page exposes no composer: encrypt an
  arbitrary prompt under the shared secret, POST it to `/send`, and the host will
  call `handlers.run()`. They can likewise submit a matching approval action to
  `/control`.
  - Confidence: high from an end-to-end code trace; a dedicated negative
    capability test is still missing.
  - Sources: `cloudflare/relay/worker.js:308-317,340-361`;
    `src/adapters/remote-relay.ts:167-181,183-228,303-309`;
    `src/adapters/remote-control.ts:34-46,63-65` (working tree, 2026-07-29).
- [supported] **Confidentiality escalation:** `/client-ws` replays all retained
  semantic mirror events before going live. `camera.html` ignores non-cue events
  only after receiving and decrypting them; a modified client can retain the
  transcript, presence metadata, and UI state.
  - Confidence: high.
  - Sources: `cloudflare/relay/worker.js:278-295,475-497`;
    `cloudflare/relay/camera.html:193-205` (working tree, 2026-07-29).
- [supported] **Availability impact:** the token alone can interrupt a turn or
  revoke the entire pairing. A coach token therefore needs explicit denial of
  these endpoints even if it uses a different content-encryption key.
  - Confidence: high.
  - Source: `cloudflare/relay/worker.js:298-305,390-395` (working tree,
    2026-07-29).
- [supported] Existing tests validate wrong-token rejection, sealed-only host
  payloads, and frame/SDP type checks, but no test asserts that a coach credential
  is unable to call control routes or read general mirror events.
  - Confidence: high.
  - Sources: `test/remote-relay.test.ts:387-493`;
    `test/relay-worker.test.ts:94-175`; repository search for camera-specific
    tests (working tree, 2026-07-29).

### Product and standards comparison

| System | Evidence relevant to Neko | Boundary / what not to copy | Primary sources |
|---|---|---|---|
| Jitsi moderator vs guest | Jitsi's current Prosody module derives `owner`/moderator from signed JWT `context.user.affiliation` or `context.user.moderator`; other authenticated occupants become members. Its documented host/guest setup separates authenticated room creation from an anonymous guest domain. | The older secure-domain mechanism is deprecated in favor of JWT authentication. Jitsi's coarse meeting roles do not by themselves express Neko's endpoint-level frame/voice/cue rights. | Jitsi [`mod_token_affiliation.lua`](https://github.com/jitsi/jitsi-meet/blob/223e6f0941f568762990af1cb58b487ec7171871/resources/prosody-plugins/mod_token_affiliation.lua), commit 2026-06-03; [Secure Domain Setup](https://jitsi.github.io/handbook/docs/devops-guide/secure-domain/), updated 2026-07-14; accessed 2026-07-29. |
| Signal call links | The link creator can require admin approval, remove/block joiners, delete the link, and rely on expiry after 90 days of inactivity. A waiting joiner receives no participant media before approval. | Signal's 90-day reusable social-call lifetime is far too long for a machine-adjacent coach capability; Neko should borrow explicit approval/lifecycle, not the duration. | Signal Support, [How to create and share call links](https://support.signal.org/hc/en-us/articles/7860719423002-How-to-create-and-share-call-links), n.d.; accessed 2026-07-29. |
| Zoom host/co-host/participant | Zoom assigns meeting roles through the host and enforces a permission matrix. Participants lack host controls; co-hosts have most administrative controls but cannot start a meeting, while alternative hosts can. | “Co-host” is the wrong Neko analogy because it remains highly privileged. Coach should be closer to a media-limited participant with a custom cue receive permission. | Zoom Support, [Understanding roles in a Zoom meeting](https://support.zoom.com/hc/en/article?id=zm_kb&sysparm_article=KB0064033), n.d.; accessed 2026-07-29. |
| Cloudflare Access service tokens | Each service token has its own name, duration, and individually revocable credential. Access policy binds a specific service token to a protected Access application, and policy `Require`/`Exclude` rules narrow admission. | A Cloudflare service token does not replace Neko's internal route authorization: application admission is coarser than deciding `/frame` vs `/send`. Borrow per-token records, expiry, and revocation; keep endpoint scopes in the Worker. | Cloudflare, [Service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/), updated 2026-07-09; [Access policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/), updated 2026-07-07; accessed 2026-07-29. |
| WebRTC and room grants | WebRTC's security architecture protects origin/device consent, signaling identity, and encrypted media; it does not define a Neko application role. LiveKit demonstrates the missing application layer: a signed room token separates `roomAdmin`, `canPublish`, `canPublishSources`, `canSubscribe`, room binding, and expiry, including camera-only and subscribe-only examples. | A successful SDP/DTLS connection is not authorization to invoke agent routes. Neko must authorize the signaling request before forwarding the offer and must keep media scopes separate from command scopes. | IETF [RFC 8827](https://www.rfc-editor.org/rfc/rfc8827.html), Jan 2021; LiveKit, [Access tokens & grants](https://docs.livekit.io/frontends/reference/tokens-grants/), n.d.; accessed 2026-07-29. |
| OAuth scopes and audience | OAuth Security BCP says token privileges should be the minimum required and each resource server must verify the token is intended for the particular resource and action. Resource Indicators distinguishes *what* (`scope`) from *where* (`resource`/audience) and recommends downscoping. Bearer-token possession otherwise conveys the token's authority. | Neko does not need an OAuth authorization server or consent grant flow for a local user minting a share link. It does need the same fail-closed, per-request resource/action checks. | IETF [RFC 9700 §2.3](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.3), Jan 2025; [RFC 8707 §§1-3](https://www.rfc-editor.org/rfc/rfc8707.html), Feb 2020; [RFC 6750 §1.2](https://www.rfc-editor.org/rfc/rfc6750.html#section-1.2), Oct 2012; accessed 2026-07-29. |
| Macaroons | Macaroons are bearer capabilities with chained-MAC caveats that can attenuate where, when, by whom, and for what purpose a request is authorized. | Delegated offline attenuation and third-party caveats exceed the present one-host/one-Worker need. They are a useful model for monotonic restrictions, not a required dependency. | Google Research / NDSS, [Macaroons: Cookies with Contextual Caveats](https://research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/), 2014; accessed 2026-07-29. |
| Biscuit | Biscuit bearer tokens use signed append-only blocks and checks; holders may add restrictions but cannot remove earlier restrictions. Its examples cover operation and expiry attenuation, with decentralized public-key verification. | Biscuit adds a Datalog policy engine, token serialization, key lifecycle, and verifier surface. That is disproportionate for a fixed three-role matrix today; reconsider only if third-party delegation or user-defined policies appear. | Eclipse Biscuit, [Specifications](https://doc.biscuitsec.org/reference/specifications) and [Introduction](https://doc.biscuitsec.org/getting-started/introduction), n.d.; accessed 2026-07-29. |

- [verified] Mature systems put role/grant enforcement at a trusted server or
  authorizer rather than treating the visible UI as the boundary.
  - Confidence: high.
  - Sources: Jitsi token-affiliation source (2026-06-03); Zoom role matrix
    (n.d.); LiveKit grants (n.d.); RFC 9700 §2.3 (2025), URLs above; accessed
    2026-07-29.
- [verified] Narrow share credentials need independent lifecycle controls:
  explicit creation, bounded lifetime, and individual revocation.
  - Confidence: high.
  - Sources: Signal call-link deletion/expiry (n.d.); Cloudflare service-token
    duration/revocation (updated 2026-07-09); LiveKit expiry/revocation guidance
    (n.d.), URLs above; accessed 2026-07-29.
- [verified] Media permissions are not equivalent to room administration or
  command authority; publish, subscribe, media source, room, and admin rights can
  and should be distinct.
  - Confidence: high.
  - Sources: LiveKit grants (n.d.); Zoom role matrix (n.d.); RFC 9700 §2.3
    resource/action restriction (2025), URLs above; accessed 2026-07-29.
- [inference] Neko should use a fixed, server-side role template backed by
  opaque, stateful capability records rather than introducing JWT, Macaroons, or
  Biscuit in P0. The existing Durable Object already supplies the online state
  needed for exact expiry and individual revocation.
  - Confidence: high.
  - Derived from: the comparison above and
    `cloudflare/relay/worker.js:176-194,238-305` (working tree, 2026-07-29).

### Proposed capability model

#### Security invariants

- [inference] **Three non-hierarchical principals:** `host`, `controller`, and
  `coach`. The host credential authenticates the local Neko process and is never
  shared. `/relay` shares a controller credential. `/coach` shares a different
  coach credential. A controller is not implicitly a coach, and a coach is never
  a controller.
  - Confidence: high.
  - Derived from: Jitsi/Zoom role separation, LiveKit distinct grants, and RFC
    9700 resource/action restriction (sources in the comparison above).
- [inference] **Two enforcement points:** the Worker authorizes the token, route,
  method, host binding, and expiry before forwarding; the host independently
  matches the Worker-injected capability id to a local keyring and accepts only
  the message kinds assigned to that capability. Neither UI visibility nor an
  untrusted client-supplied `role`/`scope` field grants authority.
  - Confidence: high.
  - Derived from: RFC 9700 §2.3 (2025), RFC 8707 (2020), and the current dual
    Worker/host trace (working tree, 2026-07-29).
- [inference] **Separate E2E keys:** the coach link gets a fresh coach secret.
  Transcript/control events remain encrypted under controller keys; frame,
  voice-offer, cue, and voice-answer payloads use the coach key. The host never
  tries a different key when decryption under the capability's assigned key
  fails.
  - Confidence: high.
  - Derived from: current shared-key escalation in
    `src/adapters/remote-relay.ts:167-181,286-309` and RFC 9700's audience/action
    restriction guidance.
- [inference] **Bounded and individually revocable:** default coach TTL 30
  minutes, configurable up to a P0 hard maximum of two hours; one active coach
  capability per Neko host/session; `/coach off`, rotation, expiry, or TUI exit
  revokes only that coach capability. Fixed expiry is authoritative even if an
  attacker keeps sending traffic.
  - Confidence: medium on the exact durations; high on bounded TTL and
    individual revocation.
  - Derived from: Signal call-link lifecycle, Cloudflare service-token lifecycle,
    LiveKit short-TTL guidance for self-hosted revocation, and Cloudflare DO
    alarms (sources above and below).

#### Role templates and endpoint policy

All statements and table entries in this proposed policy are `[inference]` unless
marked otherwise. The Worker owns these templates; the issuer requests a role, not
arbitrary scopes. Scope names are wire-level constants, and unknown roles/scopes
fail closed. They derive from RFC 9700 §2.3 and the compared server-enforced role/
grant systems (accessed 2026-07-29).

| Principal | P0 scopes | Explicitly absent |
|---|---|---|
| `host` | `host:register`, `host:ws`, `cap:issue`, `cap:revoke`, `event:publish` | All browser/client routes |
| `controller` | `prompt:write`, `control:write`, `interrupt:write`, `mirror:read`, `result:read`, `presence:read`, `sessions:read`, `session:revoke` | `frame:write`, `voice:offer`, `cue:read`, host/capability administration |
| `coach` | `frame:write`, `voice:offer`, `cue:read`, `presence:read` | Prompt, approval/overlay, interrupt, transcript/mirror replay, session listing/result, revoke, host registration, capability administration |
| `legacy` | Current v5 behavior, visibly marked broad | Nothing; compatibility only |

- [inference] `cue:read` covers only targeted `cue`, `voice-answer`,
  `voice-error`, and `coach-stop` events. It is not an alias for `mirror:read`.
  This is necessary because the Worker cannot filter event types hidden inside
  controller ciphertext.
  - Confidence: high.
  - Derived from: current opaque event forwarding in
    `worker.js:456-497` and camera filtering after receipt in
    `camera.html:193-205` (working tree, 2026-07-29).
- [inference] `presence:read` returns only `{online, role, expiresAt, kid}` for a
  coach. It does not reveal encrypted session metadata or enable `/sessions`.
  - Confidence: high.
  - Derived from: data minimization implied by RFC 8707 downscoping and current
    `/alive`/`sessions` responses in `worker.js:319-338`.

#### Durable Object state and authorization

- [inference] Store a private `hostTokenHash` and stateful capability records
  keyed by `SHA-256(token)`, for example:

```json
{
  "v": 1,
  "id": "cap_c_7A...",
  "role": "coach",
  "scopes": ["frame:write", "voice:offer", "cue:read", "presence:read"],
  "hostId": "opaque-host-id",
  "kid": "9d8f4a21",
  "createdAt": 1785290000000,
  "expiresAt": 1785291800000
}
```

  The 128-bit-or-stronger random bearer token is returned once and never stored
  raw. `kid` is only the public fingerprint of the coach E2E secret; the secret
  remains in the local host and URL fragment.
  - Confidence: high.
  - Derived from: the existing CSPRNG pairing and `kid` design in
    `remote-relay.ts:48-55,111-115`, plus Cloudflare's per-token name/duration/
    revocation model (updated 2026-07-09).
- [inference] `authorize(request, requiredScope)` hashes the bearer/subprotocol
  token, loads the record, checks role/template integrity, expiry, host binding,
  and required scope on every HTTP request and WebSocket handshake. Invalid or
  expired credentials return `401`; a valid credential lacking a scope returns
  `403 {"error":"insufficient_scope","required":"prompt:write"}`. Route code
  receives the trusted record and never reads role/scope from the request body.
  - Confidence: high.
  - Derived from: RFC 6750 bearer semantics and RFC 9700 §2.3 (sources above).
- [inference] WebSocket attachments persist `{capId, role, hostId, expiresAt}`.
  The DO schedules its one alarm for the earliest capability expiry; `alarm()`
  deletes expired records and closes sockets tagged to those capability ids,
  then schedules the next expiry. This remains correct across hibernation, unlike
  an in-memory timer.
  - Confidence: high.
  - Sources: Cloudflare [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/), updated 2026-04-21; [Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/), updated 2026-06-19; accessed 2026-07-29.

### Wire format

All wire-format statements and examples below are `[inference]`. They derive from
the security invariants above, RFC 8707/9700, and current Neko v5 wire paths
(working tree and sources cited above, 2026-07-29).

#### 1. Host registration and coach issuance (relay protocol v6)

```http
POST /register
Authorization: Bearer <private-host-token>
Content-Type: application/json

{"v":6,"session":"S","hostId":"H"}
```

```json
{"ok":true,"v":6,"auth":"scoped","hostId":"H"}
```

```http
POST /capabilities
Authorization: Bearer <private-host-token>
Content-Type: application/json

{"session":"S","role":"coach","hostId":"H","kid":"coach-kid","ttlSec":1800}
```

```json
{
  "id":"cap_c_7A...",
  "role":"coach",
  "scopes":["frame:write","voice:offer","cue:read","presence:read"],
  "token":"one-time-random-bearer",
  "expiresAt":1785291800000
}
```

- [inference] `/relay` uses the same host-only issuance endpoint with
  `role:"controller"`, a separate controller `kid`, bounded controller TTL, and
  controller-encrypted session metadata. The Worker maps that role to the
  controller template and the CLI builds the `/session/S` link from the returned
  controller token plus controller secret. Host registration itself contains no
  controller key or controller metadata. This keeps all browser-facing authority
  in capability records while registration remains a private transport identity.
  - Confidence: high.
  - Derived from: the three-principal invariant, RFC 8707's distinction between
    resource and scope, and current host/controller credential conflation traced in
    section A.
- [inference] The Worker generates the bearer token, stores only its hash, maps
  `role:"coach"` to the fixed server template, caps `ttlSec`, and returns the raw
  token once. The local host separately generates `coachSecret`, retains
  `{capId, secret, kid, expiresAt}` in memory, and constructs:

```text
https://relay.example/camera/S#v=6&c=cap_c_7A...&t=<coach-token>&k=<coach-secret>&e=1785291800000
```

    The fragment continues to keep credentials out of the HTTP request. The v6
    camera page stores the credential in `sessionStorage`, clears the fragment,
    and forgets it when the tab is closed; it must not add a coach credential to
    the durable `nekoRelayPairings` local-storage map. `e` is only a pre-connection
    display hint: the page replaces it with the authoritative `expiresAt` received
    from `/alive`/`cap_ready`, and expiry enforcement never trusts fragment data.
    - Confidence: high.
  - Derived from: current fragment clearing in `camera.html:90-95`; current
    durable local-storage behavior at the same lines is the behavior being
    narrowed (working tree, 2026-07-29).

#### 2. Coach-to-host media lanes

The browser request bodies remain nearly wire-compatible:

```http
POST /frame
Authorization: Bearer <coach-token>

{"session":"S","frame":{"iv":"...","ct":"..."}}
```

```http
POST /voice-offer
Authorization: Bearer <coach-token>

{"session":"S","offer":{"iv":"...","ct":"..."}}
```

- [inference] The client does not select a host or claim a role. The Worker takes
  `hostId`, `capId`, `kid`, role, and expiry from its capability record and
  forwards trusted context over the authenticated host socket:

```json
{
  "t":"frame",
  "cap":{"id":"cap_c_7A...","role":"coach","kid":"coach-kid","exp":1785291800000},
  "frame":{"iv":"...","ct":"..."}
}
```

  `voice-offer` uses the same envelope. If a legacy `hostId` field is supplied,
  v6 requires an exact match with the capability binding or returns 403; it never
  lets a coach choose another host.
  - Confidence: high.
  - Derived from: LiveKit room/source binding and RFC 9700 resource/action checks;
    current user-controlled host selection is at `worker.js:368-386` (working
    tree, 2026-07-29).
- [inference] The host looks up `cap.id`, verifies the locally held role/kid/expiry,
  decrypts with exactly that coach secret, validates `data:image/*` or SDP type,
  and drops any mismatch. It never feeds a coach envelope into the job queue and
  never falls back to the controller secret.
  - Confidence: high.
  - Derived from: existing sealed-only/type checks in
    `remote-relay.ts:167-181,290-301` and
    `test/remote-relay.test.ts:402-493` (working tree, tests passed 2026-07-29).

#### 3. Targeted cue/voice receive channel

```text
GET /client-ws?session=S
Sec-WebSocket-Protocol: neko-relay, t.<coach-token>
```

On connection the Worker sends no `mirror_reset`, replay, transcript, or general
presence. It sends only:

```json
{"t":"cap_ready","id":"cap_c_7A...","role":"coach","scopes":["frame:write","voice:offer","cue:read","presence:read"],"expiresAt":1785291800000}
```

The host targets an encrypted event:

```json
{"t":"cap-event","capId":"cap_c_7A...","event":{"iv":"...","ct":"..."}}
```

The Worker broadcasts it only to sockets tagged `cap:cap_c_7A...` and emits to
the browser as `{ "t":"event", "event":{...} }`. Allowed plaintext *inside*
the sealed coach envelope is one of `cue`, `voice-answer`, `voice-error`, or
`coach-stop`; nothing is durable or replayed.

- [inference] Reusing the path `/client-ws` is acceptable only if role-dependent
  server behavior is explicit and covered by negative replay tests. A new
  `/coach-ws` name is clearer but adds a migration surface without improving the
  authorization property.
  - Confidence: medium.
  - Derived from: current receive-only WebSocket enforcement in
    `worker.js:278-295,440-450` and RFC 9700's server-side enforcement rule.

#### 4. Revocation

```http
DELETE /capabilities/cap_c_7A...?session=S
Authorization: Bearer <private-host-token>
```

- [inference] Deletion removes only the coach record, closes its sockets with an
  application close code/reason such as `4003 capability revoked`, pushes a
  best-effort `coach-stop` first, and removes the local coach key. `/revoke`
  remains the broad controller/session rotation endpoint and is never callable
  by coach.
  - Confidence: high.
  - Derived from: individual Cloudflare service-token revocation and Signal
    link deletion; current broad `/revoke` behavior is
    `worker.js:298-305` (working tree, 2026-07-29).

### Backward-compatible migration

- [inference] Bump `RELAY_VERSION` from 5 to 6. A v6 Worker keeps the current v1-
  v5 token behavior under an explicit `legacy` capability so old Neko binaries
  and existing controller links continue to work. Existing test fixtures remain
  mandatory compatibility tests.
  - Confidence: high.
  - Derived from: the existing v1 compatibility commitment in
    `worker.js:11-15,412-435` and `remote-relay.ts:13-24` (working tree,
    2026-07-29).
- [inference] A v6 host talking to a v5 Worker may continue `/relay`, but `/coach`
  must fail closed with an actionable “deploy relay v6” message. It must never
  print the full controller token as a coach fallback.
  - Confidence: high.
  - Derived from: the security trace in this document and RFC 9700 fail-closed
    action enforcement.
- [inference] A v6 Worker can report `auth:"legacy"` when a session still has the
  single shared v5 token. The CLI may keep that relay running, but it must label
  the link “full remote control” and refuse to mint a supposedly narrow coach
  link until credentials are split.
  - Confidence: high.
  - Derived from: current single-token storage at `worker.js:185-194,243-247`.
- [inference] **One explicit security rotation is unavoidable.** The old protocol
  gave the host and every browser the same token and secret; therefore the
  Worker has no cryptographic fact that can distinguish “local host performing
  upgrade” from “old link holder attempting takeover.” Safe upgrade means
  `/relay new` (or a dedicated `/relay upgrade`) revokes the old session and
  creates a private host token plus a new controller capability. Old links stop
  working by design.
  - Confidence: high.
  - Derived from: the shared-credential trace in this document. This is a
    protocol impossibility result, not a product-source claim.
- [inference] Rollout sequence:
  1. Deploy v6 Worker with legacy tests green.
  2. Ship v6 host support and scoped capability/keyring handling.
  3. On first scoped use, prompt for the one-time rotation if `auth:"legacy"`.
  4. Stop printing camera links from `/relay`; print only the full-control link
     and direct users to `/coach`.
  5. Ship v6 `camera.html`; old camera pages/links remain labeled broad until
     rotated.
  6. Collect use telemetry locally/log only capability id prefix, role, decision,
     and reason—never token, secret, frame, SDP, or decrypted content.
  - Confidence: high except the exact telemetry policy, which is a design choice.
  - Derived from: current compatibility paths and the primary-source patterns
    above.

### Required tests

#### Worker authorization matrix (P0)

- [inference] Table-drive every `(role, method, route)` combination. A coach must
  succeed only on `POST /frame`, `POST /voice-offer`, coach-mode
  `GET /client-ws`, and reduced `GET /alive`; it must receive 403 for `/send`,
  `/control`, `/interrupt`, `/revoke`, `/sessions`, `/result`, `/pull`, `/reply`,
  `/register`, `/ws`, and capability-management routes.
- [inference] Prove controller and coach tokens are distinct random values,
  stored only by hash; valid token + client-supplied `role:"controller"` or extra
  `scope` does not change the trusted record.
- [inference] Bind a coach to host A, then try host B in query/body; expect 403
  and no frame on either host socket.
- [inference] Expire a capability with a fake clock/alarm; expect subsequent HTTP
  401, the coach WebSocket closed, host/control sockets still open, and only the
  expired record removed. Run the alarm twice to prove idempotence.
- [inference] Revoke one coach capability; prove its token cannot reconnect and
  the controller/host remain usable. Rotate and prove the old coach token and
  secret cannot access the new capability.
- [inference] Connect coach `/client-ws` after durable controller mirror events
  exist; expect no reset/replay/presence/transcript. Publish events for a
  different capability id; expect no cross-delivery.

#### Host/key-isolation tests (P0)

- [inference] A valid coach-secret frame with matching server-injected capability
  context reaches `onFrame`; wrong id/kid/role/secret, expired context, unsealed
  input, and non-image plaintext are dropped.
- [inference] Seal a syntactically valid agent prompt and approval action with the
  **coach secret** and deliver it as a job/control frame; assert `handlers.run`
  and `handlers.control` are never called. This is the direct regression test for
  the reported vulnerability.
- [inference] A valid controller-secret prompt still runs, but that same
  controller event is never readable through a coach socket/key. A targeted cue
  sealed under coach key is readable by that coach only.
- [inference] Removing a capability deletes its local key; later delayed frame,
  SDP, or cue work for that id is ignored.

#### Compatibility and downgrade tests (P0)

- [inference] New Worker + old v1/v5 host/client fixtures retain their exact
  current behavior as `legacy`; the existing 29 relay tests remain green.
- [inference] New host + old Worker: `/relay` works, `/coach` refuses and never
  emits a broad link. New host + v6 Worker in `legacy` mode requires explicit
  rotation before scoped coach issuance.
- [inference] Unknown relay versions, roles, scopes, event types, missing cap
  context, and malformed records fail closed. There is no plaintext or
  “try every key” downgrade.

#### UX/browser tests (P0/P1)

- [inference] `/coach` starts when off and reprints status/link when already on;
  `/coach off` revokes; `/coach new` rotates; `/coach status` shows online state,
  exact allowed/denied rights, expiry, and capture/voice state. Secret URLs are
  never mirrored to relay transcript or logs.
- [inference] The camera page uses `sessionStorage`, clears the fragment, requests
  camera/microphone only after a tap, releases tracks on stop/hide/pagehide, and
  renders explicit states for 401 expired, 403 insufficient scope, host offline,
  and relay-v5 incompatibility.
- [inference] Add a browser integration test that opens a real v6 coach link,
  sends one frame, receives one targeted cue, attempts the four control routes,
  advances expiry, and verifies camera/microphone tracks and socket stop. Retain
  static CSP/Permissions-Policy assertions as defense-in-depth.

All proposed tests derive from the P0 exploit trace, RFC 9700 §2.3, Cloudflare DO
alarm/WebSocket lifecycle docs (updated 2026-04-21/2026-06-19), and existing
relay tests (working tree, 29/29 passed 2026-07-29).

## B. Coach-mode UX

### Current Neko flow

- [supported] The working tree now recognizes a dedicated `/coach` command and
  prints a camera link plus QR code. If no relay is active, however, it calls the
  same `loadOrCreateSessionPairing(..., false)` and `startRemoteRelay()` path as
  `/relay`, then constructs the camera URL from that pairing's token and secret.
  This improves discovery but does not narrow authority.
  - Confidence: high.
  - Source: `src/ui/chat.tsx:1675-1719` (working tree, 2026-07-29).
- [supported] `/coach stop` currently stops local remote voice and publishes a
  sealed `coach-stop` mirror event, but it does not revoke or expire a credential.
  The message explicitly says `/relay` remains active. `/relay` also still prints a
  camera URL using the controller pairing.
  - Confidence: high.
  - Source: `src/ui/chat.tsx:1680-1687,1787-1792` (working tree, 2026-07-29).
- [supported] The camera page asks for camera only after the user presses Start and
  asks for microphone only after the separate voice action. It stops camera tracks
  when stopped, hidden, or page-hidden, and stops voice tracks on page hide. These
  are good consent and media-lifecycle behaviors worth preserving.
  - Confidence: high.
  - Source: `cloudflare/relay/camera.html:127-158,211-269` (working tree,
    2026-07-29).
- [supported] The current page persists the broad token and secret in
  `localStorage` and reconnects `/client-ws` indefinitely while paired. Closing the
  page therefore stops hardware capture but does not forget or revoke authority.
  - Confidence: high.
  - Source: `cloudflare/relay/camera.html:77-95,193-209` (working tree,
    2026-07-29).

### Comparable onboarding patterns

| Product/CLI | Observed onboarding/lifecycle pattern | Neko lesson | Primary source |
|---|---|---|---|
| Claude Code Remote Control | Provides dedicated `claude remote-control`, `--remote-control`/`--rc`, and in-session `/remote-control`/`/rc` entry points. Server mode prints a URL and toggles QR with Space; interactive mode opens a URL/QR status panel and displays `/rc active` in the footer. Stopping the local process ends the session. Its security section describes multiple short-lived credentials scoped to different purposes and expiring independently. | A secondary remote surface deserves a first-class command, repeatable status/QR view, visible active state, process-bound lifetime, and purpose-specific credentials. | Anthropic, [Remote Control](https://code.claude.com/docs/en/remote-control), n.d.; accessed 2026-07-29. |
| Tailscale Serve | Foreground Serve output exposes the endpoint and says `Press Ctrl+C to exit`; `--bg` is explicit. `tailscale serve status` inspects active servers, appending `off` disables one, and `reset` clears configuration. | Default to a bounded foreground/session lifecycle; provide separate status and off operations rather than a destructive toggle. | Tailscale, [tailscale serve command](https://tailscale.com/kb/1242/tailscale-serve), last validated 2026-01-26; accessed 2026-07-29. |
| Cloudflare Quick Tunnels | One command creates a random public URL and prints it in the terminal; the tunnel belongs to the running process. Cloudflare labels Quick Tunnels for testing/development rather than production. | A share URL should be generated at activation and visibly coupled to the process that owns it; scope and risk language must sit beside the link. | Cloudflare, [Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/), updated 2026-04-20; accessed 2026-07-29. |
| Signal call links | Link creation is a distinct flow; the creator may require approval and may delete the link. A deleted link blocks new joins but does not terminate an already-running call; links expire after 90 days of inactivity. | Separate link authority from active media. Neko needs both immediate capture stop and explicit capability revocation; a social-call lifetime is too long for machine-adjacent coaching. | Signal Support, [How to create and share call links](https://support.signal.org/hc/en-us/articles/7860719423002-How-to-create-and-share-call-links), n.d.; accessed 2026-07-29. |

- [verified] A discoverable auxiliary CLI feature should have its own start entry
  point, a way to show current status/link again, and an explicit stop operation.
  - Confidence: high.
  - Sources: Claude Code Remote Control (n.d.), Tailscale Serve (validated
    2026-01-26), and Cloudflare Quick Tunnels (updated 2026-04-20), URLs above;
    accessed 2026-07-29.
- [verified] The media-capture lifetime and the share credential lifetime are
  different states. Stopping hardware does not necessarily revoke a link, and
  revoking a link does not necessarily terminate media already established unless
  the product explicitly couples them.
  - Confidence: high.
  - Sources: Signal link deletion behavior (n.d.) and current Neko camera/credential
    code (working tree, 2026-07-29), cited above.

### Proposed `/coach` flow

#### Command semantics

- [inference] Make bare `/coach` **idempotent**: when off it starts scoped coach
  mode; when already on it reprints status, expiry, link, and QR. It must never act
  as a toggle. Destructive actions require a verb.
  - `/coach` — start or re-open the current share panel.
  - `/coach status` — show capability id prefix, connection/capture/voice state,
    rights, and exact expiry without printing the secret link.
  - `/coach qr` — reprint the current link and QR.
  - `/coach off` — stop media and revoke the current coach capability immediately;
    keep `/coach stop` as an alias during migration.
  - `/coach new` — revoke and rotate only the coach capability/key.
  - `/coach 45m` or `/coach --ttl 45m` — optional explicit TTL, clamped to the P0
    maximum; no unbounded mode.
  - Confidence: high except the convenience TTL syntax, which is medium.
  - Derived from: Claude Code's repeatable status panel and Tailscale's separate
    `status`/`off` lifecycle (sources above).

#### First-run output

- [inference] On success, print the security contract before the share material.
  Keep terminal-rendered strings ASCII because Neko's documented Windows console
  baseline is cp1252. A concrete P0 layout is:

```text
Coach on for this Neko session. Expires 15:40 (30 min).
Allowed: send camera frames; start voice; receive posing cues.
Blocked: prompts, approvals, transcript, interrupt, session or relay changes.

Open on the filming phone:
https://relay.example/camera/...#...
<QR>

Camera and microphone start only after a tap on the phone.
Stop and revoke now: /coach off   Rotate link: /coach new
Show again: /coach qr             Status: /coach status
```

  The URL and QR are secret-bearing output and must be excluded from relay mirror,
  session export, diagnostics, and telemetry. UI text may say “Anyone with this
  link can use camera/voice until the shown expiry, but cannot control Neko.”
  - Confidence: high.
  - Derived from: least-privilege disclosure in RFC 9700 §2.3, explicit URL/QR and
    active-state patterns in Claude Code, the existing QR renderer in
    `src/ui/chat.tsx:1704-1716`, and the ASCII console constraint in `AGENTS.md`
    (working tree, 2026-07-29).

#### Start, stop, and expiry behavior

- [inference] If no `/relay` controller is active, `/coach` starts only the private
  host connection and mints a coach capability; it does **not** mint or print a
  controller capability. If a v6 host socket already exists, it reuses that private
  transport and adds only the coach record/key.
  - Confidence: high.
  - Derived from: the three-principal architecture in section A.
- [inference] If the Worker reports v5/`legacy`, `/coach` fails closed. It explains
  that the existing protocol can create only a full-control link and offers the
  explicit one-time `/relay upgrade` flow. It never silently rotates or falls back
  to the broad pairing.
  - Confidence: high.
  - Derived from: the migration impossibility result in section A.
- [inference] P0 uses a 30-minute hard TTL. `/coach off`, `/coach new`, or TUI exit
  stops local voice, best-effort sends `coach-stop`, deletes the capability at the
  Worker, closes coach sockets, and deletes the local coach key. Expiry performs
  the same revocation without requiring either client to be online.
  - Confidence: high on behavior; medium on 30 minutes.
  - Derived from: per-token lifecycle evidence in section A, Cloudflare DO alarms
    (updated 2026-04-21), and process-bound CLI patterns above.
- [inference] Preserve immediate camera/microphone track release on stop, hide, and
  page hide. Do **not** revoke the capability immediately on `visibilitychange`:
  phone locks and app switches are normal transient states. Hard TTL remains the
  security bound. P1 may revoke after five continuous minutes with no coach socket,
  while allowing reconnection during that grace period.
  - Confidence: high on separating media stop from immediate revocation; medium on
    the five-minute grace.
  - Derived from: current media release behavior in `camera.html:211-269`, Signal's
    distinction between call and link lifecycle, and DO alarm support (sources
    above).
- [inference] Remove the camera URL from `/relay` output. Replace it with one safe
  discovery line: `Need a limited camera/voice link? Run /coach.` `/relay` must
  label its own link `Full remote control: prompts and approvals`.
  - Confidence: high.
  - Derived from: the current authority confusion and dedicated-command patterns
    above.
- [inference] P1 adds a persistent footer chip such as `coach active 18m`, connection
  state, a two-minute expiry warning with an explicit extend action, and an audit
  view containing only timestamps, capability id prefixes, role, allow/deny
  decision, and denial reason.
  - Confidence: medium.
  - Derived from: Claude Code's active footer/status behavior (n.d.) and the
    no-secret telemetry policy in section A.

## Alternatives and attempted refutations

- [rejected] **Hide the prompt box and approval buttons in `camera.html`.** A custom
  client can call `/send`, `/control`, `/interrupt`, and `/revoke` directly and can
  retain all `/client-ws` events. The Worker, not the page, is the security boundary.
  - Sources: current code trace and RFC 9700 §2.3, cited in section A (2026-07-29).
- [rejected] **Give coach a new E2E secret but keep the same bearer token.** This
  blocks prompt decryption only if the host never falls back, but the bearer alone
  still interrupts and revokes; it also still opens the general mirror socket.
  - Source: `worker.js:278-305,390-395` (working tree, 2026-07-29).
- [rejected] **Trust `role:"coach"` or a scope list supplied by the browser.** A
  bearer holder can edit the request. Role/template, host binding, and expiry must
  come from trusted Worker state.
  - Sources: RFC 6750 §1.2 (2012) and RFC 9700 §2.3 (2025), accessed 2026-07-29.
- [rejected] **Put coach in a separate session/DO but reuse all current routes.** A
  different token alone would still authorize `/send` and `/control` inside that
  DO. A second deployment containing only media routes could isolate it, but would
  duplicate transport/lifecycle logic; the scoped record plus route matrix gives a
  smaller auditable boundary.
  - Sources: current route dispatch in `worker.js:238-440` (working tree,
    2026-07-29); the final preference is an inference.
- [rejected for P0] **Adopt JWT, Macaroons, or Biscuit now.** Signed/self-attenuating
  tokens solve offline or delegated policy problems Neko does not presently have;
  exact online revocation and expiry already require the Durable Object. A fixed
  opaque capability record has fewer parser, key-lifecycle, and policy surfaces.
  - Sources: Jitsi JWT, Macaroons, Biscuit, and Cloudflare DO sources in section A;
    accessed 2026-07-29. Revisit if third-party delegation or user-defined scopes
    become a real requirement.
- [rejected] **Preserve every old link while silently converting its owner into the
  private host.** All old parties possess the same credential, so none can prove
  that it is the local host. One explicit rotation is required.
  - Source: current shared-credential trace (working tree, 2026-07-29).
- [rejected] **Make bare `/coach` toggle on/off.** Users reasonably repeat a setup
  command to recover its URL/QR or inspect status; a toggle could revoke a live
  shoot without confirmation. Dedicated `off` is observable and scriptable.
  - Sources: Claude Code repeatable status panel and Tailscale `status`/`off`
    commands, cited above; accessed 2026-07-29.
- [rejected] **Revoke on every page hide.** The current page intentionally treats
  hide as a reversible capture pause. Immediate credential revocation would make a
  phone lock or app switch destructive; hard TTL plus explicit off provides the
  security bound without that fragility.
  - Source: `camera.html:211-230` (working tree, 2026-07-29); the lifecycle choice
    is an inference.

## Quyet dinh de xuat

### A — Bao mat/kien truc

#### P0 — must ship before calling `/camera` a narrow coach capability

1. [inference] Ship relay protocol v6 with three principals: private `host`, shared
   `controller`, and shared `coach`. Use distinct random bearer tokens and distinct
   E2E keys; never derive one from another and never try another role's key.
2. [inference] Store hashed, stateful capability records in the session Durable
   Object. Enforce fixed server-owned role templates, method/route scope, host
   binding, and expiry on every request and WebSocket handshake. Use 401 for
   invalid/expired and 403 for valid-but-out-of-scope credentials.
3. [inference] Give coach only `frame:write`, `voice:offer`, `cue:read`, and reduced
   `presence:read`. Target cues/voice answers to its capability id; provide no
   transcript/mirror reset/replay, session listing, prompt, approval, interrupt,
   revoke, result, host, or capability-management access.
4. [inference] Add host-side keyring/type enforcement as an independent boundary.
   Add the complete negative authorization matrix and the direct exploit regression
   test proving coach ciphertext can never reach `handlers.run` or control handlers.
5. [inference] Make coach capabilities individually revocable and alarm-expiring.
   Keep old protocols only as visibly broad `legacy`; fail closed for `/coach` until
   the user performs one explicit pairing rotation. Never present a v5 link as safe.

Evidence base: current Neko source and 29/29 passing baseline relay tests
(2026-07-29); Jitsi/Zoom/Signal role lifecycle; Cloudflare Access/DO lifecycle;
LiveKit media grants; RFC 6750/8707/8827/9700; Macaroons and Biscuit primary sources,
all cited in section A.

#### P1 — hardening after the boundary exists

1. [inference] Redeem the share-link bearer once into a browser-generated,
   proof-of-possession session key, so copying the URL after first use cannot clone
   the active device. Keep hard TTL and manual revocation because device binding is
   defense-in-depth, not a replacement. This follows RFC 9700 §2.2's
   sender-constrained-token direction; the exact browser protocol remains P1
   research ([RFC 9700 §2.2](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.2),
   Jan 2025; accessed 2026-07-29).
2. [inference] Add per-capability rate/body-size limits and metadata-only deny/audit
   events; surface them through `/coach status` without secrets or content.
3. [inference] Consider Macaroon/Biscuit-style attenuation only if Neko later needs
   third-party delegation, offline verification, or user-defined policy. Do not add
   a general policy engine for the fixed P0 matrix.

P1 evidence base: RFC 9700 §2.2 sender-constrained tokens (Jan 2025), current
bearer-link threat trace (working tree, 2026-07-29), and Macaroon/Biscuit delegation
models (2014/n.d.), all cited above. The exact redemption and rate-limit protocols
remain open design work rather than verified product behavior.

### B — UX

#### P0 — clear activation and reliable shutdown

1. [inference] Make `/coach` the only coach entry point. Bare `/coach` starts or
   reprints the current panel; add `/coach status`, `/coach qr`, `/coach off`, and
   `/coach new`, with `/coach stop` as a migration alias. Never use a destructive
   toggle.
2. [inference] Print rights, hard expiry, link, QR, explicit tap-to-capture consent,
   and exact stop/rotate/status commands together. Mark `/relay` as full control and
   replace its camera URL with `Run /coach` discovery text.
3. [inference] Default to 30 minutes, max two hours. `/coach off`, rotation, TUI
   exit, or expiry revokes the capability and stops voice/sockets; hide/pagehide
   releases camera/mic immediately but does not turn a transient app switch into an
   irreversible revoke.
4. [inference] If safe scoped issuance is unavailable, explain the required v6
   upgrade/rotation and produce no coach link. Never degrade to the full-control
   pairing for convenience.

#### P1 — make the active state difficult to forget

1. [inference] Add an always-visible `coach active <remaining>` footer/status item,
   connection and media state, a two-minute expiry warning, and explicit bounded
   extension.
2. [inference] Add optional revoke after five uninterrupted minutes without a coach
   WebSocket, plus a clear reconnection grace state. Hard TTL remains authoritative.
3. [inference] Add one-time device redemption, a metadata-only local audit view, and
   push/system notification when a coach connects or a denied route is attempted.

P1 evidence base: Claude Code's visible active/footer and push-notification patterns
(n.d.), Cloudflare DO alarm lifecycle (updated 2026-04-21), and the current camera
socket/media lifecycle (working tree, 2026-07-29), all cited above. Exact warning and
disconnect-grace durations require user testing.

## Checkpoint 2026-07-29 — final

- [verified] Direct code tracing established that the current camera URL is a full
  remote-control credential despite its narrow UI. Confidence: high.
  - Sources: `cloudflare/relay/worker.js:243-450`,
    `src/adapters/remote-relay.ts:168-306`, `src/ui/chat.tsx:1679-1791`, and
    `cloudflare/relay/camera.html:77-269` (working tree re-inspected 2026-07-29).
- [verified] Primary product and standards sources converge on server-enforced
  roles/grants, purpose-specific short-lived credentials, explicit lifecycle, and
  visible active state. Confidence: high.
  - Sources: Jitsi/Signal/Zoom/Cloudflare/LiveKit/RFC comparison sources in section
    A and Claude Code/Tailscale/Cloudflare/Signal UX sources in section B; publisher
    dates and access date 2026-07-29 are recorded in those tables.
- [inference] The current best design is a protocol-v6 opaque stateful capability,
  separate coach key, fixed route matrix, targeted non-replayed cue lane, 30-minute
  TTL, individual revocation, and a dedicated idempotent `/coach` lifecycle.
  Confidence: high on the boundary and flow; medium on exact timeout values.
  - Derived from: the P0/P1 decisions and their cited evidence in sections A/B.
- [open] Remaining measurements are real-user comprehension of the rights copy, QR
  scan completion rate, whether 30 minutes fits common shoots, and false revocation
  from the proposed five-minute disconnected grace. Validate these before promoting
  P1 defaults.
  - Source: these are explicitly unmeasured design parameters, identified during
    the 2026-07-29 evidence-to-design review; no product-data claim is made.
- [verified] Baseline relay tests passed 29 tests, 0 failed, and 203 assertions.
  - Source: `rtk bun test test/relay-worker.test.ts test/remote-relay.test.ts`, rerun
    against the current working tree on 2026-07-29 (exit 0, 3.32 s).
- [verified] Every non-placeholder external URL except Signal returned HTTP 200
  after redirects. Signal's official page was read successfully through the web
  reader but returned 403 to a generic `curl` client; its cited lifecycle facts came
  from the fetched page rather than a search snippet.
  - Sources: parallel URL audit and direct Signal page fetch, rerun 2026-07-29.
