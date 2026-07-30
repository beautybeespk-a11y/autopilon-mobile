const API_VERSION = process.env.WHATSAPP_API_VERSION || "v19.0";
const BASE = `https://graph.facebook.com/${API_VERSION}`;

async function waFetch(phoneNumberId, accessToken, body) {
  const res = await fetch(`${BASE}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `WhatsApp API error ${res.status}`);
    err.code = data?.error?.code;
    throw err;
  }
  return data;
}

export async function sendTextMessage(phoneNumberId, accessToken, to, text) {
  return waFetch(phoneNumberId, accessToken, { to, type: "text", text: { body: text } });
}

export async function sendImageMessage(phoneNumberId, accessToken, to, { link, caption }) {
  return waFetch(phoneNumberId, accessToken, { to, type: "image", image: { link, caption } });
}

export async function sendDocumentMessage(phoneNumberId, accessToken, to, { link, filename, caption }) {
  return waFetch(phoneNumberId, accessToken, { to, type: "document", document: { link, filename, caption } });
}

// Template messages are required for business-initiated contact outside the
// 24-hour customer service window, and must be pre-approved in Meta's
// dashboard — this just invokes whichever approved template name is given.
export async function sendTemplateMessage(phoneNumberId, accessToken, to, { templateName, languageCode = "en_US", components }) {
  return waFetch(phoneNumberId, accessToken, {
    to,
    type: "template",
    template: { name: templateName, language: { code: languageCode }, components: components || [] },
  });
}

export async function markMessageRead(phoneNumberId, accessToken, messageId) {
  return waFetch(phoneNumberId, accessToken, { status: "read", message_id: messageId });
}

// Verifies the stored token/phone number still work by requesting the
// phone number's own metadata — cheap, read-only, good health check.
export async function checkConnectionHealth(phoneNumberId, accessToken) {
  const res = await fetch(`${BASE}/${phoneNumberId}?fields=display_phone_number,verified_name`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data?.error?.message || `WhatsApp health check failed (${res.status})`);
  }
  return res.json();
}
