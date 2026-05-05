(function initUrlState(globalScope) {
    function normalizeView(view) {
        return view === 'roadmap' || view === 'changelog' ? view : 'suggestions';
    }

    function parseUrlState(search) {
        const params = new URLSearchParams(search || '');
        const appId = (params.get('appId') || '').trim() || null;
        const tenantSlug = (params.get('tenant') || '').trim() || null;
        const appSlug = (params.get('app') || '').trim() || null;
        const view = normalizeView(params.get('view'));

        return { appId, tenantSlug, appSlug, view };
    }

    function buildUrlState(state) {
        const appId = state?.appId ? String(state.appId).trim() : '';
        const tenantSlug = state?.tenantSlug ? String(state.tenantSlug).trim() : '';
        const appSlug = state?.appSlug ? String(state.appSlug).trim() : '';
        const view = normalizeView(state?.view);

        if (tenantSlug) {
            const params = new URLSearchParams();
            params.set('tenant', tenantSlug);

            if (appSlug) {
                params.set('app', appSlug);
            }

            if (view !== 'suggestions') {
                params.set('view', view);
            }

            return `?${params.toString()}`;
        }

        if (!appId) return '';

        const params = new URLSearchParams();
        params.set('appId', appId);

        if (view !== 'suggestions') {
            params.set('view', view);
        }

        return `?${params.toString()}`;
    }

    const api = { normalizeView, parseUrlState, buildUrlState };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }

    globalScope.UrlState = api;
})(typeof window !== 'undefined' ? window : globalThis);
