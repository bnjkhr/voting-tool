const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const crypto = require('crypto');
const { Resend } = require('resend');
const fs = require('fs');
const {
  buildAdminCommentResponse,
  buildCommentStats,
  buildPublicCommentResponse,
  normalizeCommentData,
  validateCommentScreenshots,
} = require('./comment-utils');
const { compareAdminSuggestions } = require('./admin-suggestion-sort');
const { queryCollectionInChunks } = require('./firestore-chunks');
const {
  LEGACY_PUBLIC_HIDDEN_APP_IDS,
  isLegacyPublicAppVisible,
} = require('./legacy-public-filter');
const {
  ACTIVE_TENANT_STATUS,
  LEGACY_TENANT_ID,
  buildAppSlug,
  getTenantId,
  parseSlugParam,
} = require('./tenant-utils');
const {
  buildTenantProvisionConfig,
  buildTenantProvisionDocuments,
  buildTicketPrefix,
} = require('./tenant-provisioning');
const {
  MEMBERSHIP_ROLES,
  MEMBERSHIP_STATUSES,
  buildLoginLinkData,
  buildInviteTokenHash,
  buildInviteToken,
  buildMembershipData,
  buildSessionData,
  buildTenantInviteData,
  buildUserData,
  isInviteExpired,
  isLoginLinkExpired,
  isSessionExpired,
  normalizeInviteEmail,
  normalizeMembershipRole,
} = require('./team-utils');
const {
  API_KEY_SCOPES,
  buildApiKeyData,
  generateApiKeyToken,
  hashApiKeyToken,
  isApiKeyActive,
  normalizeScopes,
  parseApiKeyAuthHeader,
} = require('./api-key-utils');
const { shouldServeAppShell } = require('./spa-fallback');
// Postgres/Neon-Repositories (nur aktiv wenn DATA_BACKEND='postgres'; sonst Firestore).
const repos = require('../db');
const { usePostgres } = repos.backend;

const app = express();

function loadDotEnvFileIfPresent() {
  // Minimal .env loader to support local development without adding deps.
  // Environment variables already set in the shell take precedence.
  const envPath = path.join(process.cwd(), '.env');
  if (!fs.existsSync(envPath)) return;

  try {
    const content = fs.readFileSync(envPath, 'utf8');
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;

      const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
      const eqIdx = normalized.indexOf('=');
      if (eqIdx <= 0) continue;

      const key = normalized.slice(0, eqIdx).trim();
      if (!key || process.env[key] !== undefined) continue;

      let value = normalized.slice(eqIdx + 1).trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      value = value
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t');

      process.env[key] = value;
    }
  } catch (err) {
    console.warn('Warning: failed to read .env file:', err?.message || err);
  }
}

loadDotEnvFileIfPresent();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Convenience routes (people tend to type /admin instead of /admin.html)
app.get(['/admin', '/admin/'], (req, res) => {
  res.redirect(302, '/admin.html');
});

// Normalisiert einen aus einer Env-Var stammenden PEM-Private-Key robust:
// entfernt umschließende Quotes und wandelt (auch doppelt) escapte Zeilenumbrüche
// in echte um. Fängt die häufigen Vercel/Env-Copy-Paste-Fehler ab, die sonst zu
// "DECODER routines::unsupported" bei der ersten Firestore-Query führen.
function normalizeFirebasePrivateKey(key) {
  if (!key) return key;
  let k = key.trim();
  if ((k.startsWith('"') && k.endsWith('"')) || (k.startsWith("'") && k.endsWith("'"))) {
    k = k.slice(1, -1);
  }
  return k
    .replace(/\\r\\n/g, '\n') // escaptes CRLF (\r\n) zuerst -> LF
    .replace(/\\\\n/g, '\n')  // doppelt escaped (\\n)
    .replace(/\\n/g, '\n')    // einfach escaped (\n)
    .replace(/\\r/g, '')      // übrige escapte \r entfernen
    .replace(/\r\n/g, '\n');  // echte CRLF -> LF
}

// Firebase Admin initialization
if (!admin.apps.length) {
  try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT_BASE64) {
      // Bulletproof: kompletter Service-Account als base64-kodiertes JSON -> keine
      // Newline-/Quote-Probleme möglich.
      const serviceAccount = JSON.parse(
        Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_BASE64, 'base64').toString('utf8')
      );
      admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
    } else {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = normalizeFirebasePrivateKey(process.env.FIREBASE_PRIVATE_KEY);

      if (!projectId || !clientEmail || !privateKey) {
        console.error('Missing required Firebase environment variables');
        throw new Error('Firebase configuration incomplete');
      }

      admin.initializeApp({
        credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
      });
    }
  } catch (error) {
    console.error('Failed to initialize Firebase Admin:', error);
    throw error;
  }
}

const db = admin.firestore();

// Empfänger für Betreiber-Benachrichtigungen aus dem Legacy-Bereich (nicht Tenant-scoped).
// Konfigurierbar über OPERATOR_EMAIL; Fallback erhält das bisherige Verhalten.
const OPERATOR_EMAIL = process.env.OPERATOR_EMAIL || 'ben.kohler@me.com';

const FEATURE_TAGS = ['wird umgesetzt', 'im Test', 'wird nicht umgesetzt', 'wird geprüft', 'ist umgesetzt'];
const BUG_TAGS = ['neu', 'in analyse', 'behoben', 'nicht reproduzierbar'];
const VALID_SUGGESTION_TYPES = ['feature', 'bug', 'ticket'];
const VALID_BUG_SEVERITIES = ['low', 'medium', 'high', 'critical'];
const VALID_PRIORITIES = ['niedrig', 'mittel', 'hoch', 'kritisch'];

const TICKET_STATUSES = ['neu', 'offen', 'in Bearbeitung', 'im Test', 'wartend', 'gelöst', 'geschlossen'];
const FEATURE_STATUSES = ['neu', 'wird geprüft', 'wird umgesetzt', 'im Test', 'ist umgesetzt', 'wird nicht umgesetzt'];
const RESOLVED_STATUSES = ['ist umgesetzt', 'wird nicht umgesetzt', 'gelöst', 'geschlossen'];
const RELEASE_STATUSES = ['geplant', 'in Arbeit', 'veröffentlicht'];

function isLegacyTenantData(data = {}) {
  return getTenantId(data) === LEGACY_TENANT_ID;
}

function isSameTenantScope(left = {}, right = {}) {
  return getTenantId(left) === getTenantId(right);
}

function isActiveTenant(data = {}) {
  return data.status === ACTIVE_TENANT_STATUS;
}

async function findActiveTenantBySlug(tenantSlug) {
  if (usePostgres()) {
    return repos.tenants.findActiveBySlug(tenantSlug);
  }
  const snapshot = await db.collection('tenants')
    .where('slug', '==', tenantSlug)
    .limit(2)
    .get();

  if (snapshot.size > 1) {
    throw new Error(`Multiple tenants found for slug "${tenantSlug}"`);
  }

  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];
  const data = doc.data() || {};
  if (!isActiveTenant(data)) {
    return null;
  }

  return { id: doc.id, ...data };
}

async function findTenantAppBySlug(tenantId, appSlug) {
  if (usePostgres()) {
    return repos.apps.findBySlug(tenantId, appSlug);
  }
  const snapshot = await db.collection('apps')
    .where('slug', '==', appSlug)
    .get();

  const matches = snapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(appData => getTenantId(appData) === tenantId);

  if (matches.length > 1) {
    throw new Error(`Multiple apps found for tenant "${tenantId}" and slug "${appSlug}"`);
  }

  return matches[0] || null;
}

async function resolveTenantAndAppBySlug({ tenantSlug, appSlug }) {
  const tenant = await findActiveTenantBySlug(tenantSlug);
  if (!tenant) {
    return { errorStatus: 404, error: 'Tenant not found' };
  }

  const tenantApp = await findTenantAppBySlug(tenant.id, appSlug);
  if (!tenantApp) {
    return { errorStatus: 404, error: 'App not found' };
  }

  return { tenant, tenantApp };
}

async function resolveTenantSuggestionById(tenantSlug, suggestionId) {
  const tenant = await findActiveTenantBySlug(tenantSlug);
  if (!tenant) {
    return { errorStatus: 404, error: 'Tenant not found' };
  }

  const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
  const suggestionData = suggestionDoc.exists ? suggestionDoc.data() : null;
  if (!suggestionDoc.exists || getTenantId(suggestionData) !== tenant.id) {
    return { errorStatus: 404, error: 'Suggestion not found' };
  }

  return { tenant, suggestionDoc, suggestionData };
}

function buildCommentStatsMap(commentDocs, tenantId) {
  const commentStatsMap = {};

  commentDocs
    .filter(doc => getTenantId(doc.data() || {}) === tenantId)
    .forEach(doc => {
      const suggestionId = doc.data().suggestionId;
      if (!commentStatsMap[suggestionId]) {
        commentStatsMap[suggestionId] = {
          totalCount: 0,
          pendingCount: 0,
          publicCount: 0,
        };
      }

      const stats = buildCommentStats([doc]);
      commentStatsMap[suggestionId].totalCount += stats.totalCount;
      commentStatsMap[suggestionId].pendingCount += stats.pendingCount;
      commentStatsMap[suggestionId].publicCount += stats.publicCount;
    });

  return commentStatsMap;
}

function buildPublicSuggestionResponse(data, commentStatsMap, userVotesSet) {
  const type = normalizeSuggestionType(data.type);

  return {
    id: data.id,
    ...data,
    type,
    status: data.status || mapLegacyTagToStatus(type, data.tag, data.approved),
    priority: data.priority || 'mittel',
    labels: data.labels || [],
    ticketNumber: data.ticketNumber || null,
    commentCount: commentStatsMap[data.id]?.publicCount || 0,
    hasVoted: type === 'feature' && userVotesSet.has(data.id)
  };
}

function sortPublicSuggestions(suggestions) {
  suggestions.sort((a, b) => {
    const aStatus = a.status || '';
    const bStatus = b.status || '';

    const aImplemented = RESOLVED_STATUSES.includes(aStatus);
    const bImplemented = RESOLVED_STATUSES.includes(bStatus);

    if (aImplemented !== bImplemented) {
      return aImplemented ? 1 : -1;
    }

    const aVotable = !aImplemented && !a.hasVoted;
    const bVotable = !bImplemented && !b.hasVoted;
    if (aVotable !== bVotable) {
      return aVotable ? -1 : 1;
    }

    const aTime = a.createdAt?.toDate?.() || a.createdAt || new Date(0);
    const bTime = b.createdAt?.toDate?.() || b.createdAt || new Date(0);
    if (bTime - aTime !== 0) {
      return bTime - aTime;
    }

    const aVotes = a.votes || 0;
    const bVotes = b.votes || 0;
    if (bVotes !== aVotes) {
      return bVotes - aVotes;
    }

    return (a.title || a.id || '').localeCompare((b.title || b.id || ''));
  });

  return suggestions;
}

async function loadPublicSuggestionsForApp(appId, tenantId, userFingerprint) {
  if (usePostgres()) {
    const suggestions = await repos.suggestions.listPublicForApp(appId);
    if (suggestions.length === 0) return [];
    const suggestionIds = suggestions.map((s) => s.id);
    const [commentStatsMap, votedIds] = await Promise.all([
      repos.comments.statsForSuggestions(suggestionIds, tenantId),
      repos.votes.votedSuggestionIds(userFingerprint, suggestionIds),
    ]);
    const userVotesSet = new Set(votedIds);
    return sortPublicSuggestions(
      suggestions.map((data) => buildPublicSuggestionResponse(data, commentStatsMap, userVotesSet))
    );
  }

  const suggestionsSnapshot = await db.collection('suggestions')
    .where('appId', '==', appId)
    .where('approved', '==', true)
    .get();

  const suggestionDocs = suggestionsSnapshot.docs
    .filter(doc => getTenantId(doc.data() || {}) === tenantId);

  if (suggestionDocs.length === 0) {
    return [];
  }

  const suggestionIds = suggestionDocs.map(doc => doc.id);

  const [commentDocs, userVoteDocs] = await Promise.all([
    queryCollectionInChunks(db, {
      collectionName: 'comments',
      fieldName: 'suggestionId',
      values: suggestionIds,
    }),
    queryCollectionInChunks(db, {
      collectionName: 'votes',
      fieldName: 'suggestionId',
      values: suggestionIds,
      applyChunkQuery: query => query.where('userFingerprint', '==', userFingerprint),
    })
  ]);

  const commentStatsMap = buildCommentStatsMap(commentDocs, tenantId);
  const userVotesSet = new Set(
    userVoteDocs
      .filter(doc => getTenantId(doc.data() || {}) === tenantId)
      .map(doc => doc.data().suggestionId)
  );

  return sortPublicSuggestions(
    suggestionDocs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .map(data => buildPublicSuggestionResponse(data, commentStatsMap, userVotesSet))
  );
}

function parseStatusFilter(statusFilter) {
  if (!statusFilter) {
    return { statusList: null };
  }

  const statusList = statusFilter.split(',').map(s => s.trim()).filter(s => RELEASE_STATUSES.includes(s));
  if (statusList.length === 0) {
    return { error: 'Ungültiger Status-Filter' };
  }

  return { statusList };
}

function sortPublicReleases(releases) {
  releases.sort((a, b) => {
    // "in Arbeit" und "geplant" gemeinsam chronologisch nach Datum, "veröffentlicht" separat ans Ende
    const statusOrder = { 'in Arbeit': 0, 'geplant': 0, 'veröffentlicht': 1 };
    const aOrder = statusOrder[a.status] ?? 9;
    const bOrder = statusOrder[b.status] ?? 9;
    if (aOrder !== bOrder) return aOrder - bOrder;

    const aDate = a.releaseDate?.toDate?.() ?? (a.releaseDate?._seconds != null ? new Date(a.releaseDate._seconds * 1000) : new Date(0));
    const bDate = b.releaseDate?.toDate?.() ?? (b.releaseDate?._seconds != null ? new Date(b.releaseDate._seconds * 1000) : new Date(0));
    return a.status === 'veröffentlicht' ? bDate - aDate : aDate - bDate;
  });

  return releases;
}

async function loadPublicReleasesForApp(appId, tenantId, statusFilter) {
  const { statusList, error } = parseStatusFilter(statusFilter);
  if (error) {
    return { error };
  }

  if (usePostgres()) {
    let releases = await repos.releases.listByApp(appId);
    if (statusList) {
      releases = releases.filter((r) => statusList.includes(r.status));
    }
    const releaseIds = releases.map((r) => r.id);
    const suggestionsByRelease = {};
    if (releaseIds.length > 0) {
      const sugs = await repos.suggestions.listApprovedByReleaseIds(releaseIds, tenantId);
      for (const data of sugs) {
        const rid = data.releaseId;
        if (!suggestionsByRelease[rid]) suggestionsByRelease[rid] = [];
        const type = normalizeSuggestionType(data.type);
        suggestionsByRelease[rid].push({
          id: data.id,
          title: data.title,
          type,
          status: data.status || mapLegacyTagToStatus(type, data.tag, data.approved),
          ticketNumber: data.ticketNumber || null,
        });
      }
    }
    return {
      releases: sortPublicReleases(releases.map((r) => ({
        ...r,
        items: suggestionsByRelease[r.id] || [],
      }))),
    };
  }

  let query = db.collection('releases').where('appId', '==', appId);
  if (statusList && statusList.length === 1) {
    query = query.where('status', '==', statusList[0]);
  }

  const releasesSnapshot = await query.get();

  let releases = releasesSnapshot.docs
    .map(doc => ({
      id: doc.id,
      ...doc.data(),
    }))
    .filter(release => getTenantId(release) === tenantId);

  if (statusList && statusList.length > 1) {
    releases = releases.filter(r => statusList.includes(r.status));
  }

  const releaseIds = releases.map(r => r.id);
  const suggestionsByRelease = {};

  if (releaseIds.length > 0) {
    const suggestionDocs = await queryCollectionInChunks(db, {
      collectionName: 'suggestions',
      fieldName: 'releaseId',
      values: releaseIds,
      applyChunkQuery: query => query.where('approved', '==', true),
    });

    suggestionDocs
      .filter(doc => getTenantId(doc.data() || {}) === tenantId)
      .forEach(doc => {
        const data = doc.data();
        const rid = data.releaseId;
        if (!suggestionsByRelease[rid]) suggestionsByRelease[rid] = [];
        const type = normalizeSuggestionType(data.type);
        suggestionsByRelease[rid].push({
          id: doc.id,
          title: data.title,
          type,
          status: data.status || mapLegacyTagToStatus(type, data.tag, data.approved),
          ticketNumber: data.ticketNumber || null,
        });
      });
  }

  return {
    releases: sortPublicReleases(releases.map(r => ({
      ...r,
      items: suggestionsByRelease[r.id] || [],
    }))),
  };
}

function getValidStatusesForType(type) {
  if (type === 'feature') return FEATURE_STATUSES;
  return TICKET_STATUSES; // tickets and bugs share the same workflow
}

function mapStatusToLegacyTag(type, status) {
  if (type === 'feature') {
    // Feature statuses map 1:1 to legacy tags (except 'neu')
    if (status === 'neu') return null;
    return FEATURE_TAGS.includes(status) ? status : null;
  }
  // Bug/ticket status → legacy bug tag
  switch (status) {
    case 'neu': return null;
    case 'offen': return 'neu';
    case 'in Bearbeitung': return 'in analyse';
    case 'im Test': return 'in analyse';
    case 'gelöst': return 'behoben';
    case 'geschlossen': return 'nicht reproduzierbar';
    default: return null;
  }
}

function mapLegacyTagToStatus(type, tag, approved) {
  if (type === 'bug' || type === 'ticket') {
    if (!tag && !approved) return 'neu';
    if (!tag && approved) return 'offen';
    switch ((tag || '').trim().toLowerCase()) {
      case 'neu': return 'offen';
      case 'in analyse': return 'in Bearbeitung';
      case 'behoben': return 'gelöst';
      case 'nicht reproduzierbar': return 'geschlossen';
      default: return approved ? 'offen' : 'neu';
    }
  }
  // feature
  if (!tag && !approved) return 'neu';
  if (!tag && approved) return 'wird geprüft';
  switch ((tag || '').trim().toLowerCase()) {
    case 'wird geprüft': return 'wird geprüft';
    case 'wird umgesetzt': return 'wird umgesetzt';
    case 'ist umgesetzt': return 'ist umgesetzt';
    case 'wird nicht umgesetzt': return 'wird nicht umgesetzt';
    default: return approved ? 'wird geprüft' : 'neu';
  }
}

function mapSeverityToPriority(severity) {
  switch ((severity || '').trim().toLowerCase()) {
    case 'low': return 'niedrig';
    case 'medium': return 'mittel';
    case 'high': return 'hoch';
    case 'critical': return 'kritisch';
    default: return 'mittel';
  }
}

async function generateTicketNumber(appId, tenantId = LEGACY_TENANT_ID) {
  const counterRef = db.collection('counters').doc(appId);

  const result = await db.runTransaction(async (transaction) => {
    const counterDoc = await transaction.get(counterRef);

    let prefix, nextNumber;
    let resolvedTenantId = tenantId;
    if (counterDoc.exists) {
      prefix = counterDoc.data().prefix;
      nextNumber = counterDoc.data().nextNumber || 1;
      resolvedTenantId = getTenantId({ tenantId: counterDoc.data().tenantId || tenantId });
    } else {
      // Fallback: derive prefix from app name
      const appDoc = await transaction.get(db.collection('apps').doc(appId));
      const appData = appDoc.exists ? appDoc.data() : {};
      const appName = appData.name || 'APP';
      prefix = appName.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase() || 'APP';
      nextNumber = 1;
      resolvedTenantId = getTenantId(appData);
    }

    transaction.set(counterRef, {
      prefix,
      nextNumber: nextNumber + 1,
      tenantId: resolvedTenantId,
    }, { merge: true });

    return `${prefix}-${String(nextNumber).padStart(3, '0')}`;
  });

  return result;
}

async function logActivity(ticketId, action, {
  oldValue = null,
  newValue = null,
  detail = null,
  actor = 'admin',
  tenantId = LEGACY_TENANT_ID,
} = {}) {
  try {
    await db.collection('activity').add({
      tenantId: getTenantId({ tenantId }),
      ticketId,
      action,
      oldValue,
      newValue,
      detail,
      actor,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error('Error logging activity:', error.message);
  }
}

// Normalisiert eine Empfängerliste (String oder Array) zu eindeutigen, gültigen Adressen.
function normalizeRecipientList(to) {
  const list = Array.isArray(to) ? to : (to ? [to] : []);
  return [...new Set(
    list
      .map((email) => (typeof email === 'string' ? email.trim().toLowerCase() : ''))
      .filter((email) => isValidEmail(email))
  )];
}

// Ermittelt die Benachrichtigungs-Empfänger für einen Tenant (aktive Owner/Admins).
// Legacy-Daten gehen an den Betreiber; nie an fremde Tenants.
async function resolveNotificationRecipients(tenantId) {
  if (!tenantId || tenantId === LEGACY_TENANT_ID) {
    return normalizeRecipientList(OPERATOR_EMAIL);
  }
  try {
    // Schlank: nur aktive Owner/Admins auflösen (keine invites-Query, keine User-Docs
    // für Nicht-Empfänger) — dieser Pfad läuft bei jedem öffentlichen Submit.
    const membershipsSnapshot = await db.collection('memberships')
      .where('tenantId', '==', tenantId)
      .get();
    const admins = membershipsSnapshot.docs
      .map((doc) => doc.data())
      .filter((member) => (member.status || 'active') === 'active')
      .filter((member) => ['owner', 'admin'].includes(normalizeMembershipRole(member.role)));

    const userDocs = await Promise.all(
      [...new Set(admins.map((member) => member.userId).filter(Boolean))]
        .map((userId) => db.collection('users').doc(userId).get())
    );
    const recipients = userDocs
      .map((doc) => (doc.exists ? doc.data() : null))
      .filter((user) => user && (!user.status || user.status === 'active'))
      .map((user) => user.email);
    return normalizeRecipientList(recipients);
  } catch (error) {
    console.error('Failed to resolve tenant notification recipients:', error);
    return [];
  }
}

// Helper function to send admin notification email
async function sendAdminNotificationEmail(suggestionId, title, description, appName, reportMeta = {}, to = null) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('Email not configured - RESEND_API_KEY missing');
    return;
  }

  const recipients = normalizeRecipientList(to);
  if (recipients.length === 0) {
    console.warn('No notification recipients resolved - skipping admin email');
    return;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  const adminUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/admin.html`;

  const reportTypeLabels = { bug: 'Bug', ticket: 'Ticket', feature: 'Feature' };
  const reportTypeLabel = reportTypeLabels[reportMeta.type] || 'Feature';
  const severityLine = reportMeta.type === 'bug' && reportMeta.severity
    ? `<p><strong>Schweregrad:</strong> ${reportMeta.severity}</p>`
    : '';

  try {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: recipients,
      subject: `Neuer ${reportTypeLabel}-Eintrag wartet auf Freigabe: ${title}`,
      html: `
        <h2>Neuer ${reportTypeLabel}-Eintrag eingereicht</h2>
        <p><strong>App:</strong> ${appName}</p>
        <p><strong>Typ:</strong> ${reportTypeLabel}</p>
        ${severityLine}
        <p><strong>Titel:</strong> ${title}</p>
        <p><strong>Beschreibung:</strong> ${description}</p>
        <p><strong>Suggestion ID:</strong> ${suggestionId}</p>
        <br>
        <p><a href="${adminUrl}">Zum Admin-Bereich</a></p>
      `
    });

    if (error) {
      console.error('Failed to send admin email:', error);
      return;
    }
    console.log('Admin email sent successfully:', data.id);
  } catch (error) {
    console.error('Failed to send admin email:', error.message);
    throw error;
  }
}

async function sendAdminCommentNotificationEmail(suggestionId, suggestionTitle, commentText, appName, to = null) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('Email not configured - RESEND_API_KEY missing');
    return;
  }

  const recipients = normalizeRecipientList(to);
  if (recipients.length === 0) {
    console.warn('No notification recipients resolved - skipping admin comment email');
    return;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  const adminUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/admin.html`;

  try {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: recipients,
      subject: `Neuer Kommentar wartet auf Freigabe: ${suggestionTitle}`,
      html: `
        <h2>Neuer Kommentar wartet auf Freigabe</h2>
        <p><strong>App:</strong> ${appName}</p>
        <p><strong>Eintrag:</strong> ${suggestionTitle}</p>
        <p><strong>Suggestion ID:</strong> ${suggestionId}</p>
        <p><strong>Kommentar:</strong> ${commentText}</p>
        <br>
        <p><a href="${adminUrl}">Zum Admin-Bereich</a></p>
      `
    });

    if (error) {
      console.error('Failed to send admin comment email:', error);
      return;
    }
    console.log('Admin comment email sent successfully:', data.id);
  } catch (error) {
    console.error('Failed to send admin comment email:', error.message);
    throw error;
  }
}

// Helper function to send user notification email
async function sendUserNotificationEmail(userEmail, suggestionId, title, status, comment, appName, entryType = 'feature') {
  if (!process.env.RESEND_API_KEY) {
    console.warn('Email not configured - RESEND_API_KEY missing');
    return;
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(userEmail)) {
    console.warn('Invalid user email format:', userEmail);
    return;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  const suggestionUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/#suggestion-${suggestionId}`;

  let statusText = '';
  let statusColor = '';
  switch (status) {
    case 'approved':    statusText = 'Genehmigt';          statusColor = '#28a745'; break;
    case 'rejected':    statusText = 'Abgelehnt';           statusColor = '#dc3545'; break;
    case 'commented':   statusText = 'Neuer Kommentar';     statusColor = '#007bff'; break;
    case 'tag_updated': statusText = 'Status aktualisiert'; statusColor = '#6366f1'; break;
    default:            statusText = 'Status aktualisiert'; statusColor = '#6c757d';
  }

  const entryLabels = { bug: 'Bug', ticket: 'Ticket', feature: 'Vorschlag' };
  const entryLabel = entryLabels[entryType] || 'Eintrag';

  try {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: userEmail,
      subject: `Ihr ${entryLabel} "${title}" - ${statusText}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Update zu Ihrem ${entryLabel}</h2>
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: ${statusColor};">${statusText}</h3>
            <p><strong>${entryLabel}:</strong> ${title}</p>
            <p><strong>App:</strong> ${appName}</p>
            <p><strong>Typ:</strong> ${entryLabel}</p>
            ${comment ? `<p><strong>Kommentar:</strong> ${comment}</p>` : ''}
          </div>
          <p><a href="${suggestionUrl}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Eintrag ansehen</a></p>
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #dee2e6;">
          <p style="color: #6c757d; font-size: 12px;">
            Sie erhalten diese E-Mail, weil Sie Benachrichtigungen für diesen Eintrag aktiviert haben.
          </p>
        </div>
      `
    });

    if (error) {
      console.error('Failed to send user notification email:', error);
      return;
    }
    console.log('User notification email sent successfully:', data.id);
  } catch (error) {
    console.error('Failed to send user notification email:', error.message);
    throw error;
  }
}

function buildRequestBaseUrl(req) {
  // Trust the operator-configured BASE_URL above any request header. Host
  // and X-Forwarded-Host are client-controllable and would otherwise let an
  // attacker poison the origin baked into outgoing email login links.
  if (process.env.BASE_URL) {
    return process.env.BASE_URL.replace(/\/+$/, '');
  }

  const protoHeader = req.headers['x-forwarded-proto'];
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = Array.isArray(protoHeader) ? protoHeader[0] : protoHeader;
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;

  if (host) {
    return `${proto || req.protocol || 'https'}://${host}`;
  }

  return 'http://localhost:3000';
}

async function sendLoginLinkEmail({ to, loginUrl }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('Login email not configured - RESEND_API_KEY missing');
    throw new Error('Email delivery not configured');
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.EMAIL_FROM || 'onboarding@resend.dev';

  const { data, error } = await resend.emails.send({
    from: fromEmail,
    to,
    subject: 'Dein Login-Link fürs Voting Tool',
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
        <h2>Einloggen</h2>
        <p>Nutze diesen Link, um dich im Voting Tool anzumelden.</p>
        <p><a href="${loginUrl}" style="background:#111;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Einloggen</a></p>
        <p style="color:#666;font-size:13px;">Der Link ist 15 Minuten gültig und kann nur einmal verwendet werden.</p>
      </div>
    `,
  });

  if (error) {
    console.error('Failed to send login link email:', error);
    throw new Error('Failed to send login link email');
  }

  console.log('Login link email sent successfully:', data.id);
  return data;
}

async function sendTenantInviteEmail({ to, tenantName, role, acceptUrl }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('Invite email not configured - RESEND_API_KEY missing');
    throw new Error('Email delivery not configured');
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  const roleLabel = normalizeMembershipRole(role);

  const { data, error } = await resend.emails.send({
    from: fromEmail,
    to,
    subject: `Einladung zu ${tenantName}`,
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 560px; margin: 0 auto;">
        <h2>Einladung annehmen</h2>
        <p>Du wurdest als <strong>${roleLabel}</strong> in den Workspace <strong>${tenantName}</strong> eingeladen.</p>
        <p><a href="${acceptUrl}" style="background:#111;color:#fff;padding:12px 18px;border-radius:6px;text-decoration:none;display:inline-block;">Einladung annehmen</a></p>
        <p style="color:#666;font-size:13px;">Der Link ist 7 Tage gültig und kann nur einmal verwendet werden.</p>
      </div>
    `,
  });

  if (error) {
    console.error('Failed to send tenant invite email:', error);
    throw new Error('Failed to send tenant invite email');
  }

  console.log('Tenant invite email sent successfully:', data.id);
  return data;
}

// Helper function to generate user fingerprint
function generateUserFingerprint(req) {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const userAgent = req.headers['user-agent'] || '';
  return `${ip}_${Buffer.from(userAgent).toString('base64').slice(0, 10)}`;
}

async function createUserSession(userId, now = new Date()) {
  const sessionToken = buildInviteToken();
  const sessionRef = db.collection('sessions').doc();
  const sessionData = buildSessionData({
    userId,
    token: sessionToken,
    now,
  });

  await sessionRef.create(sessionData);
  return {
    sessionToken,
    session: {
      id: sessionRef.id,
      userId,
      expiresAt: sessionData.expiresAt,
    },
  };
}

async function loadActiveUserTenants(userId) {
  const membershipsSnapshot = await db.collection('memberships')
    .where('userId', '==', userId)
    .where('status', '==', 'active')
    .get();

  const memberships = membershipsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  const tenantDocs = await Promise.all(
    [...new Set(memberships.map(membership => membership.tenantId).filter(Boolean))]
      .map(tenantId => db.collection('tenants').doc(tenantId).get())
  );

  const tenantsById = {};
  tenantDocs.forEach(doc => {
    if (doc.exists && isActiveTenant(doc.data() || {})) {
      tenantsById[doc.id] = { id: doc.id, ...doc.data() };
    }
  });

  return memberships
    .filter(membership => tenantsById[membership.tenantId])
    .map(membership => {
      const tenant = tenantsById[membership.tenantId];
      return {
        membershipId: membership.id,
        role: normalizeMembershipRole(membership.role),
        tenant: {
          id: tenant.id,
          slug: tenant.slug || tenant.id,
          name: tenant.displayName || tenant.name || tenant.id,
        },
      };
    })
    .sort((a, b) => (a.tenant.name || '').localeCompare(b.tenant.name || ''));
}

async function resolvePendingInviteByToken(token) {
  const tokenHash = buildInviteTokenHash(token || '');
  const snapshot = await db.collection('invites')
    .where('tokenHash', '==', tokenHash)
    .limit(2)
    .get();

  if (snapshot.size > 1) {
    throw new Error('Multiple invites found for token');
  }

  if (snapshot.empty) {
    return { errorStatus: 404, error: 'Invite not found' };
  }

  const inviteDoc = snapshot.docs[0];
  const invite = inviteDoc.data() || {};
  if (invite.status !== 'pending') {
    return { errorStatus: 410, error: 'Invite is no longer pending' };
  }

  if (isInviteExpired(invite)) {
    return { errorStatus: 410, error: 'Invite has expired' };
  }

  const tenantDoc = await db.collection('tenants').doc(invite.tenantId).get();
  if (!tenantDoc.exists || !isActiveTenant(tenantDoc.data() || {})) {
    return { errorStatus: 404, error: 'Tenant not found' };
  }

  return {
    inviteDoc,
    invite,
    tenant: { id: tenantDoc.id, ...tenantDoc.data() },
  };
}

function buildPublicInviteResponse(invite, tenant) {
  return {
    email: invite.email,
    role: normalizeMembershipRole(invite.role),
    expiresAt: invite.expiresAt,
    tenant: {
      id: tenant.id,
      slug: tenant.slug || tenant.id,
      name: tenant.displayName || tenant.name || tenant.id,
    },
  };
}

function buildSignupWorkspaceConfig(body = {}) {
  let email;
  try {
    email = normalizeInviteEmail(body.email);
  } catch (error) {
    throw new Error(error.message || 'Invalid email');
  }

  const tenantName = cleanTenantSettingText(body.workspaceName || body.tenantName, '');
  if (!tenantName) {
    throw new Error('Workspace name is required');
  }

  return buildTenantProvisionConfig({
    tenantName,
    tenantSlug: body.workspaceSlug || body.tenantSlug,
    appName: body.boardName || body.appName || `${tenantName} Board`,
    ticketPrefix: body.ticketPrefix,
  });
}

async function resolvePendingLoginLinkByToken(token) {
  const tokenHash = buildInviteTokenHash(token || '');
  const snapshot = await db.collection('loginLinks')
    .where('tokenHash', '==', tokenHash)
    .limit(2)
    .get();

  if (snapshot.size > 1) {
    throw new Error('Multiple login links found for token');
  }

  if (snapshot.empty) {
    return { errorStatus: 404, error: 'Login link not found' };
  }

  const loginLinkDoc = snapshot.docs[0];
  const loginLink = loginLinkDoc.data() || {};
  if (loginLink.status !== 'pending') {
    return { errorStatus: 410, error: 'Login link is no longer pending' };
  }

  if (isLoginLinkExpired(loginLink)) {
    return { errorStatus: 410, error: 'Login link has expired' };
  }

  const userSnapshot = await db.collection('users')
    .where('email', '==', loginLink.email)
    .limit(1)
    .get();

  if (userSnapshot.empty) {
    return { errorStatus: 404, error: 'User not found' };
  }

  const userDoc = userSnapshot.docs[0];
  const user = { id: userDoc.id, ...userDoc.data() };
  if (user.status && user.status !== 'active') {
    return { errorStatus: 403, error: 'User is disabled' };
  }

  return { loginLinkDoc, loginLink, user };
}

// Public auth: request a one-time login link for an existing invited user
app.post('/api/auth/login-links', rateLimit(60000, 5), async (req, res) => {
  try {
    let email;
    try {
      email = normalizeInviteEmail(req.body?.email);
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Invalid email' });
    }

    const userSnapshot = await db.collection('users')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (userSnapshot.empty) {
      return res.status(404).json({ error: 'No user found for this email' });
    }

    const user = { id: userSnapshot.docs[0].id, ...userSnapshot.docs[0].data() };
    if (user.status && user.status !== 'active') {
      return res.status(403).json({ error: 'User is disabled' });
    }

    const token = buildInviteToken();
    const loginLinkData = buildLoginLinkData({
      email,
      token,
      redirectUrl: req.body?.redirectUrl,
      now: new Date(),
    });

    const docRef = await db.collection('loginLinks').add(loginLinkData);
    const loginUrl = `${buildRequestBaseUrl(req)}/login.html?token=${encodeURIComponent(token)}`;
    await sendLoginLinkEmail({ to: email, loginUrl });

    res.status(201).json({
      id: docRef.id,
      email,
      expiresAt: loginLinkData.expiresAt,
      delivery: 'email',
    });
  } catch (error) {
    console.error('Error creating login link:', error);
    res.status(500).json({ error: 'Failed to create login link' });
  }
});

// Public signup: create a new workspace and send the owner a magic login link
app.post('/api/signup/workspaces', rateLimit(60000, 3), async (req, res) => {
  try {
    let email;
    let config;
    try {
      email = normalizeInviteEmail(req.body?.email);
      config = buildSignupWorkspaceConfig(req.body || {});
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Invalid signup data' });
    }

    const [tenantDoc, slugSnapshot, existingUserSnapshot] = await Promise.all([
      db.collection('tenants').doc(config.tenantId).get(),
      db.collection('tenants').where('slug', '==', config.tenantSlug).limit(1).get(),
      db.collection('users').where('email', '==', email).limit(1).get(),
    ]);

    if (tenantDoc.exists || !slugSnapshot.empty) {
      return res.status(409).json({ error: 'Workspace slug already exists' });
    }

    if (!existingUserSnapshot.empty) {
      const existingUserId = existingUserSnapshot.docs[0].id;
      const existingMemberships = await db.collection('memberships')
        .where('userId', '==', existingUserId)
        .where('status', '==', 'active')
        .limit(1)
        .get();

      if (!existingMemberships.empty) {
        return res.status(409).json({ error: 'A workspace already exists for this email' });
      }
    }

    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    const now = new Date();
    const docs = buildTenantProvisionDocuments(config, timestamp);
    const tenantRef = db.collection('tenants').doc(config.tenantId);
    const appRef = db.collection('apps').doc();
    const counterRef = db.collection('counters').doc(appRef.id);
    const userRef = existingUserSnapshot.empty
      ? db.collection('users').doc()
      : existingUserSnapshot.docs[0].ref;
    const membershipRef = db.collection('memberships').doc();

    const batch = db.batch();
    batch.create(tenantRef, docs.tenant);
    batch.create(appRef, docs.app);
    batch.create(counterRef, docs.counter);

    if (existingUserSnapshot.empty) {
      batch.create(userRef, buildUserData({
        email,
        displayName: email,
        now,
      }));
    } else {
      batch.set(userRef, {
        status: 'active',
        updatedAt: now,
      }, { merge: true });
    }

    batch.create(membershipRef, {
      ...buildMembershipData({
        tenantId: config.tenantId,
        userId: userRef.id,
        role: 'owner',
        now,
      }),
      email,
    });
    await batch.commit();

    const token = buildInviteToken();
    const loginLinkData = buildLoginLinkData({
      email,
      token,
      redirectUrl: `/tenant-admin.html?tenant=${encodeURIComponent(config.tenantSlug)}&onboarding=1`,
      now,
    });
    const loginLinkRef = await db.collection('loginLinks').add(loginLinkData);
    const signupLoginUrl = `${buildRequestBaseUrl(req)}/login.html?token=${encodeURIComponent(token)}`;
    await sendLoginLinkEmail({ to: email, loginUrl: signupLoginUrl });

    res.status(201).json({
      tenant: {
        id: config.tenantId,
        slug: config.tenantSlug,
        name: config.tenantName,
      },
      app: {
        id: appRef.id,
        slug: config.appSlug,
        name: config.appName,
      },
      user: {
        id: userRef.id,
        email,
      },
      membership: {
        id: membershipRef.id,
        role: 'owner',
      },
      loginLink: {
        id: loginLinkRef.id,
        expiresAt: loginLinkData.expiresAt,
        delivery: 'email',
      },
      urls: {
        tenantAdmin: `/tenant-admin.html?tenant=${encodeURIComponent(config.tenantSlug)}`,
      },
      delivery: 'email',
    });
  } catch (error) {
    console.error('Error creating signup workspace:', error);
    res.status(500).json({ error: 'Failed to create workspace' });
  }
});

// Public auth: consume a one-time login link and create a user session
app.post('/api/auth/login-links/:token/consume', rateLimit(60000, 10), async (req, res) => {
  try {
    const resolved = await resolvePendingLoginLinkByToken(req.params.token);
    if (resolved.error) {
      return res.status(resolved.errorStatus).json({ error: resolved.error });
    }

    const now = new Date();
    const { sessionToken, session } = await createUserSession(resolved.user.id, now);
    await resolved.loginLinkDoc.ref.set({
      status: 'consumed',
      consumedAt: now,
      updatedAt: now,
      consumedUserId: resolved.user.id,
    }, { merge: true });

    const tenants = await loadActiveUserTenants(resolved.user.id);
    const firstTenant = tenants[0]?.tenant || null;
    const redirectUrl = resolved.loginLink.redirectUrl || (
      firstTenant
        ? `/tenant-admin.html?tenant=${encodeURIComponent(firstTenant.slug || firstTenant.id)}`
        : null
    );

    res.json({
      success: true,
      sessionToken,
      session,
      user: {
        id: resolved.user.id,
        email: resolved.user.email,
        displayName: resolved.user.displayName || resolved.user.email,
      },
      tenants,
      urls: {
        tenantAdmin: redirectUrl,
      },
    });
  } catch (error) {
    console.error('Error consuming login link:', error);
    res.status(500).json({ error: 'Failed to consume login link' });
  }
});

// Public auth: describe the current admin/session context for role-aware UI
app.get('/api/auth/session', async (req, res) => {
  try {
    const sessionAuth = await resolveSessionAuth(req);
    if (sessionAuth) {
      const tenants = await loadActiveUserTenants(sessionAuth.user.id);
      return res.json({
        authType: 'user',
        platformRole: null,
        user: {
          id: sessionAuth.user.id,
          email: sessionAuth.user.email,
          displayName: sessionAuth.user.displayName || sessionAuth.user.email,
        },
        memberships: tenants.map(item => ({
          membershipId: item.membershipId,
          role: item.role,
          tenantId: item.tenant.id,
          tenantSlug: item.tenant.slug || item.tenant.id,
          tenantName: item.tenant.name,
        })),
      });
    }

    if (hasValidAdminPassword(req)) {
      return res.json({
        authType: 'platform',
        platformRole: 'super_admin',
        user: {
          id: 'platform-admin',
          email: 'platform-admin',
          displayName: 'Platform Admin',
        },
        memberships: [],
      });
    }

    return res.status(401).json({ error: 'Unauthorized - Session required' });
  } catch (error) {
    console.error('Error loading auth session:', error);
    res.status(500).json({ error: 'Failed to load auth session' });
  }
});

// Public invite: inspect a pending invite token
app.get('/api/invites/:token', async (req, res) => {
  try {
    const resolved = await resolvePendingInviteByToken(req.params.token);
    if (resolved.error) {
      return res.status(resolved.errorStatus).json({ error: resolved.error });
    }

    res.json(buildPublicInviteResponse(resolved.invite, resolved.tenant));
  } catch (error) {
    console.error('Error resolving invite:', error);
    res.status(500).json({ error: 'Failed to resolve invite' });
  }
});

// Public invite: accept a pending invite token
app.post('/api/invites/:token/accept', rateLimit(60000, 10), async (req, res) => {
  try {
    const resolved = await resolvePendingInviteByToken(req.params.token);
    if (resolved.error) {
      return res.status(resolved.errorStatus).json({ error: resolved.error });
    }

    const { inviteDoc, invite, tenant } = resolved;
    const now = new Date();
    const displayName = typeof req.body?.displayName === 'string'
      ? req.body.displayName.trim().replace(/\s+/g, ' ')
      : '';

    const existingUser = await db.collection('users')
      .where('email', '==', invite.email)
      .limit(1)
      .get();

    const userRef = existingUser.empty
      ? db.collection('users').doc()
      : existingUser.docs[0].ref;
    const userId = userRef.id;

    const existingMembership = await db.collection('memberships')
      .where('tenantId', '==', tenant.id)
      .where('userId', '==', userId)
      .limit(1)
      .get();

    const membershipRef = existingMembership.empty
      ? db.collection('memberships').doc()
      : existingMembership.docs[0].ref;

    const batch = db.batch();
    if (existingUser.empty) {
      batch.create(userRef, buildUserData({
        email: invite.email,
        displayName,
        now,
      }));
    } else if (displayName && !existingUser.docs[0].data()?.displayName) {
      batch.set(userRef, {
        displayName,
        updatedAt: now,
      }, { merge: true });
    }

    const membershipData = buildMembershipData({
      tenantId: tenant.id,
      userId,
      role: invite.role,
      now,
    });
    if (existingMembership.empty) {
      batch.create(membershipRef, membershipData);
    } else {
      batch.set(membershipRef, {
        role: membershipData.role,
        status: 'active',
        updatedAt: now,
      }, { merge: true });
    }

    batch.set(inviteDoc.ref, {
      status: 'accepted',
      acceptedAt: now,
      updatedAt: now,
      acceptedUserId: userId,
    }, { merge: true });

    await batch.commit();
    const { sessionToken, session } = await createUserSession(userId, new Date());

    res.json({
      success: true,
      sessionToken,
      session,
      user: {
        id: userId,
        email: invite.email,
        displayName: displayName || invite.email,
      },
      membership: {
        id: membershipRef.id,
        tenantId: tenant.id,
        role: membershipData.role,
        status: 'active',
      },
      tenant: {
        id: tenant.id,
        slug: tenant.slug || tenant.id,
        name: tenant.displayName || tenant.name || tenant.id,
      },
      urls: {
        tenantAdmin: `/tenant-admin.html?tenant=${encodeURIComponent(tenant.slug || tenant.id)}`,
      },
    });
  } catch (error) {
    console.error('Error accepting invite:', error);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

// SaaS public: resolve an active tenant by slug
app.get('/api/tenants/:tenantSlug', async (req, res) => {
  try {
    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    if (!tenantSlug) {
      return res.status(400).json({ error: 'Invalid tenant slug' });
    }

    const tenant = await findActiveTenantBySlug(tenantSlug);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    res.json(tenant);
  } catch (error) {
    console.error('Error fetching tenant:', error);
    res.status(500).json({ error: 'Failed to fetch tenant' });
  }
});

// SaaS public: get apps for an active tenant
app.get('/api/tenants/:tenantSlug/apps', async (req, res) => {
  try {
    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    if (!tenantSlug) {
      return res.status(400).json({ error: 'Invalid tenant slug' });
    }

    const tenant = await findActiveTenantBySlug(tenantSlug);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const apps = await loadTenantApps(tenant.id);
    res.json(apps);
  } catch (error) {
    console.error('Error fetching tenant apps:', error);
    res.status(500).json({ error: 'Failed to fetch tenant apps' });
  }
});

// SaaS public: resolve one tenant app by slug
app.get('/api/tenants/:tenantSlug/apps/:appSlug', async (req, res) => {
  try {
    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    const appSlug = parseSlugParam(req.params.appSlug);
    if (!tenantSlug || !appSlug) {
      return res.status(400).json({ error: 'Invalid tenant or app slug' });
    }

    const tenant = await findActiveTenantBySlug(tenantSlug);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const tenantApp = await findTenantAppBySlug(tenant.id, appSlug);
    if (!tenantApp) {
      return res.status(404).json({ error: 'App not found' });
    }

    res.json(tenantApp);
  } catch (error) {
    console.error('Error fetching tenant app:', error);
    res.status(500).json({ error: 'Failed to fetch tenant app' });
  }
});

// SaaS public: get suggestions for a tenant app slug
app.get('/api/tenants/:tenantSlug/apps/:appSlug/suggestions', async (req, res) => {
  try {
    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    const appSlug = parseSlugParam(req.params.appSlug);
    if (!tenantSlug || !appSlug) {
      return res.status(400).json({ error: 'Invalid tenant or app slug' });
    }

    const { tenant, tenantApp, errorStatus, error } = await resolveTenantAndAppBySlug({ tenantSlug, appSlug });
    if (error) {
      return res.status(errorStatus).json({ error });
    }

    const suggestions = await loadPublicSuggestionsForApp(
      tenantApp.id,
      tenant.id,
      generateUserFingerprint(req)
    );

    res.json(suggestions);
  } catch (error) {
    console.error('Error fetching tenant suggestions:', error);
    res.status(500).json({ error: 'Failed to fetch tenant suggestions' });
  }
});

// SaaS public: create a suggestion for a tenant app slug
app.post('/api/tenants/:tenantSlug/apps/:appSlug/suggestions', rateLimit(60000, 3), async (req, res) => {
  try {
    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    const appSlug = parseSlugParam(req.params.appSlug);
    if (!tenantSlug || !appSlug) {
      return res.status(400).json({ error: 'Invalid tenant or app slug' });
    }

    const { tenant, tenantApp, errorStatus, error } = await resolveTenantAndAppBySlug({ tenantSlug, appSlug });
    if (error) {
      return res.status(errorStatus).json({ error });
    }

    const userFingerprint = generateUserFingerprint(req);
    const { suggestion, error: suggestionError } = buildSuggestionFromRequest(
      req.body,
      tenantApp.id,
      userFingerprint,
      tenant.id
    );
    if (suggestionError) {
      return res.status(400).json({ error: suggestionError });
    }

    suggestion.ticketNumber = await generateTicketNumber(tenantApp.id, tenant.id);

    const docRef = await db.collection('suggestions').add(suggestion);

    await logActivity(docRef.id, 'created', {
      detail: `${suggestion.type === 'bug' ? 'Bug' : suggestion.type === 'ticket' ? 'Ticket' : 'Vorschlag'} "${suggestion.title}" erstellt`,
      actor: `user:${userFingerprint}`,
      tenantId: tenant.id,
    });

    try {
      const recipients = await resolveNotificationRecipients(tenant.id);
      await sendAdminNotificationEmail(
        docRef.id,
        suggestion.title,
        suggestion.description,
        tenantApp.name,
        { type: suggestion.type, severity: suggestion.severity || null },
        recipients
      );
    } catch (emailError) {
      console.error('Error sending notification email:', emailError);
    }

    const typeMessages = {
      bug: 'Bug erfolgreich gemeldet. Er wird geprüft und dann freigegeben.',
      ticket: 'Ticket erfolgreich erstellt. Es wird geprüft und dann freigegeben.',
      feature: 'Vorschlag erfolgreich eingereicht. Er wird geprüft und dann freigegeben.',
    };

    res.status(201).json({
      id: docRef.id,
      ...suggestion,
      createdAt: new Date(),
      message: typeMessages[suggestion.type] || typeMessages.feature
    });
  } catch (error) {
    console.error('Error creating tenant suggestion:', error);
    res.status(500).json({ error: 'Failed to create suggestion' });
  }
});

// SaaS public: get releases for a tenant app slug
app.get('/api/tenants/:tenantSlug/apps/:appSlug/releases', async (req, res) => {
  try {
    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    const appSlug = parseSlugParam(req.params.appSlug);
    if (!tenantSlug || !appSlug) {
      return res.status(400).json({ error: 'Invalid tenant or app slug' });
    }

    const tenant = await findActiveTenantBySlug(tenantSlug);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const tenantApp = await findTenantAppBySlug(tenant.id, appSlug);
    if (!tenantApp) {
      return res.status(404).json({ error: 'App not found' });
    }

    const { releases, error } = await loadPublicReleasesForApp(
      tenantApp.id,
      tenant.id,
      req.query.status
    );

    if (error) {
      return res.status(400).json({ error });
    }

    res.json(releases);
  } catch (error) {
    console.error('Error fetching tenant releases:', error);
    res.status(500).json({ error: 'Failed to fetch tenant releases' });
  }
});

// SaaS public: get public comments for a tenant suggestion
app.get('/api/tenants/:tenantSlug/suggestions/:suggestionId/comments', async (req, res) => {
  try {
    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    const { suggestionId } = req.params;
    if (!tenantSlug) {
      return res.status(400).json({ error: 'Invalid tenant slug' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID format' });
    }

    const tenant = await findActiveTenantBySlug(tenantSlug);
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    const suggestionData = suggestionDoc.exists ? suggestionDoc.data() : null;
    if (
      !suggestionDoc.exists ||
      !suggestionData.approved ||
      getTenantId(suggestionData) !== tenant.id
    ) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const commentsSnapshot = await db.collection('comments')
      .where('suggestionId', '==', suggestionId)
      .get();

    const comments = commentsSnapshot.docs
      .filter(doc => getTenantId(doc.data() || {}) === tenant.id)
      .map(buildPublicCommentResponse)
      .filter(Boolean);

    comments.sort((a, b) => {
      const aTime = a.createdAt?.toDate?.() ?? (a.createdAt?._seconds != null ? new Date(a.createdAt._seconds * 1000) : new Date(0));
      const bTime = b.createdAt?.toDate?.() ?? (b.createdAt?._seconds != null ? new Date(b.createdAt._seconds * 1000) : new Date(0));
      return bTime - aTime;
    });

    res.json(comments);
  } catch (error) {
    console.error('Error fetching tenant comments:', error);
    res.status(500).json({ error: 'Failed to fetch tenant comments' });
  }
});

// SaaS public: vote for a tenant suggestion
app.post('/api/tenants/:tenantSlug/suggestions/:suggestionId/vote', rateLimit(60000, 5), async (req, res) => {
  try {
    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    const { suggestionId } = req.params;
    const userFingerprint = generateUserFingerprint(req);

    if (!tenantSlug) {
      return res.status(400).json({ error: 'Invalid tenant slug' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID' });
    }

    const { tenant, suggestionData, errorStatus, error } = await resolveTenantSuggestionById(tenantSlug, suggestionId);
    if (error) {
      return res.status(errorStatus).json({ error });
    }

    if (!suggestionData.approved) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const suggestionType = normalizeSuggestionType(suggestionData.type);
    if (suggestionType !== 'feature') {
      return res.status(400).json({ error: 'Voting is only supported for feature suggestions' });
    }

    const existingVote = await db.collection('votes')
      .where('tenantId', '==', tenant.id)
      .where('suggestionId', '==', suggestionId)
      .where('userFingerprint', '==', userFingerprint)
      .limit(1)
      .get();

    if (!existingVote.empty) {
      return res.status(400).json({ error: 'You have already voted for this suggestion' });
    }

    const batch = db.batch();
    const voteRef = db.collection('votes').doc();
    batch.set(voteRef, {
      tenantId: tenant.id,
      suggestionId,
      userFingerprint,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress
    });

    batch.update(db.collection('suggestions').doc(suggestionId), {
      votes: admin.firestore.FieldValue.increment(1)
    });

    await batch.commit();

    res.json({ success: true, message: 'Vote recorded successfully' });
  } catch (error) {
    console.error('Error recording tenant vote:', error);
    res.status(500).json({ error: 'Failed to record vote' });
  }
});

// SaaS public: remove vote for a tenant suggestion
app.delete('/api/tenants/:tenantSlug/suggestions/:suggestionId/vote', rateLimit(60000, 5), async (req, res) => {
  try {
    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    const { suggestionId } = req.params;
    const userFingerprint = generateUserFingerprint(req);

    if (!tenantSlug) {
      return res.status(400).json({ error: 'Invalid tenant slug' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID' });
    }

    const { tenant, suggestionData, errorStatus, error } = await resolveTenantSuggestionById(tenantSlug, suggestionId);
    if (error) {
      return res.status(errorStatus).json({ error });
    }

    if (!suggestionData.approved) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const suggestionType = normalizeSuggestionType(suggestionData.type);
    if (suggestionType !== 'feature') {
      return res.status(400).json({ error: 'Voting is only supported for feature suggestions' });
    }

    const existingVote = await db.collection('votes')
      .where('tenantId', '==', tenant.id)
      .where('suggestionId', '==', suggestionId)
      .where('userFingerprint', '==', userFingerprint)
      .limit(1)
      .get();

    if (existingVote.empty) {
      return res.status(400).json({ error: 'You have not voted for this suggestion' });
    }

    const batch = db.batch();
    batch.delete(existingVote.docs[0].ref);
    batch.update(db.collection('suggestions').doc(suggestionId), {
      votes: Math.max(0, (suggestionData.votes || 0) - 1)
    });

    await batch.commit();

    res.json({ success: true, message: 'Vote removed successfully' });
  } catch (error) {
    console.error('Error removing tenant vote:', error);
    res.status(500).json({ error: 'Failed to remove vote' });
  }
});

// SaaS public: check whether current user voted for a tenant suggestion
app.get('/api/tenants/:tenantSlug/suggestions/:suggestionId/voted', async (req, res) => {
  try {
    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    const { suggestionId } = req.params;
    const userFingerprint = generateUserFingerprint(req);

    if (!tenantSlug) {
      return res.status(400).json({ error: 'Invalid tenant slug' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID' });
    }

    const { tenant, suggestionData, errorStatus, error } = await resolveTenantSuggestionById(tenantSlug, suggestionId);
    if (error) {
      return res.status(errorStatus).json({ error });
    }

    if (!suggestionData.approved) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const voteSnapshot = await db.collection('votes')
      .where('tenantId', '==', tenant.id)
      .where('suggestionId', '==', suggestionId)
      .where('userFingerprint', '==', userFingerprint)
      .limit(1)
      .get();

    res.json({ voted: !voteSnapshot.empty });
  } catch (error) {
    console.error('Error checking tenant vote status:', error);
    res.status(500).json({ error: 'Failed to check vote status' });
  }
});

// SaaS public: submit comment for an approved tenant suggestion
app.post('/api/tenants/:tenantSlug/suggestions/:suggestionId/comments', rateLimit(60000, 3), async (req, res) => {
  try {
    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    const { suggestionId } = req.params;
    const { text, screenshots } = req.body;
    const userFingerprint = generateUserFingerprint(req);

    if (!tenantSlug) {
      return res.status(400).json({ error: 'Invalid tenant slug' });
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID format' });
    }

    const validText = validateInput(text, 2000);
    if (!validText) {
      return res.status(400).json({ error: 'Invalid comment text' });
    }

    const screenshotValidation = validateCommentScreenshots(screenshots);
    if (screenshotValidation.error) {
      return res.status(400).json({ error: screenshotValidation.error });
    }

    const { tenant, suggestionData, errorStatus, error } = await resolveTenantSuggestionById(tenantSlug, suggestionId);
    if (error) {
      return res.status(errorStatus).json({ error });
    }

    if (!suggestionData.approved) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const comment = {
      tenantId: tenant.id,
      suggestionId,
      text: validText,
      screenshots: screenshotValidation.screenshots,
      authorType: 'user',
      authorFingerprint: userFingerprint,
      approvalStatus: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const commentRef = await db.collection('comments').add(comment);

    await logActivity(suggestionId, 'comment_submitted', {
      detail: `Benutzer-Kommentar eingereicht: "${validText.slice(0, 80)}${validText.length > 80 ? '...' : ''}"`,
      actor: `user:${userFingerprint}`,
      tenantId: tenant.id,
    });

    try {
      const appDoc = await db.collection('apps').doc(suggestionData.appId).get();
      const appName = appDoc.exists ? appDoc.data().name : 'Unbekannte App';
      const recipients = await resolveNotificationRecipients(tenant.id);
      await sendAdminCommentNotificationEmail(suggestionId, suggestionData.title, validText, appName, recipients);
    } catch (notificationError) {
      console.error('Error sending admin comment notification:', notificationError);
    }

    res.status(201).json({
      id: commentRef.id,
      message: 'Kommentar erfolgreich eingereicht und zur Freigabe vorgemerkt'
    });
  } catch (error) {
    console.error('Error submitting tenant public comment:', error);
    res.status(500).json({ error: 'Failed to submit comment' });
  }
});

// Get all apps (legacy public board: only legacy-tenant apps, no test/hidden/blacklisted ones)
app.get('/api/apps', async (req, res) => {
  try {
    const appsSnapshot = await db.collection('apps').get();
    const apps = appsSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(appData => isLegacyPublicAppVisible(appData));

    apps.sort((a, b) => (a.name || '').localeCompare(b.name || ''));

    res.json(apps);
  } catch (error) {
    console.error('Error fetching apps:', error);
    res.status(500).json({ error: 'Failed to fetch apps' });
  }
});

// Get suggestions for an app (only approved ones)
app.get('/api/apps/:appId/suggestions', async (req, res) => {
  try {
    const { appId } = req.params;
    const userFingerprint = generateUserFingerprint(req);

    // Validate appId format
    if (!/^[a-zA-Z0-9_-]+$/.test(appId)) {
      return res.status(400).json({ error: 'Invalid app ID format' });
    }

    const appDoc = await db.collection('apps').doc(appId).get();
    if (!appDoc.exists || !isLegacyPublicAppVisible({ id: appId, ...appDoc.data() })) {
      return res.status(404).json({ error: 'App not found' });
    }

    // Get suggestions for this app
    const suggestionsSnapshot = await db.collection('suggestions')
      .where('appId', '==', appId)
      .where('approved', '==', true)
      .get();

    if (suggestionsSnapshot.empty) {
      return res.json([]);
    }

    const suggestionIds = suggestionsSnapshot.docs.map(doc => doc.id);

    // Batch load comments and votes for these suggestions in Firestore-safe chunks.
    const [commentDocs, userVoteDocs] = await Promise.all([
      queryCollectionInChunks(db, {
        collectionName: 'comments',
        fieldName: 'suggestionId',
        values: suggestionIds,
      }),
      queryCollectionInChunks(db, {
        collectionName: 'votes',
        fieldName: 'suggestionId',
        values: suggestionIds,
        applyChunkQuery: query => query.where('userFingerprint', '==', userFingerprint),
      })
    ]);

    // Create maps
    const commentStatsMap = {};
    commentDocs.forEach(doc => {
      const suggestionId = doc.data().suggestionId;
      if (!commentStatsMap[suggestionId]) {
        commentStatsMap[suggestionId] = {
          totalCount: 0,
          pendingCount: 0,
          publicCount: 0,
        };
      }

      const stats = buildCommentStats([doc]);
      commentStatsMap[suggestionId].totalCount += stats.totalCount;
      commentStatsMap[suggestionId].pendingCount += stats.pendingCount;
      commentStatsMap[suggestionId].publicCount += stats.publicCount;
    });

    const userVotesSet = new Set(
      userVoteDocs.map(doc => doc.data().suggestionId)
    );

    const suggestions = suggestionsSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(data => isLegacyTenantData(data))
      .map(data => {
        const type = normalizeSuggestionType(data.type);

        return {
          id: data.id,
          ...data,
          type,
          status: data.status || mapLegacyTagToStatus(type, data.tag, data.approved),
          priority: data.priority || 'mittel',
          labels: data.labels || [],
          ticketNumber: data.ticketNumber || null,
          commentCount: commentStatsMap[data.id]?.publicCount || 0,
          hasVoted: type === 'feature' && userVotesSet.has(data.id)
        };
      });

    // Sort: resolved/implemented items sink to the bottom, votable first, then newest
    suggestions.sort((a, b) => {
      const aStatus = a.status || '';
      const bStatus = b.status || '';

      const resolvedStatuses = RESOLVED_STATUSES;
      const aImplemented = resolvedStatuses.includes(aStatus);
      const bImplemented = resolvedStatuses.includes(bStatus);

      if (aImplemented !== bImplemented) {
        return aImplemented ? 1 : -1; // implemented last
      }

      const aVotable = !aImplemented && !a.hasVoted;
      const bVotable = !bImplemented && !b.hasVoted;
      if (aVotable !== bVotable) {
        return aVotable ? -1 : 1; // votable first
      }

      // Then: newest first
      const aTime = a.createdAt?.toDate?.() || a.createdAt || new Date(0);
      const bTime = b.createdAt?.toDate?.() || b.createdAt || new Date(0);
      if (bTime - aTime !== 0) {
        return bTime - aTime;
      }

      // Then: most votes first (stable-ish fallback)
      const aVotes = a.votes || 0;
      const bVotes = b.votes || 0;
      if (bVotes !== aVotes) {
        return bVotes - aVotes;
      }

      return (a.title || a.id || '').localeCompare((b.title || b.id || ''));
    });

    res.json(suggestions);
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// Create new suggestion
app.post('/api/apps/:appId/suggestions', rateLimit(60000, 3), async (req, res) => {
  try {
    const { appId } = req.params;
    const userFingerprint = generateUserFingerprint(req);

    // Check if app exists and is publicly visible on the legacy board
    const appDoc = await db.collection('apps').doc(appId).get();
    if (!appDoc.exists || !isLegacyPublicAppVisible({ id: appId, ...appDoc.data() })) {
      return res.status(404).json({ error: 'App not found' });
    }

    const appData = appDoc.data() || {};
    const tenantId = getTenantId(appData);

    const { suggestion, error } = buildSuggestionFromRequest(req.body, appId, userFingerprint, tenantId);
    if (error) {
      return res.status(400).json({ error });
    }

    // Generate ticket number
    const ticketNumber = await generateTicketNumber(appId, tenantId);
    suggestion.ticketNumber = ticketNumber;

    const docRef = await db.collection('suggestions').add(suggestion);

    // Log activity
    await logActivity(docRef.id, 'created', {
      detail: `${suggestion.type === 'bug' ? 'Bug' : suggestion.type === 'ticket' ? 'Ticket' : 'Vorschlag'} "${suggestion.title}" erstellt`,
      actor: `user:${userFingerprint}`,
      tenantId,
    });

    // Send email notification to admin
    try {
      const recipients = await resolveNotificationRecipients(tenantId);
      await sendAdminNotificationEmail(
        docRef.id,
        suggestion.title,
        suggestion.description,
        appData.name,
        { type: suggestion.type, severity: suggestion.severity || null },
        recipients
      );
    } catch (emailError) {
      console.error('Error sending notification email:', emailError);
      // Continue even if email fails
    }

    const typeMessages = {
      bug: 'Bug erfolgreich gemeldet. Er wird geprüft und dann freigegeben.',
      ticket: 'Ticket erfolgreich erstellt. Es wird geprüft und dann freigegeben.',
      feature: 'Vorschlag erfolgreich eingereicht. Er wird geprüft und dann freigegeben.',
    };

    res.status(201).json({
      id: docRef.id,
      ...suggestion,
      createdAt: new Date(),
      message: typeMessages[suggestion.type] || typeMessages.feature
    });
  } catch (error) {
    console.error('Error creating suggestion:', error);
    res.status(500).json({ error: 'Failed to create suggestion' });
  }
});

// Vote for a suggestion
app.post('/api/suggestions/:suggestionId/vote', rateLimit(60000, 5), async (req, res) => {
  try {
    const { suggestionId } = req.params;
    const userFingerprint = generateUserFingerprint(req);

    // Validate suggestionId format
    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID' });
    }

    // Check if suggestion exists
    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists || !isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }
    const suggestionData = suggestionDoc.data() || {};
    if (!isLegacyTenantData(suggestionData)) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }
    const suggestionType = normalizeSuggestionType(suggestionData.type);
    if (suggestionType !== 'feature') {
      return res.status(400).json({ error: 'Voting is only supported for feature suggestions' });
    }

    // Check if user already voted
    const existingVote = await db.collection('votes')
      .where('suggestionId', '==', suggestionId)
      .where('userFingerprint', '==', userFingerprint)
      .limit(1)
      .get();

    if (!existingVote.empty) {
      return res.status(400).json({ error: 'You have already voted for this suggestion' });
    }

    // Add vote and increment suggestion vote count
    const batch = db.batch();

    const voteRef = db.collection('votes').doc();
    batch.set(voteRef, {
      tenantId: getTenantId(suggestionData),
      suggestionId,
      userFingerprint,
      timestamp: admin.firestore.FieldValue.serverTimestamp(),
      ip: req.headers['x-forwarded-for'] || req.connection.remoteAddress
    });

    const suggestionRef = db.collection('suggestions').doc(suggestionId);
    batch.update(suggestionRef, {
      votes: admin.firestore.FieldValue.increment(1)
    });

    await batch.commit();

    res.json({ success: true, message: 'Vote recorded successfully' });
  } catch (error) {
    console.error('Error recording vote:', error);
    res.status(500).json({ error: 'Failed to record vote' });
  }
});

// Remove vote for a suggestion (unvote)
app.delete('/api/suggestions/:suggestionId/vote', rateLimit(60000, 5), async (req, res) => {
  try {
    const { suggestionId } = req.params;
    const userFingerprint = generateUserFingerprint(req);

    // Validate suggestionId format
    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID' });
    }

    // Check if suggestion exists
    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists || !isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }
    const suggestionType = normalizeSuggestionType(suggestionDoc.data()?.type);
    if (!isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }
    if (suggestionType !== 'feature') {
      return res.status(400).json({ error: 'Voting is only supported for feature suggestions' });
    }

    // Check if user has voted
    const existingVote = await db.collection('votes')
      .where('suggestionId', '==', suggestionId)
      .where('userFingerprint', '==', userFingerprint)
      .limit(1)
      .get();

    if (existingVote.empty) {
      return res.status(400).json({ error: 'You have not voted for this suggestion' });
    }

    // Remove vote and decrement suggestion vote count
    const batch = db.batch();

    // Delete the vote
    const voteDoc = existingVote.docs[0];
    batch.delete(voteDoc.ref);

    // Decrement suggestion vote count (ensure it doesn't go below 0)
    const suggestionRef = db.collection('suggestions').doc(suggestionId);
    const currentSuggestion = await suggestionRef.get();
    const currentVotes = currentSuggestion.data()?.votes || 0;

    batch.update(suggestionRef, {
      votes: Math.max(0, currentVotes - 1)
    });

    await batch.commit();

    res.json({ success: true, message: 'Vote removed successfully' });
  } catch (error) {
    console.error('Error removing vote:', error);
    res.status(500).json({ error: 'Failed to remove vote' });
  }
});

// Check if user has voted for a suggestion
app.get('/api/suggestions/:suggestionId/voted', async (req, res) => {
  try {
    const { suggestionId } = req.params;
    const userFingerprint = generateUserFingerprint(req);

    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists || !isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const voteSnapshot = await db.collection('votes')
      .where('suggestionId', '==', suggestionId)
      .where('userFingerprint', '==', userFingerprint)
      .limit(1)
      .get();

    res.json({ voted: !voteSnapshot.empty });
  } catch (error) {
    console.error('Error checking vote status:', error);
    res.status(500).json({ error: 'Failed to check vote status' });
  }
});

// ADMIN ENDPOINTS

// Input validation helper
function validateInput(text, maxLength = 500) {
  if (!text || typeof text !== 'string') {
    return null;
  }

  const cleaned = text.trim();
  if (cleaned.length === 0 || cleaned.length > maxLength) {
    return null;
  }

  // Basic XSS prevention
  const sanitized = cleaned.replace(/<[^>]*>/g, '');
  return sanitized;
}

function normalizeSuggestionType(type) {
  const normalized = (type || '').toString().trim().toLowerCase();
  return VALID_SUGGESTION_TYPES.includes(normalized) ? normalized : 'feature';
}

function isValidEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email.trim());
}

function buildSuggestionFromRequest(body, appId, userFingerprint, tenantId = LEGACY_TENANT_ID) {
  const type = normalizeSuggestionType(body.type);
  const validTitle = validateInput(body.title, 100);
  const validDescription = validateInput(body.description, 1000);

  if (!validTitle || !validDescription) {
    return { error: 'Invalid title or description' };
  }

  const suggestion = {
    tenantId: getTenantId({ tenantId }),
    appId,
    type,
    title: validTitle,
    description: validDescription,
    notificationEnabled: Boolean(body.notificationEnabled),
    notificationEmail: null,
    votes: 0,
    approved: false,
    status: 'neu',
    priority: 'mittel',
    labels: [],
    userFingerprint,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  };

  if (suggestion.notificationEnabled) {
    if (!isValidEmail(body.notificationEmail)) {
      return { error: 'Valid notification email is required when notifications are enabled' };
    }
    suggestion.notificationEmail = body.notificationEmail.trim();
  }

  if (type === 'bug') {
    const severity = (body.severity || '').toString().trim().toLowerCase();
    const stepsToReproduce = validateInput(body.stepsToReproduce, 2000);
    const expectedBehavior = validateInput(body.expectedBehavior, 1000);
    const actualBehavior = validateInput(body.actualBehavior, 1000);

    if (!VALID_BUG_SEVERITIES.includes(severity)) {
      return { error: 'Invalid bug severity' };
    }

    if (!stepsToReproduce || !expectedBehavior || !actualBehavior) {
      return { error: 'Missing required bug details' };
    }

    suggestion.severity = severity;
    suggestion.stepsToReproduce = stepsToReproduce;
    suggestion.expectedBehavior = expectedBehavior;
    suggestion.actualBehavior = actualBehavior;
    suggestion.environment = {
      appVersion: validateInput(body?.environment?.appVersion, 100) || null,
      platform: validateInput(body?.environment?.platform, 100) || null,
      browser: validateInput(body?.environment?.browser, 100) || null
    };
    // Map bug severity to unified priority
    suggestion.priority = mapSeverityToPriority(severity);

    // Bug screenshots (optional)
    if (body.screenshots && Array.isArray(body.screenshots)) {
      const validScreenshots = body.screenshots
        .filter(s => typeof s === 'string' && s.startsWith('data:image/') && s.length < 300000)
        .slice(0, 3);
      const totalSize = validScreenshots.reduce((sum, s) => sum + s.length, 0);
      if (totalSize <= 800000) {
        suggestion.screenshots = validScreenshots;
      }
    }
  }

  if (type === 'ticket') {
    const priority = (body.priority || '').toString().trim().toLowerCase();
    if (priority && VALID_PRIORITIES.includes(priority)) {
      suggestion.priority = priority;
    }
  }

  return { suggestion };
}

// Rate limiting store (in production use Redis)
const rateLimitStore = new Map();

// Rate limiting middleware
function rateLimit(windowMs = 60000, maxRequests = 10) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const now = Date.now();
    const windowStart = now - windowMs;

    if (!rateLimitStore.has(ip)) {
      rateLimitStore.set(ip, []);
    }

    const requests = rateLimitStore.get(ip).filter(time => time > windowStart);

    if (requests.length >= maxRequests) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    requests.push(now);
    rateLimitStore.set(ip, requests);
    next();
  };
}

// Enhanced admin authentication middleware
function requireAdminAuth(req, res, next) {
  if (hasValidAdminPassword(req)) {
    return next();
  }

  return res.status(401).json({ error: 'Unauthorized - Invalid credentials' });
}

function hasValidAdminPassword(req) {
  const authHeader = req.headers.authorization;
  const adminPassword = process.env.ADMIN_PASSWORD;

  // Require admin password to be set
  if (!adminPassword) {
    console.error('ADMIN_PASSWORD environment variable not set');
    return false;
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return false;
  }

  const token = authHeader.substring(7);
  return safeCompareSecret(token, adminPassword);
}

// Konstantzeitiger Vergleich, um Timing-Angriffe auf das Admin-Passwort zu verhindern.
// Über SHA-256-Digests verglichen, damit auch falsch-lange Tokens denselben Pfad
// nehmen und die Passwortlänge nicht übers Timing durchsickert.
function safeCompareSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const digestA = crypto.createHash('sha256').update(a, 'utf8').digest();
  const digestB = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(digestA, digestB);
}

async function resolveSessionAuth(req) {
  const sessionToken = req.headers['x-user-session'];
  if (!sessionToken || Array.isArray(sessionToken)) return null;

  const sessionSnapshot = await db.collection('sessions')
    .where('tokenHash', '==', buildInviteTokenHash(sessionToken))
    .where('status', '==', 'active')
    .limit(2)
    .get();

  if (sessionSnapshot.size !== 1) return null;

  const sessionDoc = sessionSnapshot.docs[0];
  const session = { id: sessionDoc.id, ...sessionDoc.data() };
  if (isSessionExpired(session)) return null;

  const userDoc = await db.collection('users').doc(session.userId).get();
  if (!userDoc.exists) return null;

  const user = { id: userDoc.id, ...userDoc.data() };
  if (user.status && user.status !== 'active') return null;

  await sessionDoc.ref.set({ lastUsedAt: new Date() }, { merge: true });
  return { type: 'session', session, user };
}

async function resolveAdminTenantFromParam(req, res) {
  if (req.adminTenant) return req.adminTenant;

  const tenantSlug = parseSlugParam(req.params.tenantSlug);
  if (!tenantSlug) {
    res.status(400).json({ error: 'Invalid tenant slug' });
    return null;
  }

  const tenant = await findActiveTenantBySlug(tenantSlug);
  if (!tenant) {
    res.status(404).json({ error: 'Tenant not found' });
    return null;
  }

  return tenant;
}

function requireTenantAccess(allowedRoles = MEMBERSHIP_ROLES) {
  return async (req, res, next) => {
    try {
      const tenant = await resolveAdminTenantFromParam(req, res);
      if (!tenant) return;

      const sessionAuth = await resolveSessionAuth(req);
      if (sessionAuth) {
        const membershipSnapshot = await db.collection('memberships')
          .where('tenantId', '==', tenant.id)
          .where('userId', '==', sessionAuth.user.id)
          .where('status', '==', 'active')
          .limit(1)
          .get();

        if (membershipSnapshot.empty) {
          return res.status(403).json({ error: 'Forbidden - Tenant membership required' });
        }

        const membership = { id: membershipSnapshot.docs[0].id, ...membershipSnapshot.docs[0].data() };
        const role = normalizeMembershipRole(membership.role);
        if (!allowedRoles.includes(role)) {
          return res.status(403).json({ error: 'Forbidden - Insufficient role' });
        }

        req.adminTenant = tenant;
        req.tenantAuth = {
          ...sessionAuth,
          role,
          membership,
        };
        return next();
      }

      if (hasValidAdminPassword(req)) {
        req.adminTenant = tenant;
        req.tenantAuth = { type: 'admin', role: 'owner' };
        return next();
      }

      return res.status(401).json({ error: 'Unauthorized - Tenant session required' });
    } catch (error) {
      console.error('Error checking tenant access:', error);
      return res.status(500).json({ error: 'Failed to verify tenant access' });
    }
  };
}

async function loadTenantApps(tenantId) {
  let apps;
  if (usePostgres()) {
    apps = await repos.apps.listByTenant(tenantId);
  } else {
    const appsSnapshot = await db.collection('apps')
      .where('tenantId', '==', tenantId)
      .get();
    apps = appsSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(appData => getTenantId(appData) === tenantId);
  }
  // Einheitliche, locale-aware Sortierung für beide Backends (konsistente Reihenfolge).
  apps.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return apps;
}

async function loadTenantTeam(tenantId) {
  const [membershipsSnapshot, invitesSnapshot] = await Promise.all([
    db.collection('memberships').where('tenantId', '==', tenantId).get(),
    db.collection('invites').where('tenantId', '==', tenantId).where('status', '==', 'pending').get(),
  ]);

  const memberships = membershipsSnapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(membership => getTenantId(membership) === tenantId || membership.tenantId === tenantId);

  const userDocs = await Promise.all(
    [...new Set(memberships.map(member => member.userId).filter(Boolean))]
      .map(userId => db.collection('users').doc(userId).get())
  );
  const usersById = {};
  userDocs.forEach(doc => {
    if (doc.exists) usersById[doc.id] = { id: doc.id, ...doc.data() };
  });

  const members = memberships.map(member => {
    const user = usersById[member.userId] || {};
    return {
      id: member.id,
      userId: member.userId || null,
      email: member.email || user.email || null,
      displayName: member.displayName || user.displayName || null,
      role: normalizeMembershipRole(member.role),
      status: member.status || 'active',
      createdAt: member.createdAt || null,
    };
  });

  const invites = invitesSnapshot.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(invite => invite.tenantId === tenantId)
    .map(invite => ({
      id: invite.id,
      email: invite.email,
      role: normalizeMembershipRole(invite.role),
      status: invite.status || 'pending',
      expiresAt: invite.expiresAt || null,
      createdAt: invite.createdAt || null,
    }));

  members.sort((a, b) => (a.email || '').localeCompare(b.email || ''));
  invites.sort((a, b) => (a.email || '').localeCompare(b.email || ''));

  return { members, invites };
}

async function resolveTenantMembershipById(tenantId, membershipId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(membershipId || '')) {
    return { errorStatus: 400, error: 'Invalid membership ID' };
  }

  const membershipDoc = await db.collection('memberships').doc(membershipId).get();
  if (!membershipDoc.exists) {
    return { errorStatus: 404, error: 'Member not found' };
  }

  const membership = membershipDoc.data() || {};
  if (membership.tenantId !== tenantId) {
    return { errorStatus: 404, error: 'Member not found' };
  }

  return { membershipDoc, membership };
}

async function resolveTenantInviteById(tenantId, inviteId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(inviteId || '')) {
    return { errorStatus: 400, error: 'Invalid invite ID' };
  }

  const inviteDoc = await db.collection('invites').doc(inviteId).get();
  if (!inviteDoc.exists) {
    return { errorStatus: 404, error: 'Invite not found' };
  }

  const invite = inviteDoc.data() || {};
  if (invite.tenantId !== tenantId) {
    return { errorStatus: 404, error: 'Invite not found' };
  }

  return { inviteDoc, invite };
}

async function countActiveTenantOwners(tenantId) {
  const ownersSnapshot = await db.collection('memberships')
    .where('tenantId', '==', tenantId)
    .where('role', '==', 'owner')
    .where('status', '==', 'active')
    .get();

  return ownersSnapshot.size;
}

function canManageTenantOwners(req) {
  return req.tenantAuth?.type === 'admin' || req.tenantAuth?.role === 'owner';
}

async function assertTenantMemberMutationAllowed(req, tenantId, currentMembership, nextRole, nextStatus) {
  const currentRole = normalizeMembershipRole(currentMembership.role);
  const currentStatus = currentMembership.status || 'active';
  const normalizedNextRole = normalizeMembershipRole(nextRole);
  const normalizedNextStatus = nextStatus || currentStatus;

  if ((currentRole === 'owner' || normalizedNextRole === 'owner') && !canManageTenantOwners(req)) {
    return { errorStatus: 403, error: 'Only owners can manage owner memberships' };
  }

  const removesOwner = currentRole === 'owner'
    && currentStatus === 'active'
    && (normalizedNextRole !== 'owner' || normalizedNextStatus !== 'active');
  if (removesOwner) {
    const activeOwnerCount = await countActiveTenantOwners(tenantId);
    if (activeOwnerCount <= 1) {
      return { errorStatus: 400, error: 'Cannot remove the last active owner' };
    }
  }

  return {
    role: normalizedNextRole,
    status: normalizedNextStatus,
  };
}

function cleanTenantSettingText(value, fallback = '') {
  const cleaned = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  return cleaned || fallback;
}

function normalizeOptionalEmail(value) {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  return cleaned ? normalizeInviteEmail(cleaned) : '';
}

function buildTenantSettingsResponse(tenant, apps = []) {
  const defaultBoard = apps[0] || null;
  const emailSettings = tenant.emailSettings || {};
  const tenantName = tenant.displayName || tenant.name || tenant.id;

  return {
    tenant: {
      id: tenant.id,
      name: tenantName,
      displayName: tenantName,
      slug: tenant.slug || tenant.id,
      status: tenant.status || 'unknown',
      emailSettings: {
        fromName: emailSettings.fromName || tenantName,
        replyTo: emailSettings.replyTo || '',
      },
    },
    defaultBoard: defaultBoard ? {
      id: defaultBoard.id,
      name: defaultBoard.name || defaultBoard.id,
      slug: defaultBoard.slug || '',
      ticketPrefix: defaultBoard.ticketPrefix || '',
    } : null,
    boards: apps.map(appData => ({
      id: appData.id,
      name: appData.name || appData.id,
      slug: appData.slug || '',
      ticketPrefix: appData.ticketPrefix || '',
    })),
  };
}

function buildTenantSettingsUpdate(body = {}, tenant = {}, defaultBoard = null) {
  const currentTenantName = tenant.displayName || tenant.name || tenant.id;
  const workspaceName = cleanTenantSettingText(body.workspaceName, currentTenantName);
  const requestedSlug = typeof body.workspaceSlug === 'string'
    ? body.workspaceSlug.trim()
    : tenant.slug || tenant.id;
  const workspaceSlug = parseSlugParam(requestedSlug);

  if (!workspaceSlug) {
    throw new Error('Invalid workspace slug');
  }

  if (tenant.legacy && workspaceSlug !== LEGACY_TENANT_ID) {
    throw new Error('Legacy workspace slug cannot be changed');
  }

  const boardName = cleanTenantSettingText(
    body.boardName,
    defaultBoard?.name || `${workspaceName} Board`
  );
  const ticketPrefix = buildTicketPrefix(body.ticketPrefix, boardName);
  const emailFromName = cleanTenantSettingText(body.emailFromName, workspaceName);
  const replyToEmail = normalizeOptionalEmail(body.replyToEmail);
  const timestamp = admin.firestore.FieldValue.serverTimestamp();

  return {
    plainTenant: {
      ...tenant,
      name: workspaceName,
      displayName: workspaceName,
      slug: workspaceSlug,
      emailSettings: {
        fromName: emailFromName,
        replyTo: replyToEmail,
      },
    },
    plainDefaultBoard: defaultBoard ? {
      ...defaultBoard,
      name: boardName,
      ticketPrefix,
      slug: defaultBoard.slug || buildAppSlug(boardName),
    } : null,
    tenantUpdate: {
      name: workspaceName,
      displayName: workspaceName,
      slug: workspaceSlug,
      emailSettings: {
        fromName: emailFromName,
        replyTo: replyToEmail,
      },
      updatedAt: timestamp,
    },
    appUpdate: defaultBoard ? {
      tenantId: tenant.id,
      name: boardName,
      slug: defaultBoard.slug || buildAppSlug(boardName),
      ticketPrefix,
      updatedAt: timestamp,
    } : null,
    counterUpdate: defaultBoard ? {
      tenantId: tenant.id,
      prefix: ticketPrefix,
      updatedAt: timestamp,
    } : null,
  };
}

async function loadAdminTenants() {
  const [tenantsSnapshot, appsSnapshot] = await Promise.all([
    db.collection('tenants').get(),
    db.collection('apps').get(),
  ]);

  const appCounts = {};
  const firstApps = {};
  appsSnapshot.docs.forEach(doc => {
    const app = { id: doc.id, ...doc.data() };
    const tenantId = getTenantId(app);
    appCounts[tenantId] = (appCounts[tenantId] || 0) + 1;

    if (!firstApps[tenantId]) {
      firstApps[tenantId] = app;
      return;
    }

    const currentName = firstApps[tenantId].name || '';
    const nextName = app.name || '';
    if (nextName.localeCompare(currentName) < 0) {
      firstApps[tenantId] = app;
    }
  });

  const tenants = tenantsSnapshot.docs.map(doc => {
    const data = doc.data() || {};
    const firstApp = firstApps[doc.id] || null;
    return {
      id: doc.id,
      name: data.displayName || data.name || doc.id,
      slug: data.slug || doc.id,
      status: data.status || 'unknown',
      legacy: Boolean(data.legacy),
      appCount: appCounts[doc.id] || 0,
      firstApp: firstApp ? {
        id: firstApp.id,
        name: firstApp.name || firstApp.id,
        slug: firstApp.slug || '',
      } : null,
    };
  });

  tenants.sort((a, b) => {
    if (a.legacy !== b.legacy) return a.legacy ? -1 : 1;
    return (a.name || '').localeCompare(b.name || '');
  });

  return tenants;
}

async function loadTenantAdminSuggestions(tenantId) {
  const [suggestionsSnapshot, apps] = await Promise.all([
    db.collection('suggestions').where('tenantId', '==', tenantId).get(),
    loadTenantApps(tenantId),
  ]);

  const appsMap = {};
  apps.forEach(appData => {
    appsMap[appData.id] = appData;
  });

  const suggestionDocs = suggestionsSnapshot.docs
    .filter(doc => getTenantId(doc.data() || {}) === tenantId);
  const suggestionIds = suggestionDocs.map(doc => doc.id);

  const commentStatsMap = {};
  if (suggestionIds.length > 0) {
    const commentDocs = await queryCollectionInChunks(db, {
      collectionName: 'comments',
      fieldName: 'suggestionId',
      values: suggestionIds,
    });

    commentDocs
      .filter(doc => getTenantId(doc.data() || {}) === tenantId)
      .forEach(doc => {
        const suggestionId = doc.data().suggestionId;
        if (!commentStatsMap[suggestionId]) {
          commentStatsMap[suggestionId] = {
            totalCount: 0,
            pendingCount: 0,
            publicCount: 0,
          };
        }

        const stats = buildCommentStats([doc]);
        commentStatsMap[suggestionId].totalCount += stats.totalCount;
        commentStatsMap[suggestionId].pendingCount += stats.pendingCount;
        commentStatsMap[suggestionId].publicCount += stats.publicCount;
      });
  }

  const suggestions = suggestionDocs.map(doc => {
    const data = { id: doc.id, ...doc.data() };
    const type = normalizeSuggestionType(data.type);
    return {
      id: data.id,
      ...data,
      type,
      status: data.status || mapLegacyTagToStatus(type, data.tag, data.approved),
      priority: data.priority || 'mittel',
      labels: data.labels || [],
      ticketNumber: data.ticketNumber || null,
      app: appsMap[data.appId] || { name: 'Unknown App' },
      commentCount: commentStatsMap[data.id]?.totalCount || 0,
      pendingCommentCount: commentStatsMap[data.id]?.pendingCount || 0
    };
  });

  suggestions.sort(compareAdminSuggestions);
  return { suggestions, apps };
}

// Admin: list tenants for SaaS operations
app.get('/api/admin/tenants', requireAdminAuth, async (req, res) => {
  try {
    res.json(await loadAdminTenants());
  } catch (error) {
    console.error('Error listing admin tenants:', error);
    res.status(500).json({ error: 'Failed to list tenants' });
  }
});

// Admin: provision a new SaaS tenant with one initial board
app.post('/api/admin/tenants', requireAdminAuth, rateLimit(60000, 5), async (req, res) => {
  try {
    let config;
    try {
      config = buildTenantProvisionConfig(req.body || {});
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Invalid tenant data' });
    }

    const tenantRef = db.collection('tenants').doc(config.tenantId);
    const tenantDoc = await tenantRef.get();
    if (tenantDoc.exists) {
      return res.status(409).json({ error: 'Tenant already exists' });
    }

    const slugSnapshot = await db.collection('tenants')
      .where('slug', '==', config.tenantSlug)
      .limit(1)
      .get();

    if (!slugSnapshot.empty) {
      return res.status(409).json({ error: 'Tenant slug already exists' });
    }

    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    const docs = buildTenantProvisionDocuments(config, timestamp);
    const appRef = db.collection('apps').doc();
    const counterRef = db.collection('counters').doc(appRef.id);

    const batch = db.batch();
    batch.create(tenantRef, docs.tenant);
    batch.create(appRef, docs.app);
    batch.create(counterRef, docs.counter);
    await batch.commit();

    res.status(201).json({
      tenant: {
        id: config.tenantId,
        slug: config.tenantSlug,
        name: config.tenantName,
      },
      app: {
        id: appRef.id,
        slug: config.appSlug,
        name: config.appName,
        ticketPrefix: config.ticketPrefix,
      },
      urls: {
        publicBoard: `/?tenant=${encodeURIComponent(config.tenantSlug)}&app=${encodeURIComponent(config.appSlug)}`,
        tenantAdmin: `/tenant-admin.html?tenant=${encodeURIComponent(config.tenantSlug)}`,
      },
    });
  } catch (error) {
    console.error('Error provisioning tenant:', error);
    res.status(500).json({ error: 'Failed to provision tenant' });
  }
});

// Tenant Admin: apps in one tenant
app.get('/api/admin/tenants/:tenantSlug/apps', requireTenantAccess(), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    res.json(await loadTenantApps(tenant.id));
  } catch (error) {
    console.error('Error fetching tenant admin apps:', error);
    res.status(500).json({ error: 'Failed to fetch tenant apps' });
  }
});

// Tenant Admin: create a board/app in one tenant
app.post('/api/admin/tenants/:tenantSlug/apps', requireTenantAccess(['owner', 'admin']), rateLimit(60000, 10), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const boardName = validateInput(req.body?.boardName || req.body?.name, 120);
    if (!boardName) {
      return res.status(400).json({ error: 'Board name is required' });
    }

    const requestedSlug = req.body?.boardSlug || req.body?.slug;
    const boardSlug = requestedSlug
      ? parseSlugParam(String(requestedSlug))
      : buildAppSlug(boardName);
    if (!boardSlug) {
      return res.status(400).json({ error: 'Invalid board slug' });
    }

    const slugSnapshot = await db.collection('apps')
      .where('slug', '==', boardSlug)
      .get();
    const hasTenantSlugConflict = slugSnapshot.docs
      .some(doc => getTenantId(doc.data() || {}) === tenant.id);
    if (hasTenantSlugConflict) {
      return res.status(409).json({ error: 'Tenant app slug already exists' });
    }

    const ticketPrefix = buildTicketPrefix(req.body?.boardTicketPrefix || req.body?.ticketPrefix, boardName);
    const description = validateInput(req.body?.description, 500) || `Feedback Board für ${tenant.displayName || tenant.name || tenant.slug || tenant.id}`;
    const timestamp = admin.firestore.FieldValue.serverTimestamp();
    const appRef = db.collection('apps').doc();
    const appData = {
      tenantId: tenant.id,
      name: boardName,
      description,
      slug: boardSlug,
      ticketPrefix,
      labels: [],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    const batch = db.batch();
    batch.set(appRef, appData);
    batch.set(db.collection('counters').doc(appRef.id), {
      tenantId: tenant.id,
      prefix: ticketPrefix,
      nextNumber: 1,
      updatedAt: timestamp,
    });
    await batch.commit();

    res.status(201).json({
      id: appRef.id,
      tenantId: tenant.id,
      name: boardName,
      description,
      slug: boardSlug,
      ticketPrefix,
      labels: [],
    });
  } catch (error) {
    console.error('Error creating tenant board:', error);
    res.status(500).json({ error: 'Failed to create tenant board' });
  }
});

// Tenant Admin: stats in one tenant
app.get('/api/admin/tenants/:tenantSlug/stats', requireTenantAccess(), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const { suggestions, apps } = await loadTenantAdminSuggestions(tenant.id);
    const votesSnapshot = await db.collection('votes').where('tenantId', '==', tenant.id).get();
    const tenantVotes = votesSnapshot.docs.filter(doc => getTenantId(doc.data() || {}) === tenant.id);

    res.json({
      totalApps: apps.length,
      totalSuggestions: suggestions.length,
      totalVotes: tenantVotes.length,
      totalBugs: suggestions.filter(item => item.type === 'bug').length,
      totalTickets: suggestions.filter(item => item.type === 'ticket').length,
      totalFeatures: suggestions.filter(item => item.type === 'feature').length,
      pendingSuggestions: suggestions.filter(item => !item.approved).length,
      pendingComments: suggestions.reduce((sum, item) => sum + (item.pendingCommentCount || 0), 0),
    });
  } catch (error) {
    console.error('Error fetching tenant admin stats:', error);
    res.status(500).json({ error: 'Failed to fetch tenant statistics' });
  }
});

// Tenant Admin: workspace settings in one tenant
app.get('/api/admin/tenants/:tenantSlug/settings', requireTenantAccess(), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const apps = await loadTenantApps(tenant.id);
    res.json(buildTenantSettingsResponse(tenant, apps));
  } catch (error) {
    console.error('Error fetching tenant settings:', error);
    res.status(500).json({ error: 'Failed to fetch tenant settings' });
  }
});

// Tenant Admin: update workspace settings in one tenant
app.put('/api/admin/tenants/:tenantSlug/settings', requireTenantAccess(['owner', 'admin']), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const apps = await loadTenantApps(tenant.id);
    const defaultBoard = apps[0] || null;
    let settingsUpdate;

    try {
      settingsUpdate = buildTenantSettingsUpdate(req.body || {}, tenant, defaultBoard);
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Invalid tenant settings' });
    }

    if (settingsUpdate.plainTenant.slug !== (tenant.slug || tenant.id)) {
      const slugSnapshot = await db.collection('tenants')
        .where('slug', '==', settingsUpdate.plainTenant.slug)
        .limit(2)
        .get();
      const hasConflict = slugSnapshot.docs.some(doc => doc.id !== tenant.id);
      if (hasConflict) {
        return res.status(409).json({ error: 'Workspace slug already exists' });
      }
    }

    const batch = db.batch();
    batch.set(db.collection('tenants').doc(tenant.id), settingsUpdate.tenantUpdate, { merge: true });

    if (defaultBoard && settingsUpdate.appUpdate && settingsUpdate.counterUpdate) {
      batch.set(db.collection('apps').doc(defaultBoard.id), settingsUpdate.appUpdate, { merge: true });
      batch.set(db.collection('counters').doc(defaultBoard.id), settingsUpdate.counterUpdate, { merge: true });
    }

    await batch.commit();

    const responseApps = defaultBoard
      ? apps.map(appData => appData.id === defaultBoard.id ? settingsUpdate.plainDefaultBoard : appData)
      : apps;
    res.json(buildTenantSettingsResponse(settingsUpdate.plainTenant, responseApps));
  } catch (error) {
    console.error('Error updating tenant settings:', error);
    res.status(500).json({ error: 'Failed to update tenant settings' });
  }
});

// Tenant Admin: members and pending invites in one tenant
app.get('/api/admin/tenants/:tenantSlug/members', requireTenantAccess(), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    res.json(await loadTenantTeam(tenant.id));
  } catch (error) {
    console.error('Error fetching tenant team:', error);
    res.status(500).json({ error: 'Failed to fetch tenant team' });
  }
});

// Tenant Admin: update one member role/status
app.put('/api/admin/tenants/:tenantSlug/members/:membershipId', requireTenantAccess(['owner', 'admin']), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const { membershipId } = req.params;
    const resolved = await resolveTenantMembershipById(tenant.id, membershipId);
    if (resolved.error) {
      return res.status(resolved.errorStatus).json({ error: resolved.error });
    }

    const requestedRole = req.body?.role === undefined
      ? resolved.membership.role
      : req.body.role;
    const requestedStatus = req.body?.status === undefined
      ? resolved.membership.status || 'active'
      : String(req.body.status || '').trim().toLowerCase();

    if (!MEMBERSHIP_STATUSES.includes(requestedStatus)) {
      return res.status(400).json({ error: 'Invalid membership status' });
    }

    const mutation = await assertTenantMemberMutationAllowed(
      req,
      tenant.id,
      resolved.membership,
      requestedRole,
      requestedStatus
    );
    if (mutation.error) {
      return res.status(mutation.errorStatus).json({ error: mutation.error });
    }

    await resolved.membershipDoc.ref.set({
      role: mutation.role,
      status: mutation.status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    res.json({
      id: resolved.membershipDoc.id,
      ...resolved.membership,
      role: mutation.role,
      status: mutation.status,
    });
  } catch (error) {
    console.error('Error updating tenant member:', error);
    res.status(500).json({ error: 'Failed to update member' });
  }
});

// Tenant Admin: disable one member
app.delete('/api/admin/tenants/:tenantSlug/members/:membershipId', requireTenantAccess(['owner', 'admin']), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const { membershipId } = req.params;
    const resolved = await resolveTenantMembershipById(tenant.id, membershipId);
    if (resolved.error) {
      return res.status(resolved.errorStatus).json({ error: resolved.error });
    }

    const mutation = await assertTenantMemberMutationAllowed(
      req,
      tenant.id,
      resolved.membership,
      resolved.membership.role,
      'disabled'
    );
    if (mutation.error) {
      return res.status(mutation.errorStatus).json({ error: mutation.error });
    }

    await resolved.membershipDoc.ref.set({
      status: 'disabled',
      disabledAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    res.json({ success: true, id: resolved.membershipDoc.id, status: 'disabled' });
  } catch (error) {
    console.error('Error disabling tenant member:', error);
    res.status(500).json({ error: 'Failed to disable member' });
  }
});

// Tenant Admin: create invite for one tenant
app.post('/api/admin/tenants/:tenantSlug/invites', requireTenantAccess(['owner', 'admin']), rateLimit(60000, 10), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    let email;
    try {
      email = normalizeInviteEmail(req.body?.email);
    } catch (error) {
      return res.status(400).json({ error: error.message || 'Invalid invite email' });
    }

    const role = normalizeMembershipRole(req.body?.role);
    if (!MEMBERSHIP_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    const existingInvite = await db.collection('invites')
      .where('tenantId', '==', tenant.id)
      .where('email', '==', email)
      .where('status', '==', 'pending')
      .limit(1)
      .get();

    if (!existingInvite.empty) {
      return res.status(409).json({ error: 'Invite already pending for this email' });
    }

    const existingUser = await db.collection('users')
      .where('email', '==', email)
      .limit(1)
      .get();

    if (!existingUser.empty) {
      const userId = existingUser.docs[0].id;
      const existingMembership = await db.collection('memberships')
        .where('tenantId', '==', tenant.id)
        .where('userId', '==', userId)
        .limit(1)
        .get();

      if (!existingMembership.empty) {
        return res.status(409).json({ error: 'User is already a member of this tenant' });
      }
    }

    const token = buildInviteToken();
    const inviteData = buildTenantInviteData({
      tenantId: tenant.id,
      email,
      role,
      token,
      now: new Date(),
    });

    const docRef = await db.collection('invites').add(inviteData);
    const acceptUrl = `${buildRequestBaseUrl(req)}/accept-invite.html?token=${encodeURIComponent(token)}`;
    await sendTenantInviteEmail({
      to: email,
      tenantName: tenant.displayName || tenant.name || tenant.slug || tenant.id,
      role,
      acceptUrl,
    });

    res.status(201).json({
      id: docRef.id,
      email: inviteData.email,
      role: inviteData.role,
      status: inviteData.status,
      expiresAt: inviteData.expiresAt,
      delivery: 'email',
    });
  } catch (error) {
    console.error('Error creating tenant invite:', error);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// Tenant Admin: resend one pending invite
app.post('/api/admin/tenants/:tenantSlug/invites/:inviteId/resend', requireTenantAccess(['owner', 'admin']), rateLimit(60000, 10), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const { inviteId } = req.params;
    const resolved = await resolveTenantInviteById(tenant.id, inviteId);
    if (resolved.error) {
      return res.status(resolved.errorStatus).json({ error: resolved.error });
    }

    if (resolved.invite.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending invites can be resent' });
    }

    const token = buildInviteToken();
    const inviteData = buildTenantInviteData({
      tenantId: tenant.id,
      email: resolved.invite.email,
      role: resolved.invite.role,
      token,
      now: new Date(),
    });

    await resolved.inviteDoc.ref.set(inviteData, { merge: true });
    const acceptUrl = `${buildRequestBaseUrl(req)}/accept-invite.html?token=${encodeURIComponent(token)}`;
    await sendTenantInviteEmail({
      to: inviteData.email,
      tenantName: tenant.displayName || tenant.name || tenant.slug || tenant.id,
      role: inviteData.role,
      acceptUrl,
    });

    res.json({
      id: resolved.inviteDoc.id,
      email: inviteData.email,
      role: inviteData.role,
      status: inviteData.status,
      expiresAt: inviteData.expiresAt,
      delivery: 'email',
    });
  } catch (error) {
    console.error('Error resending tenant invite:', error);
    res.status(500).json({ error: 'Failed to resend invite' });
  }
});

// Tenant Admin: revoke one pending invite
app.delete('/api/admin/tenants/:tenantSlug/invites/:inviteId', requireTenantAccess(['owner', 'admin']), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const { inviteId } = req.params;
    const resolved = await resolveTenantInviteById(tenant.id, inviteId);
    if (resolved.error) {
      return res.status(resolved.errorStatus).json({ error: resolved.error });
    }

    if (resolved.invite.status !== 'pending') {
      return res.status(400).json({ error: 'Only pending invites can be revoked' });
    }

    await resolved.inviteDoc.ref.set({
      status: 'revoked',
      revokedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    res.json({ success: true, id: resolved.inviteDoc.id, status: 'revoked' });
  } catch (error) {
    console.error('Error revoking tenant invite:', error);
    res.status(500).json({ error: 'Failed to revoke invite' });
  }
});

// Tenant Admin: suggestions in one tenant
app.get('/api/admin/tenants/:tenantSlug/suggestions', requireTenantAccess(), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const { suggestions } = await loadTenantAdminSuggestions(tenant.id);
    res.json(suggestions);
  } catch (error) {
    console.error('Error fetching tenant admin suggestions:', error);
    res.status(500).json({ error: 'Failed to fetch tenant suggestions' });
  }
});

// Tenant Admin: approve suggestion
app.post('/api/admin/tenants/:tenantSlug/suggestions/:suggestionId/approve', requireTenantAccess(['owner', 'admin']), async (req, res) => {
  try {
    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    const { suggestionId } = req.params;
    if (!tenantSlug || !/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid tenant or suggestion ID' });
    }

    const { suggestionData, errorStatus, error } = await resolveTenantSuggestionById(tenantSlug, suggestionId);
    if (error) {
      return res.status(errorStatus).json({ error });
    }

    const suggestionType = normalizeSuggestionType(suggestionData.type);
    const newStatus = suggestionType === 'feature' ? 'wird geprüft' : 'offen';
    const legacyTag = mapStatusToLegacyTag(suggestionType, newStatus);

    await db.collection('suggestions').doc(suggestionId).update({
      approved: true,
      status: newStatus,
      tag: legacyTag,
      approvedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await logActivity(suggestionId, 'approved', {
      oldValue: 'neu',
      newValue: newStatus,
      detail: `${suggestionType === 'bug' ? 'Bug' : suggestionType === 'ticket' ? 'Ticket' : 'Vorschlag'} freigegeben`,
      tenantId: getTenantId(suggestionData),
    });

    res.json({ success: true, message: 'Eintrag erfolgreich freigegeben' });
  } catch (error) {
    console.error('Error approving tenant suggestion:', error);
    res.status(500).json({ error: 'Failed to approve suggestion' });
  }
});

// Tenant Admin: update suggestion status
app.put('/api/admin/tenants/:tenantSlug/suggestions/:suggestionId/status', requireTenantAccess(['owner', 'admin']), async (req, res) => {
  try {
    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    const { suggestionId } = req.params;
    const { status } = req.body;
    if (!tenantSlug || !/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid tenant or suggestion ID' });
    }

    const { suggestionData, errorStatus, error } = await resolveTenantSuggestionById(tenantSlug, suggestionId);
    if (error) {
      return res.status(errorStatus).json({ error });
    }

    const suggestionType = normalizeSuggestionType(suggestionData.type);
    const validStatuses = getValidStatusesForType(suggestionType);
    const normalizedStatus = status ? status.toString().trim() : null;
    if (!normalizedStatus || !validStatuses.includes(normalizedStatus)) {
      return res.status(400).json({ error: `Ungültiger Status. Erlaubt: ${validStatuses.join(', ')}` });
    }

    const previousStatus = suggestionData.status || null;
    const updateData = {
      status: normalizedStatus,
      tag: mapStatusToLegacyTag(suggestionType, normalizedStatus),
      tagUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (normalizedStatus !== 'neu' && !suggestionData.approved) {
      updateData.approved = true;
      updateData.approvedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await db.collection('suggestions').doc(suggestionId).update(updateData);

    if (previousStatus !== normalizedStatus) {
      await logActivity(suggestionId, 'status_changed', {
        oldValue: previousStatus,
        newValue: normalizedStatus,
        detail: `Status geändert: ${previousStatus || 'keiner'} → ${normalizedStatus}`,
        tenantId: getTenantId(suggestionData),
      });
    }

    res.json({ success: true, message: 'Status erfolgreich aktualisiert' });
  } catch (error) {
    console.error('Error updating tenant suggestion status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Tenant Admin: update suggestion priority
app.put('/api/admin/tenants/:tenantSlug/suggestions/:suggestionId/priority', requireTenantAccess(['owner', 'admin']), async (req, res) => {
  try {
    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    const { suggestionId } = req.params;
    const { priority } = req.body;
    if (!tenantSlug || !/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid tenant or suggestion ID' });
    }

    const { suggestionData, errorStatus, error } = await resolveTenantSuggestionById(tenantSlug, suggestionId);
    if (error) {
      return res.status(errorStatus).json({ error });
    }

    const normalizedPriority = (priority || '').toString().trim().toLowerCase();
    if (!VALID_PRIORITIES.includes(normalizedPriority)) {
      return res.status(400).json({ error: `Ungültige Priorität. Erlaubt: ${VALID_PRIORITIES.join(', ')}` });
    }

    await db.collection('suggestions').doc(suggestionId).update({ priority: normalizedPriority });

    await logActivity(suggestionId, 'priority_changed', {
      oldValue: suggestionData.priority || null,
      newValue: normalizedPriority,
      detail: `Priorität geändert: ${suggestionData.priority || 'keine'} → ${normalizedPriority}`,
      tenantId: getTenantId(suggestionData),
    });

    res.json({ success: true, message: 'Priorität erfolgreich aktualisiert' });
  } catch (error) {
    console.error('Error updating tenant suggestion priority:', error);
    res.status(500).json({ error: 'Failed to update priority' });
  }
});

// ---------------------------------------------------------------------------
// Tenant Admin: Releases (Roadmap & Changelog)
//
// Parallel to the legacy /api/admin/releases endpoints, but tenant-scoped via
// requireTenantAccess + getTenantId === tenant.id. The legacy endpoints stay
// untouched (they remain password-gated and locked to the legacy tenant).
// ---------------------------------------------------------------------------

function toReleaseDate(value) {
  return value?.toDate?.()
    ?? (value?._seconds != null ? new Date(value._seconds * 1000) : new Date(0));
}

// Firestore caps a write batch at 500 ops; stay safely under it when unlinking.
const RELEASE_UNLINK_BATCH_LIMIT = 400;

const INVALID_RELEASE_DATE = Symbol('invalid-release-date');

function parseReleaseDate(value) {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return INVALID_RELEASE_DATE;
  return admin.firestore.Timestamp.fromDate(date);
}

function sortAdminReleases(releases) {
  const statusOrder = { 'geplant': 0, 'in Arbeit': 1, 'veröffentlicht': 2 };
  releases.sort((a, b) => {
    const aOrder = statusOrder[a.status] ?? 9;
    const bOrder = statusOrder[b.status] ?? 9;
    if (aOrder !== bOrder) return aOrder - bOrder;
    return toReleaseDate(b.releaseDate) - toReleaseDate(a.releaseDate);
  });
  return releases;
}

async function countSuggestionsByReleaseId(releaseIds, tenantId) {
  const itemCountMap = {};
  if (releaseIds.length === 0) return itemCountMap;

  const chunks = [];
  for (let i = 0; i < releaseIds.length; i += 10) {
    chunks.push(releaseIds.slice(i, i + 10));
  }

  const snapshots = await Promise.all(
    chunks.map(chunk =>
      db.collection('suggestions')
        .where('releaseId', 'in', chunk)
        .get()
        .catch(() => ({ docs: [] }))
    )
  );

  snapshots.forEach(snapshot => {
    snapshot.docs.forEach(doc => {
      const data = doc.data() || {};
      if (getTenantId(data) !== tenantId) return;
      itemCountMap[data.releaseId] = (itemCountMap[data.releaseId] || 0) + 1;
    });
  });

  return itemCountMap;
}

async function loadReleasesForTenant(tenantId, { appId } = {}) {
  // Scope the read to the tenant directly instead of pulling the whole
  // releases collection and filtering in memory. tenantId is a single-field
  // equality filter (auto-indexed), so no composite index is needed; the
  // optional appId narrows the already-small per-tenant set in memory.
  const [releasesSnapshot, appsSnapshot] = await Promise.all([
    db.collection('releases').where('tenantId', '==', tenantId).get(),
    db.collection('apps').where('tenantId', '==', tenantId).get(),
  ]);

  const appsMap = {};
  appsSnapshot.docs.forEach(doc => {
    appsMap[doc.id] = { id: doc.id, ...doc.data() };
  });

  let scopedReleases = releasesSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  if (appId) {
    scopedReleases = scopedReleases.filter(release => release.appId === appId);
  }

  const itemCountMap = await countSuggestionsByReleaseId(
    scopedReleases.map(release => release.id),
    tenantId,
  );

  const releases = scopedReleases.map(release => ({
    ...release,
    app: appsMap[release.appId] || { name: 'Unbekannte App' },
    itemCount: itemCountMap[release.id] || 0,
  }));

  return sortAdminReleases(releases);
}

app.get('/api/admin/tenants/:tenantSlug/releases', requireTenantAccess(), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const requestedAppId = req.query.appId;
    const appId = requestedAppId && /^[a-zA-Z0-9_-]+$/.test(requestedAppId) ? requestedAppId : null;

    const releases = await loadReleasesForTenant(tenant.id, { appId });
    res.json(releases);
  } catch (error) {
    console.error('Error fetching tenant releases:', error);
    res.status(500).json({ error: 'Failed to fetch releases' });
  }
});

app.post('/api/admin/tenants/:tenantSlug/releases', requireTenantAccess(['owner', 'admin']), rateLimit(60000, 20), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const { appId, version, title, description, status, releaseDate } = req.body || {};

    if (!appId || !/^[a-zA-Z0-9_-]+$/.test(appId)) {
      return res.status(400).json({ error: 'Ungültige App-ID' });
    }

    const appDoc = await db.collection('apps').doc(appId).get();
    if (!appDoc.exists || getTenantId(appDoc.data() || {}) !== tenant.id) {
      return res.status(404).json({ error: 'App nicht gefunden' });
    }

    const validVersion = validateInput(version, 50);
    if (!validVersion) {
      return res.status(400).json({ error: 'Version ist erforderlich (max. 50 Zeichen)' });
    }

    const parsedReleaseDate = parseReleaseDate(releaseDate);
    if (parsedReleaseDate === INVALID_RELEASE_DATE) {
      return res.status(400).json({ error: 'Ungültiges Release-Datum' });
    }

    const validStatus = RELEASE_STATUSES.includes(status) ? status : 'geplant';
    const release = {
      tenantId: tenant.id,
      appId,
      version: validVersion,
      title: validateInput(title, 200) || '',
      description: validateInput(description, 5000) || '',
      status: validStatus,
      releaseDate: parsedReleaseDate,
      publishedAt: validStatus === 'veröffentlicht' ? admin.firestore.FieldValue.serverTimestamp() : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection('releases').add(release);
    res.status(201).json({
      id: docRef.id,
      ...release,
      // serverTimestamp() is a write-only sentinel — resolve the timestamps for
      // the response so the client never sees {"_methodName":"serverTimestamp"}.
      publishedAt: validStatus === 'veröffentlicht' ? new Date() : null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (error) {
    console.error('Error creating tenant release:', error);
    res.status(500).json({ error: 'Failed to create release' });
  }
});

app.put('/api/admin/tenants/:tenantSlug/releases/:releaseId', requireTenantAccess(['owner', 'admin']), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const { releaseId } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(releaseId)) {
      return res.status(400).json({ error: 'Invalid release ID format' });
    }

    const releaseDoc = await db.collection('releases').doc(releaseId).get();
    if (!releaseDoc.exists || getTenantId(releaseDoc.data() || {}) !== tenant.id) {
      return res.status(404).json({ error: 'Release nicht gefunden' });
    }

    const { version, title, description, status, releaseDate } = req.body || {};
    const updateData = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };

    if (version !== undefined) {
      const validVersion = validateInput(version, 50);
      if (!validVersion) {
        return res.status(400).json({ error: 'Ungültige Version' });
      }
      updateData.version = validVersion;
    }

    if (title !== undefined) {
      updateData.title = validateInput(title, 200) || '';
    }

    if (description !== undefined) {
      updateData.description = validateInput(description, 5000) || '';
    }

    if (status !== undefined) {
      if (!RELEASE_STATUSES.includes(status)) {
        return res.status(400).json({ error: `Ungültiger Status. Erlaubt: ${RELEASE_STATUSES.join(', ')}` });
      }
      updateData.status = status;

      const previousStatus = releaseDoc.data().status;
      if (status === 'veröffentlicht' && previousStatus !== 'veröffentlicht') {
        updateData.publishedAt = admin.firestore.FieldValue.serverTimestamp();
      }
    }

    if (releaseDate !== undefined) {
      const parsedReleaseDate = parseReleaseDate(releaseDate);
      if (parsedReleaseDate === INVALID_RELEASE_DATE) {
        return res.status(400).json({ error: 'Ungültiges Release-Datum' });
      }
      updateData.releaseDate = parsedReleaseDate;
    }

    await db.collection('releases').doc(releaseId).update(updateData);
    res.json({ success: true, message: 'Release erfolgreich aktualisiert' });
  } catch (error) {
    console.error('Error updating tenant release:', error);
    res.status(500).json({ error: 'Failed to update release' });
  }
});

app.delete('/api/admin/tenants/:tenantSlug/releases/:releaseId', requireTenantAccess(['owner', 'admin']), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const { releaseId } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(releaseId)) {
      return res.status(400).json({ error: 'Invalid release ID format' });
    }

    const releaseDoc = await db.collection('releases').doc(releaseId).get();
    if (!releaseDoc.exists || getTenantId(releaseDoc.data() || {}) !== tenant.id) {
      return res.status(404).json({ error: 'Release nicht gefunden' });
    }

    const linkedSuggestions = await db.collection('suggestions')
      .where('releaseId', '==', releaseId)
      .get();

    const scopedSuggestions = linkedSuggestions.docs
      .filter(doc => getTenantId(doc.data() || {}) === tenant.id);

    // A Firestore batch is capped at 500 writes, so unlink in chunks instead of
    // one batch — a release on a large tenant can have more linked entries than
    // that. The release itself is deleted last; the operation is idempotent, so
    // a retry after a partial failure simply finishes the remaining unlinks.
    for (let i = 0; i < scopedSuggestions.length; i += RELEASE_UNLINK_BATCH_LIMIT) {
      const batch = db.batch();
      scopedSuggestions.slice(i, i + RELEASE_UNLINK_BATCH_LIMIT).forEach(doc => {
        batch.update(doc.ref, { releaseId: null });
      });
      await batch.commit();
    }
    await db.collection('releases').doc(releaseId).delete();

    res.json({
      success: true,
      message: 'Release gelöscht',
      unlinkedSuggestions: scopedSuggestions.length,
    });
  } catch (error) {
    console.error('Error deleting tenant release:', error);
    res.status(500).json({ error: 'Failed to delete release' });
  }
});

app.put('/api/admin/tenants/:tenantSlug/suggestions/:suggestionId/release', requireTenantAccess(['owner', 'admin']), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    const { suggestionId } = req.params;
    const { releaseId } = req.body || {};
    if (!tenantSlug || !/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid tenant or suggestion ID' });
    }

    const { suggestionData, errorStatus, error } = await resolveTenantSuggestionById(tenantSlug, suggestionId);
    if (error) {
      return res.status(errorStatus).json({ error });
    }

    if (releaseId) {
      if (!/^[a-zA-Z0-9_-]+$/.test(releaseId)) {
        return res.status(400).json({ error: 'Invalid release ID format' });
      }
      const releaseDoc = await db.collection('releases').doc(releaseId).get();
      if (!releaseDoc.exists || getTenantId(releaseDoc.data() || {}) !== tenant.id) {
        return res.status(404).json({ error: 'Release nicht gefunden' });
      }
    }

    const previousReleaseId = suggestionData.releaseId || null;
    await db.collection('suggestions').doc(suggestionId).update({ releaseId: releaseId || null });

    await logActivity(suggestionId, 'release_changed', {
      oldValue: previousReleaseId,
      newValue: releaseId || null,
      detail: releaseId ? 'Einem Release zugeordnet' : 'Release-Zuordnung entfernt',
      tenantId: tenant.id,
    });

    res.json({ success: true, message: releaseId ? 'Release zugeordnet' : 'Release-Zuordnung entfernt' });
  } catch (error) {
    console.error('Error assigning tenant release:', error);
    res.status(500).json({ error: 'Failed to assign release' });
  }
});

// Tenant Admin: get comments
app.get('/api/admin/tenants/:tenantSlug/suggestions/:suggestionId/comments', requireTenantAccess(), async (req, res) => {
  try {
    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    const { suggestionId } = req.params;
    if (!tenantSlug || !/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid tenant or suggestion ID' });
    }

    const { tenant, errorStatus, error } = await resolveTenantSuggestionById(tenantSlug, suggestionId);
    if (error) {
      return res.status(errorStatus).json({ error });
    }

    const commentsSnapshot = await db.collection('comments')
      .where('suggestionId', '==', suggestionId)
      .get();

    const comments = commentsSnapshot.docs
      .filter(doc => getTenantId(doc.data() || {}) === tenant.id)
      .map(buildAdminCommentResponse);

    comments.sort((a, b) => {
      const statusOrder = { pending: 0, approved: 1, rejected: 2 };
      const statusDelta = (statusOrder[a.approvalStatus] ?? 99) - (statusOrder[b.approvalStatus] ?? 99);
      if (statusDelta !== 0) return statusDelta;

      const aTime = a.createdAt?.toDate?.() ?? (a.createdAt?._seconds != null ? new Date(a.createdAt._seconds * 1000) : new Date(0));
      const bTime = b.createdAt?.toDate?.() ?? (b.createdAt?._seconds != null ? new Date(b.createdAt._seconds * 1000) : new Date(0));
      return bTime - aTime;
    });

    res.json(comments);
  } catch (error) {
    console.error('Error fetching tenant admin comments:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// Tenant Admin: add approved admin comment
app.post('/api/admin/tenants/:tenantSlug/suggestions/:suggestionId/comments', requireTenantAccess(['owner', 'admin']), async (req, res) => {
  try {
    const tenantSlug = parseSlugParam(req.params.tenantSlug);
    const { suggestionId } = req.params;
    const { text, screenshots } = req.body;
    if (!tenantSlug || !/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid tenant or suggestion ID' });
    }

    const validText = validateInput(text, 2000);
    if (!validText) {
      return res.status(400).json({ error: 'Invalid comment text' });
    }

    const screenshotValidation = validateCommentScreenshots(screenshots);
    if (screenshotValidation.error) {
      return res.status(400).json({ error: screenshotValidation.error });
    }

    const { tenant, errorStatus, error } = await resolveTenantSuggestionById(tenantSlug, suggestionId);
    if (error) {
      return res.status(errorStatus).json({ error });
    }

    const comment = {
      tenantId: tenant.id,
      suggestionId,
      text: validText,
      screenshots: screenshotValidation.screenshots,
      authorType: 'admin',
      approvalStatus: 'approved',
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      approvedBy: 'admin',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const commentRef = await db.collection('comments').add(comment);

    await logActivity(suggestionId, 'commented', {
      detail: `Kommentar hinzugefügt: "${validText.slice(0, 80)}${validText.length > 80 ? '...' : ''}"`,
      tenantId: tenant.id,
    });

    res.status(201).json({
      id: commentRef.id,
      ...normalizeCommentData(comment),
      createdAt: new Date(),
      message: 'Kommentar erfolgreich hinzugefügt'
    });
  } catch (error) {
    console.error('Error adding tenant admin comment:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

async function updateTenantCommentModeration(req, res, approvalStatus) {
  const tenantSlug = parseSlugParam(req.params.tenantSlug);
  const { suggestionId, commentId } = req.params;
  if (!tenantSlug || !/^[a-zA-Z0-9_-]+$/.test(suggestionId) || !/^[a-zA-Z0-9_-]+$/.test(commentId)) {
    return res.status(400).json({ error: 'Invalid ID format' });
  }

  const { tenant, errorStatus, error } = await resolveTenantSuggestionById(tenantSlug, suggestionId);
  if (error) {
    return res.status(errorStatus).json({ error });
  }

  const commentRef = db.collection('comments').doc(commentId);
  const commentDoc = await commentRef.get();
  if (!commentDoc.exists) {
    return res.status(404).json({ error: 'Comment not found' });
  }

  const comment = normalizeCommentData(commentDoc.data());
  if (comment.suggestionId !== suggestionId || getTenantId(comment) !== tenant.id) {
    return res.status(404).json({ error: 'Comment not found' });
  }

  if (comment.authorType !== 'user') {
    return res.status(400).json({ error: 'Only user comments require moderation' });
  }

  const updateData = approvalStatus === 'approved'
    ? {
        approvalStatus: 'approved',
        approvedAt: admin.firestore.FieldValue.serverTimestamp(),
        approvedBy: 'admin',
        rejectedAt: null,
        rejectedBy: null,
      }
    : {
        approvalStatus: 'rejected',
        rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
        rejectedBy: 'admin',
      };

  await commentRef.update(updateData);

  await logActivity(suggestionId, approvalStatus === 'approved' ? 'comment_approved' : 'comment_rejected', {
    detail: `Benutzer-Kommentar ${approvalStatus === 'approved' ? 'freigegeben' : 'abgelehnt'}: "${comment.text.slice(0, 80)}${comment.text.length > 80 ? '...' : ''}"`,
    tenantId: tenant.id,
  });

  res.json({ success: true, message: approvalStatus === 'approved' ? 'Kommentar freigegeben' : 'Kommentar abgelehnt' });
}

app.put('/api/admin/tenants/:tenantSlug/suggestions/:suggestionId/comments/:commentId/approve', requireTenantAccess(['owner', 'admin']), async (req, res) => {
  try {
    await updateTenantCommentModeration(req, res, 'approved');
  } catch (error) {
    console.error('Error approving tenant comment:', error);
    res.status(500).json({ error: 'Failed to approve comment' });
  }
});

app.put('/api/admin/tenants/:tenantSlug/suggestions/:suggestionId/comments/:commentId/reject', requireTenantAccess(['owner', 'admin']), async (req, res) => {
  try {
    await updateTenantCommentModeration(req, res, 'rejected');
  } catch (error) {
    console.error('Error rejecting tenant comment:', error);
    res.status(500).json({ error: 'Failed to reject comment' });
  }
});

// Admin: Create new app
app.post('/api/admin/apps', requireAdminAuth, rateLimit(60000, 10), async (req, res) => {
  try {
    const { name, description } = req.body;

    // Validate inputs
    const validName = validateInput(name, 100);
    const validDescription = validateInput(description, 300);

    if (!validName || !validDescription) {
      return res.status(400).json({ error: 'Invalid name or description' });
    }

    const ticketPrefix = (req.body.ticketPrefix || '').replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 5);

    const app = {
      tenantId: LEGACY_TENANT_ID,
      name: validName,
      description: validDescription,
      slug: buildAppSlug(validName),
      ticketPrefix: ticketPrefix || validName.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase() || 'APP',
      labels: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('apps').add(app);

    // Initialize counter for ticket numbers
    await db.collection('counters').doc(docRef.id).set({
      tenantId: LEGACY_TENANT_ID,
      prefix: app.ticketPrefix,
      nextNumber: 1,
    });

    res.status(201).json({
      id: docRef.id,
      ...app,
      createdAt: new Date()
    });
  } catch (error) {
    console.error('Error creating app:', error);
    res.status(500).json({ error: 'Failed to create app' });
  }
});

// Admin: Update app
app.put('/api/admin/apps/:appId', requireAdminAuth, async (req, res) => {
  try {
    const { appId } = req.params;
    const { name, description } = req.body;
    const existingAppDoc = await db.collection('apps').doc(appId).get();

    if (!existingAppDoc.exists || !isLegacyTenantData(existingAppDoc.data() || {})) {
      return res.status(404).json({ error: 'App not found' });
    }

    if (!name || !description) {
      return res.status(400).json({ error: 'Name and description are required' });
    }

    const updateData = {
      name: name.trim(),
      description: description.trim(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (existingAppDoc.exists && !existingAppDoc.data()?.slug) {
      updateData.slug = buildAppSlug(name);
    }

    if (existingAppDoc.exists && !existingAppDoc.data()?.tenantId) {
      updateData.tenantId = LEGACY_TENANT_ID;
    }

    // Update ticketPrefix if provided
    const ticketPrefix = (req.body.ticketPrefix || '').replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 5);
    if (ticketPrefix) {
      updateData.ticketPrefix = ticketPrefix;
      // Sync counter prefix
      await db.collection('counters').doc(appId).set({
        tenantId: getTenantId(existingAppDoc.data() || {}),
        prefix: ticketPrefix,
      }, { merge: true });
    }

    await db.collection('apps').doc(appId).update(updateData);

    res.json({
      id: appId,
      ...updateData,
      updatedAt: new Date()
    });
  } catch (error) {
    console.error('Error updating app:', error);
    res.status(500).json({ error: 'Failed to update app' });
  }
});

// Admin: Delete app (and all its suggestions and votes)
app.delete('/api/admin/apps/:appId', requireAdminAuth, async (req, res) => {
  try {
    const { appId } = req.params;
    const appDoc = await db.collection('apps').doc(appId).get();

    if (!appDoc.exists || !isLegacyTenantData(appDoc.data() || {})) {
      return res.status(404).json({ error: 'App not found' });
    }

    // Delete all suggestions for this app
    const suggestionsSnapshot = await db.collection('suggestions')
      .where('appId', '==', appId)
      .get();

    const batch = db.batch();

    // Delete app
    batch.delete(db.collection('apps').doc(appId));

    // Delete suggestions and their votes
    for (const suggestionDoc of suggestionsSnapshot.docs) {
      const suggestionId = suggestionDoc.id;

      // Delete votes for this suggestion
      const votesSnapshot = await db.collection('votes')
        .where('suggestionId', '==', suggestionId)
        .get();

      votesSnapshot.docs.forEach(voteDoc => {
        batch.delete(voteDoc.ref);
      });

      // Delete suggestion
      batch.delete(suggestionDoc.ref);
    }

    await batch.commit();

    res.json({ success: true, message: 'App and all related data deleted successfully' });
  } catch (error) {
    console.error('Error deleting app:', error);
    res.status(500).json({ error: 'Failed to delete app' });
  }
});

// Admin: Get statistics
app.get('/api/admin/stats', requireAdminAuth, async (req, res) => {
  try {
    const [appsSnapshot, suggestionsSnapshot, votesSnapshot] = await Promise.all([
      db.collection('apps').get(),
      db.collection('suggestions').get(),
      db.collection('votes').get()
    ]);

    const legacySuggestions = suggestionsSnapshot.docs.filter(doc => isLegacyTenantData(doc.data() || {}));
    const legacyVotes = votesSnapshot.docs.filter(doc => isLegacyTenantData(doc.data() || {}));
    const legacyApps = appsSnapshot.docs.filter(doc => isLegacyTenantData(doc.data() || {}));

    const stats = {
      totalApps: legacyApps.length,
      totalSuggestions: legacySuggestions.length,
      totalVotes: legacyVotes.length,
      totalBugs: legacySuggestions.filter(doc => normalizeSuggestionType(doc.data().type) === 'bug').length,
      totalTickets: legacySuggestions.filter(doc => normalizeSuggestionType(doc.data().type) === 'ticket').length,
      totalFeatures: legacySuggestions.filter(doc => normalizeSuggestionType(doc.data().type) === 'feature').length,
    };

    res.json(stats);
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Failed to fetch statistics' });
  }
});

// Admin: Get all suggestions with app info
app.get('/api/admin/suggestions', requireAdminAuth, async (req, res) => {
  try {
    // Load suggestions and apps in parallel
    const [suggestionsSnapshot, appsSnapshot] = await Promise.all([
      db.collection('suggestions').get(),
      db.collection('apps').get()
    ]);

    // Create app lookup map
    const appsMap = {};
    appsSnapshot.docs.forEach(doc => {
      appsMap[doc.id] = { id: doc.id, ...doc.data() };
    });

    const suggestionIds = suggestionsSnapshot.docs.map(doc => doc.id);

    // Load comments only for existing suggestions in batches
    let commentStatsMap = {};
    if (suggestionIds.length > 0) {
      const commentDocs = await queryCollectionInChunks(db, {
        collectionName: 'comments',
        fieldName: 'suggestionId',
        values: suggestionIds,
      });

      // Aggregate comment counts
      commentDocs.forEach(doc => {
        const suggestionId = doc.data().suggestionId;
        if (!commentStatsMap[suggestionId]) {
          commentStatsMap[suggestionId] = {
            totalCount: 0,
            pendingCount: 0,
            publicCount: 0,
          };
        }

        const stats = buildCommentStats([doc]);
        commentStatsMap[suggestionId].totalCount += stats.totalCount;
        commentStatsMap[suggestionId].pendingCount += stats.pendingCount;
        commentStatsMap[suggestionId].publicCount += stats.publicCount;
      });
    }

    const suggestions = suggestionsSnapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(data => isLegacyTenantData(data))
      .map(data => {
        const type = normalizeSuggestionType(data.type);
        return {
          id: data.id,
          ...data,
          type,
          status: data.status || mapLegacyTagToStatus(type, data.tag, data.approved),
          priority: data.priority || 'mittel',
          labels: data.labels || [],
          ticketNumber: data.ticketNumber || null,
          app: appsMap[data.appId] || { name: 'Unknown App' },
          commentCount: commentStatsMap[data.id]?.totalCount || 0,
          pendingCommentCount: commentStatsMap[data.id]?.pendingCount || 0
        };
      });

    // Sort: open approvals first, then resolved last, then votes desc, then newest first
    suggestions.sort(compareAdminSuggestions);

    res.json(suggestions);
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

// Admin: Approve suggestion
app.post('/api/admin/suggestions/:suggestionId/approve', requireAdminAuth, async (req, res) => {
  try {
    const { suggestionId } = req.params;

    // Validate suggestionId format
    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID format' });
    }

    // Check if suggestion exists
    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists || !isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const suggestionData = suggestionDoc.data() || {};

    // Determine initial status after approval
    const suggestionType = normalizeSuggestionType(suggestionData.type);
    const newStatus = suggestionType === 'feature' ? 'wird geprüft' : 'offen';
    const legacyTag = mapStatusToLegacyTag(suggestionType, newStatus);

    // Update suggestion to approved
    await db.collection('suggestions').doc(suggestionId).update({
      approved: true,
      status: newStatus,
      tag: legacyTag,
      approvedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await logActivity(suggestionId, 'approved', {
      oldValue: 'neu',
      newValue: newStatus,
      detail: `${suggestionType === 'bug' ? 'Bug' : suggestionType === 'ticket' ? 'Ticket' : 'Vorschlag'} freigegeben`,
      tenantId: getTenantId(suggestionData),
    });

    // Send notification to suggestion creator
    try {
      await notifySuggestionCreator(suggestionId, 'approved');
    } catch (notificationError) {
      console.error('Error sending approval notification:', notificationError);
    }

    res.json({
      success: true,
      message: 'Vorschlag erfolgreich freigegeben'
    });
  } catch (error) {
    console.error('Error approving suggestion:', error);
    res.status(500).json({ error: 'Failed to approve suggestion' });
  }
});

// Admin: Update suggestion tag
app.put('/api/admin/suggestions/:suggestionId/tag', requireAdminAuth, async (req, res) => {
  try {
    const { suggestionId } = req.params;
    const { tag } = req.body;

    // Validate suggestionId format
    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID format' });
    }

    // Check if suggestion exists
    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists || !isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const suggestionData = suggestionDoc.data() || {};
    const previousTag = suggestionData.tag || null;
    const previousStatus = suggestionData.status || null;
    const suggestionType = normalizeSuggestionType(suggestionData.type);
    const validTags = suggestionType === 'bug' ? BUG_TAGS : FEATURE_TAGS;
    const normalizedTag = tag ? tag.toString().trim() : null;

    if (normalizedTag !== null && !validTags.includes(normalizedTag)) {
      return res.status(400).json({ error: 'Invalid tag value' });
    }

    // Sync tag to status
    const newStatus = normalizedTag
      ? mapLegacyTagToStatus(suggestionType, normalizedTag, true)
      : (suggestionData.approved ? (suggestionType === 'feature' ? 'wird geprüft' : 'offen') : 'neu');

    // Update suggestion tag + status
    await db.collection('suggestions').doc(suggestionId).update({
      tag: normalizedTag,
      status: newStatus,
      tagUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    if (previousStatus !== newStatus) {
      await logActivity(suggestionId, 'status_changed', {
        oldValue: previousStatus,
        newValue: newStatus,
        detail: `Status geändert: ${previousStatus || 'keiner'} → ${newStatus}`,
        tenantId: getTenantId(suggestionData),
      });
    }

    if (previousTag !== normalizedTag) {
      try {
        const statusDescription = normalizedTag
          ? `Neuer Status: ${normalizedTag}`
          : 'Status wurde entfernt';
        await notifySuggestionCreator(suggestionId, 'tag_updated', statusDescription);
      } catch (notificationError) {
        console.error('Error sending tag update notification:', notificationError);
      }
    }

    res.json({
      success: true,
      message: 'Tag erfolgreich aktualisiert'
    });
  } catch (error) {
    console.error('Error updating tag:', error);
    res.status(500).json({ error: 'Failed to update tag' });
  }
});

// Admin: Delete suggestion (and all its votes)
app.delete('/api/admin/suggestions/:suggestionId', requireAdminAuth, async (req, res) => {
  try {
    const { suggestionId } = req.params;

    // Validate suggestionId format
    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID format' });
    }

    // Check if suggestion exists
    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists || !isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    // Send rejection notification before deletion
    try {
      await notifySuggestionCreator(suggestionId, 'rejected', 'Ihr Vorschlag wurde entfernt.');
    } catch (notificationError) {
      console.error('Error sending rejection notification:', notificationError);
      // Continue even if notification fails
    }

    // Delete votes, comments, and activity for this suggestion
    const [votesSnapshot, commentsSnapshot, activitySnapshot] = await Promise.all([
      db.collection('votes').where('suggestionId', '==', suggestionId).get(),
      db.collection('comments').where('suggestionId', '==', suggestionId).get(),
      db.collection('activity').where('ticketId', '==', suggestionId).get(),
    ]);

    const batch = db.batch();

    votesSnapshot.docs.forEach(doc => batch.delete(doc.ref));
    commentsSnapshot.docs.forEach(doc => batch.delete(doc.ref));
    activitySnapshot.docs.forEach(doc => batch.delete(doc.ref));
    batch.delete(db.collection('suggestions').doc(suggestionId));

    await batch.commit();

    res.json({
      success: true,
      message: 'Eintrag und alle zugehörigen Daten gelöscht',
      deletedVotes: votesSnapshot.size
    });
  } catch (error) {
    console.error('Error deleting suggestion:', error);
    res.status(500).json({ error: 'Failed to delete suggestion' });
  }
});

// Admin: Add comment to suggestion with optional screenshots
app.post('/api/admin/suggestions/:suggestionId/comments', requireAdminAuth, async (req, res) => {
  try {
    const { suggestionId } = req.params;
    const { text, screenshots } = req.body;

    // Validate suggestionId format
    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID format' });
    }

    // Validate comment text
    const validText = validateInput(text, 2000);
    if (!validText) {
      return res.status(400).json({ error: 'Invalid comment text' });
    }

    const screenshotValidation = validateCommentScreenshots(screenshots);
    if (screenshotValidation.error) {
      return res.status(400).json({ error: screenshotValidation.error });
    }

    // Check if suggestion exists
    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists || !isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    // Create comment
    const comment = {
      tenantId: getTenantId(suggestionDoc.data() || {}),
      suggestionId,
      text: validText,
      screenshots: screenshotValidation.screenshots,
      authorType: 'admin',
      approvalStatus: 'approved',
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      approvedBy: 'admin',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const commentRef = await db.collection('comments').add(comment);

    await logActivity(suggestionId, 'commented', {
      detail: `Kommentar hinzugefügt: "${validText.slice(0, 80)}${validText.length > 80 ? '...' : ''}"`,
      tenantId: getTenantId(suggestionDoc.data() || {}),
    });

    // Send notification about new comment
    try {
      await notifySuggestionCreator(suggestionId, 'commented', validText);
    } catch (notificationError) {
      console.error('Error sending comment notification:', notificationError);
    }

    res.status(201).json({
      id: commentRef.id,
      ...normalizeCommentData(comment),
      createdAt: new Date(),
      message: 'Kommentar erfolgreich hinzugefügt'
    });
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ error: 'Failed to add comment' });
  }
});

// Public: Submit comment for an approved entry (requires admin approval before it becomes visible)
app.post('/api/suggestions/:suggestionId/comments', rateLimit(60000, 3), async (req, res) => {
  try {
    const { suggestionId } = req.params;
    const { text, screenshots } = req.body;
    const userFingerprint = generateUserFingerprint(req);

    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID format' });
    }

    const validText = validateInput(text, 2000);
    if (!validText) {
      return res.status(400).json({ error: 'Invalid comment text' });
    }

    const screenshotValidation = validateCommentScreenshots(screenshots);
    if (screenshotValidation.error) {
      return res.status(400).json({ error: screenshotValidation.error });
    }

    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists || !isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const suggestion = suggestionDoc.data();
    if (!isLegacyTenantData(suggestion)) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }
    if (!suggestion.approved) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const comment = {
      tenantId: getTenantId(suggestion),
      suggestionId,
      text: validText,
      screenshots: screenshotValidation.screenshots,
      authorType: 'user',
      authorFingerprint: userFingerprint,
      approvalStatus: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const commentRef = await db.collection('comments').add(comment);

    await logActivity(suggestionId, 'comment_submitted', {
      detail: `Benutzer-Kommentar eingereicht: "${validText.slice(0, 80)}${validText.length > 80 ? '...' : ''}"`,
      actor: `user:${userFingerprint}`,
      tenantId: getTenantId(suggestion),
    });

    try {
      const appDoc = await db.collection('apps').doc(suggestion.appId).get();
      const appName = appDoc.exists ? appDoc.data().name : 'Unbekannte App';
      const recipients = await resolveNotificationRecipients(getTenantId(suggestion));
      await sendAdminCommentNotificationEmail(suggestionId, suggestion.title, validText, appName, recipients);
    } catch (notificationError) {
      console.error('Error sending admin comment notification:', notificationError);
    }

    res.status(201).json({
      id: commentRef.id,
      message: 'Kommentar erfolgreich eingereicht und zur Freigabe vorgemerkt'
    });
  } catch (error) {
    console.error('Error submitting public comment:', error);
    res.status(500).json({ error: 'Failed to submit comment' });
  }
});

// Admin: Get comments for a suggestion
app.get('/api/admin/suggestions/:suggestionId/comments', requireAdminAuth, async (req, res) => {
  try {
    const { suggestionId } = req.params;

    // Validate suggestionId format
    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID format' });
    }

    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists || !isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const commentsSnapshot = await db.collection('comments')
      .where('suggestionId', '==', suggestionId)
      .get();

    const comments = commentsSnapshot.docs
      .filter(doc => isLegacyTenantData(doc.data() || {}))
      .map(buildAdminCommentResponse);

    // Pending first, then newest first within each group.
    comments.sort((a, b) => {
      const statusOrder = { pending: 0, approved: 1, rejected: 2 };
      const statusDelta = (statusOrder[a.approvalStatus] ?? 99) - (statusOrder[b.approvalStatus] ?? 99);
      if (statusDelta !== 0) {
        return statusDelta;
      }

      const aTime = a.createdAt?.toDate?.() ?? (a.createdAt?._seconds != null ? new Date(a.createdAt._seconds * 1000) : new Date(0));
      const bTime = b.createdAt?.toDate?.() ?? (b.createdAt?._seconds != null ? new Date(b.createdAt._seconds * 1000) : new Date(0));
      return bTime - aTime;
    });

    res.json(comments);
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// Public: Get comments for a suggestion (read-only)
app.get('/api/suggestions/:suggestionId/comments', async (req, res) => {
  try {
    const { suggestionId } = req.params;

    // Validate suggestionId format
    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID format' });
    }

    // Check if suggestion exists and is approved
    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists || !suggestionDoc.data().approved || !isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const commentsSnapshot = await db.collection('comments')
      .where('suggestionId', '==', suggestionId)
      .get();

    const comments = commentsSnapshot.docs
      .map(buildPublicCommentResponse)
      .filter(Boolean);

    // Sort by createdAt descending (newest first)
    comments.sort((a, b) => {
      const aTime = a.createdAt?.toDate?.() ?? (a.createdAt?._seconds != null ? new Date(a.createdAt._seconds * 1000) : new Date(0));
      const bTime = b.createdAt?.toDate?.() ?? (b.createdAt?._seconds != null ? new Date(b.createdAt._seconds * 1000) : new Date(0));
      return bTime - aTime;
    });

    res.json(comments);
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

// Admin: Approve a user comment
app.put('/api/admin/suggestions/:suggestionId/comments/:commentId/approve', requireAdminAuth, async (req, res) => {
  try {
    const { suggestionId, commentId } = req.params;

    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId) || !/^[a-zA-Z0-9_-]+$/.test(commentId)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    const commentRef = db.collection('comments').doc(commentId);
    const commentDoc = await commentRef.get();
    if (!commentDoc.exists) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    const comment = normalizeCommentData(commentDoc.data());
    if (comment.suggestionId !== suggestionId) {
      return res.status(400).json({ error: 'Comment does not belong to this suggestion' });
    }
    if (!isLegacyTenantData(comment)) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    if (comment.authorType !== 'user') {
      return res.status(400).json({ error: 'Only user comments require moderation' });
    }

    await commentRef.update({
      approvalStatus: 'approved',
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      approvedBy: 'admin',
      rejectedAt: null,
      rejectedBy: null,
    });

    await logActivity(suggestionId, 'comment_approved', {
      detail: `Benutzer-Kommentar freigegeben: "${comment.text.slice(0, 80)}${comment.text.length > 80 ? '...' : ''}"`,
      tenantId: getTenantId(comment),
    });

    try {
      await notifySuggestionCreator(suggestionId, 'commented', comment.text);
    } catch (notificationError) {
      console.error('Error sending approved comment notification:', notificationError);
    }

    res.json({ success: true, message: 'Kommentar freigegeben' });
  } catch (error) {
    console.error('Error approving comment:', error);
    res.status(500).json({ error: 'Failed to approve comment' });
  }
});

// Admin: Reject a user comment
app.put('/api/admin/suggestions/:suggestionId/comments/:commentId/reject', requireAdminAuth, async (req, res) => {
  try {
    const { suggestionId, commentId } = req.params;

    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId) || !/^[a-zA-Z0-9_-]+$/.test(commentId)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    const commentRef = db.collection('comments').doc(commentId);
    const commentDoc = await commentRef.get();
    if (!commentDoc.exists) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    const comment = normalizeCommentData(commentDoc.data());
    if (comment.suggestionId !== suggestionId) {
      return res.status(400).json({ error: 'Comment does not belong to this suggestion' });
    }
    if (!isLegacyTenantData(comment)) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    if (comment.authorType !== 'user') {
      return res.status(400).json({ error: 'Only user comments require moderation' });
    }

    await commentRef.update({
      approvalStatus: 'rejected',
      rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
      rejectedBy: 'admin',
    });

    await logActivity(suggestionId, 'comment_rejected', {
      detail: `Benutzer-Kommentar abgelehnt: "${comment.text.slice(0, 80)}${comment.text.length > 80 ? '...' : ''}"`,
      tenantId: getTenantId(comment),
    });

    res.json({ success: true, message: 'Kommentar abgelehnt' });
  } catch (error) {
    console.error('Error rejecting comment:', error);
    res.status(500).json({ error: 'Failed to reject comment' });
  }
});

// Admin: Delete comment
app.delete('/api/admin/suggestions/:suggestionId/comments/:commentId', requireAdminAuth, async (req, res) => {
  try {
    const { suggestionId, commentId } = req.params;

    // Validate IDs
    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId) || !/^[a-zA-Z0-9_-]+$/.test(commentId)) {
      return res.status(400).json({ error: 'Invalid ID format' });
    }

    // Check if comment exists and belongs to the suggestion
    const commentDoc = await db.collection('comments').doc(commentId).get();
    if (!commentDoc.exists) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    if (commentDoc.data().suggestionId !== suggestionId) {
      return res.status(400).json({ error: 'Comment does not belong to this suggestion' });
    }
    if (!isLegacyTenantData(commentDoc.data() || {})) {
      return res.status(404).json({ error: 'Comment not found' });
    }

    // Delete comment
    await db.collection('comments').doc(commentId).delete();

    res.json({
      success: true,
      message: 'Comment deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting comment:', error);
    res.status(500).json({ error: 'Failed to delete comment' });
  }
});

// Helper function to get user notification settings
async function getUserNotificationSettings(userFingerprint) {
  try {
    const settingsSnapshot = await db.collection('userSettings')
      .where('userFingerprint', '==', userFingerprint)
      .limit(1)
      .get();

    if (settingsSnapshot.empty) {
      return { email: null, notificationsEnabled: false };
    }

    return settingsSnapshot.docs[0].data();
  } catch (error) {
    console.error('Error getting user notification settings:', error);
    return { email: null, notificationsEnabled: false };
  }
}

// Helper function to get suggestions by user fingerprint
async function getSuggestionsByUserFingerprint(userFingerprint) {
  try {
    // This is a simplified approach - in a real implementation, 
    // you'd want to track the creator of suggestions
    const suggestionsSnapshot = await db.collection('suggestions')
      .where('userFingerprint', '==', userFingerprint)
      .get();

    return suggestionsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('Error getting user suggestions:', error);
    return [];
  }
}

// Get user notification settings
app.get('/api/user/notification-settings', async (req, res) => {
  try {
    const userFingerprint = generateUserFingerprint(req);
    const settings = await getUserNotificationSettings(userFingerprint);
    
    res.json(settings);
  } catch (error) {
    console.error('Error fetching notification settings:', error);
    res.status(500).json({ error: 'Failed to fetch notification settings' });
  }
});

// Update user notification settings
app.put('/api/user/notification-settings', rateLimit(60000, 10), async (req, res) => {
  try {
    const userFingerprint = generateUserFingerprint(req);
    const { email, notificationsEnabled } = req.body;

    // Validate email if provided
    if (email && email.trim() !== '') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim())) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
    }

    const settingsData = {
      tenantId: LEGACY_TENANT_ID,
      userFingerprint,
      email: email ? email.trim() : null,
      notificationsEnabled: Boolean(notificationsEnabled),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Check if settings already exist
    const existingSettings = await db.collection('userSettings')
      .where('userFingerprint', '==', userFingerprint)
      .limit(1)
      .get();

    if (existingSettings.empty) {
      // Create new settings
      settingsData.createdAt = admin.firestore.FieldValue.serverTimestamp();
      const docRef = await db.collection('userSettings').add(settingsData);
      res.json({
        id: docRef.id,
        ...settingsData,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    } else {
      // Update existing settings
      const docRef = existingSettings.docs[0].ref;
      await docRef.update(settingsData);
      res.json({
        id: docRef.id,
        ...settingsData,
        updatedAt: new Date()
      });
    }
  } catch (error) {
    console.error('Error updating notification settings:', error);
    res.status(500).json({ error: 'Failed to update notification settings' });
  }
});

// Send notification to suggestion creator (helper function for admin actions)
async function notifySuggestionCreator(suggestionId, status, comment = null) {
  try {
    // Get suggestion details
    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists) {
      return;
    }

    const suggestion = suggestionDoc.data();

    // Get app details
    const appDoc = await db.collection('apps').doc(suggestion.appId).get();
    const appName = appDoc.exists ? appDoc.data().name : 'Unbekannte App';
    const entryType = normalizeSuggestionType(suggestion.type);

    // Primary flow: per-entry notification settings.
    // When notificationEnabled is true, this entry uses per-entry notifications
    // exclusively – never fall through to the backward-compat path.
    if (suggestion.notificationEnabled) {
      if (isValidEmail(suggestion.notificationEmail)) {
        await sendUserNotificationEmail(
          suggestion.notificationEmail.trim(),
          suggestionId,
          suggestion.title,
          status,
          comment,
          appName,
          entryType
        );
      }
      return;
    }

    // Backward compatibility: only for old entries created before per-entry
    // notifications (notificationEnabled is falsy/undefined).
    const userFingerprint = suggestion.userFingerprint;
    if (!userFingerprint) return;

    const userSettings = await getUserNotificationSettings(userFingerprint);
    if (userSettings.notificationsEnabled && isValidEmail(userSettings.email)) {
      // Guard against sending to the same address that the per-entry path
      // would have used (should not happen, but prevents duplicates).
      await sendUserNotificationEmail(
        userSettings.email,
        suggestionId,
        suggestion.title,
        status,
        comment,
        appName,
        entryType
      );
    }
  } catch (error) {
    console.error('Error notifying suggestion creator:', error);
  }
}

// Admin: Update ticket status
app.put('/api/admin/suggestions/:suggestionId/status', requireAdminAuth, async (req, res) => {
  try {
    const { suggestionId } = req.params;
    const { status } = req.body;

    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID format' });
    }

    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists || !isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const suggestionData = suggestionDoc.data() || {};
    const suggestionType = normalizeSuggestionType(suggestionData.type);
    const validStatuses = getValidStatusesForType(suggestionType);
    const normalizedStatus = status ? status.toString().trim() : null;

    if (!normalizedStatus || !validStatuses.includes(normalizedStatus)) {
      return res.status(400).json({ error: `Ungültiger Status. Erlaubt: ${validStatuses.join(', ')}` });
    }

    const previousStatus = suggestionData.status || null;
    const legacyTag = mapStatusToLegacyTag(suggestionType, normalizedStatus);

    // If status moves beyond 'neu', also set approved
    const isApproved = normalizedStatus !== 'neu';

    const updateData = {
      status: normalizedStatus,
      tag: legacyTag,
      tagUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (isApproved && !suggestionData.approved) {
      updateData.approved = true;
      updateData.approvedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await db.collection('suggestions').doc(suggestionId).update(updateData);

    if (previousStatus !== normalizedStatus) {
      await logActivity(suggestionId, 'status_changed', {
        oldValue: previousStatus,
        newValue: normalizedStatus,
        detail: `Status geändert: ${previousStatus || 'keiner'} → ${normalizedStatus}`,
        tenantId: getTenantId(suggestionData),
      });

      try {
        await notifySuggestionCreator(suggestionId, 'tag_updated', `Neuer Status: ${normalizedStatus}`);
      } catch (notificationError) {
        console.error('Error sending status notification:', notificationError);
      }
    }

    res.json({ success: true, message: 'Status erfolgreich aktualisiert' });
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

// Admin: Update ticket priority
app.put('/api/admin/suggestions/:suggestionId/priority', requireAdminAuth, async (req, res) => {
  try {
    const { suggestionId } = req.params;
    const { priority } = req.body;

    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID format' });
    }

    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists || !isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const suggestionData = suggestionDoc.data() || {};
    const normalizedPriority = (priority || '').toString().trim().toLowerCase();
    if (!VALID_PRIORITIES.includes(normalizedPriority)) {
      return res.status(400).json({ error: `Ungültige Priorität. Erlaubt: ${VALID_PRIORITIES.join(', ')}` });
    }

    const previousPriority = suggestionData.priority || null;

    await db.collection('suggestions').doc(suggestionId).update({
      priority: normalizedPriority,
    });

    if (previousPriority !== normalizedPriority) {
      await logActivity(suggestionId, 'priority_changed', {
        oldValue: previousPriority,
        newValue: normalizedPriority,
        detail: `Priorität geändert: ${previousPriority || 'keine'} → ${normalizedPriority}`,
        tenantId: getTenantId(suggestionData),
      });
    }

    res.json({ success: true, message: 'Priorität erfolgreich aktualisiert' });
  } catch (error) {
    console.error('Error updating priority:', error);
    res.status(500).json({ error: 'Failed to update priority' });
  }
});

// Admin: Add label to suggestion
app.post('/api/admin/suggestions/:suggestionId/labels', requireAdminAuth, async (req, res) => {
  try {
    const { suggestionId } = req.params;
    const { label } = req.body;

    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID format' });
    }

    const validLabel = validateInput(label, 50);
    if (!validLabel) {
      return res.status(400).json({ error: 'Ungültiges Label' });
    }

    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists || !isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const suggestionData = suggestionDoc.data() || {};

    await db.collection('suggestions').doc(suggestionId).update({
      labels: admin.firestore.FieldValue.arrayUnion(validLabel),
    });

    await logActivity(suggestionId, 'label_added', {
      newValue: validLabel,
      detail: `Label "${validLabel}" hinzugefügt`,
      tenantId: getTenantId(suggestionData),
    });

    res.json({ success: true, message: 'Label hinzugefügt' });
  } catch (error) {
    console.error('Error adding label:', error);
    res.status(500).json({ error: 'Failed to add label' });
  }
});

// Admin: Remove label from suggestion
app.delete('/api/admin/suggestions/:suggestionId/labels/:label', requireAdminAuth, async (req, res) => {
  try {
    const { suggestionId, label } = req.params;

    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID format' });
    }

    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists || !isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }
    const suggestionData = suggestionDoc.data() || {};

    const decodedLabel = decodeURIComponent(label);

    await db.collection('suggestions').doc(suggestionId).update({
      labels: admin.firestore.FieldValue.arrayRemove(decodedLabel),
    });

    await logActivity(suggestionId, 'label_removed', {
      oldValue: decodedLabel,
      detail: `Label "${decodedLabel}" entfernt`,
      tenantId: getTenantId(suggestionData),
    });

    res.json({ success: true, message: 'Label entfernt' });
  } catch (error) {
    console.error('Error removing label:', error);
    res.status(500).json({ error: 'Failed to remove label' });
  }
});

// Admin: Get activity log for a suggestion
app.get('/api/admin/suggestions/:suggestionId/activity', requireAdminAuth, async (req, res) => {
  try {
    const { suggestionId } = req.params;

    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID format' });
    }

    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists || !isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const activitySnapshot = await db.collection('activity')
      .where('ticketId', '==', suggestionId)
      .get();

    const activities = activitySnapshot.docs
      .filter(doc => isLegacyTenantData(doc.data() || {}))
      .map(doc => ({
        id: doc.id,
        ...doc.data(),
      }));

    activities.sort((a, b) => {
      const aTime = a.createdAt?.toDate?.() ?? (a.createdAt?._seconds != null ? new Date(a.createdAt._seconds * 1000) : new Date(0));
      const bTime = b.createdAt?.toDate?.() ?? (b.createdAt?._seconds != null ? new Date(b.createdAt._seconds * 1000) : new Date(0));
      return bTime - aTime;
    });

    res.json(activities);
  } catch (error) {
    console.error('Error fetching activity:', error);
    res.status(500).json({ error: 'Failed to fetch activity' });
  }
});

// Admin: Set app labels vocabulary
app.put('/api/admin/apps/:appId/labels', requireAdminAuth, async (req, res) => {
  try {
    const { appId } = req.params;
    const { labels } = req.body;
    const appDoc = await db.collection('apps').doc(appId).get();

    if (!appDoc.exists || !isLegacyTenantData(appDoc.data() || {})) {
      return res.status(404).json({ error: 'App not found' });
    }

    if (!Array.isArray(labels)) {
      return res.status(400).json({ error: 'Labels muss ein Array sein' });
    }

    const validLabels = labels
      .map(l => validateInput(l, 50))
      .filter(Boolean);

    await db.collection('apps').doc(appId).update({
      labels: validLabels,
    });

    res.json({ success: true, labels: validLabels });
  } catch (error) {
    console.error('Error updating app labels:', error);
    res.status(500).json({ error: 'Failed to update labels' });
  }
});

// ─── RELEASE ENDPOINTS ───────────────────────────────────────────────────────

// Public: Get releases for an app (with optional status filter)
app.get('/api/apps/:appId/releases', async (req, res) => {
  try {
    const { appId } = req.params;

    if (!/^[a-zA-Z0-9_-]+$/.test(appId)) {
      return res.status(400).json({ error: 'Invalid app ID format' });
    }

    const appDoc = await db.collection('apps').doc(appId).get();
    if (!appDoc.exists || !isLegacyPublicAppVisible({ id: appId, ...appDoc.data() })) {
      return res.status(404).json({ error: 'App not found' });
    }

    let query = db.collection('releases').where('appId', '==', appId);

    // Filter by status if provided (comma-separated)
    const statusFilter = req.query.status;
    let statusList = null;
    if (statusFilter) {
      statusList = statusFilter.split(',').map(s => s.trim()).filter(s => RELEASE_STATUSES.includes(s));
      if (statusList.length === 0) {
        return res.status(400).json({ error: 'Ungültiger Status-Filter' });
      }
      if (statusList.length === 1) {
        query = query.where('status', '==', statusList[0]);
      }
      // For multiple statuses, we filter in-memory (Firestore 'in' requires array)
    }

    const releasesSnapshot = await query.get();

    let releases = releasesSnapshot.docs
      .map(doc => ({
        id: doc.id,
        ...doc.data(),
      }))
      .filter(release => isLegacyTenantData(release));

    // Filter by multiple statuses in-memory if needed
    if (statusList && statusList.length > 1) {
      releases = releases.filter(r => statusList.includes(r.status));
    }

    // Load suggestions for each release
    const releaseIds = releases.map(r => r.id);
    let suggestionsByRelease = {};

    if (releaseIds.length > 0) {
      // Batch in chunks of 10 (Firestore 'in' limit)
      const chunks = [];
      for (let i = 0; i < releaseIds.length; i += 10) {
        chunks.push(releaseIds.slice(i, i + 10));
      }

      const snapshots = await Promise.all(
        chunks.map(chunk =>
          db.collection('suggestions')
            .where('releaseId', 'in', chunk)
            .where('approved', '==', true)
            .get()
            .catch(() => ({ docs: [] }))
        )
      );

      snapshots.forEach(snapshot => {
        snapshot.docs.forEach(doc => {
          const data = doc.data();
          const rid = data.releaseId;
          if (!suggestionsByRelease[rid]) suggestionsByRelease[rid] = [];
          const type = normalizeSuggestionType(data.type);
          suggestionsByRelease[rid].push({
            id: doc.id,
            title: data.title,
            type,
            status: data.status || mapLegacyTagToStatus(type, data.tag, data.approved),
            ticketNumber: data.ticketNumber || null,
          });
        });
      });
    }

    // Attach suggestions and sort
    releases = releases.map(r => ({
      ...r,
      items: suggestionsByRelease[r.id] || [],
    }));

    sortPublicReleases(releases);

    res.json(releases);
  } catch (error) {
    console.error('Error fetching releases:', error);
    res.status(500).json({ error: 'Failed to fetch releases' });
  }
});

// Admin: Get all releases (with optional appId filter)
app.get('/api/admin/releases', requireAdminAuth, async (req, res) => {
  try {
    let query = db.collection('releases');

    if (req.query.appId) {
      query = query.where('appId', '==', req.query.appId);
    }

    const [releasesSnapshot, appsSnapshot] = await Promise.all([
      query.get(),
      db.collection('apps').get(),
    ]);

    const appsMap = {};
    appsSnapshot.docs.forEach(doc => {
      appsMap[doc.id] = { id: doc.id, ...doc.data() };
    });

    // Count suggestions per release
    const releaseIds = releasesSnapshot.docs.map(doc => doc.id);
    let itemCountMap = {};

    if (releaseIds.length > 0) {
      const chunks = [];
      for (let i = 0; i < releaseIds.length; i += 10) {
        chunks.push(releaseIds.slice(i, i + 10));
      }

      const snapshots = await Promise.all(
        chunks.map(chunk =>
          db.collection('suggestions')
            .where('releaseId', 'in', chunk)
            .get()
            .catch(() => ({ docs: [] }))
        )
      );

      snapshots.forEach(snapshot => {
        snapshot.docs.forEach(doc => {
          const rid = doc.data().releaseId;
          itemCountMap[rid] = (itemCountMap[rid] || 0) + 1;
        });
      });
    }

    const releases = releasesSnapshot.docs
      .map(doc => ({
        id: doc.id,
        ...doc.data(),
        app: appsMap[doc.data().appId] || { name: 'Unbekannte App' },
        itemCount: itemCountMap[doc.id] || 0,
      }))
      .filter(release => isLegacyTenantData(release));

    // Sort by status order, then date
    releases.sort((a, b) => {
      const statusOrder = { 'geplant': 0, 'in Arbeit': 1, 'veröffentlicht': 2 };
      const aOrder = statusOrder[a.status] ?? 9;
      const bOrder = statusOrder[b.status] ?? 9;
      if (aOrder !== bOrder) return aOrder - bOrder;

      const aDate = a.releaseDate?.toDate?.() ?? (a.releaseDate?._seconds != null ? new Date(a.releaseDate._seconds * 1000) : new Date(0));
      const bDate = b.releaseDate?.toDate?.() ?? (b.releaseDate?._seconds != null ? new Date(b.releaseDate._seconds * 1000) : new Date(0));
      return bDate - aDate;
    });

    res.json(releases);
  } catch (error) {
    console.error('Error fetching releases:', error);
    res.status(500).json({ error: 'Failed to fetch releases' });
  }
});

// Admin: Create release
app.post('/api/admin/releases', requireAdminAuth, async (req, res) => {
  try {
    const { appId, version, title, description, status, releaseDate } = req.body;

    if (!appId || !/^[a-zA-Z0-9_-]+$/.test(appId)) {
      return res.status(400).json({ error: 'Ungültige App-ID' });
    }

    const appDoc = await db.collection('apps').doc(appId).get();
    if (!appDoc.exists || !isLegacyTenantData(appDoc.data() || {})) {
      return res.status(404).json({ error: 'App nicht gefunden' });
    }

    const validVersion = validateInput(version, 50);
    if (!validVersion) {
      return res.status(400).json({ error: 'Version ist erforderlich (max. 50 Zeichen)' });
    }

    const validTitle = validateInput(title, 200) || '';
    const validDescription = validateInput(description, 5000) || '';
    const validStatus = RELEASE_STATUSES.includes(status) ? status : 'geplant';

    const release = {
      tenantId: getTenantId(appDoc.data() || {}),
      appId,
      version: validVersion,
      title: validTitle,
      description: validDescription,
      status: validStatus,
      releaseDate: releaseDate ? admin.firestore.Timestamp.fromDate(new Date(releaseDate)) : null,
      publishedAt: validStatus === 'veröffentlicht' ? admin.firestore.FieldValue.serverTimestamp() : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const docRef = await db.collection('releases').add(release);

    res.status(201).json({
      id: docRef.id,
      ...release,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (error) {
    console.error('Error creating release:', error);
    res.status(500).json({ error: 'Failed to create release' });
  }
});

// Admin: Update release
app.put('/api/admin/releases/:releaseId', requireAdminAuth, async (req, res) => {
  try {
    const { releaseId } = req.params;

    if (!/^[a-zA-Z0-9_-]+$/.test(releaseId)) {
      return res.status(400).json({ error: 'Invalid release ID format' });
    }

    const releaseDoc = await db.collection('releases').doc(releaseId).get();
    if (!releaseDoc.exists || !isLegacyTenantData(releaseDoc.data() || {})) {
      return res.status(404).json({ error: 'Release nicht gefunden' });
    }

    const { version, title, description, status, releaseDate } = req.body;

    const updateData = {
      tenantId: getTenantId(releaseDoc.data() || {}),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (version !== undefined) {
      const validVersion = validateInput(version, 50);
      if (!validVersion) {
        return res.status(400).json({ error: 'Ungültige Version' });
      }
      updateData.version = validVersion;
    }

    if (title !== undefined) {
      updateData.title = validateInput(title, 200) || '';
    }

    if (description !== undefined) {
      updateData.description = validateInput(description, 5000) || '';
    }

    if (status !== undefined) {
      if (!RELEASE_STATUSES.includes(status)) {
        return res.status(400).json({ error: `Ungültiger Status. Erlaubt: ${RELEASE_STATUSES.join(', ')}` });
      }
      updateData.status = status;

      // Set publishedAt when status changes to "veröffentlicht"
      const previousStatus = releaseDoc.data().status;
      if (status === 'veröffentlicht' && previousStatus !== 'veröffentlicht') {
        updateData.publishedAt = admin.firestore.FieldValue.serverTimestamp();
      }
    }

    if (releaseDate !== undefined) {
      updateData.releaseDate = releaseDate ? admin.firestore.Timestamp.fromDate(new Date(releaseDate)) : null;
    }

    await db.collection('releases').doc(releaseId).update(updateData);

    res.json({
      success: true,
      message: 'Release erfolgreich aktualisiert',
    });
  } catch (error) {
    console.error('Error updating release:', error);
    res.status(500).json({ error: 'Failed to update release' });
  }
});

// Admin: Delete release (unsets releaseId on linked suggestions)
app.delete('/api/admin/releases/:releaseId', requireAdminAuth, async (req, res) => {
  try {
    const { releaseId } = req.params;

    if (!/^[a-zA-Z0-9_-]+$/.test(releaseId)) {
      return res.status(400).json({ error: 'Invalid release ID format' });
    }

    const releaseDoc = await db.collection('releases').doc(releaseId).get();
    if (!releaseDoc.exists || !isLegacyTenantData(releaseDoc.data() || {})) {
      return res.status(404).json({ error: 'Release nicht gefunden' });
    }

    // Unset releaseId on all linked suggestions
    const linkedSuggestions = await db.collection('suggestions')
      .where('releaseId', '==', releaseId)
      .get();

    const releaseData = releaseDoc.data() || {};
    const linkedLegacySuggestions = linkedSuggestions.docs
      .filter(doc => isSameTenantScope(releaseData, doc.data() || {}));

    const batch = db.batch();
    linkedLegacySuggestions.forEach(doc => {
      batch.update(doc.ref, { releaseId: null });
    });
    batch.delete(db.collection('releases').doc(releaseId));

    await batch.commit();

    res.json({
      success: true,
      message: 'Release gelöscht',
      unlinkedSuggestions: linkedLegacySuggestions.length,
    });
  } catch (error) {
    console.error('Error deleting release:', error);
    res.status(500).json({ error: 'Failed to delete release' });
  }
});

// Admin: Assign suggestion to release
app.put('/api/admin/suggestions/:suggestionId/release', requireAdminAuth, async (req, res) => {
  try {
    const { suggestionId } = req.params;
    const { releaseId } = req.body;

    if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
      return res.status(400).json({ error: 'Invalid suggestion ID format' });
    }

    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists || !isLegacyTenantData(suggestionDoc.data() || {})) {
      return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    }

    // Validate releaseId if provided (null means unassign)
    if (releaseId) {
      if (!/^[a-zA-Z0-9_-]+$/.test(releaseId)) {
        return res.status(400).json({ error: 'Invalid release ID format' });
      }
      const releaseDoc = await db.collection('releases').doc(releaseId).get();
      if (!releaseDoc.exists || !isLegacyTenantData(releaseDoc.data() || {})) {
        return res.status(404).json({ error: 'Release nicht gefunden' });
      }
      if (!isSameTenantScope(suggestionDoc.data() || {}, releaseDoc.data() || {})) {
        return res.status(400).json({ error: 'Release und Eintrag gehören nicht zum selben Mandanten' });
      }
    }

    const suggestionData = suggestionDoc.data() || {};
    const previousReleaseId = suggestionData.releaseId || null;

    await db.collection('suggestions').doc(suggestionId).update({
      releaseId: releaseId || null,
    });

    await logActivity(suggestionId, 'release_changed', {
      oldValue: previousReleaseId,
      newValue: releaseId || null,
      detail: releaseId ? 'Einem Release zugeordnet' : 'Release-Zuordnung entfernt',
      tenantId: getTenantId(suggestionData),
    });

    res.json({ success: true, message: releaseId ? 'Release zugeordnet' : 'Release-Zuordnung entfernt' });
  } catch (error) {
    console.error('Error assigning release:', error);
    res.status(500).json({ error: 'Failed to assign release' });
  }
});

// ----------------------------------------------------------------------------
// Public API v1 — API-key authenticated, tenant-scoped, agent-friendly
// ----------------------------------------------------------------------------

const apiKeyRateLimitStore = new Map();

function rateLimitByApiKey(windowMs, maxRequests) {
  return (req, res, next) => {
    const keyId = req.apiAuth?.keyId;
    if (!keyId) return next();

    const now = Date.now();
    const windowStart = now - windowMs;
    const requests = (apiKeyRateLimitStore.get(keyId) || []).filter(t => t > windowStart);

    if (requests.length >= maxRequests) {
      return res.status(429).json({ error: 'API key rate limit exceeded. Please slow down.' });
    }

    requests.push(now);
    apiKeyRateLimitStore.set(keyId, requests);
    next();
  };
}

function requireApiKey(requiredScopes = []) {
  const scopes = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes];

  return async (req, res, next) => {
    try {
      const token = parseApiKeyAuthHeader(req.headers.authorization);
      if (!token) {
        return res.status(401).json({ error: 'Missing or malformed API key. Use Authorization: Bearer vt_live_…' });
      }

      const snapshot = await db.collection('apiKeys')
        .where('tokenHash', '==', hashApiKeyToken(token))
        .limit(2)
        .get();

      if (snapshot.size !== 1) {
        return res.status(401).json({ error: 'Invalid API key' });
      }

      const doc = snapshot.docs[0];
      const data = { id: doc.id, ...doc.data() };
      if (!isApiKeyActive(data)) {
        return res.status(401).json({ error: 'API key revoked' });
      }

      const grantedScopes = Array.isArray(data.scopes) ? data.scopes : [];
      const missing = scopes.filter(scope => !grantedScopes.includes(scope));
      if (missing.length > 0) {
        return res.status(403).json({
          error: `API key is missing required scope(s): ${missing.join(', ')}`,
        });
      }

      const tenantDoc = await db.collection('tenants').doc(data.tenantId).get();
      if (!tenantDoc.exists || !isActiveTenant(tenantDoc.data() || {})) {
        return res.status(403).json({ error: 'API key tenant inactive or missing' });
      }

      req.apiAuth = {
        keyId: data.id,
        tenantId: data.tenantId,
        tenant: { id: tenantDoc.id, ...tenantDoc.data() },
        scopes: grantedScopes,
        keyName: data.name,
      };

      // Fire-and-forget — never block the request on usage tracking.
      doc.ref.set({ lastUsedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true })
        .catch(err => console.error('Failed to update apiKey lastUsedAt:', err?.message || err));

      next();
    } catch (error) {
      console.error('Error validating API key:', error);
      res.status(500).json({ error: 'Failed to validate API key' });
    }
  };
}

async function loadApiKeySuggestionById(req, suggestionId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(suggestionId)) {
    return { errorStatus: 400, error: 'Invalid suggestion ID' };
  }
  const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
  if (!suggestionDoc.exists) {
    return { errorStatus: 404, error: 'Suggestion not found' };
  }
  const suggestionData = { id: suggestionDoc.id, ...suggestionDoc.data() };
  if (getTenantId(suggestionData) !== req.apiAuth.tenantId) {
    return { errorStatus: 404, error: 'Suggestion not found' };
  }
  return { suggestionDoc, suggestionData };
}

function buildApiSuggestionResponse(data) {
  const type = normalizeSuggestionType(data.type);
  const createdAt = data.createdAt?.toDate?.() || data.createdAt || null;
  return {
    id: data.id,
    ticketNumber: data.ticketNumber || null,
    type,
    title: data.title || '',
    description: data.description || '',
    status: data.status || mapLegacyTagToStatus(type, data.tag, data.approved),
    priority: data.priority || 'mittel',
    labels: Array.isArray(data.labels) ? data.labels : [],
    approved: Boolean(data.approved),
    votes: data.votes || 0,
    appId: data.appId,
    tenantId: data.tenantId,
    severity: data.severity || null,
    createdAt,
  };
}

app.get('/api/v1/me', requireApiKey(), rateLimitByApiKey(60000, 120), async (req, res) => {
  const { tenant, keyName, scopes } = req.apiAuth;
  res.json({
    tenant: {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.displayName || tenant.name || tenant.slug,
    },
    key: { name: keyName, scopes },
  });
});

app.get('/api/v1/apps', requireApiKey(['suggestions:read']), rateLimitByApiKey(60000, 120), async (req, res) => {
  try {
    const apps = await loadTenantApps(req.apiAuth.tenantId);
    res.json(apps.map(appData => ({
      id: appData.id,
      slug: appData.slug,
      name: appData.name,
      description: appData.description || '',
      ticketPrefix: appData.ticketPrefix || null,
    })));
  } catch (error) {
    console.error('Error fetching apps via API key:', error);
    res.status(500).json({ error: 'Failed to load apps' });
  }
});

app.get('/api/v1/apps/:appSlug/suggestions', requireApiKey(['suggestions:read']), rateLimitByApiKey(60000, 120), async (req, res) => {
  try {
    const appSlug = parseSlugParam(req.params.appSlug);
    if (!appSlug) return res.status(400).json({ error: 'Invalid app slug' });

    const tenantApp = await findTenantAppBySlug(req.apiAuth.tenantId, appSlug);
    if (!tenantApp) return res.status(404).json({ error: 'App not found' });

    const statusFilter = (req.query.status || '').toString().trim();
    const typeFilter = (req.query.type || '').toString().trim();
    const approvedFilter = (req.query.approved || '').toString().trim();

    const snapshot = await db.collection('suggestions')
      .where('appId', '==', tenantApp.id)
      .get();

    let suggestions = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .filter(data => getTenantId(data) === req.apiAuth.tenantId);

    if (typeFilter) {
      suggestions = suggestions.filter(s => normalizeSuggestionType(s.type) === typeFilter);
    }
    if (statusFilter) {
      suggestions = suggestions.filter(s => (s.status || mapLegacyTagToStatus(normalizeSuggestionType(s.type), s.tag, s.approved)) === statusFilter);
    }
    if (approvedFilter === 'true') {
      suggestions = suggestions.filter(s => Boolean(s.approved));
    } else if (approvedFilter === 'false') {
      suggestions = suggestions.filter(s => !s.approved);
    }

    suggestions.sort((a, b) => {
      const aTime = a.createdAt?.toDate?.() || a.createdAt || new Date(0);
      const bTime = b.createdAt?.toDate?.() || b.createdAt || new Date(0);
      return bTime - aTime;
    });

    res.json(suggestions.map(buildApiSuggestionResponse));
  } catch (error) {
    console.error('Error listing suggestions via API key:', error);
    res.status(500).json({ error: 'Failed to load suggestions' });
  }
});

app.post('/api/v1/apps/:appSlug/suggestions', requireApiKey(['suggestions:write']), rateLimitByApiKey(60000, 30), async (req, res) => {
  try {
    const appSlug = parseSlugParam(req.params.appSlug);
    if (!appSlug) return res.status(400).json({ error: 'Invalid app slug' });

    const tenantApp = await findTenantAppBySlug(req.apiAuth.tenantId, appSlug);
    if (!tenantApp) return res.status(404).json({ error: 'App not found' });

    const actor = `api:${req.apiAuth.keyId}`;
    const { suggestion, error } = buildSuggestionFromRequest(
      req.body,
      tenantApp.id,
      actor,
      req.apiAuth.tenantId
    );
    if (error) return res.status(400).json({ error });

    suggestion.approved = true;
    suggestion.approvedAt = admin.firestore.FieldValue.serverTimestamp();
    suggestion.approvedBy = actor;
    suggestion.ticketNumber = await generateTicketNumber(tenantApp.id, req.apiAuth.tenantId);

    const docRef = await db.collection('suggestions').add(suggestion);

    await logActivity(docRef.id, 'created', {
      detail: `${suggestion.type === 'bug' ? 'Bug' : suggestion.type === 'ticket' ? 'Ticket' : 'Vorschlag'} "${suggestion.title}" via API erstellt`,
      actor,
      tenantId: req.apiAuth.tenantId,
    });

    res.status(201).json(buildApiSuggestionResponse({ id: docRef.id, ...suggestion, createdAt: new Date() }));
  } catch (error) {
    console.error('Error creating suggestion via API key:', error);
    res.status(500).json({ error: 'Failed to create suggestion' });
  }
});

app.get('/api/v1/suggestions/:suggestionId', requireApiKey(['suggestions:read']), rateLimitByApiKey(60000, 120), async (req, res) => {
  try {
    const { suggestionData, errorStatus, error } = await loadApiKeySuggestionById(req, req.params.suggestionId);
    if (error) return res.status(errorStatus).json({ error });
    res.json(buildApiSuggestionResponse(suggestionData));
  } catch (error) {
    console.error('Error fetching suggestion via API key:', error);
    res.status(500).json({ error: 'Failed to load suggestion' });
  }
});

app.patch('/api/v1/suggestions/:suggestionId', requireApiKey(['suggestions:status']), rateLimitByApiKey(60000, 60), async (req, res) => {
  try {
    const { suggestionDoc, suggestionData, errorStatus, error } = await loadApiKeySuggestionById(req, req.params.suggestionId);
    if (error) return res.status(errorStatus).json({ error });

    const updates = {};
    const activityEntries = [];
    const actor = `api:${req.apiAuth.keyId}`;
    const type = normalizeSuggestionType(suggestionData.type);

    if (Object.prototype.hasOwnProperty.call(req.body, 'status')) {
      const status = (req.body.status || '').toString().trim();
      const validStatuses = getValidStatusesForType(type);
      if (!validStatuses.includes(status)) {
        return res.status(400).json({ error: `Invalid status. Allowed: ${validStatuses.join(', ')}` });
      }
      const previousStatus = suggestionData.status || null;
      updates.status = status;
      updates.tag = mapStatusToLegacyTag(type, status);
      updates.tagUpdatedAt = admin.firestore.FieldValue.serverTimestamp();
      if (status !== 'neu' && !suggestionData.approved) {
        updates.approved = true;
        updates.approvedAt = admin.firestore.FieldValue.serverTimestamp();
        updates.approvedBy = actor;
      }
      if (previousStatus !== status) {
        activityEntries.push({
          action: 'status_changed',
          payload: {
            oldValue: previousStatus,
            newValue: status,
            detail: `Status via API geändert: ${previousStatus || 'keiner'} → ${status}`,
          },
        });
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'priority')) {
      const priority = (req.body.priority || '').toString().trim().toLowerCase();
      if (!VALID_PRIORITIES.includes(priority)) {
        return res.status(400).json({ error: `Invalid priority. Allowed: ${VALID_PRIORITIES.join(', ')}` });
      }
      const previous = suggestionData.priority || null;
      updates.priority = priority;
      if (previous !== priority) {
        activityEntries.push({
          action: 'priority_changed',
          payload: {
            oldValue: previous,
            newValue: priority,
            detail: `Priorität via API geändert: ${previous || 'keine'} → ${priority}`,
          },
        });
      }
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'labels')) {
      if (!Array.isArray(req.body.labels)) {
        return res.status(400).json({ error: 'labels must be an array of strings' });
      }
      const labels = req.body.labels
        .filter(label => typeof label === 'string')
        .map(label => label.trim())
        .filter(Boolean)
        .slice(0, 20);
      updates.labels = labels;
      activityEntries.push({
        action: 'labels_changed',
        payload: {
          oldValue: Array.isArray(suggestionData.labels) ? suggestionData.labels : [],
          newValue: labels,
          detail: `Labels via API gesetzt: ${labels.join(', ') || '(leer)'}`,
        },
      });
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'No supported fields provided (status, priority, labels)' });
    }

    await suggestionDoc.ref.update(updates);

    for (const entry of activityEntries) {
      await logActivity(suggestionDoc.id, entry.action, {
        ...entry.payload,
        actor,
        tenantId: req.apiAuth.tenantId,
      });
    }

    const refreshed = await suggestionDoc.ref.get();
    res.json(buildApiSuggestionResponse({ id: refreshed.id, ...refreshed.data() }));
  } catch (error) {
    console.error('Error updating suggestion via API key:', error);
    res.status(500).json({ error: 'Failed to update suggestion' });
  }
});

app.get('/api/v1/suggestions/:suggestionId/comments', requireApiKey(['comments:read']), rateLimitByApiKey(60000, 120), async (req, res) => {
  try {
    const { errorStatus, error } = await loadApiKeySuggestionById(req, req.params.suggestionId);
    if (error) return res.status(errorStatus).json({ error });

    const snapshot = await db.collection('comments')
      .where('suggestionId', '==', req.params.suggestionId)
      .get();

    const comments = snapshot.docs
      .filter(doc => getTenantId(doc.data() || {}) === req.apiAuth.tenantId)
      .map(buildAdminCommentResponse);

    comments.sort((a, b) => {
      const aTime = a.createdAt?.toDate?.() || a.createdAt || new Date(0);
      const bTime = b.createdAt?.toDate?.() || b.createdAt || new Date(0);
      return bTime - aTime;
    });

    res.json(comments);
  } catch (error) {
    console.error('Error listing comments via API key:', error);
    res.status(500).json({ error: 'Failed to load comments' });
  }
});

app.post('/api/v1/suggestions/:suggestionId/comments', requireApiKey(['comments:write']), rateLimitByApiKey(60000, 30), async (req, res) => {
  try {
    const { suggestionData, errorStatus, error } = await loadApiKeySuggestionById(req, req.params.suggestionId);
    if (error) return res.status(errorStatus).json({ error });

    const validText = validateInput(req.body?.text, 2000);
    if (!validText) return res.status(400).json({ error: 'Invalid comment text' });

    const screenshotValidation = validateCommentScreenshots(req.body?.screenshots);
    if (screenshotValidation.error) return res.status(400).json({ error: screenshotValidation.error });

    const actor = `api:${req.apiAuth.keyId}`;
    const comment = {
      tenantId: req.apiAuth.tenantId,
      suggestionId: req.params.suggestionId,
      text: validText,
      screenshots: screenshotValidation.screenshots,
      authorType: 'admin',
      approvalStatus: 'approved',
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      approvedBy: actor,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const commentRef = await db.collection('comments').add(comment);

    await logActivity(req.params.suggestionId, 'commented', {
      detail: `Kommentar via API hinzugefügt: "${validText.slice(0, 80)}${validText.length > 80 ? '...' : ''}"`,
      actor,
      tenantId: req.apiAuth.tenantId,
    });

    res.status(201).json({
      id: commentRef.id,
      ...normalizeCommentData(comment),
      createdAt: new Date(),
    });
  } catch (error) {
    console.error('Error creating comment via API key:', error);
    res.status(500).json({ error: 'Failed to create comment' });
  }
});

// ----------------------------------------------------------------------------
// Tenant admin endpoints for managing API keys (owner/admin only)
// ----------------------------------------------------------------------------

function buildApiKeyAdminResponse(data) {
  return {
    id: data.id,
    name: data.name,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    tokenPrefix: data.tokenPrefix || null,
    createdAt: data.createdAt?.toDate?.() || data.createdAt || null,
    createdBy: data.createdBy || null,
    lastUsedAt: data.lastUsedAt?.toDate?.() || data.lastUsedAt || null,
    revokedAt: data.revokedAt?.toDate?.() || data.revokedAt || null,
  };
}

app.get('/api/admin/tenants/:tenantSlug/api-keys', requireTenantAccess(['owner', 'admin']), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const snapshot = await db.collection('apiKeys')
      .where('tenantId', '==', tenant.id)
      .get();

    const keys = snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .sort((a, b) => {
        const aTime = a.createdAt?.toDate?.() || a.createdAt || new Date(0);
        const bTime = b.createdAt?.toDate?.() || b.createdAt || new Date(0);
        return bTime - aTime;
      })
      .map(buildApiKeyAdminResponse);

    res.json(keys);
  } catch (error) {
    console.error('Error listing API keys:', error);
    res.status(500).json({ error: 'Failed to list API keys' });
  }
});

app.post('/api/admin/tenants/:tenantSlug/api-keys', requireTenantAccess(['owner', 'admin']), rateLimit(60000, 10), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const name = (req.body?.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'Name ist erforderlich' });

    const scopes = normalizeScopes(req.body?.scopes);
    if (scopes.length === 0) {
      return res.status(400).json({
        error: `Mindestens ein Scope erforderlich. Erlaubt: ${API_KEY_SCOPES.join(', ')}`,
      });
    }

    const token = generateApiKeyToken();
    const createdBy = req.tenantAuth?.user?.email
      || (req.tenantAuth?.type === 'admin' ? 'platform-admin' : null);

    const data = buildApiKeyData({
      tenantId: tenant.id,
      name,
      scopes,
      token,
      createdBy,
    });

    const docRef = await db.collection('apiKeys').add(data);

    res.status(201).json({
      ...buildApiKeyAdminResponse({ id: docRef.id, ...data }),
      token,
      message: 'Token wird nur einmal angezeigt. Bitte sicher aufbewahren.',
    });
  } catch (error) {
    console.error('Error creating API key:', error);
    res.status(500).json({ error: error.message || 'Failed to create API key' });
  }
});

app.delete('/api/admin/tenants/:tenantSlug/api-keys/:keyId', requireTenantAccess(['owner', 'admin']), async (req, res) => {
  try {
    const tenant = await resolveAdminTenantFromParam(req, res);
    if (!tenant) return;

    const { keyId } = req.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(keyId)) {
      return res.status(400).json({ error: 'Invalid key id' });
    }

    const keyRef = db.collection('apiKeys').doc(keyId);
    const keyDoc = await keyRef.get();
    if (!keyDoc.exists || (keyDoc.data() || {}).tenantId !== tenant.id) {
      return res.status(404).json({ error: 'API key not found' });
    }

    await keyRef.update({
      revokedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, message: 'API-Schlüssel widerrufen' });
  } catch (error) {
    console.error('Error revoking API key:', error);
    res.status(500).json({ error: 'Failed to revoke API key' });
  }
});

// SPA-Fallback: pfad-basierte Board-URLs (/{tenant}/{board}/{view}) auf die
// öffentliche Shell mappen. Läuft NACH allen API-Routen und express.static,
// lässt /api/*, statische Assets und reservierte Seiten unangetastet.
app.get('*', (req, res, next) => {
  if (!shouldServeAppShell(req.method, req.path)) {
    return next();
  }
  res.sendFile(path.join(__dirname, '../public/index.html'));
});

// For Vercel serverless functions
module.exports = app;
