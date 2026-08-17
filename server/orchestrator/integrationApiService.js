// Integration service for the Public API (Phase 17 §13) — deliberately
// read-only in this pass. Lists which providers are connected and their
// status; never returns an OAuth token, refresh token, or any other
// credential (the `integrations` table row itself never even reaches this
// file's return value unfiltered).
//
// Action execution (send an email, create a WooCommerce product, etc.) is
// intentionally NOT exposed as its own set of Public API endpoints here —
// building a curated per-provider action layer for WordPress/WooCommerce/
// Shopify/Gmail/Meta/WhatsApp is real, substantial work. Every one of those
// actions already exists as a Tool (tools/registry.js) an agent can call,
// so the real, working path for a developer to trigger an integration
// action today is POST /v1/agents/:id/execute against an agent with that
// skill enabled — documented explicitly as a known limitation in the Phase
// 17 completion report rather than left unstated.
import db from "../db.js";

export function listOrgIntegrations(orgId) {
  return db.prepare("SELECT provider, status, createdAt FROM integrations WHERE orgId = ? ORDER BY provider ASC").all(orgId);
}
