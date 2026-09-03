'use strict';

const fs = require('fs');
const path = require('path');

// Feste, nicht-datei-basierte Präfixe, die niemals ein Tenant-Board sein dürfen.
const NON_FILE_RESERVED = ['api', 'fonts'];

// Reservierte erste Pfadsegmente = Namen aller ausgelieferten HTML-Seiten
// (aus public/, einmalig zur Ladezeit) plus die festen Präfixe oben. Dadurch
// muss die Liste bei einer neuen public/*.html-Seite NICHT von Hand gepflegt
// werden — eine neue Seite wird automatisch reserviert und nicht fälschlich als
// Tenant-Slug interpretiert. Schützt u.a. den unangetasteten Legacy-Pfad.
function buildReservedSegments(publicDir) {
    const reserved = new Set(NON_FILE_RESERVED);
    try {
        for (const file of fs.readdirSync(publicDir)) {
            if (file.endsWith('.html') && file !== 'index.html') {
                reserved.add(file.slice(0, -'.html'.length));
            }
        }
    } catch (err) {
        // Ohne lesbares public/-Verzeichnis bleiben nur die festen Präfixe reserviert.
    }
    return reserved;
}

const RESERVED_FIRST_SEGMENTS = buildReservedSegments(path.join(__dirname, '../public'));

// Entscheidet, ob ein Request die öffentliche Board-SPA (index.html) bekommen
// soll. Nur GET/HEAD auf tenant-artige Pfade ohne Dateiendung. Alles andere
// (API, statische Dateien, reservierte Seiten) fällt durch zur nächsten Route.
function shouldServeAppShell(method, pathname) {
    if (method !== 'GET' && method !== 'HEAD') return false;

    const p = String(pathname || '');
    if (!p.startsWith('/')) return false;
    if (p.startsWith('/api/') || p === '/api') return false;

    const segments = p.split('/').filter(Boolean);
    if (segments.length === 0) return false; // "/" liefert die Landingpage (eigene Route)

    if (RESERVED_FIRST_SEGMENTS.has(segments[0])) return false;

    // Pfade mit Dateiendung sind statische Assets (die express.static bereits
    // versucht hat); nicht auf die Shell umbiegen, sondern 404 durchreichen.
    if (segments.some((segment) => segment.includes('.'))) return false;

    // Nur die dokumentierten Board-Formen bekommen die Shell; alles andere
    // (z.B. tiefere oder unbekannte Pfade) fällt durch zu 404.
    //   /{tenant}                          -> 1 Segment
    //   /{tenant}/{board}                  -> 2 Segmente
    //   /{tenant}/{board}/roadmap|changelog-> 3 Segmente
    //   /{tenant}/{board}/t/{id}           -> 4 Segmente (Marker "t")
    if (segments.length === 1 || segments.length === 2) return true;
    if (segments.length === 3) return segments[2] === 'roadmap' || segments[2] === 'changelog';
    if (segments.length === 4) return segments[2] === 't';
    return false;
}

// Express liefert bei wiederholtem Parameter ein Array. URLSearchParams.get()
// in url-state.js nimmt den ersten Wert — hier dieselbe Regel, damit Server und
// Client denselben Link gleich beurteilen.
function firstQueryValue(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' ? raw.trim() : '';
}

// Query-basierte Deep-Links auf "/" benennen ein Board, keine Landingpage:
//   ?appId=<docId>            -> Legacy-Board (public/url-state.js: buildUrlState)
//   ?tenant=<slug>[&app=…]    -> Tenant-Board, alte Form vor den Pfad-URLs
// Diese Links stecken in ausgelieferten App-Builds (FamilyManager, GymBo) und
// lassen sich nicht nachtraeglich aendern. Ohne diese Weiche liefert "/" die
// Landingpage und der Link zeigt Marketing statt Board.
//
// "app" allein zaehlt nicht: ohne tenant/appId benennt es kein Board, und
// parseUrlState wertet es dann auch nicht aus.
function isBoardDeepLinkQuery(query) {
    return ['appId', 'tenant'].some((key) => firstQueryValue(query?.[key]) !== '');
}

module.exports = {
    shouldServeAppShell,
    isBoardDeepLinkQuery,
    buildReservedSegments,
    RESERVED_FIRST_SEGMENTS,
};
