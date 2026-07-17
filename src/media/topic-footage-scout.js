const fs = require('fs');
const path = require('path');
const config = require('../settings/config');
const YouTubeVideoProvider = require('./providers/youtube-video');
const RedditVideoProvider = require('./providers/reddit-video');
const PexelsVideoProvider = require('./providers/pexels-video');
const PixabayVideoProvider = require('./providers/pixabay-video');
const { getNiche } = require('../data/niches');
const {
    buildMediaHunterProfile,
    buildProviderQueries,
    rankResultsForHunter,
    getHunterFallbackKeywords,
} = require('./media-hunter');
const {
    buildVisualContract,
    scoutMediaResults,
} = require('./media-scout');
const {
    fallbackPlan: buildFallbackMediaAgentPlan,
} = require('./media-agent');
const { normalizeUrlForDedup } = require('../util/url-utils');
const { applySearchKeywordSplit, trimSearchKeyword } = require('./search-keywords');
const { filterDisabledSources, isDisabledSource, sanitizeSourceHint } = require('./source-policy');
const { callAI } = require('../brain/ai-provider');

// Active providers: free stock (Pexels/Pixabay), YouTube, Reddit.
const PROVIDER_FACTORIES = {
    youtube:     () => new YouTubeVideoProvider(),
    reddit:      () => new RedditVideoProvider(),
    pexels:      () => new PexelsVideoProvider(),
    pixabay:     () => new PixabayVideoProvider(),
};
const STOCK_PROVIDER_KEYS = ['pexels', 'pixabay'];

// Same shape footage-manager uses. null = no UI override (allow all).
function getEnabledSourcesFromUi() {
    try {
        const raw = process.env.FOOTAGE_SOURCES;
        if (raw) return JSON.parse(raw);
    } catch (_) {}
    return null;
}

function isProviderEnabledByUi(providerKey) {
    if (isDisabledSource(providerKey)) return false;
    const ui = getEnabledSourcesFromUi();
    if (!ui) return true;
    return ui[providerKey] !== false;
}

// Visual buckets and anchor types are derived dynamically per script:
//   - Layer 1: clusterScenesWithAI() — one DeepSeek call summarises the script
//     into 3-8 visual buckets + which entity types act as anchors.
//   - Layer 2: Director-extracted entities (scriptContext.entities) supply the
//     concrete anchor names, filtered by the AI-chosen anchorTypes.
//   - Layer 3: deterministic per-scene matcher selects the best bucket via
//     literal-term overlap against scene.protect / visualIntent text — no
//     hardcoded defaults, scenes without a fit get no bucket (not container_ship).

const GENERIC_TOKENS = new Set([
    'footage', 'video', 'clip', 'scene', 'shot', 'view', 'shows', 'showing',
    'world', 'around', 'nearly', 'another',
]);

const ALLOWED_ANCHOR_TYPES = ['person', 'place', 'org', 'event'];

function clean(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
}

function norm(value) {
    return clean(value).toLowerCase();
}

function short(value, max = 100) {
    const text = clean(value);
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function dedupe(values, max = 20) {
    const out = [];
    const seen = new Set();
    for (const value of values || []) {
        const text = clean(value);
        if (!text) continue;
        const key = text.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(text);
        if (out.length >= max) break;
    }
    return out;
}

function tokens(value) {
    return norm(value)
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .split(/\s+/)
        .map(t => t.replace(/^-+|-+$/g, '').trim())
        .filter(t => t.length > 2);
}

function meaningfulTokens(value, max = 18) {
    const out = [];
    const seen = new Set();
    for (const token of tokens(value)) {
        if (GENERIC_TOKENS.has(token)) continue;
        if (seen.has(token)) continue;
        seen.add(token);
        out.push(token);
        if (out.length >= max) break;
    }
    return out;
}

function sceneSearchText(scene) {
    return [
        scene?.searchKeyword,
        scene?.researchKeyword,
        scene?.keyword,
        scene?.webQuery,
        scene?.stockQuery,
        scene?.visualIntent,
        scene?.text,
    ].filter(Boolean).join(' ');
}

function candidateVisualText(candidate) {
    return [
        candidate?.title,
        candidate?.description,
        candidate?._cachedMeta?.title,
        candidate?._meta?.title,
        candidate?._cachedMeta?.description,
    ].filter(Boolean).join(' ');
}

function withTimeout(promise, ms, label) {
    let timeout;
    const timer = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
    });
    return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}

function providerKeysForScene(scene, configured, scriptContext = {}) {
    const keys = new Set();
    const configuredKeys = Array.isArray(configured) && configured.length > 0
        ? configured
        : Object.keys(PROVIDER_FACTORIES);
    for (const key of configuredKeys || []) {
        if (PROVIDER_FACTORIES[key]) keys.add(key);
    }
    const hint = sanitizeSourceHint(scene?.sourceHint || scene?.mediaIntent?.sourceHint || scene?.mediaIntent?.policy?.sourceHint || '', 'youtube') || '';
    if ((!configured || configured.length === 0) && hint === 'stock') {
        for (const key of STOCK_PROVIDER_KEYS) keys.add(key);
    } else if ((!configured || configured.length === 0) && PROVIDER_FACTORIES[hint]) {
        keys.add(hint);
    }

    // Order by niche footagePriority.video — niche-preferred providers first;
    // scene.sourceHint is soft; provider evidence is resolved by the Media Agent.
    const niche = getNiche(scriptContext?.nicheId || '');
    const priority = filterDisabledSources(Array.isArray(niche?.footagePriority?.video) ? niche.footagePriority.video : []);
    const priorityIdx = (key) => {
        const explicit = priority.indexOf(key);
        if (explicit >= 0) return explicit;
        if (STOCK_PROVIDER_KEYS.includes(key) && priority.includes('stock')) {
            return priority.indexOf('stock') + 0.5;
        }
        return 100;
    };
    return filterDisabledSources(Array.from(keys)).sort((a, b) => priorityIdx(a) - priorityIdx(b));
}

function isVideoFootageScene(scene) {
    if (!scene || scene.fullscreenMG) return false;
    // The scout is ONLY for scenes whose MAIN visual is real downloaded footage.
    // Template scenes get their background through the footage-manager's dedicated
    // template-background search (templateBgQuery) — not this pool — and overlay/
    // data beats render graphics. Clustering them made the scout search card titles
    // and abstract narration ("Worst Case", "kinetic typography") as if they were
    // footage, returning junk. Exclude them so the scout only ever searches real
    // footage keywords.
    if (scene.templateHint) return false;
    if (scene.mediaIntent?.policy?.download === 'skip') return false;
    const need = String(scene.mediaNeed || '').toLowerCase();
    if (need === 'template-only' || need === 'data-graphic') return false;
    // Must have a real, searchable footage keyword — never narration/title text.
    const kw = scene.searchKeyword || scene.keyword || scene.stockQuery || scene.webQuery;
    if (!kw || !String(kw).trim() || String(kw).trim().toLowerCase() === 'none') return false;
    const type = scene.mediaIntent?.policy?.mediaType || scene.mediaType || 'video';
    return type === 'video';
}

function sceneIndex(scene, fallback) {
    return Number.isFinite(Number(scene?.originalIndex)) ? Number(scene.originalIndex)
        : Number.isFinite(Number(scene?.index)) ? Number(scene.index)
        : fallback;
}

function sceneFootprint(scene) {
    const protect = Array.isArray(scene?.protect) ? scene.protect : [];
    return [
        ...protect.map(String),
        scene?.visualIntent,
        scene?.searchKeyword,
        scene?.researchKeyword,
        scene?.keyword,
        scene?.webQuery,
        scene?.stockQuery,
        scene?.text,
    ].filter(Boolean).join(' ');
}

// Find a recurring anchor by scanning Director-extracted entities, filtered by
// the AI-chosen anchorTypes. Returns { name, type }. Anchor type matters for
// downstream behavior (e.g. stock map boost only applies to places).
function findAnchorIn(text, entities, entityTypes, anchorTypes) {
    if (!Array.isArray(entities) || entities.length === 0) return { name: '', type: '' };
    const haystack = String(text || '').toLowerCase();
    if (!haystack) return { name: '', type: '' };
    const allowed = new Set((anchorTypes || []).map(t => String(t || '').toLowerCase()).filter(Boolean));
    const allowAll = allowed.size === 0; // if AI didn't pick types, allow all
    for (const name of entities) {
        if (!name) continue;
        const lc = String(name).toLowerCase().trim();
        if (lc.length < 2) continue;
        const type = String((entityTypes || {})[lc] || '').toLowerCase();
        if (!allowAll && type && !allowed.has(type)) continue;
        if (haystack.includes(lc)) return { name: String(name).trim(), type: type || '' };
    }
    return { name: '', type: '' };
}

// Pick the bucket whose terms have the highest literal-overlap with the text.
// No default fallback: if no bucket terms appear, return null (scene gets its
// own solo group). This is what kills the maritime default-to-container_ship bug.
function findBucketIn(text, buckets) {
    if (!Array.isArray(buckets) || buckets.length === 0) return null;
    const haystack = String(text || '').toLowerCase();
    if (!haystack) return null;
    let best = null;
    let bestScore = 0;
    for (const bucket of buckets) {
        const terms = Array.isArray(bucket?.terms) ? bucket.terms : [];
        let hits = 0;
        for (const term of terms) {
            const tlow = String(term || '').toLowerCase().trim();
            if (!tlow || tlow.length < 2) continue;
            if (haystack.includes(tlow)) hits++;
        }
        if (hits > bestScore) {
            bestScore = hits;
            best = bucket;
        }
    }
    return bestScore >= 1 ? best : null;
}

function _containsPhrase(text, phrase) {
    const needle = clean(phrase).toLowerCase();
    if (!needle || needle.length < 3) return false;
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]+');
    return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, 'iu').test(String(text || '').toLowerCase());
}

function _nonLocalEntitiesInSeed(seedText = '', sceneText = '', entities = []) {
    const out = [];
    for (const entity of entities || []) {
        const name = clean(entity);
        if (!name || name.length < 3) continue;
        if (!_containsPhrase(seedText, name)) continue;
        if (_containsPhrase(sceneText, name)) continue;
        out.push(name);
    }
    return dedupe(out, 12);
}

function _soloBucketId(keyword = '', sceneId = '') {
    const base = clean(keyword || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 42);
    return `solo_${base || sceneId || 'scene'}`;
}

async function clusterScenesWithAI(scenes, scriptContext = {}) {
    const niche = getNiche(scriptContext?.nicheId || '') || {};
    const topic = clean(scriptContext?.topic || scriptContext?.title || '');
    const summary = short(scriptContext?.summary || '', 480);
    const entities = Array.isArray(scriptContext?.entities) ? scriptContext.entities : [];
    const entityTypes = scriptContext?.entityTypes || {};

    const videoScenes = (scenes || []).filter(isVideoFootageScene);
    if (videoScenes.length === 0) return { buckets: [], anchorTypes: [] };

    // Entity stats: count appearances across all scene text + tag with type
    const counts = new Map();
    const joinedText = videoScenes.map(s => sceneFootprint(s)).join(' ').toLowerCase();
    for (const name of entities) {
        if (!name) continue;
        const lc = String(name).toLowerCase().trim();
        if (lc.length < 2) continue;
        let hits = 0;
        let idx = -1;
        while ((idx = joinedText.indexOf(lc, idx + 1)) !== -1) hits++;
        if (hits > 0) counts.set(name, hits);
    }
    const entitiesRanked = Array.from(counts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 30)
        .map(([name, hits]) => {
            const type = entityTypes[String(name).toLowerCase()] || 'unknown';
            return `${name} [${type}] x${hits}`;
        });

    // Compact scene rows: idx | lane | protect tokens | short visualIntent
    const sceneRowsAll = videoScenes.map((s, i) => {
        const idx = sceneIndex(s, i);
        const lane = s?.mediaIntent?.lane || s?.lane || s?.sourceHint || 'youtube';
        const protect = Array.isArray(s?.protect) ? s.protect.slice(0, 4).join(',') : '';
        const intent = short(s?.visualIntent || s?.searchKeyword || s?.keyword || '', 90);
        return `S${idx}: ${lane} | ${protect || '-'} | ${intent || '-'}`;
    });

    // Sample evenly when scene count is large so prompt stays bounded.
    const maxRows = 120;
    let rowsForPrompt = sceneRowsAll;
    if (sceneRowsAll.length > maxRows) {
        const step = sceneRowsAll.length / maxRows;
        rowsForPrompt = [];
        for (let i = 0; i < maxRows; i++) rowsForPrompt.push(sceneRowsAll[Math.floor(i * step)]);
    }

    const prompt = `You are clustering script scenes for a footage scout. The scout reuses footage across scenes by recurring visual subjects, so good buckets save searches and improve coherence.

Topic: ${topic || '-'}
Niche: ${niche.name || ''} (${niche.id || scriptContext?.nicheId || 'general'})
Summary: ${summary || '-'}

Frequent entities (name [type] x occurrences):
${entitiesRanked.length ? entitiesRanked.join('\n') : '(none extracted)'}

Scene rows (S<idx>: lane | protect | visualIntent):
${rowsForPrompt.join('\n')}

Your job:
1. Identify 3-8 VISUAL BUCKETS that capture the recurring on-screen subjects in THIS script.
   - Each bucket: snake_case id, short human label, 3-8 distinguishing LITERAL terms (single words or short phrases that would actually appear in scene protect/visualIntent text), and ONE concrete seedQuery (3-7 words) suitable for a stock/video search.
   - Buckets must be visually distinct from each other.
   - Bucket terms are matched literally against scene text - prefer concrete nouns and named subjects over abstract concepts.
   - Do not put a brand/person/org/entity name in seedQuery unless that exact entity is required by the bucket terms. Generic buckets need generic seed queries.
2. Pick anchorTypes - the entity TYPES that act as recurring anchors for this script.
   - anchorTypes is a subset of ["person", "place", "org", "event"].
   - Choose only types that appear repeatedly AND carry visual identity (e.g. brand names for product reviews = ["org"], locations for travel/military = ["place"], biographies = ["person"]).
   - It is FINE to return an empty array if no entity type is a recurring anchor.

Output ONLY a single JSON object, no markdown fences, no commentary:
{"buckets":[{"id":"...","label":"...","terms":["..."],"seedQuery":"..."}],"anchorTypes":["..."]}`;

    try {
        const useBedrock = !!(process.env.BEDROCK_ACCESS_KEY_ID && process.env.BEDROCK_SECRET_ACCESS_KEY);
        const raw = await callAI(prompt, {
            maxTokens: 1400,
            taskType: 'review',
            ...(useBedrock ? { provider: 'bedrock' } : {}),
        });
        if (!raw) throw new Error('empty AI response');

        const jsonMatch = String(raw).match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('no JSON object in response');
        const parsed = JSON.parse(jsonMatch[0]);

        const buckets = Array.isArray(parsed?.buckets) ? parsed.buckets.map((b, i) => ({
            id: String(b?.id || `bucket_${i}`).replace(/[^a-z0-9_]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase() || `bucket_${i}`,
            label: String(b?.label || b?.id || `Bucket ${i + 1}`).trim(),
            terms: Array.isArray(b?.terms)
                ? dedupe(b.terms.map(t => String(t || '').toLowerCase().trim()).filter(t => t.length >= 2), 10)
                : [],
            seedQuery: String(b?.seedQuery || '').trim(),
        })).filter(b => b.terms.length > 0 && b.seedQuery).slice(0, 8) : [];

        const anchorTypes = Array.isArray(parsed?.anchorTypes)
            ? Array.from(new Set(parsed.anchorTypes.map(t => String(t || '').toLowerCase()).filter(t => ALLOWED_ANCHOR_TYPES.includes(t))))
            : [];

        console.log(`  [Topic Footage Scout] AI clustered: ${buckets.length} bucket(s), anchorTypes=[${anchorTypes.join(',') || 'none'}]`);
        for (const b of buckets) {
            console.log(`  [Topic Footage Scout] bucket ${b.id}: terms=[${b.terms.slice(0, 6).join(', ')}] seed="${b.seedQuery}"`);
        }
        return { buckets, anchorTypes };
    } catch (err) {
        console.log(`  [Topic Footage Scout] AI clustering skipped (${err.message}) - falling back to entity-only`);
        return { buckets: [], anchorTypes: ALLOWED_ANCHOR_TYPES.slice() };
    }
}

function buildNeedSeed(scene, scriptContext, idx, scoutCtx) {
    applySearchKeywordSplit(scene, scriptContext);
    const keyword = clean(scene.searchKeyword || scene.researchKeyword || scene.keyword || scene.webQuery || scene.stockQuery || '');
    const id = sceneIndex(scene, idx);
    const sourceHint = sanitizeSourceHint(scene.sourceHint || '', 'youtube') || '';
    const mediaType = 'video';
    const mediaAgentPlan = buildFallbackMediaAgentPlan(scene, scriptContext, {
        keyword,
        mediaType,
        sourceHint,
        nicheId: scriptContext?.nicheId || '',
    });
    const profile = buildMediaHunterProfile(scene, scriptContext, {
        keyword,
        mediaType,
        sourceHint,
        nicheId: scriptContext?.nicheId || '',
        agentPlan: mediaAgentPlan,
    });
    const contract = buildVisualContract(scene, scriptContext, {
        keyword,
        mediaType,
        sourceHint,
        nicheId: scriptContext?.nicheId || '',
        hunterProfile: profile,
    });
    const sceneText = sceneSearchText(scene);
    const footprint = sceneFootprint(scene);
    const clusters = scoutCtx?.clusters || { buckets: [], anchorTypes: [] };
    const anchorHit = findAnchorIn(footprint, scoutCtx?.entities, scoutCtx?.entityTypes, clusters.anchorTypes);
    const rawBucket = findBucketIn(footprint, clusters.buckets);
    const anchor = anchorHit.name;
    const anchorType = anchorHit.type;
    const rawBucketSeed = rawBucket ? clean(rawBucket.seedQuery || '').replace(/\bfootage\b/gi, '').trim() : '';
    const blockedSeedEntities = rawBucketSeed
        ? _nonLocalEntitiesInSeed(rawBucketSeed, footprint, scoutCtx?.entities || [])
        : [];
    const bucket = blockedSeedEntities.length > 0 ? null : rawBucket;
    const bucketSeed = bucket ? rawBucketSeed : '';
    const bucketId = bucket?.id || _soloBucketId(keyword, id);
    const needQuery = trimSearchKeyword(clean([anchor, bucketSeed].filter(Boolean).join(' ')) || keyword, scene);
    const key = `${profile.domain || 'general'}|${norm(anchor || 'no-anchor')}|${bucketId}`;
    const bucketTerms = Array.isArray(bucket?.terms) ? bucket.terms : [];
    return {
        key,
        id: key.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').toLowerCase(),
        sceneIds: [id],
        representativeScene: scene,
        profile,
        contract,
        anchor,
        anchorType,
        bucket: bucketId,
        bucketTerms,
        bucketSeed: bucket?.seedQuery || '',
        bucketSeedBlocked: blockedSeedEntities,
        sceneTerms: meaningfulTokens(sceneText, 14),
        keyword,
        query: needQuery,
        queries: dedupe([
            needQuery,
            keyword,
            scene.webQuery,
            scene.stockQuery,
            profile.targetDescription,
            bucket ? bucket.seedQuery || '' : '',
            ...(anchor && bucket?.seedQuery ? [`${anchor} ${bucket.seedQuery}`] : []),
        ].filter(Boolean), 12),
        providerKeys: providerKeysForScene(scene, config.topicFootageScout?.providers, scriptContext),
        strictRaw: Boolean(profile.strictRaw && !profile.allowGraphics),
    };
}

async function buildNeeds(scenes, scriptContext) {
    const clusters = await clusterScenesWithAI(scenes, scriptContext);
    const scoutCtx = {
        clusters,
        entities: Array.isArray(scriptContext?.entities) ? scriptContext.entities : [],
        entityTypes: scriptContext?.entityTypes || {},
    };

    const map = new Map();
    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        if (!isVideoFootageScene(scene)) continue;
        const seed = buildNeedSeed(scene, scriptContext, i, scoutCtx);
        if (!seed.keyword && !seed.query) continue;
        if (!map.has(seed.key)) {
            map.set(seed.key, seed);
            continue;
        }
        const need = map.get(seed.key);
        need.sceneIds = dedupe([...need.sceneIds, ...seed.sceneIds], 50);
        need.queries = dedupe([...need.queries, ...seed.queries], 16);
        need.sceneTerms = dedupe([...(need.sceneTerms || []), ...(seed.sceneTerms || [])], 24);
        need.providerKeys = dedupe([...need.providerKeys, ...seed.providerKeys], 8);
        need.strictRaw = need.strictRaw || seed.strictRaw;
    }

    const needs = Array.from(map.values())
        .sort((a, b) => (b.sceneIds.length - a.sceneIds.length) || (Number(b.strictRaw) - Number(a.strictRaw)))
        .slice(0, Math.max(1, config.topicFootageScout?.maxNeeds || 8));
    return { needs, scoutCtx };
}

function buildQueriesForProvider(need, providerKey, scriptContext = {}) {
    const queries = [];

    // Stock map boost: when the need has a geographic (place-typed) anchor,
    // prepend map-flavored variants so stock providers can surface topic-accurate
    // map clips alongside the regular footage.
    const isPlaceAnchor = need.anchor && need.anchorType === 'place';
    if (STOCK_PROVIDER_KEYS.includes(providerKey) && isPlaceAnchor) {
        queries.push(`${need.anchor} map`);
        queries.push(`${need.anchor} route map`);
    }

    for (const base of need.queries) {
        queries.push(...buildProviderQueries(base, need.keyword || base, need.representativeScene, need.profile, providerKey));
    }
    queries.push(...getHunterFallbackKeywords(need.keyword || need.query, need.representativeScene, scriptContext, {
        mediaType: 'video',
        providerKey,
        sourceHint: STOCK_PROVIDER_KEYS.includes(providerKey) ? 'stock' : providerKey,
        max: 4,
    }));

    // Stock providers get one extra slot to fit the map variant without
    // crowding out the regular subject query.
    const baseCap = Math.max(1, config.topicFootageScout?.queriesPerProvider || 2);
    const cap = STOCK_PROVIDER_KEYS.includes(providerKey) && isPlaceAnchor ? baseCap + 1 : baseCap;
    return dedupe(queries, cap);
}

function providerLabel(providerKey) {
    if (providerKey === 'youtube') return 'YouTube Videos';
    if (providerKey === 'reddit') return 'Reddit Videos';
    if (providerKey === 'pexels') return 'Pexels Videos';
    if (providerKey === 'pixabay') return 'Pixabay Videos';
    return providerKey;
}

function candidateUrlKey(candidate) {
    const url = candidate?._directVideoUrl || candidate?._fallbackUrl || candidate?.url || '';
    return normalizeUrlForDedup(url);
}

async function searchNeedProvider(need, provider, providerKey, scriptContext = {}) {
    const candidates = [];
    const queries = buildQueriesForProvider(need, providerKey, scriptContext);
    const maxResults = Math.max(1, config.topicFootageScout?.maxResultsPerQuery || 8);
    const timeoutMs = Math.max(5000, config.topicFootageScout?.searchTimeoutMs || 18000);

    for (const query of queries) {
        try {
            console.log(`  [Topic Footage Scout] ${provider.name} search "${query}"`);
            let results = await withTimeout(provider.search(query), timeoutMs, `${provider.name} scout search`);
            if (provider.filterResults) results = provider.filterResults(results || []);
            results = (results || []).slice(0, maxResults);
            results = rankResultsForHunter(results, need.profile, provider.name);
            const scout = scoutMediaResults(results, need.contract, {
                providerKey,
                providerName: provider.name,
                query,
            });
            if (scout.log) console.log(scout.log);
            for (const result of scout.results.slice(0, maxResults)) {
                candidates.push({
                    ...result,
                    _topicScout: {
                        needId: need.id,
                        needKey: need.key,
                        providerKey,
                        providerName: provider.name,
                        query,
                        sceneIds: need.sceneIds.slice(),
                        score: Number(result._mediaScoutScore || 0),
                        reasons: result._mediaScoutReasons || [],
                        anchor: need.anchor,
                        anchorType: need.anchorType,
                        bucket: need.bucket,
                    },
                });
            }
        } catch (err) {
            console.log(`  [Topic Footage Scout] ${provider.name} "${query}" skipped (${err.message})`);
        }
    }

    return candidates;
}

function instantiateProviders(scriptContext) {
    const providers = {};
    const skippedByUi = [];
    for (const key of config.topicFootageScout?.providers || []) {
        const factory = PROVIDER_FACTORIES[key];
        if (!factory) continue;
        if (!isProviderEnabledByUi(key)) {
            skippedByUi.push(providerLabel(key));
            continue;
        }
        try {
            const provider = factory();
            if (provider.setContext) provider.setContext(scriptContext);
            if (!provider.isAvailable()) continue;
            providers[key] = provider;
        } catch (err) {
            console.log(`  [Topic Footage Scout] ${providerLabel(key)} unavailable (${err.message})`);
        }
    }
    if (skippedByUi.length) {
        console.log(`  [Topic Footage Scout] disabled in UI: ${skippedByUi.join(', ')}`);
    }
    return providers;
}

async function buildTopicFootageBank(scenes, scriptContext = {}, opts = {}) {
    if (config.topicFootageScout?.enabled === false || opts.enabled === false) {
        return { enabled: false, needs: [], candidates: [], byScene: {} };
    }

    const { needs, scoutCtx } = await buildNeeds(scenes || [], scriptContext);
    if (needs.length === 0) {
        console.log('  [Topic Footage Scout] no video footage needs detected');
        return { enabled: true, needs: [], candidates: [], byScene: {}, _scoutCtx: scoutCtx };
    }

    const providers = instantiateProviders(scriptContext);
    const availableKeys = Object.keys(providers);
    if (availableKeys.length === 0) {
        console.log('  [Topic Footage Scout] no scout providers available');
        return { enabled: true, needs, candidates: [], byScene: {}, _scoutCtx: scoutCtx };
    }

    console.log(`  [Topic Footage Scout] needs=${needs.length}, providers=${availableKeys.join(', ')}`);
    for (const need of needs) {
        console.log(`  [Topic Footage Scout] need ${need.id}: scenes ${need.sceneIds.join(', ')} -> "${need.query}"`);
        if (Array.isArray(need.bucketSeedBlocked) && need.bucketSeedBlocked.length > 0) {
            console.log(`  [Topic Footage Scout]   scene-local bucket guard blocked seed entities: ${need.bucketSeedBlocked.slice(0, 6).join(', ')}`);
        }
    }

    const seenUrls = new Set();
    const candidates = [];
    const maxPerNeed = Math.max(1, config.topicFootageScout?.maxCandidatesPerNeed || 8);

    for (const need of needs) {
        const needCandidates = [];
        const providerKeys = need.providerKeys.filter(key => providers[key]);
        // Parallel search across all enabled providers for this need —
        // turns the scout into an empirical per-scene shopper instead of a
        // serial bucket-list. Failures are isolated per provider.
        const searches = await Promise.all(providerKeys.map(async (providerKey) => {
            try {
                return await searchNeedProvider(need, providers[providerKey], providerKey, scriptContext);
            } catch (err) {
                console.log(`  [Topic Footage Scout] ${providerLabel(providerKey)} need ${need.id} skipped (${err.message})`);
                return [];
            }
        }));
        for (const found of searches) {
            for (const candidate of found) {
                const key = candidateUrlKey(candidate);
                if (!key || seenUrls.has(key)) continue;
                seenUrls.add(key);
                needCandidates.push(candidate);
            }
        }
        needCandidates
            .sort((a, b) => Number(b._topicScout?.score || 0) - Number(a._topicScout?.score || 0))
            .slice(0, maxPerNeed)
            .forEach(candidate => candidates.push(candidate));
    }

    const bank = { enabled: true, needs, candidates, byScene: {}, nicheId: scriptContext?.nicheId || '', _scoutCtx: scoutCtx };
    assignTopicFootageBank(scenes, bank, { silent: true });
    writeBankDebug(bank);
    const topUse = {};
    for (const items of Object.values(bank.byScene || {})) {
        for (const item of items || []) {
            const key = `${item.provider || ''}|${item.title || ''}`;
            topUse[key] = (topUse[key] || 0) + 1;
        }
    }
    const maxUse = Object.values(topUse).reduce((max, count) => Math.max(max, count), 0);
    console.log(`  [Topic Footage Scout] bank ready: ${candidates.length} candidate(s), assigned ${Object.keys(bank.byScene).length}/${(scenes || []).filter(isVideoFootageScene).length} video scene(s), max reuse ${maxUse}`);
    return bank;
}

function scoreCandidateForScene(candidate, scene, idx, scoutCtx) {
    const sceneId = sceneIndex(scene, idx);
    const meta = candidate._topicScout || {};
    const sourceSceneMatch = (meta.sceneIds || []).map(Number).includes(Number(sceneId));
    const sceneText = sceneSearchText(scene);
    const visualText = candidateVisualText(candidate);
    const candidateText = [
        visualText,
        meta.query,
        meta.anchor,
        meta.bucket,
    ].filter(Boolean).join(' ');
    const clusters = scoutCtx?.clusters || { buckets: [], anchorTypes: [] };
    const entities = scoutCtx?.entities || [];
    const entityTypes = scoutCtx?.entityTypes || {};
    const sceneAnchor = findAnchorIn(sceneFootprint(scene), entities, entityTypes, clusters.anchorTypes).name;
    const sceneBucket = findBucketIn(sceneFootprint(scene), clusters.buckets)?.id || '';
    const candidateAnchor = findAnchorIn(visualText, entities, entityTypes, clusters.anchorTypes).name || meta.anchor || '';
    const candidateBucket = meta.bucket || findBucketIn(visualText, clusters.buckets)?.id || '';

    // Keep global search quality as a tie-breaker, not the main decision. The
    // last build proved a globally strong Reddit result can drown out local
    // scene intent if this number dominates.
    let score = Math.min(12, Number(meta.score || 0) * 0.4);
    score += sourceSceneMatch ? 28 : -18;

    if (sceneAnchor && candidateAnchor) {
        score += norm(sceneAnchor) === norm(candidateAnchor) ? 14 : -24;
    } else if (sceneAnchor && !candidateAnchor) {
        score -= 6;
    } else if (!sceneAnchor && candidateAnchor) {
        score -= 2;
    }

    if (sceneBucket && candidateBucket) {
        score += sceneBucket === candidateBucket ? 10 : -6;
    }

    const sceneTokens = new Set(meaningfulTokens(sceneText, 24));
    let overlap = 0;
    for (const token of meaningfulTokens(candidateText, 28)) {
        if (sceneTokens.has(token)) overlap++;
    }
    score += Math.min(14, overlap * 2);
    if (sceneTokens.size > 0 && overlap === 0) score -= 10;

    return score;
}

function assignTopicFootageBank(scenes, bank, opts = {}) {
    if (!bank?.enabled || !Array.isArray(bank.candidates) || bank.candidates.length === 0) return bank;
    const maxPerScene = Math.max(1, config.topicFootageScout?.maxCandidatesPerScene || 5);
    const maxPerCandidate = Math.max(1, config.topicFootageScout?.maxSceneAssignmentsPerCandidate || 2);
    const maxPerProvider = Math.max(1, config.topicFootageScout?.maxCandidatesPerProviderPerScene || 2);
    const minSceneScore = Number.isFinite(Number(config.topicFootageScout?.minSceneScore))
        ? Number(config.topicFootageScout.minSceneScore)
        : 16;
    const usage = opts.usage || new Map();
    const scoutCtx = bank._scoutCtx || { clusters: { buckets: [], anchorTypes: [] }, entities: [], entityTypes: {} };
    bank.byScene = {};
    for (let i = 0; i < (scenes || []).length; i++) {
        const scene = scenes[i];
        if (!isVideoFootageScene(scene)) continue;
        const scored = bank.candidates
            .map(candidate => ({ candidate, score: scoreCandidateForScene(candidate, scene, i, scoutCtx) }))
            .filter(item => item.score >= minSceneScore)
            .sort((a, b) => b.score - a.score);
        const selected = [];
        const providerCounts = new Map();
        const addCandidate = (item, respectUsage) => {
            const key = candidateUrlKey(item.candidate) || norm(item.candidate.title || item.candidate.url || '');
            if (!key || selected.some(existing => (candidateUrlKey(existing.candidate) || norm(existing.candidate.title || existing.candidate.url || '')) === key)) {
                return false;
            }
            const provider = item.candidate._topicScout?.providerKey || item.candidate._topicScout?.providerName || 'unknown';
            if ((providerCounts.get(provider) || 0) >= maxPerProvider) return false;
            if (respectUsage && (usage.get(key) || 0) >= maxPerCandidate) return false;
            selected.push(item);
            usage.set(key, (usage.get(key) || 0) + 1);
            providerCounts.set(provider, (providerCounts.get(provider) || 0) + 1);
            return true;
        };

        for (const item of scored) {
            if (selected.length >= maxPerScene) break;
            addCandidate(item, true);
        }
        if (selected.length === 0 && scored.length > 0) {
            // Last resort: keep one good candidate even if the diversity cap is
            // already full, but only for this scene. This prevents "no bank"
            // scenes without letting one URL dominate every scene.
            addCandidate(scored[0], false);
        }
        if (selected.length === 0) continue;
        const assigned = selected.map(item => ({
            ...item.candidate,
            _topicScout: {
                ...(item.candidate._topicScout || {}),
                sceneScore: item.score,
            },
        }));
        scene._topicFootageCandidates = assigned;

        // Per-scene provider scoreboard: top-3 scored candidates per provider
        // sum into the provider's score for this scene. Emit a preferred-order
        // list so footage-manager can shop the empirically best source first
        // instead of walking VIDEO_PRIORITY blindly.
        const providerScores = new Map();
        const providerTopScore = new Map();
        const providerHits = new Map();
        for (const item of scored) {
            const pkey = item.candidate._topicScout?.providerKey;
            if (!pkey) continue;
            const hits = providerHits.get(pkey) || 0;
            if (hits >= 3) continue;
            providerHits.set(pkey, hits + 1);
            providerScores.set(pkey, (providerScores.get(pkey) || 0) + Math.max(0, item.score));
            const prevTop = providerTopScore.get(pkey) || -Infinity;
            if (item.score > prevTop) providerTopScore.set(pkey, item.score);
        }
        let providerOrder = Array.from(providerScores.entries())
            .sort((a, b) => {
                if (b[1] !== a[1]) return b[1] - a[1];
                return (providerTopScore.get(b[0]) || 0) - (providerTopScore.get(a[0]) || 0);
            })
            .map(([key]) => key);

        // Niche-level scoutDemote: providers listed here can win textual scoring
        // (keyword-rich titles like YouTube news packages) but fail downstream
        // raw-footage vision gates. Push them to the END of providerOrder so
        // cleaner sources get the per-scene budget first. Empirical scoring
        // still picks WITHIN the demoted group if everything else dries up.
        const _bankNiche = bank.nicheId ? getNiche(bank.nicheId) : null;
        const _scoutDemote = Array.isArray(_bankNiche?.scoutDemote) ? _bankNiche.scoutDemote : null;
        if (_scoutDemote && _scoutDemote.length > 0 && providerOrder.length > 1) {
            const demoteSet = new Set(_scoutDemote);
            const kept = providerOrder.filter(k => !demoteSet.has(k));
            const demoted = providerOrder.filter(k => demoteSet.has(k));
            providerOrder = [...kept, ...demoted];
        }
        const providerScoreboard = providerOrder.map(key => ({
            provider: key,
            score: Math.round(providerScores.get(key) || 0),
            top: Math.round(providerTopScore.get(key) || 0),
        }));
        const id = sceneIndex(scene, i);
        if (providerOrder.length > 0) {
            scene._scoutPreferredProvider = providerOrder[0];
            scene._scoutProviderOrder = providerOrder.slice();
            scene._scoutProviderScoreboard = providerScoreboard;
            if (!bank.preferredProviderByScene) bank.preferredProviderByScene = {};
            bank.preferredProviderByScene[id] = {
                preferred: providerOrder[0],
                order: providerOrder.slice(),
                scoreboard: providerScoreboard,
            };
        }

        bank.byScene[id] = assigned.map(item => ({
            provider: item._topicScout?.providerName || item._topicScout?.providerKey,
            query: item._topicScout?.query,
            title: short(item.title || item.url),
            score: item._topicScout?.sceneScore,
            need: item._topicScout?.needId,
            anchor: item._topicScout?.anchor,
            bucket: item._topicScout?.bucket,
        }));
    }
    if (!opts.silent) {
        console.log(`  [Topic Footage Scout] assigned bank candidates to ${Object.keys(bank.byScene).length} scene(s)`);
    }
    if (bank.preferredProviderByScene) {
        const winners = Object.entries(bank.preferredProviderByScene);
        if (winners.length > 0) {
            const summary = winners.slice(0, 8).map(([sid, info]) => {
                const top = info.scoreboard?.[0];
                const detail = top ? `${info.preferred}(${top.score})` : info.preferred;
                const runnerUp = info.order?.[1];
                return `s${sid}->${detail}${runnerUp ? `>${runnerUp}` : ''}`;
            }).join(', ');
            const tail = winners.length > 8 ? `, +${winners.length - 8} more` : '';
            console.log(`  [Topic Footage Scout] empirical winners: ${summary}${tail}`);
        }
    }
    return bank;
}

function writeBankDebug(bank) {
    try {
        const outPath = path.join(config.paths?.temp || process.cwd(), 'topic-footage-bank.json');
        const data = {
            createdAt: new Date().toISOString(),
            clusters: bank._scoutCtx?.clusters || { buckets: [], anchorTypes: [] },
            needs: bank.needs.map(need => ({
                id: need.id,
                scenes: need.sceneIds,
                query: need.query,
                anchor: need.anchor,
                anchorType: need.anchorType,
                bucket: need.bucket,
                bucketTerms: need.bucketTerms,
                bucketSeedBlocked: need.bucketSeedBlocked,
                providers: need.providerKeys,
            })),
            candidates: bank.candidates.map(candidate => ({
                provider: candidate._topicScout?.providerName || candidate._topicScout?.providerKey,
                query: candidate._topicScout?.query,
                title: candidate.title || candidate._cachedMeta?.title || '',
                url: candidate.url,
                duration: candidate.duration || candidate._cachedMeta?.duration || 0,
                score: candidate._topicScout?.score || 0,
                scenes: candidate._topicScout?.sceneIds || [],
            })),
            byScene: bank.byScene,
            preferredProviderByScene: bank.preferredProviderByScene || {},
        };
        fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    } catch (err) {
        console.log(`  [Topic Footage Scout] debug bank write skipped (${err.message})`);
    }
}

module.exports = {
    buildTopicFootageBank,
    assignTopicFootageBank,
};
