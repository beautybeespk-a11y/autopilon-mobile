import { registerTool } from "../registry.js";
import { performWebSearch } from "./providers/index.js";

registerTool({
  name: "web_search",
  description: "Searches the web for current information and returns a list of results with titles, URLs, and snippets.",
  category: "research",
  parameters: {
    type: "object",
    properties: { query: { type: "string" } },
    required: ["query"],
  },
  requiredPermissions: ["research.read"],
  requiresConfirmation: false,
  async execute(parameters) {
    const results = await performWebSearch(parameters.query);
    return { query: parameters.query, results };
  },
});
