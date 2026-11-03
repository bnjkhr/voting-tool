// Link-Vorschau (Open Graph / Twitter Card) für die Board-Shell.
// Crawler von iMessage, WhatsApp, Slack, Threads oder LinkedIn führen kein
// JavaScript aus. Titel, Beschreibung und Bild müssen deshalb schon im
// ausgelieferten HTML stehen, passend zur App (?appId=…) und zur Ansicht
// (view=changelog → „Was ist neu“, sonst Wünsche).
//
// Liegt in lib/, nicht api/: jede Datei in api/ wird auf Vercel eine eigene
// Serverless Function (siehe lib/frame-policy.js).

const fs = require('fs');
const path = require('path');
const { htmlEscape } = require('../api/email-templates');

const OG_DIR = path.join(__dirname, '../public/og');
const DEFAULT_IMAGE = 'default.png';
const META_START = '<!-- og:start -->';
const META_END = '<!-- og:end -->';
const HOST_PATTERN = /^[a-z0-9.-]+(:\d+)?$/i;

// Bild je App über den Slug (public/og/<slug>.png), sonst das neutrale Bild.
// Der Ordner ändert sich nur mit einem Deploy, darum einmal beim Laden lesen.
const OG_IMAGES = new Set(fs.readdirSync(OG_DIR));

function ogImageFor(app) {
  const file = app && typeof app.slug === 'string' ? `${app.slug}.png` : '';
  return OG_IMAGES.has(file) ? file : DEFAULT_IMAGE;
}

// Origin aus dem Host der Anfrage: geteilte Links laufen über
// votingtool.benkohler.de und roadlight.pro. Ungültige Hosts fallen auf
// relative URLs zurück, statt fremde Zeichen ins HTML zu tragen.
function requestOrigin(headers = {}) {
  const raw = String(headers['x-forwarded-host'] || headers.host || '').split(',')[0].trim();
  return HOST_PATTERN.test(raw) ? `https://${raw.toLowerCase()}` : '';
}

function buildBoardMeta({ app = null, view = '', origin = '', url = '/' } = {}) {
  let title = 'Feedback Board';
  let description = 'Wünsche vorschlagen, Fehler melden und sehen, was neu ist.';

  const name = app && typeof app.name === 'string' ? app.name.trim() : '';
  if (name && view === 'changelog') {
    title = `Was ist neu in ${name}`;
    description = `Alle Versionen von ${name} mit ihren Neuerungen und Fehlerbehebungen. Hier siehst du auch, woran ich gerade arbeite.`;
  } else if (name) {
    title = `${name}: Wünsche und Fehler`;
    description = 'Schlag neue Funktionen vor, melde Fehler und stimm für die Wünsche anderer ab. Ich lese alles mit.';
  }

  return {
    title,
    description,
    image: `${origin}/og/${ogImageFor(app)}`,
    url: `${origin}${url}`,
  };
}

function renderMetaTags(meta) {
  const t = htmlEscape(meta.title);
  const d = htmlEscape(meta.description);
  const i = htmlEscape(meta.image);
  const u = htmlEscape(meta.url);
  return [
    META_START,
    `<title>${t}</title>`,
    `<meta name="description" content="${d}">`,
    '<meta property="og:type" content="website">',
    `<meta property="og:url" content="${u}">`,
    `<meta property="og:title" content="${t}">`,
    `<meta property="og:description" content="${d}">`,
    `<meta property="og:image" content="${i}">`,
    '<meta property="og:image:width" content="1200">',
    '<meta property="og:image:height" content="630">',
    '<meta property="og:locale" content="de_DE">',
    '<meta name="twitter:card" content="summary_large_image">',
    `<meta name="twitter:title" content="${t}">`,
    `<meta name="twitter:description" content="${d}">`,
    `<meta name="twitter:image" content="${i}">`,
    META_END,
  ].join('\n    ');
}

const META_PATTERN = new RegExp(`${META_START}[\\s\\S]*?${META_END}`);

// Für Vergleiche „ist das die Shell?“ in Tests: Block ohne Vorschau-Tags.
function stripBoardMeta(html) {
  return html.replace(META_PATTERN, '');
}

// Ersetzt den markierten Block in public/index.html. Fehlen die Marker,
// bleibt das HTML unverändert (lieber keine Vorschau als eine kaputte Seite).
function injectBoardMeta(html, meta) {
  const start = html.indexOf(META_START);
  const end = html.indexOf(META_END);
  if (start === -1 || end === -1 || end < start) return html;
  return html.slice(0, start) + renderMetaTags(meta) + html.slice(end + META_END.length);
}

module.exports = {
  buildBoardMeta,
  injectBoardMeta,
  requestOrigin,
  stripBoardMeta,
};
