import { registerTool } from "../registry.js";
import { assertSafeWebhookUrl } from "../../publicApi/ssrf.js";
import { checkPageSpeed } from "./pageSpeed.js";

registerTool({
  name: "check_page_speed",
  description: "Checks a webpage's Core Web Vitals and Lighthouse scores (performance, SEO, accessibility, best practices) via Google PageSpeed Insights. Takes 15-40 seconds to run.",
  category: "seo",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
      strategy: { type: "string", enum: ["mobile", "desktop"] },
    },
    required: ["url"],
  },
  requiredPermissions: ["seo.read"],
  requiresConfirmation: false,
  async execute(parameters) {
    await assertSafeWebhookUrl(parameters.url);
    return checkPageSpeed(parameters.url, { strategy: parameters.strategy });
  },
});
