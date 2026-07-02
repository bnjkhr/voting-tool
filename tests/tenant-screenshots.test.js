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
  // suggestion-create, public-comment-create, admin-comment-create.
  const occurrences = apiSource.split('persistScreenshotAttachments(').length - 1;
  assert.ok(occurrences >= 4, `erwartet Helper-Definition + 3 Aufrufe (gefunden ${occurrences})`);
  assert.ok(apiSource.includes("persistScreenshotAttachments(tenant.id, 'suggestion'"));
  assert.ok(apiSource.includes("persistScreenshotAttachments(tenant.id, 'comment'"));
});

test('Lesepfade hängen Proxy-URLs an (public vs admin)', () => {
  // Public-Reads ohne admin-Flag, Admin-Reads mit true (authentifizierter Proxy).
  assert.ok(apiSource.includes("attachScreenshotUrls(suggestions, 'suggestion', tenant)"));
  assert.ok(apiSource.includes("attachScreenshotUrls(comments, 'comment', tenant)"));
  assert.ok(apiSource.includes("attachScreenshotUrls(suggestions, 'suggestion', tenant, true)"));
  assert.ok(apiSource.includes("attachScreenshotUrls(comments, 'comment', tenant, true)"));
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
  assert.ok(block.includes("c.approvalStatus === 'approved'"), 'öffentlich nur approved');
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
