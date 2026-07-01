const test = require('node:test');
const assert = require('node:assert/strict');
const { shouldServeAppShell } = require('../api/spa-fallback');

test('serves the board shell for path-based tenant board urls', () => {
    for (const p of ['/acme', '/acme/feedback', '/acme/feedback/roadmap', '/acme/feedback/changelog', '/acme/feedback/t/1234']) {
        assert.equal(shouldServeAppShell('GET', p), true, `expected shell for ${p}`);
    }
});

test('never hijacks the API (legacy consumers stay intact)', () => {
    for (const p of ['/api/apps', '/api/apps/family123/suggestions', '/api/tenants/acme/apps', '/api/v1/me', '/api']) {
        assert.equal(shouldServeAppShell('GET', p), false, `must not serve shell for ${p}`);
    }
});

test('does not hijack reserved pages or static assets', () => {
    for (const p of [
        '/admin', '/admin.html', '/login', '/signup', '/tenant-admin', '/super-admin',
        '/accept-invite', '/impressum', '/datenschutz', '/style.css', '/script.js',
        '/fonts/fonts.css', '/favicon.ico', '/acme/logo.png',
    ]) {
        assert.equal(shouldServeAppShell('GET', p), false, `must not serve shell for ${p}`);
    }
});

test('root is left to express.static (index.html)', () => {
    assert.equal(shouldServeAppShell('GET', '/'), false);
});

test('only canonical board shapes get the shell; unknown/deeper paths fall through to 404', () => {
    // Nicht-kanonische 3. Segmente
    assert.equal(shouldServeAppShell('GET', '/acme/feedback/xyz'), false);
    assert.equal(shouldServeAppShell('GET', '/acme/feedback/suggestions'), false);
    // Zu tief
    assert.equal(shouldServeAppShell('GET', '/acme/feedback/roadmap/extra'), false);
    assert.equal(shouldServeAppShell('GET', '/acme/feedback/t/1234/more'), false);
    // t-Marker an falscher Stelle
    assert.equal(shouldServeAppShell('GET', '/acme/feedback/x/1234'), false);
    // Kanonisch -> weiterhin Shell
    assert.equal(shouldServeAppShell('GET', '/acme/feedback/t/1234'), true);
});

test('only GET/HEAD are eligible', () => {
    assert.equal(shouldServeAppShell('POST', '/acme/feedback'), false);
    assert.equal(shouldServeAppShell('PUT', '/acme'), false);
    assert.equal(shouldServeAppShell('HEAD', '/acme/feedback/roadmap'), true);
});
