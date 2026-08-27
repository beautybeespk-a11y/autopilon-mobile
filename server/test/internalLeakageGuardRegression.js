// Confirmed live: a customer-facing reply displayed the raw
// "[Underlying tool data from this turn... do not repeat verbatim: ...]"
// history annotation (server/orchestrator/conversationService.js appends
// this so a follow-up can resolve real ids — it was never meant to reach
// the user). A prior fix added an instruction telling the model never to
// copy it forward; that instruction alone was NOT reliable enough — the
// same leak recurred. This suite tests the HARD backend boundary added on
// top of that instruction: orchestrator/index.js's exported
// INTERNAL_LEAK_PATTERNS, which every "final" model reply is checked
// against before ever being returned to a user (server/orchestrator/index.js's
// orchestrate() loop) — real production regex, not a reimplementation.
//
//   node test/internalLeakageGuardRegression.js
import assert from "node:assert/strict";

process.env.DB_PATH = process.env.DB_PATH || "/tmp/internal-leakage-guard-regression.sqlite";
process.env.BYOK_ENCRYPTION_KEY = process.env.BYOK_ENCRYPTION_KEY || "test-byok-encryption-key-for-leak-guard-test";

const { INTERNAL_LEAK_PATTERNS } = await import("../orchestrator/index.js");

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`FAIL  ${name} — ${err.message}`);
  }
}

// Every string explicitly named in the bug report as something that must
// never appear in a normal customer response.
const REQUIRED_TO_CATCH = [
  ["the exact leaked annotation, verbatim from the live bug", "Here are your ad accounts.\n\n[Underlying tool data from this turn, for your own reference in follow-ups — do not repeat verbatim: meta.list_ad_accounts returned: {...}]"],
  ["\"Underlying tool data\" alone", "Some text mentioning Underlying tool data in passing."],
  ["\"do not repeat verbatim\" alone", "A note that says do not repeat verbatim anywhere in a reply."],
  ["a bare planId token", "Your plan is ready — planId abc123, ready when you are."],
  ["planId inside JSON-shaped text", 'Result: {"planId":"pl_9f8e7d6c","valid":true}'],
  ["internal_plan token", "The internal_plan object has been stored."],
  ["raw tool_call JSON shape (toolName key)", '{"type":"tool_call","toolName":"meta_expert.execute_campaign_plan","parameters":{}}'],
  ["a raw resolved-id field name", 'resolvedAdAccountId is act_237956315579168'],
  // Round 3 (live testing): "Plan ID: pl_9f8e7d6c" appeared directly in a
  // customer-facing reply — formatRecommendation() never produces this, so
  // it was the model adding it on its own, caught by pattern rather than
  // trusted not to recur.
  ["the exact live-reported \"Plan ID:\" line", "Your campaign is ready. Plan ID: pl_9f8e7d6c\n\nApprove to proceed?"],
  ["\"plan_id:\" snake_case variant", "Reference: plan_id: pl_9f8e7d6c"],
  ["a bare conversationId token", "This is tied to conversationId conv_8f3e21 in our system."],
  ["a raw internal status word after 'status:'", "Current status: proposed — let me know if you'd like to proceed."],
  ["a raw internal status word after 'status:' (approved)", 'Debug: {"status":"approved"}'],
];

for (const [label, text] of REQUIRED_TO_CATCH) {
  check(`catches: ${label}`, () => {
    assert.equal(INTERNAL_LEAK_PATTERNS.test(text), true, `expected this to be flagged as a leak: ${JSON.stringify(text)}`);
  });
}

// A hard boundary that also fires on completely ordinary, correct
// recommendations would be worse than useless (constant unnecessary
// retries) — these must NOT match.
const MUST_NOT_FALSE_POSITIVE = [
  ["a normal full recommendation", "Based on your store, Meta account, and available business data, I recommend:\n\nGoal: Website Purchases\nAudience: Women 21–44\nLocations: Karachi, Lahore\nBudget: PKR 2,000/day\nStatus: Paused\n\nWhy:\nYour connected store sells physical products with real pricing, so optimizing for Purchase directly measures revenue rather than just clicks."],
  ["a plain Page list", "Here are your connected Facebook Pages: Beautybeespk, Careonabudget.pk, BeautyBees.pk"],
  ["budget approval question", "I recommend PKR 3,000/day as the initial test budget. Everything else is configured. Approve PKR 3,000/day or enter another budget?"],
  ["a sentence using the word 'plan' naturally", "I've built a plan for your Sales campaign and I'm ready when you approve it."],
  ["a sentence using the word 'internal' naturally, unrelated to a plan", "This budget is for internal testing purposes before scaling up."],
  ["the customer-facing 'Status: Paused' line the formatter actually produces", "Status: Paused (won't spend until you approve)"],
  ["a sentence naturally mentioning a campaign's approval status without the internal enum shape", "Your campaign was approved and is now live."],
];

for (const [label, text] of MUST_NOT_FALSE_POSITIVE) {
  check(`does NOT false-positive on: ${label}`, () => {
    assert.equal(INTERNAL_LEAK_PATTERNS.test(text), false, `expected this NOT to be flagged: ${JSON.stringify(text)}`);
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} internal-leakage guard checks passed.`);
if (failed.length) {
  console.log("\nFailed checks:");
  for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(1);
}
process.exit(0);
