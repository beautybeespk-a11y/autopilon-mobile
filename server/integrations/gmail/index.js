import { defineIntegration } from "../sdk/index.js";
import { checkConnection } from "./api.js";

defineIntegration({
  id: "gmail",
  name: "Gmail",
  category: "email",
  authType: "oauth2",
  requiredScopes: ["gmail.readonly", "gmail.send", "gmail.modify"],
  permissions: {
    "gmail.read": "Read, search, and summarize emails",
    "gmail.send": "Send emails and replies (always requires your approval before sending)",
  },
  tools: [
    { name: "gmail.list_emails" }, { name: "gmail.search_emails" }, { name: "gmail.read_email" },
    { name: "gmail.draft_reply" }, { name: "gmail.send_email" }, { name: "gmail.archive_email" },
    { name: "gmail.star_email" }, { name: "gmail.trash_email" },
  ],
  triggers: ["new_gmail_email"],
  async healthCheck(userId) {
    try {
      const profile = await checkConnection(userId);
      return { connected: true, details: profile };
    } catch (err) {
      return { connected: false, reason: err.code === "INTEGRATION_NOT_CONNECTED" ? "Not connected" : err.message };
    }
  },
});
