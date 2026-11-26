const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  senderAddress, brandButton, wrapEmail, htmlEscape, adminNotificationUrl, tenantBoardEntryUrl,
  buildLegacyStatusMail, buildTenantStatusMail, legacySenderAddress,
} = require('../api/email-templates');
const { reset, seed, sentMails, startApp } = require('./fake-app');
const apiSource = fs.readFileSync(path.join(__dirname, '..', 'api/index.js'), 'utf8');

test('brandButton rendert einen Terracotta-CTA mit der Ziel-URL', () => {
  const html = brandButton('https://roadlight.pro/x', 'Einloggen');
  assert.ok(html.includes('href="https://roadlight.pro/x"'));
  assert.ok(html.includes('#E06A3A'));
  assert.ok(html.includes('Einloggen'));
});

test('wrapEmail umschließt den Body mit Roadlight-Header/Footer', () => {
  const html = wrapEmail({ heading: 'Titel', bodyHtml: '<p>Inhalt</p>', footnote: 'Hinweis' });
  assert.ok(html.includes('Roadlight'));
  assert.ok(html.includes('roadlight.pro'));
  assert.ok(html.includes('Titel'));
  assert.ok(html.includes('<p>Inhalt</p>'));
  assert.ok(html.includes('Hinweis'));
});

test('senderAddress nutzt EMAIL_FROM, sonst einen Roadlight-Fallback', () => {
  const prev = process.env.EMAIL_FROM;
  try {
    process.env.EMAIL_FROM = 'Roadlight <hallo@roadlight.pro>';
    assert.equal(senderAddress(), 'Roadlight <hallo@roadlight.pro>');
    delete process.env.EMAIL_FROM;
    assert.ok(/Roadlight/.test(senderAddress()));
  } finally {
    if (prev !== undefined) process.env.EMAIL_FROM = prev;
    else delete process.env.EMAIL_FROM;
  }
});

test('htmlEscape neutralisiert HTML in Nutzereingaben', () => {
  assert.equal(htmlEscape('<img src=x onerror=alert(1)>'), '&lt;img src=x onerror=alert(1)&gt;');
  assert.equal(htmlEscape('A & B "C" \'D\''), 'A &amp; B &quot;C&quot; &#39;D&#39;');
  assert.equal(htmlEscape(null), '');
});

test('adminNotificationUrl zeigt für Tenants auf die Konsole, sonst auf Legacy-Admin', () => {
  assert.equal(
    adminNotificationUrl('https://roadlight.pro', 'acme'),
    'https://roadlight.pro/tenant-admin.html?tenant=acme'
  );
  // Kein Slug -> Legacy-Pfad unverändert.
  assert.equal(adminNotificationUrl('https://roadlight.pro', null), 'https://roadlight.pro/admin.html');
  // Trailing Slash der BASE_URL wird nicht dupliziert; Slug wird URL-enkodiert.
  assert.equal(
    adminNotificationUrl('https://roadlight.pro/', 'a b&c'),
    'https://roadlight.pro/tenant-admin.html?tenant=a%20b%26c'
  );
  // Fallback ohne BASE_URL.
  assert.equal(adminNotificationUrl(null, 'acme'), 'http://localhost:3000/tenant-admin.html?tenant=acme');
});

test('tenantBoardEntryUrl baut den Deep-Link aufs öffentliche Tenant-Board', () => {
  assert.equal(
    tenantBoardEntryUrl('https://roadlight.pro', 'acme', 'app-1', 'sug-123'),
    'https://roadlight.pro/acme/app-1/t/sug-123'
  );
  // Ohne App-Slug bleibt nur die Board-Übersicht.
  assert.equal(tenantBoardEntryUrl('https://roadlight.pro', 'acme', null, 'sug-123'), 'https://roadlight.pro/acme');
  // Ohne Tenant-Slug gibt es keinen Link (Aufrufer nutzt Legacy-Default).
  assert.equal(tenantBoardEntryUrl('https://roadlight.pro', null, 'app-1', 'sug-123'), null);
  // Segmente werden einzeln enkodiert.
  assert.equal(
    tenantBoardEntryUrl('https://roadlight.pro/', 'a cme', 'b/oard', 'id 9'),
    'https://roadlight.pro/a%20cme/b%2Foard/t/id%209'
  );
});

test('keine E-Mail nennt mehr "Voting Tool" oder dupliziert die Absenderzeile', () => {
  assert.equal(apiSource.includes('Voting Tool'), false, 'altes Branding entfernt');
  assert.equal(apiSource.includes("process.env.EMAIL_FROM || 'onboarding@resend.dev'"), false,
    'Absenderadresse läuft jetzt über senderAddress()');
});

const LEGACY_MAIL = {
  entryId: 'e1', title: 'Beispieltitel', appName: 'Beispiel-App', entryType: 'feature', status: 'ist umgesetzt',
};

test('Mail zum alten Board sieht aus wie im alten Stand, Link auf votingtool.benkohler.de', () => {
  // Fixture: die Vorlage aus origin/legacy-stable, mit Platzhaltern ausgewertet.
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'legacy-status-mail.html'), 'utf8');

  const mail = buildLegacyStatusMail(LEGACY_MAIL);

  assert.equal(mail.html, fixture);
  assert.equal(mail.subject, 'Ihr Vorschlag "Beispieltitel" - Status aktualisiert');
  assert.ok(mail.html.includes('href="https://votingtool.benkohler.de/#suggestion-e1"'));
  assert.ok(mail.html.includes('<strong>Typ:</strong> Vorschlag'));
});

test('Mail zum alten Board maskiert Werte, Link und Absender kommen nie aus BASE_URL', () => {
  const mail = buildLegacyStatusMail({
    ...LEGACY_MAIL, entryType: 'bug', title: '<b>fett</b>', appName: 'A & "B"', status: '<i>x</i>',
  });

  assert.ok(mail.html.includes('&lt;b&gt;fett&lt;/b&gt;'));
  assert.ok(mail.html.includes('A &amp; &quot;B&quot;'));
  assert.ok(mail.html.includes('Neuer Status: &lt;i&gt;x&lt;/i&gt;'));
  assert.equal(/<b>|<i>/.test(mail.html), false);
  assert.equal(mail.html.includes('localhost'), false);
  assert.equal(mail.subject, 'Ihr Bug "<b>fett</b>" - Status aktualisiert');
});

test('legacySenderAddress kommt nur aus LEGACY_EMAIL_FROM', () => {
  const before = { legacy: process.env.LEGACY_EMAIL_FROM, from: process.env.EMAIL_FROM };
  try {
    process.env.EMAIL_FROM = 'Roadlight <hallo@example.test>';
    delete process.env.LEGACY_EMAIL_FROM;
    assert.equal(legacySenderAddress(), null);
    process.env.LEGACY_EMAIL_FROM = '   ';
    assert.equal(legacySenderAddress(), null);
    process.env.LEGACY_EMAIL_FROM = '  Altes Board <alt@example.test> ';
    assert.equal(legacySenderAddress(), 'Altes Board <alt@example.test>');
  } finally {
    for (const [name, value] of [['LEGACY_EMAIL_FROM', before.legacy], ['EMAIL_FROM', before.from]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

for (const [type, label] of [['ticket', 'Ticket'], ['bug', 'Bug'], ['feature', 'Vorschlag']]) {
  test(`Workspace-Mail (${label}) gleicht der Mail der Statusroute`, async () => {
    reset();
    seed('tenants', 't1', { slug: 'acme', status: 'active', name: 'Acme' });
    seed('apps', 'a1', { tenantId: 't1', slug: 'board', name: 'Board & <Co>' });
    seed('suggestions', 's1', {
      tenantId: 't1', appId: 'a1', type, title: 'Titel <mit> "Zeichen"', status: 'neu', approved: true,
      notificationEnabled: true, notificationEmail: 'person@example.test',
    });
    const server = await startApp();
    try {
      const res = await server.request('/api/admin/tenants/acme/suggestions/s1/status', {
        method: 'PUT',
        body: { status: type === 'feature' ? 'ist umgesetzt' : 'gelöst' },
        headers: { authorization: 'Bearer test-admin-password' },
      });
      assert.equal(res.status, 200, res.text);
    } finally {
      await server.close();
    }

    assert.equal(sentMails.length, 1);
    const mail = buildTenantStatusMail({
      title: 'Titel <mit> "Zeichen"', appName: 'Board & <Co>', entryType: type,
      status: type === 'feature' ? 'ist umgesetzt' : 'gelöst',
      entryUrl: tenantBoardEntryUrl(process.env.BASE_URL, 'acme', 'board', 's1'),
    });
    assert.deepEqual(
      { subject: mail.subject, html: mail.html, from: senderAddress() },
      { subject: sentMails[0].subject, html: sentMails[0].html, from: sentMails[0].from }
    );
  });
}
