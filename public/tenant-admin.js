class TenantAdminApp {
    static FEATURE_STATUSES = ['neu', 'wird geprüft', 'wird umgesetzt', 'im Test', 'ist umgesetzt', 'wird nicht umgesetzt'];
    static TICKET_STATUSES = ['neu', 'offen', 'in Bearbeitung', 'im Test', 'wartend', 'gelöst', 'geschlossen'];
    static PRIORITIES = ['niedrig', 'mittel', 'hoch', 'kritisch'];
    // Ab dieser Breite stehen alle Spalten nebeneinander und Karten lassen sich ziehen.
    static WIDE_BOARD = '(min-width: 901px)';

    constructor() {
        this.tenantSlug = '';
        this.apps = [];
        this.suggestions = [];
        this.suggestionsLoaded = false;
        this.suggestionLoads = 0;
        this.boardFilters = { appId: '', label: '' };
        this.boardColumn = 'arbeit';
        this.draggedCardId = null;
        this.dropTarget = null;
        this.movingCards = new Set();
        // Verknüpfungen mit öffentlichen Einträgen.
        this.feedback = { enabled: false, sources: [], links: [] };
        this.feedbackLoads = 0;
        this.feedbackFetching = false;
        this.feedbackMessage = '';
        // Ticket, für das der Verknüpfen-Dialog offen ist.
        this.linkTarget = null;
        // Karten, deren öffentliche Aktion gerade läuft.
        this.publishingCards = new Set();
        this.activeView = '';
        this.sessionReady = false;
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
            params.delete('session_id');
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
            // Erst jetzt steht die Rolle fest: Wer direkt auf #board kommt,
            // holt hier statt beim Reiterwechsel.
            this.sessionReady = true;
            if (this.activeView === 'board') this.loadFeedback();
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
            if (trigger.dataset.action === 'billing-upgrade') this.openBillingConsentDialog();
            else if (trigger.dataset.action === 'billing-portal') this.openBillingPortal(trigger);
        });
        document.getElementById('billingConsentDialog').addEventListener('click', event => {
            const trigger = event.target.closest('[data-action="billing-consent-cancel"]');
            if (trigger) document.getElementById('billingConsentDialog').close();
        });
        document.getElementById('billingConsentForm').addEventListener('submit', event => {
            event.preventDefault();
            this.startBillingCheckout(document.getElementById('billingConsentSubmit'));
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
        document.getElementById('tenantBoardsList').addEventListener('click', event => {
            const trigger = event.target.closest('[data-action]');
            if (!trigger) return;
            if (trigger.dataset.action === 'delete-board') this.askDeleteBoard(trigger);
            else if (trigger.dataset.action === 'confirm-delete-board') this.deleteBoard(trigger);
            else if (trigger.dataset.action === 'cancel-delete-board') this.renderBoards();
        });
        document.getElementById('releasesList').addEventListener('click', event => {
            const trigger = event.target.closest('[data-action]');
            if (!trigger) return;
            if (trigger.dataset.action === 'edit-release') this.editRelease(trigger.dataset.releaseId);
            else if (trigger.dataset.action === 'delete-release') this.deleteRelease(trigger.dataset.releaseId);
        });
        document.getElementById('todoStack').addEventListener('click', event => {
            const trigger = event.target.closest('[data-action]');
            if (!trigger) return;
            const { action, id } = trigger.dataset;
            if (action === 'approve-suggestion') this.approveSuggestion(id);
            else if (action === 'open-suggestion') this.openSuggestion(id);
            else if (action === 'toggle-todo-more') {
                this.todoExpanded = !this.todoExpanded;
                this.renderTodoStack();
            }
        });
        const filterPanel = document.getElementById('filterPanel');
        if (filterPanel && !window.matchMedia('(max-width: 768px)').matches) filterPanel.open = true;
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
        // Zuletzt: Ein Fehler beim Board lässt die übrigen Listener unberührt.
        this.bindBoardEvents();
    }

    switchView(view) {
        const views = ['entries', 'board', 'releases', 'boards', 'team', 'settings'];
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

        const opened = target !== this.activeView;
        this.activeView = target;
        if (opened && target === 'board' && this.sessionReady) this.loadFeedback();
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

        // Owner einladen dürfen nur Owner, wie bei der Rollenauswahl der Mitglieder.
        const inviteRoles = this.canManageOwnerRoles() ? ['admin', 'owner', 'viewer'] : ['admin', 'viewer'];
        document.getElementById('teamInviteRole').innerHTML = inviteRoles
            .map(role => `<option value="${role}">${this.formatRole(role)}</option>`)
            .join('');

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

    // Öffentlich bestätigen oder verwerfen darf, wer Owner dieses Workspaces
    // ist. Der Server prüft die Mitgliedschaft, nicht die Plattform-Rolle.
    canPublishPublic() {
        return this.currentMembership?.role === 'owner';
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
        this.renderBoard();
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

        const canManage = this.canManageWorkspace();
        host.innerHTML = this.apps.map(app => {
            const publicUrl = this.boardUrl(this.tenantSlug, app.slug);
            const slug = app.slug || app.id;
            return `
                <article class="tenant-board-item">
                    <strong>${this.escapeHtml(app.name || app.slug || app.id)}</strong>
                    <div class="tenant-board-meta">
                        <span>${this.escapeHtml(slug)}</span>
                        <span>${this.escapeHtml(app.ticketPrefix || 'APP')}</span>
                        <a href="${this.escapeHtml(publicUrl)}">Public Board</a>
                    </div>
                    ${canManage ? `
                    <div class="tenant-team-actions">
                        <button class="secondary-btn btn-small" type="button" data-action="delete-board"
                                data-app-id="${this.escapeHtml(app.id)}"
                                data-app-slug="${this.escapeHtml(slug)}">Board löschen</button>
                    </div>` : ''}
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
        const load = ++this.suggestionLoads;
        const response = await this.adminFetch(this.tenantAdminPath('/suggestions'));
        const suggestions = await response.json();
        if (!response.ok) throw new Error(suggestions.error || 'Einträge konnten nicht geladen werden');
        // Inzwischen läuft ein neuerer Ladevorgang: Diese Antwort ist veraltet.
        if (load !== this.suggestionLoads) return;

        this.suggestions = suggestions;
        this.suggestionsLoaded = true;
        this.renderStatusFilter();
        this.renderSuggestions();
        this.renderBoard();
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

    getTodoItems() {
        if (!this.canManageWorkspace()) return [];
        return this.suggestions.filter(item => !item.approved || item.pendingCommentCount > 0);
    }

    renderTodoStack() {
        const host = document.getElementById('todoStack');
        const items = this.getTodoItems();
        host.classList.toggle('is-hidden', items.length === 0);
        if (items.length === 0) {
            host.innerHTML = '';
            return;
        }

        const pendingEntries = items.filter(item => !item.approved).length;
        const pendingComments = items.reduce((sum, item) => sum + (item.pendingCommentCount || 0), 0);
        const limit = 3;
        const visible = this.todoExpanded ? items : items.slice(0, limit);
        const cards = visible.map(item => `
            <article class="todo-card">
                <div class="tenant-badges">
                    ${item.approved ? '' : '<span class="tenant-badge is-warning">Wartet auf Freigabe</span>'}
                    ${item.pendingCommentCount > 0 ? `<span class="tenant-badge is-warning">${item.pendingCommentCount} Kommentar(e) warten</span>` : ''}
                    <span class="tenant-badge">${this.escapeHtml(item.app?.name || 'Unbekannte App')}</span>
                </div>
                <h3>${this.escapeHtml(item.title)}</h3>
                <div class="todo-card-actions">
                    ${item.approved ? '' : `<button class="primary-btn" type="button" data-action="approve-suggestion" data-id="${this.escapeHtml(item.id)}">Freigeben</button>`}
                    <button class="secondary-btn" type="button" data-action="open-suggestion" data-id="${this.escapeHtml(item.id)}">${item.pendingCommentCount > 0 ? 'Prüfen' : 'Öffnen'}</button>
                </div>
            </article>
        `).join('');
        const more = items.length > limit
            ? `<button class="secondary-btn todo-more" type="button" data-action="toggle-todo-more">${this.todoExpanded ? 'Weniger anzeigen' : `${items.length - limit} weitere anzeigen`}</button>`
            : '';

        host.innerHTML = `
            <div class="todo-stack-head">
                <strong>${items.length} zu bearbeiten</strong>
                <span>${pendingEntries} Einträge · ${pendingComments} Kommentare</span>
            </div>
            <div class="todo-stack-body">${cards}${more}</div>
        `;
    }

    async openSuggestion(id) {
        // Filter zurücksetzen, damit der Eintrag in der Liste sichtbar ist.
        ['appFilter', 'typeFilter', 'statusFilter', 'approvalFilter', 'releaseFilter'].forEach(fid => {
            document.getElementById(fid).value = '';
        });
        this.applyFilters();
        const card = document.getElementById(`suggestion-${id}`);
        if (!card) return;
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        const item = this.suggestions.find(s => s.id === id);
        const box = document.getElementById(`comments-${id}`);
        if (item?.pendingCommentCount > 0 && box && !box.classList.contains('is-visible')) {
            await this.toggleComments(id);
        }
    }

    renderSuggestions() {
        this.renderTodoStack();
        const host = document.getElementById('suggestionsList');
        const suggestions = this.getFilteredSuggestions();

        if (suggestions.length === 0) {
            host.innerHTML = '<div class="tenant-empty">Keine Einträge gefunden.</div>';
            return;
        }

        host.innerHTML = suggestions.map(item => this.renderSuggestionCard(item)).join('');
    }

    bindBoardEvents() {
        const filter = (id, key) => document.getElementById(id).addEventListener('change', event => {
            this.boardFilters[key] = event.target.value;
            this.renderBoard();
        });
        filter('boardAppFilter', 'appId');
        filter('boardLabelFilter', 'label');
        document.getElementById('boardSwitcher').addEventListener('click', event => {
            const trigger = event.target.closest('[data-action="board-column"]');
            if (!trigger) return;
            this.boardColumn = trigger.dataset.column;
            this.renderBoard();
        });
        window.matchMedia(TenantAdminApp.WIDE_BOARD).addEventListener('change', () => this.renderBoard());

        const columns = document.getElementById('boardColumns');
        columns.addEventListener('click', event => {
            const trigger = event.target.closest('[data-action="move-card"]');
            if (!trigger) return;
            this.moveCard(trigger.dataset.id, trigger.dataset.column);
        });
        columns.addEventListener('click', event => {
            const link = event.target.closest('[data-action="link-card"]');
            if (link) this.linkCard(link.dataset.id);
            const unlink = event.target.closest('[data-action="unlink-card"]');
            if (unlink) this.unlinkCard(unlink.dataset.id);
        });
        columns.addEventListener('click', event => {
            // Der zweite Klick eines Doppelklicks träfe womöglich schon den
            // neuen Knopf, den die Antwort an dieselbe Stelle gesetzt hat.
            const publish = event.target.closest('[data-action="publish-card"]');
            if (publish && !(event.detail > 1)) this.publishCard(publish.dataset.id);
            const discard = event.target.closest('[data-action="discard-card"]');
            if (discard) this.discardCard(discard.dataset.id);
            const test = event.target.closest('[data-action="test-card"]');
            if (test) this.setPublicTest(test.dataset.id);
        });
        columns.addEventListener('dragstart', event => {
            const card = event.target.closest('[data-board-card]');
            if (!card) return;
            this.draggedCardId = card.dataset.boardCard;
            // Firefox startet das Ziehen nur mit Daten.
            event.dataTransfer.setData('text/plain', this.draggedCardId);
        });
        columns.addEventListener('dragover', event => {
            const column = this.dropColumnFor(event);
            this.markDropTarget(column);
            // preventDefault erlaubt das Ablegen.
            if (column) event.preventDefault();
        });
        columns.addEventListener('drop', event => {
            const column = this.dropColumnFor(event);
            const id = this.draggedCardId;
            this.endDrag();
            if (!column) return;
            // Auch Fremdes abfangen, sonst öffnet der Browser das Abgelegte.
            event.preventDefault();
            // Wird die gezogene Karte neu gezeichnet, bleibt ihr dragend aus und
            // die id stehen. Darum zählt nur Ziehgut, das genau sie nennt.
            if (event.dataTransfer.getData('text/plain') !== id) return;
            // Erst das Ziehen abschließen, dann ggf. die Rückfrage öffnen.
            setTimeout(() => this.moveCard(id, column.dataset.column), 0);
        });
        // Am Dokument, damit auch ein Ende außerhalb des Boards aufräumt.
        document.addEventListener('dragend', () => this.endDrag());
        document.addEventListener('drop', () => this.endDrag());
        document.getElementById('feedbackFetchBtn').addEventListener('click', () => this.fetchFeedbackNow());
        document.getElementById('linkForm').addEventListener('submit', event => {
            event.preventDefault();
            this.submitLink();
        });
        document.getElementById('linkCancelBtn').addEventListener('click', () => {
            this.linkTarget = null;
            document.getElementById('linkDialog').close();
        });
    }

    // Einmal je Öffnen des Reiters: öffentlichen Stand lesen, dann holen. Ein
    // Fehler hier lässt das Board stehen.
    async loadFeedback() {
        this.feedbackMessage = '';
        if (!await this.reloadFeedbackState()) return;
        if (this.feedback.enabled && this.canManageWorkspace()) await this.fetchFeedbackNow();
    }

    // Nur lesen. false: nicht geladen oder von einem neueren Aufruf überholt.
    async reloadFeedbackState() {
        const load = ++this.feedbackLoads;
        try {
            const response = await this.adminFetch(this.tenantAdminPath('/feedback'));
            const state = await response.json();
            if (!response.ok) throw new Error(state.error || 'Verknüpfungen konnten nicht geladen werden');
            if (load !== this.feedbackLoads) return false;
            this.applyFeedback(state);
            return true;
        } catch (error) {
            console.error('Error loading feedback links:', error);
            this.feedbackMessage = 'Der öffentliche Stand ließ sich nicht laden.';
            this.renderFeedback();
            return false;
        }
    }

    applyFeedback(state) {
        this.feedback = {
            enabled: Boolean(state?.enabled),
            sources: Array.isArray(state?.sources) ? state.sources : [],
            links: Array.isArray(state?.links) ? state.links : [],
        };
        this.renderFeedback();
        this.renderBoard();
    }

    async fetchFeedbackNow() {
        if (this.feedbackFetching || !this.canManageWorkspace()) return;
        this.feedbackFetching = true;
        this.feedbackMessage = '';
        this.renderFeedback();
        let created = 0;
        // Bericht ohne Stand: Tickets sind angelegt, der Stand fehlt noch.
        let stateMissing = false;
        try {
            const response = await this.adminFetch(this.tenantAdminPath('/feedback/fetch'), {
                method: 'POST',
                body: JSON.stringify({}),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Holen fehlgeschlagen');

            // Ein noch laufendes Lesen wäre jetzt veraltet.
            this.feedbackLoads += 1;
            created = result.sources.reduce((sum, source) => sum + (source.created?.length || 0), 0);
            stateMissing = !result.state;
            if (!stateMissing) this.applyFeedback(result.state);
            this.feedbackMessage = this.describeFetch(result.sources, created);
        } catch (error) {
            console.error('Error fetching feedback:', error);
            this.feedbackMessage = 'Feedback ließ sich nicht holen.';
        } finally {
            this.feedbackFetching = false;
            this.renderFeedback();
        }
        if (created === 0 && !stateMissing) return;
        try {
            await Promise.all([this.loadStats(), this.loadSuggestions()]);
        } catch (error) {
            console.error('Error reloading after fetching feedback:', error);
        }
        if (!stateMissing) return;
        // Das Ergebnis des Holens bleibt stehen, auch wenn das Lesen scheitert.
        const summary = this.feedbackMessage;
        await this.reloadFeedbackState();
        this.feedbackMessage = summary;
        this.renderFeedback();
    }

    // Ergebnis eines Holvorgangs als ein, zwei Sätze.
    describeFetch(reports, created) {
        const boardName = report => this.feedback.sources
            .find(source => source.id === report.sourceId)?.boardName || report.board;
        const parts = [];
        if (created > 0) {
            parts.push(created === 1 ? '1 neues Ticket geholt.' : `${created} neue Tickets geholt.`);
        }
        // Auch ein gebremster Aufruf nennt den Fehler des letzten Versuchs.
        parts.push(...reports
            .filter(report => report.result === 'error' || report.error)
            .map(report => `${boardName(report)} ließ sich nicht holen.`));
        const pending = reports.reduce((sum, report) => sum + (report.pending || 0), 0);
        if (pending > 0) {
            parts.push(pending === 1
                ? '1 Eintrag folgt beim nächsten Holen.'
                : `${pending} Einträge folgen beim nächsten Holen.`);
        }
        if (parts.length > 0) return parts.join(' ');

        if (reports.length === 0) return 'Es ist noch kein Board angeschlossen.';
        if (reports.every(report => report.result === 'disabled')) return 'Holen ist noch nicht eingeschaltet.';
        if (reports.some(report => report.result === 'fetched')) return 'Keine neuen Tickets.';

        // Alle gebremst: wieder, wenn bei jeder Quelle fünf Minuten um sind.
        const throttled = new Set(reports.filter(report => report.result === 'throttled')
            .map(report => report.sourceId));
        const last = Math.max(0, ...this.feedback.sources
            .filter(source => throttled.has(source.id))
            .map(source => this.toDate(source.lastFetchedAt)?.getTime() || 0));
        if (!last) return 'Gerade erst geholt.';
        const again = new Date(last + 5 * 60 * 1000)
            .toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
        return `Gerade erst geholt. Wieder ab ${again}.`;
    }

    renderFeedback() {
        const { enabled, sources } = this.feedback;
        const show = (id, visible) => document.getElementById(id).classList.toggle('is-hidden', !visible);
        const text = (id, value) => {
            document.getElementById(id).textContent = value;
            show(id, Boolean(value));
        };
        show('boardFeedback', enabled || Boolean(this.feedbackMessage));
        show('feedbackFetchBtn', enabled && this.canManageWorkspace());
        document.getElementById('feedbackFetchBtn').disabled = this.feedbackFetching;
        text('feedbackUnapproved', enabled ? window.BoardModel.unapprovedSummary(sources) : '');
        text('feedbackResult', this.feedbackMessage);
    }

    linkCard(suggestionId) {
        if (!this.canManageWorkspace()) return;
        this.linkTarget = suggestionId;
        document.getElementById('linkEntryId').value = '';
        document.getElementById('linkDialog').showModal();
    }

    async submitLink() {
        const suggestionId = this.linkTarget;
        const entryId = document.getElementById('linkEntryId').value.trim();
        if (!suggestionId || !entryId) return;
        // Sofort vergessen: Ein zweites Absenden schickt nichts mehr.
        this.linkTarget = null;
        // Vor der Anfrage schließen, sonst läge die Meldung hinter dem Dialog.
        document.getElementById('linkDialog').close();
        await this.writeLink(suggestionId, { method: 'PUT', body: JSON.stringify({ entryId }) }, 'Verknüpft');
    }

    async unlinkCard(suggestionId) {
        if (!this.canManageWorkspace()) return;
        if (!confirm('Verknüpfung lösen? Der öffentliche Eintrag wird danach nicht erneut als Ticket geholt.')) return;
        await this.writeLink(suggestionId, { method: 'DELETE' }, 'Verknüpfung gelöst');
    }

    async writeLink(suggestionId, options, successMessage) {
        try {
            const response = await this.adminFetch(
                this.tenantAdminPath(`/suggestions/${encodeURIComponent(suggestionId)}/link`),
                options
            );
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Aktion fehlgeschlagen');

            this.showToast(successMessage, 'success');
            await this.reloadFeedbackState();
        } catch (error) {
            console.error('Error changing feedback link:', error);
            this.showToast(error.message || 'Aktion fehlgeschlagen', 'error');
        }
    }

    // Übernimmt die wartende Änderung, so wie die Karte sie gerade zeigt:
    // `mail: true` nur, wenn der Knopf die Mail nennt.
    async publishCard(suggestionId) {
        const link = this.feedbackLink(suggestionId);
        if (!window.BoardModel.pendingLine(link, { isOwner: this.canPublishPublic() })?.action) return;
        const body = { status: link.pendingStatus, mail: link.pendingMail === true };
        await this.sendPublicAction(suggestionId, 'publish', body, result => {
            if (result.result === 'published') return ['Veröffentlicht, die Mail ist raus.', 'success'];
            if (result.result === 'published_no_mail' && !result.message) {
                return ['Veröffentlicht, ohne Mail.', 'success'];
            }
            return [result.message || 'Aktion fehlgeschlagen', 'error'];
        });
    }

    async discardCard(suggestionId) {
        const link = this.feedbackLink(suggestionId);
        if (!window.BoardModel.pendingLine(link, { isOwner: this.canPublishPublic() })?.canDiscard) return;
        await this.sendPublicAction(suggestionId, 'discard', {}, result => (result.success
            ? ['Wartende Änderung verworfen', 'success']
            : ['Hier wartet keine Änderung mehr.', 'error']));
    }

    async setPublicTest(suggestionId) {
        const item = this.suggestions.find(entry => entry.id === suggestionId);
        if (!item || !this.canManageWorkspace()
            || !window.BoardModel.testAction(item, this.feedbackLink(suggestionId))) return;
        await this.sendPublicAction(suggestionId, 'test', {}, ({ publicPush }) => [
            publicPush?.message || 'Aktion fehlgeschlagen',
            !publicPush?.message || publicPush.result === 'error' ? 'error' : 'success',
        ]);
    }

    // Eine öffentliche Aktion je Karte zur Zeit. `describe` macht aus der Antwort
    // Meldung und Art.
    async sendPublicAction(suggestionId, action, body, describe) {
        if (this.publishingCards.has(suggestionId)) return;
        const hadFocus = Boolean(this.boardFocusKey());
        this.publishingCards.add(suggestionId);
        this.renderBoard();
        try {
            const path = `/feedback/links/${encodeURIComponent(suggestionId)}/${action}`;
            const response = await this.adminFetch(this.tenantAdminPath(path), {
                method: 'POST',
                body: JSON.stringify(body),
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Aktion fehlgeschlagen');

            this.showToast(...describe(result));
            if (result.state) {
                // Ein noch laufendes Lesen wäre jetzt veraltet.
                this.feedbackLoads += 1;
                this.applyFeedback(result.state);
            } else {
                await this.reloadFeedbackState();
            }
        } catch (error) {
            console.error('Error changing public entry:', error);
            this.showToast(error.message || 'Aktion fehlgeschlagen', 'error');
            // Was der Server erledigt hat, ist offen: neu lesen.
            await this.reloadFeedbackState();
        } finally {
            this.publishingCards.delete(suggestionId);
            this.renderBoard();
            // Der Fokus ging beim Sperren verloren: zurück auf die Karte.
            if (hadFocus && !this.boardFocusKey()) {
                this.focusBoard(`${action}:${suggestionId}`, `card:${suggestionId}`);
            }
        }
    }

    feedbackLink(suggestionId) {
        return this.feedback.links.find(entry => entry.suggestionId === suggestionId);
    }

    // Wartende Änderung und „Im Test“ unter der öffentlichen Zeile. Höchstens ein
    // gefüllter Knopf je Karte, alles andere sind Textlinks.
    renderPublicActions(item) {
        const link = this.feedbackLink(item.id);
        const line = window.BoardModel.pendingLine(link, { isOwner: this.canPublishPublic() });
        // Bietet der Knopf schon „im Test“ an, braucht es den Link nicht.
        const test = this.canManageWorkspace() && window.BoardModel.testAction(item, link)
            && !(line?.action && link.pendingStatus === 'im Test');
        if (!line && !test) return '';

        const id = this.escapeHtml(item.id);
        const disabled = this.publishingCards.has(item.id) ? ' disabled' : '';
        const button = (action, className, label) => `<button type="button" class="${className}" data-action="${action}-card"
                    data-id="${id}" data-focus="${action}:${id}"${disabled}>${label}</button>`;
        const labels = { publish: 'Übernehmen', publish_mail: 'Übernehmen und Mail senden' };

        return `
            <div class="board-card-pending">
                ${line ? `<p>${this.escapeHtml(line.text)}</p>` : ''}
                ${line?.error ? `<p class="board-card-pending-error">${this.escapeHtml(line.error)}</p>` : ''}
                ${line?.action ? button('publish', 'primary-btn', labels[line.action]) : ''}
                ${line?.canDiscard ? button('discard', 'board-text-link', 'Verwerfen') : ''}
                ${test ? button('test', 'board-text-link', 'Öffentlich auf Im Test setzen') : ''}
            </div>
        `;
    }

    // Öffentlicher Stand einer Karte, samt Link zum Eintrag.
    renderPublicLine(item) {
        const link = this.feedback.links.find(entry => entry.suggestionId === item.id);
        const line = window.BoardModel.publicLine(link);
        if (!line) return '';
        const anchor = line.url
            ? `<a href="${this.escapeHtml(line.url)}" target="_blank" rel="noopener" draggable="false">ansehen</a>`
            : '';
        return `<p class="board-card-public"><span>${this.escapeHtml(line.text)}</span>${anchor}</p>`;
    }

    // Verknüpfen oder lösen: nur mit Recht und nur an angeschlossenen Boards.
    renderLinkAction(item) {
        const { enabled, sources, links } = this.feedback;
        if (!enabled || !this.canManageWorkspace() || !sources.some(source => source.appId === item.appId)) return '';
        const linked = links.some(entry => entry.suggestionId === item.id);
        const id = this.escapeHtml(item.id);
        return `<button type="button" class="board-text-link" data-action="${linked ? 'unlink-card' : 'link-card'}"
                        data-id="${id}" data-focus="link:${id}">${linked ? 'Verknüpfung lösen' : 'Verknüpfen'}</button>`;
    }

    // Die Spalte unter dem Zeiger, sofern die gezogene Karte dorthin darf.
    // Fremdes Ziehgut (Text, Dateien) hat keine Karte und wird nie angenommen.
    dropColumnFor(event) {
        const item = this.suggestions.find(entry => entry.id === this.draggedCardId);
        const column = item && event.target.closest('.board-column');
        return column && this.canMoveTo(item, column.dataset.column) ? column : null;
    }

    markDropTarget(column) {
        this.dropTarget?.classList.remove('is-drop-target');
        column?.classList.add('is-drop-target');
        this.dropTarget = column;
    }

    endDrag() {
        this.markDropTarget(null);
        this.draggedCardId = null;
    }

    // Nur Einträge, die auf dem Board stehen: Nicht freigegebene würde der
    // Statuswechsel nebenbei freigeben.
    canMoveTo(item, columnKey) {
        const current = window.BoardModel.columnFor(item);
        return this.canManageWorkspace()
            && current !== null
            && current !== columnKey
            && window.BoardModel.statusFor(columnKey, item.type) !== null;
    }

    async moveCard(suggestionId, columnKey) {
        const item = this.suggestions.find(entry => entry.id === suggestionId);
        if (!item || this.movingCards.has(suggestionId) || !this.canMoveTo(item, columnKey)) return;

        // Nur wer mit dem Fokus auf dem Board ist, bekommt ihn nachgeführt.
        const hadFocus = Boolean(this.boardFocusKey());
        this.movingCards.add(suggestionId);
        try {
            if (window.BoardModel.needsConfirm(item)
                && !confirm('Dieser Wechsel kann eine E-Mail an die einreichende Person schicken. Trotzdem verschieben?')) {
                return;
            }
            await this.updateStatus(suggestionId, window.BoardModel.statusFor(columnKey, item.type));
        } finally {
            this.movingCards.delete(suggestionId);
            // Zeichnet aus den geladenen Einträgen: Schlug das Speichern fehl,
            // steht die Karte wieder in der alten Spalte.
            this.renderBoard();
            if (hadFocus) this.focusMovedCard(suggestionId, columnKey);
        }
    }

    boardFocusKey() {
        return document.activeElement?.dataset?.focus;
    }

    // Fokussiert das erste Ziel, das es gibt und das sichtbar ist: Ausgeblendete
    // Elemente nimmt der Browser nicht an.
    focusBoard(...keys) {
        const targets = [...document.querySelectorAll('.tenant-view[data-view="board"] [data-focus]')];
        for (const key of keys) {
            const target = targets.find(element => element.dataset.focus === key);
            target?.focus({ preventScroll: true });
            if (target && document.activeElement === target) return target;
        }
        return null;
    }

    focusMovedCard(suggestionId, columnKey) {
        const active = document.activeElement;
        // Wer inzwischen woanders ist, bleibt dort.
        const elsewhere = active && active !== document.body
            && ![`card:${suggestionId}`, `menu:${suggestionId}`].includes(this.boardFocusKey());
        if (elsewhere) return;

        const target = this.focusBoard(`card:${suggestionId}`, `switch:${columnKey}`, `column:${columnKey}`);
        // Gescrollt wird nur für die Tastatur, nicht nach Antippen oder Ziehen.
        if (target?.matches(':focus-visible')) target.scrollIntoView({ block: 'nearest' });
    }

    renderBoard() {
        if (!this.suggestionsLoaded) return;

        // Ein Filter auf etwas, das es nicht mehr gibt, ließe das Board leer.
        const { appId, label } = this.boardFilters;
        if (appId && !this.apps.some(app => app.id === appId)) this.boardFilters.appId = '';
        if (label && !this.suggestions.some(item => (item.labels || []).includes(label))) this.boardFilters.label = '';

        const board = window.BoardModel.buildBoard(this.suggestions, this.boardFilters);
        this.renderBoardFilters(board.labels);

        const pending = document.getElementById('boardPending');
        pending.classList.toggle('is-hidden', board.pendingCount === 0);
        pending.textContent = board.pendingCount === 1
            ? '1 Eintrag wartet auf Freigabe. Du findest ihn unter Einträge.'
            : `${board.pendingCount} Einträge warten auf Freigabe. Du findest sie unter Einträge.`;

        // Neuzeichnen ersetzt die Elemente: Fokus und Aufgeklapptes merken.
        const focusKey = this.boardFocusKey();
        const columns = document.getElementById('boardColumns');
        const openCards = new Set([...columns.querySelectorAll('.board-card-details[open]')]
            .map(details => details.closest('[data-board-card]').dataset.boardCard));

        document.getElementById('boardSwitcher').innerHTML = window.BoardModel.COLUMNS.map(({ key, label: name }) => `
            <button type="button" class="board-switch ${key === this.boardColumn ? 'is-active' : ''}"
                    data-action="board-column" data-column="${key}" data-focus="switch:${key}"
                    aria-pressed="${key === this.boardColumn}">
                <span>${name}</span>
                <strong>${board.columns[key].total}</strong>
            </button>
        `).join('');

        const draggable = this.canManageWorkspace() && window.matchMedia(TenantAdminApp.WIDE_BOARD).matches;
        columns.innerHTML = window.BoardModel.COLUMNS.map(({ key, label: name }) => {
            const { items, total } = board.columns[key];
            return `
                <section class="board-column ${key === this.boardColumn ? 'is-current' : ''}" data-column="${key}"
                         data-focus="column:${key}" tabindex="-1" aria-label="${name}">
                    <h3 class="board-column-head"><span>${name}</span> <span class="board-column-count">${total}</span></h3>
                    ${items.map(item => this.renderBoardCard(item, draggable, openCards.has(String(item.id)))).join('')
                        || '<p class="board-column-note">Keine Einträge.</p>'}
                    ${total > items.length ? `<p class="board-column-note">Zu sehen sind die letzten ${items.length}.</p>` : ''}
                </section>
            `;
        }).join('');

        if (focusKey) this.focusBoard(focusKey);
    }

    renderBoardFilters(labels) {
        const options = (allLabel, entries, selected) => `<option value="">${allLabel}</option>`
            + entries.map(([value, text]) => `<option value="${this.escapeHtml(value)}"${value === selected ? ' selected' : ''}>${this.escapeHtml(text)}</option>`).join('');

        document.getElementById('boardAppFilter').innerHTML = options(
            'Alle',
            this.apps.map(app => [app.id, app.name || app.slug || app.id]),
            this.boardFilters.appId
        );
        document.getElementById('boardLabelFilter').innerHTML = options(
            'alle',
            labels.map(label => [label, label]),
            this.boardFilters.label
        );
    }

    renderBoardCard(item, draggable, open) {
        const id = this.escapeHtml(item.id);
        const priority = item.priority === 'kritisch' || item.priority === 'hoch'
            ? `<span class="tenant-badge board-priority-${item.priority}">${item.priority}</span>`
            : '';
        const badges = [item.ticketNumber, this.boardFilters.appId ? '' : item.app?.name, ...(item.labels || [])]
            .filter(Boolean)
            .map(text => `<span class="tenant-badge">${this.escapeHtml(text)}</span>`)
            .join('');
        const targets = window.BoardModel.COLUMNS.filter(({ key }) => this.canMoveTo(item, key));

        return `
            <article class="board-card" data-board-card="${id}"${draggable ? ' draggable="true"' : ''}>
                <details class="board-card-details"${open ? ' open' : ''}>
                    <summary data-focus="card:${id}">
                        <span class="board-card-title">${this.escapeHtml(item.title)}</span>
                        <span class="tenant-badges">${priority}${badges}</span>
                    </summary>
                    <p class="board-card-description">${this.escapeHtml(item.description || 'Keine Beschreibung.')}</p>
                    ${this.renderLinkAction(item)}
                </details>
                ${this.renderPublicLine(item)}
                ${this.renderPublicActions(item)}
                ${targets.length ? `
                <details class="board-card-move" name="board-card-move">
                    <summary data-focus="menu:${id}">Verschieben nach</summary>
                    <div class="board-move-options">
                        ${targets.map(({ key, label }) => `<button type="button" data-action="move-card" data-id="${id}" data-column="${key}" data-focus="menu:${id}">${label}</button>`).join('')}
                    </div>
                </details>` : ''}
            </article>
        `;
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

    // Bewusst mehr Reibung als beim Release-Löschen: dort bleiben die Einträge
    // erhalten, hier verschwinden sie unwiderruflich. Deshalb den Slug abtippen
    // statt nur bestätigen — der Server verlangt ihn ebenfalls. Inline statt
    // Browser-Dialog, weil der Slug zum Abtippen danebenstehen muss; ein
    // confirm() kann kein Eingabefeld aufnehmen, und der Browser-Abfragedialog
    // ist in dieser Konsole verboten (tests/admin-auth.test.js).
    askDeleteBoard(trigger) {
        const { appId, appSlug } = trigger.dataset;
        const host = trigger.closest('.tenant-board-item');
        if (!host) return;

        const count = this.suggestions.filter(entry => entry.appId === appId).length;
        host.querySelector('.tenant-team-actions').innerHTML = `
            <div class="tenant-board-confirm">
                <span>${count} Einträge samt Kommentaren, Stimmen und Releases werden unwiderruflich gelöscht. Zum Bestätigen <strong>${this.escapeHtml(appSlug)}</strong> eingeben:</span>
                <input type="text" data-confirm-slug autocomplete="off" placeholder="${this.escapeHtml(appSlug)}">
                <button class="secondary-btn btn-small" type="button" data-action="confirm-delete-board"
                        data-app-id="${this.escapeHtml(appId)}" data-app-slug="${this.escapeHtml(appSlug)}">Endgültig löschen</button>
                <button class="secondary-btn btn-small" type="button" data-action="cancel-delete-board">Abbrechen</button>
            </div>
        `;
        host.querySelector('[data-confirm-slug]').focus();
    }

    async deleteBoard(trigger) {
        if (!this.canManageWorkspace()) {
            this.showToast('Keine Berechtigung für Boards', 'error');
            return;
        }

        const { appId, appSlug: slug } = trigger.dataset;
        // Aus DERSELBEN Zeile lesen: sind zwei Bestätigungen offen, träfe eine
        // globale Suche die falsche.
        const field = trigger.closest('.tenant-board-confirm').querySelector('[data-confirm-slug]');
        const entered = field ? field.value.trim() : '';
        if (entered !== slug) {
            this.showToast(`Bitte "${slug}" exakt eingeben`, 'error');
            if (field) field.focus();
            return;
        }

        try {
            const response = await this.adminFetch(
                this.tenantAdminPath(`/apps/${encodeURIComponent(appId)}`),
                { method: 'DELETE', body: JSON.stringify({ confirm: entered }) }
            );
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Board konnte nicht gelöscht werden');

            const d = result.deleted || {};
            this.showToast(`Board gelöscht (${d.suggestions || 0} Einträge, ${d.releases || 0} Releases)`, 'success');
            await Promise.all([this.loadApps(), this.loadStats(), this.loadReleases(), this.loadSuggestions()]);
        } catch (error) {
            console.error('Error deleting board:', error);
            this.showToast(error.message || 'Board konnte nicht gelöscht werden', 'error');
            this.renderBoards();
        }
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
        const canResend = invite.role !== 'owner' || this.canManageOwnerRoles();

        return `
            <div class="tenant-team-item">
                <strong>${this.escapeHtml(invite.email || 'Unbekannt')}</strong>
                <div class="tenant-badges">
                    <span class="tenant-badge">${this.escapeHtml(this.formatRole(invite.role))}</span>
                    <span class="tenant-badge">${this.escapeHtml(invite.status || 'pending')}</span>
                </div>
                ${this.canManageWorkspace() ? `
                <div class="tenant-team-actions">
                    ${canResend ? `<button class="secondary-btn btn-small" type="button" data-action="resend-invite" data-invite-id="${this.escapeHtml(invite.id)}">Erneut senden</button>` : ''}
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
        // Wartende Änderung und öffentlicher Stand hängen am internen Status,
        // auch wenn die Antwort dazu nichts sagt.
        if (this.feedbackLink(suggestionId)?.pushEnabled) await this.reloadFeedbackState();
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

            // Ein Statuswechsel sagt, was öffentlich daraus wurde.
            const note = result.publicPush?.message;
            this.showToast(
                note ? `${successMessage}. ${note}` : successMessage,
                result.publicPush?.result === 'error' ? 'error' : 'success'
            );
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
            // Plan-Gating läuft über die eigene Klasse .is-gated und NICHT über
            // das rollenbasierte .is-hidden aus renderSessionContext. Sonst
            // toggeln zwei Systeme dieselbe Klasse: ein loadSession()-Rerun (z.B.
            // nach Slug-Umbenennung) entfernt is-hidden für [data-admin-only] und
            // blendet das gegatete Formular wieder ein. Rolle (is-hidden) und Plan
            // (is-gated) sind jetzt unabhängig; beide blenden per CSS aus.
            form.classList.toggle('is-gated', gated);
            const disableForm = gated || !this.canManageWorkspace();
            form.querySelectorAll('input, button').forEach(el => { el.disabled = disableForm; });
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
            detail = 'Kostenlos — für kleine Workspaces. Pro kostet 9 € pro Monat.';
        }

        const features = isPro
            ? ['Unbegrenzt Boards', 'Unbegrenzt Team-Mitglieder', 'API-Zugriff & MCP-Server', 'Kein „Powered by Roadlight“-Badge']
            : ['1 Board', '2 Team-Mitglieder', 'API & MCP (nur Pro)', '„Powered by Roadlight“-Badge'];

        // Nutzung vs. Limit — der Server liefert `usage` nur, wenn das Gating
        // live ist; im Free-Plan zeigen wir daraus „1/1 Board, 2/2 Mitglieder".
        let usageLine = '';
        if (!isPro && b.usage) {
            const u = b.usage;
            usageLine = `<p class="billing-detail">Genutzt: ${u.boards}/${u.boardLimit} Board, ${u.members}/${u.memberLimit} Mitglieder.</p>`;
        }

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
            ${usageLine}
            <ul class="billing-features">${features.map(feature => `<li>${this.escapeHtml(feature)}</li>`).join('')}</ul>
            ${actions}
            ${note ? `<p class="billing-note">${this.escapeHtml(note)}</p>` : ''}
        `;
    }

    openBillingConsentDialog() {
        if (this.currentRole !== 'owner') {
            this.showToast('Nur der Owner kann upgraden', 'error');
            return;
        }
        const form = document.getElementById('billingConsentForm');
        form.reset();
        document.getElementById('billingConsentDialog').showModal();
    }

    async startBillingCheckout(button) {
        if (this.currentRole !== 'owner') {
            this.showToast('Nur der Owner kann upgraden', 'error');
            return;
        }
        if (button) button.disabled = true;
        try {
            const form = document.getElementById('billingConsentForm');
            const response = await this.adminFetch(this.tenantAdminPath('/billing/checkout'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    acceptTerms: form.elements.acceptTerms.checked,
                    confirmBusinessCustomer: form.elements.confirmBusinessCustomer.checked,
                }),
            });
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
        // Maskiert auch beide Anführungszeichen, damit das Ergebnis in Text und
        // Attributwerten sicher ist. In on*-Handler gehört trotzdem kein Nutzertext.
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
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
