import { registerTool } from "../registry.js";
import * as docs from "../../integrations/google/docs/api.js";

registerTool({
  name: "docs.create_doc",
  description: "Creates a new Google Doc with an optional initial body of text.",
  category: "docs",
  parameters: { type: "object", properties: { title: { type: "string" }, content: { type: "string" } }, required: ["title"] },
  requiredPermissions: ["docs.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    return docs.createDoc(context.userId, parameters);
  },
});

registerTool({
  name: "docs.read_doc",
  description: "Reads the full text content of a Google Doc.",
  category: "docs",
  parameters: { type: "object", properties: { documentId: { type: "string" } }, required: ["documentId"] },
  requiredPermissions: ["docs.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    return docs.readDoc(context.userId, parameters.documentId);
  },
});

registerTool({
  name: "docs.append_text",
  description: "Appends text to the end of an existing Google Doc.",
  category: "docs",
  parameters: { type: "object", properties: { documentId: { type: "string" }, text: { type: "string" } }, required: ["documentId", "text"] },
  requiredPermissions: ["docs.write"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    return docs.appendText(context.userId, parameters.documentId, parameters.text);
  },
});
