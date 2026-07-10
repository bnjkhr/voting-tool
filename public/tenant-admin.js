class TenantAdminApp {
    static FEATURE_STATUSES = ['neu', 'wird geprüft', 'wird umgesetzt', 'im Test', 'ist umgesetzt', 'wird nicht umgesetzt'];
    static TICKET_STATUSES = ['neu', 'offen', 'in Bearbeitung', 'im Test', 'wartend', 'gelöst', 'geschlossen'];
    static PRIORITIES = ['niedrig', 'mittel', 'hoch', 'kritisch'];

    constructor() {
        this.tenantSlug = '';
        this.apps = [];
        this.suggestions = [];
        this.releases = [];
        this.team = { members: [], invites: [] };
        this.apiKeys = [];
        this.stats = null;
        this.settings = null;
        this.filters = { app: '', type: '', status: '', approval: '', release: '' };
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
        // Rückkehr aus dem Stripe-Checkout (success|cancelled). Sofort aus der URL
        // entfernen, damit ein Refresh nicht erneut eine Meldung auslöst.
        this.billingReturn = params.get('billing');
        if (this.billingReturn) {
            params.delete('billing');
            const query = params.toString();
            history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
        }

        if (!this.tenantSlug) {
            document.getElementById('suggestionsList').innerHTML = '<div class="tenant-empty">Tenant fehlt. Öffne diese Seite mit ?tenant=tenant-slug.</div>';
            return;
        }

        document.getElementById('tenantTitle').textContent = `Workspace Admin: ${this.tenantSlug}`;
        document.getElementById('tenantSubtitle').textContent = 'Tenant-Konsole mit klarer Rollen- und Rechteanzeige.';
        document.getElementById('publicBoardLink').href = this.boardUrl(this.tenantSlug);
        document.getElementById('tenantContext').textContent = `Workspace: ${this.tenantSlug}`;
        document.getElementById('workspaceTenantLabel').textContent = this.tenantSlug;

        this.bindEvents();
        this.switchView((window.location.hash || '').replace('#', '') || 'entries');
        // Include the hash so the selected tab (e.g. #releases) survives a login redirect.
        window.adminAuth.requireTenantAuth(`${window.location.pathname}${window.location.search}${window.location.hash}`).then(async () => {
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
        document.getElementById('releaseFilter').addEventListener('change', () => this.applyFilters());
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
        document.getElementById('apiKeyForm').addEventListener('submit', event => {
            event.preventDefault();
            this.createApiKey();
        });
        document.getElementById('apiKeysList').addEventListener('click', event => {
            const trigger = event.target.closest('[data-action="revoke-api-key"]');
            if (!trigger) return;
            this.revokeApiKey(trigger.dataset.keyId);
        });
        document.getElementById('apiKeyReveal').addEventListener('click', event => {
            const trigger = event.target.closest('[data-action="copy-api-key"]');
            if (!trigger) return;
            this.copyApiKeyToClipboard(trigger.dataset.token, trigger);
        });
        document.getElementById('billingStatus').addEventListener('click', event => {
            const trigger = event.target.closest('[data-action]');
            if (!trigger) return;
            if (trigger.dataset.action === 'billing-upgrade') this.startBillingCheckout(trigger);
            else if (trigger.dataset.action === 'billing-portal') this.openBillingPortal(trigger);
        });
        document.getElementById('tenantTabs').addEventListener('click', event => {
            const trigger = event.target.closest('[data-action="switch-view"]');
            if (!trigger) return;
            this.switchView(trigger.dataset.view);
        });
        document.getElementById('releaseForm').addEventListener('submit', event => {
            event.preventDefault();
            this.saveRelease();
        });
        document.getElementById('releaseForm').addEventListener('click', event => {
            const trigger = event.target.closest('[data-action="reset-release-form"]');
            if (!trigger) return;
            this.resetReleaseForm();
        });
        document.getElementById('releasesList').addEventListener('click', event => {
            const trigger = event.target.closest('[data-action]');
            if (!trigger) return;
            if (trigger.dataset.action === 'edit-release') this.editRelease(trigger.dataset.releaseId);
            else if (trigger.dataset.action === 'delete-release') this.deleteRelease(trigger.dataset.releaseId);
        });
        document.getElementById('suggestionsList').addEventListener('change', event => {
            const trigger = event.target.closest('[data-change-action]');
            if (!trigger) return;
            const { changeAction, id } = trigger.dataset;
            if (changeAction === 'assign-release') this.updateSuggestionRelease(id, trigger.value);
            else if (changeAction === 'update-status') this.updateStatus(id, trigger.value);
            else if (changeAction === 'update-priority') this.updatePriority(id, trigger.value);
        });
        document.getElementById('suggestionsList').addEventListener('click', event => {
            const trigger = event.target.closest('[data-action]');
            if (!trigger) return;
            const { action, id, commentId, moderation } = trigger.dataset;
            if (action === 'approve-suggestion') this.approveSuggestion(id);
            else if (action === 'toggle-comments') this.toggleComments(id);
            else if (action === 'add-comment') this.addComment(id);
            else if (action === 'moderate-comment') this.moderateComment(id, commentId, moderation);
        });
        document.getElementById('teamMembersList').addEventListener('change', event => {
            const trigger = event.target.closest('[data-change-action="update-member-role"]');
            if (!trigger) return;
            this.updateMemberRole(trigger.dataset.memberId, trigger.value);
        });
        document.getElementById('teamMembersList').addEventListener('click', event => {
            const trigger = event.target.closest('[data-action]');
            if (!trigger) return;
            const { action, memberId } = trigger.dataset;
            if (action === 'enable-member') this.enableMember(memberId);
            else if (action === 'disable-member') this.disableMember(memberId);
        });
        document.getElementById('teamInvitesList').addEventListener('click', event => {
            const trigger = event.target.closest('[data-action]');
            if (!trigger) return;
            const { action, inviteId } = trigger.dataset;
            if (action === 'resend-invite') this.resendInvite(inviteId);
            else if (action === 'revoke-invite') this.revokeInvite(inviteId);
        });
    }

    switchView(view) {
        const views = ['entries', 'releases', 'boards', 'team', 'settings'];
        const target = views.includes(view) ? view : 'entries';

        document.querySelectorAll('.tenant-view').forEach(section => {
            section.classList.toggle('is-active', section.dataset.view === target);
        });
        document.querySelectorAll('#tenantTabs [data-action="switch-view"]').forEach(tab => {
            tab.classList.toggle('is-active', tab.dataset.view === target);
        });

        if (window.location.hash !== `#${target}`) {
            history.replaceState(null, '', `#${target}`);
        }
    }

    async loadData() {
        try {
            await Promise.all([
                this.loadSettings(),
                this.loadApps(),
                this.loadStats(),
                this.loadSuggestions(),
                this.loadReleases(),
                this.loadTeam(),
                this.loadApiKeys(),
                this.loadBilling(),
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

        const releaseReadonly = document.getElementById('releaseReadonly');
        if (releaseReadonly) {
            releaseReadonly.classList.toggle('is-hidden', this.canManageWorkspace());
        }
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
        this.renderReleaseAppOptions();

        const firstApp = apps[0];
        if (firstApp) {
            document.getElementById('publicBoardLink').href = this.boardUrl(this.tenantSlug, firstApp.slug);
        }
    }

    renderBoards() {
        const host = document.getElementById('tenantBoardsList');
        if (!Array.isArray(this.apps) || this.apps.length === 0) {
            host.innerHTML = '<div class="tenant-empty">Noch keine Boards angelegt.</div>';
            return;
        }

        host.innerHTML = this.apps.map(app => {
            const publicUrl = this.boardUrl(this.tenantSlug, app.slug);
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
        document.getElementById('publicBoardLink').href = this.boardUrl(workspaceSlug, board.slug);
        document.getElementById('onboardingBoardLink').href = this.boardUrl(workspaceSlug, board.slug);

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

    renderReleaseFilter() {
        const select = document.getElementById('releaseFilter');
        if (!select) return;

        const currentValue = this.filters.release;
        const options = this.releases.map(release => {
            const label = `v${release.version || ''}${release.title ? ` · ${release.title}` : ''}`;
            return `<option value="${this.escapeHtml(release.id)}" ${currentValue === release.id ? 'selected' : ''}>${this.escapeHtml(label)}</option>`;
        }).join('');

        select.innerHTML = '<option value="">Alle Releases</option>'
            + `<option value="__none__" ${currentValue === '__none__' ? 'selected' : ''}>Ohne Release</option>`
            + options;
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
            release: document.getElementById('releaseFilter').value,
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
            if (this.filters.release === '__none__' && item.releaseId) return false;
            if (this.filters.release && this.filters.release !== '__none__' && item.releaseId !== this.filters.release) return false;
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

    async loadReleases() {
        try {
            const response = await this.adminFetch(this.tenantAdminPath('/releases'));
            const releases = await response.json();
            if (!response.ok) throw new Error(releases.error || 'Releases konnten nicht geladen werden');

            this.releases = Array.isArray(releases) ? releases : [];
            this.renderReleases();
            this.renderReleaseFilter();
            if (this.suggestions.length) this.renderSuggestions();
        } catch (error) {
            console.error('Error loading tenant releases:', error);
            this.releases = [];
            const host = document.getElementById('releasesList');
            if (host) host.innerHTML = '<div class="tenant-empty">Fehler beim Laden der Releases.</div>';
        }
    }

    renderReleaseAppOptions() {
        const select = document.querySelector('#releaseForm select[name="releaseAppId"]');
        if (!select) return;

        const current = select.value;
        select.innerHTML = '<option value="">App wählen</option>' + this.apps.map(app => `
            <option value="${this.escapeHtml(app.id)}">${this.escapeHtml(app.name || app.slug || app.id)}</option>
        `).join('');
        if (current) select.value = current;
    }

    renderReleases() {
        const host = document.getElementById('releasesList');
        if (!host) return;

        if (!this.releases.length) {
            host.innerHTML = '<div class="tenant-empty">Noch keine Releases angelegt.</div>';
            return;
        }

        const statusClass = { 'geplant': '', 'in Arbeit': 'is-warning', 'veröffentlicht': 'is-success' };
        const canManage = this.canManageWorkspace();

        host.innerHTML = this.releases.map(release => `
            <article class="tenant-release-item">
                <div class="tenant-suggestion-top">
                    <div>
                        <div class="tenant-badges">
                            <span class="tenant-badge">${this.escapeHtml(release.app?.name || 'Unbekannte App')}</span>
                            <span class="tenant-badge ${statusClass[release.status] || ''}">${this.escapeHtml(release.status || 'geplant')}</span>
                            <span class="tenant-badge">${this.escapeHtml(String(release.itemCount || 0))} Einträge</span>
                        </div>
                        <h3 class="tenant-suggestion-title">v${this.escapeHtml(release.version || '')}${release.title ? ` · ${this.escapeHtml(release.title)}` : ''}</h3>
                        ${release.releaseDate ? `<p class="tenant-release-date">${this.formatDate(release.releaseDate)}</p>` : ''}
                        ${release.description ? `<p class="tenant-suggestion-description">${this.escapeHtml(release.description)}</p>` : ''}
                    </div>
                    ${canManage ? `
                    <div class="tenant-team-actions">
                        <button class="secondary-btn btn-small" type="button" data-action="edit-release" data-release-id="${this.escapeHtml(release.id)}">Bearbeiten</button>
                        <button class="secondary-btn btn-small" type="button" data-action="delete-release" data-release-id="${this.escapeHtml(release.id)}">Löschen</button>
                    </div>
                    ` : ''}
                </div>
            </article>
        `).join('');
    }

    async saveRelease() {
        if (!this.canManageWorkspace()) {
            this.showToast('Keine Berechtigung für Releases', 'error');
            return;
        }

        const form = document.getElementById('releaseForm');
        const submitButton = document.getElementById('saveReleaseBtn');
        const formData = new FormData(form);
        const releaseId = (formData.get('releaseId') || '').toString().trim();
        const releaseDate = (formData.get('releaseDate') || '').toString().trim() || null;
        const fields = {
            version: (formData.get('releaseVersion') || '').toString().trim(),
            title: (formData.get('releaseTitle') || '').toString().trim(),
            description: (formData.get('releaseDescription') || '').toString().trim(),
            status: (formData.get('releaseStatus') || 'geplant').toString(),
            releaseDate,
        };
        const appId = (formData.get('releaseAppId') || '').toString().trim();

        if (!releaseId && !appId) {
            this.showToast('Bitte eine App wählen', 'error');
            return;
        }
        if (!fields.version) {
            this.showToast('Version ist erforderlich', 'error');
            return;
        }

        const url = releaseId
            ? this.tenantAdminPath(`/releases/${encodeURIComponent(releaseId)}`)
            : this.tenantAdminPath('/releases');
        const method = releaseId ? 'PUT' : 'POST';
        const body = releaseId ? fields : { appId, ...fields };

        submitButton.disabled = true;
        try {
            const response = await this.adminFetch(url, { method, body: JSON.stringify(body) });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Release konnte nicht gespeichert werden');

            this.showToast(releaseId ? 'Release aktualisiert' : 'Release erstellt', 'success');
            this.resetReleaseForm();
            await this.loadReleases();
        } catch (error) {
            console.error('Error saving release:', error);
            this.showToast(error.message || 'Release konnte nicht gespeichert werden', 'error');
        } finally {
            submitButton.disabled = false;
        }
    }

    editRelease(releaseId) {
        const release = this.releases.find(item => item.id === releaseId);
        if (!release) return;

        const form = document.getElementById('releaseForm');
        form.elements.releaseId.value = release.id;
        form.elements.releaseAppId.value = release.appId || '';
        form.elements.releaseVersion.value = release.version || '';
        form.elements.releaseTitle.value = release.title || '';
        form.elements.releaseStatus.value = release.status || 'geplant';
        form.elements.releaseDescription.value = release.description || '';
        form.elements.releaseDate.value = this.toDateInputValue(release.releaseDate);
        form.elements.releaseAppId.disabled = true;
        document.getElementById('saveReleaseBtn').textContent = 'Release aktualisieren';

        this.switchView('releases');
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    resetReleaseForm() {
        const form = document.getElementById('releaseForm');
        form.reset();
        form.elements.releaseId.value = '';
        form.elements.releaseAppId.disabled = false;
        document.getElementById('saveReleaseBtn').textContent = 'Release speichern';
    }

    async deleteRelease(releaseId) {
        if (!this.canManageWorkspace()) {
            this.showToast('Keine Berechtigung für Releases', 'error');
            return;
        }
        if (!confirm('Release löschen? Verknüpfte Einträge bleiben erhalten, verlieren aber die Release-Zuordnung.')) return;

        try {
            const response = await this.adminFetch(
                this.tenantAdminPath(`/releases/${encodeURIComponent(releaseId)}`),
                { method: 'DELETE' }
            );
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Release konnte nicht gelöscht werden');

            this.showToast('Release gelöscht', 'success');
            this.resetReleaseForm();
            await Promise.all([this.loadReleases(), this.loadSuggestions()]);
        } catch (error) {
            console.error('Error deleting release:', error);
            this.showToast(error.message || 'Release konnte nicht gelöscht werden', 'error');
        }
    }

    async updateSuggestionRelease(suggestionId, releaseId) {
        try {
            const response = await this.adminFetch(
                this.tenantAdminPath(`/suggestions/${encodeURIComponent(suggestionId)}/release`),
                { method: 'PUT', body: JSON.stringify({ releaseId: releaseId || null }) }
            );
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Aktion fehlgeschlagen');

            this.showToast('Release-Zuordnung aktualisiert', 'success');
            // Stats are unaffected by a release reassignment — only refresh the
            // suggestion cards and the per-release item counts.
            await Promise.all([this.loadSuggestions(), this.loadReleases()]);
        } catch (error) {
            console.error('Error updating suggestion release:', error);
            this.showToast(error.message || 'Aktion fehlgeschlagen', 'error');
        }
    }

    toDateInputValue(timestamp) {
        const date = this.toDate(timestamp);
        return date ? date.toISOString().slice(0, 10) : '';
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
                        <select ${disabled ? 'disabled' : ''} data-change-action="update-member-role" data-member-id="${this.escapeHtml(member.id)}">
                            <option value="viewer" ${role === 'viewer' ? 'selected' : ''}>Viewer</option>
                            <option value="admin" ${role === 'admin' ? 'selected' : ''}>Admin</option>
                            ${this.canManageOwnerRoles() ? `<option value="owner" ${role === 'owner' ? 'selected' : ''}>Owner</option>` : ''}
                        </select>
                    </label>
                    ${status === 'disabled' ? `
                        <button class="secondary-btn btn-small" ${disabled ? 'disabled' : ''} type="button" data-action="enable-member" data-member-id="${this.escapeHtml(member.id)}">Aktivieren</button>
                    ` : `
                        <button class="secondary-btn btn-small" ${disabled ? 'disabled' : ''} type="button" data-action="disable-member" data-member-id="${this.escapeHtml(member.id)}">Deaktivieren</button>
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
                    <button class="secondary-btn btn-small" type="button" data-action="resend-invite" data-invite-id="${this.escapeHtml(invite.id)}">Erneut senden</button>
                    <button class="secondary-btn btn-small" type="button" data-action="revoke-invite" data-invite-id="${this.escapeHtml(invite.id)}">Widerrufen</button>
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
                        <select data-change-action="update-status" data-id="${this.escapeHtml(item.id)}">
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
                        <select data-change-action="update-priority" data-id="${this.escapeHtml(item.id)}">
                            ${TenantAdminApp.PRIORITIES.map(priority => `
                                <option value="${this.escapeHtml(priority)}" ${item.priority === priority ? 'selected' : ''}>
                                    ${this.escapeHtml(priority)}
                                </option>
                            `).join('')}
                        </select>
                    </label>
                    ` : ''}
                    ${canManage ? `
                    <label>
                        Release
                        <select data-change-action="assign-release" data-id="${this.escapeHtml(item.id)}">
                            <option value="">Kein Release</option>
                            ${this.releases.map(release => `
                                <option value="${this.escapeHtml(release.id)}" ${item.releaseId === release.id ? 'selected' : ''}>
                                    v${this.escapeHtml(release.version || '')}${release.title ? ` · ${this.escapeHtml(release.title)}` : ''}
                                </option>
                            `).join('')}
                        </select>
                    </label>
                    ` : ''}
                    ${canManage && !item.approved ? `
                        <button class="primary-btn" type="button" data-action="approve-suggestion" data-id="${this.escapeHtml(item.id)}">
                            Freigeben
                        </button>
                    ` : ''}
                    <button class="secondary-btn" type="button" data-action="toggle-comments" data-id="${this.escapeHtml(item.id)}">
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
                    <button class="primary-btn btn-small" type="button" data-action="add-comment" data-id="${this.escapeHtml(suggestionId)}">
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
                            <button class="primary-btn btn-small" type="button" data-action="moderate-comment" data-id="${this.escapeHtml(suggestionId)}" data-comment-id="${this.escapeHtml(comment.id)}" data-moderation="approve">
                                Freigeben
                            </button>
                        ` : ''}
                        ${comment.approvalStatus !== 'rejected' ? `
                            <button class="secondary-btn btn-small" type="button" data-action="moderate-comment" data-id="${this.escapeHtml(suggestionId)}" data-comment-id="${this.escapeHtml(comment.id)}" data-moderation="reject">
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

    async loadApiKeys() {
        if (!this.canManageWorkspace()) {
            this.apiKeys = [];
            this.renderApiKeys();
            return;
        }

        try {
            const response = await this.adminFetch(this.tenantAdminPath('/api-keys'));
            const keys = await response.json();
            if (!response.ok) throw new Error(keys.error || 'API-Schlüssel konnten nicht geladen werden');

            this.apiKeys = Array.isArray(keys) ? keys.filter(key => !key.revokedAt) : [];
        } catch (error) {
            console.error('Error loading API keys:', error);
            this.apiKeys = [];
        }
        this.renderApiKeys();
    }

    // Einheitlicher Pro-Plan-Check über ein Plan-tragendes Objekt (z.B. this.billing).
    isProPlan(source) {
        return ((source || {}).plan || 'free') === 'pro';
    }

    // API-/MCP-Zugriff ist ein Pro-Feature. Gesperrt wird erst, wenn Premium
    // live geschaltet ist (billingEnforced) UND Stripe konfiguriert ist
    // (billingEnabled) — dieselben Bedingungen wie das Backend-Gate; Postgres ist
    // implizit, da /billing ohne Postgres 404 liefert und this.billing leer
    // bleibt. Ohne aktives Billing (Legacy/Firestore) also offen, analog Backend.
    isApiAccessGated() {
        const b = this.billing;
        return !!(b && b.billingEnforced && b.billingEnabled) && !this.isProPlan(b);
    }

    renderApiKeys() {
        const host = document.getElementById('apiKeysList');
        if (!host) return;

        const gated = this.isApiAccessGated();
        const notice = document.getElementById('apiKeyProNotice');
        const form = document.getElementById('apiKeyForm');
        if (notice) notice.classList.toggle('is-hidden', !gated || !this.canManageWorkspace());
        if (form) {
            // Auch die Admin-only-Sichtbarkeit erhalten — sonst zeigt renderApiKeys
            // das Formular Nicht-Admins, weil es das gemeinsame is-hidden-Toggle
            // aus applyRolePermissions überschreibt.
            const hideForm = gated || !this.canManageWorkspace();
            form.classList.toggle('is-hidden', hideForm);
            form.querySelectorAll('input, button').forEach(el => { el.disabled = hideForm; });
        }

        if (!this.canManageWorkspace()) {
            host.innerHTML = '<div class="tenant-empty">API-Schlüssel sind nur für Admins sichtbar.</div>';
            return;
        }

        if (this.apiKeys.length === 0) {
            host.innerHTML = '<div class="tenant-empty">Noch keine API-Schlüssel erstellt.</div>';
            return;
        }

        host.innerHTML = this.apiKeys.map(key => `
            <div class="tenant-api-key-item">
                <strong>${this.escapeHtml(key.name || 'Unbenannt')}</strong>
                <code>${this.escapeHtml(key.tokenPrefix || 'vt_live_…')}…</code>
                <div class="tenant-badges">
                    ${(key.scopes || []).map(scope => `<span class="tenant-badge">${this.escapeHtml(scope)}</span>`).join('')}
                </div>
                <div class="tenant-badges">
                    <span class="tenant-badge">Erstellt: ${this.formatDate(key.createdAt)}</span>
                    <span class="tenant-badge">Zuletzt benutzt: ${key.lastUsedAt ? this.formatDate(key.lastUsedAt) : 'noch nie'}</span>
                </div>
                <div class="tenant-team-actions">
                    <span></span>
                    <button class="secondary-btn btn-small" type="button"
                            data-action="revoke-api-key"
                            data-key-id="${this.escapeHtml(key.id)}">Widerrufen</button>
                </div>
            </div>
        `).join('');
    }

    async createApiKey() {
        if (!this.canManageWorkspace()) {
            this.showToast('Keine Berechtigung für API-Schlüssel', 'error');
            return;
        }

        if (this.isApiAccessGated()) {
            this.showToast('API-Schlüssel sind ein Pro-Feature. Bitte upgrade auf Pro.', 'error');
            return;
        }

        const form = document.getElementById('apiKeyForm');
        const formData = new FormData(form);
        const name = (formData.get('apiKeyName') || '').toString().trim();
        const scopes = formData.getAll('apiKeyScope').map(value => value.toString());

        if (!name) {
            this.showToast('Name fehlt', 'error');
            return;
        }
        if (scopes.length === 0) {
            this.showToast('Mindestens einen Scope auswählen', 'error');
            return;
        }

        try {
            const response = await this.adminFetch(this.tenantAdminPath('/api-keys'), {
                method: 'POST',
                body: JSON.stringify({ name, scopes }),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Schlüssel konnte nicht erstellt werden');

            form.reset();
            form.querySelectorAll('input[name="apiKeyScope"]').forEach(input => {
                input.checked = ['suggestions:read', 'suggestions:write'].includes(input.value);
            });

            this.revealApiKey(result);
            await this.loadApiKeys();
            this.showToast('API-Schlüssel erstellt', 'success');
        } catch (error) {
            console.error('Error creating API key:', error);
            this.showToast(error.message || 'Schlüssel konnte nicht erstellt werden', 'error');
        }
    }

    revealApiKey(payload) {
        const host = document.getElementById('apiKeyReveal');
        if (!host || !payload?.token) return;

        host.classList.remove('is-hidden');
        host.innerHTML = `
            <strong>${this.escapeHtml(payload.name || 'Neuer Schlüssel')}</strong>
            <p style="margin: 0; color: var(--text-secondary); font-size: 0.85rem;">Token nur einmal angezeigt. Bitte sicher kopieren und speichern.</p>
            <code>${this.escapeHtml(payload.token)}</code>
            <div class="tenant-api-key-reveal-actions">
                <button class="primary-btn btn-small" type="button"
                        data-action="copy-api-key"
                        data-token="${this.escapeHtml(payload.token)}">Kopieren</button>
            </div>
        `;
    }

    async copyApiKeyToClipboard(token, button) {
        if (!token) return;
        try {
            await navigator.clipboard.writeText(token);
            if (button) {
                const original = button.textContent;
                button.textContent = 'Kopiert';
                setTimeout(() => { button.textContent = original; }, 1500);
            }
            this.showToast('Token in die Zwischenablage kopiert', 'success');
        } catch (error) {
            console.error('Clipboard copy failed:', error);
            this.showToast('Konnte nicht kopieren — bitte manuell auswählen', 'error');
        }
    }

    async revokeApiKey(keyId) {
        if (!keyId) return;
        if (!confirm('API-Schlüssel wirklich widerrufen? Tools, die ihn nutzen, verlieren sofort den Zugriff.')) return;

        try {
            const response = await this.adminFetch(this.tenantAdminPath(`/api-keys/${encodeURIComponent(keyId)}`), {
                method: 'DELETE',
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Schlüssel konnte nicht widerrufen werden');

            this.showToast('API-Schlüssel widerrufen', 'success');
            const reveal = document.getElementById('apiKeyReveal');
            if (reveal) {
                reveal.classList.add('is-hidden');
                reveal.innerHTML = '';
            }
            await this.loadApiKeys();
        } catch (error) {
            console.error('Error revoking API key:', error);
            this.showToast(error.message || 'Schlüssel konnte nicht widerrufen werden', 'error');
        }
    }

    async loadBilling() {
        const host = document.getElementById('billingStatus');
        try {
            const response = await this.adminFetch(this.tenantAdminPath('/billing'));
            if (response.status === 404) {
                // Billing lebt nur im Postgres-Backend — Panel ausblenden.
                const panel = document.getElementById('billingPanel');
                if (panel) panel.classList.add('is-hidden');
                return;
            }
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Plan konnte nicht geladen werden');

            this.billing = data;
            this.renderBilling();
            // Plan bestimmt das Pro-Gating der API-Schlüssel; beide Loader laufen
            // parallel, daher hier neu rendern, sobald der Plan bekannt ist.
            this.renderApiKeys();

            // Rückmeldung aus dem Checkout einmalig anzeigen.
            if (this.billingReturn === 'success') {
                this.showToast('Willkommen bei Pro! Dein Abo wird aktiviert…', 'success');
                this.pollBillingUntilPro(0); // Webhook ist async -> kurz nachladen
            } else if (this.billingReturn === 'cancelled') {
                this.showToast('Checkout abgebrochen — kein Abo abgeschlossen.', 'error');
            }
            this.billingReturn = null;
        } catch (error) {
            console.error('Error loading billing status:', error);
            if (host) {
                host.className = 'tenant-empty';
                host.textContent = 'Plan konnte nicht geladen werden.';
            }
        }
    }

    // Nach erfolgreichem Checkout ist der Webhook-Sync asynchron; ein paar Mal
    // sanft nachladen, bis der Plan auf Pro steht.
    async pollBillingUntilPro(attempt) {
        if (attempt >= 5) return;
        await new Promise(resolve => setTimeout(resolve, 2500));
        try {
            const response = await this.adminFetch(this.tenantAdminPath('/billing'));
            if (response.ok) {
                const data = await response.json();
                this.billing = data;
                this.renderBilling();
                this.renderApiKeys();
                if (this.isProPlan(data)) return; // Sync durch -> fertig
            }
        } catch (error) {
            console.error('Error polling billing status:', error);
        }
        // Auch bei transientem Fehler / Non-OK weiter versuchen — der Webhook kann
        // ein paar Sekunden brauchen; ein einzelner 502/503 darf nicht einfrieren.
        this.pollBillingUntilPro(attempt + 1);
    }

    renderBilling() {
        const host = document.getElementById('billingStatus');
        if (!host) return;

        const b = this.billing || {};
        const proStatuses = ['active', 'trialing', 'past_due'];
        const isPro = this.isProPlan(b);
        const status = b.subscriptionStatus || null;
        const isOwner = this.currentRole === 'owner';

        const statusBadge = !isPro
            ? ''
            : status === 'past_due'
                ? '<span class="tenant-badge is-warning">Zahlung offen</span>'
                : status === 'trialing'
                    ? '<span class="tenant-badge is-success">Testphase</span>'
                    : '<span class="tenant-badge is-success">Aktiv</span>';

        let detail;
        if (isPro) {
            if (status === 'trialing' && b.trialEndsAt) detail = `Testphase bis ${this.formatDate(b.trialEndsAt)}.`;
            else if (status === 'past_due') detail = 'Zahlung ausstehend — bitte im Kundenportal aktualisieren.';
            else if (b.currentPeriodEnd) detail = `Verlängert sich am ${this.formatDate(b.currentPeriodEnd)}.`;
            else detail = 'Aktiv.';
        } else {
            detail = 'Kostenlos — für kleine Workspaces.';
        }

        const features = isPro
            ? ['Unbegrenzt Boards', 'Unbegrenzt Team-Mitglieder', 'API-Zugriff & MCP-Server', 'Kein „Powered by Roadlight“-Badge']
            : ['1 Board', '2 Team-Mitglieder', 'API & MCP (nur Pro)', '„Powered by Roadlight“-Badge'];

        let actions = '';
        let note = '';
        if (!b.billingEnabled) {
            note = isPro ? '' : 'Der Pro-Plan wird in Kürze verfügbar.';
        } else if (!isOwner) {
            note = 'Nur der Owner kann das Abo verwalten.';
        } else {
            const buttons = [];
            // Upgrade nur, wenn Checkout wirklich startbar ist (Secret-Key UND
            // Preis konfiguriert) — sonst liefe der Button in ein sicheres 503.
            if (!proStatuses.includes(status) && b.checkoutReady) {
                buttons.push('<button class="primary-btn" type="button" data-action="billing-upgrade">Auf Pro upgraden</button>');
            }
            if (b.hasSubscription) {
                buttons.push('<button class="secondary-btn" type="button" data-action="billing-portal">Abo verwalten</button>');
            }
            actions = buttons.length ? `<div class="billing-actions">${buttons.join('')}</div>` : '';
            // Owner, aber Upgrade (noch) nicht möglich und kein Abo -> Hinweis.
            if (!buttons.length && !isPro) {
                note = 'Der Pro-Plan wird in Kürze verfügbar.';
            }
        }

        host.className = '';
        host.innerHTML = `
            <div class="billing-plan">
                <span class="billing-plan-name">${isPro ? 'Pro' : 'Free'}-Plan</span>
                ${statusBadge}
            </div>
            <p class="billing-detail">${this.escapeHtml(detail)}</p>
            <ul class="billing-features">${features.map(feature => `<li>${this.escapeHtml(feature)}</li>`).join('')}</ul>
            ${actions}
            ${note ? `<p class="billing-note">${this.escapeHtml(note)}</p>` : ''}
        `;
    }

    async startBillingCheckout(button) {
        if (this.currentRole !== 'owner') {
            this.showToast('Nur der Owner kann upgraden', 'error');
            return;
        }
        if (button) button.disabled = true;
        try {
            const response = await this.adminFetch(this.tenantAdminPath('/billing/checkout'), { method: 'POST' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Checkout konnte nicht gestartet werden');
            window.location.href = data.url;
        } catch (error) {
            console.error('Error starting checkout:', error);
            this.showToast(error.message || 'Checkout konnte nicht gestartet werden', 'error');
            if (button) button.disabled = false;
        }
    }

    async openBillingPortal(button) {
        if (this.currentRole !== 'owner') {
            this.showToast('Nur der Owner kann das Abo verwalten', 'error');
            return;
        }
        if (button) button.disabled = true;
        try {
            const response = await this.adminFetch(this.tenantAdminPath('/billing/portal'), { method: 'POST' });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'Portal konnte nicht geöffnet werden');
            window.location.href = data.url;
        } catch (error) {
            console.error('Error opening billing portal:', error);
            this.showToast(error.message || 'Portal konnte nicht geöffnet werden', 'error');
            if (button) button.disabled = false;
        }
    }

    escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }

    // Öffentliche Board-URL: pfad-basiert (/{tenant}/{board}) auf der Hauptdomain.
    // Die Konsole läuft auf app.roadlight.pro; die Boards leben auf roadlight.pro
    // — daher das "app."-Präfix des aktuellen Hosts entfernen (funktioniert auch
    // auf localhost, wo es kein Präfix gibt).
    boardUrl(tenantSlug, appSlug) {
        const host = window.location.host.replace(/^app\./, '');
        const path = appSlug
            ? `/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(appSlug)}`
            : `/${encodeURIComponent(tenantSlug)}`;
        return `${window.location.protocol}//${host}${path}`;
    }

    toDate(timestamp) {
        if (!timestamp) return null;
        let date = null;
        if (timestamp._seconds !== undefined) date = new Date(timestamp._seconds * 1000);
        else if (timestamp.seconds !== undefined) date = new Date(timestamp.seconds * 1000);
        else if (typeof timestamp === 'string' || typeof timestamp === 'number') date = new Date(timestamp);

        return date && !Number.isNaN(date.getTime()) ? date : null;
    }

    formatDate(timestamp) {
        const date = this.toDate(timestamp);
        if (!date) return 'Unbekannt';
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
