# Chrome Web Store listing draft

## Product details

- Name: `Neko Browser Bridge`
- Summary (132 characters max): `Safely attach one chosen Chrome tab to a local Neko Core session.`
- Category: Developer Tools
- Language: English

### Description

Connect one Chrome tab you choose to Neko Core, the local-first terminal coding agent.

Neko Browser Bridge makes browser control visible and reversible:

- one-click attachment for the active tab;
- a clear `Neko is using this tab` marker and an `AI` toolbar badge;
- a dedicated `Neko - AI active` group when the tab was not already grouped;
- separate switches for click/navigation and non-sensitive typing;
- password, OTP, and payment-field blocking;
- an Emergency stop button and automatic detach on cross-origin navigation;
- a local, redacted action audit;
- no cookie access and no connection to Neko Relay.

The extension requires Neko Core running on the same computer. Start `neko browser bridge`, open the
extension on the tab you want to use, and choose **Attach this tab to Neko**.

## Single purpose

Attach one user-selected Chrome tab to a locally running Neko Core session with visible, revocable,
least-privilege browser controls.

## Permission justifications

- `activeTab`: grants temporary access only after the user opens the extension on the current tab.
- `scripting`: reads a compact visible-element snapshot, performs explicitly approved actions, and shows
  the in-page control indicator on that selected tab.
- `storage`: preserves the local pairing capability, permission switches, and a redacted 20-entry audit.
- `tabGroups`: marks an otherwise ungrouped attached tab as `Neko - AI active`. Existing user groups are
  never renamed or rearranged, and a Neko-created group is removed on detach.

The extension requests no host permissions, `cookies`, `debugger`, `downloads`, or `<all_urls>` access.
It executes no remote-hosted code. The loopback protocol accepts only a fixed, reviewable command set.

## Data-use disclosure

Disclose **Website content**, **Web browsing activity**, and **User activity** because visible page data
is processed even though it first stays on the user's machine. State that the extension does not collect
authentication information, financial information, personal communications, or location, and link the
published `PRIVACY.md`. Keep the Dashboard answers exactly consistent with the privacy policy.

## Required listing media

- 128 x 128 extension icon: `icons/icon-128.png` (already included).
- At least one 1280 x 800 or 640 x 400 screenshot showing the popup and visible page indicator.
- 440 x 280 small promotional tile.
- Optional 1400 x 560 marquee tile.

Do not include private sites, account names, cookies, tokens, or personal content in screenshots.

## Reviewer instructions

1. Install the current Neko Core release.
2. Run `neko browser bridge` and leave it open.
3. Open `https://example.com`, open the extension, and select **Attach this tab to Neko**.
4. Confirm the toolbar badge, in-page marker, Neko-created tab group, permission switches, and Emergency
   stop. Existing Chrome tab groups can be verified to remain unchanged.
