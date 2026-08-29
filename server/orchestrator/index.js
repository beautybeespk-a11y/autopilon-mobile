import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { chatComplete } from "../ai/provider.js";
import { listToolsForSkills, getTool } from "../tools/registry.js";
import { getAgentSkillIds } from "./permissions.js";
import { runTool } from "./executor.js";
import { enforceQuota } from "./billing.js";
import { enforceSpendLimit } from "./costControls.js";
import { recordAiTextUsage } from "./costEngine.js";
import { resolveOrgId } from "./voiceUsage.js";
import { getActivePlanForConversation } from "../agents/metaExpert/planner.js";
import { messageIndicatesExecutionApproval, fingerprintPlan } from "../agents/metaExpert/policy.js";
import { normalizePlanEnumAliases } from "../agents/metaExpert/planSchema.js";

const MAX_STEPS = 8; // raised from 5 in Phase 2 — research flows chain search + multiple reads + report generation

// A real, recurring failure mode with faster/smaller models (this
// deployment's default is gpt-4o-mini): the model responds with type
// "final" and text like "let me check that for you" or "please hold on,"
// but never actually attaches a tool call — the turn just ends there, and
// whatever it said it would do never happens. Caught live in production
// (Meta Ads Manager narrating "I'll retrieve the posts" with an empty
// trace, three separate times in one debugging session). This can't be
// fully prevented by agent instructions alone (models don't follow
// wording 100% of the time) — this catches it at the one place every
// agent's response passes through, instead of re-patching each agent's
// prompt as the pattern turns up. Deliberately narrow and past-tense-safe
// (won't match "I checked and found..."): only future/present-intent
// phrasing that specifically implies an action is still pending.
//
// Two more real occurrences (live) escaped the "verb + immediate object"
// version of this regex: "I will first retrieve the recent posts..." and
// "Let me proceed with that." — both have a word (an adverb, a
// preposition) between the modal verb and its object, so a shape that
// required them adjacent still missed real cases. Chasing the exact
// grammatical shape of every way a model can phrase "I'm about to do
// this" is whack-a-mole. Matching on the commitment PHRASE alone — no
// requirement about what follows it — is far more robust, at the cost of
// occasionally nudging a legitimate final answer that happens to contain
// one of these (e.g. "I will continue monitoring this weekly" as a
// closing remark on completed work). That's an acceptable trade: the
// nudge is capped at one retry (MAX_NARRATION_NUDGES) and a correct final
// answer survives being asked to confirm it has nothing left to do,
// whereas a real unfulfilled action silently returned as done does not
// recover on its own. "let me know" is excluded — it's asking the user
// something, not promising an action.
const NARRATION_WITHOUT_ACTION = /\b(let me(?!\s+know)|let's|i'll|i will|i'm going to|i am going to|i plan to|i need to|i'm about to|i am about to|hold on|one moment|give me a moment|please wait)\b/i;
// Exactly one retry — this must never become a second way to loop
// indefinitely alongside MAX_STEPS/stepsRun (which this doesn't touch,
// since a narrated-but-toolless response was never counted as a step to
// begin with). If the model narrates again even after being told to
// stop, just return that reply rather than keep spending real tokens on
// it — same "stop trying" instinct as the tool-failure retry message a
// few lines below already has for a different failure shape.
const MAX_NARRATION_NUDGES = 1;

// A hard output boundary against internal data reaching the user — not
// just an instruction (buildSystemPrompt() below already tells the model
// never to copy the "[Underlying tool data...]" history annotation
// forward, but confirmed live: that instruction alone was NOT reliable
// enough — the exact same leak recurred). Every one of these strings is
// something a human-written recommendation would never naturally
// produce — a bracketed internal-context marker, an internal identifier
// in camelCase/snake_case, or raw tool-call JSON syntax — so their mere
// presence in a "final" message is itself the signal, without needing to
// know which specific internal mechanism produced it this time (today
// it's the tool-data-history annotation; tomorrow it could be a raw
// planId echoed from a tool result, or JSON scaffolding — all covered by
// the same check rather than chasing each source individually).
// Exported so a regression test can assert directly against this exact
// pattern (server/test/internalLeakageGuardRegression.js) without needing
// a full mocked model round-trip through orchestrate().
//
// Round 3 (live testing) added: a raw "Plan ID: ..." line appearing
// directly in a customer-facing recommendation — formatRecommendation()
// (server/agents/metaExpert/planner.js) never puts one there, so this was
// the model adding it itself; caught the same way as everything else here,
// by pattern-matching the leak rather than trusting the prompt not to
// produce it. conversationId and raw plan-status enum values (proposed/
// approved/executing/superseded — internal state words, distinct from the
// human-facing "Status: Paused" line the formatter DOES produce) join the
// same list for the same reason.
export const INTERNAL_LEAK_PATTERNS = new RegExp(
  [
    /underlying tool data/i,
    /do not repeat verbatim/i,
    /\bplanId\b/i,
    /\bplan[_ ]id\s*[:#]/i,
    /\binternal_plan\b/i,
    /\bconversationId\b/i,
    /"toolName"\s*:/i,
    /"resolved(AdAccountId|PageId|PixelId|CatalogId)"/i,
    /resolvedAdAccountId/i,
    /resolvedPageId/i,
    /\bstatus"?\s*[:=]\s*"?(proposed|approved|executing|executed|failed|rejected|superseded)"?/i,
  ]
    .map((r) => r.source)
    .join("|"),
  "i"
);
const MAX_LEAK_NUDGES = 1;

// Issue 6 (live testing round 3): "Create the best campaign you recommend
// for my business" led the model to call meta_expert.execute_campaign_plan
// as its very first action, with no plan ever proposed — which reached
// Meta and failed with a raw "Invalid parameter" error. The tool's own
// state-machine checks (planner.js/tools/meta/metaExpert.js) already
// refuse to execute when no valid plan exists, but that's still the model
// being ALLOWED to try and finding out after the fact. This gate runs in
// the orchestrator, before the tool is ever dispatched — the model is
// never even given the chance to call Meta without (a) an active plan for
// this conversation and (b) genuine approval language in the user's own,
// current message. Presenting a recommendation is not approval; only the
// user's own words are.
export function checkExecutionApprovalGate({ userId, conversationId, userMessage }) {
  const active = getActivePlanForConversation(userId, conversationId);
  if (!active) {
    return "No active campaign plan exists for this conversation yet. Call meta_expert.create_campaign_plan first (after meta_expert.research_business_context if you haven't already), present the recommendation to the user, and only call this tool once they've explicitly approved it.";
  }
  if (!messageIndicatesExecutionApproval(userMessage)) {
    return 'The user has not explicitly approved the current plan in their latest message. Present (or re-present) the recommendation and wait for clear approval language (e.g. "approve", "proceed", "run it", "yes, create it") before calling this tool.';
  }
  return null;
}

// CONFIRMED LIVE BUG (round 13): "Why did you choose all genders 18-65 and
// PKR 10,000/day? Review my WooCommerce products, Meta history, and
// audience data, then improve the plan before I approve it" was answered
// directly from conversational memory — the Agent Trace showed only
// Planning -> Completed, no tool ever called. The reply repeated stale
// claims almost verbatim from earlier turns, including "your account
// lacks a connected Meta Pixel" — directly contradicted by that SAME
// conversation's own earlier research_business_context result
// (metaPixelCount: 2) — and asked the user to design demographics/budget
// themselves, exactly the intake-form behavior this agent is supposed to
// never exhibit. Nothing backend-enforced ever required the model to
// actually call a tool for this kind of request; every other gate in this
// file (checkExecutionApprovalGate, checkCreatePlanRetryGate) only engages
// AFTER the model has already decided to call a specific tool.
//
// Two deterministic triggers, checked ONLY when stepsRun === 0 (no tool
// has been called yet THIS turn — once one has, the model is answering
// from fresh data, not memory, so neither trigger applies past that
// point):
//
//   1. Plan review/revision intent while an active plan exists: "review,"
//      "improve," "optimize," "reconsider," "why did you choose," etc.
//      aimed at the plan/audience/budget/targeting. This must always go
//      through the real revision path (research first if data was asked
//      for, then create_campaign_plan with revisesPlanId) — never a
//      conversational answer built from what the assistant said earlier.
//   2. A direct question about CURRENT connected integration state (a
//      Pixel, Page, ad account, WooCommerce/Shopify connection) — these
//      facts can only be known by actually checking, and change over time
//      (a Pixel can be added after an earlier turn correctly said there
//      wasn't one) — a "final" answer to one of these with no tool call
//      this turn is answering from potentially-stale memory, not fact.
//
// Deliberately loose/non-exhaustive regexes — same trade-off
// NARRATION_WITHOUT_ACTION above already documents: an occasional
// unnecessary nudge (one extra model turn, capped by
// MAX_STALE_ANSWER_NUDGES) is far cheaper than a real live bug like this
// one going uncaught.
const PLAN_REVIEW_INTENT_PATTERNS = new RegExp(
  [
    /\breview\b.{0,60}\b(plan|campaign|audience|budget|woocommerce|shopify|meta (history|data)|account data)\b/i,
    /\b(improve|optimi[sz]e|reconsider|refine|re-?evaluate|revise)\b.{0,40}\b(plan|campaign|audience|budget|targeting)\b/i,
    /\bwhy did you (choose|pick|select|recommend|set)\b/i,
    /\bwhy (was|is) (that|this|the)\b.{0,40}\b(audience|budget|amount|targeting|chosen|choice)\b/i,
    /\bchange the audience\b/i,
    /\buse my (account|store|woocommerce|shopify|meta) (data|history)\b.{0,40}\b(refine|improve|revise|campaign|plan)\b/i,
    /\brefresh (my|the) (data|research)\b/i,
  ]
    .map((r) => r.source)
    .join("|"),
  "i"
);
const INTEGRATION_STATE_NOUN_PATTERN = /\b(pixel|meta pixel|facebook page|ad account|woocommerce|shopify)\b/i;
const INTEGRATION_STATE_QUESTION_PATTERNS = new RegExp(
  [
    // Verb before the noun ("do I have a Pixel", "is WooCommerce connected").
    /\b(does|do|is|are|has|have)\b.{0,30}\b(pixel|meta pixel|facebook page|ad account|woocommerce|shopify)\b/i,
    // Noun before the verb ("my Pixel — is it connected?").
    /\b(pixel|meta pixel|facebook page|ad account|woocommerce|shopify)\b.{0,30}\b(connect|exist|set ?up|selected|active)\b/i,
    /\bwhat('| i)?s? my (default )?(ad account|facebook page|pixel)\b/i,
  ]
    .map((r) => r.source)
    .join("|"),
  "i"
);
// A short follow-up ("are you sure? check again.") carries no
// integration-state keywords of its own — it only makes sense read against
// what was just said. If the immediately preceding assistant turn asserted
// an integration-state fact (e.g. "no Pixel connected") and the user is
// now pressing on it, that assertion must be re-verified with a real tool
// call, not repeated from memory a second time.
const STALE_CLAIM_FOLLOWUP_PATTERNS = /\b(are you sure|sure\?|check again|double[- ]check|confirm that|verify that|really\?|are you certain)\b/i;
const MAX_STALE_ANSWER_NUDGES = 1;

// Returns a nudge message when the model's "final" decision should be
// blocked because it's answering a plan-review/revision request or an
// integration-state question without ever calling a tool this turn — or
// null when neither trigger applies. `hasMetaExpertTools` guards against
// nudging an agent that doesn't even have the Meta Expert skill enabled.
// `lastAssistantMessage` (the most recent assistant turn in history, if
// any) lets a content-free follow-up ("are you sure? check again.") be
// matched against the integration-state claim it's actually challenging.
function checkStaleFactualAnswerGate({ userMessage, hasActivePlan, hasMetaExpertTools, lastAssistantMessage }) {
  if (!hasMetaExpertTools || typeof userMessage !== "string") return null;
  if (hasActivePlan && PLAN_REVIEW_INTENT_PATTERNS.test(userMessage)) {
    return 'This looks like a request to review or revise the ACTIVE campaign plan (e.g. "review my data," "why did you choose this audience/budget," "improve/reconsider the plan") — that must go through the real revision path, never a conversational answer from memory. If the user asked you to review WooCommerce products, Meta account history, or audience data, call meta_expert.research_business_context first to get CURRENT data — a Pixel or connection status can change between turns, never state it from what an earlier turn said. Then call meta_expert.create_campaign_plan with revisesPlanId set to the active plan\'s id, changing only what the current evidence actually supports, before presenting anything to the user.';
  }
  if (INTEGRATION_STATE_QUESTION_PATTERNS.test(userMessage)) {
    return "This asks about CURRENT connected integration state (a Pixel, Page, ad account, or store connection) — these can change between turns and must never be answered from what an earlier message said. Call the real lookup tool (meta_expert.research_business_context, meta.list_pages, meta.list_ad_accounts, etc. as appropriate) to get the CURRENT answer before replying.";
  }
  if (
    STALE_CLAIM_FOLLOWUP_PATTERNS.test(userMessage) &&
    typeof lastAssistantMessage === "string" &&
    INTEGRATION_STATE_NOUN_PATTERN.test(lastAssistantMessage)
  ) {
    return "The user is pressing on an integration-state claim (a Pixel, Page, ad account, or store connection) made in the previous turn. That claim can go stale between turns and must be re-verified with a real tool call now, not simply repeated from memory. Call the real lookup tool (meta_expert.research_business_context, meta.list_pages, meta.list_ad_accounts, etc. as appropriate) to get the CURRENT answer before replying.";
  }
  return null;
}

// Issue 5 (live testing round 5): "I want more sales to my website" put
// the model into an unbounded loop calling meta_expert.create_campaign_plan
// six times, each presumably rejected, until MAX_STEPS was hit and the
// user saw a raw "Reached step limit" trace line — an internal
// orchestration failure with no customer-safe framing at all. Two
// deterministic gates, checked per-turn (state lives in orchestrate()'s
// own closure, reset every call — matches every other nudge counter in
// this file):
//
//   1. Duplicate: the new attempt's plan.js fingerprintPlan() matches the
//      PREVIOUS attempt's, and that previous attempt was rejected — the
//      model resubmitted an unchanged plan hoping for a different
//      result. Blocked immediately with META_PLAN_DUPLICATE_RETRY,
//      without spending a real createPlan() call/DB write on it.
//   2. Limit: attempts >= 2 (one initial + one automatic repair) — the
//      model is not even given the chance to try a third time. Returns a
//      customer-safe "final" reply directly, ending the turn, rather than
//      feeding the rejection back and letting the loop continue toward
//      MAX_STEPS.
//
// Returns { blocked: "duplicate" | "limit" | null, message }.
// The limit check runs BEFORE the duplicate check: `attempts` counts every
// create_campaign_plan call this turn, whether it was a real attempt or a
// blocked duplicate (both branches below increment it, in orchestrate()) —
// so once the cap is reached, a THIRD call is always hard-stopped here,
// never allowed through as "just another duplicate check." This is what
// bounds "no more than 2 total create_campaign_plan attempts per user turn"
// regardless of whether the model keeps resubmitting the same plan or
// starts inventing new ones.
// Round 10 (live testing), requirement 4: apply the SAME deterministic
// enum-alias normalization planner.js applies before structural validation
// (normalizePlanEnumAliases, planSchema.js) BEFORE fingerprinting too — a
// resubmission that only differs from the one just rejected by a harmless
// alias spelling (e.g. LOWEST_COST_WITHOUT_BID_CAP vs. the canonical
// LOWEST_COST_WITHOUT_CAP) must fingerprint identically, not look like a
// genuinely different repair. Pure/stateless, so it's safe to call here on
// the raw (possibly partial, pre-merge) tool call parameters directly.
function fingerprintPlanNormalized(parameters) {
  return fingerprintPlan(normalizePlanEnumAliases(parameters).plan);
}

function checkCreatePlanRetryGate({ parameters, attempts, lastFingerprint, wasLastRejected, maxAttempts }) {
  if (attempts >= maxAttempts) {
    return {
      blocked: "limit",
      message: `Already attempted ${attempts} times this turn (1 initial + 1 automatic repair) — no further attempts are allowed. Respond with type "final" and tell the user plainly what's blocking it.`,
    };
  }
  if (wasLastRejected && lastFingerprint && fingerprintPlanNormalized(parameters) === lastFingerprint) {
    return {
      blocked: "duplicate",
      message:
        'META_PLAN_DUPLICATE_RETRY: This plan is identical (in every strategic field) to the one just rejected — resubmitting it will fail the same way. Fix the SPECIFIC field(s) named in the last rejection\'s repairGuidance, or if it genuinely can\'t be resolved, respond with type "final" and tell the user plainly what\'s blocking it instead of calling this again.',
    };
  }
  return { blocked: null, message: null };
}

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
- Earlier messages in this conversation may end with a "[Underlying tool data from this turn, for your own reference in follow-ups — do not repeat verbatim: ...]" note. That note is internal context only, added after the fact — it was never actually said out loud and is not part of any reply you or the user wrote. Never copy that bracketed note, or its "[...]" formatting, into your own message — write your own plain-language reply using the data it contains instead.
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
    // Confirmed live: a model attempted a tool_call with an unfilled
    // placeholder token as a parameter value (e.g. "dailyBudget":
    // YOUR_DAILY_BUDGET — a bare, unquoted word, not valid JSON) instead of
    // either resolving the real value or asking the user for it. That has
    // no "message" field to salvage, so the old fallback below
    // (`{type:"final", message: text.trim()}`) dumped the raw, broken
    // tool_call scaffolding straight into the chat as if it were a normal
    // reply — exactly the "never show raw JSON scaffolding to the user"
    // bug the orchestrate() loop's own unrecognized-shape branch already
    // guards against, just reached through a different path. Anything that
    // still looks like an attempted JSON envelope (starts with "{") is
    // flagged instead of shown verbatim; orchestrate() nudges the model to
    // retry with a real value once rather than silently failing outright,
    // same pattern as the narration nudge. Only genuinely freeform,
    // non-JSON prose (no leading "{") falls through to being shown as-is —
    // that's an intentional, permissive fallback for the rare case a model
    // replies without the structured envelope at all.
    if (cleaned.startsWith("{")) {
      return {
        type: "final",
        message: "I wasn't able to put that request together correctly — let me try again.",
        _malformedEnvelope: true,
      };
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
  const modelChoice = agentId ? db.prepare("SELECT aiProvider, aiModel, orgId FROM agents WHERE id = ?").get(agentId) : null;

  // Chat is the highest-volume AI path in the app and, until this pass, was
  // the one place that called chatComplete() directly with no quota check
  // and no usage/cost recording at all — every other generation surface
  // (Content Studio, automations) went through billing.js, this didn't.
  // orgId must be the org the AGENT belongs to, not just any org the user
  // happens to be a member of — a user in multiple orgs chatting through an
  // org-B agent must never be billed/blocked against org A. Only fall back
  // to the user's default org (voiceUsage.js's resolveOrgId) for personal
  // agents that aren't scoped to any org at all.
  const orgId = modelChoice?.orgId || resolveOrgId(userId);
  if (orgId) {
    enforceQuota(orgId, "maxAiRequests", "AI requests");
    enforceSpendLimit(orgId, { agentId, userId });
  }

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
    // Temporary diagnostic — remove once image attachments are confirmed
    // working end-to-end.
    console.log("[orchestrate] built multimodal content:", {
      lastRoleWasUser: last.role === "user",
      provider: modelChoice?.aiProvider || process.env.AI_PROVIDER || "anthropic",
      model: modelChoice?.aiModel || null,
    });
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
  // Accumulated across every model call in this turn (a multi-step
  // tool-calling turn can call the model several times) — exposed to
  // callers (the Public API's agent execution, Task 45) that need a
  // per-turn usage total. Not a second source of truth: these are the
  // exact same numbers recordAiTextUsage() below already writes into
  // usage_records for billing; this is just also handing them back to the
  // caller in the return value, which nothing previously did.
  const usageTotals = { promptTokens: 0, completionTokens: 0 };
  let narrationNudges = 0;
  let malformedNudges = 0;
  let leakNudges = 0;
  let staleAnswerNudges = 0;
  const MAX_MALFORMED_NUDGES = 1;
  const hasMetaExpertTools = availableTools.some((t) => t.name?.startsWith("meta_expert."));
  let createPlanAttempts = 0;
  let lastCreatePlanFingerprint = null;
  let lastCreatePlanWasRejected = false;
  const MAX_CREATE_PLAN_ATTEMPTS = 2;

  while (stepsRun < MAX_STEPS) {
    const provider = modelChoice?.aiProvider || process.env.AI_PROVIDER || "anthropic";
    const completion = await chatComplete({
      messages: conversationForModel, systemPrompt,
      provider: modelChoice?.aiProvider || undefined,
      model: modelChoice?.aiModel || undefined,
    });
    // Every real chatComplete() call in this loop is billable — recorded
    // every iteration, not just once per user message, since a multi-step
    // tool-calling turn can call the model several times.
    usageTotals.promptTokens += completion.usage?.promptTokens || 0;
    usageTotals.completionTokens += completion.usage?.completionTokens || 0;
    if (orgId) {
      recordAiTextUsage(orgId, {
        provider, agentId: agentId || null, userId,
        promptTokens: completion.usage?.promptTokens || 0,
        completionTokens: completion.usage?.completionTokens || 0,
      });
    }
    // Every provider adapter returns { text, usage } — standardized so this
    // loop (and salvageMalformedToolCall below, which regexes the original
    // text) never has to special-case a given provider's return shape.
    const raw = completion.text;
    const decision = safeParseDecision(raw);

    if (decision.type === "final") {
      if (decision._malformedEnvelope && malformedNudges < MAX_MALFORMED_NUDGES) {
        malformedNudges += 1;
        conversationForModel = [
          ...conversationForModel,
          { role: "assistant", content: raw },
          {
            role: "user",
            content: `That wasn't valid — it looks like you tried to call a tool but used a placeholder instead of a real value (e.g. a bare word like YOUR_AD_ACCOUNT_ID or YOUR_DAILY_BUDGET where a real id or number belongs). Never use placeholder tokens. If you don't have a real value yet, call the tool that resolves it first (e.g. meta.list_ad_accounts for an ad account id, meta.list_pages for a page id) — don't guess or invent one. If a value can only come from the user, ask them for it directly with type "final" instead of attempting the tool call.`,
          },
        ];
        continue;
      }
      const leaked = typeof decision.message === "string" && INTERNAL_LEAK_PATTERNS.test(decision.message);
      if (leaked && leakNudges < MAX_LEAK_NUDGES) {
        leakNudges += 1;
        conversationForModel = [
          ...conversationForModel,
          { role: "assistant", content: JSON.stringify(decision) },
          {
            role: "user",
            content: `Your reply included internal data that must NEVER be shown to a user — a bracketed "[Underlying tool data...]" note, a raw internal id, or tool-call-shaped text. Rewrite your answer as a plain-language recommendation only: no ids, no mention of tools, schemas, or internal state — just what you're recommending and why.`,
          },
        ];
        continue;
      }
      if (leaked) {
        // Leaked again even after one retry — never show it. Fail safe with
        // a generic message rather than risk showing internal data twice.
        trace[trace.length - 1].state = "done";
        trace.push(traceStep("completed", null, "done"));
        if (planId) setPlanStatus(planId, "completed");
        return { reply: "I've put together a recommendation, but I'm having trouble phrasing it cleanly — could you ask me to summarize it again?", trace, toolResults, usage: usageTotals };
      }
      const soundsLikeUnfulfilledAction =
        availableTools.length > 0 &&
        typeof decision.message === "string" &&
        NARRATION_WITHOUT_ACTION.test(decision.message);
      if (soundsLikeUnfulfilledAction && narrationNudges < MAX_NARRATION_NUDGES) {
        narrationNudges += 1;
        conversationForModel = [
          ...conversationForModel,
          { role: "assistant", content: JSON.stringify(decision) },
          {
            role: "user",
            content: `You said you'd do that, but didn't actually call a tool — nothing happened. If you have what you need, call the right tool now with type "tool_call" (or "plan" for multiple steps) instead of describing the next step. If something's genuinely missing that only the user can provide, ask for that specific thing with type "final" instead.`,
          },
        ];
        continue;
      }
      // Round 13 (live testing): only fires on the FIRST model decision of
      // this turn — once stepsRun > 0, a tool HAS already been called this
      // turn, so the model is answering from fresh data, not memory.
      if (stepsRun === 0 && staleAnswerNudges < MAX_STALE_ANSWER_NUDGES) {
        const lastAssistantMessage = [...history].reverse().find((m) => m?.role === "assistant")?.content;
        const staleGateMessage = checkStaleFactualAnswerGate({
          userMessage,
          hasActivePlan: Boolean(getActivePlanForConversation(userId, conversationId)),
          hasMetaExpertTools,
          lastAssistantMessage,
        });
        if (staleGateMessage) {
          staleAnswerNudges += 1;
          conversationForModel = [
            ...conversationForModel,
            { role: "assistant", content: JSON.stringify(decision) },
            { role: "user", content: staleGateMessage },
          ];
          continue;
        }
      }
      trace[trace.length - 1].state = "done";
      trace.push(traceStep("completed", null, "done"));
      if (planId) setPlanStatus(planId, "completed");
      return { reply: decision.message || "Done.", trace, toolResults, usage: usageTotals };
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
      return { reply: "I wasn't able to complete that — could you rephrase what you'd like me to do?", trace, toolResults, usage: usageTotals };
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

      let outcome;
      if (call.toolName === "meta_expert.execute_campaign_plan") {
        const gateError = checkExecutionApprovalGate({ userId, conversationId, userMessage });
        if (gateError) outcome = { status: "failed", error: gateError };
      } else if (call.toolName === "meta_expert.create_campaign_plan") {
        const gate = checkCreatePlanRetryGate({
          parameters: call.parameters || {},
          attempts: createPlanAttempts,
          lastFingerprint: lastCreatePlanFingerprint,
          wasLastRejected: lastCreatePlanWasRejected,
          maxAttempts: MAX_CREATE_PLAN_ATTEMPTS,
        });
        if (gate.blocked === "duplicate") {
          outcome = { status: "failed", error: gate.message };
          createPlanAttempts += 1;
        } else if (gate.blocked === "limit") {
          trace[trace.length - 1].state = "done";
          trace.push(traceStep("completed", "Campaign plan could not be finalized after one automatic repair attempt.", "done"));
          if (planId) setPlanStatus(planId, "failed");
          return {
            reply:
              "I couldn't finalize the campaign recommendation automatically because one required business setting is still unresolved. Could you check your Meta Ads integration settings (ad account, Facebook Page, or budget), or tell me more about what you'd like for this campaign?",
            trace,
            toolResults,
            usage: usageTotals,
          };
        }
      }
      if (!outcome) {
        outcome = await runTool({
          toolName: call.toolName,
          parameters: call.parameters || {},
          userId,
          agentId,
          conversationId,
          planId,
          userMessage,
        });
        if (call.toolName === "meta_expert.create_campaign_plan") {
          createPlanAttempts += 1;
          lastCreatePlanWasRejected = outcome.status === "completed" && outcome.result && outcome.result.valid === false;
          lastCreatePlanFingerprint = fingerprintPlanNormalized(call.parameters || {});
        }
      }

      if (outcome.status === "awaiting_confirmation") {
        trace[trace.length - 1].state = "done";
        trace.push(traceStep("waiting", outcome.reason, "active"));
        setPlanStatus(planId, "running");
        return {
          reply: `Before I do that: ${outcome.reason}`,
          trace,
          toolResults,
          confirmation: { confirmationId: outcome.confirmationId, executionId: outcome.executionId, toolName: call.toolName },
          usage: usageTotals,
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
  // Internal orchestration detail — this loop hit MAX_STEPS without the
  // model producing a "final" response. Never surface the words "step
  // limit" to the user (round 6 requirement): both the trace label and the
  // reply below are worded as an ordinary stopping point, not an internal
  // failure.
  trace.push(traceStep("completed", "Finished processing this request.", "done"));
  const anySuccess = toolResults.some((r) => !r.error);
  return {
    reply: anySuccess
      ? "I completed several steps but wasn't able to finish everything in this pass. Here's what I found so far — let me know if you'd like me to continue."
      : "I wasn't able to complete this — every step I tried failed. Let me know if you'd like me to try a different approach.",
    trace,
    toolResults,
    usage: usageTotals,
  };
}
