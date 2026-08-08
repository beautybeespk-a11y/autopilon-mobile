import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { getMembership } from "./rbac.js";
import { enforceQuota } from "./billing.js";

const now = () => new Date().toISOString();

// An agent is "Personal" (orgId NULL — the only kind that existed before
// Phase 9, and still the default), "Organization" (orgId set, workspaceId
// NULL — any active org member can use it), or "Workspace" (both set — only
// that workspace's members can). Sharing means visibility/skills/
// instructions are shared; each user's own tool calls still run against
// their OWN connected integrations/memories — see Shared Integrations
// (a later Phase 9 slice) for actual cross-user resource sharing.
export function agentScope(agent) {
  if (!agent.orgId) return "personal";
  return agent.workspaceId ? "workspace" : "organization";
}

export function canAccessAgent(userId, agent) {
  if (!agent) return false;
  if (agent.userId === userId) return true;
  if (!agent.orgId) return false;
  const orgMembership = getMembership(agent.orgId, userId);
  if (!orgMembership) return false;
  if (!agent.workspaceId) return true; // organization-wide
  return Boolean(db.prepare("SELECT 1 FROM workspace_members WHERE workspaceId = ? AND userId = ?").get(agent.workspaceId, userId));
}

export function canManageAgent(userId, agent) {
  if (!agent) return false;
  if (agent.userId === userId) return true;
  if (!agent.orgId) return false;
  const orgMembership = getMembership(agent.orgId, userId);
  return Boolean(orgMembership && ["owner", "admin"].includes(orgMembership.role));
}

// Every agent the user can currently use: their own personal agents, plus
// any organization/workspace agents they have membership access to.
export function listAccessibleAgents(userId) {
  const personal = db.prepare("SELECT * FROM agents WHERE userId = ? AND orgId IS NULL ORDER BY updatedAt DESC").all(userId);
  const orgIds = db.prepare("SELECT orgId FROM organization_members WHERE userId = ? AND status = 'active'").all(userId).map((r) => r.orgId);
  if (!orgIds.length) return personal;
  const placeholders = orgIds.map(() => "?").join(",");
  const orgWide = db.prepare(
    `SELECT * FROM agents WHERE orgId IN (${placeholders}) AND workspaceId IS NULL ORDER BY updatedAt DESC`
  ).all(...orgIds);
  const workspaceIds = db.prepare("SELECT workspaceId FROM workspace_members WHERE userId = ?").all(userId).map((r) => r.workspaceId);
  const workspaceScoped = workspaceIds.length
    ? db.prepare(`SELECT * FROM agents WHERE workspaceId IN (${workspaceIds.map(() => "?").join(",")})`).all(...workspaceIds)
    : [];
  // De-dupe (an agent could theoretically show up via both org and personal ownership checks if the user is also its creator).
  const seen = new Set();
  return [...personal, ...orgWide, ...workspaceScoped].filter((a) => (seen.has(a.id) ? false : (seen.add(a.id), true)));
}

function loadAgentWithSkills(agentId) {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
  if (!agent) return null;
  const skills = db.prepare("SELECT s.* FROM skills s JOIN agent_skills a ON a.skillId = s.id WHERE a.agentId = ?").all(agentId);
  return { ...agent, skills, skillIds: skills.map((s) => s.id) };
}

function snapshotOf(agent) {
  return {
    name: agent.name,
    description: agent.description,
    instructions: agent.instructions,
    personality: agent.personality,
    avatar: agent.avatar,
    category: agent.category,
    aiProvider: agent.aiProvider,
    aiModel: agent.aiModel,
    orgId: agent.orgId,
    workspaceId: agent.workspaceId,
    skillIds: agent.skillIds,
  };
}

function recordVersion(agentId, version, snapshot, note) {
  db.prepare(
    "INSERT INTO agent_versions (id, agentId, version, snapshot, note, createdAt) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(cryptoRandom(), agentId, version, JSON.stringify(snapshot), note || null, now());
}

function setSkills(agentId, skillIds) {
  db.prepare("DELETE FROM agent_skills WHERE agentId = ?").run(agentId);
  const link = db.prepare("INSERT OR IGNORE INTO agent_skills (agentId, skillId) VALUES (?, ?)");
  for (const sid of skillIds || []) link.run(agentId, sid);
}

export function createAgent(userId, fields) {
  const { name, description, instructions, personality, avatar, category, aiProvider, aiModel, orgId, workspaceId, skillIds } = fields;
  if (!name?.trim()) throw new Error("Agent name is required.");
  if (orgId) enforceQuota(orgId, "maxAgents", "agents");
  const id = cryptoRandom();
  const ts = now();
  db.prepare(
    `INSERT INTO agents (id, userId, name, description, instructions, personality, avatar, category, aiProvider, aiModel, orgId, workspaceId, status, version, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`
  ).run(id, userId, name, description || "", instructions || "", personality || "professional", avatar || null, category || "general", aiProvider || null, aiModel || null, orgId || null, workspaceId || null, ts, ts);
  setSkills(id, skillIds);
  const agent = loadAgentWithSkills(id);
  recordVersion(id, 1, snapshotOf(agent), "Created");
  return agent;
}

// Every edit bumps `version` and writes a snapshot of the *new* state to
// agent_versions — so history reads as "what it became at each version",
// and restoring version N just re-applies that snapshot as a new version.
export function updateAgent(userId, agentId, fields, note) {
  const existing = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
  if (!existing || !canManageAgent(userId, existing)) throw new Error("Agent not found.");
  const { name, description, instructions, personality, avatar, category, aiProvider, aiModel, orgId, workspaceId, skillIds } = fields;
  const newVersion = existing.version + 1;
  // Empty string means "clear back to default" (NULL); undefined means
  // "leave whatever it already was" — COALESCE only helps for the latter,
  // so these are resolved explicitly instead.
  const nextAiProvider = aiProvider === "" ? null : aiProvider;
  const nextAiModel = aiModel === "" ? null : aiModel;
  const nextOrgId = orgId === "" ? null : orgId;
  const nextWorkspaceId = workspaceId === "" ? null : workspaceId;
  db.prepare(
    `UPDATE agents SET
       name = COALESCE(?, name), description = COALESCE(?, description), instructions = COALESCE(?, instructions),
       personality = COALESCE(?, personality), avatar = COALESCE(?, avatar), category = COALESCE(?, category),
       aiProvider = CASE WHEN ? THEN ? ELSE aiProvider END,
       aiModel = CASE WHEN ? THEN ? ELSE aiModel END,
       orgId = CASE WHEN ? THEN ? ELSE orgId END,
       workspaceId = CASE WHEN ? THEN ? ELSE workspaceId END,
       version = ?, updatedAt = ?
     WHERE id = ?`
  ).run(
    name, description, instructions, personality, avatar, category,
    aiProvider !== undefined ? 1 : 0, nextAiProvider,
    aiModel !== undefined ? 1 : 0, nextAiModel,
    orgId !== undefined ? 1 : 0, nextOrgId,
    workspaceId !== undefined ? 1 : 0, nextWorkspaceId,
    newVersion, now(), agentId
  );
  if (Array.isArray(skillIds)) setSkills(agentId, skillIds);
  const agent = loadAgentWithSkills(agentId);
  recordVersion(agentId, newVersion, snapshotOf(agent), note || "Updated");
  return agent;
}

export function cloneAgent(userId, agentId, overrideName) {
  const source = loadAgentWithSkills(agentId);
  if (!source || !canAccessAgent(userId, source)) throw new Error("Agent not found.");
  const id = cryptoRandom();
  const ts = now();
  const name = overrideName || `${source.name} (Copy)`;
  db.prepare(
    `INSERT INTO agents (id, userId, name, description, instructions, personality, avatar, category, aiProvider, aiModel, status, version, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)`
  ).run(id, userId, name, source.description, source.instructions, source.personality, source.avatar, source.category, source.aiProvider, source.aiModel, ts, ts);
  setSkills(id, source.skillIds);
  const agent = loadAgentWithSkills(id);
  recordVersion(id, 1, snapshotOf(agent), `Cloned from "${source.name}"`);
  return agent;
}

export function setAgentStatus(userId, agentId, status) {
  if (!["active", "inactive"].includes(status)) throw new Error("status must be 'active' or 'inactive'.");
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
  if (!agent || !canManageAgent(userId, agent)) throw new Error("Agent not found.");
  db.prepare("UPDATE agents SET status = ?, updatedAt = ? WHERE id = ?").run(status, now(), agentId);
  return loadAgentWithSkills(agentId);
}

export function deleteAgent(userId, agentId) {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
  if (!agent || !canManageAgent(userId, agent)) throw new Error("Agent not found.");
  db.prepare("DELETE FROM agents WHERE id = ?").run(agentId);
  return { deleted: true };
}

export function getVersionHistory(userId, agentId) {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
  if (!agent || !canManageAgent(userId, agent)) throw new Error("Agent not found.");
  return db.prepare("SELECT id, version, note, snapshot, createdAt FROM agent_versions WHERE agentId = ? ORDER BY version DESC").all(agentId)
    .map((v) => ({ ...v, snapshot: JSON.parse(v.snapshot) }));
}

export function restoreVersion(userId, agentId, version) {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
  if (!agent || !canManageAgent(userId, agent)) throw new Error("Agent not found.");
  const row = db.prepare("SELECT snapshot FROM agent_versions WHERE agentId = ? AND version = ?").get(agentId, version);
  if (!row) throw new Error(`Version ${version} not found for this agent.`);
  const snapshot = JSON.parse(row.snapshot);
  return updateAgent(userId, agentId, snapshot, `Restored from version ${version}`);
}

// Health is a live signal (is it usable right now), distinct from stats
// (how has it performed historically) — kept separate on purpose. Any user
// with access (not just the owner/managers) can check health/stats —
// "Monitor" is one of the actions Shared Agents explicitly allows.
export function getAgentHealth(userId, agentId) {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
  if (!agent || !canAccessAgent(userId, agent)) throw new Error("Agent not found.");
  const skillCount = db.prepare("SELECT COUNT(*) c FROM agent_skills WHERE agentId = ?").get(agentId).c;
  const recentFailures = db.prepare(
    `SELECT COUNT(*) c FROM tool_executions te
     JOIN conversations c ON c.id = te.conversationId
     WHERE c.agentId = ? AND te.status = 'failed' AND te.createdAt > ?`
  ).get(agentId, new Date(Date.now() - 24 * 3600_000).toISOString()).c;
  const issues = [];
  if (agent.status !== "active") issues.push("Agent is deactivated.");
  if (skillCount === 0) issues.push("No skills enabled — this agent can't use any tools yet.");
  if (recentFailures >= 3) issues.push(`${recentFailures} failed tool calls in the last 24 hours.`);
  return { healthy: issues.length === 0, status: agent.status, skillCount, recentFailures, issues };
}

export function getAgentStats(userId, agentId) {
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
  if (!agent || !canAccessAgent(userId, agent)) throw new Error("Agent not found.");

  const conversationCount = db.prepare("SELECT COUNT(*) c FROM conversations WHERE agentId = ?").get(agentId).c;
  const messageCount = db.prepare(
    "SELECT COUNT(*) c FROM messages m JOIN conversations c ON c.id = m.conversationId WHERE c.agentId = ?"
  ).get(agentId).c;

  const execStats = db.prepare(
    `SELECT
       COUNT(*) total,
       SUM(CASE WHEN te.status = 'completed' THEN 1 ELSE 0 END) succeeded,
       SUM(CASE WHEN te.status = 'failed' THEN 1 ELSE 0 END) failed,
       AVG(CASE WHEN te.startedAt IS NOT NULL AND te.completedAt IS NOT NULL
                THEN (julianday(te.completedAt) - julianday(te.startedAt)) * 86400000.0 END) avgMs
     FROM tool_executions te
     JOIN conversations c ON c.id = te.conversationId
     WHERE c.agentId = ?`
  ).get(agentId);

  const topTools = db.prepare(
    `SELECT te.toolName, COUNT(*) c FROM tool_executions te
     JOIN conversations c ON c.id = te.conversationId
     WHERE c.agentId = ?
     GROUP BY te.toolName ORDER BY c DESC LIMIT 5`
  ).all(agentId);

  const lastActive = db.prepare(
    "SELECT MAX(m.createdAt) t FROM messages m JOIN conversations c ON c.id = m.conversationId WHERE c.agentId = ?"
  ).get(agentId).t;

  return {
    conversationCount,
    messageCount,
    toolCalls: { total: execStats.total || 0, succeeded: execStats.succeeded || 0, failed: execStats.failed || 0 },
    avgResponseMs: execStats.avgMs ? Math.round(execStats.avgMs) : null,
    topTools,
    lastActiveAt: lastActive,
  };
}

// One batched, grouped query per metric across ALL of a user's agents —
// deliberately not a loop calling getAgentStats() per agent, which would be
// N+1 queries. Powers the Agent Dashboard's per-agent performance table.
export function listAgentsWithStats(userId) {
  const agents = db.prepare("SELECT * FROM agents WHERE userId = ? ORDER BY updatedAt DESC").all(userId);

  const convByAgent = new Map(
    db.prepare("SELECT agentId, COUNT(*) c FROM conversations WHERE userId = ? AND agentId IS NOT NULL GROUP BY agentId").all(userId)
      .map((r) => [r.agentId, r.c])
  );
  const msgByAgent = new Map(
    db.prepare(
      `SELECT c.agentId, COUNT(*) c FROM messages m JOIN conversations c ON c.id = m.conversationId
       WHERE c.userId = ? AND c.agentId IS NOT NULL GROUP BY c.agentId`
    ).all(userId).map((r) => [r.agentId, r.c])
  );
  const execByAgent = new Map(
    db.prepare(
      `SELECT c.agentId,
         COUNT(*) total,
         SUM(CASE WHEN te.status = 'completed' THEN 1 ELSE 0 END) succeeded,
         SUM(CASE WHEN te.status = 'failed' THEN 1 ELSE 0 END) failed,
         AVG(CASE WHEN te.startedAt IS NOT NULL AND te.completedAt IS NOT NULL
                  THEN (julianday(te.completedAt) - julianday(te.startedAt)) * 86400000.0 END) avgMs
       FROM tool_executions te JOIN conversations c ON c.id = te.conversationId
       WHERE c.userId = ? AND c.agentId IS NOT NULL GROUP BY c.agentId`
    ).all(userId).map((r) => [r.agentId, r])
  );
  const lastActiveByAgent = new Map(
    db.prepare(
      `SELECT c.agentId, MAX(m.createdAt) t FROM messages m JOIN conversations c ON c.id = m.conversationId
       WHERE c.userId = ? AND c.agentId IS NOT NULL GROUP BY c.agentId`
    ).all(userId).map((r) => [r.agentId, r.t])
  );

  return agents.map((a) => {
    const exec = execByAgent.get(a.id);
    return {
      id: a.id,
      name: a.name,
      category: a.category,
      status: a.status,
      version: a.version,
      conversationCount: convByAgent.get(a.id) || 0,
      messageCount: msgByAgent.get(a.id) || 0,
      toolCalls: { total: exec?.total || 0, succeeded: exec?.succeeded || 0, failed: exec?.failed || 0 },
      avgResponseMs: exec?.avgMs ? Math.round(exec.avgMs) : null,
      lastActiveAt: lastActiveByAgent.get(a.id) || null,
    };
  });
}

// Platform-wide totals for the Agent Dashboard's summary cards.
export function getPlatformAgentSummary(userId) {
  const c = (sql) => db.prepare(sql).get(userId).c;
  const totalAgents = c("SELECT COUNT(*) c FROM agents WHERE userId = ?");
  const activeAgents = c("SELECT COUNT(*) c FROM agents WHERE userId = ? AND status = 'active'");
  const totalConversations = c("SELECT COUNT(*) c FROM conversations WHERE userId = ?");
  const totalMessages = c("SELECT COUNT(*) c FROM messages m JOIN conversations conv ON conv.id = m.conversationId WHERE conv.userId = ?");
  const toolStats = db.prepare(
    `SELECT COUNT(*) total,
       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) succeeded,
       SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) failed,
       AVG(CASE WHEN startedAt IS NOT NULL AND completedAt IS NOT NULL
                THEN (julianday(completedAt) - julianday(startedAt)) * 86400000.0 END) avgMs
     FROM tool_executions WHERE userId = ?`
  ).get(userId);
  const activeAutomations = c("SELECT COUNT(*) c FROM automations WHERE userId = ? AND status = 'active'");
  const automationRunsThisWeek = db.prepare(
    "SELECT COUNT(*) c FROM automation_events WHERE userId = ? AND createdAt > ?"
  ).get(userId, new Date(Date.now() - 7 * 86400_000).toISOString()).c;
  const topToolsOverall = db.prepare(
    "SELECT toolName, COUNT(*) c FROM tool_executions WHERE userId = ? GROUP BY toolName ORDER BY c DESC LIMIT 8"
  ).all(userId);

  return {
    totalAgents,
    activeAgents,
    inactiveAgents: totalAgents - activeAgents,
    totalConversations,
    totalMessages,
    toolCalls: { total: toolStats.total || 0, succeeded: toolStats.succeeded || 0, failed: toolStats.failed || 0 },
    avgResponseMs: toolStats.avgMs ? Math.round(toolStats.avgMs) : null,
    activeAutomations,
    automationRunsThisWeek,
    topToolsOverall,
  };
}
