// Integration service for the Public API (Phase 17 §13, extended Phase
// 17.1 §2). listOrgIntegrations() remains read-only and unchanged; this
// file additionally exposes a CURATED, explicitly-approved subset of the
// existing Tool Registry (tools/registry.js) as Public API actions — never
// an arbitrary passthrough to an integration's underlying API, and never
// the full internal tool list. Every action listed in
// PUBLIC_INTEGRATION_ACTIONS below already exists as a real, working,
// already-tested Tool used by the internal agent chat pipeline; this file
// adds no new integration logic of its own, only a gate in front of it.
import db from "../db.js";
import { getTool } from "../tools/registry.js";
import { runTool } from "./executor.js";
import { getConnection, getOrgConnection } from "../integrations/manager.js";

// provider -> the exact tool names publicly reachable through the Public
// API for that provider. Adding an action here is a deliberate, one-line
// decision — nothing is exposed just because it happens to be registered
// in the Tool Registry. Deliberately conservative for this first pass:
// mostly reads, plus the handful of writes that already carry their own
// requiresConfirmation gate (gmail.send_email, wordpress.create_post) so a
// Public API caller gets the exact same "goes to awaiting_confirmation,
// a human approves it in the app" safety net an agent's own tool call would.
export const PUBLIC_INTEGRATION_ACTIONS = {
  gmail: ["gmail.list_emails", "gmail.search_emails", "gmail.read_email", "gmail.send_email"],
  shopify: ["shopify.list_products", "shopify.get_product", "shopify.list_orders", "shopify.get_order"],
  wordpress: ["wordpress.list_posts", "wordpress.create_post"],
  woocommerce: ["woocommerce.list_products", "woocommerce.list_orders"],
  whatsapp: ["list_whatsapp_conversations", "get_whatsapp_conversation", "send_whatsapp_message"],
};

export function listOrgIntegrations(orgId) {
  return db.prepare("SELECT provider, status, createdAt FROM integrations WHERE orgId = ? ORDER BY provider ASC").all(orgId);
}

function toPublicActionShape(tool) {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    requiresConfirmation: Boolean(tool.requiresConfirmation),
  };
}

// Lists the approved public actions for a provider, but only if the ORG
// itself has that provider connected — an unconnected (or unrecognized)
// provider returns null so the route can 404 without confirming whether
// the provider name is even valid, same "don't leak existence" discipline
// as every other Public API resource this phase.
export function listPublicActionsForProvider(orgId, provider) {
  const names = PUBLIC_INTEGRATION_ACTIONS[provider];
  if (!names) return null;
  const conn = getOrgConnection(orgId, provider);
  if (!conn || conn.status !== "connected") return null;
  return names.map((name) => toPublicActionShape(getTool(name))).filter(Boolean);
}

// Thrown with .code set — every caller maps these through
// apiErrorFromException() exactly like every other Public API service.
function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

// Executes one approved integration action on behalf of an organization's
// API key. This is the one function in this whole phase that has to bridge
// two systems that were never designed with API keys in mind: the Tool
// Registry's execution path (runTool) resolves an integration's credentials
// via getConnection(userId, provider), which follows the CALLING USER's
// own users.activeOrgId — not req.orgId. That's the right behavior for a
// human using the web app (switch org, your tools follow you), but it is
// NOT automatically safe for a machine API key: if the key creator's
// currently-active org in the browser differs from the org this key
// belongs to, letting the tool run unchecked could execute against the
// WRONG organization's connected mailbox/store/site — the exact class of
// cross-tenant bug this whole phase has been built to prevent everywhere
// else. So this function verifies, explicitly, BEFORE calling runTool(),
// that the connection the tool is actually about to use is this org's own
// connection — never trusting the delegated resolution blindly.
export function executeIntegrationAction(orgId, apiKeyId, apiKeyUserId, provider, actionName, { agentId, parameters } = {}) {
  const names = PUBLIC_INTEGRATION_ACTIONS[provider];
  if (!names || !names.includes(actionName)) fail("NOT_FOUND", "That integration action is not publicly available.");

  const orgConn = getOrgConnection(orgId, provider);
  if (!orgConn || orgConn.status !== "connected") fail("NOT_FOUND", `This organization has no connected "${provider}" integration.`);

  if (!agentId) fail("INVALID", "agentId is required — integration actions run through an agent with the matching skill enabled, same as the internal chat pipeline.");
  const agent = db.prepare("SELECT id FROM agents WHERE id = ? AND orgId = ?").get(agentId, orgId);
  if (!agent) fail("NOT_FOUND", "The requested agent was not found in this organization.");

  // The safety check described above: what the tool will actually resolve
  // for this specific user, right now, must be the SAME row as this org's
  // own connection — not a different org's, not the user's personal one.
  const resolvedForCaller = getConnection(apiKeyUserId, provider);
  if (!resolvedForCaller || resolvedForCaller.id !== orgConn.id) {
    fail(
      "INTEGRATION_CONTEXT_MISMATCH",
      `This API key's creator must have "${orgId}" set as their active organization (with integrations permission) in the web app before this action can run — the platform resolves integration credentials by the calling user's currently-active organization, and right now that does not match this organization's connection. Switch to this organization in the web app, then retry.`
    );
  }

  return runTool({ toolName: actionName, parameters: parameters || {}, userId: apiKeyUserId, agentId, conversationId: null });
}
