'use strict';

// Repository für login_links (Magic Links). Gibt Objekte im camelCase-Shape zurück.
const { query } = require('./pool');
const { mapRow } = require('./rows');

const COLUMNS = `
  id, email, status, token_hash, redirect_url,
  expires_at, consumed_at, created_at, updated_at
`;

async function findByTokenHash(tokenHash) {
  const { rows } = await query(
    `select ${COLUMNS} from login_links where token_hash = $1 and status = 'pending'`,
    [tokenHash]
  );
  return mapRow(rows[0]);
}

async function create({ id, email, tokenHash, redirectUrl, expiresAt }) {
  const { rows } = await query(
    `insert into login_links (id, email, token_hash, redirect_url, expires_at)
     values ($1, $2, $3, $4, $5)
     returning ${COLUMNS}`,
    [id, email, tokenHash, redirectUrl, expiresAt]
  );
  return mapRow(rows[0]);
}

async function consume(id) {
  const { rows } = await query(
    `update login_links set status = 'consumed', consumed_at = now(), updated_at = now()
     where id = $1 returning ${COLUMNS}`,
    [id]
  );
  return mapRow(rows[0]);
}

module.exports = {
  findByTokenHash, create, consume,
};
