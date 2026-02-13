const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

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

async function migrateSuggestionTypes() {
  loadDotEnvFileIfPresent('.env.local');
  loadDotEnvFileIfPresent('.env');
  const db = initFirebase();

  const snapshot = await db.collection('suggestions').get();

  if (snapshot.empty) {
    console.log('No suggestions found.');
    return;
  }

  const toUpdate = snapshot.docs.filter((doc) => {
    const data = doc.data() || {};
    return !data.type;
  });

  if (toUpdate.length === 0) {
    console.log('No migration needed. All suggestions already have a type.');
    return;
  }

  console.log(`Found ${toUpdate.length} suggestion(s) without type. Migrating to type=feature...`);

  let batch = db.batch();
  let opCount = 0;
  let updatedCount = 0;

  for (const doc of toUpdate) {
    batch.update(doc.ref, {
      type: 'feature',
      migratedTypeAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    opCount += 1;
    updatedCount += 1;

    if (opCount === 450) {
      await batch.commit();
      batch = db.batch();
      opCount = 0;
    }
  }

  if (opCount > 0) {
    await batch.commit();
  }

  console.log(`Migration complete. Updated ${updatedCount} suggestion(s).`);
}

migrateSuggestionTypes()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Migration failed:', error.message);
    process.exit(1);
  });
