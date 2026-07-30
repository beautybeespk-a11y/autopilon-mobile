import { getValidAccessToken } from "../tokenHelper.js";

const BASE = "https://www.googleapis.com/calendar/v3";

async function calendarFetch(userId, path, { method = "GET", body } = {}) {
  const accessToken = await getValidAccessToken(userId, "google_calendar", "Google Calendar");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Google Calendar API error ${res.status}`);
    err.code = res.status;
    throw err;
  }
  return data;
}

export async function checkConnection(userId) {
  const cal = await calendarFetch(userId, "/calendars/primary");
  return { calendar: cal.summary, timeZone: cal.timeZone };
}

export async function listCalendars(userId) {
  const data = await calendarFetch(userId, "/users/me/calendarList");
  return (data.items || []).map((c) => ({ id: c.id, summary: c.summary, primary: Boolean(c.primary) }));
}

export async function listEvents(userId, { calendarId = "primary", timeMin, timeMax, maxResults = 10, query } = {}) {
  const params = new URLSearchParams({
    maxResults: String(maxResults),
    singleEvents: "true",
    orderBy: "startTime",
    timeMin: timeMin || new Date().toISOString(),
  });
  if (timeMax) params.set("timeMax", timeMax);
  if (query) params.set("q", query);
  const data = await calendarFetch(userId, `/calendars/${encodeURIComponent(calendarId)}/events?${params}`);
  return (data.items || []).map(formatEvent);
}

function formatEvent(e) {
  return {
    id: e.id,
    summary: e.summary,
    description: e.description || "",
    location: e.location || "",
    start: e.start?.dateTime || e.start?.date,
    end: e.end?.dateTime || e.end?.date,
    attendees: (e.attendees || []).map((a) => a.email),
    htmlLink: e.htmlLink,
  };
}

export async function createEvent(userId, { calendarId = "primary", summary, description, location, start, end, attendees }) {
  const body = {
    summary,
    description,
    location,
    start: { dateTime: start },
    end: { dateTime: end },
    attendees: (attendees || []).map((email) => ({ email })),
  };
  const data = await calendarFetch(userId, `/calendars/${encodeURIComponent(calendarId)}/events`, { method: "POST", body });
  return formatEvent(data);
}

export async function updateEvent(userId, { calendarId = "primary", eventId, ...fields }) {
  const body = {};
  if (fields.summary !== undefined) body.summary = fields.summary;
  if (fields.description !== undefined) body.description = fields.description;
  if (fields.location !== undefined) body.location = fields.location;
  if (fields.start !== undefined) body.start = { dateTime: fields.start };
  if (fields.end !== undefined) body.end = { dateTime: fields.end };
  const data = await calendarFetch(userId, `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, { method: "PATCH", body });
  return formatEvent(data);
}

export async function deleteEvent(userId, { calendarId = "primary", eventId }) {
  await calendarFetch(userId, `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, { method: "DELETE" });
  return { eventId, deleted: true };
}
