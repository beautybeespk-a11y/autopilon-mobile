import Database from "better-sqlite3";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, "app.sqlite"));
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
db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_int_user_provider ON integrations(userId, provider)");

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

-- Dedupes webhook deliveries — Meta can and does redeliver the same event.
CREATE TABLE IF NOT EXISTS webhook_events (
  id         TEXT PRIMARY KEY, -- the WhatsApp message/status id, so a redelivery collides here
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

const execCols = db.prepare("PRAGMA table_info(tool_executions)").all().map((c) => c.name);
if (!execCols.includes("agentId")) db.exec("ALTER TABLE tool_executions ADD COLUMN agentId TEXT");

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

export default db;
