// Einbettung der öffentlichen Board-Shell (public/index.html) per iframe.
//
// Global gilt X-Frame-Options: SAMEORIGIN (Clickjacking-Schutz für Admin-,
// Login- und Signup-Seiten). Die Board-Shell wird aber in Apps eingebettet,
// z. B. im „Vorschlag einreichen"-Dialog von familymanager.pro. X-Frame-Options
// kennt keine Freigabeliste, darum bekommt nur die Shell stattdessen
// Content-Security-Policy: frame-ancestors mit erlaubten Origins.
//
// Weitere Origins per BOARD_FRAME_ANCESTORS (kommagetrennt, z. B.
// "https://example.com,https://app.example.com").

const DEFAULT_BOARD_FRAME_ANCESTORS = [
  'https://familymanager.pro',
  'https://www.familymanager.pro',
];

// Nur https-Origins ohne Pfad, damit kein Eintrag die Policy aufbricht
// (Leerzeichen, Semikolon, Wildcards wie "*").
const ORIGIN_PATTERN = /^https:\/\/[a-z0-9.-]+(:\d+)?$/i;

function boardFrameAncestors(env = process.env) {
  const extra = String(env.BOARD_FRAME_ANCESTORS || '')
    .split(',')
    .map((origin) => origin.trim().replace(/\/+$/, ''))
    .filter((origin) => ORIGIN_PATTERN.test(origin));
  return [...new Set([...DEFAULT_BOARD_FRAME_ANCESTORS, ...extra])];
}

function allowBoardEmbedding(res, env = process.env) {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${boardFrameAncestors(env).join(' ')}`);
}

module.exports = { DEFAULT_BOARD_FRAME_ANCESTORS, boardFrameAncestors, allowBoardEmbedding };
