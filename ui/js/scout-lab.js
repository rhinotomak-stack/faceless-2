// Scout Lab renderer — sidebar + scene card + live event log.
// Talks to main via window.electronAPI.scoutLab* (see preload.js).

const $ = (s) => document.querySelector(s);
const state = {
    buildDir: null,
    scriptContext: null,
    scenes: [],
    selectedSceneId: null,
    running: false,
    refreshScoutNext: false,
    activeRunSceneId: null,
    logsByScene: new Map(),
    globalLogs: [],
    logFilter: 'all',
    batchCount: 4,
};

function fmt(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function escapeHtml(str) {
    return String(str == null ? '' : str)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function pill(text) {
    return `<span class="pill">${escapeHtml(text)}</span>`;
}

function sourceClass(scene) {
    if (scene.fullscreenMG) return 'mg';
    const h = String(scene.sourceHint || '').toLowerCase();
    if (h === 'youtube') return 'youtube';
    if (h === 'stock') return 'stock';
    if (h === 'web-image') return 'web-image';
    if (h === 'reddit') return 'reddit';
    return 'none';
}

function sourceLabel(scene) {
    if (scene.fullscreenMG) return 'MG';
    return scene.sourceHint || 'none';
}

function renderSidebar() {
    const filter = ($('#filter').value || '').toLowerCase().trim();
    const list = $('#scene-list');
    if (!state.scenes.length) {
        list.innerHTML = `<div class="empty-state">
            <div class="big">No scenes</div>
            <div>The checkpoint had no scenes.</div></div>`;
        return;
    }
    const rows = state.scenes
        .filter((s) => {
            if (!filter) return true;
            const hay = `${s.index} ${s.originalIndex || ''} ${s.searchKeyword || ''} ${s.visualIntent || ''} ${s.sourceHint || ''}`.toLowerCase();
            return hay.includes(filter);
        })
        .map((s) => {
            const id = s.originalIndex ?? s.index;
            const active = state.selectedSceneId === id ? ' active' : '';
            return `<div class="scene-row${active}" data-id="${id}">
                <div class="row-top">
                    <span class="idx">S${id}</span>
                    <span class="src ${sourceClass(s)}">${escapeHtml(sourceLabel(s))}</span>
                </div>
                <div class="keyword">${escapeHtml((s.searchKeyword || '(no keyword)').slice(0, 80))}</div>
                <div class="intent">${escapeHtml((s.visualIntent || s.text || '').slice(0, 110))}</div>
            </div>`;
        }).join('');
    list.innerHTML = rows || `<div class="empty-state">No scenes match the filter.</div>`;
    list.querySelectorAll('.scene-row').forEach((row) => {
        row.addEventListener('click', () => selectScene(Number(row.dataset.id)));
    });
}

function selectScene(id) {
    state.selectedSceneId = id;
    renderSidebar();
    renderSceneCard();
    renderRunSummary();
    renderLogPane();
}

function _sceneDisplayId(scene) {
    return Number(scene?.originalIndex ?? scene?.index);
}

function _sortedSceneIds() {
    return state.scenes
        .map(_sceneDisplayId)
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
}

function _batchSceneIds(startId, count) {
    const ids = _sortedSceneIds();
    const idx = ids.findIndex(id => Number(id) === Number(startId));
    return idx >= 0 ? ids.slice(idx, idx + count) : [Number(startId)].filter(Number.isFinite);
}

function _readBatchCount() {
    const input = $('#batch-count');
    const raw = input ? input.value : state.batchCount;
    const n = parseInt(raw, 10);
    const value = Math.max(2, Math.min(8, Number.isFinite(n) ? n : state.batchCount || 4));
    state.batchCount = value;
    if (input) input.value = String(value);
    return value;
}

// ---- Run Summary (sticky visual panel) ----

const _DOMAIN_HINTS = {
    laundry: [/\blaundr\w*\b/i, /\bwashing machines?\b/i, /\bdetergent\b/i, /\bdryers?\b/i, /\bsoap\b/i],
    finance: [/\bstocks?\b/i, /\btrad(?:e|ing|er|ers)\b/i, /\bbanks?\b/i, /\bfinance\b/i, /\bmarkets?\b/i, /\bwall street\b/i],
    maritime: [/\bships?\b/i, /\bshipping\b/i, /\bports?\b/i, /\bcargo\b/i, /\bmaritime\b/i, /\bnavy\b/i, /\bsail(?:ing|or|ors)?\b/i],
    kitchen: [/\bcook(?:ing)?\b/i, /\bkitchen\b/i, /\bchef\b/i, /\brecipe\b/i, /\bfood\b/i],
    medical: [/\bdoctor\b/i, /\bhospital\b/i, /\bmedic(?:al)?\b/i, /\bpatient\b/i, /\bsurgery\b/i],
    tech: [/\bcomputer\b/i, /\blaptop\b/i, /\bcode\b/i, /\bsoftware\b/i, /\bphone\b/i, /\bscreen\b/i],
    auto: [/\bcars?\b/i, /\btrucks?\b/i, /\bengine\b/i, /\bmechanic\b/i, /\bvehicle\b/i, /\bhighway\b/i],
    construction: [/\bbuild(?:ing)?\b/i, /\bconstruct(?:ion)?\b/i, /\btools?\b/i, /\bhammer\b/i, /\bsite\b/i],
};

function _detectDomainKeywords(text) {
    const lower = String(text || '');
    const matches = [];
    for (const [domain, terms] of Object.entries(_DOMAIN_HINTS)) {
        if (terms.some(t => t.test(lower))) matches.push(domain);
    }
    return matches;
}

function _latestSummary(logs) {
    for (let i = logs.length - 1; i >= 0; i--) {
        if (logs[i].stage === 'summary' && logs[i].data) return logs[i];
    }
    return null;
}

function _extractInsights(logs) {
    // Mine raw `log` events for things the structured summary doesn't surface:
    // rate-limits, HTTP errors, Title Sanity rejects, vision scores, hunter mismatches.
    const issues = [];
    const visionScores = [];
    const titleSanityRejects = [];
    const seen = new Set();

    function push(severity, text) {
        const key = `${severity}:${text}`;
        if (seen.has(key)) return;
        seen.add(key);
        issues.push({ severity, text });
    }

    let qwenRateLimited = false;
    let nvidiaErrored = false;
    let storyblocksHardCap = false;
    let storyblocksLogin = false;

    for (const evt of logs) {
        if (evt.stage !== 'log' && evt.stage !== 'cluster' && evt.stage !== 'scout' && evt.stage !== 'download') continue;
        const lines = String(evt.message || '').split(/\r?\n/);
        for (const line of lines) {
            // Vision scoring
            let m = line.match(/median[\s_-]*score[:\s]+([\d.]+)\s*\/\s*10/i)
                || line.match(/vision.*score[:\s]+([\d.]+)\s*\/\s*10/i);
            if (m) visionScores.push(Number(m[1]));

            // Title sanity
            if (/TitleSanity|Title Sanity|title-sanity/i.test(line) && /reject|mismatch|skip/i.test(line)) {
                const trimmed = line.replace(/^\s*\W*/, '').slice(0, 200);
                titleSanityRejects.push(trimmed);
            }

            // Qwen rate-limits
            if (/Qwen.*(429|rate.?limit|exhaust)/i.test(line) || /(429|rate.?limit).*Qwen/i.test(line)) {
                qwenRateLimited = true;
            }
            // NVIDIA HTTP errors
            if (/NVIDIA.*\b(500|502|503|504|429|401|403)\b/i.test(line) || /\bNVIDIA.*(error|failed)/i.test(line)) {
                nvidiaErrored = true;
            }
            // Storyblocks hard-cap (new abort plumbing)
            if (/Storyblocks.*hard-cap.*exceeded/i.test(line) || /Storyblocks.*aborted/i.test(line)) {
                storyblocksHardCap = true;
            }
            if (/Storyblocks login unavailable/i.test(line)) storyblocksLogin = true;

            // Title-mismatch penalty
            const pm = line.match(/mismatch.*penalty[:\s-]*(-?\d+(?:\.\d+)?)/i)
                || line.match(/penalty[:\s-]*(-?\d+(?:\.\d+)?).*mismatch/i);
            if (pm) push('warn', `Vision mismatch penalty ${pm[1]} applied`);

            // Provider HTTP failure
            const httpm = line.match(/(\b[a-zA-Z][\w-]+)\s*(?:HTTP|status|code)[:\s]*\b(4\d\d|5\d\d)\b/i);
            if (httpm && !/qwen|nvidia/i.test(httpm[1])) {
                push('warn', `${httpm[1]} returned HTTP ${httpm[2]}`);
            }
        }
    }

    if (qwenRateLimited) push('bad', 'Qwen vision rate-limited across keys');
    if (nvidiaErrored)   push('bad', 'NVIDIA vision returned HTTP error');
    if (storyblocksHardCap) push('warn', 'Storyblocks clip hard-cap fired (abort plumbing worked)');
    if (storyblocksLogin) push('warn', 'Storyblocks login unavailable');

    return {
        issues,
        visionScores,
        titleSanityRejects: titleSanityRejects.slice(0, 4),
    };
}

function _providerScoreboard(timeline = [], rejected = []) {
    // Aggregate provider attempts: name -> { count, lastStatus, reasons[], statusCounts }
    const map = new Map();
    function bump(name, status, reason) {
        const key = name || '?';
        if (!map.has(key)) map.set(key, { name: key, count: 0, statuses: {}, reasons: [] });
        const row = map.get(key);
        row.count += 1;
        const s = status || 'info';
        row.statuses[s] = (row.statuses[s] || 0) + 1;
        if (reason) row.reasons.push(reason);
    }
    for (const t of timeline) bump(t.provider, t.status, t.reason);
    for (const r of rejected) bump(r.provider, 'rejected', r.reason);
    // Order: rows with accepted first, then by count desc
    const rows = Array.from(map.values()).sort((a, b) => {
        const aOk = a.statuses.accepted || a.statuses.cached || a.statuses.resumed ? 1 : 0;
        const bOk = b.statuses.accepted || b.statuses.cached || b.statuses.resumed ? 1 : 0;
        if (aOk !== bOk) return bOk - aOk;
        return b.count - a.count;
    });
    return rows;
}

function _bestProviderStatus(row) {
    if (row.statuses.accepted) return 'accepted';
    if (row.statuses.cached)   return 'cached';
    if (row.statuses.resumed)  return 'resumed';
    if (row.statuses.failed)   return 'failed';
    if (row.statuses.timeout)  return 'timeout';
    if (row.statuses.rejected) return 'rejected';
    return Object.keys(row.statuses)[0] || 'info';
}

function _linkHost(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); }
    catch (_) { return ''; }
}

function _durationLabel(sec) {
    const n = Number(sec || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 60) return `${Math.round(n)}s`;
    return `${Math.floor(n / 60)}m ${Math.round(n % 60)}s`;
}

function _triedLinksHtml(triedLinks = []) {
    if (!Array.isArray(triedLinks) || triedLinks.length === 0) {
        return '<div class="rs-link-empty">No candidate links recorded yet. Run this scene again to capture the new link ledger.</div>';
    }
    const rows = triedLinks.slice(0, 80).map((row) => {
        const status = row.status || 'info';
        const provider = row.provider || '?';
        const query = row.query || '';
        const url = row.url || '';
        const host = _linkHost(url);
        const duration = _durationLabel(row.duration);
        const scores = [
            Number.isFinite(Number(row.score)) ? `score ${Number(row.score)}/10` : '',
            Number.isFinite(Number(row.postScore)) ? `post ${Number(row.postScore)}/10` : '',
            Number.isFinite(Number(row.deepScore)) ? `deep ${Number(row.deepScore)}/10` : '',
        ].filter(Boolean).join(' | ');
        const meta = [
            row.source,
            duration,
            host,
            scores,
            row.reason,
        ].filter(Boolean).join(' · ');
        const title = row.title || url || 'No candidate links returned';
        const link = url
            ? `<a class="rs-link-title" href="${escapeHtml(url)}" target="_blank" rel="noreferrer" title="${escapeHtml(url)}">${escapeHtml(title)}</a>`
            : `<span class="rs-link-title muted">${escapeHtml(title)}</span>`;
        return `<div class="rs-link-row">
            <div class="rs-link-top">
                <span class="chip ${escapeHtml(status)}">${escapeHtml(status)}</span>
                <b>${escapeHtml(provider)}</b>
                ${query ? `<span class="query">"${escapeHtml(query)}"</span>` : ''}
            </div>
            ${link}
            ${meta ? `<div class="rs-link-meta">${escapeHtml(meta)}</div>` : ''}
        </div>`;
    }).join('');
    const more = triedLinks.length > 80
        ? `<div class="rs-link-empty">Showing 80 of ${triedLinks.length} recorded link rows. Export the log for the full ledger.</div>`
        : '';
    return `<div class="rs-link-list">${rows}${more}</div>`;
}

function renderRunSummary() {
    const wrap = $('#run-summary');
    const id = state.selectedSceneId;
    if (id == null) { wrap.classList.add('empty'); wrap.innerHTML = ''; return; }
    const scene = sceneById(id);
    const logs = _logsFor(id, false);
    const sumEvt = _latestSummary(logs);

    if (!sumEvt) {
        // Nothing yet — hide the panel entirely; the scene-card already shows the basics.
        wrap.classList.add('empty');
        wrap.innerHTML = '';
        return;
    }

    const d = sumEvt.data || {};
    const final = d.final || {};
    const file = d.file || {};
    const plan = d.plan || {};
    const intent = d.intent || {};
    const hunter = d.hunter || {};
    const mediaAgent = d.mediaAgent || null;
    const timeline = Array.isArray(d.timeline) ? d.timeline : [];
    const rejected = Array.isArray(d.rejected) ? d.rejected : [];
    const triedLinks = Array.isArray(d.triedLinks) ? d.triedLinks : [];
    const insights = _extractInsights(logs);

    const ok = !!d.ok;
    const dur = Number.isFinite(d.durationSec) ? `${d.durationSec.toFixed(1)}s` : '—';
    const verdictText = ok ? 'ACCEPTED' : 'FAILED';
    const verdictIcon = ok ? '✓' : '✗';

    // --- Phase tiles ---
    const scoutMsg = (() => {
        const ev = logs.find(e => e.stage === 'scout');
        if (!ev) return { cls: 'skip', value: 'not run', sub: '' };
        const data = ev.data || {};
        const bank = (data.sceneBank || []).length;
        const cand = (data.topCandidates || []).length;
        const order = (data.scoutOrder || []).join(' › ') || '(no order)';
        if (!bank && !cand) return { cls: 'warn', value: '0 bank candidates', sub: order };
        return { cls: 'ok', value: `${bank} bank, ${cand} cand`, sub: order.slice(0, 60) };
    })();

    const dlEvt = [...logs].reverse().find(e => e.stage === 'download-done');
    const dlMsg = (() => {
        if (!dlEvt) return { cls: 'skip', value: 'no download event', sub: '' };
        const dd = dlEvt.data || {};
        if (dd.error) return { cls: 'bad', value: 'failed', sub: String(dd.error).slice(0, 80) };
        if (dd.fileExists) return { cls: 'ok', value: `${dd.status || 'done'}`, sub: `${(dd.fileSize / 1024 / 1024 || 0).toFixed(2)} MB` };
        return { cls: 'warn', value: dd.status || 'no media', sub: '' };
    })();

    const visionMsg = (() => {
        if (!insights.visionScores.length) return { cls: 'skip', value: 'no scores parsed', sub: '' };
        const max = Math.max(...insights.visionScores);
        const min = Math.min(...insights.visionScores);
        const cls = max >= 6 ? 'ok' : max >= 4 ? 'warn' : 'bad';
        return { cls, value: `${min.toFixed(1)} – ${max.toFixed(1)} / 10`, sub: `${insights.visionScores.length} reads` };
    })();

    const setupMsg = (() => {
        const ctx = state.scriptContext || {};
        const niche = ctx.nicheId || ctx.niche || '—';
        return { cls: 'ok', value: niche, sub: ctx.themeId ? `theme ${ctx.themeId}` : '' };
    })();

    const tile = (label, m) => `<div class="rs-tile ${m.cls}">
        <div class="label">${escapeHtml(label)}</div>
        <div class="value">${escapeHtml(m.value)}</div>
        ${m.sub ? `<div class="sub">${escapeHtml(m.sub)}</div>` : ''}
    </div>`;

    // --- Provider scoreboard ---
    const board = _providerScoreboard(timeline, rejected);
    const boardRows = board.length
        ? board.map(row => {
            const status = _bestProviderStatus(row);
            const reason = row.reasons.find(Boolean) || '';
            return `<tr>
                <td class="name">${escapeHtml(row.name)}</td>
                <td class="count">× ${row.count}</td>
                <td><span class="chip ${escapeHtml(status)}">${escapeHtml(status)}</span></td>
                <td class="reason">${escapeHtml(reason.slice(0, 140))}</td>
            </tr>`;
        }).join('')
        : '<tr><td colspan="4" class="muted">No provider attempts recorded.</td></tr>';

    // --- Hunter / plan card with domain-mismatch tag ---
    const sceneText = `${scene?.searchKeyword || ''} ${scene?.visualIntent || ''} ${scene?.text || ''}`;
    const sceneDomains = _detectDomainKeywords(sceneText);
    const hunterDomainRaw = String(hunter.domain || '').toLowerCase();
    const hunterModeRaw = String(hunter.mode || '').toLowerCase();
    const agenticHunter = hunterDomainRaw === 'agentic' || hunterModeRaw.startsWith('agentic-');
    const hunterDomainTokens = agenticHunter ? [] : hunterDomainRaw.split(/[/,\s]+/).filter(Boolean);
    const domainMismatch = !agenticHunter && sceneDomains.length && hunterDomainTokens.length
        && !sceneDomains.some(d => hunterDomainTokens.some(t => t.includes(d) || d.includes(t)));
    if (domainMismatch) {
        insights.issues.unshift({
            severity: 'bad',
            text: `Hunter domain "${hunter.domain}" ≠ scene domain (${sceneDomains.join(', ')})`,
        });
    }

    const planHtml = `
        <div class="rs-plan">
            <div class="k">Lane</div><div class="v">${escapeHtml(intent.lane || '—')} <span class="warn-tag">${escapeHtml(intent.strength || '')}</span></div>
            <div class="k">Lock</div><div class="v">${escapeHtml(intent.lockType || '—')} · fallback=${intent.allowTypeFallback ? 'allowed' : 'blocked'}</div>
            <div class="k">Keyword</div><div class="v">${escapeHtml(plan.keyword || '—')}</div>
            <div class="k">VP Hint</div><div class="v">${escapeHtml(plan.sourceHint || '—')} (${escapeHtml(plan.mediaType || '—')}) · soft only</div>
            ${mediaAgent && Array.isArray(mediaAgent.providerOrder) && mediaAgent.providerOrder.length
                ? `<div class="k">Agent Mission</div><div class="v">${escapeHtml(mediaAgent.providerOrder.join(' › '))}</div>`
                : ''}
            ${mediaAgent && Array.isArray(mediaAgent.providerEvidence) && mediaAgent.providerEvidence.length
                ? `<div class="k">Scout Evidence</div><div class="v">${escapeHtml(mediaAgent.providerEvidence.map(e => `${e.provider}:${Math.round(e.score || 0)}`).join(' › '))}</div>`
                : ''}
            <div class="k">Hunter</div><div class="v">${escapeHtml(hunter.mode || '—')} · ${escapeHtml(hunter.domain || '—')}${domainMismatch ? '<span class="warn-tag">⚠ domain mismatch</span>' : ''}</div>
            ${hunter.target ? `<div class="k">Target</div><div class="v">${escapeHtml(hunter.target)}</div>` : ''}
            <div class="k">Final</div><div class="v">${escapeHtml(final.provider || '—')}${final.query ? ` · "${escapeHtml(final.query)}"` : ''}</div>
            <div class="k">File</div><div class="v">${file.exists ? `<span class="good-text">exists</span> · ${fmtBytes(file.sizeBytes)}` : '<span class="bad-text">missing</span>'}</div>
        </div>`;

    // --- Issues list ---
    const issuesHtml = insights.issues.length
        ? `<ul class="rs-issues">${insights.issues.slice(0, 8).map(i =>
            `<li class="${i.severity === 'bad' ? 'bad' : ''}">${escapeHtml(i.text)}</li>`
        ).join('')}</ul>`
        : '<ul class="rs-issues"><li class="muted">No issues detected.</li></ul>';

    const titleSanityHtml = insights.titleSanityRejects.length
        ? `<h3 style="margin-top:8px">Title Sanity</h3>
           <ul class="rs-issues">${insights.titleSanityRejects.map(t => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
        : '';

    wrap.classList.remove('empty');
    wrap.innerHTML = `
        <div class="rs-head">
            <h2>Run Summary · S${id}</h2>
            <span class="rs-verdict ${ok ? 'good' : 'bad'}">${verdictIcon} ${verdictText}</span>
            <span class="meta">${escapeHtml(dur)} · ${escapeHtml(final.provider || 'no provider')}</span>
            <span class="spacer"></span>
            <span class="meta">${d.counts ? `${d.counts.searches || 0} searches · ${d.counts.rejected || 0} rejected · ${d.counts.accepted || 0} accepted` : ''}</span>
        </div>
        <div class="rs-tiles">
            ${tile('SETUP', setupMsg)}
            ${tile('SCOUT', scoutMsg)}
            ${tile('DOWNLOAD', dlMsg)}
            ${tile('VISION', visionMsg)}
        </div>
        <div class="rs-cols">
            <div class="rs-card">
                <h3>Providers (${board.length})</h3>
                <table class="rs-scoreboard"><tbody>${boardRows}</tbody></table>
            </div>
            <div class="rs-card">
                <h3>Plan & Hunter</h3>
                ${planHtml}
            </div>
        </div>
        <div class="rs-card" style="margin-top:10px">
            <h3>Tried Links (${triedLinks.length})</h3>
            ${_triedLinksHtml(triedLinks)}
        </div>
        <div class="rs-card" style="margin-top:10px">
            <h3>Issues (auto-mined from log)</h3>
            ${issuesHtml}
            ${titleSanityHtml}
        </div>
    `;
}

// ---- Log filtering ----

function _eventMatchesFilter(evt) {
    const filter = state.logFilter;
    if (filter === 'all') return true;
    const stage = evt.stage || 'log';
    const msg = String(evt.message || '');
    if (filter === 'decisions') {
        if (stage === 'summary' || stage === 'download-done') return true;
        return extractDecisionTrailFromText(msg, 1).length > 0;
    }
    if (filter === 'phases') {
        return ['setup', 'scene', 'batch', 'cleanup', 'cluster', 'scout', 'download', 'download-done', 'download-skip', 'summary'].includes(stage);
    }
    if (filter === 'providers') {
        if (['scout', 'download', 'download-done'].includes(stage)) return true;
        return /pexels|pixabay|youtube|storyblocks|reddit|bing|unsplash|google|provider|hunter/i.test(msg);
    }
    if (filter === 'vision') {
        return /vision|qwen|omni|nvidia|score|frame|mismatch|TitleSanity|title.?sanity/i.test(msg) || /vision|score/i.test(stage);
    }
    if (filter === 'errors') {
        if (stage === 'summary' && evt.data && evt.data.ok === false) return true;
        if (stage === 'download-done' && evt.data && evt.data.error) return true;
        return /\berr(or|ored)?\b|\bfail(ed|ure)?\b|\b(429|500|502|503|504|401|403)\b|reject|timeout|rate.?limit|exhaust/i.test(msg);
    }
    return true;
}

function renderSceneCard() {
    const card = $('#scene-card');
    const id = state.selectedSceneId;
    if (id == null) {
        card.innerHTML = `<div class="empty-state">
            <div class="big">No scene selected</div>
            <div>Pick a scene from the sidebar, then click <b>Run Test</b>.</div></div>`;
        return;
    }
    const scene = state.scenes.find((s) => Number(s.originalIndex ?? s.index) === Number(id));
    if (!scene) {
        card.innerHTML = `<div class="empty-state"><div class="big">Scene ${id} not found</div></div>`;
        return;
    }
    const grid = [
        ['INDEX', `S${id}${scene.index !== scene.originalIndex && scene.originalIndex != null ? ` (raw S${scene.index})` : ''}`],
        ['TIME', `${(scene.startTime || 0).toFixed(2)}s → ${(scene.endTime || 0).toFixed(2)}s`],
        ['TEXT', scene.text || ''],
        ['KEYWORD', scene.searchKeyword || '(none)'],
        ['VISUAL INTENT', scene.visualIntent || '(none)'],
        ['VP SOURCE HINT', `${scene.sourceHint || 'auto'} (soft)${scene.fullscreenMG ? ' (fullscreenMG — no download)' : ''}`],
        ['MEDIA TYPE', scene.mediaType || 'video'],
    ];
    card.innerHTML = `<h2>Scene S${id}</h2>
        <div class="grid">${grid.map(([k, v]) => `<div class="k">${k}</div><div class="v">${escapeHtml(v)}</div>`).join('')}</div>
        <div class="actions">
            <button class="primary" id="btn-run" ${state.running ? 'disabled' : ''}>${state.running ? 'Running…' : 'Run Test'}</button>
            <button id="btn-run-batch" ${state.running ? 'disabled' : ''} title="Run selected scene plus the next scenes through the real multi-scene downloader">Run Batch</button>
            <label class="batch-control" title="How many scenes to include in the batch concurrency test">
                scenes
                <input id="batch-count" type="number" min="2" max="8" step="1" value="${escapeHtml(state.batchCount || 4)}" ${state.running ? 'disabled' : ''} />
            </label>
            <span class="batch-note">tests scene concurrency</span>
            <button id="btn-export-log" ${_logsFor(id, false).length ? '' : 'disabled'} title="Save this scene log and copy the file path">Export Log</button>
        </div>`;
    const btnRun = $('#btn-run');
    if (btnRun) btnRun.addEventListener('click', () => runTest(id));
    const batchInput = $('#batch-count');
    if (batchInput) batchInput.addEventListener('change', _readBatchCount);
    const btnBatch = $('#btn-run-batch');
    if (btnBatch) btnBatch.addEventListener('click', () => runBatch(id));
    const btnExport = $('#btn-export-log');
    if (btnExport) btnExport.addEventListener('click', () => exportSceneLog(id));
}

function _logKey(sceneId) {
    return sceneId == null ? '__global__' : String(sceneId);
}

function _logsFor(sceneId, create = false) {
    if (sceneId == null) return state.globalLogs;
    const key = _logKey(sceneId);
    if (!state.logsByScene.has(key) && create) state.logsByScene.set(key, []);
    return state.logsByScene.get(key) || [];
}

function clearLog(sceneId = state.selectedSceneId) {
    if (sceneId == null) {
        state.globalLogs = [];
    } else {
        state.logsByScene.set(_logKey(sceneId), []);
    }
    renderSceneCard();
    renderRunSummary();
    renderLogPane();
}

function fmtBytes(bytes) {
    const n = Number(bytes || 0);
    if (!n) return '-';
    if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
    return `${Math.round(n / 1024)} KB`;
}

function _shortLog(text, max = 170) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    return `${s.slice(0, Math.max(0, max - 1)).trim()}...`;
}

function _cleanLogLine(line) {
    return String(line || '')
        .replace(/[\u2500-\u257f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function _decisionTone(verdict) {
    const v = String(verdict || '').toLowerCase();
    if (/accept|pass|downloaded|kept|exists/.test(v)) return 'accept';
    if (/reject|failed|fail|low|skip|deadline|blocked|no media|missing/.test(v)) return 'reject';
    if (/score|vision|analysis|window|title/.test(v)) return 'score';
    if (/search|query|provider|agent|hunter/.test(v)) return 'info';
    return 'info';
}

function _decisionLabel(row) {
    const parts = [];
    if (row.provider) parts.push(row.provider);
    if (row.query) parts.push(`"${row.query}"`);
    if (row.title) parts.push(row.title);
    return parts.join(' - ');
}

function _pushDecision(rows, row) {
    const clean = {
        phase: row.phase || 'Media',
        verdict: row.verdict || 'info',
        provider: _shortLog(row.provider || '', 60),
        query: _shortLog(row.query || '', 120),
        title: _shortLog(row.title || '', 150),
        score: _shortLog(row.score || '', 40),
        reason: _shortLog(row.reason || '', 260),
        detail: _shortLog(row.detail || '', 220),
    };
    clean.tone = _decisionTone(clean.verdict || clean.phase);
    const key = `${clean.phase}|${clean.verdict}|${clean.provider}|${clean.query}|${clean.title}|${clean.score}|${clean.reason}`;
    if (!rows._seen) rows._seen = new Set();
    if (rows._seen.has(key)) return;
    rows._seen.add(key);
    rows.push(clean);
}

function extractDecisionTrailFromText(text, maxRows = 90) {
    const rows = [];
    let currentProvider = '';
    let currentQuery = '';
    let currentCandidate = '';
    const lines = String(text || '').split(/\r?\n/).map(_cleanLogLine).filter(Boolean);

    for (const line of lines) {
        let m;

        if ((m = line.match(/Media Agent:\s*(AI|fallback)?\s*role=([^\s]+)\s*need="([^"]+)"/i))) {
            _pushDecision(rows, {
                phase: 'Agent brief',
                verdict: m[1] || 'agent',
                detail: `role=${m[2]}`,
                reason: m[3],
            });
            continue;
        }
        if ((m = line.match(/Media Agent:\s*providers\s+(.+)/i))) {
            _pushDecision(rows, { phase: 'Provider order', verdict: 'agent', detail: m[1] });
            continue;
        }
        if ((m = line.match(/Media Agent:\s*mandatory visible\s+(.+)/i))) {
            _pushDecision(rows, { phase: 'Mandatory visible', verdict: 'hard requirement', reason: m[1] });
            continue;
        }
        if ((m = line.match(/Media Agent:\s*must show\s+(.+)/i))) {
            _pushDecision(rows, { phase: 'Must show', verdict: 'agent', reason: m[1] });
            continue;
        }
        if ((m = line.match(/Media Hunter:\s*mode=([^\s]+)\s+domain=([^\s]+)\s+strictRaw=([^\s]+)\s+target="([^"]+)"/i))) {
            _pushDecision(rows, {
                phase: 'Hunter contract',
                verdict: 'agent',
                detail: `mode=${m[1]} domain=${m[2]} strictRaw=${m[3]}`,
                reason: m[4],
            });
            continue;
        }
        if ((m = line.match(/Media Hunter:\s*avoid\s+(.+)/i))) {
            _pushDecision(rows, { phase: 'Avoid list', verdict: 'agent', reason: m[1] });
            continue;
        }
        if ((m = line.match(/\[Media Agent\]\s*provider plan\s*->\s*(.+)/i))) {
            _pushDecision(rows, { phase: 'Provider order', verdict: 'agent', detail: m[1] });
            continue;
        }
        if ((m = line.match(/\[Media Agent\]\s*final provider mission\s*->\s*(.+)/i))) {
            _pushDecision(rows, { phase: 'Final provider mission', verdict: 'agent', detail: m[1] });
            continue;
        }
        if ((m = line.match(/\[Topic Footage Scout\]\s*(.+?)\s*provider evidence\s*->\s*(.+?)\s*\(Media Agent keeps final authority\)/i))) {
            _pushDecision(rows, { phase: 'Scout evidence', verdict: 'info', title: m[1], detail: m[2] });
            continue;
        }

        if ((m = line.match(/Media Hunter:\s*([^[]+?)\s+query\s+"([^"]+)"\s*->\s*"([^"]+)"/i))) {
            currentProvider = _shortLog(m[1].trim(), 60);
            currentQuery = m[3];
            _pushDecision(rows, {
                phase: 'Query rewrite',
                verdict: 'search',
                provider: currentProvider,
                query: m[3],
                reason: `from "${m[2]}"`,
                detail: line.match(/\(alt:\s*([^)]+)\)/i)?.[1] || '',
            });
            continue;
        }
        if ((m = line.match(/\[([^\]]+)\]\s+Searching:\s*"([^"]+)"/i))) {
            currentProvider = m[1];
            currentQuery = m[2];
            _pushDecision(rows, { phase: 'Search', verdict: 'search', provider: currentProvider, query: currentQuery });
            continue;
        }
        if ((m = line.match(/Search keyword override:\s*using retry query\s+"([^"]+)"/i))) {
            currentQuery = m[1];
            _pushDecision(rows, { phase: 'Retry query', verdict: 'search', query: currentQuery });
            continue;
        }

        if ((m = line.match(/Media Scout:\s*\[([^\]]+)\]\s*(\d+)\s*->\s*(\d+)\s*kept\s*\(reject:\s*([^)]+)\);\s*top\s*"([^"]+)"\s*\(([^)]+)\)/i))) {
            currentProvider = m[1];
            currentCandidate = m[5];
            _pushDecision(rows, {
                phase: 'Media Scout filter',
                verdict: `${m[3]} kept`,
                provider: m[1],
                query: currentQuery,
                title: m[5],
                score: m[6],
                reason: `${m[2]} results, rejected ${m[4]}`,
            });
            continue;
        }
        if ((m = line.match(/Media Hunter:\s*\[([^\]]+)\]\s*ranked\s*"([^"]+)"\s*first\s*\(([^)]+)\)/i))) {
            currentProvider = m[1];
            currentCandidate = m[2];
            _pushDecision(rows, {
                phase: 'Hunter ranking',
                verdict: 'ranked first',
                provider: m[1],
                query: currentQuery,
                title: m[2],
                score: m[3],
            });
            continue;
        }
        if ((m = line.match(/Title Sanity\s*\(AI\):\s*\[([^\]]+)\]\s*(\d+)\s*->\s*(\d+)\s*kept\s*\(AI rejected\s*(\d+):\s*(.+)\)/i))) {
            _pushDecision(rows, {
                phase: 'Title Sanity',
                verdict: `${m[3]} kept`,
                provider: m[1],
                query: currentQuery,
                reason: `${m[4]} rejected - ${m[5]}`,
            });
            continue;
        }
        if ((m = line.match(/Title Sanity\s*\(AI\):\s*\[([^\]]+)\]\s*all\s*(\d+)\s*titles passed/i))) {
            _pushDecision(rows, {
                phase: 'Title Sanity',
                verdict: 'passed',
                provider: m[1],
                query: currentQuery,
                reason: `${m[2]} titles passed`,
            });
            continue;
        }

        if ((m = line.match(/Media Preview Scout.*candidate\s+(\d+)\/(\d+)\s+\[([^\]]+)\]\s*"([^"]+)".*\(([^)]*)\)/i))) {
            currentProvider = m[3];
            currentCandidate = m[4];
            _pushDecision(rows, {
                phase: 'Preview candidate',
                verdict: `candidate ${m[1]}/${m[2]}`,
                provider: m[3],
                title: m[4],
                detail: m[5],
            });
            continue;
        }
        if ((m = line.match(/Media Preview Scout.*inspecting\s+"([^"]+)"\s*\(([^)]*)\)/i))) {
            currentCandidate = m[1];
            _pushDecision(rows, {
                phase: 'Preview scan',
                verdict: 'inspecting',
                provider: currentProvider,
                title: m[1],
                detail: m[2],
            });
            continue;
        }
        if ((m = line.match(/Segment selected:\s*startTime=([\d.]+)s\s*\|\s*reason:\s*(.+)/i))) {
            _pushDecision(rows, {
                phase: 'Segment pick',
                verdict: 'score',
                provider: currentProvider,
                title: currentCandidate,
                score: `${m[1]}s`,
                reason: m[2],
            });
            continue;
        }
        if ((m = line.match(/Window validation:\s*(PASS|REJECT)\s*\(([\d.]+)\/10\)\s*-\s*(.+)/i))) {
            _pushDecision(rows, {
                phase: 'Exact window',
                verdict: m[1].toLowerCase(),
                provider: currentProvider,
                title: currentCandidate,
                score: `${m[2]}/10`,
                reason: m[3],
            });
            continue;
        }
        if ((m = line.match(/Media Preview Scout.*rejected\s+"([^"]+)"\s+at\s+([\d.]+)s\s*\(exact window failed:\s*(.+)\)/i))) {
            _pushDecision(rows, {
                phase: 'Preview reject',
                verdict: 'rejected',
                provider: currentProvider,
                title: m[1],
                score: `${m[2]}s`,
                reason: m[3],
            });
            continue;
        }
        if ((m = line.match(/Media Preview Scout.*rejected\s+"([^"]+)"\s*\(([^)]+)\)/i))) {
            _pushDecision(rows, {
                phase: 'Preview reject',
                verdict: 'rejected',
                provider: currentProvider,
                title: m[1],
                reason: m[2],
            });
            continue;
        }
        if ((m = line.match(/Media Preview Scout.*accepted\s+"([^"]+)"\s+at\s+([\d.]+)s\s*\(([^)]+)\)/i))) {
            _pushDecision(rows, {
                phase: 'Preview accept',
                verdict: 'accepted',
                provider: currentProvider,
                title: m[1],
                score: `${m[2]}s`,
                reason: m[3],
            });
            continue;
        }
        if ((m = line.match(/Media Preview Scout.*\[(.+?)\]\s*inspected\s*(\d+),\s*accepted\s*(\d+),\s*rejected\s*(\d+),\s*windowRejected\s*(\d+),\s*skipped\s*(\d+)\s*\(([^)]+)\)/i))) {
            _pushDecision(rows, {
                phase: 'Preview summary',
                verdict: Number(m[3]) > 0 ? 'accepted' : 'rejected',
                provider: m[1],
                reason: `inspected ${m[2]}, accepted ${m[3]}, rejected ${m[4]}, window rejected ${m[5]}, skipped ${m[6]}`,
                detail: m[7],
            });
            continue;
        }

        if ((m = line.match(/\[([^\]]+)\]\s*Downloading/i))) {
            currentProvider = m[1];
            _pushDecision(rows, { phase: 'Download', verdict: 'downloading', provider: m[1], title: currentCandidate });
            continue;
        }
        if ((m = line.match(/\[([^\]]+)\]\s*Downloaded:\s*([^ ]+)/i))) {
            currentProvider = m[1];
            _pushDecision(rows, { phase: 'Download', verdict: 'downloaded', provider: m[1], title: currentCandidate, detail: m[2] });
            continue;
        }

        if ((m = line.match(/Clip frame\s+(\d+)\/(\d+)\s*\(([^)]*)\):\s*([\d.]+)\/10\s*(?:->|>|-|.*?→)?\s*(.+)/i))) {
            _pushDecision(rows, {
                phase: 'Frame score',
                verdict: 'score',
                provider: currentProvider,
                title: currentCandidate,
                score: `${m[4]}/10`,
                reason: `frame ${m[1]}/${m[2]} ${m[3]} - ${m[5]}`,
            });
            continue;
        }
        if ((m = line.match(/Vision:\s*([\d.]+)\/10\s*(?:->|>|-|.*?→)?\s*(.+)/i))) {
            _pushDecision(rows, {
                phase: 'Vision score',
                verdict: Number(m[1]) >= 6 ? 'accepted score' : 'low score',
                provider: currentProvider,
                title: currentCandidate,
                score: `${m[1]}/10`,
                reason: m[2],
            });
            continue;
        }
        if ((m = line.match(/\[([^\]]+)\]\s*Post-download score:\s*([\d.]+)\/10\s*(?:->|>|-|.*?→)?\s*(.+)/i))) {
            _pushDecision(rows, {
                phase: 'Post-download score',
                verdict: Number(m[2]) >= 6 ? 'accepted score' : 'low score',
                provider: m[1],
                title: currentCandidate,
                score: `${m[2]}/10`,
                reason: m[3],
            });
            continue;
        }
        if ((m = line.match(/Clip Analysis:\s*([\d.]+)\/10\s*\|\s*(.+)/i))) {
            _pushDecision(rows, {
                phase: 'Deep clip analysis',
                verdict: Number(m[1]) >= 6 ? 'accepted score' : 'low score',
                provider: currentProvider,
                title: currentCandidate,
                score: `${m[1]}/10`,
                reason: m[2],
            });
            continue;
        }
        if ((m = line.match(/Deep analysis too low\s*\(([\d.]+)\/10.+trying next result/i))) {
            _pushDecision(rows, {
                phase: 'Deep clip analysis',
                verdict: 'rejected',
                provider: currentProvider,
                title: currentCandidate,
                score: `${m[1]}/10`,
                reason: 'score too low, trying next result',
            });
            continue;
        }

        if ((m = line.match(/strict raw guard:\s*(.+)/i))) {
            _pushDecision(rows, {
                phase: 'Final guard',
                verdict: /accept/i.test(m[1]) ? 'accepted' : 'rejected',
                provider: currentProvider,
                title: currentCandidate,
                reason: m[1],
            });
            continue;
        }
        if ((m = line.match(/All\s+(.+?)\s+providers failed for\s+"([^"]+)"/i))) {
            _pushDecision(rows, {
                phase: 'Provider exhausted',
                verdict: 'failed',
                query: m[2],
                reason: `all ${m[1]} providers failed`,
            });
            continue;
        }
        if ((m = line.match(/Scene deadline:\s*(.+)/i))) {
            _pushDecision(rows, { phase: 'Deadline', verdict: 'skipped', reason: m[1] });
            continue;
        }
        if (/No media found after all retries/i.test(line)) {
            _pushDecision(rows, { phase: 'Final result', verdict: 'failed', reason: 'no media found after all retries' });
            continue;
        }
        if ((m = line.match(/\[Media Trace\]\s*final:\s*(.+)/i))) {
            _pushDecision(rows, { phase: 'Final trace', verdict: /failed/i.test(m[1]) ? 'failed' : 'info', reason: m[1] });
            continue;
        }
    }

    delete rows._seen;
    return rows.slice(0, maxRows);
}

function collectDecisionTrail(logs, maxRows = 140) {
    const rows = [];
    rows._seen = new Set();
    for (const evt of logs || []) {
        if (!evt || !evt.message) continue;
        if (!['log', 'download', 'download-done', 'scout', 'cluster', 'summary'].includes(evt.stage || 'log')) continue;
        const parsed = extractDecisionTrailFromText(evt.message, maxRows);
        for (const row of parsed) _pushDecision(rows, row);
        if (rows.length >= maxRows) break;
    }
    delete rows._seen;
    return rows.slice(0, maxRows);
}

function renderDecisionTrail(rows, opts = {}) {
    const list = Array.isArray(rows) ? rows : [];
    if (!list.length) return '';
    const limit = Number.isFinite(opts.limit) ? opts.limit : 80;
    const shown = list.slice(0, limit);
    const hidden = list.length - shown.length;
    return `<div class="decision-trail">
        ${shown.map((row) => {
            const label = _decisionLabel(row);
            return `<div class="decision-row ${escapeHtml(row.tone || _decisionTone(row.verdict))}">
                <span class="phase">${escapeHtml(row.phase)}</span>
                <span class="verdict">${escapeHtml(row.verdict)}</span>
                ${row.score ? `<span class="score">${escapeHtml(row.score)}</span>` : ''}
                ${label ? `<span class="candidate">${escapeHtml(label)}</span>` : ''}
                ${row.reason ? `<div class="reason">${escapeHtml(row.reason)}</div>` : ''}
                ${row.detail ? `<div class="detail">${escapeHtml(row.detail)}</div>` : ''}
            </div>`;
        }).join('')}
        ${hidden > 0 ? `<div class="decision-more">+${hidden} more parsed decision events in raw transcript</div>` : ''}
    </div>`;
}

function decisionTrailMarkdown(rows, maxRows = 140) {
    const list = Array.isArray(rows) ? rows.slice(0, maxRows) : [];
    if (!list.length) return '';
    return list.map((row, i) => {
        const label = _decisionLabel(row);
        const bits = [
            `${i + 1}. [${row.verdict || 'info'}] ${row.phase || 'Media'}`,
            row.score ? `score=${row.score}` : '',
            label,
            row.reason ? `-- ${row.reason}` : '',
            row.detail ? `(${row.detail})` : '',
        ].filter(Boolean);
        return bits.join(' | ');
    }).join('\n');
}

function renderSummaryEvent(evt) {
    const d = evt.data || {};
    const wrap = document.createElement('div');
    wrap.className = `log-event summary ${d.ok ? 'ok' : 'err'}`;
    const file = d.file || {};
    const final = d.final || {};
    const plan = d.plan || {};
    const intent = d.intent || {};
    const hunter = d.hunter || {};
    const mediaAgent = d.mediaAgent || null;
    const timeline = Array.isArray(d.timeline) ? d.timeline : [];
    const rejected = Array.isArray(d.rejected) ? d.rejected : [];

    const timelineHtml = timeline.length
        ? timeline.map(t => `<li>
            <span class="step">#${escapeHtml(t.step)}</span>
            <b>${escapeHtml(t.provider || '?')}</b>
            <span class="status ${escapeHtml(String(t.status || '').replace(/\s+/g, '-'))}">${escapeHtml(t.status || '')}</span>
            ${t.query ? `<span class="query">"${escapeHtml(t.query)}"</span>` : ''}
            ${t.reason ? `<span class="reason">${escapeHtml(t.reason)}</span>` : ''}
        </li>`).join('')
        : '<li class="muted">No provider attempt data recorded.</li>';

    const rejectedHtml = rejected.length
        ? rejected.map(r => `<li><b>${escapeHtml(r.provider || '?')}</b>${r.query ? ` "${escapeHtml(r.query)}"` : ''}${r.reason ? ` — ${escapeHtml(r.reason)}` : ''}</li>`).join('')
        : '<li class="muted">No rejected candidates before the final result.</li>';

    let pretty = '';
    try { pretty = JSON.stringify(d, null, 2); } catch (_) { pretty = String(d); }

    wrap.innerHTML = `
        <span class="ts">${fmt(evt.ts || Date.now())}</span>
        <span class="stage">summary</span>
        <span class="msg">${escapeHtml(evt.message || '')}</span>
        <div class="summary-card">
            <div class="verdict ${d.ok ? 'good' : 'bad'}">${d.ok ? 'Accepted' : 'Not accepted'}</div>
            <div class="summary-grid">
                <div class="k">Final asset</div>
                <div class="v">${escapeHtml(final.provider || '-')} ${final.query ? `using "${escapeHtml(final.query)}"` : ''}</div>
                <div class="k">File</div>
                <div class="v">
                    <span class="${file.exists ? 'good-text' : 'bad-text'}">${file.exists ? 'exists' : 'missing'}</span>
                    ${file.sizeBytes ? ` · ${fmtBytes(file.sizeBytes)}` : ''}
                    ${file.path ? `<div class="path">${escapeHtml(file.path)}</div>` : ''}
                </div>
                <div class="k">Plan</div>
                <div class="v">${escapeHtml(plan.mediaType || '-')} / ${escapeHtml(plan.sourceHint || '-')} · ${escapeHtml(plan.keyword || '-')}</div>
                <div class="k">Source authority</div>
                <div class="v">Media Agent decides providers; VP sourceHint is soft context</div>
                <div class="k">Intent</div>
                <div class="v">${escapeHtml(intent.lane || '-')} · lock=${escapeHtml(intent.lockType || '-')} · fallback=${intent.allowTypeFallback ? 'allowed' : 'blocked'}</div>
                <div class="k">Hunter</div>
                <div class="v">${escapeHtml(hunter.mode || '-')} / ${escapeHtml(hunter.domain || '-')} ${hunter.target ? `· ${escapeHtml(hunter.target)}` : ''}</div>
                ${mediaAgent ? `
                <div class="k">Media Agent</div>
                <div class="v">${escapeHtml(mediaAgent.ai ? 'AI' : 'fallback')} / ${escapeHtml(mediaAgent.role || '-')} ${Array.isArray(mediaAgent.providerOrder) && mediaAgent.providerOrder.length ? ` - ${escapeHtml(mediaAgent.providerOrder.join(' > '))}` : ''}
                    ${mediaAgent.viewerNeed ? `<div class="path">${escapeHtml(mediaAgent.viewerNeed)}</div>` : ''}
                    ${Array.isArray(mediaAgent.literalRequiredObjects) && mediaAgent.literalRequiredObjects.length ? `<div class="path">Literal ${escapeHtml(mediaAgent.literalRequiredObjects.join(' | '))}</div>` : ''}
                    ${Array.isArray(mediaAgent.mandatoryIdentity) && mediaAgent.mandatoryIdentity.length ? `<div class="path">Mandatory identity ${escapeHtml(mediaAgent.mandatoryIdentity.join(' | '))} (${escapeHtml(mediaAgent.identityEvidenceMode || 'frame-visible')})</div>` : ''}
                    ${Array.isArray(mediaAgent.mandatoryVisible) && mediaAgent.mandatoryVisible.length ? `<div class="path">Frame-visible ${escapeHtml(mediaAgent.mandatoryVisible.join(' | '))}</div>` : ''}
                    ${Array.isArray(mediaAgent.providerEvidence) && mediaAgent.providerEvidence.length ? `<div class="path">Evidence ${escapeHtml(mediaAgent.providerEvidence.map(e => `${e.provider}:${Math.round(e.score || 0)}`).join(' | '))}</div>` : ''}
                    ${Array.isArray(mediaAgent.providerReality) && mediaAgent.providerReality.length ? `<div class="path">Reality ${escapeHtml(mediaAgent.providerReality.join(' | '))}</div>` : ''}
                    ${Array.isArray(mediaAgent.providerExclusions) && mediaAgent.providerExclusions.length ? `<div class="path bad-text">Skip ${escapeHtml(mediaAgent.providerExclusions.map(e => `${e.provider}: ${e.reason}`).join(' | '))}</div>` : ''}
                </div>` : ''}
            </div>
            <div class="summary-columns">
                <div>
                    <h3>Path To Result</h3>
                    <ol class="timeline">${timelineHtml}</ol>
                </div>
                <div>
                    <h3>Rejected Before Final</h3>
                    <ul class="rejects">${rejectedHtml}</ul>
                </div>
            </div>
            <details class="raw-json"><summary>raw summary JSON</summary><pre>${escapeHtml(pretty)}</pre></details>
        </div>`;
    return wrap;
}

function colorizeLogMessage(text) {
    // Escape first, then wrap tokens with semantic span classes. Order matters:
    // longer / more specific patterns run before shorter ones so a "rejected"
    // word inside a "✅ accepted" line doesn't get split awkwardly.
    let s = escapeHtml(String(text || ''));

    // Specific rescue / pick / pipeline phrases — strongest highlights first.
    s = s.replace(/(Best-frame rescue|Topic-map rescue|Preview Scout rescue|Smart Segment rescue|Smart Trim|Rescue floor applied|topic-map rescued|Picked|PICKED)/g,
        '<span class="tok-rescue">$1</span>');

    // Provider / module tags: [Storyblocks Videos], [Smart Trim], [Qwen Image], etc.
    s = s.replace(/\[([^\]]{1,40})\]/g, '<span class="tok-tag">[$1]</span>');

    // Score patterns: N/10 — colored by tier.
    s = s.replace(/\b(\d+)\s*\/\s*10\b/g, (m, n) => {
        const num = +n;
        const cls = num >= 7 ? 'tok-score-good' : num >= 5 ? 'tok-score-mid' : 'tok-score-bad';
        return `<span class="${cls}">${m}</span>`;
    });

    // Semantic emojis.
    s = s.replace(/(❌|💀|🚨|⛔|🔴)/g, '<span class="tok-err">$1</span>');
    s = s.replace(/(✅|🟢|🎯)/g, '<span class="tok-ok">$1</span>');
    s = s.replace(/(⚠️|⏱️|⏳|🟡)/g, '<span class="tok-warn">$1</span>');
    s = s.replace(/(🎬|🗺️|🔍|👁️|🧠|💡)/g, '<span class="tok-info">$1</span>');
    s = s.replace(/(🔄|⬇️|⏭️|🧢|📡|🔑|🌐)/g, '<span class="tok-action">$1</span>');

    // HTTP status codes for errors.
    s = s.replace(/\b(4\d{2}|5\d{2})\b/g, '<span class="tok-err-word">$1</span>');

    // URLs (after tag wrapping so [https://...] still tags first).
    s = s.replace(/(https?:\/\/[^\s<>"']+)/g, '<span class="tok-url">$1</span>');

    // Keyword classes — error / warn / ok words. Word boundaries only.
    s = s.replace(/\b(error|errors|errored|failed|failure|reject|rejected|rejecting|timeout|timed out|exhausted|aborted|abort|broken)\b/gi,
        '<span class="tok-err-word">$1</span>');
    s = s.replace(/\b(success|succeeded|accepted|downloaded|picked|usable|rescued|ok|passed|kept)\b/gi,
        '<span class="tok-ok-word">$1</span>');
    s = s.replace(/\b(skipped|skip|cooldown|rate.?limited|rate.?limit|stalling|degraded)\b/gi,
        '<span class="tok-warn-word">$1</span>');

    // Durations / sizes — dim numeric runs (e.g., 180s, 12.4MB, 25s).
    s = s.replace(/\b(\d+(?:\.\d+)?)(s|ms|MB|KB|fps)\b/g,
        '<span class="tok-num">$1$2</span>');

    return s;
}

function renderLogEvent(evt) {
    const stage = evt.stage || 'log';
    const isErr = evt.data && evt.data.error;
    if (stage === 'summary') return renderSummaryEvent(evt);
    const okSuffix = stage === 'download-done' ? (isErr ? ' err' : ' ok') : '';
    const wrap = document.createElement('div');
    wrap.className = `log-event ${stage}${okSuffix}`;

    const msg = String(evt.message || '');
    const rawLines = msg.split(/\r?\n/).filter(Boolean);
    const decisionRows = extractDecisionTrailFromText(msg, 100);
    const collapseRaw = stage === 'log' && (rawLines.length > 3 || msg.length > 900);
    let html = `<span class="ts">${fmt(evt.ts || Date.now())}</span>`;
    html += `<span class="stage">${escapeHtml(stage)}</span>`;
    if (collapseRaw) {
        html += `<span class="msg">${decisionRows.length ? `Decision trail (${decisionRows.length} parsed events)` : `Raw provider transcript (${rawLines.length || 1} lines)`}</span>`;
        html += renderDecisionTrail(decisionRows, { limit: 100 });
        html += `<div class="data raw-log"><details><summary>show raw transcript</summary><pre>${colorizeLogMessage(msg)}</pre></details></div>`;
    } else {
        html += `<span class="msg">${colorizeLogMessage(msg)}</span>`;
        html += renderDecisionTrail(decisionRows, { limit: 8 });
    }
    if (evt.data && Object.keys(evt.data).length) {
        let pretty;
        try { pretty = JSON.stringify(evt.data, null, 2); } catch (_) { pretty = String(evt.data); }
        const isLarge = pretty.length > 240;
        html += `<div class="data">
            <details${isLarge ? '' : ' open'}><summary>details (${pretty.length.toLocaleString()} chars)</summary>
            <pre>${escapeHtml(pretty)}</pre></details></div>`;
    }
    wrap.innerHTML = html;
    return wrap;
}

function renderLogPane() {
    const pane = $('#log-pane');
    const id = state.selectedSceneId;
    const logs = _logsFor(id, false);
    pane.innerHTML = '';
    const countEl = $('#log-count');
    if (!logs.length) {
        pane.innerHTML = `<div class="empty-state">
            <div>${id == null ? 'Load a build or select a scene.' : `No logs for S${id} yet.`}</div>
            ${id == null ? '' : '<div>Click <b>Run Test</b> to create logs for this scene.</div>'}
        </div>`;
        if (countEl) countEl.textContent = '';
        return;
    }
    let shown = 0;
    for (const evt of logs) {
        if (!_eventMatchesFilter(evt)) continue;
        pane.appendChild(renderLogEvent(evt));
        shown++;
    }
    if (countEl) countEl.textContent = `${shown} / ${logs.length} events`;
    if (shown === 0) {
        pane.innerHTML = `<div class="empty-state"><div>No events match filter <b>${escapeHtml(state.logFilter)}</b>.</div></div>`;
    } else {
        pane.scrollTop = pane.scrollHeight;
    }
}

function setLogFilter(filter) {
    state.logFilter = filter;
    document.querySelectorAll('#log-bar .log-chip').forEach(chip => {
        chip.classList.toggle('active', chip.dataset.filter === filter);
    });
    renderLogPane();
}

function appendEvent(evt, sceneId = undefined) {
    const targetId = sceneId !== undefined
        ? sceneId
        : (evt.sceneId != null ? evt.sceneId : (state.activeRunSceneId != null ? state.activeRunSceneId : state.selectedSceneId));
    const stamped = { ...evt, ts: evt.ts || Date.now(), sceneId: targetId };
    const logs = _logsFor(targetId, true);
    logs.push(stamped);

    if (_logKey(targetId) === _logKey(state.selectedSceneId)) {
        const pane = $('#log-pane');
        if (pane.querySelector('.empty-state')) pane.innerHTML = '';
        if (_eventMatchesFilter(stamped)) {
            pane.appendChild(renderLogEvent(stamped));
            pane.scrollTop = pane.scrollHeight;
        }
        const countEl = $('#log-count');
        if (countEl) {
            const shown = logs.filter(_eventMatchesFilter).length;
            countEl.textContent = `${shown} / ${logs.length} events`;
        }
        const btnExport = $('#btn-export-log');
        if (btnExport) btnExport.disabled = false;
        // Re-render the sticky run summary on each new event so phase tiles,
        // provider scoreboard and mined issues stay current as the run unfolds.
        renderRunSummary();
    }
}

function sceneById(sceneId) {
    return state.scenes.find((s) => Number(s.originalIndex ?? s.index) === Number(sceneId));
}

function jsonBlock(value) {
    try {
        return `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\`\n`;
    } catch (_) {
        return `\n\`\`\`text\n${String(value)}\n\`\`\`\n`;
    }
}

function dataLine(label, value) {
    return `- ${label}: ${value == null || value === '' ? '-' : String(value)}`;
}

function exportVideosTriedRows(summary) {
    if (!summary) return [];
    if (Array.isArray(summary.videosTried) && summary.videosTried.length) {
        return summary.videosTried;
    }
    const triedStatuses = new Set(['candidate', 'accepted', 'rejected', 'failed', 'cached', 'resumed']);
    return (Array.isArray(summary.triedLinks) ? summary.triedLinks : [])
        .filter(row => row && row.url && triedStatuses.has(String(row.status || '').toLowerCase()))
        .map(row => ({
            provider: row.provider,
            query: row.query,
            status: row.status,
            title: row.title,
            url: row.url,
            duration: row.duration,
            width: row.width,
            height: row.height,
            attempt: row.attempt,
            score: row.score,
            postScore: row.postScore,
            deepScore: row.deepScore,
            path: row.path,
            reason: row.reason,
        }));
}

function eventToMarkdown(evt, index) {
    const ts = evt.ts ? new Date(evt.ts).toISOString() : new Date().toISOString();
    const stage = evt.stage || 'log';
    let out = `### ${index + 1}. ${stage} (${ts})\n\n`;
    if (evt.message) out += `${String(evt.message)}\n\n`;
    if (evt.data && Object.keys(evt.data).length) out += jsonBlock(evt.data);
    return out.trimEnd();
}

function downloadPhaseEvents(logs = []) {
    const start = logs.findIndex(evt => evt.stage === 'download');
    return start >= 0 ? logs.slice(start) : logs;
}

function buildSceneLogMarkdown(sceneId) {
    const scene = sceneById(sceneId);
    const logs = _logsFor(sceneId, false);
    const ctx = state.scriptContext || {};
    const latestSummary = [...logs].reverse().find((evt) => evt.stage === 'summary');
    const summary = latestSummary?.data || null;

    const parts = [];
    parts.push(`# Scout Lab Scene S${sceneId}`);
    parts.push('');
    parts.push(dataLine('Exported', new Date().toISOString()));
    parts.push(dataLine('Build', state.buildDir));
    parts.push(dataLine('Video title', ctx.videoTitle || ctx.title));
    parts.push(dataLine('Niche', ctx.nicheId || ctx.niche));
    parts.push('');
    parts.push('## Scene');
    parts.push('');
    if (scene) {
        parts.push(dataLine('Index', `S${sceneId}${scene.index !== scene.originalIndex && scene.originalIndex != null ? ` (raw S${scene.index})` : ''}`));
        parts.push(dataLine('Time', `${(scene.startTime || 0).toFixed(2)}s -> ${(scene.endTime || 0).toFixed(2)}s`));
        parts.push(dataLine('Text', scene.text || ''));
        parts.push(dataLine('Keyword', scene.searchKeyword || '(none)'));
        parts.push(dataLine('Visual intent', scene.visualIntent || '(none)'));
        parts.push(dataLine('VP source hint', `${scene.sourceHint || 'auto'} (soft)`));
        parts.push(dataLine('Media type', scene.mediaType || 'video'));
    } else {
        parts.push(`Scene S${sceneId} was not found in the loaded build.`);
    }

    if (summary) {
        const file = summary.file || {};
        const final = summary.final || {};
        const plan = summary.plan || {};
        const intent = summary.intent || {};
        const hunter = summary.hunter || {};
        const mediaAgent = summary.mediaAgent || null;
        parts.push('');
        parts.push('## Quick Result');
        parts.push('');
        parts.push(dataLine('Verdict', summary.ok ? 'accepted' : 'not accepted'));
        parts.push(dataLine('Final provider', final.provider || '-'));
        parts.push(dataLine('Final query', final.query || '-'));
        parts.push(dataLine('File', file.path || '-'));
        parts.push(dataLine('File exists', file.exists ? `yes (${fmtBytes(file.sizeBytes)})` : 'no'));
        parts.push(dataLine('Plan', `${plan.mediaType || '-'} / ${plan.sourceHint || '-'} / ${plan.keyword || '-'}`));
        parts.push(dataLine('Intent', `${intent.lane || '-'} / lock=${intent.lockType || '-'} / fallback=${intent.allowTypeFallback ? 'allowed' : 'blocked'}`));
        parts.push(dataLine('Hunter', `${hunter.mode || '-'} / ${hunter.domain || '-'}${hunter.target ? ` / ${hunter.target}` : ''}`));
        if (mediaAgent) {
            parts.push(dataLine('Media agent', `${mediaAgent.ai ? 'AI' : 'fallback'} / ${mediaAgent.role || '-'} / ${(mediaAgent.providerOrder || []).join(' > ') || '-'}`));
            parts.push(dataLine('Source authority', 'Media Agent provider mission; VP sourceHint is soft context only'));
            parts.push(dataLine('Agent need', mediaAgent.viewerNeed || '-'));
            if (Array.isArray(mediaAgent.providerEvidence) && mediaAgent.providerEvidence.length) {
                parts.push(dataLine('Scout evidence', mediaAgent.providerEvidence.map(e => `${e.provider}:${Math.round(e.score || 0)}`).join('; ')));
            }
            if (Array.isArray(mediaAgent.providerReality) && mediaAgent.providerReality.length) {
                parts.push(dataLine('Provider reality', mediaAgent.providerReality.join('; ')));
            }
            if (Array.isArray(mediaAgent.providerExclusions) && mediaAgent.providerExclusions.length) {
                parts.push(dataLine('Provider exclusions', mediaAgent.providerExclusions.map(e => `${e.provider}: ${e.reason}`).join('; ')));
            }
            if (Array.isArray(mediaAgent.literalRequiredObjects) && mediaAgent.literalRequiredObjects.length) {
                parts.push(dataLine('Literal required objects', mediaAgent.literalRequiredObjects.join('; ')));
            }
            if (Array.isArray(mediaAgent.mandatoryIdentity) && mediaAgent.mandatoryIdentity.length) {
                parts.push(dataLine('Mandatory identity', `${mediaAgent.mandatoryIdentity.join('; ')} (${mediaAgent.identityEvidenceMode || 'frame-visible'})`));
            }
            if (Array.isArray(mediaAgent.mandatoryVisible) && mediaAgent.mandatoryVisible.length) {
                parts.push(dataLine('Mandatory visible', mediaAgent.mandatoryVisible.join('; ')));
            }
            if (Array.isArray(mediaAgent.mustShow) && mediaAgent.mustShow.length) parts.push(dataLine('Must show', mediaAgent.mustShow.join('; ')));
            if (Array.isArray(mediaAgent.mustAvoid) && mediaAgent.mustAvoid.length) parts.push(dataLine('Must avoid', mediaAgent.mustAvoid.join('; ')));
        }
        if (Array.isArray(summary.timeline) && summary.timeline.length) {
            parts.push('');
            parts.push('### Provider Path');
            parts.push('');
            for (const step of summary.timeline) {
                parts.push(`- #${step.step || '?'} ${step.provider || '?'}: ${step.status || '?'}${step.query ? ` | "${step.query}"` : ''}${step.reason ? ` | ${step.reason}` : ''}`);
            }
        }
        if (Array.isArray(summary.rejected) && summary.rejected.length) {
            parts.push('');
            parts.push('### Rejected Before Final');
            parts.push('');
            for (const rejected of summary.rejected) {
                parts.push(`- ${rejected.provider || '?'}${rejected.query ? ` "${rejected.query}"` : ''}${rejected.reason ? `: ${rejected.reason}` : ''}`);
            }
        }
        if (Array.isArray(summary.triedLinks) && summary.triedLinks.length) {
            parts.push('');
            parts.push('### Tried Links');
            parts.push('');
            for (const row of summary.triedLinks) {
                const bits = [
                    row.status || 'info',
                    row.provider || '?',
                    row.query ? `"${row.query}"` : '',
                    row.title || '',
                    Number.isFinite(Number(row.score)) ? `score: ${Number(row.score)}/10` : '',
                    Number.isFinite(Number(row.postScore)) ? `post: ${Number(row.postScore)}/10` : '',
                    Number.isFinite(Number(row.deepScore)) ? `deep: ${Number(row.deepScore)}/10` : '',
                    row.reason ? `reason: ${row.reason}` : '',
                    row.url ? `url: ${row.url}` : 'no url recorded',
                ].filter(Boolean);
                parts.push(`- ${bits.join(' | ')}`);
            }
        }
    }

    if (summary && Array.isArray(summary.videosFound) && summary.videosFound.length) {
        parts.push('');
        parts.push('## Videos Found');
        parts.push('');
        parts.push('_Every raw search result returned by any provider, grouped by provider + query (each group = one search round)._');
        let totalFound = 0;
        for (const group of summary.videosFound) totalFound += (group.count || 0);
        parts.push('');
        parts.push(dataLine('Total unique results across all rounds', String(totalFound)));
        for (const group of summary.videosFound) {
            parts.push('');
            parts.push(`### ${group.provider || '?'} — "${group.query || '(no query)'}" (${group.count || 0} result${group.count === 1 ? '' : 's'})`);
            parts.push('');
            const items = Array.isArray(group.items) ? group.items : [];
            if (!items.length) {
                parts.push('_No candidates recorded._');
                continue;
            }
            items.forEach((item, idx) => {
                const bits = [
                    `${idx + 1}.`,
                    item.title || '(no title)',
                    item.duration ? `${item.duration}s` : '',
                    item.url ? item.url : '(no url)',
                    item.stage ? `stage: ${item.stage}` : '',
                    item.reason ? `reason: ${item.reason}` : '',
                ].filter(Boolean);
                parts.push(`- ${bits.join(' | ')}`);
            });
        }
    }

    const videosTriedRows = exportVideosTriedRows(summary);
    if (videosTriedRows.length) {
        parts.push('');
        parts.push('## Videos Tried');
        parts.push('');
        parts.push('_Only the candidates actually picked for download / vision scoring (across all rounds and retries)._');
        parts.push('');
        parts.push(dataLine('Total tried', String(videosTriedRows.length)));
        parts.push('');
        videosTriedRows.forEach((row, idx) => {
            const bits = [
                `${idx + 1}.`,
                `[${row.status || 'info'}]`,
                row.provider || '?',
                row.query ? `"${row.query}"` : '',
                row.title || '',
                row.duration ? `${row.duration}s` : '',
                row.url ? row.url : '(no url)',
                Number.isFinite(row.attempt) ? `attempt ${row.attempt}` : '',
                Number.isFinite(Number(row.score)) ? `score ${Number(row.score)}/10` : '',
                Number.isFinite(Number(row.postScore)) ? `post ${Number(row.postScore)}/10` : '',
                Number.isFinite(Number(row.deepScore)) ? `deep ${Number(row.deepScore)}/10` : '',
                row.path ? `file: ${row.path}` : '',
                row.reason ? `reason: ${row.reason}` : '',
            ].filter(Boolean);
            parts.push(`- ${bits.join(' | ')}`);
        });
    }

    const downloadLogs = downloadPhaseEvents(logs);
    const decisionTrail = collectDecisionTrail(downloadLogs, 160);
    if (decisionTrail.length) {
        parts.push('');
        parts.push('## Decision Trail');
        parts.push('');
        parts.push('_Selected-scene download phase only. Full build-wide scout chatter is kept below in Full Scene Events._');
        parts.push('');
        parts.push(decisionTrailMarkdown(decisionTrail, 160));
    }

    parts.push('');
    parts.push('## Full Scene Events');
    parts.push('');
    if (logs.length) {
        logs.forEach((evt, i) => {
            parts.push(eventToMarkdown(evt, i));
            parts.push('');
        });
    } else {
        parts.push('No scene logs captured yet. Run the test first.');
    }
    return parts.join('\n');
}

async function exportSceneLog(sceneId) {
    try {
        if (!_logsFor(sceneId, false).length) {
            appendEvent({ stage: 'log', message: `Nothing to export for S${sceneId} yet. Run Test first.` }, sceneId);
            return;
        }
        const result = await window.electronAPI.scoutLabExportSceneLog({
            buildDir: state.buildDir,
            sceneId,
            content: buildSceneLogMarkdown(sceneId),
        });
        if (!result || !result.ok) throw new Error(result?.error || 'Export failed');
        appendEvent({
            stage: 'log',
            message: `Scene log exported and path copied: ${result.path}`,
            data: { path: result.path, copiedToClipboard: result.copiedToClipboard === true },
        }, sceneId);
    } catch (err) {
        appendEvent({ stage: 'log', message: `[err] Export failed: ${err.message}` }, sceneId);
    } finally {
        renderSceneCard();
    }
}

async function loadBuildDialog() {
    try {
        const dir = await window.electronAPI.selectFolder('Pick the project folder containing .build-checkpoint.json');
        if (!dir) return;
        await loadBuild(dir);
    } catch (err) {
        appendEvent({ stage: 'log', message: `Load failed: ${err.message}` });
    }
}

async function loadBuild(buildDir) {
    state.logsByScene = new Map();
    state.globalLogs = [];
    state.activeRunSceneId = null;
    state.selectedSceneId = null;
    appendEvent({ stage: 'setup', message: `Loading ${buildDir}` }, null);
    try {
        const data = await window.electronAPI.scoutLabLoadBuild(buildDir);
        state.buildDir = data.buildDir;
        state.scriptContext = data.scriptContext;
        state.scenes = data.scenes || [];
        state.selectedSceneId = null;
        const ents = data.scriptContext?.entities || [];
        $('#build-badge').textContent = `${data.sceneCount} scenes`;
        $('#niche-badge').textContent = data.scriptContext?.nicheId
            ? `niche: ${data.scriptContext.nicheId}` : '';
        $('#entities-badge').textContent = ents.length ? `entities: ${ents.length}` : '';
        document.title = `Scout Lab — ${buildDir.split(/[/\\]/).pop()}`;
        renderSidebar();
        renderSceneCard();
        renderLogPane();
        appendEvent({
            stage: 'setup',
            message: `Loaded ${data.sceneCount} scenes — niche=${data.scriptContext?.nicheId || '?'} entities=${ents.length}`,
            data: {
                videoTitle: data.scriptContext?.videoTitle,
                summary: data.scriptContext?.summary,
                entities: ents,
                entityTypes: data.scriptContext?.entityTypes,
            },
        }, null);
    } catch (err) {
        appendEvent({ stage: 'log', message: `[err] ${err.message}` });
    }
}

async function runTest(sceneId) {
    if (state.running) return;
    state.running = true;
    state.activeRunSceneId = sceneId;
    renderSceneCard();
    clearLog(sceneId);
    appendEvent({ stage: 'setup', message: `Running scout pipeline for S${sceneId} ...` }, sceneId);

    const refreshScout = state.refreshScoutNext === true;
    state.refreshScoutNext = false;
    try {
        const result = await window.electronAPI.scoutLabTestScene(state.buildDir, sceneId, { refreshScout });
        if (result && result.ok) {
            appendEvent({ stage: 'log', message: `--- done ---` }, sceneId);
        } else if (result && result.error) {
            appendEvent({ stage: 'log', message: `[err] ${result.error}` }, sceneId);
        }
    } catch (err) {
        appendEvent({ stage: 'log', message: `[err] ${err.message}` }, sceneId);
    } finally {
        state.running = false;
        state.activeRunSceneId = null;
        renderSceneCard();
    }
}

async function runBatch(sceneId) {
    if (state.running) return;
    const batchCount = _readBatchCount();
    const batchIds = _batchSceneIds(sceneId, batchCount);
    state.running = true;
    state.activeRunSceneId = sceneId;
    renderSceneCard();

    for (const id of batchIds) {
        state.logsByScene.set(_logKey(id), []);
    }
    renderRunSummary();
    renderLogPane();
    appendEvent({
        stage: 'batch',
        message: `Running batch test from S${sceneId}: ${batchIds.map(id => `S${id}`).join(', ')} | concurrency=${batchCount}`,
        data: { batchIds, sceneConcurrency: batchCount },
    }, sceneId);

    const refreshScout = state.refreshScoutNext === true;
    state.refreshScoutNext = false;
    try {
        const result = await window.electronAPI.scoutLabTestBatch(state.buildDir, sceneId, {
            refreshScout,
            count: batchCount,
            sceneConcurrency: batchCount,
        });
        if (result && result.ok) {
            appendEvent({
                stage: 'batch',
                message: `--- batch done: ${result.accepted || 0}/${result.total || batchIds.length} accepted ---`,
                data: result,
            }, sceneId);
        } else if (result && result.error) {
            appendEvent({ stage: 'log', message: `[err] ${result.error}` }, sceneId);
        }
    } catch (err) {
        appendEvent({ stage: 'log', message: `[err] ${err.message}` }, sceneId);
    } finally {
        state.running = false;
        state.activeRunSceneId = null;
        renderSceneCard();
        renderSidebar();
    }
}

// ---- bindings ----
$('#btn-load').addEventListener('click', loadBuildDialog);
$('#btn-clear-log').addEventListener('click', () => clearLog());
$('#filter').addEventListener('input', renderSidebar);
$('#btn-refresh-scout').addEventListener('click', () => {
    state.refreshScoutNext = true;
    appendEvent({ stage: 'setup', message: 'Refresh Scout armed — Topic Footage Scout will re-run on next Run Test (AI clustering + provider sweeps)' });
});
document.querySelectorAll('#log-bar .log-chip').forEach(chip => {
    chip.addEventListener('click', () => setLogFilter(chip.dataset.filter));
});

// Stream events from main process
if (window.electronAPI && window.electronAPI.onScoutLabEvent) {
    window.electronAPI.onScoutLabEvent((evt) => appendEvent(evt));
}

// ---- Draggable panel splitters (sidebar / scene-card / run-summary) ----
(function initSplitters() {
    const LS_KEY = 'scout-lab.layout.v1';
    const stored = (() => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (_) { return {}; } })();
    const save = (patch) => {
        const cur = (() => { try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (_) { return {}; } })();
        localStorage.setItem(LS_KEY, JSON.stringify({ ...cur, ...patch }));
    };

    const sidebar = $('.sidebar');
    const sceneCard = $('#scene-card');
    const runSummary = $('#run-summary');

    if (sidebar && stored.sidebarW)    sidebar.style.width = stored.sidebarW + 'px';
    if (sceneCard && stored.sceneH)    sceneCard.style.height = stored.sceneH + 'px';
    if (runSummary && stored.summaryH) runSummary.style.height = stored.summaryH + 'px';

    function bindV(splitter, target, key, min = 220, max = 700) {
        if (!splitter || !target) return;
        let dragging = false, startX = 0, startW = 0;
        splitter.addEventListener('mousedown', (e) => {
            dragging = true;
            startX = e.clientX;
            startW = target.getBoundingClientRect().width;
            splitter.classList.add('dragging');
            document.body.classList.add('is-resizing');
            document.body.style.cursor = 'col-resize';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const w = Math.max(min, Math.min(max, startW + (e.clientX - startX)));
            target.style.width = w + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            splitter.classList.remove('dragging');
            document.body.classList.remove('is-resizing');
            document.body.style.cursor = '';
            save({ [key]: parseInt(target.style.width, 10) || undefined });
        });
    }

    function bindH(splitter, target, key, min = 60, max = 0.8) {
        if (!splitter || !target) return;
        let dragging = false, startY = 0, startH = 0;
        splitter.addEventListener('mousedown', (e) => {
            dragging = true;
            startY = e.clientY;
            startH = target.getBoundingClientRect().height;
            splitter.classList.add('dragging');
            document.body.classList.add('is-resizing');
            document.body.style.cursor = 'row-resize';
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const ceiling = window.innerHeight * max;
            const h = Math.max(min, Math.min(ceiling, startH + (e.clientY - startY)));
            target.style.height = h + 'px';
        });
        document.addEventListener('mouseup', () => {
            if (!dragging) return;
            dragging = false;
            splitter.classList.remove('dragging');
            document.body.classList.remove('is-resizing');
            document.body.style.cursor = '';
            save({ [key]: parseInt(target.style.height, 10) || undefined });
        });
    }

    bindV($('#splitter-sidebar'), sidebar,    'sidebarW', 220, 700);
    bindH($('#splitter-scene'),   sceneCard,  'sceneH',   60,  0.75);
    bindH($('#splitter-summary'), runSummary, 'summaryH', 0,   0.85);

    // Double-click a splitter to reset its panel to default.
    const reset = (el, prop, val, key) => {
        if (!el) return;
        el.style[prop] = val;
        save({ [key]: undefined });
    };
    $('#splitter-sidebar')?.addEventListener('dblclick', () => reset(sidebar,    'width',  '340px', 'sidebarW'));
    $('#splitter-scene')  ?.addEventListener('dblclick', () => reset(sceneCard,  'height', '240px', 'sceneH'));
    $('#splitter-summary')?.addEventListener('dblclick', () => reset(runSummary, 'height', '300px', 'summaryH'));
})();
