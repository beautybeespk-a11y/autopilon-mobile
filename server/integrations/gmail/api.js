import { getConnection, saveConnection } from "../manager.js";
import { refreshAccessToken } from "./oauth.js";
import db from "../../db.js";
import { logActivity } from "../../middleware.js";

const BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

// Centralizes "is the token expired, refresh if so, persist the new one" —
// every Gmail tool calls through here rather than each managing refresh
// itself. Google's refresh tokens are long-lived, so this is the one place
// that logic needs to exist.
async function getValidAccessToken(userId) {
  const conn = getConnection(userId, "gmail");
  if (!conn || conn.status !== "connected") {
    const err = new Error("Gmail is not connected. Connect it first in Integrations.");
    err.code = "INTEGRATION_NOT_CONNECTED";
    throw err;
  }
  const expired = conn.tokenExpiresAt && new Date(conn.tokenExpiresAt) < new Date(Date.now() + 60_000); // refresh a minute early
  if (!expired) return conn.accessToken;

  const refreshed = await refreshAccessToken(conn.refreshToken);
  // Phase 18.2 §7: the await above is a real network round-trip — the
  // user can disconnect Gmail while it's in flight. Re-check the
  // connection is STILL connected before persisting the refreshed token;
  // without this, saveConnection()'s upsert would silently resurrect a
  // connection the user just disconnected, complete with a still-valid
  // refresh token they believed was gone. If it's gone now, the refreshed
  // access token is simply discarded (never persisted, never returned) —
  // it was correctly obtained but is no longer wanted.
  const stillConnected = getConnection(userId, "gmail");
  if (!stillConnected || stillConnected.status !== "connected") {
    const err = new Error("Gmail is not connected. Connect it first in Integrations.");
    err.code = "INTEGRATION_NOT_CONNECTED";
    throw err;
  }
  const meta = JSON.parse(conn.meta || "{}");
  saveConnection(userId, "gmail", {
    accessToken: refreshed.accessToken,
    refreshToken: conn.refreshToken, // Google doesn't reissue this on refresh — keep the original
    expiresAt: refreshed.expiresAt,
    scopes: JSON.parse(conn.scopes || "[]"),
    meta,
  });
  logActivity(db, userId, "integration_refreshed", "Refreshed Gmail access token"); // Phase 18.2 §11 — never logs a token value
  return refreshed.accessToken;
}

async function gmailFetch(userId, path, { method = "GET", body } = {}) {
  const accessToken = await getValidAccessToken(userId);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Gmail API error ${res.status}`);
    err.code = res.status;
    throw err;
  }
  return data;
}

export async function checkConnection(userId) {
  const profile = await gmailFetch(userId, "/profile");
  return { emailAddress: profile.emailAddress, messagesTotal: profile.messagesTotal };
}

export async function listMessages(userId, { query, maxResults = 10 } = {}) {
  const params = new URLSearchParams({ maxResults: String(maxResults) });
  if (query) params.set("q", query);
  const data = await gmailFetch(userId, `/messages?${params}`);
  return data.messages || [];
}

function extractPlainText(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) {
    return Buffer.from(payload.body.data, "base64").toString("utf-8");
  }
  for (const part of payload.parts || []) {
    const text = extractPlainText(part);
    if (text) return text;
  }
  return "";
}

function headerValue(headers, name) {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
}

export async function getMessage(userId, messageId) {
  const data = await gmailFetch(userId, `/messages/${messageId}?format=full`);
  const headers = data.payload?.headers || [];
  return {
    id: data.id,
    threadId: data.threadId,
    from: headerValue(headers, "From"),
    to: headerValue(headers, "To"),
    subject: headerValue(headers, "Subject"),
    date: headerValue(headers, "Date"),
    snippet: data.snippet,
    body: extractPlainText(data.payload) || data.snippet,
    labelIds: data.labelIds || [],
  };
}

export async function searchMessages(userId, query, maxResults = 10) {
  const messages = await listMessages(userId, { query, maxResults });
  // Fetching full detail for every result is expensive — return snippets
  // from a lighter fetch when just searching/summarizing, full body only
  // when the user asks to read one specific message via getMessage().
  const details = await Promise.all(
    messages.slice(0, maxResults).map((m) => gmailFetch(userId, `/messages/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`))
  );
  return details.map((d) => ({
    id: d.id,
    from: headerValue(d.payload?.headers, "From"),
    subject: headerValue(d.payload?.headers, "Subject"),
    date: headerValue(d.payload?.headers, "Date"),
    snippet: d.snippet,
  }));
}

function buildRawMessage({ to, subject, body, inReplyTo }) {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${inReplyTo}`] : []),
    "",
    body,
  ];
  const raw = Buffer.from(lines.join("\r\n")).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return raw;
}

export async function sendMessage(userId, { to, subject, body, threadId, inReplyTo }) {
  const raw = buildRawMessage({ to, subject, body, inReplyTo });
  return gmailFetch(userId, "/messages/send", { method: "POST", body: { raw, threadId } });
}

export async function modifyLabels(userId, messageId, { addLabelIds = [], removeLabelIds = [] }) {
  return gmailFetch(userId, `/messages/${messageId}/modify`, { method: "POST", body: { addLabelIds, removeLabelIds } });
}

export const trashMessage = (userId, messageId) => gmailFetch(userId, `/messages/${messageId}/trash`, { method: "POST" });
export const archiveMessage = (userId, messageId) => modifyLabels(userId, messageId, { removeLabelIds: ["INBOX"] });
export const starMessage = (userId, messageId) => modifyLabels(userId, messageId, { addLabelIds: ["STARRED"] });
export const listLabels = async (userId) => (await gmailFetch(userId, "/labels")).labels || [];
