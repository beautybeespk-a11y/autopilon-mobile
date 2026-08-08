import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { getMembership, isBuiltinRole } from "./rbac.js";
import { createNotification } from "./notifications.js";
import { ensureSubscription, enforceQuota } from "./billing.js";

const now = () => new Date().toISOString();

export function createOrganization(userId, { name, logoUrl, settings }) {
  if (!name?.trim()) throw new Error("Organization name is required.");
  const id = cryptoRandom();
  const ts = now();
  db.prepare(
    "INSERT INTO organizations (id, name, logoUrl, ownerId, status, settings, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'active', ?, ?, ?)"
  ).run(id, name, logoUrl || null, userId, JSON.stringify(settings || {}), ts, ts);
  db.prepare(
    "INSERT INTO organization_members (id, orgId, userId, role, status, joinedAt) VALUES (?, ?, ?, 'owner', 'active', ?)"
  ).run(cryptoRandom(), id, userId, ts);
  ensureSubscription(id);
  return getOrganization(userId, id);
}

export function listMyOrganizations(userId) {
  return db.prepare(
    `SELECT o.*, om.role AS myRole FROM organizations o
     JOIN organization_members om ON om.orgId = o.id
     WHERE om.userId = ? AND om.status = 'active'
     ORDER BY o.name`
  ).all(userId);
}

export function getOrganization(userId, orgId) {
  const membership = getMembership(orgId, userId);
  if (!membership) throw new Error("Organization not found, or you're not a member.");
  const org = db.prepare("SELECT * FROM organizations WHERE id = ?").get(orgId);
  if (!org) throw new Error("Organization not found.");
  return { ...org, settings: JSON.parse(org.settings || "{}"), myRole: membership.role };
}

export function updateOrganization(orgId, fields) {
  const { name, logoUrl, settings } = fields;
  db.prepare(
    `UPDATE organizations SET name = COALESCE(?, name), logoUrl = COALESCE(?, logoUrl),
     settings = COALESCE(?, settings), updatedAt = ? WHERE id = ?`
  ).run(name, logoUrl, settings ? JSON.stringify(settings) : null, now(), orgId);
  return db.prepare("SELECT * FROM organizations WHERE id = ?").get(orgId);
}

export function deleteOrganization(orgId) {
  db.prepare("DELETE FROM organizations WHERE id = ?").run(orgId); // cascades to members/workspaces/roles
  return { deleted: true };
}

export function listMembers(orgId) {
  return db.prepare(
    `SELECT om.id, om.userId, om.invitedEmail, om.role, om.status, om.invitedAt, om.joinedAt,
            u.name AS userName, u.email AS userEmail, u.avatar AS userAvatar
     FROM organization_members om LEFT JOIN users u ON u.id = om.userId
     WHERE om.orgId = ? ORDER BY om.status, om.joinedAt`
  ).all(orgId);
}

// Invites by email. If an account with that email already exists, the
// membership is linked immediately (status 'invited', still needs accept);
// otherwise it's held against the email alone until someone with a matching
// account exists — there's no outbound email here yet, so the invited
// person currently needs to be told out-of-band and check their pending
// invitations after logging in.
export function inviteMember(orgId, email, role) {
  enforceQuota(orgId, "maxUsers", "team members");
  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  const already = existing
    ? db.prepare("SELECT id FROM organization_members WHERE orgId = ? AND userId = ?").get(orgId, existing.id)
    : db.prepare("SELECT id FROM organization_members WHERE orgId = ? AND invitedEmail = ? AND userId IS NULL").get(orgId, email);
  if (already) throw new Error("This person is already a member or has a pending invitation.");
  const id = cryptoRandom();
  db.prepare(
    "INSERT INTO organization_members (id, orgId, userId, invitedEmail, role, status, invitedAt) VALUES (?, ?, ?, ?, ?, 'invited', ?)"
  ).run(id, orgId, existing?.id || null, email, role || "member", now());
  if (existing) {
    const org = db.prepare("SELECT name FROM organizations WHERE id = ?").get(orgId);
    createNotification(existing.id, {
      type: "org_invitation",
      title: `You've been invited to join ${org?.name || "an organization"}`,
      body: `Role: ${role || "member"}`,
      link: "/app/organizations",
    });
  }
  return { id, email, role: role || "member", linkedToExistingAccount: Boolean(existing) };
}

export function listMyInvitations(userId) {
  return db.prepare(
    `SELECT om.id, om.orgId, om.role, om.invitedAt, o.name AS orgName, o.logoUrl
     FROM organization_members om JOIN organizations o ON o.id = om.orgId
     WHERE om.userId = ? AND om.status = 'invited' ORDER BY om.invitedAt DESC`
  ).all(userId);
}

export function respondToInvitation(userId, membershipId, accept) {
  const row = db.prepare("SELECT * FROM organization_members WHERE id = ? AND userId = ? AND status = 'invited'").get(membershipId, userId);
  if (!row) throw new Error("Invitation not found.");
  if (accept) {
    db.prepare("UPDATE organization_members SET status = 'active', joinedAt = ? WHERE id = ?").run(now(), membershipId);
  } else {
    db.prepare("DELETE FROM organization_members WHERE id = ?").run(membershipId);
  }
  return { accepted: accept };
}

export function removeMember(orgId, membershipId) {
  const row = db.prepare("SELECT role FROM organization_members WHERE id = ? AND orgId = ?").get(membershipId, orgId);
  if (!row) throw new Error("Member not found.");
  if (row.role === "owner") throw new Error("Can't remove the organization owner — transfer ownership first.");
  db.prepare("DELETE FROM organization_members WHERE id = ? AND orgId = ?").run(membershipId, orgId);
  return { removed: true };
}

export function setMemberStatus(orgId, membershipId, status) {
  if (!["active", "suspended"].includes(status)) throw new Error("status must be 'active' or 'suspended'.");
  const row = db.prepare("SELECT role FROM organization_members WHERE id = ? AND orgId = ?").get(membershipId, orgId);
  if (!row) throw new Error("Member not found.");
  if (row.role === "owner") throw new Error("Can't suspend the organization owner.");
  db.prepare("UPDATE organization_members SET status = ? WHERE id = ? AND orgId = ?").run(status, membershipId, orgId);
  return { status };
}

export function changeMemberRole(orgId, membershipId, role) {
  const row = db.prepare("SELECT role FROM organization_members WHERE id = ? AND orgId = ?").get(membershipId, orgId);
  if (!row) throw new Error("Member not found.");
  if (row.role === "owner") throw new Error("Use transferOwnership to change who owns the organization.");
  if (!isBuiltinRole(role)) {
    const customExists = db.prepare("SELECT id FROM custom_roles WHERE id = ? AND orgId = ?").get(role, orgId);
    if (!customExists) throw new Error(`Unknown role "${role}".`);
  }
  db.prepare("UPDATE organization_members SET role = ? WHERE id = ? AND orgId = ?").run(role, membershipId, orgId);
  return { role };
}

export function transferOwnership(orgId, currentOwnerId, newOwnerUserId) {
  const newOwnerMembership = db.prepare("SELECT * FROM organization_members WHERE orgId = ? AND userId = ? AND status = 'active'").get(orgId, newOwnerUserId);
  if (!newOwnerMembership) throw new Error("The new owner must already be an active member of this organization.");
  const oldOwnerMembership = db.prepare("SELECT * FROM organization_members WHERE orgId = ? AND userId = ?").get(orgId, currentOwnerId);
  db.prepare("UPDATE organizations SET ownerId = ?, updatedAt = ? WHERE id = ?").run(newOwnerUserId, now(), orgId);
  db.prepare("UPDATE organization_members SET role = 'owner' WHERE id = ?").run(newOwnerMembership.id);
  if (oldOwnerMembership) db.prepare("UPDATE organization_members SET role = 'admin' WHERE id = ?").run(oldOwnerMembership.id);
  return { newOwnerUserId };
}

export function createCustomRole(orgId, name, permissions) {
  const id = cryptoRandom();
  db.prepare("INSERT INTO custom_roles (id, orgId, name, permissions, createdAt) VALUES (?, ?, ?, ?, ?)")
    .run(id, orgId, name, JSON.stringify(permissions || []), now());
  return { id, name, permissions: permissions || [] };
}

export function updateCustomRole(orgId, roleId, fields) {
  const { name, permissions } = fields;
  db.prepare("UPDATE custom_roles SET name = COALESCE(?, name), permissions = COALESCE(?, permissions) WHERE id = ? AND orgId = ?")
    .run(name, permissions ? JSON.stringify(permissions) : null, roleId, orgId);
  return { id: roleId };
}

export function deleteCustomRole(orgId, roleId) {
  const inUse = db.prepare("SELECT COUNT(*) c FROM organization_members WHERE orgId = ? AND role = ?").get(orgId, roleId).c;
  if (inUse > 0) throw new Error(`${inUse} member(s) currently have this role — reassign them first.`);
  db.prepare("DELETE FROM custom_roles WHERE id = ? AND orgId = ?").run(roleId, orgId);
  return { deleted: true };
}
