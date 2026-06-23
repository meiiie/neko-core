import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { NekoOAuthProvider } from "../src/adapters/mcp-oauth.ts";

test("NekoOAuthProvider persists client info, tokens, and PKCE verifier", () => {
  const p = new NekoOAuthProvider("__test_oauth__", 41789);
  expect(p.redirectUrl).toBe("http://localhost:41789/callback");
  expect(p.clientMetadata.redirect_uris[0]).toBe(p.redirectUrl);

  p.saveClientInformation({ client_id: "abc" });
  p.saveTokens({ access_token: "t0" });
  p.saveCodeVerifier("v123");
  expect(p.clientInformation()?.client_id).toBe("abc");
  expect(p.tokens()?.access_token).toBe("t0");
  expect(p.codeVerifier()).toBe("v123");

  rmSync(join(homedir(), ".neko-core", "mcp-auth", "__test_oauth__"), { recursive: true, force: true });
});
