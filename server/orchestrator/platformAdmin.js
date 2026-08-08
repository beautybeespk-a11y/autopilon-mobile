import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { createNotification } from "./notifications.js";
import { applyCustomerBalance } from "./stripeService.js";

const now = () => new Date().toISOString();

export function listAllOrganizations() {
  return db.prepare(
    `SELECT o.id, o.name, o.status, o.createdAt, u.name AS ownerName, u.email AS ownerEmail,
            s.planId, s.status AS subscriptionStatus, s.trialEndsAt,
            (SELECT COUNT(*) FROM organization_members WHERE orgId = o.id AND status = 'active') AS memberCount
     FROM organizations o
     LEFT JOIN users u ON u.id = o.ownerId
     LEFT JOIN subscriptions s ON s.orgId = o.id
     ORDER BY o.createdAt DESC`
  ).all();
}

export function updatePlan(planId, fields) {
  const { name, monthlyPriceCents, maxUsers, maxAgents, maxAutomations, maxIntegrations, maxAiRequests, apiAccess, marketplaceAccess, stripePriceId } = fields;
  const existing = db.prepare("SELECT * FROM plans WHERE id = ?").get(planId);
  if (!existing) throw new Error(`Unknown plan "${planId}".`);
  db.prepare(
    `UPDATE plans SET
       name = COALESCE(?, name), monthlyPriceCents = COALESCE(?, monthlyPriceCents),
       maxUsers = ?, maxAgents = ?, maxAutomations = ?, maxIntegrations = ?, maxAiRequests = ?,
       apiAccess = COALESCE(?, apiAccess), marketplaceAccess = COALESCE(?, marketplaceAccess),
       stripePriceId = CASE WHEN ? THEN ? ELSE stripePriceId END
     WHERE id = ?`
  ).run(
    name, monthlyPriceCents,
    maxUsers !== undefined ? maxUsers : existing.maxUsers,
    maxAgents !== undefined ? maxAgents : existing.maxAgents,
    maxAutomations !== undefined ? maxAutomations : existing.maxAutomations,
    maxIntegrations !== undefined ? maxIntegrations : existing.maxIntegrations,
    maxAiRequests !== undefined ? maxAiRequests : existing.maxAiRequests,
    apiAccess != null ? (apiAccess ? 1 : 0) : null,
    marketplaceAccess != null ? (marketplaceAccess ? 1 : 0) : null,
    stripePriceId !== undefined ? 1 : 0, stripePriceId === "" ? null : stripePriceId,
    planId
  );
  return db.prepare("SELECT * FROM plans WHERE id = ?").get(planId);
}

// Billing-relevant actions across ALL orgs — a platform-wide view, distinct
// from a single org's own audit log (which only owner/admin of that org
// can see). Reuses the same activity_logs table, just queried without an
// orgId filter and narrowed to billing-related action types.
const BILLING_ACTIONS = [
  "plan_changed", "billing_mode_changed", "api_key_saved", "api_key_deleted",
  "coupon_created", "coupon_redeemed", "manual_credit_granted", "support_adjustment",
  "subscription_canceled", "subscription_resumed",
];
export function listBillingLogs(limit = 100) {
  const placeholders = BILLING_ACTIONS.map(() => "?").join(",");
  return db.prepare(
    `SELECT al.*, u.name AS userName, o.name AS orgName FROM activity_logs al
     LEFT JOIN users u ON u.id = al.userId
     LEFT JOIN organizations o ON o.id = al.orgId
     WHERE al.action IN (${placeholders})
     ORDER BY al.createdAt DESC LIMIT ?`
  ).all(...BILLING_ACTIONS, limit);
}

// Manual trial grants — a direct trial/plan grant, reusing the same
// subscription-update shape billing.setPlan already does. Distinct from
// grantCredit() below, which is a real $ balance (synced to Stripe when
// possible), for the case where the right adjustment is "extend access to
// a plan" rather than "reduce what they'll be charged."
export function getCreditBalance(orgId) {
  return db.prepare("SELECT COALESCE(SUM(amountCents), 0) c FROM organization_credits WHERE orgId = ?").get(orgId).c;
}

export function listCredits(orgId) {
  return db.prepare(
    `SELECT oc.*, u.name AS grantedByName FROM organization_credits oc
     LEFT JOIN users u ON u.id = oc.grantedBy
     WHERE oc.orgId = ? ORDER BY oc.createdAt DESC`
  ).all(orgId);
}

// Always records the local ledger entry first (the source of truth, works
// even without Stripe connected) — then best-effort applies it as a real
// Stripe Customer Balance transaction so it actually reduces the org's next
// invoice. If Stripe isn't configured or the call fails, the credit still
// exists and is visible; it just isn't reflected on Stripe's side yet.
export async function grantCredit(adminUserId, orgId, amountCents, reason) {
  const id = cryptoRandom();
  let stripeSynced = 0;
  try {
    await applyCustomerBalance(orgId, amountCents, reason || "Manual credit");
    stripeSynced = 1;
  } catch {
    // Stripe not configured, or the call failed — the local ledger entry
    // below still records the grant; nothing here should block that.
  }
  db.prepare("INSERT INTO organization_credits (id, orgId, amountCents, reason, grantedBy, stripeSynced, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, orgId, amountCents, reason || null, adminUserId, stripeSynced, now());

  const org = db.prepare("SELECT ownerId, name FROM organizations WHERE id = ?").get(orgId);
  if (org) {
    createNotification(org.ownerId, {
      type: "credit_granted",
      title: `$${(amountCents / 100).toFixed(2)} credit added to "${org.name}"`,
      body: reason || undefined,
      link: `/app/organizations/${orgId}`,
    });
  }
  return { id, amountCents, stripeSynced: Boolean(stripeSynced) };
}

export function grantManualTrial(adminUserId, orgId, planId, days) {
  const sub = db.prepare("SELECT * FROM subscriptions WHERE orgId = ?").get(orgId);
  if (!sub) throw new Error("Organization has no subscription record.");
  const trialEndsAt = new Date(Date.now() + days * 86400_000).toISOString();
  db.prepare("UPDATE subscriptions SET planId = ?, status = 'trialing', trialEndsAt = ?, updatedAt = ? WHERE orgId = ?")
    .run(planId, trialEndsAt, now(), orgId);
  const org = db.prepare("SELECT ownerId, name FROM organizations WHERE id = ?").get(orgId);
  if (org) {
    createNotification(org.ownerId, {
      type: "manual_credit",
      title: `You've been granted a ${days}-day trial`,
      body: `An admin extended "${org.name}" onto the ${planId} plan.`,
      link: `/app/organizations/${orgId}`,
    });
  }
  return { orgId, planId, trialEndsAt };
}
