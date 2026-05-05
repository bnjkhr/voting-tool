class AcceptInviteApp {
    constructor() {
        const params = new URLSearchParams(window.location.search);
        this.token = params.get('token') || '';
        this.invite = null;
        this.summary = document.getElementById('inviteSummary');
        this.status = document.getElementById('inviteStatus');
        this.form = document.getElementById('acceptInviteForm');
        this.submitButton = document.getElementById('acceptInviteBtn');
        this.init();
    }

    init() {
        this.form.addEventListener('submit', event => {
            event.preventDefault();
            this.acceptInvite();
        });

        if (!this.token) {
            this.setStatus('Einladungstoken fehlt.', 'error');
            this.form.style.display = 'none';
            return;
        }

        this.loadInvite();
    }

    async loadInvite() {
        try {
            const response = await fetch(`/api/invites/${encodeURIComponent(this.token)}`);
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Einladung konnte nicht geladen werden');

            this.invite = data;
            this.renderInvite(data);
        } catch (error) {
            this.summary.textContent = '';
            this.form.style.display = 'none';
            this.setStatus(error.message || 'Einladung konnte nicht geladen werden', 'error');
        }
    }

    renderInvite(invite) {
        this.summary.innerHTML = `
            <div>Workspace: <strong>${this.escapeHtml(invite.tenant?.name || invite.tenant?.slug || 'Workspace')}</strong></div>
            <div>E-Mail: <strong>${this.escapeHtml(invite.email)}</strong></div>
            <div>Rolle: <strong>${this.escapeHtml(this.formatRole(invite.role))}</strong></div>
        `;
    }

    async acceptInvite() {
        const formData = new FormData(this.form);
        const displayName = (formData.get('displayName') || '').toString().trim();

        this.submitButton.disabled = true;
        this.setStatus('Einladung wird angenommen...', '');

        try {
            const response = await fetch(`/api/invites/${encodeURIComponent(this.token)}/accept`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ displayName }),
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Einladung konnte nicht angenommen werden');

            if (data.sessionToken && window.adminAuth?.setUserSession) {
                window.adminAuth.setUserSession(data.sessionToken);
            }

            this.setStatus('Einladung angenommen. Du kannst den Tenant Admin öffnen.', 'success');
            this.form.style.display = 'none';
            if (data.urls?.tenantAdmin) {
                this.summary.innerHTML += `
                    <div><a class="primary-btn" href="${this.escapeHtml(data.urls.tenantAdmin)}">Tenant Admin öffnen</a></div>
                `;
            }
        } catch (error) {
            this.setStatus(error.message || 'Einladung konnte nicht angenommen werden', 'error');
            this.submitButton.disabled = false;
        }
    }

    setStatus(message, type) {
        this.status.textContent = message;
        this.status.className = `invite-status${type ? ` is-${type}` : ''}`;
    }

    formatRole(role) {
        const labels = { owner: 'Owner', admin: 'Admin', viewer: 'Viewer' };
        return labels[role] || 'Viewer';
    }

    escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }
}

window.acceptInviteApp = new AcceptInviteApp();
