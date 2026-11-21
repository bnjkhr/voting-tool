// Kanonischer Host für die Anmeldung. Die Session liegt im localStorage und
// ist damit an die Origin gebunden; die Konsole läuft auf app.roadlight.pro.
// Eine Anmeldung auf roadlight.pro würde dort nie wiedererkannt. Liegt in
// lib/, nicht api/ (Vercel-Limit von 12 Serverless Functions).

const MARKETING_HOST = 'roadlight.pro';
// Seiten, die auf dem Konsolen-Host laufen müssen (Session je Origin).
const CONSOLE_PATHS = new Set(['/login.html', '/accept-invite.html', '/tenant-admin.html']);
const CONSOLE_ORIGIN = 'https://app.roadlight.pro';

function requestHost(headers = {}) {
  const raw = headers['x-forwarded-host'] || headers.host || '';
  const first = String(Array.isArray(raw) ? raw[0] : raw).split(',')[0];
  return first.trim().toLowerCase().replace(/:\d+$/, '');
}

// Liefert die Ziel-URL (inkl. unverändertem Query-String) oder null.
function canonicalLoginRedirect(headers, originalUrl) {
  if (requestHost(headers) !== MARKETING_HOST) return null;
  const url = String(originalUrl || '');
  const queryIndex = url.indexOf('?');
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
  if (!CONSOLE_PATHS.has(pathname)) return null;
  const query = queryIndex === -1 ? '' : url.slice(queryIndex);
  return `${CONSOLE_ORIGIN}${pathname}${query}`;
}

module.exports = { canonicalLoginRedirect, requestHost };
