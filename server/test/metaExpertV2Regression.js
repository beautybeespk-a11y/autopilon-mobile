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
const { saveConnection, updateConnectionMeta, getConnection } = await import("../integrations/manager.js");
const { gatherBusinessSnapshot } = await import("../agents/metaExpertV2/businessSnapshot.js");
const { buildStrategy, reviseStrategy } = await import("../agents/metaExpertV2/strategyBuilder.js");
const { executeStrategy } = await import("../agents/metaExpertV2/executor.js");
const { messageIndicatesExecutionApproval } = await import("../agents/metaExpertV2/policy.js");
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

function metaRouter({ adAccounts = [], pages = [], igByPageId = {}, pixels = [], catalogs = [], campaigns = [], posts = [], postsError = false, writes = [], writeError = null } = {}) {
  let nextId = 900000000000001n;
  return async (url, options = {}) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/v[\d.]+/, "");
    const method = options.method || "GET";
    if (method !== "GET") {
      const writeBody = options.body ? JSON.parse(options.body) : {};
      writes.push({ path, body: writeBody });
      // writeError simulates a real Meta API rejection (e.g. "(#100/
      // 3858558) budget too low") for ONE specific write path — every
      // other write still succeeds normally, matching a real partial
      // failure mid-execution (e.g. Campaign created fine, Ad Set
      // rejected). An optional failWhen(body) predicate scopes it further
      // (e.g. only when the submitted budget is actually below Meta's
      // real minimum) so a corrected retry against the SAME mock can
      // succeed naturally, exactly like the real API would.
      if (writeError && path.endsWith(writeError.pathSuffix) && (!writeError.failWhen || writeError.failWhen(writeBody))) {
        return jsonResponse({ error: writeError.error }, writeError.status || 400);
      }
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

  // --- Bare short approval replies (live bug, round 20) --------------------
  // Live screenshot: the model's own execute_strategy-blocked message
  // suggests exactly 'Please confirm your approval by stating "approve"
  // or "run it."' — the user (via a quick-reply chip or a terse natural
  // reply) sent just "run" (no "it"), which didn't match the "run it"
  // phrase, silently blocking a genuinely intended approval and leaving
  // the user stuck re-presented with the same recommendation.
  await check("[V2 policy] a bare 'run' (or 'yes'/'ok'/'okay'/'sure') as the ENTIRE message counts as approval — the model's own suggested short reply must actually work", () => {
    for (const reply of ["run", "Run", "run.", "run!", "yes", "ok", "okay", "sure"]) {
      assert.ok(messageIndicatesExecutionApproval(reply), `"${reply}" must be recognized as approval`);
    }
  });

  await check("[V2 policy] 'run' or 'yes' used naturally MID-SENTENCE (not as the whole reply) is never mistaken for approval", () => {
    for (const reply of ["how does this run", "yes it is", "yes, tell me more"]) {
      assert.equal(messageIndicatesExecutionApproval(reply), false, `"${reply}" must NOT be treated as approval`);
    }
  });

  await check("[V2 policy, orchestrator-level] checkV2ExecutionApprovalGate accepts a bare 'run' the same as 'run it'", async () => {
    const userId = makeUser(`v2-bare-run-approval-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true);
      const gate = checkV2ExecutionApprovalGate({ userId, conversationId, userMessage: "run" });
      assert.equal(gate, null, "a bare 'run' reply must pass the approval gate, matching the model's own suggested short phrasing");
    } finally {
      restoreFetch();
    }
  });

  // --- No-budget execution (live bug, round 16) ---------------------------
  // Live screenshot: the model presented a full recommendation with
  // "Budget: Not yet set — needs your input" (a legitimate state —
  // budget_daily is explicitly nullable at build time, "Null if a budget
  // policy/user input is still needed, never invent a number"). The user
  // then said "approved". checkV2ExecutionApprovalGate only checked for an
  // active strategy + approval language, so the call reached
  // executeStrategy() and then Meta's real Ad Set creation — which
  // requires an actual budget — and came back with a raw "(#100) Invalid
  // parameter" the user saw verbatim as "(Could not resolve: Invalid
  // parameter)". Fixed at both layers: the gate now blocks BEFORE the
  // tool is ever dispatched (same principle as every other check in this
  // gate), and executeStrategy() itself refuses defense-in-depth for any
  // other caller that might reach it directly.
  await check("[V2 budget gate] checkV2ExecutionApprovalGate blocks execute_strategy when the active strategy has no budget_daily set, even with explicit approval language", async () => {
    const userId = makeUser(`v2-budget-missing-gate-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const { budget_daily, ...strategyNoBudget } = baseStrategy();
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoBudget, userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
      assert.equal(built.strategy.budget_daily ?? null, null, "budget_daily must genuinely be unset for this test to be testing the real scenario");
      const gate = checkV2ExecutionApprovalGate({ userId, conversationId, userMessage: "approved" });
      assert.ok(gate, "must be blocked when the active strategy has no budget set, even with genuine approval language");
      assert.match(gate, /budget/i);
    } finally {
      restoreFetch();
    }
  });

  // Live bug (round 29): budget_daily missing was only ever discovered at
  // execute_strategy time — by then the user had already said "approve,"
  // and the model, blocked by the budget gate, ended up asking the user to
  // just repeat their approval, which can never fix a missing budget
  // (infinite loop). Budget is the ONE field only the user can actually
  // supply — it must be asked for once, up front, during build/revise,
  // exactly like the ambiguous-Pixel case already does for its own
  // genuinely-user-only decision.
  await check("[V2 policy] budget_daily left unset asks for it as a real unresolved_question at BUILD time — never silently presented as ready to approve", async () => {
    const userId = makeUser(`v2-budget-asked-at-build-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const { budget_daily, ...strategyNoBudget } = baseStrategy();
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoBudget, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.equal(result.strategy.budget_daily ?? null, null);
      assert.ok(result.strategy.unresolved_questions?.some((q) => /budget/i.test(q)), `a real budget question must be present: ${JSON.stringify(result.strategy.unresolved_questions)}`);
      assert.equal(result.strategy.approval_required, true, "must never be presented as ready to approve while budget is still missing");
      assert.match(result.recommendationText, /before i can build this, i need you to confirm/i, "the recommendation must lead with the open question, not 'approve this strategy'");
      assert.doesNotMatch(result.recommendationText, /approve this strategy or tell me/i, "must never ALSO say 'approve this' while a real question is still open");
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 budget gate, orchestrator-level] execute_strategy blocked for missing budget: the model's honest 'what's the budget' reply reaches the user as-is — never nudged into a retry loop, never told to just repeat approval", async () => {
    const userId = makeUser(`v2-budget-honest-reply-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    const { budget_daily, ...strategyNoBudget } = baseStrategy();
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    let built;
    try {
      built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoBudget, userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
    } finally {
      restoreFetch();
    }

    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        toolCall("meta_expert_v2.execute_strategy", {}), // blocked: no budget set
        // The model's own honest, correct reply — asks for the specific
        // missing fact, never claims execution, never asks for approval again.
        finalText("Before I can execute this, what daily budget would you like?"),
      ],
    }));
    try {
      const userMessage = "approve";
      const result = await orchestrate({
        userId, agentId, conversationId, userMessage,
        history: [{ role: "user", content: "I want more sales on my website" }, { role: "assistant", content: built.recommendationText }, { role: "user", content: userMessage }],
        agentSystemPrompt: "You are the Meta Ads Manager V2.",
      });
      // Reaching the model's SECOND scripted reply at all proves the honest
      // answer was accepted, not overridden by another forced nudge — the
      // mock throws on exhaustion if a third call were attempted.
      assert.match(result.reply, /what daily budget would you like/i, `the model's honest reply must reach the user unchanged: ${result.reply}`);
      assert.doesNotMatch(result.reply, /say ["“]approve["”]/i, "must never tell the user to just repeat their approval — that cannot fix a missing budget");
      const execCalls = result.toolResults.filter((r) => r.toolName === "meta_expert_v2.execute_strategy");
      assert.equal(execCalls.length, 1);
      assert.match(execCalls[0].error, /budget/i);
      const stored = getStoredStrategy(userId, built.strategyId);
      assert.notEqual(stored.status, "approved", "must never be marked approved/executed when nothing actually ran");
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 budget gate] executeStrategy() itself refuses to run (defense in depth) when budget_daily is missing, even if some other caller bypasses the orchestrator gate", async () => {
    const userId = makeUser(`v2-budget-missing-direct-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const { budget_daily, ...strategyNoBudget } = baseStrategy();
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoBudget, userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
      await assert.rejects(
        () => executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId }),
        (err) => err.code === "META_V2_BUDGET_MISSING"
      );
      const stored = getStoredStrategy(userId, built.strategyId);
      assert.equal(stored.status, "proposed", "a strategy blocked for missing budget must stay 'proposed', never falsely marked approved/executed");
    } finally {
      restoreFetch();
    }
  });

  // --- Budget still omitted, but the user JUST gave it (live bug, round 18) --
  // Live screenshots: after execute_strategy was correctly blocked for a
  // missing budget and the user was asked for one, the model's build_strategy/
  // revise_strategy call STILL omitted budget_daily even on the turn right
  // after the user replied "500/day" — over and over, re-asking the same
  // question the user had already answered. deriveBudgetFromUserMessageIfMissing
  // (strategySchema.js) now fills it in when the exact amount is extractable
  // from the user's own current message — never an invented number.
  await check("[V2 policy] budget_daily omitted from the model's call, but the user's CURRENT message contains a clear amount ('500/day') — filled in as USER_PROVIDED, never re-asked", async () => {
    const userId = makeUser(`v2-budget-from-message-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const { budget_daily, ...strategyNoBudget } = baseStrategy();
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoBudget, userMessage: "500/day" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.equal(result.strategy.budget_daily, 500, "the budget the user just typed must be used, not re-requested");
      assert.equal(result.strategy.budget_basis, "USER_PROVIDED");
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 policy] budget_daily omitted with NO extractable amount in the user's message ('approved') is left unset — never guesses a number", async () => {
    const userId = makeUser(`v2-budget-from-message-none-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const { budget_daily, ...strategyNoBudget } = baseStrategy();
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoBudget, userMessage: "approved" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.equal(result.strategy.budget_daily ?? null, null, "no number was ever given, so nothing must be invented");
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 policy, orchestrator-level] the full live loop: blocked for missing budget -> user replies '500/day' -> the model's next revise_strategy call STILL omits budget_daily -> filled in automatically -> the user is never re-asked, and the resulting strategy actually executes", async () => {
    const userId = makeUser(`v2-budget-from-message-loop-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    const { budget_daily, ...strategyNoBudget } = baseStrategy();
    mockFetch(scriptedFetch({
      chatResponses: [
        // First turn: builds a strategy with no budget set, exactly the
        // legitimate "budget policy/user input still needed" case, and
        // correctly asks the user for one instead of inventing a number.
        toolCall("meta_expert_v2.get_business_snapshot", {}),
        toolCall("meta_expert_v2.build_strategy", strategyNoBudget),
        finalText("Please provide a daily budget amount for the campaign so we can proceed with execution."),
      ],
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
    }));
    try {
      const firstMessage = "I want more sales on my website";
      await orchestrate({ userId, agentId, conversationId, userMessage: firstMessage, history: [{ role: "user", content: firstMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
    } finally {
      restoreFetch();
    }

    mockFetch(scriptedFetch({
      chatResponses: [
        // Live-bug shape: STILL omits budget_daily even though the user's
        // current message plainly states it — an empty requestedChanges
        // means the prior strategy's own (unset) budget_daily is simply
        // carried forward by mergeForRevision, reproducing the omission.
        toolCall("meta_expert_v2.revise_strategy", { requestedChanges: {} }),
        // A REAL revise_strategy call happened this turn, so this honest
        // "I've set the budget" claim is legitimate (see the round-17
        // execution-claim gate, which only blocks this phrasing when NO
        // matching tool call actually ran).
        finalText("I've set the daily budget to PKR 500/day — say \"approve\" when you'd like me to execute it."),
      ],
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
    }));
    let result;
    try {
      const userMessage = "500/day";
      result = await orchestrate({
        userId, agentId, conversationId, userMessage,
        history: [{ role: "user", content: "I want more sales on my website" }, { role: "assistant", content: "Please provide a daily budget amount for the campaign so we can proceed with execution." }, { role: "user", content: userMessage }],
        agentSystemPrompt: "You are the Meta Ads Manager V2.",
      });
    } finally {
      restoreFetch();
    }
    const reviseResult = result.toolResults.find((r) => r.toolName === "meta_expert_v2.revise_strategy")?.result;
    assert.equal(reviseResult?.valid, true, JSON.stringify(reviseResult));
    assert.doesNotMatch(result.reply, /provide a daily budget|budget you'd like/i, "must never re-ask for a budget the user already gave");
    assert.match(result.reply, /500/);

    // Prove it end to end: the derived budget must actually be usable for
    // a real execution, not just accepted by build/revise in isolation
    // (execute_strategy always requires a separate UI confirmation click
    // — requiresConfirmation: true — so it's exercised directly here,
    // same pattern as the round-17 budget-too-low recovery test).
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const active = getActiveStrategyForConversation(userId, conversationId);
      assert.equal(active?.strategy.budget_daily, 500);
      const executed = await executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: active.id });
      assert.equal(executed.status, "PAUSED");
    } finally {
      restoreFetch();
    }
  });

  // --- Meta rejects the real Ad Set for budget-too-low (live bug, round 17) --
  // Live screenshot: after the earlier budget-missing fix, an approved
  // strategy with a REAL (but too small) budget reached Meta's actual Ad
  // Set creation and was rejected: "(#100/3858558) To avoid zero results,
  // your budget must be at least PKR250.00." markStrategyFailed's normal
  // path would move the strategy out of EXECUTABLE_STATUSES entirely,
  // forcing the user through a full build_strategy from scratch just to
  // raise one number. For this specific, identifiable Meta rejection, the
  // strategy is kept 'proposed' instead so a plain "raise the budget"
  // reaches it through the normal revise_strategy path.
  await check("[V2 execution] Meta's real 'budget too low' rejection keeps the strategy revisable ('proposed'), not permanently 'failed' — a one-field fix shouldn't require rebuilding from scratch", async () => {
    const userId = makeUser(`v2-meta-budget-too-low-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({
      chatResponses: [],
      metaOpts: {
        adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }],
        // daily_budget arrives in Meta's real minor-unit convention now
        // (round 20 currency fix) — PKR250.00 is 25000 minor units (×100,
        // the default multiplier for a 2-decimal currency / no currency
        // on the mocked ad account).
        writeError: { pathSuffix: "/adsets", status: 400, error: { message: "Invalid parameter", code: 100, error_subcode: 3858558, error_user_msg: "To avoid zero results, your budget must be at least PKR250.00." }, failWhen: (body) => body.daily_budget < 25000 },
      },
    }));
    try {
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy({ budget_daily: 50 }), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));

      await assert.rejects(
        () => executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId }),
        (err) => /at least PKR250/.test(err.message) && err.code === 100 && err.subcode === 3858558
      );
      const stored = getStoredStrategy(userId, built.strategyId);
      assert.equal(stored.status, "proposed", "a budget-too-low rejection from Meta itself must leave the strategy revisable, not dead-ended as 'failed'");
      assert.equal(getActiveStrategyForConversation(userId, conversationId)?.id, built.strategyId, "the strategy must still be findable as the active one for a follow-up revise_strategy call");

      // The one-field fix actually works: revise_strategy finds it and a
      // corrected budget executes cleanly on the very next attempt.
      const revised = await reviseStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId, requestedChanges: { budget_daily: 500 }, userMessage: "raise the budget to PKR 500/day" });
      assert.equal(revised.ok, true, JSON.stringify(revised.unresolved));
      const executed = await executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: revised.strategyId });
      assert.equal(executed.status, "PAUSED");
    } finally {
      restoreFetch();
    }
  });

  // --- Broken bid strategies (live bug, round 22) --------------------------
  // Live screenshot: an approved strategy reached real execution and Meta
  // rejected the Ad Set creation outright: "(#100/1815857) Bid amount
  // required: you must provide a bid cap or target cost in bid_amount
  // field." Nothing in this schema/executor has ever had a bid_amount
  // field to populate — LOWEST_COST_WITH_BID_CAP and COST_CAP are
  // GUARANTEED to fail at execution 100% of the time, not a legitimate
  // choice. Every variant now normalizes to the one bid strategy that
  // actually works, and the schema's own enum no longer offers the
  // broken options to begin with.
  await check("[V2 policy] bid_strategy LOWEST_COST_WITH_BID_CAP/COST_CAP (guaranteed to fail — no bid_amount field exists anywhere) is always normalized to LOWEST_COST_WITHOUT_CAP", async () => {
    const userId = makeUser(`v2-bid-strategy-broken-${stamp}@example.com`);
    connectMeta(userId);
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      for (const brokenValue of ["LOWEST_COST_WITH_BID_CAP", "COST_CAP", "TARGET_COST"]) {
        const conversationId = `conv-${cryptoRandom()}`;
        const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy({ bid_strategy: brokenValue }), userMessage: "I want more sales on my website" });
        assert.equal(result.ok, true, JSON.stringify(result.unresolved));
        assert.equal(result.strategy.bid_strategy, "LOWEST_COST_WITHOUT_CAP", `"${brokenValue}" must be normalized to the only working bid strategy`);
      }
    } finally {
      restoreFetch();
    }
  });

  // --- Stale pre-fix stored strategy with the broken bid_strategy value (live bug, round 23) --
  // Live screenshot: the SAME "bid amount required" rejection recurred
  // even after the round-22 fix was deployed. Root cause: build/revise-
  // time normalization (above) only touches a strategy at the moment
  // it's built or revised — a strategy that was already sitting in
  // 'proposed' from BEFORE the fix shipped (a real scenario: the same
  // conversation gets reused across many testing rounds) keeps its stale
  // LOWEST_COST_WITH_BID_CAP value forever, since nothing re-touches an
  // already-stored row until its NEXT build/revise call. Simulated here
  // by inserting a strategy the way a pre-fix build_strategy call would
  // have (bypassing normalizeStrategyEnumAliases entirely, via a direct
  // DB write) and confirming executeStrategy() corrects it anyway.
  await check("[V2 execution] a stale strategy stored BEFORE the bid-strategy fix (raw DB row, normalization never applied) is still corrected at the actual execution call — defense in depth for rows that predate a fix", async () => {
    const userId = makeUser(`v2-stale-bid-strategy-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    const writes = [];
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }], writes } }));
    try {
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
      // Simulate a pre-fix stored row: overwrite the strategyJson directly,
      // the same shape normalizeStrategyEnumAliases would have produced
      // BEFORE round 22 — never going through the fixed normalization path.
      const staleStrategy = { ...built.strategy, bid_strategy: "LOWEST_COST_WITH_BID_CAP" };
      db.prepare("UPDATE meta_v2_strategies SET strategyJson = ? WHERE id = ?").run(JSON.stringify(staleStrategy), built.strategyId);

      const executed = await executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId });
      assert.equal(executed.status, "PAUSED");
      const adSetWrite = writes.find((w) => w.path.endsWith("/adsets"));
      assert.equal(adSetWrite?.body?.bid_strategy, "LOWEST_COST_WITHOUT_CAP", "a stale stored value must be corrected at the actual Meta write, not just at build/revise time");
    } finally {
      restoreFetch();
    }
  });

  // --- Missing "countries" derivable from locations (live bug, round 22) --
  // Live screenshot: a build_strategy/revise_strategy call was hard-
  // rejected with "Missing required field \"countries\"" even though
  // locations (e.g. "Pakistan") was present — countries (the real ISO
  // codes Meta targeting needs) was sometimes left off, especially right
  // after a wrong-tool recovery. Only fires when every location name maps
  // unambiguously to a known country — an unrecognized name (a city, an
  // unusual spelling) leaves the field alone and the honest rejection
  // stands, never a guess.
  await check("[V2 policy] countries omitted but locations present with a recognizable country name is derived automatically, never hard-rejected", async () => {
    const userId = makeUser(`v2-countries-from-locations-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const { countries, ...strategyNoCountries } = baseStrategy({ locations: ["Pakistan"] });
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoCountries, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.deepEqual(result.strategy.countries, ["PK"], "the real ISO code must be derived from the recognizable location name");
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 policy] countries omitted with an UNRECOGNIZED location name is left unset — never guesses, the honest rejection stands", async () => {
    const userId = makeUser(`v2-countries-unrecognized-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const { countries, ...strategyNoCountries } = baseStrategy({ locations: ["Karachi"] }); // a city, not a country
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoCountries, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, false, "an unrecognized location name must never be silently mapped to a guessed country code");
      assert.match(result.unresolved.issue, /countries/i);
    } finally {
      restoreFetch();
    }
  });

  // Live bug (round 25): a live build_strategy call was hard-rejected with
  // "Missing required field \"countries\"" even though the assistant's OWN
  // prior message had said "Location: Pakistan" — the exact-whole-string
  // match above missed it because the model this time wrote the location
  // with a qualifier around the country name, not the bare name alone.
  await check("[V2 policy] a location qualified with a city ('Karachi, Pakistan') still derives the country — the real country name just isn't the WHOLE string", async () => {
    const userId = makeUser(`v2-countries-city-qualified-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const { countries, ...strategyNoCountries } = baseStrategy({ locations: ["Karachi, Pakistan"] });
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoCountries, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.deepEqual(result.strategy.countries, ["PK"]);
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 policy] a location qualified with 'Nationwide' ('Pakistan (Nationwide)') still derives the country", async () => {
    const userId = makeUser(`v2-countries-nationwide-qualified-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const { countries, ...strategyNoCountries } = baseStrategy({ locations: ["Pakistan (Nationwide)"] });
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoCountries, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.deepEqual(result.strategy.countries, ["PK"]);
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 policy] a bare short abbreviation ('US') still resolves as an exact whole-string location", async () => {
    const userId = makeUser(`v2-countries-short-abbrev-exact-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const { countries, ...strategyNoCountries } = baseStrategy({ locations: ["US"] });
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoCountries, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.deepEqual(result.strategy.countries, ["US"]);
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 policy] a short abbreviation ('US') embedded inside a longer, non-exact location string is NOT matched as a substring — only exact whole-string, to avoid false positives (false-positive guard)", async () => {
    const userId = makeUser(`v2-countries-short-abbrev-guard-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const { countries, ...strategyNoCountries } = baseStrategy({ locations: ["Focus on the US market"] });
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoCountries, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, false, "a short abbreviation like 'US' must never be matched as a substring inside a longer free-text location — too easy to false-positive");
      assert.match(result.unresolved.issue, /countries/i);
    } finally {
      restoreFetch();
    }
  });

  // --- Missing "reasoning_summary" entirely (live bug, round 24) ----------
  // Live screenshot: build_strategy was hard-rejected with "Missing
  // required field \"reasoning_summary\"" — right after the model had
  // recovered from a wrong-tool attempt (execute_strategy called with no
  // active strategy yet, correctly falling back to build_strategy). Same
  // principle as repairSalesReasoningSummary above: reasoning_summary is a
  // templated restatement of already-decided facts, not a unique judgment
  // call, so a genuinely MISSING summary is just the most extreme case of
  // "wrong" — fixed the same mechanical way, before structural validation
  // ever sees it (never a second build_strategy call).
  await check("[V2 policy] reasoning_summary omitted entirely on an OUTCOME_SALES strategy is derived automatically (sales-framed), never hard-rejected", async () => {
    const userId = makeUser(`v2-reasoning-summary-missing-sales-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const { reasoning_summary, ...strategyNoSummary } = baseStrategy();
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoSummary, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.ok(result.strategy.reasoning_summary && result.strategy.reasoning_summary.trim(), "a real reasoning_summary must be derived, never left blank");
      assert.match(result.strategy.reasoning_summary, /\bpurchases?\b/i);
      assert.match(result.strategy.reasoning_summary, /\bcpa\b/i);
      assert.match(result.strategy.reasoning_summary, /\broas\b/i);
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 policy] reasoning_summary omitted entirely on a non-Sales explicit-action strategy falls back to a generic templated summary of the stated goal/evidence, never hard-rejected", async () => {
    const userId = makeUser(`v2-reasoning-summary-missing-explicit-${stamp}@example.com`);
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
        // reasoning_summary deliberately omitted — this is the exact live bug
        evidence_used: ["Most recent Facebook Page post"],
        assumptions: [],
        unresolved_questions: [],
        approval_required: true,
        facebook_page: { ref: "default_facebook_page" },
        ad_account: { ref: "default_ad_account" },
      };
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy, userMessage: "boost my latest Facebook post" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.ok(result.strategy.reasoning_summary && result.strategy.reasoning_summary.trim(), "a real reasoning_summary must be derived, never left blank");
      assert.match(result.strategy.reasoning_summary, /Most recent Facebook Page post/, "the derived fallback must incorporate the strategy's own evidence_used, not be generic boilerplate");
    } finally {
      restoreFetch();
    }
  });

  // --- Missing "evidence_used"/"assumptions" entirely (live bug, round 26) --
  // Live screenshot: build_strategy was hard-rejected with "Missing
  // required field \"evidence_used\"" — same wrong-tool-recovery pattern
  // as rounds 24/25 (execute_strategy blocked -> get_business_snapshot ->
  // build_strategy). Unlike other required fields, evidence_used's own
  // validation rule already accepts an empty array ("can be empty"), so a
  // MISSING value and an explicit [] mean the same thing structurally —
  // safe to default, never inventing evidence.
  await check("[V2 policy] evidence_used omitted entirely is defaulted to [] and accepted — never hard-rejected for a field whose own rule already allows empty", async () => {
    const userId = makeUser(`v2-evidence-used-missing-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const { evidence_used, ...strategyNoEvidence } = baseStrategy();
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoEvidence, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.deepEqual(result.strategy.evidence_used, []);
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 policy] assumptions omitted entirely is defaulted to [] and accepted — same 'array, can be empty' shape as evidence_used", async () => {
    const userId = makeUser(`v2-assumptions-missing-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const { assumptions, ...strategyNoAssumptions } = baseStrategy();
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoAssumptions, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.deepEqual(result.strategy.assumptions, []);
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 policy] a genuinely provided (non-empty) evidence_used is never overwritten by the missing-field default", async () => {
    const userId = makeUser(`v2-evidence-used-provided-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const strategy = baseStrategy({ evidence_used: ["WooCommerce: Skincare category, sample product PKR 1,800"] });
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.deepEqual(result.strategy.evidence_used, ["WooCommerce: Skincare category, sample product PKR 1,800"]);
    } finally {
      restoreFetch();
    }
  });

  // --- Currency minor-unit conversion (live bug, round 20) ----------------
  // Live screenshot: a PKR account, budget_daily 500 (the user's own
  // words, "500/day" — 500 whole Rupees), and Meta's real Ad Set creation
  // STILL rejected it as too low: "(#100/3858558) ... your budget must be
  // at least PKR250.00" — 500 > 250, which made no sense until traced to
  // the real cause: Meta's API requires daily_budget in the account's
  // currency's SMALLEST unit (100 = 1.00 for a standard 2-decimal
  // currency), and nothing in this codebase ever did that conversion —
  // the raw "500" was sent as 500 minor units (5.00 PKR), nowhere near a
  // real minimum. budget_daily is set/compared everywhere else in MAJOR
  // units (matching the user's own wording and the MAX_*_DAILY_BUDGET
  // config defaults) — the conversion happens ONLY at the literal Meta
  // API call, in executeCampaignMode.
  await check("[V2 execution] budget_daily (major units, e.g. 500 whole Rupees) is converted to Meta's real minor-unit convention (50000) for a standard 2-decimal currency before the actual Ad Set creation call", async () => {
    const userId = makeUser(`v2-currency-minor-units-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    const writes = [];
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "PKR" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }], writes } }));
    try {
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy({ budget_daily: 500 }), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
      const executed = await executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId });
      assert.equal(executed.status, "PAUSED");
      const campaignWrite = writes.find((w) => w.path.endsWith("/campaigns"));
      const adSetWrite = writes.find((w) => w.path.endsWith("/adsets"));
      // Round 31: the campaign write must NOT carry its own daily_budget —
      // see executeCampaignMode's round-31 comment. Budget lives only on
      // the ad set (ABO), never duplicated onto the campaign (CBO), so
      // there's only ONE minor-unit value in this whole request, and it's
      // on the ad set.
      assert.equal(campaignWrite?.body?.daily_budget, undefined, "the campaign write must never carry its own daily_budget — that's what silently turns on Campaign Budget Optimization and strands the ad set's bid_strategy");
      assert.equal(adSetWrite?.body?.daily_budget, 50000, "the real Meta ad set write must carry the minor-unit value (500 PKR x 100), never the raw major-unit number");
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 execution] a zero-decimal currency (e.g. JPY) is sent UNCHANGED — no x100 conversion for a currency with no minor unit", async () => {
    const userId = makeUser(`v2-currency-zero-decimal-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    const writes = [];
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "JPY" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }], writes } }));
    try {
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy({ budget_daily: 3000 }), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
      const executed = await executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId });
      assert.equal(executed.status, "PAUSED");
      const adSetWrite = writes.find((w) => w.path.endsWith("/adsets"));
      assert.equal(adSetWrite?.body?.daily_budget, 3000, "a zero-decimal currency (no minor unit) must be sent as-is, not multiplied");
    } finally {
      restoreFetch();
    }
  });

  // --- Bid strategy / bid_amount (live bug, round 31) ----------------------
  // Live error, AFTER approval/budget/Pixel all worked and the request
  // actually reached Meta: "Bid amount required: you must provide a bid
  // cap or target cost in bid_amount field. For LOWEST_COST_WITH_BID_CAP
  // you must provide bid_amount... For TARGET_COST you must provide
  // bid_amount... (Meta error 100/1815857)" — even though the ad set's own
  // bid_strategy was always LOWEST_COST_WITHOUT_CAP (needs no bid_amount).
  // Root cause: the campaign ALSO carried its own daily_budget, silently
  // enabling Campaign Budget Optimization — under CBO, Meta reads
  // bid_strategy from the CAMPAIGN, not the ad set, and this campaign never
  // set one, so Meta fell back to a capped default with no bid_amount
  // behind it. This test guards both halves of the fix directly: the ad
  // set's bid_strategy is the real, never-invented LOWEST_COST_WITHOUT_CAP,
  // and the campaign carries no daily_budget of its own (so CBO can never
  // turn on and strand it again).
  await check("[V2 execution] the ad set's bid_strategy is LOWEST_COST_WITHOUT_CAP (no bid_amount invented) and the campaign never carries its own daily_budget (no CBO to strand it)", async () => {
    const userId = makeUser(`v2-bid-strategy-abo-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    const writes = [];
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "PKR" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }], writes } }));
    try {
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy({ budget_daily: 500 }), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
      const executed = await executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId });
      assert.equal(executed.status, "PAUSED");
      const campaignWrite = writes.find((w) => w.path.endsWith("/campaigns"));
      const adSetWrite = writes.find((w) => w.path.endsWith("/adsets"));
      assert.equal(campaignWrite?.body?.daily_budget, undefined, "the campaign must never carry its own daily_budget — that's what enables CBO and strands the ad set's bid_strategy");
      // Round 31, second recurrence: with CBO genuinely off, Meta requires
      // is_adset_budget_sharing_enabled to be explicitly declared (Meta
      // error 100/4834011 otherwise) — false, so each ad set's approved
      // budget is never silently reallocated by Meta's own 20% sharing.
      assert.equal(campaignWrite?.body?.is_adset_budget_sharing_enabled, false, `the campaign must explicitly declare budget sharing off: ${JSON.stringify(campaignWrite?.body)}`);
      assert.equal(adSetWrite?.body?.bid_strategy, "LOWEST_COST_WITHOUT_CAP", `the ad set must send the real, uncapped bid strategy that needs no bid_amount: ${JSON.stringify(adSetWrite?.body)}`);
      assert.equal(adSetWrite?.body?.bid_amount, undefined, "no bid_amount must ever be invented — LOWEST_COST_WITHOUT_CAP needs none");
      // Round 31, fourth recurrence: Meta requires targeting_automation.
      // advantage_audience explicitly 0 or 1 (error 100/1870227) — always
      // 0 here, since the strategy's own explicit audience (gender/age/
      // countries) must be what actually runs, never silently expanded by
      // Meta's own "Advantage audience" delivery feature.
      assert.equal(adSetWrite?.body?.targeting?.targeting_automation?.advantage_audience, 0, `advantage_audience must be explicitly 0 — the approved audience must never be silently expanded: ${JSON.stringify(adSetWrite?.body?.targeting)}`);
    } finally {
      restoreFetch();
    }
  });

  // --- Orphaned campaign cleanup (live gap, round 31) ----------------------
  // Live report: on the exact bid_amount rejection above (Meta error
  // 100/1815857), the campaign IS created successfully — the error is on
  // the ad set POST only, no campaign-level error at all. Nothing
  // previously cleaned that campaign up on a subsequent failure, so every
  // failed execute_strategy attempt (and this bug fired on every live
  // attempt during this debugging session) left a real, empty, PAUSED
  // campaign behind on the actual ad account. This test guards the fix:
  // on an ad set creation failure, the just-created campaign is deleted
  // before the original error is rethrown.
  await check("[V2 execution] a failed ad set creation deletes the just-created campaign instead of leaving it orphaned on the real ad account", async () => {
    const userId = makeUser(`v2-orphan-cleanup-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    const writes = [];
    mockFetch(scriptedFetch({
      chatResponses: [],
      metaOpts: {
        adAccounts: [{ id: "act_1", name: "A", currency: "PKR" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }],
        writes,
        // The exact live shape: rejected on /adsets only, with no
        // campaign-level error — the campaign write above it must succeed.
        writeError: { pathSuffix: "/adsets", status: 400, error: { message: "Invalid parameter", code: 100, error_subcode: 1815857, error_user_title: "Bid Amount Required For The Bid Strategy Provided" } },
      },
    }));
    try {
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy({ budget_daily: 500 }), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
      await assert.rejects(
        () => executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId }),
        (err) => err.code === 100 && err.subcode === 1815857
      );
      const campaignWrite = writes.find((w) => w.path.endsWith("/campaigns"));
      assert.ok(campaignWrite, "the campaign must genuinely have been created — Meta only rejects at the ad set step in this scenario");
      const adSetWrite = writes.find((w) => w.path.endsWith("/adsets"));
      assert.ok(adSetWrite, "the ad set creation must have been attempted and rejected");
      const cleanupWrite = writes.find((w) => /^\/\d+$/.test(w.path) && w.body?.status === "DELETED");
      assert.ok(cleanupWrite, `the orphaned campaign must be deleted after the ad set creation fails, not left behind: ${JSON.stringify(writes)}`);
    } finally {
      restoreFetch();
    }
  });

  // --- Ambiguous Pixel reaching execution (live bug, round 31) ------------
  // Live report: Meta rejected the ad set with "You can't use the selected
  // performance goal with your campaign objective" (100/2490408) — traced
  // via the round-31 diagnostic logging to promoted_object.pixel_id: null.
  // Root cause: this ad account has 2+ Pixels with no saved default, so
  // build_strategy correctly stores unresolved_questions (asking which
  // Pixel to use) and leaves resolvedAssets.pixelId null — but nothing
  // previously stopped "approve" from reaching execute_strategy anyway.
  await check("[V2 execution] a genuinely unresolved question (ambiguous Pixel, pixelId left null) blocks execute_strategy even with explicit approval — both at the approval gate and as defense in depth in the executor itself", async () => {
    const userId = makeUser(`v2-unresolved-question-blocks-exec-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({
      chatResponses: [],
      metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "PKR" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel A" }, { id: "px2", name: "Pixel B" }] },
    }));
    try {
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy({ budget_daily: 500 }), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
      assert.equal(built.resolved.pixelId, null, "an ambiguous Pixel (2+, no default) must be left genuinely unresolved, never guessed");

      const gate = checkV2ExecutionApprovalGate({ userId, conversationId, userMessage: "approve it" });
      assert.ok(gate, "explicit approval must NOT be enough to execute while a real unresolved question is still open");
      assert.match(gate, /unresolved question/i);

      // Defense in depth — executeStrategy() itself, not just the
      // orchestrator gate (this function is also reachable directly).
      await assert.rejects(
        () => executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId }),
        (err) => err.code === "META_V2_UNRESOLVED_QUESTION"
      );
    } finally {
      restoreFetch();
    }
  });

  // --- Answering the ambiguous-Pixel question (live bug, round 31) --------
  // Live report: after the unresolved-question gate above correctly
  // blocked execution, the user answered "Pixel ID: 1241102478031429" —
  // revise_strategy ran and claimed the Pixel was updated, but the SAME
  // unresolved-question error kept recurring forever. Root cause: the
  // model's revise_strategy call supplied requestedChanges.pixel.ref but
  // never ALSO declared explicitAssetChanges: ["pixel"] — the ordinary
  // explicitAssetChanges gate (which exists to stop an ALREADY-resolved
  // asset from being silently reassigned, round 11) then ignored the id
  // entirely and re-resolved into the SAME ambiguity every time. This
  // test reproduces the exact call shape that caused the loop — a real
  // pixel ref with NO explicitAssetChanges — against a prior row whose
  // Pixel was never actually resolved (nothing for that gate to protect).
  await check("[V2 execution] answering an open ambiguous-Pixel question via revise_strategy (a real ref, with or without explicitAssetChanges) actually resolves the Pixel and clears the question — no infinite loop", async () => {
    const userId = makeUser(`v2-pixel-answer-persists-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({
      chatResponses: [],
      // Realistic Meta Pixel id shape (numeric) — matches the live report
      // ("Pixel ID: 1241102478031429") and resolvePixelId's own real
      // validation (isPlausiblePixelId requires a numeric-looking id).
      metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "PKR" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "1111111111111", name: "Pixel A" }, { id: "1241102478031429", name: "Pixel B" }] },
    }));
    try {
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy({ budget_daily: 500 }), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
      assert.equal(built.resolved.pixelId, null, "sanity: genuinely ambiguous going into the revision below");

      // The exact live shape: the model's answer, with NO explicitAssetChanges.
      const revised = await reviseStrategy({
        userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId,
        requestedChanges: { pixel: { ref: "1241102478031429" } },
        userMessage: "Pixel ID: 1241102478031429",
      });
      assert.equal(revised.ok, true, JSON.stringify(revised.unresolved));
      assert.equal(revised.resolved.pixelId, "1241102478031429", "the user's chosen Pixel must actually be resolved, not silently dropped for lack of explicitAssetChanges");
      assert.deepEqual(revised.strategy.unresolved_questions, [], "the Pixel question must be cleared now that it's genuinely resolved");

      // Design fix (round 31, per the user's own architectural review):
      // resolving a genuine ambiguity must be saved to the account-level
      // Default Pixel — the SAME record resolvePixelId already reads at
      // priority 2 — not just to this one strategy row.
      const savedDefaults = JSON.parse(getConnection(userId, "meta_ads").meta || "{}").defaults;
      assert.equal(savedDefaults?.pixelId, "1241102478031429", "the disambiguated Pixel must be saved as the account's Default Pixel, not just resolved for this one strategy");

      const gate = checkV2ExecutionApprovalGate({ userId, conversationId, userMessage: "approve it" });
      assert.equal(gate, null, "execution must now be allowed — the real question was actually answered");
      const executed = await executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: revised.strategyId });
      assert.equal(executed.status, "PAUSED");

      // The actual point of saving the default: a completely FRESH
      // strategy (new conversation, no priorResolved, no revision-carrying
      // machinery involved at all) must now resolve the SAME Pixel
      // automatically, with NO ambiguity and NO question — this is what
      // makes the bug class structurally impossible to hit a second time
      // for this ad account, rather than one more successful patch.
      const freshConversationId = `conv-${cryptoRandom()}`;
      const freshBuild = await buildStrategy({ userId, conversationId: freshConversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy({ budget_daily: 500 }), userMessage: "I want more sales on my website" });
      assert.equal(freshBuild.ok, true, JSON.stringify(freshBuild.unresolved));
      assert.equal(freshBuild.resolved.pixelId, "1241102478031429", "a brand-new strategy must auto-resolve the saved Default Pixel — never re-ask the same question for the same ad account");
      assert.deepEqual(freshBuild.strategy.unresolved_questions, [], "no ambiguity question at all — the account-level default already answers it");
    } finally {
      restoreFetch();
    }
  });

  // --- Pixel auto-revise when the model never calls any tool (round 31) --
  // Live report: the user supplied the exact Pixel id FOUR separate times
  // in one conversation and it was asked again every time — this trace
  // showed revise_strategy was NEVER dispatched at all; the model just
  // narrated and re-asked. Distinct from the merge-carry-forward bug fixed
  // earlier this round (there, revise_strategy at least fired) — this is
  // the SAME "model doesn't reliably call the tool for a plain-text
  // answer" class round 30 already found and fixed for budget. This test
  // reproduces the exact failure: the model's ONLY scripted response is a
  // narration with ZERO tool calls, yet the Pixel must still resolve for
  // real via the deterministic pre-loop auto-revise, which runs BEFORE
  // the model is ever asked for a decision.
  await check("[V2 execution] a Pixel id supplied in plain chat resolves via the deterministic auto-revise even when the model never calls revise_strategy at all — just narrates and would otherwise re-ask forever", async () => {
    const userId = makeUser(`v2-pixel-auto-revise-no-tool-call-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({
      chatResponses: [],
      metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "PKR" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "1111111111111", name: "Pixel A" }, { id: "1241102478031429", name: "Pixel B" }] },
    }));
    let built;
    try {
      built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy({ budget_daily: 500 }), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
      assert.equal(built.resolved.pixelId, null, "sanity: genuinely ambiguous going into the turn below");
    } finally {
      restoreFetch();
    }

    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "PKR" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "1111111111111", name: "Pixel A" }, { id: "1241102478031429", name: "Pixel B" }] },
      // Live-bug shape: the model just narrates, with ZERO tool calls —
      // exactly what the trace showed. Only ONE scripted response: if the
      // auto-revise didn't already resolve the Pixel before the model's
      // turn, this mock would need a second response it never gets.
      chatResponses: [finalText("Got it, I've noted Pixel ID 1241102478031429 — updating the strategy now.")],
    }));
    try {
      const userMessage = "Pixel ID: 1241102478031429";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const revise = result.toolResults.find((r) => r.toolName === "meta_expert_v2.revise_strategy");
      assert.ok(revise, `the auto-revise must dispatch a REAL revise_strategy call even though the model never called any tool itself: ${JSON.stringify(result.toolResults)}`);

      const active = getActiveStrategyForConversation(userId, conversationId);
      assert.equal(active?.resolvedAssets.pixelId, "1241102478031429", "the Pixel must actually be resolved in storage, not just narrated");

      const savedDefaults = JSON.parse(getConnection(userId, "meta_ads").meta || "{}").defaults;
      assert.equal(savedDefaults?.pixelId, "1241102478031429", "resolving via the auto-revise must also save the account-level Default Pixel, same as a model-initiated revision does");
    } finally {
      restoreFetch();
    }
  });

  // --- Objective/optimization_event/promoted_object validation (round 31) --
  // Explicit request: rather than fixing one Meta-rejected field per round,
  // validate the whole combination before sending and fail with a clear
  // message naming the bad pairing. This test constructs a strategy with a
  // genuinely mismatched pairing (nothing at build time currently checks
  // objective-vs-optimization_event consistency — only that a Traffic
  // objective isn't silently recommended for a clear e-commerce business)
  // and confirms execute_strategy refuses it with a clear, specific error
  // instead of ever reaching Meta with an invalid request.
  await check("[V2 execution] a mismatched objective/optimization_event pairing is refused with a clear, specific error before it ever reaches Meta", async () => {
    const userId = makeUser(`v2-invalid-field-combination-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "PKR" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      // OUTCOME_ENGAGEMENT paired with PURCHASE (an OFFSITE_CONVERSIONS-only
      // event, meaningless for an Engagement campaign) — Meta would reject
      // this exact combination the same way it rejected the live bug.
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy({ budget_daily: 500, recommended_objective: "OUTCOME_ENGAGEMENT" }), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
      await assert.rejects(
        () => executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId }),
        (err) => err.code === "META_V2_INVALID_FIELD_COMBINATION" && /OUTCOME_ENGAGEMENT/.test(err.message) && /PURCHASE/.test(err.message)
      );
    } finally {
      restoreFetch();
    }
  });

  // --- promoted_object.pixel_id validation, direct (round 31) -------------
  // Same validator, the OTHER half: a PURCHASE-optimized strategy that
  // somehow reaches execution with no resolved Pixel at all (defense in
  // depth for any path other than the ambiguous-Pixel one above) must
  // still be refused with a clear, specific error naming the real problem
  // (a missing Pixel), never a raw, confusing Meta rejection.
  await check("[V2 execution] a PURCHASE-optimized strategy with no resolved Pixel at all is refused with a clear error naming the missing Pixel", async () => {
    const userId = makeUser(`v2-missing-pixel-combination-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    // Zero Pixels connected — Acceptance H already covers the BUILD-time
    // hard rejection for this case; this test targets EXECUTE-time defense
    // in depth for a strategy that reached storage some other way (e.g. a
    // stale row from before this validator existed) with pixelId genuinely
    // null and a PURCHASE optimization_event still on it.
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "PKR" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy({ budget_daily: 500 }), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
      assert.ok(built.resolved.pixelId, "sanity: this strategy DOES have a real Pixel resolved going into the corruption below");
      // Simulate a stale/corrupted stored row (the class of scenario this
      // defense-in-depth check exists for) by clearing pixelId directly in
      // storage — never reachable through the normal build/revise path
      // while a real Pixel is connected. Same pattern as the stale
      // bid_strategy defense-in-depth test above; reads the CURRENT full
      // resolvedAssets first so adAccountName/adAccountCurrency/pageName
      // (never part of buildStrategy()'s own return value — see
      // assetResolution.js's separate `names` object) aren't dropped.
      const staleResolvedAssets = { ...getStoredStrategy(userId, built.strategyId).resolvedAssets, pixelId: null };
      db.prepare("UPDATE meta_v2_strategies SET resolvedAssetsJson = ? WHERE id = ?").run(JSON.stringify(staleResolvedAssets), built.strategyId);
      await assert.rejects(
        () => executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId }),
        (err) => err.code === "META_V2_INVALID_FIELD_COMBINATION" && /requires a real Meta Pixel/i.test(err.message)
      );
    } finally {
      restoreFetch();
    }
  });

  // --- Claimed execution without ever calling the tool (live bug, round 17) --
  // Live screenshot: execute_strategy was blocked for a missing budget,
  // the model correctly asked the user for one, the user replied "500/
  // day" — and the model's NEXT decision was "final" with the reply
  // "Executing the strategy with a daily budget of 500 PKR." Agent Trace
  // showed only Planning -> Completed, no tool ever called. Nothing was
  // actually revised or executed.
  await check("[V2 execution claim gate] a 'final' reply claiming the strategy is executing/updated with NO revise_strategy or execute_strategy call this turn is nudged into actually calling the tool, and finalizes honestly once it does", async () => {
    const userId = makeUser(`v2-execution-claim-nudge-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    let initial;
    try {
      const { budget_daily, ...strategyNoBudget } = baseStrategy();
      initial = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoBudget, userMessage: "I want more sales on my website" });
      assert.equal(initial.ok, true, JSON.stringify(initial.unresolved));
    } finally {
      restoreFetch();
    }

    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        // Live-bug shape: claims completion with zero tool calls this turn.
        finalText("Executing the strategy with a daily budget of 500 PKR."),
        toolCall("meta_expert_v2.revise_strategy", { requestedChanges: { budget_daily: 500 } }),
        // A REAL revise_strategy call happened this turn now — the exact
        // same "I've updated the budget" phrasing here must NOT be
        // blocked, since it's now an honest claim.
        finalText("I've updated the budget to PKR 500/day — say \"approve\" when you're ready to execute."),
      ],
    }));
    try {
      const userMessage = "500/day";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const toolNames = result.toolResults.map((r) => r.toolName);
      assert.ok(toolNames.includes("meta_expert_v2.revise_strategy"), `the nudge must force a real revise_strategy call: ${JSON.stringify(toolNames)}`);
      assert.doesNotMatch(result.reply, /^Executing the strategy with a daily budget of 500 PKR\.$/, "the unfulfilled claim must never be the final reply");
      assert.match(result.reply, /updated the budget/i);
      // revise_strategy always inserts a NEW row (never updates in place)
      // — the active strategy for this conversation is now the revision,
      // not initial.strategyId.
      const active = getActiveStrategyForConversation(userId, conversationId);
      assert.equal(active?.strategy.budget_daily, 500, "the budget must actually be revised in storage, not just narrated");
    } finally {
      restoreFetch();
    }
  });

  // Round 30 update: this scenario's userMessage ("500/day") is now ALSO
  // exactly what the new pre-loop auto-revise (see round 30's fix,
  // orchestrator/index.js) catches — the missing budget gets genuinely
  // saved via a REAL revise_strategy call before the model ever gets a
  // turn, so toolResults is no longer empty and budget_daily is no longer
  // left null. That's the correct, improved behavior (bug 2's fix). What
  // this test actually guards — a fabricated "the campaign is now
  // running"/"executing the strategy" claim must never reach the customer
  // when execute_strategy was never really called — is unrelated to the
  // budget being auto-saved and must still hold exactly as before.
  await check("[V2 execution claim gate] the SAME false claim repeated even after the nudge hard-stops with an honest fallback — never reaches the customer as a fabricated success", async () => {
    const userId = makeUser(`v2-execution-claim-hardstop-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    let initial;
    try {
      const { budget_daily, ...strategyNoBudget } = baseStrategy();
      initial = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoBudget, userMessage: "I want more sales on my website" });
      assert.equal(initial.ok, true, JSON.stringify(initial.unresolved));
    } finally {
      restoreFetch();
    }

    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        finalText("Executing the strategy with a daily budget of 500 PKR."),
        finalText("The campaign is now running with the updated budget."), // still no execute_strategy call after the nudge
      ],
    }));
    try {
      const userMessage = "500/day";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      assert.equal(result.toolResults.length, 1, `only the auto-revise (a REAL dispatch that genuinely saved the budget) should appear — never a fabricated execute_strategy: ${JSON.stringify(result.toolResults)}`);
      assert.equal(result.toolResults[0].toolName, "meta_expert_v2.revise_strategy");
      assert.doesNotMatch(result.reply, /is now running|executing the strategy/i, "the fabricated success claim must never reach the customer even after the nudge is exhausted");
      // A revision always inserts a NEW row (never updates in place) — the
      // original initial.strategyId row stays unchanged forever, so the
      // CURRENT active strategy must be looked up fresh, not by that id.
      const stored = getActiveStrategyForConversation(userId, conversationId);
      assert.equal(stored.strategy.budget_daily, 500, "the budget the user supplied must be genuinely saved by the auto-revise, even though execute_strategy was never really called");
    } finally {
      restoreFetch();
    }
  });

  // --- Currency hard guard (live bug, round 30, BUG 1) --------------------
  // Live report: user said "Rs 500" on a PKR ad account (act_237956315579168)
  // and the finalized strategy rendered "$500/day" — traced to currency
  // never being captured anywhere between meta.listAdAccounts()'s real
  // response and the strategy record (fixed by threading adAccountCurrency
  // through businessSnapshot.js -> assetResolution.js -> strategyBuilder.js's
  // stored resolvedAssets). This test guards the explicitly requested hard
  // guard itself (BUG 1, question 3): if the ad account's real currency has
  // drifted from what the strategy was built/revised against by the time
  // execute_strategy actually runs, refuse rather than risk spending the
  // wrong amount.
  await check("[V2 execution] executeStrategy() refuses to run when the strategy's built-for currency no longer matches the ad account's real currency at execution time", async () => {
    const userId = makeUser(`v2-currency-mismatch-guard-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "PKR" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    let built;
    try {
      built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy({ budget_daily: 500 }), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
    } finally {
      restoreFetch();
    }

    // Same ad account id/name, but its real currency has drifted to USD by
    // execution time (e.g. the billing currency was changed on Meta's side
    // between build and execution).
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "USD" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      await assert.rejects(
        () => executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: built.strategyId }),
        /built for a PKR ad account, but the ad account's real currency is now USD/i
      );
      const stored = getStoredStrategy(userId, built.strategyId);
      assert.notEqual(stored.status, "executed", "must never be marked executed when the currency guard refused to run");
    } finally {
      restoreFetch();
    }
  });

  // --- Budget auto-saved from chat, then genuinely executable (live bug, round 30, BUG 2) --
  // Live report: user supplied Rs.500 three separate times, the strategy
  // TEXT displayed it, but execute_strategy kept failing "no daily budget
  // set" — the model was narrating the update instead of ever calling
  // revise_strategy. Explicit fix request: "a user-supplied value is
  // written to the strategy via revise_strategy before any reply is
  // generated, and add a regression test: user supplies a budget in chat
  // -> revise_strategy is called with budget_daily -> execute_strategy no
  // longer reports a missing budget." This test is exactly that sequence,
  // end to end through the real orchestrator entry point.
  await check("[V2 execution] a budget supplied in plain chat is auto-saved via a REAL revise_strategy call before the model's reply, and execute_strategy no longer reports a missing budget", async () => {
    const userId = makeUser(`v2-budget-auto-revise-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "PKR" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    let initial;
    try {
      const { budget_daily, ...strategyNoBudget } = baseStrategy();
      initial = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyNoBudget, userMessage: "I want more sales on my website" });
      assert.equal(initial.ok, true, JSON.stringify(initial.unresolved));
    } finally {
      restoreFetch();
    }

    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "PKR" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [finalText('Got it — the daily budget is saved. Say "approve" when you\'re ready to execute.')],
    }));
    try {
      const userMessage = "Rs.500";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const revise = result.toolResults.find((r) => r.toolName === "meta_expert_v2.revise_strategy");
      assert.ok(revise, `a REAL revise_strategy call must be dispatched for the user-supplied budget, not just narrated: ${JSON.stringify(result.toolResults)}`);

      const active = getActiveStrategyForConversation(userId, conversationId);
      assert.equal(active?.strategy.budget_daily, 500, "the user-supplied budget must actually be saved to the strategy record");

      // execute_strategy must no longer report a missing budget now that
      // the auto-revise has genuinely saved it.
      const executed = await executeStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategyId: active.id });
      assert.equal(executed.status, "PAUSED", "execution must succeed now that a real budget is on record, not fail with 'no daily budget set'");
    } finally {
      restoreFetch();
    }
  });

  // --- Currency in the model's OWN reply text (live bug, round 31) --------
  // Live report: every strategy in this run rendered "$500"/"Daily Budget:
  // $500" on a real PKR account, even after round 30's fix made the
  // backend's OWN recommendationText correctly say "PKR 500/day" —
  // agentLibrary.js only ever told the model to present that text "in
  // plain language," which is an open invitation to paraphrase, and
  // paraphrasing silently reverted to "$". This test guards the nudge half
  // of the round-31 fix: a "$" reply on a known non-USD account is caught
  // and the model is asked to rewrite it — a genuinely corrected second
  // reply reaches the customer unchanged.
  await check("[V2 currency] the model's own final reply using '$' on a real PKR account is nudged into rewriting with the real currency", async () => {
    const userId = makeUser(`v2-currency-dollar-nudge-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "PKR" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy({ budget_daily: 500 }), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
    } finally {
      restoreFetch();
    }

    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "PKR" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        finalText("Here's your plan — Daily Budget: $500/day."),
        finalText("Here's your plan — Daily Budget: PKR 500/day."),
      ],
    }));
    try {
      const userMessage = "Can you recap the plan?";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      assert.doesNotMatch(result.reply, /\$\s?500/, "a dollar sign must never reach the customer on a real PKR account");
      assert.match(result.reply, /PKR 500/, "the genuinely corrected second reply must reach the customer unchanged");
    } finally {
      restoreFetch();
    }
  });

  // Same trigger, but the model repeats "$" even after the nudge — the
  // fail-safe deterministic substitution must still guarantee the customer
  // never sees a wrong currency symbol, since this is a real spend
  // decision, not prose the model gets to keep guessing at.
  await check("[V2 currency] a '$' reply repeated even after the nudge is deterministically corrected to the real currency, never left as '$'", async () => {
    const userId = makeUser(`v2-currency-dollar-hardstop-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "PKR" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy({ budget_daily: 500 }), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
    } finally {
      restoreFetch();
    }

    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A", currency: "PKR" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        finalText("Here's your plan — Daily Budget: $500/day."),
        finalText("Still $500/day, sorry for the confusion."),
      ],
    }));
    try {
      const userMessage = "Can you recap the plan?";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      assert.doesNotMatch(result.reply, /\$\s?500/, "a dollar sign must never reach the customer on a real PKR account, even after the nudge is exhausted");
      assert.match(result.reply, /PKR 500/, `the fail-safe substitution must still correct it deterministically: ${result.reply}`);
    } finally {
      restoreFetch();
    }
  });

  // --- "Approved" with the strategy never actually executed (live bug, round 19) --
  // Live screenshot: user said "approved" with an active strategy in
  // place. The model's reply: "Your campaign to increase website sales is
  // now set up and will be executed. I look forward to seeing the results
  // of this strategy... Thank you for your approval!" — Agent Trace
  // showed only Planning -> Completed, ZERO tool calls. Nothing was ever
  // created. The round-17 EXECUTION_CLAIM_WITHOUT_CALL_PATTERN didn't
  // catch this exact phrasing ("is now set up" — no "executing"/"running"/
  // "created" word) — this is the STRUCTURAL half of the fix: whenever
  // the user's own message contains genuine approval language and an
  // active strategy exists, execute_strategy must be ATTEMPTED this turn
  // regardless of what the final reply's wording happens to be.
  await check("[V2 execution claim gate] 'approved' with an active strategy but execute_strategy never attempted is nudged into actually calling it — regardless of the exact wording used to claim success", async () => {
    const userId = makeUser(`v2-approved-never-executed-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
    } finally {
      restoreFetch();
    }

    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        // Live-bug shape: wording the round-17 pattern doesn't match
        // ("is now set up" — not "executing"/"running"/"created"), with
        // zero tool calls this turn.
        finalText('Your campaign to increase website sales is now set up and will be executed. I look forward to seeing the results of this strategy. Thank you for your approval!'),
        toolCall("meta_expert_v2.execute_strategy", {}),
      ],
    }));
    try {
      const userMessage = "approved";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      assert.doesNotMatch(result.reply, /is now set up|thank you for your approval/i, "the fabricated success claim must never reach the customer");
      assert.equal(result.confirmation?.toolName, "meta_expert_v2.execute_strategy", "the nudge must force a REAL execute_strategy attempt, not just different wording of the same unfulfilled claim");
    } finally {
      restoreFetch();
    }
  });

  // --- "successfully executed" with an unrelated reply, no approval wording (live bug, round 21) --
  // Live screenshot: the prior turn asked the user to confirm the Pixel
  // AND said "I can proceed with executing the campaign" — the user
  // replied "yes use the same pixel" (answering the Pixel question, no
  // "approve"/"proceed"/"run it" language of its own). The model's reply:
  // "The campaign has been successfully executed with the selected Pixel
  // ending in 1429..." — Agent Trace: Planning -> Completed, zero tool
  // calls. Neither the structural approval check (userMessage doesn't
  // match approval language) nor the round-19 text pattern ("has been"
  // immediately followed by "executed" — broken by the inserted
  // "successfully") caught this. The loosened pattern (gap-tolerant +
  // "successfully executed" as its own catch-all) closes it.
  await check("[V2 execution claim gate] 'has been successfully executed' — an adverb inserted mid-phrase must still be caught, even when the user's own message has no approval wording of its own", async () => {
    const userId = makeUser(`v2-successfully-executed-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const built = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: baseStrategy(), userMessage: "I want more sales on my website" });
      assert.equal(built.ok, true, JSON.stringify(built.unresolved));
    } finally {
      restoreFetch();
    }

    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        finalText("The campaign has been successfully executed with the selected Pixel ending in 1429 for tracking purchases. Here's a summary of the campaign details: ..."),
        // Honest recovery — the user's message has no approval wording of
        // its own, so the correct next move is asking for it plainly, not
        // attempting execute_strategy (which checkV2ExecutionApprovalGate
        // would separately, correctly block).
        finalText('I still need your explicit approval — please say "approve" or "run it" before I can proceed.'),
      ],
    }));
    try {
      const userMessage = "yes use the same pixel";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      assert.doesNotMatch(result.reply, /successfully executed/i, "the fabricated success claim must never reach the customer");
      assert.match(result.reply, /explicit approval/i, "the nudge must force a genuinely reconsidered reply, not just a repeat of the fabricated claim");
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
  // Live bug (round 28): this test used to assert the second call was
  // BLOCKED as a duplicate — that was the bug itself (see the retry-cap
  // and self-correction tests above). Rewritten: two genuinely still-
  // incomplete attempts must BOTH be real dispatches (never silently
  // discarded), and the model is free to give up and ask the user
  // directly once it decides it can't self-correct further — the backend
  // never forces it to keep retrying past what its own retry budget
  // allows, but never blocks a genuine retry attempt either.
  await check("[V2 gate] build_strategy called twice in one turn, BOTH still genuinely incomplete — both are real dispatches, and the model can still finalize honestly afterward", async () => {
    const userId = makeUser(`v2-gate-build-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        toolCall("meta_expert_v2.build_strategy", {}), // deliberately incomplete — guaranteed structural rejection (valid:false)
        toolCall("meta_expert_v2.build_strategy", {}), // still incomplete — must be a REAL second attempt, not blocked
        finalText("I wasn't able to finalize a strategy — some required business details are still missing. Could you tell me more about your goal?"),
      ],
    }));
    try {
      const userMessage = "I want more sales to my website";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const buildCalls = result.toolResults.filter((r) => r.toolName === "meta_expert_v2.build_strategy");
      assert.equal(buildCalls.length, 2, `both attempts must be REAL dispatches — the second must never be blocked as a duplicate: ${JSON.stringify(buildCalls)}`);
      assert.equal(buildCalls[0].result.valid, false);
      assert.equal(buildCalls[1].result.valid, false, "a second still-incomplete attempt must still be a genuine (rejected) dispatch, not intercepted");
      assert.match(result.reply, /wasn't able to finalize/i);
    } finally {
      restoreFetch();
    }
  });

  // Live bug (round 28): a validation-rejected build_strategy call could
  // never be retried this turn at all — the per-turn gate blocked EVERY
  // repeat call regardless of whether the prior attempt succeeded or
  // failed, so the model could never self-correct a mechanical validation
  // slip (e.g. "locations must be a non-empty array"). Fixed: build_strategy/
  // revise_strategy now get up to MAX_V2_BUILD_ATTEMPTS (3) real dispatches
  // per turn as long as every attempt so far was a genuine validation
  // rejection — only a SUCCESSFUL call reverts to strict single-call
  // behavior (see the next test), and running out of the retry budget
  // still hard-stops cleanly rather than grinding toward the step limit.
  await check("[V2 gate] build_strategy REPEATEDLY FAILING validation gets real retries up to the cap, then hard-stops with a clean customer-safe reply — never grinds toward the step limit", async () => {
    const userId = makeUser(`v2-gate-build-retrycap-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        toolCall("meta_expert_v2.build_strategy", {}), // attempt 1/3 — real dispatch, fails (empty strategy)
        toolCall("meta_expert_v2.build_strategy", {}), // attempt 2/3 — real RETRY, fails again
        toolCall("meta_expert_v2.build_strategy", {}), // attempt 3/3 — real RETRY, fails again — budget now exhausted
        toolCall("meta_expert_v2.build_strategy", {}), // 4th attempt — blocked before ever reaching runTool()
      ],
    }));
    try {
      const userMessage = "I want more sales to my website";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const buildCalls = result.toolResults.filter((r) => r.toolName === "meta_expert_v2.build_strategy");
      assert.equal(buildCalls.length, 3, `exactly 3 real dispatches (the retry cap) must happen, no more: ${JSON.stringify(buildCalls)}`);
      assert.ok(buildCalls.every((c) => c.result?.valid === false), "every one of the 3 real attempts must be a genuine validation rejection");
      assert.match(result.reply, /wasn't able to finalize a strategy/i);
      assert.doesNotMatch(result.reply, /step limit/i, "the internal orchestration detail must never be shown to the user");
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 gate] a validation-rejected build_strategy call CAN be retried and succeed within the same turn — the model actually self-corrects", async () => {
    const userId = makeUser(`v2-gate-build-selfcorrect-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    const { locations, countries, ...strategyMissingLocations } = baseStrategy();
    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        toolCall("meta_expert_v2.build_strategy", strategyMissingLocations), // rejected: locations missing
        toolCall("meta_expert_v2.build_strategy", baseStrategy()), // genuine retry, corrected — must succeed
        finalText("Recommended strategy ready — want to proceed?"),
      ],
    }));
    try {
      const userMessage = "I want more sales to my website";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const buildCalls = result.toolResults.filter((r) => r.toolName === "meta_expert_v2.build_strategy");
      assert.equal(buildCalls.length, 2, `both attempts must be REAL dispatches — the second must never be blocked as a duplicate: ${JSON.stringify(buildCalls)}`);
      assert.equal(buildCalls[0].result.valid, false, "the first attempt must be a genuine rejection");
      assert.equal(buildCalls[1].result.valid, true, `the corrected retry must succeed: ${JSON.stringify(buildCalls[1])}`);
      assert.match(result.reply, /want to proceed/i, "the model's real final reply must be used, not a generic fallback");
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 gate] build_strategy succeeds, then a repeat call in the SAME turn is still blocked (single-call-after-success behavior is unchanged)", async () => {
    const userId = makeUser(`v2-gate-build-success-then-block-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        toolCall("meta_expert_v2.build_strategy", baseStrategy()), // succeeds
        toolCall("meta_expert_v2.build_strategy", baseStrategy()), // repeat after success — must be blocked (nudged), not re-dispatched
        finalText("Recommended strategy ready — want to proceed?"), // model's reply after being nudged
      ],
    }));
    try {
      const userMessage = "I want more sales to my website";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const buildCalls = result.toolResults.filter((r) => r.toolName === "meta_expert_v2.build_strategy");
      // The blocked repeat is still recorded in toolResults (as an error
      // entry, same pattern the pre-existing single-call gate uses) — it's
      // just never a real SECOND dispatch to the builder.
      assert.equal(buildCalls.length, 2, `expected one real dispatch + one blocked-duplicate entry: ${JSON.stringify(buildCalls)}`);
      assert.equal(buildCalls[0].result?.valid, true, "the first call must be the real, successful dispatch");
      assert.ok(buildCalls[1].error && /blocked duplicate call this turn/i.test(buildCalls[1].error), "the second call must be intercepted, never re-dispatched to the real builder");
      assert.match(result.reply, /want to proceed/i, "the model's real reply after the nudge must be used");
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

  // Live bug (round 28), same fix as build_strategy above: this used to
  // assert the second call was blocked as a duplicate — rewritten to
  // reflect that a genuine retry (even one that fails again, as this one
  // deliberately does by repeating the identical non-change) must be a
  // REAL dispatch, not silently intercepted.
  await check("[V2 gate] revise_strategy called twice in one turn for a rejected revision — both are real dispatches, and the model can still finalize honestly", async () => {
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
      assert.equal(reviseCalls.length, 2, `both attempts must be REAL dispatches — the second must never be blocked as a duplicate: ${JSON.stringify(reviseCalls)}`);
      assert.ok(reviseCalls[0].result);
      assert.equal(reviseCalls[0].result.valid, false);
      assert.ok(reviseCalls[1].result, "the second attempt must also be a real dispatch with its own result");
      assert.equal(reviseCalls[1].result.valid, false, "repeating the identical non-change must be rejected again for real, not intercepted");
      assert.match(result.reply, /wasn't able to make that revision/i);
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

  // --- facebook_page/ad_account omitted (live bug, same class as approval_required) --
  // Live screenshot: "It looks like there was an issue with building the
  // strategy for increasing sales due to a missing required field:
  // Facebook Page... Please ensure that your Facebook Page is integrated
  // and connected properly." A real Page WAS connected and resolvable
  // (confirmed via gatherBusinessSnapshot in production: defaultPage
  // resolution "saved_default", a real id) — the model's build_strategy
  // call had simply omitted the facebook_page field entirely, exactly the
  // same mechanical-omission class as the approval_required bug fixed
  // above. deriveDefaultAssetRefsIfMissing (strategySchema.js) now
  // defaults a missing facebook_page/ad_account to the semantic
  // "default_*" ref — the SAME ref value the model would have written
  // itself, going through the exact same resolution path either way.
  await check("[V2 policy] facebook_page and ad_account omitted entirely from the model's strategy are defaulted to the semantic default ref and accepted — never rejected as if the Page/account weren't connected", async () => {
    const userId = makeUser(`v2-assetref-missing-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const { facebook_page, ad_account, ...strategyWithoutAssetRefs } = baseStrategy();
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: strategyWithoutAssetRefs, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.equal(result.strategy.facebook_page.ref, "default_facebook_page");
      assert.equal(result.strategy.ad_account.ref, "default_ad_account");
      assert.equal(result.resolved.pageId, "111", "the real connected Page must still be resolved, exactly as if the model had written the default ref itself");
      assert.equal(result.resolved.adAccountId, "act_1");
    } finally {
      restoreFetch();
    }
  });

  await check("[V2 policy, orchestrator-level] facebook_page omitted from the model's FIRST build_strategy call succeeds immediately — no second call, never told the Page isn't connected when it is", async () => {
    const userId = makeUser(`v2-assetref-missing-loop-${stamp}@example.com`);
    connectMeta(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    const { facebook_page, ...strategyWithoutFacebookPage } = baseStrategy();
    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        toolCall("meta_expert_v2.build_strategy", strategyWithoutFacebookPage),
        finalText("Here is your recommended strategy — let me know if you'd like any changes."),
      ],
    }));
    try {
      const userMessage = "I want more sales on my website";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      const buildCalls = result.toolResults.filter((r) => r.toolName === "meta_expert_v2.build_strategy");
      assert.equal(buildCalls.length, 1, `omitting facebook_page must never force a second attempt: ${JSON.stringify(buildCalls)}`);
      assert.equal(buildCalls[0].result.valid, true, JSON.stringify(buildCalls[0].result));
      assert.doesNotMatch(result.reply, /facebook page is|please ensure/i, "must never claim the Page isn't connected when it is — the model just omitted the field");
    } finally {
      restoreFetch();
    }
  });

  // --- audience_reasoning omitted with NO real evidence to narrow by (live bug, round 15) --
  // Live screenshot sequence: build_strategy rejected repeatedly with "A
  // fully generic audience (all genders, 18-65) requires an explicit
  // audience_reasoning..." — even after strengthening the tool's field
  // description (an earlier fix this round) and an explicit user
  // instruction to use WooCommerce data. Root cause: build_strategy is a
  // single-attempt tool (Step 7) and the per-turn gate never lets a
  // corrected retry actually re-validate (see V2_SINGLE_CALL_TOOLS in
  // orchestrator/index.js) — a missed free-text field here has no second
  // chance. deriveAudienceReasoningIfMissing (strategySchema.js) closes
  // the ONE slice of this that's genuinely mechanical: when NO real store
  // or Meta account history data exists (businessSignals.
  // hasStrongerAudienceEvidence is false), "no narrower targeting
  // applies" isn't a business judgment call, it's an objective fact the
  // backend already verified — so it's safe to default, exactly like
  // approval_required/facebook_page/ad_account above.
  //
  // Round 28 follow-up: the OTHER branch this comment flags as unfixable
  // — real evidence DOES exist, so no safe mechanical default applies —
  // hit exactly this "no second chance" limitation live. Fixed at the
  // root: build_strategy/revise_strategy are no longer single-attempt
  // (see V2_RETRYABLE_BUILD_TOOLS in orchestrator/index.js) — a corrected
  // retry can now actually re-validate within the same turn.
  await check("[V2 policy] a fully generic audience (ALL, 18-65) with no audience_reasoning and NO real store/account data is auto-explained with an honest default and accepted — the model's one attempt is never spent on an unfixable-by-retry rejection", async () => {
    const userId = makeUser(`v2-audience-reasoning-noevidence-${stamp}@example.com`);
    connectMeta(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const genericStrategy = baseStrategy({ gender: "ALL", age_min: 18, age_max: 65, audience_strategy: "HEURISTIC" });
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: genericStrategy, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, true, JSON.stringify(result.unresolved));
      assert.ok(result.strategy.audience_reasoning && result.strategy.audience_reasoning.trim(), "a missing audience_reasoning must be defaulted, not left empty, when no evidence exists to narrow by");
      assert.match(result.strategy.audience_reasoning, /no connected store data|no.*(store|account).*(data|history)/i);
    } finally {
      restoreFetch();
    }
  });

  // Regression guard for the OTHER half of the same live sequence: this
  // user's WooCommerce store WAS connected (12 real products) — a genuine
  // audience_strategy=HEURISTIC/no-reasoning rejection with real store
  // data available must NOT be silently auto-filled; narrowing using that
  // real data is a genuine analysis step the model must still do.
  await check("[V2 policy] a fully generic audience (ALL, 18-65) with no audience_reasoning is still REJECTED when real store data exists to narrow it — never auto-filled away", async () => {
    const userId = makeUser(`v2-audience-reasoning-hasevidence-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const conversationId = `conv-${cryptoRandom()}`;
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] } }));
    try {
      const genericStrategy = baseStrategy({ gender: "ALL", age_min: 18, age_max: 65, audience_strategy: "HEURISTIC" });
      const result = await buildStrategy({ userId, conversationId, accessToken: `fake-meta-token-${userId}`, strategy: genericStrategy, userMessage: "I want more sales on my website" });
      assert.equal(result.ok, false, "a generic audience left unexplained must still be rejected when real store data exists to narrow it");
      assert.match(result.unresolved.issue, /audience/i);
    } finally {
      restoreFetch();
    }
  });

  // The same "no real evidence exists yet" fact must be surfaced directly
  // in get_business_snapshot's own result — the freshest, most salient
  // place for the model to read it, since the build_strategy tool
  // description alone already proved insufficient (see above).
  await check("[V2 policy] get_business_snapshot's audienceEvidenceHint reflects real store/account data when present, and the honest 'none yet' case when absent", async () => {
    const userIdNoEvidence = makeUser(`v2-hint-noevidence-${stamp}@example.com`);
    connectMeta(userIdNoEvidence);
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }] } }));
    try {
      const snapshot = await gatherBusinessSnapshot(userIdNoEvidence);
      assert.match(snapshot.audienceEvidenceHint, /no connected store data or meta campaign history/i);
    } finally {
      restoreFetch();
    }

    const userIdWithEvidence = makeUser(`v2-hint-hasevidence-${stamp}@example.com`);
    connectMeta(userIdWithEvidence);
    connectWooCommerce(userIdWithEvidence);
    mockFetch(scriptedFetch({ chatResponses: [], metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }] } }));
    try {
      const snapshot = await gatherBusinessSnapshot(userIdWithEvidence);
      assert.match(snapshot.audienceEvidenceHint, /real store and\/or meta account history data exists/i);
    } finally {
      restoreFetch();
    }
  });

  // --- Fabricated "success" out of a rejection's own text (live bug) ------
  // Live screenshot: build_strategy was genuinely REJECTED (no usable
  // existing Facebook/Instagram content — the honest checkCreativeSourceAvailabilityPolicy
  // rejection). The model then wrongly tried revise_strategy (nothing
  // exists yet), got correctly blocked; tried build_strategy again, got
  // correctly blocked by the per-turn gate (which quoted the rejection's
  // own guidance text back in its nudge); and on its NEXT "final" decision
  // dressed that guidance up as a complete, approvable strategy — "the
  // strategy remains paused until you approve it" — even though nothing
  // was ever saved. Every gate fired correctly; only the FINAL reply was
  // dishonest. The new backend-enforced check overrides any such reply
  // deterministically whenever it can prove nothing was actually saved.
  await check("[V2 honesty guard] a rejected build_strategy call can never be dressed up as a complete, approvable strategy in the final reply — the backend overrides it with an honest message when nothing was actually saved", async () => {
    const userId = makeUser(`v2-honesty-guard-${stamp}@example.com`);
    connectMeta(userId);
    connectWooCommerce(userId);
    const agentId = makeAgentWithSkills(userId, ["meta_expert_v2"]);
    const conversationId = `conv-${cryptoRandom()}`;
    // No Facebook posts mocked (empty), no Instagram connected — matches
    // the live scenario: no usable existing Meta content, so an
    // EXISTING_PAGE_POST claim is genuinely, honestly rejected.
    const strategyClaimingExistingPost = baseStrategy({
      creative_strategy: { source: "EXISTING_PAGE_POST", description: "Use your recent Facebook post about the product." },
    });
    mockFetch(scriptedFetch({
      metaOpts: { adAccounts: [{ id: "act_1", name: "A" }], pages: [{ id: "111", name: "P" }], pixels: [{ id: "px1", name: "Pixel" }] },
      chatResponses: [
        toolCall("meta_expert_v2.get_business_snapshot", {}),
        toolCall("meta_expert_v2.build_strategy", strategyClaimingExistingPost), // rejected — no usable existing content
        toolCall("meta_expert_v2.revise_strategy", {}), // wrong move — nothing exists yet to revise
        toolCall("meta_expert_v2.build_strategy", strategyClaimingExistingPost), // 2nd real attempt — blocked by the per-turn gate
        // Live-bug shape: fabricates a complete, approvable-sounding
        // strategy out of the rejection's own guidance text.
        finalText(
          "- **Objective**: Outcome Sales\n- **Creative Strategy**: New product-led creative based on WooCommerce relevance.\n\n" +
          "The strategy remains paused until you approve it. If you have any adjustments, please confirm."
        ),
      ],
    }));
    try {
      const userMessage = "I want more sales on my website";
      const result = await orchestrate({ userId, agentId, conversationId, userMessage, history: [{ role: "user", content: userMessage }], agentSystemPrompt: "You are the Meta Ads Manager V2." });
      assert.doesNotMatch(result.reply, /remains paused until you approve/i, "the fabricated fake-success reply must never reach the customer");
      assert.doesNotMatch(result.reply, /\*\*Objective\*\*/i, "no fabricated strategy-shaped content must reach the customer when nothing was actually saved");
      assert.match(result.reply, /wasn't able to finalize a strategy/i);
      const active = getActiveStrategyForConversation(userId, conversationId);
      assert.equal(active, null, "no strategy must exist for this conversation — the backend override only fires when it can PROVE nothing was saved");
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
