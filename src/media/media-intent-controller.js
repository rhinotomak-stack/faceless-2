/**
 * media-intent-controller.js
 *
 * Deterministic authority pass for media lane selection after the Visual
 * Planner/orchestrator have produced a plan, but before downloads begin.
 *
 * The Visual Planner is creative; this pass is boring on purpose:
 *   - keep static reference scenes as images
 *   - keep fullscreen lanes out of the downloader
 *   - force concrete factual scenes toward video and real sources
 *   - keep stock for genuinely generic/mood B-roll
 */

const { getNiche } = require('../data/niches');
const { filterDisabledSources, sanitizeSourceHint } = require('./source-policy');

const FACTUAL_NICHE_RE = /^(news|explainer\.(politics|military|economy|business|history|crime)|documentary)/i;
const REAL_VIDEO_SOURCES = filterDisabledSources(['youtube', 'reddit', 'storyblocks']);
const IMAGE_SOURCES = ['bing', 'storyblocks'];

const STATIC_REFERENCE_RE = /\b(map|maps|chart|charts|graph|graphs|diagram|diagrams|infographic|infographics|satellite|locator|portrait|photo|photos|image|images|thumbnail|logo|logos|brand mark|document|documents|article|screenshot|newspaper|paper|report|table|schematic|blueprint|label|labels|sticker|stickers|badge|badges|emblem|tag|tags|nameplate|name plate|serial plate|model plate|warning label|product label|packaging)\b/i;
const PERSON_REFERENCE_RE = /\b(portrait|headshot|profile photo|mugshot|passport photo|official photo|press photo|face photo)\b/i;
const CONCRETE_VIDEO_RE = /\b(ship|ships|shipping|vessel|vessels|tanker|tankers|cargo|container|containers|freighter|freighters|convoy|port|ports|canal|strait|chokepoint|choke point|route|routes|corridor|traffic|factory|assembly|officials?|briefing|summit|speech|protest|navy|naval|military|forces?|troops?|missile|missiles|drone|drones|attack|strike|blockade|sanctions?|pipeline|oil terminal|refinery|border|patrol|conflict|war|aerial|drone shot)\b/i;
const ABSTRACT_RE = /\b(concept|metaphor|idea|system|network|principle|strategy|dilemma|framework|symbolism|dynamic|equilibrium|mechanism|collapse|breaking apart|risk itself|assumption)\b/i;
const MILITARY_ACTOR_RE = /\b(iran|russia|ukraine|china|north korea|houthi|houthis|hamas|idf|nato|hezbollah|taliban|isis|navy|military|forces|troops|missile|drone|blockade)\b/i;

function _textBlob(scene) {
    return [
        scene?.keyword,
        scene?.stockQuery,
        scene?.webQuery,
        scene?.visualIntent,
        scene?.text,
        scene?.sceneClass,
        scene?.classSubSignal,
        ...(Array.isArray(scene?.protectedTerms) ? scene.protectedTerms : []),
    ].filter(Boolean).join(' ');
}

function _isFullscreen(scene) {
    return !!scene?.fullscreenMG;
}

function _isFactualNiche(nicheId) {
    return FACTUAL_NICHE_RE.test(String(nicheId || ''));
}

function _isStaticReference(scene, blob) {
    const keyword = String(scene?.keyword || '');
    if (PERSON_REFERENCE_RE.test(keyword) || PERSON_REFERENCE_RE.test(blob)) return true;
    if (STATIC_REFERENCE_RE.test(keyword)) return true;

    // Static terms in the narration are enough only if there is no obvious
    // moving subject. "shipping route map" is static; "ships moving through a
    // strait" should still become video.
    if (STATIC_REFERENCE_RE.test(blob) && !CONCRETE_VIDEO_RE.test(keyword)) {
        return true;
    }

    return false;
}

function _isPlannerWebImageReference(scene) {
    const type = String(scene?.mediaType || '').toLowerCase();
    const source = String(sanitizeSourceHint(scene?.sourceHint || '', 'web-image') || '').toLowerCase();
    return type === 'image' && source === 'web-image';
}

function _hasConcreteVideoSubject(blob) {
    return CONCRETE_VIDEO_RE.test(blob);
}

function _isMostlyAbstract(scene, blob) {
    if (scene?.sceneClass === 'concept-metaphor') return true;
    if (scene?.retrievability === 'internal-only' && !CONCRETE_VIDEO_RE.test(blob)) return true;
    return ABSTRACT_RE.test(blob) && !CONCRETE_VIDEO_RE.test(blob);
}

function _pickVideoSource(scene, scriptContext = {}, niche) {
    const priority = filterDisabledSources(Array.isArray(niche?.footagePriority?.video) ? niche.footagePriority.video : []);
    const nonStock = priority.filter(src => src && src !== 'stock');
    const blob = _textBlob(scene);

    if (MILITARY_ACTOR_RE.test(blob)) {
        if (priority.includes('youtube')) return 'youtube';
        if (priority.includes('reddit')) return 'reddit';
    }
    if (nonStock.length > 0) return nonStock[0];

    const anyReal = priority.find(src => src && src !== 'stock');
    return anyReal || 'youtube';
}

function _pickImageSource(niche) {
    const priority = Array.isArray(niche?.footagePriority?.image) ? niche.footagePriority.image : [];
    if (priority.includes('bing')) return 'web-image';
    return 'web-image';
}

function _ensureQueries(scene) {
    if (!scene.keyword) return;
    if (!scene.stockQuery) {
        scene.stockQuery = String(scene.keyword).split(/\s+/).filter(Boolean).slice(0, 4).join(' ');
    }
    if (!scene.webQuery) {
        scene.webQuery = String(scene.keyword).split(/\s+/).filter(Boolean).slice(0, 8).join(' ');
    }
}

function _buildPolicy(intent) {
    const hard = intent.strength === 'must' || intent.strength === 'prefer';

    if (intent.lane === 'skip') {
        return {
            download: 'skip',
            mediaType: null,
            sourceHint: null,
            allowTypeFallback: false,
            allowProviderFallback: false,
            allowStockFallback: false,
            allowedMediaTypes: [],
            allowedSources: [],
        };
    }

    if (intent.lane === 'template') {
        return {
            download: 'template',
            mediaType: null,
            sourceHint: null,
            allowTypeFallback: false,
            allowProviderFallback: false,
            allowStockFallback: false,
            allowedMediaTypes: [],
            allowedSources: [],
        };
    }

    if (intent.lane === 'realVideo') {
        return {
            download: 'normal',
            mediaType: 'video',
            sourceHint: sanitizeSourceHint(intent.sourceHint || 'youtube', 'youtube'),
            allowTypeFallback: true,
            allowProviderFallback: true,
            allowStockFallback: true,
            allowedMediaTypes: ['video', 'image'],
            allowedSources: intent.strength === 'must' ? REAL_VIDEO_SOURCES : null,
            allowedSourcesByType: intent.strength === 'must'
                ? { video: REAL_VIDEO_SOURCES, image: IMAGE_SOURCES }
                : null,
        };
    }

    if (intent.lane === 'mapImage') {
        return {
            download: 'normal',
            mediaType: 'image',
            sourceHint: sanitizeSourceHint(intent.sourceHint || 'web-image', 'web-image'),
            allowTypeFallback: !hard,
            allowProviderFallback: true,
            allowStockFallback: true,
            allowedMediaTypes: hard ? ['image'] : ['image', 'video'],
            allowedSources: IMAGE_SOURCES,
        };
    }

    return {
        download: 'normal',
        mediaType: intent.mediaType || null,
        sourceHint: sanitizeSourceHint(intent.sourceHint || null, 'youtube'),
        allowTypeFallback: true,
        allowProviderFallback: true,
        allowStockFallback: true,
        allowedMediaTypes: null,
        allowedSources: null,
    };
}

function inferMediaIntent(scene, scenes = [], scriptContext = {}) {
    const nicheId = scriptContext.nicheId || 'general';
    const niche = getNiche(nicheId);
    const blob = _textBlob(scene);
    const factual = _isFactualNiche(nicheId);

    if (!scene) {
        return { lane: 'none', strength: 'skip', reason: 'missing scene' };
    }
    // Talking-head presenter anchor: media is the injected presenter image (fullscreenMG
    // is nulled by enforce, so _isFullscreen won't catch it). Keep the download='skip'
    // contract so this beat never runs the B-roll download + vision gauntlet.
    if (scene._presenterAnchor || (scene.presenterInsert && scene.presenterInsert.layout !== 'pip')) {
        return { lane: 'skip', strength: 'skip', reason: 'presenter hold — media is the injected presenter, not downloaded' };
    }
    if (_isFullscreen(scene)) {
        return { lane: 'skip', strength: 'must', reason: 'fullscreen motion graphic replaces downloader media' };
    }
    const currentType = scene.mediaType || 'video';
    const currentSource = scene.sourceHint || '';
    const staticReference = _isStaticReference(scene, blob);
    const concreteVideo = _hasConcreteVideoSubject(blob);

    if (_isPlannerWebImageReference(scene)) {
        return {
            lane: 'mapImage',
            mediaType: 'image',
            sourceHint: 'web-image',
            strength: 'must',
            reason: 'visual planner selected exact web-image still',
        };
    }

    if (staticReference) {
        return {
            lane: 'mapImage',
            mediaType: 'image',
            sourceHint: _pickImageSource(niche),
            strength: PERSON_REFERENCE_RE.test(blob) ? 'must' : 'prefer',
            reason: 'static reference/portrait/map/document scene',
        };
    }

    if (factual && concreteVideo) {
        return {
            lane: 'realVideo',
            mediaType: 'video',
            sourceHint: sanitizeSourceHint(_pickVideoSource(scene, scriptContext, niche), 'youtube'),
            strength: 'must',
            reason: 'concrete factual scene needs moving real-world footage',
        };
    }

    if (concreteVideo && currentType === 'image' && currentSource !== 'web-image') {
        return {
            lane: 'realVideo',
            mediaType: 'video',
            sourceHint: sanitizeSourceHint(_pickVideoSource(scene, scriptContext, niche), 'youtube'),
            strength: 'prefer',
            reason: 'concrete moving subject was routed as non-reference image',
        };
    }

    if (_isMostlyAbstract(scene, blob)) {
        return {
            lane: currentType === 'image' ? 'image' : 'video',
            mediaType: currentType,
            sourceHint: sanitizeSourceHint(currentSource || (currentType === 'image' ? _pickImageSource(niche) : (niche.footagePriority?.video?.[0] || 'stock')), 'youtube'),
            strength: 'soft',
            reason: 'abstract/concept scene; keep planner lane unless another guard converts to template/MG',
        };
    }

    return {
        lane: currentType === 'image' ? 'image' : 'video',
        mediaType: currentType,
        sourceHint: sanitizeSourceHint(currentSource || (currentType === 'image' ? _pickImageSource(niche) : (niche.footagePriority?.video?.[0] || 'stock')), 'youtube'),
        strength: 'soft',
        reason: 'planner lane acceptable',
    };
}

function applyMediaIntentController(scenes, scriptContext = {}, options = {}) {
    const changes = [];
    const decisions = [];
    if (!Array.isArray(scenes)) return { changes, decisions };

    for (const scene of scenes) {
        const intent = inferMediaIntent(scene, scenes, scriptContext);
        decisions.push({ index: scene?.index, ...intent });
        if (!scene || intent.strength === 'skip') continue;

        scene.mediaIntent = {
            lane: intent.lane,
            strength: intent.strength,
            reason: intent.reason,
            mediaType: intent.mediaType || null,
            sourceHint: intent.sourceHint || null,
            policy: _buildPolicy(intent),
        };

        if (intent.lane !== 'realVideo' && intent.lane !== 'mapImage' && intent.lane !== 'video' && intent.lane !== 'image') continue;

        const beforeType = scene.mediaType || null;
        const beforeSource = scene.sourceHint || null;
        let changed = false;

        if (intent.mediaType && scene.mediaType !== intent.mediaType) {
            scene.mediaType = intent.mediaType;
            changed = true;
        }

        if (intent.sourceHint && scene.sourceHint !== intent.sourceHint) {
            // Do not rewrite a valid web-image reference into provider internals.
            scene.sourceHint = intent.sourceHint;
            changed = true;
        }

        if (changed) {
            _ensureQueries(scene);
            changes.push(
                `S${scene.index}: media intent ${beforeType || 'none'}/${beforeSource || 'none'} -> ${scene.mediaType}/${scene.sourceHint || 'none'} (${intent.reason})`
            );
        }
    }

    if (options.log !== false) {
        const hard = changes.length;
        const videoMust = decisions.filter(d => (d.lane === 'realVideo' || d.lane === 'video') && d.strength === 'must').length;
        const imageRef = decisions.filter(d => (d.lane === 'mapImage' || d.lane === 'image') && (d.strength === 'must' || d.strength === 'prefer')).length;
        console.log(`   [Media Intent] decisions=${decisions.length} videoMust=${videoMust} staticImage=${imageRef} corrections=${hard}`);
    }

    return { changes, decisions };
}

module.exports = {
    applyMediaIntentController,
    inferMediaIntent,
};
