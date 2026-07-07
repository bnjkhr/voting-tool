const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { senderAddress, brandButton, wrapEmail, htmlEscape } = require('../api/email-templates');
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
  assert.equal(htmlEscape('A & B "C"'), 'A &amp; B &quot;C&quot;');
  assert.equal(htmlEscape(null), '');
});

test('keine E-Mail nennt mehr "Voting Tool" oder dupliziert die Absenderzeile', () => {
  assert.equal(apiSource.includes('Voting Tool'), false, 'altes Branding entfernt');
  assert.equal(apiSource.includes("process.env.EMAIL_FROM || 'onboarding@resend.dev'"), false,
    'Absenderadresse läuft jetzt über senderAddress()');
});
