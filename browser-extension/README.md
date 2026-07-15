# Neko Browser Bridge

This Manifest V3 extension attaches exactly one user-selected Chrome tab to a local Neko session.
It does not read Chrome cookies, passwords, or session stores, and it never talks to the cloud relay.
Visible page snapshots requested by Neko may be sent by Neko Core to the model provider the user configured;
see [PRIVACY.md](PRIVACY.md) for the exact boundary.

For live pages such as chat, the extension can wait inside the attached tab for visible text to change and
settle before returning a fresh snapshot. This avoids repeated model polling and does not store message text.

## Load locally

Run `neko`, then ask it to browse a signed-in site or type `/browser`. Neko prepares this folder, opens `chrome://extensions`, starts the loopback
bridge, and reports the setup in the same TUI. `neko browser install` is the non-TUI fallback; neither route
requires Bun or a source checkout. Until the Chrome Web Store item is approved, enable Developer mode and
choose **Load unpacked** once; the folder is opened for you. After Store publication, the same command opens the
listing and Chrome asks for its one required Add-extension confirmation.

Then open the target page, click Neko, and choose **Attach this tab to Neko**. Enable click or typing only when
the current task needs it. Emergency stop detaches immediately. Later `neko` sessions start the bridge themselves;
`neko browser bridge` remains a foreground diagnostic command.

The attached page gets a visible indicator and `AI` badge. If it was not already grouped, Neko creates a
temporary `Neko - AI active` tab group; existing user groups are left untouched.

The extension reconnects the same attached tab after Chrome's background worker sleeps or Neko restarts.
If `neko browser rotate` revoked the old capability, clicking **Attach** once performs a fresh user-approved
pairing; temporary network/bridge outages never erase a valid saved pairing.

The unpacked extension id is pinned to `koalaflndbcddboachbdfmppdeblldje`. The bridge accepts only that
Chrome extension origin on loopback and authenticates reconnects with a per-session capability stored in
`~/.neko-core/browser-bridge.json` (never printed and never committed).

Public-release preparation is documented in [PUBLISHING.md](PUBLISHING.md), with Web Store copy and
permission disclosures in [STORE-LISTING.md](STORE-LISTING.md).
