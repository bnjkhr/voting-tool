'use strict';

// Tickets im Board der Konsole anlegen: wer darf, was angenommen wird und was
// gespeichert wird. Firestore und Mailversand liegen im Speicher.
const test = require('node:test');
const assert = require('node:assert/strict');
const { dump, records, reset, seed, sentMails, startApp } = require('./fake-app');
const { buildInviteTokenHash } = require('../api/team-utils');

const ONLY_PRIVATE = { error: 'Anlegen gibt es nur in privaten Workspaces.' };
const ROLES = ['owner', 'admin', 'viewer'];
const as = (user) => ({ 'x-user-session': `session-${user}` });

let server;

test.before(async () => {
  server = await startApp();
});

test.after(() => server.close());

test.beforeEach(() => {
  reset();
  seed('tenants', 't-intern', { slug: 'intern', status: 'private', name: 'Intern', plan: 'pro' });
  seed('tenants', 't-offen', { slug: 'offen', status: 'active', name: 'Offen', plan: 'pro' });
  seed('tenants', 't-aus', { slug: 'aus', status: 'suspended', name: 'Aus', plan: 'pro' });
  seed('apps', 'app-intern', { tenantId: 't-intern', slug: 'web', name: 'Web', ticketPrefix: 'IN' });
  seed('apps', 'app-offen', { tenantId: 't-offen', slug: 'web', name: 'Web', ticketPrefix: 'OF' });
  seed('apps', 'app-aus', { tenantId: 't-aus', slug: 'web', name: 'Web', ticketPrefix: 'AU' });
  for (const user of [...ROLES, 'fremd']) {
    seed('users', `u-${user}`, { email: `${user}@example.test`, status: 'active' });
    seed('sessions', `sess-${user}`, {
      userId: `u-${user}`,
      status: 'active',
      tokenHash: buildInviteTokenHash(`session-${user}`),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
    });
  }
  for (const tenantId of ['t-intern', 't-offen', 't-aus']) {
    for (const role of ROLES) {
      seed('memberships', `m-${tenantId}-${role}`, { tenantId, userId: `u-${role}`, role, status: 'active' });
    }
  }
});

const ticket = (fields = {}) => ({ appId: 'app-intern', title: 'Export als PDF', ...fields });
const create = (body, { slug = 'intern', headers = as('owner') } = {}) => server.request(
  `/api/admin/tenants/${slug}/suggestions`,
  { method: 'POST', body, headers },
);
const stored = () => [...records('suggestions').values()];

// Alles, was ein abgelehnter Aufruf nicht anfassen darf, auch nicht den Zähler.
const written = () => {
  const { suggestions, activity, counters } = dump();
  return { suggestions, activity, counters };
};
const NOTHING = { suggestions: undefined, activity: undefined, counters: undefined };

for (const role of ['owner', 'admin']) {
  test(`${role} legt ein Ticket an: 201 mit id und Ticketnummer`, async () => {
    const res = await create(ticket(), { headers: as(role) });

    assert.equal(res.status, 201, res.text);
    assert.deepEqual(Object.keys(res.body).sort(), ['id', 'ticketNumber']);
    assert.equal(res.body.ticketNumber, 'IN-001');
    assert.equal(records('suggestions').has(res.body.id), true);
  });
}

for (const [who, headers, status] of [
  ['viewer', as('viewer'), 403],
  ['fremde Person', as('fremd'), 403],
  ['ohne Anmeldung', {}, 401],
  ['mit unbekannter Sitzung', as('gibtsnicht'), 401],
]) {
  test(`${who}: ${status}, nichts wird geschrieben`, async () => {
    const res = await create(ticket(), { headers });

    assert.equal(res.status, status, res.text);
    assert.deepEqual(written(), NOTHING);
  });
}

test('Öffentlicher Workspace: 403 mit Begründung, nichts wird geschrieben', async () => {
  const res = await create(ticket({ appId: 'app-offen' }), { slug: 'offen' });

  assert.equal(res.status, 403, res.text);
  assert.deepEqual(res.body, ONLY_PRIVATE);
  assert.deepEqual(written(), NOTHING);
});

test('Gesperrter Workspace: nicht gefunden, nichts wird geschrieben', async () => {
  const res = await create(ticket({ appId: 'app-aus' }), { slug: 'aus' });

  assert.equal(res.status, 404, res.text);
  assert.deepEqual(written(), NOTHING);
});

for (const [what, appId] of [
  ['Board eines anderen Workspaces', 'app-offen'],
  ['unbekanntes Board', 'gibtsnicht'],
  ['Board fehlt', undefined],
  ['Board keine Zeichenkette', ['app-intern']],
]) {
  test(`${what}: 404, nichts wird geschrieben`, async () => {
    const res = await create(ticket({ appId }));

    assert.equal(res.status, 404, res.text);
    assert.deepEqual(res.body, { error: 'Board nicht gefunden.' });
    assert.deepEqual(written(), NOTHING);
  });
}

for (const [what, fields] of [
  ['Titel fehlt', { title: undefined }],
  ['Titel leer', { title: '' }],
  ['Titel nur Leerzeichen', { title: '   ' }],
  ['Titel mit 101 Zeichen', { title: 'a'.repeat(101) }],
  ['Titel keine Zeichenkette', { title: 42 }],
  ['Titel über zwei Zeilen', { title: 'eins\nzwei' }],
  ['Titel mit Nullzeichen', { title: 'a\u0000b' }],
  ['Beschreibung mit 1001 Zeichen', { description: 'a'.repeat(1001) }],
  ['Beschreibung keine Zeichenkette', { description: ['a'] }],
  ['Beschreibung null', { description: null }],
  ['Beschreibung mit Nullzeichen', { description: 'a\u0000b' }],
  ['unbekannte Priorität', { priority: 'dringend' }],
  ['Priorität groß geschrieben', { priority: 'Hoch' }],
  ['leere Priorität', { priority: '' }],
  ['Priorität null', { priority: null }],
  ['Status „neu“', { status: 'neu' }],
  ['Status „gelöst“', { status: 'gelöst' }],
  ['Status „geschlossen“', { status: 'geschlossen' }],
  ['Status eines Features', { status: 'wird geprüft' }],
  ['leerer Status', { status: '' }],
  ['Status null', { status: null }],
]) {
  test(`${what}: 400 mit Meldung, nichts wird geschrieben`, async () => {
    const res = await create(ticket(fields));

    assert.equal(res.status, 400, res.text);
    assert.equal(typeof res.body.error, 'string');
    assert.deepEqual(written(), NOTHING);
  });
}

test('Gespeichert wird ein freigegebenes Ticket ohne Mailadresse', async () => {
  const res = await create(ticket({ title: '  Export als PDF  ', description: '  Zwei\nZeilen  ', priority: 'hoch' }));

  assert.equal(res.status, 201, res.text);
  const { createdAt, approvedAt, ...saved } = records('suggestions').get(res.body.id);
  assert.deepEqual(saved, {
    tenantId: 't-intern',
    appId: 'app-intern',
    type: 'ticket',
    title: 'Export als PDF',
    description: 'Zwei\nZeilen',
    status: 'offen',
    tag: 'neu',
    priority: 'hoch',
    labels: [],
    votes: 0,
    approved: true,
    notificationEnabled: false,
    notificationEmail: null,
    userFingerprint: 'api:console',
    ticketNumber: 'IN-001',
  });
  assert.ok(createdAt instanceof Date);
  assert.ok(approvedAt instanceof Date);
});

for (const [what, fields] of [['ohne Angabe', {}], ['leer', { description: '' }], ['nur Leerzeichen', { description: '  ' }]]) {
  test(`Beschreibung ${what} bleibt leer, Priorität ist „mittel“, Status „offen“`, async () => {
    const res = await create(ticket(fields));

    assert.equal(res.status, 201, res.text);
    const saved = records('suggestions').get(res.body.id);
    assert.deepEqual([saved.description, saved.priority, saved.status], ['', 'mittel', 'offen']);
  });
}

for (const [status, tag] of [
  ['offen', 'neu'], ['in Bearbeitung', 'in analyse'], ['im Test', 'in analyse'], ['wartend', null],
]) {
  test(`Status „${status}“ mit passendem Legacy-Tag`, async () => {
    const res = await create(ticket({ status }));

    assert.equal(res.status, 201, res.text);
    const saved = records('suggestions').get(res.body.id);
    assert.deepEqual([saved.status, saved.tag], [status, tag]);
  });
}

for (const priority of ['niedrig', 'mittel', 'hoch', 'kritisch']) {
  test(`Priorität „${priority}“ wird übernommen`, async () => {
    const res = await create(ticket({ priority }));

    assert.equal(records('suggestions').get(res.body.id).priority, priority);
  });
}

test('Titel mit 100 und Beschreibung mit 1000 Zeichen werden angenommen', async () => {
  const res = await create(ticket({ title: 'a'.repeat(100), description: 'b'.repeat(1000) }));

  assert.equal(res.status, 201, res.text);
});

test('Spitze Klammern bleiben Text und werden nicht entfernt', async () => {
  const title = '<img src=x> bei Breite < 400 > 300';
  const res = await create(ticket({ title, description: '<b>fett</b>' }));

  const saved = records('suggestions').get(res.body.id);
  assert.deepEqual([saved.title, saved.description], [title, '<b>fett</b>']);
});

test('Ticketnummern zählen je Board weiter', async () => {
  const first = await create(ticket());
  const second = await create(ticket());

  assert.deepEqual([first.body.ticketNumber, second.body.ticketNumber], ['IN-001', 'IN-002']);
  assert.equal(stored().length, 2);
});

test('Aktivität „created“ am neuen Ticket', async () => {
  const res = await create(ticket());

  const activity = [...records('activity').values()];
  assert.equal(activity.length, 1);
  assert.equal(activity[0].ticketId, res.body.id);
  assert.equal(activity[0].tenantId, 't-intern');
  assert.equal(activity[0].action, 'created');
  assert.equal(activity[0].detail, 'Ticket "Export als PDF" in der Konsole erstellt');
});

test('Es geht keine Mail raus, auch nicht an Admins', async () => {
  await create(ticket({ priority: 'kritisch' }));

  assert.equal(sentMails.length, 0);
});

const fromAddress = (ip) => ({ ...as('owner'), 'x-forwarded-for': ip });
const fetchFeedback = (headers) => server.request(
  '/api/admin/tenants/intern/feedback/fetch',
  { method: 'POST', body: {}, headers },
);

test('30 Tickets je Minute, danach 429; andere begrenzte Routen bleiben frei', async () => {
  const headers = fromAddress('203.0.113.7');
  for (let i = 0; i < 30; i += 1) {
    assert.equal((await create(ticket(), { headers })).status, 201, `Ticket ${i + 1}`);
  }

  assert.equal((await create(ticket(), { headers })).status, 429);
  assert.equal(stored().length, 30);
  assert.notEqual((await fetchFeedback(headers)).status, 429);
});

test('Ausgeschöpftes „Feedback holen“ sperrt das Anlegen nicht', async () => {
  const headers = fromAddress('203.0.113.8');
  for (let i = 0; i < 10; i += 1) await fetchFeedback(headers);
  assert.equal((await fetchFeedback(headers)).status, 429);

  assert.equal((await create(ticket(), { headers })).status, 201);
});
