// Universal Integration SDK. Every integration — existing (Meta, WhatsApp)
// or new (WordPress, WooCommerce, Gmail, ...) — is described the same way:
// a definition object with a standard shape, registered once. The AI
// Orchestrator, Tool Registry, and Automation Engine never touch a specific
// integration's code directly; they only ever go through this shape.
//
// This doesn't replace registerIntegration() from Phase 4's manager.js — it
// wraps it with the fuller interface Phase 7 asks for (health check,
// settings, triggers, permissions, metadata) while staying compatible with
// everything already built on top of the simpler Phase 4 shape.

import { registerIntegration as registerConnectionDefinition } from "../manager.js";

const sdkRegistry = new Map();

/**
 * @param {object} def
 * @param {string} def.id                — unique integration id, e.g. "wordpress"
 * @param {string} def.name               — display name
 * @param {string} def.category           — e.g. "cms", "ecommerce", "email", "productivity"
 * @param {string} def.authType           — "oauth2" | "api_key" | "application_password" | "manual_token"
 * @param {string[]} def.requiredScopes   — OAuth scopes, or [] if not applicable
 * @param {object} def.permissions        — map of permission id -> description, e.g. { "wordpress.read": "..." }
 * @param {string} def.version            — SDK-shape version this integration implements, for future migrations
 * @param {(userId) => Promise<object>} def.healthCheck — returns { connected, reason?, details? }
 * @param {object[]} def.tools            — tool names this integration registers (informational — actual
 *                                          registration still happens via registerTool in the tools/ dir)
 * @param {object[]} def.triggers         — trigger type ids this integration can publish events for
 */
export function defineIntegration(def) {
  if (!def?.id) throw new Error("Integration definition must have an id");
  const normalized = {
    version: "1.0",
    requiredScopes: [],
    permissions: {},
    tools: [],
    triggers: [],
    healthCheck: async () => ({ connected: false, reason: "No health check implemented" }),
    ...def,
  };
  sdkRegistry.set(def.id, normalized);

  // Every SDK integration is also registered with the simpler Phase 4
  // connection-state manager, so getConnection/saveConnection/etc. work
  // identically to how Meta Ads and WhatsApp already work — no parallel
  // connection-storage system for the new integrations.
  registerConnectionDefinition({
    id: def.id,
    name: def.name,
    category: def.category,
    authType: def.authType,
    requiredScopes: def.requiredScopes,
    supportedTools: (def.tools || []).map((t) => t.name || t),
  });

  return normalized;
}

export function getIntegrationSdkDefinition(id) {
  return sdkRegistry.get(id) || null;
}

export function listSdkIntegrations() {
  return Array.from(sdkRegistry.values());
}

// Standard shape returned by GET /api/integrations for every SDK-registered
// integration, merging its static metadata with live connection state.
export async function describeIntegration(id, userId) {
  const def = getIntegrationSdkDefinition(id);
  if (!def) return null;
  const health = userId ? await def.healthCheck(userId) : { connected: false };
  return {
    id: def.id,
    name: def.name,
    category: def.category,
    authType: def.authType,
    version: def.version,
    permissions: Object.keys(def.permissions),
    tools: def.tools.map((t) => t.name || t),
    triggers: def.triggers,
    ...health,
  };
}
