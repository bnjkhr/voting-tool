// Firebase initialization script - can be re-run safely to ensure default apps exist
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function loadDotEnvFileIfPresent() {
  // Minimal .env loader to avoid an extra dependency for this script.
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

      // Support `export KEY=value`
      const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
      const eqIdx = normalized.indexOf('=');
      if (eqIdx <= 0) continue;

      const key = normalized.slice(0, eqIdx).trim();
      if (!key || process.env[key] !== undefined) continue;

      let value = normalized.slice(eqIdx + 1).trim();

      // Special case: people frequently paste FIREBASE_PRIVATE_KEY as multi-line PEM.
      // We support that by consuming subsequent lines until the END marker.
      if (
        key === 'FIREBASE_PRIVATE_KEY' &&
        value.includes('-----BEGIN') &&
        !value.includes('-----END')
      ) {
        const collected = [value];
        while (i + 1 < lines.length) {
          i++;
          collected.push(lines[i]);
          if (lines[i].includes('-----END')) break;
        }
        value = collected.join('\n').trim();
      }

      // Strip surrounding quotes if present
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      // Common escape sequences used in .env files (notably for private keys)
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

// Initialize Firebase Admin
// Supported auth options:
// - GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json (recommended locally)
// - FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY (used by the app)
const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY;

if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.log('Auth: using GOOGLE_APPLICATION_CREDENTIALS');
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
} else {
  const normalizedPrivateKey = typeof privateKey === 'string'
    ? privateKey.trim().replace(/\\n/g, '\n')
    : privateKey;

  if (!projectId || !clientEmail || !normalizedPrivateKey) {
    console.error('Firebase configuration incomplete for init-firebase.');
    console.error('Missing one of: FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY');
    console.error('');
    console.error('Fix options:');
    console.error('1) Export vars from a local .env file:');
    console.error('   (not needed anymore) This script auto-loads .env when present.');
    console.error('2) Or set GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json');
    process.exit(1);
  }

  console.log('Auth: using FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY');

  // Defensive validation: provide actionable error messages without printing secrets.
  const pk = normalizedPrivateKey;
  const hasBegin = pk.includes('BEGIN PRIVATE KEY');
  const hasEnd = pk.includes('END PRIVATE KEY');
  if (!hasBegin || !hasEnd) {
    console.error('FIREBASE_PRIVATE_KEY does not look like a valid PEM private key.');
    console.error(`Detected: length=${pk.length}, begin=${hasBegin}, end=${hasEnd}`);
    console.error('');
    console.error('Expected .env format (single line with \\n escapes):');
    console.error('FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n"');
    console.error('');
    console.error('Alternative (recommended): set GOOGLE_APPLICATION_CREDENTIALS to the downloaded serviceAccount.json');
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey: pk,
    }),
  });
}

const db = admin.firestore();

async function ensureDefaultApps() {
  const defaultApps = [
    {
      name: 'GymBo',
      description: 'Fitness-Tracking und Workout-Planung'
    },
    {
      name: 'FamilyManager',
      description: 'Familienorganisation, Aufgaben und Alltagsplanung'
    }
  ];

  console.log('Ensuring default apps exist...');

  for (const app of defaultApps) {
    try {
      const existing = await db.collection('apps')
        .where('name', '==', app.name)
        .limit(1)
        .get();

      if (!existing.empty) {
        console.log(`↩︎ App already exists: ${app.name} (ID: ${existing.docs[0].id})`);
        continue;
      }

      const docRef = await db.collection('apps').add(app);
      console.log(`✅ Created app: ${app.name} (ID: ${docRef.id})`);
    } catch (error) {
      console.error(`❌ Error creating app ${app.name}:`, error);
    }
  }

  console.log('Default apps ensured.');
  process.exit(0);
}

async function run() {
  try {
    await ensureDefaultApps();
  } catch (error) {
    console.error('Error checking apps:', error);
    process.exit(1);
  }
}

run();
