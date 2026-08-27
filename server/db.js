import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
// [OPTIONAL] Overrides where the SQLite file lives — e.g. a mounted volume
// path in a container, so the database survives the container being
// recreated. Defaults to exactly the previous hardcoded behavior.
const db = new Database(process.env.DB_PATH || join(__dirname, "app.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// --- Schema. Extend by adding tables/columns; keep migrations additive. ---
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL UNIQUE,
  password   TEXT NOT NULL,
  avatar     TEXT,
  createdAt  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
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
CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(userId);

CREATE TABLE IF NOT EXISTS skills (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  category    TEXT,
  status      TEXT DEFAULT 'available'
);

CREATE TABLE IF NOT EXISTS agent_skills (
  agentId TEXT NOT NULL,
  skillId TEXT NOT NULL,
  PRIMARY KEY (agentId, skillId),
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (skillId) REFERENCES skills(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS conversations (
  id         TEXT PRIMARY KEY,
  userId     TEXT NOT NULL,
  agentId    TEXT,
  title      TEXT NOT NULL DEFAULT 'New conversation',
  createdAt  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conv_user ON conversations(userId);

CREATE TABLE IF NOT EXISTS messages (
  id             TEXT PRIMARY KEY,
  conversationId TEXT NOT NULL,
  role           TEXT NOT NULL,
  content        TEXT NOT NULL,
  createdAt      TEXT NOT NULL,
  FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversationId);

CREATE TABLE IF NOT EXISTS memories (
  id        TEXT PRIMARY KEY,
  userId    TEXT NOT NULL,
  content   TEXT NOT NULL,
  type      TEXT DEFAULT 'note',
  createdAt TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_mem_user ON memories(userId);

CREATE TABLE IF NOT EXISTS integrations (
  id        TEXT PRIMARY KEY,
  userId    TEXT NOT NULL,
  provider  TEXT NOT NULL,
  status    TEXT DEFAULT 'not_connected',
  createdAt TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_int_user ON integrations(userId);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  userId      TEXT NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  status      TEXT DEFAULT 'todo',
  priority    TEXT DEFAULT 'medium',
  dueDate     TEXT,
  createdAt   TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(userId);

CREATE TABLE IF NOT EXISTS activity_logs (
  id          TEXT PRIMARY KEY,
  userId      TEXT NOT NULL,
  action      TEXT NOT NULL,
  description TEXT,
  createdAt   TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_act_user ON activity_logs(userId);

-- ---- Phase 2: Orchestrator / Tool execution ----

CREATE TABLE IF NOT EXISTS execution_plans (
  id             TEXT PRIMARY KEY,
  userId         TEXT NOT NULL,
  conversationId TEXT,
  goal           TEXT,
  status         TEXT NOT NULL DEFAULT 'planning', -- planning|running|completed|failed
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plans_user ON execution_plans(userId);

CREATE TABLE IF NOT EXISTS tool_executions (
  id             TEXT PRIMARY KEY,
  planId         TEXT,
  userId         TEXT NOT NULL,
  conversationId TEXT,
  toolName       TEXT NOT NULL,
  parameters     TEXT, -- JSON string; never store secrets here
  status         TEXT NOT NULL DEFAULT 'pending', -- pending|planning|awaiting_confirmation|running|completed|failed
  result         TEXT, -- JSON string
  error          TEXT,
  startedAt      TEXT,
  completedAt    TEXT,
  createdAt      TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (planId) REFERENCES execution_plans(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_exec_user ON tool_executions(userId);
CREATE INDEX IF NOT EXISTS idx_exec_plan ON tool_executions(planId);

CREATE TABLE IF NOT EXISTS confirmation_requests (
  id          TEXT PRIMARY KEY,
  executionId TEXT NOT NULL,
  userId      TEXT NOT NULL,
  toolName    TEXT NOT NULL,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'pending', -- pending|approved|rejected|expired
  createdAt   TEXT NOT NULL,
  resolvedAt  TEXT,
  expiresAt   TEXT NOT NULL,
  FOREIGN KEY (executionId) REFERENCES tool_executions(id) ON DELETE CASCADE,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_confirm_user ON confirmation_requests(userId);
CREATE INDEX IF NOT EXISTS idx_confirm_exec ON confirmation_requests(executionId);

-- Per-agent skill→permission grants. Phase 1 seeded agent_skills already
-- controls which skills an agent has; this table is for future per-agent
-- permission overrides. Not required for Phase 2's default (skill grants
-- imply its tools' permissions) but present so the schema doesn't need
-- another migration when fine-grained control is added.
CREATE TABLE IF NOT EXISTS agent_permissions (
  agentId    TEXT NOT NULL,
  permission TEXT NOT NULL,
  PRIMARY KEY (agentId, permission),
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
);

-- ---- Phase 3: Web research & Knowledge Library ----
-- One flexible table backs the Knowledge Library (reports, notes, saved
-- URLs, summaries) — same shape (title/content/tags/sources/owner/date)
-- regardless of type, so one table with a discriminator beats four
-- near-duplicate ones. "Research History" is served by the tool_executions
-- table already built in Phase 2 (every web_search/read_webpage/etc. call
-- is already logged there per user, per conversation, with a timestamp).
CREATE TABLE IF NOT EXISTS knowledge_items (
  id         TEXT PRIMARY KEY,
  userId     TEXT NOT NULL,
  type       TEXT NOT NULL DEFAULT 'report', -- report|note|url|summary|article
  title      TEXT NOT NULL,
  category   TEXT,
  tags       TEXT, -- JSON array
  content    TEXT, -- JSON: report object or { note }
  sourceUrls TEXT, -- JSON array of { title, url }
  createdAt  TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_knowledge_user ON knowledge_items(userId);
`);

// Additive migration: messages.meta stores JSON trace/toolResults for
// assistant messages so the ToolActivity rail survives a page refresh.
const messageCols = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
if (!messageCols.includes("meta")) {
  db.exec("ALTER TABLE messages ADD COLUMN meta TEXT");
}

// Additive migration: OAuth token storage for Phase 4 integrations. Tokens
// live only here, only on the server — never sent to the frontend.
const integrationCols = db.prepare("PRAGMA table_info(integrations)").all().map((c) => c.name);
const addIntegrationCol = (name, type) => {
  if (!integrationCols.includes(name)) db.exec(`ALTER TABLE integrations ADD COLUMN ${name} ${type}`);
};
addIntegrationCol("accessToken", "TEXT");
addIntegrationCol("refreshToken", "TEXT");
addIntegrationCol("tokenExpiresAt", "TEXT");
addIntegrationCol("scopes", "TEXT");  // JSON array
addIntegrationCol("meta", "TEXT");    // JSON — e.g. selected ad account id
addIntegrationCol("updatedAt", "TEXT");
// The (userId, provider) unique index used to be created right here, before
// orgId existed as a column — superseded below (Phase 18.1 §2) by two
// partial indexes once orgId is added, so it's not (re)created on every
// boot: doing so here, unconditionally, would re-fail against any DB that
// already has a personal + org-shared connection for the same user and
// provider, which the partial-index migration below is specifically there
// to allow.

// ---- Phase 5: WhatsApp Business ----
// Connection state (token, phone_number_id, WABA id, business name, settings)
// reuses the `integrations` table (provider='whatsapp') exactly like Meta
// Ads does — no separate whatsapp_accounts table needed, same reasoning as
// every "one flexible table" decision in earlier phases.
db.exec(`
CREATE TABLE IF NOT EXISTS whatsapp_conversations (
  id             TEXT PRIMARY KEY,
  userId         TEXT NOT NULL,
  contactPhone   TEXT NOT NULL,
  conversationId TEXT NOT NULL, -- links to the existing conversations table, so
                                 -- WhatsApp and web chat share one history
  createdAt      TEXT NOT NULL,
  lastMessageAt  TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (conversationId) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_conv_user_phone ON whatsapp_conversations(userId, contactPhone);

CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id          TEXT PRIMARY KEY,
  messageId   TEXT,           -- links to the existing messages table (nullable — status
                               -- events reference a wa message that may arrive before content)
  waMessageId TEXT,
  direction   TEXT NOT NULL,  -- inbound|outbound
  type        TEXT,
  status      TEXT,           -- sent|delivered|read|failed
  createdAt   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_wa_msg_wamessageid ON whatsapp_messages(waMessageId);

-- Dedupes webhook deliveries — Meta/WhatsApp and Stripe both explicitly
-- document at-least-once delivery (the same event can arrive more than
-- once). 'id' is the source's own event/message id, namespaced per source
-- (e.g. "stripe:evt_...") where a source's own ids aren't already globally
-- unique across sources — see orchestrator/webhookDedup.js.
CREATE TABLE IF NOT EXISTS webhook_events (
  id         TEXT PRIMARY KEY,
  eventType  TEXT NOT NULL,
  receivedAt TEXT NOT NULL
);
`);

// ---- Phase 6: Automation & Workflow Engine ----
// Workflow variables (spec's `workflow_variables`) are deliberately not a
// separate table — a run's live variable state is a JSON blob on
// automation_runs, and default/initial values are a JSON blob on
// automations. Both are read/written as a whole per step, never queried
// column-by-column, so a normalized table would add joins without adding
// capability — same reasoning as every other "flexible JSON column" call
// made in earlier phases.
db.exec(`
CREATE TABLE IF NOT EXISTS automations (
  id            TEXT PRIMARY KEY,
  userId        TEXT NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  status        TEXT NOT NULL DEFAULT 'draft', -- draft|active|paused
  triggerType   TEXT NOT NULL, -- manual|schedule|webhook|whatsapp_message|meta_ads_event|ai_chat_request|knowledge_update|task_due
  triggerConfig TEXT,          -- JSON — e.g. { frequency, cron, timezone, hour, minute }
  variables     TEXT,          -- JSON — default/initial variables for a new run
  agentId       TEXT,          -- which agent's permissions/skills gate this workflow's tool calls
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL,
  lastRunAt     TEXT,
  nextRunAt     TEXT,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_automations_user ON automations(userId);
CREATE INDEX IF NOT EXISTS idx_automations_trigger ON automations(triggerType, status);

CREATE TABLE IF NOT EXISTS automation_steps (
  id            TEXT PRIMARY KEY,
  automationId  TEXT NOT NULL,
  stepOrder     INTEGER NOT NULL,
  type          TEXT NOT NULL, -- condition|ai_decision|action|delay|approval|loop|end
  config        TEXT,          -- JSON — shape depends on type, see automation/runner.js
  createdAt     TEXT NOT NULL,
  FOREIGN KEY (automationId) REFERENCES automations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_steps_automation ON automation_steps(automationId, stepOrder);

CREATE TABLE IF NOT EXISTS automation_runs (
  id             TEXT PRIMARY KEY,
  automationId   TEXT NOT NULL,
  userId         TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending', -- pending|running|awaiting_approval|completed|failed|cancelled
  triggerSource  TEXT,   -- what actually fired this run (manual|schedule|whatsapp_message|...)
  variables      TEXT,   -- JSON — live variable state for this run
  currentStep    INTEGER DEFAULT 0,
  error          TEXT,
  retryCount     INTEGER DEFAULT 0,
  startedAt      TEXT,
  endedAt        TEXT,
  createdAt      TEXT NOT NULL,
  FOREIGN KEY (automationId) REFERENCES automations(id) ON DELETE CASCADE,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_runs_automation ON automation_runs(automationId, createdAt);
CREATE INDEX IF NOT EXISTS idx_runs_user ON automation_runs(userId);

CREATE TABLE IF NOT EXISTS automation_logs (
  id        TEXT PRIMARY KEY,
  runId     TEXT NOT NULL,
  stepOrder INTEGER,
  stepType  TEXT,
  status    TEXT NOT NULL, -- started|completed|failed|skipped
  detail    TEXT,          -- JSON
  createdAt TEXT NOT NULL,
  FOREIGN KEY (runId) REFERENCES automation_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_logs_run ON automation_logs(runId, createdAt);

-- Starter templates users can clone into a real automation. Seeded once below.
CREATE TABLE IF NOT EXISTS workflow_templates (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  category      TEXT,
  triggerType   TEXT NOT NULL,
  triggerConfig TEXT,
  steps         TEXT NOT NULL -- JSON array of { type, config }, applied in order on clone
);

-- ---- Phase 6.5: Event-Driven Automation ----
-- Every published event lands here first — this IS the event history the
-- spec asks for, and its unique (source, eventId) index is the dedup
-- mechanism: a redelivered webhook or a repeated Meta/WhatsApp callback
-- collides on insert and is silently skipped, exactly like Phase 5's
-- webhook_events table did for WhatsApp alone. This generalizes that same
-- pattern to every event source.
CREATE TABLE IF NOT EXISTS automation_events (
  id                  TEXT PRIMARY KEY,
  userId              TEXT NOT NULL,
  source              TEXT NOT NULL, -- whatsapp|meta_ads|internal|webhook|schedule
  eventType           TEXT NOT NULL, -- e.g. whatsapp_message, campaign_paused, task_created
  eventId             TEXT,          -- source's own id for this event, when it has one
  payload             TEXT,          -- JSON — the variables this event exposes
  matchedAutomations  TEXT,          -- JSON array of automation ids this event matched
  status              TEXT NOT NULL DEFAULT 'received', -- received|queued|processed
  createdAt           TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_dedupe ON automation_events(source, eventId);
CREATE INDEX IF NOT EXISTS idx_events_user ON automation_events(userId, createdAt);

-- The execution queue. Workflows are never run directly inside a webhook
-- handler — an event enqueues one row per matched automation here, and a
-- background tick processes them. This is an in-process, DB-backed queue
-- (no Redis/BullMQ in this stack) — durable across a restart, but not
-- distributed. See PHASE6.5_NOTES.md for what that does and doesn't cover.
CREATE TABLE IF NOT EXISTS automation_event_queue (
  id            TEXT PRIMARY KEY,
  eventId       TEXT NOT NULL,
  automationId  TEXT NOT NULL,
  userId        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued', -- queued|processing|completed|failed|dead_letter
  attempts      INTEGER NOT NULL DEFAULT 0,
  lastError     TEXT,
  createdAt     TEXT NOT NULL,
  processedAt   TEXT,
  FOREIGN KEY (eventId) REFERENCES automation_events(id) ON DELETE CASCADE,
  FOREIGN KEY (automationId) REFERENCES automations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_queue_status ON automation_event_queue(status, createdAt);
`);

// Additive migration: link approvals to an automation run, so workflow
// approval steps reuse the exact same confirmation_requests table and
// approve/reject UI built in Phase 2 — no parallel approval system.
const confirmCols = db.prepare("PRAGMA table_info(confirmation_requests)").all().map((c) => c.name);
if (!confirmCols.includes("automationRunId")) {
  db.exec("ALTER TABLE confirmation_requests ADD COLUMN automationRunId TEXT");
}

// --- Phase 8: Agent Manager core — extends the existing `agents` table
// rather than replacing it. `version` increments on every edit; the actual
// history of what changed lives in `agent_versions` below, so `agents`
// itself only ever needs to hold current state.
const agentCols = db.prepare("PRAGMA table_info(agents)").all().map((c) => c.name);
if (!agentCols.includes("avatar")) db.exec("ALTER TABLE agents ADD COLUMN avatar TEXT");
if (!agentCols.includes("category")) db.exec("ALTER TABLE agents ADD COLUMN category TEXT DEFAULT 'general'");
if (!agentCols.includes("version")) db.exec("ALTER TABLE agents ADD COLUMN version INTEGER NOT NULL DEFAULT 1");
if (!agentCols.includes("aiProvider")) db.exec("ALTER TABLE agents ADD COLUMN aiProvider TEXT"); // NULL = platform default (AI_PROVIDER env)
if (!agentCols.includes("aiModel")) db.exec("ALTER TABLE agents ADD COLUMN aiModel TEXT"); // NULL = that provider's default model
if (!agentCols.includes("orgId")) db.exec("ALTER TABLE agents ADD COLUMN orgId TEXT"); // NULL = personal agent (default, unchanged behavior)
if (!agentCols.includes("workspaceId")) db.exec("ALTER TABLE agents ADD COLUMN workspaceId TEXT"); // set only when scoped to one workspace, not the whole org
// Which Agent Library template (server/orchestrator/agentLibrary.js) this
// agent was installed from, if any — NULL for agents built from scratch.
// Fixing a template's instructions (a real, recurring need — see the Meta
// Ads Manager fixes this same session) previously had no way to reach
// customers who already installed it; every prior installer was stuck on
// whatever text existed at install time forever. templateSyncedInstructions
// is a snapshot of the instructions text as of the last install/sync —
// comparing it against the agent's CURRENT instructions tells an update
// whether the customer has hand-edited their copy since (and must not be
// silently overwritten), independent of comparing against the template's
// latest text (which tells it whether an update exists at all).
if (!agentCols.includes("templateId")) db.exec("ALTER TABLE agents ADD COLUMN templateId TEXT");
if (!agentCols.includes("templateSyncedInstructions")) db.exec("ALTER TABLE agents ADD COLUMN templateSyncedInstructions TEXT");

const execCols = db.prepare("PRAGMA table_info(tool_executions)").all().map((c) => c.name);
if (!execCols.includes("agentId")) db.exec("ALTER TABLE tool_executions ADD COLUMN agentId TEXT");


// Phase 9: Shared Automations — same additive pattern as Shared Agents.
// A user who never touches organizations keeps every automation exactly
// as "Personal" (orgId NULL), unchanged from before this migration.
const automationCols = db.prepare("PRAGMA table_info(automations)").all().map((c) => c.name);
if (!automationCols.includes("orgId")) db.exec("ALTER TABLE automations ADD COLUMN orgId TEXT");
if (!automationCols.includes("workspaceId")) db.exec("ALTER TABLE automations ADD COLUMN workspaceId TEXT");
if (!automationCols.includes("version")) db.exec("ALTER TABLE automations ADD COLUMN version INTEGER NOT NULL DEFAULT 1");

db.exec(`
CREATE TABLE IF NOT EXISTS automation_versions (
  id            TEXT PRIMARY KEY,
  automationId  TEXT NOT NULL,
  version       INTEGER NOT NULL,
  snapshot      TEXT NOT NULL, -- JSON: {name, description, triggerType, triggerConfig, variables, agentId, orgId, workspaceId, steps}
  note          TEXT,
  createdAt     TEXT NOT NULL,
  FOREIGN KEY (automationId) REFERENCES automations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_automation_versions_automation ON automation_versions(automationId);
`);

// Phase 9: Shared Integrations. users.activeOrgId is the persisted (not
// just session-only) "which org am I currently operating in" flag — this
// lets getConnection() resolve org context from userId alone, so the 80+
// existing tool call sites (getConnection(userId, provider)) don't need to
// change at all to benefit from org-shared connections. integrations.orgId
// marks a connection row as org-owned; NULL (the default, unchanged for
// every existing row) means personal, exactly as before this migration.
const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userCols.includes("activeOrgId")) db.exec("ALTER TABLE users ADD COLUMN activeOrgId TEXT");
if (!userCols.includes("isPlatformAdmin")) db.exec("ALTER TABLE users ADD COLUMN isPlatformAdmin INTEGER NOT NULL DEFAULT 0");
if (!userCols.includes("stripeCustomerId")) db.exec("ALTER TABLE users ADD COLUMN stripeCustomerId TEXT"); // for personal Marketplace purchases — distinct from the per-org subscription customer
if (!userCols.includes("onboardingCompletedAt")) db.exec("ALTER TABLE users ADD COLUMN onboardingCompletedAt TEXT"); // Phase 21 — NULL means the first-run onboarding flow hasn't been shown/finished yet

const integrationOrgCols = db.prepare("PRAGMA table_info(integrations)").all().map((c) => c.name);
if (!integrationOrgCols.includes("orgId")) db.exec("ALTER TABLE integrations ADD COLUMN orgId TEXT");

// Phase 18.1 §2 fix: idx_int_user_provider (added above, before orgId
// existed) is a UNIQUE index on just (userId, provider) — it never learned
// about org-shared connections. In practice this means a user who already
// has a personal connection for a provider can't also be the connector for
// an org-level connection of that same provider (and the same user can't
// connect that provider for two different orgs either) — saveOrgConnection
// would hit a raw SQLite UNIQUE constraint violation. Split it into two
// partial indexes matching how getConnection()/saveConnection() and
// getOrgConnection()/saveOrgConnection() actually scope rows: personal
// connections stay unique per (userId, provider), org connections are
// unique per (orgId, provider) instead — a single connecting user can now
// own both, and be the connector for multiple orgs.
db.exec("DROP INDEX IF EXISTS idx_int_user_provider");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_int_user_provider_personal ON integrations(userId, provider) WHERE orgId IS NULL");
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_int_org_provider ON integrations(orgId, provider) WHERE orgId IS NOT NULL");

// Phase 9: Projects. Belong to a workspace. Rather than adding a projectId
// column to five different existing tables (tasks, agents, knowledge_items,
// automations, conversations), one generic link table records "this project
// includes this item" — additive, and each existing table stays untouched.
db.exec(`
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active', -- active | archived
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_projects_workspace ON projects(workspaceId);

CREATE TABLE IF NOT EXISTS project_items (
  id        TEXT PRIMARY KEY,
  projectId TEXT NOT NULL,
  itemType  TEXT NOT NULL, -- task | agent | knowledge | automation | conversation
  itemId    TEXT NOT NULL,
  addedAt   TEXT NOT NULL,
  FOREIGN KEY (projectId) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_item_unique ON project_items(projectId, itemType, itemId);
`);

// Phase 9: Audit Logs. Extends the existing activity_logs table (used since
// Phase 1) rather than creating a parallel table — same events, richer
// context. All four new columns are nullable/defaulted, so every existing
// logActivity(db, userId, action, description) call site (there are many)
// keeps working exactly as before, just without the new fields populated
// unless the caller opts in to the richer form.
const activityCols = db.prepare("PRAGMA table_info(activity_logs)").all().map((c) => c.name);
if (!activityCols.includes("orgId")) db.exec("ALTER TABLE activity_logs ADD COLUMN orgId TEXT");
if (!activityCols.includes("workspaceId")) db.exec("ALTER TABLE activity_logs ADD COLUMN workspaceId TEXT");
if (!activityCols.includes("ip")) db.exec("ALTER TABLE activity_logs ADD COLUMN ip TEXT");
if (!activityCols.includes("result")) db.exec("ALTER TABLE activity_logs ADD COLUMN result TEXT NOT NULL DEFAULT 'success'"); // success | failure

// --- Phase 9: Collaboration — comments (with @mentions), task assignment,
// and a real Notification Center. All additive; a user who never uses any
// of this sees an empty notification list and untouched task behavior. ---
const taskCols = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
if (!taskCols.includes("assignedToUserId")) db.exec("ALTER TABLE tasks ADD COLUMN assignedToUserId TEXT");
// orgId/updatedAt: additive, same "NULL = personal, unchanged default
// behavior" pattern as agents.orgId — needed so the Public API (Phase 17),
// which is inherently org-scoped via the API key, has a real tenant
// boundary to filter tasks on; a personal (orgId NULL) task simply isn't
// reachable via any org's API key, same as a personal agent already isn't.
if (!taskCols.includes("orgId")) db.exec("ALTER TABLE tasks ADD COLUMN orgId TEXT");
if (!taskCols.includes("updatedAt")) db.exec("ALTER TABLE tasks ADD COLUMN updatedAt TEXT");

db.exec(`
CREATE TABLE IF NOT EXISTS comments (
  id              TEXT PRIMARY KEY,
  entityType      TEXT NOT NULL, -- task | project | automation | agent | knowledge
  entityId        TEXT NOT NULL,
  authorUserId    TEXT NOT NULL,
  content         TEXT NOT NULL,
  mentionedUserIds TEXT NOT NULL DEFAULT '[]', -- JSON array, resolved from @mentions at write time
  createdAt       TEXT NOT NULL,
  FOREIGN KEY (authorUserId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_comments_entity ON comments(entityType, entityId);

CREATE TABLE IF NOT EXISTS notifications (
  id        TEXT PRIMARY KEY,
  userId    TEXT NOT NULL,
  type      TEXT NOT NULL, -- mention | assignment | approval | automation_failure | integration_error | org_invitation
  title     TEXT NOT NULL,
  body      TEXT,
  link      TEXT,          -- client-side path to navigate to, e.g. /app/tasks
  read      INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(userId, read);

-- Phase 12D: mobile push. One row per device the user has ever logged in
-- on — token is unique so re-registering the same device (app reinstall,
-- token refresh) just updates the row instead of accumulating duplicates.
CREATE TABLE IF NOT EXISTS device_tokens (
  id        TEXT PRIMARY KEY,
  userId    TEXT NOT NULL,
  token     TEXT NOT NULL UNIQUE,
  platform  TEXT NOT NULL DEFAULT 'android', -- android | ios
  createdAt TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(userId);
`);

// --- Phase 10: Billing, Subscriptions & Usage ---
// Deliberate design boundary, consistent with every prior phase: billing is
// entirely organization-scoped. A user with no organization has no
// subscription, no quotas, no usage tracking — personal/individual mode
// stays completely unmetered, exactly as it's always been. Orgs are the
// billable unit, matching the spec's own "Organization Billing" section.
db.exec(`
CREATE TABLE IF NOT EXISTS plans (
  id                TEXT PRIMARY KEY, -- 'free' | 'starter' | 'professional' | 'business' | 'enterprise'
  name              TEXT NOT NULL,
  monthlyPriceCents INTEGER NOT NULL DEFAULT 0,
  maxUsers          INTEGER,          -- NULL = unlimited
  maxAgents         INTEGER,
  maxAutomations    INTEGER,
  maxIntegrations   INTEGER,
  maxAiRequests     INTEGER,          -- per billing period
  apiAccess         INTEGER NOT NULL DEFAULT 0,
  marketplaceAccess INTEGER NOT NULL DEFAULT 0,
  stripePriceId     TEXT,             -- Stripe Price object id; NULL = not checkout-able (e.g. Free, Enterprise)
  createdAt         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id                 TEXT PRIMARY KEY,
  orgId              TEXT NOT NULL UNIQUE,
  planId             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active', -- trialing | active | past_due | canceled
  billingMode        TEXT NOT NULL DEFAULT 'platform_managed', -- platform_managed | byok
  trialEndsAt        TEXT,
  currentPeriodStart TEXT NOT NULL,
  currentPeriodEnd   TEXT NOT NULL,
  cancelAtPeriodEnd  INTEGER NOT NULL DEFAULT 0,
  stripeCustomerId     TEXT,
  stripeSubscriptionId TEXT,
  createdAt          TEXT NOT NULL,
  updatedAt          TEXT NOT NULL,
  FOREIGN KEY (orgId) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (planId) REFERENCES plans(id)
);

-- Raw event-level usage log — one row per metered event. Kept separate from
-- the rollup table below so nothing is ever lost even if the rollup logic
-- changes later; the rollup is a derived cache, this is the source of truth.
CREATE TABLE IF NOT EXISTS usage_records (
  id        TEXT PRIMARY KEY,
  orgId     TEXT NOT NULL,
  type      TEXT NOT NULL, -- ai_request | prompt_tokens | completion_tokens | automation_execution | tool_call | api_call
  quantity  INTEGER NOT NULL DEFAULT 1,
  metadata  TEXT,           -- JSON: e.g. { provider, model, toolName }
  createdAt TEXT NOT NULL,
  FOREIGN KEY (orgId) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_usage_org_period ON usage_records(orgId, createdAt);

-- Per-org, per-billing-period rollup — what quota checks actually read, so
-- checking a quota never means scanning the full usage_records history.
CREATE TABLE IF NOT EXISTS organization_usage (
  orgId               TEXT NOT NULL,
  period              TEXT NOT NULL, -- 'YYYY-MM'
  aiRequests          INTEGER NOT NULL DEFAULT 0,
  promptTokens        INTEGER NOT NULL DEFAULT 0,
  completionTokens    INTEGER NOT NULL DEFAULT 0,
  automationExecutions INTEGER NOT NULL DEFAULT 0,
  toolCalls           INTEGER NOT NULL DEFAULT 0,
  apiCalls            INTEGER NOT NULL DEFAULT 0,
  updatedAt           TEXT NOT NULL,
  PRIMARY KEY (orgId, period)
);

-- BYOK. Keys are AES-256-GCM encrypted at rest (see orchestrator/apiKeys.js)
-- — the raw key is never stored, logged, or returned by any API response.
CREATE TABLE IF NOT EXISTS api_keys (
  id            TEXT PRIMARY KEY,
  orgId         TEXT NOT NULL,
  provider      TEXT NOT NULL, -- openai | anthropic | gemini
  encryptedKey  TEXT NOT NULL, -- iv:authTag:ciphertext, all hex
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL,
  FOREIGN KEY (orgId) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_org_provider ON api_keys(orgId, provider);

-- Platform-issued coupons (trials, discounts). Created by a platform admin
-- (see users.isPlatformAdmin), redeemed by any org owner/admin for their
-- own org. Discount coupons record the intended discount for the eventual
-- Stripe checkout flow to apply — no real charge exists yet to discount.
CREATE TABLE IF NOT EXISTS coupon_codes (
  id             TEXT PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE,
  type           TEXT NOT NULL, -- trial | percent_discount | fixed_discount
  value          INTEGER NOT NULL, -- trial: days; percent_discount: 0-100; fixed_discount: cents
  targetPlanId   TEXT,           -- for trial coupons: which plan the trial is on; NULL = current plan
  maxRedemptions INTEGER,        -- NULL = unlimited
  redemptionCount INTEGER NOT NULL DEFAULT 0,
  expiresAt      TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  createdBy      TEXT NOT NULL,
  createdAt      TEXT NOT NULL,
  FOREIGN KEY (createdBy) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS coupon_redemptions (
  id         TEXT PRIMARY KEY,
  couponId   TEXT NOT NULL,
  orgId      TEXT NOT NULL,
  redeemedAt TEXT NOT NULL,
  FOREIGN KEY (couponId) REFERENCES coupon_codes(id) ON DELETE CASCADE,
  FOREIGN KEY (orgId) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_coupon_redemption_unique ON coupon_redemptions(couponId, orgId);

-- Populated by the Stripe webhook handler (invoice.paid /
-- invoice.payment_failed) — never written to directly by any user action,
-- since these mirror what Stripe itself says happened.
CREATE TABLE IF NOT EXISTS invoices (
  id              TEXT PRIMARY KEY,
  orgId           TEXT NOT NULL,
  stripeInvoiceId TEXT NOT NULL UNIQUE,
  amountCents     INTEGER NOT NULL,
  status          TEXT NOT NULL, -- paid | open | void | uncollectible
  invoiceNumber   TEXT,
  pdfUrl          TEXT,
  periodStart     TEXT,
  periodEnd       TEXT,
  createdAt       TEXT NOT NULL,
  FOREIGN KEY (orgId) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_invoices_org ON invoices(orgId);

-- Dedupes quota-threshold notifications — without this, every single quota
-- check above 50% would fire another notification, which would be useless
-- noise. One row per (org, billing period, quota type, threshold) means
-- "already warned this org about this quota crossing this line this month."
CREATE TABLE IF NOT EXISTS quota_warnings_sent (
  orgId     TEXT NOT NULL,
  period    TEXT NOT NULL,
  quotaType TEXT NOT NULL,
  threshold INTEGER NOT NULL, -- 50 | 75 | 90 | 100
  sentAt    TEXT NOT NULL,
  PRIMARY KEY (orgId, period, quotaType, threshold)
);

-- Local audit trail for credit grants — the running balance is just
-- SUM(amountCents) for an org. When Stripe is configured, a grant is also
-- applied as a real Stripe Customer Balance transaction (see
-- stripeService.applyCustomerBalance) so it actually reduces what they owe;
-- this table is what survives regardless of whether that sync succeeds, and
-- is the only source of truth when Stripe isn't connected at all.
CREATE TABLE IF NOT EXISTS organization_credits (
  id           TEXT PRIMARY KEY,
  orgId        TEXT NOT NULL,
  amountCents  INTEGER NOT NULL, -- positive = credit granted
  reason       TEXT,
  grantedBy    TEXT NOT NULL,
  stripeSynced INTEGER NOT NULL DEFAULT 0,
  createdAt    TEXT NOT NULL,
  FOREIGN KEY (orgId) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (grantedBy) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_org_credits_org ON organization_credits(orgId);

-- Phase 11: Marketplace Core + Publishing. Scoped to the four asset types
-- that are already fully data-driven in this codebase (agent configs,
-- automation configs, prompt text, and knowledge item bundles) — none of
-- them need new execution infrastructure to exist as a catalog entry.
-- "Skill"/"Plugin"/"Integration Connector" assets need the Developer SDK
-- (a later Phase 11 slice) to mean anything beyond a name in a list.
CREATE TABLE IF NOT EXISTS marketplace_categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  description TEXT,
  createdAt   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS marketplace_assets (
  id                   TEXT PRIMARY KEY,
  creatorUserId        TEXT NOT NULL,
  assetType            TEXT NOT NULL, -- agent | automation | prompt | knowledge_pack
  name                 TEXT NOT NULL,
  slug                 TEXT NOT NULL UNIQUE,
  description          TEXT,
  categoryId           TEXT,
  tags                 TEXT NOT NULL DEFAULT '[]', -- JSON array
  pricingType          TEXT NOT NULL DEFAULT 'free', -- free | one_time | subscription
  priceCents           INTEGER NOT NULL DEFAULT 0,
  license              TEXT,
  visibility           TEXT NOT NULL DEFAULT 'public', -- public | unlisted | private
  status               TEXT NOT NULL DEFAULT 'draft', -- draft | published | unpublished
  currentVersionId     TEXT,
  platformVersionNote  TEXT, -- free-text compatibility note; no real platform-version scheme exists to check against yet
  downloadCount        INTEGER NOT NULL DEFAULT 0,
  ratingSum            INTEGER NOT NULL DEFAULT 0,
  ratingCount          INTEGER NOT NULL DEFAULT 0,
  createdAt            TEXT NOT NULL,
  updatedAt            TEXT NOT NULL,
  FOREIGN KEY (creatorUserId) REFERENCES users(id),
  FOREIGN KEY (categoryId) REFERENCES marketplace_categories(id)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_assets_creator ON marketplace_assets(creatorUserId);
CREATE INDEX IF NOT EXISTS idx_marketplace_assets_status ON marketplace_assets(status, visibility);
CREATE INDEX IF NOT EXISTS idx_marketplace_assets_type ON marketplace_assets(assetType);

-- One row per published version — the manifest is the actual asset
-- content (agent config, automation steps, prompt text, or knowledge item
-- bundle), shaped differently depending on assetType. Snapshotted at
-- publish time, not a live link back to the source agent/automation, so
-- editing your own agent later doesn't retroactively change what people
-- already installed.
CREATE TABLE IF NOT EXISTS asset_versions (
  id           TEXT PRIMARY KEY,
  assetId      TEXT NOT NULL,
  version      TEXT NOT NULL, -- semver-ish string, e.g. '1.0.0'
  releaseNotes TEXT,
  manifest     TEXT NOT NULL, -- JSON, shape depends on assetType
  createdAt    TEXT NOT NULL,
  FOREIGN KEY (assetId) REFERENCES marketplace_assets(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_asset_versions_asset ON asset_versions(assetId);

-- Tracks what got installed, from which version, and what REAL entity it
-- created (an actual agent/automation row, or knowledge_items rows) — this
-- is what update/rollback/enable/disable/uninstall operate on. Installing
-- never creates a parallel "marketplace copy" of anything; it always
-- creates the same kind of row a normal create action would, through the
-- same creation functions (agentManager.createAgent, automation
-- engine.createAutomation, knowledge_items inserts).
CREATE TABLE IF NOT EXISTS marketplace_installs (
  id                  TEXT PRIMARY KEY,
  assetId             TEXT NOT NULL,
  installedVersionId  TEXT NOT NULL,
  installedByUserId   TEXT NOT NULL,
  installedEntityType TEXT NOT NULL, -- agent | automation | knowledge_item
  installedEntityIds  TEXT NOT NULL, -- JSON array — usually one id, multiple for a knowledge_pack
  status              TEXT NOT NULL DEFAULT 'active', -- active | disabled | uninstalled
  createdAt           TEXT NOT NULL,
  updatedAt           TEXT NOT NULL,
  FOREIGN KEY (assetId) REFERENCES marketplace_assets(id) ON DELETE CASCADE,
  FOREIGN KEY (installedByUserId) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_marketplace_installs_user ON marketplace_installs(installedByUserId);
CREATE INDEX IF NOT EXISTS idx_marketplace_installs_asset ON marketplace_installs(assetId);

-- Phase 11: Ratings & Reviews. One review per (asset, user) — reviewing
-- again edits the existing one rather than creating a duplicate. Rating
-- aggregates on marketplace_assets (ratingSum/ratingCount) are recomputed
-- from this table directly on every write, not maintained incrementally,
-- since review writes are rare and a direct recompute can never drift out
-- of sync the way an increment/decrement dance could.
CREATE TABLE IF NOT EXISTS asset_reviews (
  id               TEXT PRIMARY KEY,
  assetId          TEXT NOT NULL,
  userId           TEXT NOT NULL,
  rating           INTEGER NOT NULL, -- 1-5
  reviewText       TEXT,
  developerReply   TEXT,
  developerReplyAt TEXT,
  helpfulCount     INTEGER NOT NULL DEFAULT 0,
  createdAt        TEXT NOT NULL,
  updatedAt        TEXT NOT NULL,
  FOREIGN KEY (assetId) REFERENCES marketplace_assets(id) ON DELETE CASCADE,
  FOREIGN KEY (userId) REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_reviews_unique ON asset_reviews(assetId, userId);
CREATE INDEX IF NOT EXISTS idx_asset_reviews_asset ON asset_reviews(assetId);

CREATE TABLE IF NOT EXISTS asset_review_votes (
  reviewId TEXT NOT NULL,
  userId   TEXT NOT NULL,
  createdAt TEXT NOT NULL,
  PRIMARY KEY (reviewId, userId)
);

-- Phase 11: Payments. Only one-time purchases are supported — Stripe
-- Checkout can price a one-time payment dynamically (price_data) with no
-- pre-created Price object, so a creator never has to touch the Stripe
-- dashboard. Subscription-priced assets would need a real Stripe Price
-- object per asset (Checkout can't do dynamic recurring prices) — that's a
-- disclosed scope cut, not built here.
CREATE TABLE IF NOT EXISTS asset_purchases (
  id                      TEXT PRIMARY KEY,
  assetId                 TEXT NOT NULL,
  buyerUserId             TEXT NOT NULL,
  sellerUserId            TEXT NOT NULL,
  amountCents             INTEGER NOT NULL,
  platformCommissionCents INTEGER NOT NULL,
  sellerNetCents          INTEGER NOT NULL,
  stripeCheckoutSessionId TEXT UNIQUE,
  status                  TEXT NOT NULL DEFAULT 'completed', -- completed | refunded
  createdAt               TEXT NOT NULL,
  FOREIGN KEY (assetId) REFERENCES marketplace_assets(id) ON DELETE CASCADE,
  FOREIGN KEY (buyerUserId) REFERENCES users(id),
  FOREIGN KEY (sellerUserId) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_asset_purchases_buyer ON asset_purchases(buyerUserId);
CREATE INDEX IF NOT EXISTS idx_asset_purchases_seller ON asset_purchases(sellerUserId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_purchases_buyer_asset ON asset_purchases(buyerUserId, assetId);

-- Phase 11: Moderation. Abuse reports — any user can file one; platform
-- admins resolve or dismiss.
CREATE TABLE IF NOT EXISTS asset_reports (
  id           TEXT PRIMARY KEY,
  assetId      TEXT NOT NULL,
  reporterUserId TEXT NOT NULL,
  reason       TEXT NOT NULL,
  details      TEXT,
  status       TEXT NOT NULL DEFAULT 'open', -- open | resolved | dismissed
  resolvedBy   TEXT,
  resolvedAt   TEXT,
  createdAt    TEXT NOT NULL,
  FOREIGN KEY (assetId) REFERENCES marketplace_assets(id) ON DELETE CASCADE,
  FOREIGN KEY (reporterUserId) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_asset_reports_status ON asset_reports(status);

-- Phase 11: Developer SDK. A "custom tool" is a webhook — when an agent
-- calls it, this platform POSTs the parameters to the developer's own
-- endpoint (HMAC-signed so they can verify it's really us) and uses
-- whatever JSON that endpoint returns as the result. This is the only
-- safe way to let third parties extend agent behavior without running
-- arbitrary third-party code on this server — the developer's actual
-- logic runs on THEIR infrastructure, not ours.
CREATE TABLE IF NOT EXISTS custom_tools (
  id                  TEXT PRIMARY KEY,
  creatorUserId       TEXT NOT NULL,
  name                TEXT NOT NULL UNIQUE, -- 'custom.<slug>' — the '.' prefix keeps it visually distinct from built-in tools everywhere it's listed
  description         TEXT NOT NULL,
  parametersSchema    TEXT NOT NULL DEFAULT '{"type":"object","properties":{},"required":[]}',
  webhookUrl          TEXT NOT NULL,
  webhookSecret       TEXT NOT NULL, -- used to HMAC-sign the outbound request body
  requiresConfirmation INTEGER NOT NULL DEFAULT 1, -- developer's own safety knob for their tool
  status              TEXT NOT NULL DEFAULT 'draft', -- draft | published | disabled
  createdAt           TEXT NOT NULL,
  updatedAt           TEXT NOT NULL,
  FOREIGN KEY (creatorUserId) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_custom_tools_creator ON custom_tools(creatorUserId);
`);

// moderationStatus defaults to 'approved' — every asset published before
// Moderation existed stays exactly as visible as it always was. Only NEW
// publishes (from here forward) actually enter the 'pending' review queue;
// see marketplace.js's setAssetStatus.
const marketplaceAssetCols = db.prepare("PRAGMA table_info(marketplace_assets)").all().map((c) => c.name);
if (!marketplaceAssetCols.includes("moderationStatus")) db.exec("ALTER TABLE marketplace_assets ADD COLUMN moderationStatus TEXT NOT NULL DEFAULT 'approved'");
if (!marketplaceAssetCols.includes("moderationNote")) db.exec("ALTER TABLE marketplace_assets ADD COLUMN moderationNote TEXT");

const seedCategories = [
  ["marketing", "Marketing", "Campaign planning, ad copy, content agents and automations."],
  ["sales", "Sales", "Lead handling, outreach, and pipeline automations."],
  ["support", "Customer Support", "Support agents, ticket automations, response templates."],
  ["ecommerce", "E-commerce", "Store management for WooCommerce, Shopify, and similar."],
  ["seo", "SEO & Content", "Content writing, SEO research, and publishing workflows."],
  ["productivity", "Productivity", "General task, email, and workflow automation."],
  ["analytics", "Analytics & Reporting", "Business analysis and reporting agents/automations."],
  ["developer", "Developer Tools", "Automation building blocks and technical workflows."],
];
const insertCategory = db.prepare("INSERT OR IGNORE INTO marketplace_categories (id, name, slug, description, createdAt) VALUES (?, ?, ?, ?, ?)");
for (const [slug, name, description] of seedCategories) {
  insertCategory.run(slug, name, slug, description, new Date().toISOString());
}

// Seed the five plans from the spec (idempotent — INSERT OR IGNORE so
// re-running never clobbers an admin's manual price/limit edits).
// Migrate existing plans/subscriptions rows (CREATE TABLE IF NOT EXISTS above
// only affects a fresh database — anyone who already has these tables from
// an earlier phase needs the new Stripe columns added explicitly).
const planCols = db.prepare("PRAGMA table_info(plans)").all().map((c) => c.name);
if (!planCols.includes("stripePriceId")) db.exec("ALTER TABLE plans ADD COLUMN stripePriceId TEXT");

const subCols = db.prepare("PRAGMA table_info(subscriptions)").all().map((c) => c.name);
if (!subCols.includes("stripeCustomerId")) db.exec("ALTER TABLE subscriptions ADD COLUMN stripeCustomerId TEXT");
if (!subCols.includes("stripeSubscriptionId")) db.exec("ALTER TABLE subscriptions ADD COLUMN stripeSubscriptionId TEXT");

const seedPlans = [
  ["free", "Free", 0, 3, 2, 3, 1, 50, 0, 0],
  ["starter", "Starter", 2900, 10, 10, 10, 5, 500, 0, 0],
  ["professional", "Professional", 9900, 25, 30, 30, 20, 2500, 1, 0],
  ["business", "Business", 29900, 100, 100, 100, 100, 10000, 1, 1],
  ["enterprise", "Enterprise", 0, null, null, null, null, null, 1, 1], // NULL = unlimited; enterprise pricing is custom (0 = "contact us"), not a real $0 plan
];
const insertPlan = db.prepare(
  `INSERT OR IGNORE INTO plans (id, name, monthlyPriceCents, maxUsers, maxAgents, maxAutomations, maxIntegrations, maxAiRequests, apiAccess, marketplaceAccess, createdAt)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
for (const [id, name, price, maxUsers, maxAgents, maxAutomations, maxIntegrations, maxAiRequests, apiAccess, marketplaceAccess] of seedPlans) {
  insertPlan.run(id, name, price, maxUsers, maxAgents, maxAutomations, maxIntegrations, maxAiRequests, apiAccess, marketplaceAccess, new Date().toISOString());
}

// --- Phase 8: per-agent memory isolation + knowledge sharing controls.
// agentId/ownerAgentId is nullable — NULL means "general", created outside
// any specific agent's context (e.g. plain chat), and stays visible to every
// agent exactly as all memories/knowledge were before this migration. Only
// an item explicitly owned by one agent AND marked 'private' becomes
// invisible to other agents — so nothing existing changes behavior.
const memCols = db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
if (!memCols.includes("agentId")) db.exec("ALTER TABLE memories ADD COLUMN agentId TEXT");
if (!memCols.includes("visibility")) db.exec("ALTER TABLE memories ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared'");

const knowledgeCols = db.prepare("PRAGMA table_info(knowledge_items)").all().map((c) => c.name);
if (!knowledgeCols.includes("ownerAgentId")) db.exec("ALTER TABLE knowledge_items ADD COLUMN ownerAgentId TEXT");
if (!knowledgeCols.includes("visibility")) db.exec("ALTER TABLE knowledge_items ADD COLUMN visibility TEXT NOT NULL DEFAULT 'shared'");
if (!knowledgeCols.includes("editable")) db.exec("ALTER TABLE knowledge_items ADD COLUMN editable TEXT NOT NULL DEFAULT 'editable'"); // 'editable' | 'read_only' — only meaningful when visibility = 'shared'

// Phase 9: cross-USER sharing (org/workspace), layered on top of the
// Phase 8 columns above which govern sharing between one account's OWN
// agents. These are independent concerns — a knowledge item can be
// 'shared' among your own agents (Phase 8) while still being 'private'
// across other people (Phase 9), or vice versa. Defaults are the most
// restrictive (private, read_only), so nothing existing becomes newly
// visible to other accounts just from this migration running.
if (!knowledgeCols.includes("orgId")) db.exec("ALTER TABLE knowledge_items ADD COLUMN orgId TEXT");
if (!knowledgeCols.includes("workspaceId")) db.exec("ALTER TABLE knowledge_items ADD COLUMN workspaceId TEXT");
if (!knowledgeCols.includes("crossUserVisibility")) db.exec("ALTER TABLE knowledge_items ADD COLUMN crossUserVisibility TEXT NOT NULL DEFAULT 'private'"); // private|workspace|organization|public
if (!knowledgeCols.includes("crossUserEditable")) db.exec("ALTER TABLE knowledge_items ADD COLUMN crossUserEditable TEXT NOT NULL DEFAULT 'read_only'"); // editable|read_only — only meaningful when crossUserVisibility isn't 'private'

// --- Phase 9: Organizations, Workspaces, RBAC core ---
// Nothing existing is touched by this — a user who never creates or joins
// an organization keeps working exactly as before ("personal mode").
// Organization scoping for agents/knowledge/automations/integrations is a
// deliberately separate, later slice — this just lays the foundation.
db.exec(`
CREATE TABLE IF NOT EXISTS organizations (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  logoUrl   TEXT,
  ownerId   TEXT NOT NULL,
  status    TEXT NOT NULL DEFAULT 'active', -- active | suspended
  settings  TEXT NOT NULL DEFAULT '{}',      -- JSON, org-level preferences
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  FOREIGN KEY (ownerId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS organization_members (
  id           TEXT PRIMARY KEY,
  orgId        TEXT NOT NULL,
  userId       TEXT,          -- NULL until an invitation is matched/accepted
  invitedEmail TEXT,          -- set for invitations; kept even after userId is filled in, for history
  role         TEXT NOT NULL DEFAULT 'member', -- owner | admin | manager | member | viewer | <custom role id>
  status       TEXT NOT NULL DEFAULT 'active', -- active | invited | suspended
  invitedAt    TEXT,
  joinedAt     TEXT,
  FOREIGN KEY (orgId) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(orgId);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(userId);
CREATE UNIQUE INDEX IF NOT EXISTS idx_org_member_unique ON organization_members(orgId, userId) WHERE userId IS NOT NULL;

CREATE TABLE IF NOT EXISTS custom_roles (
  id          TEXT PRIMARY KEY,
  orgId       TEXT NOT NULL,
  name        TEXT NOT NULL,
  permissions TEXT NOT NULL, -- JSON array of permission keys, e.g. ["agent_management","knowledge"]
  createdAt   TEXT NOT NULL,
  FOREIGN KEY (orgId) REFERENCES organizations(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  orgId       TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  category    TEXT NOT NULL DEFAULT 'general', -- marketing|sales|support|finance|development|hr|general
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  FOREIGN KEY (orgId) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_workspaces_org ON workspaces(orgId);

CREATE TABLE IF NOT EXISTS workspace_members (
  id          TEXT PRIMARY KEY,
  workspaceId TEXT NOT NULL,
  userId      TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',
  createdAt   TEXT NOT NULL,
  FOREIGN KEY (workspaceId) REFERENCES workspaces(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_member_unique ON workspace_members(workspaceId, userId);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS agent_versions (
  id        TEXT PRIMARY KEY,
  agentId   TEXT NOT NULL,
  version   INTEGER NOT NULL,
  snapshot  TEXT NOT NULL, -- JSON: {name, description, instructions, personality, avatar, category, skillIds}
  note      TEXT,          -- optional human note, e.g. "cloned from Marketing Manager"
  createdAt TEXT NOT NULL,
  FOREIGN KEY (agentId) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_versions_agent ON agent_versions(agentId);

CREATE TABLE IF NOT EXISTS agent_messages (
  id             TEXT PRIMARY KEY,
  userId         TEXT NOT NULL,
  fromAgentId    TEXT NOT NULL,
  toAgentId      TEXT NOT NULL,
  type           TEXT NOT NULL DEFAULT 'delegate_task', -- ask | delegate_task | request_info | share_result | request_approval | return_output
  content        TEXT NOT NULL, -- the task/question sent to the target agent
  conversationId TEXT,          -- the conversation the target agent handled this in — reuses existing chat UI/history
  status         TEXT NOT NULL DEFAULT 'pending', -- pending | completed | failed
  result         TEXT,          -- the target agent's reply, once completed
  error          TEXT,
  createdAt      TEXT NOT NULL,
  completedAt    TEXT,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (fromAgentId) REFERENCES agents(id) ON DELETE CASCADE,
  FOREIGN KEY (toAgentId) REFERENCES agents(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_messages_from ON agent_messages(fromAgentId);
CREATE INDEX IF NOT EXISTS idx_agent_messages_to ON agent_messages(toAgentId);
`);

// --- Seed the built-in skill registry (idempotent) ---
const seedSkills = [
  ["general-assistant", "General Assistant", "General-purpose AI assistance for planning, writing, reasoning, and everyday tasks.", "core"],
  ["research", "Research", "Search the web, read pages, and build cited research reports.", "knowledge"],
  ["content-creation", "Content Creation", "Draft posts, copy, and long-form content in a chosen voice.", "creative"],
  ["data-analysis", "Data Analysis", "Interpret tables and numbers and surface useful patterns.", "analytics"],
  ["marketing", "Marketing", "Plan campaigns, audiences, and messaging.", "growth"],
  ["productivity", "Productivity", "Organize tasks, schedules, and workflows.", "core"],
  ["memory", "Memory", "Remember and recall information across conversations.", "core"],
  ["meta_ads", "Meta Ads", "Manage Meta (Facebook/Instagram) ad campaigns once your account is connected.", "integration"],
  ["whatsapp", "WhatsApp Business", "Send and manage WhatsApp Business conversations once your account is connected.", "integration"],
  ["automations", "Automations", "Build and run automated workflows across your other skills and tools.", "core"],
  ["wordpress", "WordPress", "Manage posts, pages, and media on your WordPress site once connected.", "integration"],
  ["woocommerce", "WooCommerce", "Manage products, orders, and customers on your WooCommerce store once connected.", "integration"],
  ["gmail", "Gmail", "Read, search, and send email once your Gmail account is connected.", "integration"],
  ["calendar", "Google Calendar", "View and manage calendar events once your Google account is connected.", "integration"],
  ["drive", "Google Drive", "List, search, create, and share Drive files once your Google account is connected.", "integration"],
  ["docs", "Google Docs", "Create, read, and edit Google Docs once your Google account is connected.", "integration"],
  ["sheets", "Google Sheets", "Create spreadsheets and read/write cell data once your Google account is connected.", "integration"],
  ["shopify", "Shopify", "Manage products, orders, customers, inventory, discounts, and collections once your store is connected.", "integration"],
  ["collaboration", "Agent Collaboration", "Delegate tasks to your other agents and chain them together on multi-step work.", "core"],
  ["custom_tools", "Custom Tools (Developer)", "Use tools you've built and published yourself via the Developer SDK — each one calls a webhook you host.", "core"],
];
const insertSkill = db.prepare(
  "INSERT OR IGNORE INTO skills (id, name, description, category, status) VALUES (?, ?, ?, ?, 'available')"
);
for (const s of seedSkills) insertSkill.run(...s);
// INSERT OR IGNORE won't touch a row that already exists (e.g. from an
// earlier phase's seed), so explicitly refresh descriptions on every boot.
const refreshSkill = db.prepare("UPDATE skills SET description = ?, category = ? WHERE id = ?");
for (const [id, , description, category] of seedSkills) refreshSkill.run(description, category, id);

// --- Seed starter workflow templates (idempotent, refreshed each boot) ---
const insertTemplate = db.prepare(
  "INSERT OR IGNORE INTO workflow_templates (id, name, description, category, triggerType, triggerConfig, steps) VALUES (?, ?, ?, ?, ?, ?, ?)"
);
const daily9am = JSON.stringify({ frequency: "daily", hour: 9, minute: 0 });
const seedTemplates = [
  [
    "tmpl-morning-report", "Morning Business Report",
    "Summarizes tasks, campaigns, and recent activity every morning.",
    "reporting", "schedule", daily9am,
    JSON.stringify([
      { type: "action", config: { toolName: "list_tasks", parameters: { status: "todo" }, resultVariable: "openTasks" } },
      { type: "action", config: { toolName: "list_campaigns", parameters: {}, resultVariable: "campaigns" } },
    ]),
  ],
  [
    "tmpl-meta-summary", "Daily Meta Ads Summary",
    "Pulls campaign insights and reports on ad performance daily.",
    "marketing", "schedule", daily9am,
    JSON.stringify([{ type: "action", config: { toolName: "list_campaigns", parameters: {}, resultVariable: "campaigns" } }]),
  ],
  [
    "tmpl-research-trending", "Research Trending Products",
    "Runs a web research pass on a topic and saves the findings.",
    "research", "manual", "{}",
    JSON.stringify([
      { type: "action", config: { toolName: "web_search", parameters: { query: "{{topic}}" }, resultVariable: "searchResults" } },
      { type: "action", config: { toolName: "generate_report", parameters: { topic: "{{topic}}", findings: "{{searchResults.results}}" }, resultVariable: "report" } },
      { type: "approval", config: { reason: "Save this research to your Knowledge Library?" } },
      { type: "action", config: { toolName: "save_research", parameters: { title: "{{topic}}", content: "{{report.report}}" } } },
    ]),
  ],
  [
    "tmpl-whatsapp-autoreply", "WhatsApp Auto Reply",
    "Replies to an incoming WhatsApp message using the connected agent.",
    "messaging", "manual", "{}",
    JSON.stringify([{ type: "action", config: { toolName: "reply_whatsapp_message", parameters: { to: "{{contactPhone}}", message: "{{replyText}}" } } }]),
  ],
  [
    "tmpl-lead-followup", "Lead Follow-up",
    "Creates a follow-up task and drafts an outreach message for a new lead.",
    "sales", "manual", "{}",
    JSON.stringify([
      { type: "action", config: { toolName: "create_task", parameters: { title: "Follow up: {{leadName}}", priority: "high" }, resultVariable: "task" } },
    ]),
  ],
  [
    "tmpl-customer-support", "Customer Support Assistant",
    "Answers a customer question and logs it as a task if it needs follow-up.",
    "support", "manual", "{}",
    JSON.stringify([
      { type: "ai_decision", config: { question: "Does this question need human follow-up? {{question}}", options: ["yes", "no"], resultVariable: "needsFollowup" } },
      { type: "condition", config: { groups: [[{ field: "{{needsFollowup.choice}}", op: "equals", value: "yes" }]], onFalse: "end" } },
      { type: "action", config: { toolName: "create_task", parameters: { title: "Follow up on support question", description: "{{question}}" } } },
    ]),
  ],
  [
    "tmpl-competitor-monitoring", "Competitor Monitoring",
    "Researches a competitor's recent activity on a schedule.",
    "research", "schedule", JSON.stringify({ frequency: "weekly", dayOfWeek: 1, hour: 9, minute: 0 }),
    JSON.stringify([
      { type: "action", config: { toolName: "web_search", parameters: { query: "{{competitor}} news this week" }, resultVariable: "searchResults" } },
      { type: "action", config: { toolName: "generate_report", parameters: { topic: "{{competitor}}", findings: "{{searchResults.results}}" }, resultVariable: "report" } },
    ]),
  ],
  [
    "tmpl-weekly-marketing", "Weekly Marketing Report",
    "Compiles campaign performance into a weekly summary.",
    "marketing", "schedule", JSON.stringify({ frequency: "weekly", dayOfWeek: 1, hour: 9, minute: 0 }),
    JSON.stringify([{ type: "action", config: { toolName: "list_campaigns", parameters: {}, resultVariable: "campaigns" } }]),
  ],
];
for (const t of seedTemplates) insertTemplate.run(...t);

// One-time backfill: agents created before the Memory skill existed (or
// created without picking any skill) have zero rows in agent_skills, so no
// tool is ever available to them. Grant the core set so existing agents
// gain tool access without the user having to delete and recreate them.
const agentsWithNoSkills = db.prepare(
  `SELECT id FROM agents WHERE id NOT IN (SELECT DISTINCT agentId FROM agent_skills)`
).all();
const grantSkill = db.prepare("INSERT OR IGNORE INTO agent_skills (agentId, skillId) VALUES (?, ?)");
for (const { id } of agentsWithNoSkills) {
  grantSkill.run(id, "general-assistant");
  grantSkill.run(id, "productivity");
  grantSkill.run(id, "memory");
}

// --- Phase 13: Voice & Multimodal AI ---
// Voice is just another way a message enters the existing chat pipeline (see
// server/routes/voice.js) — these tables only track usage/preferences around
// that entry point, they don't duplicate any conversation/message storage.
// Same unmetered-for-individuals design boundary as billing above: orgId is
// recorded when known but never required, since direct chat has never been
// org-scoped either.
db.exec(`
CREATE TABLE IF NOT EXISTS voice_usage (
  id                  TEXT PRIMARY KEY,
  userId              TEXT NOT NULL,
  orgId               TEXT,
  agentId             TEXT,
  conversationId      TEXT,
  kind                TEXT NOT NULL, -- 'stt' | 'tts'
  provider            TEXT NOT NULL,
  durationSeconds     REAL,          -- stt: input audio duration
  characters          INTEGER,       -- tts: output text length
  estimatedCostCents  REAL NOT NULL DEFAULT 0,
  createdAt           TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_voice_usage_user ON voice_usage(userId, createdAt);
CREATE INDEX IF NOT EXISTS idx_voice_usage_org ON voice_usage(orgId, createdAt);

-- One row per user, created lazily on first read/write (same pattern as
-- ensureSubscription() for billing) rather than at signup, so this table
-- stays empty for users who never touch voice.
CREATE TABLE IF NOT EXISTS voice_settings (
  userId     TEXT PRIMARY KEY,
  voice      TEXT NOT NULL DEFAULT 'alloy',
  language   TEXT,                       -- NULL = auto-detect
  speed      REAL NOT NULL DEFAULT 1.0,
  volume     REAL NOT NULL DEFAULT 1.0,
  autoPlay   INTEGER NOT NULL DEFAULT 1,
  voiceMode  TEXT NOT NULL DEFAULT 'tap', -- 'tap' (record/stop/send) — 'continuous' reserved for a future natural-voice-mode pass
  captions   INTEGER NOT NULL DEFAULT 1,
  updatedAt  TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
`);

// --- Phase 14: File & Document Management ---
// Metadata lives here; actual bytes live in whatever the storage provider
// is configured to (see server/storage/provider.js) — a file row's
// storageProvider + storageKey is a pointer, never the content itself.
// Visibility follows the exact same private|workspace|organization
// convention knowledge_items already uses (see crossUserVisibility above)
// for consistency; "shared" additionally consults file_permissions for
// explicit per-user grants, and a public link is its own separate,
// disabled-by-default mechanism (file_shares), not a visibility level.
db.exec(`
CREATE TABLE IF NOT EXISTS folders (
  id             TEXT PRIMARY KEY,
  orgId          TEXT,
  workspaceId    TEXT,
  projectId      TEXT,
  ownerId        TEXT NOT NULL,
  name           TEXT NOT NULL,
  parentFolderId TEXT,
  visibility     TEXT NOT NULL DEFAULT 'private', -- private|workspace|organization
  trashedAt      TEXT,
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL,
  FOREIGN KEY (ownerId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_folders_owner ON folders(ownerId);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parentFolderId);
CREATE INDEX IF NOT EXISTS idx_folders_org ON folders(orgId);
CREATE INDEX IF NOT EXISTS idx_folders_workspace ON folders(workspaceId);

CREATE TABLE IF NOT EXISTS files (
  id                     TEXT PRIMARY KEY,
  orgId                  TEXT,
  workspaceId            TEXT,
  projectId              TEXT,
  folderId               TEXT,
  ownerId                TEXT NOT NULL,
  uploaderId             TEXT NOT NULL,
  filename               TEXT NOT NULL,
  originalFilename       TEXT NOT NULL,
  extension              TEXT,
  mimeType               TEXT,
  sizeBytes              INTEGER NOT NULL,
  storageProvider        TEXT NOT NULL DEFAULT 'local',
  storageKey             TEXT NOT NULL,
  checksum               TEXT,
  version                INTEGER NOT NULL DEFAULT 1,
  status                 TEXT NOT NULL DEFAULT 'active',       -- active | trashed
  processingStatus       TEXT NOT NULL DEFAULT 'uploading',    -- uploading|processing|ready|failed|unsupported|quarantined
  processingError        TEXT,
  aiProcessingStatus     TEXT NOT NULL DEFAULT 'not_started',  -- not_started|ready|unsupported
  securityScanStatus     TEXT NOT NULL DEFAULT 'not_scanned',  -- not_scanned|clean|infected|scan_failed — see storage/fileSecurity.js; never set to 'clean' unless a real scanner actually ran
  securityScanProvider   TEXT,
  previewSupport         INTEGER NOT NULL DEFAULT 0,
  textExtractionSupport  INTEGER NOT NULL DEFAULT 0,
  aiAnalysisSupport      INTEGER NOT NULL DEFAULT 0,
  extractedText          TEXT, -- populated by the processing pipeline; LIKE-searched, same approach as knowledge_items
  visibility             TEXT NOT NULL DEFAULT 'private', -- private|workspace|organization|shared
  favorite               INTEGER NOT NULL DEFAULT 0,
  trashedAt              TEXT,
  lastAccessedAt         TEXT,
  createdAt              TEXT NOT NULL,
  updatedAt              TEXT NOT NULL,
  FOREIGN KEY (ownerId) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (folderId) REFERENCES folders(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(ownerId, status);
CREATE INDEX IF NOT EXISTS idx_files_org ON files(orgId, status);
CREATE INDEX IF NOT EXISTS idx_files_workspace ON files(workspaceId, status);
CREATE INDEX IF NOT EXISTS idx_files_project ON files(projectId, status);
CREATE INDEX IF NOT EXISTS idx_files_folder ON files(folderId, status);

-- Every upload creates version 1 here too — files.version/storageKey always
-- mirror the current row in this table, so "download this file" never needs
-- to know versioning exists, while "view history" has a complete record.
CREATE TABLE IF NOT EXISTS file_versions (
  id              TEXT PRIMARY KEY,
  fileId          TEXT NOT NULL,
  version         INTEGER NOT NULL,
  storageProvider TEXT NOT NULL,
  storageKey      TEXT NOT NULL,
  sizeBytes       INTEGER NOT NULL,
  checksum        TEXT,
  uploaderId      TEXT NOT NULL,
  note            TEXT,
  createdAt       TEXT NOT NULL,
  FOREIGN KEY (fileId) REFERENCES files(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_versions_unique ON file_versions(fileId, version);

-- subjectType is 'user' only for this pass; 'team'/'agent' are valid values
-- the schema already accepts so a later phase can grant to those without a
-- migration — nothing in this phase writes them yet.
CREATE TABLE IF NOT EXISTS file_permissions (
  id          TEXT PRIMARY KEY,
  fileId      TEXT NOT NULL,
  subjectType TEXT NOT NULL, -- 'user' | 'team' | 'agent'
  subjectId   TEXT NOT NULL,
  permission  TEXT NOT NULL, -- view|download|edit|share|delete|manage
  grantedBy   TEXT NOT NULL,
  createdAt   TEXT NOT NULL,
  FOREIGN KEY (fileId) REFERENCES files(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_permissions_unique ON file_permissions(fileId, subjectType, subjectId, permission);
CREATE INDEX IF NOT EXISTS idx_file_permissions_subject ON file_permissions(subjectType, subjectId);

CREATE TABLE IF NOT EXISTS file_tags (
  fileId TEXT NOT NULL,
  tag    TEXT NOT NULL,
  PRIMARY KEY (fileId, tag),
  FOREIGN KEY (fileId) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_file_tags_tag ON file_tags(tag);

CREATE TABLE IF NOT EXISTS file_shares (
  id             TEXT PRIMARY KEY,
  fileId         TEXT NOT NULL,
  token          TEXT NOT NULL UNIQUE,
  createdBy      TEXT NOT NULL,
  expiresAt      TEXT,
  passwordHash   TEXT,
  downloadOnly   INTEGER NOT NULL DEFAULT 0,
  revoked        INTEGER NOT NULL DEFAULT 0,
  accessCount    INTEGER NOT NULL DEFAULT 0,
  lastAccessedAt TEXT,
  createdAt      TEXT NOT NULL,
  FOREIGN KEY (fileId) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_file_shares_file ON file_shares(fileId);

CREATE TABLE IF NOT EXISTS file_activity (
  id          TEXT PRIMARY KEY,
  fileId      TEXT NOT NULL,
  userId      TEXT,
  orgId       TEXT,
  workspaceId TEXT,
  projectId   TEXT,
  agentId     TEXT,
  action      TEXT NOT NULL, -- upload|download|view|share|rename|move|delete|restore|version_created|permission_changed|ai_access|ai_analysis|automation_access
  result      TEXT NOT NULL DEFAULT 'success',
  detail      TEXT,
  createdAt   TEXT NOT NULL,
  FOREIGN KEY (fileId) REFERENCES files(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_file_activity_file ON file_activity(fileId, createdAt);

-- Generic association so a file can connect to a Project, an Agent, or a
-- Knowledge Library item without files needing a column per relationship —
-- section 17/16/15 integrations all read/write this same table.
CREATE TABLE IF NOT EXISTS file_links (
  id         TEXT PRIMARY KEY,
  fileId     TEXT NOT NULL,
  linkedType TEXT NOT NULL, -- 'project' | 'agent' | 'knowledge'
  linkedId   TEXT NOT NULL,
  createdAt  TEXT NOT NULL,
  FOREIGN KEY (fileId) REFERENCES files(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_file_links_unique ON file_links(fileId, linkedType, linkedId);
CREATE INDEX IF NOT EXISTS idx_file_links_linked ON file_links(linkedType, linkedId);
`);

// Storage usage is deliberately NOT a separate rollup table — with this
// app's data volumes, SUM(sizeBytes) over files is cheap and always
// accurate, and a cached rollup would just be one more place for drift to
// creep in. See getStorageUsage() in orchestrator/storageUsage.js.

// Additive: lets each plan cap total file storage, enforced the same way
// every other quota is (see billing.js). NULL = unlimited, matching every
// other plan limit column's convention.
const planColsPhase14 = db.prepare("PRAGMA table_info(plans)").all().map((c) => c.name);
if (!planColsPhase14.includes("maxStorageBytes")) db.exec("ALTER TABLE plans ADD COLUMN maxStorageBytes INTEGER");
if (!planColsPhase14.includes("maxFileUploadMB")) db.exec("ALTER TABLE plans ADD COLUMN maxFileUploadMB INTEGER");
db.prepare("UPDATE plans SET maxStorageBytes = ? WHERE id = ? AND maxStorageBytes IS NULL").run(1 * 1024 * 1024 * 1024, "free");
db.prepare("UPDATE plans SET maxStorageBytes = ? WHERE id = ? AND maxStorageBytes IS NULL").run(10 * 1024 * 1024 * 1024, "starter");
db.prepare("UPDATE plans SET maxStorageBytes = ? WHERE id = ? AND maxStorageBytes IS NULL").run(50 * 1024 * 1024 * 1024, "professional");
db.prepare("UPDATE plans SET maxStorageBytes = ? WHERE id = ? AND maxStorageBytes IS NULL").run(250 * 1024 * 1024 * 1024, "business");
// enterprise stays NULL = unlimited, consistent with its other limits.
db.prepare("UPDATE plans SET maxFileUploadMB = ? WHERE id = ? AND maxFileUploadMB IS NULL").run(10, "free");
db.prepare("UPDATE plans SET maxFileUploadMB = ? WHERE id = ? AND maxFileUploadMB IS NULL").run(50, "starter");
db.prepare("UPDATE plans SET maxFileUploadMB = ? WHERE id = ? AND maxFileUploadMB IS NULL").run(200, "professional");
db.prepare("UPDATE plans SET maxFileUploadMB = ? WHERE id = ? AND maxFileUploadMB IS NULL").run(500, "business");

db.prepare("INSERT OR IGNORE INTO skills (id, name, description, category, status) VALUES (?, ?, ?, ?, 'available')")
  .run("files", "Files & Documents", "Find, organize, and analyze files and documents in the centralized File Manager.", "core");
db.prepare("UPDATE skills SET description = ?, category = ? WHERE id = ?")
  .run("Find, organize, and analyze files and documents in the centralized File Manager.", "core", "files");

// --- Phase 15: AI Content Studio ---
// Media assets (images/video/audio/voiceovers) are never stored here —
// contentAssets.fileId points at the existing `files` table, which owns
// the actual bytes, permissions, and versioning-at-the-storage-level. Pure
// text content (captions, ad copy, blog posts, scripts) is stored inline
// on the asset/generation row instead of wrapped in a File — that's a
// database column, not a second storage system, and matches how
// knowledge_items has always stored note/report text directly rather than
// as a file. A generation IS a version: content_generations doubles as
// version history (ordered by `version` per assetId) rather than keeping a
// separate content_versions table that would just mirror it.
db.exec(`
CREATE TABLE IF NOT EXISTS content_brands (
  id               TEXT PRIMARY KEY,
  orgId            TEXT,
  ownerId          TEXT NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT,
  tone             TEXT,
  writingStyle     TEXT,
  targetAudience   TEXT,
  preferredWords   TEXT NOT NULL DEFAULT '[]',
  avoidWords       TEXT NOT NULL DEFAULT '[]',
  ctaStyle         TEXT,
  guidelines       TEXT,
  createdAt        TEXT NOT NULL,
  updatedAt        TEXT NOT NULL,
  FOREIGN KEY (ownerId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_content_brands_org ON content_brands(orgId);
CREATE INDEX IF NOT EXISTS idx_content_brands_owner ON content_brands(ownerId);

-- NULL ownerId + isPlatform=1 rows are the built-in seed templates (visible
-- to everyone); a real ownerId row is a user's own custom template, private
-- unless later published to the Marketplace (marketplaceAssetId links back
-- once it is — set by the existing marketplace publish flow, not this table).
CREATE TABLE IF NOT EXISTS content_templates (
  id                  TEXT PRIMARY KEY,
  orgId               TEXT,
  ownerId             TEXT,
  name                TEXT NOT NULL,
  description         TEXT,
  contentType         TEXT NOT NULL,
  category            TEXT,
  promptTemplate      TEXT NOT NULL,
  config              TEXT NOT NULL DEFAULT '{}',
  isPlatform          INTEGER NOT NULL DEFAULT 0,
  marketplaceAssetId  TEXT,
  createdAt           TEXT NOT NULL,
  updatedAt           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_content_templates_org ON content_templates(orgId);
CREATE INDEX IF NOT EXISTS idx_content_templates_type ON content_templates(contentType);

CREATE TABLE IF NOT EXISTS content_assets (
  id              TEXT PRIMARY KEY,
  orgId           TEXT,
  workspaceId     TEXT,
  projectId       TEXT,
  ownerId         TEXT NOT NULL,
  creatorUserId   TEXT NOT NULL,
  agentId         TEXT,
  contentType     TEXT NOT NULL, -- image|video|audio|voiceover|music|social_post|ad_copy|product_description|blog|email|script|caption|hashtags|ugc_script|campaign_creative
  title           TEXT NOT NULL,
  fileId          TEXT,          -- media types: the current version's file in the centralized File System
  textContent     TEXT,          -- text types: the current version's generated text
  status          TEXT NOT NULL DEFAULT 'ready', -- queued|processing|ready|failed|cancelled
  errorMessage    TEXT,
  currentVersion  INTEGER NOT NULL DEFAULT 1,
  favorite        INTEGER NOT NULL DEFAULT 0,
  visibility      TEXT NOT NULL DEFAULT 'private', -- private|workspace|organization
  publishStatus   TEXT NOT NULL DEFAULT 'draft',   -- draft|published
  tags            TEXT NOT NULL DEFAULT '[]',
  trashedAt       TEXT,
  createdAt       TEXT NOT NULL,
  updatedAt       TEXT NOT NULL,
  FOREIGN KEY (ownerId) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (fileId) REFERENCES files(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_content_assets_owner ON content_assets(ownerId, status);
CREATE INDEX IF NOT EXISTS idx_content_assets_org ON content_assets(orgId, status);
CREATE INDEX IF NOT EXISTS idx_content_assets_workspace ON content_assets(workspaceId, status);
CREATE INDEX IF NOT EXISTS idx_content_assets_project ON content_assets(projectId, status);
CREATE INDEX IF NOT EXISTS idx_content_assets_type ON content_assets(contentType, status);

-- Every attempt is recorded, including failures — this is both the audit
-- trail and the version history (a successful generation with a new
-- 'version' number IS what "regenerate" produces).
CREATE TABLE IF NOT EXISTS content_generations (
  id                  TEXT PRIMARY KEY,
  assetId             TEXT NOT NULL,
  version             INTEGER NOT NULL,
  contentType         TEXT NOT NULL,
  provider            TEXT,
  model               TEXT,
  prompt              TEXT,
  negativePrompt      TEXT,
  parameters          TEXT NOT NULL DEFAULT '{}', -- aspectRatio, resolution, duration, style, seed, numImages, etc — only what the provider actually supports
  status              TEXT NOT NULL DEFAULT 'queued', -- queued|processing|ready|failed|cancelled
  errorMessage        TEXT,
  fileId              TEXT,   -- this version's resulting file, for media types
  textContent         TEXT,   -- this version's resulting text, for text types
  estimatedCostCents  REAL NOT NULL DEFAULT 0,
  durationMs          INTEGER,
  creatorUserId       TEXT NOT NULL,
  agentId             TEXT,
  createdAt           TEXT NOT NULL,
  completedAt         TEXT,
  FOREIGN KEY (assetId) REFERENCES content_assets(id) ON DELETE CASCADE,
  FOREIGN KEY (fileId) REFERENCES files(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_content_generations_unique ON content_generations(assetId, version);
CREATE INDEX IF NOT EXISTS idx_content_generations_creator ON content_generations(creatorUserId, createdAt);
`);

// Additive: reuses the EXISTING usage/billing pipeline (organization_usage +
// recordUsage()/checkQuota() in billing.js) rather than a parallel one —
// these are analytics-only counters; the actual quota gate content
// generation goes through is the existing maxAiRequests soft quota (every
// content generation also records an 'ai_request', same as any other AI
// call), so no new plan-limit column or enforcement path was needed.
const orgUsageColsPhase15 = db.prepare("PRAGMA table_info(organization_usage)").all().map((c) => c.name);
if (!orgUsageColsPhase15.includes("imageGenerations")) db.exec("ALTER TABLE organization_usage ADD COLUMN imageGenerations INTEGER NOT NULL DEFAULT 0");
if (!orgUsageColsPhase15.includes("videoGenerations")) db.exec("ALTER TABLE organization_usage ADD COLUMN videoGenerations INTEGER NOT NULL DEFAULT 0");
if (!orgUsageColsPhase15.includes("audioGenerations")) db.exec("ALTER TABLE organization_usage ADD COLUMN audioGenerations INTEGER NOT NULL DEFAULT 0");
if (!orgUsageColsPhase15.includes("contentTextGenerations")) db.exec("ALTER TABLE organization_usage ADD COLUMN contentTextGenerations INTEGER NOT NULL DEFAULT 0");

// Additive: a purely local reference — "this content asset was designated
// for this Meta campaign" — NOT an upload to Meta. This codebase's Meta Ads
// integration (integrations/meta/api.js) only reaches Campaign-level CRUD;
// there is no Ad Set/Ad/Creative API here, so Meta has nowhere to actually
// attach an image at the campaign level. Building real creative upload is a
// separate, larger integration; this column lets create_campaign optionally
// record which generated asset a campaign was built from, so a human can
// pick it up from there (download it and attach it manually in Ads
// Manager, or a future phase can wire the real Creative API). No money
// moves and no approval step is bypassed by this — it's metadata only.
const contentAssetCols = db.prepare("PRAGMA table_info(content_assets)").all().map((c) => c.name);
if (!contentAssetCols.includes("linkedCampaignId")) db.exec("ALTER TABLE content_assets ADD COLUMN linkedCampaignId TEXT");

db.prepare("INSERT OR IGNORE INTO skills (id, name, description, category, status) VALUES (?, ?, ?, ?, 'available')")
  .run("content_studio", "AI Content Studio", "Generate and manage AI images, copywriting, and other content assets.", "core");
db.prepare("UPDATE skills SET description = ?, category = ? WHERE id = ?")
  .run("Generate and manage AI images, copywriting, and other content assets.", "core", "content_studio");

// Platform seed templates (isPlatform=1, ownerId NULL) — visible to every
// user, never editable by them (templateService.js enforces that). {{...}}
// placeholders are filled in by the caller via applyTemplate().
const seedContentTemplates = [
  ["tmpl-ig-product-post", "Instagram Product Post", "A caption for a single-product Instagram post.", "caption", "social",
    "Write an Instagram caption for {{productName}}, a {{productDescription}}. Target audience: {{targetAudience}}. Include a short hook, 2-3 sentences of value, and a call to action.", {}],
  ["tmpl-ig-reel-script", "Instagram Reel Script", "A short-form vertical video script.", "script", "social",
    "Write a 20-30 second Instagram Reel script for {{productName}}. Target audience: {{targetAudience}}. Include on-screen text cues and a hook in the first line.", { aspectRatio: "9:16" }],
  ["tmpl-facebook-ad", "Facebook Ad", "Persuasive ad copy for a Facebook campaign.", "ad_copy", "ads",
    "Write Facebook ad copy for {{productName}}. Offer: {{offer}}. Target audience: {{targetAudience}}. Include a headline, primary text, and a call to action.", {}],
  ["tmpl-meta-ad-creative-image", "Meta Ad Creative", "A product ad creative image prompt.", "image", "ads",
    "A professional advertising photo of {{productName}}, {{productDescription}}, styled for a {{platform}} ad targeting {{targetAudience}}. Clean composition, commercial photography lighting.", { aspectRatio: "1:1" }],
  ["tmpl-product-launch", "Product Launch", "An announcement caption for a new product.", "caption", "social",
    "Write an exciting product launch announcement for {{productName}}. What's new: {{whatsNew}}. Target audience: {{targetAudience}}.", {}],
  ["tmpl-sale-announcement", "Sale Announcement", "A caption announcing a sale or promotion.", "caption", "social",
    "Write a sale announcement caption. Offer: {{offer}}. Ends: {{endDate}}. Create urgency without sounding pushy.", {}],
  ["tmpl-ugc-video", "UGC Video", "An authentic, creator-style video script.", "ugc_script", "ugc",
    "Write a UGC-style video script for {{productName}}. Brand: {{brand}}. Offer: {{offer}}. Tone: {{tone}}. Target platform: {{platform}}.", { aspectRatio: "9:16" }],
  ["tmpl-product-review", "Product Review Highlights", "Copy summarizing why customers love a product.", "product_description", "social",
    "Write product description copy for {{productName}} that highlights the kind of things real customers love about it. Target audience: {{targetAudience}}.", {}],
  ["tmpl-email-campaign", "Email Campaign", "A marketing email with subject line and body.", "email", "email",
    "Write a marketing email for {{productName}}. Offer: {{offer}}. Target audience: {{targetAudience}}. Include a subject line.", {}],
  ["tmpl-blog-article", "Blog Article", "A structured, SEO-aware blog post.", "blog", "content",
    "Write a blog article about {{topic}}. Target audience: {{targetAudience}}. Keywords to include: {{keywords}}.", {}],
  ["tmpl-youtube-short", "YouTube Short", "A vertical short-form video script.", "script", "social",
    "Write a YouTube Shorts script (under 60 seconds) for {{productName}}. Target audience: {{targetAudience}}. Strong hook in the first 3 seconds.", { aspectRatio: "9:16" }],
];
const insertContentTemplate = db.prepare(
  `INSERT OR IGNORE INTO content_templates (id, orgId, ownerId, name, description, contentType, category, promptTemplate, config, isPlatform, marketplaceAssetId, createdAt, updatedAt)
   VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`
);
for (const [id, name, description, contentType, category, promptTemplate, config] of seedContentTemplates) {
  insertContentTemplate.run(id, name, description, contentType, category, promptTemplate, JSON.stringify(config), new Date().toISOString(), new Date().toISOString());
}

// --- Phase 16: generalized Job Manager ---
// Separate from automation_event_queue (above) on purpose: that queue is
// specific to workflow execution, already durable, already proven in
// production use, and stays exactly as-is (no rewrite risk to something
// working). This `jobs` table is the generic backing store for the new
// Job Manager (server/jobs/jobManager.js) — future long-running work
// (batch generation, file processing at scale, video generation once a
// provider exists) registers here instead of each subsystem inventing its
// own ad-hoc tracking. Built behind a Queue Provider interface
// (server/jobs/queueProvider.js) so swapping the in-process adapter for a
// real Redis/BullMQ one later doesn't touch call sites.
db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'queued', -- queued|running|paused|completed|failed|cancelled|dead_letter
  priority      INTEGER NOT NULL DEFAULT 0,      -- higher runs first
  orgId         TEXT,
  workspaceId   TEXT,
  userId        TEXT,
  agentId       TEXT,
  automationId  TEXT,
  payload       TEXT NOT NULL DEFAULT '{}',
  result        TEXT,
  progress      INTEGER NOT NULL DEFAULT 0,      -- 0-100, best-effort
  progressNote  TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  maxAttempts   INTEGER NOT NULL DEFAULT 3,
  idempotencyKey TEXT,
  error         TEXT,
  errorRetryable INTEGER NOT NULL DEFAULT 1,
  createdAt     TEXT NOT NULL,
  startedAt     TEXT,
  completedAt   TEXT,
  nextAttemptAt TEXT                              -- backoff: don't retry before this time
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, priority DESC, createdAt);
CREATE INDEX IF NOT EXISTS idx_jobs_org ON jobs(orgId, status);
CREATE INDEX IF NOT EXISTS idx_jobs_user ON jobs(userId, status);
CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type, status);
-- A NULL idempotencyKey means "no dedup requested" — SQLite's UNIQUE index
-- treats every NULL as distinct, so only requests that actually supply a
-- key collide with each other.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs(idempotencyKey) WHERE idempotencyKey IS NOT NULL;

-- Feature flags: enable/disable without a redeploy (Phase 16). Overrides
-- are a separate table (not JSON columns on feature_flags) so a lookup by
-- (flagKey, scopeType, scopeId) can use a real unique index rather than
-- scanning and parsing JSON on every isFeatureEnabled() call, which runs on
-- a hot path.
CREATE TABLE IF NOT EXISTS feature_flags (
  id             TEXT PRIMARY KEY,
  key            TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  description    TEXT,
  enabled        INTEGER NOT NULL DEFAULT 0,
  rolloutPercent INTEGER NOT NULL DEFAULT 100,
  createdAt      TEXT NOT NULL,
  updatedAt      TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feature_flag_overrides (
  id        TEXT PRIMARY KEY,
  flagKey   TEXT NOT NULL,
  scopeType TEXT NOT NULL, -- 'org' | 'user'
  scopeId   TEXT NOT NULL,
  enabled   INTEGER NOT NULL,
  createdAt TEXT NOT NULL,
  FOREIGN KEY (flagKey) REFERENCES feature_flags(key) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_flag_override_scope ON feature_flag_overrides(flagKey, scopeType, scopeId);

-- Generic key-value store for small, singular pieces of platform-wide
-- config — maintenance mode today, and a natural home for anything similar
-- later, rather than a new one-row table per setting.
CREATE TABLE IF NOT EXISTS platform_settings (
  key       TEXT PRIMARY KEY,
  value     TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);
`);

// Additive: real cost (not just request count) and who/what actually
// incurred it, so AI spend can be limited per-org/day/month/agent/user/
// automation (Phase 16 §40) with a real SQL SUM(costCents) instead of
// parsing every row's JSON metadata — this table is exactly the kind of
// thing that grows fast, so that distinction matters at scale.
const usageRecordCols = db.prepare("PRAGMA table_info(usage_records)").all().map((c) => c.name);
const addUsageCol = (name, type) => { if (!usageRecordCols.includes(name)) db.exec(`ALTER TABLE usage_records ADD COLUMN ${name} ${type}`); };
addUsageCol("costCents", "INTEGER NOT NULL DEFAULT 0");
addUsageCol("agentId", "TEXT");
addUsageCol("userId", "TEXT");
addUsageCol("automationId", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_usage_org_agent ON usage_records(orgId, agentId, createdAt)");
db.exec("CREATE INDEX IF NOT EXISTS idx_usage_org_user ON usage_records(orgId, userId, createdAt)");
db.exec("CREATE INDEX IF NOT EXISTS idx_usage_org_automation ON usage_records(orgId, automationId, createdAt)");

// Org-level AI spend safeguards — unset (NULL) means unlimited for that
// scope; an org only gets real limits once someone explicitly sets them.
// Separate table, not new plans.* columns: these are per-organization
// choices an org admin sets for themselves, not a platform-wide plan tier.
db.exec(`
CREATE TABLE IF NOT EXISTS organization_spend_limits (
  orgId                  TEXT PRIMARY KEY,
  dailyLimitCents        INTEGER,
  monthlyLimitCents      INTEGER,
  perAgentLimitCents     INTEGER,
  perUserLimitCents      INTEGER,
  perAutomationLimitCents INTEGER,
  alertThresholdPercent  INTEGER NOT NULL DEFAULT 80,
  updatedAt              TEXT NOT NULL,
  FOREIGN KEY (orgId) REFERENCES organizations(id) ON DELETE CASCADE
);
`);

// Phase 16 database performance pass — indexes for lookups that were doing
// full table scans (found via the audit: reverse-lookups and org/workspace
// scoping filters that had no matching index, only the userId-scoped ones
// added when each table was created).
db.exec(`
CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(userId);
CREATE INDEX IF NOT EXISTS idx_conv_agent ON conversations(agentId);
CREATE INDEX IF NOT EXISTS idx_exec_conversation ON tool_executions(conversationId);
CREATE INDEX IF NOT EXISTS idx_agents_org ON agents(orgId);
CREATE INDEX IF NOT EXISTS idx_agents_workspace ON agents(workspaceId);
CREATE INDEX IF NOT EXISTS idx_automations_org ON automations(orgId);
CREATE INDEX IF NOT EXISTS idx_automations_workspace ON automations(workspaceId);
CREATE INDEX IF NOT EXISTS idx_activity_org_created ON activity_logs(orgId, createdAt);
CREATE INDEX IF NOT EXISTS idx_queue_user ON automation_event_queue(userId);
`);

// Phase 17 — Public API & Developer Platform. Deliberately a NEW table, not
// a reuse of the existing `api_keys` table (that one is BYOK — one AI
// provider key per org, AES-256-GCM encrypted because the app must decrypt
// and use it). A developer API key is a different kind of secret: many keys
// per org, each independently named/scoped/expirable/revocable, and the app
// NEVER needs the raw value back after creation — only a fast hash
// comparison at auth time — so it's hashed, not encrypted, and the raw
// value is shown to the developer exactly once.
db.exec(`
CREATE TABLE IF NOT EXISTS developer_api_keys (
  id            TEXT PRIMARY KEY,
  orgId         TEXT NOT NULL,
  userId        TEXT NOT NULL,          -- creator, for audit
  name          TEXT NOT NULL,
  keyPrefix     TEXT NOT NULL,          -- first chars of the raw key, shown in the UI so a key is identifiable without ever re-displaying the secret
  hashedSecret  TEXT NOT NULL UNIQUE,   -- SHA-256 hex digest of the full raw secret
  scopes        TEXT NOT NULL,          -- JSON array, drawn from the fixed scope list in apiKeyService.js
  status        TEXT NOT NULL DEFAULT 'active', -- active | revoked
  expiresAt     TEXT,                   -- NULL = never expires
  lastUsedAt    TEXT,
  createdAt     TEXT NOT NULL,
  revokedAt     TEXT,
  FOREIGN KEY (orgId) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dev_api_keys_org ON developer_api_keys(orgId, status);

-- One row per public API request — the source of truth for the Developer
-- Console's usage dashboard and the admin analytics extension. Expected to
-- grow fast; no retention/pruning job exists yet (documented as a known
-- limitation in the Phase 17 report), same honest disclosure Phase 16 gave
-- usage_records before any archival strategy existed for it either.
CREATE TABLE IF NOT EXISTS api_request_logs (
  id           TEXT PRIMARY KEY,
  apiKeyId     TEXT,
  orgId        TEXT,
  requestId    TEXT NOT NULL,
  method       TEXT NOT NULL,
  path         TEXT NOT NULL,
  statusCode   INTEGER,
  latencyMs    INTEGER,
  errorCode    TEXT,
  createdAt    TEXT NOT NULL,
  FOREIGN KEY (apiKeyId) REFERENCES developer_api_keys(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_api_logs_org_created ON api_request_logs(orgId, createdAt);
CREATE INDEX IF NOT EXISTS idx_api_logs_key_created ON api_request_logs(apiKeyId, createdAt);

-- Developer-configured webhook endpoints. The signing secret IS encrypted
-- (not hashed) — unlike an API key, the app must read it back every single
-- delivery to compute that delivery's HMAC signature, so it uses
-- secretsCrypto.js the same way BYOK provider keys do.
CREATE TABLE IF NOT EXISTS developer_webhooks (
  id            TEXT PRIMARY KEY,
  orgId         TEXT NOT NULL,
  userId        TEXT NOT NULL,
  url           TEXT NOT NULL,
  description   TEXT,
  encryptedSecret TEXT NOT NULL,
  events        TEXT NOT NULL,          -- JSON array of subscribed event types, or ["*"] for all
  status        TEXT NOT NULL DEFAULT 'active', -- active | disabled
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL,
  FOREIGN KEY (orgId) REFERENCES organizations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dev_webhooks_org ON developer_webhooks(orgId);

-- One row per delivery ATTEMPT SERIES for one webhook+event pair — the
-- developer-facing history record. The actual retry/backoff/dead-letter
-- scheduling is delegated entirely to the Phase 16 Job Manager (jobId below
-- points at the driving job); this row mirrors that job's outcome plus the
-- HTTP-specific detail (status code, response time) the generic jobs table
-- has no reason to carry. Reusing the queue here is a direct requirement of
-- the Phase 17 spec, not a design choice made in isolation.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id             TEXT PRIMARY KEY,
  webhookId      TEXT NOT NULL,
  jobId          TEXT NOT NULL,
  eventType      TEXT NOT NULL,
  eventId        TEXT NOT NULL,         -- unique per event occurrence — the value the receiving end should dedup on
  payload        TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending', -- mirrors jobs.status: pending|running|completed|failed|dead_letter
  httpStatus     INTEGER,
  responseTimeMs INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  lastAttemptAt  TEXT,
  error          TEXT,
  createdAt      TEXT NOT NULL,
  FOREIGN KEY (webhookId) REFERENCES developer_webhooks(id) ON DELETE CASCADE,
  FOREIGN KEY (jobId) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhookId, createdAt);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_job ON webhook_deliveries(jobId);
`);

// A public-API-initiated agent execution (Phase 17 §6/§7) — a thin tracking
// record, NOT a parallel execution path: every run's actual work happens
// through the exact same handleIncomingMessage()/orchestrate() pipeline
// internal chat already uses (conversationId below points at the real
// conversation/messages rows that call creates), so quota/spend
// enforcement and usage recording are inherited for free, not reimplemented.
// jobId is set only for async runs, pointing at the driving jobs row — same
// "let the Job Manager own retry/scheduling" pattern webhook_deliveries uses.
db.exec(`
CREATE TABLE IF NOT EXISTS api_agent_runs (
  id               TEXT PRIMARY KEY,
  orgId            TEXT NOT NULL,
  apiKeyId         TEXT NOT NULL,
  agentId          TEXT NOT NULL,
  userId           TEXT NOT NULL,
  conversationId   TEXT,
  jobId            TEXT,
  mode             TEXT NOT NULL DEFAULT 'sync', -- sync | async
  status           TEXT NOT NULL DEFAULT 'queued', -- queued|running|completed|failed
  inputMessage     TEXT,
  resultText       TEXT,
  promptTokens     INTEGER NOT NULL DEFAULT 0,
  completionTokens INTEGER NOT NULL DEFAULT 0,
  errorMessage     TEXT,
  createdAt        TEXT NOT NULL,
  completedAt      TEXT,
  FOREIGN KEY (orgId) REFERENCES organizations(id) ON DELETE CASCADE,
  FOREIGN KEY (apiKeyId) REFERENCES developer_api_keys(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_api_agent_runs_org ON api_agent_runs(orgId, createdAt);
CREATE INDEX IF NOT EXISTS idx_api_agent_runs_agent ON api_agent_runs(agentId, createdAt);
`);

// Public API Idempotency-Key support (Phase 17.1 §1) — an HTTP-layer
// request/response cache, deliberately NOT a second job/queue system: it
// sits in front of the existing synchronous route handlers (and, for async
// agent execution, in front of the existing Job Manager enqueue) and simply
// remembers "this exact request, from this exact key, already happened."
// Scoped by (apiKeyId, idempotencyKey) — never by orgId alone — so two
// different keys within the same org can't collide, and one org's key can
// never see or replay into another org's reservation.
db.exec(`
CREATE TABLE IF NOT EXISTS api_idempotency_keys (
  id             TEXT PRIMARY KEY,
  apiKeyId       TEXT NOT NULL,
  orgId          TEXT NOT NULL,
  idempotencyKey TEXT NOT NULL,
  requestHash    TEXT NOT NULL,   -- sha256(method + path + body) — detects conflicting reuse of the same key
  status         TEXT NOT NULL DEFAULT 'in_progress', -- in_progress | completed
  statusCode     INTEGER,
  responseBody   TEXT,
  createdAt      TEXT NOT NULL,
  expiresAt      TEXT NOT NULL,
  FOREIGN KEY (apiKeyId) REFERENCES developer_api_keys(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_idempotency_key ON api_idempotency_keys(apiKeyId, idempotencyKey);
CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON api_idempotency_keys(expiresAt);
`);

// Phase 21 — beta feedback. Deliberately minimal: no separate feedback
// service/table family, just what's needed to collect and triage real
// beta input. userId nullable (not orgId-scoped) since feedback is a
// personal act, not something that needs multi-tenant isolation the way
// agents/integrations do.
db.exec(`
CREATE TABLE IF NOT EXISTS feedback (
  id        TEXT PRIMARY KEY,
  userId    TEXT NOT NULL,
  type      TEXT NOT NULL, -- bug | feature | general
  message   TEXT NOT NULL,
  page      TEXT,          -- the client route the user was on when they submitted this
  status    TEXT NOT NULL DEFAULT 'new', -- new | reviewed | resolved
  createdAt TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(createdAt);
`);

// Phase 21 — SEO skill (on-page audit + Core Web Vitals via Google's free
// PageSpeed Insights API). Rank tracking / competitor backlink data are
// deliberately NOT part of this — those need a paid third-party SEO data
// provider (no free API exists for either), out of scope until that's a
// real subscription someone has decided to pay for.
db.prepare("INSERT OR IGNORE INTO skills (id, name, description, category, status) VALUES (?, ?, ?, ?, 'available')")
  .run("seo", "SEO Audit", "Audit a page's on-page SEO (title, meta description, headings, alt text) and check Core Web Vitals / page speed.", "marketing");
db.prepare("UPDATE skills SET description = ?, category = ? WHERE id = ?")
  .run("Audit a page's on-page SEO (title, meta description, headings, alt text) and check Core Web Vitals / page speed.", "marketing", "seo");

// Meta Ads Expert planner (Phase 1) — server/agents/metaExpert/. Stores
// the internal campaign plan the LLM proposes (goal, objective, targeting,
// budget, semantic asset references, etc.) as a validated, schema-checked
// JSON document, separately from whether/when it gets executed. Deliberately
// its own table rather than reusing an existing one: a plan is a distinct
// lifecycle (proposed -> approved -> executed, or rejected) from an actual
// Meta campaign, and needs to exist and be inspectable even before any
// real Meta object is created. planJson never contains resolved secrets —
// only ids Meta itself already returns for objects this user's own token
// can already see (page/ad-account/pixel/catalog ids), the same as every
// other Meta tool result already exposed to the model.
db.exec(`
CREATE TABLE IF NOT EXISTS meta_campaign_plans (
  id          TEXT PRIMARY KEY,
  userId      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'proposed', -- proposed | approved | executed | rejected
  planJson    TEXT NOT NULL,   -- the validated internal plan (see internal_plan_schema.json)
  contextJson TEXT,            -- the business-research context the plan was built from (known/inferred/unavailable)
  recommendationText TEXT,     -- the customer-facing recommendation presented for this plan
  executionResultJson TEXT,    -- set once execute_campaign_plan runs: created campaign/adSet/ad ids
  createdAt   TEXT NOT NULL,
  updatedAt   TEXT NOT NULL,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_meta_plans_user ON meta_campaign_plans(userId);
`);

db.prepare("INSERT OR IGNORE INTO skills (id, name, description, category, status) VALUES (?, ?, ?, ?, 'available')")
  .run("meta_expert", "Meta Ads Expert Planner", "Research business/account context and build a validated, approval-gated Meta campaign strategy from a stated goal, instead of guessing individual campaign settings.", "marketing");
db.prepare("UPDATE skills SET description = ?, category = ? WHERE id = ?")
  .run("Research business/account context and build a validated, approval-gated Meta campaign strategy from a stated goal, instead of guessing individual campaign settings.", "marketing", "meta_expert");

export default db;
