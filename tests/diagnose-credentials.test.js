const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const diagnoseSource = fs.readFileSync(
  path.join(rootDir, 'scripts/diagnose-firebase-credentials.js'),
  'utf8'
);
const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

test('package.json exposes the diagnose-credentials script', () => {
  assert.equal(
    packageJson.scripts['diagnose-credentials'],
    'node scripts/diagnose-firebase-credentials.js'
  );
});

test('diagnose script never logs the private key body', () => {
  // The whole point of this tool is that we can ship it and a user runs it
  // without leaking the secret. Make that an explicit invariant.
  assert.equal(
    diagnoseSource.includes('process.env.FIREBASE_PRIVATE_KEY)'),
    false,
    'diagnose must never console.log(process.env.FIREBASE_PRIVATE_KEY)'
  );
  assert.equal(
    /console\.log\([^)]*sanitized[^)]*\)/.test(diagnoseSource),
    false,
    'diagnose must never console.log the sanitized PEM contents'
  );
  assert.equal(
    /console\.log\([^)]*rawKey[^)]*\)/.test(diagnoseSource),
    false,
    'diagnose must never console.log the raw env value'
  );
  assert.equal(
    /console\.log\([^)]*bodyJoined[^)]*\)/.test(diagnoseSource),
    false,
    'diagnose must never console.log the base64 body'
  );
});

test('diagnose script uses crypto.createPrivateKey for the final verdict', () => {
  // Round-trip into Node crypto is the same primitive firebase-admin uses,
  // so structural shape passing but the actual key still being invalid would
  // be caught here.
  assert.ok(diagnoseSource.includes("require('crypto')"));
  assert.ok(diagnoseSource.includes('crypto.createPrivateKey'));
});

test('diagnose script delegates env loading to firebase-admin-utils', () => {
  // Do not duplicate the loader logic — reuse it so this tool ages with the
  // real loader.
  assert.ok(diagnoseSource.includes("require('./firebase-admin-utils')"));
  assert.ok(diagnoseSource.includes('loadDotEnvFileIfPresent'));
  assert.ok(diagnoseSource.includes('sanitizePrivateKey'));
});

test('diagnose script exits non-zero on failure so callers can chain it', () => {
  assert.ok(
    /process\.exit\(allGood\s*\?\s*0\s*:\s*1\)/.test(diagnoseSource),
    'must `process.exit(0/1)` so npm scripts/CI can use it as a precondition'
  );
});

// Functional check on the underlying logic: feed a real (throwaway) RSA key
// generated in-process to the sanitizer and crypto round-trip, mirroring what
// the diagnose script does internally. This protects sanitizePrivateKey
// against future regressions even when no .env exists.
test('sanitizePrivateKey + crypto round-trip works on a quoted, escaped PEM', () => {
  const { sanitizePrivateKey } = require('../scripts/firebase-admin-utils');

  // Generate a tiny throwaway RSA key in PKCS#8 PEM form.
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  // Simulate the messiest plausible .env shape: quoted, with literal \n
  // escapes — the same form Google's service-account JSON ships in.
  const envValue = `"${privateKey.replace(/\n/g, '\\n')}"`;
  const sanitized = sanitizePrivateKey(envValue);

  assert.ok(sanitized.startsWith('-----BEGIN PRIVATE KEY-----'));
  assert.ok(sanitized.includes('\n'), 'literal \\n must become real newlines');
  assert.equal(sanitized.includes('\\n'), false, 'no literal \\n should survive sanitization');

  // The definitive test: Node crypto must accept it.
  const parsed = crypto.createPrivateKey({ key: sanitized, format: 'pem' });
  assert.equal(parsed.asymmetricKeyType, 'rsa');
});
