import crypto from "crypto";

// Meta signs every webhook POST body with HMAC-SHA256 using the app secret,
// sent as `X-Hub-Signature-256: sha256=<hex>`. Verifying this is the only
// way to be sure a webhook call actually came from Meta and not a forged
// request — never process a webhook body without checking this first.
export function verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!signatureHeader || !appSecret) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
