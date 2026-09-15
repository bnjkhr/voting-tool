'use strict';

// Räumt Bot-Tenants auf: Workspaces, die Bots mit Zufallsnamen und echten,
// fremden E-Mail-Adressen angelegt haben (Wellen Juli bis September 2026).
//
//   node scripts/cleanup-bot-tenants.js                         # Dry-Run (Default, read-only)
//   node scripts/cleanup-bot-tenants.js --commit --expect=119   # löscht wirklich
//
// Erkennung: Der Tenant-Name besteht aus mindestens 15 Buchstaben ohne
// Leerzeichen, z. B. „xmUgopBzCxZxEIkKJV“. Nur gemeldet, nie gelöscht werden
// Tenants mit Billing-Bezug, mit Suggestions oder mit einem Namen ohne
// Zufallsmuster (siehe looksRandom). Dort wiegt ein Fehlalarm schwerer als ein
// übrig gebliebener Bot.
//
// --expect muss die Zahl der Lösch-Kandidaten aus dem Dry-Run nennen. Kommt
// zwischen Dry-Run und Commit ein Tenant hinzu oder fällt einer weg, bricht das
// Skript ab, statt ungesehen mitzulöschen.
//
// Gelöscht wird in einer einzigen Transaktion:
//   - activity der Tenants (kein FK, also kein Cascade)
//   - login_links an die Adressen der gelöschten User (kein FK)
//   - tenants; per Cascade: apps, releases, suggestions, votes, comments,
//     attachments, memberships, invites, api_keys, billing_checkout_sessions
//   - users ohne verbleibende Mitgliedschaft; per Cascade: sessions
//
// Nutzt DATABASE_URL_UNPOOLED (sonst DATABASE_URL) aus Shell oder .env.local.

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { stripSslParams, sslDisabled } = require('../db/pool');

const BOT_TENANT_NAME_PATTERN = '^[A-Za-z]{15,}$';

const CANDIDATES_SQL = `
  select t.id, t.name, t.slug, t.created_at,
         (t.plan is not null or t.stripe_customer_id is not null
           or t.stripe_subscription_id is not null or t.subscription_status is not null) as has_billing,
         (select count(*)::int from suggestions s where s.tenant_id = t.id) as suggestions
  from tenants t
  where t.name ~ $1
  order by t.created_at`;

// User, die ausschließlich in Bot-Tenants Mitglied sind.
const USERS_SQL = `
  select u.id, u.email from users u
  where exists (select 1 from memberships m where m.user_id = u.id and m.tenant_id = any($1))
    and not exists (select 1 from memberships m where m.user_id = u.id and m.tenant_id <> all($1))
  order by u.email`;

const COUNTS_SQL = `
  select
    (select count(*)::int from apps where tenant_id = any($1))                  as apps,
    (select count(*)::int from memberships where tenant_id = any($1))           as memberships,
    (select count(*)::int from invites where tenant_id = any($1))               as invites,
    (select count(*)::int from activity where tenant_id = any($1))              as activity,
    (select count(*)::int from sessions where user_id = any($2))                as sessions,
    (select count(*)::int from login_links where email = any($3::citext[]))     as login_links`;

// Minimaler .env.local/.env-Loader (Shell-Env hat Vorrang), wie in migrate-db.js.
function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
}

function parseArgs(argv) {
  const commit = argv.includes('--commit');
  const expectArg = argv.find((arg) => arg.startsWith('--expect='));
  const expect = expectArg ? Number(expectArg.slice('--expect='.length)) : null;
  if (commit && !Number.isInteger(expect)) {
    throw new Error('--commit braucht --expect=<Anzahl Lösch-Kandidaten aus dem Dry-Run>.');
  }
  return { commit, expect };
}

// Zufallsnamen wechseln mehrfach mitten im Wort von klein auf groß
// („xmUgopBzCxZxEIkKJV“). Lange echte Einzelwörter wie „Physiotherapiepraxis“
// tun das nicht und sollen nie ungesehen gelöscht werden.
function looksRandom(name) {
  return (String(name).match(/[a-z][A-Z]/g) || []).length >= 2;
}

function skipReason(tenant) {
  if (tenant.has_billing) return 'Billing';
  if (tenant.suggestions > 0) return `${tenant.suggestions} Suggestions`;
  if (!looksRandom(tenant.name)) return 'Name wirkt nicht zufällig';
  return null;
}

function partitionCandidates(tenants) {
  const targets = [];
  const skipped = [];
  for (const tenant of tenants) {
    const reason = skipReason(tenant);
    if (reason) skipped.push({ ...tenant, reason });
    else targets.push(tenant);
  }
  return { targets, skipped };
}

// Die Adressen gehören meist Unbeteiligten: nur maskiert ausgeben.
function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
}

async function collect(client) {
  const { rows: tenants } = await client.query(CANDIDATES_SQL, [BOT_TENANT_NAME_PATTERN]);
  const { targets, skipped } = partitionCandidates(tenants);
  const tenantIds = targets.map((t) => t.id);
  const { rows: users } = await client.query(USERS_SQL, [tenantIds]);
  const userIds = users.map((u) => u.id);
  const emails = users.map((u) => u.email);
  const { rows: [counts] } = await client.query(COUNTS_SQL, [tenantIds, userIds, emails]);
  return { targets, skipped, tenantIds, users, userIds, emails, counts };
}

function report({ targets, skipped, users, counts }) {
  console.log(`\nLösch-Kandidaten: ${targets.length} Tenants`);
  targets.forEach((t) => {
    console.log(`  ${t.created_at.toISOString().slice(0, 10)}  ${t.id.padEnd(28)} ${t.name}`);
  });

  if (skipped.length) {
    console.log(`\nÜbersprungen, bitte von Hand prüfen: ${skipped.length}`);
    skipped.forEach((t) => {
      console.log(`  ${t.id.padEnd(28)} ${t.name}  (${t.reason})`);
    });
  }

  const domains = {};
  users.forEach((u) => { const d = String(u.email).split('@')[1] || '?'; domains[d] = (domains[d] || 0) + 1; });
  console.log(`\nUser ohne andere Mitgliedschaft: ${users.length}`);
  users.forEach((u) => console.log(`  ${maskEmail(u.email)}`));
  console.log('  nach Domain:', Object.entries(domains).sort((a, b) => b[1] - a[1]).map(([d, n]) => `${d}=${n}`).join(', '));

  console.log('\nBetroffene Zeilen:');
  Object.entries(counts).forEach(([table, n]) => console.log(`  ${table.padEnd(12)} ${n}`));
}

async function deleteAll(client, { tenantIds, userIds, emails }) {
  const deleted = {};
  deleted.activity = (await client.query('delete from activity where tenant_id = any($1)', [tenantIds])).rowCount;
  deleted.login_links = (await client.query('delete from login_links where email = any($1::citext[])', [emails])).rowCount;
  deleted.tenants = (await client.query('delete from tenants where id = any($1)', [tenantIds])).rowCount;
  // Erneut prüfen: nur User ohne jede verbleibende Mitgliedschaft.
  deleted.users = (await client.query(
    `delete from users u where u.id = any($1)
       and not exists (select 1 from memberships m where m.user_id = u.id)`,
    [userIds]
  )).rowCount;
  return deleted;
}

async function main() {
  loadEnv();
  const { commit, expect } = parseArgs(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Fehlt: DATABASE_URL_UNPOOLED (oder DATABASE_URL) in .env.local setzen.');
  }

  const client = new Client({ connectionString: stripSslParams(connectionString), ssl: sslDisabled() ? false : true });
  await client.connect();
  try {
    // Dry-Run in einer READ-ONLY-Transaktion: selbst ein Fehler im Skript kann nichts schreiben.
    await client.query(commit ? 'begin' : 'begin read only');
    const found = await collect(client);
    report(found);

    if (!commit) {
      await client.query('rollback');
      console.log(`\nDry-Run: nichts gelöscht. Zum Löschen: --commit --expect=${found.targets.length}`);
      return;
    }

    if (found.targets.length !== expect) {
      await client.query('rollback');
      throw new Error(`Abbruch: ${found.targets.length} Kandidaten gefunden, --expect=${expect}. Dry-Run wiederholen.`);
    }
    const deleted = await deleteAll(client, found);
    await client.query('commit');
    console.log('\nGelöscht:', deleted);
  } catch (error) {
    await client.query('rollback').catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = { BOT_TENANT_NAME_PATTERN, maskEmail, parseArgs, partitionCandidates };
