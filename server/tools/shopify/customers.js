import { registerTool } from "../registry.js";
import { requireValidToken, getConnection } from "../../integrations/manager.js";
import * as shopify from "../../integrations/shopify/api.js";

function shopCreds(userId) {
  const token = requireValidToken(userId, "shopify");
  const conn = getConnection(userId, "shopify");
  const meta = JSON.parse(conn.meta || "{}");
  return { shop: meta.shopDomain, token };
}

registerTool({
  name: "shopify.list_customers",
  description: "Lists customers in the Shopify store.",
  category: "shopify",
  parameters: { type: "object", properties: { limit: { type: "number" } }, required: [] },
  requiredPermissions: ["shopify.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    const customers = await shopify.listCustomers(shop, token, { limit: parameters.limit || 20 });
    return { customers };
  },
});

registerTool({
  name: "shopify.get_customer",
  description: "Gets details of a specific customer, or searches by email/name.",
  category: "shopify",
  parameters: { type: "object", properties: { customerId: { type: "string" }, query: { type: "string" } }, required: [] },
  requiredPermissions: ["shopify.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    if (parameters.customerId) return shopify.getCustomer(shop, token, parameters.customerId);
    if (parameters.query) return { customers: await shopify.searchCustomers(shop, token, parameters.query) };
    throw new Error("Provide either customerId or query.");
  },
});

registerTool({
  name: "shopify.create_customer",
  description: "Creates a new customer record.",
  category: "shopify",
  parameters: {
    type: "object",
    properties: { firstName: { type: "string" }, lastName: { type: "string" }, email: { type: "string" }, phone: { type: "string" } },
    required: ["email"],
  },
  requiredPermissions: ["shopify.manage"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const { shop, token } = shopCreds(context.userId);
    return shopify.createCustomer(shop, token, { first_name: parameters.firstName, last_name: parameters.lastName, email: parameters.email, phone: parameters.phone });
  },
});
