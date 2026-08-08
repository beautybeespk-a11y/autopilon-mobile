import Stripe from "stripe";
import db from "../db.js";
import { cryptoRandom } from "../middleware.js";
import { getPlan, ensureSubscription } from "./billing.js";
import { createNotification } from "./notifications.js";

let stripeClient = null;
function stripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    const err = new Error("Stripe is not configured — set STRIPE_SECRET_KEY in server/.env.");
    err.code = "STRIPE_NOT_CONFIGURED";
    throw err;
  }
  if (!stripeClient) stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  return stripeClient;
}

export function stripeStatus() {
  return { configured: Boolean(process.env.STRIPE_SECRET_KEY), webhookConfigured: Boolean(process.env.STRIPE_WEBHOOK_SECRET) };
}

// Every org gets at most one Stripe Customer, created lazily on first
// checkout and reused for every subsequent checkout/portal session.
async function getOrCreateStripeCustomer(orgId) {
  const sub = ensureSubscription(orgId);
  if (sub.stripeCustomerId) return sub.stripeCustomerId;

  const org = db.prepare("SELECT o.name, u.email FROM organizations o JOIN users u ON u.id = o.ownerId WHERE o.id = ?").get(orgId);
  const customer = await stripe().customers.create({ name: org.name, email: org.email, metadata: { orgId } });
  db.prepare("UPDATE subscriptions SET stripeCustomerId = ? WHERE orgId = ?").run(customer.id, orgId);
  return customer.id;
}

// A separate per-USER Stripe customer, for personal Marketplace purchases —
// distinct from the per-org one above, since an individual buying an asset
// isn't necessarily acting on behalf of any organization at all.
async function getOrCreateUserStripeCustomer(userId) {
  const user = db.prepare("SELECT stripeCustomerId, name, email FROM users WHERE id = ?").get(userId);
  if (user.stripeCustomerId) return user.stripeCustomerId;
  const customer = await stripe().customers.create({ name: user.name, email: user.email, metadata: { userId } });
  db.prepare("UPDATE users SET stripeCustomerId = ? WHERE id = ?").run(customer.id, userId);
  return customer.id;
}

// One-time asset purchase — priced dynamically (price_data) so a creator
// never has to create a Stripe Price object themselves, unlike plan
// checkout above which requires an admin-set stripePriceId.
export async function createAssetCheckoutSession(buyerUserId, asset, successUrl, cancelUrl) {
  const customerId = await getOrCreateUserStripeCustomer(buyerUserId);
  const session = await stripe().checkout.sessions.create({
    customer: customerId,
    mode: "payment",
    line_items: [{
      price_data: { currency: "usd", unit_amount: asset.priceCents, product_data: { name: asset.name, description: asset.description || undefined } },
      quantity: 1,
    }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { type: "asset_purchase", assetId: asset.id, buyerUserId, sellerUserId: asset.creatorUserId },
  });
  return session.url;
}

export async function createCheckoutSession(orgId, planId, successUrl, cancelUrl) {
  const plan = getPlan(planId);
  if (!plan) throw new Error(`Unknown plan "${planId}".`);
  if (!plan.stripePriceId) throw new Error(`The ${plan.name} plan isn't set up for checkout yet — an admin needs to set its Stripe Price ID first.`);

  const customerId = await getOrCreateStripeCustomer(orgId);
  const session = await stripe().checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: plan.stripePriceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { orgId, planId },
    subscription_data: { metadata: { orgId, planId } },
  });
  return session.url;
}

export async function createPortalSession(orgId, returnUrl) {
  const customerId = await getOrCreateStripeCustomer(orgId);
  const session = await stripe().billingPortal.sessions.create({ customer: customerId, return_url: returnUrl });
  return session.url;
}

// Cancellation goes through Stripe (source of truth for the actual
// subscription), not a direct DB write — the webhook (customer.subscription.updated,
// with cancel_at_period_end set) is what actually updates our local copy,
// consistent with "Stripe's webhooks are the only writer of subscription state."
// Uses Stripe's own Customer Balance feature — a credit here genuinely
// reduces what the org owes on its NEXT invoice, rather than being a number
// that only exists in our database and does nothing. Stripe's sign
// convention: a NEGATIVE amount is a credit (reduces what the customer
// owes); positive would be a charge. We always pass a credit here (negated
// from the positive cents the caller thinks of as "granting a credit").
export async function applyCustomerBalance(orgId, creditCents, description) {
  const customerId = await getOrCreateStripeCustomer(orgId);
  await stripe().customers.createBalanceTransaction(customerId, {
    amount: -Math.abs(creditCents),
    currency: "usd",
    description,
  });
}

export async function cancelSubscription(orgId, atPeriodEnd = true) {
  const sub = db.prepare("SELECT stripeSubscriptionId FROM subscriptions WHERE orgId = ?").get(orgId);
  if (!sub?.stripeSubscriptionId) throw new Error("This organization has no active Stripe subscription to cancel.");
  if (atPeriodEnd) {
    await stripe().subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
  } else {
    await stripe().subscriptions.cancel(sub.stripeSubscriptionId);
  }
  return { canceled: true, atPeriodEnd };
}

// Undoes a scheduled cancellation — only meaningful if the subscription is
// still active with cancel_at_period_end set (once Stripe actually ends it,
// there's nothing to resume; a new checkout is what's needed instead).
export async function resumeSubscription(orgId) {
  const sub = db.prepare("SELECT stripeSubscriptionId FROM subscriptions WHERE orgId = ?").get(orgId);
  if (!sub?.stripeSubscriptionId) throw new Error("This organization has no Stripe subscription to resume.");
  await stripe().subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: false });
  return { resumed: true };
}

export function verifyWebhookSignature(rawBody, signature) {
  if (!process.env.STRIPE_WEBHOOK_SECRET) {
    const err = new Error("STRIPE_WEBHOOK_SECRET is not set — cannot verify incoming Stripe webhooks.");
    err.code = "STRIPE_NOT_CONFIGURED";
    throw err;
  }
  return stripe().webhooks.constructEvent(rawBody, signature, process.env.STRIPE_WEBHOOK_SECRET);
}

function orgIdFromStripeObject(obj) {
  return obj.metadata?.orgId || null;
}

// Every branch here ends up writing to the SAME `subscriptions` table the
// rest of the billing system already uses — Stripe is just another trigger
// for the same state transitions an admin or a coupon can also cause, not a
// separate parallel system.
export async function handleWebhookEvent(event) {
  const now = new Date().toISOString();

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;

      if (session.metadata?.type === "asset_purchase") {
        const { assetId, buyerUserId, sellerUserId } = session.metadata;
        if (!assetId || !buyerUserId || !sellerUserId) break;
        const amountCents = session.amount_total || 0;
        const commissionPercent = Number(process.env.PLATFORM_COMMISSION_PERCENT || 20);
        const platformCommissionCents = Math.round((amountCents * commissionPercent) / 100);
        const sellerNetCents = amountCents - platformCommissionCents;
        db.prepare(
          `INSERT OR IGNORE INTO asset_purchases (id, assetId, buyerUserId, sellerUserId, amountCents, platformCommissionCents, sellerNetCents, stripeCheckoutSessionId, status, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?)`
        ).run(cryptoRandom(), assetId, buyerUserId, sellerUserId, amountCents, platformCommissionCents, sellerNetCents, session.id, now);
        const asset = db.prepare("SELECT name FROM marketplace_assets WHERE id = ?").get(assetId);
        createNotification(sellerUserId, {
          type: "asset_sold",
          title: `You sold "${asset?.name}"!`,
          body: `$${(sellerNetCents / 100).toFixed(2)} net (after platform commission).`,
          link: "/app/marketplace/creator-dashboard",
        });
        break;
      }

      const orgId = session.metadata?.orgId;
      const planId = session.metadata?.planId;
      if (!orgId || !planId) break;
      ensureSubscription(orgId);
      db.prepare(
        "UPDATE subscriptions SET planId = ?, status = 'active', stripeCustomerId = ?, stripeSubscriptionId = ?, cancelAtPeriodEnd = 0, updatedAt = ? WHERE orgId = ?"
      ).run(planId, session.customer, session.subscription, now, orgId);
      const org = db.prepare("SELECT ownerId, name FROM organizations WHERE id = ?").get(orgId);
      if (org) createNotification(org.ownerId, { type: "subscription_renewed", title: `Subscription started for "${org.name}"`, body: `You're now on the ${planId} plan.`, link: `/app/organizations/${orgId}` });
      break;
    }

    case "customer.subscription.updated": {
      const subObj = event.data.object;
      const orgId = orgIdFromStripeObject(subObj);
      if (!orgId) break;
      const status = subObj.status === "past_due" ? "past_due" : subObj.status === "trialing" ? "trialing" : "active";
      db.prepare(
        `UPDATE subscriptions SET status = ?, cancelAtPeriodEnd = ?, currentPeriodStart = ?, currentPeriodEnd = ?, updatedAt = ?
         WHERE stripeSubscriptionId = ?`
      ).run(
        status, subObj.cancel_at_period_end ? 1 : 0,
        new Date(subObj.current_period_start * 1000).toISOString(),
        new Date(subObj.current_period_end * 1000).toISOString(),
        now, subObj.id
      );
      if (status === "past_due") {
        const org = db.prepare("SELECT ownerId, name FROM organizations WHERE id = ?").get(orgId);
        if (org) createNotification(org.ownerId, { type: "payment_failed", title: `Payment issue on "${org.name}"`, body: "Stripe couldn't process your latest payment — please update your payment method.", link: `/app/organizations/${orgId}` });
      }
      break;
    }

    case "customer.subscription.deleted": {
      const subObj = event.data.object;
      const orgId = orgIdFromStripeObject(subObj);
      if (!orgId) break;
      // Subscription is genuinely gone on Stripe's side — revert to Free
      // rather than leaving the org stuck on a plan nothing is paying for.
      db.prepare("UPDATE subscriptions SET planId = 'free', status = 'active', stripeSubscriptionId = NULL, cancelAtPeriodEnd = 0, updatedAt = ? WHERE orgId = ?").run(now, orgId);
      break;
    }

    case "invoice.paid": {
      const invoice = event.data.object;
      const orgId = invoice.subscription_details?.metadata?.orgId || invoice.metadata?.orgId;
      if (!orgId) break;
      const existing = db.prepare("SELECT id FROM invoices WHERE stripeInvoiceId = ?").get(invoice.id);
      if (!existing) {
        db.prepare(
          `INSERT INTO invoices (id, orgId, stripeInvoiceId, amountCents, status, invoiceNumber, pdfUrl, periodStart, periodEnd, createdAt)
           VALUES (?, ?, ?, ?, 'paid', ?, ?, ?, ?, ?)`
        ).run(
          cryptoRandom(), orgId, invoice.id, invoice.amount_paid, invoice.number, invoice.invoice_pdf,
          invoice.period_start ? new Date(invoice.period_start * 1000).toISOString() : null,
          invoice.period_end ? new Date(invoice.period_end * 1000).toISOString() : null,
          now
        );
      }
      const org = db.prepare("SELECT ownerId, name FROM organizations WHERE id = ?").get(orgId);
      if (org) createNotification(org.ownerId, { type: "invoice_paid", title: `Invoice paid for "${org.name}"`, body: `$${(invoice.amount_paid / 100).toFixed(2)}`, link: `/app/organizations/${orgId}` });
      break;
    }

    case "invoice.payment_failed": {
      const invoice = event.data.object;
      const orgId = invoice.subscription_details?.metadata?.orgId || invoice.metadata?.orgId;
      if (!orgId) break;
      const org = db.prepare("SELECT ownerId, name FROM organizations WHERE id = ?").get(orgId);
      if (org) createNotification(org.ownerId, { type: "payment_failed", title: `Payment failed for "${org.name}"`, body: "Stripe will automatically retry — you can also update your payment method now.", link: `/app/organizations/${orgId}` });
      break;
    }

    default:
      break; // Unhandled event types are ignored, not errored — Stripe sends many we don't act on.
  }
}
