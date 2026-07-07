class SignupApp {
    constructor() {
        this.form = document.getElementById('signupForm');
        this.workspaceNameInput = this.form.elements.workspaceName;
        this.workspaceSlugInput = this.form.elements.workspaceSlug;
        this.status = document.getElementById('signupStatus');
        this.result = document.getElementById('signupResult');
        this.submitButton = document.getElementById('signupBtn');
        this.slugTouched = false;
        this.init();
    }

    init() {
        this.workspaceNameInput.addEventListener('input', () => this.syncWorkspaceSlug());
        this.workspaceSlugInput.addEventListener('input', () => {
            this.slugTouched = true;
            this.workspaceSlugInput.value = this.normalizeSlug(this.workspaceSlugInput.value);
        });

        this.form.addEventListener('submit', event => {
            event.preventDefault();
            this.createWorkspace();
        });
    }

    syncWorkspaceSlug() {
        if (this.slugTouched) return;
        this.workspaceSlugInput.value = this.normalizeSlug(this.workspaceNameInput.value);
    }

    normalizeSlug(value) {
        return String(value || '')
            .normalize('NFKD')
            .replace(/[\u0300-\u036f]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60);
    }

    async createWorkspace() {
        this.syncWorkspaceSlug();
        const formData = new FormData(this.form);
        const payload = {
            email: (formData.get('email') || '').toString().trim(),
            workspaceName: (formData.get('workspaceName') || '').toString().trim(),
            workspaceSlug: (formData.get('workspaceSlug') || '').toString().trim(),
            boardName: (formData.get('boardName') || '').toString().trim(),
            ticketPrefix: (formData.get('ticketPrefix') || '').toString().trim(),
        };

        if (!payload.email || !payload.workspaceName) {
            this.setStatus('E-Mail und Workspace Name sind erforderlich.', 'error');
            return;
        }

        this.submitButton.disabled = true;
        this.result.innerHTML = '';
        this.setStatus('Workspace wird erstellt...', '');

        try {
            const response = await fetch('/api/signup/workspaces', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Workspace konnte nicht erstellt werden');

            this.form.reset();
            this.slugTouched = false;
            const workspaceName = this.escapeHtml(data.tenant?.name || payload.workspaceName);
            if (data.delivery === 'failed') {
                // Workspace angelegt, aber die Login-Mail kam nicht raus. Nicht als
                // Fehler darstellen — der Nutzer holt den Link über "Anmelden".
                this.setStatus('Workspace erstellt – die Login-Mail konnte gerade nicht gesendet werden.', 'warning');
                this.result.innerHTML = `
                    <p>Dein Workspace <strong>${workspaceName}</strong> wurde erstellt.</p>
                    <p>Wir konnten dir die Login-Mail nicht senden. Gehe zu <a href="/login.html">Anmelden</a> und fordere einen neuen Login-Link an.</p>
                `;
            } else {
                this.setStatus('Login-Link wurde per E-Mail verschickt.', 'success');
                this.result.innerHTML = `
                    <p>Workspace <strong>${workspaceName}</strong> wurde erstellt.</p>
                    <p>Öffne den Login-Link aus deiner E-Mail, um als Owner in den Admin-Bereich zu gelangen.</p>
                `;
            }
        } catch (error) {
            this.setStatus(error.message || 'Workspace konnte nicht erstellt werden', 'error');
        } finally {
            this.submitButton.disabled = false;
        }
    }

    setStatus(message, type) {
        this.status.textContent = message;
        this.status.className = `signup-status${type ? ` is-${type}` : ''}`;
    }

    escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }
}

window.signupApp = new SignupApp();
