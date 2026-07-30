import { registerTool } from "../registry.js";
import { requireValidToken } from "../../integrations/manager.js";
import * as meta from "../../integrations/meta/api.js";
import { publishEvent } from "../../automation/triggers.js";

function token(context) {
  // Every Meta tool needs a live connection; this throws a clear, tool-level
  // error (caught by the executor) rather than a crash if not connected.
  return requireValidToken(context.userId, "meta_ads");
}

registerTool({
  name: "list_ad_accounts",
  description: "Lists the Meta ad accounts the connected user has access to.",
  category: "meta_ads",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["meta.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const accounts = await meta.listAdAccounts(token(context));
    return { accounts };
  },
});

registerTool({
  name: "list_campaigns",
  description: "Lists campaigns in a given Meta ad account. Accepts the account ID with or without the 'act_' prefix.",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: { adAccountId: { type: "string" } },
    required: ["adAccountId"],
  },
  requiredPermissions: ["meta.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const campaigns = await meta.listCampaigns(token(context), parameters.adAccountId);
    return { campaigns };
  },
});

registerTool({
  name: "create_campaign",
  description: "Creates a new Meta ad campaign (created PAUSED so nothing spends until manually resumed).",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: {
      adAccountId: { type: "string" },
      name: { type: "string" },
      objective: { type: "string" }, // e.g. OUTCOME_TRAFFIC, OUTCOME_ENGAGEMENT
      dailyBudget: { type: "number" }, // in the account's smallest currency unit (e.g. cents)
    },
    required: ["adAccountId", "name", "objective"],
  },
  requiredPermissions: ["meta.write"],
  requiresConfirmation: true, // Creating a campaign involves a budget — always confirm first.
  async execute(parameters, context) {
    const result = await meta.createCampaign(token(context), parameters.adAccountId, {
      name: parameters.name,
      objective: parameters.objective,
      dailyBudget: parameters.dailyBudget,
      status: "PAUSED",
    });
    // Meta doesn't push ad-account change webhooks to this app — this event
    // is published because OUR OWN tool call just succeeded, not because of
    // an incoming Meta callback. Documented as such in PHASE6.5_NOTES.md.
    publishEvent(context.userId, "meta_ads", "meta_ads_event", { eventSubtype: "campaign_created", campaignId: result.id, name: parameters.name });
    return { campaignId: result.id, name: parameters.name, status: "PAUSED" };
  },
});

registerTool({
  name: "update_campaign",
  description: "Updates fields on an existing Meta campaign (name, budget, etc).",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: {
      campaignId: { type: "string" },
      name: { type: "string" },
      dailyBudget: { type: "number" },
    },
    required: ["campaignId"],
  },
  requiredPermissions: ["meta.write"],
  requiresConfirmation: true, // Edits a live campaign's budget/config — confirm first.
  async execute(parameters, context) {
    const fields = {};
    if (parameters.name) fields.name = parameters.name;
    if (parameters.dailyBudget) fields.daily_budget = parameters.dailyBudget;
    await meta.updateCampaign(token(context), parameters.campaignId, fields);
    publishEvent(context.userId, "meta_ads", "meta_ads_event", { eventSubtype: "campaign_updated", campaignId: parameters.campaignId, updated: fields });
    return { campaignId: parameters.campaignId, updated: fields };
  },
});

registerTool({
  name: "pause_campaign",
  description: "Pauses a running Meta campaign, stopping spend.",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: { campaignId: { type: "string" } },
    required: ["campaignId"],
  },
  requiredPermissions: ["meta.manage"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    await meta.setCampaignStatus(token(context), parameters.campaignId, "PAUSED");
    publishEvent(context.userId, "meta_ads", "meta_ads_event", { eventSubtype: "campaign_paused", campaignId: parameters.campaignId });
    return { campaignId: parameters.campaignId, status: "PAUSED" };
  },
});

registerTool({
  name: "resume_campaign",
  description: "Resumes a paused Meta campaign, allowing it to spend budget again.",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: { campaignId: { type: "string" } },
    required: ["campaignId"],
  },
  requiredPermissions: ["meta.manage"],
  requiresConfirmation: true, // Resuming re-enables real ad spend — always confirm.
  async execute(parameters, context) {
    await meta.setCampaignStatus(token(context), parameters.campaignId, "ACTIVE");
    publishEvent(context.userId, "meta_ads", "meta_ads_event", { eventSubtype: "campaign_resumed", campaignId: parameters.campaignId });
    return { campaignId: parameters.campaignId, status: "ACTIVE" };
  },
});

registerTool({
  name: "get_campaign_insights",
  description: "Returns performance insights (impressions, clicks, spend, CTR, CPC, reach) for a campaign.",
  category: "meta_ads",
  parameters: {
    type: "object",
    properties: {
      campaignId: { type: "string" },
      datePreset: { type: "string" }, // e.g. last_7d, last_30d
    },
    required: ["campaignId"],
  },
  requiredPermissions: ["meta.read"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const insights = await meta.getCampaignInsights(token(context), parameters.campaignId, parameters.datePreset || "last_30d");
    return { campaignId: parameters.campaignId, insights };
  },
});
