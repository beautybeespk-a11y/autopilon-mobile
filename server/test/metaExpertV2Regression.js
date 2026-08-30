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
const { getStoredStrategy, getActiveStrategyForConversation, listRecentStrategiesForUser } = await import("../agents/metaExpertV2/strategyStore.js");
const { checkV2ExecutionApprovalGate, orchestrate } = await import("../orchestrator/index.js");
const { getTool, listToolsForSkills } = await import("../tools/registry.js");
const { runTool, resumeAfterConfirmation } = await import("../orchestrator/executor.js");
const { listTemplates, installTemplate } = await import("../orchestrator/agentLibrary.js");
const { updateFlag } = await import("../orchestrator/featureFlags.js");
const { handleIncomingMessage } = await import("../orchestrator/conversationService.js");
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

function metaRouter({ adAccounts = [], pages = [], igByPageId = {}, pixels = [], catalogs = [], campaigns = [], posts = [], postsError = false, writes = [] } = {}) {
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
    // postsError simulates a real Meta API failure (e.g. a transient error
    // or a revoked permission) for the Page-posts fetch specifically —
    // distinct from "not_connected"/empty, matching businessSnapshot.js's
    // real fetch_failed status (attempt() catches the thrown error).
    if (path.endsWith("/posts")) return postsError ? jsonResponse({ error: { message: "Simulated Facebook posts fetch failure" } }, 500) : jsonResponse({ data: posts });
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
    // PRODUCT_IMAGE rather than EXISTING_PAGE_POST — grounded regardless of
    // whether a given test happens to mock any Facebook/Instagram posts
    // (most don't, since post content isn't what they're testing); an
    // EXISTING_PAGE_POST/EXISTING_INSTAGRAM_POST claim is now backend-
    // enforced against real snapshot content (checkCreativeSourceAvailabilityPolicy)
    // and would be rejected against an empty mocked post list.
    creative_strategy: { source: "PRODUCT_IMAGE", description: "Product image ad featuring the Vitamin C Serum" },
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

  // --- V2 single-call gate (live bug: build_strategy retry loop) ---------
  // Live testing round: "I want more sales to my website" led the model to
  // call meta_expert_v2.build_strategy repeatedly in the same turn until
  // the orchestrator's step limit was hit. These tests exercise the fix
  // through the REAL orchestrate() loop (server/orchestrator/index.js),
  // same mocked-chatComplete harness as Acceptance E/F above — not just a
  // unit test of the gate function in isolation.
  await check("[V2 gate] build_strategy called twice in one turn — the second call is never really dispatched; the model is nudged with exactly what the first (rejected) call returned, and finalizes from it", async () => {
    const userId = makeUser(`v2-gate-build-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        toolCall("meta_expert_v2.build_strategy", {}), // deliberately incomplete — guaranteed structural rejection (valid:false)
        toolCall("meta_expert_v2.build_strategy", {}), // the live-bug repeat — must be intercepted, never really dispatched again
        finalText("I wasn't able to finalize a strategy — some required business details are still missing. Could you tell me more about your goal?"),
      ],
    }));
    try {
      const userMessage = "I want more sales to my website";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const buildCalls = result.toolResults.filter((r) => r.toolName === "meta_expert_v2.build_strategy");
      assert.equal(buildCalls.length, 2, `expected exactly one real dispatch + one blocked-duplicate entry, got: ${JSON.stringify(buildCalls)}`);
      assert.ok(buildCalls[0].result, "the first call must be a real dispatch with a result");
      assert.equal(buildCalls[0].result.valid, false);
      assert.ok(buildCalls[1].error && /blocked duplicate call this turn/i.test(buildCalls[1].error), "the second call must be intercepted before it ever reaches the real builder");
      assert.match(result.reply, /wasn't able to finalize/i);
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 gate] build_strategy called a THIRD time in one turn — hard-stops with a clean customer-safe reply instead of grinding toward the step limit", async () => {
    const userId = makeUser(`v2-gate-build-hardstop-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        toolCall("meta_expert_v2.build_strategy", {}),
        toolCall("meta_expert_v2.build_strategy", {}), // 1st repeat — nudged, not dispatched
        toolCall("meta_expert_v2.build_strategy", {}), // 2nd repeat (3rd total call) — hard-stopped before another model call is even needed
      ],
    }));
    try {
      const userMessage = "I want more sales to my website";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const buildCalls = result.toolResults.filter((r) => r.toolName === "meta_expert_v2.build_strategy");
      assert.equal(buildCalls.length, 2, `only the FIRST call may ever be a real dispatch — no third real dispatch, even after the hard-stop: ${JSON.stringify(buildCalls)}`);
      assert.ok(buildCalls[0].result);
      assert.match(result.reply, /already have a result/i);
      assert.doesNotMatch(result.reply, /step limit/i, "the internal orchestration detail must never be shown to the user");
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 gate] get_business_snapshot called twice in one turn — the second call is never really dispatched", async () => {
    const userId = makeUser(`v2-gate-snapshot-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        toolCall("meta_expert_v2.get_business_snapshot", {}),
        toolCall("meta_expert_v2.get_business_snapshot", {}), // repeat — must be intercepted
        finalText("Yes, your account has a connected Pixel."),
      ],
    }));
    try {
      const userMessage = "Does my account have a Pixel?";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const snapshotCalls = result.toolResults.filter((r) => r.toolName === "meta_expert_v2.get_business_snapshot");
      assert.equal(snapshotCalls.length, 2, `expected exactly one real dispatch + one blocked-duplicate entry, got: ${JSON.stringify(snapshotCalls)}`);
      assert.ok(snapshotCalls[0].result, "the first call must be a real dispatch");
      assert.ok(snapshotCalls[1].error && /blocked duplicate call this turn/i.test(snapshotCalls[1].error));
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 gate] revise_strategy called twice in one turn for a rejected revision — the second call is never really dispatched; the model is nudged with the first result", async () => {
    const userId = makeUser(`v2-gate-revise-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    let initial;
    try {
      initial = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(initial.ok, true, JSON.stringify(initial.unresolved));
    } finally {
      restoreFetch();
    }

    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        // gender is left identical to the prior strategy's own value — a
        // guaranteed, deterministic checkRevisionSubstantive rejection
        // (same rejection Acceptance C's inverse test exercises above).
        toolCall("meta_expert_v2.revise_strategy", { requestedChanges: { gender: initial.strategy.gender }, freshResearchRequired: false }),
        toolCall("meta_expert_v2.revise_strategy", { requestedChanges: { gender: initial.strategy.gender }, freshResearchRequired: false }), // repeat — must be intercepted
        finalText("I wasn't able to make that revision — the audience is already set the way you described."),
      ],
    }));
    try {
      const userMessage = "Reconsider the audience gender";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const reviseCalls = result.toolResults.filter((r) => r.toolName === "meta_expert_v2.revise_strategy");
      assert.equal(reviseCalls.length, 2, `expected exactly one real dispatch + one blocked-duplicate entry, got: ${JSON.stringify(reviseCalls)}`);
      assert.ok(reviseCalls[0].result);
      assert.equal(reviseCalls[0].result.valid, false);
      assert.ok(reviseCalls[1].error && /blocked duplicate call this turn/i.test(reviseCalls[1].error));
    } finally {
      restoreFetch();
    }
  });

  // --- Non-strategic reasoning_summary repair (live bug) -------------------
  // Live testing round: a valid OUTCOME_SALES/PURCHASE strategy (correct
  // objective, audience, budget, assets, placements) was rejected purely
  // because reasoning_summary's WORDING didn't frame it around purchases/
  // CPA/ROAS/revenue — a presentation defect, not a real business issue.
  // The backend now auto-repairs the summary deterministically instead of
  // rejecting, so build_strategy never needs a second call for this.
  await check("[V2 policy] a structurally valid Sales/Purchase strategy with a weak/generic reasoning_summary is auto-repaired (not rejected) — accepted on the FIRST build_strategy call", async () => {
    const userId = makeUser(`v2-repair-reasoning-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const weakSummary = "This will get more people to see and engage with your brand and increase reach.";
      const strategy = baseStrategy({ reasoning_summary: weakSummary });
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.notEqual(result.strategy.reasoning_summary, weakSummary, "the weak/generic wording must actually be replaced, not kept");
      assert.match(result.strategy.reasoning_summary, /\bpurchases?\b/i);
      assert.match(result.strategy.reasoning_summary, /\bcpa\b/i);
      assert.match(result.strategy.reasoning_summary, /\broas\b/i);
      assert.match(result.strategy.reasoning_summary, /\brevenue\b/i);
      assert.match(result.recommendationText, /\bpurchases?\b/i, "the repaired wording must actually reach the customer-facing recommendation text");
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 policy, orchestrator-level] a weak/generic reasoning_summary for an otherwise-valid Sales/Purchase strategy never triggers a second build_strategy call through the real loop", async () => {
    const userId = makeUser(`v2-repair-reasoning-loop-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    const strategy = baseStrategy({ reasoning_summary: "This will get more people to see and engage with your brand and increase reach." });
    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        toolCall("meta_expert_v2.build_strategy", strategy),
        finalText("Here is your recommended strategy."),
      ],
    }));
    try {
      const userMessage = "I want more sales on my website";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const buildCalls = result.toolResults.filter((r) => r.toolName === "meta_expert_v2.build_strategy");
      assert.equal(buildCalls.length, 1, `the weak reasoning_summary must be repaired in place — no retry should ever be needed: ${JSON.stringify(buildCalls)}`);
      assert.equal(buildCalls[0].result.valid, true, JSON.stringify(buildCalls[0].result));
    } finally {
      restoreFetch();
    }
  });

  // --- Creative-selection grounding (live bug) ------------------------------
  // Live testing round: "Choose the exact best creative for this campaign
  // from my recent Facebook/Instagram content and WooCommerce products.
  // Tell me which specific Reel/post/product you selected and why." was
  // answered directly — Agent Trace showed only Planning -> Completed, no
  // tool ever called — yet the reply confidently named a specific post/
  // product/date and called it high engagement/proven effectiveness, none
  // of which could have been known. Two backend fixes, tested below:
  // (1) orchestrator/index.js's CREATIVE_SELECTION_INTENT_PATTERNS now
  // forces a real get_business_snapshot (and revise_strategy, if an active
  // strategy exists) before the model may finalize such a request; (2)
  // policy.js's checkCreativeGroundingPolicy rejects/auto-repairs any
  // strategy that describes content as high-performing/proven without real
  // engagement data in the snapshot to back it up.
  const CREATIVE_TEST_POST = {
    id: "111_1", message: "New Vitamin C Serum drop!", created_time: "2024-03-03T10:00:00+0000",
    permalink_url: "https://facebook.com/111/posts/1", attachments: { data: [{ media_type: "video" }] },
  };
  const CREATIVE_TEST_POST_WITH_ENGAGEMENT = {
    ...CREATIVE_TEST_POST,
    likes: { summary: { total_count: 480 } }, comments: { summary: { total_count: 52 } }, shares: { count: 30 },
  };

  await check("[Creative gate 1] 'Choose my best recent Facebook Reel.' forces a real get_business_snapshot call before any creative claim is finalized", async () => {
    const userId = makeUser(`v2-creative-gate-1-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], posts: [CREATIVE_TEST_POST] },
      chatResponses: [
        finalText("Your Facebook Reel posted on March 3rd showing the new Vitamin C Serum has the highest engagement of all your recent content — I recommend using it."),
        toolCall("meta_expert_v2.get_business_snapshot", {}),
        finalText("Based on content relevance and format, the Vitamin C Serum post is the most suitable option to use — no real engagement data is currently available to rank it by results."),
      ],
    }));
    try {
      const userMessage = "Choose my best recent Facebook Reel.";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const toolNames = result.toolResults.map((r) => r.toolName);
      assert.ok(toolNames.includes("meta_expert_v2.get_business_snapshot"), `a real snapshot call must be forced before any creative claim is finalized: ${JSON.stringify(toolNames)}`);
      assert.doesNotMatch(result.reply, /highest engagement of all your recent content/i, "the invented, ungrounded claim must never reach the user");
    } finally {
      restoreFetch();
    }
  });

  await check("[Creative gate 2] the model tries to answer a creative-selection request by reusing a claim from conversation HISTORY without calling any tool — the stale-factual gate blocks it and forces a real snapshot call", async () => {
    const userId = makeUser(`v2-creative-gate-2-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], posts: [CREATIVE_TEST_POST] },
      chatResponses: [
        finalText("As I mentioned earlier, your March 3rd post is your best-performing content, so I'll use that one again."),
        toolCall("meta_expert_v2.get_business_snapshot", {}),
        finalText("Based on content relevance and format, the Vitamin C Serum post is the best fit to use for this ad."),
      ],
    }));
    const priorAssistantClaim = "Your March 3rd Facebook post about the Vitamin C Serum had the highest engagement of anything you've posted recently.";
    try {
      const userMessage = "Use my best recent content for this ad.";
      const history = [
        { role: "user", content: "Which of my posts performs best?" },
        { role: "assistant", content: priorAssistantClaim },
        { role: "user", content: userMessage },
      ];
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history, agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const toolNames = result.toolResults.map((r) => r.toolName);
      assert.ok(toolNames.includes("meta_expert_v2.get_business_snapshot"), `a real snapshot call must be forced even though conversation history already contains a specific claim: ${JSON.stringify(toolNames)}`);
      assert.doesNotMatch(result.reply, /as I mentioned earlier/i, "the reply must not simply repeat the stale historical claim");
    } finally {
      restoreFetch();
    }
  });

  await check("[Creative grounding 3] a creative selection claiming 'high performing'/'proven effectiveness' with NO real engagement data in the snapshot is auto-repaired to honest, clearly-labeled wording — never a false performance claim", async () => {
    const userId = makeUser(`v2-creative-noeng-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], posts: [CREATIVE_TEST_POST] } }));
    try {
      const strategy = {
        mode: "explicit_action",
        business_goal: "boost my best post",
        action_type: "BOOST_FACEBOOK_POST",
        content_selector: { confirmedId: "111_1" },
        budget_daily: 1000,
        budget_basis: "HEURISTIC_STARTING_TEST",
        campaign_status: "PAUSED",
        reasoning_summary: "This is your highest-performing post with proven effectiveness, so it's the best choice to boost.",
        evidence_used: ["Facebook Page recent content"],
        assumptions: [], unresolved_questions: [], approval_required: true,
        facebook_page: { ref: "default_facebook_page" }, ad_account: { ref: "default_ad_account" },
      };
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy, userMessage: "boost my best post" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.doesNotMatch(result.strategy.reasoning_summary, /highest-performing|proven effectiveness/i, "the unsupported performance claim must be replaced, not kept");
      assert.match(result.strategy.reasoning_summary, /content relevance and format/i);
    } finally {
      restoreFetch();
    }
  });

  await check("[Creative grounding 4] a creative selection claiming strong performance WITH real engagement data in the snapshot is accepted unchanged — grounded claims are allowed through", async () => {
    const userId = makeUser(`v2-creative-witheng-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], posts: [CREATIVE_TEST_POST_WITH_ENGAGEMENT] } }));
    try {
      const strategy = {
        mode: "explicit_action",
        business_goal: "boost my best post",
        action_type: "BOOST_FACEBOOK_POST",
        content_selector: { confirmedId: "111_1" },
        budget_daily: 1000,
        budget_basis: "HEURISTIC_STARTING_TEST",
        campaign_status: "PAUSED",
        reasoning_summary: "This is your highest-performing post (480 likes, 52 comments, 30 shares) with proven effectiveness, so it's the best choice to boost.",
        evidence_used: ["Facebook Page recent content: 480 likes, 52 comments, 30 shares"],
        assumptions: [], unresolved_questions: [], approval_required: true,
        facebook_page: { ref: "default_facebook_page" }, ad_account: { ref: "default_ad_account" },
      };
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy, userMessage: "boost my best post" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.equal(result.strategy.reasoning_summary, strategy.reasoning_summary, "a genuinely grounded performance claim must be accepted unchanged, not rewritten");
      assert.match(result.strategy.reasoning_summary, /480 likes/);
    } finally {
      restoreFetch();
    }
  });

  await check("[Creative revision 5] revising ONLY the creative selection for an active strategy preserves Page/ad account/Pixel/objective/audience/budget exactly, without rebuilding the campaign", async () => {
    const userId = makeUser(`v2-creative-revision-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({
      chatResponses: [],
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }], posts: [CREATIVE_TEST_POST_WITH_ENGAGEMENT] },
    }));
    try {
      const initial = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(initial.ok, true, JSON.stringify(initial.unresolved));

      const revision = await reviseStrategy({
        userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: initial.strategyId,
        requestedChanges: { creative_strategy: { source: "EXISTING_PAGE_POST", description: "Use the Vitamin C Serum post (480 likes, 52 comments, 30 shares) — real engagement shows strong interest." } },
        userMessage: "Choose the exact best creative for this campaign from my recent content.",
      });
      assert.equal(revision.ok, true, JSON.stringify(revision.unresolved));
      assert.match(revision.strategy.creative_strategy.description, /480 likes/);
      // Every non-creative field must carry forward unchanged — this must
      // be a revision, never a rebuild.
      assert.equal(revision.strategy.recommended_objective, initial.strategy.recommended_objective);
      assert.equal(revision.strategy.optimization_event, initial.strategy.optimization_event);
      assert.equal(revision.strategy.gender, initial.strategy.gender);
      assert.equal(revision.strategy.age_min, initial.strategy.age_min);
      assert.equal(revision.strategy.age_max, initial.strategy.age_max);
      assert.equal(revision.strategy.budget_daily, initial.strategy.budget_daily);
      assert.equal(revision.resolved.adAccountId, initial.resolved.adAccountId);
      assert.equal(revision.resolved.pageId, initial.resolved.pageId);
      assert.equal(revision.resolved.pixelId, initial.resolved.pixelId);
    } finally {
      restoreFetch();
    }
  });

  await check("[Creative grounding 6] a content_selector confirmedId that doesn't exist in the CURRENT snapshot is REJECTED — a specific post/date may only appear in the final answer if it's actually there", async () => {
    const userId = makeUser(`v2-creative-invalid-id-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], posts: [CREATIVE_TEST_POST] } }));
    try {
      const strategy = {
        mode: "explicit_action",
        business_goal: "boost my best post",
        action_type: "BOOST_FACEBOOK_POST",
        content_selector: { confirmedId: "999_invented_id" }, // NOT present in the real snapshot
        budget_daily: 1000,
        budget_basis: "HEURISTIC_STARTING_TEST",
        campaign_status: "PAUSED",
        reasoning_summary: "Boosting a specific post for maximum relevance.",
        evidence_used: ["Facebook Page recent content"],
        assumptions: [], unresolved_questions: [], approval_required: true,
        facebook_page: { ref: "default_facebook_page" }, ad_account: { ref: "default_ad_account" },
      };
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy, userMessage: "boost this specific post" });
      assert.equal(result.ok, false, "a post id that doesn't exist in the current snapshot must never be accepted");
      assert.match(result.unresolved.issue, /not one of the recent posts/i);
    } finally {
      restoreFetch();
    }
  });

  // --- Mandatory revise_strategy after snapshot (live bug follow-up) ------
  // Live testing round: the snapshot-forcing gate worked — the model
  // called meta_expert_v2.get_business_snapshot and correctly avoided
  // inventing engagement data — but with an active strategy, it then
  // finished right after the snapshot, never calling revise_strategy at
  // all. checkCreativeRevisionRequiredGate (orchestrator/index.js) now
  // forces get_business_snapshot -> revise_strategy -> final.
  await check("[Creative revision gate] active strategy + creative-selection request: finalizing right after get_business_snapshot (skipping revise_strategy) is blocked and forces the real revision call", async () => {
    const userId = makeUser(`v2-creative-revision-gate-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }], posts: [CREATIVE_TEST_POST_WITH_ENGAGEMENT] } }));
    let initial;
    try {
      initial = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(initial.ok, true, JSON.stringify(initial.unresolved));
    } finally {
      restoreFetch();
    }

    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }], posts: [CREATIVE_TEST_POST_WITH_ENGAGEMENT] },
      chatResponses: [
        toolCall("meta_expert_v2.get_business_snapshot", {}),
        // Live-bug shape: finalizes right after the snapshot, without ever
        // calling revise_strategy — must be intercepted.
        finalText("I recommend using the Vitamin C Serum post (480 likes, 52 comments, 30 shares) as your creative."),
        toolCall("meta_expert_v2.revise_strategy", { requestedChanges: { creative_strategy: { source: "EXISTING_PAGE_POST", description: "Use the Vitamin C Serum post (480 likes, 52 comments, 30 shares) — real engagement shows strong interest." } }, freshResearchRequired: false }),
        finalText("I've updated the creative to use your Vitamin C Serum post, which has real engagement (480 likes, 52 comments, 30 shares)."),
      ],
    }));
    try {
      const userMessage = "Choose the exact best creative for this campaign.";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const toolNames = result.toolResults.map((r) => r.toolName);
      assert.ok(toolNames.includes("meta_expert_v2.get_business_snapshot"), `snapshot must be called: ${JSON.stringify(toolNames)}`);
      assert.ok(toolNames.includes("meta_expert_v2.revise_strategy"), `revise_strategy must be called before finalizing when an active strategy exists: ${JSON.stringify(toolNames)}`);
      const reviseResult = result.toolResults.find((r) => r.toolName === "meta_expert_v2.revise_strategy")?.result;
      assert.equal(reviseResult?.valid, true, JSON.stringify(reviseResult));
      assert.doesNotMatch(result.reply, /I recommend using the Vitamin C Serum post \(480 likes, 52 comments, 30 shares\) as your creative\.$/, "the premature pre-revision answer must never be the final reply");
    } finally {
      restoreFetch();
    }
  });

  // --- Facebook fetch failure + Instagram unavailable (exact requested test) --
  // Live testing round: with an active strategy, an exact creative-
  // selection request, and a snapshot where Facebook post fetching FAILED
  // and Instagram has no usable content, the required flow is
  // get_business_snapshot -> revise_strategy -> final, and the resulting
  // creative strategy must NEVER present a WooCommerce product as if it
  // were an existing Facebook/Instagram creative — it must be honestly
  // labeled as a new, product-led recommendation instead.
  await check("[Creative revision, Facebook fetch failure] active strategy + exact creative-selection request + Facebook fetch failure + Instagram unavailable: revise_strategy is still called, the creative is updated, and no WooCommerce product is presented as an existing Meta creative", async () => {
    const userId = makeUser(`v2-creative-fbfail-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    // Initial strategy built while Facebook/Instagram content was fine.
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    let initial;
    try {
      initial = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(initial.ok, true, JSON.stringify(initial.unresolved));
    } finally {
      restoreFetch();
    }

    // Now the creative-selection turn: Facebook posts fetch FAILS
    // (postsError), and no Instagram account is connected at all — both
    // platforms are unusable for existing content.
    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }], postsError: true },
      chatResponses: [
        toolCall("meta_expert_v2.get_business_snapshot", {}),
        // Correctly-behaved model: does NOT claim an existing Facebook/
        // Instagram post — recommends a new product-led creative instead,
        // using the exact required honesty framing.
        toolCall("meta_expert_v2.revise_strategy", {
          requestedChanges: {
            creative_strategy: {
              source: "PRODUCT_IMAGE",
              description: "I couldn't verify a usable existing Reel/post, so I recommend creating a new product-led creative around the Vitamin C Serum based on WooCommerce relevance.",
            },
          },
          freshResearchRequired: false,
        }),
        finalText("I couldn't verify a usable existing Reel/post, so I recommend creating a new product-led creative around the Vitamin C Serum based on WooCommerce relevance."),
      ],
    }));
    try {
      const snapshotCheck = await gatherBusinessSnapshot(userId);
      assert.notEqual(snapshotCheck.recentContent.facebookPosts.status, "exists", "test setup sanity check: Facebook posts must be unusable");
      assert.notEqual(snapshotCheck.recentContent.instagramPosts.status, "exists", "test setup sanity check: Instagram must be unusable");

      const userMessage = "Choose the exact best creative for this campaign from my recent content.";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const toolNames = result.toolResults.map((r) => r.toolName);
      assert.ok(toolNames.includes("meta_expert_v2.get_business_snapshot"), `snapshot must be called: ${JSON.stringify(toolNames)}`);
      assert.ok(toolNames.includes("meta_expert_v2.revise_strategy"), `revise_strategy must still be called: ${JSON.stringify(toolNames)}`);
      const reviseResult = result.toolResults.find((r) => r.toolName === "meta_expert_v2.revise_strategy")?.result;
      assert.equal(reviseResult?.valid, true, JSON.stringify(reviseResult));

      const updated = getActiveStrategyForConversation(userId, conversationId);
      assert.notEqual(updated.strategy.creative_strategy.source, "EXISTING_PAGE_POST", "must never claim an existing Facebook post when Facebook fetch failed");
      assert.notEqual(updated.strategy.creative_strategy.source, "EXISTING_INSTAGRAM_POST", "must never claim an existing Instagram post when Instagram is unavailable");
      assert.match(updated.strategy.creative_strategy.description, /new product-led creative/i);
      assert.match(result.reply, /couldn't verify a usable existing reel\/post/i);
    } finally {
      restoreFetch();
    }
  });

  await check("[Creative source grounding] a revision that FALSELY claims an existing Facebook post as the creative while Facebook fetch failed and Instagram is unavailable is REJECTED", async () => {
    const userId = makeUser(`v2-creative-fbfail-rejected-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    let initial;
    try {
      initial = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(initial.ok, true, JSON.stringify(initial.unresolved));
    } finally {
      restoreFetch();
    }

    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }], postsError: true } }));
    try {
      // Misbehaving model: falsely claims an existing Facebook post despite
      // the fetch failure — this must never be silently accepted.
      const revision = await reviseStrategy({
        userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: initial.strategyId,
        requestedChanges: { creative_strategy: { source: "EXISTING_PAGE_POST", description: "Your recent Facebook post about the Vitamin C Serum." } },
        userMessage: "Choose the exact best creative for this campaign.",
      });
      assert.equal(revision.ok, false, "an existing-post claim must be rejected when that platform's content is actually unusable");
      assert.match(revision.unresolved.issue, /never present a WooCommerce\/Shopify product.*as if it were an existing Facebook creative/i);
    } finally {
      restoreFetch();
    }
  });

  // --- Exact live-reported wording, end-to-end through the real loop ------
  // Production report (commit 1ec290c): the exact live user message below,
  // against an active PROPOSED V2 strategy, still produced
  // get_business_snapshot -> final with no revise_strategy call. This
  // reproduces that scenario byte-for-byte (same wording, same active-
  // strategy setup, same bad-then-nudged model shape) through the REAL
  // orchestrate() loop to prove/disprove the gate logic itself is at
  // fault. See checkCreativeRevisionRequiredGate's temporary
  // [meta_expert_v2_trace] creativeRevisionGate instrumentation
  // (orchestrator/index.js) for the live diagnostic fields requested
  // alongside this test — set META_EXPERT_V2_TRACE=1 in production and
  // reproduce this exact message to see which field is actually false.
  await check("[Creative revision gate, exact live wording] active PROPOSED strategy + the exact reported live message: required flow is get_business_snapshot -> revise_strategy -> final", async () => {
    const userId = makeUser(`v2-creative-live-wording-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }], posts: [CREATIVE_TEST_POST_WITH_ENGAGEMENT] } }));
    let initial;
    try {
      initial = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(initial.ok, true, JSON.stringify(initial.unresolved));
      const storedInitial = getActiveStrategyForConversation(userId, conversationId);
      assert.equal(storedInitial.status, "proposed", "test setup sanity check: the active strategy must be PROPOSED, matching the live report");
    } finally {
      restoreFetch();
    }

    const userMessage =
      "Choose the exact best creative for this campaign from my recent Facebook/Instagram content and WooCommerce products. " +
      "Tell me which specific Reel/post/product you selected and why. " +
      "Do not ask me to choose unless the data is genuinely ambiguous.";

    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }], posts: [CREATIVE_TEST_POST_WITH_ENGAGEMENT] },
      chatResponses: [
        toolCall("meta_expert_v2.get_business_snapshot", {}),
        // Exact live-bug shape: finalizes right after the snapshot,
        // without ever calling revise_strategy.
        finalText("Based on your recent content, I selected the Vitamin C Serum post (480 likes, 52 comments, 30 shares) as the best creative for this campaign because it has real, verified engagement."),
        toolCall("meta_expert_v2.revise_strategy", { requestedChanges: { creative_strategy: { source: "EXISTING_PAGE_POST", description: "Use the Vitamin C Serum post (480 likes, 52 comments, 30 shares) — real engagement shows strong interest." } }, freshResearchRequired: false }),
        finalText("I've updated the creative to use your Vitamin C Serum post, which has real engagement (480 likes, 52 comments, 30 shares)."),
      ],
    }));
    try {
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const toolNames = result.toolResults.map((r) => r.toolName);
      assert.deepEqual(toolNames, ["meta_expert_v2.get_business_snapshot", "meta_expert_v2.revise_strategy"], `required flow is get_business_snapshot -> revise_strategy -> final: ${JSON.stringify(toolNames)}`);
      const reviseResult = result.toolResults.find((r) => r.toolName === "meta_expert_v2.revise_strategy")?.result;
      assert.equal(reviseResult?.valid, true, JSON.stringify(reviseResult));
      assert.doesNotMatch(result.reply, /because it has real, verified engagement\.$/, "the premature pre-revision answer must never be the final reply");
    } finally {
      restoreFetch();
    }
  });

  // --- Strategy persistence / conversationId linkage, end-to-end ----------
  // Production report: getActiveStrategyForConversation found no active
  // strategy for the live conversation (activeV2StrategyFound: false),
  // even though a build_strategy call had just succeeded in that same
  // chat. This exercises the REAL production call chain — routes/chat.js's
  // own conversation-creation step, then handleIncomingMessage()
  // (conversationService.js, the exact function routes/chat.js calls, not
  // orchestrate() called directly like the tests above) — end to end,
  // numbered to match the required invariant:
  //   1. User starts conversation X.
  //   2. build_strategy succeeds.
  //   3. DB row exists with conversationId X and status 'proposed'.
  //   4. Next user turn in the SAME chat asks to change/select creative.
  //   5. getActiveStrategyForConversation() returns that same strategy.
  //   6. The creative revision gate forces revise_strategy.
  await check("[Strategy persistence] end-to-end through the real chat call chain: build_strategy in conversation X persists conversationId=X/status=proposed, and the next turn in that same chat finds it", async () => {
    const userId = makeUser(`v2-persistence-e2e-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);

    // Step 1: "User starts conversation X" — replicate routes/chat.js's own
    // conversation-creation step (POST /chat/message with no conversationId
    // in the body creates one server-side) rather than inventing an id the
    // real request path would never actually produce.
    const conversationIdX = cryptoRandom();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO conversations (id, userId, agentId, title, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
      .run(conversationIdX, userId, agentId, "Test conversation", now, now);

    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }], posts: [CREATIVE_TEST_POST_WITH_ENGAGEMENT] },
      chatResponses: [toolCall("meta_expert_v2.build_strategy", baseStrategy()), finalText("Here is your recommended strategy.")],
    }));
    try {
      // Step 2: build_strategy succeeds, through the REAL chat call chain —
      // handleIncomingMessage(), the exact function routes/chat.js calls.
      const turn1 = await handleIncomingMessage({
        userId, agentId, conversationId: conversationIdX, content: "I want more sales on my website",
      });
      assert.ok(turn1.toolResults.some((r) => r.toolName === "meta_expert_v2.build_strategy" && r.result?.valid), `build_strategy must succeed: ${JSON.stringify(turn1.toolResults)}`);
    } finally {
      restoreFetch();
    }

    // Step 3: DB row exists with conversationId X and status 'proposed'.
    const stored = getActiveStrategyForConversation(userId, conversationIdX);
    assert.ok(stored, "a strategy row must exist for conversation X immediately after build_strategy succeeds");
    assert.equal(stored.conversationId, conversationIdX, "the stored row's conversationId must be EXACTLY X, not null/undefined/a different id");
    assert.equal(stored.status, "proposed");
    const recent = listRecentStrategiesForUser(userId, 10);
    assert.equal(recent[0].id, stored.id);
    assert.equal(recent[0].conversationId, conversationIdX);
    assert.equal(recent[0].status, "proposed");

    // Step 4: next user turn in the SAME chat (same conversationIdX, exactly
    // as the real chat client would send when correctly echoing it back)
    // asks to select creative.
    const userMessage = "Choose the exact best creative for this campaign from my recent Facebook/Instagram content and WooCommerce products.";
    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }], posts: [CREATIVE_TEST_POST_WITH_ENGAGEMENT] },
      chatResponses: [
        toolCall("meta_expert_v2.get_business_snapshot", {}),
        finalText("I selected the Vitamin C Serum post as the creative."), // live-bug shape: no revise_strategy
        toolCall("meta_expert_v2.revise_strategy", { requestedChanges: { creative_strategy: { source: "EXISTING_PAGE_POST", description: "Use the Vitamin C Serum post (480 likes, 52 comments, 30 shares)." } }, freshResearchRequired: false }),
        finalText("I've updated the creative to use your Vitamin C Serum post."),
      ],
    }));
    try {
      const turn2 = await handleIncomingMessage({ userId, agentId, conversationId: conversationIdX, content: userMessage });
      const toolNames = turn2.toolResults.map((r) => r.toolName);

      // Step 5: getActiveStrategyForConversation() found and used the SAME
      // strategy (not a different/duplicate one under a mismatched id).
      const reviseCall = turn2.toolResults.find((r) => r.toolName === "meta_expert_v2.revise_strategy");
      assert.ok(reviseCall, `revise_strategy must be called: ${JSON.stringify(toolNames)}`);
      assert.equal(reviseCall.result?.valid, true, JSON.stringify(reviseCall.result));
      // A revision always inserts a NEW row (see strategyStore.js's
      // insertStrategy comment: the prior row is marked 'superseded', never
      // updated in place) — so the meaningful check isn't "same id," it's
      // that this new row's revisionOf points back to the SAME strategy
      // found via conversationId X in step 5, and that prior row is now
      // superseded, never left dangling as still 'proposed'.
      const revisedStored = getStoredStrategy(userId, reviseCall.result?.strategyId);
      assert.equal(revisedStored?.revisionOf, stored.id, "the revision must be OF the same strategy found via conversationId X, not an unrelated one");
      assert.equal(getStoredStrategy(userId, stored.id)?.status, "superseded", "the original strategy must be marked superseded once revised, not left dangling as proposed");

      // Step 6: the required flow — snapshot, then revision, before final.
      assert.deepEqual(toolNames, ["meta_expert_v2.get_business_snapshot", "meta_expert_v2.revise_strategy"], `required flow is get_business_snapshot -> revise_strategy -> final: ${JSON.stringify(toolNames)}`);
    } finally {
      restoreFetch();
    }
  });

  // --- Chat route conversationId reuse (not a new id per turn) ------------
  // Directly tests the exact behavior requested: "whether the chat API is
  // generating a new conversationId between turns while the UI still
  // visually shows the same conversation." Two consecutive
  // handleIncomingMessage() calls with the SAME conversationId (as
  // routes/chat.js sends whenever the client includes conversationId in
  // the request body — see routes/chat.js's `let convId = conversationId`)
  // must both persist under, and both find data under, that identical id —
  // never silently split across two different conversationIds server-side.
  await check("[Strategy persistence] two consecutive chat turns with the SAME conversationId never get split across two different conversations server-side", async () => {
    const userId = makeUser(`v2-persistence-sameid-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = cryptoRandom();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO conversations (id, userId, agentId, title, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)")
      .run(conversationId, userId, agentId, "Test conversation", now, now);

    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [toolCall("meta_expert_v2.build_strategy", baseStrategy()), finalText("Here is your recommended strategy.")],
    }));
    try {
      await handleIncomingMessage({ userId, agentId, conversationId, content: "I want more sales on my website" });
    } finally {
      restoreFetch();
    }

    mockFetch(scriptedFetch({ chatResponses: [finalText("Sure, tell me more.")] }));
    try {
      await handleIncomingMessage({ userId, agentId, conversationId, content: "Ok, tell me more." });
    } finally {
      restoreFetch();
    }

    // Both turns' messages must be under the ONE conversation row — never
    // silently duplicated into a second conversations row for the "same"
    // chat, which is exactly what a client-side conversationId-loss bug
    // would produce server-side.
    const convRows = db.prepare("SELECT COUNT(*) as n FROM conversations WHERE userId = ?").get(userId);
    assert.equal(convRows.n, 1, "exactly one conversations row must exist for this user after two turns with the same conversationId");
    const msgRows = db.prepare("SELECT COUNT(*) as n FROM messages WHERE conversationId = ?").get(conversationId).n;
    assert.equal(msgRows, 4, "both turns (2 messages each: user + assistant) must be stored under the SAME conversationId");
    // The strategy built in turn 1 must still be findable by that SAME id.
    const stillActive = getActiveStrategyForConversation(userId, conversationId);
    assert.ok(stillActive, "the strategy built in turn 1 must remain findable under the same conversationId after a second, unrelated turn");
  });

  // --- approval_required omitted (live bug) --------------------------------
  // Live screenshot: the model's first build_strategy call omitted
  // approval_required (a plain required boolean, not a business decision) —
  // validateStrategyStructure hard-rejected the WHOLE strategy over it, the
  // per-turn single-call gate correctly blocked a second attempt, and the
  // customer was shown a confusing final message quoting the raw internal
  // field name back at them: "the field 'approval_required' is required.
  // Please confirm that you approve the recommended campaign strategy..."
  // — conflating a technical omission with the real approval flow.
  // deriveApprovalRequiredIfMissing (strategySchema.js) now defaults a
  // missing value to true (the conservative choice — see its comment for
  // why this can never weaken the real execution-approval gate), same
  // "mechanical fix before validation" principle as deriveCtaIfMissing.
  await check("[V2 policy] approval_required omitted entirely from the model's strategy is defaulted to true and accepted — never rejected, never surfaced as a confusing field-name message", async () => {
    const userId = makeUser(`v2-approval-required-missing-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const { approval_required, ...strategyWithoutApprovalRequired } = baseStrategy();
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyWithoutApprovalRequired, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.equal(result.strategy.approval_required, true, "a missing approval_required must default to true, not be left undefined");
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 policy, orchestrator-level] approval_required omitted from the model's FIRST build_strategy call succeeds immediately — no second call, no confusing field-name message reaches the user", async () => {
    const userId = makeUser(`v2-approval-required-missing-loop-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    const { approval_required, ...strategyWithoutApprovalRequired } = baseStrategy();
    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        toolCall("meta_expert_v2.build_strategy", strategyWithoutApprovalRequired),
        finalText("Here is your recommended strategy — let me know if you'd like any changes."),
      ],
    }));
    try {
      const userMessage = "I want more sales on my website";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const buildCalls = result.toolResults.filter((r) => r.toolName === "meta_expert_v2.build_strategy");
      assert.equal(buildCalls.length, 1, `omitting approval_required must never force a second attempt: ${JSON.stringify(buildCalls)}`);
      assert.equal(buildCalls[0].result.valid, true, JSON.stringify(buildCalls[0].result));
      assert.doesNotMatch(result.reply, /approval_required/i, "the raw internal field name must never reach the customer-facing reply");
    } finally {
      restoreFetch();
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
