class TenantAdminApp {
    static FEATURE_STATUSES = ['neu', 'wird geprüft', 'wird umgesetzt', 'ist umgesetzt', 'wird nicht umgesetzt'];
    static TICKET_STATUSES = ['neu', 'offen', 'in Bearbeitung', 'wartend', 'gelöst', 'geschlossen'];
    static PRIORITIES = ['niedrig', 'mittel', 'hoch', 'kritisch'];

    constructor() {
        this.tenantSlug = '';
        this.apps = [];
        this.suggestions = [];
        this.team = { members: [], invites: [] };
        this.stats = null;
        this.settings = null;
        this.filters = { app: '', type: '', status: '', approval: '' };
        this.session = null;
        this.currentMembership = null;
        this.currentRole = 'viewer';
        this.isPlatformAdmin = false;
        this.onboardingRequested = false;
        this.init();
    }

    init() {
        const params = new URLSearchParams(window.location.search);
        this.tenantSlug = (params.get('tenant') || '').trim();
        this.onboardingRequested = params.get('onboarding') === '1';

        if (!this.tenantSlug) {
            document.getElementById('suggestionsList').innerHTML = '<div class="tenant-empty">Tenant fehlt. Öffne diese Seite mit ?tenant=tenant-slug.</div>';
            return;
        }

        document.getElementById('tenantTitle').textContent = `Workspace Admin: ${this.tenantSlug}`;
        document.getElementById('tenantSubtitle').textContent = 'Tenant-Konsole mit klarer Rollen- und Rechteanzeige.';
        document.getElementById('publicBoardLink').href = `/?tenant=${encodeURIComponent(this.tenantSlug)}`;
        document.getElementById('tenantContext').textContent = `Workspace: ${this.tenantSlug}`;
        document.getElementById('workspaceTenantLabel').textContent = this.tenantSlug;

        this.bindEvents();
        window.adminAuth.requireTenantAuth(`${window.location.pathname}${window.location.search}`).then(async () => {
            await this.loadSession();
            await this.loadData();
        });
    }

    bindEvents() {
        document.getElementById('refreshBtn').addEventListener('click', () => this.loadData());
        document.getElementById('logoutBtn').addEventListener('click', () => window.adminAuth.logout());
        document.getElementById('appFilter').addEventListener('change', () => this.applyFilters());
        document.getElementById('typeFilter').addEventListener('change', () => this.applyFilters());
        document.getElementById('statusFilter').addEventListener('change', () => this.applyFilters());
        document.getElementById('approvalFilter').addEventListener('change', () => this.applyFilters());
        document.getElementById('teamInviteForm').addEventListener('submit', event => {
            event.preventDefault();
            this.sendInvite();
        });
        document.getElementById('workspaceSettingsForm').addEventListener('submit', event => {
            event.preventDefault();
            this.saveSettings();
        });
        document.getElementById('tenantBoardForm').addEventListener('submit', event => {
            event.preventDefault();
            this.createBoard();
        });
        document.getElementById('dismissOnboardingBtn').addEventListener('click', () => this.dismissOnboarding());
    }

    async loadData() {
        try {
            await Promise.all([
                this.loadSettings(),
                this.loadApps(),
                this.loadStats(),
                this.loadSuggestions(),
                this.loadTeam(),
            ]);
        } catch (error) {
            console.error('Error loading tenant admin data:', error);
        }
    }

    async loadSession() {
        try {
            const response = await window.adminAuth.authFetch('/api/auth/session');
            const session = await response.json();
            if (!response.ok) throw new Error(session.error || 'Session konnte nicht geladen werden');

            this.session = session;
            this.isPlatformAdmin = session.platformRole === 'super_admin';
            this.currentMembership = (session.memberships || [])
                .find(item => item.tenantSlug === this.tenantSlug || item.tenantId === this.tenantSlug) || null;
            this.currentRole = this.isPlatformAdmin
                ? 'super_admin'
                : this.currentMembership?.role || 'viewer';
            this.renderSessionContext();
        } catch (error) {
            console.error('Error loading session context:', error);
            this.session = null;
            this.currentRole = 'viewer';
            this.renderSessionContext();
        }
    }

    renderSessionContext() {
        const user = this.session?.user || {};
        const roleLabel = this.isPlatformAdmin
            ? 'Super Admin'
            : this.formatRole(this.currentRole);
        const userLabel = user.email || user.displayName || 'Unbekannte Session';

        document.getElementById('roleContext').textContent = `Rolle: ${roleLabel}`;
        document.getElementById('userIdentity').textContent = userLabel;
        document.getElementById('workspaceRoleLabel').textContent = roleLabel;
        document.getElementById('workspacePlatformLabel').textContent = this.isPlatformAdmin ? 'Ja' : 'Nein';

        const platformLink = document.getElementById('platformAdminLink');
        platformLink.classList.toggle('is-hidden', !this.isPlatformAdmin);

        document.querySelectorAll('[data-admin-only]').forEach(element => {
            element.classList.toggle('is-hidden', !this.canManageWorkspace());
        });

        const settingsReadonly = document.getElementById('workspaceSettingsReadonly');
        settingsReadonly.classList.toggle('is-hidden', this.canManageWorkspace());
    }

    canManageWorkspace() {
        return this.isPlatformAdmin || this.currentRole === 'owner' || this.currentRole === 'admin';
    }

    canManageOwnerRoles() {
        return this.isPlatformAdmin || this.currentRole === 'owner';
    }

    tenantAdminPath(path) {
        return `/api/admin/tenants/${encodeURIComponent(this.tenantSlug)}${path}`;
    }

    async adminFetch(url, options = {}) {
        const response = await window.adminAuth.authFetch(url, options);
        if (response.status === 401) {
            this.showToast('Authentifizierung fehlgeschlagen', 'error');
        }
        return response;
    }

    async loadApps() {
        const response = await this.adminFetch(this.tenantAdminPath('/apps'));
        const apps = await response.json();
        if (!response.ok) throw new Error(apps.error || 'Apps konnten nicht geladen werden');

        this.apps = apps;
        this.renderAppFilter();
        this.renderBoards();

        const firstApp = apps[0];
        if (firstApp) {
            document.getElementById('publicBoardLink').href =
                `/?tenant=${encodeURIComponent(this.tenantSlug)}&app=${encodeURIComponent(firstApp.slug || '')}`;
        }
    }

    renderBoards() {
        const host = document.getElementById('tenantBoardsList');
        if (!Array.isArray(this.apps) || this.apps.length === 0) {
            host.innerHTML = '<div class="tenant-empty">Noch keine Boards angelegt.</div>';
            return;
        }

        host.innerHTML = this.apps.map(app => {
            const publicUrl = `/?tenant=${encodeURIComponent(this.tenantSlug)}${app.slug ? `&app=${encodeURIComponent(app.slug)}` : ''}`;
            return `
                <article class="tenant-board-item">
                    <strong>${this.escapeHtml(app.name || app.slug || app.id)}</strong>
                    <div class="tenant-board-meta">
                        <span>${this.escapeHtml(app.slug || app.id)}</span>
                        <span>${this.escapeHtml(app.ticketPrefix || 'APP')}</span>
                        <a href="${this.escapeHtml(publicUrl)}">Public Board</a>
                    </div>
                </article>
            `;
        }).join('');
    }

    async createBoard() {
        if (!this.canManageWorkspace()) {
            this.showToast('Keine Berechtigung für Boards', 'error');
            return;
        }

        const form = document.getElementById('tenantBoardForm');
        const submitButton = document.getElementById('createBoardBtn');
        const formData = new FormData(form);
        const payload = {
            boardName: (formData.get('boardName') || '').toString().trim(),
            boardSlug: (formData.get('boardSlug') || '').toString().trim(),
            boardTicketPrefix: (formData.get('boardTicketPrefix') || '').toString().trim(),
        };

        submitButton.disabled = true;
        try {
            const response = await this.adminFetch(this.tenantAdminPath('/apps'), {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Board konnte nicht erstellt werden');

            form.reset();
            this.showToast('Board erstellt', 'success');
            await Promise.all([this.loadApps(), this.loadStats()]);
        } catch (error) {
            console.error('Error creating tenant board:', error);
            this.showToast(error.message || 'Board konnte nicht erstellt werden', 'error');
        } finally {
            submitButton.disabled = false;
        }
    }

    async loadSettings() {
        const response = await this.adminFetch(this.tenantAdminPath('/settings'));
        const settings = await response.json();
        if (!response.ok) throw new Error(settings.error || 'Settings konnten nicht geladen werden');

        this.settings = settings;
        this.renderSettings();
    }

    renderSettings() {
        const settings = this.settings || {};
        const tenant = settings.tenant || {};
        const board = settings.defaultBoard || {};
        const emailSettings = tenant.emailSettings || {};
        const workspaceName = tenant.displayName || tenant.name || this.tenantSlug;
        const workspaceSlug = tenant.slug || this.tenantSlug;

        document.getElementById('tenantTitle').textContent = `Workspace Admin: ${workspaceName}`;
        document.getElementById('tenantContext').textContent = `Workspace: ${workspaceSlug}`;
        document.getElementById('workspaceTenantLabel').textContent = workspaceSlug;
        document.getElementById('publicBoardLink').href =
            `/?tenant=${encodeURIComponent(workspaceSlug)}${board.slug ? `&app=${encodeURIComponent(board.slug)}` : ''}`;
        document.getElementById('onboardingBoardLink').href =
            `/?tenant=${encodeURIComponent(workspaceSlug)}${board.slug ? `&app=${encodeURIComponent(board.slug)}` : ''}`;

        const form = document.getElementById('workspaceSettingsForm');
        form.elements.workspaceName.value = workspaceName;
        form.elements.workspaceSlug.value = workspaceSlug;
        form.elements.boardName.value = board.name || '';
        form.elements.ticketPrefix.value = board.ticketPrefix || '';
        form.elements.emailFromName.value = emailSettings.fromName || workspaceName;
        form.elements.replyToEmail.value = emailSettings.replyTo || '';
        this.renderOnboarding();
    }

    shouldShowOnboarding() {
        if (!this.onboardingRequested) return false;
        return localStorage.getItem(`tenantAdmin:onboardingDismissed:${this.tenantSlug}`) !== '1';
    }

    renderOnboarding() {
        const panel = document.getElementById('workspaceOnboarding');
        panel.classList.toggle('is-hidden', !this.shouldShowOnboarding());
    }

    dismissOnboarding() {
        localStorage.setItem(`tenantAdmin:onboardingDismissed:${this.tenantSlug}`, '1');
        this.renderOnboarding();
    }

    async saveSettings() {
        if (!this.canManageWorkspace()) {
            this.showToast('Keine Berechtigung für Workspace Settings', 'error');
            return;
        }

        const form = document.getElementById('workspaceSettingsForm');
        const submitButton = document.getElementById('saveSettingsBtn');
        const formData = new FormData(form);
        const payload = {
            workspaceName: (formData.get('workspaceName') || '').toString().trim(),
            workspaceSlug: (formData.get('workspaceSlug') || '').toString().trim(),
            boardName: (formData.get('boardName') || '').toString().trim(),
            ticketPrefix: (formData.get('ticketPrefix') || '').toString().trim(),
            emailFromName: (formData.get('emailFromName') || '').toString().trim(),
            replyToEmail: (formData.get('replyToEmail') || '').toString().trim(),
        };

        submitButton.disabled = true;
        try {
            const response = await this.adminFetch(this.tenantAdminPath('/settings'), {
                method: 'PUT',
                body: JSON.stringify(payload),
            });
            const settings = await response.json();
            if (!response.ok) throw new Error(settings.error || 'Settings konnten nicht gespeichert werden');

            const nextSlug = settings.tenant?.slug || this.tenantSlug;
            this.settings = settings;
            if (nextSlug !== this.tenantSlug) {
                this.tenantSlug = nextSlug;
                const nextUrl = new URL(window.location.href);
                nextUrl.searchParams.set('tenant', nextSlug);
                window.history.replaceState({}, '', nextUrl.toString());
                await this.loadSession();
            }

            this.renderSettings();
            this.showToast('Workspace Settings gespeichert', 'success');
            await Promise.all([this.loadApps(), this.loadStats(), this.loadSuggestions()]);
        } catch (error) {
            console.error('Error saving workspace settings:', error);
            this.showToast(error.message || 'Settings konnten nicht gespeichert werden', 'error');
        } finally {
            submitButton.disabled = false;
        }
    }

    async loadStats() {
        const response = await this.adminFetch(this.tenantAdminPath('/stats'));
        const stats = await response.json();
        if (!response.ok) throw new Error(stats.error || 'Statistiken konnten nicht geladen werden');

        this.stats = stats;
        this.renderStats();
    }

    async loadSuggestions() {
        const response = await this.adminFetch(this.tenantAdminPath('/suggestions'));
        const suggestions = await response.json();
        if (!response.ok) throw new Error(suggestions.error || 'Einträge konnten nicht geladen werden');

        this.suggestions = suggestions;
        this.renderStatusFilter();
        this.renderSuggestions();
    }

    async loadTeam() {
        if (!this.canManageWorkspace()) {
            this.team = { members: [], invites: [] };
            this.renderTeam();
            return;
        }

        const response = await this.adminFetch(this.tenantAdminPath('/members'));
        const team = await response.json();
        if (!response.ok) throw new Error(team.error || 'Team konnte nicht geladen werden');

        this.team = {
            members: Array.isArray(team.members) ? team.members : [],
            invites: Array.isArray(team.invites) ? team.invites : [],
        };
        this.renderTeam();
    }

    renderAppFilter() {
        const select = document.getElementById('appFilter');
        const currentValue = this.filters.app;
        select.innerHTML = '<option value="">Alle Apps</option>' + this.apps.map(app => `
            <option value="${this.escapeHtml(app.id)}" ${currentValue === app.id ? 'selected' : ''}>
                ${this.escapeHtml(app.name)}
            </option>
        `).join('');
    }

    renderStatusFilter() {
        const select = document.getElementById('statusFilter');
        const currentValue = this.filters.status;
        const statuses = [...new Set(this.suggestions.map(item => item.status).filter(Boolean))]
            .sort((a, b) => a.localeCompare(b, 'de'));

        select.innerHTML = '<option value="">Alle Status</option>' + statuses.map(status => `
            <option value="${this.escapeHtml(status)}" ${currentValue === status ? 'selected' : ''}>
                ${this.escapeHtml(status)}
            </option>
        `).join('');
    }

    renderStats() {
        const stats = this.stats || {};
        document.getElementById('tenantStats').innerHTML = [
            ['Apps', stats.totalApps || 0],
            ['Einträge', stats.totalSuggestions || 0],
            ['Wartende Einträge', stats.pendingSuggestions || 0],
            ['Wartende Kommentare', stats.pendingComments || 0],
            ['Features', stats.totalFeatures || 0],
            ['Bugs', stats.totalBugs || 0],
            ['Tickets', stats.totalTickets || 0],
            ['Votes', stats.totalVotes || 0],
        ].map(([label, value]) => `
            <div class="tenant-admin-stat">
                <span>${this.escapeHtml(label)}</span>
                <strong>${this.escapeHtml(String(value))}</strong>
            </div>
        `).join('');
    }

    applyFilters() {
        this.filters = {
            app: document.getElementById('appFilter').value,
            type: document.getElementById('typeFilter').value,
            status: document.getElementById('statusFilter').value,
            approval: document.getElementById('approvalFilter').value,
        };
        this.renderSuggestions();
    }

    getFilteredSuggestions() {
        return this.suggestions.filter(item => {
            if (this.filters.app && item.appId !== this.filters.app) return false;
            if (this.filters.type && item.type !== this.filters.type) return false;
            if (this.filters.status && item.status !== this.filters.status) return false;
            if (this.filters.approval === 'pending' && item.approved) return false;
            if (this.filters.approval === 'approved' && !item.approved) return false;
            return true;
        });
    }

    renderSuggestions() {
        const host = document.getElementById('suggestionsList');
        const suggestions = this.getFilteredSuggestions();

        if (suggestions.length === 0) {
            host.innerHTML = '<div class="tenant-empty">Keine Einträge gefunden.</div>';
            return;
        }

        host.innerHTML = suggestions.map(item => this.renderSuggestionCard(item)).join('');
    }

    renderTeam() {
        document.getElementById('teamMembersList').innerHTML = this.team.members.length > 0
            ? this.team.members.map(member => this.renderTeamMember(member)).join('')
            : this.canManageWorkspace()
                ? '<div class="tenant-empty">Noch keine Mitglieder.</div>'
                : '<div class="tenant-empty">Teamverwaltung ist für deine Rolle nicht verfügbar.</div>';

        document.getElementById('teamInvitesList').innerHTML = this.team.invites.length > 0
            ? this.team.invites.map(invite => this.renderTeamInvite(invite)).join('')
            : this.canManageWorkspace()
                ? '<div class="tenant-empty">Keine offenen Einladungen.</div>'
                : '<div class="tenant-empty">Offene Einladungen sind nur für Admins sichtbar.</div>';
    }

    renderTeamMember(member) {
        const role = member.role || 'viewer';
        const status = member.status || 'active';
        const canEditOwner = role !== 'owner' || this.canManageOwnerRoles();
        const disabled = !this.canManageWorkspace() || !canEditOwner;

        return `
            <div class="tenant-team-item">
                <strong>${this.escapeHtml(member.email || member.displayName || 'Unbekannt')}</strong>
                <div class="tenant-badges">
                    <span class="tenant-badge">${this.escapeHtml(this.formatRole(role))}</span>
                    <span class="tenant-badge ${status === 'disabled' ? 'is-warning' : 'is-success'}">${this.escapeHtml(status)}</span>
                </div>
                ${this.canManageWorkspace() ? `
                <div class="tenant-team-actions">
                    <label>
                        Rolle
                        <select ${disabled ? 'disabled' : ''} onchange="tenantAdmin.updateMemberRole('${this.escapeHtml(member.id)}', this.value)">
                            <option value="viewer" ${role === 'viewer' ? 'selected' : ''}>Viewer</option>
                            <option value="admin" ${role === 'admin' ? 'selected' : ''}>Admin</option>
                            ${this.canManageOwnerRoles() ? `<option value="owner" ${role === 'owner' ? 'selected' : ''}>Owner</option>` : ''}
                        </select>
                    </label>
                    ${status === 'disabled' ? `
                        <button class="secondary-btn btn-small" ${disabled ? 'disabled' : ''} type="button" onclick="tenantAdmin.enableMember('${this.escapeHtml(member.id)}')">Aktivieren</button>
                    ` : `
                        <button class="secondary-btn btn-small" ${disabled ? 'disabled' : ''} type="button" onclick="tenantAdmin.disableMember('${this.escapeHtml(member.id)}')">Deaktivieren</button>
                    `}
                </div>
                ` : ''}
            </div>
        `;
    }

    renderTeamInvite(invite) {
        return `
            <div class="tenant-team-item">
                <strong>${this.escapeHtml(invite.email || 'Unbekannt')}</strong>
                <div class="tenant-badges">
                    <span class="tenant-badge">${this.escapeHtml(this.formatRole(invite.role))}</span>
                    <span class="tenant-badge">${this.escapeHtml(invite.status || 'pending')}</span>
                </div>
                ${this.canManageWorkspace() ? `
                <div class="tenant-team-actions">
                    <button class="secondary-btn btn-small" type="button" onclick="tenantAdmin.resendInvite('${this.escapeHtml(invite.id)}')">Erneut senden</button>
                    <button class="secondary-btn btn-small" type="button" onclick="tenantAdmin.revokeInvite('${this.escapeHtml(invite.id)}')">Widerrufen</button>
                </div>
                ` : ''}
            </div>
        `;
    }

    async sendInvite() {
        const form = document.getElementById('teamInviteForm');
        const linkBox = document.getElementById('teamInviteLink');
        const formData = new FormData(form);
        const email = (formData.get('inviteEmail') || '').toString().trim();
        const role = (formData.get('inviteRole') || 'admin').toString();

        linkBox.classList.remove('is-visible');
        linkBox.textContent = '';

        if (!email) {
            this.showToast('E-Mail fehlt', 'error');
            return;
        }

        try {
            const response = await this.adminFetch(this.tenantAdminPath('/invites'), {
                method: 'POST',
                body: JSON.stringify({ email, role }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Einladung konnte nicht erstellt werden');

            linkBox.textContent = `Einladung per E-Mail verschickt an ${result.email || email}.`;
            linkBox.classList.add('is-visible');
            form.reset();
            this.showToast('Einladung per E-Mail verschickt', 'success');
            await this.loadTeam();
        } catch (error) {
            console.error('Error creating tenant invite:', error);
            this.showToast(error.message || 'Einladung konnte nicht erstellt werden', 'error');
        }
    }

    async updateMemberRole(memberId, role) {
        await this.writeTeamChange(
            this.tenantAdminPath(`/members/${encodeURIComponent(memberId)}`),
            { method: 'PUT', body: JSON.stringify({ role }) },
            'Rolle aktualisiert'
        );
    }

    async enableMember(memberId) {
        await this.writeTeamChange(
            this.tenantAdminPath(`/members/${encodeURIComponent(memberId)}`),
            { method: 'PUT', body: JSON.stringify({ status: 'active' }) },
            'Mitglied aktiviert'
        );
    }

    async disableMember(memberId) {
        if (!confirm('Mitglied deaktivieren?')) return;
        await this.writeTeamChange(
            this.tenantAdminPath(`/members/${encodeURIComponent(memberId)}`),
            { method: 'DELETE' },
            'Mitglied deaktiviert'
        );
    }

    async resendInvite(inviteId) {
        await this.writeTeamChange(
            this.tenantAdminPath(`/invites/${encodeURIComponent(inviteId)}/resend`),
            { method: 'POST' },
            'Einladung erneut gesendet'
        );
    }

    async revokeInvite(inviteId) {
        if (!confirm('Einladung widerrufen?')) return;
        await this.writeTeamChange(
            this.tenantAdminPath(`/invites/${encodeURIComponent(inviteId)}`),
            { method: 'DELETE' },
            'Einladung widerrufen'
        );
    }

    async writeTeamChange(url, options, successMessage) {
        try {
            const response = await this.adminFetch(url, options);
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Team-Aktion fehlgeschlagen');

            this.showToast(successMessage, 'success');
            await this.loadTeam();
        } catch (error) {
            console.error('Tenant team write failed:', error);
            this.showToast(error.message || 'Team-Aktion fehlgeschlagen', 'error');
            await this.loadTeam();
        }
    }

    renderSuggestionCard(item) {
        const canManage = this.canManageWorkspace();
        const statuses = item.type === 'feature'
            ? TenantAdminApp.FEATURE_STATUSES
            : TenantAdminApp.TICKET_STATUSES;
        const typeLabel = item.type === 'bug' ? 'Bug' : item.type === 'ticket' ? 'Ticket' : 'Feature';
        const approvalBadge = item.approved
            ? '<span class="tenant-badge is-success">Freigegeben</span>'
            : '<span class="tenant-badge is-warning">Wartet</span>';
        const pendingBadge = item.pendingCommentCount > 0
            ? `<span class="tenant-badge is-warning">${item.pendingCommentCount} Kommentar(e) warten</span>`
            : '';

        return `
            <article class="tenant-suggestion-card" id="suggestion-${this.escapeHtml(item.id)}">
                <div class="tenant-suggestion-top">
                    <div>
                        <div class="tenant-badges">
                            ${item.ticketNumber ? `<span class="tenant-badge">${this.escapeHtml(item.ticketNumber)}</span>` : ''}
                            <span class="tenant-badge">${this.escapeHtml(typeLabel)}</span>
                            <span class="tenant-badge">${this.escapeHtml(item.app?.name || 'Unbekannte App')}</span>
                            ${approvalBadge}
                            ${pendingBadge}
                        </div>
                        <h3 class="tenant-suggestion-title">${this.escapeHtml(item.title)}</h3>
                        <p class="tenant-suggestion-description">${this.escapeHtml(item.description || '')}</p>
                    </div>
                    <div class="tenant-badges">
                        <span class="tenant-badge">${this.escapeHtml(item.status || 'kein Status')}</span>
                        <span class="tenant-badge">${this.escapeHtml(item.priority || 'mittel')}</span>
                        <span class="tenant-badge">${this.escapeHtml(String(item.votes || 0))} Votes</span>
                    </div>
                </div>

                <div class="tenant-admin-controls" ${canManage ? 'data-admin-only' : ''}>
                    ${canManage ? `
                    <label>
                        Status
                        <select onchange="tenantAdmin.updateStatus('${this.escapeHtml(item.id)}', this.value)">
                            ${statuses.map(status => `
                                <option value="${this.escapeHtml(status)}" ${item.status === status ? 'selected' : ''}>
                                    ${this.escapeHtml(status)}
                                </option>
                            `).join('')}
                        </select>
                    </label>
                    ` : ''}
                    ${canManage ? `
                    <label>
                        Priorität
                        <select onchange="tenantAdmin.updatePriority('${this.escapeHtml(item.id)}', this.value)">
                            ${TenantAdminApp.PRIORITIES.map(priority => `
                                <option value="${this.escapeHtml(priority)}" ${item.priority === priority ? 'selected' : ''}>
                                    ${this.escapeHtml(priority)}
                                </option>
                            `).join('')}
                        </select>
                    </label>
                    ` : ''}
                    ${canManage && !item.approved ? `
                        <button class="primary-btn" type="button" onclick="tenantAdmin.approveSuggestion('${this.escapeHtml(item.id)}')">
                            Freigeben
                        </button>
                    ` : ''}
                    <button class="secondary-btn" type="button" onclick="tenantAdmin.toggleComments('${this.escapeHtml(item.id)}')">
                        Kommentare (${item.commentCount || 0})
                    </button>
                </div>

                <div class="tenant-comment-box" id="comments-${this.escapeHtml(item.id)}">
                    <div class="tenant-empty">Kommentare werden geladen...</div>
                </div>
            </article>
        `;
    }

    async approveSuggestion(suggestionId) {
        if (!confirm('Eintrag freigeben?')) return;
        await this.writeAndReload(
            this.tenantAdminPath(`/suggestions/${encodeURIComponent(suggestionId)}/approve`),
            { method: 'POST' },
            'Eintrag freigegeben'
        );
    }

    async updateStatus(suggestionId, status) {
        await this.writeAndReload(
            this.tenantAdminPath(`/suggestions/${encodeURIComponent(suggestionId)}/status`),
            { method: 'PUT', body: JSON.stringify({ status }) },
            'Status aktualisiert'
        );
    }

    async updatePriority(suggestionId, priority) {
        await this.writeAndReload(
            this.tenantAdminPath(`/suggestions/${encodeURIComponent(suggestionId)}/priority`),
            { method: 'PUT', body: JSON.stringify({ priority }) },
            'Priorität aktualisiert'
        );
    }

    async writeAndReload(url, options, successMessage) {
        try {
            const response = await this.adminFetch(url, options);
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Aktion fehlgeschlagen');

            this.showToast(successMessage, 'success');
            await Promise.all([this.loadStats(), this.loadSuggestions()]);
        } catch (error) {
            console.error('Tenant admin write failed:', error);
            this.showToast(error.message || 'Aktion fehlgeschlagen', 'error');
        }
    }

    async toggleComments(suggestionId) {
        const box = document.getElementById(`comments-${suggestionId}`);
        if (!box) return;

        box.classList.toggle('is-visible');
        if (box.classList.contains('is-visible')) {
            await this.loadComments(suggestionId);
        }
    }

    async loadComments(suggestionId) {
        const box = document.getElementById(`comments-${suggestionId}`);
        try {
            const response = await this.adminFetch(this.tenantAdminPath(`/suggestions/${encodeURIComponent(suggestionId)}/comments`));
            const comments = await response.json();
            if (!response.ok) throw new Error(comments.error || 'Kommentare konnten nicht geladen werden');

            this.renderComments(suggestionId, comments);
        } catch (error) {
            console.error('Error loading tenant comments:', error);
            box.innerHTML = '<div class="tenant-empty">Fehler beim Laden der Kommentare.</div>';
        }
    }

    renderComments(suggestionId, comments) {
        const box = document.getElementById(`comments-${suggestionId}`);
        const commentList = comments.length > 0
            ? comments.map(comment => this.renderComment(suggestionId, comment)).join('')
            : '<div class="tenant-empty">Noch keine Kommentare vorhanden.</div>';

        box.innerHTML = `
            ${this.canManageWorkspace() ? `
            <div class="tenant-comment">
                <label>
                    Admin-Kommentar
                    <textarea id="new-comment-${this.escapeHtml(suggestionId)}" placeholder="Kommentar schreiben..."></textarea>
                </label>
                <div class="admin-actions" style="margin: 8px 0 0;">
                    <button class="primary-btn btn-small" type="button" onclick="tenantAdmin.addComment('${this.escapeHtml(suggestionId)}')">
                        Kommentar speichern
                    </button>
                </div>
            </div>
            ` : ''}
            ${commentList}
        `;
    }

    renderComment(suggestionId, comment) {
        const pending = comment.authorType === 'user' && comment.approvalStatus === 'pending';
        const statusLabel = comment.authorType === 'admin'
            ? 'Admin'
            : comment.approvalStatus === 'approved'
                ? 'User · freigegeben'
                : comment.approvalStatus === 'rejected'
                    ? 'User · abgelehnt'
                    : 'User · wartet';

        return `
            <div class="tenant-comment ${pending ? 'is-pending' : ''}">
                <div class="tenant-badges" style="margin-bottom: 8px;">
                    <span class="tenant-badge ${pending ? 'is-warning' : ''}">${this.escapeHtml(statusLabel)}</span>
                    <span class="tenant-badge">${this.formatDate(comment.createdAt)}</span>
                </div>
                <p style="white-space: pre-wrap; margin: 0 0 8px;">${this.escapeHtml(comment.text)}</p>
                ${comment.authorType === 'user' && this.canManageWorkspace() ? `
                    <div class="admin-actions" style="margin: 0;">
                        ${comment.approvalStatus !== 'approved' ? `
                            <button class="primary-btn btn-small" type="button" onclick="tenantAdmin.moderateComment('${this.escapeHtml(suggestionId)}', '${this.escapeHtml(comment.id)}', 'approve')">
                                Freigeben
                            </button>
                        ` : ''}
                        ${comment.approvalStatus !== 'rejected' ? `
                            <button class="secondary-btn btn-small" type="button" onclick="tenantAdmin.moderateComment('${this.escapeHtml(suggestionId)}', '${this.escapeHtml(comment.id)}', 'reject')">
                                Ablehnen
                            </button>
                        ` : ''}
                    </div>
                ` : ''}
            </div>
        `;
    }

    async addComment(suggestionId) {
        const textarea = document.getElementById(`new-comment-${suggestionId}`);
        const text = (textarea?.value || '').trim();
        if (!text) {
            this.showToast('Kommentartext fehlt', 'error');
            return;
        }

        try {
            const response = await this.adminFetch(this.tenantAdminPath(`/suggestions/${encodeURIComponent(suggestionId)}/comments`), {
                method: 'POST',
                body: JSON.stringify({ text, screenshots: [] }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Kommentar konnte nicht gespeichert werden');

            this.showToast('Kommentar gespeichert', 'success');
            await this.loadComments(suggestionId);
            await Promise.all([this.loadStats(), this.loadSuggestions()]);
        } catch (error) {
            console.error('Error adding tenant admin comment:', error);
            this.showToast(error.message || 'Kommentar konnte nicht gespeichert werden', 'error');
        }
    }

    async moderateComment(suggestionId, commentId, action) {
        try {
            const response = await this.adminFetch(
                this.tenantAdminPath(`/suggestions/${encodeURIComponent(suggestionId)}/comments/${encodeURIComponent(commentId)}/${action}`),
                { method: 'PUT' }
            );
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Kommentar konnte nicht moderiert werden');

            this.showToast(action === 'approve' ? 'Kommentar freigegeben' : 'Kommentar abgelehnt', 'success');
            await this.loadComments(suggestionId);
            await Promise.all([this.loadStats(), this.loadSuggestions()]);
        } catch (error) {
            console.error('Error moderating tenant comment:', error);
            this.showToast(error.message || 'Kommentar konnte nicht moderiert werden', 'error');
        }
    }

    escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }

    formatDate(timestamp) {
        if (!timestamp) return 'Unbekannt';
        let date = null;
        if (timestamp._seconds !== undefined) date = new Date(timestamp._seconds * 1000);
        else if (timestamp.seconds !== undefined) date = new Date(timestamp.seconds * 1000);
        else if (typeof timestamp === 'string' || typeof timestamp === 'number') date = new Date(timestamp);

        if (!date || Number.isNaN(date.getTime())) return 'Unbekannt';
        return date.toLocaleDateString('de-DE', {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
        });
    }

    formatRole(role) {
        const labels = {
            owner: 'Owner',
            admin: 'Admin',
            viewer: 'Viewer',
        };
        return labels[role] || 'Viewer';
    }

    showToast(message, type = 'success') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = `toast ${type}`;
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 3500);
    }
}

const tenantAdmin = new TenantAdminApp();
