'use strict';

// Gemeinsamer Postgres-Pool (Neon). Nutzt den Pooled-Connection-String
// (DATABASE_URL, endet auf -pooler.neon.tech) — passt zu Vercel-Serverless.
// Migrationen/DDL nutzen stattdessen die Direktverbindung (siehe scripts/migrate-db.js).
const { Pool } = require('pg');

let pool = null;

// Entfernt sslmode/channel_binding aus dem Connection-String. Wir steuern SSL
// explizit über die ssl-Option — das vermeidet die pg-Deprecation-Warnung, dass
// sslmode=require künftig als verify-full behandelt wird.
function stripSslParams(connectionString) {
  try {
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    url.searchParams.delete('channel_binding');
    return url.toString();
  } catch (_) {
    return connectionString;
  }
}

function getPool() {
  if (pool) return pool;
  const raw = process.env.DATABASE_URL;
  if (!raw) {
    throw new Error('DATABASE_URL ist nicht gesetzt (Neon Pooled-Connection-String erwartet).');
  }
  pool = new Pool({
    connectionString: stripSslParams(raw),
    // Klein halten: auf Serverless teilen sich viele Instanzen den Pooler.
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: { rejectUnauthorized: false },
  });
  pool.on('error', (err) => console.error('Unerwarteter PG-Pool-Fehler:', err));
  return pool;
}

// Einzel-Query.
function query(text, params) {
  return getPool().query(text, params);
}

// Transaktion: cb bekommt einen Client mit .query(); Commit/Rollback automatisch.
async function withTransaction(cb) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await cb(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { getPool, query, withTransaction, stripSslParams };
