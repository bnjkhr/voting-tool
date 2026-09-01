'use strict';

// Stripe-Billing. Aktiv nur, wenn STRIPE_SECRET_KEY gesetzt ist (sonst No-Op,
// analog zu Resend/DATA_BACKEND). Single Source of Truth für den Abo-Status ist
// Stripe; der Webhook synchronisiert die Felder nach `tenants`.
const Stripe = require('stripe');

const STRIPE_API_VERSION = '2026-07-29.dahlia';
const PLAN_FREE = 'free';
const PLAN_PRO = 'pro';
// Status, bei denen der Workspace als Pro (freigeschaltet) gilt.
const PRO_STATUSES = new Set(['active', 'trialing', 'past_due']);

let cachedClient = null;

function billingEnabled() {
  return !!process.env.STRIPE_SECRET_KEY;
}

// Master-Schalter für das Premium-Gating. Solange dieser NICHT auf 'true' steht,
// hat jeder Workspace vollen Zugriff auf alle Pro-Features (API/MCP etc.) — d.h.
// bis wir Premium mit der Stripe-Anbindung bewusst live schalten, sind alle
// effektiv Pro. Bewusst getrennt von billingEnabled(), damit das Anbinden von
// Stripe (Secret-Key setzen, Checkout testen) das Gating NICHT versehentlich
// scharf schaltet.
function billingEnforced() {
  return process.env.BILLING_ENFORCED === 'true';
}

function getStripe() {
  if (!billingEnabled()) return null;
  if (!cachedClient) {
    // Bewusst pinnen: Checkout- und Webhook-Shape dürfen sich nicht durch eine
    // kontoweite Stripe-Änderung unangekündigt verschieben.
    cachedClient = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: STRIPE_API_VERSION,
    });
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

// Entitlement: Ist der Workspace auf dem Pro-Plan? Single Source ist das vom
// Webhook synchronisierte `plan`-Feld auf dem Tenant. Fehlt es (Alt-Shape,
// nie synchronisiert), gilt Free.
function isProPlan(tenant) {
  return (tenant?.plan || PLAN_FREE) === PLAN_PRO;
}

// Ist das Pro-Gating überhaupt live? Nur wenn Premium bewusst scharf geschaltet
// ist (billingEnforced), Stripe konfiguriert ist (Upgrade-Pfad) und Postgres als
// Plan-Quelle dient (dort synct der Stripe-Webhook `plan`). Der Postgres-Flag
// wird übergeben, damit lib nicht von db/backend abhängt. Bis alle drei zutreffen
// hat jeder vollen Zugriff. Aufrufer nutzen das auch, um zu entscheiden, ob der
// maßgebliche (Postgres-)Tenant für die Plan-Prüfung geladen werden muss.
function proGatingActive({ postgres } = {}) {
  return billingEnforced() && billingEnabled() && !!postgres;
}

// Feature-unabhängiges Gate: Ist dieser Workspace für Pro-Features gesperrt?
// True nur, wenn das Gating live ist (proGatingActive) UND der Plan nicht Pro
// ist. Künftige Pro-Gates (Board-Limits etc.) nutzen denselben Check statt die
// Bedingungen zu kopieren. `tenant` muss aus der Plan-Quelle (Postgres) stammen.
function requiresProUpgrade(tenant, { postgres } = {}) {
  return proGatingActive({ postgres }) && !isProPlan(tenant);
}

// Wie requiresProUpgrade, aber für einen Plan-Tenant, der asynchron aus der
// Plan-Quelle geladen wurde und dabei `null`/`undefined` sein kann — etwa bei
// einem ID-Mismatch zwischen Firestore und Postgres oder einem transienten
// Lookup-Fehler. Ein bezahltes Entitlement ist zu schützen: bei einem nicht
// auflösbaren Tenant NICHT sperren (fail-open), sonst bekäme ein zahlender
// Pro-Kunde bei einem Lookup-Fehler fälschlich ein 402. (Ein direkter
// requiresProUpgrade(null) liefert dagegen fail-closed = true, weil ein
// plan-loser Tenant als Free gilt — genau die falsche Richtung hier.)
function requiresProUpgradeResolved(planTenant, options = {}) {
  if (!planTenant) return false;
  return requiresProUpgrade(planTenant, options);
}

// Lädt den Plan-Tenant über den übergebenen async Loader mit Fail-open-Semantik:
// Wirft der Loader (transienter Fehler der Plan-Quelle), wird der Fehler NICHT
// propagiert, sondern als „nicht auflösbar" (tenant=null) behandelt — zusammen
// mit requiresProUpgradeResolved ergibt das den Fail-open-Schutz für zahlende
// Pro-Kunden (ein Lookup-Fehler darf kein 402 erzeugen). Der Fehler wird fürs
// Logging mit zurückgegeben. Fail-open ist eine Billing-Policy und lebt daher
// hier; ausgelagert, damit dieser Pfad ohne die Express-Middleware testbar ist.
async function resolvePlanTenant(loader) {
  try {
    return { tenant: (await loader()) || null, error: null };
  } catch (error) {
    return { tenant: null, error };
  }
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

function validateProPrice(price, { unitAmount = 900, currency = 'eur' } = {}) {
  if (!price || price.active !== true) return { valid: false, reason: 'price_inactive' };
  if (price.currency !== currency) return { valid: false, reason: 'currency_mismatch' };
  if (price.unit_amount !== unitAmount) return { valid: false, reason: 'amount_mismatch' };
  if (price.type !== 'recurring'
    || price.recurring?.interval !== 'month'
    || price.recurring?.interval_count !== 1) {
    return { valid: false, reason: 'interval_mismatch' };
  }
  return { valid: true, reason: null };
}

module.exports = {
  STRIPE_API_VERSION,
  PLAN_FREE, PLAN_PRO, PRO_STATUSES,
  billingEnabled, billingEnforced, getStripe, isProPlan,
  proGatingActive, requiresProUpgrade, requiresProUpgradeResolved,
  resolvePlanTenant, mapSubscriptionToBilling, validateProPrice,
};
