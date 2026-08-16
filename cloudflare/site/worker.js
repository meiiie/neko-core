/**
 * neko.holilihu.online — the landing page, the two paths that must never change, and the version
 * numbers that must never be stale.
 *
 * `curl -fsSL https://neko.holilihu.online/install.sh | sh` is printed in the README, inside both
 * installer scripts, and in every release note. Whatever else this site becomes, those two URLs have to
 * keep returning the installer, so they are handled here rather than left to a convention of the assets
 * layer.
 *
 * The page also carries a version and five download sizes. Hardcoding them means every release needs a
 * site deploy, and the day someone forgets, the page lies about what it is offering. So the Worker reads
 * the latest release from the GitHub API and rewrites those spots on the way out. Three properties make
 * that safe to do on every request:
 *
 *   - It is CACHED for ten minutes in Cloudflare's own cache, so GitHub sees roughly six calls an hour
 *     from this Worker regardless of traffic, well inside the unauthenticated rate limit.
 *   - It FAILS OPEN. If GitHub is slow, rate-limiting, or down, the response is the static HTML with the
 *     values baked in at deploy time. A stale number is a small problem; a blank page is a big one.
 *   - It only ever fills in elements the markup MARKED for it (`data-release`), so the page is complete
 *     and correct on its own and the Worker is an enhancement rather than a dependency.
 */
const REPO = "meiiie/neko-core";
const RAW = `https://raw.githubusercontent.com/${REPO}/main`;
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_TTL = 600; // seconds

const INSTALLERS = {
  "/install.sh": `${RAW}/install.sh`,
  "/install.ps1": `${RAW}/install.ps1`,
};

/** MB, rounded the way a human reads a download size. */
function megabytes(bytes) {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/**
 * The latest release, or null. Cached in the Cloudflare cache under a stable key so all colos and all
 * requests share one upstream call per TTL. Every failure path returns null, which the caller treats as
 * "leave the page exactly as it was built".
 */
async function latestRelease(ctx) {
  const key = new Request("https://neko.holilihu.online/__release", { method: "GET" });
  const cache = caches.default;
  const hit = await cache.match(key);
  if (hit) {
    const cached = await hit.json().catch(() => null);
    // Freshness is checked against a timestamp WE wrote, not against the platform honouring
    // Cache-Control. v0.18.0 shipped and this endpoint kept answering 0.17.1 in one region while
    // another was already correct: the entry was outliving its max-age, and each expiry re-read a
    // still-cached upstream and re-primed the same stale answer for another interval.
    if (cached && typeof cached.at === "number" && Date.now() - cached.at < RELEASE_TTL * 1000) return cached;
  }

  let res;
  try {
    // No `cf.cacheTtl` here on purpose. Two caches with the same TTL stacked on one another is what
    // produced the self-refreshing stale loop; this Worker keeps exactly one, the one above.
    res = await fetch(RELEASE_API, {
      headers: {
        // GitHub rejects unidentified clients; the version pin keeps the response shape stable.
        "User-Agent": "neko-core-site",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cf: { cacheTtl: 0 },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;

  const data = await res.json().catch(() => null);
  if (!data || typeof data.tag_name !== "string") return null;

  const info = {
    at: Date.now(),
    version: data.tag_name.replace(/^v/, ""),
    url: typeof data.html_url === "string" ? data.html_url : `https://github.com/${REPO}/releases`,
    sizes: Object.fromEntries(
      (Array.isArray(data.assets) ? data.assets : [])
        .filter((a) => a && typeof a.name === "string" && typeof a.size === "number" && !a.name.endsWith(".sha256"))
        .map((a) => [a.name, megabytes(a.size)]),
    ),
  };
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(info), {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${RELEASE_TTL}` },
  })));
  return info;
}

/** Fill the marked spots. `data-release="version"` and `data-release="size:<asset>"`. */
function inject(response, info) {
  return new HTMLRewriter()
    .on("[data-release]", {
      element(el) {
        const what = el.getAttribute("data-release") || "";
        if (what === "version") return el.setInnerContent(info.version);
        if (what.startsWith("size:")) {
          const size = info.sizes[what.slice(5)];
          if (size) el.setInnerContent(size);
        }
      },
    })
    .transform(response);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const installer = INSTALLERS[url.pathname];
    // 302, matching what the domain served before this Worker existed, so a pinned-version one-liner
    // keeps working.
    if (installer) return Response.redirect(installer, 302);

    // A tiny JSON view of what the page is being told, so the release workflow can assert the site
    // caught up instead of a human checking by eye.
    if (url.pathname === "/__release") {
      const info = await latestRelease(ctx);
      return new Response(JSON.stringify(info ?? { version: null }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }

    const response = await env.ASSETS.fetch(request);
    const type = response.headers.get("content-type") || "";
    if (!type.includes("text/html")) return response;

    const info = await latestRelease(ctx);
    return info ? inject(response, info) : response;
  },
};
