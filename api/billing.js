'use strict';

// Stripe-Billing. Aktiv nur, wenn STRIPE_SECRET_KEY gesetzt ist (sonst No-Op,
// analog zu Resend/DATA_BACKEND). Single Source of Truth für den Abo-Status ist
// Stripe; der Webhook synchronisiert die Felder nach `tenants`.
const Stripe = require('stripe');

const PLAN_FREE = 'free';
const PLAN_PRO = 'pro';
// Status, bei denen der Workspace als Pro (freigeschaltet) gilt.
const PRO_STATUSES = new Set(['active', 'trialing', 'past_due']);

let cachedClient = null;

function billingEnabled() {
  return !!process.env.STRIPE_SECRET_KEY;
}

function getStripe() {
  if (!billingEnabled()) return null;
  if (!cachedClient) {
    // apiVersion bewusst nicht gepinnt -> SDK-Default (Account-Version).
    cachedClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }
  return cachedClient;
}

function toDate(unixSeconds) {
  return Number.isFinite(unixSeconds) ? new Date(unixSeconds * 1000) : null;
}

// Period-Ende liegt je nach Stripe-API-Version auf der Subscription selbst oder
// auf dem ersten Item — beides berücksichtigen.
function currentPeriodEnd(subscription) {
  const onSub = subscription?.current_period_end;
  const onItem = subscription?.items?.data?.[0]?.current_period_end;
  return toDate(Number.isFinite(onSub) ? onSub : onItem);
}

// Reiner Mapper: Stripe-Subscription -> tenants-Billing-Felder (camelCase).
// Ein aktives/gültiges Abo => Pro; alles andere => Free.
function mapSubscriptionToBilling(subscription) {
  const status = subscription?.status || null;
  const isPro = status ? PRO_STATUSES.has(status) : false;
  return {
    plan: isPro ? PLAN_PRO : PLAN_FREE,
    subscriptionStatus: status,
    stripeSubscriptionId: isPro ? (subscription?.id || null) : null,
    currentPeriodEnd: currentPeriodEnd(subscription),
    trialEndsAt: toDate(subscription?.trial_end),
  };
}

module.exports = {
  PLAN_FREE, PLAN_PRO, PRO_STATUSES,
  billingEnabled, getStripe, mapSubscriptionToBilling,
};
