const express = require('express');
const cors = require('cors');
require('dotenv').config();
const admin = require('firebase-admin');
const path = require('path');
const { Resend } = require('resend');

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Firebase Admin initialization
if (!admin.apps.length) {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');


  if (!projectId || !clientEmail || !privateKey) {
    console.error('Missing required Firebase environment variables');
    throw new Error('Firebase configuration incomplete');
  }

  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId,
        clientEmail,
        privateKey,
      }),
    });
  } catch (error) {
    console.error('Failed to initialize Firebase Admin:', error);
    throw error;
  }
}

const db = admin.firestore();

// Helper function to send admin notification email
async function sendAdminNotificationEmail(suggestionId, title, description, appName) {
  // Check if Resend is configured
  if (!process.env.RESEND_API_KEY) {
    console.warn('Email not configured - RESEND_API_KEY missing');
    return;
  }

  console.log('Attempting to send email notification via Resend...');
  const resend = new Resend(process.env.RESEND_API_KEY);
  const fromEmail = process.env.EMAIL_FROM || 'onboarding@resend.dev';

  try {
    const adminUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/admin.html`;

    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: 'ben.kohler@me.com',
      subject: `Neuer Vorschlag wartet auf Freigabe: ${title}`,
      html: `
        <h2>Neuer Vorschlag eingereicht</h2>
        <p><strong>App:</strong> ${appName}</p>
        <p><strong>Titel:</strong> ${title}</p>
        <p><strong>Beschreibung:</strong> ${description}</p>
        <p><strong>Suggestion ID:</strong> ${suggestionId}</p>
        <br>
        <p><a href="${adminUrl}">Zum Admin-Bereich</a></p>
      `
    });

    if (error) {
      console.error('Failed to send email:', error);
      return;
    }

    console.log('Email sent successfully:', data.id);
  } catch (error) {
    console.error('Unexpected error sending email:', error);
  }
}

// Helper function to send user notification email
async function sendUserNotificationEmail(userEmail, suggestionId, title, status, comment, appName) {
  // Check if Resend is configured
  if (!process.env.RESEND_API_KEY) {
    console.warn('Email not configured - RESEND_API_KEY missing');
    return;
  }

  // Validate email address
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(userEmail)) {
    console.warn('Invalid user email format:', userEmail);
    return;
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const fromEmail = process.env.EMAIL_FROM || 'onboarding@resend.dev';

    const suggestionUrl = `${process.env.BASE_URL || 'http://localhost:3000'}/#suggestion-${suggestionId}`;
    
    let statusText = '';
    let statusColor = '';
    
    switch(status) {
      case 'approved':
        statusText = 'Freigegeben';
        statusColor = '#28a745';
        break;
      case 'rejected':
        statusText = 'Abgelehnt';
        statusColor = '#dc3545';
        break;
      case 'commented':
        statusText = 'Neuer Kommentar';
        statusColor = '#007bff';
        break;
      case 'tag_changed':
        statusText = 'Status geändert';
        statusColor = '#f59e0b';
        break;
      default:
        statusText = 'Status aktualisiert';
        statusColor = '#6c757d';
    }

    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: userEmail,
      subject: `Ihr Vorschlag "${title}" - ${statusText}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Update zu Ihrem Vorschlag</h2>
          
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: ${statusColor};">${statusText}</h3>
            <p><strong>Vorschlag:</strong> ${title}</p>
            <p><strong>App:</strong> ${appName}</p>
            ${comment ? `<p><strong>Kommentar:</strong> ${comment}</p>` : ''}
          </div>
          
          <p><a href="${suggestionUrl}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Vorschlag ansehen</a></p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #dee2e6;">
          <p style="color: #6c757d; font-size: 12px;">
            Sie erhalten diese E-Mail, weil Sie Benachrichtigungen für diesen Vorschlag aktiviert haben.
            <br>Um keine Benachrichtigungen mehr zu erhalten, deaktivieren Sie die Benachrichtigungen in den Einstellungen.
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
    console.error('Unexpected error sending user notification email:', error);
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

    // Batch load comments and votes for these suggestions
    const [commentsSnapshot, votesSnapshot] = await Promise.all([
      db.collection('comments')
        .where('suggestionId', 'in', suggestionIds.slice(0, 10)) // Firestore 'in' limit is 10
        .get()
        .catch(() => ({ docs: [] })), // Fallback if query fails
      db.collection('votes')
        .where('suggestionId', 'in', suggestionIds.slice(0, 10))
        .where('userFingerprint', '==', userFingerprint)
        .get()
        .catch(() => ({ docs: [] }))
    ]);

    // If more than 10 suggestions, load remaining in second batch
    let additionalComments = [];
    let additionalVotes = [];
    if (suggestionIds.length > 10) {
      const [commentsSnapshot2, votesSnapshot2] = await Promise.all([
        db.collection('comments')
          .where('suggestionId', 'in', suggestionIds.slice(10))
          .get()
          .catch(() => ({ docs: [] })),
        db.collection('votes')
          .where('suggestionId', 'in', suggestionIds.slice(10))
          .where('userFingerprint', '==', userFingerprint)
          .get()
          .catch(() => ({ docs: [] }))
      ]);
      additionalComments = commentsSnapshot2.docs;
      additionalVotes = votesSnapshot2.docs;
    }

    // Create maps
    const commentCountMap = {};
    [...commentsSnapshot.docs, ...additionalComments].forEach(doc => {
      const suggestionId = doc.data().suggestionId;
      commentCountMap[suggestionId] = (commentCountMap[suggestionId] || 0) + 1;
    });

    const userVotesSet = new Set(
      [...votesSnapshot.docs, ...additionalVotes].map(doc => doc.data().suggestionId)
    );

    const suggestions = suggestionsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      commentCount: commentCountMap[doc.id] || 0,
      hasVoted: userVotesSet.has(doc.id)
    }));

    // Sort by votes (desc) then by createdAt (desc)
    suggestions.sort((a, b) => {
      // First: check if suggestion has "ist umgesetzt" tag (completed)
      const aCompleted = a.tag === 'ist umgesetzt' ? 1 : 0;
      const bCompleted = b.tag === 'ist umgesetzt' ? 1 : 0;
      if (aCompleted !== bCompleted) {
        return aCompleted - bCompleted; // Open suggestions (0) come before completed (1)
      }

      // Within each group: sort by votes (desc)
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

// Create new suggestion
app.post('/api/apps/:appId/suggestions', rateLimit(60000, 3), async (req, res) => {
  try {
    const { appId } = req.params;
    const { title, description, email, notificationsEnabled } = req.body;
    const userFingerprint = generateUserFingerprint(req);

    // Validate inputs
    const validTitle = validateInput(title, 100);
    const validDescription = validateInput(description, 500);

    if (!validTitle || !validDescription) {
      return res.status(400).json({ error: 'Invalid title or description' });
    }

    // Validate email if provided
    let validEmail = null;
    if (email && email.trim() !== '') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email.trim())) {
        return res.status(400).json({ error: 'Invalid email format' });
      }
      validEmail = email.trim();
    }

    // Check if app exists
    const appDoc = await db.collection('apps').doc(appId).get();
    if (!appDoc.exists) {
      return res.status(404).json({ error: 'App not found' });
    }

    const suggestion = {
      appId,
      title: validTitle,
      description: validDescription,
      votes: 0,
      approved: false,
      userFingerprint: userFingerprint,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('suggestions').add(suggestion);

    // Save user notification settings if email was provided
    if (validEmail) {
      try {
        const settingsData = {
          userFingerprint,
          email: validEmail,
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
          await db.collection('userSettings').add(settingsData);
        } else {
          // Update existing settings
          const docRef = existingSettings.docs[0].ref;
          await docRef.update(settingsData);
        }
      } catch (settingsError) {
        console.error('Error saving user notification settings:', settingsError);
        // Continue even if settings save fails
      }
    }

    // Send email notification to admin
    try {
      await sendAdminNotificationEmail(docRef.id, validTitle, validDescription, appDoc.data().name);
    } catch (emailError) {
      console.error('Error sending notification email:', emailError);
      // Continue even if email fails
    }

    res.status(201).json({
      id: docRef.id,
      ...suggestion,
      createdAt: new Date(),
      message: 'Vorschlag erfolgreich eingereicht. Er wird geprüft und dann freigegeben.'
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

    const app = {
      name: validName,
      description: validDescription,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const docRef = await db.collection('apps').add(app);

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
      totalVotes: votesSnapshot.size
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
    let commentCountMap = {};
    if (suggestionIds.length > 0) {
      // Split into chunks of 10 for Firestore 'in' query limit
      const chunks = [];
      for (let i = 0; i < suggestionIds.length; i += 10) {
        chunks.push(suggestionIds.slice(i, i + 10));
      }

      // Load all chunks in parallel
      const commentSnapshots = await Promise.all(
        chunks.map(chunk =>
          db.collection('comments')
            .where('suggestionId', 'in', chunk)
            .get()
            .catch(() => ({ docs: [] }))
        )
      );

      // Aggregate comment counts
      commentSnapshots.forEach(snapshot => {
        snapshot.docs.forEach(doc => {
          const suggestionId = doc.data().suggestionId;
          commentCountMap[suggestionId] = (commentCountMap[suggestionId] || 0) + 1;
        });
      });
    }

    const suggestions = suggestionsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      app: appsMap[doc.data().appId] || { name: 'Unknown App' },
      commentCount: commentCountMap[doc.id] || 0
    }));

    // Sort by approval status (pending first), then by votes (desc), then by createdAt (desc)
    suggestions.sort((a, b) => {
      // First: check if suggestion has "ist umgesetzt" tag (completed)
      const aCompleted = a.tag === 'ist umgesetzt' ? 1 : 0;
      const bCompleted = b.tag === 'ist umgesetzt' ? 1 : 0;
      if (aCompleted !== bCompleted) {
        return aCompleted - bCompleted; // Open suggestions (0) come before completed (1)
      }

      // Then: pending suggestions (not approved) come first within each group
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

    // Update suggestion to approved
    await db.collection('suggestions').doc(suggestionId).update({
      approved: true,
      approvedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Send notification to suggestion creator
    try {
      await notifySuggestionCreator(suggestionId, 'approved');
    } catch (notificationError) {
      console.error('Error sending approval notification:', notificationError);
      // Continue even if notification fails
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

    // Validate tag value (allow null to remove tag)
    const validTags = ['wird umgesetzt', 'wird nicht umgesetzt', 'wird geprüft', 'ist umgesetzt', null];
    if (tag !== undefined && !validTags.includes(tag)) {
      return res.status(400).json({ error: 'Invalid tag value' });
    }

    // Check if suggestion exists
    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists) {
      return res.status(404).json({ error: 'Suggestion not found' });
    }

    // Update suggestion tag
    await db.collection('suggestions').doc(suggestionId).update({
      tag: tag || null,
      tagUpdatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // Send notification to suggestion creator about tag change
    try {
      await notifySuggestionCreator(suggestionId, 'tag_changed', `Status wurde geändert zu: ${tag || 'Kein Status'}`);
    } catch (notificationError) {
      console.error('Error sending tag change notification:', notificationError);
      // Continue even if notification fails
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

    // Delete votes for this suggestion
    const votesSnapshot = await db.collection('votes')
      .where('suggestionId', '==', suggestionId)
      .get();

    const batch = db.batch();

    // Delete all votes
    votesSnapshot.docs.forEach(voteDoc => {
      batch.delete(voteDoc.ref);
    });

    // Delete suggestion
    batch.delete(db.collection('suggestions').doc(suggestionId));

    await batch.commit();

    res.json({
      success: true,
      message: 'Suggestion and all related votes deleted successfully',
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

    // Validate screenshots (optional array of base64 strings)
    let processedScreenshots = [];
    if (screenshots && Array.isArray(screenshots)) {
      if (screenshots.length > 5) {
        return res.status(400).json({ error: 'Maximum 5 screenshots allowed' });
      }

      // Validate each screenshot
      processedScreenshots = screenshots.filter(screenshot => {
        // Basic validation: check if it's a base64 data URL and reasonable size
        return typeof screenshot === 'string' &&
               screenshot.startsWith('data:image/') &&
               screenshot.length < 300000; // ~225KB limit per image
      });

      // Validate total size
      const totalSize = processedScreenshots.reduce((sum, s) => sum + s.length, 0);
      if (totalSize > 800000) { // ~600KB total limit
        return res.status(400).json({ error: 'Screenshots total size too large. Please use smaller images.' });
      }
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
      screenshots: processedScreenshots,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const commentRef = await db.collection('comments').add(comment);

    // Send notification about new comment
    try {
      await notifySuggestionCreator(suggestionId, 'commented', validText);
    } catch (notificationError) {
      console.error('Error sending comment notification:', notificationError);
      // Continue even if notification fails
    }

    res.status(201).json({
      id: commentRef.id,
      ...comment,
      createdAt: new Date(),
      message: 'Kommentar erfolgreich hinzugefügt'
    });
  } catch (error) {
    console.error('Error adding comment:', error);
    res.status(500).json({ error: 'Failed to add comment' });
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

    const comments = commentsSnapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    // Sort by createdAt descending (newest first)
    comments.sort((a, b) => {
      const aTime = a.createdAt?.toDate?.() || a.createdAt?._seconds ? new Date(a.createdAt._seconds * 1000) : new Date(0);
      const bTime = b.createdAt?.toDate?.() || b.createdAt?._seconds ? new Date(b.createdAt._seconds * 1000) : new Date(0);
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

    const comments = commentsSnapshot.docs.map(doc => ({
      id: doc.id,
      text: doc.data().text,
      screenshots: doc.data().screenshots || [],
      createdAt: doc.data().createdAt
    }));

    // Sort by createdAt descending (newest first)
    comments.sort((a, b) => {
      const aTime = a.createdAt?.toDate?.() || a.createdAt?._seconds ? new Date(a.createdAt._seconds * 1000) : new Date(0);
      const bTime = b.createdAt?.toDate?.() || b.createdAt?._seconds ? new Date(b.createdAt._seconds * 1000) : new Date(0);
      return bTime - aTime;
    });

    res.json(comments);
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
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
    console.log(`[NOTIFICATION] Starting notification for suggestion ${suggestionId}, status: ${status}`);

    // Get suggestion details
    const suggestionDoc = await db.collection('suggestions').doc(suggestionId).get();
    if (!suggestionDoc.exists) {
      console.log(`[NOTIFICATION] Suggestion ${suggestionId} does not exist`);
      return;
    }

    const suggestion = suggestionDoc.data();
    console.log(`[NOTIFICATION] Suggestion userFingerprint: ${suggestion.userFingerprint}`);

    // Get app details
    const appDoc = await db.collection('apps').doc(suggestion.appId).get();
    const appName = appDoc.exists ? appDoc.data().name : 'Unbekannte App';

    // For now, we'll use a simplified approach to find the user
    // In a real implementation, you'd want to track the creator's fingerprint
    const userFingerprint = suggestion.userFingerprint;

    if (userFingerprint) {
      const userSettings = await getUserNotificationSettings(userFingerprint);
      console.log(`[NOTIFICATION] User settings:`, {
        hasEmail: !!userSettings.email,
        notificationsEnabled: userSettings.notificationsEnabled,
        email: userSettings.email ? userSettings.email.substring(0, 3) + '***' : 'none'
      });

      if (userSettings.email && userSettings.notificationsEnabled) {
        console.log(`[NOTIFICATION] Sending email to user...`);
        await sendUserNotificationEmail(
          userSettings.email,
          suggestionId,
          suggestion.title,
          status,
          comment,
          appName
        );
        console.log(`[NOTIFICATION] Email sent successfully`);
      } else {
        console.log(`[NOTIFICATION] Not sending email - conditions not met`);
      }
    } else {
      console.log(`[NOTIFICATION] No userFingerprint found for suggestion`);
    }
  } catch (error) {
    console.error('[NOTIFICATION] Error notifying suggestion creator:', error);
  }
}

// For Vercel serverless functions
// TEST ENDPOINT - Remove later
app.get('/api/test-email', async (req, res) => {
  if (!process.env.RESEND_API_KEY) {
    return res.status(500).json({ error: 'RESEND_API_KEY is missing in env variables' });
  }

  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    const fromEmail = process.env.EMAIL_FROM || 'onboarding@resend.dev';
    
    // Send to the admin email defined in env or hardcoded fallback
    const toEmail = 'ben.kohler@me.com';

    console.log(`Testing email from ${fromEmail} to ${toEmail}`);

    const { data, error } = await resend.emails.send({
      from: fromEmail,
      to: toEmail,
      subject: 'Test Email Voting Tool',
      html: '<p>Wenn Sie das lesen, funktioniert der Versand! 🚀</p>'
    });

    if (error) {
      console.error('Resend Error:', error);
      return res.status(400).json({ 
        success: false, 
        error: error,
        message: 'Resend returned an error. See "error" object details.'
      });
    }

    return res.json({ 
      success: true, 
      data: data,
      message: `Email sent successfully to ${toEmail}` 
    });

  } catch (err) {
    console.error('Server Error:', err);
    return res.status(500).json({ 
      success: false, 
      error: err.message, 
      stack: err.stack 
    });
  }
});

module.exports = app;