const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// End-to-End gegen die echte Express-App: der Bug lag nicht in einer Hilfsfunktion,
// sondern darin, WELCHE Datei die Root-Route ausliefert. Ein Test gegen den
// Helfer allein haette ihn nicht gefangen.
//
// api/index.js initialisiert beim Laden Firebase Admin und wirft ohne
// Credentials. Deshalb hier ein Wegwerf-Service-Account: admin.credential.cert
// validiert nur das PEM-Format und spricht mit niemandem, und die Root-Route
// beruehrt ohnehin keinen Datenspeicher. Der .env-Loader in api/index.js
// ueberschreibt gesetzte Variablen nicht — der Test laeuft damit lokal und in
// CI gegen dieselbe Konfiguration, statt still an vorhandene Credentials der
// Entwicklungsmaschine zu geraten.
process.env.FIREBASE_PROJECT_ID = 'roadlight-root-deep-links-test';
process.env.FIREBASE_CLIENT_EMAIL = 'test@roadlight-root-deep-links-test.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

const app = require('../api/index.js');

const publicDir = path.join(__dirname, '../public');
const LANDING = fs.readFileSync(path.join(publicDir, 'landing.html'), 'utf8');
const SHELL = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

let server;
let base;

test.before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

async function bodyOf(url) {
    const res = await fetch(base + url);
    assert.equal(res.status, 200, `expected 200 for ${url}`);
    return res.text();
}

test('legacy app deep links get the board shell, not the landing page', async () => {
    // Genau die Form, die in den ausgelieferten Builds von FamilyManager und
    // GymBo steckt (public/url-state.js: buildUrlState fuer appId).
    for (const url of [
        '/?appId=OMXhYVpea6zl36v1cuQs',
        '/?appId=rVDAahPXAtUrPF8CImio',
        '/?appId=OMXhYVpea6zl36v1cuQs&view=roadmap',
    ]) {
        assert.equal(await bodyOf(url), SHELL, `expected board shell for ${url}`);
    }
});

test('query based tenant deep links get the board shell', async () => {
    for (const url of ['/?tenant=acme', '/?tenant=acme&app=feedback', '/?tenant=acme&app=feedback&view=changelog']) {
        assert.equal(await bodyOf(url), SHELL, `expected board shell for ${url}`);
    }
});

test('the bare root stays the landing page', async () => {
    assert.equal(await bodyOf('/'), LANDING);
});

test('queries that name no board stay on the landing page', async () => {
    // "app" ohne tenant benennt kein Board, "view" erst recht nicht. Leere
    // Werte zaehlen nicht — sonst kaeme jeder ?appId=-Rest auf der Shell raus.
    for (const url of ['/?view=roadmap', '/?app=feedback', '/?appId=', '/?tenant=%20', '/?utm_source=newsletter']) {
        assert.equal(await bodyOf(url), LANDING, `expected landing page for ${url}`);
    }
});
