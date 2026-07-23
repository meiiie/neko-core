# Security — the few things that actually sink a project

At a hackathon you won't build a security program. You need the handful of controls whose absence loses
the demo, leaks a secret, or gets you disqualified. Do these; skip the rest.

## Non-negotiable (do every time)
- **No secrets in the repo or client.** API keys, tokens, DB URLs live in env / the host's secret store,
  never committed and never shipped to the browser. Run a secret scan before any public push (Neko's own
  rule). A leaked key in a public Docker image or GitHub repo is a real, common loss.
- **Validate and sanitize every input at the boundary.** This kills the injection class (SQL/command/
  template) and the crash-on-bad-input that ends live demos. Parameterized queries, never string-built SQL.
- **HTTPS everywhere.** No plaintext auth or data, even in a demo.
- **Auth on every non-public endpoint.** A short-lived JWT via `Authorization: Bearer` beats a hand-rolled
  session; never trust a client-supplied user id. (See `backend.md`.)
- **Don't echo internals.** Errors return a helpful message, not a stack trace, DB dump, or secret.
  Turn off debug mode in the deployed build.

## Cheap wins if time allows
- **Rate-limit public endpoints** (even crude) so a loop or a curious judge can't wedge the service.
- **Least privilege**: the app's DB user / cloud token can do only what it needs. A demo key with god
  rights is a liability.
- **Dependency sanity**: pin versions (lockfile); avoid a random unmaintained package for a core path.
- **CORS/headers**: restrict origins to your own; set the basic security headers your framework offers.
- **PII/data**: don't log or display personal data you don't need; if the demo uses real user data, say
  how it's handled.

## Competition-specific (read the rules)
Some events forbid external network calls, tampering with provided assets, or "gaming" the scoring
(the VAIC brief bans pre-baking results, dual-path, and measurement gaming). Read the anti-cheat rules
and treat every optimization as an honest one — a disqualification is the worst possible score.

## The mindset (ties to the engine's skepticism)
Assume inputs are hostile and the network is untrusted. Verify a control works by trying to break it
(send the bad input, hit the endpoint without a token) — a security assumption you didn't test is not a
control. Don't ship a "should be safe"; ship one you watched reject the attack.
