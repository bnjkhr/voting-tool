// Bot-Schutz für öffentliche Formulare, Gegenstück zu lib/bot-protection.js:
// misst die Ausfüllzeit, liest das Honeypot-Feld und rendert Cloudflare
// Turnstile, sobald der Server einen Site-Key liefert.
class FormGuard {
    // action muss zur Action passen, die der Server für dieses Formular erwartet.
    constructor(form, action) {
        this.form = form;
        this.action = action;
        this.startedAt = Date.now();
        this.turnstileToken = '';
        this.turnstileRequired = false;
        this.widgetId = null;
        this.loadTurnstile();
    }

    static NOT_READY_MESSAGE = 'Die Bot-Prüfung ist noch nicht abgeschlossen. Falls sie nicht erscheint, deaktiviere bitte Content-Blocker für diese Seite.';

    async loadTurnstile() {
        const container = this.form.querySelector('[data-turnstile]');
        if (!container) return;

        try {
            const response = await fetch('/api/auth/bot-protection');
            const { turnstileSiteKey } = await response.json();
            if (!turnstileSiteKey) return;
            // Ab hier verlangt der Server ein Token, auch wenn das Skript gleich
            // an einem Content-Blocker scheitert.
            this.turnstileRequired = true;

            await new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
                script.onload = resolve;
                script.onerror = reject;
                document.head.appendChild(script);
            });
            this.widgetId = window.turnstile.render(container, {
                sitekey: turnstileSiteKey,
                action: this.action,
                language: 'de',
                callback: token => { this.turnstileToken = token; },
                'expired-callback': () => { this.turnstileToken = ''; },
            });
        } catch (error) {
            console.warn('Turnstile konnte nicht geladen werden:', error);
        }
    }

    // false, solange Turnstile aktiv ist und noch kein Token vorliegt.
    isReady() {
        return !this.turnstileRequired || Boolean(this.turnstileToken);
    }

    fields() {
        return {
            website: this.form.elements.website.value,
            formElapsedMs: Date.now() - this.startedAt,
            turnstileToken: this.turnstileToken,
        };
    }

    // Turnstile-Tokens gelten nur einmal: nach jedem Absenden neu anfordern.
    reset() {
        if (this.widgetId !== null) window.turnstile.reset(this.widgetId);
        this.turnstileToken = '';
    }
}
