// Phase 19.3 — database migration regression. This app has no separate
// migration framework: db.js's own header says it plainly — "keep
// migrations additive" — every schema change is a PRAGMA table_info()-
// guarded `ALTER TABLE ... ADD COLUMN`, run automatically on every boot
// (see db.js, 47 such statements as of this phase). This test exercises
// the three real scenarios that matter for a real staging/production
// deploy:
//
//   1. Fresh database: db.js boots cleanly against a file that doesn't
//      exist yet (also covered by CI's "migration-check" job against a
//      live server; this test checks it at the module level directly).
//   2. Existing, already-current database: re-running the same idempotent
//      statements against a database that already has every column must
//      be a genuine no-op — no error, no data touched.
//   3. Existing database on an OLDER schema shape: a database built with
//      only the base CREATE TABLE columns (no later ALTER TABLE ADD
//      COLUMN columns applied yet — i.e. exactly what a real pre-upgrade
//      production database looks like) with REAL data already in it. The
//      current db.js must apply every outstanding column addition without
//      losing or corrupting a single existing row.
//
// Also documents, rather than tests (there's nothing to test — it's a
// property of the schema, verified by grep): there is no DROP TABLE/DROP
// COLUMN/RENAME anywhere in db.js, so there is no destructive migration to
// roll back. A code rollback to an older release after a new column has
// been added is safe by construction — older code simply never reads or
// writes that column; the column stays, unused, until the newer code
// returns.
//
//   node test/dbMigrationRegression.js
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, pass: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, pass: false, err: err.message });
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

function freshTmpPath(label) {
  return `/tmp/db-migration-regression-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`;
}

function rmDbFiles(p) {
  for (const suffix of ["", "-shm", "-wal"]) fs.rmSync(p + suffix, { force: true });
}

async function bootDbModule(dbPath, byokKey) {
  // db.js is an ES module with top-level side effects that run once per
  // process — a fresh child process per scenario is the only real way to
  // re-exercise its bootstrap logic against a different starting file,
  // exactly like a real server restart does in production.
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["-e", "import('./db.js').then(() => { console.log('DB_BOOT_OK'); process.exit(0); }).catch((e) => { console.error(e); process.exit(1); })"], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, DB_PATH: dbPath, BYOK_ENCRYPTION_KEY: byokKey },
    });
    let out = "";
    let err = "";
    proc.stdout.on("data", (d) => (out += d));
    proc.stderr.on("data", (d) => (err += d));
    proc.on("exit", (code) => {
      if (code === 0 && out.includes("DB_BOOT_OK")) resolve({ out, err });
      else reject(new Error(`db.js boot exited ${code}. stderr: ${err.slice(0, 2000)}`));
    });
  });
}

// --- Scenario 1: fresh database ---------------------------------------
await check("db.js boots cleanly against a completely fresh (nonexistent) database file", async () => {
  const p = freshTmpPath("fresh");
  rmDbFiles(p);
  await bootDbModule(p, "test-key-fresh");
  assert.ok(fs.existsSync(p), "expected the database file to have been created");
  const db = new Database(p, { readonly: true });
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(tables.includes("users") && tables.includes("agents") && tables.includes("integrations") && tables.includes("jobs"), "expected core tables to exist after a fresh boot");
  db.close();
  rmDbFiles(p);
});

// --- Scenario 2: existing, already-current database (idempotent re-run) --
await check("re-booting db.js against an ALREADY-CURRENT database is a genuine no-op — no error, no data touched", async () => {
  const p = freshTmpPath("current");
  rmDbFiles(p);
  await bootDbModule(p, "test-key-current"); // first boot: creates everything fresh
  const db1 = new Database(p);
  const userId = "u_" + Date.now();
  db1.prepare("INSERT INTO users (id, name, email, password, createdAt) VALUES (?, ?, ?, ?, ?)").run(userId, "Migration Test User", `mig-${Date.now()}@example.com`, "hashed", new Date().toISOString());
  db1.close();

  await bootDbModule(p, "test-key-current"); // second boot: same schema, must be a no-op

  const db2 = new Database(p, { readonly: true });
  const row = db2.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  assert.ok(row, "expected the row inserted between boots to still be present after a second boot");
  assert.equal(row.name, "Migration Test User");
  db2.close();
  rmDbFiles(p);
});

// --- Scenario 3: existing database on an OLDER schema shape, with real data --
await check("an existing database built on the OLDEST base-column-only schema shape, with real data already in it, migrates cleanly under the current db.js — every outstanding ALTER TABLE ADD COLUMN applies, and not one existing row is lost or corrupted", async () => {
  const p = freshTmpPath("legacy");
  rmDbFiles(p);

  // Hand-construct a database using ONLY the base CREATE TABLE column
  // sets from db.js's own top-of-file schema block — i.e. exactly what a
  // real production database looked like before any of the 47 ALTER
  // TABLE ADD COLUMN statements below it had ever run. This is not a
  // synthetic shape; it's copied verbatim from db.js's own base
  // CREATE TABLE statements for these two tables.
  const legacy = new Database(p);
  legacy.pragma("foreign_keys = ON");
  legacy.exec(`
    CREATE TABLE users (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      email      TEXT NOT NULL UNIQUE,
      password   TEXT NOT NULL,
      avatar     TEXT,
      createdAt  TEXT NOT NULL
    );
    CREATE TABLE agents (
      id           TEXT PRIMARY KEY,
      userId       TEXT NOT NULL,
      name         TEXT NOT NULL,
      description  TEXT,
      instructions TEXT,
      personality  TEXT DEFAULT 'professional',
      status       TEXT DEFAULT 'active',
      createdAt    TEXT NOT NULL,
      updatedAt    TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
  const legacyUserId = "legacy_u_" + Date.now();
  const legacyAgentId = "legacy_a_" + Date.now();
  const createdAt = new Date().toISOString();
  legacy.prepare("INSERT INTO users (id, name, email, password, createdAt) VALUES (?, ?, ?, ?, ?)")
    .run(legacyUserId, "Pre-Migration Real User", `legacy-${Date.now()}@example.com`, "a-real-bcrypt-hash-shape", createdAt);
  legacy.prepare("INSERT INTO agents (id, userId, name, description, instructions, personality, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(legacyAgentId, legacyUserId, "Pre-Migration Real Agent", "a real agent description", "real instructions text", "professional", "active", createdAt, createdAt);
  legacy.close();

  // Now boot the CURRENT db.js against this exact file — this is the real
  // migration path: an existing production database, new code deployed.
  await bootDbModule(p, "test-key-legacy");

  const migrated = new Database(p, { readonly: true });

  const userRow = migrated.prepare("SELECT * FROM users WHERE id = ?").get(legacyUserId);
  assert.ok(userRow, "the pre-existing user row must survive the migration");
  assert.equal(userRow.name, "Pre-Migration Real User");
  assert.equal(userRow.password, "a-real-bcrypt-hash-shape", "the pre-existing password hash must not be touched or corrupted by adding new columns");

  const userCols = migrated.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  for (const col of ["activeOrgId", "isPlatformAdmin", "stripeCustomerId"]) {
    assert.ok(userCols.includes(col), `expected users.${col} to have been added by the migration`);
  }
  assert.equal(userRow.isPlatformAdmin, 0, "a new NOT NULL DEFAULT 0 column must backfill correctly on pre-existing rows, not leave them NULL/broken");

  const agentRow = migrated.prepare("SELECT * FROM agents WHERE id = ?").get(legacyAgentId);
  assert.ok(agentRow, "the pre-existing agent row must survive the migration");
  assert.equal(agentRow.name, "Pre-Migration Real Agent");
  assert.equal(agentRow.instructions, "real instructions text", "pre-existing agent instructions must not be touched or corrupted");

  const agentCols = migrated.prepare("PRAGMA table_info(agents)").all().map((c) => c.name);
  for (const col of ["avatar", "category", "version", "aiProvider", "aiModel", "orgId", "workspaceId"]) {
    assert.ok(agentCols.includes(col), `expected agents.${col} to have been added by the migration`);
  }
  assert.equal(agentRow.category, "general", "a new column with a DEFAULT clause must backfill that default on pre-existing rows");
  assert.equal(agentRow.version, 1, "a new NOT NULL DEFAULT 1 column must backfill correctly on pre-existing rows");
  assert.equal(agentRow.orgId, null, "a new nullable column with no default must backfill as NULL on pre-existing rows, not an error or a placeholder value");

  // And the migrated database must still be fully usable afterward — a
  // normal write through the now-complete schema.
  migrated.close();
  const writable = new Database(p);
  writable.prepare("UPDATE agents SET category = 'sales' WHERE id = ?").run(legacyAgentId);
  const after = writable.prepare("SELECT category FROM agents WHERE id = ?").get(legacyAgentId);
  assert.equal(after.category, "sales");
  writable.close();

  rmDbFiles(p);
});

// --- Rollback strategy: documented by property, not by test ------------
await check("no destructive migration exists anywhere in db.js (no DROP TABLE / DROP COLUMN / RENAME) — a code rollback after a schema change is safe by construction, since older code simply never touches the new column", async () => {
  const fsMod = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const src = fsMod.readFileSync(path.join(__dirname, "../db.js"), "utf8");
  assert.ok(!/DROP\s+TABLE/i.test(src), "found a DROP TABLE statement — this would make a rollback genuinely unsafe");
  assert.ok(!/DROP\s+COLUMN/i.test(src), "found a DROP COLUMN statement — this would make a rollback genuinely unsafe");
  assert.ok(!/RENAME\s+(TO|COLUMN)/i.test(src), "found a RENAME statement — this would make a rollback genuinely unsafe (old code would look for the old name and find nothing)");
});

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} database migration checks passed.`);
if (failed.length) process.exit(1);
