# Publishing Neko Browser Bridge

The runtime package is ready for owner testing, but public Chrome Web Store publication is not complete until
the listing media, stable privacy URL, owner-controlled developer account, review, and final Store item id are
in place. The account has a one-time registration fee. Submission is therefore a release-owner step, not
something the Neko runtime performs.

## Readiness at a glance

- Ready: Manifest V3 package, 16/32/48/128 icons, least-privilege permission copy, privacy policy, reviewer
  instructions, deterministic developer id, first-upload ZIP, reconnect, visible control state, and emergency stop.
- Owner step: register the publisher, capture clean 1280 x 800 listing screenshots, create the 440 x 280 tile,
  publish the promo video requested by the current Dashboard guidance, host `PRIVACY.md` at stable HTTPS, submit
  for review, and add the assigned Store id to `browser_extension_store_id`.
- Publication is optional for personal/developer use. It is the practical requirement for a polished public
  one-click install and automatic updates on normal Windows and macOS Chrome.

## Use now versus Web Store

- **Immediate and free:** run `neko` and type `/browser` (or use `neko browser install` outside the TUI). A source checkout uses its audited local folder; a released
  single binary downloads the ten fixed extension assets from its own versioned Git tag into
  `~/.neko-core/browser-extension`, validates the manifest identity, opens `chrome://extensions` and reveals the
  folder. Load unpacked still requires Chrome's one-time Developer-mode gesture and does not receive Store updates.
- **Public automatic updates:** register the owner account, upload the Store package, and pass review. Google
  shows the one-time fee in the registration flow; do not hard-code a currency/amount into Neko.
- Every first publication and update is reviewed. Google says most reviews finish within a few days but some
  take several weeks, and its review page currently warns of longer queues from the April 2026 submission
  surge. Contact support only after an item has remained pending for more than three weeks.
- Private and unlisted Web Store visibility do not bypass review. They change discovery, not the review gate.
- Normal Windows/macOS Chrome users cannot receive a silent off-Store install. Once the Store id is added to
  config-first `browser_extension_store_id`, `/browser` and `neko browser install` open that listing automatically; Chrome retains
  the final Add-extension confirmation. Silent force-install is reserved for administrator-managed browsers.

## First Chrome Web Store upload

1. Run `bun scripts/package-browser-extension.ts --store-first-upload`.
2. Register or open the Chrome Web Store Developer Dashboard and add a new item.
3. Upload `dist/neko-browser-extension-0.3.0-store-first-upload.zip`. Its root contains `manifest.json`;
   the developer-only `key` is intentionally removed for this first upload.
4. In the item's **Package** tab, choose **View public key**. Record both the base64 public-key body and the
   32-character Dashboard item id. Do not publish the first upload yet.
5. Make one identity-finalization patch before review: put the Dashboard public key in `manifest.json`, set
   `NEKO_BROWSER_EXTENSION_ID` and the default `browser_extension_store_id` to the Dashboard item id, retain
   the old unpacked id only as a temporary migration allowlist entry, and update the identity tests. Confirm
   that loading the final unpacked folder produces exactly the Dashboard item id.

   ```json
   { "browser_extension_store_id": "the_32_character_store_item_id" }
   ```

6. Re-run all tests, package the final Store-keyed build, upload it over the draft, then submit that exact ZIP
   for review. Never add a private `.pem` key to the repo.

## Dashboard checklist

- Paste the copy and permission explanations from `STORE-LISTING.md`.
- Publish `PRIVACY.md` at a stable public HTTPS URL and use that URL in the Privacy practices tab.
- Declare no remote-hosted code. Neko receives only the finite commands visible in `service-worker.js`.
- Make data disclosures match the privacy policy, including local processing of website content.
- Upload clean screenshots and promotional media with no private account data.
- Provide the reviewer steps for starting the local Neko companion bridge.
- Use deferred/manual publish and a limited rollout for the first approved release.

## Public GitHub bundle

Tagged Neko releases also attach the unpacked extension bundle. This is useful for development and audit,
but Windows and macOS users should receive automatic updates through the Chrome Web Store after approval.

Official references:

- <https://developer.chrome.com/docs/webstore/register>
- <https://developer.chrome.com/docs/webstore/prepare>
- <https://developer.chrome.com/docs/webstore/publish>
- <https://developer.chrome.com/docs/webstore/review-process>
- <https://developer.chrome.com/docs/extensions/reference/manifest/key>
- <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>
- <https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements>
