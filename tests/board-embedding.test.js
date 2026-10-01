const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

// Die Board-Shell wird in Apps eingebettet (iframe im „Vorschlag einreichen"-
// Dialog von familymanager.pro). Der globale X-Frame-Options: SAMEORIGIN hat
// das blockiert. Geprüft wird gegen die echte Express-App, weil es darauf
// ankommt, WELCHE Route welche Header mitschickt. Firebase-Setup wie in
// root-deep-links.test.js: Wegwerf-Service-Account, kein Datenzugriff.
process.env.FIREBASE_PROJECT_ID = 'roadlight-board-embedding-test';
process.env.FIREBASE_CLIENT_EMAIL = 'test@roadlight-board-embedding-test.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

const app = require('../api/index.js');
const { boardFrameAncestors } = require('../lib/frame-policy.js');

let server;
let base;

test.before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

function assertEmbeddable(response, label) {
    assert.equal(response.status, 200, label);
    assert.equal(response.headers.get('x-frame-options'), null, `${label}: X-Frame-Options muss weg sein`);
    const csp = response.headers.get('content-security-policy') || '';
    assert.match(csp, /frame-ancestors 'self' .*https:\/\/familymanager\.pro/, `${label}: frame-ancestors fehlt`);
}

test('Legacy-Deep-Link /?appId=… ist von familymanager.pro einbettbar', async () => {
    assertEmbeddable(await fetch(`${base}/?appId=OMXhYVpea6zl36v1cuQs`), '/?appId');
});

test('/index.html und Tenant-Board-Pfad sind einbettbar', async () => {
    assertEmbeddable(await fetch(`${base}/index.html`), '/index.html');
    assertEmbeddable(await fetch(`${base}/acme/gymbo`), '/acme/gymbo');
});

test('Landingpage, Admin, Login und Signup bleiben gegen Einbettung geschützt', async () => {
    for (const pathname of ['/', '/admin.html', '/login.html', '/signup.html', '/tenant-admin.html']) {
        const response = await fetch(`${base}${pathname}`);
        assert.equal(response.headers.get('x-frame-options'), 'SAMEORIGIN', pathname);
        assert.equal(response.headers.get('content-security-policy'), null, pathname);
    }
});

test('BOARD_FRAME_ANCESTORS ergänzt Origins, ungültige Einträge fallen raus', () => {
    const origins = boardFrameAncestors({
        BOARD_FRAME_ANCESTORS: 'https://gymbo.app/, *, http://unsicher.de, https://x.de; script-src *, https://ok.example.com:8443',
    });
    assert.ok(origins.includes('https://familymanager.pro'));
    assert.ok(origins.includes('https://gymbo.app'));
    assert.ok(origins.includes('https://ok.example.com:8443'));
    assert.ok(!origins.some((origin) => origin === '*' || origin.startsWith('http:') || origin.includes(';')));
});
