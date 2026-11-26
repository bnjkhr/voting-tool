'use strict';

// Gespeichert werden nur Raster-Bilder als reine Base64-Data-URL.
const test = require('node:test');
const assert = require('node:assert/strict');
const { records, reset, seed, startApp } = require('./fake-app');
const { validateCommentScreenshots } = require('../api/comment-utils');

const VALID = [
  'data:image/png;base64,iVBORw0KGgo=',
  'data:image/jpeg;base64,/9j/4AAQSkZJRg==',
  'data:image/gif;base64,R0lGODlh',
  'data:image/webp;base64,UklGRg+/',
];

const INVALID = [
  'data:image/svg+xml;base64,PHN2Zy8+',
  'data:image/png;base64,AAAA" data-x="1',
  "data:image/png;base64,AAAA' data-x='1",
  'data:image/png;base64,AAAA><b>',
  'data:image/png;base64,AAAA\n',
  'data:image/png;base64,',
  'data:image/png,AAAA',
  'data:image/png;charset=utf-8;base64,AAAA',
  'data:text/html;base64,AAAA',
  ' data:image/png;base64,AAAA',
  'https://example.test/bild.png',
];

test('Kommentar-Screenshots: nur Raster-Bilder mit reinem Base64', () => {
  for (const screenshot of VALID) {
    assert.deepEqual(validateCommentScreenshots([screenshot]), { screenshots: [screenshot] }, screenshot);
  }
  for (const screenshot of INVALID) {
    assert.deepEqual(validateCommentScreenshots([screenshot]), { screenshots: [] }, JSON.stringify(screenshot));
  }
});

let server;

test.before(async () => {
  server = await startApp();
});

test.after(() => server.close());

test.beforeEach(() => {
  reset();
  seed('apps', 'legacyapp', { name: 'Altes Board' });
  seed('suggestions', 's1', { appId: 'legacyapp', approved: true, title: 'Eintrag', type: 'feature' });
});

const stored = (name) => [...records(name).values()];

test('öffentlicher Kommentar speichert nur gültige Screenshots', async () => {
  const res = await server.request('/api/suggestions/s1/comments', {
    method: 'POST',
    body: { text: 'Siehe Bild', screenshots: [VALID[0], INVALID[0], INVALID[1]] },
  });

  assert.equal(res.status, 201);
  assert.deepEqual(stored('comments')[0].screenshots, [VALID[0]]);
});

test('Bug-Meldung speichert nur gültige Screenshots', async () => {
  const res = await server.request('/api/apps/legacyapp/suggestions', {
    method: 'POST',
    body: {
      type: 'bug',
      title: 'Absturz',
      description: 'Beim Start',
      severity: 'high',
      stepsToReproduce: 'Öffnen',
      expectedBehavior: 'Läuft',
      actualBehavior: 'Stürzt ab',
      screenshots: [INVALID[1], VALID[1], INVALID[0]],
    },
  });

  assert.equal(res.status, 201);
  const created = stored('suggestions').find((entry) => entry.title === 'Absturz');
  assert.deepEqual(created.screenshots, [VALID[1]]);
});
