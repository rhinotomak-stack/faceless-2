// Scout Lab — isolated per-scene test harness.
//
// Loads a build's saved .build-checkpoint.json (scenes + scriptContext from a
// previous Director/VP run) and runs the *real* media-downloading pipeline for
// ONE selected scene: AI clustering -> Topic Footage Scout -> provider search
// -> scoring -> downloadMedia. Every step streams events back to the UI so the
// user can see exactly what would happen during a real build.
//
// Used by main.js IPC handlers `scout-lab-load-build` and `scout-lab-test-scene`.

const fs = require('fs');
const path = require('path');
const { buildTopicFootageBank } = require('./topic-footage-scout');
const footageManager = require('./footage-manager');
const { TEMPLATE_REGISTRY } = require('../agents/ai-templates');

// Per-buildDir scout cache. The Topic Footage Scout normally runs ONCE per
// build (Step 4.9) and the resulting bank is reused by every scene at Step 5.
// We mirror that: first testScene() in a lab session runs the scout; later
// testScene() calls on the same build reuse the cached scenes+bank, so the
// user can iterate scene-by-scene without paying the DeepSeek cluster cost +
// provider sweeps again. `loadBuild` resets this for a fresh build.
const _scoutCache = new Map(); // buildDir -> { scenes, scriptContext, bank, builtAt }

function _safeJson(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function _normalizeScene(scene) {
    // Older runs save protectedTerms; the new Scout reads scene.protect.
    if (!Array.isArray(scene.protect) && Array.isArray(scene.protectedTerms)) {
        scene.protect = scene.protectedTerms.slice();
    }
    return scene;
}

function _logArgsToLine(args) {
    return args.map((a) => (typeof a === 'string' ? a : (() => {
        try { return JSON.stringify(a); } catch (_) { return String(a); }
    })())).join(' ');
}

function _sceneIdFromBatchLog(line, sceneIds, fallbackSceneId) {
    const allowed = new Set((sceneIds || []).map(Number).filter(Number.isFinite));
    const text = String(line || '');
    const patterns = [
        /\bScene\s+S?(\d+)(?=\b|\/)/i,
        /\[Scene\s+S?(\d+)\]/i,
        /\bscene-S?(\d+)-\d{4}/i,
        /(?:^|[\\/\s_-])scene-(\d+)(?=[.\-_/\\])/i,
        /\bS(\d+)\b/i,
    ];
    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match) continue;
        const id = Number(match[1]);
        if (Number.isFinite(id) && (!allowed.size || allowed.has(id))) return id;
    }
    return fallbackSceneId;
}

function _isUsableVisualValue(value) {
    if (value == null) return false;
    const text = String(value).trim();
    return !!text && !['none', 'null', 'undefined', 'n/a'].includes(text.toLowerCase());
}

const TEMPLATE_BG_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'into', 'over', 'under', 'that', 'this',
    'these', 'those', 'their', 'there', 'where', 'when', 'what', 'which', 'while',
    'around', 'nearly', 'still', 'just', 'template', 'hint', 'scene',
    'dark', 'darkened', 'ominous', 'moody', 'atmospheric', 'eerie', 'sinister',
    'gloomy', 'somber', 'foreboding', 'tense', 'bleak', 'grim', 'dramatic',
    'cinematic', 'epic', 'minimalist', 'abstract', 'stylized', 'artistic',
    'background', 'backdrop', 'atmosphere', 'ambience', 'mood', 'tone',
    'elements', 'aesthetic', 'vibe', 'feel', 'setting', 'imagery', 'composition',
]);

function _compactTemplateBgKeyword(value, maxWords = 8) {
    const seen = new Set();
    return String(value || '')
        .replace(/^[^:]+:/, ' ')
        .replace(/[_|;]/g, ' ')
        .replace(/[^a-zA-Z0-9\s-]/g, ' ')
        .split(/\s+/)
        .map(w => w.trim())
        .filter(Boolean)
        .filter(w => {
            const key = w.toLowerCase();
            if (TEMPLATE_BG_STOPWORDS.has(key)) return false;
            if (key.length < 3 && !/^\d+$/.test(key) && !['el', 'al', 'uk', 'us'].includes(key)) return false;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, maxWords)
        .join(' ');
}

function _templateType(templateHint) {
    return String(templateHint || '').split(':')[0].trim();
}

function _templateBackgroundMediaType(scene) {
    const type = _templateType(scene?.templateHint);
    const registry = type ? TEMPLATE_REGISTRY[type] : null;
    if (registry?.backgroundMedia === 'image') return 'image';
    if (registry?.needsItemImages && !registry?.needsBackground) return 'image';
    return 'video';
}

function _templateBackgroundSource(scene, scriptContext = {}) {
    const mediaType = _templateBackgroundMediaType(scene);
    if (mediaType === 'image') return 'web-image';
    if (_isUsableVisualValue(scene?.sourceHint)) return scene.sourceHint;
    try {
        const { getNiche } = require('../data/niches');
        const niche = getNiche(scriptContext.nicheId || scriptContext.niche || 'general');
        const priority = Array.isArray(niche?.footagePriority?.video) ? niche.footagePriority.video : [];
        const source = priority.find(src => src && src !== 'stock');
        if (source) return source;
    } catch (_) {}
    return 'youtube';
}

function _prepareTemplateBackgroundScene(scene, scriptContext = {}) {
    if (!scene || scene.fullscreenMG || !scene.templateHint) return null;
    if (scene._templateBackupFootage && _isUsableVisualValue(scene.keyword) && _isUsableVisualValue(scene.sourceHint)) {
        return null;
    }

    const query = scene.templateBgQuery
        || scene.bgQuery
        || scene._aiBgQuery
        || _compactTemplateBgKeyword(`${scene.templateHint} ${scene.text || scene.visualIntent || ''}`)
        || 'documentary background footage';
    const mediaType = _templateBackgroundMediaType(scene);
    const sourceHint = _templateBackgroundSource(scene, scriptContext);

    scene.templateBgQuery = query;
    scene.keyword = query;
    scene.searchKeyword = query;
    scene.stockQuery = scene.stockQuery || query;
    scene.webQuery = scene.webQuery || query;
    scene.sourceHint = sourceHint;
    scene.mediaType = mediaType;
    scene._templateBackupFootage = true;
    scene._templateMediaFootage = true;
    scene.mediaIntent = {
        lane: 'templateBackground',
        strength: 'soft',
        reason: 'scout lab required template background media test',
        mediaType,
        sourceHint,
        policy: {
            download: 'normal',
            mediaType,
            sourceHint,
            allowTypeFallback: true,
            allowProviderFallback: true,
            allowStockFallback: true,
            allowedMediaTypes: null,
            allowedSources: null,
        },
    };
    return { query, mediaType, sourceHint };
}

function _prepareTemplateBackgroundScenes(scenes = [], scriptContext = {}) {
    let prepared = 0;
    for (const scene of scenes) {
        if (_prepareTemplateBackgroundScene(scene, scriptContext)) prepared++;
    }
    return prepared;
}

function _needsTopicFootageScout(scene) {
    if (!scene || scene.fullscreenMG) return false;
    const policy = scene.mediaIntent?.policy || {};
    if (policy.download === 'skip' || policy.download === 'template') return false;
    const type = policy.mediaType || scene.mediaType || 'video';
    return type === 'video';
}

function _emptyScoutBank() {
    return {
        needs: [],
        candidates: [],
        byScene: {},
        _scoutCtx: { clusters: { buckets: [], anchorTypes: [] } },
    };
}

function _shortText(value, max = 120) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function _providerTimeline(events = []) {
    const timeline = [];
    for (const event of events) {
        if (!event || event.status === 'searching') continue;
        if (!['results', 'accepted', 'rejected', 'cached', 'resumed', 'failed'].includes(event.status)) continue;
        const label = event.status === 'results'
            ? 'searched'
            : event.status;
        timeline.push({
            step: timeline.length + 1,
            provider: event.provider || event.key || '?',
            status: label,
            query: _shortText(event.query || '', 90),
            reason: _shortText(event.reason || '', 140),
            resultCount: event.resultCount,
            attempt: event.attempt,
        });
    }
    return timeline.slice(-12);
}

function _statusRank(status) {
    const s = String(status || '').toLowerCase();
    if (s === 'accepted' || s === 'cached' || s === 'resumed') return 8;
    if (s === 'rejected' || s === 'failed') return 7;
    if (s === 'candidate') return 6;
    if (s === 'results' || s === 'searched') return 4;
    if (s === 'info') return 3;
    if (s === 'searching') return 2;
    if (s === 'discovered') return 1;
    return 0;
}

function _candidateSourceUrl(candidate = {}) {
    return String(candidate.pageUrl || candidate.url || candidate.streamUrl || '').trim();
}

function _providerTriedLinks(events = [], maxRows = 80) {
    const map = new Map();
    const order = [];

    const upsert = (row) => {
        const url = String(row.url || '').trim();
        const key = url
            ? `${row.provider || '?'}|${url}`
            : `${row.provider || '?'}|${row.query || ''}|no-url`;
        const existing = map.get(key);
        if (!existing) {
            map.set(key, row);
            order.push(key);
            return;
        }
        if (_statusRank(row.status) >= _statusRank(existing.status)) {
            map.set(key, {
                ...existing,
                ...row,
                title: row.title || existing.title,
                reason: row.reason || existing.reason,
                query: row.query || existing.query,
            });
        }
    };

    for (const event of events || []) {
        if (!event) continue;
        const provider = event.provider || event.key || '?';
        const base = {
            provider,
            key: event.key || '',
            mediaType: event.mediaType || '',
            query: _shortText(event.query || '', 120),
            status: event.status || 'info',
            reason: _shortText(event.reason || '', 180),
            resultCount: event.resultCount,
            attempt: event.attempt,
            score: Number.isFinite(Number(event.score)) ? Number(event.score) : undefined,
            postScore: Number.isFinite(Number(event.postScore)) ? Number(event.postScore) : undefined,
            deepScore: Number.isFinite(Number(event.deepScore)) ? Number(event.deepScore) : undefined,
            path: event.path || '',
            url: String(event.url || '').trim(),
        };

        const candidates = [];
        if (event.selected) candidates.push({ ...event.selected, _selected: true });
        if (Array.isArray(event.candidates)) candidates.push(...event.candidates);

        if (!candidates.length) {
            if (base.url) {
                upsert({
                    ...base,
                    title: _shortText(event.title || event.reason || base.url, 180),
                    url: base.url,
                });
                continue;
            }
            if (['searching', 'rejected', 'failed'].includes(String(event.status || '').toLowerCase())) {
                upsert({
                    ...base,
                    title: Number(event.resultCount) === 0 ? 'No candidate links returned' : 'No candidate links recorded',
                    url: '',
                });
            }
            continue;
        }

        candidates.forEach((candidate, idx) => {
            const url = _candidateSourceUrl(candidate);
            // Per-candidate reason (e.g. title-sanity verdict for THIS exact title)
            // beats the batch reason that gets repeated across every candidate.
            const candidateReason = _shortText(candidate.reason || '', 180);
            upsert({
                ...base,
                status: candidate._selected && !['accepted', 'rejected', 'failed', 'cached', 'resumed'].includes(String(base.status || '').toLowerCase())
                    ? 'candidate'
                    : base.status,
                title: _shortText(candidate.title || url || `candidate ${idx + 1}`, 180),
                url,
                streamUrl: candidate.streamUrl || '',
                duration: candidate.duration,
                width: candidate.width,
                height: candidate.height,
                source: candidate.source || '',
                topicQuery: candidate.topicQuery || '',
                rank: idx + 1,
                reason: candidateReason || base.reason,
            });
        });
    }

    return order.map(key => map.get(key)).slice(0, maxRows);
}

// Walks providers events and collects every unique candidate URL/title that
// came back from any provider search (the raw discovery + filter-stage
// batches). Groups by provider + query so the UI can render per-round tables.
function _collectVideosFound(events = [], maxRows = 200) {
    const groups = new Map(); // `${provider}|${query}` -> { provider, query, items: Map<url, row> }
    const groupOrder = [];

    const getGroup = (provider, query) => {
        const key = `${provider || '?'}|${query || ''}`;
        let group = groups.get(key);
        if (!group) {
            group = { provider: provider || '?', query: query || '', items: new Map(), order: [] };
            groups.set(key, group);
            groupOrder.push(key);
        }
        return group;
    };

    const upsertCandidate = (group, candidate, fallback) => {
        if (!candidate) return;
        const url = _candidateSourceUrl(candidate);
        const itemKey = url || `${candidate.title || ''}|${candidate.duration || ''}`;
        if (!itemKey) return;
        const existing = group.items.get(itemKey);
        const row = {
            title: _shortText(candidate.title || url || '(no title)', 200),
            url,
            duration: candidate.duration,
            width: candidate.width,
            height: candidate.height,
            source: candidate.source || '',
            // First-seen filter-stage status (rejected/info/results) gives the
            // user the earliest verdict that touched this video.
            stage: fallback.status || 'discovered',
            reason: _shortText(candidate.reason || fallback.reason || '', 200),
        };
        if (!existing) {
            group.items.set(itemKey, row);
            group.order.push(itemKey);
        } else if (!existing.url && row.url) {
            // Upgrade existing record if a later event finally exposes the URL.
            group.items.set(itemKey, { ...existing, url: row.url });
        }
    };

    for (const event of events || []) {
        if (!event) continue;
        const candidates = Array.isArray(event.candidates) ? event.candidates : [];
        if (candidates.length === 0) continue;
        const provider = event.provider || event.key || '?';
        const query = event.query || '';
        const group = getGroup(provider, query);
        const fallback = {
            status: event.status || 'discovered',
            reason: event.reason || '',
        };
        for (const candidate of candidates) upsertCandidate(group, candidate, fallback);
    }

    const out = [];
    for (const key of groupOrder) {
        const group = groups.get(key);
        if (!group) continue;
        const items = group.order.map(k => group.items.get(k));
        out.push({
            provider: group.provider,
            query: group.query,
            count: items.length,
            items: items.slice(0, maxRows),
        });
    }
    return out;
}

// Walks providers events and collects only URLs that were actually selected
// for download/vision (status === 'candidate' or per-URL 'accepted'/'rejected'
// with event.selected). Each row records the final verdict.
function _collectVideosTried(events = [], maxRows = 60) {
    const map = new Map();
    const order = [];

    const upsert = (url, row) => {
        if (!url) return;
        const key = `${row.provider || '?'}|${url}`;
        const existing = map.get(key);
        if (!existing) {
            map.set(key, row);
            order.push(key);
            return;
        }
        if (_statusRank(row.status) >= _statusRank(existing.status)) {
            map.set(key, {
                ...existing,
                ...row,
                title: row.title || existing.title,
                reason: row.reason || existing.reason,
                query: row.query || existing.query,
            });
        }
    };

    for (const event of events || []) {
        if (!event) continue;
        const status = String(event.status || '').toLowerCase();
        const isTried = status === 'candidate' || status === 'accepted'
            || ((status === 'rejected' || status === 'failed') && !!event.selected)
            || (status === 'cached' && !!event.selected)
            || (status === 'resumed' && !!event.selected);
        if (!isTried) continue;
        const selected = event.selected || (event.url ? {
            url: event.url,
            title: event.title || event.reason || event.url,
            duration: event.duration,
            width: event.width,
            height: event.height,
        } : null);
        const url = _candidateSourceUrl(selected) || String(event.url || '').trim();
        if (!url) continue;
        upsert(url, {
            provider: event.provider || event.key || '?',
            query: _shortText(event.query || '', 120),
            status,
            title: _shortText(selected.title || url, 200),
            url,
            duration: selected.duration,
            width: selected.width,
            height: selected.height,
            attempt: event.attempt,
            score: Number.isFinite(Number(event.score)) ? Number(event.score) : undefined,
            postScore: Number.isFinite(Number(event.postScore)) ? Number(event.postScore) : undefined,
            deepScore: Number.isFinite(Number(event.deepScore)) ? Number(event.deepScore) : undefined,
            path: event.path || '',
            reason: _shortText(selected.reason || event.reason || '', 220),
        });
    }

    return order.map(key => map.get(key)).slice(0, maxRows);
}

function _buildFriendlySummary(scene, info = {}) {
    const diag = scene.mediaDiagnostics || {};
    const planner = diag.planner || {};
    const intent = diag.intent || scene.mediaIntent || {};
    const policy = intent.policy || {};
    const hunter = diag.hunter || {};
    const mediaAgent = diag.mediaAgent || scene._mediaAgentPlan || null;
    const providers = Array.isArray(diag.providers) ? diag.providers : [];
    const final = diag.final || {};
    const acceptedEvents = providers.filter(e => e?.status === 'accepted' || e?.status === 'cached' || e?.status === 'resumed');
    const rejectedEvents = providers.filter(e => e?.status === 'rejected');
    const resultEvents = providers.filter(e => e?.status === 'results');
    const refereeEvents = providers.filter(e => /\bAI Referee\b/i.test(String(e?.reason || '')));
    const lastAccepted = acceptedEvents[acceptedEvents.length - 1] || null;
    const provider = scene.sourceProvider || final.provider || lastAccepted?.provider || null;
    const acceptedQuery = lastAccepted?.query || final.query || resultEvents[resultEvents.length - 1]?.query || planner.searchKeyword || planner.keyword || scene.keyword || '';
    const status = info.status || scene.mediaDownloadStatus || final.status || (scene.mediaFile ? 'accepted' : 'failed');
    const ok = !info.error && status !== 'failed' && !!scene.mediaFile;

    return {
        ok,
        verdict: ok ? 'accepted' : 'failed',
        status,
        durationSec: Number.isFinite(info.durationMs) ? Number((info.durationMs / 1000).toFixed(1)) : null,
        final: {
            provider,
            query: _shortText(acceptedQuery, 120),
            reason: _shortText(final.reason || lastAccepted?.reason || '', 160),
        },
        file: {
            path: info.outputPath || scene.mediaFile || null,
            exists: !!info.fileExists,
            sizeBytes: info.fileSize || null,
            sizeMB: info.fileSize ? Number((info.fileSize / 1024 / 1024).toFixed(2)) : null,
        },
        plan: {
            mediaType: planner.mediaType || scene.mediaType || '',
            sourceHint: planner.sourceHint || scene.sourceHint || '',
            sourceHintRole: 'soft context only',
            keyword: planner.keyword || scene.searchKeyword || scene.keyword || '',
            stockQuery: planner.stockQuery || scene.stockQuery || '',
            webQuery: planner.webQuery || scene.webQuery || '',
        },
        intent: {
            lane: intent.lane || '-',
            strength: intent.strength || '-',
            lockType: policy.mediaType || '-',
            allowTypeFallback: policy.allowTypeFallback !== false,
            source: policy.sourceHint || intent.sourceHint || '-',
            reason: intent.reason || '-',
        },
        hunter: {
            mode: hunter.mode || '-',
            domain: hunter.domain || '-',
            target: _shortText(hunter.target || '', 180),
        },
        mediaAgent: mediaAgent ? {
            ai: mediaAgent.ai === true,
            sourceAuthority: mediaAgent.sourceAuthority || 'media-agent',
            vpSourceHint: mediaAgent.vpSourceHint || mediaAgent.sourceHint || '',
            role: mediaAgent.role || '-',
            viewerNeed: _shortText(mediaAgent.viewerNeed || '', 260),
            providerOrder: Array.isArray(mediaAgent.providerOrder) ? mediaAgent.providerOrder.slice(0, 8) : [],
            providerLock: mediaAgent.providerLock || null,
            providerEvidence: Array.isArray(mediaAgent.providerEvidence) ? mediaAgent.providerEvidence.slice(0, 8) : [],
            providerReality: Array.isArray(mediaAgent.providerReality) ? mediaAgent.providerReality.slice(0, 8) : [],
            providerExclusions: Array.isArray(mediaAgent.providerExclusions) ? mediaAgent.providerExclusions.slice(0, 8) : [],
            literalRequiredObjects: Array.isArray(mediaAgent.literalRequiredObjects) ? mediaAgent.literalRequiredObjects.slice(0, 8) : [],
            mustShow: Array.isArray(mediaAgent.mustShow) ? mediaAgent.mustShow.slice(0, 8) : [],
            mustAvoid: Array.isArray(mediaAgent.mustAvoid) ? mediaAgent.mustAvoid.slice(0, 8) : [],
            acceptanceTest: _shortText(mediaAgent.acceptanceTest || '', 260),
        } : null,
        counts: {
            searches: resultEvents.length,
            rejected: rejectedEvents.length,
            accepted: acceptedEvents.length,
        },
        referee: refereeEvents.length ? {
            count: refereeEvents.length,
            last: _shortText(refereeEvents[refereeEvents.length - 1].reason || '', 240),
        } : null,
        timeline: _providerTimeline(providers),
        triedLinks: _providerTriedLinks(providers),
        videosFound: _collectVideosFound(providers),
        videosTried: _collectVideosTried(providers),
        rejected: rejectedEvents.slice(-6).map(e => ({
            provider: e.provider || e.key || '?',
            query: _shortText(e.query || '', 90),
            reason: _shortText(e.reason || '', 140),
            attempt: e.attempt,
        })),
        error: info.error || null,
    };
}

function _scenePreview(scene) {
    return {
        index: scene.index,
        originalIndex: scene.originalIndex,
        text: (scene.text || '').slice(0, 300),
        searchKeyword: scene.searchKeyword || scene.keyword || '',
        keyword: scene.keyword,
        webQuery: scene.webQuery,
        stockQuery: scene.stockQuery,
        visualIntent: scene.visualIntent,
        templateHint: scene.templateHint,
        templateBgQuery: scene.templateBgQuery,
        templateBackground: !!scene._templateBackupFootage,
        sourceHint: scene.sourceHint,
        mediaType: scene.mediaType,
        fullscreenMG: !!scene.fullscreenMG,
        protect: scene.protect || scene.protectedTerms || [],
        lane: scene?.mediaIntent?.lane || scene.lane,
        startTime: scene.startTime,
        endTime: scene.endTime,
        duration: scene.duration,
        sceneClass: scene.sceneClass,
        treatmentHint: scene.treatmentHint,
    };
}

function _sceneSidebarRow(scene) {
    return {
        index: scene.index,
        originalIndex: scene.originalIndex,
        text: (scene.text || '').slice(0, 140),
        searchKeyword: scene.searchKeyword || scene.keyword || '',
        sourceHint: scene.sourceHint || '',
        mediaType: scene.mediaType || 'video',
        fullscreenMG: !!scene.fullscreenMG,
        visualIntent: (scene.visualIntent || '').slice(0, 140),
        templateHint: scene.templateHint || '',
        templateBgQuery: scene.templateBgQuery || '',
        templateBackground: !!scene._templateBackupFootage,
        startTime: scene.startTime,
        endTime: scene.endTime,
    };
}

function _loadCheckpoint(buildDir) {
    const ckptPath = path.join(buildDir, '.build-checkpoint.json');
    if (!fs.existsSync(ckptPath)) {
        throw new Error(`.build-checkpoint.json not found in ${buildDir}`);
    }
    const ckpt = _safeJson(ckptPath);
    const scenes = (ckpt.scenes || []).map(_normalizeScene);
    const scriptContext = ckpt.scriptContext || {};
    // Topic-footage-scout looks for scriptContext.topic / .title — older builds
    // store the title under videoTitle.
    if (!scriptContext.topic && scriptContext.videoTitle) {
        scriptContext.topic = scriptContext.videoTitle;
    }
    _prepareTemplateBackgroundScenes(scenes, scriptContext);
    return { ckpt, scenes, scriptContext };
}

async function loadBuild(buildDir) {
    // Reloading a build invalidates any cached scout bank for that path.
    _scoutCache.delete(buildDir);
    const { ckpt, scenes, scriptContext } = _loadCheckpoint(buildDir);
    return {
        buildDir,
        savedAt: ckpt._savedAt,
        audioFile: ckpt.audioFile,
        sceneCount: scenes.length,
        scriptContext: {
            nicheId: scriptContext.nicheId || '',
            themeId: scriptContext.themeId || '',
            videoTitle: scriptContext.videoTitle || '',
            summary: (scriptContext.summary || '').slice(0, 600),
            entities: scriptContext.entities || [],
            entityTypes: scriptContext.entityTypes || {},
            format: scriptContext.format || '',
            ctaDetected: !!scriptContext.ctaDetected,
        },
        scenes: scenes.map(_sceneSidebarRow),
    };
}

function _sceneDisplayId(scene) {
    return Number(scene?.originalIndex ?? scene?.index);
}

function _sceneFilenameBase(scene, fallbackId = 0) {
    const idx = Number(scene?.index);
    const si = Number.isFinite(idx) ? idx : Number(fallbackId);
    return `scene-${Number.isFinite(si) ? si : 0}`;
}

function _findSceneById(scenes, sceneId) {
    const targetId = Number(sceneId);
    return scenes.find((s) => Number(s.originalIndex ?? s.index) === targetId)
        || scenes.find((s) => Number(s.index) === targetId);
}

function _clampInt(value, min, max, fallback) {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
}

function _defaultBatchCount() {
    return _clampInt(
        process.env.MEDIA_SCENE_CONCURRENCY
            || process.env.SCENE_DOWNLOAD_CONCURRENCY
            || process.env.DOWNLOAD_CONCURRENCY
            || '4',
        2,
        8,
        4,
    );
}

function _batchScenesFrom(scenes, sceneId, count) {
    const sorted = scenes
        .slice()
        .sort((a, b) => {
            const ai = Number(a.originalIndex ?? a.index);
            const bi = Number(b.originalIndex ?? b.index);
            return (Number.isFinite(ai) ? ai : 0) - (Number.isFinite(bi) ? bi : 0);
        });
    const targetId = Number(sceneId);
    const start = sorted.findIndex((s) => Number(s.originalIndex ?? s.index) === targetId || Number(s.index) === targetId);
    if (start < 0) return [];
    return sorted.slice(start, start + count);
}

async function testScene(buildDir, sceneId, emit, options = {}) {
    let emitSceneId = null;
    const safeEmit = (evt) => {
        const payload = emitSceneId != null && evt && evt.sceneId == null
            ? { ...evt, sceneId: emitSceneId }
            : evt;
        try { emit(payload); } catch (_) {}
    };

    // Reuse cached scenes + bank if this build has already been scouted.
    // Pass options.refreshScout=true to force a re-run (UI button can wire it up).
    let cache = _scoutCache.get(buildDir);
    if (options.refreshScout) {
        _scoutCache.delete(buildDir);
        cache = null;
    }
    let scenes, scriptContext;
    if (cache) {
        scenes = cache.scenes;
        scriptContext = cache.scriptContext;
        const ageMin = Math.floor((Date.now() - cache.builtAt) / 60000);
        safeEmit({ stage: 'setup', message: `Reusing cached scout bank (built ${ageMin}m ago, ${scenes.length} scenes) — Topic Scout will NOT re-run` });
    } else {
        safeEmit({ stage: 'setup', message: `Loading ${buildDir}` });
        const loaded = _loadCheckpoint(buildDir);
        scenes = loaded.scenes;
        scriptContext = loaded.scriptContext;
    }

    const targetId = Number(sceneId);
    const scene = scenes.find((s) => Number(s.originalIndex ?? s.index) === targetId)
        || scenes.find((s) => Number(s.index) === targetId);
    if (!scene) throw new Error(`Scene ${sceneId} not found in checkpoint (${scenes.length} scenes)`);
    const sceneIndexId = Number(scene.originalIndex ?? scene.index);
    emitSceneId = sceneIndexId;

    safeEmit({
        stage: 'setup',
        message: `Loaded ${scenes.length} scenes — niche=${scriptContext.nicheId || '?'} theme=${scriptContext.themeId || '?'} entities=${(scriptContext.entities || []).length}`,
        data: {
            nicheId: scriptContext.nicheId,
            themeId: scriptContext.themeId,
            videoTitle: scriptContext.videoTitle,
            entities: scriptContext.entities || [],
            entityTypes: scriptContext.entityTypes || {},
        },
    });

    safeEmit({ stage: 'scene', message: `Selected scene S${targetId}`, data: _scenePreview(scene) });

    // Bridge all console.log output during the run so the UI sees the SAME
    // chatter a real build prints — Topic Footage Scout, providers, scoring,
    // download, vision audit, etc.
    const origLog = console.log;
    const origErr = console.error;
    const consoleBridge = (...args) => {
        const line = args.map((a) => (typeof a === 'string' ? a : (() => {
            try { return JSON.stringify(a); } catch (_) { return String(a); }
        })())).join(' ');
        safeEmit({ stage: 'log', message: line });
        origLog(...args);
    };
    console.log = consoleBridge;
    console.error = (...args) => {
        const line = args.map((a) => (typeof a === 'string' ? a : (() => {
            try { return JSON.stringify(a); } catch (_) { return String(a); }
        })())).join(' ');
        safeEmit({ stage: 'log', message: `[err] ${line}` });
        origErr(...args);
    };

    // Route footage-manager's per-scene buffered logs into our UI bridge.
    // downloadAllMedia hijacks console.log for AsyncLocalStorage scene buffering
    // and flushes via _originalConsoleLog — by default that bypasses our bridge.
    // setLogSink redirects those flushes to the UI.
    footageManager.setLogSink((...args) => {
        const line = args.map((a) => (typeof a === 'string' ? a : (() => {
            try { return JSON.stringify(a); } catch (_) { return String(a); }
        })())).join(' ');
        safeEmit({ stage: 'log', message: line });
        origLog(...args);
    });

    try {
        footageManager.initProviders(scriptContext);

        // Step 1: Topic Footage Scout — runs ONCE per buildDir, mirroring
        // real-build Step 4.9. Subsequent testScene calls reuse the same
        // scene objects (with _topicFootageCandidates/_scoutProviderOrder/
        // _scoutProviderScoreboard already stamped on them) and skip this.
        let bank;
        if (cache) {
            bank = cache.bank;
            safeEmit({
                stage: 'cluster',
                message: `Reusing cached scout bank — ${bank.needs?.length || 0} need(s), ${bank.candidates?.length || 0} candidate(s) (no AI/network)`,
                data: {
                    clusters: bank._scoutCtx?.clusters || { buckets: [], anchorTypes: [] },
                    candidateCount: bank.candidates?.length || 0,
                    cached: true,
                },
            });
        } else if (!_needsTopicFootageScout(scene)) {
            bank = _emptyScoutBank();
            safeEmit({
                stage: 'cluster',
                message: `Topic Footage Scout skipped for S${sceneIndexId} (${scene.mediaType || 'image'}/${scene.sourceHint || 'none'}): selected scene is not a video-footage scene`,
                data: {
                    clusters: bank._scoutCtx.clusters,
                    needs: [],
                    candidateCount: 0,
                    skipped: true,
                    reason: 'non-video selected scene',
                },
            });
        } else {
            safeEmit({ stage: 'cluster', message: 'Running Topic Footage Scout (AI clustering + provider search) ...' });
            const t0 = Date.now();
            bank = await buildTopicFootageBank(scenes, scriptContext);
            const dt = Date.now() - t0;
            _scoutCache.set(buildDir, { scenes, scriptContext, bank, builtAt: Date.now() });
            safeEmit({
                stage: 'cluster',
                message: `Scout done in ${(dt / 1000).toFixed(1)}s — ${bank.needs?.length || 0} need(s), ${bank.candidates?.length || 0} candidate(s) (cached for next scene)`,
                data: {
                    clusters: bank._scoutCtx?.clusters || { buckets: [], anchorTypes: [] },
                    needs: (bank.needs || []).map((n) => ({
                        id: n.id,
                        scenes: n.sceneIds,
                        anchor: n.anchor,
                        anchorType: n.anchorType,
                        bucket: n.bucket,
                        bucketTerms: n.bucketTerms,
                        query: n.query,
                        queries: n.queries,
                        providers: n.providerKeys,
                    })),
                    candidateCount: bank.candidates?.length || 0,
                },
            });
        }

        // Step 2: What did the scout assign to THIS scene?
        const sceneBank = (bank.byScene && bank.byScene[sceneIndexId]) || [];
        const scoutOrder = scene._scoutProviderOrder || [];
        const scoutBoard = scene._scoutProviderScoreboard || [];
        const scoutCandidates = scene._topicFootageCandidates || [];
        safeEmit({
            stage: 'scout',
            message: `Scout for S${sceneIndexId}: ${sceneBank.length} bank assignment(s), preferred providers=${scoutOrder.join(' > ') || '(none)'}`,
            data: {
                sceneBank,
                scoutOrder,
                scoutBoard,
                topCandidates: scoutCandidates.slice(0, 8).map((c) => ({
                    provider: c._topicScout?.providerName || c._topicScout?.providerKey,
                    title: (c.title || c.url || '').slice(0, 140),
                    url: c.url,
                    score: c._topicScout?.sceneScore || c._topicScout?.score,
                    needId: c._topicScout?.needId,
                    anchor: c._topicScout?.anchor,
                    bucket: c._topicScout?.bucket,
                })),
            },
        });

        // Step 3: Run the FULL per-scene download chain — same code path as a
        // real build (validateKeyword + trimSearchKeyword + intentPolicy gates +
        // Hunter fallback variants + controlled stock fallback + final retry +
        // vision audit + scoring). We call downloadAllMedia with a single-scene
        // array so we get 100% behavioural parity with the build pipeline.
        const sceneIdx = Number(scene.index);
        const sceneSi = Number.isFinite(sceneIdx) ? sceneIdx : sceneIndexId;
        const keyword = scene.searchKeyword || scene.keyword || '';
        const mediaType = scene.mediaType || 'video';
        const sourceHint = scene.sourceHint || '';

        if (scene.fullscreenMG) {
            safeEmit({ stage: 'download-skip', message: 'Scene is fullscreenMG (graphics only) — nothing to download', data: { fullscreenMG: scene.fullscreenMG } });
            return { ok: true, skipped: true };
        }

        // Resume-detection in downloadAllMedia uses temp filename `scene-${si}`.
        // For a testing lab we want a fresh run every time, so clean any prior
        // temp file before kicking off the chain.
        try {
            const filenameBase = `scene-${sceneSi}`;
            const removedStable = footageManager.cleanupSceneTempMedia(filenameBase);
            const removedRace = footageManager.cleanupSceneRaceTempMedia(filenameBase);
            const removed = removedStable + removedRace;
            if (removed > 0) {
                safeEmit({
                    stage: 'cleanup',
                    message: `Cleaned ${removed} stale temp file(s) for S${sceneIndexId} before retry`,
                    data: { filenameBase, removedStable, removedRace },
                });
            }
        } catch (_) {}

        safeEmit({
            stage: 'download',
            message: `Running full download chain for S${sceneIndexId} — keyword="${keyword}", mediaType=${mediaType}, legacy source hint=${sourceHint || 'auto'} (soft)`,
            data: { keyword, mediaType, sourceHint, nicheId: scriptContext.nicheId || '', filenameBase: `scene-${sceneSi}` },
        });

        const dlStart = Date.now();
        let downloadError = null;
        try {
            await footageManager.downloadAllMedia([scene], scriptContext, {
                label: `scout-lab S${sceneIndexId}`,
                preserveCache: true,
            });
        } catch (err) {
            downloadError = err && err.message ? err.message : String(err);
        }
        const dlDt = Date.now() - dlStart;

        const resolvedPath = scene.mediaFile || null;
        const resolvedExists = !!(resolvedPath && fs.existsSync(resolvedPath));
        let resolvedSize = null;
        if (resolvedExists) {
            try { resolvedSize = fs.statSync(resolvedPath).size; } catch (_) {}
        }

        const status = scene.mediaDownloadStatus || (downloadError ? 'errored' : (resolvedPath ? 'completed' : 'failed'));
        const existsTag = resolvedPath ? ` | FILE EXISTS: ${resolvedExists ? 'yes' : 'no'}` : '';
        let summary;
        try {
            summary = _buildFriendlySummary(scene, {
                status,
                error: downloadError,
                outputPath: resolvedPath,
                fileExists: resolvedExists,
                fileSize: resolvedSize,
                durationMs: dlDt,
            });
        } catch (summaryErr) {
            const diag = scene.mediaDiagnostics || {};
            const final = diag.final || {};
            summary = {
                ok: !downloadError && status !== 'failed' && !!resolvedPath,
                verdict: !downloadError && status !== 'failed' && !!resolvedPath ? 'accepted' : 'failed',
                status,
                durationSec: Number((dlDt / 1000).toFixed(1)),
                final: {
                    provider: scene.sourceProvider || final.provider || null,
                    query: final.query || scene.searchKeyword || scene.keyword || '',
                    reason: `summary build failed: ${String(summaryErr?.message || summaryErr).slice(0, 140)}`,
                },
                file: {
                    path: resolvedPath,
                    exists: resolvedExists,
                    sizeBytes: resolvedSize,
                    sizeMB: resolvedSize ? Number((resolvedSize / 1024 / 1024).toFixed(2)) : null,
                },
                counts: { searches: 0, rejected: 0, accepted: resolvedPath ? 1 : 0 },
                triedLinks: [],
                videosFound: [],
                videosTried: [],
                error: downloadError || String(summaryErr?.message || summaryErr),
            };
        }
        safeEmit({
            stage: 'summary',
            message: summary.ok
                ? `Accepted via ${summary.final.provider || '?'} (${summary.counts.rejected} rejected before final)`
                : `No usable media accepted${downloadError ? `: ${downloadError}` : ''}`,
            data: summary,
        });
        safeEmit({
            stage: 'download-done',
            message: downloadError
                ? `Download FAILED after ${(dlDt / 1000).toFixed(1)}s: ${downloadError}`
                : (resolvedPath
                    ? `Download ${status} in ${(dlDt / 1000).toFixed(1)}s — ${resolvedPath}${resolvedSize ? ` (${(resolvedSize / 1024 / 1024).toFixed(2)} MB)` : ''}${existsTag} via ${scene.sourceProvider || '?'}`
                    : `Download ${status} after ${(dlDt / 1000).toFixed(1)}s — no media produced`),
            data: {
                error: downloadError,
                status,
                outputPath: resolvedPath,
                fileExists: resolvedExists,
                fileSize: resolvedSize,
                durationMs: dlDt,
                sourceProvider: scene.sourceProvider || null,
                mediaType: scene.mediaType,
                mediaWidth: scene.mediaWidth,
                mediaHeight: scene.mediaHeight,
                mediaDiagnostics: scene.mediaDiagnostics || null,
            },
        });

        return {
            ok: !downloadError && status !== 'failed',
            status,
            outputPath: resolvedPath,
            sourceProvider: scene.sourceProvider || null,
        };
    } finally {
        console.log = origLog;
        console.error = origErr;
        try { footageManager.setLogSink(null); } catch (_) {}
    }
}

async function testSceneBatch(buildDir, sceneId, emit, options = {}) {
    const startId = Number(sceneId);
    const count = _clampInt(options.count || options.batchSize || _defaultBatchCount(), 2, 8, _defaultBatchCount());
    const sceneConcurrency = _clampInt(options.sceneConcurrency || count, 1, 8, count);
    const safeEmit = (evt) => {
        try { emit(evt); } catch (_) {}
    };

    let cache = _scoutCache.get(buildDir);
    if (options.refreshScout) {
        _scoutCache.delete(buildDir);
        cache = null;
    }

    let scenes, scriptContext;
    if (cache) {
        scenes = cache.scenes;
        scriptContext = cache.scriptContext;
        const ageMin = Math.floor((Date.now() - cache.builtAt) / 60000);
        safeEmit({
            stage: 'setup',
            sceneId: startId,
            message: `Reusing cached scout bank (built ${ageMin}m ago, ${scenes.length} scenes) - Topic Scout will NOT re-run`,
        });
    } else {
        safeEmit({ stage: 'setup', sceneId: startId, message: `Loading ${buildDir}` });
        const loaded = _loadCheckpoint(buildDir);
        scenes = loaded.scenes;
        scriptContext = loaded.scriptContext;
    }

    const firstScene = _findSceneById(scenes, sceneId);
    if (!firstScene) throw new Error(`Scene ${sceneId} not found in checkpoint (${scenes.length} scenes)`);

    const batchScenes = _batchScenesFrom(scenes, sceneId, count);
    if (!batchScenes.length) throw new Error(`Could not build a scene batch starting at S${sceneId}`);
    const sceneIds = batchScenes.map(_sceneDisplayId).filter(Number.isFinite);

    safeEmit({
        stage: 'batch',
        sceneId: startId,
        message: `Running batch concurrency test: ${sceneIds.map(id => `S${id}`).join(', ')} | scene concurrency=${sceneConcurrency}`,
        data: {
            sceneIds,
            requestedCount: count,
            sceneConcurrency,
            note: 'Uses the real multi-scene downloadAllMedia path with buffering enabled.',
        },
    });

    for (const scene of batchScenes) {
        const id = _sceneDisplayId(scene);
        safeEmit({ stage: 'scene', sceneId: id, message: `Batch includes S${id}`, data: _scenePreview(scene) });
    }

    const origLog = console.log;
    const origErr = console.error;
    const consoleBridge = (...args) => {
        const line = _logArgsToLine(args);
        const routedSceneId = _sceneIdFromBatchLog(line, sceneIds, startId);
        safeEmit({ stage: 'log', sceneId: routedSceneId, message: line });
        origLog(...args);
    };
    console.log = consoleBridge;
    console.error = (...args) => {
        const line = _logArgsToLine(args);
        const routedSceneId = _sceneIdFromBatchLog(line, sceneIds, startId);
        safeEmit({ stage: 'log', sceneId: routedSceneId, message: `[err] ${line}` });
        origErr(...args);
    };

    footageManager.setLogSink((...args) => {
        const line = _logArgsToLine(args);
        const routedSceneId = _sceneIdFromBatchLog(line, sceneIds, startId);
        safeEmit({ stage: 'log', sceneId: routedSceneId, message: line });
        origLog(...args);
    });

    const summaries = [];
    try {
        footageManager.initProviders(scriptContext);

        let bank;
        if (cache) {
            bank = cache.bank;
            safeEmit({
                stage: 'cluster',
                sceneId: startId,
                message: `Reusing cached scout bank - ${bank.needs?.length || 0} need(s), ${bank.candidates?.length || 0} candidate(s)`,
                data: {
                    clusters: bank._scoutCtx?.clusters || { buckets: [], anchorTypes: [] },
                    candidateCount: bank.candidates?.length || 0,
                    cached: true,
                },
            });
        } else if (!batchScenes.some(_needsTopicFootageScout)) {
            bank = _emptyScoutBank();
            safeEmit({
                stage: 'cluster',
                sceneId: startId,
                message: 'Topic Footage Scout skipped for this batch: no video-footage scenes selected',
                data: { skipped: true, reason: 'non-video batch' },
            });
        } else {
            safeEmit({ stage: 'cluster', sceneId: startId, message: 'Running Topic Footage Scout for batch (AI clustering + provider search) ...' });
            const t0 = Date.now();
            bank = await buildTopicFootageBank(scenes, scriptContext);
            const dt = Date.now() - t0;
            _scoutCache.set(buildDir, { scenes, scriptContext, bank, builtAt: Date.now() });
            safeEmit({
                stage: 'cluster',
                sceneId: startId,
                message: `Scout done in ${(dt / 1000).toFixed(1)}s - ${bank.needs?.length || 0} need(s), ${bank.candidates?.length || 0} candidate(s)`,
                data: {
                    clusters: bank._scoutCtx?.clusters || { buckets: [], anchorTypes: [] },
                    candidateCount: bank.candidates?.length || 0,
                },
            });
        }

        for (const scene of batchScenes) {
            const id = _sceneDisplayId(scene);
            const sceneBank = (bank.byScene && bank.byScene[id]) || [];
            const scoutOrder = scene._scoutProviderOrder || [];
            const scoutBoard = scene._scoutProviderScoreboard || [];
            const scoutCandidates = scene._topicFootageCandidates || [];
            safeEmit({
                stage: 'scout',
                sceneId: id,
                message: `Scout for S${id}: ${sceneBank.length} bank assignment(s), preferred providers=${scoutOrder.join(' > ') || '(none)'}`,
                data: {
                    sceneBank,
                    scoutOrder,
                    scoutBoard,
                    topCandidates: scoutCandidates.slice(0, 8).map((c) => ({
                        provider: c._topicScout?.providerName || c._topicScout?.providerKey,
                        title: (c.title || c.url || '').slice(0, 140),
                        url: c.url,
                        score: c._topicScout?.sceneScore || c._topicScout?.score,
                        needId: c._topicScout?.needId,
                        anchor: c._topicScout?.anchor,
                        bucket: c._topicScout?.bucket,
                    })),
                },
            });
        }

        for (const scene of batchScenes) {
            const id = _sceneDisplayId(scene);
            try {
                const filenameBase = _sceneFilenameBase(scene, id);
                const removedStable = footageManager.cleanupSceneTempMedia(filenameBase);
                const removedRace = footageManager.cleanupSceneRaceTempMedia(filenameBase);
                const removed = removedStable + removedRace;
                if (removed > 0) {
                    safeEmit({
                        stage: 'cleanup',
                        sceneId: id,
                        message: `Cleaned ${removed} stale temp file(s) for S${id} before batch retry`,
                        data: { filenameBase, removedStable, removedRace },
                    });
                }
            } catch (_) {}
        }

        const batchLabel = `scout-lab batch S${sceneIds[0]}-${sceneIds[sceneIds.length - 1]}`;
        const batchSceneTimeoutMs = Math.max(
            8 * 60 * 1000,
            parseInt(options.sceneTimeoutMs || process.env.SCOUT_LAB_BATCH_SCENE_TIMEOUT_MS || '0', 10) || 0
        );

        safeEmit({
            stage: 'download',
            sceneId: startId,
            message: `Running real multi-scene downloader for ${batchScenes.length} scene(s) with sceneConcurrency=${sceneConcurrency}, scene timeout=${Math.round(batchSceneTimeoutMs / 1000)}s`,
            data: {
                sceneIds,
                sceneConcurrency,
                sceneTimeoutMs: batchSceneTimeoutMs,
                label: batchLabel,
            },
        });

        const dlStart = Date.now();
        let downloadError = null;
        try {
            await footageManager.downloadAllMedia(batchScenes, scriptContext, {
                label: batchLabel,
                preserveCache: true,
                sceneConcurrency,
                sceneTimeoutMs: batchSceneTimeoutMs,
            });
        } catch (err) {
            downloadError = err && err.message ? err.message : String(err);
        }
        const totalMs = Date.now() - dlStart;

        for (const scene of batchScenes) {
            const id = _sceneDisplayId(scene);
            const resolvedPath = scene.mediaFile || null;
            const resolvedExists = !!(resolvedPath && fs.existsSync(resolvedPath));
            let resolvedSize = null;
            if (resolvedExists) {
                try { resolvedSize = fs.statSync(resolvedPath).size; } catch (_) {}
            }
            const status = scene.mediaDownloadStatus || (downloadError ? 'errored' : (resolvedPath ? 'completed' : 'failed'));
            let summary;
            try {
                summary = _buildFriendlySummary(scene, {
                    status,
                    error: downloadError,
                    outputPath: resolvedPath,
                    fileExists: resolvedExists,
                    fileSize: resolvedSize,
                    durationMs: totalMs,
                });
            } catch (summaryErr) {
                const diag = scene.mediaDiagnostics || {};
                const final = diag.final || {};
                summary = {
                    ok: !downloadError && status !== 'failed' && !!resolvedPath,
                    verdict: !downloadError && status !== 'failed' && !!resolvedPath ? 'accepted' : 'failed',
                    status,
                    durationSec: Number((totalMs / 1000).toFixed(1)),
                    final: {
                        provider: scene.sourceProvider || final.provider || null,
                        query: final.query || scene.searchKeyword || scene.keyword || '',
                        reason: `summary build failed: ${String(summaryErr?.message || summaryErr).slice(0, 140)}`,
                    },
                    file: {
                        path: resolvedPath,
                        exists: resolvedExists,
                        sizeBytes: resolvedSize,
                        sizeMB: resolvedSize ? Number((resolvedSize / 1024 / 1024).toFixed(2)) : null,
                    },
                    counts: { searches: 0, rejected: 0, accepted: resolvedPath ? 1 : 0 },
                    triedLinks: [],
                    videosFound: [],
                    videosTried: [],
                    error: downloadError || String(summaryErr?.message || summaryErr),
                };
            }
            summaries.push({ sceneId: id, ok: !!summary.ok, status, outputPath: resolvedPath, sourceProvider: scene.sourceProvider || null });
            safeEmit({
                stage: 'summary',
                sceneId: id,
                message: summary.ok
                    ? `Batch accepted S${id} via ${summary.final.provider || '?'} (${summary.counts.rejected} rejected before final)`
                    : `Batch did not accept S${id}${downloadError ? `: ${downloadError}` : ''}`,
                data: summary,
            });
            safeEmit({
                stage: 'download-done',
                sceneId: id,
                message: downloadError
                    ? `Batch download FAILED after ${(totalMs / 1000).toFixed(1)}s: ${downloadError}`
                    : (resolvedPath
                        ? `Batch download ${status} in ${(totalMs / 1000).toFixed(1)}s - ${resolvedPath}${resolvedSize ? ` (${(resolvedSize / 1024 / 1024).toFixed(2)} MB)` : ''} via ${scene.sourceProvider || '?'}`
                        : `Batch download ${status} after ${(totalMs / 1000).toFixed(1)}s - no media produced`),
                data: {
                    error: downloadError,
                    status,
                    outputPath: resolvedPath,
                    fileExists: resolvedExists,
                    fileSize: resolvedSize,
                    durationMs: totalMs,
                    sourceProvider: scene.sourceProvider || null,
                    mediaType: scene.mediaType,
                    mediaWidth: scene.mediaWidth,
                    mediaHeight: scene.mediaHeight,
                    mediaDiagnostics: scene.mediaDiagnostics || null,
                },
            });
        }

        const accepted = summaries.filter(s => s.ok).length;
        safeEmit({
            stage: 'batch',
            sceneId: startId,
            message: `Batch finished: ${accepted}/${summaries.length} accepted in ${(totalMs / 1000).toFixed(1)}s`,
            data: { accepted, total: summaries.length, sceneConcurrency, summaries },
        });

        return {
            ok: !downloadError,
            accepted,
            total: summaries.length,
            sceneConcurrency,
            sceneIds,
            summaries,
            error: downloadError,
        };
    } finally {
        console.log = origLog;
        console.error = origErr;
        try { footageManager.setLogSink(null); } catch (_) {}
    }
}

module.exports = { loadBuild, testScene, testSceneBatch };
