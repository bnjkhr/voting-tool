'use strict';

// Repository für sessions. Gibt Objekte im camelCase-Shape zurück.
const { query } = require('./pool');
const { mapRow } = require('./rows');

const COLUMNS = `
  id, user_id, status, token_hash,
  last_used_at, expires_at, created_at, updated_at
`;

async function findByTokenHash(tokenHash) {
  const { rows } = await query(
    `select ${COLUMNS} from sessions where token_hash = $1 and status = 'active'`,
    [tokenHash]
  );
  return mapRow(rows[0]);
}

async function create({ id, userId, tokenHash, expiresAt }) {
  const { rows } = await query(
    `insert into sessions (id, user_id, token_hash, expires_at)
     values ($1, $2, $3, $4)
     returning ${COLUMNS}`,
    [id, userId, tokenHash, expiresAt]
  );
  return mapRow(rows[0]);
}

// Gleitender Ablauf: jede Nutzung schiebt expires_at auf jetzt + ttlDays,
// höchstens aber auf created_at + maxAgeDays.
async function touch(id, ttlDays, maxAgeDays) {
  const { rows } = await query(
    `update sessions
     set last_used_at = now(), updated_at = now(),
         expires_at = least(now() + make_interval(days => $2::int),
                            created_at + make_interval(days => $3::int))
     where id = $1 returning ${COLUMNS}`,
    [id, ttlDays, maxAgeDays]
  );
  return mapRow(rows[0]);
}

async function revoke(id) {
  const { rows } = await query(
    `update sessions set status = 'revoked', updated_at = now()
     where id = $1 returning ${COLUMNS}`,
    [id]
  );
  return mapRow(rows[0]);
}

module.exports = {
  findByTokenHash, create, touch, revoke,
};
