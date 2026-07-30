import { getValidAccessToken } from "../tokenHelper.js";

const BASE = "https://sheets.googleapis.com/v4/spreadsheets";
const DRIVE_BASE = "https://www.googleapis.com/drive/v3";

async function sheetsFetch(userId, path, { method = "GET", body } = {}) {
  const accessToken = await getValidAccessToken(userId, "google_sheets", "Google Sheets");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Google Sheets API error ${res.status}`);
    err.code = res.status;
    throw err;
  }
  return data;
}

export async function checkConnection(userId) {
  const accessToken = await getValidAccessToken(userId, "google_sheets", "Google Sheets");
  const res = await fetch(`${DRIVE_BASE}/about?fields=user`, { headers: { authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Google API error ${res.status}`);
    err.code = res.status;
    throw err;
  }
  return { user: data.user?.emailAddress };
}

export async function createSpreadsheet(userId, title, sheetNames) {
  const body = {
    properties: { title },
    sheets: (sheetNames || ["Sheet1"]).map((name) => ({ properties: { title: name } })),
  };
  const data = await sheetsFetch(userId, "", { method: "POST", body });
  return {
    spreadsheetId: data.spreadsheetId,
    title: data.properties?.title,
    url: data.spreadsheetUrl,
    sheets: (data.sheets || []).map((s) => s.properties?.title),
  };
}

export async function listSheetTabs(userId, spreadsheetId) {
  const data = await sheetsFetch(userId, `/${spreadsheetId}?fields=properties.title,sheets.properties`);
  return {
    title: data.properties?.title,
    sheets: (data.sheets || []).map((s) => ({ sheetId: s.properties?.sheetId, title: s.properties?.title })),
  };
}

export async function readRange(userId, spreadsheetId, range) {
  const data = await sheetsFetch(userId, `/${spreadsheetId}/values/${encodeURIComponent(range)}`);
  return { range: data.range, values: data.values || [] };
}

export async function writeRange(userId, spreadsheetId, range, values) {
  const data = await sheetsFetch(
    userId,
    `/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    { method: "PUT", body: { range, values } }
  );
  return { range: data.updatedRange, updatedCells: data.updatedCells };
}

export async function appendRow(userId, spreadsheetId, range, values) {
  const data = await sheetsFetch(
    userId,
    `/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    { method: "POST", body: { values: [values] } }
  );
  return { updatedRange: data.updates?.updatedRange, updatedCells: data.updates?.updatedCells };
}
