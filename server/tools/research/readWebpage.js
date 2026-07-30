import { registerTool } from "../registry.js";
import { readWebpage } from "./htmlExtract.js";

registerTool({
  name: "read_webpage",
  description: "Reads a webpage (typically from a web_search result) and returns its title, headings, and main text content.",
  category: "research",
  parameters: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
  requiredPermissions: ["research.read"],
  requiresConfirmation: false,
  async execute(parameters) {
    return readWebpage(parameters.url);
  },
});
