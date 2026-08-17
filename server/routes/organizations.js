import { Router } from "express";
import db from "../db.js";
import { requireAuth, logActivity } from "../middleware.js";
import {
  createOrganization, listMyOrganizations, getOrganization, updateOrganization, deleteOrganization,
  listMembers, inviteMember, listMyInvitations, respondToInvitation, removeMember, setMemberStatus,
  changeMemberRole, transferOwnership, createCustomRole, updateCustomRole, deleteCustomRole,
} from "../orchestrator/organizationManager.js";
import { requireOrgPermission, listRoles, getMembership } from "../orchestrator/rbac.js";

const router = Router();
router.use(requireAuth);

// Invitations addressed to the current user — not nested under a specific
// org id, since the point is discovering orgs you've been invited to.
router.get("/invitations", (req, res) => {
  res.json(listMyInvitations(req.session.userId));
});
router.post("/invitations/:membershipId/accept", (req, res) => {
  try { res.json(respondToInvitation(req.session.userId, req.params.membershipId, true)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});
router.post("/invitations/:membershipId/decline", (req, res) => {
  try { res.json(respondToInvitation(req.session.userId, req.params.membershipId, false)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

// Which organization the current session is "in" — null means personal
// mode. Purely a session flag right now; later phases can use this to
// scope agents/knowledge/automations to the active org.
router.get("/current", (req, res) => {
  res.json({ orgId: req.session.currentOrgId || null });
});
router.post("/switch", (req, res) => {
  const { orgId } = req.body || {};
  if (orgId && !getMembership(orgId, req.session.userId)) {
    return res.status(403).json({ error: "You're not a member of that organization." });
  }
  req.session.currentOrgId = orgId || null;
  db.prepare("UPDATE users SET activeOrgId = ? WHERE id = ?").run(orgId || null, req.session.userId);
  res.json({ orgId: req.session.currentOrgId });
});

router.get("/", (req, res) => {
  res.json(listMyOrganizations(req.session.userId));
});

router.post("/", (req, res) => {
  try {
    const org = createOrganization(req.session.userId, req.body || {});
    logActivity(db, req.session.userId, "organization_created", `Created organization "${org.name}"`, { orgId: org.id, req });
    res.json(org);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/:id", (req, res) => {
  try { res.json(getOrganization(req.session.userId, req.params.id)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

router.patch("/:id", requireOrgPermission("settings"), (req, res) => {
  const org = updateOrganization(req.params.id, req.body || {});
  logActivity(db, req.session.userId, "organization_updated", `Updated organization "${org.name}"`, { orgId: req.params.id, req });
  res.json(org);
});

router.delete("/:id", async (req, res) => {
  const membership = getMembership(req.params.id, req.session.userId);
  if (!membership || membership.role !== "owner") {
    return res.status(403).json({ error: "Only the organization owner can delete it." });
  }
  // Logged BEFORE deletion, deliberately: deleteOrganization() cleans up
  // every other org-scoped table but leaves activity_logs alone precisely
  // so this audit entry (and the org's prior history) survives the org
  // itself — see organizationManager.js's deleteOrganization() comment.
  logActivity(db, req.session.userId, "organization_deleted", "Deleted an organization", { orgId: req.params.id, req });
  await deleteOrganization(req.params.id);
  res.json({ deleted: true });
});

// --- Members & invitations ---
router.get("/:id/members", (req, res) => {
  const membership = getMembership(req.params.id, req.session.userId);
  if (!membership) return res.status(403).json({ error: "You're not a member of this organization." });
  res.json(listMembers(req.params.id));
});

router.post("/:id/members/invite", requireOrgPermission("member_management"), (req, res) => {
  try {
    const { email, role } = req.body || {};
    if (!email) return res.status(400).json({ error: "email is required." });
    const result = inviteMember(req.params.id, email, role);
    logActivity(db, req.session.userId, "member_invited", `Invited ${email} to organization`, { orgId: req.params.id, req });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/:id/members/:membershipId/resend", requireOrgPermission("member_management"), (req, res) => {
  // No outbound email exists yet — this just re-stamps invitedAt so it's
  // clear a resend was attempted, and logs it for the activity feed.
  db.prepare("UPDATE organization_members SET invitedAt = ? WHERE id = ? AND orgId = ? AND status = 'invited'")
    .run(new Date().toISOString(), req.params.membershipId, req.params.id);
  logActivity(db, req.session.userId, "invitation_resent", "Resent an organization invitation", { orgId: req.params.id, req });
  res.json({ ok: true });
});

router.delete("/:id/members/:membershipId", requireOrgPermission("member_management"), (req, res) => {
  try {
    removeMember(req.params.id, req.params.membershipId);
    logActivity(db, req.session.userId, "member_removed", "Removed an organization member", { orgId: req.params.id, req });
    res.json({ removed: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/:id/members/:membershipId/suspend", requireOrgPermission("member_management"), (req, res) => {
  try {
    const result = setMemberStatus(req.params.id, req.params.membershipId, "suspended");
    logActivity(db, req.session.userId, "member_suspended", "Suspended an organization member", { orgId: req.params.id, req });
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});
router.post("/:id/members/:membershipId/reactivate", requireOrgPermission("member_management"), (req, res) => {
  try {
    const result = setMemberStatus(req.params.id, req.params.membershipId, "active");
    logActivity(db, req.session.userId, "member_reactivated", "Reactivated an organization member", { orgId: req.params.id, req });
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.patch("/:id/members/:membershipId/role", requireOrgPermission("member_management"), (req, res) => {
  try {
    const result = changeMemberRole(req.params.id, req.params.membershipId, req.body?.role);
    logActivity(db, req.session.userId, "member_role_changed", `Changed a member's role to "${req.body?.role}"`, { orgId: req.params.id, req });
    res.json(result);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

router.post("/:id/transfer-ownership", (req, res) => {
  const membership = getMembership(req.params.id, req.session.userId);
  if (!membership || membership.role !== "owner") {
    return res.status(403).json({ error: "Only the current owner can transfer ownership." });
  }
  try {
    const result = transferOwnership(req.params.id, req.session.userId, req.body?.toUserId);
    logActivity(db, req.session.userId, "ownership_transferred", "Transferred organization ownership", { orgId: req.params.id, req });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Roles ---
router.get("/:id/roles", (req, res) => {
  const membership = getMembership(req.params.id, req.session.userId);
  if (!membership) return res.status(403).json({ error: "You're not a member of this organization." });
  res.json(listRoles(req.params.id));
});
router.post("/:id/roles", requireOrgPermission("settings"), (req, res) => {
  const { name, permissions } = req.body || {};
  if (!name) return res.status(400).json({ error: "name is required." });
  res.json(createCustomRole(req.params.id, name, permissions));
});
router.patch("/:id/roles/:roleId", requireOrgPermission("settings"), (req, res) => {
  res.json(updateCustomRole(req.params.id, req.params.roleId, req.body || {}));
});
router.delete("/:id/roles/:roleId", requireOrgPermission("settings"), (req, res) => {
  try { res.json(deleteCustomRole(req.params.id, req.params.roleId)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

export default router;
