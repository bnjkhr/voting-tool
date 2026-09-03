'use strict';

// End-to-End-Test des öffentlichen v1-API gegen eine echte Postgres-DB, mit
// DATA_BACKEND=postgres. Deckt genau den Failure Mode ab, den die reinen
// Quelltext-Tests nicht sehen können: Vorher lasen/schrieben mehrere
// v1-Handler unbedingt gegen Firestore. Unter DATA_BACKEND=postgres hätte sich
// ein in Postgres angelegter API-Key gar nicht erst authentifizieren können,
// und ein per API angelegter Eintrag hätte seine Ticketnummer aus Postgres
// bezogen, das Dokument aber nach Firestore geschrieben.
//
// Firebase Admin wird mit einem Wegwerf-Schlüsselpaar initialisiert: die
// Initialisierung ist lazy und stellt keine Verbindung her. Schlägt hier
// irgendein Pfad doch auf Firestore durch, scheitert der Request sichtbar —
// genau das ist die Aussage dieses Tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { hasDatabase } = require('./helpers');

const suite = hasDatabase ? test : test.skip;

const T = 'test_v1_tenant';
const T2 = 'test_v1_other_tenant';
const T_INACTIVE = 'test_v1_inactive_tenant';
const A = 'test_v1_app';

async function cleanup() {
  const { query } = require('../../db/pool');
  for (const tenantId of [T, T2, T_INACTIVE]) {
    await query('delete from activity where tenant_id = $1', [tenantId]);
    await query('delete from tenants where id = $1', [tenantId]); // cascade: apps, suggestions, comments, api_keys, attachments
  }
}

// Bootet die echte Express-App auf einem freien Port und liefert einen
// fetch-Helper, der Authorization und JSON-Parsing kapselt.
function bootApp() {
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  process.env.FIREBASE_PROJECT_ID = 'test-no-firestore';
  process.env.FIREBASE_CLIENT_EMAIL = 'test@test-no-firestore.iam.gserviceaccount.com';
  process.env.FIREBASE_PRIVATE_KEY = privateKey;
  // Der Schalter, um den es geht. Muss vor dem require gesetzt sein.
  process.env.DATA_BACKEND = 'postgres';
  // Pro-Gating aus lassen: hier geht es um den Backend-Pfad, nicht um Billing.
  delete process.env.BILLING_ENFORCED;

  const app = require('../../api/index.js');
  const server = app.listen(0);

  return new Promise((resolve) => {
    server.once('listening', () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        server,
        async call(method, path, { token, body } = {}) {
          const res = await fetch(`${base}${path}`, {
            method,
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
          });
          const text = await res.text();
          let json = null;
          try { json = JSON.parse(text); } catch (_) { /* nicht-JSON sichtbar lassen */ }
          return { status: res.status, body: json, raw: text };
        },
      });
    });
  });
}

suite('v1 API gegen Postgres (DATA_BACKEND=postgres)', async (t) => {
  const { query } = require('../../db/pool');
  const { hashApiKeyToken, generateApiKeyToken } = require('../../api/api-key-utils');

  t.after(cleanup);
  await cleanup();

  // --- Seed: zwei aktive Tenants + ein inaktiver, ein Board, drei Keys ---
  await query("insert into tenants (id, name, slug, status) values ($1,'V1','test-v1','active')", [T]);
  await query("insert into tenants (id, name, slug, status) values ($1,'V1 Other','test-v1-other','active')", [T2]);
  await query("insert into tenants (id, name, slug, status) values ($1,'V1 Off','test-v1-off','suspended')", [T_INACTIVE]);
  await query(
    "insert into apps (id, tenant_id, name, slug, ticket_prefix) values ($1,$2,'Board','board','V1')",
    [A, T]
  );

  const fullToken = generateApiKeyToken();
  const readOnlyToken = generateApiKeyToken();
  const revokedToken = generateApiKeyToken();
  const inactiveTenantToken = generateApiKeyToken();

  async function seedKey(id, tenantId, token, scopes, revoked = false) {
    await query(
      `insert into api_keys (id, tenant_id, name, scopes, token_hash, token_prefix, revoked_at)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [id, tenantId, id, scopes, hashApiKeyToken(token), token.slice(0, 14), revoked ? new Date() : null]
    );
  }

  const ALL_SCOPES = ['suggestions:read', 'suggestions:write', 'suggestions:status', 'comments:read', 'comments:write'];
  await seedKey('test_v1_key_full', T, fullToken, ALL_SCOPES);
  await seedKey('test_v1_key_read', T, readOnlyToken, ['suggestions:read']);
  await seedKey('test_v1_key_revoked', T, revokedToken, ALL_SCOPES, true);
  await seedKey('test_v1_key_inactive', T_INACTIVE, inactiveTenantToken, ALL_SCOPES);

  const { server, call } = await bootApp();
  t.after(() => new Promise((resolve) => server.close(resolve)));

  // -------------------------------------------------------------------------
  // Authentifizierung: der Kern des Bugs — ein in Postgres angelegter Key
  // konnte sich vorher gar nicht anmelden (Lookup ging nur gegen Firestore).
  // -------------------------------------------------------------------------
  await t.test('ein in Postgres angelegter Key authentifiziert sich', async () => {
    const res = await call('GET', '/api/v1/me', { token: fullToken });
    assert.equal(res.status, 200, `erwartet 200, bekam ${res.status}: ${res.raw}`);
    assert.equal(res.body.tenant.id, T);
    assert.equal(res.body.tenant.slug, 'test-v1');
    assert.deepEqual(res.body.key.scopes.sort(), [...ALL_SCOPES].sort());
  });

  await t.test('lastUsedAt wird nach einem Request fortgeschrieben', async () => {
    // Fire-and-forget im Handler — kurz nachfassen statt sofort zu lesen.
    for (let i = 0; i < 20; i++) {
      const { rows } = await query('select last_used_at from api_keys where id = $1', ['test_v1_key_full']);
      if (rows[0].last_used_at) return;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.fail('last_used_at wurde nicht gesetzt');
  });

  await t.test('unbekannter, widerrufener und fehlender Key werden abgewiesen', async () => {
    assert.equal((await call('GET', '/api/v1/me')).status, 401, 'ohne Header');
    assert.equal((await call('GET', '/api/v1/me', { token: 'vt_live_nichtvergeben' })).status, 401, 'unbekannt');
    const revoked = await call('GET', '/api/v1/me', { token: revokedToken });
    assert.equal(revoked.status, 401);
    assert.match(revoked.body.error, /revoked/i);
  });

  await t.test('Key eines inaktiven Tenants wird abgewiesen (403)', async () => {
    const res = await call('GET', '/api/v1/me', { token: inactiveTenantToken });
    assert.equal(res.status, 403, `erwartet 403, bekam ${res.status}: ${res.raw}`);
    assert.match(res.body.error, /tenant inactive or missing/i);
  });

  await t.test('fehlender Scope liefert 403 mit Scope-Namen', async () => {
    const res = await call('POST', '/api/v1/apps/board/suggestions', {
      token: readOnlyToken,
      body: { type: 'feature', title: 'Nope', description: 'Nope' },
    });
    assert.equal(res.status, 403);
    assert.match(res.body.error, /suggestions:write/);
  });

  // -------------------------------------------------------------------------
  // Boards + Suggestions
  // -------------------------------------------------------------------------
  await t.test('GET /api/v1/apps listet die Boards des Key-Tenants', async () => {
    const res = await call('GET', '/api/v1/apps', { token: fullToken });
    assert.equal(res.status, 200, res.raw);
    assert.deepEqual(res.body.map((a) => a.slug), ['board']);
    assert.equal(res.body[0].ticketPrefix, 'V1');
  });

  let createdId;
  await t.test('POST legt den Eintrag wirklich in Postgres an (Ticketnummer + Zeile)', async () => {
    const res = await call('POST', '/api/v1/apps/board/suggestions', {
      token: fullToken,
      body: { type: 'feature', title: 'Dark Mode', description: 'Bitte dunkel' },
    });
    assert.equal(res.status, 201, `erwartet 201, bekam ${res.status}: ${res.raw}`);
    // Ticketnummer stammt aus apps.next_ticket_number — vorher wurde sie zwar
    // dort gezogen, die Zeile aber nach Firestore geschrieben.
    assert.equal(res.body.ticketNumber, 'V1-001');
    createdId = res.body.id;

    const { rows } = await query('select * from suggestions where id = $1', [createdId]);
    assert.equal(rows.length, 1, 'die Zeile muss in Postgres liegen, nicht in Firestore');
    assert.equal(rows[0].tenant_id, T);
    assert.equal(rows[0].app_id, A);
    assert.equal(rows[0].ticket_number, 'V1-001');
    assert.equal(rows[0].approved, true, 'via API erstellte Einträge sind direkt freigegeben');
    assert.ok(rows[0].approved_at, 'approved ohne approved_at wäre eine halbfertige Zeile');

    // Der Zähler ist tatsächlich weitergelaufen (kein doppeltes V1-001).
    const second = await call('POST', '/api/v1/apps/board/suggestions', {
      token: fullToken,
      body: { type: 'ticket', title: 'Zweites', description: 'Noch eins', priority: 'hoch' },
    });
    assert.equal(second.status, 201, second.raw);
    assert.equal(second.body.ticketNumber, 'V1-002');
    assert.equal(second.body.priority, 'hoch');
  });

  await t.test('Activity-Log landet in Postgres mit api:<keyId> als Actor', async () => {
    const { rows } = await query(
      "select * from activity where ticket_id = $1 and action = 'created'", [createdId]
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor, 'api:test_v1_key_full');
    assert.equal(rows[0].tenant_id, T);
  });

  await t.test('GET listet aus Postgres und filtert nach type/status/approved', async () => {
    const all = await call('GET', '/api/v1/apps/board/suggestions', { token: fullToken });
    assert.equal(all.status, 200, all.raw);
    assert.equal(all.body.length, 2);

    const features = await call('GET', '/api/v1/apps/board/suggestions?type=feature', { token: fullToken });
    assert.deepEqual(features.body.map((s) => s.title), ['Dark Mode']);

    const neu = await call('GET', '/api/v1/apps/board/suggestions?status=neu', { token: fullToken });
    assert.equal(neu.body.length, 2);

    const notApproved = await call('GET', '/api/v1/apps/board/suggestions?approved=false', { token: fullToken });
    assert.equal(notApproved.body.length, 0, 'API-Einträge sind approved');
  });

  await t.test('PATCH schreibt Status/Priorität/Labels nach Postgres', async () => {
    const res = await call('PATCH', `/api/v1/suggestions/${createdId}`, {
      token: fullToken,
      body: { status: 'wird umgesetzt', priority: 'kritisch', labels: ['ui', ' design '] },
    });
    assert.equal(res.status, 200, `erwartet 200, bekam ${res.status}: ${res.raw}`);
    assert.equal(res.body.status, 'wird umgesetzt');
    assert.equal(res.body.priority, 'kritisch');

    const { rows } = await query('select * from suggestions where id = $1', [createdId]);
    assert.equal(rows[0].status, 'wird umgesetzt');
    assert.equal(rows[0].priority, 'kritisch');
    assert.deepEqual(rows[0].labels, ['ui', 'design'], 'Labels werden getrimmt als text[] gespeichert');
    // tagUpdatedAt kam als Firestore-Sentinel — in Postgres muss ein echtes
    // Datum stehen, kein serialisiertes Objekt.
    assert.ok(rows[0].tag_updated_at instanceof Date);

    const statusEntry = await query(
      "select * from activity where ticket_id = $1 and action = 'status_changed'", [createdId]
    );
    assert.equal(statusEntry.rows.length, 1);
    assert.equal(statusEntry.rows[0].new_value, 'wird umgesetzt');
  });

  await t.test('PATCH mit ungültigem Status ändert nichts', async () => {
    const res = await call('PATCH', `/api/v1/suggestions/${createdId}`, {
      token: fullToken, body: { status: 'quatsch' },
    });
    assert.equal(res.status, 400);
    const { rows } = await query('select status from suggestions where id = $1', [createdId]);
    assert.equal(rows[0].status, 'wird umgesetzt', 'Status darf unverändert bleiben');
  });

  // -------------------------------------------------------------------------
  // Kommentare
  // -------------------------------------------------------------------------
  await t.test('POST/GET Kommentare laufen über Postgres', async () => {
    const created = await call('POST', `/api/v1/suggestions/${createdId}/comments`, {
      token: fullToken, body: { text: 'Kommt in 2.0' },
    });
    assert.equal(created.status, 201, `erwartet 201, bekam ${created.status}: ${created.raw}`);

    const { rows } = await query('select * from comments where id = $1', [created.body.id]);
    assert.equal(rows.length, 1, 'Kommentar muss in Postgres liegen');
    assert.equal(rows[0].tenant_id, T);
    assert.equal(rows[0].suggestion_id, createdId);
    assert.equal(rows[0].approval_status, 'approved', 'API-Kommentare sind Admin-Kommentare');
    assert.equal(rows[0].approved_by, 'api:test_v1_key_full');

    const list = await call('GET', `/api/v1/suggestions/${createdId}/comments`, { token: fullToken });
    assert.equal(list.status, 200, list.raw);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].text, 'Kommt in 2.0');
    assert.equal(list.body[0].authorType, 'admin');
    assert.deepEqual(list.body[0].screenshots, []);
  });

  await t.test('Kommentar-Screenshots landen als attachments-Zeilen', async () => {
    // 1x1 PNG
    const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const created = await call('POST', `/api/v1/suggestions/${createdId}/comments`, {
      token: fullToken, body: { text: 'Mit Bild', screenshots: [png] },
    });
    assert.equal(created.status, 201, created.raw);

    const { rows } = await query(
      "select * from attachments where parent_type = 'comment' and parent_id = $1", [created.body.id]
    );
    assert.equal(rows.length, 1, 'Screenshot muss als attachments-Zeile persistiert werden');
    assert.equal(rows[0].content_type, 'image/png');
    assert.equal(rows[0].tenant_id, T);

    // Schon die 201-Antwort liefert die kanonische Form (Proxy-URL), nicht das
    // hochgeladene base64 zurück — sonst wären es bis zu 800 KB Echo, und die
    // Antwort hätte eine andere Form als das nachfolgende GET.
    assert.equal(created.body.screenshots.length, 1);
    assert.match(created.body.screenshots[0], /\/attachments\/[0-9a-f-]{36}$/,
      'POST-Antwort spiegelt kein base64 zurück');
    assert.equal(created.body.screenshots[0].startsWith('data:'), false);

    const list = await call('GET', `/api/v1/suggestions/${createdId}/comments`, { token: fullToken });
    const withImage = list.body.find((c) => c.text === 'Mit Bild');
    assert.equal(withImage.screenshots.length, 1);
    assert.match(withImage.screenshots[0], /\/attachments\/[0-9a-f-]{36}$/,
      'statt base64 kommt eine Proxy-URL zurück');
    assert.deepEqual(created.body.screenshots, withImage.screenshots,
      'POST und GET liefern dieselbe URL');
  });

  // -------------------------------------------------------------------------
  // Tenant-Isolation — der Schutz muss auch im Postgres-Zweig greifen.
  // -------------------------------------------------------------------------
  await t.test('fremde Boards und Einträge sind für den Key unsichtbar (404)', async () => {
    await query(
      "insert into apps (id, tenant_id, name, slug, ticket_prefix) values ('test_v1_app2',$1,'Fremd','board','X')",
      [T2]
    );
    await query(
      "insert into suggestions (id, tenant_id, app_id, type, title) values ('test_v1_s_other',$1,'test_v1_app2','feature','Fremd')",
      [T2]
    );

    // Gleicher Slug, anderer Tenant: findTenantAppBySlug muss tenant-gescopt sein.
    const apps = await call('GET', '/api/v1/apps', { token: fullToken });
    assert.deepEqual(apps.body.map((a) => a.id), [A], 'nur das eigene Board');

    const list = await call('GET', '/api/v1/apps/board/suggestions', { token: fullToken });
    assert.equal(list.body.some((s) => s.id === 'test_v1_s_other'), false,
      'kein Eintrag des Fremd-Tenants in der Liste');

    for (const [method, path, body] of [
      ['GET', '/api/v1/suggestions/test_v1_s_other', null],
      ['PATCH', '/api/v1/suggestions/test_v1_s_other', { status: 'wird umgesetzt' }],
      ['GET', '/api/v1/suggestions/test_v1_s_other/comments', null],
      ['POST', '/api/v1/suggestions/test_v1_s_other/comments', { text: 'hi' }],
    ]) {
      const res = await call(method, path, { token: fullToken, ...(body ? { body } : {}) });
      assert.equal(res.status, 404, `${method} ${path} muss 404 liefern, bekam ${res.status}`);
    }

    // Und die fremde Zeile bleibt unverändert.
    const { rows } = await query('select status from suggestions where id = $1', ['test_v1_s_other']);
    assert.equal(rows[0].status, 'neu');
  });
});
