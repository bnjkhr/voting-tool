#!/usr/bin/env node

// Diagnose Firebase credential loading without ever printing secret material.
//
// Why this exists:
//   The repo has historically shipped with a flaky .env where FIREBASE_PRIVATE_KEY
//   would not parse into a valid PEM, blocking every script that needs Firestore
//   admin access (bootstrap-tenancy, test-tenant:create, migrations).
//
// What this tool does:
//   1. Runs the same .env loader the real scripts use (firebase-admin-utils.js).
//   2. Inspects FIREBASE_* env vars by SHAPE only — never logs the secret body.
//   3. Tries to import the private key into Node's crypto module, which is the
//      same check firebase-admin does internally before failing.
//   4. Suggests the next concrete action when something is wrong.
//
// What this tool intentionally does NOT do:
//   - Print the private key, even masked.
//   - Send anything off-machine.
//   - Mutate .env.

'use strict';

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const {
  loadDotEnvFileIfPresent,
  sanitizePrivateKey,
} = require('./firebase-admin-utils');

const PEM_BEGIN = '-----BEGIN PRIVATE KEY-----';
const PEM_END = '-----END PRIVATE KEY-----';

function check(label, ok, detail = '') {
  const mark = ok ? '✓' : '✗';
  const line = `  ${mark} ${label}${detail ? ` — ${detail}` : ''}`;
  console.log(line);
  return ok;
}

function diagnoseEnvFilePresence() {
  const envPath = path.join(process.cwd(), '.env');
  console.log('\n[1/4] .env file');
  if (!fs.existsSync(envPath)) {
    check('.env exists in cwd', false, `expected at ${envPath}`);
    return false;
  }
  check('.env exists', true, envPath);
  return true;
}

function diagnoseGoogleAppCreds() {
  console.log('\n[2/4] GOOGLE_APPLICATION_CREDENTIALS (alternative auth path)');
  const value = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!value) {
    check('GOOGLE_APPLICATION_CREDENTIALS set', false, 'fine if you use FIREBASE_* instead');
    return false;
  }
  check('GOOGLE_APPLICATION_CREDENTIALS set', true);
  const exists = fs.existsSync(value);
  check('credentials file readable', exists, exists ? value : `missing: ${value}`);
  return exists;
}

function diagnoseFirebaseEnvVars() {
  console.log('\n[3/4] FIREBASE_* env vars');
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;

  const projectOk = check('FIREBASE_PROJECT_ID set', Boolean(projectId));
  const emailOk = check(
    'FIREBASE_CLIENT_EMAIL set',
    Boolean(clientEmail),
    clientEmail ? `${clientEmail.slice(0, 3)}…@${(clientEmail.split('@')[1] || '').slice(0, 12)}…` : ''
  );
  const keyPresent = check('FIREBASE_PRIVATE_KEY set', Boolean(rawKey));

  if (!keyPresent) return false;
  return projectOk && emailOk;
}

function diagnosePrivateKeyShape() {
  console.log('\n[4/4] FIREBASE_PRIVATE_KEY shape');
  const rawKey = process.env.FIREBASE_PRIVATE_KEY;
  if (!rawKey) {
    check('private key in env', false);
    return false;
  }

  const sanitized = sanitizePrivateKey(rawKey);

  const hasBegin = sanitized.includes(PEM_BEGIN);
  const hasEnd = sanitized.includes(PEM_END);
  check('contains BEGIN PRIVATE KEY header', hasBegin);
  check('contains END PRIVATE KEY footer', hasEnd);

  if (!hasBegin || !hasEnd) {
    return false;
  }

  const lines = sanitized.split('\n');
  const expectsAtLeast = 4; // header + body + footer + (optional trailing)
  check(
    'has at least 4 lines after sanitization',
    lines.length >= expectsAtLeast,
    `${lines.length} lines`
  );

  // Encoded-escape detection: if literal \n still appears, the loader failed.
  const literalEscapesLeft = (sanitized.match(/\\n/g) || []).length;
  check(
    'no literal \\n escapes left after loader',
    literalEscapesLeft === 0,
    literalEscapesLeft === 0
      ? ''
      : `${literalEscapesLeft} literal \\n found — your .env likely wraps the key in quotes incorrectly`
  );

  const bodyLines = lines.filter(line => line && !line.startsWith('-----'));
  const bodyJoined = bodyLines.join('');
  // Base64 body for a Google service account RSA key is roughly 1600-1700 chars.
  const bodyLength = bodyJoined.length;
  check(
    'base64 body length is plausible (≥ 1000 chars)',
    bodyLength >= 1000,
    `${bodyLength} chars`
  );
  const isBase64Like = /^[A-Za-z0-9+/=]+$/.test(bodyJoined);
  check('base64 body uses base64 alphabet only', isBase64Like);

  // The crypto round-trip is the definitive test — firebase-admin uses the
  // same primitive under the hood.
  let cryptoOk = false;
  let cryptoError = '';
  try {
    const key = crypto.createPrivateKey({ key: sanitized, format: 'pem' });
    cryptoOk = key.asymmetricKeyType === 'rsa';
    if (!cryptoOk) {
      cryptoError = `unexpected key type: ${key.asymmetricKeyType}`;
    }
  } catch (err) {
    cryptoError = err?.message || String(err);
  }
  check(
    'crypto.createPrivateKey accepts the PEM as RSA',
    cryptoOk,
    cryptoError
  );

  return cryptoOk;
}

function suggestActions(allGood) {
  console.log('\nNext action:');
  if (allGood) {
    console.log('  Credentials look healthy. Try:');
    console.log('    npm run bootstrap-tenancy:dry-run');
    console.log('    npm run test-tenant:create:dry-run -- --tenant-slug staging-saas-smoke');
    return;
  }

  console.log('  • If FIREBASE_PRIVATE_KEY is missing or broken:');
  console.log('    1. Open Firebase Console → Project Settings → Service accounts.');
  console.log('    2. Click "Generate new private key" and download the JSON.');
  console.log('    3. Copy the `private_key` value from the JSON.');
  console.log('    4. In .env, set FIREBASE_PRIVATE_KEY to that value as one of:');
  console.log('         a) wrapped in double quotes, all on one line, with literal \\n escapes');
  console.log('            FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n"');
  console.log('         b) wrapped in double quotes, multi-line, no escapes');
  console.log('            FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----');
  console.log('            ...');
  console.log('            -----END PRIVATE KEY-----');
  console.log('            "');
  console.log('    5. Re-run this diagnose script. The check above tells you exactly what is off.');
  console.log('');
  console.log('  • Alternatively, point GOOGLE_APPLICATION_CREDENTIALS at the downloaded JSON');
  console.log('    (no env-var copy-paste needed):');
  console.log('         export GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/serviceAccount.json');
}

function main() {
  console.log('Firebase credential diagnose');
  console.log('(no secret material is printed — only structural checks)');

  loadDotEnvFileIfPresent();

  const envOk = diagnoseEnvFilePresence();
  const gappOk = diagnoseGoogleAppCreds();
  const envVarsOk = diagnoseFirebaseEnvVars();
  const keyOk = envVarsOk ? diagnosePrivateKeyShape() : false;

  // Either valid GOOGLE_APPLICATION_CREDENTIALS or fully valid FIREBASE_* env vars.
  const allGood = gappOk || (envVarsOk && keyOk);

  suggestActions(allGood);

  console.log(`\nOverall: ${allGood ? 'OK — credentials should work.' : 'BROKEN — fix items marked ✗ above.'}`);
  // Non-zero exit so CI/Make can chain this in front of bootstrap scripts.
  process.exit(allGood ? 0 : 1);
}

if (require.main === module) {
  main();
}

module.exports = {
  diagnoseEnvFilePresence,
  diagnoseGoogleAppCreds,
  diagnoseFirebaseEnvVars,
  diagnosePrivateKeyShape,
};
