'use strict';

// Schließt öffentliche Boards an ein Board eines privaten Workspaces an und
// schaltet das Holen je Board ein oder aus. Ohne --commit nur Probelauf. Liest
// nur Postgres: Ob es die App im Altbestand gibt, zeigt erst der Probelauf des
// Holens (`dryRun`).
//
//   npm run feedback:sources -- connect --workspace <slug> --board <slug>
//     (--legacy-app <id> | --source-workspace <slug> --source-board <slug>) [--commit]
//   npm run feedback:sources -- enable|disable --workspace <slug> --board <slug> [--commit]
//   npm run feedback:sources -- list --workspace <slug>

const { parseArgs } = require('util');
const { LEGACY_TENANT_SLUG, parseSlugParam } = require('../api/tenant-utils');
const { loadEnv, describeTarget } = require('./create-private-workspace');

const COMMANDS = ['connect', 'enable', 'disable', 'list'];
const SOURCE_OPTIONS = ['legacy-app', 'source-workspace', 'source-board'];
const LEGACY_APP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const DRY_RUN_NOTE = 'Probelauf: nichts geschrieben. Mit --commit ausführen.';

function readSlug(values, option, { legacyAllowed = false } = {}) {
  const value = values[option];
  const slug = parseSlugParam(value);
  if (!slug || slug !== value || (!legacyAllowed && slug === LEGACY_TENANT_SLUG)) {
    throw new Error(`--${option} fehlt oder ist ungültig (Kleinbuchstaben, Ziffern, Bindestriche).`);
  }
  return slug;
}

// Genau eine Quellart: eine App des Altbestands oder ein Board eines Workspaces.
function readSource(values) {
  const legacy = values['legacy-app'] !== undefined;
  const workspace = values['source-workspace'] !== undefined || values['source-board'] !== undefined;
  if (legacy === workspace) {
    throw new Error('Genau eine Quelle angeben: --legacy-app <id> oder --source-workspace <slug> --source-board <slug>.');
  }
  if (legacy) {
    if (!LEGACY_APP_ID.test(values['legacy-app'])) throw new Error('--legacy-app ist keine gültige App-ID.');
    return { kind: 'legacy', appId: values['legacy-app'] };
  }
  return {
    kind: 'workspace',
    workspace: readSlug(values, 'source-workspace'),
    board: readSlug(values, 'source-board', { legacyAllowed: true }),
  };
}

function readInput(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      workspace: { type: 'string' },
      board: { type: 'string' },
      'legacy-app': { type: 'string' },
      'source-workspace': { type: 'string' },
      'source-board': { type: 'string' },
      commit: { type: 'boolean', default: false },
    },
  });

  const [command] = positionals;
  if (positionals.length !== 1 || !COMMANDS.includes(command)) {
    throw new Error(`Genau einen Befehl angeben: ${COMMANDS.join(', ')}.`);
  }
  if (command !== 'connect' && SOURCE_OPTIONS.some((option) => values[option] !== undefined)) {
    throw new Error(`Eine Quelle gibt es nur bei connect, nicht bei ${command}.`);
  }
  if (command === 'list' && (values.board !== undefined || values.commit)) {
    throw new Error('list kennt nur --workspace.');
  }
  return {
    command,
    commit: values.commit,
    workspace: readSlug(values, 'workspace'),
    board: command === 'list' ? null : readSlug(values, 'board', { legacyAllowed: true }),
    source: command === 'connect' ? readSource(values) : null,
  };
}

async function findWorkspaceBoard(repos, tenant, boardSlug) {
  const board = await repos.apps.findBySlug(tenant.id, boardSlug);
  if (!board) throw new Error(`Im Workspace "${tenant.slug}" gibt es kein Board "${boardSlug}". Nichts geändert.`);
  return board;
}

async function describeSource(repos, source) {
  if (source.sourceKind === 'legacy') return `Altbestand, App ${source.sourceAppId}`;
  const tenant = await repos.tenants.findById(source.sourceTenantId);
  const board = await repos.apps.findById(source.sourceAppId);
  const note = tenant?.status === 'active' ? '' : ' (nicht öffentlich erreichbar)';
  return `Workspace ${tenant?.slug || source.sourceTenantId}, Board ${board?.slug || source.sourceAppId}${note}`;
}

// Quelle aus den Eingaben auflösen. Ein Quell-Workspace muss öffentlich sein.
async function resolveSource(repos, source) {
  if (source.kind === 'legacy') {
    return { sourceKind: 'legacy', sourceTenantId: null, sourceAppId: source.appId };
  }
  const tenant = await repos.tenants.findBySlug(source.workspace);
  if (!tenant) throw new Error(`Den Quell-Workspace "${source.workspace}" gibt es nicht. Nichts geändert.`);
  if (tenant.status !== 'active') {
    throw new Error(`Der Quell-Workspace "${source.workspace}" ist nicht öffentlich (Status ${tenant.status}). Nichts geändert.`);
  }
  const board = await findWorkspaceBoard(repos, tenant, source.board);
  return { sourceKind: 'workspace', sourceTenantId: tenant.id, sourceAppId: board.id };
}

async function list(repos, tenant, log) {
  const sources = await repos.feedback.listSources(tenant.id);
  if (sources.length === 0) log('Keine Boards angeschlossen.');
  for (const source of sources) {
    log(`Board ${source.boardSlug}`);
    log(`  Quelle: ${await describeSource(repos, source)}`);
    log(`  Holen: ${source.fetchEnabled ? 'an' : 'aus'}`);
    log(`  Zuletzt geholt: ${source.lastFetchedAt ? source.lastFetchedAt.toISOString() : 'noch nie'}`);
    log(`  Warten auf Freigabe: ${source.unapprovedCount}`);
    log(`  Fehler: ${source.lastError || 'keiner'}`);
  }
}

async function connect(repos, tenant, board, input, log) {
  const target = await resolveSource(repos, input.source);
  const current = await repos.feedback.findSourceByApp(tenant.id, board.id);
  log(`Quelle: ${await describeSource(repos, target)}`);
  if (current) log(`Bisher: ${await describeSource(repos, current)}`);
  if (!input.commit) return log(DRY_RUN_NOTE);

  let source;
  try {
    source = await repos.feedback.upsertSource({ tenantId: tenant.id, appId: board.id, ...target });
  } catch (error) {
    if (error.code === '23505') {
      throw new Error('Diese Quelle ist schon an einem anderen Board angeschlossen. Nichts geändert.');
    }
    if (['NOT_PRIVATE', 'SOURCE_IN_USE'].includes(error.code)) {
      throw new Error(`${error.message} Nichts geändert.`);
    }
    throw error;
  }
  return log(source.fetchEnabled
    ? 'Quelle ist angeschlossen, Holen bleibt an.'
    : 'Quelle angeschlossen, Holen ist aus. Erst den Probelauf ansehen, dann "enable".');
}

async function switchFetch(repos, tenant, board, input, log) {
  const source = await repos.feedback.findSourceByApp(tenant.id, board.id);
  if (!source) throw new Error(`An Board "${board.slug}" ist keine Quelle angeschlossen. Nichts geändert.`);
  const enabled = input.command === 'enable';
  log(`Quelle: ${await describeSource(repos, source)}`);
  log(`Holen: ${source.fetchEnabled ? 'an' : 'aus'} -> ${enabled ? 'an' : 'aus'}`);
  if (!input.commit) return log(DRY_RUN_NOTE);
  await repos.feedback.setFetchEnabled(source.id, enabled);
  return log(`Holen für Board "${board.slug}" ist ${enabled ? 'an' : 'aus'}.`);
}

async function run(argv, { env = process.env, log = console.log, repos = require('../db') } = {}) {
  const input = readInput(argv);
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL ist nicht gesetzt.');

  log(`Ziel-Datenbank: ${describeTarget(env.DATABASE_URL)}`);
  const tenant = await repos.tenants.findBySlug(input.workspace);
  if (!tenant) throw new Error(`Den Workspace "${input.workspace}" gibt es nicht. Nichts geändert.`);
  // Ausschalten und Ansehen gehen immer, Anschließen und Einschalten nur privat.
  if (['connect', 'enable'].includes(input.command) && tenant.status !== 'private') {
    throw new Error(`Ziel sind nur private Workspaces: "${tenant.slug}" hat den Status ${tenant.status}. Nichts geändert.`);
  }
  log(`Workspace: ${tenant.slug} (Status ${tenant.status})`);

  if (input.command === 'list') return list(repos, tenant, log);
  const board = await findWorkspaceBoard(repos, tenant, input.board);
  log(`Board: ${board.slug}`);
  if (input.command === 'connect') return connect(repos, tenant, board, input, log);
  return switchFetch(repos, tenant, board, input, log);
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
