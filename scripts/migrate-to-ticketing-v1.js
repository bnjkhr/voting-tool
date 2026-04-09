const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');

function loadDotEnvFileIfPresent(filename) {
  const envPath = path.join(process.cwd(), filename);
  if (!fs.existsSync(envPath)) return;

  const content = fs.readFileSync(envPath, 'utf8');
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIdx = normalized.indexOf('=');
    if (eqIdx <= 0) continue;

    const key = normalized.slice(0, eqIdx).trim();
    if (!key || process.env[key] !== undefined) continue;

    let value = normalized.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    value = value
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');

    process.env[key] = value;
  }
}

function initFirebase() {
  if (admin.apps.length > 0) return admin.firestore();

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
    return admin.firestore();
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('Missing Firebase configuration. Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_* vars.');
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: privateKey.trim().replace(/\\n/g, '\n'),
    }),
  });

  return admin.firestore();
}

function derivePrefix(appName) {
  const cleaned = appName.replace(/[^a-zA-Z]/g, '');
  return cleaned.slice(0, 3).toUpperCase() || 'APP';
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

  // feature (and ticket, though tickets won't have legacy tags)
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

async function migrate() {
  loadDotEnvFileIfPresent('.env.local');
  loadDotEnvFileIfPresent('.env');
  const db = initFirebase();

  if (DRY_RUN) {
    console.log('=== DRY RUN MODE - keine Änderungen werden geschrieben ===\n');
  }

  // Step 1: Load and update apps with ticketPrefix
  console.log('Schritt 1: Apps laden und Ticket-Präfixe setzen...');
  const appsSnapshot = await db.collection('apps').get();

  if (appsSnapshot.empty) {
    console.log('Keine Apps gefunden. Migration abgebrochen.');
    return;
  }

  const apps = {};
  const usedPrefixes = new Set();

  for (const doc of appsSnapshot.docs) {
    const data = doc.data();
    let prefix = derivePrefix(data.name);

    // Ensure unique prefix
    let candidate = prefix;
    let suffix = 2;
    while (usedPrefixes.has(candidate)) {
      candidate = prefix.slice(0, 2) + suffix;
      suffix++;
    }
    prefix = candidate;
    usedPrefixes.add(prefix);

    apps[doc.id] = { name: data.name, prefix };
    console.log(`  App "${data.name}" (${doc.id}) → Präfix: ${prefix}`);
  }

  // Step 2: Count existing suggestions per app for counter initialization
  console.log('\nSchritt 2: Suggestions laden...');
  const suggestionsSnapshot = await db.collection('suggestions').get();

  if (suggestionsSnapshot.empty) {
    console.log('Keine Suggestions gefunden.');
  }

  // Group suggestions by app and sort by createdAt for sequential numbering
  const suggestionsByApp = {};
  const alreadyMigrated = [];

  for (const doc of suggestionsSnapshot.docs) {
    const data = doc.data();

    if (data.migratedAt) {
      alreadyMigrated.push(doc.id);
      continue;
    }

    const appId = data.appId;
    if (!suggestionsByApp[appId]) {
      suggestionsByApp[appId] = [];
    }
    suggestionsByApp[appId].push({ id: doc.id, data });
  }

  if (alreadyMigrated.length > 0) {
    console.log(`  ${alreadyMigrated.length} Dokument(e) bereits migriert, werden übersprungen.`);
  }

  // Sort each app's suggestions by createdAt
  for (const appId of Object.keys(suggestionsByApp)) {
    suggestionsByApp[appId].sort((a, b) => {
      const aTime = a.data.createdAt?.toDate?.() ?? (a.data.createdAt?._seconds != null ? new Date(a.data.createdAt._seconds * 1000) : new Date(0));
      const bTime = b.data.createdAt?.toDate?.() ?? (b.data.createdAt?._seconds != null ? new Date(b.data.createdAt._seconds * 1000) : new Date(0));
      return aTime - bTime;
    });
  }

  // Step 3: Write changes
  if (DRY_RUN) {
    console.log('\n=== DRY RUN: Geplante Änderungen ===\n');

    for (const [appId, app] of Object.entries(apps)) {
      const suggestions = suggestionsByApp[appId] || [];
      console.log(`App "${app.name}" (${appId}):`);
      console.log(`  Präfix: ${app.prefix}`);
      console.log(`  Labels: [] (leer)`);
      console.log(`  Counter startet bei: ${suggestions.length + 1}`);

      for (let i = 0; i < suggestions.length; i++) {
        const s = suggestions[i];
        const type = (s.data.type || 'feature').toLowerCase();
        const status = mapLegacyTagToStatus(type, s.data.tag, s.data.approved);
        const priority = type === 'bug' ? mapSeverityToPriority(s.data.severity) : 'mittel';
        const ticketNumber = `${app.prefix}-${String(i + 1).padStart(3, '0')}`;

        console.log(`  ${ticketNumber}: "${s.data.title}" (${type}) → status: ${status}, priority: ${priority}`);
      }
      console.log('');
    }

    console.log('=== DRY RUN abgeschlossen. Führe ohne --dry-run aus, um Änderungen zu schreiben. ===');
    return;
  }

  // Actual migration
  console.log('\nSchritt 3: Änderungen schreiben...');

  let batch = db.batch();
  let opCount = 0;
  let totalUpdated = 0;

  async function commitBatchIfNeeded() {
    if (opCount >= 450) {
      await batch.commit();
      batch = db.batch();
      opCount = 0;
    }
  }

  // Update apps with ticketPrefix and labels
  for (const [appId, app] of Object.entries(apps)) {
    batch.update(db.collection('apps').doc(appId), {
      ticketPrefix: app.prefix,
      labels: [],
    });
    opCount++;
    await commitBatchIfNeeded();
  }

  // Create/update counter documents
  for (const [appId, app] of Object.entries(apps)) {
    const suggestions = suggestionsByApp[appId] || [];
    const counterRef = db.collection('counters').doc(appId);
    batch.set(counterRef, {
      prefix: app.prefix,
      nextNumber: suggestions.length + 1,
    });
    opCount++;
    await commitBatchIfNeeded();
  }

  // Migrate suggestions
  for (const [appId, suggestions] of Object.entries(suggestionsByApp)) {
    const app = apps[appId];
    if (!app) {
      console.warn(`  App ${appId} nicht gefunden, überspringe ${suggestions.length} Suggestions.`);
      continue;
    }

    for (let i = 0; i < suggestions.length; i++) {
      const s = suggestions[i];
      const type = (s.data.type || 'feature').toLowerCase();
      const status = mapLegacyTagToStatus(type, s.data.tag, s.data.approved);
      const priority = type === 'bug' ? mapSeverityToPriority(s.data.severity) : 'mittel';
      const ticketNumber = `${app.prefix}-${String(i + 1).padStart(3, '0')}`;

      batch.update(db.collection('suggestions').doc(s.id), {
        ticketNumber,
        status,
        priority,
        labels: [],
        migratedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      opCount++;
      totalUpdated++;
      await commitBatchIfNeeded();
    }
  }

  // Commit remaining
  if (opCount > 0) {
    await batch.commit();
  }

  console.log(`\nMigration abgeschlossen:`);
  console.log(`  ${Object.keys(apps).length} App(s) aktualisiert`);
  console.log(`  ${totalUpdated} Suggestion(s) migriert`);
  console.log(`  ${alreadyMigrated.length} Suggestion(s) übersprungen (bereits migriert)`);
}

migrate()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Migration fehlgeschlagen:', error.message);
    process.exit(1);
  });
