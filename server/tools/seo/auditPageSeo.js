import { registerTool } from "../registry.js";
import { assertSafeWebhookUrl } from "../../publicApi/ssrf.js";
import { auditPageSeo } from "./htmlAudit.js";

registerTool({
  name: "audit_page_seo",
  description: "Fetches a webpage and audits its on-page SEO: title, meta description, headings, canonical tag, robots directives, image alt text, and Open Graph tags. Returns a list of concrete issues found.",
  category: "seo",
  parameters: {
    type: "object",
    properties: { url: { type: "string" } },
    required: ["url"],
  },
  requiredPermissions: ["seo.read"],
  requiresConfirmation: false,
  async execute(parameters) {
    // The URL here is agent/user-supplied, same shape of risk as a
    // developer-configured webhook URL (our server makes an outbound
    // request to wherever it points) — reusing the same SSRF guard rather
    // than writing a second copy of the private-IP/localhost checks.
    await assertSafeWebhookUrl(parameters.url);
    return auditPageSeo(parameters.url);
  },
});
