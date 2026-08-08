import { registerTool } from "../registry.js";
import { chatComplete } from "../../ai/provider.js";
import { createAutomation } from "../../automation/engine.js";
import { listTools } from "../registry.js";
import db from "../../db.js";

const PLANNER_PROMPT = `Convert the user's natural-language automation request into a workflow definition.

Respond with ONLY JSON in this shape:
{
  "name": "<short name>",
  "description": "<one sentence>",
  "triggerType": "manual" | "schedule",
  "triggerConfig": { "frequency": "daily" | "hourly" | "weekly" | "every_minute", "hour": 9, "minute": 0 },
  "steps": [
    { "type": "action", "config": { "toolName": "<a real tool name>", "parameters": {...}, "resultVariable": "<name>" } },
    ...
  ]
}

Rules:
- Only use "toolName" values from the provided tool list.
- If the request implies a schedule ("every day at 9am"), use triggerType "schedule" with a matching triggerConfig.
- If no schedule is implied, use triggerType "manual".
- Keep steps minimal and directly matched to what the user asked for.
- Output raw JSON only — no markdown fences, no commentary.`;

function safeParse(text, fallback) {
  try {
    return JSON.parse(text.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim());
  } catch {
    return fallback;
  }
}

registerTool({
  name: "draft_workflow",
  description: "Converts a natural-language automation request into a real workflow, saved as a draft for the user to review before activating.",
  category: "automations",
  parameters: {
    type: "object",
    properties: { request: { type: "string" } },
    required: ["request"],
  },
  requiredPermissions: ["automation.write"],
  requiresConfirmation: false, // it lands as a draft, not active — nothing runs until the user reviews and activates it
  async execute(parameters, context) {
    const availableTools = listTools().map((t) => `${t.name}: ${t.description}`).join("\n");
    const raw = (await chatComplete({
      systemPrompt: `${PLANNER_PROMPT}\n\nAvailable tools:\n${availableTools}`,
      messages: [{ role: "user", content: parameters.request }],
    })).text;
    const plan = safeParse(raw, null);
    if (!plan?.name || !Array.isArray(plan.steps)) {
      const err = new Error("Could not turn that into a workflow — try describing it more concretely (what should happen, and when).");
      throw err;
    }
    const automationId = createAutomation(context.userId, {
      name: plan.name,
      description: plan.description,
      triggerType: plan.triggerType || "manual",
      triggerConfig: plan.triggerConfig || {},
      steps: plan.steps,
      agentId: db.prepare("SELECT id FROM agents WHERE userId = ? ORDER BY createdAt ASC LIMIT 1").get(context.userId)?.id || null,
      status: "draft",
    });
    return { automationId, name: plan.name, status: "draft", stepCount: plan.steps.length };
  },
});
