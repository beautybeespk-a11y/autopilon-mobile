// Resolving which agent a chat message is addressed to — and what to do
// when the id the client posted no longer resolves.
//
// Round 58 — the intermittent "AI provider not configured — Agent not
// found" the owner saw in the chat UI. That banner text is misleading twice
// over, and both halves have a fix (the client half is in Chat.jsx):
//
//  1. The provider was never the problem. The chat route answers any
//     failure of POST /api/chat/message with that banner — the API helper
//     turns the response's `error` field into err.message, and the client
//     renders it under "AI provider not configured — …" for EVERY status,
//     not just the 503 a genuinely unconfigured provider returns. A 404
//     { error: "Agent not found" } therefore shows up as "AI provider not
//     configured — Agent not found", and the owner reasonably concludes his
//     AI key is missing when it is fine.
//
//  2. The 404 itself fires when the posted agentId doesn't exist or the
//     user can't access it (routes/chat.js). Both chat clients post the
//     dropdown's currently-selected agent id — defaulting to the first
//     agent in the /agents list, and never re-synced to the conversation
//     actually open — so a stale selection (long-lived session, app
//     restart, an agent renamed/replaced since the list was loaded) 404s
//     the whole turn even though the conversation itself is fine and its
//     own agent was validated when the conversation was created.
//
// The fix here: when the posted id doesn't exist in the DB at all AND the
// message continues an existing conversation the user owns, fall back to
// that conversation's own stored agentId (still access-checked) instead of
// failing the turn. Deliberately NOT a fallback when the agent EXISTS but
// the user can't access it — that is a genuine authorization refusal and
// stays a 404, so this can never be used to reach another org's agent.
// New conversations have no conversation to fall back to and keep the 404.
import db from "../db.js";
import { canAccessAgent } from "./agentManager.js";

export function resolveMessageAgentId({ userId, agentId, conversationId }) {
  // No agent requested: plain chat, no tools — nothing to resolve.
  if (!agentId) return { agentId: null };
  const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(agentId);
  if (agent && canAccessAgent(userId, agent)) return { agentId };
  // The agent exists but this user can't use it — a real authorization
  // refusal, never a stale id. No fallback of any kind.
  if (agent) return { error: "Agent not found" };
  // The posted id doesn't exist at all — most likely a stale client-side
  // selection. The conversation itself already knows its agent.
  if (conversationId) {
    const conv = db
      .prepare("SELECT agentId FROM conversations WHERE id = ? AND userId = ?")
      .get(conversationId, userId);
    const convAgentId = conv?.agentId;
    if (convAgentId) {
      const convAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(convAgentId);
      if (convAgent && canAccessAgent(userId, convAgent)) {
        return { agentId: convAgentId, fellBack: true };
      }
    }
  }
  return { error: "Agent not found" };
}
