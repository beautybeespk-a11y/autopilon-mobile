import { registerTool } from "../registry.js";
import * as calendar from "../../integrations/google/calendar/api.js";

registerTool({
  name: "calendar.list_events",
  description: "Lists upcoming calendar events, optionally within a date range or matching a search query.",
  category: "calendar",
  parameters: {
    type: "object",
    properties: {
      timeMin: { type: "string", description: "ISO datetime to start from. Defaults to now." },
      timeMax: { type: "string", description: "ISO datetime to stop at." },
      maxResults: { type: "number" },
      query: { type: "string" },
    },
    required: [],
  },
  requiredPermissions: ["calendar.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const events = await calendar.listEvents(context.userId, parameters);
    return { events };
  },
});

registerTool({
  name: "calendar.list_calendars",
  description: "Lists the calendars available on the connected Google account.",
  category: "calendar",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["calendar.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const calendars = await calendar.listCalendars(context.userId);
    return { calendars };
  },
});

registerTool({
  name: "calendar.create_event",
  description: "Creates a new calendar event. start/end must be ISO 8601 datetimes (e.g. 2026-08-01T14:00:00-07:00).",
  category: "calendar",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string" },
      description: { type: "string" },
      location: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      attendees: { type: "array", items: { type: "string" }, description: "Attendee email addresses" },
    },
    required: ["summary", "start", "end"],
  },
  requiredPermissions: ["calendar.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    return calendar.createEvent(context.userId, parameters);
  },
});

registerTool({
  name: "calendar.update_event",
  description: "Updates an existing calendar event's fields. Only pass the fields you want changed.",
  category: "calendar",
  parameters: {
    type: "object",
    properties: {
      eventId: { type: "string" },
      summary: { type: "string" },
      description: { type: "string" },
      location: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
    },
    required: ["eventId"],
  },
  requiredPermissions: ["calendar.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    return calendar.updateEvent(context.userId, parameters);
  },
});

registerTool({
  name: "calendar.delete_event",
  description: "Deletes a calendar event. This cannot be undone.",
  category: "calendar",
  parameters: { type: "object", properties: { eventId: { type: "string" } }, required: ["eventId"] },
  requiredPermissions: ["calendar.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    return calendar.deleteEvent(context.userId, parameters);
  },
});
