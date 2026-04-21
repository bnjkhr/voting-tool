const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const path = require('path');
const { Resend } = require('resend');
const fs = require('fs');
const {
  buildAdminCommentResponse,
  buildCommentStats,
  buildPublicCommentResponse,
  normalizeCommentData,
  validateCommentScreenshots,
} = require('./comment-utils');
const { queryCollectionInChunks } = require('./firestore-chunks');

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

// Firebase Admin initialization
if (!admin.apps.length) {
  try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      admin.initializeApp({
        credential: admin.credential.applicationDefault(),
      });
    } else {
      const projectId = process.env.FIREBASE_PROJECT_ID;
      const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
      const privateKey = process.env.FIREBASE_PRIVATE_KEY;

      if (!projectId || !clientEmail || !privateKey) {
        console.error('Missing required Firebase environment variables');
        throw new Error('Firebase configuration incomplete');
      }

      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          privateKey: privateKey.trim().replace(/\\n/g, '\n'),
        }),
      });
    }
  } catch (error) {
    console.error('Failed to initialize Firebase Admin:', error);
    throw error;
  }
}

const db = admin.firestore();
const FEATURE_TAGS = ['wird umgesetzt', 'wird nicht umgesetzt', 'wird geprüft', 'ist umgesetzt'];
const BUG_TAGS = ['neu', 'in analyse', 'behoben', 'nicht reproduzierbar'];
const VALID_SUGGESTION_TYPES = ['feature', 'bug', 'ticket'];
const VALID_BUG_SEVERITIES = ['low', 'medium', 'high', 'critical'];
const VALID_PRIORITIES = ['niedrig', 'mittel', 'hoch', 'kritisch'];

const TICKET_STATUSES = ['neu', 'offen', 'in Bearbeitung', 'wartend', 'gelöst', 'geschlossen'];
const FEATURE_STATUSES = ['neu', 'wird geprüft', 'wird umgesetzt', 'ist umgesetzt', 'wird nicht umgesetzt'];
const RESOLVED_STATUSES = ['ist umgesetzt', 'wird nicht umgesetzt', 'gelöst', 'geschlossen'];
const RELEASE_STATUSES = ['geplant', 'in Arbeit', 'veröffentlicht'];

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

async function generateTicketNumber(appId) {
  const counterRef = db.collection('counters').doc(appId);

  const result = await db.runTransaction(async (transaction) => {
    const counterDoc = await transaction.get(counterRef);

    let prefix, nextNumber;
    if (counterDoc.exists) {
      prefix = counterDoc.data().prefix;
      nextNumber = counterDoc.data().nextNumber || 1;
    } else {
      // Fallback: derive prefix from app name
      const appDoc = await transaction.get(db.collection('apps').doc(appId));
      const appName = appDoc.exists ? appDoc.data().name : 'APP';
      prefix = appName.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase() || 'APP';
      nextNumber = 1;
    }

    transaction.set(counterRef, { prefix, nextNumber: nextNumber + 1 }, { merge: true });

    return `${prefix}-${String(nextNumber).padStart(3, '0')}`;
  });

  return result;
}

async function logActivity(ticketId, action, { oldValue = null, newValue = null, detail = null, actor = 'admin' } = {}) {
  try {
    await db.collection('activity').add({
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

// Helper function to send admin notification email
async function sendAdminNotificationEmail(suggestionId, title, description, appName, reportMeta = {}) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('Email not configured - RESEND_API_KEY missing');
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
      to: 'ben.kohler@me.com',
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

async function sendAdminCommentNotificationEmail(suggestionId, suggestionTitle, commentText, appName) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('Email not configured - RESEND_API_KEY missing');
    return;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  const adminUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/admin.html`;

  try {
    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: 'ben.kohler@me.com',
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

// Helper function to generate user fingerprint
function generateUserFingerprint(req) {
  const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  const userAgent = req.headers['user-agent'] || '';
  return `${ip}_${Buffer.from(userAgent).toString('base64').slice(0, 10)}`;
}

// Get all apps
app.get('/api/apps', async (req, res) => {
  try {
    const appsSnapshot = await db.collection('apps').get();
    const apps = appsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Sort by name
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

    const suggestions = suggestionsSnapshot.docs.map(doc => {
      const data = doc.data();
      const type = normalizeSuggestionType(data.type);

      return {
        id: doc.id,
        ...data,
        type,
        status: data.status || mapLegacyTagToStatus(type, data.tag, data.approved),
        priority: data.priority || 'mittel',
        labels: data.labels || [],
        ticketNumber: data.ticketNumber || null,
        commentCount: commentStatsMap[doc.id]?.publicCount || 0,
        hasVoted: type === 'feature' && userVotesSet.has(doc.id)
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

    // Check if app exists
    const appDoc = await db.collection('apps').doc(appId).get();
    if (!appDoc.exists) {
      return res.status(404).json({ error: 'App not found' });
    }

    const { suggestion, error } = buildSuggestionFromRequest(req.body, appId, userFingerprint);
    if (error) {
      return res.status(400).json({ error });
    }

    // Generate ticket number
    const ticketNumber = await generateTicketNumber(appId);
    suggestion.ticketNumber = ticketNumber;

    const docRef = await db.collection('suggestions').add(suggestion);

    // Log activity
    await logActivity(docRef.id, 'created', {
      detail: `${suggestion.type === 'bug' ? 'Bug' : suggestion.type === 'ticket' ? 'Ticket' : 'Vorschlag'} "${suggestion.title}" erstellt`,
      actor: `user:${userFingerprint}`,
    });

    // Send email notification to admin
    try {
      await sendAdminNotificationEmail(
        docRef.id,
        suggestion.title,
        suggestion.description,
        appDoc.data().name,
        { type: suggestion.type, severity: suggestion.severity || null }
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
    if (!suggestionDoc.exists) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }
    const suggestionType = normalizeSuggestionType(suggestionDoc.data()?.type);
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
    if (!suggestionDoc.exists) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }
    const suggestionType = normalizeSuggestionType(suggestionDoc.data()?.type);
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

function buildSuggestionFromRequest(body, appId, userFingerprint) {
  const type = normalizeSuggestionType(body.type);
  const validTitle = validateInput(body.title, 100);
  const validDescription = validateInput(body.description, 1000);

  if (!validTitle || !validDescription) {
    return { error: 'Invalid title or description' };
  }

  const suggestion = {
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
  const authHeader = req.headers.authorization;
  const adminPassword = process.env.ADMIN_PASSWORD;

  // Require admin password to be set
  if (!adminPassword) {
    console.error('ADMIN_PASSWORD environment variable not set');
    return res.status(500).json({ error: 'Server configuration error' });
  }

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized - Invalid auth format' });
  }

  const token = authHeader.substring(7);
  if (token !== adminPassword) {
    return res.status(401).json({ error: 'Unauthorized - Invalid credentials' });
  }

  next();
}

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
      name: validName,
      description: validDescription,
      ticketPrefix: ticketPrefix || validName.replace(/[^a-zA-Z]/g, '').slice(0, 3).toUpperCase() || 'APP',
      labels: [],
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('apps').add(app);

    // Initialize counter for ticket numbers
    await db.collection('counters').doc(docRef.id).set({
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

    if (!name || !description) {
      return res.status(400).json({ error: 'Name and description are required' });
    }

    const updateData = {
      name: name.trim(),
      description: description.trim(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // Update ticketPrefix if provided
    const ticketPrefix = (req.body.ticketPrefix || '').replace(/[^a-zA-Z]/g, '').toUpperCase().slice(0, 5);
    if (ticketPrefix) {
      updateData.ticketPrefix = ticketPrefix;
      // Sync counter prefix
      await db.collection('counters').doc(appId).set({ prefix: ticketPrefix }, { merge: true });
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

    const stats = {
      totalApps: appsSnapshot.size,
      totalSuggestions: suggestionsSnapshot.size,
      totalVotes: votesSnapshot.size,
      totalBugs: suggestionsSnapshot.docs.filter(doc => normalizeSuggestionType(doc.data().type) === 'bug').length,
      totalTickets: suggestionsSnapshot.docs.filter(doc => normalizeSuggestionType(doc.data().type) === 'ticket').length,
      totalFeatures: suggestionsSnapshot.docs.filter(doc => normalizeSuggestionType(doc.data().type) === 'feature').length,
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

    const suggestions = suggestionsSnapshot.docs.map(doc => {
      const data = doc.data();
      const type = normalizeSuggestionType(data.type);
      return {
        id: doc.id,
        ...data,
        type,
        status: data.status || mapLegacyTagToStatus(type, data.tag, data.approved),
        priority: data.priority || 'mittel',
        labels: data.labels || [],
        ticketNumber: data.ticketNumber || null,
        app: appsMap[data.appId] || { name: 'Unknown App' },
        commentCount: commentStatsMap[doc.id]?.totalCount || 0,
        pendingCommentCount: commentStatsMap[doc.id]?.pendingCount || 0
      };
    });

    // Sort: resolved last, then pending before approved, then votes desc, then newest first
    suggestions.sort((a, b) => {
      const resolvedStatuses = RESOLVED_STATUSES;
      const aResolved = resolvedStatuses.includes(a.status) ? 1 : 0;
      const bResolved = resolvedStatuses.includes(b.status) ? 1 : 0;
      if (aResolved !== bResolved) {
        return aResolved - bResolved;
      }

      // Then: pending suggestions (not approved) come before approved
      const aApproved = a.approved === true ? 1 : 0;
      const bApproved = b.approved === true ? 1 : 0;
      if (aApproved !== bApproved) {
        return aApproved - bApproved;
      }

      // Then: sort by votes (desc)
      if (b.votes !== a.votes) {
        return (b.votes || 0) - (a.votes || 0);
      }

      // Finally: sort by createdAt (desc)
      const aTime = a.createdAt?.toDate?.() || a.createdAt || new Date(0);
      const bTime = b.createdAt?.toDate?.() || b.createdAt || new Date(0);
      return bTime - aTime;
    });

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
    if (!suggestionDoc.exists) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    // Determine initial status after approval
    const suggestionType = normalizeSuggestionType(suggestionDoc.data()?.type);
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
    if (!suggestionDoc.exists) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const previousTag = suggestionDoc.data()?.tag || null;
    const previousStatus = suggestionDoc.data()?.status || null;
    const suggestionType = normalizeSuggestionType(suggestionDoc.data()?.type);
    const validTags = suggestionType === 'bug' ? BUG_TAGS : FEATURE_TAGS;
    const normalizedTag = tag ? tag.toString().trim() : null;

    if (normalizedTag !== null && !validTags.includes(normalizedTag)) {
      return res.status(400).json({ error: 'Invalid tag value' });
    }

    // Sync tag to status
    const newStatus = normalizedTag
      ? mapLegacyTagToStatus(suggestionType, normalizedTag, true)
      : (suggestionDoc.data()?.approved ? (suggestionType === 'feature' ? 'wird geprüft' : 'offen') : 'neu');

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
    if (!suggestionDoc.exists) {
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
    if (!suggestionDoc.exists) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    // Create comment
    const comment = {
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
    if (!suggestionDoc.exists) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const suggestion = suggestionDoc.data();
    if (!suggestion.approved) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const comment = {
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
    });

    try {
      const appDoc = await db.collection('apps').doc(suggestion.appId).get();
      const appName = appDoc.exists ? appDoc.data().name : 'Unbekannte App';
      await sendAdminCommentNotificationEmail(suggestionId, suggestion.title, validText, appName);
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

    const commentsSnapshot = await db.collection('comments')
      .where('suggestionId', '==', suggestionId)
      .get();

    const comments = commentsSnapshot.docs.map(buildAdminCommentResponse);

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
    if (!suggestionDoc.exists || !suggestionDoc.data().approved) {
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
    if (!suggestionDoc.exists) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const suggestionType = normalizeSuggestionType(suggestionDoc.data()?.type);
    const validStatuses = getValidStatusesForType(suggestionType);
    const normalizedStatus = status ? status.toString().trim() : null;

    if (!normalizedStatus || !validStatuses.includes(normalizedStatus)) {
      return res.status(400).json({ error: `Ungültiger Status. Erlaubt: ${validStatuses.join(', ')}` });
    }

    const previousStatus = suggestionDoc.data()?.status || null;
    const legacyTag = mapStatusToLegacyTag(suggestionType, normalizedStatus);

    // If status moves beyond 'neu', also set approved
    const isApproved = normalizedStatus !== 'neu';

    const updateData = {
      status: normalizedStatus,
      tag: legacyTag,
      tagUpdatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    if (isApproved && !suggestionDoc.data()?.approved) {
      updateData.approved = true;
      updateData.approvedAt = admin.firestore.FieldValue.serverTimestamp();
    }

    await db.collection('suggestions').doc(suggestionId).update(updateData);

    if (previousStatus !== normalizedStatus) {
      await logActivity(suggestionId, 'status_changed', {
        oldValue: previousStatus,
        newValue: normalizedStatus,
        detail: `Status geändert: ${previousStatus || 'keiner'} → ${normalizedStatus}`,
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
    if (!suggestionDoc.exists) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const normalizedPriority = (priority || '').toString().trim().toLowerCase();
    if (!VALID_PRIORITIES.includes(normalizedPriority)) {
      return res.status(400).json({ error: `Ungültige Priorität. Erlaubt: ${VALID_PRIORITIES.join(', ')}` });
    }

    const previousPriority = suggestionDoc.data()?.priority || null;

    await db.collection('suggestions').doc(suggestionId).update({
      priority: normalizedPriority,
    });

    if (previousPriority !== normalizedPriority) {
      await logActivity(suggestionId, 'priority_changed', {
        oldValue: previousPriority,
        newValue: normalizedPriority,
        detail: `Priorität geändert: ${previousPriority || 'keine'} → ${normalizedPriority}`,
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
    if (!suggestionDoc.exists) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    await db.collection('suggestions').doc(suggestionId).update({
      labels: admin.firestore.FieldValue.arrayUnion(validLabel),
    });

    await logActivity(suggestionId, 'label_added', {
      newValue: validLabel,
      detail: `Label "${validLabel}" hinzugefügt`,
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
    if (!suggestionDoc.exists) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    const decodedLabel = decodeURIComponent(label);

    await db.collection('suggestions').doc(suggestionId).update({
      labels: admin.firestore.FieldValue.arrayRemove(decodedLabel),
    });

    await logActivity(suggestionId, 'label_removed', {
      oldValue: decodedLabel,
      detail: `Label "${decodedLabel}" entfernt`,
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

    const activitySnapshot = await db.collection('activity')
      .where('ticketId', '==', suggestionId)
      .get();

    const activities = activitySnapshot.docs.map(doc => ({
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

    let releases = releasesSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

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

    // Sort: "in Arbeit" before "geplant", "veröffentlicht" by date desc
    releases.sort((a, b) => {
      const statusOrder = { 'in Arbeit': 0, 'geplant': 1, 'veröffentlicht': 2 };
      const aOrder = statusOrder[a.status] ?? 9;
      const bOrder = statusOrder[b.status] ?? 9;
      if (aOrder !== bOrder) return aOrder - bOrder;

      // Within same status: by releaseDate
      const aDate = a.releaseDate?.toDate?.() ?? (a.releaseDate?._seconds != null ? new Date(a.releaseDate._seconds * 1000) : new Date(0));
      const bDate = b.releaseDate?.toDate?.() ?? (b.releaseDate?._seconds != null ? new Date(b.releaseDate._seconds * 1000) : new Date(0));
      // For published: newest first. For planned: earliest first.
      return a.status === 'veröffentlicht' ? bDate - aDate : aDate - bDate;
    });

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

    const releases = releasesSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      app: appsMap[doc.data().appId] || { name: 'Unbekannte App' },
      itemCount: itemCountMap[doc.id] || 0,
    }));

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
    if (!appDoc.exists) {
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
    if (!releaseDoc.exists) {
      return res.status(404).json({ error: 'Release nicht gefunden' });
    }

    const { version, title, description, status, releaseDate } = req.body;

    const updateData = {
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
    if (!releaseDoc.exists) {
      return res.status(404).json({ error: 'Release nicht gefunden' });
    }

    // Unset releaseId on all linked suggestions
    const linkedSuggestions = await db.collection('suggestions')
      .where('releaseId', '==', releaseId)
      .get();

    const batch = db.batch();
    linkedSuggestions.docs.forEach(doc => {
      batch.update(doc.ref, { releaseId: null });
    });
    batch.delete(db.collection('releases').doc(releaseId));

    await batch.commit();

    res.json({
      success: true,
      message: 'Release gelöscht',
      unlinkedSuggestions: linkedSuggestions.size,
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
    if (!suggestionDoc.exists) {
      return res.status(404).json({ error: 'Eintrag nicht gefunden' });
    }

    // Validate releaseId if provided (null means unassign)
    if (releaseId) {
      if (!/^[a-zA-Z0-9_-]+$/.test(releaseId)) {
        return res.status(400).json({ error: 'Invalid release ID format' });
      }
      const releaseDoc = await db.collection('releases').doc(releaseId).get();
      if (!releaseDoc.exists) {
        return res.status(404).json({ error: 'Release nicht gefunden' });
      }
    }

    const previousReleaseId = suggestionDoc.data()?.releaseId || null;

    await db.collection('suggestions').doc(suggestionId).update({
      releaseId: releaseId || null,
    });

    await logActivity(suggestionId, 'release_changed', {
      oldValue: previousReleaseId,
      newValue: releaseId || null,
      detail: releaseId ? 'Einem Release zugeordnet' : 'Release-Zuordnung entfernt',
    });

    res.json({ success: true, message: releaseId ? 'Release zugeordnet' : 'Release-Zuordnung entfernt' });
  } catch (error) {
    console.error('Error assigning release:', error);
    res.status(500).json({ error: 'Failed to assign release' });
  }
});

// For Vercel serverless functions
module.exports = app;
