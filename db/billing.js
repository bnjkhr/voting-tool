'use strict';

const { query } = require('./pool');
const { mapRow } = require('./rows');

const CHECKOUT_COLUMNS = `
  tenant_id, attempt_id, stripe_session_id, checkout_url, status,
  terms_version, terms_accepted_at, immediate_performance_accepted_at,
  business_customer_confirmed_at,
  accepted_by, expires_at, created_at, updated_at
`;

async function reserveCheckout({
  tenantId,
  attemptId,
  termsVersion,
  acceptedBy,
  expiresAt,
}) {
  const { rows } = await query(
    `insert into billing_checkout_sessions (
       tenant_id, attempt_id, status, terms_version, terms_accepted_at,
       business_customer_confirmed_at, accepted_by, expires_at
     ) values ($1, $2, 'creating', $3, now(), now(), $4, $5)
     on conflict (tenant_id) do update set
       attempt_id = excluded.attempt_id,
       stripe_session_id = null,
       checkout_url = null,
       status = 'creating',
       terms_version = excluded.terms_version,
       terms_accepted_at = excluded.terms_accepted_at,
       immediate_performance_accepted_at = null,
       business_customer_confirmed_at = excluded.business_customer_confirmed_at,
       accepted_by = excluded.accepted_by,
       expires_at = excluded.expires_at,
       updated_at = now()
     where billing_checkout_sessions.status in ('completed', 'failed', 'expired')
        or billing_checkout_sessions.expires_at <= now()
     returning ${CHECKOUT_COLUMNS}`,
    [tenantId, attemptId, termsVersion, acceptedBy, expiresAt]
  );
  if (rows[0]) return { reserved: true, checkout: mapRow(rows[0]) };

  const existing = await findCheckoutByTenant(tenantId);
  return { reserved: false, checkout: existing };
}

async function findCheckoutByTenant(tenantId) {
  const { rows } = await query(
    `select ${CHECKOUT_COLUMNS} from billing_checkout_sessions where tenant_id = $1`,
    [tenantId]
  );
  return mapRow(rows[0]);
}

async function markCheckoutReady(attemptId, { stripeSessionId, checkoutUrl }) {
  const { rows } = await query(
    `update billing_checkout_sessions
        set stripe_session_id = $2, checkout_url = $3, status = 'ready', updated_at = now()
      where attempt_id = $1
      returning ${CHECKOUT_COLUMNS}`,
    [attemptId, stripeSessionId, checkoutUrl]
  );
  return mapRow(rows[0]);
}

async function markCheckoutFailed(attemptId) {
  await query(
    `update billing_checkout_sessions set status = 'failed', updated_at = now() where attempt_id = $1`,
    [attemptId]
  );
}

async function markCheckoutCompleted(stripeSessionId) {
  await query(
    `update billing_checkout_sessions
        set status = 'completed', updated_at = now()
      where stripe_session_id = $1`,
    [stripeSessionId]
  );
}

async function beginWebhookEvent(eventId, eventType) {
  const { rows } = await query(
    `insert into stripe_webhook_events (event_id, event_type)
     values ($1, $2)
     on conflict (event_id) do update set
       event_type = excluded.event_type,
       received_at = now()
     where stripe_webhook_events.processed_at is null
       and stripe_webhook_events.received_at <= now() - interval '5 minutes'
     returning event_id`,
    [eventId, eventType]
  );
  if (rows[0]) return 'claimed';

  const existing = await query(
    `select processed_at from stripe_webhook_events where event_id = $1`,
    [eventId]
  );
  return existing.rows[0]?.processed_at ? 'processed' : 'processing';
}

async function completeWebhookEvent(eventId) {
  await query(
    `update stripe_webhook_events set processed_at = now() where event_id = $1`,
    [eventId]
  );
}

async function releaseWebhookEvent(eventId) {
  await query(
    `delete from stripe_webhook_events where event_id = $1 and processed_at is null`,
    [eventId]
  );
}

module.exports = {
  reserveCheckout,
  findCheckoutByTenant,
  markCheckoutReady,
  markCheckoutFailed,
  markCheckoutCompleted,
  beginWebhookEvent,
  completeWebhookEvent,
  releaseWebhookEvent,
};
