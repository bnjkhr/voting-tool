const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const rootDir = path.join(__dirname, '..');
const urlStatePath = path.join(rootDir, 'public', 'url-state.js');
const indexHtml = fs.readFileSync(path.join(rootDir, 'public', 'index.html'), 'utf8');
const publicScript = fs.readFileSync(path.join(rootDir, 'public', 'script.js'), 'utf8');

function loadUrlStateModule() {
    assert.ok(
        fs.existsSync(urlStatePath),
        'expected public/url-state.js to exist for direct url state handling'
    );

    delete require.cache[require.resolve(urlStatePath)];
    return require(urlStatePath);
}

test('direct url state helper exists', () => {
    assert.ok(fs.existsSync(urlStatePath));
});

test('parses path-based tenant board urls', () => {
    const { parseUrlState } = loadUrlStateModule();

    assert.deepEqual(parseUrlState('/', ''), {
        appId: null, tenantSlug: null, appSlug: null, view: 'suggestions', suggestionId: null,
    });

    assert.deepEqual(parseUrlState('/acme', ''), {
        appId: null, tenantSlug: 'acme', appSlug: null, view: 'suggestions', suggestionId: null,
    });

    assert.deepEqual(parseUrlState('/acme/feedback', ''), {
        appId: null, tenantSlug: 'acme', appSlug: 'feedback', view: 'suggestions', suggestionId: null,
    });

    assert.deepEqual(parseUrlState('/acme/feedback/roadmap', ''), {
        appId: null, tenantSlug: 'acme', appSlug: 'feedback', view: 'roadmap', suggestionId: null,
    });

    assert.deepEqual(parseUrlState('/acme/feedback/changelog', ''), {
        appId: null, tenantSlug: 'acme', appSlug: 'feedback', view: 'changelog', suggestionId: null,
    });

    assert.deepEqual(parseUrlState('/acme/feedback/t/1234', ''), {
        appId: null, tenantSlug: 'acme', appSlug: 'feedback', view: 'suggestions', suggestionId: '1234',
    });
});

test('builds canonical path-based urls from state', () => {
    const { buildUrlState } = loadUrlStateModule();

    assert.equal(buildUrlState({ tenantSlug: 'acme' }), '/acme');
    assert.equal(buildUrlState({ tenantSlug: 'acme', appSlug: 'feedback' }), '/acme/feedback');
    assert.equal(buildUrlState({ tenantSlug: 'acme', appSlug: 'feedback', view: 'suggestions' }), '/acme/feedback');
    assert.equal(buildUrlState({ tenantSlug: 'acme', appSlug: 'feedback', view: 'roadmap' }), '/acme/feedback/roadmap');
    assert.equal(buildUrlState({ tenantSlug: 'acme', appSlug: 'feedback', view: 'changelog' }), '/acme/feedback/changelog');
    assert.equal(buildUrlState({ tenantSlug: 'acme', appSlug: 'feedback', suggestionId: '1234' }), '/acme/feedback/t/1234');
    assert.equal(buildUrlState({}), '/');
});

test('parse and build round-trip for tenant board deep links', () => {
    const { parseUrlState, buildUrlState } = loadUrlStateModule();
    for (const url of ['/acme', '/acme/feedback', '/acme/feedback/roadmap', '/acme/feedback/t/1234']) {
        assert.equal(buildUrlState(parseUrlState(url, '')), url, `round-trip failed for ${url}`);
    }
});

test('back-compat: old query-param deep links still parse', () => {
    const { parseUrlState } = loadUrlStateModule();

    // Alter Tenant-Link
    assert.deepEqual(parseUrlState('/', '?tenant=acme&app=feedback&view=roadmap'), {
        appId: null, tenantSlug: 'acme', appSlug: 'feedback', view: 'roadmap', suggestionId: null,
    });

    // Alter Legacy-Link (Firestore-Doc-ID)
    assert.deepEqual(parseUrlState('/', '?appId=family123&view=roadmap'), {
        appId: 'family123', tenantSlug: null, appSlug: null, view: 'roadmap', suggestionId: null,
    });
});

test('legacy appId state builds root query url (unchanged legacy behaviour)', () => {
    const { buildUrlState } = loadUrlStateModule();
    assert.equal(buildUrlState({ appId: 'family123', view: 'changelog' }), '/?appId=family123&view=changelog');
    assert.equal(buildUrlState({ appId: 'family123', view: 'suggestions' }), '/?appId=family123');
});

test('public app loads url state helper before the main app script', () => {
    const urlStateScriptIndex = indexHtml.indexOf('src="url-state.js"');
    const mainScriptIndex = indexHtml.indexOf('src="script.js"');
    assert.notEqual(urlStateScriptIndex, -1);
    assert.notEqual(mainScriptIndex, -1);
    assert.ok(urlStateScriptIndex < mainScriptIndex);
});

test('public app syncs direct urls through the path and browser history', () => {
    assert.ok(publicScript.includes('UrlState.parseUrlState'));
    assert.ok(publicScript.includes('window.location.pathname'), 'expected script.js to read the path from the location');
    assert.ok(publicScript.includes('history.pushState'));
    assert.ok(publicScript.includes("window.addEventListener('popstate'"));
});

test('public app centralizes tenant-aware read endpoints', () => {
    assert.ok(publicScript.includes('/api/tenants/${encodeURIComponent(this.tenantSlug)}/apps'));
    assert.ok(publicScript.includes('buildSuggestionsUrl'));
    assert.ok(publicScript.includes('buildReleasesUrl'));
    assert.ok(publicScript.includes('buildCommentsUrl'));
    assert.ok(publicScript.includes('buildVoteUrl'));
});
