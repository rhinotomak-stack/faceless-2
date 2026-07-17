/**
 * Media Agent
 *
 * AI-guided scene media brief. This sits above Media Hunter / Media Scout:
 * the agent decides what a human editor would want the audience to see for
 * this exact narration, then the downloader/scout code executes that plan.
 */

const config = require('../settings/config');
const { callAIJson } = require('../brain/strict-json');
const { sanitizeSourceHint } = require('./source-policy');

const STOCK_PROVIDERS = ['pexels', 'pixabay'];
const VIDEO_PROVIDERS = ['youtube', 'pexels', 'pixabay', 'reddit'];
const IMAGE_PROVIDERS = ['bing', 'brave', 'pexels', 'pixabay'];
const PROVIDER_ALIASES = {
    stock: 'pexels',
    storyblocks: 'pexels',
    pexels: 'pexels',
    pixabay: 'pixabay',
    youtube: 'youtube',
    reddit: 'reddit',
    bing: 'bing',
    brave: 'brave',
    'web-image': 'bing',
};
const PROVIDER_LOCK_STRENGTHS = new Set(['open', 'soft', 'hard', 'reference']);

const GENERIC_AVOID = [
    'presenter talking head',
    'news anchor desk',
    'podcast or interview',
    'AI generated graphic',
    'cartoon or illustration',
    'generic topic metaphor',
    'wrong product or wrong brand',
    'unrelated factory or process',
    'watermarked thumbnail',
];

const QUERY_NOISE_RE = /\b(background|cinematic|dramatic|moody|dark|ominous|beautiful|high quality|template|fullscreen|card|statcard|factcard|chaptercard|showing|visual|intent)\b/gi;
const EXACT_REFERENCE_MARKER_RE = /\b(exact|specific|named|official|public|real|actual|authentic|brand|branded|branding|logo|label|sticker|model|product name|clearly visible|visible|recognizable|identifiable|screenshot|screen capture|comment section|document|webpage|website|interface|ui|chart from|map of|photo of)\b/i;
const GENERIC_STOCK_ROLE_RE = /\b(generic[-\s]?broll|generic b-roll|background|atmosphere|texture|abstract|symbolic|metaphor)\b/i;
const FRAME_VISIBLE_IDENTITY_RE = /\b(logo|label|sticker|model|model plate|serial|screen|display|control panel|touchscreen|error code|comment section|screenshot|document|webpage|website|interface|ui|package|packaging|retail shelf|product close[-\s]?up|close[-\s]?up still|reference still|exact still|photo)\b/i;
const SOURCE_PROVEN_IDENTITY_RE = /\b(source[-\s]?proven|source[-\s]?verified|factory|facility|plant|manufacturing|production line|assembly line|factory floor|workshop floor|behind[-\s]?the[-\s]?scenes|tour|documentary footage|company video|official video|official demo|product demo|demo video|process footage|making of|how it'?s made|in action|operation|operating|running|working|wash cycle|cycle demo|test footage)\b/i;
const MANDATORY_VISIBLE_ENTITY_TYPES = new Set([
    'org', 'organization', 'company', 'brand', 'product', 'person', 'model',
]);

const EMPTY_SCENE_ENTITY_PLAN = {
    ai: false,
    requiredEntities: [],
    visibleEntities: [],
    contextualEntities: [],
    rejectedEntities: [],
    reason: '',
};

function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function norm(value) {
    return clean(value).toLowerCase();
}

function short(value, max = 420) {
    const text = clean(value);
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function dedupe(values, max = 20) {
    const out = [];
    const seen = new Set();
    for (const value of values || []) {
        const text = clean(value);
        if (!text || /^none$/i.test(text)) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= max) break;
    }
    return out;
}

function listValue(value) {
    if (Array.isArray(value)) return value;
    const text = clean(value);
    return text ? [text] : [];
}

function tokens(value) {
    return norm(value)
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .split(/\s+/)
        .map(t => t.replace(/^-+|-+$/g, '').trim())
        .filter(t => t.length > 2);
}

const SCENE_CONTRACT_STOP_WORDS = new Set([
    'about', 'above', 'actual', 'alternate', 'alternative', 'background',
    'behind', 'blocked', 'card', 'clean', 'clear', 'close', 'closeup',
    'context', 'directly', 'editorial', 'exact', 'footage', 'generic',
    'graphic', 'highlighted', 'image', 'infographic', 'large', 'literal',
    'map', 'media', 'photo', 'planned', 'route', 'shot', 'show', 'showing',
    'shows', 'specific', 'still', 'template', 'through', 'toward', 'video',
    'visual', 'wide', 'with',
]);

function sceneContractTokens(value) {
    return tokens(value)
        .map(t => t.toLowerCase())
        .filter(t => !SCENE_CONTRACT_STOP_WORDS.has(t));
}

function compactQuery(value, maxWords = 8) {
    const out = [];
    const seen = new Set();
    for (const raw of clean(value).replace(QUERY_NOISE_RE, ' ').split(/\s+/)) {
        const word = raw.trim();
        const key = word.toLowerCase().replace(/[^\p{L}\p{N}-]/gu, '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(word);
        if (out.length >= maxWords) break;
    }
    return out.join(' ');
}

function providerKey(value) {
    return PROVIDER_ALIASES[String(value || '').toLowerCase().trim()] || '';
}

function isStockProviderKey(value) {
    const key = providerKey(value) || String(value || '').toLowerCase().trim();
    return STOCK_PROVIDERS.includes(key);
}

function stockProvidersFor(mediaType) {
    const allowed = allowedProviders(mediaType);
    return STOCK_PROVIDERS.filter(key => allowed.includes(key));
}

function sourceProvider(sourceHint, mediaType) {
    const safeHint = sanitizeSourceHint(sourceHint || '', mediaType === 'image' ? 'web-image' : 'youtube') || '';
    const mapped = providerKey(safeHint);
    if (mapped) return mapped;
    return mediaType === 'image' ? 'bing' : 'youtube';
}

function allowedProviders(mediaType) {
    return mediaType === 'image' ? IMAGE_PROVIDERS : VIDEO_PROVIDERS;
}

function normalizeSearchStrategy(parsed = {}, fallback = {}, mediaType = 'video', scene = {}, scriptContext = {}) {
    const raw = parsed?.searchStrategy && typeof parsed.searchStrategy === 'object' ? parsed.searchStrategy : {};
    const allowed = new Set(allowedProviders(mediaType));
    const lanes = [];
    const dropped = [];
    let ordinal = 0;

    const addLane = (value, defaultProvider = '') => {
        if (value == null) return;
        if (typeof value === 'string') {
            const query = compactQuery(value, mediaType === 'image' ? 8 : 7);
            if (!query) return;
            const nonLocal = _nonLocalKnownEntitiesInText(query, scene, scriptContext);
            if (nonLocal.length > 0) {
                dropped.push(...nonLocal);
                return;
            }
            lanes.push({
                provider: providerKey(defaultProvider) || '',
                query,
                purpose: '',
                priority: 50,
                order: ordinal++,
            });
            return;
        }
        if (typeof value !== 'object') return;
        const provider = providerKey(value.provider || value.providerKey || value.source || value.sourceHint || defaultProvider);
        if (provider && !allowed.has(provider)) return;
        const maxWords = isStockProviderKey(provider) ? 6 : mediaType === 'image' ? 8 : 8;
        const query = compactQuery(value.query || value.search || value.phrase || value.text || value.keyword || '', maxWords);
        if (!query) return;
        const nonLocal = _nonLocalKnownEntitiesInText(query, scene, scriptContext);
        if (nonLocal.length > 0) {
            dropped.push(...nonLocal);
            return;
        }
        lanes.push({
            provider,
            query,
            purpose: short(value.purpose || value.reason || value.intent || '', 180),
            priority: Number.isFinite(Number(value.priority)) ? Number(value.priority) : 50,
            order: ordinal++,
        });
    };

    for (const lane of [
        ...(Array.isArray(raw.queryLanes) ? raw.queryLanes : []),
        ...(Array.isArray(parsed?.queryLanes) ? parsed.queryLanes : []),
    ]) {
        addLane(lane);
    }

    const providerQueries = raw.providerQueries || parsed?.providerQueries || {};
    if (providerQueries && typeof providerQueries === 'object' && !Array.isArray(providerQueries)) {
        for (const [providerName, values] of Object.entries(providerQueries)) {
            const entries = Array.isArray(values)
                ? values
                : values && typeof values === 'object'
                ? [values]
                : listValue(values);
            for (const value of entries) addLane(value, providerName);
        }
    }

    if (lanes.length === 0 && fallback?.searchStrategy?.queryLanes?.length) {
        for (const lane of fallback.searchStrategy.queryLanes) addLane(lane, lane.provider);
    }

    const seen = new Set();
    const queryLanes = lanes
        .sort((a, b) => (b.priority - a.priority) || (a.order - b.order))
        .filter(lane => {
            const key = `${lane.provider || '*'}:${lane.query.toLowerCase()}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, 18)
        .map(({ order, ...lane }) => lane);

    return {
        assetClass: clean(parsed?.assetClass || raw.assetClass || fallback.assetClass || fallback.role || ''),
        primaryProvider: providerKey(parsed?.primaryProvider || raw.primaryProvider || fallback.searchStrategy?.primaryProvider || ''),
        providerReasoning: short(parsed?.providerReasoning || raw.providerReasoning || raw.reason || fallback.searchStrategy?.providerReasoning || '', 320),
        minimumAcceptable: short(parsed?.minimumAcceptable || raw.minimumAcceptable || fallback.minimumAcceptable || '', 360),
        queryLanes,
        repairStrategy: dedupe([
            ...listValue(raw.repairStrategy || parsed?.repairStrategy),
            ...listValue(raw.repairQueries || parsed?.repairQueries),
            ...(Array.isArray(raw.repairStrategy) ? raw.repairStrategy : []),
            ...(Array.isArray(parsed?.repairStrategy) ? parsed.repairStrategy : []),
        ], 8),
        droppedNonLocalEntities: dedupe(dropped, 12),
    };
}

function _scoutProviderEvidence(scene = {}) {
    const rows = [];
    const seen = new Set();
    if (Array.isArray(scene?._scoutProviderScoreboard)) {
        for (const row of scene._scoutProviderScoreboard) {
            const key = providerKey(row?.provider);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            rows.push({
                provider: key,
                score: Number(row?.score || 0),
                top: Number(row?.top || 0),
            });
        }
    }
    if (rows.length === 0 && Array.isArray(scene?._topicFootageCandidates)) {
        const totals = new Map();
        const tops = new Map();
        for (const candidate of scene._topicFootageCandidates) {
            const key = providerKey(candidate?._topicScout?.providerKey || candidate?._topicScout?.providerName);
            if (!key) continue;
            const score = Number(candidate?._topicScout?.sceneScore || candidate?._topicScout?.score || 0);
            totals.set(key, (totals.get(key) || 0) + Math.max(0, score));
            tops.set(key, Math.max(tops.get(key) || 0, score));
        }
        for (const [key, score] of totals.entries()) {
            rows.push({ provider: key, score, top: tops.get(key) || 0 });
        }
    }
    return rows
        .filter(row => row.provider && Number.isFinite(row.score))
        .sort((a, b) => (b.score - a.score) || (b.top - a.top))
        .slice(0, 6);
}

function normalizeProviderOrder(order, mediaType, sourceHint, opts = {}) {
    const allowed = new Set(allowedProviders(mediaType));
    const preferred = sourceProvider(sourceHint, mediaType);
    const orderList = (order || []).map(providerKey).filter(Boolean);
    const seed = opts.hintFirst
        ? [preferred, ...orderList, ...allowedProviders(mediaType)]
        : [...orderList, preferred, ...allowedProviders(mediaType)];
    return dedupe([
        ...seed,
    ].filter(key => key && allowed.has(key)), 6);
}

function normalizeProviderLock(value, mediaType) {
    const raw = (value && typeof value === 'object')
        ? value
        : { strength: value };
    const strengthRaw = clean(raw.strength || raw.mode || raw.type || '')
        .toLowerCase()
        .replace(/_/g, '-');
    const strength = PROVIDER_LOCK_STRENGTHS.has(strengthRaw) ? strengthRaw : 'open';
    const allowed = new Set(allowedProviders(mediaType));
    const providerValues = Array.isArray(raw.providers) ? raw.providers
        : Array.isArray(raw.allowedProviders) ? raw.allowedProviders
        : Array.isArray(raw.providerOrder) ? raw.providerOrder
        : raw.provider ? [raw.provider]
        : [];
    const providers = dedupe(
        providerValues
            .map(providerKey)
            .filter(key => key && allowed.has(key)),
        6
    );
    return {
        strength,
        family: clean(raw.family || raw.providerFamily || raw.lane || ''),
        providers,
        reason: clean(raw.reason || raw.providerLockReason || raw.why || ''),
    };
}

function sceneIndex(scene) {
    const idx = scene?.originalIndex ?? scene?.index ?? scene?.sceneIndex;
    return Number.isFinite(Number(idx)) ? Number(idx) : null;
}

function sceneTextBlock(scene) {
    return [
        scene?.text,
        scene?.transcript,
        scene?.visualIntent,
        scene?.templateHint,
        scene?.templateBgQuery,
        scene?.sourceReason,
    ].filter(Boolean).join(' ');
}

function primarySearch(scene, opts = {}) {
    return clean(
        opts.keyword
        || scene?.searchKeyword
        || scene?.researchKeyword
        || scene?.templateBgQuery
        || scene?.bgQuery
        || scene?.webQuery
        || scene?.stockQuery
        || scene?.keyword
        || scene?.visualIntent
        || ''
    );
}

function collectAnchors(scene, scriptContext = {}, opts = {}) {
    const keyword = primarySearch(scene, opts);
    const visualIntent = clean(scene?.visualIntent || '');
    const terms = [
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
        ...(Array.isArray(scene?.entityContext) ? scene.entityContext : []),
    ];

    const basePhrases = [
        keyword,
        scene?.templateBgQuery,
        scene?.bgQuery,
        scene?.webQuery,
        scene?.stockQuery,
    ].filter(Boolean);

    // Keep the literal search phrase as the strongest anchor, then add short
    // concrete token phrases from the visual intent. This is intentionally
    // scene-local, not niche/domain-based.
    const visualTokens = tokens(visualIntent)
        .filter(t => !['fullscreen', 'showing', 'background', 'scene', 'shot', 'close', 'wide'].includes(t))
        .slice(0, 8);
    const visualPhrase = compactQuery(visualTokens.join(' '), 6);

    return dedupe([
        ...terms,
        ...basePhrases,
        visualPhrase,
        ...(Array.isArray(scriptContext?.entities) ? scriptContext.entities.filter(e => norm(sceneTextBlock(scene)).includes(norm(e))) : []),
    ], 12);
}

function genericizeForStock(query, anchors = []) {
    let out = clean(query);
    for (const anchor of anchors || []) {
        const text = clean(anchor);
        if (!text || text.length < 4) continue;
        // Remove exact multi-word proper names from stock fallback queries, but
        // keep product/category words already present in the query.
        if (/^[A-Z0-9][A-Za-z0-9&'.-]+(?:\s+[A-Z0-9][A-Za-z0-9&'.-]+)+$/.test(text)) {
            const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            out = out.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), ' ');
        }
    }
    // Stock libraries rarely index exact brand names. If the query starts with
    // a proper-name prefix followed by lowercase product/category words, keep
    // the product words for a usable generic fallback.
    out = out.replace(/^(?:[A-Z][A-Za-z0-9&'.-]+\s+){1,3}(?=[a-z])/u, ' ');
    out = out.replace(/\s+/g, ' ').trim();
    return compactQuery(out || query, 6);
}

function _isStockFriendlyGeneric(plan = {}, scene = {}) {
    const text = [
        plan.role,
        plan.viewerNeed,
        plan.target,
        ...(Array.isArray(plan.mustShow) ? plan.mustShow : []),
        scene.visualIntent,
        primarySearch(scene, { keyword: plan.keyword }),
    ].join(' ').toLowerCase();
    if (!text.trim()) return false;
    if (GENERIC_STOCK_ROLE_RE.test(text)) return true;
    return /\b(retail|store|shop|showroom|aisle|shelf|shelves|warehouse|factory|facility|landfill|dump|scrapyard|workshop|tool|appliance|washer|dryer|laundromat|kitchen|lab|road|street|office|assembly|production|machine|machinery|industrial|shopping|shopper|customer)\b/i.test(text);
}

function _knownEntitySet(scriptContext = {}) {
    return new Set([
        ...(Array.isArray(scriptContext?.entities) ? scriptContext.entities : []),
        ...Object.keys(scriptContext?.entityTypes || {}),
    ].map(v => norm(v)).filter(Boolean));
}

function _entityType(scriptContext = {}, value = '') {
    const key = norm(value);
    const types = scriptContext?.entityTypes || {};
    return clean(types[key] || types[value] || '').toLowerCase();
}

function _escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _textContainsPhrase(text, phrase) {
    const needle = clean(phrase);
    if (!needle || needle.length < 3) return false;
    const pattern = needle.split(/\s+/).map(_escapeRegExp).join('[\\s-]+');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${pattern}($|[^\\p{L}\\p{N}])`, 'iu').test(String(text || ''));
}

function _sceneLocalMandatoryEvidenceText(scene = {}) {
    return [
        scene?.text,
        scene?.transcript,
        scene?.visualIntent,
        scene?.templateBgQuery,
        scene?.bgQuery,
        scene?.webQuery,
        scene?.stockQuery,
        scene?.searchKeyword,
        scene?.researchKeyword,
        scene?.keyword,
        scene?.sourceReason,
    ].filter(Boolean).join(' ');
}

function _sceneCoreContractEvidenceText(scene = {}) {
    return [
        scene?.text,
        scene?.transcript,
        scene?.templateBgQuery,
        scene?.bgQuery,
        scene?.webQuery,
        scene?.stockQuery,
        scene?.searchKeyword,
        scene?.researchKeyword,
        scene?.keyword,
    ].filter(Boolean).join(' ');
}

function _knownEntityList(scriptContext = {}) {
    return dedupe([
        ...(Array.isArray(scriptContext?.entities) ? scriptContext.entities : []),
        ...Object.keys(scriptContext?.entityTypes || {}),
    ], 80);
}

function _sceneHasEntityEvidence(scene = {}, scriptContext = {}, value = '') {
    const text = clean(value);
    if (!text || text.length < 3) return false;
    if (_sceneEntityPlanMentions(scene, text, ['requiredEntities', 'visibleEntities'])) return true;
    const localEvidence = _sceneLocalMandatoryEvidenceText(scene);
    if (_textContainsPhrase(localEvidence, text)) return true;
    for (const entity of _knownEntityList(scriptContext)) {
        const anchor = clean(entity);
        if (!anchor || anchor.length < 3) continue;
        if (_textContainsPhrase(text, anchor) && _textContainsPhrase(localEvidence, anchor)) return true;
    }
    return false;
}

function _nonLocalKnownEntitiesInText(text = '', scene = {}, scriptContext = {}) {
    const localEvidence = _sceneLocalMandatoryEvidenceText(scene);
    const out = [];
    for (const entity of _knownEntityList(scriptContext)) {
        const anchor = clean(entity);
        if (!anchor || anchor.length < 3) continue;
        if (!_textContainsPhrase(text, anchor)) continue;
        if (_sceneEntityPlanMentions(scene, anchor, ['requiredEntities', 'visibleEntities'])) continue;
        if (_textContainsPhrase(localEvidence, anchor)) continue;
        out.push(anchor);
    }
    return dedupe(out, 12);
}

function _knownEntitiesMissingFromEvidence(text = '', evidence = '', scriptContext = {}) {
    const out = [];
    for (const entity of _knownEntityList(scriptContext)) {
        const anchor = clean(entity);
        if (!anchor || anchor.length < 3) continue;
        if (!_textContainsPhrase(text, anchor)) continue;
        if (_textContainsPhrase(evidence, anchor)) continue;
        out.push(anchor);
    }
    return dedupe(out, 12);
}

function _filterSceneLocalEntityItems(values = [], scene = {}, scriptContext = {}, max = 20) {
    const kept = [];
    const dropped = [];
    for (const value of listValue(values)) {
        const text = clean(value);
        if (!text) continue;
        const nonLocal = _nonLocalKnownEntitiesInText(text, scene, scriptContext);
        if (nonLocal.length > 0) {
            dropped.push(...nonLocal);
            continue;
        }
        kept.push(text);
    }
    return { kept: dedupe(kept, max), dropped: dedupe(dropped, 20) };
}

function _sceneContractGrounding(value = '', scene = {}, scriptContext = {}, opts = {}) {
    const text = clean(value);
    if (!text) return { grounded: false, reason: 'empty' };
    const coreEvidence = clean(`${_sceneCoreContractEvidenceText(scene)} ${scene?._forcedSearchKeyword || ''}`);
    const localEvidence = clean(`${_sceneLocalMandatoryEvidenceText(scene)} ${scene?._forcedSearchKeyword || ''}`);
    if (!localEvidence) return { grounded: true, reason: 'no scene evidence available' };
    const groundingEvidence = coreEvidence || localEvidence;
    if (_textContainsPhrase(groundingEvidence, text)) return { grounded: true, reason: 'exact scene phrase' };

    const missingCoreEntities = coreEvidence
        ? _knownEntitiesMissingFromEvidence(text, coreEvidence, scriptContext)
        : [];
    if (missingCoreEntities.length > 0) {
        return { grounded: false, reason: `not in scene narration/query ${missingCoreEntities.slice(0, 3).join(', ')}` };
    }

    const nonLocalEntities = _nonLocalKnownEntitiesInText(text, scene, scriptContext);
    if (nonLocalEntities.length > 0) {
        return { grounded: false, reason: `non-scene entity ${nonLocalEntities.slice(0, 3).join(', ')}` };
    }

    const wanted = sceneContractTokens(text);
    if (wanted.length === 0) return { grounded: true, reason: 'style-only term' };
    const localTokens = new Set(sceneContractTokens(groundingEvidence));
    const hits = wanted.filter(token => localTokens.has(token));
    const hitRatio = hits.length / Math.max(1, wanted.length);

    // Mandatory contract terms must be stricter than generic search fallbacks:
    // an AI can invent a nice route/map/process detail, but it cannot make that
    // detail a scoring requirement unless the scene itself asked for it.
    const requiredHits = opts.query
        ? Math.min(2, wanted.length)
        : wanted.length <= 2 ? wanted.length : Math.ceil(wanted.length * 0.6);
    if (hits.length >= requiredHits || hitRatio >= (opts.query ? 0.34 : 0.55)) {
        return { grounded: true, reason: `scene token overlap ${hits.length}/${wanted.length}` };
    }
    return {
        grounded: false,
        reason: `not scene-grounded (${hits.length}/${wanted.length} token overlap)`,
    };
}

function _filterSceneLocalVisualItems(values = [], scene = {}, scriptContext = {}, max = 20) {
    const kept = [];
    const dropped = [];
    for (const value of listValue(values)) {
        const text = clean(value);
        if (!text) continue;
        const grounding = _sceneContractGrounding(text, scene, scriptContext);
        if (!grounding.grounded) {
            dropped.push(`${text} (${grounding.reason})`);
            continue;
        }
        kept.push(text);
    }
    return { kept: dedupe(kept, max), dropped: dedupe(dropped, 20) };
}

function _contractTextIsOverSpecified(value = '', scene = {}, scriptContext = {}) {
    const text = clean(value);
    if (!text) return false;
    const grounding = _sceneContractGrounding(text, scene, scriptContext);
    if (grounding.grounded) return false;
    const wanted = sceneContractTokens(text);
    return wanted.length >= 5;
}

/**
 * Canonical CLEAN visual subject for a scene — the single source of truth for
 * "what footage should we search for" when the planner didn't hand us a query.
 * Data-driven, no niche/keyword hardcoding. Order:
 *   1. Planner-produced visual queries/keywords (clean by construction)
 *   2. The scene's OWN entities (required/visible/context) + the video topic
 *   3. The video topic alone
 * It NEVER falls back to scene.text — raw narration prose yields fragment
 * garbage ("happens failing backup", "beginning exactly that's") that pulls
 * irrelevant footage. A relevant topic-level subject beats prose-fragment hits.
 */
function cleanSceneSubject(scene = {}, scriptContext = {}, opts = {}) {
    const maxWords = opts.maxWords || 7;
    const direct = compactQuery(
        clean(opts.keyword)
        || clean(scene?.searchKeyword) || clean(scene?.researchKeyword)
        || clean(scene?.stockQuery) || clean(scene?.webQuery)
        || clean(scene?.bgQuery) || clean(scene?.templateBgQuery)
        || clean(scene?.keyword)
        || clean(scene?.visualIntent),
        maxWords
    );
    if (direct) return direct;
    // Semantic anchors: the scene's OWN entities + the video topic — never prose.
    const plan = _sceneEntityPlan(scene);
    const entityBits = dedupe([
        ...(Array.isArray(plan?.requiredEntities) ? plan.requiredEntities : []),
        ...(Array.isArray(plan?.visibleEntities) ? plan.visibleEntities : []),
        ...(Array.isArray(scene?.entityContext) ? scene.entityContext : []),
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
        ...(Array.isArray(plan?.contextualEntities) ? plan.contextualEntities : []),
    ], 3);
    const topic = clean(scriptContext?.topic || scriptContext?.title || scriptContext?.videoTitle || scriptContext?.subject || '');
    const anchored = compactQuery([entityBits.join(' '), topic].filter(Boolean).join(' '), maxWords);
    if (anchored) return anchored;
    return topic;
}

function _groundedViewerNeed(plan = {}, scene = {}, mediaType = 'video', scriptContext = {}) {
    const subject = cleanSceneSubject(scene, scriptContext, { keyword: plan?.keyword, maxWords: mediaType === 'image' ? 8 : 7 })
        || 'the scene subject';
    if (/template-background/i.test(String(plan?.role || '')) || scene?._templateBackupFootage || scene?.mediaIntent?.lane === 'templateBackground') {
        return `background media that directly supports the scene subject: ${subject}`;
    }
    if (mediaType === 'image') {
        return `reference image that directly shows the scene subject: ${subject}`;
    }
    return `footage that directly shows the scene subject: ${subject}`;
}

function _sanitizeQueriesForScene(queries = {}, fallbackQueries = [], scene = {}, scriptContext = {}, mediaType = 'video', baseKeyword = '') {
    const allowed = allowedProviders(mediaType);
    const out = {};
    const dropped = [];
    for (const key of allowed) {
        const maxWords = isStockProviderKey(key) ? 6 : 8;
        const kept = [];
        for (const query of listValue(queries?.[key])) {
            const text = compactQuery(query, maxWords);
            if (!text) continue;
            const nonLocal = _nonLocalKnownEntitiesInText(text, scene, scriptContext);
            if (nonLocal.length > 0) {
                dropped.push(...nonLocal);
                continue;
            }
            const grounding = _sceneContractGrounding(text, scene, scriptContext, { query: true });
            if (!grounding.grounded) {
                dropped.push(`${text} (${grounding.reason})`);
                continue;
            }
            kept.push(text);
        }
        out[key] = dedupe(kept, 8);
    }

    const fallbackKept = [];
    for (const query of listValue(fallbackQueries)) {
        const text = compactQuery(query, mediaType === 'image' ? 8 : 7);
        if (!text) continue;
        const nonLocal = _nonLocalKnownEntitiesInText(text, scene, scriptContext);
        if (nonLocal.length > 0) {
            dropped.push(...nonLocal);
            continue;
        }
        const grounding = _sceneContractGrounding(text, scene, scriptContext, { query: true });
        if (!grounding.grounded) {
            dropped.push(`${text} (${grounding.reason})`);
            continue;
        }
        fallbackKept.push(text);
    }

    const base = cleanSceneSubject(scene, scriptContext, { keyword: baseKeyword, maxWords: mediaType === 'image' ? 8 : 7 });
    const cleanBase = base && _nonLocalKnownEntitiesInText(base, scene, scriptContext).length === 0 ? base : '';
    if (cleanBase) {
        for (const key of allowed) {
            if (!out[key]?.length) {
                const suffix = mediaType === 'image' || key === 'bing' ? 'photo' : 'footage';
                out[key] = dedupe([cleanBase, `${cleanBase} ${suffix}`], 4);
            }
        }
        if (fallbackKept.length === 0) fallbackKept.push(cleanBase);
    }

    return { queries: out, fallbackQueries: dedupe(fallbackKept, 12), dropped: dedupe(dropped, 20) };
}

function _sceneEntityPlan(scene = {}) {
    return scene?._sceneEntityPlan || EMPTY_SCENE_ENTITY_PLAN;
}

function _sceneEntityPlanMentions(scene = {}, value = '', fields = ['requiredEntities', 'visibleEntities', 'contextualEntities']) {
    const text = clean(value);
    if (!text) return false;
    const plan = _sceneEntityPlan(scene);
    for (const field of fields) {
        const values = Array.isArray(plan?.[field]) ? plan[field] : [];
        if (values.some(entity => _textContainsPhrase(text, entity) || _textContainsPhrase(entity, text))) return true;
    }
    return false;
}

function _sceneEntityPromptRows(scene = {}, scriptContext = {}) {
    const entityTypes = scriptContext?.entityTypes || {};
    const candidates = dedupe([
        ...(Array.isArray(scriptContext?.entities) ? scriptContext.entities : []),
        ...(Array.isArray(scene?.entityContext) ? scene.entityContext : []),
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
        ...(Array.isArray(scene?.protect) ? scene.protect : []),
        ..._properNamedPhrases(_sceneLocalMandatoryEvidenceText(scene)),
    ], 40);
    return candidates.map(entity => {
        const name = clean(entity);
        const type = clean(entityTypes[norm(name)] || entityTypes[name] || 'unknown');
        return `${name}${type ? ` [${type}]` : ''}`;
    });
}

function _normalizeSceneEntityPlan(parsed = {}, scene = {}, scriptContext = {}) {
    const candidates = _sceneEntityPromptRows(scene, scriptContext)
        .map(row => clean(row.replace(/\s+\[[^\]]+\]\s*$/g, '')))
        .filter(Boolean);
    const known = new Set(candidates.map(norm));
    const pick = (value, max) => dedupe(listValue(value).filter(entity => {
        const text = clean(entity);
        if (!text) return false;
        if (known.has(norm(text))) return true;
        return candidates.some(candidate => _textContainsPhrase(candidate, text) || _textContainsPhrase(text, candidate));
    }), max);
    const requiredRaw = pick(parsed.requiredEntities || parsed.required || parsed.mandatoryIdentity, 10);
    const coreEvidence = _sceneCoreContractEvidenceText(scene);
    const requiredEntities = requiredRaw.filter(entity => {
        if (!coreEvidence) return true;
        return _textContainsPhrase(coreEvidence, entity);
    });
    const demotedRequired = requiredRaw.filter(entity => !requiredEntities.some(required => norm(required) === norm(entity)));
    const visibleEntities = requiredEntities.length > 0
        ? pick(parsed.visibleEntities || parsed.frameVisible || parsed.mandatoryVisible, 10)
            .filter(entity => requiredEntities.some(required => norm(required) === norm(entity)))
        : [];
    const contextualEntities = dedupe([
        ...pick(parsed.contextualEntities || parsed.contextOnly || parsed.backgroundContext, 16),
        ...demotedRequired,
    ], 16)
        .filter(entity => !requiredEntities.some(required => norm(required) === norm(entity)));
    const rejectedEntities = pick(parsed.rejectedEntities || parsed.notRelevant || parsed.unusedEntities, 20)
        .filter(entity => !requiredEntities.some(required => norm(required) === norm(entity)));
    return {
        ai: true,
        requiredEntities,
        visibleEntities,
        contextualEntities,
        rejectedEntities,
        reason: short(parsed.reason || parsed.sceneReason || '', 240),
    };
}

async function resolveSceneEntityPlan(scene = {}, scriptContext = {}, opts = {}) {
    if (!scene || config.mediaAgent?.enabled === false || config.mediaAgent?.useAI === false || opts.ai === false) {
        return { ...EMPTY_SCENE_ENTITY_PLAN };
    }
    const rows = _sceneEntityPromptRows(scene, scriptContext);
    if (rows.length === 0) return { ...EMPTY_SCENE_ENTITY_PLAN };

    const localEvidence = [
        `Narration: ${short(scene?.text || scene?.transcript || '', 520) || '-'}`,
        `Keyword/search: ${primarySearch(scene, opts) || '-'}`,
        `Visual intent: ${short(scene?.visualIntent || '', 360) || '-'}`,
        `Source/web/stock queries: ${[scene?.webQuery, scene?.stockQuery, scene?.templateBgQuery].filter(Boolean).join(' | ') || '-'}`,
    ].join('\n');
    const prompt = `You are the scene entity resolver for a documentary media agent.
The Director extracted full-video entities. Your job is to decide which of those entities matter for THIS ONE SCENE.

Scene:
${localEvidence}

Director/full-video entity candidates:
${rows.join('\n')}

Rules:
- requiredEntities: entities the audience must see/prove for this scene to be correct.
- visibleEntities: subset of requiredEntities that must be readable/identifiable inside the actual frame.
- contextualEntities: useful full-video context only; these must NOT become scoring requirements.
- rejectedEntities: entities from the full-video list that do not belong to this scene.
- If the scene is generic/contextual B-roll, requiredEntities and visibleEntities should be empty.
- Do not require an entity merely because it appears elsewhere in the video.
- If the scene uses pronouns or continuity and a Director entity is clearly the subject of this exact scene, include it.

Output ONLY JSON:
{"requiredEntities":[],"visibleEntities":[],"contextualEntities":[],"rejectedEntities":[],"reason":"short explanation"}`;

    try {
        const timeoutMs = Math.max(4000, Number(config.mediaAgent?.entityTimeoutMs || 14000));
        const parsed = await withTimeout(callAIJson(prompt, {
            label: 'Scene Entity Resolver',
            maxTokens: Math.max(250, Number(config.mediaAgent?.entityMaxTokens || 520)),
            temperature: 0.1,
            taskType: 'general',
            maxRetries: 2,
            schemaDescription: '{"requiredEntities":[],"visibleEntities":[],"contextualEntities":[],"rejectedEntities":[],"reason":"short explanation"}',
            validate(value) {
                for (const key of ['requiredEntities', 'visibleEntities', 'contextualEntities', 'rejectedEntities']) {
                    if (value[key] !== undefined && !Array.isArray(value[key])) return `${key} must be an array`;
                }
                return true;
            },
        }), timeoutMs, 'Scene Entity Resolver');
        return _normalizeSceneEntityPlan(parsed, scene, scriptContext);
    } catch (err) {
        return {
            ...EMPTY_SCENE_ENTITY_PLAN,
            error: err?.message || String(err),
        };
    }
}

function _looksLikeNamedAnchor(value, knownEntities = new Set()) {
    const text = clean(value);
    if (!text || text.length < 3) return false;
    const lower = norm(text);
    if (knownEntities.has(lower)) return true;
    if (/^[A-Z0-9][A-Za-z0-9&'.-]+(?:\s+[A-Z0-9][A-Za-z0-9&'.-]+)+$/.test(text)) return true;
    if (/\b[A-Z]{2,}\b/.test(text) && /\b[A-Z][A-Za-z0-9&'.-]+\b/.test(text)) return true;
    return false;
}

function _properNamedPhrases(value) {
    const text = clean(value);
    if (!text) return [];
    const out = [];
    const re = /\b[A-Z][A-Za-z0-9&'-]+(?:\s+[A-Z][A-Za-z0-9&'-]+){1,4}\b/g;
    let match;
    while ((match = re.exec(text))) {
        const phrase = clean(match[0]);
        if (!phrase || /^(The|This|That|If|When|Where|Why|How|And|But)\b/.test(phrase)) continue;
        out.push(phrase);
    }
    return dedupe(out, 12);
}

function _detectMandatoryVisibleEntities(plan = {}, scene = {}, scriptContext = {}) {
    // Retrievability Rescue deliberately broadened this scene to GENERIC topical B-roll
    // because the literal subject (proprietary product / meta-reference) is unfindable.
    // Enforcing a frame-visible mandatory identity here would re-anchor on that exact
    // subject and make Title Sanity / vision reject every generic clip — defeating the
    // rescue. A rescued scene has no mandatory frame-visible identity.
    if (scene && scene._retrievabilityRescued) return [];
    const localNarrationAndSearch = _sceneCoreContractEvidenceText(scene);
    const contextText = localNarrationAndSearch;

    const candidates = dedupe([
        ...(Array.isArray(scriptContext?.entities) ? scriptContext.entities : []),
        ..._properNamedPhrases(localNarrationAndSearch),
        ...(Array.isArray(plan?.subjectAnchors) ? plan.subjectAnchors : []),
        ...(Array.isArray(plan?.literalRequiredObjects) ? plan.literalRequiredObjects : []),
    ], 40);

    const out = [];
    const knownEntities = _knownEntitySet(scriptContext);
    const localProper = new Set(_properNamedPhrases(localNarrationAndSearch).map(norm));
    for (const candidate of candidates) {
        const text = clean(candidate);
        if (!text || text.length < 3 || !_textContainsPhrase(contextText, text)) continue;
        if (!_sceneHasEntityEvidence(scene, scriptContext, text)) continue;
        const type = _entityType(scriptContext, text);
        const typedMandatory = MANDATORY_VISIBLE_ENTITY_TYPES.has(type);
        const knownNamed = knownEntities.has(norm(text)) && _looksLikeNamedAnchor(text, knownEntities);
        const localProperNamed = localProper.has(norm(text)) && _looksLikeNamedAnchor(text, knownEntities);
        if (typedMandatory || knownNamed || localProperNamed) out.push(text);
    }

    return dedupe(out, 10);
}

function _mandatoryEvidenceText(plan = {}, scene = {}) {
    return _sceneCoreContractEvidenceText(scene);
}

function _sanitizeMandatoryVisibleEntities(values = [], plan = {}, scene = {}, scriptContext = {}) {
    const evidenceText = _mandatoryEvidenceText(plan, scene);
    const knownEntities = _knownEntitySet(scriptContext);
    // localProper must only extract proper-named phrases from the NARRATION
    // (scene.text / scene.transcript). visualIntent / templateBgQuery describe
    // the CARD design — including subheaders, slogans, button labels — which
    // are display text, not entity proof requirements. Mixing those in lets
    // the AI Title-Case card text ("Refused to Sell Out") into a fake brand
    // ("Sell Out") that 100% of B-roll candidates fail to match.
    const narrationText = [scene?.text, scene?.transcript].filter(Boolean).join(' ');
    const localProper = new Set(_properNamedPhrases(narrationText).map(norm));
    const role = clean(plan?.role || '').toLowerCase();
    const isBackgroundRole = role === 'template-background' || role === 'generic-broll';
    return dedupe(listValue(values).filter(value => {
        const text = clean(value);
        if (!text || text.length < 3) return false;
        if (!_textContainsPhrase(evidenceText, text)) return false;
        if (!_sceneHasEntityEvidence(scene, scriptContext, text)) return false;
        const type = _entityType(scriptContext, text);
        const typedMandatory = MANDATORY_VISIBLE_ENTITY_TYPES.has(type);
        const knownNamed = knownEntities.has(norm(text));
        const localProperNamed = localProper.has(norm(text));
        // A KNOWN non-verifiable type (place/event tagged by the Director) must
        // never become a frame-visible requirement, even when it's a Director
        // entity or a proper noun in narration: no footage can PROVE which sea,
        // city, region, or era is on screen. It rides on narration + context,
        // not in-frame proof. Type-driven → niche-agnostic (history "Rome",
        // nature "Pacific", war "Yemen" all handled), no topic word lists.
        // Unknown/untagged type still falls through (could be an untagged brand).
        if (type && !typedMandatory) return false;
        // Background/generic B-roll: refuse ANY entity that isn't already
        // Director-tagged or strongly typed. Card design text is never a
        // B-roll proof requirement.
        if (isBackgroundRole && !knownNamed && !typedMandatory) return false;
        return typedMandatory || knownNamed || localProperNamed;
    }), 10);
}

function _identityEvidenceText(plan = {}, scene = {}) {
    return [
        scene?.text,
        scene?.transcript,
        scene?.visualIntent,
        scene?.templateBgQuery,
        scene?.webQuery,
        scene?.searchKeyword,
        scene?.researchKeyword,
        scene?.keyword,
        plan?.role,
        plan?.viewerNeed,
        plan?.target,
        plan?.acceptanceTest,
        ...(Array.isArray(plan?.literalRequiredObjects) ? plan.literalRequiredObjects : []),
        ...(Array.isArray(plan?.subjectAnchors) ? plan.subjectAnchors : []),
        ...(Array.isArray(plan?.mustShow) ? plan.mustShow : []),
        ...(Array.isArray(plan?.niceToShow) ? plan.niceToShow : []),
    ].filter(Boolean).join(' ');
}

function _normalizeIdentityEvidenceMode(value, plan = {}, scene = {}, mediaType = 'video') {
    const raw = clean(value).toLowerCase().replace(/_/g, '-');
    const valid = new Set(['frame-visible', 'source-proven', 'either', 'none']);
    let mode = valid.has(raw) ? raw : '';
    const evidence = _identityEvidenceText(plan, scene);
    const roleText = clean(plan?.role || '');
    const sourceProvenSignal = mediaType === 'video' && SOURCE_PROVEN_IDENTITY_RE.test(evidence);

    if (mediaType === 'image' || /\b(reference-still|reference-image)\b/i.test(roleText)) {
        mode = 'frame-visible';
    } else if (sourceProvenSignal) {
        mode = 'source-proven';
    } else if (FRAME_VISIBLE_IDENTITY_RE.test(evidence)) {
        mode = 'frame-visible';
    }

    return mode || 'frame-visible';
}

function _identityQueryExpansions(plan = {}, scene = {}, provider = '', mediaType = 'video') {
    const key = providerKey(provider);
    const identities = Array.isArray(plan?.mandatoryIdentity) ? plan.mandatoryIdentity : [];
    if (!identities.length || !key) return [];
    if (isStockProviderKey(key)) return [];

    const evidence = _identityEvidenceText(plan, scene);
    const base = clean(plan?.keyword || primarySearch(scene, { keyword: plan?.keyword }) || '');
    const out = [];
    const sourceProvenScene = mediaType === 'video' && SOURCE_PROVEN_IDENTITY_RE.test(evidence);
    for (const identity of identities.slice(0, 3)) {
        const entity = clean(identity);
        if (!entity) continue;
        if (key === 'bing' || mediaType === 'image') {
            out.push(`${entity} ${base}`.trim(), `${entity} photo`, `${entity} official image`);
            continue;
        }
        if (sourceProvenScene) {
            out.push(
                `${entity} manufacturing facility tour`,
                `${entity} factory tour`,
                `${entity} production line`,
                `${entity} factory floor`,
                `${entity} behind the scenes`
            );
        } else {
            out.push(
                `${entity} ${base}`.trim(),
                `${entity} footage`,
                `${entity} demo`,
                `${entity} real video`
            );
        }
    }
    return dedupe(out.map(q => compactQuery(q, key === 'bing' ? 9 : 8)), 8);
}

function _ensureIdentityQueries(plan = {}, scene = {}, mediaType = 'video') {
    if (!plan?.queries || !Array.isArray(plan?.mandatoryIdentity) || plan.mandatoryIdentity.length === 0) return plan;
    const out = { ...plan, queries: { ...plan.queries } };
    const keys = mediaType === 'image' ? IMAGE_PROVIDERS : VIDEO_PROVIDERS;
    const sourceProven = String(out.identityEvidenceMode || '').toLowerCase() === 'source-proven';
    for (const key of keys) {
        const expansions = _identityQueryExpansions(out, scene, key, mediaType);
        if (!expansions.length) continue;
        const existing = Array.isArray(out.queries[key]) ? out.queries[key] : [];
        out.queries[key] = sourceProven
            ? dedupe([...expansions, ...existing], 8)
            : dedupe([...existing, ...expansions], 8);
    }
    out.fallbackQueries = dedupe([
        ..._identityQueryExpansions(out, scene, mediaType === 'image' ? 'bing' : 'youtube', mediaType),
        ...(Array.isArray(out.fallbackQueries) ? out.fallbackQueries : []),
    ], 12);
    return out;
}

function _requiresExactReference(plan, scene = {}, scriptContext = {}) {
    const knownEntities = _knownEntitySet(scriptContext);
    const anchors = dedupe([
        ...(plan?.subjectAnchors || []),
        ...(plan?.mustShow || []),
        primarySearch(scene, { keyword: plan?.keyword }),
        scene?.webQuery,
        scene?.templateBgQuery,
    ], 24);
    const requirementText = [
        plan?.viewerNeed,
        plan?.target,
        plan?.acceptanceTest,
        ...(plan?.mustShow || []),
        scene?.visualIntent,
        scene?.text,
        primarySearch(scene, { keyword: plan?.keyword }),
        scene?.webQuery,
        scene?.templateBgQuery,
    ].join(' ');
    const containedEntities = (Array.isArray(scriptContext?.entities) ? scriptContext.entities : [])
        .filter(entity => {
            const text = clean(entity);
            if (!text || text.length < 3) return false;
            const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            return new RegExp(`\\b${escaped}\\b`, 'i').test(requirementText);
        });
    const namedAnchors = dedupe([
        ...anchors.filter(anchor => _looksLikeNamedAnchor(anchor, knownEntities)),
        ...containedEntities,
    ], 16);
    if (namedAnchors.length === 0) return { required: false, namedAnchors: [] };

    const entityExact = namedAnchors.some(anchor => {
        const type = _entityType(scriptContext, anchor);
        if (!['org', 'person', 'brand', 'product'].includes(type)) return false;
        const escaped = clean(anchor).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`, 'i').test(requirementText);
    });
    if (GENERIC_STOCK_ROLE_RE.test(plan?.role || '') && !EXACT_REFERENCE_MARKER_RE.test(requirementText)) {
        return { required: false, namedAnchors };
    }
    return {
        required: entityExact || EXACT_REFERENCE_MARKER_RE.test(requirementText),
        namedAnchors,
    };
}

function _lockProviderFamily(out, mediaType, strength, providers, reason, family = '') {
    const lock = normalizeProviderLock({
        strength,
        providers,
        reason,
        family,
    }, mediaType);
    if (!lock.providers.length && (lock.strength === 'hard' || lock.strength === 'reference')) {
        lock.strength = 'open';
    }
    out.providerLock = lock;
    if (lock.strength !== 'open') {
        const note = `provider lock: ${lock.strength}${lock.providers.length ? ` ${lock.providers.join('>')}` : ''}${lock.reason ? ` (${lock.reason})` : ''}`;
        if (!out.providerReality.includes(note)) out.providerReality.push(note);
    }
}

function _applyProviderLock(out, mediaType) {
    const lock = normalizeProviderLock(out.providerLock, mediaType);
    out.providerLock = lock;
    if (!lock.providers.length || (lock.strength !== 'hard' && lock.strength !== 'reference')) {
        return out;
    }
    const allowedLocked = new Set(lock.providers);
    // Free stock providers are the build-saver lane. Even when the agent locks
    // the ideal provider family, keep them available as fallback candidates so
    // exactness decisions cannot starve the build of usable footage.
    for (const stockProvider of stockProvidersFor(mediaType)) {
        allowedLocked.add(stockProvider);
    }
    const addExclusion = (provider, reason) => {
        const key = providerKey(provider);
        if (isStockProviderKey(key)) return;
        if (!key || allowedLocked.has(key)) return;
        if (!out.providerExclusions.some(e => providerKey(e.provider) === key)) {
            out.providerExclusions.push({ provider: key, reason });
        }
    };
    for (const key of allowedProviders(mediaType)) {
        addExclusion(key, lock.reason || `provider lock ${lock.strength} -> ${lock.providers.join('>')}`);
    }
    out.providerOrder = dedupe([
        ...lock.providers,
        ...stockProvidersFor(mediaType).filter(key => allowedLocked.has(key) && !lock.providers.includes(key)),
        ...(out.providerOrder || []).map(providerKey).filter(key => allowedLocked.has(key)),
    ], 6);
    for (const key of allowedProviders(mediaType)) {
        if (!allowedLocked.has(key) && out.queries?.[key]) out.queries[key] = [];
    }
    return out;
}

function applyProviderReality(plan, scene = {}, scriptContext = {}, mediaType = 'video') {
    const localGuardDrops = [];
    // Retrievability Rescue broadened this scene to GENERIC topical B-roll because the
    // literal subject (proprietary product / meta-reference) is unfindable in footage. Strip
    // the literal-identity anchors the Media Agent AI extracted from the narration ("Right
    // Grip") so the contract below flows into the stock-protected generic-B-roll path instead
    // of locking the scene to youtube/reddit for an exact subject that does not exist on film.
    if (scene && scene._retrievabilityRescued && plan && typeof plan === 'object') {
        plan = {
            ...plan,
            mandatoryVisible: [],
            mandatoryIdentity: [],
            literalRequiredObjects: [],
            subjectAnchors: [],
            mustShow: [],
            identityEvidenceMode: 'none',
            providerLock: { strength: 'open', providers: [], reason: 'retrievability-rescued generic B-roll' },
        };
    }
    let out = {
        ...plan,
        mandatoryVisible: dedupe([
            ...(Array.isArray(plan?.mandatoryVisible) ? plan.mandatoryVisible : []),
            ..._detectMandatoryVisibleEntities(plan, scene, scriptContext),
        ], 10),
        mandatoryIdentity: dedupe([
            ...(Array.isArray(plan?.mandatoryIdentity) ? plan.mandatoryIdentity : []),
            ...(Array.isArray(plan?.mandatoryVisible) ? plan.mandatoryVisible : []),
            ..._detectMandatoryVisibleEntities(plan, scene, scriptContext),
        ], 10),
        providerExclusions: Array.isArray(plan?.providerExclusions) ? [...plan.providerExclusions] : [],
        providerReality: Array.isArray(plan?.providerReality) ? [...plan.providerReality] : [],
        providerEvidence: Array.isArray(plan?.providerEvidence) ? [...plan.providerEvidence] : _scoutProviderEvidence(scene),
        queries: { ...(plan?.queries || {}) },
        sceneEntities: plan?.sceneEntities || scene?._sceneEntityPlan || EMPTY_SCENE_ENTITY_PLAN,
        providerLock: normalizeProviderLock(plan?.providerLock || {
            strength: plan?.providerLockStrength,
            providers: plan?.providerLockProviders,
            reason: plan?.providerLockReason,
        }, mediaType),
    };
    for (const field of ['literalRequiredObjects', 'subjectAnchors', 'mustShow']) {
        const filtered = _filterSceneLocalVisualItems(out[field], scene, scriptContext, field === 'mustShow' ? 14 : 12);
        out[field] = filtered.kept;
        localGuardDrops.push(...filtered.dropped);
    }
    if (localGuardDrops.length > 0) {
        const note = `scene-contract guard: demoted non-scene visual requirements (${dedupe(localGuardDrops, 8).join(', ')})`;
        if (!out.providerReality.includes(note)) out.providerReality.push(note);
    }
    const overspecifiedFields = [];
    for (const field of ['viewerNeed', 'target', 'minimumAcceptable', 'acceptanceTest']) {
        if (_contractTextIsOverSpecified(out[field], scene, scriptContext)) {
            overspecifiedFields.push(field);
        }
    }
    if (overspecifiedFields.length > 0) {
        const groundedNeed = _groundedViewerNeed(out, scene, mediaType, scriptContext);
        out.viewerNeed = groundedNeed;
        out.target = groundedNeed;
        out.minimumAcceptable = `A truthful asset that makes the scene readable: ${groundedNeed}`;
        out.acceptanceTest = `Accept if the asset truthfully shows the current scene subject without adding unrelated requirements.`;
        const note = `scene-contract guard: reset over-specific ${overspecifiedFields.join('/')} to scene-grounded target`;
        if (!out.providerReality.includes(note)) out.providerReality.push(note);
    }
    out.mandatoryIdentity = _sanitizeMandatoryVisibleEntities(out.mandatoryIdentity, out, scene, scriptContext);
    out.identityEvidenceMode = _normalizeIdentityEvidenceMode(out.identityEvidenceMode, out, scene, mediaType);
    if (out.identityEvidenceMode === 'none' && out.mandatoryIdentity.length > 0) {
        out.identityEvidenceMode = _normalizeIdentityEvidenceMode('', out, scene, mediaType);
    }
    if (out.identityEvidenceMode === 'source-proven') {
        const sourceProof = new Set(out.mandatoryIdentity.map(norm));
        out.mandatoryVisible = _sanitizeMandatoryVisibleEntities(out.mandatoryVisible, out, scene, scriptContext)
            .filter(entity => !sourceProof.has(norm(entity)));
    } else if (out.identityEvidenceMode === 'either') {
        out.mandatoryVisible = _sanitizeMandatoryVisibleEntities(out.mandatoryVisible, out, scene, scriptContext);
    } else {
        out.mandatoryVisible = _sanitizeMandatoryVisibleEntities([
            ...out.mandatoryVisible,
            ...out.mandatoryIdentity,
        ], out, scene, scriptContext);
    }
    out = _ensureIdentityQueries(out, scene, mediaType);
    const addExclusion = (provider, reason) => {
        const key = providerKey(provider);
        if (!key) return;
        if (!out.providerExclusions.some(e => providerKey(e.provider) === key)) {
            out.providerExclusions.push({ provider: key, reason });
        }
        out.providerReality.push(`${key}: ${reason}`);
    };

    const exact = _requiresExactReference(out, scene, scriptContext);
    // Rescued scenes never require an exact reference — they are generic B-roll by design.
    if (scene && scene._retrievabilityRescued) exact.required = false;
    const mandatoryVisible = out.mandatoryVisible || [];
    const mandatoryIdentity = out.mandatoryIdentity || [];
    if (mediaType === 'image' && (exact.required || mandatoryVisible.length > 0 || mandatoryIdentity.length > 0)) {
        const anchorText = (mandatoryVisible.length ? mandatoryVisible : mandatoryIdentity.length ? mandatoryIdentity : exact.namedAnchors).slice(0, 3).join(', ');
        _lockProviderFamily(
            out,
            mediaType,
            'reference',
            ['bing', 'brave', ...stockProvidersFor(mediaType)],
            `exact/reference image prefers public image search, but free stock remains available as a build-saver${anchorText ? ` (${anchorText})` : ''}`,
            'reference-image'
        );
    } else if (mediaType === 'video' && (exact.required || mandatoryVisible.length > 0 || mandatoryIdentity.length > 0)) {
        const anchorText = (mandatoryVisible.length ? mandatoryVisible : mandatoryIdentity.length ? mandatoryIdentity : exact.namedAnchors).slice(0, 3).join(', ');
        _lockProviderFamily(
            out,
            mediaType,
            'hard',
            ['youtube', 'reddit', ...stockProvidersFor(mediaType)],
            `mandatory scene identity prefers real/public footage, but free stock remains available as a build-saver${anchorText ? ` (${anchorText})` : ''}`,
            'real-video'
        );
    }
    if (mandatoryIdentity.length > 0) {
        const note = `identity evidence: ${out.identityEvidenceMode || 'frame-visible'} for ${mandatoryIdentity.slice(0, 3).join(', ')}`;
        if (!out.providerReality.includes(note)) out.providerReality.push(note);
    }

    if (!exact.required && mandatoryVisible.length === 0 && mandatoryIdentity.length === 0 && mediaType === 'video') {
        // Concrete generic B-roll is exactly where stock libraries can be
        // strongest. Do not let the agent exclude free stock just because it
        // wants "real" or documentary-feeling footage; vision/title checks
        // will reject weak or unrelated stock results later.
        out.providerExclusions = out.providerExclusions
            .filter(e => !isStockProviderKey(e.provider));
        const styleRejectRe = /\b(stock[-\s]?like|stock footage|looks? too clean|too polished|saniti[sz]ed|generic stock)\b/i;
        out.mustAvoid = dedupe((out.mustAvoid || []).filter(item => !styleRejectRe.test(String(item || ''))), 14);
        out.rejectIf = dedupe((out.rejectIf || []).filter(item => !styleRejectRe.test(String(item || ''))), 12);
        const stockOrder = stockProvidersFor(mediaType);
        if (!out.providerOrder.map(providerKey).some(isStockProviderKey)) {
            out.providerOrder = normalizeProviderOrder([...out.providerOrder, ...stockOrder], mediaType, scene?.sourceHint || out.sourceHint || '', { hintFirst: false });
        }
        if (_isStockFriendlyGeneric(out, scene)) {
            const orderKeys = (out.providerOrder || []).map(providerKey).filter(Boolean);
            if (!isStockProviderKey(orderKeys[0])) {
                out.providerOrder = dedupe([...stockOrder, ...orderKeys, ...allowedProviders(mediaType)], 6);
            }
            const currentLock = normalizeProviderLock(out.providerLock, mediaType);
            if (currentLock.strength === 'open') {
                _lockProviderFamily(
                    out,
                    mediaType,
                    'soft',
                    stockOrder,
                    'stock-friendly generic scene; let free stock finish its candidate pass before web-video fallback',
                    'stock-broll'
                );
            }
            const note = 'provider reality: concrete generic B-roll, so free stock gets a protected first pass';
            if (!out.providerReality.includes(note)) out.providerReality.push(note);
        }
        const evidence = (out.providerEvidence || []).filter(row => providerKey(row.provider));
        const topEvidence = evidence[0] || null;
        if (isStockProviderKey(topEvidence?.provider) && Number(topEvidence.score || 0) >= 24) {
            const orderKeys = (out.providerOrder || []).map(providerKey).filter(Boolean);
            if (!isStockProviderKey(orderKeys[0])) {
                out.providerOrder = dedupe([...stockOrder, ...orderKeys, ...allowedProviders(mediaType)], 6);
                const note = `agent evidence: free stock has strongest pre-scout candidates (${Math.round(topEvidence.score)}), so try it early`;
                if (!out.providerReality.includes(note)) out.providerReality.push(note);
            }
        }
        const hintedProvider = sourceProvider(scene?.sourceHint || out.sourceHint || out.vpSourceHint || '', mediaType);
        if (isStockProviderKey(hintedProvider) && _isStockFriendlyGeneric(out, scene)) {
            const orderKeys = (out.providerOrder || []).map(providerKey).filter(Boolean);
            if (!isStockProviderKey(orderKeys[0])) {
                out.providerOrder = dedupe([...stockOrder, ...orderKeys, ...allowedProviders(mediaType)], 6);
                const note = 'provider reality: stock-friendly generic scene, so free stock gets first pass before web-video';
                if (!out.providerReality.includes(note)) out.providerReality.push(note);
            }
        }
    }

    if (mediaType === 'video') {
        const stockOrder = stockProvidersFor(mediaType);
        const hardLock = normalizeProviderLock(out.providerLock, mediaType);
        const hardLockExcludesStock = (hardLock.strength === 'hard' || hardLock.strength === 'reference')
            && hardLock.providers.length > 0
            && stockOrder.every(key => !hardLock.providers.includes(key));
        out.providerExclusions = out.providerExclusions.filter(e => !isStockProviderKey(e.provider));
        const orderKeys = (out.providerOrder || []).map(providerKey).filter(Boolean);
        if (!hardLockExcludesStock && !orderKeys.some(isStockProviderKey)) {
            out.providerOrder = normalizeProviderOrder([...orderKeys, ...stockOrder], mediaType, scene?.sourceHint || out.sourceHint || '', { hintFirst: false });
        }
        if (!hardLockExcludesStock) {
            const base = compactQuery(scene?.stockQuery || scene?.searchKeyword || scene?.keyword || scene?.visualIntent || '', 6);
            for (const key of stockOrder) {
                if (!out.queries[key] || out.queries[key].length === 0) {
                    out.queries[key] = dedupe([base, `${base} footage`].filter(Boolean), 5);
                }
            }
        }
    }

    out = _applyProviderLock(out, mediaType);

    const excluded = new Set(out.providerExclusions.map(e => providerKey(e.provider)).filter(Boolean));
    for (const key of STOCK_PROVIDERS) excluded.delete(key);
    if (excluded.size > 0) {
        const replacement = allowedProviders(mediaType).filter(key => !excluded.has(key));
        out.providerOrder = dedupe([
            ...(out.providerOrder || []).filter(key => !excluded.has(providerKey(key))),
            ...replacement,
        ], 6);
        for (const key of excluded) {
            if (out.queries[key]) out.queries[key] = [];
        }
        out.fallbackQueries = dedupe(out.fallbackQueries || [], 12);
    }

    const queryGuard = _sanitizeQueriesForScene(
        out.queries,
        out.fallbackQueries,
        scene,
        scriptContext,
        mediaType,
        out.keyword || primarySearch(scene, { keyword: plan?.keyword })
    );
    out.queries = queryGuard.queries;
    out.fallbackQueries = queryGuard.fallbackQueries;
    if (queryGuard.dropped.length > 0) {
        const note = `scene-local query guard: removed non-scene entity search terms (${queryGuard.dropped.slice(0, 8).join(', ')})`;
        if (!out.providerReality.includes(note)) out.providerReality.push(note);
    }
    out = _applyProviderLock(out, mediaType);

    return out;
}

function fallbackPlan(scene, scriptContext = {}, opts = {}) {
    const mediaType = opts.mediaType || scene?.mediaType || 'video';
    const sourceHint = opts.sourceHint || scene?.sourceHint || '';
    const keyword = primarySearch(scene, opts);
    const anchors = collectAnchors(scene, scriptContext, { ...opts, keyword });
    const base = compactQuery(keyword, mediaType === 'image' ? 8 : 7) || cleanSceneSubject(scene, scriptContext, { maxWords: mediaType === 'image' ? 8 : 7 });
    const stockBase = genericizeForStock(base, anchors);
    const isTemplateBg = !!scene?._templateBackupFootage || scene?.mediaIntent?.lane === 'templateBackground';
    const isReference = mediaType === 'image' || sourceProvider(sourceHint, mediaType) === 'bing';
    const role = isTemplateBg ? 'template-background' : isReference ? 'reference-still' : 'foreground-footage';
    const viewerNeed = isTemplateBg
        ? `background media that directly shows ${base || 'the scene subject'} behind the planned template`
        : isReference
        ? `exact still/reference image that directly shows ${base || 'the scene subject'}`
        : `real footage that visually shows ${base || 'the scene narration'}`;

    const providerOrder = normalizeProviderOrder([], mediaType, sourceHint, { hintFirst: true });
    const literalRequiredObjects = dedupe([base, stockBase], 10);
    const mustShow = isTemplateBg
        ? literalRequiredObjects
        : dedupe([base, ...anchors], 12);
    const entityPlan = _sceneEntityPlan(scene);
    const aiRequiredEntities = Array.isArray(entityPlan.requiredEntities) ? entityPlan.requiredEntities : [];
    const aiVisibleEntities = Array.isArray(entityPlan.visibleEntities) ? entityPlan.visibleEntities : [];
    const detectedIdentity = dedupe([
        ...aiRequiredEntities,
        ..._detectMandatoryVisibleEntities({ mustShow, literalRequiredObjects, subjectAnchors: anchors, viewerNeed }, scene, scriptContext),
    ], 10);
    const identityEvidenceMode = _normalizeIdentityEvidenceMode('', {
        role,
        viewerNeed,
        target: viewerNeed,
        mustShow,
        literalRequiredObjects,
        subjectAnchors: anchors,
    }, scene, mediaType);
    const queries = {
        youtube: dedupe([base, `${base} footage`, `${base} demo`, `${base} running`, `${base} close up`].map(q => compactQuery(q, 8)), 5),
        reddit: dedupe([base, `${base} footage`, `${base} real`, `${base} clip`].map(q => compactQuery(q, 8)), 4),
        pexels: dedupe([stockBase, `${stockBase} footage`, `${stockBase} close up`, base].map(q => compactQuery(q, 6)), 5),
        pixabay: dedupe([stockBase, `${stockBase} footage`, `${stockBase} close up`, base].map(q => compactQuery(q, 6)), 5),
        bing: dedupe([base, `${base} photo`, `${base} close up`, `${base} screenshot`].map(q => compactQuery(q, 8)), 5),
        brave: dedupe([base, `${base} photo`, `${base} close up`, `${base} screenshot`].map(q => compactQuery(q, 8)), 5),
    };
    const assetClass = isTemplateBg
        ? 'template-background-footage'
        : isReference
        ? 'exact-reference-still'
        : detectedIdentity.length > 0
        ? 'source-proven-or-reference-footage'
        : 'scene-footage';
    const minimumAcceptable = `A truthful asset that makes the scene readable: ${viewerNeed}`;
    const queryLanes = allowedProviders(mediaType).flatMap(provider => (queries[provider] || []).slice(0, 3).map((query, index) => ({
        provider,
        query,
        purpose: index === 0 ? 'primary scene search' : 'fallback phrasing',
        priority: 80 - index,
    })));

    const plan = {
        enabled: true,
        ai: false,
        version: 1,
        sourceAuthority: 'media-agent',
        vpSourceHint: sourceHint || '',
        role,
        assetClass,
        viewerNeed,
        target: viewerNeed,
        minimumAcceptable,
        literalRequiredObjects,
        subjectAnchors: anchors,
        mustShow,
        mandatoryIdentity: detectedIdentity,
        identityEvidenceMode,
        mandatoryVisible: identityEvidenceMode === 'source-proven' ? [] : detectedIdentity,
        niceToShow: dedupe([scene?.visualIntent, scene?.templateBgQuery, scene?.webQuery, scene?.stockQuery], 8),
        mustAvoid: GENERIC_AVOID.slice(),
        rejectIf: GENERIC_AVOID.slice(0, 7),
        providerOrder,
        providerLock: { strength: 'open', family: 'open', providers: [], reason: '' },
        queries,
        providerEvidence: _scoutProviderEvidence(scene),
        fallbackQueries: dedupe([base, stockBase, ...(queries.youtube || []), ...(queries.bing || [])], 10),
        searchStrategy: {
            assetClass,
            primaryProvider: providerOrder[0] || '',
            providerReasoning: 'fallback draft from scene metadata',
            minimumAcceptable,
            queryLanes,
            repairStrategy: [],
            droppedNonLocalEntities: [],
        },
        acceptanceTest: `Accept only if the asset would make the narration visually obvious: ${viewerNeed}.`,
        sceneEntities: entityPlan,
        sourceHint,
        mediaType,
        keyword: base,
    };
    if (aiVisibleEntities.length > 0) {
        plan.mandatoryVisible = dedupe([...aiVisibleEntities, ...plan.mandatoryVisible], 10);
    }
    return applyProviderReality(plan, scene, scriptContext, mediaType);
}

function parseJsonObject(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
}

function validateMediaAgentJson(parsed) {
    if (!parsed || typeof parsed !== 'object') return 'plan must be a JSON object';
    if (!clean(parsed.viewerNeed) && !clean(parsed.target)) return 'viewerNeed or target is required';
    if (parsed.providerOrder !== undefined && !Array.isArray(parsed.providerOrder)) return 'providerOrder must be an array';
    if (parsed.providerExclusions !== undefined && !Array.isArray(parsed.providerExclusions)) return 'providerExclusions must be an array';
    if (parsed.queries !== undefined && (!parsed.queries || typeof parsed.queries !== 'object' || Array.isArray(parsed.queries))) return 'queries must be an object';
    if (parsed.searchStrategy !== undefined && (!parsed.searchStrategy || typeof parsed.searchStrategy !== 'object' || Array.isArray(parsed.searchStrategy))) return 'searchStrategy must be an object';
    return true;
}

function withTimeout(promise, ms, label) {
    let timeoutId = null;
    const timeout = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
    });
}

function normalizePlan(parsed, fallback, mediaType, sourceHint, scene = {}, scriptContext = {}) {
    const scoutEvidence = _scoutProviderEvidence(scene);
    const plan = {
        ...fallback,
        ai: true,
        sourceAuthority: 'media-agent',
        vpSourceHint: sourceHint || '',
        role: clean(parsed?.role) || fallback.role,
        assetClass: clean(parsed?.assetClass || parsed?.searchStrategy?.assetClass) || fallback.assetClass || fallback.role,
        viewerNeed: clean(parsed?.viewerNeed) || fallback.viewerNeed,
        target: clean(parsed?.target) || clean(parsed?.viewerNeed) || fallback.target,
        minimumAcceptable: short(parsed?.minimumAcceptable || parsed?.searchStrategy?.minimumAcceptable || fallback.minimumAcceptable || fallback.acceptanceTest || '', 360),
        literalRequiredObjects: dedupe(listValue(parsed?.literalRequiredObjects).length ? listValue(parsed.literalRequiredObjects) : (fallback.literalRequiredObjects || fallback.mustShow), 12),
        subjectAnchors: dedupe(listValue(parsed?.subjectAnchors).length ? listValue(parsed.subjectAnchors) : fallback.subjectAnchors, 12),
        mustShow: dedupe(listValue(parsed?.mustShow).length ? listValue(parsed.mustShow) : fallback.mustShow, 14),
        mandatoryIdentity: [],
        identityEvidenceMode: clean(parsed?.identityEvidenceMode || parsed?.identityEvidence || fallback.identityEvidenceMode || ''),
        mandatoryVisible: [],
        niceToShow: dedupe(listValue(parsed?.niceToShow).length ? listValue(parsed.niceToShow) : fallback.niceToShow, 10),
        mustAvoid: dedupe(listValue(parsed?.mustAvoid).length ? listValue(parsed.mustAvoid) : fallback.mustAvoid, 14),
        rejectIf: dedupe(listValue(parsed?.rejectIf).length ? listValue(parsed.rejectIf) : fallback.rejectIf, 12),
        textIsSubject: parsed?.textIsSubject === true || (parsed?.textIsSubject === undefined && fallback.textIsSubject === true),
        providerOrder: normalizeProviderOrder(parsed?.providerOrder || fallback.providerOrder, mediaType, sourceHint, { hintFirst: !Array.isArray(parsed?.providerOrder) || parsed.providerOrder.length === 0 }),
        providerLock: normalizeProviderLock(parsed?.providerLock || {
            strength: parsed?.providerLockStrength,
            providers: parsed?.providerLockProviders || parsed?.lockedProviders,
            reason: parsed?.providerLockReason,
            family: parsed?.providerFamily,
        }, mediaType),
        queries: { ...fallback.queries },
        providerExclusions: Array.isArray(parsed?.providerExclusions) ? parsed.providerExclusions : fallback.providerExclusions,
        providerReality: Array.isArray(parsed?.providerReality) ? parsed.providerReality : fallback.providerReality,
        providerEvidence: scoutEvidence,
        fallbackQueries: dedupe(listValue(parsed?.fallbackQueries).length ? listValue(parsed.fallbackQueries) : fallback.fallbackQueries, 12),
        searchStrategy: normalizeSearchStrategy(parsed, fallback, mediaType, scene, scriptContext),
        acceptanceTest: clean(parsed?.acceptanceTest) || fallback.acceptanceTest,
        sceneEntities: scene?._sceneEntityPlan || fallback.sceneEntities || EMPTY_SCENE_ENTITY_PLAN,
    };
    if (!plan.searchStrategy.assetClass) plan.searchStrategy.assetClass = plan.assetClass;
    if (!plan.searchStrategy.minimumAcceptable) plan.searchStrategy.minimumAcceptable = plan.minimumAcceptable;
    if (plan.searchStrategy.droppedNonLocalEntities?.length) {
        const note = `scene-local query-lane guard: removed non-scene entity search terms (${plan.searchStrategy.droppedNonLocalEntities.slice(0, 8).join(', ')})`;
        if (!plan.providerReality.includes(note)) plan.providerReality.push(note);
    }

    plan.mandatoryVisible = _sanitizeMandatoryVisibleEntities([
        ...(Array.isArray(plan.sceneEntities?.visibleEntities) ? plan.sceneEntities.visibleEntities : []),
        ...listValue(parsed?.mandatoryVisible),
    ], plan, scene, scriptContext);
    plan.mandatoryIdentity = _sanitizeMandatoryVisibleEntities([
        ...(Array.isArray(plan.sceneEntities?.requiredEntities) ? plan.sceneEntities.requiredEntities : []),
        ...listValue(parsed?.mandatoryIdentity),
        ...listValue(parsed?.mandatoryVisible),
        ...(fallback.mandatoryIdentity || []),
        ...(fallback.mandatoryVisible || []),
        ..._detectMandatoryVisibleEntities(plan, scene, scriptContext),
    ], plan, scene, scriptContext);
    plan.identityEvidenceMode = _normalizeIdentityEvidenceMode(plan.identityEvidenceMode, plan, scene, mediaType);
    if (plan.identityEvidenceMode === 'none' && plan.mandatoryIdentity.length > 0) {
        plan.identityEvidenceMode = _normalizeIdentityEvidenceMode('', plan, scene, mediaType);
    }
    if (plan.identityEvidenceMode === 'source-proven') {
        const sourceProof = new Set(plan.mandatoryIdentity.map(norm));
        plan.mandatoryVisible = plan.mandatoryVisible.filter(entity => !sourceProof.has(norm(entity)));
    } else if (plan.identityEvidenceMode === 'frame-visible') {
        plan.mandatoryVisible = _sanitizeMandatoryVisibleEntities([
            ...plan.mandatoryVisible,
            ...plan.mandatoryIdentity,
        ], plan, scene, scriptContext);
    }

    const allowed = new Set(allowedProviders(mediaType));
    const parsedQueries = parsed?.queries && typeof parsed.queries === 'object' ? parsed.queries : {};
    for (const key of [...VIDEO_PROVIDERS, ...IMAGE_PROVIDERS, 'storyblocks']) {
        const mapped = providerKey(key);
        if (!mapped || !allowed.has(mapped)) continue;
        const values = Array.isArray(parsedQueries[key]) ? parsedQueries[key]
            : Array.isArray(parsedQueries[mapped]) ? parsedQueries[mapped]
            : [];
        const maxWords = isStockProviderKey(mapped) ? 6 : 8;
        plan.queries[mapped] = dedupe([
            ...values.map(q => compactQuery(q, maxWords)),
            ..._identityQueryExpansions(plan, scene, mapped, mediaType),
            ...(fallback.queries[mapped] || []),
        ], 6);
    }

    if (plan.mustShow.length === 0) plan.mustShow = fallback.mustShow;
    if (!Array.isArray(plan.literalRequiredObjects) || plan.literalRequiredObjects.length === 0) {
        plan.literalRequiredObjects = fallback.literalRequiredObjects || fallback.mustShow || [];
    }
    if (plan.providerOrder.length === 0) plan.providerOrder = fallback.providerOrder;
    return applyProviderReality(plan, scene, scriptContext, mediaType);
}

function cacheKey(scene, scriptContext = {}, opts = {}) {
    const evidenceSig = _scoutProviderEvidence(scene)
        .map(row => `${row.provider}:${Math.round(row.score || 0)}:${Math.round(row.top || 0)}`)
        .join(',');
    return [
        sceneIndex(scene) ?? 'x',
        opts.mediaType || scene?.mediaType || '',
        opts.sourceHint || scene?.sourceHint || '',
        clean(scene?.visualIntent || ''),
        clean(scene?.templateBgQuery || ''),
        clean(opts.keyword || scene?._forcedSearchKeyword || ''),
        clean(scene?.text || '').slice(0, 180),
        clean(scriptContext?.nicheId || ''),
        evidenceSig,
    ].join('|').toLowerCase();
}

function sceneRows(scene, scriptContext = {}, opts = {}) {
    const entities = Array.isArray(scriptContext?.entities) ? scriptContext.entities.slice(0, 20).join(', ') : '';
    const protectedTerms = Array.isArray(scene?.protectedTerms) ? scene.protectedTerms.join(', ') : '';
    const entityContext = Array.isArray(scene?.entityContext) ? scene.entityContext.join(', ') : '';
    const entityPlan = _sceneEntityPlan(scene);
    const sceneEntityLine = entityPlan?.ai
        ? `Scene entity resolver: required=[${(entityPlan.requiredEntities || []).join(', ') || 'none'}], visible=[${(entityPlan.visibleEntities || []).join(', ') || 'none'}], context-only=[${(entityPlan.contextualEntities || []).slice(0, 10).join(', ') || 'none'}]`
        : `Scene entity resolver: unavailable${entityPlan?.error ? ` (${entityPlan.error})` : ''}`;
    const scoutEvidence = _scoutProviderEvidence(scene)
        .map(row => `${row.provider} score=${Math.round(row.score)} top=${Math.round(row.top)}`)
        .join(' | ');
    return [
        `Scene index: ${sceneIndex(scene) ?? '-'}`,
        `Video topic: ${clean(scriptContext?.topic || scriptContext?.title || scriptContext?.videoTitle || '') || '-'}`,
        `Niche/format: ${clean(scriptContext?.nicheId || '') || '-'} / ${clean(scriptContext?.format || '') || '-'}`,
        `Narration: ${short(scene?.text || scene?.transcript || '', 520) || '-'}`,
        `VP keyword: ${primarySearch(scene, opts) || '-'}`,
        `VP visual intent: ${short(scene?.visualIntent || '', 360) || '-'}`,
        `Template hint: ${clean(scene?.templateHint || '') || '-'}${(scene?._templateBackupFootage || scene?.mediaIntent?.lane === 'templateBackground') ? ' (background media required)' : ''}`,
        `Template bg query: ${clean(scene?.templateBgQuery || '') || '-'}`,
        `Media lane: ${opts.mediaType || scene?.mediaType || '-'} / legacy VP source hint (soft only): ${opts.sourceHint || scene?.sourceHint || '-'} / ${scene?.mediaIntent?.lane || '-'}`,
        `Topic Scout evidence (not authority): ${scoutEvidence || '-'}`,
        `Protected terms: ${protectedTerms || '-'}`,
        `Scene entity context: ${entityContext || '-'}`,
        sceneEntityLine,
        `Build entities (context only; do not copy all into mandatoryVisible): ${entities || '-'}`,
    ].join('\n');
}

async function buildMediaAgentPlan(scene, scriptContext = {}, opts = {}) {
    const mediaType = opts.mediaType || scene?.mediaType || 'video';
    const sourceHint = opts.sourceHint || scene?.sourceHint || '';
    if (scene && !scene._sceneEntityPlan) {
        scene._sceneEntityPlan = await resolveSceneEntityPlan(scene, scriptContext, opts);
        const entityPlan = scene._sceneEntityPlan;
        if (entityPlan?.ai) {
            const required = entityPlan.requiredEntities?.join(', ') || 'none';
            const contextOnly = entityPlan.contextualEntities?.slice(0, 5).join(', ') || 'none';
            console.log(`  [Scene Entities] required=${required}; context-only=${contextOnly}${entityPlan.reason ? ` (${entityPlan.reason})` : ''}`);
        } else if (entityPlan?.error) {
            console.log(`  [Scene Entities] resolver fallback (${entityPlan.error})`);
        }
    }
    const fallback = fallbackPlan(scene, scriptContext, opts);
    if (!scene) return fallback;

    const key = cacheKey(scene, scriptContext, opts);
    if (scene._mediaAgentPlan && scene._mediaAgentPlan._cacheKey === key) {
        return scene._mediaAgentPlan;
    }

    if (config.mediaAgent?.enabled === false || config.mediaAgent?.useAI === false || opts.ai === false) {
        scene._mediaAgentPlan = { ...fallback, _cacheKey: key };
        return scene._mediaAgentPlan;
    }

    const providerCaps = mediaType === 'image'
        ? `Bing/Brave Images = exact public/reference stills. Pexels/Pixabay = free generic stock images; they are usually bad for exact brands, logos, screenshots, documents, UI, comments, named people, or specific public products.`
        : `YouTube = real demos/reviews/events/tutorials/documentary footage. Reddit = real user clips. Pexels/Pixabay = free generic stock B-roll and can be excellent for concrete generic visuals like hands using tools, repairs, factories, warehouses, appliances, retail shelves, labs, roads, kitchens, workshops, and facilities. Pexels/Pixabay are usually bad only when the scene needs exact brands, logos, model plates, screenshots, named public products, current events, or proof shots.`;
    const fallbackJson = JSON.stringify({
        viewerNeed: fallback.viewerNeed,
        role: fallback.role,
        literalRequiredObjects: fallback.literalRequiredObjects.slice(0, 8),
        mandatoryIdentity: (fallback.mandatoryIdentity || []).slice(0, 8),
        identityEvidenceMode: fallback.identityEvidenceMode || '',
        mandatoryVisible: (fallback.mandatoryVisible || []).slice(0, 8),
        subjectAnchors: fallback.subjectAnchors.slice(0, 8),
        providerOrder: fallback.providerOrder,
        providerLock: fallback.providerLock,
        queries: fallback.queries,
        assetClass: fallback.assetClass,
        minimumAcceptable: fallback.minimumAcceptable,
        searchStrategy: fallback.searchStrategy,
    }, null, 2);

    const prompt = `You are the footage collection agent for a documentary editor.
Your job is NOT to classify the niche. Your job is to decide what the audience should SEE for this exact scene.

Inputs:
${sceneRows(scene, scriptContext, opts)}

Provider capabilities:
${providerCaps}

Think like a human editor:
- The asset must visually serve the narration, not merely share a broad category.
- This must work for ANY topic: breaking news, war, politics, history, nature, science, crime, sports, business, product reviews, local events, maps, archives, or generic B-roll. Do not rely on niche labels; build the strategy from this scene only.
- First decide the assetClass: exact event/news footage, archive/history material, source-proven process/facility footage, exact reference still/screenshot/document, generic licensed B-roll, map/data visual, metaphor/symbolic B-roll, or template background. This is a reasoning label, not a hardcoded niche.
- Write provider-specific query lanes. A lane is what a human researcher would actually type into that provider. Use different lanes for exact real footage, source-proven footage, public/reference stills, archive material, and generic B-roll.
- For exact/current/specific events, named people, public incidents, war footage, news events, official statements, or historical archive needs, use real/public/reference providers and source-proven query lanes before generic stock.
- For generic actions/settings with no mandatory named identity, let licensed stock compete; do not waste time on public-video providers when a clean stock shot truthfully satisfies the scene.
- Global visual style: translate abstract ideas into hands-on, concrete action. Prefer closeups of people building, repairing, testing, using tools/products, before-after comparisons, workbenches, kitchens, stores, labs, factories, and real objects moving. Avoid abstract documentary mood shots unless the scene explicitly needs an establishing shot.
- Define minimumAcceptable: the simplest truthful asset that would still communicate the scene if the perfect shot is unavailable. Do not over-perfect, but never accept a misleading asset.
- Decide what KIND of visual evidence is enough for this scene. Direct proof is best, but a truthful evidence/proxy visual is acceptable when it clearly communicates the viewer need: a visible label/sign/marking, object detail, packaging, document/UI/screen, facility/process, retail context, or same-category action can be enough if the scene does not require an exact named identity.
- Put that evidence threshold into minimumAcceptable and acceptanceTest. The vision judge will use your words as the contract, so write them like a practical editor: "accept if the viewer can understand X from visible evidence/context", not "only accept the perfect literal shot".
- For template/background scenes, pick background footage that supports the card while still showing the concrete subject.
 - Preserve exact brands/products/people/orgs when the CURRENT scene depends on them. If the scene narration, keyword, or visual intent says a named brand/product/person/org, put it in mandatoryIdentity.
 - mandatoryIdentity must contain ONLY real-world proper nouns: brand names, product names, people, organizations, places. NEVER include verb phrases, idioms, descriptive phrases, or common nouns that you Title-Cased. If the scene text writes a phrase in lowercase or hyphenated form (e.g. "sell-out", "hands-on", "before-after", "top-loader", "buy it for life"), it is NOT an entity — leave it out. Test: would this phrase appear capitalized in the scene narration itself? If not, do not put it in mandatoryIdentity.
 - mandatoryIdentity must contain ONLY named entities present in this exact scene's narration, keyword, or visual intent. Do not copy unrelated Build entities from the full video. When the scene is generic B-roll (factory floor, workshop, kitchen, store aisle) with no specific brand visible, mandatoryIdentity MUST be empty — do not invent identities from descriptive language.
 - CRITICAL: visualIntent / templateBgQuery / bgQuery describe the CARD DESIGN — including its subheaders, button labels, slogans, and other display text. Any Title-Cased phrase that appears as CARD TEXT (e.g. a card subheader saying "Refused to Sell Out", "Made to Last", "Buy Once Cry Once") is NOT an entity. Those phrases are graphics on top of the card, not things the background footage must prove. For role=template-background, the background just needs to match the topic — never put card text into mandatoryIdentity.
 - Decide identityEvidenceMode:
   - "frame-visible" when the viewer must read/see the brand/person/model in the actual frame (logo, label, screen, control panel, screenshot, document, product close-up, exact still).
   - "source-proven" when the source title/page can prove the identity and the frame only needs to show the right real-world process/setting (factory tour, facility, manufacturing, production line, official/company/documentary/process footage, product demo, wash/action/operation footage where the logo cannot naturally stay visible during the action).
   - "either" only when either proof path is acceptable.
 - mandatoryVisible is ONLY for entities that must be identifiable inside the image/video frame. For source-proven factory/facility/process/action footage, leave mandatoryVisible empty and use mandatoryIdentity + identityEvidenceMode="source-proven".
- Do not demand a perfect shot. Framing/style/running/action are softer preferences unless the narration explicitly requires them.
- Use generic stock only when the scene truly wants generic B-roll.
- The legacy VP source hint is only a soft prior from the visual planner. You own the final providerOrder.
- Topic Scout evidence is only evidence from previous provider searches. Use it when it proves a provider is promising, but do not blindly obey it.
- Decide providerLock:
  - "hard" when only one provider family can realistically satisfy the scene.
  - "reference" for exact stills/screenshots/product images that must come from public image search.
  - "soft" when one provider should go first but fallback providers can still satisfy the scene.
  - "open" when multiple providers can compete.
- For video with mandatoryIdentity that must be source-proven or visible, put real/public video providers first (YouTube, Reddit), but do NOT exclude Pexels/Pixabay. Free stock is allowed as a build-saver fallback if it has usable contextual footage.
- For image/reference stills with mandatoryIdentity or exact screenshots/documents/UI/product images, lock to Bing/Brave Images.
- For generic B-roll with no mandatoryIdentity, do not hard-lock away from Pexels/Pixabay; let free stock compete early.
- For concrete generic B-roll with strong free-stock evidence, try Pexels/Pixabay early enough to leave time for vision scoring.
- Do not lock based on full-video entities alone. Lock only from current-scene narration, keyword, visual intent, source query, or the Scene entity resolver.
- For mandatory named brands/products/people/orgs, public figures, exact models, or exact screenshots, prefer real/public/reference sources first and explain the lock or exclusion.
- Use Pexels/Pixabay when a concrete generic visual would satisfy the scene without needing an exact named thing visible.
- Do not reject footage merely because it looks like licensed stock. Reject it only if the visible subject is wrong, too generic, fake/staged in a misleading way, or fails the must-show list.
 - Prefer search phrases a provider can actually find. Preserve multiple query lanes: direct scene/action query first when the scene names an action/object ("Speed Queen top loader washer running"), source-proven process queries when useful ("[entity] manufacturing facility tour", "[entity] factory tour", "[entity] production line"), and generic fallback only as fallback.
- Separate display text / nicknames / metaphors from literal on-screen objects. If a card says "Laundry Tank" but the audience should see washing machines, "tank" is NOT a literalRequiredObject.
- textIsSubject: set TRUE only when the asset you are deliberately planning IS an inherently-textual object — a book cover, album/record cover, movie/event poster, magazine/newspaper front page, a sign, a plaque, or a document — where the printed/cover text belongs to the object itself and is the whole point of the shot. In that case the vision judge will NOT treat the object's own cover text as an editorial-overlay defect. Set FALSE (default) for normal footage, portraits, photos, and any scene where on-image headline/banner text would be an article-cover defect. Do not set TRUE just to bypass quality checks — only when a titled physical object is genuinely the intended subject.

Fallback draft you may improve:
${fallbackJson}

Output ONLY JSON:
{
  "role": "foreground-footage|template-background|reference-still|generic-broll",
  "assetClass": "short reasoning label such as exact-event-footage, source-proven-process-footage, exact-reference-still, archive-footage, generic-broll, map-data-visual, metaphor-broll, template-background",
  "viewerNeed": "one plain sentence describing what should be seen",
  "target": "short visual target for vision/title judging",
  "minimumAcceptable": "simplest truthful asset that is still acceptable if the perfect shot is unavailable",
  "literalRequiredObjects": ["physical objects/settings that must literally appear on screen; no metaphors, idioms, card titles, lower-third text, or nicknames"],
  "mandatoryIdentity": ["named brands/products/people/orgs from the current scene that must be proven; empty if none"],
  "identityEvidenceMode": "frame-visible|source-proven|either|none",
  "mandatoryVisible": ["subset of mandatoryIdentity that MUST be visible/identifiable in the actual frame; empty for source-proven factory/facility/process footage"],
  "subjectAnchors": ["literal visible anchors"],
  "mustShow": ["things that make the result acceptable"],
  "niceToShow": ["secondary useful signals"],
  "mustAvoid": ["things that would make the edit wrong"],
  "rejectIf": ["clear rejection reasons"],
  "textIsSubject": false,
  "providerOrder": ["youtube|pexels|pixabay|reddit|bing|brave"],
  "providerLock": {"strength":"open|soft|hard|reference", "family":"real-video|reference-image|stock-broll|open", "providers":["youtube|reddit|pexels|pixabay|bing|brave"], "reason":"why this lock is necessary"},
  "providerExclusions": [{"provider":"youtube|reddit|pexels|pixabay|bing|brave", "reason":"why it cannot satisfy this scene"}],
  "providerReality": ["short provider-fit notes"],
  "searchStrategy": {
    "assetClass": "same reasoning label",
    "primaryProvider": "youtube|pexels|pixabay|reddit|bing|brave",
    "providerReasoning": "why the provider order fits this exact scene",
    "minimumAcceptable": "same simplest truthful acceptable asset",
    "queryLanes": [
      {"provider":"youtube|pexels|pixabay|reddit|bing|brave", "query":"provider-specific search phrase", "purpose":"why this query lane exists", "priority":100}
    ],
    "repairStrategy": ["how to change the search if early candidates fail"]
  },
  "queries": {
    "youtube": ["query"],
    "pexels": ["query"],
    "pixabay": ["query"],
    "reddit": ["query"],
    "bing": ["query"],
    "brave": ["query"]
  },
  "fallbackQueries": ["query"],
  "acceptanceTest": "one sentence a vision judge can apply"
}`;

    try {
        const timeoutMs = Math.max(5000, Number(config.mediaAgent?.timeoutMs || 45000));
        console.log(`  [Media Agent] mission AI request timeout=${Math.round(timeoutMs / 1000)}s`);
        const parsed = await withTimeout(callAIJson(prompt, {
            label: 'Media Agent mission',
            maxTokens: Math.max(500, Number(config.mediaAgent?.maxTokens || 1500)),
            temperature: 0.2,
            taskType: 'general',
            maxRetries: 2,
            schemaDescription: '{"role":"...","viewerNeed":"...","target":"...","providerOrder":[],"providerLock":{},"providerExclusions":[],"searchStrategy":{},"queries":{},"fallbackQueries":[],"acceptanceTest":"..."}',
            validate: validateMediaAgentJson,
        }), timeoutMs, 'Media Agent mission');
        const plan = normalizePlan(parsed, fallback, mediaType, sourceHint, scene, scriptContext);
        scene._mediaAgentPlan = { ...plan, _cacheKey: key };
        return scene._mediaAgentPlan;
    } catch (err) {
        console.log(`  [Media Agent] mission fallback: ${err?.message || String(err)}`);
        const plan = {
            ...fallback,
            ai: false,
            error: err?.message || String(err),
            _cacheKey: key,
        };
        scene._mediaAgentPlan = plan;
        return plan;
    }
}

function repairFailureRows(failureContext = {}) {
    const rows = Array.isArray(failureContext.providers) ? failureContext.providers : [];
    const usefulRows = rows
        .filter(row => row && (row.provider || row.key || row.query || row.reason || row.status))
        .slice(-32);
    if (usefulRows.length === 0) return 'No structured failure rows were recorded.';
    return usefulRows.map((row, index) => {
        const provider = clean(row.provider || row.key || 'provider');
        const status = clean(row.status || 'info');
        const query = row.query ? ` query="${short(row.query, 90)}"` : '';
        const reason = row.reason ? ` reason="${short(row.reason, 140)}"` : '';
        const resultCount = Number.isFinite(Number(row.resultCount)) ? ` results=${Number(row.resultCount)}` : '';
        const selected = row.selected?.title || row.selected?.url
            ? ` selected="${short(row.selected.title || row.selected.url, 120)}"`
            : '';
        const candidates = Array.isArray(row.candidates) && row.candidates.length
            ? ` candidates=[${row.candidates.slice(0, 4).map(candidate => {
                const title = short(candidate?.title || candidate?.url || '', 90);
                const why = candidate?.reason ? ` (${short(candidate.reason, 70)})` : '';
                const url = candidate?.url ? ` <${short(candidate.url, 90)}>` : '';
                return `${title}${why}${url}`;
            }).filter(Boolean).join(' | ')}]`
            : '';
        return `${index + 1}. ${provider}:${status}${query}${resultCount}${reason}${selected}${candidates}`;
    }).join('\n').slice(0, 9000);
}

function repairCurrentPlanSnapshot(plan = {}) {
    if (!plan) return '{}';
    return JSON.stringify({
        role: plan.role || '',
        assetClass: plan.assetClass || plan.searchStrategy?.assetClass || '',
        viewerNeed: plan.viewerNeed || '',
        target: plan.target || '',
        minimumAcceptable: plan.minimumAcceptable || plan.searchStrategy?.minimumAcceptable || '',
        providerOrder: plan.providerOrder || [],
        providerLock: plan.providerLock || {},
        providerExclusions: plan.providerExclusions || [],
        mandatoryIdentity: (plan.mandatoryIdentity || []).slice(0, 8),
        identityEvidenceMode: plan.identityEvidenceMode || '',
        mandatoryVisible: (plan.mandatoryVisible || []).slice(0, 8),
        mustShow: (plan.mustShow || []).slice(0, 8),
        searchStrategy: plan.searchStrategy ? {
            providerReasoning: plan.searchStrategy.providerReasoning || '',
            queryLanes: (plan.searchStrategy.queryLanes || []).slice(0, 14),
            repairStrategy: (plan.searchStrategy.repairStrategy || []).slice(0, 8),
        } : null,
        queries: plan.queries || {},
    }, null, 2);
}

async function buildMediaAgentRepairPlan(scene, scriptContext = {}, currentPlan = null, failureContext = {}, opts = {}) {
    const mediaType = opts.mediaType || scene?.mediaType || currentPlan?.mediaType || 'video';
    const sourceHint = opts.sourceHint || scene?.sourceHint || currentPlan?.sourceHint || '';
    if (!scene) return null;
    if (config.mediaAgent?.enabled === false || config.mediaAgent?.useAI === false || opts.ai === false) {
        return null;
    }
    if (!scene._sceneEntityPlan) {
        scene._sceneEntityPlan = await resolveSceneEntityPlan(scene, scriptContext, opts);
    }

    const fallback = currentPlan?.enabled
        ? currentPlan
        : fallbackPlan(scene, scriptContext, opts);
    const providerCaps = mediaType === 'image'
        ? `Bing/Brave Images = exact public/reference stills. Pexels/Pixabay = free generic stock images, not exact screenshots/logos/documents unless the need is generic.`
        : `YouTube = broad real/public footage. Reddit = real user clips. Pexels/Pixabay = free generic stock B-roll; strong for hands-on generic settings/actions, weak for exact named identities or source-proof.`;
    const failureRows = repairFailureRows(failureContext);
    const planSnapshot = repairCurrentPlanSnapshot(fallback);

    const prompt = `You are the media repair agent for a documentary footage collection system.
The first search pass FAILED. Repair the mission globally and intelligently, like a human footage researcher.

Scene:
${sceneRows(scene, scriptContext, opts)}

Current failed plan:
${planSnapshot}

Provider capabilities:
${providerCaps}

Failure evidence from the actual run:
${failureRows}

Your task:
- Diagnose why the current plan failed: wrong provider, wrong query lane, too strict target, too literal metaphor, bad source proof requirement, or poor minimumAcceptable.
- Produce a revised Media Agent plan that the existing parallel candidate army can run again.
- Do NOT repeat the same failed query lanes unless the evidence says the query was good but the provider/download had a transient failure.
- Stay scene-local. Mandatory identities must be present in this exact scene narration, keyword, visual intent, or query. Full-video entities are context only.
- If the scene needs exact named identity, source-proven public footage, public events, history, news, war, politics, product proof, screenshots, documents, UI, maps, or specific places, choose the provider family that can prove it.
- If the scene only needs concrete generic B-roll, let stock compete and write stock-searchable phrases.
- When a plan is abstract, repair it into hands-on concrete visuals: people building, repairing, testing, using tools/products, process closeups, workbenches, stores, kitchens, labs, factories, and real objects moving.
- If exact/reference media failed, build a truthful approximation ladder: exact artifact -> visible label/stamp/sign/UI/product marking -> same object/action/location context -> broader concept B-roll. Never accept unrelated objects just because they are visually convenient.
- For category/claim scenes, keep the meaning of the claim as the acceptance anchor even when no named brand is required. A visible sign, label, marking, screen, document, packaging, facility/process, or same-category object/action can satisfy the scene if it truthfully communicates what the viewer needs.
- Search-only exemplars are allowed when they clarify the category; use them as query hints, not mandatory identity unless the scene itself names them.
- If a direct proof query fails, produce progressively broader provider-specific lanes that preserve the evidence type before escaping to generic B-roll.
- If the first plan was too perfect, soften minimumAcceptable while preserving the mandatory visible/proven thing the audience needs.
- If one provider family is correct, keep trying that family with better lanes instead of escaping to a bad provider.
- Output only JSON using the same schema below.

Output ONLY JSON:
{
  "role": "foreground-footage|template-background|reference-still|generic-broll",
  "assetClass": "reasoning label",
  "viewerNeed": "what the audience should see",
  "target": "short visual target for judging",
  "minimumAcceptable": "simplest truthful acceptable asset",
  "literalRequiredObjects": ["literal physical objects/settings only"],
  "mandatoryIdentity": ["scene-local named brands/products/people/orgs only"],
  "identityEvidenceMode": "frame-visible|source-proven|either|none",
  "mandatoryVisible": ["subset of mandatoryIdentity that must be visible in frame"],
  "subjectAnchors": ["visible anchors"],
  "mustShow": ["acceptance signals"],
  "niceToShow": ["soft preferences"],
  "mustAvoid": ["wrong/misleading things"],
  "rejectIf": ["clear rejection reasons"],
  "providerOrder": ["youtube|pexels|pixabay|reddit|bing|brave"],
  "providerLock": {"strength":"open|soft|hard|reference", "family":"real-video|reference-image|stock-broll|open", "providers":["youtube|reddit|pexels|pixabay|bing|brave"], "reason":"why"},
  "providerExclusions": [{"provider":"youtube|reddit|pexels|pixabay|bing|brave", "reason":"why"}],
  "providerReality": ["short notes explaining provider fit"],
  "searchStrategy": {
    "assetClass": "same reasoning label",
    "primaryProvider": "youtube|pexels|pixabay|reddit|bing|brave",
    "providerReasoning": "why this revised provider order fixes the failure",
    "minimumAcceptable": "same simplest truthful acceptable asset",
    "queryLanes": [
      {"provider":"youtube|pexels|pixabay|reddit|bing|brave", "query":"new provider-specific search phrase", "purpose":"why this lane should work after the failure", "priority":100}
    ],
    "repairStrategy": ["what to try next if these lanes fail"]
  },
  "queries": {
    "youtube": ["query"],
    "pexels": ["query"],
    "pixabay": ["query"],
    "reddit": ["query"],
    "bing": ["query"],
    "brave": ["query"]
  },
  "fallbackQueries": ["query"],
  "acceptanceTest": "one sentence a vision judge can apply"
}`;

    try {
        const timeoutMs = Math.max(5000, Number(config.mediaAgent?.repairTimeoutMs || config.mediaAgent?.timeoutMs || 45000));
        console.log(`  [Media Repair] AI repair request timeout=${Math.round(timeoutMs / 1000)}s`);
        const parsed = await withTimeout(callAIJson(prompt, {
            label: 'Media Agent repair',
            maxTokens: Math.max(700, Number(config.mediaAgent?.repairMaxTokens || config.mediaAgent?.maxTokens || 1500)),
            temperature: 0.25,
            taskType: 'general',
            maxRetries: 2,
            schemaDescription: '{"role":"...","viewerNeed":"...","target":"...","providerOrder":[],"providerLock":{},"providerExclusions":[],"searchStrategy":{},"queries":{},"fallbackQueries":[],"acceptanceTest":"..."}',
            validate: validateMediaAgentJson,
        }), timeoutMs, 'Media Agent repair');
        const plan = normalizePlan(parsed, fallback, mediaType, sourceHint, scene, scriptContext);
        plan.repair = true;
        plan.repairReason = clean(parsed?.repairReason || parsed?.diagnosis || failureContext?.summary || 'provider pass failed');
        plan.repairOf = failureContext?.summary || '';
        plan.version = Math.max(2, Number(plan.version || 1));
        return plan;
    } catch (err) {
        console.log(`  [Media Repair] AI repair unavailable: ${err?.message || String(err)}`);
        return null;
    }
}

function summarizeMediaAgentPlan(plan) {
    if (!plan) return null;
    return {
        ai: Boolean(plan.ai),
        repair: Boolean(plan.repair),
        repairReason: plan.repairReason || '',
        role: plan.role,
        assetClass: plan.assetClass || plan.searchStrategy?.assetClass || '',
        viewerNeed: plan.viewerNeed,
        minimumAcceptable: plan.minimumAcceptable || plan.searchStrategy?.minimumAcceptable || '',
        providerOrder: plan.providerOrder || [],
        providerLock: normalizeProviderLock(plan.providerLock || {}, plan.mediaType || 'video'),
        providerExclusions: plan.providerExclusions || [],
        providerReality: plan.providerReality || [],
        providerEvidence: plan.providerEvidence || [],
        searchStrategy: plan.searchStrategy ? {
            primaryProvider: plan.searchStrategy.primaryProvider || '',
            providerReasoning: plan.searchStrategy.providerReasoning || '',
            queryLanes: (plan.searchStrategy.queryLanes || []).slice(0, 10),
            repairStrategy: (plan.searchStrategy.repairStrategy || []).slice(0, 6),
        } : null,
        sourceAuthority: plan.sourceAuthority || 'media-agent',
        vpSourceHint: plan.vpSourceHint || plan.sourceHint || '',
        literalRequiredObjects: (plan.literalRequiredObjects || []).slice(0, 8),
        mandatoryIdentity: (plan.mandatoryIdentity || []).slice(0, 8),
        identityEvidenceMode: plan.identityEvidenceMode || '',
        mandatoryVisible: (plan.mandatoryVisible || []).slice(0, 8),
        sceneEntities: plan.sceneEntities || null,
        mustShow: (plan.mustShow || []).slice(0, 8),
        mustAvoid: (plan.mustAvoid || []).slice(0, 8),
        acceptanceTest: plan.acceptanceTest || '',
    };
}

function getMediaAgentProviderOrder(plan, mediaType, sourceHint) {
    if (!plan?.enabled) return [];
    const excluded = new Set((plan.providerExclusions || []).map(e => providerKey(e.provider)).filter(k => k && !isStockProviderKey(k)));
    const order = normalizeProviderOrder(plan.providerOrder || [], mediaType, sourceHint, { hintFirst: false });
    if (process.env.MEDIA_AGENT_HARD_PROVIDER_EXCLUSIONS === '1') {
        return order.filter(key => !excluded.has(providerKey(key)));
    }
    if (excluded.size === 0) return order;
    const preferred = order.filter(key => !excluded.has(providerKey(key)));
    const fallback = order.filter(key => excluded.has(providerKey(key)));
    return [...preferred, ...fallback];
}

function getMediaAgentProviderLock(plan, mediaType) {
    if (!plan?.enabled) return { strength: 'open', family: 'open', providers: [], reason: '' };
    return normalizeProviderLock(plan.providerLock || {}, mediaType);
}

function getMediaAgentQueries(plan, providerKeyName, max = 6) {
    if (!plan?.enabled) return [];
    const key = providerKey(providerKeyName);
    if (!key) return [];
    if (process.env.MEDIA_AGENT_HARD_PROVIDER_EXCLUSIONS === '1' && getMediaAgentProviderSkipReason(plan, key)) return [];
    const laneQueries = (Array.isArray(plan.searchStrategy?.queryLanes) ? plan.searchStrategy.queryLanes : [])
        .filter(lane => {
            const laneProvider = providerKey(lane?.provider);
            return !laneProvider || laneProvider === key;
        })
        .map(lane => lane?.query)
        .filter(Boolean);
    return dedupe([
        ...laneQueries,
        ...(Array.isArray(plan.queries?.[key]) ? plan.queries[key] : []),
        ...(Array.isArray(plan.fallbackQueries) ? plan.fallbackQueries : []),
    ], max);
}

function getMediaAgentProviderSkipReason(plan, providerKeyName) {
    if (!plan?.enabled) return '';
    const key = providerKey(providerKeyName);
    if (isStockProviderKey(key)) return '';
    const hit = (plan.providerExclusions || []).find(e => providerKey(e.provider) === key);
    return clean(hit?.reason || '');
}

module.exports = {
    buildMediaAgentPlan,
    buildMediaAgentRepairPlan,
    fallbackPlan,
    summarizeMediaAgentPlan,
    getMediaAgentProviderOrder,
    getMediaAgentQueries,
    getMediaAgentProviderLock,
    getMediaAgentProviderSkipReason,
};
