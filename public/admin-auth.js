class AdminAuth {
    constructor() {
        this.storageKey = 'adminToken';
        this.userSessionKey = 'userSessionToken';
        this.token = localStorage.getItem(this.storageKey);
        this.userSessionToken = localStorage.getItem(this.userSessionKey);
        this.overlay = null;
        this.form = null;
        this.passwordInput = null;
        this.errorElement = null;
        this.pendingResolve = null;
    }

    getToken() {
        return this.token || localStorage.getItem(this.storageKey);
    }

    getUserSession() {
        return this.userSessionToken || localStorage.getItem(this.userSessionKey);
    }

    isAuthenticated() {
        return Boolean(this.getToken() || this.getUserSession());
    }

    async requireAuth() {
        if (this.getUserSession()) {
            return null;
        }

        if (this.getToken()) {
            return this.getToken();
        }

        return this.showLogin();
    }

    async requireTenantAuth(redirectUrl = null) {
        if (this.getUserSession()) {
            return null;
        }

        if (this.getToken()) {
            return this.getToken();
        }

        const target = redirectUrl || `${window.location.pathname}${window.location.search}`;
        window.location.href = `/login.html?redirect=${encodeURIComponent(target)}`;
        return new Promise(() => {});
    }

    showLogin(message = '') {
        this.ensureOverlay();
        this.setError(message);
        this.overlay.classList.add('is-visible');
        this.passwordInput.value = '';
        setTimeout(() => this.passwordInput.focus(), 0);

        return new Promise(resolve => {
            this.pendingResolve = resolve;
        });
    }

    ensureOverlay() {
        if (this.overlay) return;

        const overlay = document.createElement('div');
        overlay.className = 'admin-auth-overlay';
        overlay.innerHTML = `
            <form class="admin-auth-form">
                <h2>Admin Login</h2>
                <p>Mit dem bestehenden Admin-Passwort anmelden.</p>
                <label>
                    Passwort
                    <input class="admin-auth-password" type="password" autocomplete="current-password" required>
                </label>
                <div class="admin-auth-error" role="alert"></div>
                <button class="primary-btn" type="submit">Anmelden</button>
                <a class="secondary-btn" href="/login.html">Per E-Mail anmelden</a>
            </form>
        `;

        document.body.appendChild(overlay);

        this.overlay = overlay;
        this.form = overlay.querySelector('.admin-auth-form');
        this.passwordInput = overlay.querySelector('.admin-auth-password');
        this.errorElement = overlay.querySelector('.admin-auth-error');

        this.form.addEventListener('submit', event => {
            event.preventDefault();
            const password = this.passwordInput.value.trim();
            if (!password) {
                this.setError('Passwort eingeben.');
                return;
            }

            this.setToken(password);
            this.hideLogin();
            if (this.pendingResolve) {
                this.pendingResolve(password);
                this.pendingResolve = null;
            }
        });
    }

    setToken(token) {
        this.token = token;
        localStorage.setItem(this.storageKey, token);
    }

    setUserSession(token) {
        this.userSessionToken = token;
        localStorage.setItem(this.userSessionKey, token);
    }

    clearToken() {
        this.token = null;
        this.userSessionToken = null;
        localStorage.removeItem(this.storageKey);
        localStorage.removeItem(this.userSessionKey);
    }

    hideLogin() {
        if (this.overlay) {
            this.overlay.classList.remove('is-visible');
        }
    }

    setError(message) {
        if (this.errorElement) {
            this.errorElement.textContent = message || '';
        }
    }

    async authFetch(url, options = {}) {
        const token = await this.requireAuth();
        const userSession = this.getUserSession();
        const headers = {
            'Content-Type': 'application/json',
            ...(options.headers || {}),
        };
        if (token) headers.Authorization = `Bearer ${token}`;
        if (userSession) headers['X-User-Session'] = userSession;

        const response = await fetch(url, { ...options, headers });
        if (response.status === 401) {
            this.clearToken();
            this.showLogin('Authentifizierung fehlgeschlagen.');
        }

        return response;
    }

    logout() {
        this.clearToken();
        this.showLogin('Abgemeldet.');
    }
}

window.adminAuth = new AdminAuth();
