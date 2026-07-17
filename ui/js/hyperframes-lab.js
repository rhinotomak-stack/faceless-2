(function () {
    const state = {
        registry: null,
        lastResult: null,
        busy: false,
        previewPlaying: false,
        previewTime: 0,
        previewDuration: 0,
    };

    const $ = (id) => document.getElementById(id);
    const els = {
        status: $('status-pill'),
        refresh: $('btn-refresh-registry'),
        openFolder: $('btn-open-folder'),
        generate: $('btn-generate'),
        generateAll: $('btn-generate-all'),
        mode: $('mode'),
        kind: $('kind'),
        type: $('type-select'),
        variant: $('variant-select'),
        animation: $('animation-select'),
        style: $('style-select'),
        motionDirector: $('motion-director'),
        theme: $('theme-select'),
        duration: $('duration'),
        gap: $('gap'),
        speed: $('speed'),
        shadow: $('shadow'),
        coverageSummary: $('coverage-summary'),
        styleBadges: $('style-badges'),
        preview: $('preview-frame'),
        emptyPreview: $('empty-preview'),
        playPreview: $('btn-preview-play'),
        restartPreview: $('btn-preview-restart'),
        previewScrub: $('preview-scrub'),
        previewTime: $('preview-time'),
        projectPath: $('project-path'),
        reportSummary: $('report-summary'),
        issues: $('issue-list'),
        resolved: $('resolved-table'),
        matrix: $('matrix-grid'),
        log: $('log'),
    };

    function setStatus(text, cls) {
        els.status.textContent = text;
        els.status.className = `status-pill ${cls || ''}`.trim();
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function titleCase(value) {
        return String(value || '')
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .replace(/[-_]+/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .replace(/\b\w/g, (c) => c.toUpperCase());
    }

    function option(value, label) {
        const opt = document.createElement('option');
        opt.value = value;
        opt.textContent = label || titleCase(value);
        return opt;
    }

    function currentEntries() {
        if (!state.registry) return [];
        return els.kind.value === 'template'
            ? (state.registry.templates || [])
            : (state.registry.mgCategories || []);
    }

    function selectedEntry() {
        return currentEntries().find((entry) => entry.key === els.type.value) || currentEntries()[0] || null;
    }

    function fillSelect(select, values, selected) {
        select.innerHTML = '';
        for (const item of values || []) {
            if (typeof item === 'string') {
                select.appendChild(option(item, titleCase(item)));
            } else {
                select.appendChild(option(item.key, item.label || titleCase(item.key)));
            }
        }
        if (selected && Array.from(select.options).some((opt) => opt.value === selected)) {
            select.value = selected;
        }
    }

    function populateControls() {
        if (!state.registry) return;
        const previousType = els.type.value;
        fillSelect(els.theme, state.registry.themeIds || ['standard']);
        fillSelect(els.style, state.registry.styles || ['clean']);
        fillSelect(els.type, currentEntries(), previousType);
        updateVariantAndAnimation();
        renderCoverage();
        renderMatrix();
    }

    function updateVariantAndAnimation() {
        const entry = selectedEntry();
        if (!entry) {
            fillSelect(els.variant, []);
            fillSelect(els.animation, []);
            return;
        }
        const variants = els.kind.value === 'template'
            ? (entry.variants || [entry.defaultVariant || 'standard'])
            : (entry.variants || [{ key: entry.defaultVariant || 'standard' }]);
        const animations = entry.animations || [entry.defaultAnimation || 'fadeSlide'];
        fillSelect(els.variant, variants, entry.defaultVariant);
        fillSelect(els.animation, animations, entry.defaultAnimation);
    }

    function metric(label, value, hint) {
        return `
            <div class="metric">
                <div class="label">${escapeHtml(label)}</div>
                <div class="value">${escapeHtml(value)}</div>
                <div class="hint">${escapeHtml(hint || '')}</div>
            </div>
        `;
    }

    function renderCoverage() {
        if (!state.registry) return;
        const mg = state.registry.mgCategories || [];
        const templates = state.registry.templates || [];
        const mgVariants = mg.reduce((sum, entry) => sum + ((entry.variants || []).length || 1), 0);
        const templateVariants = templates.reduce((sum, entry) => sum + ((entry.variants || []).length || 1), 0);
        const animations = new Set();
        mg.forEach((entry) => (entry.animations || []).forEach((name) => animations.add(name)));
        templates.forEach((entry) => (entry.animations || []).forEach((name) => animations.add(name)));
        els.coverageSummary.innerHTML = [
            metric('MG Types', mg.length, `${mgVariants} variants`),
            metric('Templates', templates.length, `${templateVariants} variants`),
            metric('Styles', (state.registry.styles || []).length, 'theme presets'),
            metric('Animations', animations.size, 'declared options'),
        ].join('');

        els.styleBadges.innerHTML = (state.registry.styles || [])
            .map((name) => `<span class="badge">${escapeHtml(name)}</span>`)
            .join('') || '<span class="badge warn">No styles loaded</span>';
    }

    function renderMatrix() {
        if (!state.registry) return;
        const rows = [];
        for (const entry of state.registry.mgCategories || []) {
            rows.push({
                kind: 'MG',
                type: entry.key,
                variants: (entry.variants || []).map((v) => v.key || v).join(', '),
                animations: (entry.animations || []).join(', '),
            });
        }
        for (const entry of state.registry.templates || []) {
            rows.push({
                kind: 'Template',
                type: entry.key,
                variants: (entry.variants || []).join(', '),
                animations: (entry.animations || []).join(', '),
            });
        }
        els.matrix.innerHTML = table(rows, ['kind', 'type', 'variants', 'animations']);
    }

    function table(rows, columns) {
        if (!rows || !rows.length) return '<div class="issue">No rows yet.</div>';
        return `
            <table>
                <thead><tr>${columns.map((col) => `<th>${escapeHtml(titleCase(col))}</th>`).join('')}</tr></thead>
                <tbody>
                    ${rows.map((row) => `
                        <tr>${columns.map((col) => `<td>${escapeHtml(row[col])}</td>`).join('')}</tr>
                    `).join('')}
                </tbody>
            </table>
        `;
    }

    function payload(modeOverride) {
        return {
            mode: modeOverride || els.mode.value,
            kind: els.kind.value,
            type: els.type.value,
            variant: els.variant.value,
            animation: els.animation.value,
            styleName: els.style.value,
            motionDirector: Boolean(els.motionDirector?.checked),
            themeId: els.theme.value,
            styles: state.registry?.styles || [],
            duration: Number(els.duration.value || 2.8),
            gap: Number(els.gap.value || 0.35),
            speed: Number(els.speed.value || 1),
            shadowStrength: Number(els.shadow.value || 0.55),
        };
    }

    function setBusy(isBusy) {
        state.busy = isBusy;
        els.generate.disabled = isBusy;
        els.generateAll.disabled = isBusy;
        els.refresh.disabled = isBusy;
        setStatus(isBusy ? 'Generating' : 'Ready', isBusy ? 'warn' : 'ok');
    }

    function reportCard(label, value, hint) {
        return `<div class="report-card"><b>${escapeHtml(label)}</b><span>${escapeHtml(value)}</span><div class="hint">${escapeHtml(hint || '')}</div></div>`;
    }

    function countList(counts, limit = 4) {
        const entries = Object.entries(counts || {})
            .filter(([, count]) => Number(count || 0) > 0)
            .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0));
        if (!entries.length) return '';
        const shown = entries.slice(0, limit).map(([key, count]) => `${titleCase(key)} ${count}`);
        if (entries.length > limit) shown.push(`+${entries.length - limit} more`);
        return shown.join(', ');
    }

    function compact(value, max = 64) {
        const text = String(value ?? '').replace(/\s+/g, ' ').trim();
        return text.length > max ? `${text.slice(0, max - 1)}...` : text;
    }

    function renderReports(result) {
        const reports = result.reports || {};
        const visual = reports.visual || {};
        const style = reports.style || {};
        const snapshot = reports.snapshot || {};
        const stats = result.labStats || {};
        const unsupported = visual.unsupported || [];
        const fallbacks = visual.fallbacks || [];
        const missingMapAssets = visual.missingMapAssets || [];
        const missingTemplateMedia = visual.missingTemplateMedia || [];
        const byType = visual.byType || {};
        const byComposition = visual.byComposition || style.byComposition || {};
        const byLayout = visual.byLayout || style.byLayout || {};
        const byAnimation = visual.byAnimation || style.byAnimation || {};
        const totalResolved = visual.total || Object.values(byType).reduce((sum, n) => sum + Number(n || 0), 0);
        const sceneCount = Array.isArray(snapshot.scenes) ? snapshot.scenes.length : 0;

        els.reportSummary.innerHTML = [
            reportCard('Generated', `${stats.totalItems || 0} items`, `${stats.mgItems || 0} MG / ${stats.templateItems || 0} template${stats.motionDirector ? ' / director' : ''}`),
            reportCard('Resolved', totalResolved, `${Object.keys(byType).length} visual types`),
            reportCard('Composition', countList(byComposition, 3) || 'none', countList(byLayout, 3) || 'no layouts'),
            reportCard('Motion', countList(byAnimation, 3) || 'none', 'animations applied'),
            reportCard('Warnings', unsupported.length + fallbacks.length + missingMapAssets.length + missingTemplateMedia.length, 'bridge report'),
            reportCard('Plan', `${sceneCount || 1} scene`, style.themeId ? `theme ${style.themeId}` : 'snapshot saved'),
        ].join('');

        const issues = [];
        unsupported.forEach((item) => issues.push({ type: 'err', text: `Unsupported: ${describeIssue(item)}` }));
        fallbacks.forEach((item) => issues.push({ type: 'warn', text: `Fallback: ${describeIssue(item)}` }));
        missingMapAssets.forEach((item) => issues.push({ type: 'err', text: `Missing map asset: ${describeIssue(item)}` }));
        missingTemplateMedia.forEach((item) => issues.push({ type: 'err', text: `Missing template media: ${describeIssue(item)}` }));
        els.issues.innerHTML = issues.length
            ? issues.map((issue) => `<div class="issue ${issue.type === 'err' ? 'err' : ''}">${escapeHtml(issue.text)}</div>`).join('')
            : '<span class="badge good">No bridge issues reported</span>';

        const resolvedItems = Array.isArray(visual.resolved) ? visual.resolved : [];
        const resolvedRows = resolvedItems.length
            ? resolvedItems.map((row) => ({
                kind: row.kind || 'graphic',
                type: row.type || '-',
                mode: row.compositionMode || 'legacy',
                layout: row.layout || 'legacy',
                safeZone: row.safeZone || '-',
                source: row.compositionSource || '-',
                variant: row.variant || '-',
                animation: row.animation || '-',
                text: compact(row.text || ''),
            }))
            : Object.entries(byType).map(([type, count]) => ({ kind: '-', type, mode: '-', layout: '-', safeZone: '-', source: '-', variant: '-', animation: '-', text: `${count}` }));
        els.resolved.innerHTML = resolvedRows.length
            ? table(resolvedRows, ['kind', 'type', 'mode', 'layout', 'safeZone', 'source', 'variant', 'animation', 'text'])
            : '<div class="issue">No resolved visual report rows yet.</div>';

        els.log.textContent = [
            `success: ${result.success}`,
            `project: ${result.projectDir || '-'}`,
            `index: ${result.indexPath || '-'}`,
            `background: ${stats.background || '-'}`,
            `motion director: ${stats.motionDirector ? 'on' : 'off'}`,
            `composition: ${countList(byComposition) || 'none'}`,
            `layouts: ${countList(byLayout) || 'none'}`,
            `style report: ${style ? 'loaded' : 'missing'}`,
            `visual report: ${visual ? 'loaded' : 'missing'}`,
        ].join('\n');
    }

    function describeIssue(item) {
        if (item == null) return 'unknown';
        if (typeof item === 'string') return item;
        return Object.entries(item)
            .slice(0, 6)
            .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : value}`)
            .join(' ');
    }

    function previewDurationFor(result) {
        const statsDuration = Number(result?.labStats?.duration || 0);
        const snapshotDuration = Number(result?.reports?.snapshot?.totalDuration || 0);
        const duration = Math.max(statsDuration, snapshotDuration);
        return Number.isFinite(duration) && duration > 0 ? duration : 3;
    }

    function previewTimeFor(result) {
        const duration = previewDurationFor(result);
        if (Number.isFinite(duration) && duration > 0) {
            return Math.max(0.25, Math.min(0.9, duration * 0.22));
        }
        return 0.65;
    }

    function formatTime(seconds) {
        const value = Math.max(0, Number(seconds) || 0);
        return value.toFixed(2);
    }

    function updatePreviewControls() {
        const hasPreview = Boolean(state.lastResult?.fileUrl);
        els.playPreview.disabled = !hasPreview;
        els.restartPreview.disabled = !hasPreview;
        els.previewScrub.disabled = !hasPreview;
        els.playPreview.textContent = state.previewPlaying ? 'Pause' : 'Play';
        const duration = Math.max(0.001, Number(state.previewDuration) || 0.001);
        const progress = Math.max(0, Math.min(1000, Math.round((state.previewTime / duration) * 1000)));
        if (document.activeElement !== els.previewScrub) {
            els.previewScrub.value = String(progress);
        }
        els.previewTime.textContent = `${formatTime(state.previewTime)} / ${formatTime(state.previewDuration)}`;
    }

    function previewUrl(fileUrl, timeSec) {
        const glue = String(fileUrl || '').includes('?') ? '&' : '?';
        return `${fileUrl}${glue}preview=1&t=${encodeURIComponent(timeSec)}&cache=${Date.now()}`;
    }

    function seekPreview(timeSec, playing = false) {
        state.previewTime = Math.max(0, Math.min(Number(timeSec) || 0, state.previewDuration || Number.MAX_SAFE_INTEGER));
        state.previewPlaying = Boolean(playing);
        updatePreviewControls();
        try {
            els.preview?.contentWindow?.postMessage({
                type: 'hf-preview-seek',
                time: timeSec,
                playing,
            }, '*');
        } catch (_) {
            // Some file:// previews can block postMessage during navigation; the URL still carries the seek time.
        }
    }

    function setPreviewPlaying(playing) {
        if (!state.lastResult?.fileUrl) return;
        state.previewPlaying = Boolean(playing);
        updatePreviewControls();
        try {
            els.preview?.contentWindow?.postMessage({
                type: playing ? 'hf-preview-play' : 'hf-preview-pause',
            }, '*');
        } catch (_) {}
    }

    function restartPreview() {
        if (!state.lastResult?.fileUrl) return;
        seekPreview(0, true);
    }

    async function generate(modeOverride) {
        if (state.busy) return;
        setBusy(true);
        els.log.textContent = 'Generating real HyperFrames project...';
        try {
            const result = await window.electronAPI.hyperframesLabGenerate(payload(modeOverride));
            state.lastResult = result;
            if (!result || !result.success) {
                setStatus('Failed', 'err');
                els.log.textContent = result?.error || 'Unknown generation error';
                return;
            }
            if (result.fileUrl) {
                els.emptyPreview.style.display = 'none';
                const timeSec = previewTimeFor(result);
                result.previewTime = timeSec;
                state.previewDuration = previewDurationFor(result);
                state.previewTime = timeSec;
                state.previewPlaying = false;
                updatePreviewControls();
                els.preview.src = previewUrl(result.fileUrl, timeSec);
            }
            els.projectPath.textContent = result.projectDir || 'Project generated';
            renderReports(result);
            const warnings = (result.reports?.visual?.unsupported || []).length
                + (result.reports?.visual?.fallbacks || []).length
                + (result.reports?.visual?.missingMapAssets || []).length
                + (result.reports?.visual?.missingTemplateMedia || []).length;
            setStatus(warnings ? 'Ready with warnings' : 'Ready', warnings ? 'warn' : 'ok');
        } catch (err) {
            setStatus('Failed', 'err');
            els.log.textContent = err.message || String(err);
        } finally {
            els.generate.disabled = false;
            els.generateAll.disabled = false;
            els.refresh.disabled = false;
            state.busy = false;
        }
    }

    async function loadRegistry() {
        setStatus('Loading registry', 'warn');
        try {
            const registry = await window.electronAPI.hyperframesLabRegistry();
            if (!registry || !registry.success) throw new Error(registry?.error || 'Registry load failed');
            state.registry = registry;
            populateControls();
            setStatus('Ready', 'ok');
            els.log.textContent = `Loaded ${registry.mgCategories.length} MG categories and ${registry.templates.length} templates.`;
        } catch (err) {
            setStatus('Registry failed', 'err');
            els.log.textContent = err.message || String(err);
        }
    }

    function bind() {
        els.refresh.addEventListener('click', loadRegistry);
        els.openFolder.addEventListener('click', () => {
            window.electronAPI.hyperframesLabOpenFolder(state.lastResult?.projectDir);
        });
        els.preview.addEventListener('load', () => {
            if (!state.lastResult?.fileUrl) return;
            window.setTimeout(() => seekPreview(state.lastResult.previewTime || previewTimeFor(state.lastResult), false), 80);
        });
        els.playPreview.addEventListener('click', () => setPreviewPlaying(!state.previewPlaying));
        els.restartPreview.addEventListener('click', restartPreview);
        els.previewScrub.addEventListener('input', () => {
            const ratio = Number(els.previewScrub.value || 0) / 1000;
            seekPreview((state.previewDuration || 0) * ratio, false);
        });
        window.addEventListener('message', (event) => {
            const msg = event.data || {};
            if (msg.type !== 'hf-preview-time') return;
            state.previewTime = Number(msg.time || 0);
            state.previewDuration = Number(msg.duration || state.previewDuration || 0);
            state.previewPlaying = Boolean(msg.playing);
            updatePreviewControls();
        });
        els.generate.addEventListener('click', () => generate());
        els.generateAll.addEventListener('click', () => {
            els.mode.value = 'all';
            generate('all');
        });
        els.mode.addEventListener('change', () => {
            const single = els.mode.value === 'single';
            els.kind.disabled = !single;
            els.type.disabled = !single;
            els.variant.disabled = !single;
            els.animation.disabled = !single;
        });
        els.kind.addEventListener('change', populateControls);
        els.type.addEventListener('change', updateVariantAndAnimation);
    }

    bind();
    loadRegistry();
})();
