const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');

// votingtool.benkohler.de ist die Legacy-Domain. Seit der Landingpage auf "/"
// (#39) bekam sie dort Roadlight-Marketing statt der App-Auswahl. Geprüft gegen
// die echte Express-App, weil es um die Weiche in der Root-Route geht.
// Firebase-Setup wie in root-deep-links.test.js.
process.env.FIREBASE_PROJECT_ID = 'roadlight-legacy-root-host-test';
process.env.FIREBASE_CLIENT_EMAIL = 'test@roadlight-legacy-root-host-test.iam.gserviceaccount.com';
process.env.FIREBASE_PRIVATE_KEY = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

const app = require('../api/index.js');
const { isLegacyBoardHost } = require('../api/spa-fallback.js');

const publicDir = path.join(__dirname, '../public');
const LANDING = fs.readFileSync(path.join(publicDir, 'landing.html'), 'utf8');
const SHELL = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');

let server;
let port;

test.before(async () => {
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    port = server.address().port;
});

test.after(() => new Promise((resolve) => server.close(resolve)));

function get(urlPath, headers) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: urlPath, headers }, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => { body += chunk; });
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
        }).on('error', reject);
    });
}

test('Legacy-Domain bekommt auf "/" das Board, nicht die Landingpage', async () => {
    for (const host of ['votingtool.benkohler.de', 'VotingTool.Benkohler.de', 'votingtool.benkohler.de:443']) {
        const res = await get('/', { host });
        assert.equal(res.status, 200, host);
        assert.equal(res.body, SHELL, `Board-Shell erwartet für ${host}`);
    }
});

test('x-forwarded-host zählt vor dem Host-Header', async () => {
    const res = await get('/', { host: 'internal.vercel.app', 'x-forwarded-host': 'votingtool.benkohler.de' });
    assert.equal(res.body, SHELL);
});

test('Roadlight-Domains behalten die Landingpage', async () => {
    for (const host of ['roadlight.pro', 'www.roadlight.pro', 'app.roadlight.pro', 'votingtool.benkohler.de.evil.example']) {
        const res = await get('/', { host });
        assert.equal(res.body, LANDING, `Landingpage erwartet für ${host}`);
    }
});

test('Board-Shell kommt ohne ETag/Last-Modified, damit kein 304 alte Header konserviert', async () => {
    for (const [urlPath, host] of [['/', 'votingtool.benkohler.de'], ['/?appId=OMXhYVpea6zl36v1cuQs', 'roadlight.pro'], ['/acme/gymbo', 'roadlight.pro']]) {
        const res = await get(urlPath, { host });
        assert.equal(res.body, SHELL, urlPath);
        assert.equal(res.headers.etag, undefined, `${urlPath}: kein ETag`);
        assert.equal(res.headers['last-modified'], undefined, `${urlPath}: kein Last-Modified`);
        assert.equal(res.headers['x-frame-options'], undefined, `${urlPath}: kein X-Frame-Options`);
        // Auch eine Revalidierung mit altem ETag bekommt die volle Antwort.
        const revalidated = await get(urlPath, { host, 'if-none-match': 'W/"363c-1668f272800"' });
        assert.equal(revalidated.status, 200, `${urlPath}: kein 304`);
    }
});

test('LEGACY_BOARD_HOSTS ergänzt weitere Legacy-Domains', () => {
    const env = { LEGACY_BOARD_HOSTS: ' feedback.example.com , ' };
    assert.equal(isLegacyBoardHost({ host: 'feedback.example.com' }, env), true);
    assert.equal(isLegacyBoardHost({ host: 'votingtool.benkohler.de' }, env), true);
    assert.equal(isLegacyBoardHost({ host: 'roadlight.pro' }, env), false);
    assert.equal(isLegacyBoardHost({}, env), false);
});
