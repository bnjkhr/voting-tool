const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');
const read = (name) => fs.readFileSync(path.join(publicDir, name), 'utf8');

const PROD_PAGES = ['index.html', 'admin.html'];

test('production pages do not load fonts from Google (no third-country IP transfer)', () => {
  for (const page of PROD_PAGES) {
    const html = read(page);
    assert.equal(html.includes('fonts.googleapis.com'), false, `${page} must not preconnect/link fonts.googleapis.com`);
    assert.equal(html.includes('fonts.gstatic.com'), false, `${page} must not load fonts.gstatic.com`);
  }
});

test('production pages load the self-hosted font stylesheet', () => {
  for (const page of PROD_PAGES) {
    assert.ok(read(page).includes('/fonts/fonts.css'), `${page} must reference the local font stylesheet`);
  }
});

test('self-hosted font CSS references only local font files', () => {
  const css = read('fonts/fonts.css');
  assert.equal(/https?:\/\//.test(css), false, 'fonts.css must not contain any external URLs');
  assert.ok(css.includes('/fonts/'), 'fonts.css must reference local /fonts/ paths');
  assert.ok(css.includes("font-family: 'DM Sans'"), 'DM Sans must be declared');
  assert.ok(css.includes("font-family: 'JetBrains Mono'"), 'JetBrains Mono must be declared');
});

test('legal pages exist', () => {
  for (const page of ['impressum.html', 'datenschutz.html']) {
    assert.ok(fs.existsSync(path.join(publicDir, page)), `${page} must exist`);
  }
});

test('public-facing pages link to Impressum and Datenschutz', () => {
  for (const page of ['index.html', 'signup.html', 'login.html']) {
    const html = read(page);
    assert.ok(html.includes('/impressum.html'), `${page} must link to the imprint`);
    assert.ok(html.includes('/datenschutz.html'), `${page} must link to the privacy policy`);
  }
});

test('signup links the privacy policy as a consent reference near the submit action', () => {
  const html = read('signup.html');
  const btnIdx = html.indexOf('id="signupBtn"');
  assert.ok(btnIdx !== -1, 'signup submit button must exist');

  // Der Consent-Hinweis muss eine echte Verlinkung zur Datenschutzerklärung sein
  // und in unmittelbarer Nähe der Absende-Aktion stehen (nicht irgendwo auf der Seite).
  const linkIdx = html.indexOf('href="/datenschutz.html"', btnIdx);
  assert.ok(linkIdx !== -1 && linkIdx - btnIdx < 600, 'privacy policy must be linked near the submit button');

  const consentIdx = html.indexOf('Datenschutzerkl', btnIdx);
  assert.ok(consentIdx !== -1 && consentIdx - btnIdx < 600, 'consent wording must sit near the submit button');
});
