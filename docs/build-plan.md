# Autopilon — Meta Ads Agent Build Plan (Phase 1 → 4)

Written 2 Sep 2026, after Phase 1 shipped.

This is the working document for everything after Phase 1. It carries the
engineering rules learned the hard way during Phase 1, the open items still
outstanding, and the phase-by-phase plan.

**How to use it:** one section per Claude Code session. Never more. Every
session ends with a check on a real Meta account, not a passing test suite.

---

## 0. Where things actually stand (updated 3 Sep 2026)

**Phase 1 — done and verified in Ads Manager:** plain-language goal → business
snapshot → strategy → revision → one approval → real PAUSED campaign + ad set.
All three objectives work (Sales/Purchase, Traffic/Link Click,
Awareness/Reach). Budgets convert correctly to PKR minor units. ABO, not CBO.
Budget is asked for, never invented. Double approval creates no duplicate.

**Phase 2A — done.** Creative selection and attach. The agent lists real
products from the store with real IDs, takes the choice by number/name/ID,
uploads the product image, and creates a real PAUSED ad with headline from
`product.name`, body from the store's own description, and link from the real
permalink. Nothing model-authored.

**Also shipped 2–3 Sep:** deploy.sh now fails loudly instead of reporting
success on stale code; privacy policy and data-deletion pages live at
`/privacy` and `/data-deletion`; Meta app published (out of Development mode);
logo across the app; admin-created beta accounts; self-service delete-account.

**Untested:** every other store on earth. One account, one currency, one
country, one product category, women's beauty. That is the single biggest gap
between what exists and what can be sold.

---

## 0b. Open items as of 3 Sep 2026

Check each of these before starting new work.

| Item | Status |
|---|---|
| **Pixel default is wrong** — account default saved as `1299666955022281`; the working pixel that receives Purchase events is `1241102478031429`. Correct via `POST /api/integrations/meta/default-pixel` (browser console, validates against Meta before saving). | Do this first |
| **Pixel bug A** — the digit-run matcher used `.find()` with no ambiguity guard, so a message naming two pixel IDs silently saved whichever came first in Meta's response order. Fix mirrors the creative matcher's `if (matches.length > 1) return null`. | Fix built, verify deployed |
| **Pixel bug B** — more serious. The round-31 loop fix *removed* the `explicitAssetChanges` safety check instead of making the caller satisfy it, so a model-supplied pixel ID with no user confirmation could be written permanently to the account default. Fix restores the contract and has the pre-loop pass `explicitAssetChanges: ["pixel"]`. | Fix built, verify deployed |
| **Sweep for the same class of bug** — asked Claude Code to find any other place where a fix relaxed a check rather than making the caller comply, and any other candidate matcher without an ambiguity guard. | Results pending |
| **Delete the wrong-pixel campaigns** — every campaign built so far points at the wrong dataset. All paused, so no spend, but not worth keeping. | Outstanding |
| **DataDeletion page copy** — still says deletion is email-only; a self-service button now exists. Published page that Meta reads. | Outstanding |
| **Delete-account hardening** — `DELETE /api/auth/me` destroys an account irreversibly from one authenticated request. Before paying customers: re-auth on the request, soft-delete grace period, email confirmation (needs a mailer, which doesn't exist yet). | Before customers |
| **`consumerKey` encryption at rest** — WooCommerce `consumerKey` sits in plaintext in the `meta` JSON column while its partner `consumerSecret` is AES-256-GCM encrypted. Not an auth risk alone, but inconsistent. | Backlog |
| **Backup retention** — privacy policy states 30 days; nightly backups currently have no pruning. Add a 30-day cleanup so the statement is true. | Outstanding |
| **Terms of Service** — Meta App Settings had a placeholder pointing at facebook.com. Needs a real page. | Before App Review |
| **Meta Advanced Access / Tech Provider** — required before any customer's ad account works. Business verification plus App Review with screencasts. Long lead time. | Before launch |

**A pattern worth naming:** three times in two days, protective logic assumed a
case couldn't happen and was wrong — the pixel loop, the admin self-delete FK
gap, and pixel bug B. When a fix "explains away" a case as structurally
impossible, that's the place to look.

---

## 1. Engineering rules (earned in Phase 1 — apply to every phase)

These are not style preferences. Each one comes from a bug that cost hours.

**1.1 The model's promises are not enforcement.** Every time behaviour was
requested in a prompt, it eventually failed: the "$" currency symbol survived
repeated instruction, and the model claimed actions it never took. Anything that
must always happen goes in code — a validator, a gate, or a deterministic
substitution.

**1.2 Resolve ambiguous assets once, at account level.** The pixel question
broke five times across five layers because resolution state lived on a
per-strategy row and was re-derived through merge logic each turn. The fix was
to write the answer to the account defaults record. Any future
ask-the-user-then-store field — creative, catalog, audience — takes this shape
from day one, not after the fifth loop.

**1.3 Protective logic must distinguish "already resolved" from "never
resolved."** That single confusion produced both the budget and pixel classes of
bug. Review any new merge/carry-forward logic against it before shipping.

**1.4 A hard failure ends the turn.** Feeding a money-path error back to the
model produces improvisation, and improvisation produces a different wrong
answer every time. Short-circuit before the model sees it, and return a
structured, user-readable error.

**1.5 Validate combinations before calling Meta.** Four consecutive rounds were
spent discovering Meta's ad set rules one rejection at a time. The pre-flight
validator now catches objective/optimization/pixel mismatches. Extend it with
every new field rather than learning from rejections again.

**1.6 Log the actual payload on any path that spends money.** Three rounds of
guessing at the request body converged the moment the JSON was visible.

**1.7 Nothing is fixed until it runs in production.** Two full rounds were lost
to a stale image. After every deploy: confirm the commit and confirm
`StartedAt` is fresh. A green test suite says nothing about what is deployed.

**1.8 Verify before building.** Every Claude Code session starts with "verify
these claims against the live code; if any is wrong, stop and tell me." This
caught a completely wrong premise on the first session and has been worth it
every time since.

---

## 2. Open items from Phase 1

Not blockers, but each will bite eventually.

| Item | Why it matters |
|---|---|
| `deploy.sh` reports success without restarting | It pulls `:latest`, which only changes when the GHCR workflow runs. Should fail loudly when the running digest doesn't match the commit it claims to have deployed. |
| Which pixel is the account default | The created campaign used `1299666955022281`, not the one selected in chat. Confirm in Events Manager which dataset actually receives Purchase events, and correct the default if wrong. Wrong pixel = no conversion attribution. |
| `advantage_audience` missing on V1 and boost-post paths | Both go through the shared `meta.create_ad_set`, which never sets it. They will hit the same Meta rejection Phase 1 already fixed for campaign mode. |
| Orphaned campaigns on the ad account | ~23 campaigns against 9 ad sets, mostly debris from failed attempts. Delete manually; cleanup-on-failure is now in place for new ones. |
| Disk growth on the VPS | `local-*` images from every rebuild, plus nightly backups with no pruning. At 7% now. `docker image prune -a --filter "until=168h"` when needed — the `until` filter protects the rollback image. |
| Meta API version churn | v19 → v25 happened during Phase 1. Meta deprecates versions on a schedule; at subscription scale this is recurring maintenance, not a one-off. |

---

## 3. Track A — Multi-tenant robustness (runs alongside everything)

**This is not a phase. It is the precondition for charging money.** Every line
of Phase 1 was verified against one account.

What is unverified:

- **Currency** — every non-PKR account. Minor-unit offsets differ (JPY has none;
  KWD has three decimals). The code reads the offset from the account rather
  than hardcoding, which is right, but it has never run against anything else.
- **Country and language** — targeting, placements, and available objectives
  vary by market.
- **Store with no pixel** — Sales objective is impossible. Does the agent
  degrade gracefully to Traffic and explain why, or dead-end?
- **Service business with no products** — the snapshot leans on WooCommerce
  product data. What does it produce with none?
- **Men's or unisex products** — genders were inferred from the beauty product
  mix. Verify it isn't defaulting to women.
- **Account with multiple pages, or none** — page resolution has only ever seen
  one valid page.
- **Brand-new ad account with no history** — no past performance to reason from.
- **Shopify rather than WooCommerce** — a whole second store integration that
  the snapshot has never been exercised against.

**Recommended first move:** find one real store that isn't yours — different
category, different currency if possible — and run the full Phase 1 flow. A
friend's shop, a client, anything. One outside account will teach you more than
another week of testing BeautyBees.

**Also worth building here:** a per-customer spend guardrail. A maximum daily
budget the agent can ever propose, set per account, enforced in code. Today's
protection is that the customer reads the number. That is thin for a product
where a bug creates spend on someone else's account.

---

## 4. Phase 2A — Creative selection and attach

**This finishes Phase 1 in practice.** Until an ad exists, nothing delivers.

Scope: given an approved strategy and the customer's real content, pick a
creative and attach it. **No generation.** No competitor research. No scoring
models.

Steps:

1. **Creative inventory.** Read what actually exists: Facebook page posts,
   Instagram media, WooCommerce product images. Return a list with real IDs.
   Existing tools already reach IG media and page posts — reuse rather than
   rebuild.
2. **Candidate selection.** Present real options to the customer with enough
   context to choose. This is an ambiguous-asset flow — apply rule 1.2 from day
   one. If the account has an obvious default (one page, one product), don't ask.
3. **Format decision.** Single image, carousel, or existing-post boost. Carousel
   support already exists in `buildCarouselLinkData`. Boost-post already exists
   via `meta.boost_post`.
4. **Attach.** Create the ad creative and the ad, both PAUSED, under the
   existing ad set. Same approval gate. Same idempotency guarantee.
5. **Verify.** Read back the created ad and confirm it against the plan.

**The claim rule (rule 1.1 applies hard here):** the agent must never say a
creative is "best-performing" without measured data behind it. That cannot be a
prompt instruction — it failed for currency and it will fail here. Enforce it:
if no performance data is attached to the candidate, superlative claims are
blocked or substituted in code.

**Acceptance:** an unpausable-but-complete campaign — campaign, ad set, and ad —
created end to end from "I want more sales", with a real image from the
customer's own store, and verified in Ads Manager.

**Watch for:** image upload is a new failure surface (file size, aspect ratio,
hash handling). Meta rejects creatives for reasons unrelated to targeting. Expect
a short round of Meta rejections like the ad set rules — the pre-flight validator
should absorb them as they're learned.

---

## 5. Phase 2B — Creative generation

Only after 2A is solid.

Generate primary text, headlines, descriptions, and CTA. Build variants using
PAS / AIDA / problem-solution / offer-led framings. Produce a testing matrix.

Three things to get right:

- **Character limits per placement.** Meta truncates silently. Validate in code.
- **Claims and compliance.** Beauty and health products attract Meta ad policy
  rejections. Generated copy needs a policy check before submission, and
  rejection reasons need surfacing clearly to the customer.
- **Brief, not fabrication.** Where no usable content exists, the agent
  recommends a creative brief. It must never describe a post that doesn't exist —
  the false-completion class of bug, in a new place.

---

## 6. Phase 3A — Performance analysis (read-only)

**Strong argument for doing this before 2B.** It cannot spend money, cannot
create anything, and cannot break a customer's account. It is immediately
valuable to any customer already running ads — including ones who never use your
campaign builder. It is the lowest-risk, highest-leverage thing on this roadmap.

Read: spend, impressions, reach, CPM, CTR, CPC, landing page views, add to cart,
initiate checkout, purchases, CPA, ROAS, frequency, conversion rate.

Diagnose the patterns from your roadmap: high CPM → audience/auction/creative;
low CTR → hook; good CTR with poor conversion → landing page, offer, or tracking;
high frequency with falling CTR → fatigue; good CPA and ROAS → scale candidate.

Two rules:

- **Never diagnose without data.** If the campaign has 40 impressions, say the
  sample is too small. Confident diagnosis from noise is worse than silence.
- **Attach confidence to every diagnosis**, as your roadmap already specifies.
  Enforce it structurally so it can't be dropped.

**Acceptance:** ask "why is my campaign not getting sales?" against a real
campaign with real spend, and get an answer grounded in that account's numbers
that a media buyer would agree with.

---

## 7. Phase 3B / 3C — Recommend, then act on approval

3B: recommendations only — keep, pause, reduce, increase, test new creative,
broaden, narrow, duplicate winner, stop loser. Presented with reasoning and
confidence. No execution.

3C: the customer approves a specific recommendation and the agent executes it,
through the same approval gate and idempotency guarantees as campaign creation.

**Budget changes need their own guardrail**, separate from campaign creation:
a maximum percentage change, a maximum absolute daily spend, and a floor. In
code, per account. The model proposes; the backend bounds.

---

## 8. Phase 4 — Memory, monitoring, guardrailed automation

**4A — Measured memory.** Winning and losing audiences, age ranges, cities,
products, creatives, historical CPA and ROAS, budgets, seasonality. Your own
constraint is the important one: memory records *measured results*, never model
assumptions. Store it as data with the campaign IDs it came from, so any claim
can be traced back.

**4B — Monitoring.** Daily checks for spend without purchases, CPA
deterioration, creative fatigue, ROAS improvement, broken tracking. Note you
already have a worker container and redis — the scheduling infrastructure
exists.

**4C — Guardrailed automation.** Adviser / Approval / Managed modes, with
managed mode bounded by explicit limits (max 15% daily increase, hard ceiling,
never launch without approval, pause when spend exceeds 2× target CPA with zero
purchases).

**Before any of this ships:** an audit log the customer can read. Every
automated action, with timestamp, reason, and the data behind it. If your agent
changes someone's budget while they sleep, they need to see exactly what
happened and why. This is also your defence when a customer disputes a change.

---

## 9. Suggested sequencing (differs from the original roadmap)

```
Track A (multi-tenant robustness) ──────── continuous, alongside everything
        │
  2A creative selection + attach     ← finishes Phase 1 in practice
        │
  3A performance analysis            ← read-only, low risk, sellable alone
        │
  2B creative generation
        │
  3B recommendations
        │
  3C approved actions
        │
  4A measured memory
        │
  4B monitoring
        │
  4C guardrailed automation
```

The swap of 3A ahead of 2B is the main change. Analysis is read-only and
independently valuable; generation is riskier and slower.

---

## 10. Other options worth considering

**Sell 2A as the product.** "Describe your goal, get a correctly built, paused
campaign with your own product image, ready to review and launch." That is a
complete, honest product for a store owner who finds Ads Manager impenetrable.
It does not require Phase 3 or 4 to be worth paying for.

**Sell 3A separately.** "Connect your ad account, find out why your ads aren't
working." Different customer — someone already running ads — and no dependency
on your campaign builder.

**Creative brief instead of creative generation.** Between 2A and 2B, an agent
that says "here's the exact ad you should shoot: this product, this hook, this
format, this angle" is genuinely useful and carries none of the compliance risk
of generated copy.

**A test ad account.** Create a separate Meta ad account with a tiny lifetime
budget, purely for testing execution paths. Right now every test creates debris
on your real business account.

**Use Meta's own automation where it's better.** Advantage+ campaigns and
catalog ads do a lot of what Phase 4 aims at, natively. Positioning your agent
as the thing that configures and monitors them correctly may be more robust than
rebuilding the optimisation logic yourself.

**Don't ship customer-facing copy claiming more than the agent does.** "Creates
your campaign" is currently true only in a narrow sense. Once 2A lands it will
be true fully. Until then, describe it as building a campaign ready for review.

---

## 11. Working method for each session

The pattern that worked in Phase 1:

1. **One item per Claude Code session.** State explicitly what is out of scope.
2. **Verify before building.** "Verify these claims against the live code. If
   any is wrong, stop and tell me before writing anything."
3. **Deploy and confirm it's live.** Commit hash and fresh `StartedAt`.
4. **Test on a real account.** A passing suite is not evidence.
5. **Check Ads Manager**, not just the chat reply.
6. **Log the payload** for anything touching money.
7. **No relay through a second AI for implementation.** Scope and product
   thinking elsewhere is fine; specs come from whatever reads the repo.

One practical note: Phase 1 took two days of near-continuous work and the worst
hours were the ones spent debugging code that wasn't deployed. Fixing
`deploy.sh` to fail loudly is worth doing before the next phase starts — it will
save more time than any feature on this list.
