const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
    buildBoardMeta,
    injectBoardMeta,
    requestOrigin,
} = require('../lib/og-meta.js');

const SHELL = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
const FM = { name: 'FamilyManager', slug: 'familymanager' };

test('Changelog-Link einer App: „Was ist neu“ mit App-Bild', () => {
    const meta = buildBoardMeta({
        app: FM,
        view: 'changelog',
        origin: 'https://votingtool.benkohler.de',
        url: '/?appId=OMXhYVpea6zl36v1cuQs&view=changelog',
    });
    assert.equal(meta.title, 'Was ist neu in FamilyManager');
    assert.match(meta.description, /^Alle Versionen von FamilyManager/);
    assert.equal(meta.image, 'https://votingtool.benkohler.de/og/familymanager.png');
    assert.equal(meta.url, 'https://votingtool.benkohler.de/?appId=OMXhYVpea6zl36v1cuQs&view=changelog');
});

test('Board-Link einer App: Wünsche und Fehler', () => {
    const meta = buildBoardMeta({ app: FM, origin: 'https://votingtool.benkohler.de' });
    assert.equal(meta.title, 'FamilyManager: Wünsche und Fehler');
    assert.match(meta.description, /^Schlag neue Funktionen vor/);
});

test('App ohne eigenes Bild und unbekannte App fallen auf das neutrale Bild', () => {
    const gymbo = buildBoardMeta({ app: { name: 'GymBo', slug: 'gymbo' }, origin: 'https://x.de' });
    assert.equal(gymbo.title, 'GymBo: Wünsche und Fehler');
    assert.equal(gymbo.image, 'https://x.de/og/default.png');

    const none = buildBoardMeta({ origin: 'https://x.de' });
    assert.equal(none.title, 'Feedback Board');
    assert.equal(none.image, 'https://x.de/og/default.png');

    // Slug darf keinen Pfad ins Dateisystem öffnen.
    const evil = buildBoardMeta({ app: { name: 'X', slug: '../index' } });
    assert.equal(evil.image, '/og/default.png');
});

test('jedes referenzierte Vorschaubild liegt in public/og', () => {
    for (const file of ['default.png', 'familymanager.png']) {
        assert.ok(fs.existsSync(path.join(__dirname, '../public/og', file)), file);
    }
});

test('Einspielung ersetzt den markierten Block und escaped Werte', () => {
    const html = injectBoardMeta(SHELL, buildBoardMeta({
        app: { name: 'A "B" <script>', slug: 'x' },
        view: 'changelog',
        origin: 'https://votingtool.benkohler.de',
        url: '/?appId=a&view=changelog&x="><script>',
    }));
    assert.match(html, /<title>Was ist neu in A &quot;B&quot; &lt;script&gt;<\/title>/);
    assert.match(html, /property="og:title" content="Was ist neu in A &quot;B&quot; &lt;script&gt;"/);
    assert.match(html, /og:url" content="https:\/\/votingtool\.benkohler\.de\/\?appId=a&amp;view=changelog&amp;x=&quot;&gt;&lt;script&gt;"/);
    assert.match(html, /name="twitter:card" content="summary_large_image"/);
    assert.equal((html.match(/<title>/g) || []).length, 1);
    assert.ok(!html.includes('<script>"'));
});

test('ohne Marker bleibt das HTML unverändert', () => {
    const html = '<html><head><title>x</title></head></html>';
    assert.equal(injectBoardMeta(html, buildBoardMeta()), html);
});

test('Origin nur aus gültigen Hosts', () => {
    assert.equal(requestOrigin({ host: 'votingtool.benkohler.de' }), 'https://votingtool.benkohler.de');
    assert.equal(requestOrigin({ host: 'internal.vercel.app', 'x-forwarded-host': 'Roadlight.pro' }), 'https://roadlight.pro');
    assert.equal(requestOrigin({ host: 'evil.de"><script>' }), '');
    assert.equal(requestOrigin({}), '');
});
