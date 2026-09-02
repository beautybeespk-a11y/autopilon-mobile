// Closed-beta account creation — the admin-created-account path chosen
// over an invite-code system: public signup stays gated by
// PUBLIC_SIGNUP_ENABLED (routes/auth.js) exactly as before; this is a
// completely separate insert path, reachable only through
// requirePlatformAdmin, that never reads or writes that flag. No email
// infra exists in this codebase yet (routes/auth.js's /forgot-password is
// a stub — see its own comment), so there's no single-use-link flow to
// build here either: a temp password is generated, hashed, and returned
// to the admin ONCE for them to relay out-of-band, the same as handing a
// tester any other credential today.
import bcrypt from "bcryptjs";
import db from "../db.js";
import { cryptoRandom, logActivity, secureRandomToken } from "../middleware.js";

const now = () => new Date().toISOString();

export function createUserAsAdmin(adminUserId, { name, email }) {
  if (!name?.trim() || !email?.trim()) throw new Error("Name and email are required.");
  const normalizedEmail = email.toLowerCase().trim();
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(normalizedEmail);
  if (exists) throw new Error("An account with this email already exists.");

  // Security-sensitive credential — same crypto.randomBytes-backed
  // generator every other real secret in this codebase uses (API keys,
  // webhook secrets, file-share tokens), never the Math.random()-backed
  // cryptoRandom() reserved for non-sensitive ids (see middleware.js's
  // own comment on that distinction).
  const tempPassword = secureRandomToken(9); // 18 hex chars
  const id = cryptoRandom();
  const hash = bcrypt.hashSync(tempPassword, 10);
  db.prepare(
    "INSERT INTO users (id, name, email, password, createdByAdmin, createdByAdminId, createdAt) VALUES (?, ?, ?, ?, 1, ?, ?)"
  ).run(id, name.trim(), normalizedEmail, hash, adminUserId, now());

  // Logged under the ADMIN's id, not the new user's — same pattern
  // platformAdmin.js already uses for grant-trial/credits (logged under
  // the acting admin, not the org). Matters for account deletion: if this
  // beta account is later removed, its own activity_logs cascade away
  // with it, but the "an admin created this account" audit entry must
  // survive — it lives under the admin instead.
  logActivity(db, adminUserId, "admin_created_user", `Created a beta account for ${normalizedEmail}`, {});

  return { id, name: name.trim(), email: normalizedEmail, tempPassword };
}

// Scoped to admin-created accounts only, not a general "all users" view —
// that's a separate, unbuilt thing (see BETA_TESTING.md) and real extra
// scope this doesn't need.
export function listAdminCreatedUsers() {
  return db.prepare(
    "SELECT id, name, email, createdAt, createdByAdminId FROM users WHERE createdByAdmin = 1 ORDER BY createdAt DESC"
  ).all();
}
