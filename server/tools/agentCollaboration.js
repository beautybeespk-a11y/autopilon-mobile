import { registerTool } from "./registry.js";
import db from "../db.js";
import { routeTask, routeChain, findBestAgent } from "../orchestrator/agentRouter.js";

function resolveAgentId(userId, { agentId, agentName }) {
  if (agentId) return agentId;
  if (agentName) {
    const match = db.prepare(
      "SELECT id FROM agents WHERE userId = ? AND status = 'active' AND LOWER(name) LIKE ?"
    ).get(userId, `%${agentName.toLowerCase()}%`);
    if (match) return match.id;
    throw new Error(`No active agent found matching "${agentName}". Use agent.list_agents to see available agents.`);
  }
  return null;
}

registerTool({
  name: "agent.list_agents",
  description: "Lists your other AI agents (name, description, category) so you know who's available to delegate tasks to.",
  category: "collaboration",
  parameters: { type: "object", properties: {}, required: [] },
  requiredPermissions: ["agent.delegate"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    const agents = db.prepare(
      "SELECT id, name, description, category, status FROM agents WHERE userId = ? AND status = 'active'"
    ).all(context.userId);
    return { agents: agents.filter((a) => a.id !== context.agentId) };
  },
});

registerTool({
  name: "agent.delegate_task",
  description:
    "Delegates a task to another one of your agents and returns their result. Specify agentId or agentName to pick a specific agent, or leave both blank to auto-pick the best-fit agent based on the task description.",
  category: "collaboration",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "The task or question to hand off." },
      agentId: { type: "string" },
      agentName: { type: "string", description: "Partial or full name match, e.g. 'Marketing'" },
    },
    required: ["task"],
  },
  requiredPermissions: ["agent.delegate"],
  requiresConfirmation: false,
  async execute(parameters, context) {
    let toAgentId = resolveAgentId(context.userId, parameters);
    if (!toAgentId) {
      const best = findBestAgent(context.userId, parameters.task, { excludeAgentId: context.agentId });
      if (!best) throw new Error("Couldn't find a suitable agent for this task, and none was specified. Try agent.list_agents first.");
      toAgentId = best.agent.id;
    }
    if (toAgentId === context.agentId) throw new Error("Can't delegate a task to yourself.");
    const result = await routeTask(context.userId, { fromAgentId: context.agentId, toAgentId, content: parameters.task });
    return { delegatedTo: result.toAgent, reply: result.reply, conversationId: result.conversationId };
  },
});

registerTool({
  name: "agent.delegate_chain",
  description:
    "Runs a task through a sequence of agents, each building on the previous agent's output — e.g. Research Agent -> Content Writer -> Marketing Agent.",
  category: "collaboration",
  parameters: {
    type: "object",
    properties: {
      task: { type: "string", description: "The initial task/brief to start the chain." },
      agentIds: { type: "array", items: { type: "string" }, description: "Agent IDs in the order they should run." },
    },
    required: ["task", "agentIds"],
  },
  requiredPermissions: ["agent.delegate"],
  requiresConfirmation: true,
  async execute(parameters, context) {
    const result = await routeChain(context.userId, {
      fromAgentId: context.agentId,
      agentIds: parameters.agentIds,
      initialContent: parameters.task,
    });
    return result;
  },
});
