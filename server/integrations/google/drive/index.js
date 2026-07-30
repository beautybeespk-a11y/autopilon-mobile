import { defineIntegration } from "../../sdk/index.js";
import { checkConnection } from "./api.js";

defineIntegration({
  id: "google_drive",
  name: "Google Drive",
  category: "productivity",
  authType: "oauth2",
  requiredScopes: ["drive"],
  permissions: {
    "drive.read": "List and search your Drive files",
    "drive.write": "Create, delete, and share Drive files/folders",
  },
  tools: [
    { name: "drive.list_files" }, { name: "drive.search_files" }, { name: "drive.create_folder" },
    { name: "drive.create_text_file" }, { name: "drive.delete_file" }, { name: "drive.share_file" },
  ],
  triggers: ["new_drive_file"],
  async healthCheck(userId) {
    try {
      const info = await checkConnection(userId);
      return { connected: true, details: info };
    } catch (err) {
      return { connected: false, reason: err.code === "INTEGRATION_NOT_CONNECTED" ? "Not connected" : err.message };
    }
  },
});
