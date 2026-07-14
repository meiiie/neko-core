# Neko Browser Bridge privacy policy

Effective: July 12, 2026

Neko Browser Bridge is a local companion extension for Neko Core. It attaches only the Chrome tab
that the user explicitly selects. The extension has no analytics, advertising, account system, or
direct cloud/relay connection.

## Data the extension handles

While a tab is attached, the extension can read its URL origin/path, title, and a compact snapshot of
visible interactive elements. It can click, scroll, navigate, or type non-sensitive text only when the
corresponding permission is enabled in the extension. Password, one-time-code, and payment fields are
always blocked.

If the user explicitly attaches a mail, chat, or social-network tab, the visible interactive-element
snapshot can include personal communications shown in that tab. The extension does not scan other tabs or
store those communications in its audit, but Neko Core may send the task-specific snapshot to the configured
model provider as described below.

The extension sends this data only to Neko Core over an authenticated loopback connection on the same
computer (`127.0.0.1`). Neko Core may then send the specific page snapshot required for a task to the
language-model provider configured by the user. That provider's privacy terms apply. Browser cookies,
authentication storage, passwords, one-time codes, and payment details are not read or sent by this
extension. Nothing is sent through Neko Relay.

## Local storage and retention

Chrome local storage contains the local Neko session capability, the selected tab metadata, permission
switches, and at most 20 audit entries containing timestamp, action name, and outcome. It does not store
page contents or typed text. Neko Core stores its matching capability and redacted bridge status under
`~/.neko-core/`. Data remains until it is replaced, cleared in Chrome, removed with the extension, or
rotated with `neko browser rotate`.

## User control

The attached page displays a visible "Neko is using this tab" indicator. The user can disable click or
typing access, detach the tab, or press Emergency stop at any time. Cross-origin navigation automatically
detaches the tab. Neko does not rename or rearrange an existing user-created tab group.

## Sharing and sale

The project does not sell user data and does not share it for advertising, credit, or unrelated purposes.
The only onward transfer is the task-specific data Neko Core sends to the model provider selected by the
user, as described above.

Questions or deletion requests can be opened at
<https://github.com/meiiie/neko-core/issues>.
