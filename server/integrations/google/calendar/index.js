import { defineIntegration } from "../../sdk/index.js";
import { checkConnection } from "./api.js";

defineIntegration({
  id: "google_calendar",
  name: "Google Calendar",
  category: "productivity",
  authType: "oauth2",
  requiredScopes: ["calendar"],
  permissions: {
    "calendar.read": "Read your calendars and events",
    "calendar.write": "Create, update, and delete calendar events",
  },
  tools: [
    { name: "calendar.list_events" }, { name: "calendar.list_calendars" },
    { name: "calendar.create_event" }, { name: "calendar.update_event" }, { name: "calendar.delete_event" },
  ],
  triggers: ["new_calendar_event"],
  async healthCheck(userId) {
    try {
      const info = await checkConnection(userId);
      return { connected: true, details: info };
    } catch (err) {
      return { connected: false, reason: err.code === "INTEGRATION_NOT_CONNECTED" ? "Not connected" : err.message };
    }
  },
});
