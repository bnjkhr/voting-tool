const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

function loadDotEnvFileIfPresent() {
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

function sanitizePrivateKey(value) {
  if (typeof value !== 'string') return value;

  let normalized = value.trim();
  normalized = normalized
    .replace(/^"+/, '')
    .replace(/"+$/, '')
    .replace(/^'+/, '')
    .replace(/'+$/, '')
    .trim();

  normalized = normalized
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '\r')
    .replace(/\\t/g, '\t');

  return normalized;
}

function initFirestore() {
  if (admin.apps.length > 0) return admin.firestore();

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    admin.initializeApp({ credential: admin.credential.applicationDefault() });
    return admin.firestore();
  }

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = sanitizePrivateKey(process.env.FIREBASE_PRIVATE_KEY);

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error(
      'Firebase configuration incomplete. Set GOOGLE_APPLICATION_CREDENTIALS or FIREBASE_* vars.'
    );
  }

  const hasBegin = privateKey.includes('BEGIN PRIVATE KEY');
  const hasEnd = privateKey.includes('END PRIVATE KEY');
  if (!hasBegin || !hasEnd) {
    throw new Error(
      `FIREBASE_PRIVATE_KEY does not look like a valid PEM private key (begin=${hasBegin}, end=${hasEnd}).`
    );
  }

  admin.initializeApp({
    credential: admin.credential.cert({
      projectId,
      clientEmail,
      privateKey,
    }),
  });

  return admin.firestore();
}

module.exports = {
  admin,
  initFirestore,
  loadDotEnvFileIfPresent,
  sanitizePrivateKey,
};
