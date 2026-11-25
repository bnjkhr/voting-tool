'use strict';

// Die Einstellungen hängen nur an IP und Browser-Kennung. Die gespeicherte
// Adresse darf deshalb nie in einer Antwort stehen.
const test = require('node:test');
const assert = require('node:assert/strict');
const { records, reset, seed, sentMails, startApp } = require('./fake-app');

const URL_PATH = '/api/user/notification-settings';
const IP = '203.0.113.7';
const AGENT = 'TestBrowser/1.0';
const FINGERPRINT = `${IP}_${Buffer.from(AGENT).toString('base64').slice(0, 10)}`;
const sameClient = { 'x-forwarded-for': IP, 'user-agent': AGENT };
const STORED = 'person@example.test';

let server;

test.before(async () => {
  server = await startApp();
});

test.after(() => server.close());

test.beforeEach(() => {
  reset();
  seed('userSettings', 'u1', { userFingerprint: FINGERPRINT, email: STORED, notificationsEnabled: true });
});

const read = () => server.request(URL_PATH, { headers: sameClient });
const save = (body) => server.request(URL_PATH, { method: 'PUT', headers: sameClient, body });

test('GET nennt nur, ob Benachrichtigungen an sind und eine Adresse vorliegt', async () => {
  const res = await read();

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { notificationsEnabled: true, hasEmail: true });
});

test('GET ohne gespeicherte Einstellungen', async () => {
  reset();
  const res = await read();

  assert.deepEqual(res.body, { notificationsEnabled: false, hasEmail: false });
});

for (const [label, body] of [
  ['ohne Adressfeld', { notificationsEnabled: false }],
  ['mit leerem Adressfeld', { email: '', notificationsEnabled: false }],
  ['mit Leerzeichen im Adressfeld', { email: '  ', notificationsEnabled: false }],
]) {
  test(`Speichern ${label} behält die Adresse und gibt sie nicht aus`, async () => {
    const res = await save(body);

    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { notificationsEnabled: false, hasEmail: true });
    assert.equal(records('userSettings').get('u1').email, STORED);
    assert.equal(records('userSettings').get('u1').notificationsEnabled, false);
  });
}

test('Speichern mit neuer Adresse ersetzt sie', async () => {
  const res = await save({ email: ' neu@example.test ', notificationsEnabled: true });

  assert.deepEqual(res.body, { notificationsEnabled: true, hasEmail: true });
  assert.equal(records('userSettings').get('u1').email, 'neu@example.test');
});

test('Speichern mit email: null löscht die Adresse', async () => {
  const res = await save({ email: null, notificationsEnabled: false });

  assert.deepEqual(res.body, { notificationsEnabled: false, hasEmail: false });
  assert.equal(records('userSettings').get('u1').email, null);
});

test('erstes Speichern ohne Adresse legt keinen Wert an', async () => {
  reset();
  const res = await save({ notificationsEnabled: true });

  assert.deepEqual(res.body, { notificationsEnabled: true, hasEmail: false });
  assert.equal([...records('userSettings').values()][0].email, null);
});

for (const email of ['keine-adresse', 42, false, ['a@example.test']]) {
  test(`Speichern lehnt ${JSON.stringify(email)} ab und ändert nichts`, async () => {
    const res = await save({ email, notificationsEnabled: true });

    assert.equal(res.status, 400);
    assert.equal(records('userSettings').get('u1').email, STORED);
  });
}

test('der Versand nutzt weiterhin die gespeicherte Adresse', async () => {
  seed('apps', 'legacyapp', { name: 'Altes Board' });
  seed('suggestions', 's1', {
    appId: 'legacyapp', type: 'feature', title: 'Eintrag', status: 'neu', approved: true,
    userFingerprint: FINGERPRINT,
  });

  const res = await server.request('/api/admin/suggestions/s1/status', {
    method: 'PUT',
    headers: { authorization: 'Bearer test-admin-password' },
    body: { status: 'wird umgesetzt' },
  });

  assert.equal(res.status, 200);
  assert.deepEqual(sentMails.map((mail) => mail.to).flat(), [STORED]);
});
