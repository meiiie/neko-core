import { expect, test } from "bun:test";

const html = await Bun.file(new URL("../cloudflare/relay/client.html", import.meta.url)).text();
const script = html.match(/<script[^>]*>([\s\S]*)<\/script>/)?.[1] ?? "";

test("relay client script parses and exposes the complete multi-session control path", () => {
  expect(() => new Function(script)).not.toThrow();
  expect(script).toContain('"/sessions?session="');
  expect(script).toContain("hostId: host");
  expect(script).toContain("const pending = new Map()");
  expect(script).toContain("nekoRelayHistory");
  expect(script).toContain("drafts[currentHost()]");
  expect(script).toContain('localStorage.removeItem("nekoRelayHistory")');
  expect(script).toContain("rr.status === 401");
});

test("relay client keeps terminal semantics and accessible control names", () => {
  expect(html).toContain('role="log"');
  expect(html).toContain('<script nonce="__CSP_NONCE__">');
  expect(html).toContain('<style nonce="__CSP_NONCE__">');
  expect(html).toContain('aria-label="message Neko"');
  expect(html).toContain('aria-label="switch Neko session"');
  expect(script).toContain('t.className = "turn user"');
  expect(script).toContain('t.className = "turn neko"');
  expect(html).toContain('class="pr">&gt;</span>');
  expect(html).toContain('id="hversion">v0.9.0</small>');
  expect(html).toContain('Try: "explain src/agent.ts"   or   /help');
  expect(html).toContain("width: 100%; max-width: none; height: 100dvh");
  expect(script).toContain('e.key === "Escape"');
  expect(script).toContain('e.key === "Tab" && e.shiftKey');
  expect(script).toContain('"\\u0000neko:cycle-mode"');
  expect(script).toContain("log.scrollHeight - log.clientHeight - log.scrollTop");
  expect(script).toContain('location.pathname.match(/^\\/(?:session|hub)');
  expect(script).toContain("nekoRelayPairings");
  expect(script).toContain("const legacyMatches = localStorage.nekoSession === session.value");
  expect(script).toContain('"/client-ws?session="');
  expect(script).toContain('frame.t === "mirror_reset"');
  expect(script).toContain('event.type === "snapshot"');
  expect(script).toContain("connectMirror(true)");
  expect(script).toContain("Math.min(1_000 * 2 ** mirrorFailures++, 25_000)");
});
