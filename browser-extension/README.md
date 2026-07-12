# Neko Browser Bridge

This Manifest V3 extension attaches exactly one user-selected Chrome tab to a local Neko session.
It does not read Chrome cookies, passwords, or session stores, and it never talks to the cloud relay.
Visible page snapshots requested by Neko may be sent by Neko Core to the model provider the user configured;
see [PRIVACY.md](PRIVACY.md) for the exact boundary.

## Load locally

1. Run `neko browser bridge` and keep that terminal open.
2. Open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder.
3. Open the target page, click the Neko extension, then **Attach this tab to Neko**.
4. Enable click or typing only when the current task needs it. Emergency stop detaches immediately.

The attached page gets a visible indicator and `AI` badge. If it was not already grouped, Neko creates a
temporary `Neko - AI active` tab group; existing user groups are left untouched.

The unpacked extension id is pinned to `koalaflndbcddboachbdfmppdeblldje`. The bridge accepts only that
Chrome extension origin on loopback and authenticates reconnects with a per-session capability stored in
`~/.neko-core/browser-bridge.json` (never printed and never committed).

Public-release preparation is documented in [PUBLISHING.md](PUBLISHING.md), with Web Store copy and
permission disclosures in [STORE-LISTING.md](STORE-LISTING.md).
