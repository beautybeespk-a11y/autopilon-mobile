// Meta Ads Expert V2 — regression suite covering the required live
// acceptance tests (A-J) plus raw-tool isolation proof (Step 9), before
// V2 may be enabled for real users. Real production code (server/agents/
// metaExpertV2/*, server/tools/meta/metaExpertV2.js, the orchestrator's
// V2 gate), real DB — only Meta's Graph API, WooCommerce's REST API, and
// (for the orchestrator-level tests) Anthropic's chat endpoint are mocked,
// same pattern as the original planner's regression suites.
//
//   node test/metaExpertV2Regression.js
import assert from "node:assert/strict";

process.env.DB_PATH = process.env.DB_PATH || "/tmp/meta-expert-v2-regression.sqlite";
process.env.BYOK_ENCRYPTION_KEY = process.env.BYOK_ENCRYPTION_KEY || "test-byok-encryption-key-for-meta-expert-v2-test";
process.env.META_APP_ID = process.env.META_APP_ID || "test-app-id";
process.env.META_APP_SECRET = process.env.META_APP_SECRET || "test-app-secret";
process.env.META_EXPERT_V2_MAX_SUGGESTED_DAILY_BUDGET = "5000";
process.env.META_EXPERT_V2_MAX_EXECUTABLE_DAILY_BUDGET = "10000";
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-anthropic-key";
process.env.META_EXPERT_V2 = "true";

const db = (await import("../db.js")).default;
const { cryptoRandom } = await import("../middleware.js");
const { saveConnection, updateConnectionMeta } = await import("../integrations/manager.js");
const { gatherBusinessSnapshot } = await import("../agents/metaExpertV2/businessSnapshot.js");
const { buildStrategy, reviseStrategy } = await import("../agents/metaExpertV2/strategyBuilder.js");
const { executeStrategy } = await import("../agents/metaExpertV2/executor.js");
const { getStoredStrategy, getActiveStrategyForConversation } = await import("../agents/metaExpertV2/strategyStore.js");
const { checkV2ExecutionApprovalGate, orchestrate } = await import("../orchestrator/index.js");
const { getTool, listToolsForSkills } = await import("../tools/registry.js");
const { runTool, resumeAfterConfirmation } = await import("../orchestrator/executor.js");
const { listTemplates, installTemplate } = await import("../orchestrator/agentLibrary.js");
const { updateFlag } = await import("../orchestrator/featureFlags.js");
await import("../tools/index.js"); // registers meta_expert_v2.* tools

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

function makeAgentWithSkills(userId, skillIds) {
  const agentId = cryptoRandom();
  const now = new Date().toISOString();
  db.prepare("INSERT INTO agents (id, userId, name, status, createdAt, updatedAt) VALUES (?, ?, ?, 'active', ?, ?)").run(agentId, userId, "Test V2 Agent", now, now);
  for (const skillId of skillIds) db.prepare("INSERT OR IGNORE INTO agent_skills (agentId, skillId) VALUES (?, ?)").run(agentId, skillId);
  return agentId;
}

const originalFetch = global.fetch;
function mockFetch(handler) { global.fetch = handler; }
function restoreFetch() { global.fetch = originalFetch; }
function jsonResponse(body, status = 200) { return { ok: status < 400, status, json: async () => body }; }

function metaRouter({ adAccounts = [], pages = [], igByPageId = {}, pixels = [], catalogs = [], campaigns = [], posts = [], writes = [] } = {}) {
  let nextId = 900000000000001n;
  return async (url, options = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v[\d.]+/, "");
    const method = options.method || "GET";
    if (method !== "GET") {
      writes.push({ path, body: options.body ? JSON.parse(options.body) : {} });
      return jsonResponse({ id: String(nextId++) });
    }
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
    if (path.endsWith("/insights")) return jsonResponse({ data: [{ impressions: "1000", clicks: "40", spend: "120", ctr: "4", cpc: "3", cpm: "12", reach: "900", frequency: "1.1", actions: [{ action_type: "purchase", value: "8" }], cost_per_action_type: [{ action_type: "purchase", value: "15" }], purchase_roas: [{ action_type: "omni_purchase", value: "2.4" }] }] });
    if (path.endsWith("/posts")) return jsonResponse({ data: posts });
    if (path.endsWith("/media")) return jsonResponse({ data: [] });
    return jsonResponse({ error: { message: `Unmocked GET path in test: ${path}` } }, 400);
  };
}

function scriptedFetch({ chatResponses, metaOpts = {} }) {
  let chatIndex = 0;
  const metaHandler = metaRouter(metaOpts);
  return async (url, options = {}) => {
    const u = new URL(url);
    if (u.hostname === "api.anthropic.com") {
      const text = chatResponses[chatIndex];
      chatIndex += 1;
      if (text === undefined) throw new Error(`Test error: chat mock exhausted after ${chatIndex - 1} scripted responses.`);
      return jsonResponse({ content: [{ type: "text", text }], usage: { input_tokens: 5, output_tokens: 5 } });
    }
    if (u.pathname.startsWith("/wp-json/wc/v3/")) {
      if (u.pathname.endsWith("/settings/general")) return jsonResponse([{ id: "woocommerce_default_country", value: "PK" }]);
      if (u.pathname.endsWith("/products")) return jsonResponse([{ id: 1, name: "Vitamin C Serum", price: "1800", categories: [{ name: "Skincare" }] }]);
      if (u.pathname.endsWith("/products/categories")) return jsonResponse([{ name: "Skincare" }]);
      if (u.pathname.endsWith("/reports/top_sellers")) return jsonResponse([]);
      return jsonResponse([]);
    }
    return metaHandler(url, options);
  };
}

function decisionText(decision) { return JSON.stringify(decision); }
function finalText(message) { return decisionText({ type: "final", message }); }
function toolCall(toolName, parameters) { return decisionText({ type: "tool_call", toolName, parameters }); }

function connectMeta(userId) {
  saveConnection(userId, "meta_ads", { accessToken: `fake-meta-token-${userId}`, expiresAt: null, scopes: ["ads_read", "ads_management", "pages_show_list", "business_management"] });
}
function connectWooCommerce(userId) {
  saveConnection(userId, "woocommerce", { accessToken: "fake-consumer-secret", expiresAt: null, scopes: [], meta: { siteUrl: "https://store.example.com", consumerKey: "ck_fake" } });
}

// A complete, valid campaign-mode strategy — the shape a well-behaved
// model would submit for "I want more sales on my website" against a
// clear e-commerce business with real purchase tracking.
function baseStrategy(overrides = {}) {
  return {
    business_goal: "I want more website sales",
    recommended_objective: "OUTCOME_SALES",
    optimization_event: "PURCHASE",
    conversion_location: "WEBSITE",
    audience_strategy: "PRODUCT_CATEGORY",
    gender: "FEMALE",
    age_min: 21,
    age_max: 44,
    locations: ["Pakistan"],
    countries: ["PK"],
    targeting_approach: "BROAD_WITH_TEST",
    placements: "ADVANTAGE_PLUS",
    creative_strategy: { source: "EXISTING_PAGE_POST", description: "Best recent product Reel" },
    budget_daily: 3000,
    budget_basis: "HEURISTIC_STARTING_TEST",
    bid_strategy: "LOWEST_COST_WITHOUT_CAP",
    cta: "SHOP_NOW",
    campaign_status: "PAUSED",
    reasoning_summary: "Store sells skincare with real purchase tracking; optimizing for Purchase drives revenue, not just cheap clicks — expect measurable ROAS and CPA once volume builds.",
    evidence_used: ["WooCommerce: Skincare category, sample product PKR 1,800"],
    assumptions: [],
    unresolved_questions: [],
    approval_required: true,
    facebook_page: { ref: "default_facebook_page" },
    ad_account: { ref: "default_ad_account" },
    pixel: { ref: "default_pixel" },
    ...overrides,
  };
}

const stamp = Date.now();

// Round 2 (runtime kill switch): every acceptance/isolation test below
// exercises normal V2 behavior, so the ambient state for the whole suite
// is "runtime-enabled" (both META_EXPERT_V2=true, set at the top of this
// file, and the DB flag on at 100% rollout) — the SAME two-gate check
// meta_expert_v2's tool wrappers now enforce on every call (server/
// agents/metaExpertV2/runtimeGate.js). The dedicated "[rollout]" and
// "[kill switch]" tests further down are the ones that deliberately flip
// this flag off mid-run — each restores it (in a try/finally) before
// returning, so no other test ever sees a stale disabled state.
updateFlag("meta_expert_v2", { enabled: true, rolloutPercent: 100 });

async function run() {
  console.log("Meta Ads Expert V2 regression suite\n");

  // --- Step 9: raw-tool isolation (structural + dynamic) ------------------
  await check("[isolation] listToolsForSkills(['meta_expert_v2']) exposes ONLY the 4 V2 tools — no raw meta.* mutation tools", () => {
    const names = listToolsForSkills(["meta_expert_v2"]).map((t) => t.name);
    assert.deepEqual(names.sort(), [
      "meta_expert_v2.build_strategy", "meta_expert_v2.execute_strategy",
      "meta_expert_v2.get_business_snapshot", "meta_expert_v2.revise_strategy",
    ]);
  });

  await check("[isolation] a V2-only agent attempting meta.create_campaign directly through the real runTool() dispatch path is REJECTED — 'create the best campaign' cannot reach the raw tool", async () => {
    const userId = makeUser(`v2-isolation-raw-campaign-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const outcome = await runTool({ toolName: "meta.create_campaign", parameters: { name: "x", objective: "OUTCOME_SALES", dailyBudget: 1000 }, userId, agentId, conversationId: `conv-${cryptoRandom()}`, planId: null });
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error, /not (available|enabled)|skill/i, `expected a tool-availability rejection, got: ${outcome.error}`);
  });

  await check("[isolation] a V2-only agent attempting meta.boost_post directly is REJECTED — 'boost this reel' cannot reach the raw tool", async () => {
    const userId = makeUser(`v2-isolation-raw-boost-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const outcome = await runTool({ toolName: "meta.boost_post", parameters: { adSetId: "1", name: "x", postId: "1_2" }, userId, agentId, conversationId: `conv-${cryptoRandom()}`, planId: null });
    assert.equal(outcome.status, "failed");
    assert.match(outcome.error, /not (available|enabled)|skill/i, `expected a tool-availability rejection, got: ${outcome.error}`);
  });

  // --- Acceptance Test A ----------------------------------------------
  await check("[Acceptance A] 'I want more sales on my website' — WooCommerce detected, correct defaults, usable Pixel, Sales/Purchase, no unnecessary question, full recommendation", async () => {
    const userId = makeUser(`accept-a-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    updateConnectionMeta(userId, "meta_ads", { defaults: { adAccountId: "act_1", pageId: "111" } });
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "Beautybeespk Ads" }], pages: [{ id: "111", name: "Beautybeespk" }], pixels: [{ id: "px1", name: "Store Pixel" }] } }));
    try {
      const snapshot = await gatherBusinessSnapshot(userId);
      assert.equal(snapshot.business.commerceConnected, true);
      assert.equal(snapshot.business.commerceDataStatus, "exists");
      assert.equal(snapshot.metaAssets.defaultAdAccount.id, "act_1");
      assert.equal(snapshot.metaAssets.defaultPage.id, "111");
      assert.equal(snapshot.metaAssets.defaultPixel.id, "px1");

      const result = await buildStrategy({ userId, conversationId: `conv-${cryptoRandom()}`, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.equal(result.strategy.recommended_objective, "OUTCOME_SALES");
      assert.equal(result.strategy.optimization_event, "PURCHASE");
      assert.equal(result.resolved.adAccountId, "act_1");
      assert.equal(result.resolved.pageId, "111");
      assert.equal(result.resolved.pixelId, "px1");
      assert.equal(result.strategy.unresolved_questions.length, 0, "no unnecessary question when everything is resolvable");
      assert.match(result.recommendationText, /Goal: Website Purchases/);
      assert.match(result.recommendationText, /3000\/day/);
    } finally {
      restoreFetch();
    }
  });

  // --- Acceptance Test B ------------------------------------------------
  await check("[Acceptance B] a Traffic recommendation for a clear e-commerce business with real tracking is REJECTED unless goal_alignment explicitly flags it", async () => {
    const userId = makeUser(`accept-b-reject-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const strategy = baseStrategy({ recommended_objective: "OUTCOME_TRAFFIC", optimization_event: "LINK_CLICKS", pixel: null });
      const result = await buildStrategy({ userId, conversationId: `conv-${cryptoRandom()}`, accessToken: `fake-meta-token-${userId}`, strategy, userMessage: "I want more traffic" });
      assert.equal(result.ok, false);
      assert.match(result.unresolved.issue, /Traffic objective must not be recommended silently/i);
    } finally {
      restoreFetch();
    }
  });

  await check("[Acceptance B] Traffic is accepted as a genuine, explicit alternative once goal_alignment correctly recommends Sales and offers Traffic as the alternative", async () => {
    const userId = makeUser(`accept-b-alt-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const strategy = baseStrategy({
        goal_alignment: { literal_request: "traffic", likely_business_outcome: "revenue from purchases", recommendation_differs_from_literal_request: true },
        unresolved_questions: ["You asked for traffic, but Sales optimized for Purchase is more appropriate for a revenue business — say so if you genuinely just want visits and I'll switch to Traffic."],
      });
      const result = await buildStrategy({ userId, conversationId: `conv-${cryptoRandom()}`, accessToken: `fake-meta-token-${userId}`, strategy, userMessage: "I want more traffic" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.equal(result.strategy.recommended_objective, "OUTCOME_SALES");
      assert.match(result.recommendationText, /Before I can build this/);
    } finally {
      restoreFetch();
    }
  });

  // --- Acceptance Test C -------------------------------------------------
  await check("[Acceptance C] 'Why did you choose this audience and budget? Review my WooCommerce and Meta history.' — snapshot refreshed, assets preserved, audience/budget actually reconsidered", async () => {
    const userId = makeUser(`accept-c-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const initial = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(initial.ok, true, JSON.stringify(initial.unresolved));

      const revision = await reviseStrategy({
        userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: initial.strategyId,
        requestedChanges: { gender: "ALL", age_min: 18, age_max: 55, audience_strategy: "ACCOUNT_HISTORY", budget_daily: 2000, budget_basis: "SAVED_POLICY", reasoning_summary: "Reviewed store data and Meta history — widening slightly and lowering the test budget based on recent CPA." },
        freshResearchRequired: true, userMessage: "Why did you choose this audience and budget? Review my WooCommerce and Meta history.",
      });
      assert.equal(revision.ok, true, JSON.stringify(revision.unresolved));
      assert.notEqual(revision.strategy.gender, initial.strategy.gender, "audience must actually be reconsidered, not cosmetic");
      assert.notEqual(revision.strategy.budget_daily, initial.strategy.budget_daily, "budget must actually be reconsidered, not cosmetic");
      assert.equal(revision.resolved.adAccountId, initial.resolved.adAccountId, "assets must be preserved across a revision that didn't ask to change them");
      assert.equal(revision.resolved.pageId, initial.resolved.pageId);
      assert.equal(revision.resolved.pixelId, initial.resolved.pixelId);
    } finally {
      restoreFetch();
    }
  });

  await check("[Acceptance C, inverse] a revision that CLAIMS to reconsider audience/budget but leaves the values identical is REJECTED — cosmetic prose only is never accepted", async () => {
    const userId = makeUser(`accept-c-cosmetic-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const initial = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(initial.ok, true, JSON.stringify(initial.unresolved));
      const revision = await reviseStrategy({
        userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: initial.strategyId,
        requestedChanges: { gender: initial.strategy.gender, age_min: initial.strategy.age_min, age_max: initial.strategy.age_max, budget_daily: initial.strategy.budget_daily, reasoning_summary: "I've carefully reconsidered the audience and test budget for purchase-driven revenue and the same values remain the best fit for ROAS/CPA." },
        userMessage: "Improve the audience and budget",
      });
      assert.equal(revision.ok, false);
      assert.match(revision.unresolved.issue, /left .* exactly as they were/i);
    } finally {
      restoreFetch();
    }
  });

  // --- Acceptance Test D ---------------------------------------------
  await check("[Acceptance D] 'Make the audience narrower' revises ONLY the audience — Page/ad account/Pixel unchanged", async () => {
    const userId = makeUser(`accept-d-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }, { id: "act_2", name: "B" }], pages: [{ id: "111", name: "P" }, { id: "222", name: "Q" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      updateConnectionMeta(userId, "meta_ads", { defaults: { adAccountId: "act_1", pageId: "111" } });
      const initial = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(initial.ok, true, JSON.stringify(initial.unresolved));

      const revision = await reviseStrategy({
        userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: initial.strategyId,
        requestedChanges: { age_min: 25, age_max: 34, reasoning_summary: "Narrowing to the age band with the strongest historical conversion rate." },
        userMessage: "Make the audience narrower",
      });
      assert.equal(revision.ok, true, JSON.stringify(revision.unresolved));
      assert.equal(revision.strategy.age_min, 25);
      assert.equal(revision.strategy.age_max, 34);
      assert.equal(revision.resolved.adAccountId, "act_1", "ad account must be unchanged");
      assert.equal(revision.resolved.pageId, "111", "Page must be unchanged");
      assert.equal(revision.resolved.pixelId, "px1", "Pixel must be unchanged");
    } finally {
      restoreFetch();
    }
  });

  // --- Acceptance Test E (orchestrator-level: current data over memory) --
  await check("[Acceptance E] 'Does my Meta account have a Pixel?' forces a real get_business_snapshot call — never answered from chat memory", async () => {
    const userId = makeUser(`accept-e-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        finalText("No, your Meta account does not have a Pixel connected."), // must be intercepted — no tool called
        toolCall("meta_expert_v2.get_business_snapshot", {}),
        finalText("Yes — your account has a connected Pixel (Pixel)."),
      ],
    }));
    try {
      const userMessage = "Does my Meta account have a Pixel?";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const toolNames = result.toolResults.map((r) => r.toolName);
      assert.ok(toolNames.includes("meta_expert_v2.get_business_snapshot"), `a real tool must be called to answer an integration-state question, not memory: ${JSON.stringify(toolNames)}`);
      assert.match(result.reply, /has a connected pixel/i);
    } finally {
      restoreFetch();
    }
  });

  // --- Acceptance Test F (orchestrator-level: approval gate + execution) -
  await check("[Acceptance F] checkV2ExecutionApprovalGate blocks execute_strategy with no active strategy", () => {
    const userId = makeUser(`accept-f-noplan-${stamp}@example.com`);
    const gate = checkV2ExecutionApprovalGate({ userId, conversationId: `conv-${cryptoRandom()}`, userMessage: "approve it" });
    assert.ok(gate, "must be blocked when no active strategy exists");
  });

  await check("[Acceptance F] checkV2ExecutionApprovalGate blocks execute_strategy without explicit approval language, even with an active strategy", async () => {
    const userId = makeUser(`accept-f-noapproval-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true);
      const gate = checkV2ExecutionApprovalGate({ userId, conversationId, userMessage: "looks good, tell me more about it" });
      assert.ok(gate, "must be blocked without genuine approval language");
    } finally {
      restoreFetch();
    }
  });

  await check("[Acceptance F] 'Approve it.' — explicit approval gate passes, execute_strategy creates a PAUSED campaign through the real executor, raw tools stayed internal", async () => {
    const userId = makeUser(`accept-f-execute-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true);
      const gate = checkV2ExecutionApprovalGate({ userId, conversationId, userMessage: "Approve it." });
      assert.equal(gate, null, "genuine approval language with an active strategy must pass the gate");

      const executed = await executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId });
      assert.equal(executed.status, "PAUSED");
      assert.ok(executed.campaignId);
      assert.ok(executed.adSetId);
      const stored = getStoredStrategy(userId, built.strategyId);
      assert.equal(stored.status, "executed");
    } finally {
      restoreFetch();
    }
  });

  // --- Acceptance Test G --------------------------------------------------
  await check("[Acceptance G] multiple ad accounts/Pages/Pixels — saved defaults are used deterministically, never guessed", async () => {
    const userId = makeUser(`accept-g-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    updateConnectionMeta(userId, "meta_ads", { defaults: { adAccountId: "act_237956315579168", pageId: "717559728109412", pixelId: "px_default" } });
    mockFetch(scriptedFetch({
      chatResponses: [],
      metaOpts: {
        adAccounts: [{ id: "act_237956315579168", name: "Beautybeespk Ads" }, { id: "act_other", name: "Other Ads" }],
        pages: [{ id: "717559728109412", name: "Beautybeespk" }, { id: "999999999999999", name: "Careonabudget.pk" }],
        pixels: [{ id: "px_default", name: "Store Pixel" }, { id: "px_other", name: "Other Pixel" }],
      },
    }));
    try {
      const result = await buildStrategy({ userId, conversationId: `conv-${cryptoRandom()}`, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.equal(result.resolved.adAccountId, "act_237956315579168");
      assert.equal(result.resolved.pageId, "717559728109412");
      assert.equal(result.resolved.pixelId, "px_default");
    } finally {
      restoreFetch();
    }
  });

  // --- Acceptance Test H ---------------------------------------------
  await check("[Acceptance H] no usable Pixel — Sales/Purchase remains the recommendation, tracking blocker explained, NO silent Traffic downgrade", async () => {
    const userId = makeUser(`accept-h-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [] } }));
    try {
      const strategy = baseStrategy({ pixel: null });
      const result = await buildStrategy({ userId, conversationId: `conv-${cryptoRandom()}`, accessToken: `fake-meta-token-${userId}`, strategy, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, false, "zero Pixels is a genuine tracking blocker and must reject");
      assert.match(result.unresolved.issue, /tracking-setup gap/i);
      // The message may still legitimately MENTION Traffic as something to
      // offer the user EXPLICITLY if they genuinely want it (that's the
      // correct, desired guidance) — what must never appear is language
      // instructing an automatic/silent switch away from Sales/Purchase.
      assert.doesNotMatch(result.unresolved.issue, /silently switch|switch (the )?objective|downgrade (it|to)/i, "the rejection must never instruct a silent/automatic switch away from Sales/Purchase");
      assert.match(result.unresolved.issue, /not a reason to change the objective/i, "the rejection must explicitly forbid treating this as a reason to change the objective");
    } finally {
      restoreFetch();
    }
  });

  await check("[Acceptance H] an AMBIGUOUS Pixel (2+, no default) asks once via unresolved_questions — never rejects, never downgrades the objective", async () => {
    const userId = makeUser(`accept-h-ambiguous-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel One" }, { id: "px2", name: "Pixel Two" }] } }));
    try {
      const strategy = baseStrategy({ pixel: null });
      const result = await buildStrategy({ userId, conversationId: `conv-${cryptoRandom()}`, accessToken: `fake-meta-token-${userId}`, strategy, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.equal(result.strategy.recommended_objective, "OUTCOME_SALES");
      assert.equal(result.strategy.optimization_event, "PURCHASE");
      assert.ok(result.strategy.unresolved_questions.some((q) => /pixel/i.test(q)));
    } finally {
      restoreFetch();
    }
  });

  // --- Acceptance Test I --------------------------------------------
  await check("[Acceptance I] no budget supplied — a safe heuristic test budget is used, honest basis, approval required", async () => {
    const userId = makeUser(`accept-i-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const strategy = baseStrategy({ budget_daily: 3000, budget_basis: "HEURISTIC_STARTING_TEST", approval_required: true });
      const result = await buildStrategy({ userId, conversationId: `conv-${cryptoRandom()}`, accessToken: `fake-meta-token-${userId}`, strategy, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.equal(result.strategy.budget_basis, "HEURISTIC_STARTING_TEST");
      assert.equal(result.strategy.approval_required, true);
      assert.match(result.recommendationText, /conservative starting test budget/);
    } finally {
      restoreFetch();
    }
  });

  await check("[Acceptance I] an over-cap heuristic budget is silently clamped to the safe maximum — no repair attempt, no rejection", async () => {
    const userId = makeUser(`accept-i-cap-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const strategy = baseStrategy({ budget_daily: 80000, budget_basis: "HEURISTIC_STARTING_TEST" });
      const result = await buildStrategy({ userId, conversationId: `conv-${cryptoRandom()}`, accessToken: `fake-meta-token-${userId}`, strategy, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.equal(result.strategy.budget_daily, 5000);
    } finally {
      restoreFetch();
    }
  });

  // --- Acceptance Test J --------------------------------------------
  await check("[Acceptance J] an invalid/aliased enum value is normalized automatically on the FIRST attempt — no retry loop needed", async () => {
    const userId = makeUser(`accept-j-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const strategy = baseStrategy({ bid_strategy: "LOWEST_COST_WITHOUT_BID_CAP", cta: undefined });
      const result = await buildStrategy({ userId, conversationId: `conv-${cryptoRandom()}`, accessToken: `fake-meta-token-${userId}`, strategy, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.equal(result.strategy.bid_strategy, "LOWEST_COST_WITHOUT_CAP");
      assert.equal(result.strategy.cta, "SHOP_NOW");
    } finally {
      restoreFetch();
    }
  });

  // --- Feature flag / rollout -------------------------------------------
  // --- Step 10: explicit actions ("boost my latest reel") -----------
  await check("[explicit action] 'boost my latest Facebook post' resolves content ORDINALLY (never a raw id), builds, and executes through the internal boost_post primitive — PAUSED", async () => {
    const userId = makeUser(`explicit-action-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({
      chatResponses: [],
      metaOpts: {
        adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }],
        posts: [{ id: "111_999", message: "New arrivals!", created_time: "2026-01-01T00:00:00Z" }],
      },
    }));
    try {
      const strategy = {
        mode: "explicit_action",
        business_goal: "boost my latest Facebook post",
        action_type: "BOOST_FACEBOOK_POST",
        content_selector: { position: 1 },
        budget_daily: 1000,
        budget_basis: "HEURISTIC_STARTING_TEST",
        campaign_status: "PAUSED",
        reasoning_summary: "Boosting the most recent organic post to extend its reach among an already-engaged audience.",
        evidence_used: ["Most recent Facebook Page post"],
        assumptions: [],
        unresolved_questions: [],
        approval_required: true,
        facebook_page: { ref: "default_facebook_page" },
        ad_account: { ref: "default_ad_account" },
      };
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy, userMessage: "boost my latest Facebook post" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
      assert.equal(built.resolved.contentId, "111_999", "position 1 must resolve to the real, most-recent post id from the snapshot — never invented");
      assert.match(built.recommendationText, /boost your most recent Facebook post/i);

      const gate = checkV2ExecutionApprovalGate({ userId, conversationId, userMessage: "approve" });
      assert.equal(gate, null);
      const executed = await executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId });
      assert.equal(executed.status, "PAUSED");
      assert.ok(executed.adId, "the boosted post ad must be created");
    } finally {
      restoreFetch();
    }
  });

  await check("[rollout] the V2 template is hidden from listTemplates() when the feature flag is disabled for this user", () => {
    const userId = makeUser(`rollout-hidden-${stamp}@example.com`);
    updateFlag("meta_expert_v2", { enabled: false });
    try {
      const templates = listTemplates(userId, null);
      assert.ok(!templates.some((t) => t.id === "meta-ads-manager-v2"), "V2 template must stay hidden while the flag is off");
    } finally {
      updateFlag("meta_expert_v2", { enabled: true, rolloutPercent: 100 }); // restore ambient "enabled" state for later tests
    }
  });

  await check("[rollout] enabling the feature flag for a specific user makes the V2 template visible to them, and installable", () => {
    const userId = makeUser(`rollout-enabled-${stamp}@example.com`);
    updateFlag("meta_expert_v2", { enabled: true, rolloutPercent: 100 });
    const templates = listTemplates(userId, null);
    assert.ok(templates.some((t) => t.id === "meta-ads-manager-v2"));
    const agent = installTemplate(userId, "meta-ads-manager-v2", null, null);
    assert.deepEqual(agent.skillIds || [], ["meta_expert_v2"].filter(() => true), "installed agent's skills should be exactly meta_expert_v2");
  });

  // --- Runtime kill switch (round 2) ---------------------------------
  // Closes the gap the pre-deployment report flagged: install-time gating
  // (agentLibrary.js's listTemplates/installTemplate) only controls
  // whether a NEW agent can be created from the V2 template — it says
  // nothing about an agent installed BEFORE the flag was disabled. This
  // proves the runtime gate (server/agents/metaExpertV2/runtimeGate.js) is
  // checked fresh on every V2 tool call, so flipping the flag off takes
  // effect immediately for an agent that already exists, with no
  // dependency on when it was installed.
  await check("[kill switch] 1-6: a V2 agent installed while ENABLED is fully blocked (snapshot/build/revise/execute, raw Meta mutations never reached) once the flag is disabled, and fully restored once it's re-enabled", async () => {
    const userId = makeUser(`kill-switch-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    const writes = [];
    mockFetch(scriptedFetch({
      chatResponses: [],
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }], writes },
    }));
    try {
      // 1. V2 agent installed WHILE ENABLED — through the real install
      // path (agentLibrary.js's installTemplate), not a hand-rolled DB row.
      updateFlag("meta_expert_v2", { enabled: true, rolloutPercent: 100 });
      const agent = installTemplate(userId, "meta-ads-manager-v2", null, null);
      const agentId = agent.id;

      // A real, approved-shape strategy built WHILE enabled — proves even
      // an already-built strategy can't be executed once the flag flips.
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
      assert.equal(writes.length, 0, "building a strategy alone must never touch the Meta write API");

      // 2. Feature flag later disabled.
      updateFlag("meta_expert_v2", { enabled: false });

      // 3. Snapshot/build/revise calls are blocked — through the REAL
      // runTool() dispatch path (the same path a live agent call goes
      // through), not just the bare function.
      const snapshotOutcome = await runTool({ toolName: "meta_expert_v2.get_business_snapshot", parameters: {}, userId, agentId, conversationId, planId: null });
      assert.equal(snapshotOutcome.status, "failed");
      assert.match(snapshotOutcome.error, /not currently available/i);

      const buildOutcome = await runTool({ toolName: "meta_expert_v2.build_strategy", parameters: baseStrategy(), userId, agentId, conversationId, planId: null });
      assert.equal(buildOutcome.status, "failed");
      assert.match(buildOutcome.error, /not currently available/i);

      const reviseOutcome = await runTool({ toolName: "meta_expert_v2.revise_strategy", parameters: { strategyId: built.strategyId, requestedChanges: { gender: "MALE" } }, userId, agentId, conversationId, planId: null });
      assert.equal(reviseOutcome.status, "failed");
      assert.match(reviseOutcome.error, /not currently available/i);

      // 4. execute_strategy is blocked — through the REAL confirm-then-
      // resume flow (requiresConfirmation:true means runTool() only
      // returns awaiting_confirmation; the runtime gate is enforced when
      // the confirmation is actually resumed, exactly where the real
      // Meta write would otherwise happen).
      const execAttempt = await runTool({ toolName: "meta_expert_v2.execute_strategy", parameters: { strategyId: built.strategyId }, userId, agentId, conversationId, planId: null });
      assert.equal(execAttempt.status, "awaiting_confirmation", "the approval prompt itself is still shown — the block happens at the point the real write would occur, same as every other confirm-gated Meta write tool");
      const resumed = await resumeAfterConfirmation({ executionId: execAttempt.executionId, approved: true });
      assert.equal(resumed.status, "failed");
      assert.match(resumed.error, /not currently available/i);

      // 4b. Direct-function defense-in-depth — executeStrategy() itself
      // (not just its tool wrapper) refuses to run while disabled, for
      // any future caller that might reach it another way.
      await assert.rejects(
        () => executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId }),
        (err) => err.code === "META_EXPERT_V2_DISABLED"
      );

      // 5. Raw Meta mutations never reached — no campaign/ad set/ad/etc.
      // write request ever hit the Meta API mock during any of the
      // blocked attempts above.
      assert.equal(writes.length, 0, "no Meta write call must ever be reached while the runtime flag is disabled");
      const stillProposed = getStoredStrategy(userId, built.strategyId);
      assert.equal(stillProposed.status, "proposed", "the strategy must remain unexecuted — never silently marked approved/executing/executed while blocked");

      // 6. Re-enabling restores functionality — the SAME strategy, same
      // agent, same conversation, no reinstall needed.
      updateFlag("meta_expert_v2", { enabled: true, rolloutPercent: 100 });
      const snapshotAfter = await runTool({ toolName: "meta_expert_v2.get_business_snapshot", parameters: {}, userId, agentId, conversationId, planId: null });
      assert.equal(snapshotAfter.status, "completed");

      const executedAfter = await executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId });
      assert.equal(executedAfter.status, "PAUSED");
      assert.ok(writes.length > 0, "re-enabled execution must actually reach the Meta write API this time");
      const finalStored = getStoredStrategy(userId, built.strategyId);
      assert.equal(finalStored.status, "executed");
    } finally {
      restoreFetch();
      updateFlag("meta_expert_v2", { enabled: true, rolloutPercent: 100 }); // restore ambient "enabled" state regardless of pass/fail
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} Meta Expert V2 checks passed.`);
  if (failed.length) {
    console.log("\nFailed checks:");
    for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
    process.exit(1);
  }
}

run();
