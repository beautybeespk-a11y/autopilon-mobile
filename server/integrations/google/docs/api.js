import { getValidAccessToken } from "../tokenHelper.js";

const BASE = "https://docs.googleapis.com/v1/documents";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

async function docsFetch(userId, path, { method = "GET", body } = {}) {
  const accessToken = await getValidAccessToken(userId, "google_docs", "Google Docs");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Google Docs API error ${res.status}`);
    err.code = res.status;
    throw err;
  }
  return data;
}

export async function checkConnection(userId) {
  // Docs API has no lightweight "who am I" endpoint — use Drive's About,
  // which shares the same access token since documents.create needs
  // drive.file-adjacent scope anyway for the resulting file to be listable.
  const accessToken = await getValidAccessToken(userId, "google_docs", "Google Docs");
  const res = await fetch(`${DRIVE_BASE}/about?fields=user`, { headers: { authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Google API error ${res.status}`);
    err.code = res.status;
    throw err;
  }
  return { user: data.user?.emailAddress };
}

function extractText(doc) {
  const content = doc.body?.content || [];
  let text = "";
  for (const el of content) {
    for (const run of el.paragraph?.elements || []) {
      text += run.textRun?.content || "";
    }
  }
  return text;
}

export async function createDoc(userId, { title, content }) {
  const doc = await docsFetch(userId, "", { method: "POST", body: { title } });
  if (content) {
    await docsFetch(userId, `/${doc.documentId}:batchUpdate`, {
      method: "POST",
      body: { requests: [{ insertText: { location: { index: 1 }, text: content } }] },
    });
  }
  return { documentId: doc.documentId, title: doc.title, url: `https://docs.google.com/document/d/${doc.documentId}/edit` };
}

export async function readDoc(userId, documentId) {
  const doc = await docsFetch(userId, `/${documentId}`);
  return { documentId, title: doc.title, content: extractText(doc) };
}

export async function appendText(userId, documentId, text) {
  const doc = await docsFetch(userId, `/${documentId}`);
  const endIndex = (doc.body?.content || []).reduce((max, el) => Math.max(max, el.endIndex || 0), 1);
  await docsFetch(userId, `/${documentId}:batchUpdate`, {
    method: "POST",
    body: { requests: [{ insertText: { location: { index: Math.max(endIndex - 1, 1) }, text } }] },
  });
  return { documentId, appended: true };
}
