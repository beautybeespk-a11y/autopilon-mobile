// Meta Ads Expert V2 — runtime kill switch (closes a gap the pre-
// deployment report flagged): agentLibrary.js's feature-flag gating only
// controls whether the V2 template can be INSTALLED as a new agent. It
// says nothing about whether an agent installed BEFORE the flag was
// disabled can keep calling V2 tools afterward — for a system that spends
// real ad budget, "already installed" must never be a way to keep running
// once the flag is off. This is checked again, fresh, on EVERY V2 tool
// call (not just at install time), so disabling the flag takes effect
// immediately for every agent already using it — no restart, no
// dependency on when the agent was created.
//
// Same two gates the pre-deployment report described:
//   1. META_EXPERT_V2=true — the env var master switch.
//   2. The "meta_expert_v2" DB feature flag (server/orchestrator/
//      featureFlags.js), evaluated for the CURRENT userId/orgId — the
//      same per-user/org rollout system already used for every other
//      risky feature in this app, re-evaluated live (its own cache TTL
//      is 30s — see featureFlags.js's evaluationData()) rather than
//      cached anywhere in V2's own code, so a flag flip is visible within
//      seconds, not on the next deploy.
import { isFeatureEnabled } from "../../orchestrator/featureFlags.js";
import { resolveOrgId } from "../../orchestrator/voiceUsage.js";

export function isV2RuntimeEnabled(userId) {
  if (process.env.META_EXPERT_V2 !== "true") return false;
  const orgId = resolveOrgId(userId);
  return isFeatureEnabled("meta_expert_v2", { userId, orgId });
}

// Throws a customer-safe, internally-coded error — same shape every other
// V2 backend rejection already uses (err.code + a plain-language
// err.message, e.g. META_V2_STRATEGY_REQUIRED, META_V2_BUDGET_LIMIT_
// EXCEEDED) — callers never need special-case handling for this one.
export function assertV2RuntimeEnabled(userId) {
  if (isV2RuntimeEnabled(userId)) return;
  const err = new Error("Meta Ads Expert V2 is not currently available. Please try again later or contact support if this continues.");
  err.code = "META_EXPERT_V2_DISABLED";
  throw err;
}
