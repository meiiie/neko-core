# Chrome Web Store listing draft

## Product details

- Name: `Neko Browser Bridge`
- Summary (132 characters max): `Let a local Neko Core session attach and operate one visible Chrome tab.`
- Category: Developer Tools
- Language: English

### Description

Connect one Chrome tab you choose to Neko Core, the local-first terminal coding agent.

Neko Browser Bridge makes browser control visible and reversible:

- autonomous or one-click attachment for the active tab;
- a clear `Neko is using this tab` marker and an `AI` toolbar badge;
- a dedicated `Neko - AI active` group when the tab was not already grouped;
- separate switches for click/navigation and non-sensitive typing;
- password, OTP, and payment-field blocking;
- an Emergency stop button and automatic detach on cross-origin navigation;
- a local, redacted action audit;
- no cookie access and no connection to Neko Relay.

The extension requires Neko Core running on the same computer. Start `neko`, ask it to browse a signed-in
site (or type `/browser`), and open that site. Autonomous attach is enabled by default; it can be disabled
in the popup for manual **Attach this tab to Neko** operation.

## Single purpose

Attach one active Chrome tab to a locally running Neko Core session with visible, revocable controls.

## Permission justifications

- `host access` (`http://*/*`, `https://*/*`): permits the user-switchable autonomous attach flow on ordinary
  web pages without requiring a fresh toolbar gesture; it excludes browser-internal and local-file pages;
- `scripting`: reads a compact visible-text/element snapshot, waits for visible text changes when requested,
  performs explicitly approved actions, and shows the in-page control indicator on that selected tab.
- `storage`: preserves the local pairing capability, permission switches, and a redacted 20-entry audit.
- `tabGroups`: marks an otherwise ungrouped attached tab as `Neko - AI active`. Existing user groups are
  never renamed or rearranged, and a Neko-created group is removed on detach.
- `alarms`: wakes the Manifest V3 background worker every 30 seconds while a tab remains attached, or while
  a bounded autonomous-attach retry is pending, so temporary suspension or bridge startup does not strand it.

The extension requests no `cookies`, `debugger`, `downloads`, or `<all_urls>` access.
It executes no remote-hosted code. The loopback protocol accepts only a fixed, reviewable command set.

## Data-use disclosure

Disclose **Website content**, **Web browsing activity**, **User activity**, **Personal communications**,
**Authentication information**, **Financial and payment information**, and **Location**. A compact visible
snapshot can contain any of those categories when the attached site renders them as ordinary page content.
Clarify that the extension does not directly read cookies/authentication storage and blocks password, OTP,
and payment-field values; those controls do not filter sensitive text visibly rendered elsewhere on a page.
Link the published `PRIVACY.md` and keep the Dashboard answers exactly consistent with this policy.

## Required listing media

- 128 x 128 extension icon: `icons/icon-128.png` (already included).
- At least one 1280 x 800 or 640 x 400 screenshot showing the popup and visible page indicator.
- 440 x 280 small promotional tile.
- A public YouTube promo video URL is listed among the current Dashboard graphic assets.
- Optional 1400 x 560 marquee tile.

Do not include private sites, account names, cookies, tokens, or personal content in screenshots.

## Reviewer instructions

1. Install the current Neko Core release.
2. Run `neko browser bridge` and leave it open.
3. Open `https://example.com`, open the extension, and select **Attach this tab to Neko**.
4. This explicit first attach creates the local pairing capability. Confirm the toolbar badge, in-page marker,
   Neko-created tab group, permission switches, and Emergency
   stop. Existing Chrome tab groups can be verified to remain unchanged.
