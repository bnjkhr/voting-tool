'use strict';

// Bot-Schutz für die öffentlichen Formulare (Signup, Login-Link-Anforderung).
//
// Hintergrund: Bots haben mit Zufallsnamen Workspaces angelegt und dabei echte,
// fremde E-Mail-Adressen eingetragen. Jede Anmeldung und jede Login-Link-
// Anforderung verschickt eine Mail an Unbeteiligte und kostet Reputation beim
// Resend-Absender. Die IP-Rate-Limits in api/index.js allein reichen nicht:
// sie leben pro Serverless-Instanz im Speicher, und Bots rotieren IPs.
//
// Drei Schichten, alle ohne neue Serverless Function:
//   1. Honeypot-Feld: für Menschen unsichtbar, Bots füllen es aus.
//   2. Mindest-Ausfüllzeit: das Formular misst die Zeit seit dem Laden.
//   3. Cloudflare Turnstile: nur aktiv, wenn TURNSTILE_SITE_KEY und
//      TURNSTILE_SECRET_KEY gesetzt sind. Die Prüfung folgt Cloudflares
//      Vorgabe: success, erwartete action und erlaubter hostname
//      (TURNSTILE_HOSTNAMES, kommagetrennt, in Produktion ohne localhost).
// Dazu das Limit pro E-Mail-Adresse (isEmailQuotaExceeded), gezählt über die
// login_links in der DB, damit es instanzübergreifend greift.

const HONEYPOT_FIELD = 'website';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TURNSTILE_TIMEOUT_MS = 10_000;
const TURNSTILE_TOKEN_MAX_LENGTH = 2048;

// Höchstens so viele Login-Links pro E-Mail-Adresse im jeweiligen Fenster.
const EMAIL_QUOTA_WINDOWS = [
  { windowMs: 15 * 60 * 1000, max: 3 },
  { windowMs: 24 * 60 * 60 * 1000, max: 10 },
];
const EMAIL_QUOTA_LOOKBACK_MS = Math.max(...EMAIL_QUOTA_WINDOWS.map((w) => w.windowMs));

const BOT_CHECK_FAILED = {
  error: 'Die Anfrage konnte nicht verarbeitet werden. Bitte lade die Seite neu und versuche es erneut.',
  code: 'bot_check_failed',
};

function turnstileConfig(env = process.env) {
  const siteKey = env.TURNSTILE_SITE_KEY;
  const secretKey = env.TURNSTILE_SECRET_KEY;
  // Nur beide Schlüssel zusammen schalten Turnstile scharf. Ein Secret ohne
  // Site-Key würde sonst jede Anfrage abweisen, weil kein Widget rendert.
  if (!siteKey || !secretKey) return null;
  const hostnames = new Set(
    String(env.TURNSTILE_HOSTNAMES || '').split(',').map((hostname) => hostname.trim()).filter(Boolean)
  );
  return { siteKey, secretKey, hostnames };
}

// Liefert den Grund der Abweisung oder null.
function detectBotSignals(body = {}, { minFillMs }) {
  if (String(body[HONEYPOT_FIELD] || '').trim() !== '') {
    return 'honeypot';
  }
  const elapsed = Number(body.formElapsedMs);
  if (!Number.isFinite(elapsed) || elapsed < minFillMs) {
    return 'too_fast';
  }
  return null;
}

// Liefert den Grund der Abweisung oder null. Im Zweifel wird abgewiesen, auch
// wenn Cloudflare nicht erreichbar ist.
async function verifyTurnstile(token, remoteIp, { secretKey, action, hostnames, fetchImpl = fetch }) {
  if (typeof token !== 'string' || token.length === 0 || token.length > TURNSTILE_TOKEN_MAX_LENGTH) {
    return 'turnstile_missing';
  }
  if (hostnames.size === 0) {
    console.error('Turnstile ist aktiv, aber TURNSTILE_HOSTNAMES ist leer: Anfrage abgewiesen.');
    return 'turnstile_hostnames_missing';
  }

  const form = new URLSearchParams({ secret: secretKey, response: token });
  if (remoteIp) form.set('remoteip', remoteIp);

  let result;
  try {
    const response = await fetchImpl(TURNSTILE_VERIFY_URL, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`siteverify ${response.status}`);
    result = await response.json();
  } catch (error) {
    console.error('Turnstile-Prüfung fehlgeschlagen, Anfrage abgewiesen:', error.message);
    return 'turnstile_unreachable';
  }

  if (!result || result.success !== true) return 'turnstile_failed';
  if (result.action !== action) return 'turnstile_action';
  if (!hostnames.has(result.hostname)) return 'turnstile_hostname';
  return null;
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '');
  return forwarded.split(',')[0].trim() || req.socket?.remoteAddress || '';
}

// Express-Middleware für ein öffentliches Formular-Endpoint. `action` muss zu
// der Action passen, mit der das Formular sein Turnstile-Widget rendert.
function requireHumanForm({ minFillMs, action, env = process.env, fetchImpl } = {}) {
  return async (req, res, next) => {
    let reason = detectBotSignals(req.body || {}, { minFillMs });
    const turnstile = turnstileConfig(env);
    if (!reason && turnstile) {
      reason = await verifyTurnstile(req.body?.turnstileToken, clientIp(req), {
        secretKey: turnstile.secretKey,
        hostnames: turnstile.hostnames,
        action,
        fetchImpl,
      });
    }
    if (reason) {
      // Bewusst ohne E-Mail-Adresse: die gehört meist Unbeteiligten.
      console.warn(`Bot-Schutz: ${req.method} ${req.path} abgewiesen (${reason})`);
      return res.status(400).json(BOT_CHECK_FAILED);
    }
    return next();
  };
}

// createdAtList: Erstellzeitpunkte der Login-Links dieser Adresse, mindestens
// für EMAIL_QUOTA_LOOKBACK_MS.
function isEmailQuotaExceeded(createdAtList, now = new Date()) {
  const times = createdAtList.map((value) => new Date(value).getTime());
  return EMAIL_QUOTA_WINDOWS.some(({ windowMs, max }) => {
    const since = now.getTime() - windowMs;
    return times.filter((time) => time > since).length >= max;
  });
}

module.exports = {
  BOT_CHECK_FAILED,
  EMAIL_QUOTA_LOOKBACK_MS,
  HONEYPOT_FIELD,
  detectBotSignals,
  isEmailQuotaExceeded,
  requireHumanForm,
  turnstileConfig,
  verifyTurnstile,
};
