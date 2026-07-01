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

async function touch(id) {
  const { rows } = await query(
    `update sessions set last_used_at = now(), updated_at = now()
     where id = $1 returning ${COLUMNS}`,
    [id]
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
