'use strict';

// Aktionen hinter den zusätzlichen MCP-Werkzeugen, mit einer Attrappe für die
// API. mcp/actions.js ist ein ES-Modul und wird deshalb per import() geladen.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let actions;

test.before(async () => {
  actions = await import('../mcp/actions.js');
});

// Attrappe: merkt sich jeden Aufruf und antwortet je "METHODE pfad".
function fakeApi(responses = {}) {
  const calls = [];
  const api = async (method, url, body) => {
    calls.push({ method, url, body });
    const response = responses[`${method} ${url}`];
    if (response instanceof Error) throw response;
    return response === undefined ? { ok: true } : response;
  };
  return { api, calls };
}

const entry = (id, ticketNumber, overrides = {}) => ({
  id,
  ticketNumber,
  type: 'ticket',
  status: 'offen',
  priority: 'mittel',
  title: `Titel ${id}`,
  description: 'Beschreibung',
  labels: [],
  votes: 0,
  ...overrides,
});

test('CLOSED_STATUSES entspricht RESOLVED_STATUSES der API', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'api', 'index.js'), 'utf8');
  const list = source.match(/^const RESOLVED_STATUSES = \[([^\]]*)\];/m);
  assert.ok(list, 'RESOLVED_STATUSES nicht gefunden');
  const resolved = [...list[1].matchAll(/'([^']*)'/g)].map(([, status]) => status);

  assert.deepEqual([...actions.CLOSED_STATUSES].sort(), resolved.sort());
});

test('listOpen lässt Erledigtes weg und sortiert nach Priorität, dann Ticketnummer', async () => {
  const { api, calls } = fakeApi({
    'GET /apps': [{ slug: 'familymanager' }, { slug: 'websites' }],
    'GET /apps/familymanager/suggestions': [
      entry('a', 'FM-010', { priority: 'niedrig' }),
      entry('b', 'FM-002', { priority: 'hoch', labels: ['ios'] }),
      entry('c', 'FM-003', { status: 'ist umgesetzt', priority: 'kritisch' }),
      entry('d', 'FM-004', { status: 'wird nicht umgesetzt' }),
      entry('e', 'FM-1000', { priority: 'hoch' }),
    ],
    'GET /apps/websites/suggestions': [
      entry('f', 'WEB-001', { status: 'gelöst' }),
      entry('g', 'WEB-002', { status: 'geschlossen' }),
      entry('h', 'WEB-003', { priority: 'kritisch', type: 'bug', status: 'neu' }),
      entry('i', 'WEB-004'),
    ],
  });

  const result = await actions.listOpen(api, {});

  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.items.map((item) => item.ticketNumber),
    ['WEB-003', 'FM-002', 'FM-1000', 'WEB-004', 'FM-010']);
  assert.deepEqual(result.items[1], {
    id: 'b',
    ticketNumber: 'FM-002',
    board: 'familymanager',
    type: 'ticket',
    status: 'offen',
    priority: 'hoch',
    title: 'Titel b',
    labels: ['ios'],
  });
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'GET', 'GET']);
});

test('listOpen mit appSlug fragt nur dieses Board ab, Slug kodiert', async () => {
  const { api, calls } = fakeApi({ 'GET /apps/a%2Fb/suggestions': [entry('a', 'AB-001')] });

  const result = await actions.listOpen(api, { appSlug: 'a/b' });

  assert.deepEqual(calls.map((call) => call.url), ['/apps/a%2Fb/suggestions']);
  assert.deepEqual(result.items.map((item) => [item.board, item.id]), [['a/b', 'a']]);
});

test('listOpen: ein fehlerhaftes Board steht in errors, die anderen in items', async () => {
  const { api } = fakeApi({
    'GET /apps': [{ slug: 'kaputt' }, { slug: 'websites' }, { slug: 'seltsam' }],
    'GET /apps/kaputt/suggestions': new Error('GET /apps/kaputt/suggestions → Failed to load suggestions'),
    'GET /apps/websites/suggestions': [entry('a', 'WEB-001')],
    'GET /apps/seltsam/suggestions': '<html>falsche Adresse</html>',
  });

  const result = await actions.listOpen(api, {});

  assert.deepEqual(result.items.map((item) => item.id), ['a']);
  assert.deepEqual(result.errors.map((error) => error.board), ['kaputt', 'seltsam']);
  assert.match(result.errors[0].message, /Failed to load suggestions/);
  assert.ok(result.errors[1].message);
});

test('listOpen: scheitert schon die Board-Liste, gibt es keine leere Erfolgsliste', async () => {
  const failing = fakeApi({ 'GET /apps': new Error('GET /apps → Invalid API key') });
  await assert.rejects(actions.listOpen(failing.api, {}), /Invalid API key/);

  const strange = fakeApi({ 'GET /apps': '<html></html>' });
  await assert.rejects(actions.listOpen(strange.api, {}), /Board-Liste/);
});

test('createBoard', async () => {
  const { api, calls } = fakeApi();

  await actions.createBoard(api, { name: 'Websites', slug: 'websites', ticketPrefix: 'WEB' });

  assert.deepEqual(calls, [{
    method: 'POST', url: '/apps',
    body: { boardName: 'Websites', boardSlug: 'websites', ticketPrefix: 'WEB' },
  }]);
});

test('listReleases mit und ohne Status', async () => {
  const { api, calls } = fakeApi();

  await actions.listReleases(api, { appSlug: 'a/b' });
  await actions.listReleases(api, { appSlug: 'websites', status: 'in Arbeit' });

  assert.deepEqual(calls.map((call) => [call.method, call.url]), [
    ['GET', '/apps/a%2Fb/releases'],
    ['GET', '/apps/websites/releases?status=in+Arbeit'],
  ]);
});

test('createRelease', async () => {
  const { api, calls } = fakeApi();
  const fields = {
    version: '1.2', title: 'Herbst', description: 'Neues', status: 'geplant', releaseDate: '2026-12-01',
  };

  await actions.createRelease(api, { appSlug: 'a/b', ...fields });

  assert.deepEqual(calls, [{ method: 'POST', url: '/apps/a%2Fb/releases', body: fields }]);
});

test('updateRelease sendet nur die übergebenen Felder', async () => {
  const { api, calls } = fakeApi();

  await actions.updateRelease(api, { releaseId: 'r/1', status: 'veröffentlicht', releaseDate: null });

  assert.deepEqual(calls, [{
    method: 'PATCH', url: '/releases/r%2F1',
    body: { status: 'veröffentlicht', releaseDate: null },
  }]);
});

test('assignRelease ordnet zu und löst mit releaseId null', async () => {
  const { api, calls } = fakeApi();

  await actions.assignRelease(api, { suggestionId: 's/1', releaseId: 'r1' });
  await actions.assignRelease(api, { suggestionId: 's1', releaseId: null });

  assert.deepEqual(calls, [
    { method: 'PUT', url: '/suggestions/s%2F1/release', body: { releaseId: 'r1' } },
    { method: 'PUT', url: '/suggestions/s1/release', body: { releaseId: null } },
  ]);
});
