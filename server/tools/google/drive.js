import { registerTool } from "../registry.js";
import * as drive from "../../integrations/google/drive/api.js";

registerTool({
  name: "drive.list_files",
  description: "Lists recent files in Google Drive, most recently modified first.",
  category: "drive",
  parameters: { type: "object", properties: { maxResults: { type: "number" } }, required: [] },
  requiredPermissions: ["drive.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const files = await drive.listFiles(context.userId, parameters);
    return { files };
  },
});

registerTool({
  name: "drive.search_files",
  description: "Searches Google Drive files by name.",
  category: "drive",
  parameters: { type: "object", properties: { query: { type: "string" }, maxResults: { type: "number" } }, required: ["query"] },
  requiredPermissions: ["drive.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const files = await drive.searchFiles(context.userId, parameters.query, parameters.maxResults || 20);
    return { files };
  },
});

registerTool({
  name: "drive.create_folder",
  description: "Creates a new folder in Google Drive.",
  category: "drive",
  parameters: { type: "object", properties: { name: { type: "string" }, parentId: { type: "string" } }, required: ["name"] },
  requiredPermissions: ["drive.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    return drive.createFolder(context.userId, parameters.name, parameters.parentId);
  },
});

registerTool({
  name: "drive.create_text_file",
  description: "Creates a new plain-text (or CSV) file in Google Drive with the given content.",
  category: "drive",
  parameters: {
    type: "object",
    properties: {
      name: { type: "string" },
      content: { type: "string" },
      mimeType: { type: "string", description: "Defaults to text/plain. Use text/csv for CSV content." },
      parentId: { type: "string" },
    },
    required: ["name", "content"],
  },
  requiredPermissions: ["drive.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    return drive.createTextFile(context.userId, parameters);
  },
});

registerTool({
  name: "drive.delete_file",
  description: "Permanently deletes a file from Google Drive. This cannot be undone.",
  category: "drive",
  parameters: { type: "object", properties: { fileId: { type: "string" } }, required: ["fileId"] },
  requiredPermissions: ["drive.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    return drive.deleteFile(context.userId, parameters.fileId);
  },
});

registerTool({
  name: "drive.share_file",
  description: "Shares a Google Drive file with another person by email.",
  category: "drive",
  parameters: {
    type: "object",
    properties: {
      fileId: { type: "string" },
      email: { type: "string" },
      role: { type: "string", description: "reader, commenter, or writer. Defaults to reader." },
    },
    required: ["fileId", "email"],
  },
  requiredPermissions: ["drive.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    return drive.shareFile(context.userId, parameters.fileId, parameters);
  },
});
