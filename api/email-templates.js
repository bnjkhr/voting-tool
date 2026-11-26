'use strict';

// Gemeinsames, gebrandetes E-Mail-Layout (Roadlight). Inline-Styles + Arial-
// Fallback für maximale Client-Kompatibilität; Marken-Terracotta als Akzent.

// Isomorphe Single-Source-of-Truth für Board-Pfade (dieselbe Datei, die der
// Browser lädt) — hält Mail-Deep-Links und SPA-Routing garantiert im Gleichlauf.
const { buildUrlState } = require('../public/url-state');
const { LEGACY_BOARD_BASE } = require('../lib/feedback-links');

const BRAND = {
  primary: '#E06A3A',
  text: '#1A1A1A',
  secondary: '#6B6560',
  muted: '#A49E96',
  bg: '#FAF8F5',
  surface: '#FFFFFF',
  border: '#E8E4DD',
};

function senderAddress() {
  return process.env.EMAIL_FROM || 'Roadlight <onboarding@resend.dev>';
}

// Escaped von Nutzern stammende Werte, bevor sie in Mail-HTML interpoliert
// werden (verhindert kaputtes HTML / HTML-Injektion in Transaktions-Mails).
function htmlEscape(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Baut die Ziel-URL für Admin-Benachrichtigungen. Tenant-Boards zeigen auf die
// Tenant-Konsole; der Legacy-Pfad (kein Slug) bleibt beim passwortgeschützten
// /admin.html.
function adminNotificationUrl(baseUrl, tenantSlug = null) {
  const base = (baseUrl || 'http://localhost:3000').replace(/\/+$/, '');
  return tenantSlug
    ? `${base}/tenant-admin.html?tenant=${encodeURIComponent(tenantSlug)}`
    : `${base}/admin.html`;
}

// Baut den Deep-Link auf einen einzelnen Eintrag im öffentlichen Tenant-Board.
// Das Pfadschema (/{tenant}/{app}/t/{id}, Board-Übersicht ohne App-Slug) kommt
// aus buildUrlState — kein zweites, driftgefährdetes Schema. Ohne Tenant-Slug
// gibt es keinen Tenant-Link (der Aufrufer nutzt dann den Legacy-Default).
function tenantBoardEntryUrl(baseUrl, tenantSlug, appSlug, suggestionId) {
  if (!tenantSlug) return null;
  const base = (baseUrl || 'http://localhost:3000').replace(/\/+$/, '');
  return `${base}${buildUrlState({ tenantSlug, appSlug, suggestionId })}`;
}

function brandButton(url, label) {
  return `<a href="${url}" style="display:inline-block;background:${BRAND.primary};color:#ffffff;`
    + `padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold;`
    + `font-family:Arial,Helvetica,sans-serif;font-size:15px;">${label}</a>`;
}

// Umschließt den Body-HTML mit Header (Wortmarke), Karte und Footer.
function wrapEmail({ heading, bodyHtml, footnote }) {
  return `
    <div style="background:${BRAND.bg};padding:24px 12px;font-family:Arial,Helvetica,sans-serif;">
      <div style="max-width:520px;margin:0 auto;background:${BRAND.surface};border:1px solid ${BRAND.border};border-radius:14px;overflow:hidden;">
        <div style="padding:18px 28px;border-bottom:1px solid ${BRAND.border};">
          <span style="font-size:18px;font-weight:bold;color:${BRAND.text};">Roadlight</span>
        </div>
        <div style="padding:28px;color:${BRAND.text};font-size:15px;line-height:1.6;">
          <h2 style="margin:0 0 14px;font-size:20px;color:${BRAND.text};">${heading}</h2>
          ${bodyHtml}
          ${footnote ? `<p style="color:${BRAND.secondary};font-size:13px;margin-top:22px;">${footnote}</p>` : ''}
        </div>
        <div style="padding:16px 28px;border-top:1px solid ${BRAND.border};color:${BRAND.muted};font-size:12px;">
          Roadlight · <a href="https://roadlight.pro" style="color:${BRAND.secondary};text-decoration:none;">roadlight.pro</a>
        </div>
      </div>
    </div>`;
}

const ENTRY_LABELS = { bug: 'Bug', ticket: 'Ticket', feature: 'Vorschlag' };

// Absender für Mails zum alten Board. Bewusst ohne Rückfall auf EMAIL_FROM:
// Diese Mails kommen nie vom Roadlight-Absender.
function legacySenderAddress() {
  return (process.env.LEGACY_EMAIL_FROM || '').trim() || null;
}

// Statusmail zum alten Board: Markup, Betreff, Anrede und Farben wörtlich wie
// sendUserNotificationEmail im alten Stand (legacy-stable), nur maskiert und mit
// festem Link aufs alte Board.
function buildLegacyStatusMail({ entryId, title, appName, entryType, status }) {
  const entryLabel = ENTRY_LABELS[entryType] || 'Eintrag';
  const statusText = 'Status aktualisiert';
  const statusColor = '#6366f1';
  const comment = `Neuer Status: ${status}`;
  const suggestionUrl = `${LEGACY_BOARD_BASE}/#suggestion-${htmlEscape(entryId)}`;
  return {
    subject: `Ihr ${entryLabel} "${title}" - ${statusText}`,
    html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #333;">Update zu Ihrem ${entryLabel}</h2>
          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3 style="margin-top: 0; color: ${statusColor};">${statusText}</h3>
            <p><strong>${entryLabel}:</strong> ${htmlEscape(title)}</p>
            <p><strong>App:</strong> ${htmlEscape(appName)}</p>
            <p><strong>Typ:</strong> ${entryLabel}</p>
            ${comment ? `<p><strong>Kommentar:</strong> ${htmlEscape(comment)}</p>` : ''}
          </div>
          <p><a href="${suggestionUrl}" style="background-color: #007bff; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px;">Eintrag ansehen</a></p>
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #dee2e6;">
          <p style="color: #6c757d; font-size: 12px;">
            Sie erhalten diese E-Mail, weil Sie Benachrichtigungen für diesen Eintrag aktiviert haben.
          </p>
        </div>
      `,
  };
}

// Statusmail zu einem Eintrag auf einem Roadlight-Board, gleich der Mail, die
// die Statusroute des Workspaces über sendUserNotificationEmail verschickt.
function buildTenantStatusMail({ title, appName, entryType, status, entryUrl }) {
  const entryLabel = ENTRY_LABELS[entryType] || 'Eintrag';
  const statusText = 'Status aktualisiert';
  const comment = `Neuer Status: ${status}`;
  return {
    subject: `Dein ${entryLabel} "${title}" – ${statusText}`,
    html: wrapEmail({
      heading: `Update zu deinem ${entryLabel}`,
      bodyHtml: `
          <p style="margin:0 0 12px;font-weight:bold;color:#E06A3A;">${statusText}</p>
          <p style="margin:4px 0;"><strong>${entryLabel}:</strong> ${htmlEscape(title)}</p>
          <p style="margin:4px 0;"><strong>App:</strong> ${htmlEscape(appName)}</p>
          ${comment ? `<p style="margin:4px 0;"><strong>Kommentar:</strong> ${htmlEscape(comment)}</p>` : ''}
          <p style="margin:20px 0 0;">${brandButton(entryUrl, 'Eintrag ansehen')}</p>`,
      footnote: 'Du erhältst diese E-Mail, weil du Benachrichtigungen für diesen Eintrag aktiviert hast.',
    }),
  };
}

module.exports = {
  BRAND,
  senderAddress,
  brandButton,
  wrapEmail,
  htmlEscape,
  adminNotificationUrl,
  tenantBoardEntryUrl,
  legacySenderAddress,
  buildLegacyStatusMail,
  buildTenantStatusMail,
};
