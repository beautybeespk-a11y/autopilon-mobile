import { getValidAccessToken } from "../tokenHelper.js";

const BASE = "https://www.googleapis.com/drive/v3";
const UPLOAD_BASE = "https://www.googleapis.com/upload/drive/v3/files";

async function driveFetch(userId, path, { method = "GET", body } = {}) {
  const accessToken = await getValidAccessToken(userId, "google_drive", "Google Drive");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Google Drive API error ${res.status}`);
    err.code = res.status;
    throw err;
  }
  return data;
}

export async function checkConnection(userId) {
  const about = await driveFetch(userId, "/about?fields=user,storageQuota");
  return { user: about.user?.emailAddress, storageQuota: about.storageQuota };
}

function formatFile(f) {
  return { id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, webViewLink: f.webViewLink, size: f.size };
}

export async function listFiles(userId, { maxResults = 20 } = {}) {
  const params = new URLSearchParams({
    pageSize: String(maxResults),
    fields: "files(id,name,mimeType,modifiedTime,webViewLink,size)",
    orderBy: "modifiedTime desc",
  });
  const data = await driveFetch(userId, `/files?${params}`);
  return (data.files || []).map(formatFile);
}

export async function searchFiles(userId, query, maxResults = 20) {
  const params = new URLSearchParams({
    pageSize: String(maxResults),
    q: `name contains '${query.replace(/'/g, "\\'")}' and trashed = false`,
    fields: "files(id,name,mimeType,modifiedTime,webViewLink,size)",
  });
  const data = await driveFetch(userId, `/files?${params}`);
  return (data.files || []).map(formatFile);
}

export async function createFolder(userId, name, parentId) {
  const body = { name, mimeType: "application/vnd.google-apps.folder", parents: parentId ? [parentId] : undefined };
  const data = await driveFetch(userId, "/files?fields=id,name,mimeType,webViewLink", { method: "POST", body });
  return formatFile(data);
}

// Simple upload for text content (notes, CSV exports, etc.) — multipart isn't
// needed since we're always sending plain text/CSV rather than binary blobs.
export async function createTextFile(userId, { name, content = "", mimeType = "text/plain", parentId }) {
  const accessToken = await getValidAccessToken(userId, "google_drive", "Google Drive");
  const metadata = { name, mimeType, parents: parentId ? [parentId] : undefined };
  const boundary = "gdrive_boundary_" + Date.now();
  const body =
    `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n${content}\r\n` +
    `--${boundary}--`;
  const res = await fetch(`${UPLOAD_BASE}?uploadType=multipart&fields=id,name,mimeType,webViewLink`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": `multipart/related; boundary=${boundary}` },
    body,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Google Drive upload error ${res.status}`);
    err.code = res.status;
    throw err;
  }
  return formatFile(data);
}

export async function deleteFile(userId, fileId) {
  await driveFetch(userId, `/files/${fileId}`, { method: "DELETE" });
  return { fileId, deleted: true };
}

export async function shareFile(userId, fileId, { email, role = "reader" }) {
  const body = { type: "user", role, emailAddress: email };
  await driveFetch(userId, `/files/${fileId}/permissions?sendNotificationEmail=false`, { method: "POST", body });
  return { fileId, sharedWith: email, role };
}
