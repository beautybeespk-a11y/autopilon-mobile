import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { handleIncomingMessage } from "./conversationService.js";

const now = () => new Date().toISOString();

// Every agent-to-agent exchange runs through the SAME handleIncomingMessage
// pipeline a normal chat message uses — same permission checks, same tool
// registry, same confirmation gating for the target agent's own tool calls.
// This function does not execute anything itself; it just addresses a task
// to a target agent and records the exchange.
export async function routeTask(userId, { fromAgentId, toAgentId, content, type = "delegate_task" }) {
  const fromAgent = fromAgentId ? db.prepare("SELECT * FROM agents WHERE id = ? AND userId = ?").get(fromAgentId, userId) : null;
  const toAgent = db.prepare("SELECT * FROM agents WHERE id = ? AND userId = ?").get(toAgentId, userId);
  if (!toAgent) throw new Error("Target agent not found.");
  if (toAgent.status !== "active") throw new Error(`"${toAgent.name}" is deactivated and can't take on tasks right now.`);

  const messageId = cryptoRandom();
  const conversationId = cryptoRandom();
  const title = `${fromAgent ? `${fromAgent.name} → ` : ""}${toAgent.name}: ${content.slice(0, 60)}`;
  db.prepare(
    "INSERT INTO conversations (id, userId, agentId, title, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(conversationId, userId, toAgentId, title, now(), now());

  db.prepare(
    `INSERT INTO agent_messages (id, userId, fromAgentId, toAgentId, type, content, conversationId, status, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
  ).run(messageId, userId, fromAgentId || toAgentId, toAgentId, type, content, conversationId, now());

  try {
    // Frame the task so the target agent knows it came from another agent,
    // not the human directly — matters for how it should respond (a result
    // to hand back, not a conversational reply).
    const framedContent = fromAgent
      ? `[Task delegated to you by another agent, "${fromAgent.name}"]\n\n${content}`
      : content;
    const { reply, trace, toolResults } = await handleIncomingMessage({
      userId, agentId: toAgentId, conversationId, content: framedContent,
    });
    db.prepare("UPDATE agent_messages SET status = 'completed', result = ?, completedAt = ? WHERE id = ?")
      .run(reply, now(), messageId);
    return { messageId, conversationId, toAgent: toAgent.name, reply, trace, toolResults };
  } catch (err) {
    db.prepare("UPDATE agent_messages SET status = 'failed', error = ?, completedAt = ? WHERE id = ?")
      .run(err.message, now(), messageId);
    throw err;
  }
}

// Runs a chain of agents sequentially, passing each agent's output forward
// as the next agent's input — e.g. Research → Content Writer → Marketing.
export async function routeChain(userId, { fromAgentId, agentIds, initialContent }) {
  let content = initialContent;
  const steps = [];
  for (const toAgentId of agentIds) {
    const result = await routeTask(userId, { fromAgentId, toAgentId, content, type: "delegate_task" });
    steps.push(result);
    content = result.reply; // this step's output becomes the next step's input
  }
  return { steps, finalResult: steps[steps.length - 1]?.reply };
}

// Lightweight keyword-overlap matcher — no ML, just scores each active
// agent's name/description/skill names against the task text and returns
// the best fit. Good enough for "which of my agents should handle this",
// and transparent about why it picked what it picked.
export function findBestAgent(userId, taskDescription, { excludeAgentId } = {}) {
  const agents = db.prepare("SELECT * FROM agents WHERE userId = ? AND status = 'active'").all(userId);
  const words = new Set(taskDescription.toLowerCase().match(/[a-z0-9]+/g) || []);

  // One query for every candidate agent's skills instead of one query per
  // agent — this used to re-query per agent inside the loop below.
  const skillsByAgent = new Map();
  if (agents.length) {
    const placeholders = agents.map(() => "?").join(",");
    const rows = db.prepare(
      `SELECT a.agentId, s.name, s.category FROM skills s JOIN agent_skills a ON a.skillId = s.id WHERE a.agentId IN (${placeholders})`
    ).all(...agents.map((a) => a.id));
    for (const row of rows) {
      if (!skillsByAgent.has(row.agentId)) skillsByAgent.set(row.agentId, []);
      skillsByAgent.get(row.agentId).push(row);
    }
  }

  let best = null;
  let bestScore = 0;
  for (const agent of agents) {
    if (agent.id === excludeAgentId) continue;
    const skills = skillsByAgent.get(agent.id) || [];
    const haystack = [agent.name, agent.description, agent.category, ...skills.map((s) => `${s.name} ${s.category}`)].join(" ").toLowerCase();
    const haystackWords = new Set(haystack.match(/[a-z0-9]+/g) || []);
    let score = 0;
    for (const w of words) if (haystackWords.has(w)) score++;
    if (score > bestScore) { bestScore = score; best = agent; }
  }
  return best ? { agent: best, score: bestScore } : null;
}

export function listAgentMessages(userId, agentId, limit = 20) {
  return db.prepare(
    `SELECT am.*, f.name AS fromAgentName, t.name AS toAgentName
     FROM agent_messages am
     JOIN agents f ON f.id = am.fromAgentId
     JOIN agents t ON t.id = am.toAgentId
     WHERE am.userId = ? AND (am.fromAgentId = ? OR am.toAgentId = ?)
     ORDER BY am.createdAt DESC LIMIT ?`
  ).all(userId, agentId, agentId, limit);
}
