import { defineIntegration } from "../../sdk/index.js";
import { checkConnection } from "./api.js";

defineIntegration({
  id: "google_sheets",
  name: "Google Sheets",
  category: "productivity",
  authType: "oauth2",
  requiredScopes: ["spreadsheets"],
  permissions: {
    "sheets.read": "Read data from your spreadsheets",
    "sheets.write": "Create spreadsheets and write/append data",
  },
  tools: [
    { name: "sheets.create_spreadsheet" }, { name: "sheets.list_tabs" },
    { name: "sheets.read_range" }, { name: "sheets.write_range" }, { name: "sheets.append_row" },
  ],
  triggers: [],
  async healthCheck(userId) {
    try {
      const info = await checkConnection(userId);
      return { connected: true, details: info };
    } catch (err) {
      return { connected: false, reason: err.code === "INTEGRATION_NOT_CONNECTED" ? "Not connected" : err.message };
    }
  },
});
