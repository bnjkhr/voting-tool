const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { handlerAfter } = require('./source-slice');

const {
  BOT_CHECK_FAILED,
  HONEYPOT_FIELD,
  detectBotSignals,
  isEmailQuotaExceeded,
  requireHumanForm,
  turnstileConfig,
  verifyTurnstile,
} = require('../lib/bot-protection');

const rootDir = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(rootDir, file), 'utf8');
const apiSource = read('api/index.js');

const MINUTE = 60 * 1000;
const NOW = new Date('2026-09-15T12:00:00Z');
const ago = (ms) => new Date(NOW.getTime() - ms);

function fakeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function runMiddleware(middleware, body) {
  const req = { method: 'POST', path: '/api/test', headers: { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }, body };
  const res = fakeRes();
  let nextCalled = false;
  await middleware(req, res, () => { nextCalled = true; });
  return { res, nextCalled };
}

// ---------------------------------------------------------------------------
// Honeypot + Ausfüllzeit
// ---------------------------------------------------------------------------

test('detectBotSignals: ausgefülltes Honeypot-Feld wird abgewiesen', () => {
  assert.equal(detectBotSignals({ [HONEYPOT_FIELD]: 'http://spam', formElapsedMs: 9000 }, { minFillMs: 3000 }), 'honeypot');
});

test('detectBotSignals: zu schnelles oder fehlendes Timing wird abgewiesen', () => {
  assert.equal(detectBotSignals({ formElapsedMs: 200 }, { minFillMs: 3000 }), 'too_fast');
  assert.equal(detectBotSignals({}, { minFillMs: 3000 }), 'too_fast', 'direkter API-Aufruf ohne Formular');
  assert.equal(detectBotSignals({ formElapsedMs: 'abc' }, { minFillMs: 3000 }), 'too_fast');
});

test('detectBotSignals: Mensch mit leerem Honeypot kommt durch', () => {
  assert.equal(detectBotSignals({ [HONEYPOT_FIELD]: '', formElapsedMs: 4200 }, { minFillMs: 3000 }), null);
});

// ---------------------------------------------------------------------------
// Limit pro E-Mail-Adresse
// ---------------------------------------------------------------------------

test('isEmailQuotaExceeded: 3 Links in 15 Minuten sind das Maximum', () => {
  assert.equal(isEmailQuotaExceeded([ago(1 * MINUTE), ago(5 * MINUTE)], NOW), false);
  assert.equal(isEmailQuotaExceeded([ago(1 * MINUTE), ago(5 * MINUTE), ago(14 * MINUTE)], NOW), true);
});

test('isEmailQuotaExceeded: 10 Links in 24 Stunden sind das Maximum', () => {
  const spread = (n) => Array.from({ length: n }, (_, i) => ago((i + 1) * 60 * MINUTE));
  assert.equal(isEmailQuotaExceeded(spread(9), NOW), false);
  assert.equal(isEmailQuotaExceeded(spread(10), NOW), true);
});

test('isEmailQuotaExceeded: ältere Links als 24 Stunden zählen nicht', () => {
  const old = Array.from({ length: 20 }, (_, i) => ago(25 * 60 * MINUTE + i * MINUTE));
  assert.equal(isEmailQuotaExceeded(old, NOW), false);
});

// ---------------------------------------------------------------------------
// Turnstile
// ---------------------------------------------------------------------------

test('turnstileConfig: nur beide Schlüssel zusammen schalten Turnstile scharf', () => {
  assert.equal(turnstileConfig({}), null);
  assert.equal(turnstileConfig({ TURNSTILE_SECRET_KEY: 's' }), null);
  assert.equal(turnstileConfig({ TURNSTILE_SITE_KEY: 'k' }), null);
  assert.deepEqual(turnstileConfig({ TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET_KEY: 's' }), { siteKey: 'k', secretKey: 's' });
});

test('verifyTurnstile: schickt Secret, Token und IP an Cloudflare', async () => {
  let sent;
  const fetchImpl = async (url, options) => {
    sent = { url, form: new URLSearchParams(options.body) };
    return { json: async () => ({ success: true }) };
  };
  assert.equal(await verifyTurnstile('tok', '203.0.113.7', { secretKey: 'sec', fetchImpl }), null);
  assert.equal(sent.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(sent.form.get('secret'), 'sec');
  assert.equal(sent.form.get('response'), 'tok');
  assert.equal(sent.form.get('remoteip'), '203.0.113.7');
});

test('verifyTurnstile: fehlendes oder ungültiges Token wird abgewiesen', async () => {
  const fetchImpl = async () => ({ json: async () => ({ success: false }) });
  assert.equal(await verifyTurnstile('', null, { secretKey: 'sec', fetchImpl }), 'turnstile_missing');
  assert.equal(await verifyTurnstile('tok', null, { secretKey: 'sec', fetchImpl }), 'turnstile_failed');
});

test('verifyTurnstile: Cloudflare nicht erreichbar sperrt niemanden aus', async (t) => {
  t.mock.method(console, 'error', () => {});
  const fetchImpl = async () => { throw new Error('ECONNRESET'); };
  assert.equal(await verifyTurnstile('tok', null, { secretKey: 'sec', fetchImpl }), null);
});

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

test('requireHumanForm: Bot bekommt 400 und erreicht den Handler nie', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const middleware = requireHumanForm({ minFillMs: 3000, env: {} });
  const { res, nextCalled } = await runMiddleware(middleware, { [HONEYPOT_FIELD]: 'x', formElapsedMs: 5000 });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.deepEqual(res.body, BOT_CHECK_FAILED);
});

test('requireHumanForm: Mensch ohne Turnstile-Konfiguration kommt durch', async () => {
  const middleware = requireHumanForm({ minFillMs: 3000, env: {} });
  const { nextCalled } = await runMiddleware(middleware, { [HONEYPOT_FIELD]: '', formElapsedMs: 5000 });
  assert.equal(nextCalled, true);
});

test('requireHumanForm: mit Turnstile wird das Token geprüft, IP aus X-Forwarded-For', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const env = { TURNSTILE_SITE_KEY: 'k', TURNSTILE_SECRET_KEY: 's' };
  let remoteIp;
  const fetchImpl = async (url, options) => {
    const form = new URLSearchParams(options.body);
    remoteIp = form.get('remoteip');
    return { json: async () => ({ success: form.get('response') === 'good' }) };
  };
  const middleware = requireHumanForm({ minFillMs: 3000, env, fetchImpl });

  const rejected = await runMiddleware(middleware, { formElapsedMs: 5000, turnstileToken: 'bad' });
  assert.equal(rejected.nextCalled, false);
  assert.equal(rejected.res.statusCode, 400);

  const accepted = await runMiddleware(middleware, { formElapsedMs: 5000, turnstileToken: 'good' });
  assert.equal(accepted.nextCalled, true);
  assert.equal(remoteIp, '203.0.113.7');
});

// ---------------------------------------------------------------------------
// Verdrahtung in API und Frontend
// ---------------------------------------------------------------------------

test('Signup und Login-Link-Anforderung laufen durch den Bot-Schutz', () => {
  assert.match(apiSource, /app\.post\('\/api\/signup\/workspaces', [^\n]*requireHumanForm\(/);
  assert.match(apiSource, /app\.post\('\/api\/auth\/login-links', [^\n]*requireHumanForm\(/);
  assert.ok(apiSource.includes("app.get('/api/auth/bot-protection'"));
});

test('Beide Endpoints prüfen das E-Mail-Limit vor dem Mailversand', () => {
  for (const route of ["app.post('/api/signup/workspaces'", "app.post('/api/auth/login-links'"]) {
    const body = handlerAfter(apiSource, route);
    const quota = body.indexOf('await isLoginLinkQuotaExceeded(email)');
    assert.ok(quota > -1, `${route}: E-Mail-Limit fehlt`);
    assert.ok(quota < body.indexOf('persistLoginLink('), `${route}: Limit muss vor dem Link greifen`);
    assert.ok(quota < body.indexOf('sendLoginLinkEmail('), `${route}: Limit muss vor der Mail greifen`);
  }
});

test('E-Mail-Limit zählt über die DB, gestützt durch einen Index', () => {
  assert.ok(read('db/login-links.js').includes('async function listCreatedAtSince('));
  assert.ok(/on login_links \(email, created_at\)/.test(read('migrations/0009_login_links_email_index.sql')));
});

test('Formulare tragen Honeypot, Turnstile-Container und laden form-guard.js vor dem Seitenskript', () => {
  for (const [html, pageScript] of [['public/signup.html', 'signup.js'], ['public/login.html', 'login.js']]) {
    const source = read(html);
    assert.ok(source.includes(`name="${HONEYPOT_FIELD}"`), `${html}: Honeypot fehlt`);
    assert.ok(source.includes('tabindex="-1"'), `${html}: Honeypot darf nicht per Tab erreichbar sein`);
    assert.ok(source.includes('data-turnstile'), `${html}: Turnstile-Container fehlt`);
    const guard = source.indexOf('src="form-guard.js"');
    assert.ok(guard > -1 && guard < source.indexOf(`src="${pageScript}"`), `${html}: form-guard.js muss vorher laden`);
  }
  const guard = read('public/form-guard.js');
  ['website:', 'formElapsedMs:', 'turnstileToken:', "fetch('/api/auth/bot-protection')"]
    .forEach((snippet) => assert.ok(guard.includes(snippet), `form-guard.js: ${snippet} fehlt`));
  assert.ok(read('public/signup.js').includes('...this.guard.fields()'));
  assert.ok(read('public/login.js').includes('...this.guard.fields()'));
});

test('Datenschutzerklärung nennt Cloudflare Turnstile, das form-guard.js nachlädt', () => {
  assert.ok(read('public/form-guard.js').includes('challenges.cloudflare.com/turnstile'));
  const privacy = read('public/datenschutz.html');
  ['Cloudflare Turnstile', 'Cloudflare, Inc.', 'https://www.cloudflare.com/turnstile-privacy-policy/']
    .forEach((snippet) => assert.ok(privacy.includes(snippet), `datenschutz.html: ${snippet} fehlt`));
});

// ---------------------------------------------------------------------------
// Magic Link: Scanner dürfen den Link nicht verbrauchen
// ---------------------------------------------------------------------------

test('Login-Seite löst den Magic Link erst nach Klick ein, nicht beim Laden', () => {
  const script = read('public/login.js');
  const init = script.slice(script.indexOf('    init() {'), script.indexOf('    async requestLoginLink() {'));
  assert.ok(init.length > 0, 'init() nicht gefunden');
  assert.equal(init.includes('this.consumeLoginLink();'), false, 'kein automatisches Einlösen beim Laden');
  assert.ok(init.includes("this.consumeButton.addEventListener('click', () => this.consumeLoginLink())"));
  assert.ok(read('public/login.html').includes('id="consumeBtn"'));
  // Die API selbst löst nur per POST ein; ein GET auf den Link liefert nur die Seite.
  assert.ok(apiSource.includes("app.post('/api/auth/login-links/:token/consume'"));
  assert.equal(apiSource.includes("app.get('/api/auth/login-links/:token"), false);
});
