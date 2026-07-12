# Publishing Neko Browser Bridge

The source is ready for public distribution, but Chrome Web Store publication requires an owner-controlled
Chrome Web Store developer account and a one-time registration fee. Submission is therefore a release-owner
step, not something the Neko runtime performs.

## First Chrome Web Store upload

1. Run `bun scripts/package-browser-extension.ts --store-first-upload`.
2. Register or open the Chrome Web Store Developer Dashboard and add a new item.
3. Upload `dist/neko-browser-extension-0.2.0-store-first-upload.zip`. Its root contains `manifest.json`;
   the developer-only `key` is intentionally removed for this first upload.
4. In the item's **Package** tab, choose **View public key**. Copy the base64 body into the manifest's
   `key` field. Confirm that the resulting unpacked ID equals the Dashboard item ID.
5. Replace the developer ID in Neko's default `browser_extension_ids` with the Store item ID, while
   retaining the developer ID only if local unpacked builds still need it. Users can also configure IDs:

   ```json
   { "browser_extension_ids": ["the_32_character_store_item_id"] }
   ```

6. Re-run all tests and package the final Store-keyed build. Never add a private `.pem` key to the repo.

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
- <https://developer.chrome.com/docs/extensions/reference/manifest/key>
- <https://developer.chrome.com/docs/webstore/cws-dashboard-privacy>
- <https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements>
