// Phase 1, round 6 — orchestrator-level regression for the
// meta_expert.create_campaign_plan retry loop. Live testing found "I want
// more sales to my website" made the model call create_campaign_plan six
// times (each rejected) until the orchestrator hit MAX_STEPS and the user
// was shown a raw "Reached step limit" line. This suite drives the REAL
// orchestrate() loop end-to-end — real DB, real policy.js/planner.js/
// registry.js dispatch — with only two things mocked via global.fetch:
// Meta's Graph API (same pattern as metaExpertPlannerRegression.js) and
// Anthropic's chat completion endpoint (scripted per-call responses, since
// there is no live LLM in a deterministic test). This is the only way to
// exercise the retry-limit/duplicate-fingerprint gate the way a real
// multi-turn model conversation actually reaches it — through orchestrate()
// itself, not by calling the gate function directly.
//
//   node test/metaExpertOrchestratorRetryRegression.js
import assert from "node:assert/strict";

process.env.DB_PATH = process.env.DB_PATH || "/tmp/meta-expert-orchestrator-retry-regression.sqlite";
process.env.BYOK_ENCRYPTION_KEY = process.env.BYOK_ENCRYPTION_KEY || "test-byok-encryption-key-for-orchestrator-test";
process.env.META_APP_ID = process.env.META_APP_ID || "test-app-id";
process.env.META_APP_SECRET = process.env.META_APP_SECRET || "test-app-secret";
process.env.META_EXPERT_MAX_SUGGESTED_DAILY_BUDGET = "5000";
process.env.META_EXPERT_MAX_EXECUTABLE_DAILY_BUDGET = "10000";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-anthropic-key";

const db = (await import("../db.js")).default;
const { cryptoRandom } = await import("../middleware.js");
const { saveConnection } = await import("../integrations/manager.js");
const { orchestrate, safeParseDecision } = await import("../orchestrator/index.js");
const { runTool } = await import("../orchestrator/executor.js");
const { registerTool } = await import("../tools/registry.js");
const { getActivePlanForConversation, getStoredPlan } = await import("../agents/metaExpert/planner.js");
await import("../tools/index.js"); // registers meta_expert.* tools

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.stack || err.message });
    console.log(`FAIL  ${name} — ${err.message}`);
  }
}

function makeUser(email) {
  const id = cryptoRandom();
  db.prepare("INSERT INTO users (id, email, password, name, createdAt) VALUES (?, ?, ?, ?, ?)").run(id, email, "hash", "Test User", new Date().toISOString());
  return id;
}

db.prepare("INSERT OR IGNORE INTO skills (id, name, description, category, status) VALUES (?, ?, ?, ?, 'available')")
  .run("meta_ads", "Meta Ads", "Manage Facebook and Instagram ad campaigns directly.", "marketing");
// agent_skills.skillId has a real FK to skills(id) — needed for the
// test-only "test_tools" category used by the non-meta_ads tool-failure
// regression test below.
db.prepare("INSERT OR IGNORE INTO skills (id, name, description, category, status) VALUES (?, ?, ?, ?, 'available')")
  .run("test_tools", "Test Tools", "Test-only tools for regression coverage.", "test");

function makeAgentWithSkills(userId, skillIds) {
  const agentId = cryptoRandom();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO agents (id, userId, name, status, createdAt, updatedAt) VALUES (?, ?, ?, 'active', ?, ?)").run(agentId, userId, "Test Meta Ads Agent", now, now);
  for (const skillId of skillIds) {
    db.prepare("INSERT OR IGNORE INTO agent_skills (agentId, skillId) VALUES (?, ?)").run(agentId, skillId);
  }
  return agentId;
}

const originalFetch = global.fetch;
function restoreFetch() { global.fetch = originalFetch; }
function jsonResponse(body, status = 200) {
  return { ok: status < 400, status, json: async () => body };
}

function metaRouter({ adAccounts = [], pages = [], igByPageId = {}, pixels = [], catalogs = [], campaigns = [] } = {}) {
  let nextId = 900000000000001n;
  return async (url, options = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v[\d.]+/, "");
    const method = options.method || "GET";
    if (method !== "GET") return jsonResponse({ id: String(nextId++) });
    if (path === "/me/adaccounts") return jsonResponse({ data: adAccounts });
    if (path === "/me/accounts") return jsonResponse({ data: pages });
    if (path === "/me/businesses") return jsonResponse({ data: [] });
    const pageFieldsMatch = path.match(/^\/(\d+)$/);
    if (pageFieldsMatch && u.searchParams.get("fields") === "instagram_business_account") {
      const igId = igByPageId[pageFieldsMatch[1]];
      return jsonResponse(igId ? { instagram_business_account: { id: igId } } : {});
    }
    if (path.endsWith("/adspixels")) return jsonResponse({ data: pixels });
    if (path.endsWith("/product_catalogs")) return jsonResponse({ data: catalogs });
    if (path.endsWith("/campaigns")) return jsonResponse({ data: campaigns });
    if (path.endsWith("/insights")) return jsonResponse({ data: [{ impressions: "0", clicks: "0", spend: "0" }] });
    if (path.endsWith("/posts")) return jsonResponse({ data: [] });
    if (path.endsWith("/media")) return jsonResponse({ data: [] });
    return jsonResponse({ error: { message: `Unmocked GET path in test: ${path}` } }, 400);
  };
}

function connectMeta(userId) {
  saveConnection(userId, "meta_ads", { accessToken: `fake-meta-token-${userId}`, expiresAt: null, scopes: ["ads_read", "ads_management", "pages_show_list", "business_management"] });
}

function connectWooCommerce(userId) {
  saveConnection(userId, "woocommerce", { accessToken: "fake-consumer-secret", expiresAt: null, scopes: [], meta: { siteUrl: "https://store.example.com", consumerKey: "ck_fake" } });
}

// A scripted global.fetch handler: Anthropic chat calls are served in order
// from `chatResponses` (each entry is the raw text a real model response
// would contain — the same JSON-envelope string safeParseDecision() parses
// in production); everything else goes to the real Meta/WooCommerce mock
// routers, exactly like metaExpertPlannerRegression.js.
function scriptedFetch({ chatResponses, metaOpts = {} }) {
  let chatIndex = 0;
  const metaHandler = metaRouter(metaOpts);
  return async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname === "api.anthropic.com") {
      const text = chatResponses[chatIndex];
      chatIndex += 1;
      if (text === undefined) {
        throw new Error(`Test error: chat mock exhausted after ${chatIndex - 1} scripted responses — the orchestrator called the model more times than this scenario expected (a regression toward the unbounded-loop bug).`);
      }
      return jsonResponse({ content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 5 } });
    }
    if (u.pathname.startsWith("/wp-json/wc/v3/")) {
      if (u.pathname.endsWith("/settings/general")) return jsonResponse([{ id: "woocommerce_default_country", value: "PK" }]);
      if (u.pathname.endsWith("/products")) return jsonResponse([{ id: 1, name: "Vitamin C Serum", price: "1800", categories: [{ name: "Skincare" }] }]);
      if (u.pathname.endsWith("/products/categories")) return jsonResponse([{ name: "Skincare" }]);
      return jsonResponse([]);
    }
    return metaHandler(url, options);
  };
}

function decisionText(decision) { return JSON.stringify(decision); }
const researchCall = decisionText({ type: "tool_call", toolName: "meta_expert.research_business_context", parameters: {} });
function planCall(plan) { return decisionText({ type: "tool_call", toolName: "meta_expert.create_campaign_plan", parameters: plan }); }
function finalText(message) { return decisionText({ type: "final", message }); }

function basePlan(overrides = {}) {
  return {
    goal: "I want more website sales",
    goal_classification: {
      literal_goal: "more website sales",
      inferred_business_outcome: "revenue from purchases",
      recommended_meta_objective: "OUTCOME_SALES",
      requires_goal_confirmation: false,
    },
    objective: "OUTCOME_SALES",
    conversion_location: "WEBSITE",
    optimization_event: "PURCHASE",
    targeting_strategy: "BROAD_WITH_TEST",
    age_min: 21,
    age_max: 44,
    gender: "ALL",
    audience_basis: "HEURISTIC",
    locations: ["Karachi", "Lahore"],
    countries: ["PK"],
    placements: "ADVANTAGE_PLUS",
    creative_strategy: { source: "EXISTING_PAGE_POST", description: "Best recent reel" },
    budget_strategy: "DAILY",
    daily_budget: 2000,
    budget_basis: "USER_PROVIDED",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    facebook_page: { ref: "default_facebook_page" },
    instagram_identity: null,
    ad_account: { ref: "default_ad_account" },
    pixel: null,
    catalog: null,
    cta: "SHOP_NOW",
    campaign_status: "PAUSED",
    assumptions: ["Assumed Karachi/Lahore based on connected store's typical market"],
    reasoning_summary: "Clear sales intent + connected store with real products; Sales objective with Purchase optimization directly serves that.",
    confidence: "HIGH",
    approval_required: false,
    ...overrides,
  };
}

// A Traffic/LINK_CLICKS plan for a business with a connected store AND a
// real Pixel — the exact live-bug shape from round 3/4/5's investigation,
// rejected by checkGoalClassificationPolicy() because a Sales-capable
// business is proposing Traffic instead.
function invalidTrafficPlan(overrides = {}) {
  return basePlan({
    goal: "I want more sales to my website",
    objective: "OUTCOME_TRAFFIC",
    optimization_event: "LINK_CLICKS",
    pixel: null,
    goal_classification: {
      literal_goal: "more sales", inferred_business_outcome: "revenue from purchases",
      recommended_meta_objective: "OUTCOME_SALES", requires_goal_confirmation: false,
    },
    ...overrides,
  });
}

const metaFixture = {
  adAccounts: [{ id: "act_1", name: "A" }],
  pages: [{ id: "111", name: "Beautybeespk" }],
  pixels: [{ id: "px1", name: "Store Pixel" }],
};

const stamp = Date.now();

async function run() {
  console.log("Meta Ads Expert orchestrator retry-limit (Phase 1, round 6) regression suite\n");

  await check("acceptance test: 'I want more sales to my website' — research runs once, plan is repaired once and succeeds, no step-limit message, no more than 2 create_campaign_plan attempts", async () => {
    const userId = makeUser(`accept-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert"]);
    const conversationId = `conv-${cryptoRandom()}`;
    global.fetch = scriptedFetch({
      metaOpts: metaFixture,
      chatResponses: [
        researchCall,
        planCall(invalidTrafficPlan()),
        planCall(basePlan()), // genuinely different + policy-correct repair
        finalText("Recommended: Sales objective, Purchase optimization, PKR 2,000/day, Beautybeespk Page. Want to proceed?"),
      ],
    });
    try {
      const userMessage = "I want more sales to my website";
      const result = await orchestrate({
        userId, agentId, conversationId, userMessage,
        history: [{ role: "user", content: userMessage }],
        agentSystemPrompt: "You are the Meta Ads Expert.",
      });
      assert.doesNotMatch(result.reply, /step limit/i, `reply must never mention step limit: ${result.reply}`);
      const planCalls = result.toolResults.filter((r) => r.toolName === "meta_expert.create_campaign_plan");
      assert.equal(planCalls.length, 2, `expected exactly 2 create_campaign_plan attempts (1 initial + 1 repair), got ${planCalls.length}`);
      assert.equal(planCalls[0].result?.valid, false, "first attempt (Traffic for a Sales-capable business) must be rejected");
      assert.equal(planCalls[1].result?.valid, true, `repaired attempt must succeed: ${JSON.stringify(planCalls[1])}`);
      assert.match(result.reply, /proceed/i, "final reply should be the model's real recommendation, not a generic fallback");
    } finally {
      restoreFetch();
    }
  });

  await check("identical rejected plan resubmitted twice is blocked with META_PLAN_DUPLICATE_RETRY, without a second real planner call", async () => {
    const userId = makeUser(`dup-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert"]);
    const conversationId = `conv-${cryptoRandom()}`;
    const invalid = invalidTrafficPlan();
    global.fetch = scriptedFetch({
      metaOpts: metaFixture,
      chatResponses: [
        researchCall,
        planCall(invalid),
        planCall(invalid), // model resubmits the EXACT same plan
        finalText("Unable to confirm whether Sales or Traffic is the right objective without more input — could you clarify?"),
      ],
    });
    try {
      const userMessage = "I want more sales to my website";
      const result = await orchestrate({
        userId, agentId, conversationId, userMessage,
        history: [{ role: "user", content: userMessage }],
        agentSystemPrompt: "You are the Meta Ads Expert.",
      });
      assert.doesNotMatch(result.reply, /step limit/i);
      const planCalls = result.toolResults.filter((r) => r.toolName === "meta_expert.create_campaign_plan");
      assert.equal(planCalls.length, 2, `expected exactly 2 create_campaign_plan tool-result entries (1 real rejection + 1 blocked duplicate), got ${planCalls.length}`);
      assert.equal(planCalls[0].result?.valid, false);
      assert.match(planCalls[1].error || "", /META_PLAN_DUPLICATE_RETRY/, `second identical submission must be blocked as a duplicate: ${JSON.stringify(planCalls[1])}`);
      assert.match(result.reply, /clarify/i, "orchestrate should return the model's own final message, reached normally, not the internal fallback");
    } finally {
      restoreFetch();
    }
  });

  await check("a different repaired plan submitted once succeeds cleanly (no duplicate block, no retry-limit fallback)", async () => {
    const userId = makeUser(`repair-ok-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert"]);
    const conversationId = `conv-${cryptoRandom()}`;
    global.fetch = scriptedFetch({
      metaOpts: metaFixture,
      chatResponses: [
        researchCall,
        planCall(invalidTrafficPlan()),
        planCall(basePlan({ daily_budget: 2500 })), // different AND policy-correct
        finalText("Recommended: Sales objective, Purchase optimization, PKR 2,500/day. Want to proceed?"),
      ],
    });
    try {
      const userMessage = "I want more sales to my website";
      const result = await orchestrate({
        userId, agentId, conversationId, userMessage,
        history: [{ role: "user", content: userMessage }],
        agentSystemPrompt: "You are the Meta Ads Expert.",
      });
      const planCalls = result.toolResults.filter((r) => r.toolName === "meta_expert.create_campaign_plan");
      assert.equal(planCalls.length, 2);
      assert.equal(planCalls[0].result?.valid, false);
      assert.equal(planCalls[1].result?.valid, true);
      assert.equal(planCalls[1].error, undefined, "a genuinely repaired plan must not be blocked as a duplicate");
      assert.doesNotMatch(result.reply, /step limit/i);
    } finally {
      restoreFetch();
    }
  });

  await check("second repair failure stops cleanly: no third create_campaign_plan call, customer-safe fallback, no step-limit wording", async () => {
    const userId = makeUser(`repair-fail-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert"]);
    const conversationId = `conv-${cryptoRandom()}`;
    const firstInvalid = invalidTrafficPlan();
    const secondInvalid = invalidTrafficPlan({ daily_budget: 3000 }); // different fingerprint, still policy-rejected
    global.fetch = scriptedFetch({
      metaOpts: metaFixture,
      chatResponses: [
        researchCall,
        planCall(firstInvalid),
        planCall(secondInvalid),
        // A third attempt — must never reach the real planner. Deliberately
        // identical to the second, to also prove the hard attempt-limit
        // wins over the duplicate check once the cap is reached.
        planCall(secondInvalid),
        // Intentionally NOT provided: if the orchestrator wrongly went back
        // to the model for a 5th chat call instead of hard-returning, the
        // scripted fetch above throws and this test fails loudly.
      ],
    });
    try {
      const userMessage = "I want more sales to my website";
      const result = await orchestrate({
        userId, agentId, conversationId, userMessage,
        history: [{ role: "user", content: userMessage }],
        agentSystemPrompt: "You are the Meta Ads Expert.",
      });
      assert.doesNotMatch(result.reply, /step limit/i, `reply must never mention step limit: ${result.reply}`);
      const planCalls = result.toolResults.filter((r) => r.toolName === "meta_expert.create_campaign_plan");
      assert.equal(planCalls.length, 2, `the third attempt must be hard-stopped before reaching the planner — expected exactly 2 recorded attempts, got ${planCalls.length}`);
      assert.equal(planCalls[0].result?.valid, false);
      assert.equal(planCalls[1].result?.valid, false);
      assert.match(result.reply, /couldn't finalize the campaign recommendation automatically/i, `expected the customer-safe fallback message, got: ${result.reply}`);
    } finally {
      restoreFetch();
    }
  });

  // --- Round 13, live testing: "Why did you choose all genders 18-65 and
  //    PKR 10,000/day? Review my WooCommerce products, Meta history, and
  //    audience data, then improve the plan before I approve it" was
  //    answered directly from conversational memory — Agent Trace showed
  //    only Planning -> Completed, no tool ever called, and the reply
  //    repeated a stale claim ("no Meta Pixel connected") the SAME
  //    conversation's own earlier research had already contradicted. These
  //    tests drive the REAL two-turn conversation: turn 1 creates a real
  //    active plan through orchestrate() itself (not faked), turn 2 sends
  //    the review/revision-shaped message with the model's SCRIPTED first
  //    response being the exact bad shape (a confident "final" answer, no
  //    tool call) — proving the new gate intercepts it and forces a real
  //    tool call before any reply reaches the user.
  await check("[round 13] active plan + 'Review my WooCommerce products and improve the audience' forces the revision tool to be invoked, not a memory-only answer", async () => {
    const userId = makeUser(`route-review-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert"]);
    const conversationId = `conv-${cryptoRandom()}`;

    // Turn 1: establish a REAL active plan the normal way.
    global.fetch = scriptedFetch({
      metaOpts: metaFixture,
      chatResponses: [researchCall, planCall(basePlan()), finalText("Recommended: Sales objective, Purchase optimization, PKR 2,000/day. Approve to proceed?")],
    });
    const turn1Message = "I want more sales to my website";
    let turn1;
    try {
      turn1 = await orchestrate({
        userId, agentId, conversationId, userMessage: turn1Message,
        history: [{ role: "user", content: turn1Message }],
        agentSystemPrompt: "You are the Meta Ads Expert.",
      });
    } finally {
      restoreFetch();
    }
    const activePlan = getActivePlanForConversation(userId, conversationId);
    assert.ok(activePlan, "turn 1 must have created a real active plan");

    // Turn 2: the review request. The model's FIRST scripted response is
    // the exact live-bug shape — a confident, tool-less "final" answer
    // with a stale Pixel claim — proving the gate catches it before it
    // ever reaches the user.
    const staleBadAnswer = "All genders 18-65 is a reasonable choice, and PKR 10,000/day is a reasonable budget. Also, your account lacks a connected Meta Pixel. Please choose your preferred demographics and budget.";
    global.fetch = scriptedFetch({
      metaOpts: metaFixture,
      chatResponses: [
        finalText(staleBadAnswer), // the live bug — must be intercepted
        researchCall,
        planCall({ audience_reasoning: "Reviewed WooCommerce products and Meta history.", revisesPlanId: activePlan.id }),
        finalText("Reviewed your store and account data — recommend keeping the current audience and budget, both are well-supported. Approve to proceed?"),
      ],
    });
    const turn2Message = "Why did you choose all genders 18-65 and PKR 10,000/day? Review my WooCommerce products, Meta history, and audience data, then improve the plan before I approve it.";
    try {
      const turn2 = await orchestrate({
        userId, agentId, conversationId, userMessage: turn2Message,
        history: [
          { role: "user", content: turn1Message },
          { role: "assistant", content: turn1.reply },
          { role: "user", content: turn2Message },
        ],
        agentSystemPrompt: "You are the Meta Ads Expert.",
      });
      assert.notEqual(turn2.reply, staleBadAnswer, "the stale, tool-less answer must never reach the user");
      const toolNames = turn2.toolResults.map((r) => r.toolName);
      assert.ok(toolNames.includes("meta_expert.research_business_context"), `research_business_context must be called when the user explicitly asked to review WooCommerce/Meta data: ${JSON.stringify(toolNames)}`);
      assert.ok(toolNames.includes("meta_expert.create_campaign_plan"), `the revision tool must be invoked, not a memory-only answer: ${JSON.stringify(toolNames)}`);
    } finally {
      restoreFetch();
    }
  });

  await check("[round 13] active plan + 'Why did you choose PKR 10,000/day? Reconsider it.' forces the revision path, not a chat-only answer", async () => {
    const userId = makeUser(`route-reconsider-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert"]);
    const conversationId = `conv-${cryptoRandom()}`;

    global.fetch = scriptedFetch({
      metaOpts: metaFixture,
      chatResponses: [researchCall, planCall(basePlan()), finalText("Recommended: Sales objective, Purchase optimization, PKR 2,000/day. Approve to proceed?")],
    });
    const turn1Message = "I want more sales to my website";
    let turn1;
    try {
      turn1 = await orchestrate({
        userId, agentId, conversationId, userMessage: turn1Message,
        history: [{ role: "user", content: turn1Message }],
        agentSystemPrompt: "You are the Meta Ads Expert.",
      });
    } finally {
      restoreFetch();
    }
    const activePlan = getActivePlanForConversation(userId, conversationId);
    assert.ok(activePlan);

    global.fetch = scriptedFetch({
      metaOpts: metaFixture,
      chatResponses: [
        finalText("PKR 2,000/day is a reasonable starting budget based on typical costs in this category."), // no tool call — must be intercepted
        planCall({ daily_budget: 3000, budget_basis: "HEURISTIC_STARTING_TEST", reasoning_summary: "Reconsidered the budget upward slightly for better initial reach.", revisesPlanId: activePlan.id }),
        finalText("Reconsidered — recommend PKR 3,000/day for better initial reach. Approve to proceed?"),
      ],
    });
    const turn2Message = "Why did you choose PKR 10,000/day? Reconsider it.";
    try {
      const turn2 = await orchestrate({
        userId, agentId, conversationId, userMessage: turn2Message,
        history: [
          { role: "user", content: turn1Message },
          { role: "assistant", content: turn1.reply },
          { role: "user", content: turn2Message },
        ],
        agentSystemPrompt: "You are the Meta Ads Expert.",
      });
      const toolNames = turn2.toolResults.map((r) => r.toolName);
      assert.ok(toolNames.includes("meta_expert.create_campaign_plan"), `the revision path must run, not a chat-only answer: ${JSON.stringify(toolNames)}`);
    } finally {
      restoreFetch();
    }
  });

  await check("[round 13] 'Does my Meta account have a Pixel?' forces a real tool call — a stale conversational claim is never returned directly", async () => {
    const userId = makeUser(`route-pixel-question-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert"]);
    const conversationId = `conv-${cryptoRandom()}`;

    global.fetch = scriptedFetch({
      metaOpts: metaFixture, // metaFixture has exactly one real, connected Pixel
      chatResponses: [
        finalText("No, your Meta account does not have a Pixel connected."), // must be intercepted — no tool called
        researchCall,
        finalText("Yes — your account has a connected Pixel (Store Pixel)."),
      ],
    });
    const userMessage = "Does my Meta account have a Pixel?";
    try {
      const result = await orchestrate({
        userId, agentId, conversationId, userMessage,
        history: [{ role: "user", content: userMessage }],
        agentSystemPrompt: "You are the Meta Ads Expert.",
      });
      const toolNames = result.toolResults.map((r) => r.toolName);
      assert.ok(toolNames.includes("meta_expert.research_business_context"), `a real tool must be called to answer an integration-state question, not memory: ${JSON.stringify(toolNames)}`);
      assert.match(result.reply, /has a connected pixel/i, "the final reply must reflect the real, current tool result");
    } finally {
      restoreFetch();
    }
  });

  await check("[round 13] a stale 'no Pixel' claim earlier in the conversation history does not exempt the current turn from checking current tool data", async () => {
    const userId = makeUser(`route-pixel-stale-history-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert"]);
    const conversationId = `conv-${cryptoRandom()}`;

    global.fetch = scriptedFetch({
      metaOpts: metaFixture, // a real Pixel IS connected now, despite the stale history claim below
      chatResponses: [
        finalText("As I mentioned, your account has no Meta Pixel connected."), // repeating the stale claim — must be intercepted
        researchCall,
        finalText("Checked again — your account now has a connected Pixel (Store Pixel)."),
      ],
    });
    const priorUserMessage = "Does my account have a Pixel?";
    const priorStaleAssistantReply = "No, your account does not have a Meta Pixel connected.";
    const userMessage = "Are you sure? Check again.";
    try {
      const result = await orchestrate({
        userId, agentId, conversationId, userMessage,
        history: [
          { role: "user", content: priorUserMessage },
          { role: "assistant", content: priorStaleAssistantReply },
          { role: "user", content: userMessage },
        ],
        agentSystemPrompt: "You are the Meta Ads Expert.",
      });
      const researchResult = result.toolResults.find((r) => r.toolName === "meta_expert.research_business_context");
      assert.ok(researchResult, "current tool data must be fetched rather than trusting the stale history claim");
      assert.ok(researchResult.result?.knownFacts?.meta?.pixels?.length > 0, `the CURRENT tool result must show the real, currently-connected Pixel: ${JSON.stringify(researchResult.result?.knownFacts?.meta)}`);
      assert.match(result.reply, /has a connected pixel|does have a connected pixel|now has a connected pixel/i, "the current tool result must win over the stale history claim");
    } finally {
      restoreFetch();
    }
  });

  await check("[round 13] a review/revision request preserves the prior resolved Page/ad account/Pixel unless explicitly changed", async () => {
    const userId = makeUser(`route-preserve-assets-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert"]);
    const conversationId = `conv-${cryptoRandom()}`;
    const twoPageFixture = {
      adAccounts: [{ id: "act_1", name: "A" }],
      pages: [{ id: "717559728109412", name: "Beautybeespk" }, { id: "555555555555555", name: "Careonabudget.pk" }],
      pixels: [{ id: "px1", name: "Store Pixel" }],
    };

    // Turn 1: explicitly select Beautybeespk (declared via changingAssets,
    // per round 12's requirement for a real id to count as intentional).
    global.fetch = scriptedFetch({
      metaOpts: twoPageFixture,
      chatResponses: [
        researchCall,
        planCall({ ...basePlan(), facebook_page: { ref: "717559728109412" }, pixel: { ref: "default_pixel" }, changingAssets: ["facebook_page"] }),
        finalText("Recommended plan using Beautybeespk. Approve to proceed?"),
      ],
    });
    const turn1Message = "I want more sales to my website, use my Beautybeespk page";
    let turn1;
    try {
      turn1 = await orchestrate({
        userId, agentId, conversationId, userMessage: turn1Message,
        history: [{ role: "user", content: turn1Message }],
        agentSystemPrompt: "You are the Meta Ads Expert.",
      });
    } finally {
      restoreFetch();
    }
    const activePlan = getActivePlanForConversation(userId, conversationId);
    assert.ok(activePlan);
    assert.equal(activePlan.planData.resolved.pageId, "717559728109412", "sanity check on the starting state");

    // Turn 2: review/improve the audience — NOT asking to change the Page —
    // the model's revision call omits facebook_page/changingAssets
    // entirely, exactly as agentLibrary.js instructs for an unrelated
    // revision.
    global.fetch = scriptedFetch({
      metaOpts: twoPageFixture,
      chatResponses: [
        finalText("All genders 18-65 is reasonable."), // stale answer — must be intercepted
        researchCall,
        planCall({ gender: "FEMALE", audience_reasoning: "Reviewed store data — this category performs best with women.", revisesPlanId: activePlan.id }),
        finalText("Reviewed and narrowed the audience to women. Approve to proceed?"),
      ],
    });
    const turn2Message = "Review my data and improve the audience.";
    try {
      const turn2 = await orchestrate({
        userId, agentId, conversationId, userMessage: turn2Message,
        history: [
          { role: "user", content: turn1Message },
          { role: "assistant", content: turn1.reply },
          { role: "user", content: turn2Message },
        ],
        agentSystemPrompt: "You are the Meta Ads Expert.",
      });
      const revisionCall = turn2.toolResults.find((r) => r.toolName === "meta_expert.create_campaign_plan");
      assert.ok(revisionCall?.result?.valid, `the revision must validate: ${JSON.stringify(revisionCall)}`);
      const revisedStored = getStoredPlan(userId, revisionCall.result.planId);
      assert.equal(revisedStored.planData.resolved.pageId, "717559728109412", "the Page must be preserved — the review request never asked to change it");
      assert.equal(revisedStored.planData.plan.gender, "FEMALE", "the field actually being revised must still change");
    } finally {
      restoreFetch();
    }
  });

  // --- Meta Ads tool-failure hard stop (round 27 request) -----------------
  // Question raised: does a failed tool call get fed back to the model with
  // "try a different approach," meaning a Meta connection/API failure gets
  // improvised around differently each time instead of failing
  // consistently? Confirmed true for every tool category, including raw
  // meta.* (category "meta_ads") ones — orchestrate()'s outcome.status ===
  // "failed" branch had no category check at all. Fixed: a meta_ads tool
  // failure now ends the turn immediately with the real, structured error
  // — the model never sees it (so it can never improvise a different-
  // sounding workaround on retry) — while every other tool category keeps
  // the existing forgiving retry-nudge behavior unchanged (verified by the
  // next test).
  function scriptedFetchWithMetaFailure({ chatResponses, metaOpts = {}, failPathSuffix, failBody, failStatus = 400 }) {
    let chatIndex = 0;
    const metaHandler = metaRouter(metaOpts);
    return async (url, options = {}) => {
      const u = new URL(url);
      if (u.hostname === "api.anthropic.com") {
        const text = chatResponses[chatIndex];
        chatIndex += 1;
        if (text === undefined) {
          throw new Error(`Test error: chat mock exhausted after ${chatIndex - 1} scripted responses — the orchestrator called the model more times than this scenario expected.`);
        }
        return jsonResponse({ content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 5 } });
      }
      const path = u.pathname.replace(/^\/v[\d.]+/, "");
      if ((options.method || "GET") === "GET" && path.endsWith(failPathSuffix)) {
        return jsonResponse(failBody, failStatus);
      }
      return metaHandler(url, options);
    };
  }

  await check("[meta_ads failure] a raw meta.* tool failure ends the turn immediately with the real, structured error — no 'try a different approach' nudge, no second chat call", async () => {
    const userId = makeUser(`meta-ads-hardstop-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_ads"]);
    const conversationId = `conv-${cryptoRandom()}`;
    global.fetch = scriptedFetchWithMetaFailure({
      metaOpts: metaFixture,
      failPathSuffix: "/campaigns",
      failBody: { error: { message: "Invalid OAuth access token.", type: "OAuthException", code: 190, error_subcode: 463 } },
      failStatus: 401,
      // Only ONE scripted chat response — if the old forgiving behavior
      // regressed back in, the orchestrator would call the model a SECOND
      // time with a retry nudge and this mock would throw "chat mock
      // exhausted," failing the test.
      chatResponses: [decisionText({ type: "tool_call", toolName: "meta.list_campaigns", parameters: { adAccountId: "act_1" } })],
    });
    try {
      const userMessage = "Show me my campaigns";
      const result = await orchestrate({
        userId, agentId, conversationId, userMessage,
        history: [{ role: "user", content: userMessage }],
        agentSystemPrompt: "You manage Meta ads directly.",
      });
      assert.match(result.reply, /couldn't complete this Meta Ads action/i, `must use the deterministic hard-stop wording: ${result.reply}`);
      assert.match(result.reply, /Invalid OAuth access token/i, `the real Meta error must reach the customer verbatim: ${result.reply}`);
      assert.doesNotMatch(result.reply, /try a different approach/i, "must never carry the generic forgiving-retry wording");
      const failed = result.toolResults.find((r) => r.toolName === "meta.list_campaigns");
      assert.ok(failed?.error, "the failure must still be recorded in toolResults for the Trace UI");
      assert.equal(failed.code, 190, "err.code from Meta's real error payload must be preserved through to toolResults");
    } finally {
      restoreFetch();
    }
  });

  // A minimal, directly-registered throwaway tool with a NON-meta_ads
  // category — deliberately not reusing a real meta_expert tool, since its
  // internal resilience to a failed Meta API call isn't the point being
  // tested here and shouldn't be assumed. This isolates the test to
  // exactly one thing: does a category outside "meta_ads" still get the
  // pre-existing forgiving retry-nudge, unchanged.
  registerTool({
    name: "test.always_fails",
    description: "Test-only tool that always throws — used to verify non-meta_ads tool failures keep the forgiving retry behavior.",
    category: "test_tools",
    parameters: { type: "object", properties: {}, required: [] },
    requiredPermissions: [],
    requiresConfirmation: false,
    async execute() {
      throw new Error("Simulated non-Meta tool failure.");
    },
  });

  await check("[meta_ads failure] a NON-meta_ads tool failure (a different category) still gets the existing forgiving retry-nudge, unchanged", async () => {
    const userId = makeUser(`non-meta-ads-forgiving-${stamp}@example.com`);
    const agentId = makeAgentWithSkills(userId, ["test_tools"]);
    const conversationId = `conv-${cryptoRandom()}`;
    global.fetch = scriptedFetchWithMetaFailure({
      metaOpts: metaFixture,
      failPathSuffix: "/__never_hit__",
      failBody: {},
      chatResponses: [
        decisionText({ type: "tool_call", toolName: "test.always_fails", parameters: {} }),
        finalText("I couldn't complete that, but here's what I can tell you so far."),
      ],
    });
    try {
      const userMessage = "Do the thing";
      const result = await orchestrate({
        userId, agentId, conversationId, userMessage,
        history: [{ role: "user", content: userMessage }],
        agentSystemPrompt: "You are a test agent.",
      });
      // Reaching the SECOND scripted chat response at all proves the
      // failure was fed back to the model (the forgiving path), not
      // hard-stopped — scriptedFetchWithMetaFailure throws on mock
      // exhaustion if the orchestrator didn't call the model again.
      assert.match(result.reply, /here's what I can tell you so far/i, `the model's real second-turn reply must be used: ${result.reply}`);
      const failed = result.toolResults.find((r) => r.toolName === "test.always_fails");
      assert.ok(failed?.error, "the failure must still be recorded in toolResults");
      assert.match(failed.error, /Simulated non-Meta tool failure/);
    } finally {
      restoreFetch();
    }
  });

  // --- executor.js preserves err.code (round 27 request) -------------------
  // Question raised: does runTool preserve err.code, or only err.message?
  // Confirmed: only err.message before this fix — err.code/err.subcode
  // (set by integrations/meta/api.js's metaFetch from Meta's own error
  // payload) were silently dropped in executor.js's executeNow() catch
  // block. Tested directly against runTool() (not through the full
  // orchestrate() loop) since this is specifically about what the executor
  // itself returns.
  await check("[executor] runTool() preserves err.code/err.subcode from a thrown Meta API error, not just err.message", async () => {
    const userId = makeUser(`executor-errcode-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_ads"]);
    global.fetch = scriptedFetchWithMetaFailure({
      metaOpts: metaFixture,
      failPathSuffix: "/campaigns",
      failBody: { error: { message: "Budget too low.", type: "OAuthException", code: 100, error_subcode: 3858558 } },
      failStatus: 400,
      chatResponses: [],
    });
    try {
      const outcome = await runTool({
        toolName: "meta.list_campaigns",
        parameters: { adAccountId: "act_1" },
        userId, agentId, conversationId: `conv-${cryptoRandom()}`, planId: null,
      });
      assert.equal(outcome.status, "failed");
      assert.match(outcome.error, /Budget too low/i);
      assert.equal(outcome.code, 100, `err.code must be preserved: ${JSON.stringify(outcome)}`);
      assert.equal(outcome.subcode, 3858558, `err.subcode must be preserved: ${JSON.stringify(outcome)}`);
    } finally {
      restoreFetch();
    }
  });

  // --- safeParseDecision non-string crash fix (round 27 request) -----------
  // Question raised: does safeParseDecision's final fallback call .trim()
  // on the original argument instead of the coerced string? Confirmed:
  // yes, before this fix — `text.trim()` instead of `asString.trim()`,
  // which threw a TypeError for exactly the non-string-provider case the
  // function's own coercion logic exists to handle, whenever the text also
  // failed to parse as JSON, had no salvageable "message" field, and didn't
  // start with "{".
  await check("[safeParseDecision] a non-string, non-JSON, non-'{'-prefixed input no longer throws — falls back to the coerced string instead of crashing", () => {
    const contentParts = [{ text: "Sure, " }, { text: "here's my answer." }];
    const result = safeParseDecision(contentParts);
    assert.equal(result.type, "final");
    assert.equal(result.message, "Sure, here's my answer.");
  });

  await check("[safeParseDecision] the plain-string fallback path is unchanged by the fix", () => {
    const result = safeParseDecision("  Just a plain freeform reply, not JSON.  ");
    assert.equal(result.type, "final");
    assert.equal(result.message, "Just a plain freeform reply, not JSON.");
  });

  console.log(`\n# ${results.filter((r) => r.ok).length}/${results.length} Meta Expert orchestrator retry-limit checks passed.`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

await run();
