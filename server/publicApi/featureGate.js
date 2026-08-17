// Feature-flag gating for the Public API (Phase 17 §53) — reuses the exact
// same Phase 16 feature-flag engine every other kill switch in the app runs
// on (server/orchestrator/featureFlags.js), never a second gating system.
// Every flag here defaults to enabled=true at 100% rollout, matching the
// Public API's current always-on behavior — this task adds the ability to
// pull a slice of the API (or all of it, for one org, or globally) without
// a redeploy; it does not change who can reach what today.
import { createFlag, isFeatureEnabled } from "../orchestrator/featureFlags.js";
import { apiError } from "./errors.js";

// key -> [name, description]. "public_api" is the master switch every
// authenticated request under /api/v1 passes through (checked once, inside
// requireApiKey itself, so no route can forget it); the rest gate one
// resource area each, so a single misbehaving capability (e.g. content
// generation hitting a provider outage) can be pulled without taking the
// whole Public API down with it.
export const PUBLIC_API_FLAG_DEFS = {
  public_api: ["Public API", "Master switch for the entire /api/v1 Public API. Disabling this takes the whole Public API offline (globally, or for one org/user via an override)."],
  public_api_agents: ["Public API: Agents", "Gates /api/v1/agents and /api/v1/runs."],
  public_api_automations: ["Public API: Automations", "Gates /api/v1/automations."],
  public_api_tasks: ["Public API: Tasks", "Gates /api/v1/tasks."],
  public_api_projects: ["Public API: Projects", "Gates /api/v1/projects."],
  public_api_files: ["Public API: Files", "Gates /api/v1/files."],
  public_api_content: ["Public API: Content Generation", "Gates /api/v1/content."],
  public_api_integrations: ["Public API: Integrations", "Gates /api/v1/integrations."],
  public_api_marketplace: ["Public API: Marketplace", "Gates /api/v1/marketplace."],
  public_api_webhooks: ["Public API: Webhooks", "Gates /api/v1/webhooks (developer webhook management)."],
};

// Idempotent — called once at server startup. Uses createFlag()'s own
// duplicate-key check rather than raw SQL so this stays the one place flag
// rows get created, same validation path as an admin creating one by hand.
export function ensurePublicApiFlags() {
  for (const [key, [name, description]] of Object.entries(PUBLIC_API_FLAG_DEFS)) {
    try {
      createFlag({ key, name, description, enabled: true, rolloutPercent: 100 });
    } catch (err) {
      if (err.code !== "INVALID") throw err; // INVALID here only ever means "a flag with this key already exists"
    }
  }
}

// Applied per-resource-router, after requireApiKey (needs req.orgId) and
// before the route's own requireScope — keeps "which capability flag this
// resource needs" visible at the point of declaration, same reasoning as
// requireScope() not being buried inside a shared handler.
export function requireCapability(key) {
  return (req, res, next) => {
    if (!isFeatureEnabled(key, { orgId: req.orgId, userId: req.apiKey?.userId })) {
      return apiError(res, 503, "FEATURE_DISABLED", "This Public API capability is currently unavailable for this organization.");
    }
    next();
  };
}
