# BILLING SYSTEM — Developer Documentation

Covers everything built across Phase 10: Subscription Plans, Usage Tracking,
Quotas, BYOK, Cost Engine, Coupons/Trials, Stripe, the Admin Panel, quota
warnings, and Credits. Written for whoever picks this codebase up next.

---

## 1. Architecture overview

Billing is **entirely organization-scoped**. This is the single most
important design decision in the whole system: a user account with no
organization has no subscription, no quotas, no usage tracking — personal/
individual use stays completely unmetered, exactly as it worked before
Phase 10 existed. Organizations are the billable unit.

Every organization has **exactly one subscription row** (`subscriptions`
table, `orgId UNIQUE`), created automatically the moment the org is created
(`billing.ensureSubscription`), always on the Free plan by default. There is
no "no subscription" state to special-case anywhere else in the codebase —
every quota check and billing read can assume a subscription exists.

Core modules (`server/orchestrator/`):

| Module | Responsibility |
|---|---|
| `billing.js` | Plans, subscriptions, usage recording, quota checks/enforcement, warning thresholds |
| `apiKeys.js` | BYOK — encrypted storage/retrieval of customer-provided AI provider keys |
| `costEngine.js` | Estimated $ costs from token usage, broken down by provider/agent/user/day |
| `coupons.js` | Coupon codes, redemption, trial expiry sweep |
| `stripeService.js` | Checkout, Customer Portal, webhook handling, Customer Balance (credits) |
| `platformAdmin.js` | Cross-org admin operations: plan management, manual trials, credits, billing logs |

Routes (`server/routes/`): `billing.js` (org-facing), `coupons.js` (redeem +
admin create), `platformAdmin.js` (admin-only), `orgIntegrations.js` (org-
level shared integrations, quota-checked), `stripeWebhook.js` (public,
signature-verified).

---

## 2. Subscription flow

```
Org created -> ensureSubscription() -> Free plan, status='active'
                                            |
                    Org owner picks a paid plan in Billing card
                                            |
                    POST /organizations/:id/billing/checkout
                                            |
                    stripeService.createCheckoutSession()
                    (creates a Stripe Customer if the org doesn't have one yet)
                                            |
                    Redirect to Stripe-hosted Checkout
                                            |
                    Customer pays -> Stripe fires webhook
                                            |
                    checkout.session.completed -> subscriptions row updated:
                    planId, status='active', stripeCustomerId, stripeSubscriptionId
```

**Important:** direct plan assignment (`POST /billing/plan`) is
**platform-admin only**. This was tightened once Stripe checkout existed —
letting an org owner set their own plan via that endpoint would be a free
self-upgrade bypassing payment entirely. Org owners always go through
Checkout/Portal now; direct assignment is for admin/support use (manual
trials, comping an account, etc.).

Upgrade/downgrade/cancel/resume all flow through Stripe, never a direct
local write to `planId` for a Stripe-backed subscription — the webhook is
the only writer of subscription state once a Stripe subscription exists.
Cancellation defaults to `cancel_at_period_end: true` (access continues
until the paid period ends); `resumeSubscription` undoes that flag.

---

## 3. Usage tracking

Two tables:
- `usage_records` — raw, one row per event. Source of truth, never
  aggregated away.
- `organization_usage` — a rollup keyed by `(orgId, period)` where
  `period` is `'YYYY-MM'`. This is what quota checks actually read, so a
  quota check never means scanning the full history.

`billing.recordUsage(orgId, type, quantity, metadata)` writes both in one
call. `type` is one of: `ai_request`, `prompt_tokens`, `completion_tokens`,
`automation_execution`, `tool_call`, `api_call`.

**Every AI call that should be metered goes through the same pattern**:
`enforceQuota()` before, `recordUsage()` after, with `metadata` including
`{ provider, agentId, userId, byok }`. This is wired into:
- `orchestrator/index.js` (`orchestrate()`) — the main chat/agent pipeline
- `automation/stepExecutor.js` (`ai_decision` step type)

If you add a new place that calls an AI provider directly, **it needs this
same wiring** or its usage/cost will be invisible to billing. This was a
real bug found during development — `ai_decision` steps originally called
`chatComplete` directly, completely bypassing quota and usage tracking.

---

## 4. Quota enforcement

`billing.checkQuota(orgId, quotaType)` returns:
```js
{ allowed, limit, current, remaining, percentUsed, warningLevel, isSoft }
```

Quota types: `maxUsers`, `maxAgents`, `maxAutomations`, `maxIntegrations`,
`maxAiRequests` — each maps to a column on `plans`. `limit === null` means
unlimited (Enterprise, or any plan with that field left NULL).

**Hard vs. soft** (`SOFT_QUOTA_TYPES` in `billing.js`): structural limits
(users/agents/automations/integrations) are hard — `enforceQuota` throws
`QUOTA_EXCEEDED` once the limit is hit, blocking creation. AI request
volume is soft — `enforceQuota` never throws for it; going over just means
`warningLevel` stays at 100 and a notification goes out. Hard-blocking a
chat mid-conversation over a request count was judged worse UX than
metered overage, which is how most real usage-based SaaS handles it.

**Warning thresholds** fire at 50/75/90/100% via `maybeWarnQuota`, deduped
per `(orgId, period, quotaType, threshold)` in `quota_warnings_sent` so a
usage jump from 40% to 95% only notifies once (the highest threshold
crossed), not four times.

To add a new quota type: add the column to `plans`, add a `getCurrent`
function to the `checks` map in `checkQuota`, decide hard or soft, call
`enforceQuota` at the relevant creation point.

---

## 5. BYOK (Bring Your Own Key)

`api_keys` table, one row per `(orgId, provider)`, AES-256-GCM encrypted
(`BYOK_ENCRYPTION_KEY` env var — any passphrase, hashed into a proper key
internally). `apiKeys.getDecryptedApiKey` is the **only** function that
ever returns a usable key; every route-facing list function returns a
masked hint only.

An org's `subscriptions.billingMode` is `'platform_managed'` (default) or
`'byok'`. When `'byok'`, `orchestrate()` resolves the org's own key for the
agent's configured provider and passes it to `chatComplete` as an
override — the platform's own env-var key is never touched for that call,
and the usage is tracked but **excluded** from the platform cost total
(the org is paying their own provider directly).

---

## 6. Cost Engine

`costEngine.getCostBreakdown(orgId, { sinceDays })` estimates $ cost from
`prompt_tokens`/`completion_tokens` usage records, using **representative
published per-provider rates** (`RATES_PER_MILLION_TOKENS`) — not exact
per-model billing, since there's no live pricing API integration. Always
labeled as an estimate wherever it's surfaced. BYOK usage is tracked
separately (`byokCostCents`) and excluded from the main total for the same
reason described above.

---

## 7. Stripe setup

1. **Secret key**: Dashboard -> Developers -> API keys -> copy the test-mode
   Secret key -> `STRIPE_SECRET_KEY` in `server/.env`.
2. **Products/Prices**: Dashboard -> Product catalog -> create one product
   per paid plan (Starter/Professional/Business), recurring monthly price.
   Copy each Price ID (`price_...`) into that plan's **Stripe Price ID**
   field in the Admin Panel — this is what makes a plan checkout-able
   (`plans.stripePriceId`).
3. **Webhook**: Dashboard -> Webhooks -> Add endpoint ->
   `<APP_BASE_URL>/api/stripe/webhook`, listening for:
   `checkout.session.completed`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`.
   Copy the signing secret -> `STRIPE_WEBHOOK_SECRET`.
4. **Enterprise/Free plans** intentionally have no Stripe Price ID —
   they're not checkout-able (Enterprise is "contact us", Free needs no
   payment).

### Webhook signature verification
`req.rawBody` is captured globally by the `express.json()` `verify` hook in
`index.js` — the same mechanism already used for WhatsApp/Shopify
webhooks. `stripeWebhook.js` is intentionally **not** behind `requireAuth`;
the signature (verified against `STRIPE_WEBHOOK_SECRET`) is the only
authentication, since Stripe calls this with no session.

### Testing locally
Use the Stripe CLI to forward webhooks to a local/Codespace URL during
development:
```
stripe listen --forward-to <APP_BASE_URL>/api/stripe/webhook
```

---

## 8. Invoices

`invoices` table is populated **only** by the `invoice.paid` webhook
handler — never written to by any user-facing action, since it mirrors
what Stripe says actually happened. `GET /organizations/:orgId/invoices`
returns the stored rows; for full invoice management (PDF download,
payment retry, etc.), the Stripe Customer Portal (`POST .../billing/portal`)
is the actual interface — this app doesn't reimplement that UI.

---

## 9. Credits

`organization_credits` is the local audit-trail ledger (source of truth,
works even without Stripe). `platformAdmin.grantCredit` also **best-effort**
applies the credit as a real **Stripe Customer Balance transaction**
(`stripeService.applyCustomerBalance` — negative amount = credit, per
Stripe's convention) so it genuinely reduces the org's next invoice, not
just a number sitting in this app's database. If Stripe isn't configured
or the call fails, the local ledger entry is still recorded and flagged
`stripeSynced: false` in the UI ("local only").

---

## 10. Coupons & Trials

Two coupon types: `trial` (grants a temporary plan + `trialEndsAt`,
applies immediately) and `percent_discount`/`fixed_discount` (validated
and recorded as redeemed, but the actual discount application is deferred
to the Stripe checkout flow — there's no real charge to discount until
that exists for a given org).

`coupons.sweepExpiredTrials()` runs hourly (same `setInterval` pattern as
the existing confirmation-expiry sweep in `index.js`), reverting expired
trials to Free and notifying the org owner.

---

## 11. Known limitations

- **Discount coupons** (percent/fixed) don't yet actually apply to a
  Stripe Checkout Session — the redemption is recorded, but wiring the
  discount into `createCheckoutSession` (via a Stripe Coupon/Promotion
  Code object) hasn't been built.
- **Feature Gating** (unlimited agents, marketplace publishing, voice AI,
  custom branding, etc.) was deliberately not built — those aren't real
  features on this platform yet, and gating something that doesn't exist
  would be a placeholder.
- **Stripe integration is untested against a live account** — written
  against the stable, well-documented Stripe Node SDK surface, but this
  sandbox couldn't install/run the `stripe` package to verify against a
  real API (same network restriction hit with other packages). Needs live
  testing with real test-mode keys.
- **Plans without a Stripe Price ID can't be checked out** — Free and
  Enterprise by design; any paid plan without one set will show "Not
  available" in the upgrade UI until an admin sets it.
