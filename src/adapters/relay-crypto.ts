/**
 * End-to-end encryption for /remote-relay — so the relay (your Cloudflare Worker) only ever forwards
 * ciphertext and can never read your messages or Neko's replies (a blind, zero-knowledge forwarder).
 * The host (Neko) and the phone client share a `secret` (a pairing code printed by /relay, never sent
 * to the relay). Both derive the same AES-256-GCM key from it; payloads are sealed/opened at the edges.
 *
 * Wire format is WebCrypto-compatible (SubtleCrypto AES-GCM appends the 16-byte auth tag to the
 * ciphertext), so this Node side and the browser client interoperate without conversion.
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";

const SALT = "neko-relay-e2e-v1";
const ITERATIONS = 100_000;
const TAG_BYTES = 16;

export interface Sealed {
  iv: string; // base64 (12-byte GCM nonce)
  ct: string; // base64 (ciphertext with the GCM tag appended, WebCrypto-style)
}

function keyFor(secret: string): Buffer {
  return pbkdf2Sync(secret, SALT, ITERATIONS, 32, "sha256");
}

/** Encrypt UTF-8 plaintext. Output matches SubtleCrypto's encrypt (ct||tag, base64). */
export function seal(secret: string, plaintext: string): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("base64"), ct: Buffer.concat([enc, tag]).toString("base64") };
}

/** Decrypt a {iv,ct} blob produced by seal() or by the browser's SubtleCrypto. Throws if tampered. */
export function open(secret: string, sealed: Sealed): string {
  const iv = Buffer.from(sealed.iv, "base64");
  const data = Buffer.from(sealed.ct, "base64");
  const tag = data.subarray(data.length - TAG_BYTES);
  const body = data.subarray(0, data.length - TAG_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", keyFor(secret), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}

/** True when a value looks like a Sealed payload (so the host can run with or without E2E). */
export function isSealed(v: unknown): v is Sealed {
  return !!v && typeof v === "object" && typeof (v as Sealed).iv === "string" && typeof (v as Sealed).ct === "string";
}
