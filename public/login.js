class LoginApp {
    constructor() {
        const params = new URLSearchParams(window.location.search);
        this.token = params.get('token') || '';
        this.redirectUrl = params.get('redirect') || '';
        this.form = document.getElementById('loginForm');
        this.status = document.getElementById('loginStatus');
        this.result = document.getElementById('loginResult');
        this.submitButton = document.getElementById('loginBtn');
        this.init();
    }

    init() {
        this.form.addEventListener('submit', event => {
            event.preventDefault();
            this.requestLoginLink();
        });

        if (this.token) {
            this.form.style.display = 'none';
            this.consumeLoginLink();
        }
    }

    async requestLoginLink() {
        const formData = new FormData(this.form);
        const email = (formData.get('email') || '').toString().trim();
        if (!email) {
            this.setStatus('E-Mail eingeben.', 'error');
            return;
        }

        this.submitButton.disabled = true;
        this.result.innerHTML = '';
        this.setStatus('Login-Link wird erstellt...', '');

        try {
            const response = await fetch('/api/auth/login-links', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, redirectUrl: this.redirectUrl }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Login-Link konnte nicht erstellt werden');

            this.setStatus('Login-Link wurde per E-Mail verschickt.', 'success');
            this.result.innerHTML = '';
        } catch (error) {
            this.setStatus(error.message || 'Login-Link konnte nicht erstellt werden', 'error');
        } finally {
            this.submitButton.disabled = false;
        }
    }

    async consumeLoginLink() {
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

            this.setStatus('Angemeldet.', 'success');
            if (data.urls?.tenantAdmin) {
                this.result.innerHTML = `<a class="primary-btn" href="${this.escapeHtml(data.urls.tenantAdmin)}">Tenant Admin öffnen</a>`;
            }
        } catch (error) {
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
