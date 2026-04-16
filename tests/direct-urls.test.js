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
    assert.ok(
        fs.existsSync(urlStatePath),
        'expected a dedicated helper for parsing and building direct url state'
    );
});

test('direct url state parses and builds app/view query parameters', () => {
    const { parseUrlState, buildUrlState } = loadUrlStateModule();

    assert.deepEqual(parseUrlState(''), {
        appId: null,
        view: 'suggestions',
    });

    assert.deepEqual(parseUrlState('?appId=family123&view=roadmap'), {
        appId: 'family123',
        view: 'roadmap',
    });

    assert.equal(
        buildUrlState({ appId: 'family123', view: 'changelog' }),
        '?appId=family123&view=changelog'
    );

    assert.equal(
        buildUrlState({ appId: 'family123', view: 'suggestions' }),
        '?appId=family123'
    );

    assert.equal(
        buildUrlState({ appId: null, view: 'suggestions' }),
        ''
    );
});

test('public app loads url state helper before the main app script', () => {
    const urlStateScriptIndex = indexHtml.indexOf('src="url-state.js"');
    const mainScriptIndex = indexHtml.indexOf('src="script.js"');

    assert.notEqual(urlStateScriptIndex, -1, 'expected index.html to load the direct url helper');
    assert.notEqual(mainScriptIndex, -1, 'expected index.html to load the main app script');
    assert.ok(
        urlStateScriptIndex < mainScriptIndex,
        'expected url-state.js to be loaded before script.js'
    );
});

test('public app syncs direct urls through query params and browser history', () => {
    assert.ok(
        publicScript.includes('UrlState.parseUrlState'),
        'expected script.js to read direct url state from the helper'
    );

    assert.ok(
        publicScript.includes('window.location.search'),
        'expected script.js to inspect query parameters from the current location'
    );

    assert.ok(
        publicScript.includes('history.pushState'),
        'expected script.js to write direct url changes into browser history'
    );

    assert.ok(
        publicScript.includes("window.addEventListener('popstate'"),
        'expected script.js to react to browser back/forward navigation'
    );
});
