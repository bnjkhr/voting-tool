'use strict';

// Repository für tenants. Gibt Objekte im bisherigen (Firestore-)camelCase-Shape
// zurück, damit die spätere Umverdrahtung in index.js minimal bleibt.
const { query } = require('./pool');
const { mapRow, buildUpdate } = require('./rows');

const COLUMNS = `
  id, name, display_name, slug, status,
  email_from_name, email_reply_to,
  plan, stripe_customer_id, stripe_subscription_id, subscription_status,
  trial_ends_at, current_period_end, created_at, updated_at
`;

// Ergänzt das verschachtelte emailSettings-Objekt (wie im Alt-Shape).
function mapTenant(row) {
  const t = mapRow(row);
  if (!t) return null;
  t.emailSettings = { fromName: t.emailFromName || null, replyTo: t.emailReplyTo || null };
  return t;
}

async function findById(id) {
  const { rows } = await query(`select ${COLUMNS} from tenants where id = $1`, [id]);
  return mapTenant(rows[0]);
}

async function findBySlug(slug) {
  const { rows } = await query(`select ${COLUMNS} from tenants where slug = $1`, [slug]);
  return mapTenant(rows[0]);
}

async function findActiveBySlug(slug) {
  const { rows } = await query(
    `select ${COLUMNS} from tenants where slug = $1 and status = 'active'`,
    [slug]
  );
  return mapTenant(rows[0]);
}

async function list() {
  const { rows } = await query(`select ${COLUMNS} from tenants order by created_at asc`);
  return rows.map(mapTenant);
}

async function create({ id, name, displayName, slug, status = 'active' }) {
  const { rows } = await query(
    `insert into tenants (id, name, display_name, slug, status)
     values ($1, $2, $3, $4, $5)
     returning ${COLUMNS}`,
    [id, name, displayName || name, slug, status]
  );
  return mapTenant(rows[0]);
}

// Partielles Update; akzeptiert camelCase-Felder (z.B. displayName, status,
// stripeCustomerId, subscriptionStatus). updated_at wird immer gesetzt.
async function update(id, fields) {
  const { setClause, values, nextIndex } = buildUpdate(fields);
  if (!setClause) return findById(id);
  const { rows } = await query(
    `update tenants set ${setClause}, updated_at = now()
     where id = $${nextIndex} returning ${COLUMNS}`,
    [...values, id]
  );
  return mapTenant(rows[0]);
}

// Email-Settings (fromName/replyTo) — spiegelt das Alt-Feld emailSettings.
async function updateEmailSettings(id, { fromName, replyTo }) {
  return update(id, { emailFromName: fromName ?? null, emailReplyTo: replyTo ?? null });
}

module.exports = {
  mapTenant,
  findById,
  findBySlug,
  findActiveBySlug,
  list,
  create,
  update,
  updateEmailSettings,
};
