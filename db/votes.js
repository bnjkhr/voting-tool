'use strict';

// Repository für votes. Nutzt die DB-Unique-Constraint (suggestion_id,
// user_fingerprint) statt App-seitiger Dedup-Logik. Alle Operationen sind
// tenant-gescopt (Defense-in-depth gegen Cross-Tenant-Schreiben/-Lesen).
const { query, withTransaction } = require('./pool');

async function hasVoted(suggestionId, userFingerprint, tenantId) {
  const { rowCount } = await query(
    `select 1 from votes
     where suggestion_id = $1 and user_fingerprint = $2 and tenant_id = $3`,
    [suggestionId, userFingerprint, tenantId]
  );
  return rowCount > 0;
}

// Gibt die Teilmenge der suggestionIds zurück, für die der Fingerprint bereits
// abgestimmt hat. Ersetzt die gechunkte Firestore-`in`-Query (Postgres kann
// beliebig große Arrays via = ANY()).
async function votedSuggestionIds(userFingerprint, suggestionIds, tenantId) {
  if (!userFingerprint || !suggestionIds || suggestionIds.length === 0) return [];
  const { rows } = await query(
    `select suggestion_id from votes
     where user_fingerprint = $1 and suggestion_id = any($2::text[]) and tenant_id = $3`,
    [userFingerprint, suggestionIds, tenantId]
  );
  return rows.map((r) => r.suggestion_id);
}

// Stimmt ab: fügt einen Vote ein UND erhöht den denormalisierten Zähler auf
// suggestions — atomar. Doppel-Votes werden durch die Unique-Constraint
// verhindert (ON CONFLICT DO NOTHING). Rückgabe: { created, votes }.
async function cast({ id, tenantId, suggestionId, userFingerprint }) {
  return withTransaction(async (client) => {
    // Cross-Tenant-Schutz: nur abstimmen, wenn die Suggestion zum Tenant gehört.
    const owns = await client.query(
      'select 1 from suggestions where id = $1 and tenant_id = $2',
      [suggestionId, tenantId]
    );
    if (owns.rowCount === 0) {
      return { created: false, votes: null, notFound: true };
    }
    const ins = await client.query(
      `insert into votes (id, tenant_id, suggestion_id, user_fingerprint)
       values ($1, $2, $3, $4)
       on conflict (suggestion_id, user_fingerprint) do nothing
       returning id`,
      [id, tenantId, suggestionId, userFingerprint]
    );
    if (ins.rowCount === 0) {
      const { rows } = await client.query('select votes from suggestions where id = $1', [suggestionId]);
      return { created: false, votes: rows[0] ? rows[0].votes : null };
    }
    const upd = await client.query(
      'update suggestions set votes = votes + 1 where id = $1 and tenant_id = $2 returning votes',
      [suggestionId, tenantId]
    );
    return { created: true, votes: upd.rows[0] ? upd.rows[0].votes : null };
  });
}

// Entfernt einen Vote und dekrementiert den Zähler — atomar, tenant-gescopt.
// Rückgabe: { removed, votes }.
async function uncast({ tenantId, suggestionId, userFingerprint }) {
  return withTransaction(async (client) => {
    const del = await client.query(
      `delete from votes
       where tenant_id = $1 and suggestion_id = $2 and user_fingerprint = $3
       returning id`,
      [tenantId, suggestionId, userFingerprint]
    );
    if (del.rowCount === 0) {
      return { removed: false, votes: null };
    }
    const upd = await client.query(
      `update suggestions set votes = greatest(votes - 1, 0)
       where id = $1 and tenant_id = $2 returning votes`,
      [suggestionId, tenantId]
    );
    return { removed: true, votes: upd.rows[0] ? upd.rows[0].votes : null };
  });
}

// Gesamtzahl der Votes eines Tenants (für die Admin-Statistik).
async function countByTenant(tenantId) {
  const { rows } = await query('select count(*)::int as count from votes where tenant_id = $1', [tenantId]);
  return rows[0].count;
}

module.exports = { hasVoted, votedSuggestionIds, cast, uncast, countByTenant };
