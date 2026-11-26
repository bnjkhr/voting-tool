'use strict';

// Reiter „Board“: die echte Konsole in einem nachgebauten DOM, mit gefälschtem
// Server. Geprüft wird, was angezeigt und was an die API geschickt wird.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicDir = path.join(__dirname, '..', 'public');
const read = (file) => fs.readFileSync(path.join(publicDir, file), 'utf8');
const html = read('tenant-admin.html');

const MAIL_QUESTION = 'Dieser Wechsel kann eine E-Mail an die einreichende Person schicken. Trotzdem verschieben?';
const WIDE = '(min-width: 901px)';

function fakeClassList(initial = []) {
  const classes = new Set(initial);
  return {
    add: (name) => classes.add(name),
    remove: (name) => classes.delete(name),
    contains: (name) => classes.has(name),
    toggle(name, force = !classes.has(name)) {
      if (force) classes.add(name);
      else classes.delete(name);
      return force;
    },
  };
}

function fakeElement() {
  const listeners = {};
  return {
    listens: (type) => (listeners[type] || []).length,
    innerHTML: '',
    textContent: '',
    value: '',
    dataset: {},
    classList: fakeClassList(),
    // Für <dialog>.
    open: false,
    showModal() { this.open = true; },
    close() { this.open = false; },
    addEventListener(type, handler) { (listeners[type] ||= []).push(handler); },
    fire(type, event) { (listeners[type] || []).forEach((handler) => handler(event)); },
  };
}

// Ein Ereignisziel, das closest() für „.klasse“, „[attr]“ und „[attr="wert"]“ kennt.
function fakeTarget(attributes) {
  const node = {
    value: attributes.value || '',
    classList: fakeClassList((attributes.class || '').split(/\s+/).filter(Boolean)),
    dataset: Object.fromEntries(Object.entries(attributes)
      .filter(([name]) => name.startsWith('data-'))
      .map(([name, value]) => [
        name.slice(5).replace(/-(\w)/g, (_, letter) => letter.toUpperCase()),
        value,
      ])),
    closest(selector) {
      if (selector.startsWith('.')) return node.classList.contains(selector.slice(1)) ? node : null;
      const [, name, value] = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(selector);
      if (!(name in attributes)) return null;
      return value === undefined || attributes[name] === value ? node : null;
    },
  };
  return node;
}

function fakeEvent(target) {
  const data = {};
  const event = {
    target,
    prevented: false,
    preventDefault() { event.prevented = true; },
    dataTransfer: {
      setData(type, value) { data[type] = value; },
      getData: (type) => data[type] || '',
    },
  };
  return event;
}

function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Liest Tags samt Attributen so, wie der Browser Anführungszeichen auswertet.
function parseTags(markup) {
  return [...String(markup).matchAll(/<([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)]
    .map(([, tag, rest]) => ({
      tag: tag.toLowerCase(),
      attributes: Object.fromEntries(
        [...rest.matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)]
          .map(([, name, double, single, bare]) => [name, decodeEntities(double ?? single ?? bare ?? '')]),
      ),
    }));
}

// Elemente aus gerendertem Markup: genug für closest(), [open] und den Fokus.
function parseNodes(markup, container, dom) {
  const nodes = [];
  const stack = [];
  const tag = /<(\/?)([a-zA-Z][^\s/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  for (const match of String(markup).matchAll(tag)) {
    const [whole, closing, name, rest] = match;
    if (closing) {
      stack.pop();
      continue;
    }
    const [{ attributes }] = parseTags(`<${name}${rest}>`);
    const own = fakeTarget(attributes);
    const node = {
      tag: name.toLowerCase(),
      attributes,
      container,
      parent: stack.at(-1) || null,
      dataset: own.dataset,
      classList: own.classList,
      matchesSelf: (selector) => own.closest(selector) !== null,
      closest(selector) {
        for (let current = node; current; current = current.parent) {
          if (current.matchesSelf(selector)) return current;
        }
        return null;
      },
      focus() { if (!dom.isHidden(node) && !node.disabled) dom.active = node; },
      matches: () => false,
      scrollIntoView() {},
      disabled: 'disabled' in attributes,
      parentElement: stack.at(-1) || null,
      removeAttribute: (attribute) => { delete attributes[attribute]; },
    };
    if (node.tag === 'textarea') {
      const start = match.index + whole.length;
      // Wie im Browser fällt ein Zeilenumbruch direkt nach dem Start-Tag weg.
      node.value = decodeEntities(String(markup).slice(start, String(markup).indexOf('</textarea>', start))
        .replace(/^\n/, ''));
      node.selectionStart = 0;
      node.selectionEnd = 0;
      node.setSelectionRange = (from, to) => Object.assign(node, { selectionStart: from, selectionEnd: to });
    }
    nodes.push(node);
    stack.push(node);
  }
  return nodes;
}

function fakeContainer(id, dom) {
  const element = fakeElement();
  let html = '';
  let nodes = [];
  Object.defineProperty(element, 'innerHTML', {
    get: () => html,
    set(value) {
      // Wie im Browser: mit dem alten Inhalt geht auch der Fokus verloren.
      if (dom.active?.container === id) dom.active = null;
      html = value;
      nodes = parseNodes(value, id, dom);
    },
  });
  element.nodes = () => nodes;
  // Versteht zusammengesetzte Selektoren wie „.klasse[attr]“.
  element.querySelectorAll = (selector) => {
    const parts = selector.match(/\.[\w-]+|\[[^\]]+\]/g);
    return nodes.filter((node) => parts.every((part) => node.matchesSelf(part)));
  };
  return element;
}

const settle = async () => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

let nextNumber = 0;
function entry(id, fields = {}) {
  nextNumber += 1;
  return {
    id,
    appId: 'a1',
    app: { id: 'a1', name: 'Web' },
    type: 'ticket',
    status: 'offen',
    approved: true,
    priority: 'mittel',
    labels: [],
    title: `Titel ${id}`,
    description: `Beschreibung ${id}`,
    ticketNumber: `WEB-${String(nextNumber).padStart(3, '0')}`,
    userFingerprint: 'api:k1',
    ...fields,
  };
}

const APPS = [{ id: 'a1', name: 'Web', slug: 'web' }, { id: 'a2', name: 'iOS', slug: 'ios' }];

async function openConsole(suggestions, {
  role = 'owner', wide = true, confirmAnswer = true, apps = APPS, load = true, missing = [],
  feedback = { enabled: false, sources: [], links: [] }, signIn = false, hash = '', membership = { role },
  workspace = null, storage = {},
} = {}) {
  const server = {
    suggestions: structuredClone(suggestions), apps, failWith: null, hold: null,
    // Antworten auf die Liste zurückhalten, um sie in anderer Reihenfolge zu liefern.
    deferList: false, waiting: [], failList: null, removeOnWrite: false,
    // Verknüpfungen: Stand, Antwort des Holens und Fehler.
    feedback: structuredClone(feedback), failFeedback: false, fetchAnswer: null, failFetch: null,
    holdFetch: null, failLink: null, dropState: false,
    // Zurückschreiben: Antwort je Aktion, Anhalten, HTTP-Fehler, publicPush.
    pushAnswer: null, holdPush: null, failPush: null, publicPush: null,
    // Anlegen: Anhalten, Fehlerantwort und Netzfehler.
    holdCreate: null, failCreate: null, loseCreate: false,
  };
  const calls = { requests: [], confirm: [], hash: [] };

  const dom = { active: null };
  const elements = new Map();
  const containers = ['boardSwitcher', 'boardColumns'];
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, containers.includes(id) ? fakeContainer(id, dom) : fakeElement());
    }
    return elements.get(id);
  };
  const boardNodes = () => containers.flatMap((id) => element(id).nodes());
  const documentNode = fakeElement();

  const viewNodes = (pattern) => [...html.matchAll(pattern)].map((match) => {
    const node = fakeElement();
    node.dataset.view = match[1];
    return node;
  });
  const sections = viewNodes(/<section class="tenant-view[^"]*" data-view="(\w+)"/g);
  const tabs = viewNodes(/data-action="switch-view" data-view="(\w+)"/g);

  const media = new Map();
  const matchMedia = (query) => {
    if (!media.has(query)) {
      const node = fakeElement();
      media.set(query, {
        matches: query === WIDE ? wide : false,
        addEventListener: node.addEventListener,
        fire: node.fire,
      });
    }
    return media.get(query);
  };

  // Bildet nach, was das Stylesheet und geschlossene <details> ausblenden.
  dom.isHidden = (node) => {
    for (let child = node; child.parent; child = child.parent) {
      if (child.parent.tag === 'details' && !('open' in child.parent.attributes) && child.tag !== 'summary') return true;
    }
    if (node.container === 'boardSwitcher') return matchMedia(WIDE).matches;
    const column = node.closest('.board-column');
    return !matchMedia(WIDE).matches && column !== null && !column.matchesSelf('.is-current');
  };

  const respond = (payload, ok = true, status = ok ? 200 : 500) => ({ ok, status, json: async () => payload });
  // Die Einstellungen schreiben in die Felder des Formulars.
  element('workspaceSettingsForm').elements = new Proxy({}, {
    get: (fields, name) => (fields[name] ||= { value: '' }),
  });
  async function authFetch(url, options = {}) {
    const method = options.method || 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.requests.push({ method, url, body });
    const route = url.replace('/api/admin/tenants/acme', '');
    if (method === 'GET' && route === '/suggestions') {
      const answer = server.failList
        ? respond({ error: server.failList }, false)
        : respond(structuredClone(server.suggestions));
      if (server.deferList) await new Promise((resolve) => server.waiting.push(resolve));
      return answer;
    }
    if (method === 'GET' && route === '/apps') return respond(server.apps);
    if (method === 'GET' && route === '/settings') return respond({ tenant: { slug: 'acme', status: workspace } });
    if (method === 'POST' && route === '/suggestions') {
      if (server.holdCreate) await server.holdCreate;
      if (server.loseCreate) throw new TypeError('Failed to fetch');
      if (server.failCreate) return respond({ error: server.failCreate.error }, false, server.failCreate.status);
      const id = `neu${server.suggestions.length + 1}`;
      const ticketNumber = `WEB-9${String(server.suggestions.length + 1).padStart(2, '0')}`;
      server.suggestions.push({
        ...body, id, ticketNumber, type: 'ticket', approved: true, labels: [], userFingerprint: 'api:console',
        app: server.apps.find((app) => app.id === body.appId),
      });
      return respond({ id, ticketNumber }, true, 201);
    }
    if (url === '/api/auth/session') {
      return respond({ user: { email: 'a@example.test' }, memberships: [{ tenantSlug: 'acme', role }] });
    }
    if (method === 'GET' && route === '/feedback') {
      if (server.failFeedback) return respond({ error: 'Failed to load feedback links' }, false);
      return respond(structuredClone(server.feedback));
    }
    if (method === 'POST' && route === '/feedback/fetch') {
      if (server.holdFetch) await server.holdFetch;
      if (server.failFetch) return respond({ error: server.failFetch }, false);
      const answer = server.fetchAnswer?.(server) || { sources: [] };
      if (server.dropState) return respond(answer);
      return respond({ ...answer, state: structuredClone(server.feedback) });
    }
    const linkRoute = /^\/suggestions\/([^/]+)\/link$/.exec(route);
    if (linkRoute) {
      if (server.failLink) return respond({ error: server.failLink }, false);
      const suggestionId = decodeURIComponent(linkRoute[1]);
      const others = server.feedback.links.filter((item) => item.suggestionId !== suggestionId);
      server.feedback.links = method === 'PUT'
        ? [...others, { suggestionId, entryId: body.entryId, publicDeleted: false, publicSeenAt: null, url: null }]
        : others;
      return respond({ success: true });
    }
    const pushRoute = /^\/feedback\/links\/([^/]+)\/(publish|discard|test)$/.exec(route);
    if (method === 'POST' && pushRoute) {
      if (server.holdPush) await server.holdPush;
      if (server.failPush) return respond({ error: server.failPush }, false);
      const suggestionId = decodeURIComponent(pushRoute[1]);
      const answer = server.pushAnswer?.(server, suggestionId, pushRoute[2], body) || {};
      return respond({ ...answer, state: structuredClone(server.feedback) });
    }
    if (method === 'GET') return respond({});
    const status = /^\/suggestions\/([^/]+)\/status$/.exec(route);
    if (method === 'PUT' && status) {
      if (server.hold) await server.hold;
      if (server.failWith) return respond({ error: server.failWith }, false);
      const id = decodeURIComponent(status[1]);
      server.suggestions.find((item) => item.id === id).status = body.status;
      if (server.removeOnWrite) server.suggestions = server.suggestions.filter((item) => item.id !== id);
      return respond({ success: true, ...(server.publicPush ? { publicPush: server.publicPush(server, id) } : {}) });
    }
    throw new Error(`Unerwartete Anfrage: ${method} ${url}`);
  }

  const context = {
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams,
    setTimeout: (handler, delay) => { if (!delay) setImmediate(handler); },
    localStorage: {
      getItem: (key) => storage[key] ?? null,
      setItem: (key, value) => { storage[key] = String(value); },
    },
    history: { replaceState: (state, title, url) => calls.hash.push(url) },
    confirm: (message) => { calls.confirm.push(message); return confirmAnswer; },
    document: {
      get activeElement() { return dom.active; },
      addEventListener: documentNode.addEventListener,
      getElementById: (id) => (missing.includes(id) ? null : element(id)),
      querySelector: () => null,
      querySelectorAll: (selector) => {
        if (selector === '.tenant-view') return sections;
        if (selector.startsWith('#tenantTabs')) return tabs;
        if (selector === '.tenant-view[data-view="board"] [data-focus]') {
          return boardNodes().filter((node) => 'data-focus' in node.attributes);
        }
        return [];
      },
    },
  };
  context.window = {
    location: { search: '?tenant=acme', hash, pathname: '/tenant-admin.html', host: 'localhost', protocol: 'http:' },
    matchMedia,
    // Die Anmeldung bleibt offen: die Tests laden selbst, was sie brauchen.
    // Mit `signIn` läuft der echte Start samt Sitzung durch.
    adminAuth: { requireTenantAuth: () => (signIn ? Promise.resolve() : new Promise(() => {})), authFetch },
  };

  vm.createContext(context);
  vm.runInContext(read('board-model.js'), context);
  let startError = null;
  try {
    vm.runInContext(
      read('tenant-admin.js').replace('const tenantAdmin = new TenantAdminApp();', 'this.app = new TenantAdminApp();'),
      context,
    );
  } catch (error) {
    if (!missing.length) throw error;
    startError = error;
  }
  if (missing.length) return { element, startError };

  const { app } = context;
  if (signIn) {
    await settle();
  } else {
    app.currentRole = role;
    app.currentMembership = membership;
    app.sessionReady = true;
    if (load) {
      await app.loadApps();
      await app.loadSuggestions();
      if (workspace) await app.loadSettings();
    }
    calls.requests.length = 0;
  }

  const markup = (id) => element(id).innerHTML;
  const tags = () => parseTags(markup('boardColumns'));
  // Markup je Spalte.
  // Nur das Start-Tag zählt: die Menüknöpfe darin haben ebenfalls data-column.
  const columnMarkup = (key) => markup('boardColumns')
    .split(/(?=<section class="board-column[ "])/)
    .find((part) => new RegExp(`^<section [^>]*data-column="${key}"`).test(part)) || '';
  const cardsIn = (key) => parseTags(columnMarkup(key))
    .filter(({ attributes }) => 'data-board-card' in attributes)
    .map(({ attributes }) => attributes['data-board-card']);
  const cardMarkup = (id) => markup('boardColumns')
    .split(/(?=<article )/)
    .find((part) => part.includes(`data-board-card="${id}"`))
    .split('</article>')[0];
  const moveTargets = (id) => parseTags(cardMarkup(id))
    .filter(({ attributes }) => attributes['data-action'] === 'move-card')
    .map(({ attributes }) => attributes['data-column']);
  const writes = () => calls.requests.filter(({ method }) => method !== 'GET');

  const find = (id, predicate) => {
    const found = parseTags(markup(id)).find(({ attributes }) => predicate(attributes));
    assert.ok(found, `Element in #${id} nicht gefunden`);
    return fakeTarget(found.attributes);
  };
  const card = (id) => find('boardColumns', (attributes) => attributes['data-board-card'] === id);
  const column = (key) => find('boardColumns', (attributes) => attributes['data-column'] === key
    && /(^| )board-column( |$)/.test(attributes.class || ''));

  const node = (key) => {
    const found = boardNodes().find((candidate) => candidate.attributes['data-focus'] === key);
    assert.ok(found, `Kein Fokusziel ${key}`);
    return found;
  };
  const focused = () => dom.active?.attributes?.['data-focus'] ?? null;
  const cardDetails = (id) => element('boardColumns').querySelectorAll('.board-card-details')
    .find((details) => details.closest('[data-board-card]').dataset.boardCard === id);
  // Wie mit der Tastatur: Menü öffnen, Knopf fokussieren, auslösen.
  const pressMove = (id, to) => {
    const button = element('boardColumns').nodes().find(({ attributes }) => attributes['data-action'] === 'move-card'
      && attributes['data-id'] === id && attributes['data-column'] === to);
    button.parent.parent.attributes.open = '';
    button.focus();
    element('boardColumns').fire('click', fakeEvent(button));
  };

  return {
    app, server, calls, element, markup, tags, columnMarkup, cardsIn, cardMarkup, moveTargets, writes, find, card, column, sections, tabs, matchMedia,
    dom, documentNode, node, focused, cardDetails, pressMove,
  };
}

const statusPath = (id) => `/api/admin/tenants/acme/suggestions/${id}/status`;

// ---------------------------------------------------------------------------
// Aufbau
// ---------------------------------------------------------------------------

test('Reiter „Board“ steht zwischen „Einträge“ und „Releases“', () => {
  const tabs = [...html.matchAll(/data-action="switch-view" data-view="(\w+)">([^<]+)</g)]
    .map(([, view, label]) => [view, label]);

  assert.deepEqual(tabs.slice(0, 3), [['entries', 'Einträge'], ['board', 'Board'], ['releases', 'Releases']]);
});

test('board-model.js wird vor tenant-admin.js geladen', () => {
  assert.ok(html.indexOf('src="board-model.js"') > -1);
  assert.ok(html.indexOf('src="board-model.js"') < html.indexOf('src="tenant-admin.js"'));
});

test('switchView zeigt das Board', async () => {
  const board = await openConsole([]);

  board.app.switchView('board');

  const active = (nodes) => nodes.filter((node) => node.classList.contains('is-active')).map((node) => node.dataset.view);
  assert.deepEqual(active(board.sections), ['board']);
  assert.deepEqual(active(board.tabs), ['board']);
  assert.equal(board.calls.hash.at(-1), '#board');
});

test('Einträge stehen nach dem Laden in ihrer Spalte', async () => {
  const board = await openConsole([
    entry('o', { status: 'neu' }),
    entry('a', { status: 'in Bearbeitung' }),
    entry('t', { type: 'feature', status: 'im Test' }),
    entry('w', { type: 'bug', status: 'wartend' }),
    entry('f', { status: 'gelöst' }),
    entry('weg', { status: 'geschlossen' }),
  ]);

  assert.deepEqual(['offen', 'arbeit', 'test', 'wartet', 'fertig'].map(board.cardsIn), [['o'], ['a'], ['t'], ['w'], ['f']]);
  assert.equal(board.markup('boardColumns').includes('data-board-card="weg"'), false);
});

test('Solange die Einträge laden, bleibt der Ladehinweis stehen', async () => {
  const board = await openConsole([entry('a')], { load: false });
  board.element('boardColumns').innerHTML = 'Lade Einträge...';

  await board.app.loadApps();

  assert.equal(board.markup('boardColumns'), 'Lade Einträge...');
});

test('Boards, die nach den Einträgen laden, stehen trotzdem in der Auswahl', async () => {
  const board = await openConsole([entry('a')], { load: false });

  await board.app.loadSuggestions();
  await board.app.loadApps();

  assert.ok(board.markup('boardAppFilter').includes('value="a2"'));
});

test('Karte zeigt Titel, Nummer, Board, Labels und aufklappbare Beschreibung', async () => {
  const board = await openConsole([entry('a', { labels: ['Ben', 'Export'], ticketNumber: 'WEB-042' })]);
  const card = board.cardMarkup('a');

  for (const text of ['Titel a', 'WEB-042', 'Web', 'Ben', 'Export']) assert.ok(card.includes(text), text);
  const description = card.indexOf('Beschreibung a');
  assert.ok(card.indexOf('<details') < description && description < card.indexOf('</details>'));
  assert.ok(card.indexOf('<summary') < card.indexOf('Titel a'));
  assert.ok(card.indexOf('</summary>') < description);
});

for (const [priority, shown] of [['kritisch', true], ['hoch', true], ['mittel', false], ['niedrig', false]]) {
  test(`Karte zeigt Priorität ${priority}: ${shown ? 'ja' : 'nein'}`, async () => {
    const board = await openConsole([entry('a', { priority })]);

    assert.equal(board.cardMarkup('a').includes(`>${priority}<`), shown);
  });
}

test('Leere Spalte sagt das, die Zähler stehen in Kopf und Umschalter', async () => {
  const board = await openConsole([entry('a'), entry('b')]);

  assert.ok(board.columnMarkup('test').includes('Keine Einträge.'));
  assert.match(board.columnMarkup('offen'), /Offen<\/span>\s*<span class="board-column-count">2</);
  assert.match(board.markup('boardSwitcher'), /Offen<\/span>\s*<strong>2</);
});

test('„Fertig“ sagt, wenn nur die letzten 20 zu sehen sind', async () => {
  const done = (count) => Array.from({ length: count }, (_, i) => entry(`f${i}`, { status: 'gelöst' }));
  const many = await openConsole(done(23));
  const few = await openConsole(done(20));

  assert.equal(many.cardsIn('fertig').length, 20);
  assert.match(many.columnMarkup('fertig'), /board-column-count">23</);
  assert.ok(many.columnMarkup('fertig').includes('Zu sehen sind die letzten 20.'));
  assert.equal(few.columnMarkup('fertig').includes('Zu sehen sind'), false);
});

// ---------------------------------------------------------------------------
// Farben
// ---------------------------------------------------------------------------

// Plan 26.11.2026: Grund und Schrift je Farbplatz.
const PALETTE = [
  ['#E0F1E6', '#1F6B3B'], ['#EEE5FA', '#5E35A8'], ['#FAE3F0', '#99246A'], ['#EDF0D8', '#55631A'],
  ['#E2ECFA', '#1D55A0'], ['#DCF1F2', '#0E6068'], ['#F2E8DD', '#7A4A1E'], ['#E6E9EE', '#3E4C63'],
];
const DATED_APPS = [
  { id: 'a2', name: 'iOS', slug: 'ios', createdAt: '2026-02-01T00:00:00.000Z' },
  { id: 'a1', name: 'Web', slug: 'web', createdAt: '2026-01-01T00:00:00.000Z' },
];
const badge = (board, id, text) => parseTags(`${board.cardMarkup(id).split(`>${text}</span>`)[0]}>`).at(-1).attributes.class;

test('Board-Tag hat die Farbe seines Boards, Nummer und Labels bleiben neutral', async () => {
  const board = await openConsole([
    entry('a', { ticketNumber: 'WEB-042', labels: ['Export'] }),
    entry('b', { appId: 'a2', app: DATED_APPS[0] }),
  ], { apps: DATED_APPS });

  assert.equal(badge(board, 'a', 'Web'), 'tenant-badge board-tag board-tag-0');
  assert.equal(badge(board, 'b', 'iOS'), 'tenant-badge board-tag board-tag-1');
  assert.equal(badge(board, 'a', 'WEB-042'), 'tenant-badge');
  assert.equal(badge(board, 'a', 'Export'), 'tenant-badge');
});

test('Filter ändern die Farbe eines Boards nicht', async () => {
  const board = await openConsole([
    entry('a', { appId: 'a2', app: DATED_APPS[0], labels: ['Export'] }),
  ], { apps: DATED_APPS });

  board.element('boardLabelFilter').fire('change', fakeEvent({ value: 'Export' }));

  assert.equal(badge(board, 'a', 'iOS'), 'tenant-badge board-tag board-tag-1');
});

test('Ein Label mit dem Namen eines Boards bekommt keine Farbe', async () => {
  const board = await openConsole([entry('a', { labels: ['iOS'] })], { apps: DATED_APPS });

  assert.equal(badge(board, 'a', 'iOS'), 'tenant-badge');
});

test('Eintrag ohne bekanntes Board zeigt ein neutrales Tag', async () => {
  const board = await openConsole([entry('a', { appId: 'weg', app: { name: 'Unknown App' } })], { apps: DATED_APPS });

  assert.equal(badge(board, 'a', 'Unknown App'), 'tenant-badge');
});

function contrast(first, second) {
  const luminance = (hex) => [0, 2, 4]
    .map((at) => parseInt(hex.replace('#', '').slice(at, at + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test('Das Stylesheet kennt alle acht Farbplätze aus dem Plan, lesbar', () => {
  PALETTE.forEach(([background, text], slot) => {
    assert.match(html, new RegExp(`\\.board-tag-${slot} \\{ --tag-bg: ${background}; --tag-text: ${text}; \\}`));
    assert.ok(contrast(background, text) >= 4.5, `Platz ${slot}`);
  });
  assert.equal(html.includes('.board-tag-8'), false);
});

test('„kritisch“ ist rot mit weißer Schrift', () => {
  const [, rule] = /\.board-card \.board-priority-kritisch \{([^}]*)\}/.exec(html);

  assert.match(rule, /border-color: #BF2F2F;/);
  assert.match(rule, /background: #BF2F2F;/);
  assert.match(rule, /color: #FFFFFF;/);
  assert.ok(contrast('#BF2F2F', '#FFFFFF') >= 4.5);
});

// ---------------------------------------------------------------------------
// Freigabe und Maskierung
// ---------------------------------------------------------------------------

test('Nicht freigegebener Eintrag fehlt, der Hinweis nennt die Anzahl', async () => {
  const board = await openConsole([
    entry('frei'),
    entry('neu1', { approved: false, status: 'neu', title: 'Noch geheim' }),
    entry('neu2', { approved: false, status: 'neu' }),
  ]);

  assert.deepEqual(board.cardsIn('offen'), ['frei']);
  assert.equal(board.markup('boardColumns').includes('Noch geheim'), false);
  assert.equal(
    board.element('boardPending').textContent,
    '2 Einträge warten auf Freigabe. Du findest sie unter Einträge.',
  );
  assert.equal(board.element('boardPending').classList.contains('is-hidden'), false);
});

test('Hinweis in der Einzahl', async () => {
  const board = await openConsole([entry('neu', { approved: false, status: 'neu' })]);

  assert.equal(board.element('boardPending').textContent, '1 Eintrag wartet auf Freigabe. Du findest ihn unter Einträge.');
});

test('Ohne wartende Einträge kein Hinweis', async () => {
  const board = await openConsole([entry('frei')]);

  assert.equal(board.element('boardPending').classList.contains('is-hidden'), true);
});

test('HTML aus Einträgen und Boards wird als Text gezeigt', async () => {
  const title = '<img src=x onerror=alert(1)>';
  const attack = (n) => `"><img src=x onerror=alert(${n})>' onfocus="x`;
  const hostileApp = { id: attack(2), name: attack(3), slug: 'x' };
  const board = await openConsole([entry(attack(4), {
    appId: hostileApp.id,
    app: hostileApp,
    title,
    description: attack(5),
    ticketNumber: attack(6),
    labels: [attack(7)],
    priority: 'hoch',
  })], { apps: [hostileApp] });

  const rendered = ['boardColumns', 'boardSwitcher', 'boardAppFilter', 'boardLabelFilter'].map(board.markup).join('');
  assert.ok(board.markup('boardColumns').includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.equal(rendered.includes('<img'), false);
  for (const { tag, attributes } of parseTags(rendered)) {
    assert.notEqual(tag, 'img');
    assert.deepEqual(Object.keys(attributes).filter((name) => name.startsWith('on')), [], tag);
  }
  // In Attributen kommt der Wert unverändert an.
  assert.ok(parseTags(board.markup('boardLabelFilter')).some(({ attributes }) => attributes.value === attack(7)));
  assert.ok(parseTags(board.markup('boardAppFilter')).some(({ attributes }) => attributes.value === attack(2)));
  assert.deepEqual(board.cardsIn('offen'), [attack(4)]);
});

// ---------------------------------------------------------------------------
// Verschieben
// ---------------------------------------------------------------------------

for (const [type, from, to, status] of [
  ['ticket', 'offen', 'arbeit', 'in Bearbeitung'],
  ['bug', 'in Bearbeitung', 'offen', 'offen'],
  ['ticket', 'offen', 'wartet', 'wartend'],
  ['ticket', 'im Test', 'fertig', 'gelöst'],
  ['feature', 'wird geprüft', 'arbeit', 'wird umgesetzt'],
  ['feature', 'wird umgesetzt', 'offen', 'wird geprüft'],
  ['feature', 'wird umgesetzt', 'test', 'im Test'],
  ['feature', 'im Test', 'fertig', 'ist umgesetzt'],
]) {
  test(`moveCard: ${type} nach ${to} schickt „${status}“`, async () => {
    const board = await openConsole([entry('a', { type, status: from })]);

    await board.app.moveCard('a', to);

    assert.deepEqual(board.writes(), [{ method: 'PUT', url: statusPath('a'), body: { status } }]);
    assert.deepEqual(board.cardsIn(to), ['a']);
  });
}

for (const [label, fields, target] of [
  ['Feature nach „Wartet“', { type: 'feature', status: 'wird geprüft' }, 'wartet'],
  ['gleiche Spalte', { status: 'in Bearbeitung' }, 'arbeit'],
  ['gleiche Spalte trotz anderem Status', { status: 'neu' }, 'offen'],
  ['unbekannte Spalte', {}, 'gibtsnicht'],
  ['nicht freigegebener Eintrag', { approved: false, status: 'neu' }, 'arbeit'],
  ['geschlossener Eintrag', { status: 'geschlossen' }, 'arbeit'],
]) {
  test(`moveCard: ${label} schickt nichts und fragt nicht`, async () => {
    const board = await openConsole([entry('a', { userFingerprint: '1.2.3.4_abc', ...fields })]);

    await board.app.moveCard('a', target);

    assert.deepEqual(board.calls.requests, []);
    assert.deepEqual(board.calls.confirm, []);
  });
}

test('moveCard: unbekannte Karte schickt nichts', async () => {
  const board = await openConsole([entry('a')]);

  await board.app.moveCard('fremd', 'arbeit');

  assert.deepEqual(board.calls.requests, []);
});

for (const [label, fields] of [
  ['Eintrag von außen', { userFingerprint: '1.2.3.4_abc' }],
  ['Eintrag mit Benachrichtigung', { notificationEnabled: true }],
]) {
  test(`moveCard: ${label}, Rückfrage abgelehnt, schickt nichts`, async () => {
    const board = await openConsole([entry('a', fields)], { confirmAnswer: false });
    board.element('boardColumns').innerHTML = 'veraltet';

    await board.app.moveCard('a', 'arbeit');

    assert.deepEqual(board.calls.confirm, [MAIL_QUESTION]);
    assert.deepEqual(board.calls.requests, []);
    // Auch nach dem Abbruch wird neu gezeichnet.
    assert.deepEqual(board.cardsIn('offen'), ['a']);
  });

  test(`moveCard: ${label}, Rückfrage bestätigt, verschiebt`, async () => {
    const board = await openConsole([entry('a', fields)]);

    await board.app.moveCard('a', 'arbeit');

    assert.deepEqual(board.calls.confirm, [MAIL_QUESTION]);
    assert.equal(board.writes().length, 1);
    assert.deepEqual(board.cardsIn('arbeit'), ['a']);
  });
}

test('moveCard: per API angelegter Eintrag fragt nicht', async () => {
  const board = await openConsole([entry('a')]);

  await board.app.moveCard('a', 'arbeit');

  assert.deepEqual(board.calls.confirm, []);
  assert.equal(board.writes().length, 1);
});

test('moveCard: bei Fehlerantwort bleibt die Karte in der alten Spalte mit Meldung', async () => {
  const board = await openConsole([entry('a')]);
  board.server.failWith = 'Datenbank nicht erreichbar';

  await board.app.moveCard('a', 'arbeit');

  assert.equal(board.writes().length, 1);
  assert.deepEqual(board.cardsIn('offen'), ['a']);
  assert.deepEqual(board.cardsIn('arbeit'), []);
  assert.equal(board.element('toast').textContent, 'Datenbank nicht erreichbar');
  assert.ok(board.element('toast').classList.contains('show'));
});

test('moveCard: dieselbe Karte wird nicht doppelt gespeichert', async () => {
  const board = await openConsole([entry('a')]);
  let release;
  board.server.hold = new Promise((resolve) => { release = resolve; });

  const first = board.app.moveCard('a', 'arbeit');
  const second = board.app.moveCard('a', 'test');
  release();
  await Promise.all([first, second]);

  assert.deepEqual(board.writes().map(({ body }) => body.status), ['in Bearbeitung']);

  board.server.hold = null;
  await board.app.moveCard('a', 'test');
  assert.equal(board.writes().length, 2);
});

// ---------------------------------------------------------------------------
// Menü, Ziehen, Rollen
// ---------------------------------------------------------------------------

test('Menü bietet nur erlaubte Spalten außer der aktuellen', async () => {
  const board = await openConsole([
    entry('t', { status: 'in Bearbeitung' }),
    entry('f', { type: 'feature', status: 'neu' }),
  ]);

  assert.ok(board.cardMarkup('t').includes('Verschieben nach'));
  assert.deepEqual(board.moveTargets('t'), ['offen', 'test', 'wartet', 'fertig']);
  assert.deepEqual(board.moveTargets('f'), ['arbeit', 'test', 'fertig']);
});

test('Klick im Menü verschiebt die Karte', async () => {
  const board = await openConsole([entry('a')]);

  board.element('boardColumns').fire('click', fakeEvent(board.find('boardColumns',
    (attributes) => attributes['data-action'] === 'move-card' && attributes['data-column'] === 'test')));
  await settle();

  assert.deepEqual(board.writes(), [{ method: 'PUT', url: statusPath('a'), body: { status: 'im Test' } }]);
});

function drag(board, id, to) {
  const start = fakeEvent(board.card(id));
  const over = fakeEvent(board.column(to));
  const drop = fakeEvent(over.target);
  drop.dataTransfer = start.dataTransfer;
  const columns = board.element('boardColumns');
  columns.fire('dragstart', start);
  columns.fire('dragover', over);
  const highlighted = over.target.classList.contains('is-drop-target');
  columns.fire('drop', drop);
  const end = fakeEvent(start.target);
  columns.fire('dragend', end);
  board.documentNode.fire('dragend', end);
  return { start, over, drop, highlighted };
}

test('Ziehen und Ablegen verschiebt die Karte', async () => {
  const board = await openConsole([entry('a')]);
  assert.equal(board.card('a').closest('[draggable="true"]') !== null, true);

  const events = drag(board, 'a', 'wartet');
  await settle();

  assert.equal(events.over.prevented, true);
  assert.equal(events.drop.prevented, true);
  assert.equal(events.highlighted, true);
  assert.equal(events.over.target.classList.contains('is-drop-target'), false);
  assert.deepEqual(board.writes().map(({ body }) => body.status), ['wartend']);
});

test('Feature lässt sich nicht auf „Wartet“ ablegen', async () => {
  const board = await openConsole([entry('a', { type: 'feature', status: 'neu' })]);

  const events = drag(board, 'a', 'wartet');
  await settle();

  assert.equal(events.over.prevented, false);
  assert.equal(events.highlighted, false);
  assert.deepEqual(board.calls.requests, []);
});

test('Fremdes Ziehgut wird nicht angenommen', async () => {
  const board = await openConsole([entry('a')]);
  const columns = board.element('boardColumns');
  const over = fakeEvent(board.column('arbeit'));
  const drop = fakeEvent(over.target);
  drop.dataTransfer.setData('text/plain', 'a');

  columns.fire('dragover', over);
  columns.fire('drop', drop);
  await settle();

  assert.equal(over.prevented, false);
  assert.deepEqual(board.calls.requests, []);
});

test('Bis 900 px sind Karten nicht ziehbar, ab 901 px schon', async () => {
  const board = await openConsole([entry('a')], { wide: false });
  assert.equal(board.markup('boardColumns').includes('draggable'), false);
  assert.ok(board.moveTargets('a').length > 0);

  const query = board.matchMedia(WIDE);
  query.matches = true;
  query.fire('change', {});

  assert.ok(board.cardMarkup('a').includes('draggable="true"'));
});

test('viewer bekommt kein Menü und kann nicht ziehen oder verschieben', async () => {
  const board = await openConsole([entry('a')], { role: 'viewer' });

  assert.deepEqual(board.cardsIn('offen'), ['a']);
  assert.equal(board.markup('boardColumns').includes('Verschieben nach'), false);
  assert.equal(board.markup('boardColumns').includes('move-card'), false);
  assert.equal(board.markup('boardColumns').includes('draggable'), false);

  await board.app.moveCard('a', 'arbeit');
  assert.deepEqual(board.calls.requests, []);
});

for (const role of ['owner', 'admin']) {
  test(`${role} bekommt das Menü`, async () => {
    const board = await openConsole([entry('a')], { role });

    assert.ok(board.cardMarkup('a').includes('Verschieben nach'));
  });
}

// ---------------------------------------------------------------------------
// Umschalter und Filter
// ---------------------------------------------------------------------------

const currentColumns = (board) => board.tags()
  .filter(({ attributes }) => /(^| )is-current( |$)/.test(attributes.class || ''))
  .map(({ attributes }) => attributes['data-column']);

test('Umschalter startet bei „In Arbeit“ und wechselt die Spalte', async () => {
  const board = await openConsole([entry('a')], { wide: false });
  assert.deepEqual(currentColumns(board), ['arbeit']);
  assert.match(board.markup('boardSwitcher'), /aria-pressed="true"[^>]*>\s*<span>In Arbeit</);

  board.element('boardSwitcher').fire('click', fakeEvent(board.find('boardSwitcher',
    (attributes) => attributes['data-column'] === 'wartet')));

  assert.deepEqual(currentColumns(board), ['wartet']);
  assert.match(board.markup('boardSwitcher'), /aria-pressed="true"[^>]*>\s*<span>Wartet</);
  assert.deepEqual(board.calls.requests, []);
});

const choose = (board, id, value) => {
  board.element(id).value = value;
  board.element(id).fire('change', fakeEvent(board.element(id)));
};

test('Filter nach Board und Label', async () => {
  const board = await openConsole([
    entry('web-ben', { labels: ['Ben'] }),
    entry('web'),
    entry('ios-ben', { appId: 'a2', app: { id: 'a2', name: 'iOS' }, labels: ['Ben'] }),
    entry('ios-neu', { appId: 'a2', approved: false, status: 'neu' }),
  ]);
  assert.match(board.markup('boardAppFilter'), /<option value="">Alle<\/option>/);
  assert.match(board.markup('boardLabelFilter'), /<option value="">alle<\/option>/);

  choose(board, 'boardLabelFilter', 'Ben');
  assert.deepEqual(board.cardsIn('offen'), ['web-ben', 'ios-ben']);
  assert.equal(board.element('boardPending').classList.contains('is-hidden'), true);

  choose(board, 'boardAppFilter', 'a1');
  assert.deepEqual(board.cardsIn('offen'), ['web-ben']);
  // Bei gewähltem Board steht dessen Name nicht auf jeder Karte.
  assert.equal(board.cardMarkup('web-ben').includes('>Web<'), false);
  assert.match(board.markup('boardAppFilter'), /value="a1" selected/);
  assert.match(board.markup('boardLabelFilter'), /value="Ben" selected/);

  choose(board, 'boardAppFilter', '');
  assert.ok(board.cardMarkup('web-ben').includes('>Web<'));
});

test('Verschwindet das gefilterte Label, zeigt das Board wieder alle', async () => {
  const board = await openConsole([entry('a', { labels: ['Alt'] }), entry('b')]);
  choose(board, 'boardLabelFilter', 'Alt');

  board.server.suggestions[0].labels = [];
  await board.app.loadSuggestions();

  assert.deepEqual(board.cardsIn('offen'), ['a', 'b']);
});

test('Wird das gefilterte Board gelöscht, zeigt das Board wieder alle', async () => {
  const board = await openConsole([entry('a'), entry('b', { appId: 'a2' })]);
  choose(board, 'boardAppFilter', 'a2');

  board.server.apps = [APPS[0]];
  await board.app.loadApps();

  assert.deepEqual(board.cardsIn('offen'), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// Stehen gebliebene Karten-id beim Ziehen
// ---------------------------------------------------------------------------

// Ziehgut von außen: kein dragstart auf dem Board, eigene Daten.
function dropForeign(board, to, text) {
  const over = fakeEvent(board.column(to));
  const drop = fakeEvent(over.target);
  if (text) drop.dataTransfer.setData('text/plain', text);
  board.element('boardColumns').fire('dragover', over);
  board.element('boardColumns').fire('drop', drop);
  board.documentNode.fire('drop', drop);
  return { over, drop };
}

for (const [what, text] of [['Text', 'Irgendein Text'], ['Datei', '']]) {
  test(`Neu gezeichnet während des Ziehens: ${what} von außen verschiebt die alte Karte nicht`, async () => {
    const board = await openConsole([entry('a')]);
    board.element('boardColumns').fire('dragstart', fakeEvent(board.card('a')));
    // Die gezogene Karte wird ersetzt, ihr dragend erreicht niemanden mehr.
    board.app.renderBoard();

    const { drop } = dropForeign(board, 'arbeit', text);
    await settle();

    assert.deepEqual(board.writes(), []);
    assert.deepEqual(board.calls.confirm, []);
    // Das Überfahren war angenommen: Der Browser darf das Abgelegte nicht öffnen.
    assert.equal(drop.prevented, true);
  });
}

test('Neu gezeichnet während des Ziehens: die eigene Karte lässt sich noch ablegen', async () => {
  const board = await openConsole([entry('a')]);
  const start = fakeEvent(board.card('a'));
  board.element('boardColumns').fire('dragstart', start);
  board.app.renderBoard();

  const drop = fakeEvent(board.column('arbeit'));
  drop.dataTransfer = start.dataTransfer;
  board.element('boardColumns').fire('drop', drop);
  await settle();

  assert.deepEqual(board.writes().map(({ body }) => body.status), ['in Bearbeitung']);
});

for (const type of ['dragend', 'drop']) {
  test(`${type} irgendwo im Dokument beendet das Ziehen`, async () => {
    const board = await openConsole([entry('a')]);
    board.element('boardColumns').fire('dragstart', fakeEvent(board.card('a')));

    board.documentNode.fire(type, fakeEvent(fakeTarget({})));
    const over = fakeEvent(board.column('arbeit'));
    board.element('boardColumns').fire('dragover', over);

    assert.equal(over.prevented, false);
  });
}

// ---------------------------------------------------------------------------
// Parallele Ladevorgänge
// ---------------------------------------------------------------------------

for (const order of [['newer', 'older'], ['older', 'newer']]) {
  test(`Zwei Ladevorgänge, Antworten ${order.join(' vor ')}: nur der neueste zählt`, async () => {
    const board = await openConsole([entry('a')]);
    board.server.deferList = true;
    const loads = {};
    board.server.suggestions[0].status = 'in Bearbeitung';
    loads.older = board.app.loadSuggestions();
    board.server.suggestions[0].status = 'im Test';
    loads.newer = board.app.loadSuggestions();
    await settle();
    const release = { older: board.server.waiting[0], newer: board.server.waiting[1] };

    release[order[0]]();
    await loads[order[0]];
    // Eine ältere Antwort wird auch dann nicht übernommen, wenn sie zuerst kommt.
    assert.deepEqual(board.cardsIn(order[0] === 'newer' ? 'test' : 'offen'), ['a']);

    release[order[1]]();
    await loads[order[1]];

    assert.deepEqual(board.cardsIn('test'), ['a']);
    assert.equal(board.app.suggestions[0].status, 'im Test');
    // Gilt auch für die Einträge-Ansicht samt Statusfilter.
    for (const id of ['suggestionsList', 'statusFilter']) {
      assert.ok(board.markup(id).includes('im Test'), id);
    }
    assert.equal(board.markup('statusFilter').includes('in Bearbeitung'), false);
  });
}

test('Zwei schnelle Verschiebungen: beide bleiben am Ziel, wenn die erste Antwort zuletzt kommt', async () => {
  const board = await openConsole([entry('a'), entry('b')]);
  board.server.deferList = true;

  const first = board.app.moveCard('a', 'arbeit');
  await settle();
  const second = board.app.moveCard('b', 'test');
  await settle();
  assert.equal(board.server.waiting.length, 2);
  board.server.waiting[1]();
  await second;
  board.server.waiting[0]();
  await first;

  assert.deepEqual(board.cardsIn('arbeit'), ['a']);
  assert.deepEqual(board.cardsIn('test'), ['b']);
});

test('Ein älterer fehlgeschlagener Ladevorgang meldet den Fehler weiterhin', async () => {
  const board = await openConsole([entry('a')]);
  board.server.deferList = true;
  board.server.failList = 'Liste nicht erreichbar';
  const older = board.app.loadSuggestions();
  board.server.failList = null;
  const newer = board.app.loadSuggestions();
  await settle();

  board.server.waiting[1]();
  await newer;
  board.server.waiting[0]();

  await assert.rejects(older, /Liste nicht erreichbar/);
});

// ---------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------

test('Fehlt ein Board-Element, hängen die übrigen Listener trotzdem', async () => {
  const board = await openConsole([], { missing: ['boardAppFilter'] });

  assert.ok(board.startError, 'der Fehler wird nicht verschluckt');
  for (const [id, type] of [
    ['suggestionsList', 'click'], ['suggestionsList', 'change'], ['teamMembersList', 'click'],
    ['teamInvitesList', 'click'], ['todoStack', 'click'], ['tenantTabs', 'click'],
  ]) {
    assert.equal(board.element(id).listens(type), 1, `${id} ${type}`);
  }
  assert.equal(board.element('filterPanel').open, true);
});

// ---------------------------------------------------------------------------
// Neuzeichnen: aufgeklappte Karten und Tastaturfokus
// ---------------------------------------------------------------------------

const isOpen = (board, id) => 'open' in board.cardDetails(id).attributes;

test('Aufgeklappte Karte bleibt nach dem Neuladen und Verschieben aufgeklappt', async () => {
  const board = await openConsole([entry('a'), entry('b')]);
  board.cardDetails('a').attributes.open = '';

  await board.app.loadSuggestions();
  assert.deepEqual([isOpen(board, 'a'), isOpen(board, 'b')], [true, false]);

  await board.app.moveCard('a', 'test');
  assert.deepEqual([isOpen(board, 'a'), isOpen(board, 'b')], [true, false]);
});

test('Zugeklappte Karte bleibt zugeklappt', async () => {
  const board = await openConsole([entry('a')]);
  board.cardDetails('a').attributes.open = '';
  await board.app.loadSuggestions();
  delete board.cardDetails('a').attributes.open;

  await board.app.loadSuggestions();

  assert.equal(isOpen(board, 'a'), false);
});

for (const key of ['card:a', 'menu:a']) {
  test(`Neuladen lässt den Fokus auf ${key}`, async () => {
    const board = await openConsole([entry('a'), entry('b')]);
    const before = board.node(key);
    before.focus();

    await board.app.loadSuggestions();

    assert.equal(board.focused(), key);
    assert.notEqual(board.dom.active, before);
  });
}

test('Der gewählte Umschalter behält den Fokus', async () => {
  const board = await openConsole([entry('a')], { wide: false });
  const button = board.node('switch:wartet');
  button.focus();

  board.element('boardSwitcher').fire('click', fakeEvent(button));

  assert.equal(board.focused(), 'switch:wartet');
  assert.notEqual(board.dom.active, button);
});

test('Nach dem Verschieben liegt der Fokus auf der verschobenen Karte', async () => {
  const board = await openConsole([entry('a'), entry('b')]);

  board.pressMove('a', 'test');
  await settle();

  assert.equal(board.focused(), 'card:a');
  assert.equal(board.dom.active.closest('.board-column').dataset.column, 'test');
});

test('Schmal: ist die Karte nicht mehr sichtbar, liegt der Fokus auf dem Umschalter der Zielspalte', async () => {
  const board = await openConsole([entry('a', { status: 'in Bearbeitung' })], { wide: false });

  board.pressMove('a', 'test');
  await settle();

  assert.equal(board.focused(), 'switch:test');
});

test('Breit: ist die Karte nicht mehr da, liegt der Fokus auf der Zielspalte', async () => {
  const board = await openConsole([entry('a')]);
  board.server.removeOnWrite = true;

  board.pressMove('a', 'test');
  await settle();

  assert.equal(board.focused(), 'column:test');
  assert.equal(board.dom.active.attributes.tabindex, '-1');
});

for (const wide of [true, false]) {
  const width = wide ? 'Breit' : 'Schmal';

  test(`${width}: nach Fehlerantwort liegt der Fokus auf der Karte in der alten Spalte`, async () => {
    const board = await openConsole([entry('a', { status: 'in Bearbeitung' })], { wide });
    board.server.failWith = 'Fehler';

    board.pressMove('a', 'test');
    await settle();

    assert.equal(board.focused(), 'card:a');
    assert.equal(board.dom.active.closest('.board-column').dataset.column, 'arbeit');
  });

  test(`${width}: nach abgelehnter Rückfrage liegt der Fokus auf der Karte`, async () => {
    const board = await openConsole(
      [entry('a', { status: 'in Bearbeitung', userFingerprint: '1.2.3.4_abc' })],
      { wide, confirmAnswer: false },
    );

    board.pressMove('a', 'test');
    await settle();

    assert.equal(board.focused(), 'card:a');
  });
}

async function moveSlowly(board, meanwhile) {
  let release;
  board.server.hold = new Promise((resolve) => { release = resolve; });
  board.pressMove('a', 'test');
  await settle();
  meanwhile();
  release();
  await settle();
}

test('Wer während des Speicherns weitergeht, behält seinen Fokus', async () => {
  const board = await openConsole([entry('a'), entry('b')]);

  await moveSlowly(board, () => board.node('card:b').focus());

  assert.equal(board.focused(), 'card:b');
});

test('Fokus außerhalb des Boards wird nicht zurückgeholt', async () => {
  const board = await openConsole([entry('a')]);
  const outside = { dataset: {} };

  await moveSlowly(board, () => { board.dom.active = outside; });

  assert.equal(board.dom.active, outside);
});

test('Ohne Fokus auf dem Board setzt das Verschieben keinen', async () => {
  const board = await openConsole([entry('a')]);

  await board.app.moveCard('a', 'test');

  assert.equal(board.dom.active, null);
});

// ---------------------------------------------------------------------------
// Verknüpfung mit öffentlichen Einträgen
// ---------------------------------------------------------------------------

const FEEDBACK_BASE = '/api/admin/tenants/acme';
const connected = (links = [], sources = [{}]) => ({
  enabled: true,
  sources: sources.map((source, index) => ({
    id: `q${index + 1}`, appId: 'a1', boardName: 'Web', sourceLabel: 'Altes Board', fetchEnabled: true,
    lastFetchedAt: '2026-11-26T10:00:00.000Z', unapprovedCount: 0, lastError: null, ...source,
  })),
  links,
});
const publicLink = (suggestionId, fields = {}) => ({
  suggestionId, entryId: 'e1', publicStatus: 'im Test', publicApproved: true, publicDeleted: false,
  publicSeenAt: '2026-11-26T10:00:00.000Z', url: 'https://example.test/board', ...fields,
});
const report = (result, fields = {}) => () => ({
  sources: [{ sourceId: 'q1', board: 'web', result, created: [], ...fields }],
});
const requested = (board) => board.calls.requests
  .filter(({ url }) => url.includes('/feedback') || url.endsWith('/link'))
  .map(({ method, url }) => `${method} ${url.replace(FEEDBACK_BASE, '')}`);
const resultText = (board) => board.element('feedbackResult').textContent;
const hidden = (board, id) => board.element(id).classList.contains('is-hidden');
const actions = (board, id) => parseTags(board.cardMarkup(id))
  .map(({ attributes }) => attributes['data-action'])
  .filter((action) => action === 'link-card' || action === 'unlink-card');

async function openBoard(suggestions, options, prepare = () => {}) {
  const board = await openConsole(suggestions, { feedback: connected(), ...options });
  prepare(board.server);
  board.app.switchView('board');
  await settle();
  return board;
}

const clickCard = async (board, action, id) => {
  const button = board.find('boardColumns', (attributes) => attributes['data-action'] === action
    && attributes['data-id'] === id);
  board.element('boardColumns').fire('click', fakeEvent(button));
  await settle();
};

test('Board öffnen lädt den Stand und holt dann', async () => {
  const board = await openBoard([entry('a')]);

  assert.deepEqual(requested(board), ['GET /feedback', 'POST /feedback/fetch']);
  assert.deepEqual(board.calls.requests.find(({ method }) => method === 'POST').body, {});
  assert.equal(hidden(board, 'boardFeedback'), false);
  assert.equal(hidden(board, 'feedbackFetchBtn'), false);
});

test('Den offenen Reiter noch einmal antippen holt nicht erneut, erneutes Öffnen schon', async () => {
  const board = await openBoard([entry('a')]);

  board.app.switchView('board');
  await settle();
  assert.equal(requested(board).length, 2);

  board.app.switchView('entries');
  board.app.switchView('board');
  await settle();
  assert.equal(requested(board).length, 4);
});

test('Direkt auf #board: geholt wird erst mit geladener Sitzung', async () => {
  const board = await openConsole([entry('a')], { feedback: connected(), signIn: true, hash: '#board' });

  assert.deepEqual(requested(board), ['GET /feedback', 'POST /feedback/fetch']);
});

test('Andere Reiter holen nicht', async () => {
  const board = await openConsole([entry('a')], { feedback: connected(), signIn: true });

  assert.deepEqual(requested(board), []);
});

test('viewer: kein Holen, kein „Verknüpfen“, aber der öffentliche Stand', async () => {
  const board = await openBoard([entry('a'), entry('b')], {
    role: 'viewer', feedback: connected([publicLink('a')]),
  });

  assert.deepEqual(requested(board), ['GET /feedback']);
  assert.equal(hidden(board, 'feedbackFetchBtn'), true);
  assert.deepEqual(actions(board, 'a'), []);
  assert.deepEqual(actions(board, 'b'), []);
  assert.ok(board.cardMarkup('a').includes('Öffentlich: im Test'));
});

test('Ohne Verknüpfungen (enabled false): kein Holen, kein Link, nichts zu sehen', async () => {
  const board = await openBoard([entry('a')], { feedback: { enabled: false, sources: [], links: [] } });

  assert.deepEqual(requested(board), ['GET /feedback']);
  assert.equal(hidden(board, 'boardFeedback'), true);
  assert.deepEqual(actions(board, 'a'), []);
  assert.equal(board.cardMarkup('a').includes('Öffentlich'), false);
});

test('Holen scheitert: Das Board zeigt die Karten und die Meldung', async () => {
  const board = await openBoard([entry('a')], {}, (server) => { server.failFetch = 'Failed to fetch feedback'; });

  assert.deepEqual(board.cardsIn('offen'), ['a']);
  assert.equal(resultText(board), 'Feedback ließ sich nicht holen.');
  assert.equal(hidden(board, 'feedbackResult'), false);
});

test('Stand lässt sich nicht laden: Karten bleiben, Meldung, kein Holen', async () => {
  const board = await openBoard([entry('a')], {}, (server) => { server.failFeedback = true; });

  assert.deepEqual(board.cardsIn('offen'), ['a']);
  assert.deepEqual(requested(board), ['GET /feedback']);
  assert.equal(resultText(board), 'Der öffentliche Stand ließ sich nicht laden.');
  assert.equal(hidden(board, 'boardFeedback'), false);
  assert.equal(hidden(board, 'feedbackFetchBtn'), true);
});

for (const [count, text] of [[1, '1 neues Ticket geholt.'], [2, '2 neue Tickets geholt.']]) {
  test(`Neue Tickets (${count}): Meldung, und das Board lädt neu`, async () => {
    const created = Array.from({ length: count }, (_, i) => ({ id: `n${i}` }));
    const board = await openBoard([entry('a')], {}, (server) => {
      server.fetchAnswer = (current) => {
        current.suggestions.push(...created.map(({ id }) => entry(id)));
        return report('fetched', { created })();
      };
    });

    assert.equal(resultText(board), text);
    assert.equal(board.cardsIn('offen').length, count + 1);
  });
}

for (const [why, answer, text] of [
  ['nichts Neues', report('fetched'), 'Keine neuen Tickets.'],
  ['ausgeschaltet', report('disabled'), 'Holen ist noch nicht eingeschaltet.'],
  ['Fehler', report('error', { error: 'x' }), 'Web ließ sich nicht holen.'],
  ['alter Fehler', report('throttled', { error: 'x' }), 'Web ließ sich nicht holen.'],
]) {
  test(`Holen, ${why}: „${text}“`, async () => {
    const board = await openBoard([entry('a')], {}, (server) => { server.fetchAnswer = answer; });

    assert.equal(resultText(board), text);
  });
}

test('Holen gebremst: nennt die Uhrzeit fünf Minuten nach dem letzten Holen', async () => {
  const board = await openBoard([entry('a')], {}, (server) => { server.fetchAnswer = report('throttled'); });
  const time = new Date('2026-11-26T10:05:00.000Z')
    .toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  assert.equal(resultText(board), `Gerade erst geholt. Wieder ab ${time}.`);
});

for (const [fields, text] of [
  [{ pending: 1 }, '1 Eintrag folgt beim nächsten Holen.'],
  [{ pending: 2 }, '2 Einträge folgen beim nächsten Holen.'],
  [{ pending: 3, created: [{ id: 'n' }] }, '1 neues Ticket geholt. 3 Einträge folgen beim nächsten Holen.'],
]) {
  test(`Holen mit Ausstehendem: „${text}“`, async () => {
    const board = await openBoard([entry('a')], {}, (server) => {
      server.fetchAnswer = report('fetched', fields);
    });

    assert.equal(resultText(board), text);
  });
}

for (const [why, created] of [['mit neuen Tickets', [{ id: 'n' }]], ['ohne neue Tickets', []]]) {
  test(`Holbericht ohne Stand (${why}): Das Board lädt neu und holt den Stand nach`, async () => {
    const board = await openBoard([entry('a')], { feedback: connected([publicLink('a')]) }, (server) => {
      server.dropState = true;
      server.fetchAnswer = (current) => {
        current.suggestions.push(entry('n'));
        current.feedback = connected([publicLink('a'), publicLink('n', { publicStatus: 'wartend' })]);
        return report('fetched', { created })();
      };
    });

    assert.deepEqual(board.cardsIn('offen').sort(), ['a', 'n']);
    assert.ok(board.cardMarkup('n').includes('Öffentlich: wartend'));
    assert.equal(resultText(board), created.length ? '1 neues Ticket geholt.' : 'Keine neuen Tickets.');
    assert.equal(hidden(board, 'boardFeedback'), false);
    assert.equal(hidden(board, 'feedbackFetchBtn'), false);
  });
}

test('Holbericht ohne Stand, Nachladen scheitert auch: Die Meldung bleibt, der alte Stand auch', async () => {
  const board = await openBoard([entry('a')], { feedback: connected([publicLink('a')]) }, (server) => {
    server.dropState = true;
    server.fetchAnswer = (current) => {
      current.failFeedback = true;
      return report('fetched')();
    };
  });

  assert.equal(resultText(board), 'Keine neuen Tickets.');
  assert.ok(board.cardMarkup('a').includes('Öffentlich: im Test'));
  assert.equal(hidden(board, 'feedbackFetchBtn'), false);
});

test('Eine Quelle holt, eine scheitert: beides steht da', async () => {
  const board = await openBoard([entry('a')], {
    feedback: connected([], [{}, { appId: 'a2', boardName: 'iOS' }]),
  }, (server) => {
    server.fetchAnswer = () => ({
      sources: [
        { sourceId: 'q1', board: 'web', result: 'fetched', created: [{ id: 'n' }] },
        { sourceId: 'q2', board: 'ios', result: 'error', created: [], error: 'x' },
      ],
    });
  });

  assert.equal(resultText(board), '1 neues Ticket geholt. iOS ließ sich nicht holen.');
});

test('Textlink „Feedback holen“ holt, aber nie doppelt gleichzeitig', async () => {
  const board = await openBoard([entry('a')]);
  let release;
  board.server.holdFetch = new Promise((resolve) => { release = resolve; });
  board.calls.requests.length = 0;

  board.element('feedbackFetchBtn').fire('click', {});
  board.element('feedbackFetchBtn').fire('click', {});
  await settle();
  assert.equal(board.element('feedbackFetchBtn').disabled, true);
  release();
  await settle();

  assert.deepEqual(requested(board), ['POST /feedback/fetch']);
  assert.equal(board.element('feedbackFetchBtn').disabled, false);
});

test('Über dem Board steht, wie viele öffentlich auf Freigabe warten', async () => {
  const board = await openBoard([entry('a')], {
    feedback: connected([], [{ unapprovedCount: 2 }, { appId: 'a2', boardName: 'iOS', unapprovedCount: 1 }]),
  });

  assert.equal(
    board.element('feedbackUnapproved').textContent,
    'Öffentlich warten 3 Einträge auf Freigabe: Web 2, iOS 1.'
  );
  assert.equal(hidden(board, 'feedbackUnapproved'), false);
});

test('Ohne wartende Einträge bleibt die Zeile weg', async () => {
  const board = await openBoard([entry('a')]);

  assert.equal(hidden(board, 'feedbackUnapproved'), true);
});

test('Karte zeigt den öffentlichen Status mit „ansehen“ in neuem Tab', async () => {
  const board = await openBoard([entry('a'), entry('b')], { feedback: connected([publicLink('a')]) });

  assert.ok(board.cardMarkup('a').includes('Öffentlich: im Test'));
  const [anchor] = parseTags(board.cardMarkup('a')).filter(({ tag }) => tag === 'a');
  assert.deepEqual(
    [anchor.attributes.href, anchor.attributes.target, anchor.attributes.rel, anchor.attributes.draggable],
    ['https://example.test/board', '_blank', 'noopener', 'false']
  );
  assert.equal(board.cardMarkup('b').includes('Öffentlich'), false);
});

test('Status von außen wird als Text gezeigt', async () => {
  const board = await openBoard([entry('a')], {
    feedback: connected([publicLink('a', {
      publicStatus: '<img src=x onerror=alert(1)>', url: 'https://example.test/"><img src=x>',
    })]),
  });

  assert.equal(board.tags().some(({ tag }) => tag === 'img'), false);
  assert.ok(board.cardMarkup('a').includes('&lt;img src=x onerror=alert(1)&gt;'));
});

test('Eine javascript:-Adresse ergibt keinen Link', async () => {
  const board = await openBoard([entry('a')], {
    feedback: connected([publicLink('a', { url: 'javascript:alert(1)' })]),
  });

  assert.ok(board.cardMarkup('a').includes('Öffentlich: im Test'));
  assert.equal(parseTags(board.cardMarkup('a')).some(({ tag }) => tag === 'a'), false);
  assert.equal(board.markup('boardColumns').includes('javascript:'), false);
});

test('„Verknüpfen“ nur mit Quelle fürs Board, „Verknüpfung lösen“ nur mit Verknüpfung', async () => {
  const board = await openBoard([entry('a'), entry('b'), entry('c', { appId: 'a2' })], {
    feedback: connected([publicLink('a')]),
  });

  assert.deepEqual(actions(board, 'a'), ['unlink-card']);
  assert.deepEqual(actions(board, 'b'), ['link-card']);
  assert.deepEqual(actions(board, 'c'), []);
});

const dialog = (board) => board.element('linkDialog');
async function submitLink(board, value) {
  board.element('linkEntryId').value = value;
  const event = fakeEvent(board.element('linkForm'));
  board.element('linkForm').fire('submit', event);
  await settle();
  // Sonst lädt der Browser die Seite neu.
  assert.equal(event.prevented, true);
}

test('„Verknüpfen“ öffnet den Dialog mit leerem Feld und sendet noch nichts', async () => {
  const board = await openBoard([entry('a')]);
  board.element('linkEntryId').value = 'von vorher';
  board.calls.requests.length = 0;

  await clickCard(board, 'link-card', 'a');

  assert.equal(dialog(board).open, true);
  assert.equal(board.element('linkEntryId').value, '');
  assert.deepEqual(board.calls.requests, []);
});

test('„Verknüpfen“ sendet die ID, schließt den Dialog und zeigt den neuen Stand', async () => {
  const board = await openBoard([entry('a')]);
  await clickCard(board, 'link-card', 'a');
  board.calls.requests.length = 0;

  await submitLink(board, '  e42  ');

  assert.equal(dialog(board).open, false);
  assert.deepEqual(requested(board), ['PUT /suggestions/a/link', 'GET /feedback']);
  assert.deepEqual(board.calls.requests[0].body, { entryId: 'e42' });
  assert.ok(board.cardMarkup('a').includes('Öffentlich: noch nicht geholt'));
  assert.deepEqual(actions(board, 'a'), ['unlink-card']);
});

test('„Verknüpfen“ mit leerer ID: nichts wird gesendet, der Dialog bleibt', async () => {
  const board = await openBoard([entry('a')]);
  await clickCard(board, 'link-card', 'a');
  board.calls.requests.length = 0;

  await submitLink(board, '   ');

  assert.equal(dialog(board).open, true);
  assert.deepEqual(board.calls.requests, []);
});

test('„Abbrechen“ schließt den Dialog, nichts wird gesendet', async () => {
  const board = await openBoard([entry('a')]);
  await clickCard(board, 'link-card', 'a');
  board.calls.requests.length = 0;

  board.element('linkCancelBtn').fire('click', {});

  assert.equal(dialog(board).open, false);
  assert.deepEqual(board.calls.requests, []);
});

test('Doppeltes Absenden verknüpft nur einmal', async () => {
  const board = await openBoard([entry('a')]);
  await clickCard(board, 'link-card', 'a');
  board.calls.requests.length = 0;
  board.element('linkEntryId').value = 'e1';

  board.element('linkForm').fire('submit', fakeEvent(board.element('linkForm')));
  board.element('linkForm').fire('submit', fakeEvent(board.element('linkForm')));
  await settle();

  assert.deepEqual(requested(board), ['PUT /suggestions/a/link', 'GET /feedback']);
});

test('„Verknüpfen“ abgelehnt: Die Meldung des Servers erscheint', async () => {
  const board = await openBoard([entry('a')]);
  board.server.failLink = 'Der Eintrag oder das Ticket ist schon verknüpft.';
  await clickCard(board, 'link-card', 'a');

  await submitLink(board, 'e1');

  assert.equal(board.element('toast').textContent, 'Der Eintrag oder das Ticket ist schon verknüpft.');
  assert.deepEqual(actions(board, 'a'), ['link-card']);
});

test('viewer kann nicht verknüpfen oder lösen', async () => {
  const board = await openBoard([entry('a')], { role: 'viewer', feedback: connected([publicLink('a')]) });
  board.calls.requests.length = 0;

  board.app.linkCard('a');
  await board.app.unlinkCard('a');
  await submitLink(board, 'e1');

  assert.equal(dialog(board).open, false);
  assert.deepEqual(board.calls.requests, []);
});

test('„Verknüpfung lösen“ fragt nach', async () => {
  const board = await openBoard([entry('a')], { feedback: connected([publicLink('a')]), confirmAnswer: false });
  board.calls.requests.length = 0;

  await clickCard(board, 'unlink-card', 'a');

  assert.deepEqual(board.calls.confirm, [
    'Verknüpfung lösen? Der öffentliche Eintrag wird danach nicht erneut als Ticket geholt.',
  ]);
  assert.deepEqual(board.calls.requests, []);
});

test('„Verknüpfung lösen“ bestätigt: DELETE, die Karte verliert die Zeile', async () => {
  const board = await openBoard([entry('a')], { feedback: connected([publicLink('a')]) });
  board.calls.requests.length = 0;

  await clickCard(board, 'unlink-card', 'a');

  assert.deepEqual(requested(board), ['DELETE /suggestions/a/link', 'GET /feedback']);
  assert.equal(board.cardMarkup('a').includes('Öffentlich'), false);
});

// ---------------------------------------------------------------------------
// Wartende Veröffentlichung
// ---------------------------------------------------------------------------

const waitingLink = (suggestionId, fields = {}) => publicLink(suggestionId, {
  publicStatus: 'offen', pushEnabled: true, pendingStatus: 'gelöst', pendingReason: 'mail', pendingMail: true,
  pendingError: null, pushStage: null, ...fields,
});
const elementsOf = (board, id) => parseTags(board.cardMarkup(id));
const pushButtons = (board, id) => elementsOf(board, id)
  .map(({ attributes }) => attributes['data-action'])
  .filter((action) => ['publish-card', 'discard-card', 'test-card'].includes(action));
const attributesOf = (board, id, action) => elementsOf(board, id)
  .find(({ attributes }) => attributes['data-action'] === action)?.attributes;
const filled = (board, id) => elementsOf(board, id)
  .filter(({ attributes }) => (attributes.class || '').includes('primary-btn')).length;
const toast = (board) => board.element('toast').textContent;
// Der Server hat die Änderung erledigt.
const settled = (result, message) => (server, id) => {
  server.feedback.links = server.feedback.links.map((item) => (item.suggestionId === id
    ? { ...item, publicStatus: item.pendingStatus, pendingStatus: null, pendingReason: null, pendingMail: false }
    : item));
  return { result, message };
};
async function openPending(fields = {}, options = {}) {
  const board = await openBoard([entry('a', { status: 'gelöst' })], {
    feedback: connected([waitingLink('a', fields)]), ...options,
  });
  board.calls.requests.length = 0;
  return board;
}

test('Karte zeigt die wartende Änderung mit einem gefüllten Knopf und Textlink', async () => {
  const board = await openPending();

  assert.ok(board.cardMarkup('a').includes('Wartet auf Veröffentlichung: gelöst'));
  assert.ok(board.cardMarkup('a').includes('>Übernehmen und Mail senden<'));
  assert.deepEqual(pushButtons(board, 'a'), ['publish-card', 'discard-card']);
  assert.equal(attributesOf(board, 'a', 'publish-card').class, 'primary-btn');
  assert.equal(attributesOf(board, 'a', 'discard-card').class, 'board-text-link');
  assert.equal(filled(board, 'a'), 1);
});

test('Ohne Mail heißt der Knopf „Übernehmen“', async () => {
  const board = await openPending({ pendingMail: false, pendingReason: 'backward' });

  assert.ok(board.cardMarkup('a').includes('>Übernehmen<'));
  assert.equal(board.cardMarkup('a').includes('Mail senden'), false);
});

for (const [who, options] of [
  ['Admin', { role: 'admin' }],
  ['Viewer', { role: 'viewer' }],
  ['Plattform-Admin ohne Mitgliedschaft', { role: 'super_admin', membership: null }],
  ['Plattform-Admin mit Admin-Mitgliedschaft', { role: 'super_admin', membership: { role: 'admin' } }],
]) {
  test(`${who} sieht die Zeile ohne Knopf`, async () => {
    const board = await openPending({}, options);

    assert.ok(board.cardMarkup('a').includes('Wartet auf Veröffentlichung: gelöst'));
    assert.deepEqual(pushButtons(board, 'a'), []);
    await board.app.publishCard('a');
    await board.app.discardCard('a');
    assert.deepEqual(board.calls.requests, []);
  });
}

test('Plattform-Admin, der Owner ist, bekommt den Knopf', async () => {
  const board = await openPending({}, { role: 'super_admin', membership: { role: 'owner' } });

  assert.deepEqual(pushButtons(board, 'a'), ['publish-card', 'discard-card']);
});

test('Die Rolle aus der echten Sitzung entscheidet', async () => {
  const board = await openConsole([entry('a')], {
    signIn: true, hash: '#board', role: 'owner', feedback: connected([waitingLink('a')]),
  });
  await settle();

  assert.equal(board.app.canPublishPublic(), true);
});

test('Ausgeschalteter Schalter zeigt keine Bedienung', async () => {
  const board = await openBoard([entry('a', { status: 'im Test' })], {
    feedback: connected([waitingLink('a', { pushEnabled: false })]),
  });
  board.calls.requests.length = 0;

  assert.equal(board.cardMarkup('a').includes('Wartet auf'), false);
  assert.deepEqual(pushButtons(board, 'a'), []);
  await board.app.publishCard('a');
  await board.app.setPublicTest('a');
  assert.deepEqual(board.calls.requests, []);
});

test('Klick sendet Status und Mail, zeigt den neuen Stand und meldet das Ergebnis', async () => {
  const board = await openPending();
  board.server.pushAnswer = settled('published');

  await clickCard(board, 'publish-card', 'a');

  assert.deepEqual(requested(board), ['POST /feedback/links/a/publish']);
  assert.deepEqual(board.calls.requests[0].body, { entryId: 'e1', status: 'gelöst', mail: true });
  assert.equal(toast(board), 'Veröffentlicht, die Mail ist raus.');
  assert.equal(board.cardMarkup('a').includes('Wartet auf'), false);
  assert.ok(board.cardMarkup('a').includes('Öffentlich: gelöst'));
});

test('Klick ohne Mail sagt ausdrücklich mail: false', async () => {
  const board = await openPending({ pendingMail: false });
  board.server.pushAnswer = settled('published_no_mail');

  await clickCard(board, 'publish-card', 'a');

  assert.deepEqual(board.calls.requests[0].body, { entryId: 'e1', status: 'gelöst', mail: false });
  assert.equal(toast(board), 'Veröffentlicht, ohne Mail.');
});

for (const [result, message] of [
  ['published_no_mail', 'Status veröffentlicht, die Mail ging nicht raus.'],
  ['busy', 'Die Änderung wird gerade veröffentlicht.'],
  ['error', 'Der öffentliche Eintrag ist nicht freigegeben.'],
]) {
  test(`Antwort ${result}: Die Meldung des Servers erscheint`, async () => {
    const board = await openPending();
    board.server.pushAnswer = () => ({ result, message });

    await clickCard(board, 'publish-card', 'a');

    assert.equal(toast(board), message);
    assert.equal(board.element('toast').className, 'toast error');
  });
}

test('Verlangt der Server die Mail, zeigt die Karte danach den Mail-Knopf', async () => {
  const board = await openPending({ pendingMail: false });
  board.server.pushAnswer = (server) => {
    server.feedback.links = [waitingLink('a', { pendingMail: true })];
    return { result: 'error', message: 'Zu diesem Eintrag ginge eine Mail raus. Nichts veröffentlicht.' };
  };

  await clickCard(board, 'publish-card', 'a');

  assert.ok(board.cardMarkup('a').includes('Übernehmen und Mail senden'));
  assert.equal(board.calls.requests.length, 1);
});

test('Doppelklick sendet nur einmal, der Knopf ist solange gesperrt', async () => {
  const board = await openPending();
  let release;
  board.server.holdPush = new Promise((resolve) => { release = resolve; });
  board.server.pushAnswer = settled('published');
  const button = () => board.find('boardColumns', (attributes) => attributes['data-action'] === 'publish-card');

  board.element('boardColumns').fire('click', fakeEvent(button()));
  board.element('boardColumns').fire('click', fakeEvent(button()));
  await settle();

  assert.ok('disabled' in attributesOf(board, 'a', 'publish-card'));
  assert.ok('disabled' in attributesOf(board, 'a', 'discard-card'));
  await board.app.discardCard('a');
  release();
  await settle();
  assert.deepEqual(requested(board), ['POST /feedback/links/a/publish']);
});

test('Der zweite Klick eines Doppelklicks trifft keinen neuen Knopf', async () => {
  const board = await openPending();
  const button = board.find('boardColumns', (attributes) => attributes['data-action'] === 'publish-card');

  board.element('boardColumns').fire('click', { ...fakeEvent(button), detail: 2 });
  await settle();

  assert.deepEqual(board.calls.requests, []);
});

test('HTTP-Fehler: Meldung, Stand neu lesen, Knopf wieder frei', async () => {
  const board = await openPending();
  board.server.failPush = 'Veröffentlichen kann nur ein angemeldeter Owner.';

  await clickCard(board, 'publish-card', 'a');

  assert.equal(toast(board), 'Veröffentlichen kann nur ein angemeldeter Owner.');
  assert.deepEqual(requested(board), ['POST /feedback/links/a/publish', 'GET /feedback']);
  assert.equal('disabled' in attributesOf(board, 'a', 'publish-card'), false);
});

test('„Verwerfen“ räumt die Zeile ab', async () => {
  const board = await openPending();
  board.server.pushAnswer = (server) => {
    server.feedback.links = [publicLink('a', { pushEnabled: true })];
    return { success: true };
  };

  await clickCard(board, 'discard-card', 'a');

  assert.deepEqual(requested(board), ['POST /feedback/links/a/discard']);
  assert.deepEqual(board.calls.requests[0].body, { entryId: 'e1' });
  assert.equal(toast(board), 'Wartende Änderung verworfen');
  assert.equal(board.cardMarkup('a').includes('Wartet auf'), false);
});

test('„Verwerfen“ auf veraltetem Stand zeigt die Meldung des Servers', async () => {
  const board = await openPending();
  const message = 'Die wartende Änderung hat sich geändert. Nichts veröffentlicht.';
  board.server.pushAnswer = () => ({ success: false, message });

  await clickCard(board, 'discard-card', 'a');

  assert.equal(toast(board), message);
  assert.equal(board.element('toast').className, 'toast error');
});

test('Hängender Mailversand: nur der Hinweis und „Verwerfen“', async () => {
  const board = await openPending({ pushStage: 'mailing' });

  assert.ok(board.cardMarkup('a').includes('Ob die Mail rausging, ist unklar.'));
  assert.equal(board.cardMarkup('a').includes('Wartet auf'), false);
  assert.deepEqual(pushButtons(board, 'a'), ['discard-card']);
  await board.app.publishCard('a');
  assert.deepEqual(board.calls.requests, []);
});

test('Fehlertext wird als Text gezeigt', async () => {
  const board = await openPending({
    pendingReason: 'failed', pendingError: '<img src=x onerror=alert(1)>', pendingStatus: '<img src=y>',
  });

  assert.equal(board.tags().some(({ tag }) => tag === 'img'), false);
  assert.ok(board.cardMarkup('a').includes('&lt;img src=x onerror=alert(1)&gt;'));
});

const testing = (fields = {}) => connected([publicLink('a', {
  publicStatus: 'in Bearbeitung', pushEnabled: true, pendingStatus: null, ...fields,
})]);

for (const [why, status, fields, options, shown] of [
  ['Owner, intern im Test', 'im Test', {}, {}, true],
  ['Admin, intern im Test', 'im Test', {}, { role: 'admin' }, true],
  ['Viewer', 'im Test', {}, { role: 'viewer' }, false],
  ['intern in Bearbeitung', 'in Bearbeitung', {}, {}, false],
  ['öffentlich schon im Test', 'im Test', { publicStatus: 'im Test' }, {}, false],
  ['Schalter aus', 'im Test', { pushEnabled: false }, {}, false],
  ['Owner mit wartendem „im Test“: der Knopf reicht', 'im Test', { pendingStatus: 'im Test' }, {}, false],
  ['Admin mit wartendem „im Test“ behält den Link', 'im Test', { pendingStatus: 'im Test' }, { role: 'admin' }, true],
]) {
  test(`„Öffentlich auf Im Test setzen“: ${why}`, async () => {
    const board = await openBoard([entry('a', { status })], { feedback: testing(fields), ...options });

    assert.equal(pushButtons(board, 'a').includes('test-card'), shown);
    if (shown) {
      assert.equal(attributesOf(board, 'a', 'test-card').class, 'board-text-link');
      assert.ok(board.cardMarkup('a').includes('>Öffentlich auf Im Test setzen<'));
      assert.equal(filled(board, 'a'), 0);
    }
  });
}

test('„Öffentlich auf Im Test setzen“ sendet und meldet das Ergebnis', async () => {
  const board = await openBoard([entry('a', { status: 'im Test' })], { feedback: testing() });
  board.calls.requests.length = 0;
  board.server.pushAnswer = (server) => {
    server.feedback.links = testing({ publicStatus: 'im Test' }).links;
    return { publicPush: { result: 'written', message: 'Öffentlich veröffentlicht: im Test.' } };
  };

  await clickCard(board, 'test-card', 'a');

  assert.deepEqual(requested(board), ['POST /feedback/links/a/test']);
  assert.equal(toast(board), 'Öffentlich veröffentlicht: im Test.');
  assert.deepEqual(pushButtons(board, 'a'), []);
});

test('Statuswechsel meldet publicPush und lädt den öffentlichen Stand neu', async () => {
  const board = await openBoard([entry('a', { status: 'in Bearbeitung' })], { feedback: testing() });
  board.calls.requests.length = 0;
  const message = 'Öffentlich noch nicht geändert: Es ginge eine Mail raus. Die Änderung wartet auf der Karte.';
  board.server.publicPush = (server) => {
    server.feedback.links = [waitingLink('a')];
    return { result: 'waiting', message };
  };

  await board.app.moveCard('a', 'fertig');
  await settle();

  assert.ok(requested(board).includes('GET /feedback'));
  assert.equal(toast(board), `Status aktualisiert. ${message}`);
  assert.ok(board.cardMarkup('a').includes('Wartet auf Veröffentlichung: gelöst'));
});

test('Statuswechsel ohne publicPush räumt die alte wartende Änderung von der Karte', async () => {
  const board = await openBoard([entry('a', { status: 'in Bearbeitung' })], {
    feedback: connected([waitingLink('a')]),
  });
  board.calls.requests.length = 0;
  // Wie der Server: „wartend“ ändert öffentlich nichts und verwirft das Wartende.
  board.server.feedback.links = [waitingLink('a', { pendingStatus: null, pendingMail: false })];

  await board.app.moveCard('a', 'wartet');
  await settle();

  assert.deepEqual(requested(board), ['GET /feedback']);
  assert.equal(toast(board), 'Status aktualisiert');
  assert.deepEqual(pushButtons(board, 'a'), []);
});

test('Statuswechsel ohne eingeschaltetes Zurückschreiben liest den Stand nicht neu', async () => {
  const board = await openBoard([entry('a', { status: 'in Bearbeitung' })], {
    feedback: connected([publicLink('a')]),
  });
  board.calls.requests.length = 0;

  await board.app.moveCard('a', 'fertig');
  await settle();

  assert.deepEqual(requested(board), []);
  assert.equal(toast(board), 'Status aktualisiert');
});

// ---------------------------------------------------------------------------
// Anlegen in der Spalte
// ---------------------------------------------------------------------------

const createPath = '/api/admin/tenants/acme/suggestions';
const LAST_BOARD = 'tenantAdmin:newTicketBoard:acme';
const ADD_COLUMNS = [['offen', 'offen'], ['arbeit', 'in Bearbeitung'], ['test', 'im Test'], ['wartet', 'wartend']];

async function privateConsole(suggestions = [], options = {}) {
  const board = await openConsole(suggestions, { workspace: 'private', ...options });
  const columns = () => board.element('boardColumns');
  const send = (type, target, fields = {}) => {
    const event = Object.assign(fakeEvent(target), fields);
    columns().fire(type, event);
    return event;
  };
  const click = (key) => {
    const target = board.node(key);
    if (target.disabled) return;
    target.focus();
    send('click', target);
    // Ein Knopf zum Absenden löst im Browser „submit“ am Formular aus.
    if (target.attributes.type === 'submit') send('submit', target.closest('.board-new'));
  };
  const key = (name, fields) => send('keydown', board.node(name), fields);
  const type = (field, value) => {
    const target = board.node(`new:${field}`);
    target.focus();
    Object.assign(target, { value, selectionStart: value.length, selectionEnd: value.length });
    send('input', target);
  };
  const has = (focusKey) => columns().nodes().some((node) => node.attributes['data-focus'] === focusKey);
  const composers = () => columns().nodes().filter((node) => node.classList.contains('board-new'));
  const composerColumn = () => composers()[0]?.closest('.board-column').dataset.column ?? null;
  const posts = () => board.writes().filter(({ method, url }) => method === 'POST' && url === createPath);
  const pressed = (field) => columns().nodes()
    .find(({ attributes }) => attributes['data-field'] === field && attributes['aria-pressed'] === 'true')
    ?.attributes['data-value'];
  const open = (column = 'offen', title) => {
    click(`add:${column}`);
    if (title !== undefined) type('title', title);
  };
  const toast = () => board.element('toast').textContent;
  return { ...board, send, click, key, type, has, composers, composerColumn, posts, pressed, open, toast };
}

// Ein angehaltener Aufruf, den der Test selbst fortsetzt.
function gate() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

test('„+ Ticket“ steht in jeder Spalte außer „Fertig“', async () => {
  const board = await privateConsole([entry('a')]);

  assert.deepEqual(['offen', 'arbeit', 'test', 'wartet', 'fertig'].map((column) => board.has(`add:${column}`)),
    [true, true, true, true, false]);
  const column = board.columnMarkup('offen');
  assert.ok(column.indexOf('board-column-head') < column.indexOf('+ Ticket'));
  assert.ok(column.indexOf('+ Ticket') < column.indexOf('data-board-card'));
});

for (const [what, options] of [
  ['viewer', { role: 'viewer' }],
  ['öffentlicher Workspace', { workspace: 'active' }],
  ['unbekannter Workspace-Stand', { workspace: null }],
  ['ohne Boards', { apps: [] }],
]) {
  test(`Kein „+ Ticket“: ${what}`, async () => {
    const board = await privateConsole([entry('a')], options);

    assert.equal(board.markup('boardColumns').includes('+ Ticket'), false);
    board.app.openComposer('offen');
    assert.equal(board.composers().length, 0);
  });
}

test('Einstellungen, die nach den Einträgen laden, bringen „+ Ticket“ aufs Board', async () => {
  const board = await openConsole([entry('a')], { workspace: 'private', load: false });

  await board.app.loadApps();
  await board.app.loadSuggestions();
  assert.equal(board.markup('boardColumns').includes('+ Ticket'), false);
  await board.app.loadSettings();

  assert.ok(board.markup('boardColumns').includes('+ Ticket'));
});

test('Ein Klick öffnet die Karte an dieser Stelle mit Fokus im Titel', async () => {
  const board = await privateConsole([entry('a')]);

  board.open('test');

  assert.equal(board.composers().length, 1);
  assert.equal(board.composerColumn(), 'test');
  assert.equal(board.focused(), 'new:title');
  assert.equal(board.has('add:test'), false);
  assert.equal(board.has('add:offen'), true);
  assert.equal(board.has('new:description'), false);
  assert.ok(board.markup('boardColumns').includes('Beschreibung hinzufügen'));
  assert.equal(board.pressed('priority'), 'mittel');
  assert.deepEqual(board.writes(), []);
});

test('„+ Ticket“ in einer anderen Spalte verschiebt die Karte samt Inhalt', async () => {
  const board = await privateConsole();
  board.open('offen', 'Halb getippt');
  board.click('new:priority:hoch');

  board.open('wartet');

  assert.equal(board.composers().length, 1);
  assert.equal(board.composerColumn(), 'wartet');
  assert.equal(board.node('new:title').value, 'Halb getippt');
  assert.equal(board.node('new:title').selectionStart, 'Halb getippt'.length);
  assert.equal(board.pressed('priority'), 'hoch');
  assert.equal(board.focused(), 'new:title');
  assert.equal(board.has('add:offen'), true);
});

for (const [what, storage, filter, expected] of [
  ['das erste Board', {}, '', 'a1'],
  ['das zuletzt benutzte', { [LAST_BOARD]: 'a2' }, '', 'a2'],
  ['das erste, wenn es das zuletzt benutzte nicht mehr gibt', { [LAST_BOARD]: 'weg' }, '', 'a1'],
  ['der Board-Filter vor dem zuletzt benutzten', { [LAST_BOARD]: 'a1' }, 'a2', 'a2'],
]) {
  test(`Vorausgewählt ist ${what}`, async () => {
    const board = await privateConsole([], { storage });
    board.element('boardAppFilter').fire('change', fakeEvent({ value: filter }));

    board.open();

    assert.equal(board.pressed('appId'), expected);
  });
}

test('Auch ein gesperrter Speicher verhindert das Anlegen nicht', async () => {
  const storage = new Proxy({}, { get() { throw new Error('gesperrt'); }, set() { throw new Error('gesperrt'); } });
  const board = await privateConsole([], { storage });

  board.open('offen', 'Ohne Speicher');
  board.key('new:title', { key: 'Enter' });
  await settle();

  assert.equal(board.posts().length, 1);
  assert.equal(board.node('new:title').value, '');
});

test('Auswahl von Board und Priorität: Menü zu, Fokus zurück, Farbe am Board', async () => {
  const board = await privateConsole([], { apps: DATED_APPS });
  board.open();
  const chip = () => board.node('new:appId').attributes.class;
  assert.equal(chip(), 'board-new-chip board-tag board-tag-1');

  board.node('new:appId').parentElement.attributes.open = '';
  board.click('new:appId:a1');

  assert.equal(board.pressed('appId'), 'a1');
  assert.equal(chip(), 'board-new-chip board-tag board-tag-0');
  assert.equal(board.focused(), 'new:appId');
  assert.equal('open' in board.node('new:appId').parentElement.attributes, false);

  board.node('new:priority').parentElement.attributes.open = '';
  board.click('new:priority:kritisch');
  assert.equal(board.pressed('priority'), 'kritisch');
  assert.equal(board.focused(), 'new:priority');
});

test('Die Karte nutzt Menüs, kein natives select', async () => {
  const board = await privateConsole();
  board.open();

  const tags = parseTags(board.columnMarkup('offen')).map(({ tag }) => tag);
  assert.equal(tags.includes('select'), false);
  assert.equal(tags.filter((tag) => tag === 'details').length, 2);
});

test('„Beschreibung hinzufügen“ zeigt das Feld und fokussiert es', async () => {
  const board = await privateConsole();
  board.open();

  board.click('new:describe');

  assert.equal(board.focused(), 'new:description');
  assert.equal(board.has('new:describe'), false);
});

test('Knopf ist bei leerem Titel gesperrt, Enter schickt dann nichts', async () => {
  const board = await privateConsole();
  board.open();
  assert.equal(board.node('new:submit').disabled, true);

  board.type('title', '   ');
  assert.equal(board.node('new:submit').disabled, true);
  const enter = board.key('new:title', { key: 'Enter' });
  board.send('submit', board.composers()[0]);
  await settle();

  assert.equal(enter.prevented, true);
  assert.deepEqual(board.writes(), []);
  board.type('title', 'x');
  assert.equal(board.node('new:submit').disabled, false);
  board.type('title', '');
  assert.equal(board.node('new:submit').disabled, true);
});

for (const [column, status] of ADD_COLUMNS) {
  test(`Anlegen in „${column}“ schickt Status „${status}“`, async () => {
    const board = await privateConsole();
    board.open(column, '  Neue Aufgabe  ');

    board.key('new:title', { key: 'Enter' });
    await settle();

    assert.deepEqual(board.posts().map(({ body }) => body), [{
      appId: 'a1', title: 'Neue Aufgabe', description: '', priority: 'mittel', status,
    }]);
    assert.equal(board.cardsIn(column).length, 1);
  });
}

test('Der Knopf legt mit Board, Priorität und Beschreibung an', async () => {
  const board = await privateConsole();
  board.open('offen', 'Mit allem');
  board.click('new:appId:a2');
  board.click('new:priority:niedrig');
  board.click('new:describe');
  board.type('description', 'Zeile 1\nZeile 2\n');

  board.click('new:submit');
  await settle();

  assert.deepEqual(board.posts().map(({ body }) => body), [{
    appId: 'a2', title: 'Mit allem', description: 'Zeile 1\nZeile 2', priority: 'niedrig', status: 'offen',
  }]);
});

for (const [what, fields] of [['isComposing', { isComposing: true }], ['keyCode 229', { keyCode: 229 }]]) {
  test(`Während einer IME-Eingabe (${what}) legt Enter nichts an, Esc schließt nicht`, async () => {
    const board = await privateConsole();
    board.open('offen', 'にほん');

    const enter = board.key('new:title', { key: 'Enter', ...fields });
    board.key('new:title', { key: 'Escape', ...fields });
    await settle();

    assert.equal(enter.prevented, false);
    assert.deepEqual(board.writes(), []);
    assert.equal(board.composers().length, 1);
  });
}

test('In der Beschreibung ist Enter ein Umbruch', async () => {
  const board = await privateConsole();
  board.open('offen', 'Titel');
  board.click('new:describe');

  const enter = board.key('new:description', { key: 'Enter' });
  await settle();

  assert.equal(enter.prevented, false);
  assert.deepEqual(board.writes(), []);
});

for (const modifier of ['metaKey', 'ctrlKey']) {
  test(`In der Beschreibung legt Enter mit ${modifier} an`, async () => {
    const board = await privateConsole();
    board.open('offen', 'Titel');
    board.click('new:describe');
    board.type('description', 'Text');

    const enter = board.key('new:description', { key: 'Enter', [modifier]: true });
    await settle();

    assert.equal(enter.prevented, true);
    assert.equal(board.posts().length, 1);
    assert.equal(board.focused(), 'new:title');
  });
}

test('Enter auf einem Knopf der Karte bleibt beim Knopf', async () => {
  const board = await privateConsole();
  board.open('offen', 'Titel');

  const enter = board.key('new:cancel', { key: 'Enter' });
  await settle();

  assert.equal(enter.prevented, false);
  assert.deepEqual(board.writes(), []);
});

test('Während des Speicherns ist alles gesperrt, nichts wird doppelt angelegt', async () => {
  const board = await privateConsole();
  const hold = gate();
  board.server.holdCreate = hold.promise;
  board.open('offen', 'Nur einmal');

  board.key('new:title', { key: 'Enter' });
  // Das gesperrte Feld behält Fokus und Schreibmarke.
  assert.equal(board.focused(), 'new:title');
  board.key('new:title', { key: 'Enter' });
  board.send('submit', board.composers()[0]);
  board.key('new:title', { key: 'Escape' });
  board.click('new:cancel');
  board.click('add:test');
  await settle();

  assert.equal(board.posts().length, 1);
  assert.equal(board.composerColumn(), 'offen');
  assert.equal(board.node('new:submit').disabled, true);
  assert.equal(board.node('new:cancel').disabled, true);
  assert.ok('readonly' in board.node('new:title').attributes);
  assert.equal(board.node('new:title').value, 'Nur einmal');

  hold.release();
  await settle();
  assert.equal(board.posts().length, 1);
  assert.equal('readonly' in board.node('new:title').attributes, false);
});

test('Nach dem Anlegen bleibt die Karte offen und leer, das Board bleibt', async () => {
  const storage = {};
  const board = await privateConsole([], { storage });
  board.open('arbeit', 'Erstes');
  board.click('new:appId:a2');
  board.click('new:priority:kritisch');
  board.click('new:describe');
  board.type('description', 'Text');

  board.click('new:submit');
  await settle();

  assert.equal(board.composerColumn(), 'arbeit');
  assert.equal(board.node('new:title').value, '');
  assert.equal(board.has('new:description'), false);
  assert.equal(board.pressed('priority'), 'mittel');
  assert.equal(board.pressed('appId'), 'a2');
  assert.equal(board.focused(), 'new:title');
  assert.equal(board.node('new:submit').disabled, true);
  assert.equal(board.toast(), 'WEB-901 angelegt.');
  assert.equal(storage[LAST_BOARD], 'a2');
  assert.deepEqual(board.cardsIn('arbeit'), ['neu1']);
  assert.ok(board.calls.requests.some(({ url }) => url.endsWith('/stats')));
});

test('Zwei Tickets nacheinander', async () => {
  const board = await privateConsole();
  board.open('offen', 'Eins');
  board.key('new:title', { key: 'Enter' });
  await settle();
  board.type('title', 'Zwei');
  board.key('new:title', { key: 'Enter' });
  await settle();

  assert.deepEqual(board.posts().map(({ body }) => body.title), ['Eins', 'Zwei']);
  assert.equal(board.cardsIn('offen').length, 2);
});

test('Blendet der Label-Filter das Ticket aus, sagt die Meldung das', async () => {
  const board = await privateConsole([entry('a', { labels: ['Export'] })]);
  board.element('boardLabelFilter').fire('change', fakeEvent({ value: 'Export' }));
  board.open('offen', 'Versteckt');

  board.key('new:title', { key: 'Enter' });
  await settle();

  assert.equal(board.toast(), 'WEB-902 angelegt. Der Label-Filter blendet es aus.');
});

test('Blendet der Board-Filter das Ticket aus, sagt die Meldung das', async () => {
  const board = await privateConsole();
  board.element('boardAppFilter').fire('change', fakeEvent({ value: 'a1' }));
  board.open('offen', 'Anderswo');
  board.click('new:appId:a2');

  board.key('new:title', { key: 'Enter' });
  await settle();

  assert.equal(board.toast(), 'WEB-901 angelegt. Der Board-Filter blendet es aus.');
});

for (const [what, prepare, message] of [
  ['Fehlerantwort', (server) => { server.failCreate = { status: 404, error: 'Board nicht gefunden.' }; }, 'Board nicht gefunden.'],
  ['Anfrage-Grenze', (server) => { server.failCreate = { status: 429, error: 'Too many requests.' }; }, 'Zu viele Tickets auf einmal. Warte eine Minute.'],
  ['Netzfehler', (server) => { server.loseCreate = true; }, 'Das Ticket ließ sich nicht anlegen.'],
  ['Antwort ohne Meldung', (server) => { server.failCreate = { status: 500 }; }, 'Das Ticket ließ sich nicht anlegen.'],
]) {
  test(`${what}: Text bleibt stehen, die Meldung steht in der Karte`, async () => {
    const board = await privateConsole();
    prepare(board.server);
    board.open('offen', 'Bleibt stehen');
    board.click('new:priority:hoch');
    board.click('new:describe');
    board.type('description', 'Auch das');

    board.click('new:submit');
    await settle();

    assert.ok(board.columnMarkup('offen').includes(`role="alert">${message}<`), board.columnMarkup('offen'));
    assert.equal(board.node('new:title').value, 'Bleibt stehen');
    assert.equal(board.node('new:description').value, 'Auch das');
    assert.equal(board.pressed('priority'), 'hoch');
    assert.equal(board.node('new:submit').disabled, false);
    assert.equal(board.focused(), 'new:title');

    Object.assign(board.server, { failCreate: null, loseCreate: false });
    board.click('new:submit');
    await settle();
    assert.equal(board.markup('boardColumns').includes('role="alert"'), false);
    assert.equal(board.posts().length, 2);
  });
}

test('Lädt die Liste danach nicht, sagt die Meldung, dass das Ticket angelegt ist', async () => {
  const board = await privateConsole();
  board.open('offen', 'Angelegt');
  board.server.failList = 'kaputt';

  board.key('new:title', { key: 'Enter' });
  await settle();

  assert.equal(board.toast(), 'WEB-901 angelegt. Die Liste ließ sich nicht neu laden.');
  assert.equal(board.node('new:title').value, '');
});

test('Wer während des Speicherns weitergeht, behält seinen Fokus', async () => {
  const board = await privateConsole([entry('a')]);
  const hold = gate();
  board.server.holdCreate = hold.promise;
  board.open('offen', 'Titel');
  board.key('new:title', { key: 'Enter' });
  await settle();

  board.node('card:a').focus();
  hold.release();
  await settle();

  assert.equal(board.focused(), 'card:a');
});

// Ein Klick neben die Felder oder auf den gesperrten Knopf trifft die Karte.
for (const outcome of ['Erfolg', 'Fehler']) {
  test(`Klick in die Karte während des Speicherns: nach ${outcome} liegt der Fokus im Titel`, async () => {
    const board = await privateConsole();
    const hold = gate();
    board.server.holdCreate = hold.promise;
    if (outcome === 'Fehler') board.server.failCreate = { status: 500 };
    board.open('offen', 'Titel');
    board.key('new:title', { key: 'Enter' });
    await settle();
    assert.equal(board.composers()[0].attributes.tabindex, '-1');

    board.node('new:form').focus();
    hold.release();
    await settle();

    assert.equal(board.focused(), 'new:title');
  });
}

test('Esc schließt auch, wenn der Fokus auf der Karte selbst liegt', async () => {
  const board = await privateConsole();
  board.open('offen', 'Titel');

  board.key('new:form', { key: 'Escape' });

  assert.equal(board.composers().length, 0);
});

for (const [what, close] of [
  ['Esc', (board) => board.key('new:title', { key: 'Escape' })],
  ['„Abbrechen“', (board) => board.click('new:cancel')],
]) {
  test(`${what} schließt, verwirft und fokussiert „+ Ticket“ der Spalte`, async () => {
    const board = await privateConsole();
    board.open('test', 'Weg damit');

    close(board);

    assert.equal(board.composers().length, 0);
    assert.equal(board.focused(), 'add:test');
    assert.deepEqual(board.writes(), []);
    board.open('test');
    assert.equal(board.node('new:title').value, '');
  });
}

test('Esc bei offenem Menü schließt nur das Menü', async () => {
  const board = await privateConsole();
  board.open('offen', 'Bleibt');
  board.node('new:priority').parentElement.attributes.open = '';
  board.node('new:priority:hoch').focus();

  board.key('new:priority:hoch', { key: 'Escape' });

  assert.equal(board.composers().length, 1);
  assert.equal(board.node('new:title').value, 'Bleibt');
  assert.equal('open' in board.node('new:priority').parentElement.attributes, false);
  assert.equal(board.focused(), 'new:priority');
});

test('Esc im Titel bei offenem Menü schließt nur das Menü', async () => {
  const board = await privateConsole();
  board.open('offen', 'Bleibt');
  board.node('new:priority').parentElement.attributes.open = '';

  board.key('new:title', { key: 'Escape' });

  assert.equal(board.composers().length, 1);
  assert.equal('open' in board.node('new:priority').parentElement.attributes, false);
  assert.equal(board.focused(), 'new:title');
});

for (const [what, redraw] of [
  ['Neuladen', (board) => board.app.loadSuggestions()],
  ['Verschieben einer Karte', (board) => board.app.moveCard('a', 'arbeit')],
  ['Feedback-Holen', (board) => board.app.fetchFeedbackNow()],
  ['neue Boards', (board) => board.app.loadApps()],
  ['Breitenwechsel', async (board) => board.matchMedia(WIDE).fire('change')],
]) {
  test(`${what}: Eingaben, Fokus und Schreibmarke bleiben`, async () => {
    const board = await privateConsole([entry('a')], {
      feedback: { enabled: true, sources: [], links: [] },
    });
    board.open('offen', 'Mitten im Satz');
    board.click('new:describe');
    board.type('description', '\nerste Zeile ist leer');
    board.node('new:description').setSelectionRange(3, 7);
    const before = board.node('new:description');

    await redraw(board);
    await settle();

    const after = board.node('new:description');
    assert.notEqual(after, before);
    assert.equal(after.value, '\nerste Zeile ist leer');
    assert.equal(board.node('new:title').value, 'Mitten im Satz');
    assert.equal(board.focused(), 'new:description');
    assert.deepEqual([after.selectionStart, after.selectionEnd], [3, 7]);
  });
}

test('Ein offenes Menü der Karte bleibt beim Neuzeichnen offen', async () => {
  const board = await privateConsole();
  board.open();
  board.node('new:priority').parentElement.attributes.open = '';
  board.node('new:priority:hoch').focus();

  await board.app.loadSuggestions();

  assert.equal('open' in board.node('new:priority').parentElement.attributes, true);
  assert.equal('open' in board.node('new:appId').parentElement.attributes, false);
  assert.equal(board.focused(), 'new:priority:hoch');
});

test('Neuzeichnen holt den Fokus nicht in die Karte', async () => {
  const board = await privateConsole([entry('a')]);
  board.open('offen', 'Titel');
  board.node('card:a').focus();

  await board.app.loadSuggestions();

  assert.equal(board.focused(), 'card:a');
  assert.equal(board.node('new:title').value, 'Titel');
});

test('Schmal: Beim Spaltenwechsel bleibt die Karte an ihrer Spalte', async () => {
  const board = await privateConsole([], { wide: false });
  board.open('arbeit', 'Bleibt hier');

  board.element('boardSwitcher').fire('click', fakeEvent(board.node('switch:test')));

  assert.equal(board.composerColumn(), 'arbeit');
  assert.ok(board.columnMarkup('test').includes('is-current'));
});

test('Wird das Fenster beim Schreiben schmal, bleibt die Spalte der Karte vorn', async () => {
  const board = await privateConsole();
  board.open('wartet', 'Schreibe gerade');

  board.matchMedia(WIDE).matches = false;
  board.matchMedia(WIDE).fire('change');

  assert.ok(board.columnMarkup('wartet').includes('is-current'));
  assert.equal(board.focused(), 'new:title');
});

test('Eingefügte Zeilenumbrüche im Titel werden zu Leerzeichen', async () => {
  const board = await privateConsole();
  board.open('offen', 'eins\r\n\nzwei\nrest');

  assert.equal(board.node('new:title').value, 'eins zwei rest');
  board.key('new:title', { key: 'Enter' });
  await settle();
  assert.equal(board.posts()[0].body.title, 'eins zwei rest');
});

test('Wird das gewählte Board gelöscht, wählt die Karte ein vorhandenes', async () => {
  const board = await privateConsole();
  board.open('offen', 'Titel');
  board.click('new:appId:a2');

  board.server.apps = [APPS[0]];
  await board.app.loadApps();

  assert.equal(board.pressed('appId'), 'a1');
});

test('HTML in Boardnamen und Eingaben bleibt in der Karte Text', async () => {
  const attack = (n) => `"><img src=x onerror=alert(${n})></textarea>' onfocus="x`;
  const hostileApp = { id: attack(1), name: attack(2), slug: 'x' };
  const board = await privateConsole([], { apps: [hostileApp] });
  board.open('offen', attack(3));
  board.click('new:describe');
  board.type('description', attack(4));

  await board.app.loadSuggestions();

  const rendered = board.markup('boardColumns');
  assert.equal(rendered.includes('<img'), false);
  for (const { tag, attributes } of parseTags(rendered)) {
    assert.notEqual(tag, 'img');
    assert.deepEqual(Object.keys(attributes).filter((name) => name.startsWith('on')), [], tag);
  }
  assert.equal(board.node('new:title').value, attack(3));
  assert.equal(board.node('new:description').value, attack(4));
  assert.equal(board.pressed('appId'), attack(1));
});
