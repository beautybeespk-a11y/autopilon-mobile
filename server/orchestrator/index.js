import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { chatComplete } from "../ai/provider.js";
import { listToolsForSkills, getTool } from "../tools/registry.js";
import { getAgentSkillIds } from "./permissions.js";
import { runTool } from "./executor.js";

const MAX_STEPS = 8; // raised from 5 in Phase 2 — research flows chain search + multiple reads + report generation

function createPlan({ userId, conversationId, goal }) {
  const id = cryptoRandom();
  const now = new Date().toISOString();
  db.prepare(
    "INSERT INTO execution_plans (id, userId, conversationId, goal, status, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'planning', ?, ?)"
  ).run(id, userId, conversationId || null, goal, now, now);
  return id;
}

function setPlanStatus(planId, status) {
  db.prepare("UPDATE execution_plans SET status = ?, updatedAt = ? WHERE id = ?").run(status, new Date().toISOString(), planId);
}

function buildSystemPrompt({ agentSystemPrompt, availableTools }) {
  const toolDocs = availableTools
    .map((t) => `- ${t.name}: ${t.description} | parameters: ${JSON.stringify(t.parameters)}`)
    .join("\n");

  const hasResearchTools = availableTools.some((t) => t.category === "research");
  const researchGuidance = hasResearchTools
    ? `

When researching:
- Use web_search to find sources, then read_webpage on the most relevant results before concluding anything.
- Some pages will fail to load (blocked, paywalled, etc.) — that's normal. If read_webpage fails, try a different result or proceed using the search result's snippet; don't give up on the whole request over one failed page.
- Use generate_report to synthesize findings once you have enough source material.
- Clearly separate facts drawn from sources from your own analysis/recommendations.
- Always include the sources you used in your final message.
- Never save anything to the Knowledge Library without first asking the user — use save_research only after they agree, since it requires their confirmation anyway.`
    : "";

  return `${agentSystemPrompt}

You can take real actions using the tools below when the user's request calls for one.
Available tools:
${toolDocs || "(none available to this agent)"}${researchGuidance}

Respond with ONLY a single JSON object, no other text, matching exactly one of these shapes:

1. Plain conversational reply (no tool needed):
{"type": "final", "message": "<your reply>"}

2. A single tool call:
{"type": "tool_call", "toolName": "<name>", "parameters": { ... }}

3. Multiple tool calls in sequence (only when the user clearly asked for multiple actions):
{"type": "plan", "goal": "<short summary>", "steps": [{"toolName": "<name>", "parameters": {...}}, ...]}

Rules:
- Only use a tool name from the list above.
- Never invent a tool.
- If no tool applies, use "final".
- When a tool returns a list of named items that have their own ID (campaigns, ad accounts, tasks, saved research, etc.), mention each item's real ID alongside its name in your reply — the user or a later step may need to reference it, and the name alone usually isn't enough to look it up again.
- When a tool result contains many items (e.g. more than 5), summarize the most relevant ones concisely rather than listing every field for every item in full — a complete, shorter answer is better than a longer one that gets cut off.
- Output raw JSON only — no markdown fences, no commentary.`;
}

function safeParseDecision(text) {
  // Defensive: some providers can hand back something other than a plain
  // string (e.g. an array of content parts) — coerce rather than crash the
  // whole request on a .trim() call.
  const asString = typeof text === "string" ? text : Array.isArray(text) ? text.map((p) => (typeof p === "string" ? p : p?.text ?? "")).join("") : String(text ?? "");
  const cleaned = asString.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // The model didn't return valid JSON — most often because the reply was
    // truncated mid-object (a long list plus a tight token limit). Try to
    // salvage the "message" field's content with a regex before giving up
    // and dumping the raw JSON scaffold in front of the user.
    const salvage = cleaned.match(/"message"\s*:\s*"([\s\S]*)/);
    if (salvage) {
      let message = salvage[1];
      // Trim a trailing, unterminated JSON tail if present (closing quote/brace).
      message = message.replace(/"\s*\}\s*$/, "");
      // Un-escape the common JSON escapes so the salvaged text reads naturally.
      message = message.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
      return { type: "final", message: message.trim() || "I ran into trouble formatting that reply — could you ask again, maybe for fewer items at once?" };
    }
    return { type: "final", message: text.trim() };
  }
}

function traceStep(type, detail, state) {
  return { type, detail, state };
}

// Recovers a real tool call when the model produced valid-but-malformed JSON —
// most commonly a duplicate "type" key (once holding the tool name, once
// holding something else, e.g. {"type":"create_memory","content":"...","type":"preference"}).
// JSON.parse silently keeps only the LAST duplicate key, so the tool name can
// already be lost from `decision` by the time we see it — this scans the
// ORIGINAL raw text instead, before that collapse happens.
function salvageMalformedToolCall(raw, decision) {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return null;
  const matches = [...raw.matchAll(/"(?:type|toolName)"\s*:\s*"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
  const registeredMatches = [...new Set(matches)].filter((name) => getTool(name));
  if (registeredMatches.length !== 1) return null; // ambiguous or nothing recognizable — don't guess
  const toolName = registeredMatches[0];
  const parameters = { ...decision };
  // "type" is deleted only when it *was* the tool-name field (i.e. it still
  // equals the tool name after parsing) — if a duplicate key caused a
  // different value to survive (as in the create_memory example above),
  // that surviving value is itself a real parameter (e.g. the memory's
  // "type": "preference") and must be kept, not discarded.
  if (decision.type === toolName) delete parameters.type;
  delete parameters.toolName;
  return [{ toolName, parameters }];
}

/**
 * Runs one turn of the orchestrator: decide (plan/tool_call/final), execute
 * any tool calls through the executor, and produce a final natural-language
 * response plus a trace of what happened for the ToolActivity UI.
 */
export async function orchestrate({ userId, agentId, conversationId, userMessage, history, agentSystemPrompt, extraContext, extraImage }) {
  const trace = [traceStep("planning", null, "active")];
  const skillIds = getAgentSkillIds(agentId);
  const availableTools = listToolsForSkills(skillIds);
  const modelChoice = agentId ? db.prepare("SELECT aiProvider, aiModel FROM agents WHERE id = ?").get(agentId) : null;

  const systemPrompt = buildSystemPrompt({ agentSystemPrompt, availableTools });
  let planId = null;
  let stepsRun = 0;
  let conversationForModel = [...history];

  // extraContext (e.g. an attached file's extracted text) is appended to
  // what the MODEL sees for this turn only — it's deliberately not part of
  // `history` as loaded from the DB, so the stored/displayed transcript
  // stays short and re-opening the conversation later doesn't replay a
  // wall of pasted file content.
  if (extraImage && conversationForModel.length) {
    // An attached image can't be folded into the text string the way
    // extraContext is — it becomes a multimodal content array instead
    // (canonical { type: "text" | "image", ... } parts; each provider
    // adapter converts these to its own vendor shape). Also turn-only,
    // never persisted into `history`.
    const last = conversationForModel[conversationForModel.length - 1];
    if (last.role === "user") {
      const text = extraContext ? `${last.content}\n\n${extraContext}` : last.content;
      conversationForModel = [
        ...conversationForModel.slice(0, -1),
        { ...last, content: [{ type: "text", text: text || "" }, { type: "image", mimeType: extraImage.mimeType, data: extraImage.base64 }] },
      ];
    }
  } else if (extraContext && conversationForModel.length) {
    const last = conversationForModel[conversationForModel.length - 1];
    if (last.role === "user") {
      conversationForModel = [
        ...conversationForModel.slice(0, -1),
        { ...last, content: `${last.content}\n\n${extraContext}` },
      ];
    }
  }
  const toolResults = [];

  while (stepsRun < MAX_STEPS) {
    const completion = await chatComplete({
      messages: conversationForModel, systemPrompt,
      provider: modelChoice?.aiProvider || undefined,
      model: modelChoice?.aiModel || undefined,
    });
    // Every provider adapter returns { text, usage } — standardized so this
    // loop (and salvageMalformedToolCall below, which regexes the original
    // text) never has to special-case a given provider's return shape.
    const raw = completion.text;
    const decision = safeParseDecision(raw);

    if (decision.type === "final") {
      trace[trace.length - 1].state = "done";
      trace.push(traceStep("completed", null, "done"));
      if (planId) setPlanStatus(planId, "completed");
      return { reply: decision.message || "Done.", trace, toolResults };
    }

    const calls =
      decision.type === "plan" && Array.isArray(decision.steps)
        ? decision.steps
        : decision.type === "tool_call"
        ? [{ toolName: decision.toolName, parameters: decision.parameters }]
        : salvageMalformedToolCall(raw, decision);

    if (!calls) {
      // Unrecognized shape — fail safe rather than ever showing raw JSON
      // scaffolding to the user (which is a real bug regardless of how the
      // model got here — the decision envelope is an internal format).
      trace.push(traceStep("completed", "Could not determine an action; answering directly.", "done"));
      return { reply: "I wasn't able to complete that — could you rephrase what you'd like me to do?", trace, toolResults };
    }

    if (!planId) planId = createPlan({ userId, conversationId, goal: decision.goal || userMessage });
    trace[trace.length - 1].state = "done";

    for (const call of calls) {
      stepsRun += 1;

      const toolDef = getTool(call.toolName);
      const INTEGRATION_LABELS = { meta_ads: "Meta Ads", whatsapp: "WhatsApp Business" };
      if (toolDef?.category && INTEGRATION_LABELS[toolDef.category]) {
        trace.push(traceStep("integration", INTEGRATION_LABELS[toolDef.category], "done"));
      }
      trace.push(traceStep("tool", `Selected: ${call.toolName}`, "active"));

      const outcome = await runTool({
        toolName: call.toolName,
        parameters: call.parameters || {},
        userId,
        agentId,
        conversationId,
        planId,
      });

      if (outcome.status === "awaiting_confirmation") {
        trace[trace.length - 1].state = "done";
        trace.push(traceStep("waiting", outcome.reason, "active"));
        setPlanStatus(planId, "running");
        return {
          reply: `Before I do that: ${outcome.reason}`,
          trace,
          toolResults,
          confirmation: { confirmationId: outcome.confirmationId, executionId: outcome.executionId, toolName: call.toolName },
        };
      }

      if (outcome.status === "failed") {
        trace[trace.length - 1].state = "done";
        trace.push(traceStep("error", `${call.toolName} failed: ${outcome.error}`, "done"));
        toolResults.push({ toolName: call.toolName, error: outcome.error });
        // Report the failure back to the model instead of aborting the whole
        // response — a single blocked page or bad parameter shouldn't kill a
        // multi-step research flow. The model can retry a different source,
        // skip it, or summarize with what it already has.
        conversationForModel = [
          ...conversationForModel,
          { role: "assistant", content: JSON.stringify(decision) },
          {
            role: "user",
            content: `Tool "${call.toolName}" failed: ${outcome.error}. Try a different approach (e.g. a different source or query), continue without it, or respond with type "final" summarizing what you have so far.`,
          },
        ];
        continue;
      }

      trace[trace.length - 1].state = "done";
      toolResults.push({ toolName: call.toolName, result: outcome.result });
      // Feed the tool's result back to the model so it can decide the next step
      // or produce the final summary.
      conversationForModel = [
        ...conversationForModel,
        { role: "assistant", content: JSON.stringify(decision) },
        { role: "user", content: `Tool "${call.toolName}" result: ${JSON.stringify(outcome.result)}. Continue, or respond with type "final" if done.` },
      ];
    }
  }

  if (planId) setPlanStatus(planId, toolResults.some((r) => !r.error) ? "completed" : "failed");
  trace.push(traceStep("completed", "Reached step limit.", "done"));
  const anySuccess = toolResults.some((r) => !r.error);
  return {
    reply: anySuccess
      ? "I completed several steps but ran up against the step limit before finishing everything. Here's what I found so far — let me know if you'd like me to continue."
      : "I wasn't able to complete this — every step I tried failed. Let me know if you'd like me to try a different approach.",
    trace,
    toolResults,
  };
}
