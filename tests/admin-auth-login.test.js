'use strict';

// Anmeldefenster der Konsole: Nach einer abgelehnten Sitzung darf die Seite nicht
// auf „Lade Einträge...“ stehen bleiben, und der E-Mail-Weg führt zurück zur Seite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/admin-auth.js'), 'utf8');

function element() {
    const children = new Map();
    const listeners = {};
    const attributes = {};
    return {
        value: '',
        textContent: '',
        innerHTML: '',
        classList: { add() {}, remove() {} },
        focus() {},
        setAttribute(name, value) { attributes[name] = value; },
        getAttribute(name) { return attributes[name]; },
        addEventListener(type, handler) { listeners[type] = handler; },
        emit(type) { listeners[type]({ preventDefault() {} }); },
        querySelector(selector) {
            if (!children.has(selector)) children.set(selector, element());
            return children.get(selector);
        },
    };
}

function load({ stored = {}, status = 200 } = {}) {
    const storage = new Map(Object.entries(stored));
    const state = { reloads: 0, requests: [] };
    const window = {
        location: {
            pathname: '/tenant-admin.html',
            search: '?tenant=intern',
            hash: '#board',
            reload() { state.reloads += 1; },
        },
    };
    vm.runInNewContext(source, {
        window,
        document: { createElement: element, body: { appendChild() {} } },
        localStorage: {
            getItem: (key) => storage.get(key) ?? null,
            setItem: (key, value) => storage.set(key, value),
            removeItem: (key) => storage.delete(key),
        },
        setTimeout: () => {},
        fetch: async (url) => { state.requests.push(url); return { status, ok: status < 400 }; },
    });
    const auth = window.adminAuth;
    const submit = (password) => {
        const form = auth.overlay.querySelector('.admin-auth-form');
        auth.overlay.querySelector('.admin-auth-password').value = password;
        form.emit('submit');
    };
    return { auth, state, storage, submit };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

test('abgelehnte Sitzung: nach der Anmeldung lädt die Seite neu', async () => {
    const { auth, state, storage, submit } = load({ stored: { userSessionToken: 'abgelaufen' }, status: 401 });

    await auth.authFetch('/api/auth/session');
    auth.authFetch('/api/admin/tenants/intern/suggestions');
    await settled();
    submit('geheim');

    assert.equal(storage.get('adminToken'), 'geheim');
    assert.equal(state.reloads, 1);
});

test('nach dem Abmelden führt eine neue Anmeldung ebenfalls zum Neuladen', () => {
    const { auth, state, submit } = load({ stored: { adminToken: 'x' } });

    auth.logout();
    submit('geheim');

    assert.equal(state.reloads, 1);
});

test('ohne vorherige Ablehnung laufen alle wartenden Anfragen weiter, ohne Neuladen', async () => {
    const { auth, state, submit } = load();
    const done = [];

    auth.authFetch('/a').then(() => done.push('/a'));
    auth.authFetch('/b').then(() => done.push('/b'));
    await settled();
    submit('geheim');
    await settled();

    assert.deepEqual(done.sort(), ['/a', '/b']);
    assert.equal(state.reloads, 0);
});

test('„Per E-Mail anmelden“ führt zurück auf dieselbe Seite samt Reiter', () => {
    const { auth } = load();

    auth.showLogin();

    assert.equal(
        auth.overlay.querySelector('.admin-auth-email').getAttribute('href'),
        `/login.html?redirect=${encodeURIComponent('/tenant-admin.html?tenant=intern#board')}`,
    );
});
