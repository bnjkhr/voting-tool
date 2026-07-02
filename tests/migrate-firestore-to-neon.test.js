const test = require('node:test');
const assert = require('node:assert/strict');

// Der Auto-Run ist per require.main-Guard abgeschirmt — require löst keine
// Migration aus, nur die reinen Helfer werden geladen.
const { ts, tenantIdOf, isNonLegacy, decodeScreenshot } = require('../scripts/migrate-firestore-to-neon');

test('ts wandelt Firestore-Timestamps, {_seconds}, Dates und Nullish', () => {
  const d = new Date('2026-04-28T09:21:39.000Z');
  assert.equal(ts({ toDate: () => d }).getTime(), d.getTime());       // Firestore Timestamp
  assert.equal(ts({ _seconds: 1777539699 }).getTime(), 1777539699000); // reines {_seconds}
  assert.equal(ts(d).getTime(), d.getTime());                          // JS Date durchreichen
  assert.equal(ts(null), null);
  assert.equal(ts(undefined), null);
});

test('tenantIdOf/isNonLegacy behandeln fehlende tenantId als legacy', () => {
  assert.equal(tenantIdOf({ tenantId: 'mitko' }), 'mitko');
  assert.equal(tenantIdOf({ tenantId: '  ' }), 'legacy');   // leer -> legacy
  assert.equal(tenantIdOf({}), 'legacy');                   // fehlend -> legacy
  assert.equal(tenantIdOf({ tenantId: 'legacy' }), 'legacy');
  assert.equal(isNonLegacy({ tenantId: 'mbc' }), true);
  assert.equal(isNonLegacy({ tenantId: 'legacy' }), false);
  assert.equal(isNonLegacy({}), false);
});

test('decodeScreenshot dekodiert nur Raster-data-URLs', () => {
  const png = 'data:image/png;base64,' + Buffer.from('hi').toString('base64');
  const dec = decodeScreenshot(png);
  assert.equal(dec.contentType, 'image/png');
  assert.ok(Buffer.isBuffer(dec.data) && dec.data.toString() === 'hi');
  // SVG wird abgelehnt (kein aktives SVG von eigener Origin)
  assert.equal(decodeScreenshot('data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64')), null);
  assert.equal(decodeScreenshot('nicht-data-url'), null);
  assert.equal(decodeScreenshot(null), null);
});
