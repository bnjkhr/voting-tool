const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const apiSource = fs.readFileSync(path.join(rootDir, 'api/index.js'), 'utf8');
const attachmentsRepo = fs.readFileSync(path.join(rootDir, 'db/attachments.js'), 'utf8');
const migration = fs.readFileSync(path.join(rootDir, 'migrations/0004_attachments_inline_data.sql'), 'utf8');

// ---------------------------------------------------------------------------
// PR D: Screenshots als attachments (bytea) + Proxy-Serving im Postgres-Modus
// ---------------------------------------------------------------------------

test('die Postgres-Screenshot-Guards sind entfernt (kein stilles 400 mehr)', () => {
  assert.equal(
    apiSource.includes('Screenshots werden aktuell nicht unterstützt'),
    false,
    'die PR-D-Platzhalter-Guards dürfen nicht mehr existieren',
  );
});

test('Schreibpfade legen Screenshots als attachments an', () => {
  // Die Ablage hängt nicht mehr an jedem einzelnen Handler, sondern an den
  // beiden gemeinsamen Schreib-Helfern — dadurch kann kein Create-Pfad sie
  // mehr vergessen.
  assert.ok(apiSource.includes("persistScreenshotAttachments(tenantId, 'suggestion', suggestionId, suggestion.screenshots)"),
    'createSuggestionRecord muss die Screenshots ablegen');
  assert.ok(apiSource.includes("persistScreenshotAttachments(tenantId, 'comment', commentId, comment.screenshots)"),
    'createCommentRecord muss die Screenshots ablegen');

  // Und alle Create-Pfade laufen wirklich über die Helfer (öffentlicher Submit,
  // öffentlicher Kommentar, Admin-Kommentar, v1-Submit, v1-Kommentar).
  assert.equal(apiSource.split('createSuggestionRecord(').length - 1, 3,
    'Definition + 2 Aufrufer (öffentlicher Submit, v1)');
  assert.equal(apiSource.split('createCommentRecord(').length - 1, 4,
    'Definition + 3 Aufrufer (öffentlich, Tenant-Admin, v1)');

  // Kein tenant-fähiger Handler schreibt noch selbst gegen die Collections.
  // Übrig bleiben nur der Helper und die Legacy-Endpoints (/api/apps/:appId/…,
  // /api/suggestions/:id/comments, /api/admin/suggestions/:id/comments) — die
  // bleiben bewusst Firestore-only und dürfen NICHT über den backend-bewussten
  // Helper laufen, sonst landen Legacy-Daten nach dem Cutover in Postgres.
  assert.equal(apiSource.split("db.collection('suggestions').add(").length - 1, 2,
    'Helper + genau ein Legacy-Pfad schreiben Suggestions nach Firestore');
  assert.equal(apiSource.split("db.collection('comments').add(").length - 1, 3,
    'Helper + genau zwei Legacy-Pfade schreiben Kommentare nach Firestore');
});

test('Lesepfade hängen Proxy-URLs an (public vs admin)', () => {
  // Public-Reads ohne admin-Flag, Admin-Reads mit true (authentifizierter Proxy).
  assert.ok(apiSource.includes("attachScreenshotUrls(suggestions, 'suggestion', tenant)"));
  assert.ok(apiSource.includes("attachScreenshotUrls(comments, 'comment', tenant)"));
  assert.ok(apiSource.includes("attachScreenshotUrls(suggestions, 'suggestion', tenant, 'admin')"));
  assert.ok(apiSource.includes("attachScreenshotUrls(comments, 'comment', tenant, 'admin')"));
  // v1 liest ueber eine eigene Route — ein API-Key hat keine Admin-Session.
  assert.ok(apiSource.includes("attachScreenshotUrls(comments, 'comment', req.apiAuth.tenant, 'v1')"));
  // Ein unbekannter Scope muss laut auffallen, nicht still eine falsche URL bauen.
  assert.ok(apiSource.includes('Unbekannter Attachment-Scope'));
});

test('öffentlicher Proxy ist tenant-gescopt UND nur für freigegebene Parents', () => {
  assert.ok(
    apiSource.includes("app.get('/api/tenants/:tenantSlug/attachments/:attachmentId'"),
    'erwartet die öffentliche Proxy-Route',
  );
  assert.ok(apiSource.includes('repos.attachments.findWithData(attachmentId, tenant.id)'));
  // approved-Parent-Gate gegen geleakte URLs unmoderierter Inhalte.
  assert.ok(apiSource.includes('isAttachmentParentPublic('));
});

test('authentifizierter Admin-Proxy existiert (Moderations-Vorschau)', () => {
  assert.ok(
    apiSource.includes("app.get('/api/admin/tenants/:tenantSlug/attachments/:attachmentId', requireTenantAccess()"),
    'erwartet die authentifizierte Admin-Proxy-Route',
  );
});

test('Serving erzwingt Raster-Whitelist und nosniff (SVG-XSS-Schutz)', () => {
  assert.ok(apiSource.includes('SERVABLE_IMAGE_TYPES'));
  assert.ok(apiSource.includes("'image/png', 'image/jpeg', 'image/gif', 'image/webp'"));
  assert.ok(apiSource.includes("res.setHeader('X-Content-Type-Options', 'nosniff')"));
});

test('der öffentliche Kommentar-Lesepfad hat einen Postgres-Branch (approved-only)', () => {
  // Vor PR D war GET .../comments Firestore-only — in Postgres erstellte
  // Kommentare wären unsichtbar gewesen. Jetzt tenant- und approved-gescopt.
  const idx = apiSource.indexOf("app.get('/api/tenants/:tenantSlug/suggestions/:suggestionId/comments'");
  assert.ok(idx !== -1, 'öffentlicher Kommentar-Endpoint fehlt');
  const block = apiSource.slice(idx, idx + 1600);
  assert.ok(block.includes('usePostgres()'), 'erwartet einen Postgres-Branch');
  // Die approved-Regel liegt jetzt in comment-utils (isCommentVisibleToPublic),
  // die buildPublicCommentResponse anwendet — eine Regel für beide Backends
  // statt einer zweiten Formulierung im Postgres-Zweig.
  assert.ok(
    block.includes('.map(buildPublicCommentResponse)') && block.includes('.filter(Boolean)'),
    'öffentlich nur approved — über buildPublicCommentResponse'
  );
  const utils = fs.readFileSync(path.join(rootDir, 'api/comment-utils.js'), 'utf8');
  assert.ok(
    utils.includes('if (!isCommentVisibleToPublic(normalized)) {') && utils.includes('return null;'),
    'buildPublicCommentResponse muss nicht freigegebene Kommentare verwerfen'
  );
});

test('das attachments-Repo hält Bytes inline und lädt tenant-gescopt', () => {
  assert.ok(attachmentsRepo.includes('function findWithData(id, tenantId)'));
  assert.ok(attachmentsRepo.includes('function listForParents(parentType, parentIds, tenantId)'));
  assert.ok(/insert into attachments[\s\S]*data/.test(attachmentsRepo), 'create schreibt die data-Spalte');
});

test('Migration 0004 ergänzt data bytea und lockert storage_key', () => {
  assert.ok(/add column if not exists data bytea/.test(migration));
  assert.ok(/alter column storage_key drop not null/.test(migration));
  assert.ok(/attachments_data_or_key/.test(migration), 'Constraint: data ODER storage_key');
});

test('legacy/Firestore-Kommentarpfade bleiben unverändert (base64 inline)', () => {
  // Die nicht-tenant-Endpoints nutzen weiter buildAdminCommentResponse /
  // buildPublicCommentResponse aus dem Firestore-Doc.
  assert.ok(apiSource.includes('buildAdminCommentResponse'));
  assert.ok(apiSource.includes('buildPublicCommentResponse'));
});
