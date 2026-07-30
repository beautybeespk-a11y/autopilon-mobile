import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { orchestrate } from "./index.js";

// Everything a new inbound message needs to go through, regardless of which
// channel it arrived on (web chat or WhatsApp): build the agent's system
// prompt, load + enrich history, run the Orchestrator, persist the reply.
// Both routes/chat.js and the WhatsApp webhook call this — neither
// duplicates it.
export async function handleIncomingMessage({ userId, agentId, conversationId, content, skipUserInsert = false }) {
  const now = new Date().toISOString();

  if (!skipUserInsert) {
    db.prepare("INSERT INTO messages (id, conversationId, role, content, createdAt) VALUES (?, ?, 'user', ?, ?)")
      .run(cryptoRandom(), conversationId, content, now);
  }

  let systemPrompt = "You are a helpful AI assistant inside the AI Agent Platform.";
  if (agentId) {
    const agent = db.prepare("SELECT * FROM agents WHERE id = ? AND userId = ?").get(agentId, userId);
    if (agent) systemPrompt = `You are "${agent.name}". Personality: ${agent.personality}. ${agent.instructions || ""}`.trim();
  }

  // Prior tool results are folded into history so a follow-up referencing an
  // earlier result by name (e.g. a campaign, a task) can still resolve back
  // to its real ID — see the Phase 4 cross-turn memory fix for why this matters.
  const rawHistory = db.prepare("SELECT role, content, meta FROM messages WHERE conversationId = ? ORDER BY createdAt ASC").all(conversationId);
  const history = rawHistory.map((m) => {
    if (m.role !== "assistant" || !m.meta) return { role: m.role, content: m.content };
    const parsedMeta = JSON.parse(m.meta);
    const successes = (parsedMeta.toolResults || []).filter((r) => !r.error);
    if (!successes.length) return { role: m.role, content: m.content };
    const dataNote = successes.map((r) => `${r.toolName} returned: ${JSON.stringify(r.result)}`).join("\n");
    return { role: m.role, content: `${m.content}\n\n[Underlying tool data from this turn, for your own reference in follow-ups — do not repeat verbatim: ${dataNote}]` };
  });

  const { reply, trace, toolResults, confirmation } = await orchestrate({
    userId,
    agentId: agentId || null,
    conversationId,
    userMessage: content,
    history,
    agentSystemPrompt: systemPrompt,
  });

  const replyAt = new Date().toISOString();
  const meta = JSON.stringify({ trace, toolResults, confirmation });
  const assistantMessageId = cryptoRandom();
  db.prepare("INSERT INTO messages (id, conversationId, role, content, createdAt, meta) VALUES (?, ?, 'assistant', ?, ?, ?)")
    .run(assistantMessageId, conversationId, reply, replyAt, meta);
  db.prepare("UPDATE conversations SET updatedAt = ? WHERE id = ?").run(replyAt, conversationId);

  return { conversationId, reply, trace, toolResults, confirmation, assistantMessageId };
}
