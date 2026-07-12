# Neko Browser Bridge

Status: public-release candidate (2026-07-12). This is the Neko-owned, explicit-tab path for controlling an
already signed-in Chrome without copying its profile, cookies, or credential stores.

## Shape

```text
Neko Core / ToolRegistry
        |  MCP-shaped local tools + normal Neko approval gate
        v
127.0.0.1 authenticated bridge
        |  exact extension Origin + per-session capability
        v
Neko Browser Extension (Manifest V3)
        |  activeTab user gesture + read/click/type grants
        v
one selected Chrome tab
```

The core agent loop is unchanged. `src/adapters/browser-bridge.ts` is an edge adapter and is composed as
another `McpTools` source. The extension contains no model, planner, cloud client, or relay secret.

## User contract

1. Run `neko browser bridge` and keep it open.
2. Install the public extension when available, or load `browser-extension/` unpacked during development.
3. Open a target page, click the extension, and choose **Attach this tab to Neko**.
4. Reading is scoped to that attached tab. Click/scroll/navigation and typing are separate switches, off
   by default. Password, OTP, passcode and payment fields remain blocked even when typing is enabled.
5. **Emergency stop** immediately detaches the tab and clears action grants.

The attached page always gets an `AI` toolbar badge and a visible **Neko is using this tab** marker with
its own Stop button. If the tab was ungrouped, Neko creates a temporary `Neko - AI active` group and removes
it on detach. An existing user-created group is never renamed, recolored, rearranged, or removed.

`neko browser rotate` revokes the saved capability for the next bridge start. The token lives with mode
0600 in `~/.neko-core/browser-bridge.json`; it is never printed, committed, placed in a URL, or sent to the
Cloudflare relay.

## Protocol and trust boundaries

- The server binds only `127.0.0.1` and accepts WebSocket upgrades only from exact extension Origins whose
  32-character ids are in config-first `browser_extension_ids`. The deterministic unpacked id is the default;
  the Chrome Web Store item id is added after the Dashboard creates it. Arbitrary extensions are never accepted.
- Initial pairing is available for ten minutes after bridge start and requires the extension's attach
  user gesture. Reconnect uses the per-session 256-bit capability.
- Local HTTP commands require the same bearer capability, cap request/message sizes at 64 KiB, validate
  action names, and time out after 30 seconds.
- Audit rows contain timestamp/action/status only. They deliberately omit command arguments, typed text,
  page content, full URLs and cookies.
- Cross-origin navigation revokes the tab attachment. The user must attach the new origin explicitly.
- Production uses `activeTab`, not `<all_urls>` or `debugger`. This is intentionally less powerful than a
  CDP extension; Playwright MCP remains the high-capability browser adapter when full automation is needed.

## Relay boundary

The local bridge writes a redacted status file containing only online/connected, attached host and grant
booleans. The TUI includes that object inside the existing E2E-sealed relay presence; the phone UI shows
`browser attached`. Page content, commands, cookies and the browser capability never enter the relay.

## Reconnect and ownership

The extension stores `{session, token, tab id, tab origin, grants, Neko-created group id}` in its own Chrome storage and resumes the
same local session while the capability remains valid. Only one extension connection owns a bridge session;
a newer authenticated connection replaces the older one. Closing the tab or crossing origins detaches it.

## Verification

- Unit E2E: exact-Origin pairing, token-authenticated command round trip, redacted audit, unauthorized HTTP
  rejection.
- Popup Playwright test at 360x640: status, grants, detach and emergency-stop affordances.
- Real Manifest V3 harness: pair -> attach -> snapshot -> deny ungranted click -> grant -> click/type ->
  block password -> emergency stop. The harness adds localhost host permission only to a temporary copy;
  a repo test locks the production manifest to `activeTab` without `<all_urls>` or `debugger`.
- Public-release harness: the in-page indicator is present, its Stop button detaches and removes a Neko-created
  group, while a pre-existing user group retains its original title and remains grouped after detach.

Web Store privacy copy, permission explanations, reviewer steps, and the two-phase item-ID procedure live in
`browser-extension/`. Tagged GitHub releases attach an auditable unpacked bundle; normal Windows/macOS updates
should use the Chrome Web Store once the owner submits and the item passes review.

Native messaging is not needed in the developer preview. Add it only if managed-browser policy blocks
loopback WebSockets or a packaged enterprise installer needs OS-level host attestation.
