'use strict';

// Skript zum Anschließen öffentlicher Boards: Eingaben, Probelauf, Meldungen.
// Die Datenbank-Seite prüft tests/integration/feedback-db-postgres.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { run } = require('../scripts/feedback-sources');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'feedback-sources.js');
const DATABASE_URL = 'postgres://geheimnutzer:geheimwort@db.example.test:6543/roadlight?sslmode=require';

const TENANTS = [
  { id: 't-intern', slug: 'intern', status: 'private' },
  { id: 't-offen', slug: 'offen', status: 'active' },
  { id: 't-zu', slug: 'gesperrt', status: 'suspended' },
  { id: 't-privat', slug: 'zweitprivat', status: 'private' },
];
const APPS = [
  { id: 'a-ziel', tenantId: 't-intern', slug: 'ziel' },
  { id: 'a-quelle', tenantId: 't-offen', slug: 'quelle' },
  { id: 'a-aktivziel', tenantId: 't-offen', slug: 'ziel' },
  { id: 'a-zu', tenantId: 't-zu', slug: 'quelle' },
  { id: 'a-privat', tenantId: 't-privat', slug: 'quelle' },
];
const SOURCE = {
  id: 'q1', tenantId: 't-intern', appId: 'a-ziel', boardSlug: 'ziel', sourceKind: 'legacy',
  sourceTenantId: null, sourceAppId: 'legacy_app', fetchEnabled: false, lastFetchedAt: null,
  unapprovedCount: 0, lastError: null, pushEnabled: false,
};

function fakeRepos({ sources = [], links = [], upsertError = null } = {}) {
  const writes = [];
  return {
    writes,
    tenants: {
      findBySlug: async (slug) => TENANTS.find((tenant) => tenant.slug === slug) || null,
      findById: async (id) => TENANTS.find((tenant) => tenant.id === id) || null,
    },
    apps: {
      findBySlug: async (tenantId, slug) => APPS.find((app) => app.tenantId === tenantId && app.slug === slug) || null,
      findById: async (id) => APPS.find((app) => app.id === id) || null,
    },
    feedback: {
      listSources: async (tenantId) => sources.filter((source) => source.tenantId === tenantId),
      findSourceByApp: async (tenantId, appId) => sources
        .find((source) => source.tenantId === tenantId && source.appId === appId) || null,
      upsertSource: async (input) => {
        writes.push(['upsertSource', input]);
        if (upsertError) throw upsertError;
        return { fetchEnabled: false, ...input };
      },
      setFetchEnabled: async (id, enabled) => writes.push(['setFetchEnabled', id, enabled]),
      setPushEnabled: async (id, enabled) => writes.push(['setPushEnabled', id, enabled]),
      listLinks: async () => links,
    },
  };
}

async function runScript(argv, { repos = fakeRepos(), env = { DATABASE_URL } } = {}) {
  const lines = [];
  await run(argv, { env, repos, log: (line) => lines.push(line) });
  return { writes: repos.writes, output: lines.join('\n') };
}

const LEGACY = ['connect', '--workspace', 'intern', '--board', 'ziel', '--legacy-app', 'legacy_app'];
const WORKSPACE = [
  'connect', '--workspace', 'intern', '--board', 'ziel',
  '--source-workspace', 'offen', '--source-board', 'quelle',
];
const switchArgs = (command) => [command, '--workspace', 'intern', '--board', 'ziel'];

const assertClean = (output) => {
  for (const secret of ['geheimnutzer', 'geheimwort', 'postgres://']) {
    assert.equal(output.includes(secret), false, `${secret} darf nicht in der Ausgabe stehen`);
  }
};

for (const [why, argv, parts, sources] of [
  ['connect (Altbestand)', LEGACY, ['legacy_app'], []],
  ['connect (Workspace)', WORKSPACE, ['offen', 'quelle'], []],
  ['enable', switchArgs('enable'), ['legacy_app', 'aus -> an'], [SOURCE]],
  ['disable', switchArgs('disable'), ['legacy_app', 'an -> aus'], [{ ...SOURCE, fetchEnabled: true }]],
]) {
  test(`${why} ohne --commit: nichts geschrieben, Ziel ohne Zugangsdaten`, async () => {
    const { writes, output } = await runScript(argv, { repos: fakeRepos({ sources }) });

    assert.deepEqual(writes, []);
    for (const part of ['db.example.test:6543/roadlight', 'intern', 'ziel', '--commit', ...parts]) {
      assert.ok(output.includes(part), `${part} fehlt in:\n${output}`);
    }
    assertClean(output);
  });
}

test('connect --commit schließt eine App des Altbestands an', async () => {
  const { writes, output } = await runScript([...LEGACY, '--commit']);

  assert.deepEqual(writes, [['upsertSource', {
    tenantId: 't-intern', appId: 'a-ziel', sourceKind: 'legacy', sourceTenantId: null, sourceAppId: 'legacy_app',
  }]]);
  assert.match(output, /Holen ist aus/);
  assertClean(output);
});

test('connect --commit schließt ein Board eines Workspaces an', async () => {
  const { writes } = await runScript([...WORKSPACE, '--commit']);

  assert.deepEqual(writes, [['upsertSource', {
    tenantId: 't-intern', appId: 'a-ziel', sourceKind: 'workspace',
    sourceTenantId: 't-offen', sourceAppId: 'a-quelle',
  }]]);
});

for (const [command, enabled] of [['enable', true], ['disable', false]]) {
  test(`${command} --commit setzt den Schalter`, async () => {
    const repos = fakeRepos({ sources: [SOURCE] });

    const { writes } = await runScript([...switchArgs(command), '--commit'], { repos });

    assert.deepEqual(writes, [['setFetchEnabled', 'q1', enabled]]);
  });
}

test('list zeigt Quelle, Schalter, letzte Marke und Fehler', async () => {
  const repos = fakeRepos({
    sources: [{
      ...SOURCE, fetchEnabled: true, lastFetchedAt: new Date('2026-11-26T10:00:00Z'),
      unapprovedCount: 3, lastError: 'Die Quelle antwortet nicht.',
    }],
  });

  const { writes, output } = await runScript(['list', '--workspace', 'intern'], { repos });

  assert.deepEqual(writes, []);
  for (const part of ['Board ziel', 'legacy_app', 'Holen: an', '2026-11-26T10:00:00.000Z',
    'Warten auf Freigabe: 3', 'Fehler: Die Quelle antwortet nicht.']) {
    assert.ok(output.includes(part), `${part} fehlt in:\n${output}`);
  }
  assertClean(output);
});

test('list: freie Marke (noch nie geholt oder Einträge ausstehend)', async () => {
  const { output } = await runScript(['list', '--workspace', 'intern'], {
    repos: fakeRepos({ sources: [SOURCE] }),
  });

  assert.ok(output.includes('Zuletzt geholt: offen (noch nie oder Einträge ausstehend)'), output);
});

test('list ohne Quellen', async () => {
  const { output } = await runScript(['list', '--workspace', 'intern']);

  assert.match(output, /Keine Boards angeschlossen/);
});

for (const command of ['connect', 'enable']) {
  test(`${command} auf aktivem Workspace: nur private Workspaces`, async () => {
    const argv = command === 'connect'
      ? ['connect', '--workspace', 'offen', '--board', 'ziel', '--legacy-app', 'x', '--commit']
      : ['enable', '--workspace', 'offen', '--board', 'ziel', '--commit'];
    const repos = fakeRepos();

    await assert.rejects(runScript(argv, { repos }), /nur private Workspaces/);

    assert.deepEqual(repos.writes, []);
  });
}

test('disable geht auch, wenn der Workspace nicht mehr privat ist', async () => {
  const repos = fakeRepos({
    sources: [{ ...SOURCE, tenantId: 't-offen', appId: 'a-aktivziel', fetchEnabled: true }],
  });

  await runScript(['disable', '--workspace', 'offen', '--board', 'ziel', '--commit'], { repos });

  assert.deepEqual(repos.writes, [['setFetchEnabled', 'q1', false]]);
});

for (const [slug, status] of [['zweitprivat', 'private'], ['gesperrt', 'suspended']]) {
  test(`Quell-Workspace ${status}: Abbruch`, async () => {
    const repos = fakeRepos();
    const argv = [...WORKSPACE.slice(0, 5), '--source-workspace', slug, '--source-board', 'quelle', '--commit'];

    await assert.rejects(runScript(argv, { repos }), /nicht öffentlich.*Nichts geändert/);

    assert.deepEqual(repos.writes, []);
  });
}

const CONNECT = ['connect', '--workspace', 'intern', '--board', 'ziel'];
for (const [why, argv, env, message] of [
  ['beide Quellarten', [...LEGACY, '--source-workspace', 'offen', '--source-board', 'quelle'], undefined, /Genau eine Quelle/],
  ['keine Quelle', CONNECT, undefined, /Genau eine Quelle/],
  ['Quell-Workspace ohne Board', [...CONNECT, '--source-workspace', 'offen'], undefined, /--source-board/],
  ['Quell-Board ohne Workspace', [...CONNECT, '--source-board', 'quelle'], undefined, /--source-workspace/],
  ['ungültige App-ID', [...CONNECT, '--legacy-app', 'a/b'], undefined, /--legacy-app/],
  ['Quelle bei enable', [...switchArgs('enable'), '--legacy-app', 'x'], undefined, /nur bei connect/],
  ['--commit bei list', ['list', '--workspace', 'intern', '--commit'], undefined, /list kennt nur/],
  ['unbekannter Befehl', ['delete', '--workspace', 'intern'], undefined, /Befehl/],
  ['kein Befehl', ['--workspace', 'intern'], undefined, /Befehl/],
  ['unbekannte Option', [...LEGACY, '--comit'], undefined, /--comit/],
  ['fehlender Workspace', ['list'], undefined, /--workspace/],
  ['unbekannter Workspace', ['list', '--workspace', 'gibtsnicht'], undefined, /gibtsnicht.*gibt es nicht/],
  ['fehlendes Board', ['enable', '--workspace', 'intern'], undefined, /--board/],
  ['unbekanntes Board', ['enable', '--workspace', 'intern', '--board', 'fehlt'], undefined, /kein Board "fehlt"/],
  ['unbekanntes Quell-Board', [...WORKSPACE.slice(0, 7), '--source-board', 'fehlt'], undefined, /kein Board "fehlt"/],
  ['Board ohne Quelle', switchArgs('enable'), undefined, /keine Quelle angeschlossen/],
  ['fehlende DATABASE_URL', LEGACY, {}, /DATABASE_URL/],
]) {
  test(`${why}: Abbruch ohne Schreibzugriff`, async () => {
    const repos = fakeRepos();
    // Wo möglich mit --commit: Auch dann darf nichts geschrieben werden.
    const withCommit = argv.includes('list') ? argv : [...argv, '--commit'];
    await assert.rejects(runScript(withCommit, { env, repos }), message);
    assert.deepEqual(repos.writes, []);
  });
}

for (const [code, message] of [
  ['23505', /schon an einem anderen Board angeschlossen.*Nichts geändert/],
  ['SOURCE_IN_USE', /Nichts geändert/],
]) {
  test(`Fehler ${code} wird verständlich gemeldet`, async () => {
    const repos = fakeRepos({ upsertError: Object.assign(new Error('Belegt.'), { code }) });

    await assert.rejects(runScript([...LEGACY, '--commit'], { repos }), message);
  });
}

test('Aufruf von der Kommandozeile: Exit 1 und Meldung', () => {
  // Leerer Ordner, damit keine .env gelesen wird.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'feedback-sources-'));
  const result = spawnSync(process.execPath, [SCRIPT, ...CONNECT], {
    cwd, env: { PATH: process.env.PATH }, encoding: 'utf8',
  });
  fs.rmdirSync(cwd);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Genau eine Quelle/);
});

// ---------------------------------------------------------------------------
// Zurückschreiben
// ---------------------------------------------------------------------------

// Zwei Änderungen warten, eine hängt im Mailversand, zwei gehören nicht dazu.
const LINKS = [
  { sourceId: 'q1', pendingStatus: 'gelöst', pushStage: null },
  { sourceId: 'q1', pendingStatus: 'in Bearbeitung', pushStage: 'writing' },
  { sourceId: 'q1', pendingStatus: 'gelöst', pushStage: 'mailing' },
  { sourceId: 'q1', pendingStatus: null, pushStage: null },
  { sourceId: 'q2', pendingStatus: 'gelöst', pushStage: null },
];
const ON = { ...SOURCE, pushEnabled: true };

test('enable-push ohne --commit: Ziel anzeigen, nichts schreiben', async () => {
  const { writes, output } = await runScript(switchArgs('enable-push'), { repos: fakeRepos({ sources: [SOURCE] }) });

  assert.deepEqual(writes, []);
  for (const part of ['db.example.test:6543/roadlight', 'Board: ziel', 'legacy_app', 'Zurückschreiben: aus -> an',
    'Probelauf']) {
    assert.ok(output.includes(part), `${part} fehlt in:\n${output}`);
  }
  assertClean(output);
});

test('disable-push ohne --commit nennt, was gelöscht würde', async () => {
  const repos = fakeRepos({ sources: [ON], links: LINKS });

  const { writes, output } = await runScript(switchArgs('disable-push'), { repos });

  assert.deepEqual(writes, []);
  assert.ok(output.includes('Zurückschreiben: an -> aus'), output);
  assert.ok(output.includes('Wartende Änderungen, die gelöscht würden: 2'), output);
  assert.ok(output.includes('Laufender oder hängender Mailversand, bleibt stehen: 1'), output);
});

for (const [command, enabled, said] of [
  ['enable-push', true, 'Zurückschreiben für Board "ziel" ist an. Nachgeholt wird nichts.'],
  ['disable-push', false, 'Zurückschreiben für Board "ziel" ist aus.'],
]) {
  test(`${command} --commit setzt nur den Schalter`, async () => {
    const repos = fakeRepos({ sources: [SOURCE], links: LINKS });

    const { writes, output } = await runScript([...switchArgs(command), '--commit'], { repos });

    assert.deepEqual(writes, [['setPushEnabled', 'q1', enabled]]);
    assert.ok(output.includes(said), output);
  });
}

test('enable-push auf nicht privatem Workspace: Abbruch ohne Schreibzugriff', async () => {
  const repos = fakeRepos({ sources: [{ ...SOURCE, tenantId: 't-offen', appId: 'a-aktivziel' }] });

  await assert.rejects(
    runScript(['enable-push', '--workspace', 'offen', '--board', 'ziel', '--commit'], { repos }),
    /nur private Workspaces/
  );

  assert.deepEqual(repos.writes, []);
});

test('disable-push geht auch, wenn der Workspace nicht mehr privat ist', async () => {
  const repos = fakeRepos({ sources: [{ ...ON, tenantId: 't-offen', appId: 'a-aktivziel' }] });

  await runScript(['disable-push', '--workspace', 'offen', '--board', 'ziel', '--commit'], { repos });

  assert.deepEqual(repos.writes, [['setPushEnabled', 'q1', false]]);
});

for (const [why, argv, message] of [
  ['ohne angeschlossene Quelle', switchArgs('enable-push'), /keine Quelle angeschlossen/],
  ['mit Quelle als Option', [...switchArgs('enable-push'), '--legacy-app', 'x'], /nur bei connect/],
  ['ohne Board', ['disable-push', '--workspace', 'intern'], /--board/],
]) {
  test(`Zurückschreiben ${why}: Abbruch`, async () => {
    const repos = fakeRepos();

    await assert.rejects(runScript([...argv, '--commit'], { repos }), message);

    assert.deepEqual(repos.writes, []);
  });
}

for (const [pushEnabled, word] of [[true, 'an'], [false, 'aus']]) {
  test(`list zeigt „Zurückschreiben: ${word}“`, async () => {
    const repos = fakeRepos({ sources: [{ ...SOURCE, pushEnabled }] });

    const { writes, output } = await runScript(['list', '--workspace', 'intern'], { repos });

    assert.deepEqual(writes, []);
    assert.ok(output.includes(`Zurückschreiben: ${word}`), output);
  });
}
