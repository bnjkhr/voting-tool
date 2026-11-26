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
  for (const [, closing, name, rest] of String(markup).matchAll(tag)) {
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
      focus() { if (!dom.isHidden(node)) dom.active = node; },
      matches: () => false,
      scrollIntoView() {},
    };
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

async function openConsole(suggestions, { role = 'owner', wide = true, confirmAnswer = true, apps = APPS, load = true, missing = [] } = {}) {
  const server = {
    suggestions: structuredClone(suggestions), apps, failWith: null, hold: null,
    // Antworten auf die Liste zurückhalten, um sie in anderer Reihenfolge zu liefern.
    deferList: false, waiting: [], failList: null, removeOnWrite: false,
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

  const respond = (payload, ok = true) => ({ ok, status: ok ? 200 : 500, json: async () => payload });
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
    if (method === 'GET') return respond({});
    const status = /^\/suggestions\/([^/]+)\/status$/.exec(route);
    if (method === 'PUT' && status) {
      if (server.hold) await server.hold;
      if (server.failWith) return respond({ error: server.failWith }, false);
      const id = decodeURIComponent(status[1]);
      server.suggestions.find((item) => item.id === id).status = body.status;
      if (server.removeOnWrite) server.suggestions = server.suggestions.filter((item) => item.id !== id);
      return respond({ success: true });
    }
    throw new Error(`Unerwartete Anfrage: ${method} ${url}`);
  }

  const context = {
    console: { log() {}, warn() {}, error() {} },
    URLSearchParams,
    setTimeout: (handler, delay) => { if (!delay) setImmediate(handler); },
    localStorage: { getItem: () => null, setItem() {} },
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
    location: { search: '?tenant=acme', hash: '', pathname: '/tenant-admin.html', host: 'localhost', protocol: 'http:' },
    matchMedia,
    // Die Anmeldung bleibt offen: die Tests laden selbst, was sie brauchen.
    adminAuth: { requireTenantAuth: () => new Promise(() => {}), authFetch },
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
  app.currentRole = role;
  if (load) {
    await app.loadApps();
    await app.loadSuggestions();
  }
  calls.requests.length = 0;

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
