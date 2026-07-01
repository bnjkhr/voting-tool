(function initUrlState(globalScope) {
    function normalizeView(view) {
        return view === 'roadmap' || view === 'changelog' ? view : 'suggestions';
    }

    // Dekodiert ein Pfadsegment, ohne es zu normalisieren: der Roh-Slug muss
    // 1:1 gegen app.slug/tenant.slug matchen können. Aggressive Normalisierung
    // (wie serverseitig in tenant-utils) würde gültige Segmente verwerfen.
    function decodeSegment(segment) {
        if (!segment) return null;
        try {
            return decodeURIComponent(segment).trim() || null;
        } catch (err) {
            return segment.trim() || null;
        }
    }

    // Zerlegt einen Board-Pfad in Segmente. Erwartetes Schema:
    //   /{tenant}/{board}                     -> Vorschläge
    //   /{tenant}/{board}/roadmap|changelog   -> Roadmap/Changelog
    //   /{tenant}/{board}/t/{suggestionId}    -> einzelner Eintrag
    //   /{tenant}                             -> Board-Übersicht des Tenants
    function parsePathSegments(segments) {
        const tenantSlug = decodeSegment(segments[0]);
        if (!tenantSlug) {
            return { appId: null, tenantSlug: null, appSlug: null, view: 'suggestions', suggestionId: null };
        }

        const appSlug = segments.length > 1 ? decodeSegment(segments[1]) : null;
        const rest = segments.slice(2);

        let view = 'suggestions';
        let suggestionId = null;

        if (rest[0] === 't' && rest[1]) {
            suggestionId = decodeSegment(rest[1]);
        } else if (rest[0]) {
            view = normalizeView(rest[0]);
        }

        return { appId: null, tenantSlug, appSlug, view, suggestionId };
    }

    // Rückwärtskompatibel: alte Deep-Links kamen als Query-Parameter
    //   ?tenant=slug&app=board&view=roadmap   (Tenant)
    //   ?appId=<docId>&view=roadmap           (Legacy)
    function parseQueryState(search) {
        const params = new URLSearchParams(search || '');
        const tenantSlug = (params.get('tenant') || '').trim() || null;
        const appSlug = (params.get('app') || '').trim() || null;
        const appId = (params.get('appId') || '').trim() || null;
        const view = normalizeView(params.get('view'));

        return { appId, tenantSlug, appSlug, view, suggestionId: null };
    }

    function parseUrlState(pathname, search) {
        const segments = String(pathname || '')
            .split('/')
            .filter(Boolean);

        // "/" und "/index.html" verhalten sich gleich: kein Board-Pfad, sondern
        // Root -> alte Query-Deep-Links (?tenant/?app/?appId) auswerten.
        if (segments.length === 0 || (segments.length === 1 && segments[0] === 'index.html')) {
            return parseQueryState(search);
        }

        return parsePathSegments(segments);
    }

    function encodeSegment(value) {
        return encodeURIComponent(String(value).trim());
    }

    // Baut die kanonische URL (Pfad) für einen Zustand.
    // Tenant -> Pfadsegmente; Legacy (nur appId) -> Root + Query.
    function buildUrlState(state) {
        const tenantSlug = state?.tenantSlug ? String(state.tenantSlug).trim() : '';
        const appSlug = state?.appSlug ? String(state.appSlug).trim() : '';
        const appId = state?.appId ? String(state.appId).trim() : '';
        const suggestionId = state?.suggestionId ? String(state.suggestionId).trim() : '';
        const view = normalizeView(state?.view);

        if (tenantSlug) {
            let path = `/${encodeSegment(tenantSlug)}`;
            if (appSlug) {
                path += `/${encodeSegment(appSlug)}`;
                if (suggestionId) {
                    path += `/t/${encodeSegment(suggestionId)}`;
                } else if (view !== 'suggestions') {
                    path += `/${view}`;
                }
            }
            return path;
        }

        if (appId) {
            const params = new URLSearchParams();
            params.set('appId', appId);
            if (view !== 'suggestions') {
                params.set('view', view);
            }
            return `/?${params.toString()}`;
        }

        return '/';
    }

    const api = { normalizeView, parseUrlState, buildUrlState };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    globalScope.UrlState = api;
})(typeof window !== 'undefined' ? window : globalThis);
