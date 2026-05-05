class SuperAdminApp {
    constructor() {
        this.form = document.getElementById('tenantProvisionForm');
        this.status = document.getElementById('provisionStatus');
        this.result = document.getElementById('provisionResult');
        this.submitButton = document.getElementById('createTenantBtn');
        this.tenantList = document.getElementById('tenantList');
        this.pilotTenantSlugInput = document.getElementById('pilotTenantSlug');
        this.pilotTenantStatus = document.getElementById('pilotTenantStatus');
        this.pilotStatusPill = document.getElementById('pilotStatusPill');
        this.pilotChecklistKey = 'superAdmin:friendlyPilotChecklist';
        this.tenants = [];
        this.init();
    }

    init() {
        window.adminAuth.requireAuth().then(() => this.loadTenants());
        document.getElementById('logoutBtn').addEventListener('click', () => window.adminAuth.logout());
        document.getElementById('refreshTenantsBtn').addEventListener('click', () => this.loadTenants());
        this.pilotTenantSlugInput.addEventListener('input', () => this.updatePilotLinks());
        document.querySelectorAll('[data-pilot-check]').forEach(input => {
            input.addEventListener('change', () => this.savePilotChecklist());
        });
        document.querySelectorAll('[data-copy-target]').forEach(btn => {
            btn.addEventListener('click', () => this.copyLink(btn));
        });
        this.loadPilotChecklist();
        this.updatePilotLinks();

        this.form.addEventListener('submit', event => {
            event.preventDefault();
            this.provisionTenant();
        });
    }

    buildPayload() {
        const formData = new FormData(this.form);
        const payload = {
            tenantName: this.cleanValue(formData.get('tenantName')),
            tenantSlug: this.cleanValue(formData.get('tenantSlug')),
            appName: this.cleanValue(formData.get('appName')),
            ticketPrefix: this.cleanValue(formData.get('ticketPrefix')).toUpperCase(),
        };

        Object.keys(payload).forEach(key => {
            if (!payload[key]) delete payload[key];
        });

        return payload;
    }

    cleanValue(value) {
        return typeof value === 'string' ? value.trim() : '';
    }

    async provisionTenant() {
        const payload = this.buildPayload();
        this.setStatus('Tenant wird erstellt…', '');
        this.result.classList.remove('is-visible');
        this.submitButton.disabled = true;

        try {
            const response = await window.adminAuth.authFetch('/api/admin/tenants', {
                method: 'POST',
                body: JSON.stringify(payload),
            });

            const data = await response.json();

            if (response.status === 401) {
                this.setStatus('Authentifizierung fehlgeschlagen.', 'error');
                return;
            }

            if (!response.ok) {
                throw new Error(data.error || 'Tenant konnte nicht erstellt werden');
            }

            this.renderResult(data);
            this.setStatus('Tenant erstellt.', 'success');
            this.form.reset();
            await this.loadTenants();
        } catch (error) {
            this.setStatus(error.message || 'Tenant konnte nicht erstellt werden', 'error');
        } finally {
            this.submitButton.disabled = false;
        }
    }

    async loadTenants() {
        this.tenantList.innerHTML = '<div class="sa-status">Lade Tenants…</div>';

        try {
            const response = await window.adminAuth.authFetch('/api/admin/tenants');
            const tenants = await response.json();

            if (response.status === 401) {
                this.tenantList.innerHTML = '<div class="sa-status is-error">Authentifizierung fehlgeschlagen.</div>';
                return;
            }

            if (!response.ok) {
                throw new Error(tenants.error || 'Tenants konnten nicht geladen werden');
            }

            this.tenants = Array.isArray(tenants) ? tenants : [];
            this.renderTenantList(this.tenants);
            this.setDefaultPilotTenant(this.tenants);
            this.renderPilotStatus();
        } catch (error) {
            this.tenantList.innerHTML = `<div class="sa-status is-error">${this.escapeHtml(error.message || 'Tenants konnten nicht geladen werden')}</div>`;
        }
    }

    renderTenantList(tenants) {
        if (!Array.isArray(tenants) || tenants.length === 0) {
            this.tenantList.innerHTML = '<div class="sa-status">Keine Tenants gefunden.</div>';
            return;
        }

        this.tenantList.innerHTML = tenants.map(tenant => this.renderTenantItem(tenant)).join('');
    }

    renderTenantItem(tenant) {
        const slug = tenant.slug || tenant.id;
        const firstAppSlug = tenant.firstApp?.slug || '';
        const publicUrl = firstAppSlug
            ? `/?tenant=${encodeURIComponent(slug)}&app=${encodeURIComponent(firstAppSlug)}`
            : `/?tenant=${encodeURIComponent(slug)}`;
        const adminUrl = `/tenant-admin.html?tenant=${encodeURIComponent(slug)}`;
        const statusBadgeClass = tenant.status === 'active' ? 'is-active' : '';

        return `
            <article class="tenant-list-item">
                <div class="tenant-list-item-main">
                    <h4>${this.escapeHtml(tenant.name || slug)}</h4>
                    <div class="tenant-list-meta">
                        <span class="tenant-list-badge">${this.escapeHtml(slug)}</span>
                        <span class="tenant-list-badge ${statusBadgeClass}">${this.escapeHtml(tenant.status || 'unknown')}</span>
                        ${tenant.legacy ? '<span class="tenant-list-badge is-legacy">legacy</span>' : ''}
                        <span class="tenant-list-badge">${this.escapeHtml(String(tenant.appCount || 0))} Boards</span>
                    </div>
                </div>
                <div class="tenant-list-actions">
                    <a href="${this.escapeHtml(publicUrl)}">Board</a>
                    <a href="${this.escapeHtml(adminUrl)}">Admin</a>
                </div>
            </article>
        `;
    }

    setDefaultPilotTenant(tenants) {
        if (this.cleanValue(this.pilotTenantSlugInput.value)) return;
        const firstPilotTenant = (Array.isArray(tenants) ? tenants : [])
            .find(tenant => !tenant.legacy && tenant.status === 'active');
        if (!firstPilotTenant) return;

        this.pilotTenantSlugInput.value = firstPilotTenant.slug || firstPilotTenant.id || '';
        this.updatePilotLinks();
    }

    normalizeSlug(value) {
        return (value || '')
            .toLowerCase()
            .replace(/[^a-z0-9-]+/g, '-')
            .replace(/^-+|-+$/g, '');
    }

    updatePilotLinks() {
        const rawSlug = this.cleanValue(this.pilotTenantSlugInput.value) || 'pilot-ben';
        const slug = this.normalizeSlug(rawSlug) || 'pilot-ben';
        const publicPath = `/?tenant=${encodeURIComponent(slug)}`;
        const adminPath = `/tenant-admin.html?tenant=${encodeURIComponent(slug)}`;
        const loginPath = `/login.html?redirect=${encodeURIComponent(adminPath)}`;

        this.setPilotLink('pilotPublicLink', publicPath);
        this.setPilotLink('pilotAdminLink', adminPath);
        this.setPilotLink('pilotLoginLink', loginPath);
        this.renderPilotStatus(slug);
    }

    renderPilotStatus(slugOverride) {
        if (!this.pilotStatusPill || !this.pilotTenantStatus) return;

        const rawSlug = slugOverride || this.cleanValue(this.pilotTenantSlugInput.value);
        const slug = rawSlug ? this.normalizeSlug(rawSlug) : '';
        const tenant = this.tenants.find(item => (item.slug || item.id) === slug);
        const appCount = Number(tenant?.appCount || 0);
        const hasTenant = Boolean(tenant);
        const hasBoard = appCount > 0;
        const isLegacy = Boolean(tenant?.legacy);
        const isActive = tenant?.status === 'active';
        const ready = hasTenant && hasBoard && isActive && !isLegacy;

        if (!slug) {
            this.setPilotPill('Tenant wählen', '');
            this.pilotTenantStatus.textContent = 'Tenant auswählen oder Slug eingeben. Die Links bleiben tenant-basiert.';
            return;
        }

        if (!hasTenant) {
            this.setPilotPill('Nicht gefunden', 'warning');
            this.pilotTenantStatus.innerHTML = `Tenant <strong>${this.escapeHtml(slug)}</strong> ist in der Liste nicht enthalten. Erst provisionieren oder Liste aktualisieren.`;
            return;
        }

        if (ready) {
            this.setPilotPill('Bereit', 'ready');
            this.pilotTenantStatus.innerHTML = `<strong>${this.escapeHtml(tenant.name || slug)}</strong> ist aktiv und hat ${appCount} Board${appCount === 1 ? '' : 's'}.`;
            return;
        }

        const missing = [];
        if (!isActive) missing.push('Tenant aktivieren');
        if (isLegacy) missing.push('nicht Legacy verwenden');
        if (!hasBoard) missing.push('mindestens ein Board erstellen');

        this.setPilotPill('Noch nicht bereit', 'warning');
        this.pilotTenantStatus.innerHTML = `<strong>${this.escapeHtml(slug)}</strong> braucht: ${this.escapeHtml(missing.join(', '))}.`;
    }

    setPilotPill(text, state) {
        this.pilotStatusPill.textContent = text;
        this.pilotStatusPill.className = `pilot-status-pill${state ? ` is-${state}` : ''}`;
    }

    setPilotLink(elementId, path) {
        const el = document.getElementById(elementId);
        if (!el) return;
        el.textContent = path;
        el.dataset.fullUrl = `${window.location.origin}${path}`;
    }

    async copyLink(button) {
        const targetId = button.dataset.copyTarget;
        const target = document.getElementById(targetId);
        if (!target) return;
        const value = target.dataset.fullUrl || target.textContent;

        try {
            if (navigator.clipboard?.writeText) {
                await navigator.clipboard.writeText(value);
            } else {
                const range = document.createRange();
                range.selectNode(target);
                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
                document.execCommand('copy');
                sel.removeAllRanges();
            }
            button.classList.add('is-copied');
            window.setTimeout(() => button.classList.remove('is-copied'), 1200);
        } catch (error) {
            button.classList.add('is-copied');
            window.setTimeout(() => button.classList.remove('is-copied'), 1200);
        }
    }

    loadPilotChecklist() {
        let state = {};
        try {
            state = JSON.parse(localStorage.getItem(this.pilotChecklistKey) || '{}');
        } catch (error) {
            state = {};
        }

        document.querySelectorAll('[data-pilot-check]').forEach(input => {
            input.checked = Boolean(state[input.dataset.pilotCheck]);
        });
    }

    savePilotChecklist() {
        const state = {};
        document.querySelectorAll('[data-pilot-check]').forEach(input => {
            state[input.dataset.pilotCheck] = input.checked;
        });
        localStorage.setItem(this.pilotChecklistKey, JSON.stringify(state));
    }

    renderResult(data) {
        const origin = window.location.origin;
        const publicUrl = data.urls?.publicBoard || '/';
        const adminUrl = data.urls?.tenantAdmin || '/super-admin.html';

        document.getElementById('resultTenant').textContent =
            `${data.tenant?.name || data.tenant?.slug || 'Tenant'} (${data.tenant?.slug || data.tenant?.id || '-'})`;

        this.setResultLink('resultPublicUrl', `${origin}${publicUrl}`);
        this.setResultLink('resultAdminUrl', `${origin}${adminUrl}`);

        this.result.classList.add('is-visible');
    }

    setResultLink(elementId, url) {
        const link = document.getElementById(elementId);
        link.href = url;
        link.textContent = url;
    }

    setStatus(message, type) {
        this.status.textContent = message;
        this.status.className = `sa-status${type ? ` is-${type}` : ''}`;
    }

    escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = value == null ? '' : String(value);
        return div.innerHTML;
    }
}

window.superAdmin = new SuperAdminApp();
