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
import { getActiveStrategyForConversation } from "../agents/metaExpertV2/strategyStore.js";
import { messageIndicatesExecutionApproval as messageIndicatesExecutionApprovalV2 } from "../agents/metaExpertV2/policy.js";
import { trace as v2Trace } from "../agents/metaExpertV2/diagnostics.js";

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

// CONFIRMED LIVE BUG (round 17): after execute_strategy was blocked for a
// missing budget and the model correctly asked the user for one, the
// user replied with a plain number ("500/day"). The model's NEXT
// decision was "final" with the reply "Executing the strategy with a
// daily budget of 500 PKR." — Agent Trace showed only Planning ->
// Completed, no tool ever called. Nothing was actually revised or
// executed; the reply asserted a real-money action was happening when it
// wasn't. NARRATION_WITHOUT_ACTION above only catches FUTURE-tense
// commitments ("I'll do X") — it doesn't cover a PRESENT/PAST-tense claim
// that something is already running or done, which is arguably worse
// since it tells the customer a real action already occurred.
// checkStaleFactualAnswerGate (stepsRun === 0 only) and the honesty guard
// (only fires when build/revise_strategy was actually REJECTED this
// turn) both structurally can't catch this either — neither engages when
// no V2 tool was attempted at all this turn. Scoped tightly to the exact
// language a genuine execute/revise completion claim uses, and gated on
// hasV2Tools + neither revise_strategy nor execute_strategy having
// actually run this turn — a legitimate final reply after a REAL
// execute_strategy call this turn (e.g. "Your campaign is now created
// and paused") is untouched, since executeCalledThisTurn is true there.
const EXECUTION_CLAIM_WITHOUT_CALL_PATTERN = /\b(executing the (strategy|campaign)|i'?ve (set|updated|increased|revised|applied)\b.{0,30}\bbudget|(campaign|strategy|ad set) is now (created|running|live|executing)|proceeding to (execute|create) the (campaign|strategy))\b/i;
const MAX_EXECUTION_CLAIM_NUDGES = 1;
function checkExecutionClaimWithoutCallGate({ decision, hasV2Tools, executeCalledThisTurn, reviseCalledThisTurn }) {
  if (!hasV2Tools || decision.type !== "final" || typeof decision.message !== "string") return null;
  if (executeCalledThisTurn || reviseCalledThisTurn) return null;
  if (!EXECUTION_CLAIM_WITHOUT_CALL_PATTERN.test(decision.message)) return null;
  return 'Your reply claims the strategy is being executed, revised, or updated, but neither meta_expert_v2.revise_strategy nor meta_expert_v2.execute_strategy was actually called this turn — nothing happened. If you now have what you need (e.g. a budget the user just gave you), call the real tool now with type "tool_call" instead of describing it as done. Never describe an action as executing/created/updated/running unless the matching tool call actually ran and succeeded this turn.';
}

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

// Meta Ads Expert V2's own version of the gate above, kept as a SEPARATE
// function (not a shared/modified checkExecutionApprovalGate) per the V2
// rebuild's own instruction: build V2 beside the original planner, never
// patch the original's internals to serve V2. Same principle — the model
// is never even given the chance to call meta_expert_v2.execute_strategy
// without (a) an active strategy for this conversation and (b) genuine
// approval language in the user's own, current message — just pointed at
// V2's own strategy store (server/agents/metaExpertV2/strategyStore.js)
// instead of the original planner's meta_campaign_plans table.
export function checkV2ExecutionApprovalGate({ userId, conversationId, userMessage }) {
  const active = getActiveStrategyForConversation(userId, conversationId);
  if (!active) {
    return "No active strategy exists for this conversation yet. Call meta_expert_v2.build_strategy first (after meta_expert_v2.get_business_snapshot if you haven't already), present the recommendation to the user, and only call this tool once they've explicitly approved it.";
  }
  if (!messageIndicatesExecutionApprovalV2(userMessage)) {
    return 'The user has not explicitly approved the current strategy in their latest message. Present (or re-present) the recommendation and wait for clear approval language (e.g. "approve", "proceed", "run it", "yes, create it") before calling this tool.';
  }
  // Live bug: budget_daily is deliberately nullable at build time (the
  // schema explicitly allows it — "Null if a budget policy/user input is
  // still needed, never invent a number"), so a strategy can be validly
  // SAVED with no budget set. Nothing here checked for that before letting
  // an "approve" reach execute_strategy — the call went through to the
  // real Meta Ad Set creation, which requires a real budget, and Meta's
  // own API rejected it with a raw "(#100) Invalid parameter" the
  // customer saw verbatim after clicking Approve. Same principle as the
  // rest of this gate: catch it before the tool is ever dispatched, not
  // after a doomed real API call.
  if (typeof active.strategy.budget_daily !== "number" || active.strategy.budget_daily <= 0) {
    return "This strategy still has no daily budget set — Meta requires a real budget to create the Ad Set and this call would fail. Ask the user what daily budget they'd like (or call meta_expert_v2.revise_strategy with a budget_daily once they answer) before calling execute_strategy again.";
  }
  return null;
}

// CONFIRMED LIVE BUG (V2 live testing): "I want more sales to my website"
// led the model to call meta_expert_v2.build_strategy repeatedly within
// the same turn until MAX_STEPS was hit and the user saw the generic
// step-limit fallback reply. build_strategy returning `valid:false` is a
// normal `status:"completed"` tool result (see runTool()/executeNow() in
// orchestrator/executor.js) — not a thrown "failed" outcome — so nothing
// ever capped how many times the MODEL could re-invoke the tool from
// scratch. strategyBuilder.js's "one generation attempt, no internal
// repair loop" (Step 7) only bounds what happens INSIDE a single call;
// it does nothing to stop the model calling the tool again a moment
// later. Same nudge-then-hard-stop shape as every other gate in this
// file: each of the 4 V2 tools may be REALLY dispatched at most once per
// turn; a repeat attempt is intercepted here — before it ever reaches
// runTool(), so a second real build/revise/snapshot/execute NEVER
// actually happens — and answered with a nudge quoting exactly what the
// first call returned. A second repeat (a third total call for that
// tool) hard-stops the turn with a clean customer-safe reply instead of
// looping toward MAX_STEPS.
const V2_SINGLE_CALL_TOOLS = new Set([
  "meta_expert_v2.get_business_snapshot",
  "meta_expert_v2.build_strategy",
  "meta_expert_v2.revise_strategy",
  "meta_expert_v2.execute_strategy",
]);
const MAX_V2_TOOL_NUDGES = 1;

// Human-readable digest of what a V2 tool's first (and only allowed) real
// call this turn actually returned — quoted back to the model so "use the
// first result" is something it can act on, not just an instruction to
// obey blindly.
function summarizeV2ToolResult(toolName, outcome) {
  if (!outcome) return "no result was captured for it.";
  if (outcome.status === "failed") return `it failed: ${outcome.error}`;
  const result = outcome.result;
  if (toolName === "meta_expert_v2.get_business_snapshot") {
    return "it returned the current business snapshot, already shown to you above — use that data, don't fetch it again.";
  }
  if (toolName === "meta_expert_v2.build_strategy" || toolName === "meta_expert_v2.revise_strategy") {
    if (result?.valid === false) {
      return `it was rejected as unresolved — field "${result.field}": ${result.issue}. That's a genuine business issue, not something calling it again will fix.`;
    }
    return `it succeeded (strategyId: ${result?.strategyId}) — the recommendation text was already returned to you above; present it and wait for the user's explicit approval.`;
  }
  if (toolName === "meta_expert_v2.execute_strategy") {
    return `it succeeded (campaignId: ${result?.campaignId}) — the campaign was already created, paused. Do not execute it again.`;
  }
  return `it returned: ${JSON.stringify(result)}`;
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

// CONFIRMED LIVE BUG (V2 live testing): "Choose the exact best creative
// for this campaign from my recent Facebook/Instagram content and
// WooCommerce products. Tell me which specific Reel/post/product you
// selected and why." was answered directly — Agent Trace showed only
// Planning -> Completed, no tool ever called — yet the reply confidently
// named a specific post/product/date and described it as high engagement/
// proven effectiveness. None of that could have been known: it was
// invented. Neither PLAN_REVIEW_INTENT_PATTERNS (requires an ACTIVE plan/
// strategy, and doesn't match "choose"/"pick"/"which post/product"
// phrasing at all) nor INTEGRATION_STATE_QUESTION_PATTERNS (Pixel/Page/ad
// account/store connection only) covers a creative-selection request —
// this category of ask fell through every existing gate in this file.
//
// Deliberately checked with NO hasActivePlan requirement (unlike
// PLAN_REVIEW_INTENT_PATTERNS) — a creative-selection request is just as
// invention-prone on a brand-new conversation with no strategy yet as it
// is mid-revision; the trigger is the request TYPE, not conversation
// state. Same loose/non-exhaustive regex trade-off as every other trigger
// in this file — an occasional unnecessary nudge is far cheaper than
// naming a real post/product/date that was never actually looked up.
// Kept as a labeled ARRAY (not just a combined regex) so live diagnostic
// tracing (see checkCreativeRevisionRequiredGate's call site below) can
// report exactly WHICH sub-pattern matched a real message, not just a
// yes/no — that's the difference between "the gate never ran" and "the
// gate ran but this specific phrasing doesn't match any pattern" when
// debugging a live report.
const CREATIVE_SELECTION_INTENT_PATTERN_LIST = [
  { label: "choose/pick/select + quality + noun", pattern: /\b(choose|pick|select)\b.{0,60}\b(best|exact|strongest|top|right)\b.{0,50}\b(reel|post|creative|content|product|video|image)\b/i },
  { label: "choose/pick/select + noun + purpose", pattern: /\b(choose|pick|select)\b.{0,40}\b(reel|post|creative|content|product)\b.{0,40}\b(advertise|for (this|the) (ad|campaign)|to (run|use))\b/i },
  { label: "which noun should/for ad", pattern: /\bwhich\b.{0,40}\b(product|reel|post|creative|content)\b.{0,40}\b(should|to use|for (this|the) (ad|campaign))\b/i },
  { label: "use my best/recent noun", pattern: /\buse my (best|recent|top|strongest)\b.{0,40}\b(reel|post|content|creative|product)\b/i },
  { label: "compare my recent posts", pattern: /\bcompare (my )?(recent )?(posts|reels|content|creatives)\b/i },
  { label: "which existing creative reuse", pattern: /\bwhich (existing )?(ad )?creative\b.{0,40}\breuse\b/i },
  { label: "best/highest-performing noun", pattern: /\b(best|strongest|top|highest[- ]performing)\b.{0,30}\b(reel|post|creative|content)\b/i },
  // "change/update/optimize the creative" — no choose/pick/select verb,
  // no quality adjective, so none of the patterns above catch it; this
  // is the exact live-bug follow-up shape ("optimize the campaign
  // creative") reported after the snapshot-forcing fix above shipped.
  { label: "change/update/optimize the creative", pattern: /\b(change|update|swap|replace|optimi[sz]e|revise)\b.{0,40}\b(the )?(ad |campaign )?creative\b/i },
];
const CREATIVE_SELECTION_INTENT_PATTERNS = new RegExp(
  CREATIVE_SELECTION_INTENT_PATTERN_LIST.map((p) => p.pattern.source).join("|"),
  "i"
);
// Diagnostic-only helper — returns the label of the FIRST sub-pattern that
// matches, or null. Never used for real gating logic (that still runs
// against the combined CREATIVE_SELECTION_INTENT_PATTERNS regex above,
// unchanged) — purely so a trace log can say exactly which phrasing rule
// fired.
function matchedCreativeSelectionPatternLabel(userMessage) {
  if (typeof userMessage !== "string") return null;
  const hit = CREATIVE_SELECTION_INTENT_PATTERN_LIST.find((p) => p.pattern.test(userMessage));
  return hit ? hit.label : null;
}

// Returns a nudge message when the model's "final" decision should be
// blocked because it's answering a plan-review/revision request or an
// integration-state question without ever calling a tool this turn — or
// null when neither trigger applies. `hasMetaExpertTools` guards against
// nudging an agent that doesn't even have the Meta Expert skill enabled.
// `lastAssistantMessage` (the most recent assistant turn in history, if
// any) lets a content-free follow-up ("are you sure? check again.") be
// matched against the integration-state claim it's actually challenging.
function checkStaleFactualAnswerGate({ userMessage, hasActivePlan, hasMetaExpertTools, hasV2Tools, lastAssistantMessage }) {
  if (!hasMetaExpertTools || typeof userMessage !== "string") return null;
  if (hasActivePlan && PLAN_REVIEW_INTENT_PATTERNS.test(userMessage)) {
    return 'This looks like a request to review or revise the ACTIVE campaign plan (e.g. "review my data," "why did you choose this audience/budget," "improve/reconsider the plan") — that must go through the real revision path, never a conversational answer from memory. If the user asked you to review WooCommerce products, Meta account history, or audience data, call meta_expert.research_business_context first to get CURRENT data — a Pixel or connection status can change between turns, never state it from what an earlier turn said. Then call meta_expert.create_campaign_plan with revisesPlanId set to the active plan\'s id, changing only what the current evidence actually supports, before presenting anything to the user.';
  }
  if (CREATIVE_SELECTION_INTENT_PATTERNS.test(userMessage)) {
    const snapshotTool = hasV2Tools ? "meta_expert_v2.get_business_snapshot" : "meta_expert.research_business_context";
    const revisionClause = hasV2Tools && hasActivePlan
      ? " Since an active strategy already exists for this conversation, then call meta_expert_v2.revise_strategy updating ONLY the creative fields (creative_strategy / content_selector) with what the real data supports — preserve the Page, ad account, Pixel, objective, audience, and budget exactly as they are; do not rebuild the campaign."
      : "";
    return `This asks you to select or compare specific creative (a Reel, post, or product) for an ad. Never name a specific post, product, or date, and never describe something as "high engagement," "high performing," or "proven effectiveness," without real CURRENT data behind it. Call ${snapshotTool} first to get the actual recent content list before selecting or describing anything specific.${revisionClause} If no real engagement/performance data is available for a piece of content, say so plainly and choose based on clearly-labeled factors instead (e.g. "Based on content relevance and format...") — never claim something is your best- or highest-performing content without the numbers to back it up.`;
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

// CONFIRMED LIVE BUG (V2 live testing, follow-up): the creative-selection
// gate above successfully forced a real meta_expert_v2.get_business_snapshot
// call and the model correctly avoided inventing engagement data — but
// with an ACTIVE strategy already in place, the model then finished
// (type: "final") right after the snapshot, never calling
// meta_expert_v2.revise_strategy at all. checkStaleFactualAnswerGate above
// only runs when stepsRun === 0 (no tool called yet THIS turn) — once the
// snapshot call happens, stepsRun becomes 1 and that gate no longer
// applies, so nothing backend-enforced ever required the SECOND step
// (the actual revision) to happen too.
//
// Checked on EVERY "final" decision this turn (no stepsRun restriction —
// that's the whole point, this fires AFTER a tool has already been
// called), with its own nudge budget (MAX_CREATIVE_REVISION_NUDGES) so it
// doesn't interfere with the snapshot-forcing gate's own one-nudge budget
// above. `revisedThisTurn` is read from the SAME v2ToolCallCounts map the
// V2 single-call gate already maintains — a call counts as satisfying
// this requirement whether it succeeded or was rejected (a genuine
// rejection is a real, honest attempt; the single-call gate already
// prevents that from becoming a retry loop).
const MAX_CREATIVE_REVISION_NUDGES = 1;
function checkCreativeRevisionRequiredGate({ userMessage, hasActiveV2Strategy, hasV2Tools, revisedThisTurn }) {
  if (!hasV2Tools || !hasActiveV2Strategy || revisedThisTurn) return null;
  if (typeof userMessage !== "string" || !CREATIVE_SELECTION_INTENT_PATTERNS.test(userMessage)) return null;
  return 'An active strategy already exists for this conversation and this is a creative-selection/change request. You must call meta_expert_v2.revise_strategy — updating ONLY the creative fields (creative_strategy / content_selector) with what the business snapshot actually supports — before finalizing. Preserve the existing objective, audience, budget, Page, ad account, and Pixel exactly as they are; never rebuild the campaign from scratch. The required flow is: get_business_snapshot -> revise_strategy -> final.';
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
  let creativeRevisionNudges = 0;
  let executionClaimNudges = 0;
  const MAX_MALFORMED_NUDGES = 1;
  const hasMetaExpertTools = availableTools.some((t) => t.name?.startsWith("meta_expert.") || t.name?.startsWith("meta_expert_v2."));
  const hasV2Tools = availableTools.some((t) => t.name?.startsWith("meta_expert_v2."));
  let createPlanAttempts = 0;
  let lastCreatePlanFingerprint = null;
  let lastCreatePlanWasRejected = false;
  const MAX_CREATE_PLAN_ATTEMPTS = 2;
  // Per-turn state for the V2 single-call gate (see V2_SINGLE_CALL_TOOLS
  // above) — keyed by tool name, reset every orchestrate() call same as
  // every other nudge counter in this function.
  const v2ToolCallCounts = new Map();
  const v2ToolNudgeCounts = new Map();
  const v2ToolLastOutcome = new Map();

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
      // Round 17 (live testing) — see EXECUTION_CLAIM_WITHOUT_CALL_PATTERN
      // above. Checked with NO stepsRun restriction (unlike the stale-
      // factual-answer gate below): the model could have called SOME
      // unrelated tool earlier this turn and still be about to claim an
      // execute/revise happened when it didn't.
      const executionClaimGateMessage = hasV2Tools
        ? checkExecutionClaimWithoutCallGate({
            decision, hasV2Tools,
            executeCalledThisTurn: (v2ToolCallCounts.get("meta_expert_v2.execute_strategy") || 0) > 0,
            reviseCalledThisTurn: (v2ToolCallCounts.get("meta_expert_v2.revise_strategy") || 0) > 0,
          })
        : null;
      if (executionClaimGateMessage && executionClaimNudges < MAX_EXECUTION_CLAIM_NUDGES) {
        executionClaimNudges += 1;
        conversationForModel = [
          ...conversationForModel,
          { role: "assistant", content: JSON.stringify(decision) },
          { role: "user", content: executionClaimGateMessage },
        ];
        continue;
      }
      if (executionClaimGateMessage) {
        // Nudge already used and it STILL claimed an unexecuted action —
        // never let this reach the customer. Fail safe with an honest,
        // actionable message instead of a fabricated "done."
        trace[trace.length - 1].state = "done";
        trace.push(traceStep("completed", "Claimed an action that was never actually taken — overridden.", "done"));
        if (planId) setPlanStatus(planId, "failed");
        return {
          reply: "I wasn't able to actually apply that — could you repeat the budget (or whatever you'd like changed), and I'll update and execute the strategy for real this time?",
          trace, toolResults, usage: usageTotals,
        };
      }
      // Round 13 (live testing): only fires on the FIRST model decision of
      // this turn — once stepsRun > 0, a tool HAS already been called this
      // turn, so the model is answering from fresh data, not memory.
      if (stepsRun === 0 && staleAnswerNudges < MAX_STALE_ANSWER_NUDGES) {
        const lastAssistantMessage = [...history].reverse().find((m) => m?.role === "assistant")?.content;
        const staleGateMessage = checkStaleFactualAnswerGate({
          userMessage,
          hasActivePlan: Boolean(getActivePlanForConversation(userId, conversationId)) || Boolean(getActiveStrategyForConversation(userId, conversationId)),
          hasMetaExpertTools,
          hasV2Tools,
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
      // Mandatory revise_strategy step (live bug follow-up) — see
      // checkCreativeRevisionRequiredGate above. Deliberately checked with
      // NO stepsRun restriction: this fires specifically AFTER the model
      // has already called get_business_snapshot (satisfying the gate
      // above) but is trying to finalize without also revising the active
      // strategy's creative fields.
      {
        const revisedThisTurn = (v2ToolCallCounts.get("meta_expert_v2.revise_strategy") || 0) > 0;
        const activeV2Strategy = getActiveStrategyForConversation(userId, conversationId);
        const creativeRevisionMessage = checkCreativeRevisionRequiredGate({
          userMessage,
          hasActiveV2Strategy: Boolean(activeV2Strategy),
          hasV2Tools,
          revisedThisTurn,
        });
        // TEMPORARY diagnostic instrumentation (live bug: production still
        // shows get_business_snapshot -> final with no revise_strategy call
        // even after this gate shipped) — env-gated (META_EXPERT_V2_TRACE=1),
        // no secrets/tokens, safe to leave deployed. Remove once the trace
        // identifies which condition is actually false in production.
        v2Trace("creativeRevisionGate", {
          conversationId,
          creativeIntentMatched: matchedCreativeSelectionPatternLabel(userMessage) !== null,
          matchedPattern: matchedCreativeSelectionPatternLabel(userMessage),
          activeV2StrategyFound: Boolean(activeV2Strategy),
          activeV2StrategyId: activeV2Strategy?.id || null,
          activeV2StrategyStatus: activeV2Strategy?.status || null,
          activeV2StrategyConversationId: activeV2Strategy?.conversationId || null,
          hasV2Tools,
          reviseStrategyAlreadyCalledThisTurn: revisedThisTurn,
          gateRan: true,
          gateDecision: !creativeRevisionMessage
            ? "allow"
            : creativeRevisionNudges < MAX_CREATIVE_REVISION_NUDGES
            ? "nudge"
            : "hard-stop",
          stepsRun,
          userMessageSnippet: typeof userMessage === "string" ? userMessage.slice(0, 200) : null,
        });
        if (creativeRevisionMessage) {
          if (creativeRevisionNudges < MAX_CREATIVE_REVISION_NUDGES) {
            creativeRevisionNudges += 1;
            conversationForModel = [
              ...conversationForModel,
              { role: "assistant", content: JSON.stringify(decision) },
              { role: "user", content: creativeRevisionMessage },
            ];
            continue;
          }
          trace[trace.length - 1].state = "done";
          trace.push(traceStep("completed", "Creative update could not be finalized through the required revision step.", "done"));
          if (planId) setPlanStatus(planId, "failed");
          return {
            reply: "I wasn't able to complete that creative update through the proper revision process — could you try again, or tell me more about what you'd like changed?",
            trace,
            toolResults,
            usage: usageTotals,
          };
        }
      }
      // CONFIRMED LIVE BUG: a rejected meta_expert_v2.build_strategy call
      // (this turn) fed its rejection guidance into the per-turn gate's
      // nudge above (see summarizeV2ToolResult); the model then dressed
      // that guidance up as if it were a complete, approvable strategy —
      // "the strategy remains paused until you approve it" — even though
      // NOTHING was ever actually saved for this conversation. A user who
      // then said "approve it" would hit checkV2ExecutionApprovalGate's
      // "No active strategy exists" failure, having been told the
      // opposite. Every gate up to this point fired correctly; nothing
      // stopped the model from fabricating a fake success out of a
      // rejection's own leftover text once it reached "final."
      //
      // Backend-enforced, deterministic, and narrow: only overrides the
      // reply when build_strategy/revise_strategy was attempted THIS TURN,
      // its real (dispatched) outcome was a genuine rejection
      // (valid:false), AND no active strategy exists for this conversation
      // right now — i.e. the backend can PROVE nothing was actually saved.
      // A genuine success, or a rejected revision of an EXISTING active
      // strategy (which stays active, untouched, since only a successful
      // revision ever supersedes it), never triggers this — the model's
      // own wording is trusted in every other case.
      if (hasV2Tools) {
        const lastBuildOutcome = v2ToolLastOutcome.get("meta_expert_v2.build_strategy");
        const lastReviseOutcome = v2ToolLastOutcome.get("meta_expert_v2.revise_strategy");
        const rejectedOutcome = [lastReviseOutcome, lastBuildOutcome].find((o) => o?.status === "completed" && o.result?.valid === false);
        if (rejectedOutcome && !getActiveStrategyForConversation(userId, conversationId)) {
          trace[trace.length - 1].state = "done";
          trace.push(traceStep("completed", "Strategy could not be finalized — nothing was saved this turn.", "done"));
          if (planId) setPlanStatus(planId, "failed");
          return {
            reply: `I wasn't able to finalize a strategy for this request — ${rejectedOutcome.result.issue} Could you tell me more, or would you like me to try a different approach?`,
            trace,
            toolResults,
            usage: usageTotals,
          };
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

      // V2 single-call gate — checked BEFORE any dispatch attempt, so a
      // repeat call for a tool already really-dispatched this turn NEVER
      // reaches runTool() a second time. See V2_SINGLE_CALL_TOOLS above.
      if (V2_SINGLE_CALL_TOOLS.has(call.toolName) && (v2ToolCallCounts.get(call.toolName) || 0) >= 1) {
        const priorSummary = summarizeV2ToolResult(call.toolName, v2ToolLastOutcome.get(call.toolName));
        const nudges = v2ToolNudgeCounts.get(call.toolName) || 0;
        if (nudges < MAX_V2_TOOL_NUDGES) {
          v2ToolNudgeCounts.set(call.toolName, nudges + 1);
          trace[trace.length - 1].state = "done";
          trace.push(traceStep("error", `${call.toolName} already called once this turn — reusing that result.`, "done"));
          toolResults.push({ toolName: call.toolName, error: `Blocked duplicate call this turn — ${priorSummary}` });
          conversationForModel = [
            ...conversationForModel,
            { role: "assistant", content: JSON.stringify(decision) },
            {
              role: "user",
              content: `"${call.toolName}" can only be called once per turn, and it was already called once this turn — ${priorSummary} Do not call "${call.toolName}" again. Respond now with type "final" using that result — or, only for a genuinely valid build_strategy/revise_strategy result, present it and wait for the user's explicit approval before calling meta_expert_v2.execute_strategy.`,
            },
          ];
          continue;
        }
        // Second repeat (a third total call for this tool) — hard-stop
        // rather than let the loop grind toward MAX_STEPS.
        trace[trace.length - 1].state = "done";
        trace.push(traceStep("completed", `${call.toolName} could not be finalized after one attempt this turn.`, "done"));
        if (planId) setPlanStatus(planId, "failed");
        return {
          reply: "I already have a result from earlier in this response and wasn't able to move past it — could you tell me more about what you'd like, or try again in a new message?",
          trace,
          toolResults,
          usage: usageTotals,
        };
      }

      let outcome;
      if (call.toolName === "meta_expert.execute_campaign_plan") {
        const gateError = checkExecutionApprovalGate({ userId, conversationId, userMessage });
        if (gateError) outcome = { status: "failed", error: gateError };
      } else if (call.toolName === "meta_expert_v2.execute_strategy") {
        // Meta Ads Expert V2's own approval gate — see
        // checkV2ExecutionApprovalGate above. This runs IN ADDITION to the
        // V2 single-call gate above — a gate-blocked attempt here (no
        // active strategy yet, or no approval language) doesn't consume
        // the once-per-turn dispatch budget, only a genuine execution
        // attempt that reaches runTool() below does.
        const gateError = checkV2ExecutionApprovalGate({ userId, conversationId, userMessage });
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
        if (V2_SINGLE_CALL_TOOLS.has(call.toolName)) {
          v2ToolCallCounts.set(call.toolName, (v2ToolCallCounts.get(call.toolName) || 0) + 1);
          v2ToolLastOutcome.set(call.toolName, outcome);
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
