'use strict';

// Nutzertext darf in den Admin-Oberflächen nie als Markup oder Code gelten.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const publicDir = path.join(__dirname, '..', 'public');
const read = (file) => fs.readFileSync(path.join(publicDir, file), 'utf8');

const MARKER = 'NUTZERTEXT';
const hostile = (field) => `${MARKER}-${field} ' " onfocus="${MARKER}`;

// Verhält sich wie der Browser: textContent -> innerHTML maskiert nur & < >.
function browserLikeElement() {
  let text = '';
  let html = '';
  return {
    style: {},
    dataset: {},
    value: '',
    set textContent(value) {
      text = value == null ? '' : String(value);
      html = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    },
    get textContent() { return text; },
    set innerHTML(value) { html = value; },
    get innerHTML() { return html; },
    appendChild(child) { html += child.innerHTML; },
  };
}

function decodeEntities(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Liest Tags und Attribute so, wie der HTML-Parser Anführungszeichen auswertet.
function parseTags(html) {
  const tags = [];
  const tagStart = /<([a-zA-Z][^\s/>]*)/g;
  let match;
  while ((match = tagStart.exec(html))) {
    let i = tagStart.lastIndex;
    const attributes = {};
    while (i < html.length && html[i] !== '>') {
      if (/[\s/]/.test(html[i])) { i += 1; continue; }
      const name = /^[^\s/>][^\s/>=]*/.exec(html.slice(i))[0];
      i += name.length;
      let value = '';
      const equals = /^\s*=\s*/.exec(html.slice(i));
      if (equals) {
        i += equals[0].length;
        const quote = html[i];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, i + 1);
          assert.ok(end > -1, `Attribut ${name} ist nicht geschlossen`);
          value = html.slice(i + 1, end);
          i = end + 1;
        } else {
          value = /^[^\s>]*/.exec(html.slice(i))[0];
          i += value.length;
        }
      }
      attributes[name.toLowerCase()] ??= decodeEntities(value);
    }
    tagStart.lastIndex = i;
    tags.push({ tag: match[1].toLowerCase(), attributes });
  }
  return tags;
}

function loadAdmin() {
  const elements = new Map();
  const calls = { confirm: [], fetch: [] };
  const context = {
    console,
    encodeURIComponent,
    document: {
      createElement: browserLikeElement,
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, browserLikeElement());
        return elements.get(id);
      },
    },
    confirm(message) { calls.confirm.push(message); return false; },
    fetch: async (url) => {
      calls.fetch.push(url);
      return { ok: true, json: async () => ({}) };
    },
  };
  const source = read('admin.js').replace('const adminApp = new AdminApp();', 'this.AdminApp = AdminApp;');
  vm.runInNewContext(source, context);

  const admin = Object.create(context.AdminApp.prototype);
  Object.assign(admin, {
    filters: { app: '', type: '', status: '', priority: '' },
    selectedScreenshots: {},
    loadComments: () => {},
    loadData: () => {},
    loadSuggestions: () => {},
    showToast: () => {},
  });
  context.adminApp = admin;
  return { admin, context, elements, calls };
}

function renderEverything() {
  const loaded = loadAdmin();
  const { admin } = loaded;
  admin.apps = [{
    id: 'app1', name: hostile('app'), description: hostile('beschreibung'), ticketPrefix: hostile('prefix'),
  }];
  admin.suggestions = [{
    id: 's1',
    appId: 'app1',
    app: { name: hostile('appname') },
    approved: false,
    type: 'feature',
    title: hostile('titel'),
    description: hostile('text'),
    ticketNumber: hostile('ticket'),
    status: hostile('status'),
    labels: [hostile('label')],
    pendingCommentCount: 1,
    commentCount: 1,
  }];
  admin.releases = [{
    id: 'r1', appId: 'app1', version: hostile('version'), title: hostile('releasetitel'),
    status: 'geplant', itemCount: 1, app: { name: hostile('releaseapp') },
  }];

  admin.renderApps(admin.apps);
  admin.renderSuggestions(admin.suggestions);
  admin.renderReleases(admin.releases);
  admin.renderComments('s1', [{
    id: 'c1',
    authorType: 'user',
    approvalStatus: 'pending',
    text: hostile('kommentar'),
    screenshots: [`data:image/png;base64,AAAA" onerror="${MARKER}`],
  }]);

  loaded.tags = [...loaded.elements.values()].flatMap((element) => parseTags(String(element.innerHTML)));
  return loaded;
}

// Führt den Handler eines gerenderten Buttons so aus wie ein Klick.
function click({ tags, context }, method) {
  const button = tags.find(({ attributes }) => attributes.onclick?.includes(`adminApp.${method}(`));
  assert.ok(button, `kein Button für ${method}`);
  const dataset = Object.fromEntries(Object.entries(button.attributes)
    .filter(([name]) => name.startsWith('data-'))
    .map(([name, value]) => [name.slice(5), value]));
  context.element = { dataset };
  return vm.runInContext(`(function () { ${button.attributes.onclick} }).call(element)`, context);
}

test('Legacy-Admin: kein Nutzertext in on*-Attributen', () => {
  const { tags } = renderEverything();
  assert.ok(tags.some(({ attributes }) => attributes.onclick), 'Handler wurden gerendert');

  for (const { tag, attributes } of tags) {
    for (const [name, value] of Object.entries(attributes)) {
      if (!name.startsWith('on')) continue;
      assert.equal(value.includes(MARKER), false, `<${tag} ${name}> enthält Nutzertext: ${value}`);
    }
  }
});

test('Legacy-Admin: Screenshot bleibt vollständig im src-Attribut', () => {
  const { tags } = renderEverything();
  const images = tags.filter(({ tag }) => tag === 'img');

  assert.equal(images.length, 1);
  assert.equal(images[0].attributes.src, `data:image/png;base64,AAAA" onerror="${MARKER}`);
  assert.equal('onerror' in images[0].attributes, false);
});

for (const [method, field] of [
  ['deleteApp', 'app'],
  ['approveSuggestion', 'titel'],
  ['deleteSuggestion', 'titel'],
  ['deleteRelease', 'version'],
]) {
  test(`Legacy-Admin: ${method} fragt mit dem unveränderten Text nach`, async () => {
    const loaded = renderEverything();
    await click(loaded, method);

    assert.equal(loaded.calls.confirm.length, 1);
    assert.ok(loaded.calls.confirm[0].includes(hostile(field)), loaded.calls.confirm[0]);
    assert.equal(loaded.calls.fetch.length, 0);
  });
}

test('Legacy-Admin: removeLabel schickt das unveränderte Label', async () => {
  const loaded = renderEverything();
  await click(loaded, 'removeLabel');

  assert.deepEqual(loaded.calls.fetch, [
    `/api/admin/suggestions/s1/labels/${encodeURIComponent(hostile('label'))}`,
  ]);
});

for (const file of ['admin.js', 'tenant-admin.js', 'super-admin.js']) {
  test(`${file}: escapeHtml maskiert auch Anführungszeichen`, () => {
    const method = read(file).match(/\n {4}escapeHtml\((\w+)\) \{\n([\s\S]*?)\n {4}\}\n/);
    assert.ok(method, `escapeHtml in ${file} nicht gefunden`);
    const escapeHtml = vm.runInNewContext(
      `(function (${method[1]}) {\n${method[2]}\n})`,
      { document: { createElement: browserLikeElement } }
    );

    assert.equal(escapeHtml(`<a b="c" d='e'>&`), '&lt;a b=&quot;c&quot; d=&#39;e&#39;&gt;&amp;');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(0), '0');
  });
}
