'use strict';

// Anlage-Skript für private Workspaces: Eingaben, Probelauf, Meldungen.
// Die Datenbank-Seite prüft tests/integration/private-workspace-postgres.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseBoards } = require('../lib/private-workspace');
const { run } = require('../scripts/create-private-workspace');
const { OwnerNotFoundError, WorkspaceExistsError } = require('../db/provisioning');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'create-private-workspace.js');
const DATABASE_URL = 'postgres://geheimnutzer:geheimwort@db.example.test:6543/roadlight?sslmode=require';
const ARGS = [
  '--slug', 'intern', '--name', 'Intern', '--email', 'Owner@Example.test',
  '--boards', 'FamilyManager:FM,Websites:WEB',
];

async function runScript(argv, { provision, env = { DATABASE_URL } } = {}) {
  const lines = [];
  const calls = [];
  await run(argv, {
    env,
    log: (line) => lines.push(line),
    provision: async (input) => {
      calls.push(input);
      if (provision) await provision(input);
    },
  });
  return { calls, output: lines.join('\n') };
}

test('parseBoards liest Name und Präfix', () => {
  assert.deepEqual(parseBoards('FamilyManager:FM, Websites:web '), [
    { name: 'FamilyManager', slug: 'familymanager', ticketPrefix: 'FM' },
    { name: 'Websites', slug: 'websites', ticketPrefix: 'WEB' },
  ]);
});

for (const [why, text, message] of [
  ['leerem Text', '', /Mindestens ein Board/],
  ['nur Trennzeichen', ' , ', /Mindestens ein Board/],
  ['fehlendem Präfix', 'FamilyManager', /Name:Präfix/],
  ['leerem Präfix', 'FamilyManager:', /Name:Präfix/],
  ['fehlendem Namen', ':FM', /Name:Präfix/],
  ['Name ohne Buchstaben oder Ziffern', '!!!:FM', /Name:Präfix/],
  ['Präfix mit Ziffer', 'FamilyManager:F1', /1 bis 5 Buchstaben/],
  ['zu langem Präfix', 'FamilyManager:FAMILY', /1 bis 5 Buchstaben/],
  ['doppeltem Slug', 'Websites:A,websites:B', /doppelt/],
  ['doppeltem Präfix', 'FamilyManager:FM,Fahrten:fm', /doppelt/],
]) {
  test(`parseBoards wirft bei ${why}`, () => {
    assert.throws(() => parseBoards(text), message);
  });
}

test('Probelauf schreibt nicht und nennt Ziel, Slug und Boards ohne Zugangsdaten', async () => {
  const { calls, output } = await runScript(ARGS);

  assert.equal(calls.length, 0);
  for (const part of ['db.example.test:6543/roadlight', 'intern', 'owner@example.test',
    'FamilyManager', 'familymanager', 'FM', 'Websites', 'WEB', '--commit']) {
    assert.ok(output.includes(part), `${part} fehlt in:\n${output}`);
  }
  for (const secret of ['geheimnutzer', 'geheimwort', 'postgres://']) {
    assert.equal(output.includes(secret), false, `${secret} darf nicht in der Ausgabe stehen`);
  }
});

test('--commit legt genau einmal an', async () => {
  const { calls, output } = await runScript([...ARGS, '--commit']);

  assert.equal(calls.length, 1);
  const { membershipId, ...input } = calls[0];
  assert.match(membershipId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(input, {
    tenantId: 'intern',
    slug: 'intern',
    name: 'Intern',
    ownerEmail: 'owner@example.test',
    boards: parseBoards('FamilyManager:FM,Websites:WEB'),
  });
  assert.match(output, /angelegt/i);
});

for (const [ErrorClass, message] of [
  [OwnerNotFoundError, /Kein aktives Konto.*Nichts geändert/s],
  [WorkspaceExistsError, /"intern" existiert bereits.*Nichts geändert/s],
]) {
  test(`${ErrorClass.name} wird verständlich gemeldet`, async () => {
    await assert.rejects(
      runScript([...ARGS, '--commit'], { provision: () => { throw new ErrorClass(); } }),
      message
    );
  });
}

for (const [why, argv, env, message] of [
  ['unbekannte Option', [...ARGS, '--comit'], undefined, /--comit/],
  ['fehlender Slug', ARGS.slice(2), undefined, /--slug/],
  ['ungültiger Slug', ['--slug', 'In Tern', ...ARGS.slice(2)], undefined, /--slug/],
  ['Slug legacy', ['--slug', 'legacy', ...ARGS.slice(2)], undefined, /--slug/],
  ['fehlender Name', ['--slug', 'intern', ...ARGS.slice(4)], undefined, /--name/],
  ['fehlende E-Mail', [...ARGS.slice(0, 4), ...ARGS.slice(6)], undefined, /--email/],
  ['ungültige E-Mail', [...ARGS.slice(0, 4), '--email', 'owner', ...ARGS.slice(6)], undefined, /--email/],
  ['fehlende DATABASE_URL', ARGS, {}, /DATABASE_URL/],
]) {
  test(`${why}: Abbruch ohne Schreibzugriff`, async () => {
    let written = false;
    await assert.rejects(
      runScript([...argv, '--commit'], { env, provision: () => { written = true; } }),
      message
    );
    assert.equal(written, false);
  });
}

// Als Programm gestartet: Port 1 nimmt keine Verbindung an, ein Probelauf darf
// sie also gar nicht erst brauchen. Das leere Arbeitsverzeichnis verhindert,
// dass eine vorhandene .env.local gelesen wird.
function runCli(argv) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'private-workspace-'));
  try {
    return spawnSync(process.execPath, [SCRIPT, ...argv], {
      cwd,
      encoding: 'utf8',
      timeout: 20000,
      env: { PATH: process.env.PATH, DATABASE_URL: 'postgres://geheimnutzer:geheimwort@127.0.0.1:1/db', PGSSLMODE: 'disable' },
    });
  } finally {
    fs.rmdirSync(cwd);
  }
}

test('Programm: Probelauf endet mit 0 und zeigt keine Zugangsdaten', () => {
  const result = runCli(ARGS);

  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes('127.0.0.1:1/db'), result.stdout);
  assert.equal(/geheim/.test(result.stdout + result.stderr), false);
});

test('Programm: fehlgeschlagene Anlage endet mit 1 ohne Zugangsdaten', () => {
  const result = runCli([...ARGS, '--commit']);

  assert.equal(result.status, 1, result.stdout);
  assert.ok(result.stderr.trim(), 'eine Meldung auf stderr');
  assert.equal(/geheim/.test(result.stdout + result.stderr), false);
});
