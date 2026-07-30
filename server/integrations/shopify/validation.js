import crypto from "crypto";

// Shopify signs every webhook POST body with HMAC-SHA256, base64-encoded,
// sent as `X-Shopify-Hmac-Sha256`. The secret is the API secret key from
// the custom app that created the webhook (Shopify Admin → Settings →
// Apps and sales channels → Develop apps → your app → API credentials).
export function verifyShopifyWebhook(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("base64");
  const a = Buffer.from(expected);
  const b = Buffer.from(hmacHeader);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
