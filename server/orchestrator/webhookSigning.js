// HMAC signing for developer webhook deliveries (Phase 17 §16) — Stripe's
// well-documented convention (`t=<timestamp>,v1=<hmac>`), reused rather
// than inventing a new scheme, since it's the format most developers
// integrating a webhook receiver will already recognize and have
// verification snippets for.
import crypto from "crypto";

// The signed string is `${timestamp}.${rawBody}` — including the timestamp
// IN the signed content (not just alongside it) is what makes this replay-
// resistant: a captured (timestamp, signature, body) triple can't be
// replayed with a forged later timestamp, since the signature wouldn't
// match the new timestamp.
export function signWebhookPayload(secret, rawBody) {
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  return { timestamp, signature, header: `t=${timestamp},v1=${signature}` };
}

// For a receiver-side verification example in WEBHOOKS.md / the test-send
// endpoint's own self-check — not used by the delivery path itself (which
// only ever signs, never verifies its own signature back).
export function verifyWebhookSignature(secret, rawBody, header, { toleranceSeconds = 300 } = {}) {
  const match = /^t=(\d+),v1=([0-9a-f]+)$/.exec(header || "");
  if (!match) return false;
  const [, tsStr, signature] = match;
  const timestamp = Number(tsStr);
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false; // replay protection
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  // Constant-time comparison — a signature check is exactly the kind of
  // thing that must never leak timing information about how much of the
  // expected value the attacker's guess matched.
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
