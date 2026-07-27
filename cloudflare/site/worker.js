/**
 * neko.holilihu.online - the landing page, plus the two paths that must never change.
 *
 * `curl -fsSL https://neko.holilihu.online/install.sh | sh` is printed in the README, inside both
 * installer scripts, and in every release note. Whatever else this site becomes, those two URLs have to
 * keep returning the installer. They are handled here rather than in `_redirects` so the behaviour is
 * explicit and testable rather than a convention of the assets layer.
 */
const REPO = "https://raw.githubusercontent.com/meiiie/neko-core/main";

const INSTALLERS = {
  "/install.sh": `${REPO}/install.sh`,
  "/install.ps1": `${REPO}/install.ps1`,
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const installer = INSTALLERS[url.pathname];
    if (installer) {
      // 302, matching what the domain already served, so a pinned-version one-liner keeps working.
      return Response.redirect(installer, 302);
    }
    return env.ASSETS.fetch(request);
  },
};
