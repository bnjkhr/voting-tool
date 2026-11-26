'use strict';

// Legt einen privaten Workspace an (Status `private`, Plan `pro`) samt Boards
// und Owner-Mitgliedschaft für ein bestehendes Konto. Ohne --commit nur
// Probelauf.
//
//   npm run workspace:create-private -- --slug intern --name Intern \
//     --email <adresse> --boards "<Name:Präfix,…>" [--commit]

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { LEGACY_TENANT_SLUG, parseSlugParam } = require('../api/tenant-utils');
const { normalizeInviteEmail } = require('../api/team-utils');
const { parseBoards } = require('../lib/private-workspace');
const { provisionPrivateWorkspace } = require('../db/provisioning');

// Minimaler .env.local/.env-Loader (Shell-Env hat Vorrang), wie in migrate-db.js.
function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      if (process.env[key] !== undefined) continue;
      process.env[key] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

// Nur Host und Datenbankname: Benutzer und Passwort gehören in keine Ausgabe.
function describeTarget(connectionString) {
  try {
    const url = new URL(connectionString);
    return `${url.host}${url.pathname}`;
  } catch {
    return 'unbekannt (DATABASE_URL ist keine gültige Adresse)';
  }
}

function readInput(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      slug: { type: 'string' },
      name: { type: 'string' },
      email: { type: 'string' },
      boards: { type: 'string' },
      commit: { type: 'boolean', default: false },
    },
  });

  const slug = parseSlugParam(values.slug);
  if (!slug || slug !== values.slug || slug === LEGACY_TENANT_SLUG) {
    throw new Error('--slug fehlt oder ist ungültig (Kleinbuchstaben, Ziffern, Bindestriche; nicht "legacy").');
  }
  const name = (values.name || '').trim();
  if (!name) throw new Error('--name fehlt.');

  let ownerEmail;
  try {
    ownerEmail = normalizeInviteEmail(values.email);
  } catch {
    throw new Error('--email fehlt oder ist keine gültige Adresse.');
  }

  return { commit: values.commit, slug, name, ownerEmail, boards: parseBoards(values.boards) };
}

async function run(argv, { env = process.env, log = console.log, provision = provisionPrivateWorkspace } = {}) {
  const { commit, slug, name, ownerEmail, boards } = readInput(argv);
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL ist nicht gesetzt.');

  log(`Ziel-Datenbank: ${describeTarget(env.DATABASE_URL)}`);
  log(`Workspace: ${name} (Slug ${slug}, Status private, Plan pro)`);
  log(`Owner: ${ownerEmail}`);
  log('Boards:');
  for (const board of boards) log(`  - ${board.name} (Slug ${board.slug}, Präfix ${board.ticketPrefix})`);

  if (!commit) {
    log('Probelauf: nichts geschrieben. Mit --commit ausführen.');
    return;
  }

  try {
    await provision({
      tenantId: slug, slug, name, ownerEmail, boards, membershipId: crypto.randomUUID(),
    });
  } catch (error) {
    if (error.code === 'OWNER_NOT_FOUND') {
      throw new Error(`Kein aktives Konto mit der Adresse ${ownerEmail}. Nichts geändert.`);
    }
    if (error.code === 'WORKSPACE_EXISTS') {
      throw new Error(`Der Workspace "${slug}" existiert bereits. Nichts geändert.`);
    }
    throw error;
  }
  log(`Workspace "${slug}" angelegt, ${boards.length} Boards.`);
}

async function main() {
  loadEnv();
  const { getPool } = require('../db/pool');
  try {
    await run(process.argv.slice(2));
  } finally {
    if (process.env.DATABASE_URL) await getPool().end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

module.exports = { run };
