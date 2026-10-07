/**
 * holilihu.online — the HoLiLiHu company site.
 *
 * Pages live in ./public and work with JavaScript off. This Worker only:
 *   - sends www.holilihu.online to https://holilihu.online (same path and query)
 *   - serves those static files
 *   - adds security headers, and noindex on the 404
 *
 * It does not call any other host, count visitors, or touch the neko-site Worker.
 */

const SECURITY = {
  "Content-Security-Policy": [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'none'",
    "connect-src 'none'",
  ].join("; "),
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "X-Frame-Options": "DENY",
};

function withHeaders(response, extra) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(SECURITY)) headers.set(key, value);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // www always lands on the canonical https apex. Apex HTTP is left to
    // Cloudflare's edge redirect — doing it here makes `wrangler dev` loop,
    // because local preview is plain HTTP on the zone hostname.
    if (url.hostname === "www.holilihu.online") {
      url.hostname = "holilihu.online";
      url.protocol = "https:";
      return withHeaders(Response.redirect(url.toString(), 301));
    }

    const response = await env.ASSETS.fetch(request);
    const extra = {};
    if (response.status === 404) {
      extra["Cache-Control"] = "no-store";
      extra["X-Robots-Tag"] = "noindex";
    } else if (url.pathname === "/" || url.pathname.endsWith(".html")) {
      extra["Cache-Control"] = "public, max-age=300";
    } else {
      extra["Cache-Control"] = "public, max-age=86400";
    }
    return withHeaders(response, extra);
  },
};
