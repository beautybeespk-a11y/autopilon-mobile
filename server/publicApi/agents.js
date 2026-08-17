// Public Agent API (Phase 17 §5/§6/§7). Every route here is strictly
// org-scoped via req.orgId (set by requireApiKey) — agents belonging to a
// different org are treated as not existing (404), never a 403, so an API
// key can't even confirm another org's agent id is real.
import { Router } from "express";
import { requireApiKey, requireScope } from "./auth.js";
import { apiRateLimit, apiAiConcurrencyLimit } from "./rateLimit.js";
import { apiError, apiErrorFromException } from "./errors.js";
import { parsePagination, paginate, cursorWhereClause } from "./pagination.js";
import { listOrgAgents, getOrgAgent, executeAgentSync, executeAgentAsync, listRunsForAgent } from "../orchestrator/agentApiService.js";
import { agentScope } from "../orchestrator/agentManager.js";

const router = Router();
router.use(requireApiKey, apiRateLimit());

function toPublicAgentShape(agent) {
  // Never exposes agent.instructions (the system prompt) — matches §6's
  // "do not expose secrets or internal system prompts."
  return {
    id: agent.id, name: agent.name, description: agent.description, personality: agent.personality,
    status: agent.status, category: agent.category, scope: agentScope(agent),
    createdAt: agent.createdAt, updatedAt: agent.updatedAt,
  };
}

router.get("/", requireScope("agents:read"), (req, res) => {
  const { limit, cursor } = parsePagination(req);
  const rows = listOrgAgents(req.orgId, { limit, cursorClause: cursorWhereClause(cursor) });
  const { data, pagination } = paginate(rows, limit);
  res.json({ data: data.map(toPublicAgentShape), pagination });
});

router.get("/:id", requireScope("agents:read"), (req, res) => {
  const agent = getOrgAgent(req.orgId, req.params.id);
  if (!agent) return apiError(res, 404, "RESOURCE_NOT_FOUND", "The requested agent was not found.");
  res.json(toPublicAgentShape(agent));
});

router.get("/:id/runs", requireScope("agents:read"), (req, res) => {
  const agent = getOrgAgent(req.orgId, req.params.id);
  if (!agent) return apiError(res, 404, "RESOURCE_NOT_FOUND", "The requested agent was not found.");
  const { limit, cursor } = parsePagination(req);
  const rows = listRunsForAgent(req.orgId, req.params.id, { limit, cursorClause: cursorWhereClause(cursor) });
  const { data, pagination } = paginate(rows, limit);
  res.json({ data, pagination });
});

// Execute is the AI-heavy endpoint — stacks a per-key AI concurrency cap on
// top of apiRateLimit()'s per-key per-minute ceiling, same layered
// protection internal chat/content routes already use (session-keyed there;
// API-key-keyed here, see apiAiConcurrencyLimit()'s comment for why the
// internal one can't just be reused directly).
const aiConcurrency = apiAiConcurrencyLimit();
router.post("/:id/execute", requireScope("agents:execute"), aiConcurrency, async (req, res) => {
  const agent = getOrgAgent(req.orgId, req.params.id);
  if (!agent) return apiError(res, 404, "RESOURCE_NOT_FOUND", "The requested agent was not found.");
  const { message, conversationId, async: runAsync } = req.body || {};
  if (!message?.trim()) return apiError(res, 400, "INVALID_REQUEST", "message is required.");

  try {
    if (runAsync) {
      const run = executeAgentAsync({ orgId: req.orgId, apiKeyId: req.apiKey.id, userId: req.apiKey.userId, agentId: agent.id, message, conversationId });
      return res.status(202).json(run);
    }
    const run = await executeAgentSync({ orgId: req.orgId, apiKeyId: req.apiKey.id, userId: req.apiKey.userId, agentId: agent.id, message, conversationId });
    res.json(run);
  } catch (err) {
    apiErrorFromException(res, err, "Agent execution failed.");
  }
});

// A lighter conversational alias for /execute — always synchronous, meant
// for simple "send a message, get a reply" integrations (chatbots) that
// don't need run-tracking detail beyond the reply itself.
router.post("/:id/messages", requireScope("agents:execute"), aiConcurrency, async (req, res) => {
  const agent = getOrgAgent(req.orgId, req.params.id);
  if (!agent) return apiError(res, 404, "RESOURCE_NOT_FOUND", "The requested agent was not found.");
  const { message, conversationId } = req.body || {};
  if (!message?.trim()) return apiError(res, 400, "INVALID_REQUEST", "message is required.");

  try {
    const run = await executeAgentSync({ orgId: req.orgId, apiKeyId: req.apiKey.id, userId: req.apiKey.userId, agentId: agent.id, message, conversationId });
    res.json({ conversationId: run.conversationId, response: run.response, usage: run.usage });
  } catch (err) {
    apiErrorFromException(res, err, "Agent execution failed.");
  }
});

export default router;
