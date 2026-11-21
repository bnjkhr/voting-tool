class LoginApp {
    constructor() {
        const params = new URLSearchParams(window.location.search);
        this.token = params.get('token') || '';
        this.redirectUrl = params.get('redirect') || '';
        this.form = document.getElementById('loginForm');
        this.status = document.getElementById('loginStatus');
        this.result = document.getElementById('loginResult');
        this.submitButton = document.getElementById('loginBtn');
        this.consumeButton = document.getElementById('consumeBtn');
        this.sessionNotice = document.getElementById('sessionNotice');
        this.sessionNoticeText = document.getElementById('sessionNoticeText');
        this.init();
    }

    init() {
        this.form.addEventListener('submit', event => {
            event.preventDefault();
            this.requestLoginLink();
        });

        if (this.token) {
            // Nicht automatisch einlösen: Mail-Security-Scanner öffnen Links
            // samt JavaScript und würden den Einmal-Link sonst verbrauchen.
            this.form.style.display = 'none';
            this.consumeButton.style.display = '';
            this.consumeButton.addEventListener('click', () => this.consumeLoginLink());
            this.setStatus('Klicke auf „Jetzt anmelden“, um die Anmeldung abzuschließen.', '');
            return;
        }

        const sessionToken = this.readUserSession();
        if (sessionToken) {
            this.resumeExistingSession(sessionToken);
        } else {
            this.showForm();
        }
    }

    showForm() {
        this.form.style.display = '';
        if (!this.guard) this.guard = new FormGuard(this.form, 'login');
    }

    showNoWorkspaceNotice(email) {
        if (!this.sessionNotice || !this.sessionNoticeText) return;
        const who = email ? `als ${email}` : '';
        this.sessionNoticeText.textContent =
            `Du bist ${who ? who + ' ' : ''}angemeldet, gehörst aber noch zu keinem Workspace. ` +
            'Lass dich von einer Workspace-Inhaberin einladen oder leg einen eigenen Workspace an.';
        this.sessionNotice.hidden = false;
    }

    readUserSession() {
        try {
            return window.adminAuth?.getUserSession?.() || localStorage.getItem('userSessionToken') || '';
        } catch (error) {
            return '';
        }
    }

    // Nur den Nutzer-Session-Token entfernen, nie das adminToken.
    dropUserSession() {
        try {
            localStorage.removeItem('userSessionToken');
        } catch (error) {
            // Speicher gesperrt: nichts zu entfernen.
        }
        if (window.adminAuth) window.adminAuth.userSessionToken = null;
    }

    // Nur Ziele auf derselben Origin. Der URL-Parser streicht Tab/Newline und
    // würde `/\t/evil.com` sonst zu `//evil.com`; darum die Origin nachprüfen.
    safeRedirectTarget(value) {
        if (typeof value !== 'string' || value[0] !== '/') return null;
        try {
            const url = new URL(value, window.location.origin);
            if (url.origin !== window.location.origin) return null;
            return url.pathname + url.search + url.hash;
        } catch (error) {
            return null;
        }
    }

    async resumeExistingSession(sessionToken) {
        this.form.style.display = 'none';
        this.setStatus('Du bist noch angemeldet …', '');
        try {
            const response = await fetch('/api/auth/session', {
                headers: { 'X-User-Session': sessionToken },
                signal: AbortSignal.timeout(5000),
            });
            if (response.status === 401) {
                this.dropUserSession();
                this.setStatus('', '');
                this.showForm();
                return;
            }
            if (!response.ok) throw new Error(`Session-Prüfung fehlgeschlagen (${response.status})`);

            const data = await response.json();
            const tenantSlug = data.memberships?.[0]?.tenantSlug;
            const target = this.safeRedirectTarget(this.redirectUrl);
            if (target) {
                window.location.replace(target);
            } else if (tenantSlug) {
                window.location.replace(`/tenant-admin.html?tenant=${encodeURIComponent(tenantSlug)}`);
            } else {
                // Angemeldet, aber ohne Workspace: Hinweis, Formular bleibt für ein anderes Konto.
                this.setStatus('', '');
                this.showNoWorkspaceNotice(data.user?.email);
                this.showForm();
            }
        } catch (error) {
            // Netzwerk- oder Serverfehler: Token behalten, Formular anbieten.
            this.setStatus('', '');
            this.showForm();
        }
    }

    async requestLoginLink() {
        const formData = new FormData(this.form);
        const email = (formData.get('email') || '').toString().trim();
        if (!email) {
            this.setStatus('E-Mail eingeben.', 'error');
            return;
        }
        if (!this.guard.isReady()) {
            this.setStatus(FormGuard.NOT_READY_MESSAGE, 'error');
            return;
        }

        this.submitButton.disabled = true;
        this.result.innerHTML = '';
        this.setStatus('Login-Link wird erstellt...', '');

        try {
            const response = await fetch('/api/auth/login-links', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, redirectUrl: this.redirectUrl, ...this.guard.fields() }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Login-Link konnte nicht erstellt werden');

            this.setStatus('Login-Link wurde per E-Mail verschickt.', 'success');
            this.result.innerHTML = '';
        } catch (error) {
            this.setStatus(error.message || 'Login-Link konnte nicht erstellt werden', 'error');
        } finally {
            this.submitButton.disabled = false;
            this.guard.reset();
        }
    }

    async consumeLoginLink() {
        this.consumeButton.disabled = true;
        this.setStatus('Login-Link wird geprüft...', '');

        try {
            const response = await fetch(`/api/auth/login-links/${encodeURIComponent(this.token)}/consume`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Login-Link konnte nicht verwendet werden');

            if (data.sessionToken && window.adminAuth?.setUserSession) {
                window.adminAuth.setUserSession(data.sessionToken);
            }

            // Einmal-Token aus der Adresszeile entfernen, redirect-Param behalten.
            const remaining = new URLSearchParams(window.location.search);
            remaining.delete('token');
            const query = remaining.toString();
            history.replaceState(null, '', window.location.pathname + (query ? `?${query}` : ''));

            this.consumeButton.style.display = 'none';
            this.setStatus('Angemeldet.', 'success');
            if (data.urls?.tenantAdmin) {
                this.result.innerHTML = `<a class="primary-btn" href="${this.escapeHtml(data.urls.tenantAdmin)}">Tenant Admin öffnen</a>`;
            }
        } catch (error) {
            this.consumeButton.disabled = false;
            this.setStatus(error.message || 'Login-Link konnte nicht verwendet werden', 'error');
        }
    }

    setStatus(message, type) {
        this.status.textContent = message;
        this.status.className = `login-status${type ? ` is-${type}` : ''}`;
    }

    escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }
}

window.loginApp = new LoginApp();
