import db from "../db.js";

// Everything here reads from tables that already exist for their own
// reasons (agents, automations, integrations, activity_logs, etc.) — this
// module adds no new state of its own, just org-scoped aggregation queries.
//
// Deliberately NOT included: AI Usage, Token Consumption, Storage, API
// Usage. No token/usage metering or storage system exists anywhere in this
// platform (file storage was explicitly deferred to its own future phase).
// Reporting zeros or invented numbers for these would be a placeholder —
// they're left out entirely rather than faked.

export function getOrgDashboard(orgId) {
  const members = db.prepare(
    "SELECT status, COUNT(*) c FROM organization_members WHERE orgId = ? GROUP BY status"
  ).all(orgId);
  const memberCounts = Object.fromEntries(members.map((m) => [m.status, m.c]));

  const agents = db.prepare("SELECT status, COUNT(*) c FROM agents WHERE orgId = ? GROUP BY status").all(orgId);
  const agentCounts = Object.fromEntries(agents.map((a) => [a.status, a.c]));

  const automations = db.prepare("SELECT status, COUNT(*) c FROM automations WHERE orgId = ? GROUP BY status").all(orgId);
  const automationCounts = Object.fromEntries(automations.map((a) => [a.status, a.c]));

  const runningNow = db.prepare(
    `SELECT COUNT(*) c FROM automation_runs r JOIN automations a ON a.id = r.automationId
     WHERE a.orgId = ? AND r.status IN ('running', 'awaiting_approval')`
  ).get(orgId).c;

  const connectedIntegrations = db.prepare("SELECT COUNT(*) c FROM integrations WHERE orgId = ? AND status = 'connected'").get(orgId).c;
  const workspaceCount = db.prepare("SELECT COUNT(*) c FROM workspaces WHERE orgId = ?").get(orgId).c;

  const recentActivity = db.prepare(
    `SELECT al.*, u.name AS userName FROM activity_logs al LEFT JOIN users u ON u.id = al.userId
     WHERE al.orgId = ? ORDER BY al.createdAt DESC LIMIT 15`
  ).all(orgId);

  // Real signals derived from actual audit data — not simulated. A failed
  // login is a genuine event that already happened; this just surfaces the
  // pattern rather than making the admin scroll the raw audit log to spot it.
  const since24h = new Date(Date.now() - 24 * 3600_000).toISOString();
  const failedLogins = db.prepare(
    `SELECT u.name, u.email, COUNT(*) c FROM activity_logs al JOIN users u ON u.id = al.userId
     WHERE al.orgId = ? AND al.action = 'login_failed' AND al.createdAt > ? GROUP BY al.userId HAVING c >= 3`
  ).all(orgId, since24h);
  const securityAlerts = [
    ...failedLogins.map((f) => ({ severity: "high", message: `${f.name || f.email}: ${f.c} failed login attempts in the last 24h` })),
  ];

  return {
    members: { total: Object.values(memberCounts).reduce((a, b) => a + b, 0), ...memberCounts },
    agents: { total: Object.values(agentCounts).reduce((a, b) => a + b, 0), ...agentCounts },
    automations: { total: Object.values(automationCounts).reduce((a, b) => a + b, 0), ...automationCounts, runningNow },
    connectedIntegrations,
    workspaceCount,
    recentActivity,
    securityAlerts,
  };
}

export function getOrgAnalytics(orgId, { sinceDays = 30 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();

  const mostActiveUsers = db.prepare(
    `SELECT u.id, u.name, COUNT(*) actions FROM activity_logs al JOIN users u ON u.id = al.userId
     WHERE al.orgId = ? AND al.createdAt > ? GROUP BY al.userId ORDER BY actions DESC LIMIT 10`
  ).all(orgId, since);

  const mostUsedAgents = db.prepare(
    `SELECT a.id, a.name, COUNT(*) messageCount FROM messages m
     JOIN conversations c ON c.id = m.conversationId JOIN agents a ON a.id = c.agentId
     WHERE a.orgId = ? AND m.createdAt > ? GROUP BY a.id ORDER BY messageCount DESC LIMIT 10`
  ).all(orgId, since);

  const mostUsedTools = db.prepare(
    `SELECT te.toolName, COUNT(*) c FROM tool_executions te
     JOIN conversations c ON c.id = te.conversationId JOIN agents a ON a.id = c.agentId
     WHERE a.orgId = ? AND te.createdAt > ? GROUP BY te.toolName ORDER BY c DESC LIMIT 10`
  ).all(orgId, since);

  const automationStats = db.prepare(
    `SELECT COUNT(*) total, SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) succeeded
     FROM automation_runs r JOIN automations a ON a.id = r.automationId
     WHERE a.orgId = ? AND r.createdAt > ?`
  ).get(orgId, since);
  const automationSuccessRate = automationStats.total ? Math.round((automationStats.succeeded / automationStats.total) * 100) : null;

  const avgResponse = db.prepare(
    `SELECT AVG(CASE WHEN te.startedAt IS NOT NULL AND te.completedAt IS NOT NULL
              THEN (julianday(te.completedAt) - julianday(te.startedAt)) * 86400000.0 END) avgMs
     FROM tool_executions te JOIN conversations c ON c.id = te.conversationId JOIN agents a ON a.id = c.agentId
     WHERE a.orgId = ? AND te.createdAt > ?`
  ).get(orgId, since);

  // Organization growth: cumulative active-member count by the month they
  // joined — a real, derivable trend from organization_members.joinedAt.
  const joins = db.prepare(
    "SELECT joinedAt FROM organization_members WHERE orgId = ? AND joinedAt IS NOT NULL ORDER BY joinedAt ASC"
  ).all(orgId);
  const growthByMonth = {};
  let cumulative = 0;
  for (const j of joins) {
    const month = j.joinedAt.slice(0, 7); // YYYY-MM
    cumulative++;
    growthByMonth[month] = cumulative;
  }

  const workspaceActivity = db.prepare(
    `SELECT w.id, w.name,
       (SELECT COUNT(*) FROM agents WHERE workspaceId = w.id) agentCount,
       (SELECT COUNT(*) FROM automations WHERE workspaceId = w.id) automationCount,
       (SELECT COUNT(*) FROM projects WHERE workspaceId = w.id) projectCount
     FROM workspaces w WHERE w.orgId = ?`
  ).all(orgId);

  return {
    periodDays: sinceDays,
    mostActiveUsers,
    mostUsedAgents,
    mostUsedTools,
    automationSuccessRate,
    avgResponseMs: avgResponse.avgMs ? Math.round(avgResponse.avgMs) : null,
    organizationGrowth: Object.entries(growthByMonth).map(([month, total]) => ({ month, totalMembers: total })),
    workspaceActivity,
  };
}
