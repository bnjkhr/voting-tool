'use strict';

// Repository für votes. Nutzt die DB-Unique-Constraint (suggestion_id,
// user_fingerprint) statt App-seitiger Dedup-Logik.
const { query, withTransaction } = require('./pool');

async function hasVoted(suggestionId, userFingerprint) {
  const { rowCount } = await query(
    `select 1 from votes where suggestion_id = $1 and user_fingerprint = $2`,
    [suggestionId, userFingerprint]
  );
  return rowCount > 0;
}

// Gibt die Teilmenge der suggestionIds zurück, für die der Fingerprint bereits
// abgestimmt hat. Ersetzt die gechunkte Firestore-`in`-Query (Postgres kann
// beliebig große Arrays via = ANY()).
async function votedSuggestionIds(userFingerprint, suggestionIds) {
  if (!userFingerprint || !suggestionIds || suggestionIds.length === 0) return [];
  const { rows } = await query(
    `select suggestion_id from votes
     where user_fingerprint = $1 and suggestion_id = any($2::text[])`,
    [userFingerprint, suggestionIds]
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
      'update suggestions set votes = votes + 1 where id = $1 returning votes',
      [suggestionId]
    );
    return { created: true, votes: upd.rows[0] ? upd.rows[0].votes : null };
  });
}

module.exports = { hasVoted, votedSuggestionIds, cast };
