'use strict';

// Einmalige Datenmigration Firestore -> Neon Postgres (SaaS/Tenant-Daten).
// Legacy-Daten (tenantId 'legacy' bzw. fehlend) bleiben in Firestore und werden
// NIE migriert. Users/Sessions/LoginLinks sind global (kein Tenant) und werden
// vollständig übernommen.
//
// Sicherheit & Wiederholbarkeit:
//   - Default ist DRY-RUN: zählt nur, was migriert würde. Erst `--commit`
//     schreibt tatsächlich nach Neon.
//   - Idempotent: id-basierte Tabellen per UPSERT (ON CONFLICT id), activity &
//     attachments per delete-je-Tenant + insert. Ein erneuter Lauf ist gefahrlos.
//   - Alles läuft in EINER Transaktion (atomar).
//
// Aufruf:  node scripts/migrate-firestore-to-neon.js [--commit]
// Env:     DATABASE_URL + Firebase-Credentials (aus .env.local oder Umgebung).

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');
const { query, withTransaction } = require('../db/pool');

const LEGACY = 'legacy';
const COMMIT = process.argv.includes('--commit');

// --- .env.local laden (nur lokal; in Prod kommen die Vars aus der Umgebung) ---
function loadDotEnvLocal() {
  for (const f of ['.env.local', '.env']) {
    const p = path.join(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
      }
    }
  }
}

function normalizeFirebasePrivateKey(key) {
  if (!key) return key;
  let k = key.trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) k = k.slice(1, -1);
  return k.replace(/\\r\\n/g, '\n').replace(/\\\\n/g, '\n').replace(/\\n/g, '\n').replace(/\\r/g, '').replace(/\r\n/g, '\n');
}

function initFirebase() {
  if (admin.apps.length) return;
  if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
    const sa = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8'));
    admin.initializeApp({ credential: admin.credential.cert(sa) });
  } else {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: normalizeFirebasePrivateKey(process.env.FIREBASE_PRIVATE_KEY),
      }),
    });
  }
}

// --- reine Helfer ---
const tenantIdOf = (d) => ((d.tenantId || '').toString().trim() || LEGACY);
const isNonLegacy = (d) => tenantIdOf(d) !== LEGACY;
function ts(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate();
  if (v._seconds != null) return new Date(v._seconds * 1000);
  if (v instanceof Date) return v;
  return null;
}
// data:image/...;base64,XXXX -> { data: Buffer, contentType } | null
const DATA_URL_RE = /^data:([\w.+-]+\/[\w.+-]+);base64,(.+)$/s;
const SERVABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
function decodeScreenshot(url) {
  const m = DATA_URL_RE.exec(typeof url === 'string' ? url : '');
  if (!m || !SERVABLE_IMAGE_TYPES.has(m[1])) return null;
  return { data: Buffer.from(m[2], 'base64'), contentType: m[1] };
}

async function fetchAll(col) {
  const snap = await admin.firestore().collection(col).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

async function run() {
  loadDotEnvLocal();
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL fehlt (.env.local oder Umgebung).');
  initFirebase();

  // Alles laden (Datenbestand ist klein).
  const [
    tenants, apps, releases, suggestions, votes, comments, activity,
    users, memberships, invites, sessions, loginLinks, apiKeys, counters,
  ] = await Promise.all([
    fetchAll('tenants'), fetchAll('apps'), fetchAll('releases'), fetchAll('suggestions'),
    fetchAll('votes'), fetchAll('comments'), fetchAll('activity'), fetchAll('users'),
    fetchAll('memberships'), fetchAll('invites'), fetchAll('sessions'), fetchAll('loginLinks'),
    fetchAll('apiKeys'), fetchAll('counters'),
  ]);

  // Nicht-Legacy-Scope.
  const nlTenants = tenants.filter((t) => t.id !== LEGACY && !t.legacy);
  const tenantIds = new Set(nlTenants.map((t) => t.id));
  const keep = (rows) => rows.filter((r) => isNonLegacy(r) && tenantIds.has(tenantIdOf(r)));
  const nlApps = keep(apps);
  const nlReleases = keep(releases);
  const nlSuggestions = keep(suggestions);
  const nlVotes = keep(votes);
  const nlComments = keep(comments);
  const nlActivity = keep(activity);
  const nlMemberships = keep(memberships);
  const nlInvites = keep(invites);

  // counters (id == appId) -> next_ticket_number
  const nextByApp = {};
  for (const c of counters) if (Number.isFinite(c.nextNumber)) nextByApp[c.id] = c.nextNumber;

  // Users nur, soweit von migrierten Memberships/Sessions referenziert + alle globalen.
  // Users/Sessions/LoginLinks sind global -> vollständig übernehmen.
  const nlUsers = users;
  const nlSessions = sessions;
  const nlLoginLinks = loginLinks;
  const nlApiKeys = keep(apiKeys);

  // Screenshots -> attachments (aktuell 0, aber vollständig behandelt).
  const attachments = [];
  for (const s of nlSuggestions) {
    for (const url of Array.isArray(s.screenshots) ? s.screenshots : []) {
      const dec = decodeScreenshot(url);
      if (dec) attachments.push({ tenantId: tenantIdOf(s), parentType: 'suggestion', parentId: s.id, ...dec });
    }
  }
  for (const c of nlComments) {
    for (const url of Array.isArray(c.screenshots) ? c.screenshots : []) {
      const dec = decodeScreenshot(url);
      if (dec) attachments.push({ tenantId: tenantIdOf(c), parentType: 'comment', parentId: c.id, ...dec });
    }
  }

  const plan = {
    tenants: nlTenants.length, users: nlUsers.length, apps: nlApps.length,
    releases: nlReleases.length, suggestions: nlSuggestions.length, votes: nlVotes.length,
    comments: nlComments.length, attachments: attachments.length, activity: nlActivity.length,
    memberships: nlMemberships.length, invites: nlInvites.length, sessions: nlSessions.length,
    login_links: nlLoginLinks.length, api_keys: nlApiKeys.length,
  };
  console.log(`\n=== Firestore -> Neon Migration (${COMMIT ? 'COMMIT' : 'DRY-RUN'}) ===`);
  console.log('Migrierte Tenants:', nlTenants.map((t) => t.id).join(', '));
  console.log('Geplante Zeilen:', JSON.stringify(plan, null, 2));

  if (!COMMIT) {
    console.log('\nDRY-RUN — nichts geschrieben. Mit --commit ausführen.');
    return;
  }

  await withTransaction(async (client) => {
    const up = (sql, params) => client.query(sql, params);

    // tenants
    for (const t of nlTenants) {
      await up(
        `insert into tenants (id, name, display_name, slug, status, email_from_name, email_reply_to,
           plan, stripe_customer_id, stripe_subscription_id, subscription_status, trial_ends_at,
           current_period_end, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,coalesce($14,now()),coalesce($15,now()))
         on conflict (id) do update set name=excluded.name, display_name=excluded.display_name,
           slug=excluded.slug, status=excluded.status, email_from_name=excluded.email_from_name,
           email_reply_to=excluded.email_reply_to, plan=excluded.plan,
           stripe_customer_id=excluded.stripe_customer_id, stripe_subscription_id=excluded.stripe_subscription_id,
           subscription_status=excluded.subscription_status, trial_ends_at=excluded.trial_ends_at,
           current_period_end=excluded.current_period_end, updated_at=excluded.updated_at`,
        [t.id, t.name || t.id, t.displayName || t.name || t.id, t.slug || t.id, t.status || 'active',
         t.emailSettings?.fromName || null, t.emailSettings?.replyTo || null, t.plan || null,
         t.stripeCustomerId || null, t.stripeSubscriptionId || null, t.subscriptionStatus || null,
         ts(t.trialEndsAt), ts(t.currentPeriodEnd), ts(t.createdAt), ts(t.updatedAt)]
      );
    }

    // users
    for (const u of nlUsers) {
      await up(
        `insert into users (id, email, display_name, status, created_at, updated_at)
         values ($1,$2,$3,$4,coalesce($5,now()),coalesce($6,now()))
         on conflict (id) do update set email=excluded.email, display_name=excluded.display_name,
           status=excluded.status, updated_at=excluded.updated_at`,
        [u.id, u.email, u.displayName || null, u.status || 'active', ts(u.createdAt), ts(u.updatedAt)]
      );
    }

    // apps (+ next_ticket_number aus counters)
    for (const a of nlApps) {
      await up(
        `insert into apps (id, tenant_id, name, description, slug, ticket_prefix, labels,
           next_ticket_number, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9,now()),coalesce($10,now()))
         on conflict (id) do update set tenant_id=excluded.tenant_id, name=excluded.name,
           description=excluded.description, slug=excluded.slug, ticket_prefix=excluded.ticket_prefix,
           labels=excluded.labels, next_ticket_number=excluded.next_ticket_number, updated_at=excluded.updated_at`,
        [a.id, tenantIdOf(a), a.name || a.id, a.description || '', a.slug || a.id, a.ticketPrefix || null,
         Array.isArray(a.labels) ? a.labels : [], nextByApp[a.id] ?? 1, ts(a.createdAt), ts(a.updatedAt)]
      );
    }

    // releases
    for (const r of nlReleases) {
      await up(
        `insert into releases (id, tenant_id, app_id, version, title, description, status,
           release_date, published_at, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10,now()),coalesce($11,now()))
         on conflict (id) do update set tenant_id=excluded.tenant_id, app_id=excluded.app_id,
           version=excluded.version, title=excluded.title, description=excluded.description,
           status=excluded.status, release_date=excluded.release_date, published_at=excluded.published_at,
           updated_at=excluded.updated_at`,
        [r.id, tenantIdOf(r), r.appId, r.version || null, r.title || '', r.description || '',
         r.status || 'geplant', ts(r.releaseDate), ts(r.publishedAt), ts(r.createdAt), ts(r.updatedAt)]
      );
    }

    // suggestions
    for (const s of nlSuggestions) {
      await up(
        `insert into suggestions (id, tenant_id, app_id, type, title, description, status, priority,
           labels, tag, tag_updated_at, votes, approved, approved_at, release_id, ticket_number,
           user_fingerprint, notification_enabled, notification_email, severity, steps_to_reproduce,
           expected_behavior, actual_behavior, environment, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,coalesce($25,now()))
         on conflict (id) do update set tenant_id=excluded.tenant_id, app_id=excluded.app_id,
           type=excluded.type, title=excluded.title, description=excluded.description, status=excluded.status,
           priority=excluded.priority, labels=excluded.labels, tag=excluded.tag, tag_updated_at=excluded.tag_updated_at,
           votes=excluded.votes, approved=excluded.approved, approved_at=excluded.approved_at,
           release_id=excluded.release_id, ticket_number=excluded.ticket_number, user_fingerprint=excluded.user_fingerprint,
           notification_enabled=excluded.notification_enabled, notification_email=excluded.notification_email,
           severity=excluded.severity, steps_to_reproduce=excluded.steps_to_reproduce,
           expected_behavior=excluded.expected_behavior, actual_behavior=excluded.actual_behavior,
           environment=excluded.environment`,
        [s.id, tenantIdOf(s), s.appId, s.type, s.title || '', s.description || '', s.status || 'neu',
         s.priority || null, Array.isArray(s.labels) ? s.labels : [], s.tag || null, ts(s.tagUpdatedAt),
         Number.isFinite(s.votes) ? s.votes : 0, s.approved === true, ts(s.approvedAt), s.releaseId || null,
         s.ticketNumber || null, s.userFingerprint || null, s.notificationEnabled === true,
         s.notificationEmail || null, s.severity || null, s.stepsToReproduce || null, s.expectedBehavior || null,
         s.actualBehavior || null, s.environment ? JSON.stringify(s.environment) : null, ts(s.createdAt)]
      );
    }

    // votes
    for (const v of nlVotes) {
      await up(
        `insert into votes (id, tenant_id, suggestion_id, user_fingerprint, created_at)
         values ($1,$2,$3,$4,coalesce($5,now()))
         on conflict (id) do update set tenant_id=excluded.tenant_id, suggestion_id=excluded.suggestion_id,
           user_fingerprint=excluded.user_fingerprint`,
        // Firestore-Votes speichern die Zeit in `timestamp` (nicht createdAt).
        [v.id, tenantIdOf(v), v.suggestionId, v.userFingerprint, ts(v.createdAt || v.timestamp)]
      );
    }

    // comments
    for (const c of nlComments) {
      await up(
        `insert into comments (id, tenant_id, suggestion_id, text, author_type, author_fingerprint,
           approval_status, approved_at, approved_by, rejected_at, rejected_by, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,coalesce($12,now()))
         on conflict (id) do update set tenant_id=excluded.tenant_id, suggestion_id=excluded.suggestion_id,
           text=excluded.text, author_type=excluded.author_type, author_fingerprint=excluded.author_fingerprint,
           approval_status=excluded.approval_status, approved_at=excluded.approved_at, approved_by=excluded.approved_by,
           rejected_at=excluded.rejected_at, rejected_by=excluded.rejected_by`,
        [c.id, tenantIdOf(c), c.suggestionId, c.text || '', c.authorType || 'user', c.authorFingerprint || null,
         c.approvalStatus || 'pending', ts(c.approvedAt), c.approvedBy || null, ts(c.rejectedAt), c.rejectedBy || null,
         ts(c.createdAt)]
      );
    }

    // attachments (delete-je-Tenant + insert -> idempotent, da keine natürliche id)
    for (const id of tenantIds) await up('delete from attachments where tenant_id = $1', [id]);
    for (const a of attachments) {
      await up(
        `insert into attachments (tenant_id, parent_type, parent_id, data, content_type, size_bytes)
         values ($1,$2,$3,$4,$5,$6)`,
        [a.tenantId, a.parentType, a.parentId, a.data, a.contentType, a.data.length]
      );
    }

    // activity (bigint identity -> delete-je-Tenant + insert)
    for (const id of tenantIds) await up('delete from activity where tenant_id = $1', [id]);
    for (const a of nlActivity) {
      await up(
        `insert into activity (tenant_id, ticket_id, action, old_value, new_value, detail, actor, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,coalesce($8,now()))`,
        [tenantIdOf(a), a.ticketId, a.action, a.oldValue ?? null, a.newValue ?? null, a.detail ?? null,
         a.actor ?? null, ts(a.createdAt)]
      );
    }

    // memberships
    for (const m of nlMemberships) {
      await up(
        `insert into memberships (id, tenant_id, user_id, role, status, disabled_at, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,coalesce($7,now()),coalesce($8,now()))
         on conflict (id) do update set tenant_id=excluded.tenant_id, user_id=excluded.user_id,
           role=excluded.role, status=excluded.status, disabled_at=excluded.disabled_at, updated_at=excluded.updated_at`,
        [m.id, tenantIdOf(m), m.userId, m.role, m.status || 'active', ts(m.disabledAt), ts(m.createdAt), ts(m.updatedAt)]
      );
    }

    // invites
    for (const i of nlInvites) {
      await up(
        `insert into invites (id, tenant_id, email, role, status, token_hash, expires_at, accepted_at,
           revoked_at, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10,now()),coalesce($11,now()))
         on conflict (id) do update set tenant_id=excluded.tenant_id, email=excluded.email, role=excluded.role,
           status=excluded.status, token_hash=excluded.token_hash, expires_at=excluded.expires_at,
           accepted_at=excluded.accepted_at, revoked_at=excluded.revoked_at, updated_at=excluded.updated_at`,
        [i.id, tenantIdOf(i), i.email, i.role, i.status || 'pending', i.tokenHash, ts(i.expiresAt),
         ts(i.acceptedAt), ts(i.revokedAt), ts(i.createdAt), ts(i.updatedAt)]
      );
    }

    // sessions (global)
    for (const s of nlSessions) {
      await up(
        `insert into sessions (id, user_id, status, token_hash, last_used_at, expires_at, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,coalesce($7,now()),coalesce($8,now()))
         on conflict (id) do update set user_id=excluded.user_id, status=excluded.status,
           token_hash=excluded.token_hash, last_used_at=excluded.last_used_at, expires_at=excluded.expires_at,
           updated_at=excluded.updated_at`,
        [s.id, s.userId, s.status || 'active', s.tokenHash, ts(s.lastUsedAt), ts(s.expiresAt), ts(s.createdAt), ts(s.updatedAt)]
      );
    }

    // login_links (global)
    for (const l of nlLoginLinks) {
      await up(
        `insert into login_links (id, email, status, token_hash, redirect_url, expires_at, consumed_at, created_at, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,coalesce($8,now()),coalesce($9,now()))
         on conflict (id) do update set email=excluded.email, status=excluded.status, token_hash=excluded.token_hash,
           redirect_url=excluded.redirect_url, expires_at=excluded.expires_at, consumed_at=excluded.consumed_at,
           updated_at=excluded.updated_at`,
        [l.id, l.email, l.status || 'pending', l.tokenHash, l.redirectUrl || null, ts(l.expiresAt), ts(l.consumedAt),
         ts(l.createdAt), ts(l.updatedAt)]
      );
    }

    // api_keys
    for (const k of nlApiKeys) {
      await up(
        `insert into api_keys (id, tenant_id, name, scopes, token_hash, token_prefix, created_by,
           last_used_at, revoked_at, created_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,coalesce($10,now()))
         on conflict (id) do update set tenant_id=excluded.tenant_id, name=excluded.name, scopes=excluded.scopes,
           token_hash=excluded.token_hash, token_prefix=excluded.token_prefix, created_by=excluded.created_by,
           last_used_at=excluded.last_used_at, revoked_at=excluded.revoked_at`,
        [k.id, tenantIdOf(k), k.name || 'API Key', Array.isArray(k.scopes) ? k.scopes : [], k.tokenHash,
         k.tokenPrefix || null, k.createdBy || null, ts(k.lastUsedAt), ts(k.revokedAt), ts(k.createdAt)]
      );
    }
  });

  // Verifikation: Zeilen je Tabelle in Neon.
  const verify = {};
  for (const t of ['tenants', 'users', 'apps', 'releases', 'suggestions', 'votes', 'comments',
    'attachments', 'activity', 'memberships', 'invites', 'sessions', 'login_links', 'api_keys']) {
    const { rows } = await query(`select count(*)::int n from ${t}`);
    verify[t] = rows[0].n;
  }
  console.log('\n=== Migration committed. Neon-Zeilen jetzt: ===');
  console.log(JSON.stringify(verify, null, 2));
}

// Nur ausführen, wenn direkt gestartet — beim require (Unit-Test) laufen nur
// die reinen Helfer, keine Migration.
if (require.main === module) {
  run().then(() => process.exit(0)).catch((e) => { console.error('MIGRATION FEHLGESCHLAGEN:', e.stack || e.message); process.exit(1); });
}

module.exports = { ts, tenantIdOf, isNonLegacy, decodeScreenshot };
