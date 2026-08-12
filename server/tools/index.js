// Importing these runs their registerTool() calls as a side effect.
// Adding a new tool in Phase 3+ means: write the file, import it here.
import "./tasks.js";
import "./memory.js";
import "./research/webSearch.js";
import "./research/readWebpage.js";
import "./research/generateReport.js";
import "./research/knowledge.js";
import "./meta/campaigns.js";
import "./whatsapp/messaging.js";
import "./automation/draftWorkflow.js";
import "./wordpress/content.js";
import "./woocommerce/commerce.js";
import "./gmail/email.js";
import "./google/calendar.js";
import "./google/drive.js";
import "./google/docs.js";
import "./google/sheets.js";
import "./shopify/products.js";
import "./shopify/orders.js";
import "./shopify/customers.js";
import "./shopify/inventory.js";
import "./shopify/discounts.js";
import "./shopify/collections.js";
import "./shopify/analytics.js";
import "./shopify/webhooks.js";
import "./agentCollaboration.js";
import "./files.js";
import "./content.js";

export { listTools, listToolsForSkills, getTool } from "./registry.js";
