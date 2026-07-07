'use strict';

// Gemeinsames, gebrandetes E-Mail-Layout (Roadlight). Inline-Styles + Arial-
// Fallback für maximale Client-Kompatibilität; Marken-Terracotta als Akzent.

// Isomorphe Single-Source-of-Truth für Board-Pfade (dieselbe Datei, die der
// Browser lädt) — hält Mail-Deep-Links und SPA-Routing garantiert im Gleichlauf.
const { buildUrlState } = require('../public/url-state');

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

module.exports = {
  BRAND,
  senderAddress,
  brandButton,
  wrapEmail,
  htmlEscape,
  adminNotificationUrl,
  tenantBoardEntryUrl,
};
