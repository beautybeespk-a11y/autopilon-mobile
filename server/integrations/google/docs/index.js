import { defineIntegration } from "../../sdk/index.js";
import { checkConnection } from "./api.js";

defineIntegration({
  id: "google_docs",
  name: "Google Docs",
  category: "productivity",
  authType: "oauth2",
  requiredScopes: ["documents"],
  permissions: {
    "docs.read": "Read the content of your Google Docs",
    "docs.write": "Create new docs and edit their content",
  },
  tools: [{ name: "docs.create_doc" }, { name: "docs.read_doc" }, { name: "docs.append_text" }],
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
