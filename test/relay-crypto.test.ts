import { expect, test } from "bun:test";

import { open, seal, type Sealed } from "../src/adapters/relay-crypto.ts";

// The browser client (client.html) encrypts with SubtleCrypto. Mirror that here to prove the Node host
// and the browser client interoperate — i.e. either side can seal what the other opens.
const SALT = "neko-relay-e2e-v1";
const b64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));
const ub64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function webKey(secret: string) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: new TextEncoder().encode(SALT), iterations: 100_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
async function webSeal(secret: string, plaintext: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await webKey(secret), new TextEncoder().encode(plaintext)));
  return { iv: b64(iv), ct: b64(ct) };
}
async function webOpen(secret: string, s: Sealed): Promise<string> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ub64(s.iv) }, await webKey(secret), ub64(s.ct));
  return new TextDecoder().decode(pt);
}

test("relay-crypto: host (Node) seals -> client (WebCrypto) opens", async () => {
  const secret = "pair-code-12345";
  const sealed = seal(secret, "run the tests and report");
  expect(await webOpen(secret, sealed)).toBe("run the tests and report");
});

test("relay-crypto: client (WebCrypto) seals -> host (Node) opens", async () => {
  const secret = "pair-code-12345";
  const sealed = await webSeal(secret, "what is 17 times 4?");
  expect(open(secret, sealed)).toBe("what is 17 times 4?");
});

test("relay-crypto: a wrong secret cannot open (GCM auth fails)", () => {
  const sealed = seal("right-secret", "secret plan");
  expect(() => open("wrong-secret", sealed)).toThrow();
});

test("relay-crypto: tampered ciphertext is rejected", () => {
  const sealed = seal("s", "hello");
  const bytes = Uint8Array.from(atob(sealed.ct), (c) => c.charCodeAt(0));
  bytes[0] ^= 0xff; // flip a bit
  expect(() => open("s", { iv: sealed.iv, ct: btoa(String.fromCharCode(...bytes)) })).toThrow();
});
