(function initUrlState(globalScope) {
    function normalizeView(view) {
        return view === 'roadmap' || view === 'changelog' ? view : 'suggestions';
    }

    function parseUrlState(search) {
        const params = new URLSearchParams(search || '');
        const appId = (params.get('appId') || '').trim() || null;
        const view = normalizeView(params.get('view'));

        return { appId, view };
    }

    function buildUrlState(state) {
        const appId = state?.appId ? String(state.appId).trim() : '';
        const view = normalizeView(state?.view);

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
