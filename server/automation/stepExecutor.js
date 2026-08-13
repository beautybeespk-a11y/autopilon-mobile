import { resolveDeep } from "./templating.js";
import { evaluateConditionGroups } from "./conditions.js";
import { runTool } from "../orchestrator/executor.js";
import { createApprovalStep } from "./approvals.js";
import { chatComplete } from "../ai/provider.js";
import { enforceQuota } from "../orchestrator/billing.js";
import { enforceSpendLimit } from "../orchestrator/costControls.js";
import { recordAiTextUsage } from "../orchestrator/costEngine.js";

function safeParseJson(text, fallback) {
  try {
    return JSON.parse(text.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim());
  } catch {
    return fallback;
  }
}

// Runs one step. Returns:
//   { outcome: "continue", variables }
//   { outcome: "jump", jumpTo, variables }
//   { outcome: "pause", confirmationId, reason, variables }
//   { outcome: "fail", error, variables }
//   { outcome: "end", variables }
export async function executeStep(step, variables, ctx) {
  const config = JSON.parse(step.config || "{}");

  switch (step.type) {
    case "condition": {
      const passed = evaluateConditionGroups(config.groups, variables);
      if (passed) return { outcome: "continue", variables };
      if (config.onFalse === "end") return { outcome: "end", variables };
      if (typeof config.onFalse === "number") return { outcome: "jump", jumpTo: config.onFalse, variables };
      return { outcome: "continue", variables }; // no else branch configured — just proceed
    }

    case "action": {
      const parameters = resolveDeep(config.parameters || {}, variables);
      const outcome = await runTool({
        toolName: config.toolName,
        parameters,
        userId: ctx.userId,
        agentId: ctx.agentId,
        automationRunId: ctx.runId,
      });
      if (outcome.status === "awaiting_confirmation") {
        return { outcome: "pause", confirmationId: outcome.confirmationId, reason: outcome.reason, variables };
      }
      if (outcome.status === "failed") {
        if (config.onError === "continue") {
          return { outcome: "continue", variables, warning: outcome.error };
        }
        return { outcome: "fail", error: outcome.error, variables };
      }
      const key = config.resultVariable || `${config.toolName}Result`;
      return { outcome: "continue", variables: { ...variables, [key]: outcome.result } };
    }

    case "ai_decision": {
      const prompt = `Context variables: ${JSON.stringify(variables)}
Decision needed: ${config.question}
${config.options ? `Choose one of these options: ${JSON.stringify(config.options)}` : ""}
Respond with ONLY JSON: {"choice": "<your choice>", "reasoning": "<why, 1-2 sentences>"}`;
      if (ctx.orgId) {
        enforceQuota(ctx.orgId, "maxAiRequests", "AI requests this billing period");
        enforceSpendLimit(ctx.orgId, { agentId: ctx.agentId, userId: ctx.userId, automationId: ctx.automationId });
      }
      const completion = await chatComplete({ messages: [{ role: "user", content: prompt }], systemPrompt: "You are making a decision inside an automated workflow. Be decisive and explain your reasoning briefly." });
      const raw = completion.text;
      if (ctx.orgId) {
        recordAiTextUsage(ctx.orgId, {
          provider: process.env.AI_PROVIDER || "anthropic",
          agentId: ctx.agentId || null, userId: ctx.userId, automationId: ctx.automationId || null,
          promptTokens: completion.usage?.promptTokens || 0,
          completionTokens: completion.usage?.completionTokens || 0,
        });
      }
      const decision = safeParseJson(raw, { choice: config.options?.[0] || null, reasoning: "Could not parse a structured decision; defaulted to the first option." });
      const key = config.resultVariable || "aiDecision";
      return { outcome: "continue", variables: { ...variables, [key]: decision } };
    }

    case "approval": {
      const reason = resolveDeep(config.reason || "This workflow step requires your approval to continue.", variables);
      const { confirmationId } = createApprovalStep({ runId: ctx.runId, userId: ctx.userId, reason });
      return { outcome: "pause", confirmationId, reason, variables };
    }

    case "delay": {
      // Only short in-process delays are supported — see PHASE6_NOTES.md.
      // There's no persistent job scheduler here, same disclosed limitation
      // as Phase 5's fire-and-forget webhook processing.
      const ms = Math.min(Number(config.seconds || 0) * 1000, 60_000);
      if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
      return { outcome: "continue", variables };
    }

    case "loop": {
      const items = resolveDeep(config.overVariable, variables);
      const list = Array.isArray(items) ? items : [];
      const itemVar = config.itemVariable || "item";
      const collected = [];
      for (const item of list) {
        let loopVars = { ...variables, [itemVar]: item };
        for (const nested of config.steps || []) {
          const result = await executeStep({ type: nested.type, config: JSON.stringify(nested.config || {}) }, loopVars, ctx);
          loopVars = result.variables;
          if (result.outcome === "fail" || result.outcome === "pause") {
            // Nested pausing mid-loop isn't supported in this pass — stop the
            // loop and surface the failure/pause at the loop level instead.
            return { outcome: result.outcome, error: result.error, confirmationId: result.confirmationId, reason: result.reason, variables: loopVars };
          }
        }
        collected.push(loopVars);
      }
      const key = config.resultVariable || "loopResults";
      return { outcome: "continue", variables: { ...variables, [key]: collected } };
    }

    case "end":
      return { outcome: "end", variables };

    default:
      return { outcome: "fail", error: `Unknown step type "${step.type}"`, variables };
  }
}
