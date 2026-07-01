'use strict';

// Wendet migrations/*.sql in Reihenfolge an und merkt sich angewandte
// Migrationen in schema_migrations. Idempotent: bereits angewandte werden
// uebersprungen. Nutzt bevorzugt die Direktverbindung (DATABASE_URL_UNPOOLED)
// fuer DDL, sonst DATABASE_URL.
//
//   node scripts/migrate-db.js            # anwenden
//   node scripts/migrate-db.js --status   # nur anzeigen, was offen ist

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { stripSslParams } = require('../db/pool');

// Minimaler .env.local/.env-Loader (Shell-Env hat Vorrang).
function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue;
      let val = m[2].trim().replace(/^["']|["']$/g, '');
      process.env[key] = val;
    }
  }
}

async function main() {
  loadEnv();
  const statusOnly = process.argv.includes('--status');
  const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('Fehlt: DATABASE_URL_UNPOOLED (oder DATABASE_URL) in .env.local setzen.');
    process.exit(1);
  }

  const migrationsDir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

  const client = new Client({ connectionString: stripSslParams(connectionString), ssl: true });
  await client.connect();
  try {
    // --status ist rein lesend: Tabelle NICHT anlegen, nur abfragen falls vorhanden.
    if (statusOnly) {
      const exists = (await client.query(`select to_regclass('public.schema_migrations') is not null as e`)).rows[0].e;
      const applied = exists
        ? new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name))
        : new Set();
      const pending = files.filter((f) => !applied.has(f));
      console.log(`Angewandt: ${applied.size} | Offen: ${pending.length}`);
      pending.forEach((f) => console.log('  offen:', f));
      return;
    }

    // Advisory-Lock verhindert, dass zwei Runner parallel dieselbe Migration anwenden.
    await client.query('select pg_advisory_lock(4242424242)');
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`);
    const applied = new Set(
      (await client.query('select name from schema_migrations')).rows.map((r) => r.name)
    );

    const pending = files.filter((f) => !applied.has(f));
    if (pending.length === 0) {
      console.log('Keine offenen Migrationen.');
      return;
    }

    for (const file of pending) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      process.stdout.write(`anwenden: ${file} ... `);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations(name) values ($1)', [file]);
        await client.query('COMMIT');
        console.log('ok');
      } catch (err) {
        await client.query('ROLLBACK');
        console.log('FEHLER');
        throw err;
      }
    }
    console.log(`Fertig: ${pending.length} Migration(en) angewandt.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
