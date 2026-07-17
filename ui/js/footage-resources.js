(function () {
    const elements = {
        clipAnalyzer: document.getElementById('clip-analyzer-toggle'),
        storyblocks: document.getElementById('src-storyblocks'),
        pexels: document.getElementById('src-pexels'),
        pixabay: document.getElementById('src-pixabay'),
        youtube: document.getElementById('src-youtube'),
        reddit: document.getElementById('src-reddit'),
        bing: document.getElementById('src-bing'),
        brave: document.getElementById('src-brave'),
        saveStatus: document.getElementById('resource-save-status'),
        qwenPoolBtn: document.getElementById('reset-qwen-pool-btn'),
        qwenPoolStatus: document.getElementById('qwen-pool-status'),
        visionSummary: document.getElementById('vision-health-summary'),
        visionMetrics: document.getElementById('vision-health-metrics'),
        visionKeys: document.getElementById('vision-health-keys'),
        visionWarnings: document.getElementById('vision-health-warnings'),
        visionRefresh: document.getElementById('vision-health-refresh-btn'),
        visionLive: document.getElementById('vision-health-live-btn'),
        keyManagerToggle: document.getElementById('vision-key-manager-toggle'),
        keyManager: document.getElementById('vision-key-manager'),
        keyEnvPath: document.getElementById('vision-key-env-path'),
        keyList: document.getElementById('vision-key-list'),
        keyAdditions: document.getElementById('vision-key-additions'),
        keySave: document.getElementById('vision-key-save-btn'),
        keyCancel: document.getElementById('vision-key-cancel-btn'),
        keySaveStatus: document.getElementById('vision-key-save-status'),
        envPath: document.getElementById('resource-env-path'),
        envGroups: document.getElementById('resource-env-groups'),
        envNotes: document.getElementById('resource-env-notes'),
        envStatus: document.getElementById('resource-env-status'),
        envRefresh: document.getElementById('resource-env-refresh-btn'),
        envSave: document.getElementById('resource-env-save-btn'),
        envLive: document.getElementById('resource-env-live-btn'),
        envClean: document.getElementById('resource-env-clean-btn'),
        envLiveResults: document.getElementById('resource-env-live-results'),
        envAddKey: document.getElementById('resource-env-add-key'),
        envAddValue: document.getElementById('resource-env-add-value'),
        envAdd: document.getElementById('resource-env-add-btn'),
        cloudPanels: document.getElementById('cloud-account-panels'),
        cloudRefresh: document.getElementById('cloud-account-refresh-btn'),
        cloudSave: document.getElementById('cloud-account-save-btn'),
        cloudStatus: document.getElementById('cloud-account-status'),
    };

    let visionKeyRows = { image: [], omni: [] };
    let envState = null;
    let cloudState = null;
    let saveTimer = null;

    const escapeHtml = (value) => String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

    const ratioText = (item) => `${Number(item?.available || 0)}/${Number(item?.total || 0)}`;
    const verifiedText = (item) => Number(item?.verifiedOk || 0) > 0 ? `${Number(item.verifiedOk)} live` : 'not probed';

    function setSaveStatus(text, level = '') {
        if (!elements.saveStatus) return;
        elements.saveStatus.textContent = text;
        elements.saveStatus.className = `resource-save-status ${level}`.trim();
    }

    function getResourceSettings() {
        return {
            clipAnalyzer: elements.clipAnalyzer?.checked !== false,
            footageSources: {
                storyblocks: elements.storyblocks?.checked === true,
                pexels: elements.pexels?.checked !== false,
                pixabay: elements.pixabay?.checked !== false,
                youtube: elements.youtube?.checked !== false,
                reddit: elements.reddit?.checked !== false,
                bing: elements.bing?.checked !== false,
                brave: elements.brave?.checked !== false,
            },
        };
    }

    function applyResourceSettings(settings = {}) {
        const sources = settings.footageSources || settings.sources || {};
        if (elements.clipAnalyzer) elements.clipAnalyzer.checked = settings.clipAnalyzer !== false;
        if (elements.storyblocks) elements.storyblocks.checked = sources.storyblocks === true;
        if (elements.pexels) elements.pexels.checked = sources.pexels !== false;
        if (elements.pixabay) elements.pixabay.checked = sources.pixabay !== false;
        if (elements.youtube) elements.youtube.checked = sources.youtube !== false;
        if (elements.reddit) elements.reddit.checked = sources.reddit !== false;
        if (elements.bing) elements.bing.checked = sources.bing !== false;
        if (elements.brave) elements.brave.checked = sources.brave !== false;
    }

    async function saveResourceSettings() {
        if (!window.electronAPI?.footageResourcesSet) return;
        clearTimeout(saveTimer);
        setSaveStatus('saving...', 'warn');
        saveTimer = setTimeout(async () => {
            try {
                const result = await window.electronAPI.footageResourcesSet(getResourceSettings());
                setSaveStatus(result?.success ? 'synced' : 'sync failed', result?.success ? 'ok' : 'bad');
            } catch (err) {
                setSaveStatus(err?.message || 'sync failed', 'bad');
            }
        }, 80);
    }

    function setEnvStatus(text, level = '') {
        if (!elements.envStatus) return;
        elements.envStatus.textContent = text || '';
        elements.envStatus.style.color = level === 'bad' ? '#fca5a5' : level === 'warn' ? '#fbbf24' : level === 'ok' ? '#86efac' : '#94a3b8';
    }

    function statusLabel(status) {
        const map = {
            ok: 'ready',
            on: 'on',
            off: 'off',
            empty: 'empty',
            bad: 'required',
            warn: 'check',
            missing: 'missing',
            default: 'default',
            future: 'future',
            legacy: 'legacy',
            'missing-path': 'path?',
        };
        return map[status] || status || 'unknown';
    }

    function fieldInputHtml(field) {
        const value = field.secret ? '' : escapeHtml(field.editableValue || '');
        const placeholder = escapeHtml(field.placeholder || (field.secret ? 'Paste replacement value' : ''));
        const type = field.kind === 'number' ? 'number' : field.secret ? 'password' : 'text';
        const attrs = `data-env-input data-env-key="${escapeHtml(field.key)}" data-env-kind="${escapeHtml(field.kind || 'text')}"`;
        if (field.kind === 'secret-list') {
            return `<textarea ${attrs} rows="2" placeholder="${placeholder || 'Paste one or more keys, comma or newline separated'}"></textarea>`;
        }
        return `<input ${attrs} type="${type}" value="${value}" placeholder="${placeholder}">`;
    }

    function renderEnvField(field, options = {}) {
        const display = field.displayValue || (field.defaultValue ? `default: ${field.defaultValue}` : '');
        const note = [field.note, field.pathExists === false ? 'Configured path was not found.' : '', field.duplicateCount > 1 ? `${field.duplicateCount} duplicate lines found.` : '']
            .filter(Boolean)
            .join(' ');
        return `
            <div class="resource-env-field status-${escapeHtml(field.status)}" data-env-field="${escapeHtml(field.key)}">
                <div class="resource-env-field-head">
                    <div>
                        <strong>${escapeHtml(field.label || field.key)}</strong>
                        <code>${escapeHtml(field.key)}</code>
                    </div>
                    <span class="resource-env-badge">${escapeHtml(statusLabel(field.status))}</span>
                </div>
                <div class="resource-env-current" title="${escapeHtml(display)}">${display ? escapeHtml(display) : '<span>not set</span>'}</div>
                <div class="resource-env-control">
                    ${fieldInputHtml(field)}
                    <button type="button" data-env-clear="${escapeHtml(field.key)}" title="Set this variable to an empty value">Clear</button>
                    <button type="button" data-env-remove="${escapeHtml(field.key)}" title="Remove this line from .env">Remove</button>
                </div>
                ${note ? `<small>${escapeHtml(note)}</small>` : ''}
            </div>
        `;
    }

    function renderEnvResources(data) {
        envState = data || null;
        if (elements.envPath) {
            elements.envPath.textContent = data?.envPath || '.env unavailable';
            elements.envPath.title = data?.envPath || '';
        }
        if (elements.envNotes) {
            const notes = data?.cleanupSuggestions || [];
            elements.envNotes.innerHTML = notes.length
                ? notes.map(note => `<div>${escapeHtml(note)}</div>`).join('')
                : '<div>.env looks clean. Empty optional defaults are left in place.</div>';
        }
        if (!elements.envGroups) return;

        const groups = (data?.groups || []).map(group => `
            <details class="resource-env-group status-${escapeHtml(group.status)}" open>
                <summary>
                    <div>
                        <strong>${escapeHtml(group.title)}</strong>
                        <small>${escapeHtml(group.description || '')}</small>
                    </div>
                    <span>${escapeHtml(statusLabel(group.status))}</span>
                </summary>
                <div class="resource-env-fields">
                    ${(group.fields || []).map(field => renderEnvField(field)).join('')}
                </div>
            </details>
        `);

        const unmatched = data?.unmatched || [];
        if (unmatched.length) {
            groups.push(`
                <details class="resource-env-group status-warn">
                    <summary>
                        <div>
                            <strong>Other .env Variables</strong>
                            <small>Present in .env but not part of the curated resource groups yet.</small>
                        </div>
                        <span>${unmatched.length}</span>
                    </summary>
                    <div class="resource-env-fields">
                        ${unmatched.map(item => renderEnvField({
                            key: item.key,
                            label: item.key,
                            kind: item.secret ? 'secret' : 'text',
                            secret: item.secret,
                            status: item.empty ? 'empty' : 'ok',
                            displayValue: item.displayValue,
                            editableValue: item.secret ? '' : item.displayValue,
                            line: item.line,
                        })).join('')}
                    </div>
                </details>
            `);
        }

        elements.envGroups.innerHTML = groups.join('');
        elements.envGroups.querySelectorAll('[data-env-input]').forEach(input => {
            input.addEventListener('input', () => {
                input.dataset.envDirty = '1';
                setEnvStatus('unsaved edits', 'warn');
            });
        });
        elements.envGroups.querySelectorAll('[data-env-clear]').forEach(button => {
            button.addEventListener('click', () => {
                const key = button.getAttribute('data-env-clear');
                const input = elements.envGroups.querySelector(`[data-env-input][data-env-key="${CSS.escape(key)}"]`);
                if (!input) return;
                input.value = '';
                input.dataset.envDirty = '1';
                button.classList.add('active');
                setEnvStatus(`${key} will be cleared`, 'warn');
            });
        });
        elements.envGroups.querySelectorAll('[data-env-remove]').forEach(button => {
            button.addEventListener('click', () => {
                button.classList.toggle('active');
                button.textContent = button.classList.contains('active') ? 'Undo' : 'Remove';
                setEnvStatus(button.classList.contains('active') ? 'remove queued' : 'unsaved edits', 'warn');
            });
        });
    }

    async function loadEnvResources() {
        if (!window.electronAPI?.resourceEnvStatus) return;
        setEnvStatus('checking...', 'warn');
        try {
            const result = await window.electronAPI.resourceEnvStatus();
            if (!result?.success) throw new Error(result?.error || 'env status failed');
            renderEnvResources(result);
            setEnvStatus('ready', 'ok');
        } catch (err) {
            setEnvStatus(err?.message || 'env status failed', 'bad');
        }
    }

    function renderEnvLiveChecks(result) {
        if (!elements.envLiveResults) return;
        if (!result) {
            elements.envLiveResults.innerHTML = '';
            return;
        }
        if (!result.success) {
            elements.envLiveResults.innerHTML = `<div class="resource-env-check status-bad"><strong>Live check failed</strong><span>${escapeHtml(result.error || 'unknown error')}</span></div>`;
            return;
        }
        const checks = Array.isArray(result.checks) ? result.checks : [];
        const summary = result.summary || {};
        const checkedAt = result.checkedAt ? new Date(result.checkedAt).toLocaleTimeString() : '';
        const header = `
            <div class="resource-env-live-head">
                <strong>Live Check</strong>
                <span>${Number(summary.ok || 0)} ok · ${Number(summary.warn || 0)} warning · ${Number(summary.bad || 0)} bad${checkedAt ? ` · ${escapeHtml(checkedAt)}` : ''}</span>
            </div>
        `;
        const cards = checks.map(check => `
            <div class="resource-env-check status-${escapeHtml(check.status || 'warn')}">
                <strong>${escapeHtml(check.title || check.id || 'resource')}</strong>
                <span>${escapeHtml(check.detail || '')}</span>
            </div>
        `).join('');
        elements.envLiveResults.innerHTML = header + (cards || '<div class="resource-env-check status-warn"><strong>No checks ran</strong><span>Edit a resource or run a forced check.</span></div>');
    }

    async function liveCheckResources(options = {}) {
        if (!window.electronAPI?.resourceEnvLiveCheck) return null;
        if (elements.envLive) elements.envLive.disabled = true;
        setEnvStatus('live checking...', 'warn');
        try {
            const result = await window.electronAPI.resourceEnvLiveCheck(options);
            renderEnvLiveChecks(result);
            if (!result?.success) throw new Error(result?.error || 'live check failed');
            const bad = Number(result.summary?.bad || 0);
            const warn = Number(result.summary?.warn || 0);
            setEnvStatus(bad ? `${bad} resource problem${bad === 1 ? '' : 's'}` : warn ? `${warn} warning${warn === 1 ? '' : 's'}` : 'live check passed', bad ? 'bad' : warn ? 'warn' : 'ok');
            return result;
        } catch (err) {
            renderEnvLiveChecks({ success: false, error: err?.message || 'live check failed' });
            setEnvStatus(err?.message || 'live check failed', 'bad');
            return null;
        } finally {
            if (elements.envLive) elements.envLive.disabled = false;
        }
    }

    function setCloudStatus(text, level = '') {
        if (!elements.cloudStatus) return;
        elements.cloudStatus.textContent = text || '';
        elements.cloudStatus.style.color = level === 'bad' ? '#fca5a5' : level === 'warn' ? '#fbbf24' : level === 'ok' ? '#86efac' : '#94a3b8';
    }

    function cloudFieldHtml(provider, slot, fieldDef, field) {
        const value = field?.secret ? '' : escapeHtml(field?.editableValue || '');
        const type = fieldDef.kind === 'secret' ? 'password' : 'text';
        const placeholder = escapeHtml(field?.placeholder || fieldDef.defaultValue || '');
        return `
            <label class="resource-cloud-field status-${escapeHtml(field?.status || 'empty')}">
                <span>${escapeHtml(fieldDef.label || fieldDef.suffix)}</span>
                <input data-cloud-field
                    data-cloud-provider="${escapeHtml(provider.id)}"
                    data-cloud-slot="${escapeHtml(slot.id)}"
                    data-cloud-suffix="${escapeHtml(fieldDef.suffix)}"
                    data-cloud-secret="${fieldDef.kind === 'secret' ? '1' : '0'}"
                    data-cloud-secret-set="${field?.secretSet ? '1' : '0'}"
                    type="${type}"
                    value="${value}"
                    placeholder="${placeholder}">
                ${fieldDef.kind === 'secret' ? `<button type="button" data-cloud-clear-secret="${escapeHtml(provider.id)}:${escapeHtml(slot.id)}:${escapeHtml(fieldDef.suffix)}">Clear</button>` : ''}
                ${field?.displayValue ? `<small>${escapeHtml(field.displayValue)}</small>` : ''}
            </label>
        `;
    }

    function renderCloudAccounts(data) {
        cloudState = data || null;
        if (!elements.cloudPanels) return;
        const providers = data?.providers || [];
        if (!providers.length) {
            elements.cloudPanels.innerHTML = '<div class="resource-env-check status-warn"><strong>No cloud account providers loaded</strong><span>Refresh the Resource Center.</span></div>';
            return;
        }
        elements.cloudPanels.innerHTML = providers.map(provider => `
            <section class="resource-cloud-provider" data-cloud-provider="${escapeHtml(provider.id)}">
                <div class="resource-cloud-provider-head">
                    <div>
                        <strong>${escapeHtml(provider.title)}</strong>
                        <small>${escapeHtml(provider.note || '')}</small>
                    </div>
                    <button type="button" data-cloud-add="${escapeHtml(provider.id)}" class="vision-health-btn">Add Slot</button>
                </div>
                <div class="resource-cloud-slots">
                    ${(provider.slots || []).map(slot => `
                        <article class="resource-cloud-slot status-${escapeHtml(slot.status || 'empty')}" data-cloud-slot-card data-cloud-provider="${escapeHtml(provider.id)}" data-cloud-slot="${escapeHtml(slot.id)}">
                            <div class="resource-cloud-slot-head">
                                <label>
                                    <input type="radio" name="cloud-active-${escapeHtml(provider.id)}" data-cloud-active="${escapeHtml(provider.id)}" value="${escapeHtml(slot.id)}" ${slot.active ? 'checked' : ''}>
                                    <strong>Slot ${escapeHtml(slot.id)}</strong>
                                </label>
                                <span>${slot.active ? 'active' : slot.virtual ? 'current .env' : statusLabel(slot.status)}</span>
                            </div>
                            <input class="resource-cloud-label" data-cloud-label="${escapeHtml(provider.id)}:${escapeHtml(slot.id)}" type="text" value="${escapeHtml(slot.label || '')}" placeholder="Account label">
                            <div class="resource-cloud-fields">
                                ${(provider.fields || []).map(fieldDef => cloudFieldHtml(provider, slot, fieldDef, slot.fields?.[fieldDef.suffix] || {})).join('')}
                            </div>
                            <div class="resource-cloud-actions">
                                <button type="button" data-cloud-check="${escapeHtml(provider.id)}:${escapeHtml(slot.id)}" class="vision-health-btn">Test Slot</button>
                                <button type="button" data-cloud-remove="${escapeHtml(provider.id)}:${escapeHtml(slot.id)}" class="vision-health-btn danger-soft">Remove Slot</button>
                                <span data-cloud-slot-status="${escapeHtml(provider.id)}:${escapeHtml(slot.id)}"></span>
                            </div>
                        </article>
                    `).join('')}
                </div>
            </section>
        `).join('');

        elements.cloudPanels.querySelectorAll('[data-cloud-field], .resource-cloud-label, [data-cloud-active]').forEach(input => {
            input.addEventListener('input', () => setCloudStatus('unsaved account edits', 'warn'));
            input.addEventListener('change', () => setCloudStatus('unsaved account edits', 'warn'));
        });
        elements.cloudPanels.querySelectorAll('[data-cloud-add]').forEach(button => {
            button.addEventListener('click', () => addCloudSlot(button.getAttribute('data-cloud-add')));
        });
        elements.cloudPanels.querySelectorAll('[data-cloud-remove]').forEach(button => {
            button.addEventListener('click', () => {
                const [provider, slot] = String(button.getAttribute('data-cloud-remove') || '').split(':');
                const cards = [...elements.cloudPanels.querySelectorAll(`[data-cloud-slot-card][data-cloud-provider="${CSS.escape(provider)}"]`)];
                if (cards.length <= 1) {
                    setCloudStatus('keep at least one slot', 'warn');
                    return;
                }
                const card = elements.cloudPanels.querySelector(`[data-cloud-slot-card][data-cloud-provider="${CSS.escape(provider)}"][data-cloud-slot="${CSS.escape(slot)}"]`);
                card?.remove();
                const active = elements.cloudPanels.querySelector(`[data-cloud-active="${CSS.escape(provider)}"]:checked`);
                if (!active) {
                    const first = elements.cloudPanels.querySelector(`[data-cloud-active="${CSS.escape(provider)}"]`);
                    if (first) first.checked = true;
                }
                setCloudStatus('slot removal queued', 'warn');
            });
        });
        elements.cloudPanels.querySelectorAll('[data-cloud-clear-secret]').forEach(button => {
            button.addEventListener('click', () => {
                const [provider, slot, suffix] = String(button.getAttribute('data-cloud-clear-secret') || '').split(':');
                const input = elements.cloudPanels.querySelector(`[data-cloud-field][data-cloud-provider="${CSS.escape(provider)}"][data-cloud-slot="${CSS.escape(slot)}"][data-cloud-suffix="${CSS.escape(suffix)}"]`);
                if (!input) return;
                input.value = '';
                input.dataset.cloudClear = input.dataset.cloudClear === '1' ? '0' : '1';
                button.classList.toggle('active', input.dataset.cloudClear === '1');
                button.textContent = input.dataset.cloudClear === '1' ? 'Undo Clear' : 'Clear';
                setCloudStatus(input.dataset.cloudClear === '1' ? 'secret clear queued' : 'unsaved account edits', 'warn');
            });
        });
        elements.cloudPanels.querySelectorAll('[data-cloud-check]').forEach(button => {
            button.addEventListener('click', () => {
                const [provider, slot] = String(button.getAttribute('data-cloud-check') || '').split(':');
                checkCloudSlot(provider, slot);
            });
        });
    }

    function addCloudSlot(providerId) {
        if (!cloudState || !providerId) return;
        const provider = (cloudState.providers || []).find(item => item.id === providerId);
        if (!provider) return;
        const existing = [...elements.cloudPanels.querySelectorAll(`[data-cloud-slot-card][data-cloud-provider="${CSS.escape(providerId)}"]`)]
            .map(card => parseInt(card.getAttribute('data-cloud-slot'), 10))
            .filter(Number.isFinite);
        const nextId = String((existing.length ? Math.max(...existing) : 0) + 1);
        const emptySlot = {
            id: nextId,
            label: `${provider.title.replace(/ Accounts$/, '')} ${nextId}`,
            active: false,
            status: 'empty',
            fields: Object.fromEntries((provider.fields || []).map(field => [field.suffix, {
                suffix: field.suffix,
                label: field.label,
                kind: field.kind,
                secret: field.kind === 'secret',
                status: field.required ? 'bad' : 'empty',
                displayValue: '',
                editableValue: field.defaultValue || '',
                placeholder: field.defaultValue || '',
            }])),
        };
        provider.slots = [...(provider.slots || []), emptySlot];
        renderCloudAccounts(cloudState);
        setCloudStatus('new slot added; save to keep it', 'warn');
    }

    function collectCloudSlot(provider, slotId) {
        const card = elements.cloudPanels?.querySelector(`[data-cloud-slot-card][data-cloud-provider="${CSS.escape(provider.id)}"][data-cloud-slot="${CSS.escape(slotId)}"]`);
        if (!card) return null;
        const label = card.querySelector('.resource-cloud-label')?.value || '';
        const fields = {};
        (provider.fields || []).forEach(field => {
            const input = card.querySelector(`[data-cloud-field][data-cloud-suffix="${CSS.escape(field.suffix)}"]`);
            if (!input) return;
            const secret = input.dataset.cloudSecret === '1';
            const clear = input.dataset.cloudClear === '1';
            const value = input.value || '';
            fields[field.suffix] = {
                value,
                clear,
                keep: secret && !clear && !value,
            };
        });
        return { id: String(slotId), label, fields };
    }

    function collectCloudAccounts() {
        const providers = {};
        (cloudState?.providers || []).forEach(provider => {
            const cards = [...elements.cloudPanels.querySelectorAll(`[data-cloud-slot-card][data-cloud-provider="${CSS.escape(provider.id)}"]`)];
            const slots = cards.map(card => collectCloudSlot(provider, card.getAttribute('data-cloud-slot'))).filter(Boolean);
            const active = elements.cloudPanels.querySelector(`[data-cloud-active="${CSS.escape(provider.id)}"]:checked`)?.value || slots[0]?.id || '1';
            providers[provider.id] = { activeSlotId: active, slots };
        });
        return { providers };
    }

    async function loadCloudAccounts() {
        if (!window.electronAPI?.cloudAccountSlotsStatus) return;
        setCloudStatus('loading slots...', 'warn');
        try {
            const result = await window.electronAPI.cloudAccountSlotsStatus();
            if (!result?.success) throw new Error(result?.error || 'account status failed');
            renderCloudAccounts(result);
            setCloudStatus('slots ready', 'ok');
        } catch (err) {
            setCloudStatus(err?.message || 'account status failed', 'bad');
        }
    }

    async function saveCloudAccounts() {
        if (!window.electronAPI?.cloudAccountSlotsSave) return;
        if (elements.cloudSave) elements.cloudSave.disabled = true;
        setCloudStatus('saving accounts...', 'warn');
        try {
            const result = await window.electronAPI.cloudAccountSlotsSave(collectCloudAccounts());
            if (!result?.success) throw new Error(result?.error || 'account save failed');
            renderCloudAccounts(result);
            renderEnvResources(await window.electronAPI.resourceEnvStatus());
            setCloudStatus('saved and active slots applied', 'ok');
        } catch (err) {
            setCloudStatus(err?.message || 'account save failed', 'bad');
        } finally {
            if (elements.cloudSave) elements.cloudSave.disabled = false;
        }
    }

    async function checkCloudSlot(providerId, slotId) {
        if (!window.electronAPI?.cloudAccountSlotCheck || !cloudState) return;
        const provider = (cloudState.providers || []).find(item => item.id === providerId);
        if (!provider) return;
        const statusEl = elements.cloudPanels?.querySelector(`[data-cloud-slot-status="${CSS.escape(providerId)}:${CSS.escape(slotId)}"]`);
        const button = elements.cloudPanels?.querySelector(`[data-cloud-check="${CSS.escape(providerId)}:${CSS.escape(slotId)}"]`);
        if (statusEl) {
            statusEl.textContent = 'testing...';
            statusEl.style.color = '#fbbf24';
        }
        if (button) button.disabled = true;
        try {
            const result = await window.electronAPI.cloudAccountSlotCheck({
                provider: providerId,
                slot: collectCloudSlot(provider, slotId),
                timeoutMs: 25000,  // reasoning models (Grok) + gcloud token mint need headroom
            });
            if (!result?.success) throw new Error(result?.error || 'slot check failed');
            const check = result.check || {};
            if (statusEl) {
                statusEl.textContent = `${statusLabel(check.status)} - ${check.detail || ''}`;
                statusEl.style.color = check.status === 'ok' ? '#86efac' : check.status === 'bad' ? '#fca5a5' : '#fbbf24';
                statusEl.title = check.detail || '';
            }
        } catch (err) {
            if (statusEl) {
                statusEl.textContent = err?.message || 'slot check failed';
                statusEl.style.color = '#fca5a5';
            }
        } finally {
            if (button) button.disabled = false;
        }
    }

    function collectEnvEdits() {
        const updates = {};
        const removals = [];
        elements.envGroups?.querySelectorAll('[data-env-input]').forEach(input => {
            if (input.dataset.envDirty !== '1') return;
            const key = input.getAttribute('data-env-key');
            if (!key) return;
            updates[key] = input.value || '';
        });
        elements.envGroups?.querySelectorAll('[data-env-remove].active').forEach(button => {
            const key = button.getAttribute('data-env-remove');
            if (key) removals.push(key);
        });
        const addKey = String(elements.envAddKey?.value || '').trim();
        const addValue = String(elements.envAddValue?.value || '');
        if (addKey) {
            updates[addKey] = addValue;
        }
        return { updates, removals };
    }

    async function saveEnvEdits() {
        if (!window.electronAPI?.resourceEnvSave) return;
        const payload = collectEnvEdits();
        const changeCount = Object.keys(payload.updates).length + payload.removals.length;
        if (!changeCount) {
            setEnvStatus('nothing to save', '');
            return;
        }
        if (elements.envSave) elements.envSave.disabled = true;
        setEnvStatus('saving...', 'warn');
        try {
            const result = await window.electronAPI.resourceEnvSave(payload);
            if (!result?.success) throw new Error(result?.error || 'save failed');
            if (elements.envAddKey) elements.envAddKey.value = '';
            if (elements.envAddValue) elements.envAddValue.value = '';
            renderEnvResources(result);
            const changed = result.changedKeys?.length || 0;
            setEnvStatus(`saved ${changed}; backup made`, 'ok');
            if (result.qwenTrackingReset) {
                refreshVisionHealth('env changed');
                loadVisionKeys();
            }
            if ((result.changedKeys || []).some(key => /^(BEDROCK_|AZURE_)/.test(String(key)))) {
                loadCloudAccounts();
            }
            if (changed) {
                await liveCheckResources({ changedKeys: result.changedKeys || [], timeoutMs: 9000 });
            }
        } catch (err) {
            setEnvStatus(err?.message || 'save failed', 'bad');
        } finally {
            if (elements.envSave) elements.envSave.disabled = false;
        }
    }

    async function cleanEnvFile() {
        if (!window.electronAPI?.resourceEnvClean) return;
        if (!confirm('Clean .env now? A backup will be created first. This removes duplicate variable lines and trims whitespace; it does not delete empty optional defaults.')) return;
        if (elements.envClean) elements.envClean.disabled = true;
        setEnvStatus('cleaning...', 'warn');
        try {
            const result = await window.electronAPI.resourceEnvClean();
            if (!result?.success) throw new Error(result?.error || 'clean failed');
            renderEnvResources(result);
            const removed = result.removedDuplicates?.length || 0;
            setEnvStatus(`cleaned; ${removed} duplicate${removed === 1 ? '' : 's'} removed`, 'ok');
        } catch (err) {
            setEnvStatus(err?.message || 'clean failed', 'bad');
        } finally {
            if (elements.envClean) elements.envClean.disabled = false;
        }
    }

    function setVisionSummary(text, level) {
        if (!elements.visionSummary) return;
        elements.visionSummary.textContent = text;
        elements.visionSummary.className = `vision-health-summary ${level || ''}`.trim();
    }

    function renderVisionHealth(status, modeLabel = '') {
        if (!status) {
            setVisionSummary('unavailable', 'bad');
            return;
        }

        const warnings = status.diagnostics?.warnings || [];
        const hasImage = Number(status.image?.available || 0) > 0;
        const hasOmni = Number(status.omniHttp?.available || 0) > 0 || Number(status.omniRealtime?.available || 0) > 0;
        const level = !hasImage && !hasOmni ? 'bad' : warnings.length ? 'warn' : 'ok';
        const label = !hasImage && !hasOmni ? 'No Qwen Vision' : warnings.length ? 'Degraded' : 'Healthy';
        setVisionSummary(modeLabel ? `${label} - ${modeLabel}` : label, level);

        if (elements.visionMetrics) {
            const healthAge = status.health?.updatedAt
                ? new Date(status.health.updatedAt).toLocaleString()
                : 'no live probe';
            const realtime = status.omniRealtime?.activeInCurrentRuntime ? 'on' : 'off';
            elements.visionMetrics.innerHTML = [
                ['Keys', `${Number(status.imageKeys || 0)} VL / ${Number(status.omniKeys || 0)} Omni`],
                ['Image/VL', `${ratioText(status.image)} (${verifiedText(status.image)})`],
                ['Omni HTTP', `${ratioText(status.omniHttp)} (${verifiedText(status.omniHttp)})`],
                ['Realtime', `${ratioText(status.omniRealtime)} (${realtime})`],
                ['Health Cache', healthAge],
            ].map(([name, value]) => `
                <div class="vision-health-metric">
                    <span>${escapeHtml(name)}</span>
                    <strong title="${escapeHtml(value)}">${escapeHtml(value)}</strong>
                </div>
            `).join('');
        }

        if (elements.visionKeys) {
            const imageCards = (status.image?.perKey || []).map(item => `
                <div class="vision-health-key">
                    <span>Image ${Number(item.keyIndex || 0)} - ${escapeHtml(item.keyTail || 'unknown')}</span>
                    <strong>VL ${ratioText(item)}</strong>
                    <small>${Number(item.verifiedOk || 0)} live verified</small>
                </div>
            `);
            const omniCards = (status.omniHttp?.perKey || []).map(item => {
                const rt = (status.omniRealtime?.perKey || []).find(k => Number(k.keyIndex) === Number(item.keyIndex));
                return `
                    <div class="vision-health-key">
                        <span>Omni ${Number(item.keyIndex || 0)} - ${escapeHtml(item.keyTail || 'unknown')}</span>
                        <strong>HTTP ${ratioText(item)}${rt ? ` | RT ${ratioText(rt)}` : ''}</strong>
                        <small>${Number(item.verifiedOk || 0) + Number(rt?.verifiedOk || 0)} live verified</small>
                    </div>
                `;
            });
            elements.visionKeys.innerHTML = [...imageCards, ...omniCards].join('') || '<div class="vision-health-warning">No Qwen vision keys loaded.</div>';
        }

        if (elements.visionWarnings) {
            const notes = warnings.slice(0, 6);
            elements.visionWarnings.innerHTML = notes.length
                ? notes.map(w => `<div class="vision-health-warning">${escapeHtml(w)}</div>`).join('')
                : '';
        }
    }

    function renderVisionKeyRows(data) {
        const laneDefs = [
            { id: 'image', title: 'Image/VL Keys', description: 'Used for still-image scoring and frame scoring.', fallback: 'shared fallback' },
            { id: 'omni', title: 'Omni Multimodal Keys', description: 'Used for clip analyzer and video-frame reasoning.', fallback: 'shared fallback' },
        ];
        visionKeyRows = {
            image: (data?.image?.keys || []).map(key => ({ ...key, remove: false })),
            omni: (data?.omni?.keys || []).map(key => ({ ...key, remove: false })),
        };
        if (elements.keyEnvPath) {
            elements.keyEnvPath.textContent = data?.envPath || '';
            elements.keyEnvPath.title = data?.envPath || '';
        }
        if (!elements.keyList) return;
        if (elements.keyAdditions) elements.keyAdditions.style.display = 'none';
        elements.keyList.innerHTML = laneDefs.map(lane => {
            const laneData = data?.[lane.id] || {};
            const rows = visionKeyRows[lane.id] || [];
            const badge = laneData.explicit
                ? laneData.envKey
                : `${laneData.envKey || ''} using ${laneData.fallback || lane.fallback}`;
            const emptyText = laneData.explicit
                ? 'No keys in this explicit lane. Add keys below, or remove the env line manually to use shared fallback.'
                : 'No lane-specific keys found. This lane is using shared fallback; add keys below to split it.';
            const rowsHtml = rows.length ? rows.map(row => `
                <div class="vision-key-row" data-key-lane="${lane.id}" data-key-index="${Number(row.index)}">
                    <div class="vision-key-label">
                        <span>${lane.id} key ${Number(row.index) + 1} - ${escapeHtml(row.tail || '')}</span>
                        <strong title="${escapeHtml(row.masked || '')}">${escapeHtml(row.masked || '')}</strong>
                    </div>
                    <input class="vision-key-replace" data-key-replace-lane="${lane.id}" data-key-replace-index="${Number(row.index)}" type="password" placeholder="Paste replacement key (optional)">
                    <button class="vision-key-remove" data-key-remove-lane="${lane.id}" data-key-remove-index="${Number(row.index)}" type="button">Remove</button>
                </div>
            `).join('') : `<div class="vision-health-warning">${escapeHtml(emptyText)}</div>`;
            return `
                <div class="vision-key-section" data-key-section="${lane.id}">
                    <div class="vision-key-section-head">
                        <div>
                            <strong>${escapeHtml(lane.title)}</strong>
                            <small>${escapeHtml(lane.description)}</small>
                        </div>
                        <span>${escapeHtml(badge)}</span>
                    </div>
                    ${rowsHtml}
                    <textarea class="vision-key-additions" data-key-additions="${lane.id}" rows="2" placeholder="Add ${escapeHtml(lane.title)} here, one per line or comma-separated."></textarea>
                </div>
            `;
        }).join('');
        elements.keyList.querySelectorAll('[data-key-remove-lane]').forEach(button => {
            button.addEventListener('click', () => {
                const lane = button.getAttribute('data-key-remove-lane');
                const index = Number(button.getAttribute('data-key-remove-index'));
                const row = (visionKeyRows[lane] || []).find(item => Number(item.index) === index);
                if (!row) return;
                row.remove = !row.remove;
                button.classList.toggle('active', row.remove);
                button.textContent = row.remove ? 'Undo' : 'Remove';
            });
        });
    }

    async function loadVisionKeys() {
        if (!window.electronAPI?.qwenVisionKeysStatus) return;
        try {
            const result = await window.electronAPI.qwenVisionKeysStatus();
            if (result?.success) {
                renderVisionKeyRows(result);
                if (elements.keySaveStatus) elements.keySaveStatus.textContent = '';
            } else if (elements.keySaveStatus) {
                elements.keySaveStatus.textContent = result?.error || 'could not load keys';
                elements.keySaveStatus.style.color = '#fca5a5';
            }
        } catch (err) {
            if (elements.keySaveStatus) {
                elements.keySaveStatus.textContent = err?.message || 'could not load keys';
                elements.keySaveStatus.style.color = '#fca5a5';
            }
        }
    }

    async function saveVisionKeysAndProbe() {
        if (!window.electronAPI?.qwenVisionKeysSave) return;
        const lanes = {};
        for (const lane of ['image', 'omni']) {
            lanes[lane] = {
                rows: (visionKeyRows[lane] || []).map(row => {
                    const input = elements.keyList?.querySelector(`[data-key-replace-lane="${lane}"][data-key-replace-index="${Number(row.index)}"]`);
                    return {
                        index: Number(row.index),
                        remove: row.remove === true,
                        replacement: input?.value || '',
                    };
                }),
                additions: elements.keyList?.querySelector(`[data-key-additions="${lane}"]`)?.value || '',
            };
        }
        if (elements.keySaveStatus) {
            elements.keySaveStatus.textContent = 'saving...';
            elements.keySaveStatus.style.color = '#fbbf24';
        }
        if (elements.keySave) elements.keySave.disabled = true;
        try {
            const result = await window.electronAPI.qwenVisionKeysSave({ lanes });
            if (!result?.success) throw new Error(result?.error || 'save failed');
            renderVisionKeyRows(result);
            renderVisionHealth(result.status, 'saved');
            if (elements.keySaveStatus) {
                const saved = result.saved && typeof result.saved === 'object'
                    ? `Image ${result.saved.image || 0}, Omni ${result.saved.omni || 0}`
                    : `${result.saved || 0}`;
                elements.keySaveStatus.textContent = `saved ${saved}; probing...`;
                elements.keySaveStatus.style.color = '#86efac';
            }
            if (window.electronAPI?.visionHealthLiveCheck) {
                setVisionSummary('probing new keys...', 'warn');
                const probe = await window.electronAPI.visionHealthLiveCheck({
                    lanes: ['image', 'omniHttp'],
                    imageLimit: 1,
                    omniLimit: 1,
                    concurrency: 3,
                    timeoutMs: 12000,
                });
                if (probe?.success) {
                    renderVisionHealth(probe.status, 'keys checked');
                    if (elements.keySaveStatus) elements.keySaveStatus.textContent = 'saved and checked';
                } else if (elements.keySaveStatus) {
                    elements.keySaveStatus.textContent = 'saved; probe failed';
                    elements.keySaveStatus.style.color = '#fca5a5';
                }
            }
        } catch (err) {
            if (elements.keySaveStatus) {
                elements.keySaveStatus.textContent = err?.message || 'save failed';
                elements.keySaveStatus.style.color = '#fca5a5';
            }
        } finally {
            if (elements.keySave) elements.keySave.disabled = false;
            updateQwenPoolStatus();
        }
    }

    async function updateQwenPoolStatus() {
        if (!elements.qwenPoolStatus || !window.electronAPI?.qwenPoolStatus) return;
        try {
            const status = await window.electronAPI.qwenPoolStatus();
            if (status.exhausted > 0) {
                elements.qwenPoolStatus.textContent = `${status.exhausted} exhausted`;
                elements.qwenPoolStatus.style.color = status.exhausted > 12 ? '#fca5a5' : '#fbbf24';
            } else {
                elements.qwenPoolStatus.textContent = 'tracking clean';
                elements.qwenPoolStatus.style.color = '#86efac';
            }
        } catch (_) {
            elements.qwenPoolStatus.textContent = '';
        }
    }

    async function refreshVisionHealth(modeLabel = '') {
        if (!window.electronAPI?.visionHealthStatus) {
            setVisionSummary('unsupported', 'bad');
            return;
        }
        try {
            const result = await window.electronAPI.visionHealthStatus();
            if (result?.success) {
                renderVisionHealth(result.status, modeLabel);
            } else {
                setVisionSummary('status failed', 'bad');
                if (elements.visionWarnings) {
                    elements.visionWarnings.innerHTML = `<div class="vision-health-warning">${escapeHtml(result?.error || 'Could not read vision status.')}</div>`;
                }
            }
        } catch (err) {
            setVisionSummary('status failed', 'bad');
            if (elements.visionWarnings) {
                elements.visionWarnings.innerHTML = `<div class="vision-health-warning">${escapeHtml(err?.message || err)}</div>`;
            }
        }
        updateQwenPoolStatus();
        if (elements.keyManager && !elements.keyManager.classList.contains('hidden')) {
            loadVisionKeys();
        }
    }

    function wireEvents() {
        [elements.clipAnalyzer, elements.storyblocks, elements.pexels, elements.pixabay, elements.youtube, elements.reddit, elements.bing, elements.brave]
            .filter(Boolean)
            .forEach(input => input.addEventListener('change', saveResourceSettings));

        elements.visionRefresh?.addEventListener('click', () => refreshVisionHealth('cached'));

        elements.visionLive?.addEventListener('click', async () => {
            if (!window.electronAPI?.visionHealthLiveCheck) return;
            elements.visionLive.disabled = true;
            setVisionSummary('probing...', 'warn');
            try {
                const result = await window.electronAPI.visionHealthLiveCheck({
                    lanes: ['image', 'omniHttp'],
                    imageLimit: 1,
                    omniLimit: 1,
                    concurrency: 3,
                    timeoutMs: 12000,
                });
                if (result?.success) {
                    const total = result.probe?.summary?.total || 0;
                    renderVisionHealth(result.status, `${total} checked`);
                } else {
                    setVisionSummary('probe failed', 'bad');
                    if (elements.visionWarnings) {
                        elements.visionWarnings.innerHTML = `<div class="vision-health-warning">${escapeHtml(result?.error || 'Live probe failed.')}</div>`;
                    }
                }
            } catch (err) {
                setVisionSummary('probe failed', 'bad');
                if (elements.visionWarnings) {
                    elements.visionWarnings.innerHTML = `<div class="vision-health-warning">${escapeHtml(err?.message || err)}</div>`;
                }
            } finally {
                elements.visionLive.disabled = false;
                updateQwenPoolStatus();
            }
        });

        elements.qwenPoolBtn?.addEventListener('click', async () => {
            if (!window.electronAPI?.qwenPoolReset) return;
            elements.qwenPoolBtn.disabled = true;
            try {
                const result = await window.electronAPI.qwenPoolReset();
                if (elements.qwenPoolStatus) {
                    elements.qwenPoolStatus.textContent = result?.success ? 'tracking reset' : 'reset failed';
                    elements.qwenPoolStatus.style.color = result?.success ? '#86efac' : '#fca5a5';
                }
                setTimeout(() => refreshVisionHealth('reset'), 800);
            } catch (_) {
                if (elements.qwenPoolStatus) {
                    elements.qwenPoolStatus.textContent = 'reset failed';
                    elements.qwenPoolStatus.style.color = '#fca5a5';
                }
            } finally {
                elements.qwenPoolBtn.disabled = false;
            }
        });

        elements.keyManagerToggle?.addEventListener('click', async () => {
            if (!elements.keyManager) return;
            const opening = elements.keyManager.classList.contains('hidden');
            elements.keyManager.classList.toggle('hidden', !opening);
            elements.keyManagerToggle.textContent = opening ? 'Hide Keys' : 'Manage Keys';
            if (opening) await loadVisionKeys();
        });

        elements.keyCancel?.addEventListener('click', () => {
            elements.keyManager?.classList.add('hidden');
            if (elements.keyManagerToggle) elements.keyManagerToggle.textContent = 'Manage Keys';
            if (elements.keySaveStatus) elements.keySaveStatus.textContent = '';
        });

        elements.keySave?.addEventListener('click', saveVisionKeysAndProbe);
        elements.envRefresh?.addEventListener('click', loadEnvResources);
        elements.envSave?.addEventListener('click', saveEnvEdits);
        elements.envLive?.addEventListener('click', () => liveCheckResources({ force: true, timeoutMs: 9000 }));
        elements.envClean?.addEventListener('click', cleanEnvFile);
        elements.envAdd?.addEventListener('click', saveEnvEdits);
        elements.cloudRefresh?.addEventListener('click', loadCloudAccounts);
        elements.cloudSave?.addEventListener('click', saveCloudAccounts);

        window.electronAPI?.onFootageResourcesUpdated?.((settings) => {
            applyResourceSettings(settings);
            setSaveStatus('synced', 'ok');
        });
    }

    async function init() {
        wireEvents();
        try {
            const settings = await window.electronAPI?.footageResourcesGet?.();
            if (settings?.success) applyResourceSettings(settings);
        } catch (_) {}
        setSaveStatus('ready');
        loadEnvResources();
        loadCloudAccounts();
        refreshVisionHealth();
    }

    document.addEventListener('DOMContentLoaded', init);
})();
