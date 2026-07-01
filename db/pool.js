'use strict';

// Gemeinsamer Postgres-Pool (Neon). Nutzt den Pooled-Connection-String
// (DATABASE_URL, endet auf -pooler.neon.tech) — passt zu Vercel-Serverless.
// Migrationen/DDL nutzen stattdessen die Direktverbindung (siehe scripts/migrate-db.js).
const { Pool } = require('pg');

let pool = null;

function getPool() {
  if (pool) return pool;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL ist nicht gesetzt (Neon Pooled-Connection-String erwartet).');
  }
  pool = new Pool({
    connectionString,
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

module.exports = { getPool, query, withTransaction };
