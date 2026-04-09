class AdminApp {
    static FEATURE_STATUSES = ['neu', 'wird geprüft', 'wird umgesetzt', 'ist umgesetzt', 'wird nicht umgesetzt'];
    static TICKET_STATUSES = ['neu', 'offen', 'in Bearbeitung', 'wartend', 'gelöst', 'geschlossen'];
    static PRIORITIES = ['niedrig', 'mittel', 'hoch', 'kritisch'];
    static RESOLVED_STATUSES = ['ist umgesetzt', 'wird nicht umgesetzt', 'gelöst', 'geschlossen'];

    constructor() {
        this.adminToken = null;
        this.apps = [];
        this.filters = { app: '', type: '', status: '', priority: '' };
        this.init();
    }

    init() {
        this.checkAuth();
        this.bindEvents();
        this.loadData();
    }

    checkAuth() {
        // Check if admin token exists in localStorage
        this.adminToken = localStorage.getItem('adminToken');
        if (!this.adminToken) {
            this.showAuthPrompt();
        }
    }

    showAuthPrompt() {
        const password = prompt('Admin-Passwort eingeben:');
        if (password) {
            this.adminToken = password;
            localStorage.setItem('adminToken', password);
            this.loadData();
        } else {
            window.location.href = '/';
        }
    }

    bindEvents() {
        // Modal events
        document.getElementById('addAppBtn').addEventListener('click', () => this.showAppModal());
        document.getElementById('closeModal').addEventListener('click', () => this.hideAppModal());
        document.getElementById('cancelBtn').addEventListener('click', () => this.hideAppModal());

        // Form submission
        document.getElementById('appForm').addEventListener('submit', (e) => this.saveApp(e));

        // Close modal on outside click
        document.getElementById('appModal').addEventListener('click', (e) => {
            if (e.target.id === 'appModal') {
                this.hideAppModal();
            }
        });
    }

    async loadData() {
        await Promise.all([
            this.loadStats(),
            this.loadApps(),
            this.loadSuggestions()
        ]);
    }

    async loadStats() {
        try {
            const response = await this.adminFetch('/api/admin/stats');
            const stats = await response.json();

            if (response.ok) {
                document.getElementById('totalApps').textContent = stats.totalApps;
                document.getElementById('totalFeatures').textContent = stats.totalFeatures || 0;
                document.getElementById('totalTickets').textContent = stats.totalTickets || 0;
                document.getElementById('totalBugs').textContent = stats.totalBugs || 0;
                document.getElementById('totalVotes').textContent = stats.totalVotes;
            } else {
                throw new Error(stats.error);
            }
        } catch (error) {
            console.error('Error loading stats:', error);
            if (error.message.includes('Unauthorized')) {
                this.handleAuthError();
            } else {
                this.showToast('Fehler beim Laden der Statistiken', 'error');
            }
        }
    }

    async loadApps() {
        try {
            const response = await fetch('/api/apps');
            const apps = await response.json();

            if (response.ok) {
                this.apps = apps;
                this.renderApps(apps);
            } else {
                throw new Error(apps.error);
            }
        } catch (error) {
            console.error('Error loading apps:', error);
            this.showToast('Fehler beim Laden der Apps', 'error');
        }
    }

    async loadSuggestions() {
        try {
            const response = await this.adminFetch('/api/admin/suggestions');
            const suggestions = await response.json();

            if (response.ok) {
                this.suggestions = suggestions;
                this.renderSuggestions(suggestions);
            } else {
                throw new Error(suggestions.error);
            }
        } catch (error) {
            console.error('Error loading suggestions:', error);
            if (error.message.includes('Unauthorized')) {
                this.handleAuthError();
            } else {
                this.showToast('Fehler beim Laden der Vorschläge', 'error');
            }
        }
    }

    renderApps(apps) {
        const appsList = document.getElementById('appsList');

        if (apps.length === 0) {
            appsList.innerHTML = `
                <div class="loading">
                    Noch keine Apps vorhanden.<br>
                    Fügen Sie die erste App hinzu!
                </div>
            `;
            return;
        }

        appsList.innerHTML = apps.map(app => `
            <div class="app-item">
                <div class="app-details">
                    <h4>${this.escapeHtml(app.name)} ${app.ticketPrefix ? `<span style="font-size: 0.75rem; color: var(--text-muted); font-weight: 400;">[${this.escapeHtml(app.ticketPrefix)}]</span>` : ''}</h4>
                    <p>${this.escapeHtml(app.description)}</p>
                </div>
                <div class="app-actions">
                    <button class="secondary-btn btn-small" onclick="adminApp.editApp('${app.id}')">
                        Bearbeiten
                    </button>
                    <button class="btn-danger btn-small" onclick="adminApp.deleteApp('${app.id}', '${this.escapeHtml(app.name)}')">
                        Löschen
                    </button>
                </div>
            </div>
        `).join('');
    }

    applyFilters() {
        this.filters.app = document.getElementById('appFilter').value;
        this.filters.type = document.getElementById('typeFilter').value;
        this.filters.status = document.getElementById('statusFilter').value;
        this.filters.priority = document.getElementById('priorityFilter').value;
        this.renderSuggestions(this.suggestions);
    }

    renderSuggestions(suggestions) {
        const suggestionsList = document.getElementById('suggestionsList');

        // Populate app filter dropdown
        const appFilter = document.getElementById('appFilter');
        if (appFilter && this.apps.length > 0) {
            const currentValue = this.filters.app;
            appFilter.innerHTML = '<option value="">Alle Apps</option>' +
                this.apps.map(app =>
                    `<option value="${app.id}" ${currentValue === app.id ? 'selected' : ''}>${this.escapeHtml(app.name)}</option>`
                ).join('');
        }

        // Populate status filter from available statuses
        const statusFilter = document.getElementById('statusFilter');
        if (statusFilter) {
            const allStatuses = [...new Set(suggestions.map(s => s.status).filter(Boolean))];
            const currentStatus = this.filters.status;
            statusFilter.innerHTML = '<option value="">Alle Status</option>' +
                allStatuses.map(s => `<option value="${s}" ${currentStatus === s ? 'selected' : ''}>${this.escapeHtml(s)}</option>`).join('');
        }

        // Apply all filters
        let filtered = suggestions;
        if (this.filters.app) filtered = filtered.filter(s => s.appId === this.filters.app);
        if (this.filters.type) filtered = filtered.filter(s => s.type === this.filters.type);
        if (this.filters.status) filtered = filtered.filter(s => s.status === this.filters.status);
        if (this.filters.priority) filtered = filtered.filter(s => s.priority === this.filters.priority);

        if (filtered.length === 0) {
            suggestionsList.innerHTML = `<div class="loading">Keine Einträge gefunden.</div>`;
            return;
        }

        suggestionsList.innerHTML = filtered.map(suggestion => {
            const suggestionType = suggestion.type || 'feature';
            const status = suggestion.status || '';
            const isApproved = suggestion.approved === true;
            const resolvedStatuses = AdminApp.RESOLVED_STATUSES;
            const isResolved = resolvedStatuses.includes(status);
            const itemOpacity = isResolved ? 'opacity: 0.5;' : '';

            const typeIcons = { bug: '🐞 Bug', ticket: '🎫 Ticket', feature: '✨ Feature' };
            const typeColors = { bug: '#ef4444', ticket: '#a855f7', feature: '#4f46e5' };
            const typeBadge = `<span style="background: ${typeColors[suggestionType] || '#4f46e5'}; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px;">${typeIcons[suggestionType] || '✨ Feature'}</span>`;

            const approvalBadge = isApproved
                ? '<span style="background: #10b981; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px;">✓ Freigegeben</span>'
                : '<span style="background: #f59e0b; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px;">⏳ Wartet</span>';

            const ticketNumberBadge = suggestion.ticketNumber
                ? `<span style="font-family: monospace; font-size: 12px; background: var(--surface); border: 1px solid var(--border); padding: 3px 7px; border-radius: 4px; color: var(--text-muted); font-weight: 600;">${this.escapeHtml(suggestion.ticketNumber)}</span>`
                : '';

            const hasComments = suggestion.commentCount > 0;
            const commentBadge = hasComments
                ? `<span style="background: #3b82f6; color: white; padding: 4px 8px; border-radius: 4px; font-size: 12px;">💬 ${suggestion.commentCount}</span>`
                : '';

            // Labels
            const labelPills = (suggestion.labels || []).map(l =>
                `<span style="font-size: 11px; padding: 2px 8px; border-radius: 9999px; background: var(--surface); border: 1px solid var(--border); color: var(--text-secondary); margin-right: 4px;">${this.escapeHtml(l)} <button onclick="adminApp.removeLabel('${suggestion.id}', '${this.escapeHtml(l)}')" style="border:none;background:none;cursor:pointer;color:var(--text-muted);font-size:11px;padding:0 0 0 2px;">×</button></span>`
            ).join('');

            // Status options for this type
            const statuses = suggestionType === 'feature' ? AdminApp.FEATURE_STATUSES : AdminApp.TICKET_STATUSES;

            // Priority color
            const priorityColors = { niedrig: '#3b82f6', mittel: '#f59e0b', hoch: '#f97316', kritisch: '#ef4444' };
            const pColor = priorityColors[suggestion.priority] || '#6b7280';

            return `
                <div class="suggestion-item" style="border-left: 4px solid ${isApproved ? '#10b981' : '#f59e0b'}; ${itemOpacity}">
                    <div class="suggestion-header">
                        <div class="suggestion-content">
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 8px; flex-wrap: wrap;">
                                ${ticketNumberBadge}
                                <h4 style="margin: 0;">${this.escapeHtml(suggestion.title)}</h4>
                                ${typeBadge}
                                ${approvalBadge}
                                ${commentBadge}
                            </div>
                            <p>${this.escapeHtml(suggestion.description)}</p>
                            <div class="suggestion-meta">
                                <div class="meta-item"><strong>App:</strong> ${this.escapeHtml(suggestion.app.name)}</div>
                                ${suggestionType === 'feature' ? `<div class="meta-item"><strong>Votes:</strong> ${suggestion.votes || 0}</div>` : ''}
                                <div class="meta-item"><strong>Erstellt:</strong> ${this.formatDate(suggestion.createdAt)}</div>
                            </div>
                            <div style="margin-top: 12px; display: flex; gap: 12px; flex-wrap: wrap; align-items: end;">
                                <div>
                                    <label style="display: block; margin-bottom: 4px; font-size: 0.8rem; color: var(--text-secondary); font-weight: 500;">Status:</label>
                                    <select onchange="adminApp.updateStatus('${suggestion.id}', this.value)" style="padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text-primary); font-size: 0.85rem; cursor: pointer;">
                                        ${statuses.map(s => `<option value="${s}" ${status === s ? 'selected' : ''}>${s}</option>`).join('')}
                                    </select>
                                </div>
                                <div>
                                    <label style="display: block; margin-bottom: 4px; font-size: 0.8rem; color: var(--text-secondary); font-weight: 500;">Priorität:</label>
                                    <select onchange="adminApp.updatePriority('${suggestion.id}', this.value)" style="padding: 6px 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: ${pColor}; font-size: 0.85rem; cursor: pointer; font-weight: 600;">
                                        ${AdminApp.PRIORITIES.map(p => `<option value="${p}" ${suggestion.priority === p ? 'selected' : ''}>${p.charAt(0).toUpperCase() + p.slice(1)}</option>`).join('')}
                                    </select>
                                </div>
                            </div>
                            ${labelPills ? `<div style="margin-top: 8px;">${labelPills}</div>` : ''}
                            <div style="margin-top: 8px;">
                                <button class="secondary-btn btn-small" onclick="adminApp.promptAddLabel('${suggestion.id}')" style="font-size: 11px; padding: 2px 8px;">+ Label</button>
                            </div>
                            <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border-light); display: flex; gap: 8px; flex-wrap: wrap;">
                                <button class="secondary-btn btn-small" onclick="adminApp.toggleComments('${suggestion.id}')" style="flex: 1;">
                                    ${hasComments ? `💬 Kommentare (${suggestion.commentCount})` : '💬 Kommentar'}
                                </button>
                                <button class="secondary-btn btn-small" onclick="adminApp.toggleActivity('${suggestion.id}')" style="flex: 1;">
                                    📋 Aktivität
                                </button>
                            </div>
                            <div id="comments-${suggestion.id}" style="display: none; margin-top: 12px;">
                                <div class="loading">Kommentare werden geladen...</div>
                            </div>
                            <div id="activity-${suggestion.id}" style="display: none; margin-top: 12px;">
                                <div class="loading">Aktivität wird geladen...</div>
                            </div>
                        </div>
                        <div class="suggestion-actions" style="display: flex; gap: 8px; flex-direction: column;">
                            ${!isApproved ? `
                                <button class="primary-btn btn-small" onclick="adminApp.approveSuggestion('${suggestion.id}', '${this.escapeHtml(suggestion.title)}')">
                                    Freigeben
                                </button>
                            ` : ''}
                            <button class="btn-danger btn-small" onclick="adminApp.deleteSuggestion('${suggestion.id}', '${this.escapeHtml(suggestion.title)}')">
                                Löschen
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
    }

    showAppModal(app = null) {
        const modal = document.getElementById('appModal');
        const form = document.getElementById('appForm');
        const title = document.getElementById('modalTitle');

        // Reset form
        form.reset();

        if (app) {
            title.textContent = 'App bearbeiten';
            document.getElementById('appId').value = app.id;
            document.getElementById('appName').value = app.name;
            document.getElementById('appDescription').value = app.description;
            document.getElementById('appTicketPrefix').value = app.ticketPrefix || '';
        } else {
            title.textContent = 'Neue App hinzufügen';
            document.getElementById('appId').value = '';
        }

        modal.classList.add('show');
        document.getElementById('appName').focus();
    }

    hideAppModal() {
        document.getElementById('appModal').classList.remove('show');
    }

    async saveApp(e) {
        e.preventDefault();

        const appId = document.getElementById('appId').value;
        const name = document.getElementById('appName').value.trim();
        const description = document.getElementById('appDescription').value.trim();
        const ticketPrefix = (document.getElementById('appTicketPrefix').value || '').trim().toUpperCase();

        if (!name || !description) {
            this.showToast('Bitte füllen Sie alle Felder aus', 'error');
            return;
        }

        try {
            const isEdit = !!appId;
            const url = isEdit ? `/api/admin/apps/${appId}` : '/api/admin/apps';
            const method = isEdit ? 'PUT' : 'POST';

            const payload = { name, description };
            if (ticketPrefix) payload.ticketPrefix = ticketPrefix;

            const response = await this.adminFetch(url, {
                method,
                body: JSON.stringify(payload)
            });

            const result = await response.json();

            if (response.ok) {
                this.showToast(
                    isEdit ? 'App erfolgreich aktualisiert!' : 'App erfolgreich erstellt!',
                    'success'
                );
                this.hideAppModal();
                this.loadData();
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            console.error('Error saving app:', error);
            if (error.message.includes('Unauthorized')) {
                this.handleAuthError();
            } else {
                this.showToast(error.message || 'Fehler beim Speichern der App', 'error');
            }
        }
    }

    editApp(appId) {
        const app = this.apps.find(a => a.id === appId);
        if (app) {
            this.showAppModal(app);
        }
    }

    async deleteApp(appId, appName) {
        if (!confirm(`Sind Sie sicher, dass Sie "${appName}" löschen möchten?\n\nDies löscht auch alle Vorschläge und Votes für diese App!`)) {
            return;
        }

        try {
            const response = await this.adminFetch(`/api/admin/apps/${appId}`, {
                method: 'DELETE'
            });

            const result = await response.json();

            if (response.ok) {
                this.showToast('App erfolgreich gelöscht!', 'success');
                this.loadData();
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            console.error('Error deleting app:', error);
            if (error.message.includes('Unauthorized')) {
                this.handleAuthError();
            } else {
                this.showToast(error.message || 'Fehler beim Löschen der App', 'error');
            }
        }
    }

    async approveSuggestion(suggestionId, suggestionTitle) {
        if (!confirm(`Möchten Sie den Vorschlag "${suggestionTitle}" freigeben?\n\nDer Vorschlag wird dann öffentlich sichtbar.`)) {
            return;
        }

        try {
            const response = await this.adminFetch(`/api/admin/suggestions/${suggestionId}/approve`, {
                method: 'POST'
            });

            const result = await response.json();

            if (response.ok) {
                this.showToast('Vorschlag erfolgreich freigegeben!', 'success');
                this.loadData();
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            console.error('Error approving suggestion:', error);
            if (error.message.includes('Unauthorized')) {
                this.handleAuthError();
            } else {
                this.showToast(error.message || 'Fehler beim Freigeben des Vorschlags', 'error');
            }
        }
    }

    async deleteSuggestion(suggestionId, suggestionTitle) {
        if (!confirm(`Sind Sie sicher, dass Sie den Vorschlag "${suggestionTitle}" löschen möchten?\n\nDies löscht auch alle Votes für diesen Vorschlag!`)) {
            return;
        }

        try {
            const response = await this.adminFetch(`/api/admin/suggestions/${suggestionId}`, {
                method: 'DELETE'
            });

            const result = await response.json();

            if (response.ok) {
                this.showToast(`Vorschlag erfolgreich gelöscht! (${result.deletedVotes} Votes entfernt)`, 'success');
                this.loadData();
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            console.error('Error deleting suggestion:', error);
            if (error.message.includes('Unauthorized')) {
                this.handleAuthError();
            } else {
                this.showToast(error.message || 'Fehler beim Löschen des Vorschlags', 'error');
            }
        }
    }

    async updateStatus(suggestionId, status) {
        try {
            const response = await this.adminFetch(`/api/admin/suggestions/${suggestionId}/status`, {
                method: 'PUT',
                body: JSON.stringify({ status })
            });
            const result = await response.json();
            if (response.ok) {
                this.showToast('Status aktualisiert!', 'success');
                this.loadData();
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            console.error('Error updating status:', error);
            this.showToast(error.message || 'Fehler beim Aktualisieren', 'error');
        }
    }

    async updatePriority(suggestionId, priority) {
        try {
            const response = await this.adminFetch(`/api/admin/suggestions/${suggestionId}/priority`, {
                method: 'PUT',
                body: JSON.stringify({ priority })
            });
            const result = await response.json();
            if (response.ok) {
                this.showToast('Priorität aktualisiert!', 'success');
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            console.error('Error updating priority:', error);
            this.showToast(error.message || 'Fehler beim Aktualisieren', 'error');
        }
    }

    async promptAddLabel(suggestionId) {
        const label = prompt('Label eingeben:');
        if (!label || !label.trim()) return;
        try {
            const response = await this.adminFetch(`/api/admin/suggestions/${suggestionId}/labels`, {
                method: 'POST',
                body: JSON.stringify({ label: label.trim() })
            });
            const result = await response.json();
            if (response.ok) {
                this.showToast('Label hinzugefügt!', 'success');
                this.loadData();
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            console.error('Error adding label:', error);
            this.showToast(error.message || 'Fehler beim Hinzufügen', 'error');
        }
    }

    async removeLabel(suggestionId, label) {
        try {
            const response = await this.adminFetch(`/api/admin/suggestions/${suggestionId}/labels/${encodeURIComponent(label)}`, {
                method: 'DELETE',
            });
            const result = await response.json();
            if (response.ok) {
                this.showToast('Label entfernt!', 'success');
                this.loadData();
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            console.error('Error removing label:', error);
            this.showToast(error.message || 'Fehler beim Entfernen', 'error');
        }
    }

    async toggleActivity(suggestionId) {
        const activityDiv = document.getElementById(`activity-${suggestionId}`);
        if (activityDiv.style.display === 'none') {
            activityDiv.style.display = 'block';
            await this.loadActivity(suggestionId);
        } else {
            activityDiv.style.display = 'none';
        }
    }

    async loadActivity(suggestionId) {
        const activityDiv = document.getElementById(`activity-${suggestionId}`);
        try {
            const response = await this.adminFetch(`/api/admin/suggestions/${suggestionId}/activity`);
            const activities = await response.json();

            if (!response.ok) throw new Error(activities.error);

            if (activities.length === 0) {
                activityDiv.innerHTML = '<p style="color: var(--text-secondary); font-size: 0.85rem; font-style: italic;">Keine Aktivität vorhanden.</p>';
                return;
            }

            activityDiv.innerHTML = `
                <div class="activity-timeline">
                    ${activities.map(a => `
                        <div class="activity-entry">
                            <span class="activity-time">${this.formatDate(a.createdAt)}</span>
                            <span>${this.escapeHtml(a.detail || a.action)}</span>
                        </div>
                    `).join('')}
                </div>
            `;
        } catch (error) {
            console.error('Error loading activity:', error);
            activityDiv.innerHTML = '<div style="color: var(--danger-color); padding: 8px;">Fehler beim Laden</div>';
        }
    }

    async adminFetch(url, options = {}) {
        const defaultOptions = {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.adminToken}`
            }
        };

        return fetch(url, { ...defaultOptions, ...options });
    }

    handleAuthError() {
        localStorage.removeItem('adminToken');
        this.showToast('Authentifizierung fehlgeschlagen. Bitte erneut anmelden.', 'error');
        setTimeout(() => {
            this.showAuthPrompt();
        }, 2000);
    }

    escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    showToast(message, type = 'success') {
        const toast = document.getElementById('toast');
        toast.textContent = message;
        toast.className = `toast ${type}`;

        // Show toast
        toast.classList.add('show');

        // Hide after 4 seconds
        setTimeout(() => {
            toast.classList.remove('show');
        }, 4000);
    }

    formatDate(timestamp) {
        if (!timestamp) return 'Unbekannt';
        try {
            let date;

            // Handle Firestore timestamp object (from server)
            if (timestamp._seconds !== undefined) {
                date = new Date(timestamp._seconds * 1000);
            } else if (timestamp.seconds !== undefined) {
                date = new Date(timestamp.seconds * 1000);
            } else if (timestamp.toDate) {
                // Handle Firestore timestamp (client SDK)
                date = timestamp.toDate();
            } else if (typeof timestamp === 'string' || typeof timestamp === 'number') {
                date = new Date(timestamp);
            } else {
                return 'Unbekannt';
            }

            // Check if date is valid
            if (isNaN(date.getTime())) {
                return 'Unbekannt';
            }

            return date.toLocaleDateString('de-DE', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        } catch (error) {
            console.error('Error formatting date:', error, timestamp);
            return 'Unbekannt';
        }
    }

    async toggleComments(suggestionId) {
        const commentsDiv = document.getElementById(`comments-${suggestionId}`);

        if (commentsDiv.style.display === 'none') {
            commentsDiv.style.display = 'block';
            await this.loadComments(suggestionId);
        } else {
            commentsDiv.style.display = 'none';
        }
    }

    async loadComments(suggestionId) {
        const commentsDiv = document.getElementById(`comments-${suggestionId}`);

        try {
            const response = await this.adminFetch(`/api/admin/suggestions/${suggestionId}/comments`);
            const comments = await response.json();

            if (response.ok) {
                this.renderComments(suggestionId, comments);
            } else {
                throw new Error(comments.error);
            }
        } catch (error) {
            console.error('Error loading comments:', error);
            commentsDiv.innerHTML = '<div style="color: var(--danger-color); padding: 8px;">Fehler beim Laden der Kommentare</div>';
        }
    }

    renderComments(suggestionId, comments) {
        const commentsDiv = document.getElementById(`comments-${suggestionId}`);

        let html = `
            <div style="background: var(--border-light); padding: 12px; border-radius: 8px; margin-bottom: 12px;">
                <h5 style="margin: 0 0 8px 0; font-size: 0.9rem;">Neuer Kommentar</h5>
                <textarea
                    id="comment-text-${suggestionId}"
                    placeholder="Kommentar eingeben..."
                    style="width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--surface); color: var(--text-primary); font-family: inherit; font-size: 0.9rem; min-height: 80px; resize: vertical;"
                ></textarea>
                <div style="margin-top: 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                    <input
                        type="file"
                        id="comment-files-${suggestionId}"
                        accept="image/*"
                        multiple
                        style="display: none;"
                        onchange="adminApp.handleScreenshotSelect('${suggestionId}')"
                    >
                    <button
                        class="secondary-btn btn-small"
                        onclick="document.getElementById('comment-files-${suggestionId}').click()"
                    >
                        📎 Screenshot hinzufügen
                    </button>
                    <button
                        class="primary-btn btn-small"
                        onclick="adminApp.addComment('${suggestionId}')"
                    >
                        Kommentar speichern
                    </button>
                    <div id="screenshot-preview-${suggestionId}" style="display: flex; gap: 8px; flex-wrap: wrap;"></div>
                </div>
            </div>
        `;

        if (comments.length > 0) {
            html += '<div style="margin-top: 12px;">';
            html += '<h5 style="margin: 0 0 8px 0; font-size: 0.9rem; color: var(--text-secondary);">Kommentare:</h5>';

            comments.forEach(comment => {
                html += `
                    <div style="background: var(--surface); border: 1px solid var(--border); padding: 12px; border-radius: 8px; margin-bottom: 8px;">
                        <div style="display: flex; justify-content: space-between; align-items: start; gap: 8px;">
                            <div style="flex: 1;">
                                <p style="margin: 0 0 4px 0; white-space: pre-wrap;">${this.escapeHtml(comment.text)}</p>
                                <div style="font-size: 0.8rem; color: var(--text-secondary);">
                                    ${this.formatDate(comment.createdAt)}
                                </div>
                            </div>
                            <button
                                class="btn-danger btn-small"
                                onclick="adminApp.deleteComment('${suggestionId}', '${comment.id}')"
                                style="flex-shrink: 0;"
                            >
                                Löschen
                            </button>
                        </div>
                        ${comment.screenshots && comment.screenshots.length > 0 ? `
                            <div style="display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap;">
                                ${comment.screenshots.map((screenshot, idx) => `
                                    <img
                                        src="${screenshot}"
                                        alt="Screenshot ${idx + 1}"
                                        onclick="adminApp.showImageModal(this.src)"
                                        style="max-width: 150px; max-height: 150px; border-radius: 6px; cursor: pointer; border: 1px solid var(--border); object-fit: cover; transition: transform 0.2s;"
                                        onmouseover="this.style.transform='scale(1.05)'"
                                        onmouseout="this.style.transform='scale(1)'"
                                    >
                                `).join('')}
                            </div>
                        ` : ''}
                    </div>
                `;
            });

            html += '</div>';
        } else {
            html += '<p style="color: var(--text-secondary); font-size: 0.9rem; font-style: italic; margin-top: 12px;">Noch keine Kommentare vorhanden.</p>';
        }

        commentsDiv.innerHTML = html;
    }

    selectedScreenshots = {};

    handleScreenshotSelect(suggestionId) {
        const fileInput = document.getElementById(`comment-files-${suggestionId}`);
        const files = Array.from(fileInput.files);

        if (files.length > 5) {
            this.showToast('Maximal 5 Screenshots erlaubt', 'error');
            fileInput.value = '';
            return;
        }

        this.selectedScreenshots[suggestionId] = [];
        const previewDiv = document.getElementById(`screenshot-preview-${suggestionId}`);
        previewDiv.innerHTML = '';

        files.forEach((file, idx) => {
            this.compressImage(file, 800, 0.6).then(compressedDataUrl => {
                // Check size (max 200KB per image)
                const sizeInBytes = compressedDataUrl.length * 0.75; // Approximate base64 to bytes
                if (sizeInBytes > 200000) {
                    this.showToast('Bild zu groß. Bitte kleineres Bild verwenden.', 'error');
                    return;
                }

                this.selectedScreenshots[suggestionId].push(compressedDataUrl);

                const imgContainer = document.createElement('div');
                imgContainer.style.cssText = 'position: relative; display: inline-block;';
                imgContainer.innerHTML = `
                    <img
                        src="${compressedDataUrl}"
                        style="width: 60px; height: 60px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border);"
                    >
                    <button
                        onclick="adminApp.removeScreenshot('${suggestionId}', ${idx})"
                        style="position: absolute; top: -6px; right: -6px; background: var(--danger-color); color: white; border: none; border-radius: 50%; width: 20px; height: 20px; font-size: 12px; cursor: pointer; line-height: 1; padding: 0;"
                    >×</button>
                `;
                previewDiv.appendChild(imgContainer);
            }).catch(error => {
                console.error('Error compressing image:', error);
                this.showToast('Fehler beim Verarbeiten des Bildes', 'error');
            });
        });
    }

    compressImage(file, maxWidth, quality) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    // Calculate new dimensions
                    let width = img.width;
                    let height = img.height;

                    if (width > maxWidth) {
                        height = (height * maxWidth) / width;
                        width = maxWidth;
                    }

                    // Create canvas and compress
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);

                    // Convert to data URL with compression
                    resolve(canvas.toDataURL('image/jpeg', quality));
                };
                img.onerror = reject;
                img.src = e.target.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    removeScreenshot(suggestionId, index) {
        this.selectedScreenshots[suggestionId].splice(index, 1);
        const fileInput = document.getElementById(`comment-files-${suggestionId}`);
        fileInput.value = '';

        // Re-render preview
        const previewDiv = document.getElementById(`screenshot-preview-${suggestionId}`);
        previewDiv.innerHTML = '';
        this.selectedScreenshots[suggestionId].forEach((screenshot, idx) => {
            const imgContainer = document.createElement('div');
            imgContainer.style.cssText = 'position: relative; display: inline-block;';
            imgContainer.innerHTML = `
                <img
                    src="${screenshot}"
                    style="width: 60px; height: 60px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border);"
                >
                <button
                    onclick="adminApp.removeScreenshot('${suggestionId}', ${idx})"
                    style="position: absolute; top: -6px; right: -6px; background: var(--danger-color); color: white; border: none; border-radius: 50%; width: 20px; height: 20px; font-size: 12px; cursor: pointer; line-height: 1; padding: 0;"
                >×</button>
            `;
            previewDiv.appendChild(imgContainer);
        });
    }

    async addComment(suggestionId) {
        const textArea = document.getElementById(`comment-text-${suggestionId}`);
        const text = textArea.value.trim();

        if (!text) {
            this.showToast('Bitte geben Sie einen Kommentar ein', 'error');
            return;
        }

        const screenshots = this.selectedScreenshots[suggestionId] || [];

        try {
            const response = await this.adminFetch(`/api/admin/suggestions/${suggestionId}/comments`, {
                method: 'POST',
                body: JSON.stringify({ text, screenshots })
            });

            const result = await response.json();

            if (response.ok) {
                this.showToast('Kommentar erfolgreich hinzugefügt!', 'success');
                textArea.value = '';
                this.selectedScreenshots[suggestionId] = [];
                const fileInput = document.getElementById(`comment-files-${suggestionId}`);
                if (fileInput) fileInput.value = '';
                await this.loadComments(suggestionId);
                await this.loadSuggestions(); // Reload to update comment count
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            console.error('Error adding comment:', error);
            this.showToast(error.message || 'Fehler beim Hinzufügen des Kommentars', 'error');
        }
    }

    async deleteComment(suggestionId, commentId) {
        if (!confirm('Möchten Sie diesen Kommentar wirklich löschen?')) {
            return;
        }

        try {
            const response = await this.adminFetch(`/api/admin/suggestions/${suggestionId}/comments/${commentId}`, {
                method: 'DELETE'
            });

            const result = await response.json();

            if (response.ok) {
                this.showToast('Kommentar erfolgreich gelöscht!', 'success');
                await this.loadComments(suggestionId);
                await this.loadSuggestions(); // Reload to update comment count
            } else {
                throw new Error(result.error);
            }
        } catch (error) {
            console.error('Error deleting comment:', error);
            this.showToast(error.message || 'Fehler beim Löschen des Kommentars', 'error');
        }
    }

    showImageModal(imageSrc) {
        const modal = document.getElementById('imageModal');
        const modalImage = document.getElementById('modalImage');
        modalImage.src = imageSrc;
        modal.style.display = 'flex';
        document.body.style.overflow = 'hidden';
    }

    closeImageModal() {
        const modal = document.getElementById('imageModal');
        modal.style.display = 'none';
        document.body.style.overflow = '';
    }
}

// Initialize the admin app
const adminApp = new AdminApp();
