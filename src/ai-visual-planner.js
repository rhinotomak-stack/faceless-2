/**
 * AI Visual Planner Module — Step 4 of the pipeline
 *
 * Replaces ai-keywords.js with a BATCH approach.
 * Instead of calling AI once per scene (N calls), we call it ONCE for ALL scenes.
 *
 * Why batch is better:
 *   - AI sees the FULL video story arc → plans visual variety
 *   - AI understands context from ai-director.js → smarter keyword choices
 *   - 1 API call instead of N calls → faster, cheaper
 *   - Visual consistency across the video (no repetition)
 *
 * Receives from ai-director.js:
 *   - scenes: Scene[] with text, timestamps, words
 *   - scriptContext: { theme, tone, mood, pacing, format, entities, hook, CTA, etc. }
 *   - directorsBrief: Quality tier, format, audience hint
 *
 * Outputs:
 *   - Enriched scenes with:
 *     • keyword: "FBI agents raiding mansion at night"
 *     • mediaType: "video" | "image"
 *     • sourceHint: "stock" | "youtube" | "web-image" | "telegram" | "reddit"
 *     • visualIntent: "Aerial establishing shot of large mansion surrounded by police vehicles"
 *     • effects: ["grain", "vignette"] — expanded from effectPreset (preset-based, not individual picks)
 *     • mgHint: "lowerThird: Detective Smith, Lead Investigator" — MG suggestion from niche's allowed list (or null)
 *
 * Uses shared ai-provider.js for all AI calls.
 */

const { callAI } = require('./ai-provider');
const config = require('./config');
const path = require('path');
const fs = require('fs');
const { getMatchingBackgrounds, BACKGROUND_LIBRARY, getTheme } = require('./themes');

// ============================================================
// HELPERS
// ============================================================

/**
 * Scan assets/backgrounds/ for custom background files, optionally filtered by theme.
 * Theme tagging convention: "{theme}--{name}.ext" (e.g., "history--vintage-paper.jpg")
 * Files without a theme prefix are available for all themes.
 */
function _scanCustomBackgrounds(themeId) {
    const bgDir = path.join(__dirname, '..', 'assets', 'backgrounds');
    if (!fs.existsSync(bgDir)) return [];

    const VALID_THEMES = new Set(['crime', 'history', 'modern', 'minimal', 'standard']);
    const supportedExts = new Set(['.mp4', '.webm', '.mov', '.jpg', '.jpeg', '.png', '.gif']);

    try {
        const files = fs.readdirSync(bgDir).filter(f => {
            const ext = path.extname(f).toLowerCase();
            return supportedExts.has(ext) && !f.startsWith('.');
        });

        return files.map(f => {
            let name = path.basename(f, path.extname(f));
            let theme = null;
            const dashIdx = name.indexOf('--');
            if (dashIdx > 0) {
                const prefix = name.substring(0, dashIdx).toLowerCase();
                if (VALID_THEMES.has(prefix)) {
                    theme = prefix;
                    name = name.substring(dashIdx + 2);
                }
            }
            return { filename: f, name, theme };
        }).filter(bg => !bg.theme || bg.theme === themeId);
    } catch (e) {
        return [];
    }
}

/**
 * Build a list of available backgrounds for the AI prompt.
 * Includes built-in gradients + custom files matching the current theme.
 */
function _buildBackgroundList(themeId) {
    const matched = getMatchingBackgrounds(themeId || 'standard');
    // Show top 6 gradient matches to keep prompt concise
    const shown = matched.slice(0, 6);
    let lines = shown.map(bg => `   - "${bg.id}" = ${bg.name} (gradient)`);

    // Add custom background files matching this theme
    const customBgs = _scanCustomBackgrounds(themeId);
    for (const bg of customBgs) {
        lines.push(`   - "file:${bg.filename}" = ${bg.name} (custom image/video)`);
    }

    return lines.join('\n');
}

/**
 * Auto-generate a stock-optimized query from a descriptive keyword.
 * Stock APIs work best with 2-3 visual/generic words.
 * Strips names, dates, specifics — keeps visual descriptors.
 */
function _autoStockQuery(keyword) {
    // Common non-visual words to strip for stock search
    const STRIP = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
        'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be',
        'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should',
        'this', 'that', 'their', 'its', 'photo', 'photos', 'image', 'images',
        'footage', 'video', 'clip', 'picture', 'portrait', 'press', 'conference',
        'report', 'event', 'scene', 'shot', 'view', 'real', 'actual',
    ]);

    // Words that are visual descriptors (keep these)
    const VISUAL = new Set([
        'aerial', 'closeup', 'close-up', 'wide', 'panoramic', 'night', 'dark',
        'dramatic', 'cinematic', 'golden', 'silhouette', 'underwater', 'slow',
        'timelapse', 'drone', 'macro', 'bokeh', 'sunset', 'sunrise', 'rain',
        'fog', 'smoke', 'fire', 'explosion', 'neon', 'glowing', 'abstract',
    ]);

    const words = keyword.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(Boolean);
    // Remove stop words, keep visual descriptors and nouns
    const kept = words.filter(w => !STRIP.has(w) && w.length > 2);

    if (kept.length <= 3) return kept.join(' ') || keyword.split(/\s+/).slice(0, 3).join(' ');

    // Prioritize: visual descriptors first, then longest words (likely nouns)
    const visual = kept.filter(w => VISUAL.has(w));
    const rest = kept.filter(w => !VISUAL.has(w)).sort((a, b) => b.length - a.length);
    const selected = [...visual.slice(0, 1), ...rest].slice(0, 3);
    return selected.join(' ');
}

/**
 * Auto-generate a web-optimized query from a descriptive keyword.
 * Web search benefits from specificity — keep names, dates, add context.
 */
function _autoWebQuery(keyword, sourceHint) {
    let query = keyword.trim();
    // If it's already short enough for web, use as-is
    if (query.split(/\s+/).length <= 6) return query;
    // Take first 6 meaningful words
    const words = query.split(/\s+/).slice(0, 6).join(' ');
    return words;
}

function _clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function _getScenePhase(scene, scriptContext = {}) {
    const hookEnd = parseFloat(scriptContext.hookEndTime);
    const ctaStart = parseFloat(scriptContext.ctaStartTime);
    if (!Number.isNaN(hookEnd) && (scene.startTime || 0) < hookEnd) return 'hook';
    if (scriptContext.ctaDetected && !Number.isNaN(ctaStart) && (scene.startTime || 0) >= ctaStart) return 'cta';
    return 'body';
}
// Known template + fullscreenMG type names, matched flexibly
// (both camelCase and "two word" spellings).
const _TEMPLATE_TYPE_ALIASES = {
    statCard:        [/\bstat[\s-]*cards?\b/],
    factCard:        [/\bfact[\s-]*cards?\b/],
    personIntro:     [/\bperson[\s-]*intro(?:duction)?s?\b/, /\bperson card\b/],
    locationCard:    [/\blocation[\s-]*cards?\b/, /\bplace cards?\b/],
    chapterCard:     [/\bchapter[\s-]*cards?\b/, /\bsection cards?\b/],
    quoteCard:       [/\bquote[\s-]*cards?\b/],
    keyTakeaway:     [/\bkey[\s-]*takeaways?\b/, /\btakeaway cards?\b/],
    comparisonCard:  [/\bcomparison[\s-]*cards?\b/, /\bvs(?:\.|\s)*cards?\b/],
    timelineCard:    [/\btimeline[\s-]*cards?\b/],
    imageShowcase:   [/\bimage[\s-]*showcase\b/, /\bphoto[\s-]*collage\b/, /\bpicture[\s-]*grid\b/],
    splitScreen:     [/\bsplit[\s-]*screens?\b/, /\bside[\s-]*by[\s-]*sides?\b/],
    infographic:     [/\binfographics?\b/],
};
const _FULLSCREEN_TYPE_ALIASES = {
    mapChart:        [/\bmap[\s-]*charts?\b/, /\broute[\s-]*maps?\b/, /\btrade[\s-]*route[\s-]*maps?\b/, /\bshipping[\s-]*route[\s-]*maps?\b/, /\blocator[\s-]*maps?\b/],
    barChart:        [/\bbar[\s-]*charts?\b/],
    donutChart:      [/\bdonut[\s-]*charts?\b/, /\bpie[\s-]*charts?\b/],
    timeline:        [/\btimeline\b/],
    bulletList:      [/\bbullet[\s-]*lists?\b/],
    rankingList:     [/\branking[\s-]*lists?\b/, /\btop[\s-]*\d+[\s-]*lists?\b/],
    comparisonCard:  [/\bcomparison[\s-]*cards?\b/],
    kineticText:     [/\bkinetic[\s-]*texts?\b/],
    articleHighlight:[/\barticle[\s-]*highlights?\b/, /\bheadline[\s-]*cards?\b/],
};

function _parseVisualInstructionPrefs(rawInstructions = '') {
    const raw = String(rawInstructions || '').trim();
    const lower = raw.toLowerCase();
    const prefs = {
        raw,
        hasUserDirectives: raw.length > 0,
        avoidStock: /\b(?:no|avoid|without|don't use|dont use)\s+(?:any\s+)?stock\b/.test(lower),
        preferRealFootage: /\b(?:real|raw|authentic)\s+(?:footage|video|clips?)\b/.test(lower) || /\bprefer real footage\b/.test(lower),
        preferMaps: /\b(?:use|prefer|more)\s+maps?\b/.test(lower) || /\bmap animation\b/.test(lower) || /\b(?:map[\s-]*charts?|route[\s-]*maps?|trade[\s-]*route[\s-]*maps?|shipping[\s-]*route[\s-]*maps?|locator[\s-]*maps?)\b/.test(lower),
        preferTemplates: /\b(?:use|prefer|more)\s+(?:templates?|infographics?|cards?)\b/.test(lower) || /\buse more templates?\b/.test(lower),
        preferGraphics: /\b(?:use|prefer|more)\s+(?:graphics|motion graphics|mgs?|overlays)\b/.test(lower),
        minimizeGraphics: /\b(?:no|avoid|less|fewer|minimal)\s+(?:graphics|motion graphics|mgs?|overlays)\b/.test(lower),
        avoidFullscreenMG: /\b(?:no|avoid|less|fewer|minimal|minimize)\s+(?:fullscreen|full-?screen|full screen)(?:\s+(?:graphics|mgs?))?\b/.test(lower),
        preferImages: /\b(?:use|prefer|more)\s+(?:images|photos|stills)\b/.test(lower),
        preferVideos: /\b(?:use|prefer|more)\s+(?:video|videos|footage|clips)\b/.test(lower),
        preferFloating: /\b(?:use|prefer|more)\s+floating\b/.test(lower),
        preferCinematic: /\b(?:use|prefer|more)\s+cinematic\b/.test(lower),
        preferFullscreen: /\b(?:use|prefer|mostly)\s+fullscreen\b/.test(lower),
        requestedTemplateTypes: new Set(),
        requestedFullscreenTypes: new Set(),
        bannedSources: new Set(),
        preferredSources: [],
    };

    // Detect explicit type names the user wrote in instructions — AI still chooses
    // WHERE to apply them; we just surface the ask in the prompt.
    for (const [type, patterns] of Object.entries(_TEMPLATE_TYPE_ALIASES)) {
        if (patterns.some(re => re.test(lower))) prefs.requestedTemplateTypes.add(type);
    }
    for (const [type, patterns] of Object.entries(_FULLSCREEN_TYPE_ALIASES)) {
        if (patterns.some(re => re.test(lower))) prefs.requestedFullscreenTypes.add(type);
    }

    const sourcePatterns = [
        { source: 'stock', bans: [/\b(?:no|avoid|don't use|dont use)\s+stock\b/], prefers: [/\b(?:prefer|use|more)\s+stock\b/] },
        { source: 'youtube', bans: [/\b(?:no|avoid|don't use|dont use)\s+youtube\b/], prefers: [/\b(?:prefer|use|more)\s+youtube\b/] },
        { source: 'telegram', bans: [/\b(?:no|avoid|don't use|dont use)\s+telegram\b/], prefers: [/\b(?:prefer|use|more)\s+telegram\b/] },
        { source: 'reddit', bans: [/\b(?:no|avoid|don't use|dont use)\s+reddit\b/], prefers: [/\b(?:prefer|use|more)\s+reddit\b/] },
        { source: 'web-image', bans: [/\b(?:no|avoid|don't use|dont use)\s+(?:web images?|web-image|google images?)\b/], prefers: [/\b(?:prefer|use|more)\s+(?:web images?|web-image|google images?)\b/] },
    ];

    for (const cfg of sourcePatterns) {
        if (cfg.bans.some(re => re.test(lower))) prefs.bannedSources.add(cfg.source);
        if (cfg.prefers.some(re => re.test(lower))) prefs.preferredSources.push(cfg.source);
    }

    prefs.preferredSources = [...new Set(prefs.preferredSources)];
    prefs.preferredVideoRatio =
        prefs.preferVideos ? 0.78 :
        prefs.preferImages ? 0.35 :
        null;
    prefs.preferredFraming =
        prefs.preferFullscreen ? 'fullscreen' :
        prefs.preferFloating ? 'floating' :
        prefs.preferCinematic ? 'cinematic' :
        null;

    return prefs;
}

function _deriveStylePlannerPrefs(styleProfile) {
    if (!styleProfile || typeof styleProfile !== 'object') {
        return {
            hasStyleInfluence: false,
            targetVideoRatio: null,
            preferRealSources: false,
            mgDensity: null,
            preferredMGTypes: [],
            hookUsesMG: false,
            framingBias: null,
        };
    }

    const footage = styleProfile.footage || {};
    const motionGraphics = styleProfile.motionGraphics || {};
    const summaryText = [
        styleProfile.summary || '',
        ...(Array.isArray(styleProfile.systemNotes) ? styleProfile.systemNotes.map(n => `${n.observation || ''} ${n.gap || ''}`) : []),
    ].join(' ').toLowerCase();

    let framingBias = null;
    if (/\bfloating\b|\bframed\b|\bexhibit\b|\bphoto on\b/.test(summaryText)) {
        framingBias = 'floating';
    } else if (/\bcinematic\b|\bpulled back\b|\bletterbox\b/.test(summaryText)) {
        framingBias = 'cinematic';
    }

    const stockVsReal = String(footage.stockVsReal || '').toLowerCase();
    const targetVideoRatio = typeof footage.videoToImageRatio === 'number'
        ? _clamp(footage.videoToImageRatio, 0.2, 0.9)
        : null;

    return {
        hasStyleInfluence: true,
        targetVideoRatio,
        preferRealSources: stockVsReal.includes('real') || stockVsReal.includes('mixed'),
        mgDensity: (motionGraphics.density || '').toLowerCase() || null,
        preferredMGTypes: Array.isArray(motionGraphics.preferredTypes) ? motionGraphics.preferredTypes : [],
        hookUsesMG: !!styleProfile.hook?.usesMG,
        framingBias,
    };
}

function _buildPlannerDirectives(scenes, scriptContext, directorsBrief) {
    return {
        user: _parseVisualInstructionPrefs(directorsBrief?.freeInstructions || ''),
        style: _deriveStylePlannerPrefs(scriptContext?.styleProfile || directorsBrief?.styleProfile || null),
        sceneCount: scenes.length,
    };
}

function _countRegexMatches(text, patterns) {
    const lower = String(text || '').toLowerCase();
    return patterns.reduce((count, pattern) => count + (pattern.test(lower) ? 1 : 0), 0);
}

function _deriveSceneSignals(scene, scenes, scriptContext) {
    const text = String(scene.text || '');
    const lower = text.toLowerCase();
    const entities = scriptContext?.entities || [];
    const entityTypes = scriptContext?.entityTypes || {};
    const matchedEntities = entities.filter(e => lower.includes(e.toLowerCase()));
    const placeTypes = new Set(['place', 'location', 'country', 'city', 'region']);
    const people = matchedEntities.filter(e => entityTypes[e.toLowerCase()] === 'person');
    const places = matchedEntities.filter(e => placeTypes.has(entityTypes[e.toLowerCase()]));
    const numericTokens = text.match(/\b(?:\$?\d+(?:\.\d+)?%?|\d{4})\b/g) || [];
    const geoTerms = [
        /\bstrait\b/, /\bgulf\b/, /\bsea\b/, /\bocean\b/, /\broute\b/, /\bcorridor\b/,
        /\bshipping\b/, /\btrade\b/, /\bpipeline\b/, /\bport\b/, /\bterminal\b/,
        /\bharbor\b/, /\bcanal\b/, /\bborder\b/, /\bchokepoint\b/,
    ];
    const mapCandidate = places.length >= 2 || _countRegexMatches(lower, geoTerms) >= 2;
    const hasQuote = /["“”]/.test(text) || /\bquote\b|\bsaid\b/.test(lower);
    const likelyAction = /\b(attack|strike|launch|sail|drive|march|fire|moving|tour|training|operation|meeting|speeches?|protests?|election|vote|summit|review|walkthrough)\b/.test(lower);
    const likelyDataImage = numericTokens.length > 0 || /\b(percent|rate|chart|graph|data|ranking|budget|stat)\b/.test(lower);
    const isAbstractMood = !likelyAction && !likelyDataImage && people.length === 0 && places.length === 0 &&
        /\b(sunset|storm|rain|night|crowd|city|smoke|cloud|ocean|aerial|abstract|mood)\b/.test(lower);
    const firstPersonIntro = people.find(person => {
        return !scenes.some(other => {
            if ((other.index || 0) >= (scene.index || 0)) return false;
            return String(other.text || '').toLowerCase().includes(person.toLowerCase());
        });
    }) || null;

    return {
        phase: _getScenePhase(scene, scriptContext),
        matchedEntities,
        people,
        places,
        primaryPerson: people[0] || null,
        firstPersonIntro,
        numericTokens,
        hasNumeric: numericTokens.length > 0,
        hasQuote,
        hasMapCandidate: mapCandidate,
        likelyAction,
        likelyDataImage,
        isAbstractMood,
    };
}

function _sceneTagString(scene, scenes, scriptContext) {
    const signals = _deriveSceneSignals(scene, scenes, scriptContext);
    const tags = [signals.phase.toUpperCase()];
    if (signals.hasNumeric) tags.push('STAT');
    if (signals.hasMapCandidate) tags.push('GEO');
    if (signals.firstPersonIntro) tags.push('PERSON-INTRO');
    if (signals.hasQuote) tags.push('QUOTE');
    return tags.join(', ');
}

// Deterministic scene-role classifier. Returns a primary editorial role plus
// hard structural flags the planner prompt can show as CONSTRAINTS — so the
// AI doesn't have to re-derive them and we don't have to fix bad lane picks
// downstream. Logic only uses already-derived signals + niche/mapPolicy +
// scene class — no extra AI cost.
const _NEWS_ACTOR_RE = /\b(iran|russia|houthi|hamas|idf|nato|ukraine|israel|china|north korea|hezbollah|taliban|isis|kremlin|pentagon|cia|fbi|saudi|riyadh|tehran|moscow|beijing|kyiv|gaza|west bank)\b/i;
const _NEWS_VERB_RE  = /\b(navy|forces|strike|patrol|attack|invasion|missile|drone|blockade|sanctions?|airstrike|offensive|deploy|launches?|launch(?:ed|ing)?|deploy(?:ed|ing|ment)?|fired|incursion|ceasefire|treaty|summit)\b/i;
const _ROUTE_RE      = /\b(route|corridor|pipeline|shipping|trade|strait|canal|advance|march|movement|expansion|invasion path|push toward|drove from|sailed from|traveled from|from\s+\w+\s+to\s+\w+)\b/i;
const _REGION_RE     = /\b(region|territory|empire|throughout|across the|all over|continent|peninsula|eastern|western|northern|southern)\b/i;
const _COMPARISON_RE = /\b(versus|vs\.?|compared to|side by side|contrast|in contrast|while .* by contrast)\b/i;
const _PRODUCT_DEMO_RE = /\b(launch|unveil|release|reveal|demo|new model|ces|keynote|reveal event|showcase)\b/i;

function _deriveSceneRoles(scene, signals, scriptContext, niche, mapPolicy) {
    const text = String(scene.text || '');
    const lower = text.toLowerCase();
    const allowedMGs = (niche && Array.isArray(niche.allowedMGs)) ? niche.allowedMGs : [];
    const nicheAllowsMap = allowedMGs.includes('mapChart');
    const nicheAllowsTimeline = allowedMGs.includes('timeline');
    const nicheAllowsBars = allowedMGs.includes('barChart') || allowedMGs.includes('donutChart') || allowedMGs.includes('rankingList');
    const nicheAllowsStatOverlay = allowedMGs.includes('statCounter');
    const nicheAllowsAnyStat = nicheAllowsBars || nicheAllowsStatOverlay;
    const nicheAllowsTypography = allowedMGs.includes('focusWord') || allowedMGs.includes('kineticText');
    const isNewsActor = _NEWS_ACTOR_RE.test(lower) && _NEWS_VERB_RE.test(lower);
    const phase = signals.phase;

    // Map mode resolution (only meaningful when hasMapCandidate)
    let mapMode = null;
    if (signals.hasMapCandidate) {
        if (_COMPARISON_RE.test(lower) && signals.places.length >= 2) {
            mapMode = 'comparison';
        } else if (_ROUTE_RE.test(lower) && signals.places.length >= 1) {
            mapMode = 'route';
        } else if (_REGION_RE.test(lower) || (signals.places.length === 1 && /\b(across|through|within|inside)\b/.test(lower))) {
            mapMode = 'region';
        } else {
            mapMode = 'locator';
        }
        if (mapPolicy && Array.isArray(mapPolicy.preferredModes) && mapPolicy.preferredModes.length > 0) {
            // Tie-break ambiguous → niche's preferred mode
            const ambiguous = (mapMode === 'locator' && signals.places.length >= 2 && !_ROUTE_RE.test(lower) && !_COMPARISON_RE.test(lower));
            if (ambiguous) mapMode = mapPolicy.preferredModes[0];
        }
    }

    // Hard map flags. Hook + CTA scenes always block fullscreen map graphics —
    // hooks need real grabby visuals, CTAs need closing footage. Niche allowlist
    // also gates this. mapAllowed and mapForbidden must stay mutually exclusive.
    const mapForbidden = !nicheAllowsMap || phase === 'cta' || phase === 'hook';
    const mapAllowed = signals.hasMapCandidate && !mapForbidden;
    const mapPreferred = mapAllowed && (
        signals.places.length >= 2 ||
        _ROUTE_RE.test(lower) ||
        (isNewsActor && signals.places.length >= 1)
    );

    // Class block of map: scene class may explicitly block 'map'
    const classBlocked = new Set(scene.treatmentHint?.blocked || []);
    const mapBlockedByClass = classBlocked.has('map');

    // Stock appropriateness
    const stockInappropriate = (
        isNewsActor ||
        (signals.primaryPerson != null) ||
        signals.hasMapCandidate ||
        (niche?.id?.startsWith?.('news')) ||
        (signals.hasNumeric && signals.likelyDataImage)
    ) && !signals.isAbstractMood;

    // Fullscreen MG framing
    const fullscreenAllowed = phase !== 'hook' && phase !== 'cta';
    const fullscreenDiscouraged = phase === 'hook' || phase === 'cta' || (signals.likelyAction && !signals.hasNumeric);

    // Allowed MG families this scene can SUPPORT (not what to USE — what is editorial-fit)
    const allowedMGFamilies = [];
    if (mapAllowed && !mapBlockedByClass) allowedMGFamilies.push('map');
    if (signals.hasNumeric && nicheAllowsAnyStat) allowedMGFamilies.push('data');
    if (signals.hasQuote) allowedMGFamilies.push('callout');
    if (signals.firstPersonIntro) allowedMGFamilies.push('intro');
    if (signals.isAbstractMood && nicheAllowsTypography && phase !== 'hook' && phase !== 'cta') allowedMGFamilies.push('typography');
    if (allowedMGFamilies.length === 0 && fullscreenAllowed) allowedMGFamilies.push('overlay-only');

    // Preferred source family
    let preferredSourceFamily = null;
    if (signals.firstPersonIntro || signals.primaryPerson) preferredSourceFamily = 'web-image-portrait';
    else if (signals.likelyDataImage && !signals.hasMapCandidate) preferredSourceFamily = 'web-image-data';
    else if (signals.hasMapCandidate && mapAllowed) preferredSourceFamily = 'mapChart';
    else if (isNewsActor) preferredSourceFamily = 'real-footage';
    else if (signals.likelyAction) preferredSourceFamily = 'real-footage';
    else if (signals.isAbstractMood) preferredSourceFamily = 'stock-mood';

    // Primary role
    let role = 'generic';
    if (mapPreferred && !mapBlockedByClass) {
        if (mapMode === 'route') role = 'geo-route';
        else if (mapMode === 'region') role = 'geo-region';
        else if (mapMode === 'comparison') role = 'geo-compare';
        else role = 'geo-establish';
    } else if (signals.firstPersonIntro) {
        role = 'person-intro';
    } else if (signals.hasQuote) {
        role = 'quote-beat';
    } else if (signals.hasNumeric && signals.numericTokens.length >= 2) {
        role = 'stat-beat';
    } else if (isNewsActor) {
        role = 'escalation-news';
    } else if (_PRODUCT_DEMO_RE.test(lower) && (niche?.id?.startsWith?.('news.tech') || niche?.id?.startsWith?.('explainer.tech'))) {
        role = 'product-demo';
    } else if (signals.isAbstractMood) {
        role = 'abstract-breathing-room';
    } else if (!signals.likelyAction && !signals.likelyDataImage && !signals.hasMapCandidate && signals.matchedEntities.length === 0) {
        role = 'concept-explainer';
    }

    return {
        role,
        mapMode,
        mapAllowed: mapAllowed && !mapBlockedByClass,
        mapForbidden: mapForbidden || mapBlockedByClass,
        mapPreferred: mapPreferred && !mapBlockedByClass,
        fullscreenAllowed,
        fullscreenDiscouraged,
        stockInappropriate,
        preferredSourceFamily,
        allowedMGFamilies,
        isNewsActor,
    };
}

function _renderSceneConstraintLine(scene, scenes, scriptContext, niche, mapPolicy) {
    const signals = _deriveSceneSignals(scene, scenes, scriptContext);
    const roles = _deriveSceneRoles(scene, signals, scriptContext, niche, mapPolicy);
    const parts = [`ROLE=${roles.role}`];
    if (roles.mapForbidden) {
        parts.push('MAP=forbidden');
    } else if (roles.mapPreferred) {
        parts.push(`MAP=preferred:${roles.mapMode}`);
    } else if (roles.mapAllowed) {
        parts.push(`MAP=allowed:${roles.mapMode || 'locator'}`);
    } else {
        parts.push('MAP=n/a');
    }
    parts.push(`FS-MG=${roles.fullscreenDiscouraged ? 'discouraged' : (roles.fullscreenAllowed ? 'allowed' : 'forbidden')}`);
    parts.push(`STOCK=${roles.stockInappropriate ? 'disallowed' : 'ok'}`);
    if (roles.preferredSourceFamily) parts.push(`SRC=${roles.preferredSourceFamily}`);
    if (roles.allowedMGFamilies.length > 0) parts.push(`MG-FAMILIES=${roles.allowedMGFamilies.join('+')}`);
    return parts.join(' | ');
}

function _getNicheAllowedMGs(nicheId) {
    try {
        const { getNiche } = require('./niches');
        const niche = getNiche(nicheId || 'general');
        return Array.isArray(niche?.allowedMGs) ? niche.allowedMGs : [];
    } catch (err) {
        return [];
    }
}

function _nicheAllowsMapChartById(nicheId) {
    const allowedMGs = _getNicheAllowedMGs(nicheId);
    if (allowedMGs.length === 0) return true;
    return allowedMGs.some(type => String(type).toLowerCase() === 'mapchart');
}

function _fullscreenMGType(value) {
    if (!value || typeof value !== 'string') return null;
    const raw = value.split(':')[0].trim();
    return raw || null;
}

function _snapshotRawAIChoice(scene) {
    if (scene._aiChose) return;
    scene._aiChose = {
        templateHint: scene.templateHint ? String(scene.templateHint).split(':')[0].trim() : null,
        fullscreenMG: scene.fullscreenMG ? String(scene.fullscreenMG).split(':')[0].trim() : null,
        mgHint: scene.mgHint ? String(scene.mgHint).split(':')[0].trim() : null,
        sourceHint: scene.sourceHint || null,
        mediaType: scene.mediaType || null,
        framing: scene.framing || null,
    };
}

function _restoreFootageAfterFullscreenDrop(scene, nicheId, plannerDirectives = null) {
    if (!scene.keyword || scene.keyword === 'none') {
        scene.keyword = extractFallbackKeyword(scene.text || '');
    }
    scene.mediaType = scene.mediaType || 'video';
    scene.sourceHint = scene.sourceHint || _pickPreferredVideoSource(nicheId || 'general', plannerDirectives, 'stock');
    scene.stockQuery = scene.stockQuery || _autoStockQuery(scene.keyword);
    scene.webQuery = scene.webQuery || _autoWebQuery(scene.keyword, scene.sourceHint);
    scene.visualIntent = scene.visualIntent || scene.keyword;
}

function _dropForbiddenMapChart(scene, nicheId, plannerDirectives = null, restoreFootage = false) {
    const fsType = _fullscreenMGType(scene.fullscreenMG);
    if (!fsType || !fsType.toLowerCase().startsWith('map')) return null;
    if (_nicheAllowsMapChartById(nicheId)) return null;

    const before = scene.fullscreenMG;
    scene.fullscreenMG = null;
    scene.mapVariant = null;
    scene._nicheMapDrop = { before, reason: `niche ${nicheId || 'general'} excludes mapChart` };
    if (restoreFootage) {
        _restoreFootageAfterFullscreenDrop(scene, nicheId, plannerDirectives);
    }
    return { index: scene.index, before, after: scene.keyword || 'footage fallback', reason: scene._nicheMapDrop.reason };
}

function _enforceNicheMapChartBan(scenes, nicheId, plannerDirectives = null) {
    if (_nicheAllowsMapChartById(nicheId)) return [];
    const fixes = [];
    for (const scene of scenes || []) {
        const fix = _dropForbiddenMapChart(scene, nicheId, plannerDirectives, true);
        if (fix) fixes.push(fix);
    }
    return fixes;
}

function _renderPlannerDirectiveBlock(plannerDirectives, scriptContext) {
    const lines = [];
    const { user, style } = plannerDirectives;
    const nicheAllowsMapChart = _nicheAllowsMapChartById(scriptContext?.nicheId || 'general');

    if (user.hasUserDirectives) {
        lines.push('VISUAL COMPLIANCE RULES (deterministic, must respect these):');
        if (user.avoidStock) lines.push('- Avoid stock unless the scene is pure abstract mood with no real entity/event.');
        if (user.preferRealFootage) lines.push('- Favor real footage sources over generic stock whenever the scene allows it.');
        if (user.preferMaps) {
            lines.push(nicheAllowsMapChart
                ? '- For geographic / route / chokepoint scenes, prefer maps or route visuals over generic footage.'
                : '- User asked for map/route visuals, but this niche forbids mapChart; use web-image route references, real footage, templates, or overlays instead. Never output fullscreenMG=mapChart.');
        }
        if (user.preferredSources.length > 0) lines.push(`- Preferred sources when they fit: ${user.preferredSources.join(', ')}.`);
        if (user.bannedSources.size > 0) lines.push(`- Avoid these sources when alternatives exist: ${[...user.bannedSources].join(', ')}.`);
        if (user.preferredFraming) lines.push(`- Preferred framing bias: ${user.preferredFraming}.`);
        if (user.preferredVideoRatio != null) lines.push(`- Preferred media mix: ~${Math.round(user.preferredVideoRatio * 100)}% video / ${100 - Math.round(user.preferredVideoRatio * 100)}% image.`);
        if (user.preferGraphics || user.preferTemplates) lines.push('- Be more proactive about graphics/templates when the narration has numbers, quotes, or introductions.');
        if (user.minimizeGraphics) lines.push('- Keep motion graphics sparse unless the narration clearly needs one.');
        if (user.avoidFullscreenMG) lines.push('- User asked for FEWER fullscreen MGs. Prefer overlay mgHint or templateHint over fullscreenMG when the scene content allows it.');
        if (user.requestedTemplateTypes && user.requestedTemplateTypes.size > 0) {
            lines.push(`- User explicitly asked for these TEMPLATES where they fit naturally (YOU decide which scenes): ${[...user.requestedTemplateTypes].join(', ')}.`);
        }
        if (user.requestedFullscreenTypes && user.requestedFullscreenTypes.size > 0) {
            lines.push(`- User explicitly asked for these FULLSCREEN MG types where they fit naturally (YOU decide which scenes): ${[...user.requestedFullscreenTypes].join(', ')}.`);
        }
    }

    if (style.hasStyleInfluence) {
        lines.push('STYLE-DRIVEN VISUAL PRIORS (soft constraints, deterministic):');
        if (style.targetVideoRatio != null) lines.push(`- Style media mix target: ~${Math.round(style.targetVideoRatio * 100)}% video / ${100 - Math.round(style.targetVideoRatio * 100)}% image.`);
        if (style.preferRealSources) lines.push('- Style leans toward real/documentary footage over generic stock.');
        if (style.mgDensity) lines.push(`- Style MG density inspiration: ${style.mgDensity}.`);
        if (style.preferredMGTypes.length > 0) lines.push(`- Style frequently uses MG types like: ${style.preferredMGTypes.slice(0, 5).join(', ')}.`);
        if (style.hookUsesMG) lines.push('- Style reference uses graphics in the hook when the narration supports them.');
        if (style.framingBias) lines.push(`- Style framing bias: ${style.framingBias} when it fits the shot.`);
    }

    if (scriptContext.mainPoints?.length > 0) {
        lines.push(`UPSTREAM STORY POINTS: ${scriptContext.mainPoints.slice(0, 6).join(' | ')}`);
    }
    if (scriptContext.sections?.length > 0) {
        const sectionNames = scriptContext.sections
            .map(s => typeof s === 'string' ? s : s?.title)
            .filter(Boolean);
        if (sectionNames.length > 0) lines.push(`UPSTREAM SECTIONS: ${sectionNames.slice(0, 8).join(' | ')}`);
    }

    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

function _compactSceneText(text, maxLen = 160) {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (clean.length <= maxLen) return clean;
    return `${clean.substring(0, Math.max(0, maxLen - 3)).trim()}...`;
}

function buildGlobalOutlinePrompt(scenes, scriptContext, directorsBrief, plannerDirectives) {
    const nicheId = scriptContext.nicheId || 'general';
    const { getNiche } = require('./niches');
    const niche = getNiche(nicheId);
    const nicheAllowsMapChart = _nicheAllowsMapChartById(nicheId);
    const { user, style } = plannerDirectives;

    const sceneList = scenes.map(scene => {
        const duration = ((scene.endTime || 0) - (scene.startTime || 0)).toFixed(1);
        const tags = _sceneTagString(scene, scenes, scriptContext);
        return `SCENE ${scene.index} (${scene.startTime.toFixed(1)}s-${scene.endTime.toFixed(1)}s, ${duration}s) [${tags}]: "${_compactSceneText(scene.text, 180)}"`;
    }).join('\n');

    const directiveLines = [];
    if (user.hasUserDirectives) {
        directiveLines.push(`- User instructions: ${user.raw}`);
        if (user.preferMaps) {
            directiveLines.push(nicheAllowsMapChart
                ? '- User wants maps / route visuals when they fit.'
                : '- User asked for map/route visuals, but mapChart is forbidden by this niche; use route footage, web-image references, templates, or overlays instead.');
        }
        if (user.preferTemplates) directiveLines.push('- User wants more template/card usage when editorially justified.');
        if (user.preferGraphics) directiveLines.push('- User is open to more graphics when the narration benefits.');
        if (user.avoidFullscreenMG) directiveLines.push('- User prefers fewer fullscreen graphics.');
        if (user.avoidStock) directiveLines.push('- User wants less stock footage.');
    }
    if (style.hasStyleInfluence) {
        if (style.targetVideoRatio != null) directiveLines.push(`- Style media mix target: ~${Math.round(style.targetVideoRatio * 100)}% video.`);
        if (style.preferRealSources) directiveLines.push('- Style prefers real/documentary footage over generic stock.');
        if (style.mgDensity) directiveLines.push(`- Style graphics density inspiration: ${style.mgDensity}.`);
        if (style.framingBias) directiveLines.push(`- Style framing bias: ${style.framingBias}.`);
    }

    return `You are creating a VIDEO-WIDE VISUAL OUTLINE before detailed scene planning.

Think across ALL scenes at once. Your job is to create a concise AI blueprint for the full video so later chunk planners can stay globally consistent.

Do NOT write final stockQuery/webQuery fields. Do NOT output the full detailed planner format. This is an OUTLINE pass only.

VIDEO CONTEXT:
- Niche: ${niche.name} (${niche.description})
- Theme: ${scriptContext.theme || 'general'}
- Tone: ${scriptContext.tone || 'informative'}
- Mood: ${scriptContext.mood || 'neutral'}
- Pacing: ${scriptContext.pacing || 'moderate'}
- Format: ${scriptContext.format || 'general'}
- Summary: ${scriptContext.summary || 'none'}
- Event Anchor: ${scriptContext.eventAnchor || 'none'}
- Main Points: ${scriptContext.mainPoints?.length ? scriptContext.mainPoints.slice(0, 8).join(' | ') : 'none'}
- Sections: ${scriptContext.sections?.length ? scriptContext.sections.map(s => typeof s === 'string' ? s : s?.title).filter(Boolean).slice(0, 8).join(' | ') : 'none'}
- Entities: ${scriptContext.entities?.length ? scriptContext.entities.slice(0, 12).join(', ') : 'none'}
${scriptContext.webContext ? `- Research: ${String(scriptContext.webContext).substring(0, 1200)}` : ''}
${directiveLines.length ? `\nDIRECTIVES:\n${directiveLines.map(line => `  ${line}`).join('\n')}` : ''}

SCENES (${scenes.length} total):
${sceneList}

WHAT YOU MUST DO:
1. Think about the WHOLE visual journey, not just single scenes.
2. Decide where the video should lean into footage, overlays, templates, or fullscreen MG.
3. Prevent repetition across neighboring scenes.
4. Preserve stronger moments for hook / reveal / conclusion scenes.
5. Flag the best editorial opportunities for templates instead of letting everything collapse into fullscreen graphics.

OUTPUT FORMAT:
GLOBAL ARC: <one concise line about the full-video visual journey>
GLOBAL SOURCES: <one concise line about source rhythm across the full video>
GLOBAL GRAPHICS: <one concise line about where templates / overlays / fullscreen graphics should appear>
GLOBAL DIVERSITY: <one concise line about anti-repetition / variation strategy>
Then output ONE line for EVERY scene:
SCENE N: lane=<short editorial role> | source=<best source family> | graphics=<footage|overlay|template|fullscreenMG> | note=<short anti-repeat or emphasis cue>

RULES:
- Cover EVERY scene exactly once.
- Keep scene notes short and practical.
- Let graphics choices be editorial, not mechanical.
- Use "template" when a card/panel layout would communicate better than raw footage.
- Use "fullscreenMG" only when replacing footage is clearly the better communication choice.
- Keep the outline concise and easy for a later planner pass to follow.`;
}

function _parseGlobalVisualOutline(rawText, scenes) {
    const validSceneIds = new Set(scenes.map(scene => scene.index));
    const lines = String(rawText || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const globalLines = [];
    const sceneHints = {};

    for (const line of lines) {
        const sceneMatch = line.match(/^SCENE\s+(\d+)\s*:\s*(.+)$/i);
        if (sceneMatch) {
            const idx = parseInt(sceneMatch[1], 10);
            if (!validSceneIds.has(idx)) continue;
            const body = sceneMatch[2].trim();
            const field = (name) => {
                const match = body.match(new RegExp(`\\b${name}\\s*=\\s*([^|]+)`, 'i'));
                return match ? match[1].trim() : '';
            };
            sceneHints[idx] = {
                index: idx,
                raw: body,
                lane: field('lane'),
                source: field('source'),
                graphics: field('graphics'),
                note: field('note'),
            };
            continue;
        }
        if (/^GLOBAL\s+[A-Z ]+:/i.test(line)) {
            globalLines.push(line);
        }
    }

    const expected = scenes.length;
    const actual = Object.keys(sceneHints).length;
    const missing = scenes.map(scene => scene.index).filter(idx => !sceneHints[idx]);
    const graphicsCounts = { footage: 0, overlay: 0, template: 0, fullscreenMG: 0, unknown: 0 };
    for (const hint of Object.values(sceneHints)) {
        const g = String(hint.graphics || '').toLowerCase();
        if (g.includes('template')) graphicsCounts.template++;
        else if (g.includes('fullscreen')) graphicsCounts.fullscreenMG++;
        else if (g.includes('overlay')) graphicsCounts.overlay++;
        else if (g.includes('footage')) graphicsCounts.footage++;
        else graphicsCounts.unknown++;
    }

    return {
        rawText: String(rawText || ''),
        globalLines,
        sceneHints,
        coverage: expected > 0 ? actual / expected : 0,
        missing,
        graphicsCounts,
    };
}

function _renderGlobalOutlineBlock(globalOutline, currentScenes) {
    if (!globalOutline) return '';

    const currentIds = currentScenes.map(scene => scene.index);
    const first = currentIds[0];
    const last = currentIds[currentIds.length - 1];
    const currentHints = currentIds
        .map(idx => globalOutline.sceneHints[idx])
        .filter(Boolean);
    const seamIds = [first - 2, first - 1, last + 1, last + 2];
    const seamHints = seamIds
        .map(idx => globalOutline.sceneHints[idx])
        .filter(Boolean);

    const lines = ['FULL-VIDEO AI OUTLINE (generated from ALL scenes before detailed planning):'];
    for (const line of globalOutline.globalLines.slice(0, 4)) {
        lines.push(`- ${line}`);
    }
    if (currentHints.length > 0) {
        lines.push('CURRENT SCENE BLUEPRINT HINTS:');
        for (const hint of currentHints) {
            lines.push(`- Scene ${hint.index}: ${hint.raw}`);
        }
    }
    if (seamHints.length > 0) {
        lines.push('NEIGHBORING SEAM HINTS (for continuity before/after this batch):');
        for (const hint of seamHints) {
            lines.push(`- Scene ${hint.index}: ${hint.raw}`);
        }
    }
    lines.push('Treat this outline as a SOFT whole-video blueprint. Keep the final per-scene plan intelligent and scene-specific.');
    return `\n${lines.join('\n')}\n`;
}

async function _generateGlobalVisualOutline(scenes, scriptContext, directorsBrief, plannerDirectives) {
    console.log(`   🧭 [Step 4 Outline] generating whole-video outline for ${scenes.length} scenes...`);
    const prompt = buildGlobalOutlinePrompt(scenes, scriptContext, directorsBrief, plannerDirectives);
    const maxTokens = Math.max(1200, scenes.length * 60);
    const rawText = await callAI(prompt, { maxTokens });
    if (!rawText) throw new Error('Empty outline response');

    const outline = _parseGlobalVisualOutline(rawText, scenes);
    const coveragePct = Math.round(outline.coverage * 100);
    const gfx = outline.graphicsCounts;
    console.log(`   🧭 [Step 4 Outline] globals=${outline.globalLines.length} sceneHints=${Object.keys(outline.sceneHints).length}/${scenes.length} (${coveragePct}%) graphics={footage:${gfx.footage}, overlay:${gfx.overlay}, template:${gfx.template}, fs:${gfx.fullscreenMG}, unknown:${gfx.unknown}}`);
    if (outline.globalLines.length > 0) {
        console.log(`   🧭 [Step 4 Outline] ${outline.globalLines.slice(0, 2).join(' | ')}`);
    }
    if (outline.missing.length > 0) {
        console.log(`   ⚠️ [Step 4 Outline] missing scene hints for: ${outline.missing.slice(0, 8).join(', ')}${outline.missing.length > 8 ? '...' : ''}`);
    }
    return outline;
}

function _extractFirstStatToken(text) {
    const match = String(text || '').match(/\b(?:\$?\d+(?:\.\d+)?%?|\d{4})\b/);
    return match ? match[0] : null;
}

function _buildMapKeyword(scene, signals, scriptContext) {
    const anchors = [];
    for (const place of signals.places.slice(0, 2)) anchors.push(place);
    if (anchors.length === 0 && scriptContext.eventAnchor) anchors.push(scriptContext.eventAnchor);
    if (anchors.length === 0 && scriptContext.videoTitle) anchors.push(scriptContext.videoTitle.split(/\s+/).slice(0, 4).join(' '));
    const suffix = /\b(route|corridor|pipeline|shipping|trade|strait|canal)\b/i.test(scene.text || '') ? 'route map' : 'map';
    return [...anchors.slice(0, 2), suffix].join(' ').trim() || 'location map';
}

function _pickPreferredVideoSource(nicheId, plannerDirectives, fallback = 'youtube') {
    plannerDirectives = plannerDirectives || {};
    plannerDirectives.user = plannerDirectives.user || {};
    plannerDirectives.user.preferredSources = plannerDirectives.user.preferredSources || [];
    if (!(plannerDirectives.user.bannedSources instanceof Set)) {
        plannerDirectives.user.bannedSources = new Set(plannerDirectives.user.bannedSources || []);
    }
    const { getNiche } = require('./niches');
    const niche = getNiche(nicheId || 'general');
    const videoPriority = niche.footagePriority?.video || [fallback];
    const preferred = plannerDirectives.user.preferredSources.filter(src => videoPriority.includes(src) && src !== 'stock');
    const ordered = [...preferred, ...videoPriority.filter(src => !preferred.includes(src) && src !== 'pexels' && src !== 'pixabay')];
    const allowed = ordered.filter(src => !plannerDirectives.user.bannedSources.has(src));
    return allowed[0] || ordered[0] || fallback;
}

function _applyPlannerMediaMix(scenes, scriptContext, plannerDirectives, stats) {
    const footageScenes = scenes.filter(s => !s.fullscreenMG);
    if (footageScenes.length < 6) return;

    const nicheId = scriptContext.nicheId || 'general';
    const { user, style } = plannerDirectives;
    let targetVideoRatio = user.preferredVideoRatio;
    if (targetVideoRatio == null && style.targetVideoRatio != null && !nicheId.startsWith('news')) {
        targetVideoRatio = style.targetVideoRatio;
    }
    if (targetVideoRatio == null) return;

    const currentVideoCount = footageScenes.filter(s => s.mediaType === 'video').length;
    const currentRatio = currentVideoCount / footageScenes.length;
    if (Math.abs(currentRatio - targetVideoRatio) < 0.08) return;

    if (currentRatio < targetVideoRatio) {
        const needed = Math.ceil(targetVideoRatio * footageScenes.length) - currentVideoCount;
        const topSource = _pickPreferredVideoSource(nicheId, plannerDirectives);
        const candidates = footageScenes
            .filter(s => s.mediaType === 'image' && !s._personLock)
            .map(scene => ({ scene, signals: _deriveSceneSignals(scene, scenes, scriptContext) }))
            .filter(({ signals }) => !signals.likelyDataImage && !signals.hasMapCandidate && !signals.primaryPerson)
            .sort((a, b) => (a.scene.index || 0) - (b.scene.index || 0));

        let flipped = 0;
        for (const { scene } of candidates) {
            if (flipped >= needed) break;
            scene.mediaType = 'video';
            scene.sourceHint = topSource;
            scene.stockQuery = scene.stockQuery || _autoStockQuery(scene.keyword || extractFallbackKeyword(scene.text));
            flipped++;
        }
        if (flipped > 0) stats.styleMixAdjusted += flipped;
    } else {
        const needed = currentVideoCount - Math.floor(targetVideoRatio * footageScenes.length);
        const candidates = footageScenes
            .filter(s => s.mediaType === 'video')
            .map(scene => ({ scene, signals: _deriveSceneSignals(scene, scenes, scriptContext) }))
            .filter(({ signals }) => signals.likelyDataImage || signals.hasMapCandidate || (!signals.likelyAction && signals.phase === 'body'))
            .sort((a, b) => (a.scene.index || 0) - (b.scene.index || 0));

        let flipped = 0;
        for (const { scene, signals } of candidates) {
            if (flipped >= needed) break;
            scene.mediaType = 'image';
            scene.sourceHint = 'web-image';
            if (signals.hasMapCandidate) {
                const mapKeyword = _buildMapKeyword(scene, signals, scriptContext);
                scene.keyword = mapKeyword;
                scene.webQuery = `${mapKeyword} reference image`;
            }
            flipped++;
        }
        if (flipped > 0) stats.styleMixAdjusted += flipped;
    }
}

function _applyGraphicDensity(scenes, scriptContext, plannerDirectives, stats) {
    const { user, style } = plannerDirectives;
    if (user.minimizeGraphics) {
        let cleared = 0;
        for (const scene of scenes) {
            const signals = _deriveSceneSignals(scene, scenes, scriptContext);
            if (scene.mgHint && !signals.hasNumeric && !signals.firstPersonIntro) {
                scene.mgHint = null;
                cleared++;
            }
        }
        if (cleared > 0) stats.graphicsTrimmed += cleared;
        return;
    }

    let targetRatio = null;
    if (style.mgDensity === 'high') targetRatio = 0.22;
    if (style.mgDensity === 'medium') targetRatio = 0.15;
    if (style.mgDensity === 'low') targetRatio = 0.08;
    if (user.preferGraphics || user.preferTemplates) targetRatio = Math.max(targetRatio || 0, 0.18);
    if (!targetRatio) return;

    const currentGraphicScenes = scenes.filter(s => s.mgHint || s.templateHint || s.fullscreenMG).length;
    const needed = Math.max(0, Math.ceil(targetRatio * scenes.length) - currentGraphicScenes);
    if (needed === 0) return;

    const candidates = scenes
        .filter(s => !s.mgHint && !s.templateHint && !s.fullscreenMG)
        .map(scene => ({ scene, signals: _deriveSceneSignals(scene, scenes, scriptContext) }))
        .filter(({ signals }) => signals.phase === 'body' && (signals.hasNumeric || signals.firstPersonIntro || signals.hasQuote))
        .sort((a, b) => {
            const scoreA = (a.signals.hasNumeric ? 3 : 0) + (a.signals.firstPersonIntro ? 2 : 0) + (a.signals.hasQuote ? 1 : 0);
            const scoreB = (b.signals.hasNumeric ? 3 : 0) + (b.signals.firstPersonIntro ? 2 : 0) + (b.signals.hasQuote ? 1 : 0);
            return scoreB - scoreA || ((a.scene.index || 0) - (b.scene.index || 0));
        });

    let injected = 0;
    for (const { scene, signals } of candidates) {
        if (injected >= needed) break;
        if (signals.hasNumeric) {
            const stat = _extractFirstStatToken(scene.text);
            if (stat) {
                scene.mgHint = `statCounter: ${stat}`;
                injected++;
            }
        } else if (signals.firstPersonIntro) {
            scene.mgHint = `lowerThird: ${signals.firstPersonIntro}`;
            injected++;
        } else if (signals.hasQuote) {
            const snippet = String(scene.text || '').replace(/^["“”']+|["“”']+$/g, '').split(/[.?!]/)[0].trim();
            if (snippet) {
                scene.mgHint = `callout: ${snippet.substring(0, 80)}`;
                injected++;
            }
        }
    }

    if (injected > 0) stats.graphicsInjected += injected;
}

function _applyPlannerCompliance(scenes, scriptContext, directorsBrief, plannerDirectives) {
    const nicheId = scriptContext.nicheId || 'general';
    const stats = {
        sourceOverrides: 0,
        mapOverrides: 0,
        framingOverrides: 0,
        styleMixAdjusted: 0,
        graphicsInjected: 0,
        graphicsTrimmed: 0,
    };

    const topVideoSource = _pickPreferredVideoSource(nicheId, plannerDirectives);

    for (const scene of scenes) {
        const signals = _deriveSceneSignals(scene, scenes, scriptContext);
        scene.sceneType = signals.phase;
        scene.narrativeArc = scene.narrativeArc || signals.phase;

        if (!scene.fullscreenMG) {
            const banned = plannerDirectives.user.bannedSources.has(scene.sourceHint);
            const shouldAvoidStock =
                (plannerDirectives.user.avoidStock || plannerDirectives.user.preferRealFootage || plannerDirectives.style.preferRealSources) &&
                scene.sourceHint === 'stock' &&
                !signals.isAbstractMood;

            if (banned || shouldAvoidStock) {
                if (scene.mediaType === 'image' || signals.primaryPerson || signals.likelyDataImage || signals.hasMapCandidate) {
                    if (plannerDirectives.user.bannedSources.has('web-image')) {
                        scene.sourceHint = topVideoSource;
                        scene.mediaType = 'video';
                    } else {
                        scene.sourceHint = 'web-image';
                        scene.mediaType = 'image';
                    }
                } else {
                    scene.sourceHint = topVideoSource;
                    scene.mediaType = 'video';
                }
                stats.sourceOverrides++;
            }

            if (plannerDirectives.user.preferredSources.length > 0 &&
                scene.mediaType === 'video' &&
                !signals.primaryPerson &&
                !signals.likelyDataImage &&
                !signals.hasMapCandidate &&
                !plannerDirectives.user.bannedSources.has(scene.sourceHint)) {
                const preferredSource = _pickPreferredVideoSource(nicheId, plannerDirectives, scene.sourceHint);
                if (preferredSource && preferredSource !== scene.sourceHint) {
                    scene.sourceHint = preferredSource;
                    stats.sourceOverrides++;
                }
            }

            if (plannerDirectives.user.preferMaps && signals.hasMapCandidate && !signals.primaryPerson && signals.phase !== 'cta') {
                const mapKeyword = _buildMapKeyword(scene, signals, scriptContext);
                scene.keyword = mapKeyword;
                const useWebImage = !plannerDirectives.user.bannedSources.has('web-image');
                scene.mediaType = useWebImage ? 'image' : 'video';
                scene.sourceHint = useWebImage ? 'web-image' : topVideoSource;
                scene.webQuery = `${mapKeyword} reference map`;
                scene.stockQuery = _autoStockQuery(mapKeyword);
                if (!scene.visualIntent || scene.visualIntent === scene.keyword) {
                    scene.visualIntent = `Map / route visualization for ${mapKeyword}`;
                }
                stats.mapOverrides++;
            }

            if (plannerDirectives.user.preferredFraming === 'fullscreen') {
                if (scene.framing !== 'fullscreen') {
                    scene.framing = 'fullscreen';
                    scene.backgroundId = 'none';
                    scene.background = 'none';
                    stats.framingOverrides++;
                }
            } else if (plannerDirectives.user.preferredFraming === 'cinematic' &&
                scene.framing === 'fullscreen' &&
                (scene.mediaType === 'image' || scene.sourceHint === 'web-image' || signals.likelyDataImage)) {
                scene.framing = 'cinematic';
                scene.backgroundId = scene.backgroundId || 'blur';
                stats.framingOverrides++;
            } else if (plannerDirectives.user.preferredFraming === 'floating' &&
                scene.framing === 'fullscreen' &&
                (scene.mediaType === 'image' || scene.sourceHint === 'web-image')) {
                scene.framing = 'floating';
                scene.backgroundId = scene.backgroundId || 'soft-beige';
                scene.floatingAnim = scene.floatingAnim || 'fadeScale';
                scene.floatingShadow = scene.floatingShadow || 0.5;
                stats.framingOverrides++;
            } else if (!plannerDirectives.user.preferredFraming &&
                plannerDirectives.style.framingBias === 'floating' &&
                scene.framing === 'fullscreen' &&
                scene.mediaType === 'image' &&
                scene.sourceHint === 'web-image') {
                scene.framing = 'floating';
                scene.backgroundId = scene.backgroundId || 'soft-beige';
                scene.floatingAnim = scene.floatingAnim || 'fadeScale';
                scene.floatingShadow = scene.floatingShadow || 0.5;
                stats.framingOverrides++;
            }
        }
    }

    _applyPlannerMediaMix(scenes, scriptContext, plannerDirectives, stats);
    _applyGraphicDensity(scenes, scriptContext, plannerDirectives, stats);

    for (const scene of scenes) {
        if (scene.framing) scene._framingLocked = true;
    }

    const changeParts = [];
    if (stats.sourceOverrides > 0) changeParts.push(`sources=${stats.sourceOverrides}`);
    if (stats.mapOverrides > 0) changeParts.push(`maps=${stats.mapOverrides}`);
    if (stats.framingOverrides > 0) changeParts.push(`framing=${stats.framingOverrides}`);
    if (stats.styleMixAdjusted > 0) changeParts.push(`styleMix=${stats.styleMixAdjusted}`);
    if (stats.graphicsInjected > 0) changeParts.push(`graphics+${stats.graphicsInjected}`);
    if (stats.graphicsTrimmed > 0) changeParts.push(`graphics-${stats.graphicsTrimmed}`);
    if (changeParts.length > 0) {
        console.log(`   🧭 Planner compliance: ${changeParts.join(' | ')}`);
    }
    return stats;
}

function _finalizeVisualPlan(enrichedScenes, scriptContext, directorsBrief, plannerDirectives) {
    // Listicle keyword variety enforcement
    if (scriptContext.format === 'listicle' && scriptContext.listicleItems) {
        const { enforceKeywordVariety } = require('./listicle-format');
        enforceKeywordVariety(enrichedScenes, scriptContext.listicleItems);

        const firstItem = scriptContext.listicleItems.find(it => it.startSceneIndex != null);
        if (firstItem) {
            const overviewIdx = Math.max(0, firstItem.startSceneIndex - 1);
            const overviewScene = enrichedScenes.find(s => s.index === overviewIdx);
            if (overviewScene && !overviewScene.fullscreenMG) {
                overviewScene.fullscreenMG = 'listicleGrid';
                overviewScene.isListicleOverview = true;
                overviewScene.keyword = null;
                overviewScene.stockQuery = null;
                overviewScene.webQuery = null;
                overviewScene.mediaType = null;
                overviewScene.sourceHint = null;
                console.log(`      [Listicle] Scene ${overviewIdx}: forced to listicleGrid overview (no footage needed)`);
            }
        }
    }

    const complianceStats = _applyPlannerCompliance(enrichedScenes, scriptContext, directorsBrief, plannerDirectives) || {};

    _enforceVideoRatio(enrichedScenes, scriptContext.nicheId);

    if (scriptContext.nicheId && scriptContext.nicheId.startsWith('news')) {
        for (const scene of enrichedScenes) {
            if (scene.sourceHint === 'stock' && scene.mediaType !== 'video') {
                scene.sourceHint = 'web-image';
            }
        }
    }

    const entities = scriptContext.entities || [];
    const entityTypes2 = scriptContext.entityTypes || {};
    if (entities.length > 0) {
        for (const scene of enrichedScenes) {
            if (!scene.keyword || scene.sourceHint === 'web-image') continue;
            const kwLower = scene.keyword.toLowerCase();
            const matchedEntities = entities.filter(e => {
                const eLower = e.toLowerCase();
                return kwLower.includes(eLower) || eLower.includes(kwLower);
            });
            const personEntity = matchedEntities.find(e => entityTypes2[e.toLowerCase()] === 'person');
            const hasPortraitHint = /portrait|photo|headshot|face/i.test(kwLower);
            if (personEntity || hasPortraitHint) {
                if (scene.mediaType !== 'image' || scene.sourceHint !== 'web-image') {
                    console.log(`   🧑 Person override: "${scene.keyword}" → [image, web-image]`);
                    scene.mediaType = 'image';
                    scene.sourceHint = 'web-image';
                }
            }
        }
    }

    _validateKeywords(enrichedScenes, scriptContext);

    // ── CTA zone fullscreenMG guard ──
    // Conclusion/CTA scenes should never be a fullscreenMG — they need real closing
    // footage. If the planner (or a promoter upstream) left one there, strip it and
    // restore sensible footage defaults.
    let ctaGuardStripped = 0;
    for (const scene of enrichedScenes) {
        if (!scene.fullscreenMG) continue;
        const phase = _getScenePhase(scene, scriptContext);
        if (phase !== 'cta') continue;
        scene._correctedFromFullscreen = scene.fullscreenMG;
        scene.fullscreenMG = null;
        if (!scene.keyword || scene.keyword === 'none') {
            scene.keyword = scene.visualIntent || extractFallbackKeyword(scene.text || '');
        }
        if (!scene.mediaType) scene.mediaType = 'video';
        if (!scene.sourceHint) {
            const nicheIdLocal = scriptContext.nicheId || 'general';
            scene.sourceHint = _pickPreferredVideoSource(nicheIdLocal, plannerDirectives, 'stock');
        }
        if (!scene.stockQuery) scene.stockQuery = _autoStockQuery(scene.keyword);
        if (!scene.webQuery)  scene.webQuery  = _autoWebQuery(scene.keyword, scene.sourceHint);
        ctaGuardStripped++;
    }
    if (ctaGuardStripped > 0) {
        console.log(`   🛡️  CTA guard: stripped fullscreenMG from ${ctaGuardStripped} conclusion scene(s) — restored footage`);
    }

    // ── Keyword compliance guard ──
    // Catches keywords the model generated despite the prompt's abstract/news-actor rules.
    // Logs every violation so we can see whether the prompt is landing, and repairs the
    // scene instead of letting a doomed query hit the provider chain.
    const kwViolations = _enforceKeywordCompliance(enrichedScenes, scriptContext);
    if (kwViolations.length > 0) {
        console.log(`   ⚠️  Keyword compliance: caught ${kwViolations.length} violation(s) the AI slipped past the prompt:`);
        for (const v of kwViolations) {
            console.log(`      Scene ${v.index}: ${v.reason} — "${v.before}" → "${v.after}"${v.sourceChange ? ` (source: ${v.sourceChange})` : ''}`);
        }
    }

    // ── Typography run dedup ──
    // After metaphor scenes get flipped to fullscreenMG focusWord, a cluster of
    // adjacent abstract scenes can all become focusWord — three typography cards
    // in a row look lazy. Alternate them and break long runs.
    const typoFixes = _dedupTypographyRuns(enrichedScenes);
    if (typoFixes.length > 0) {
        console.log(`   🎨 Typography dedup: varied ${typoFixes.length} adjacent MG scene(s):`);
        for (const f of typoFixes) {
            console.log(`      Scene ${f.index}: ${f.before} → ${f.after}`);
        }
    }

    // ── Class/treatment validator ──
    // When the Scene Classifier attached sceneClass + treatmentHint, rewrite
    // any scene whose chosen lane conflicts with its class rules.
    // No-op when classes weren't attached (flag off or classifier failed).
    const classFixes = _enforceClassTreatment(enrichedScenes);
    if (classFixes.length > 0) {
        console.log(`   🏷️  Class compliance: rewrote ${classFixes.length} scene(s) to match class treatment:`);
        for (const f of classFixes) {
            console.log(`      Scene ${f.index}: ${f.reason} — "${f.before}" → "${f.after}"`);
        }
    }

    // Final niche map gate. Parser-time stripping catches raw AI output; this
    // pass catches later compliance/class rewrites that might reintroduce a
    // map lane after the parse step.
    const nicheMapFixes = _enforceNicheMapChartBan(enrichedScenes, scriptContext.nicheId, plannerDirectives);
    if (nicheMapFixes.length > 0) {
        console.log(`   Niche map compliance: stripped ${nicheMapFixes.length} forbidden mapChart scene(s):`);
        for (const f of nicheMapFixes) {
            console.log(`      Scene ${f.index}: "${f.before}" -> "${f.after}" (${f.reason})`);
        }
    }
    const nicheMapDrops = enrichedScenes.filter(s => s._nicheMapDrop).length;

    // ── Global Source Diversity ──
    // Run ONCE across the full scene list (was per-batch, which missed
    // cross-chunk skew: e.g. 3 batches each 50% youtube = 50% youtube globally
    // but ran with 2-scene streaks in every chunk seam).
    _enforceSourceDiversity(enrichedScenes, scriptContext.nicheId);

    // ── Planner compliance summary ──
    // Distinguish "AI chose this" from "we corrected it" so it's visible whether
    // the model is actually planning, or the guardrails are doing the work.
    // Loss counters surface every place an AI choice was overridden — high values
    // mean the prompt isn't landing and the guardrails are doing the planning.
    const summary = _buildPlannerSummary(enrichedScenes, {
        ctaGuardStripped,
        kwViolations: kwViolations.length,
        typoFixes: typoFixes.length,
        classFixes: classFixes.length,
        nicheMapDrops,
        sourceOverrides: complianceStats.sourceOverrides || 0,
        mapOverrides: complianceStats.mapOverrides || 0,
        framingOverrides: complianceStats.framingOverrides || 0,
        styleMixAdjusted: complianceStats.styleMixAdjusted || 0,
        graphicsInjected: complianceStats.graphicsInjected || 0,
        graphicsTrimmed: complianceStats.graphicsTrimmed || 0,
    });
    console.log(summary);

    return enrichedScenes;
}

function _buildPlannerSummary(scenes, lossBag = {}) {
    // Backward-compat: previous callers passed (scenes, ctaGuardStripped:number).
    // Normalize that into the lossBag shape used below.
    if (typeof lossBag === 'number') lossBag = { ctaGuardStripped: lossBag };
    const {
        ctaGuardStripped = 0,
        kwViolations = 0,
        typoFixes = 0,
        classFixes = 0,
        nicheMapDrops = 0,
        sourceOverrides = 0,
        mapOverrides = 0,
        framingOverrides = 0,
        styleMixAdjusted = 0,
        graphicsInjected = 0,
        graphicsTrimmed = 0,
    } = lossBag;

    const total = scenes.length;
    let aiTpl = 0, aiFS = 0, aiMg = 0;
    let finalTpl = 0, finalFS = 0, finalMg = 0;
    let sourceChanges = 0, mediaChanges = 0, framingChanges = 0;
    let aiMapProposed = 0, mapDropped = 0, mapAdded = 0;
    let templateAdded = 0, templateDropped = 0;
    let fullscreenAdded = 0, fullscreenDropped = 0;
    const sourceCounts = {};
    for (const s of scenes) {
        const ai = s._aiChose || {};
        if (ai.templateHint) aiTpl++;
        if (ai.fullscreenMG) aiFS++;
        if (ai.mgHint) aiMg++;
        if (s.templateHint) finalTpl++;
        if (s.fullscreenMG) finalFS++;
        if (s.mgHint) finalMg++;

        // Lane-specific loss accounting.
        const finalFsType = s.fullscreenMG ? String(s.fullscreenMG).split(':')[0].trim() : null;
        const aiIsMap     = typeof ai.fullscreenMG === 'string' && ai.fullscreenMG.toLowerCase().startsWith('map');
        const finalIsMap  = finalFsType && finalFsType.toLowerCase().startsWith('map');
        if (aiIsMap) aiMapProposed++;
        if (aiIsMap && !finalIsMap) mapDropped++;
        if (!aiIsMap && finalIsMap) mapAdded++;
        if (ai.templateHint && !s.templateHint) templateDropped++;
        if (!ai.templateHint && s.templateHint) templateAdded++;
        if (ai.fullscreenMG && !s.fullscreenMG) fullscreenDropped++;
        if (!ai.fullscreenMG && s.fullscreenMG) fullscreenAdded++;

        if (ai.sourceHint && s.sourceHint && ai.sourceHint !== s.sourceHint) sourceChanges++;
        if (ai.mediaType && s.mediaType && ai.mediaType !== s.mediaType) mediaChanges++;
        if (ai.framing && s.framing && ai.framing !== s.framing) framingChanges++;
        const src = s.sourceHint || (s.fullscreenMG ? 'fs-mg' : 'none');
        sourceCounts[src] = (sourceCounts[src] || 0) + 1;
    }
    const dist = Object.entries(sourceCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}:${v}`)
        .join(', ');
    const corr = sourceChanges + mediaChanges + framingChanges + ctaGuardStripped + kwViolations + typoFixes + classFixes + nicheMapDrops;

    // Loss bag — counts every place an AI choice was rewritten, dropped, or
    // injected by a guard. High totals here mean the prompt isn't landing and
    // the guardrails are silently authoring the plan.
    const lossParts = [];
    if (mapDropped > 0)        lossParts.push(`map-dropped=${mapDropped}`);
    if (mapAdded > 0)          lossParts.push(`map-added=${mapAdded}`);
    if (templateDropped > 0)   lossParts.push(`tpl-dropped=${templateDropped}`);
    if (templateAdded > 0)     lossParts.push(`tpl-added=${templateAdded}`);
    if (fullscreenDropped > 0) lossParts.push(`fs-dropped=${fullscreenDropped}`);
    if (fullscreenAdded > 0)   lossParts.push(`fs-added=${fullscreenAdded}`);
    if (ctaGuardStripped > 0)  lossParts.push(`cta-guard=${ctaGuardStripped}`);
    if (kwViolations > 0)      lossParts.push(`kw-violations=${kwViolations}`);
    if (classFixes > 0)        lossParts.push(`class-rewrites=${classFixes}`);
    if (nicheMapDrops > 0)     lossParts.push(`niche-map-drop=${nicheMapDrops}`);
    if (typoFixes > 0)         lossParts.push(`typo-dedup=${typoFixes}`);
    if (sourceOverrides > 0)   lossParts.push(`src-overrides=${sourceOverrides}`);
    if (mapOverrides > 0)      lossParts.push(`map-overrides=${mapOverrides}`);
    if (framingOverrides > 0)  lossParts.push(`framing-overrides=${framingOverrides}`);
    if (styleMixAdjusted > 0)  lossParts.push(`style-mix=${styleMixAdjusted}`);
    if (graphicsInjected > 0)  lossParts.push(`gfx+${graphicsInjected}`);
    if (graphicsTrimmed > 0)   lossParts.push(`gfx-${graphicsTrimmed}`);
    const lossBlock = lossParts.length > 0 ? ` | losses: {${lossParts.join(' ')}}` : '';

    return [
        `   📊 [Planner Summary] ${total} scenes — AI-chose: tpl=${aiTpl} fs-mg=${aiFS} ov-mg=${aiMg} (mapProposed=${aiMapProposed}) | final: tpl=${finalTpl} fs-mg=${finalFS} ov-mg=${finalMg}`,
        `   📊 [Planner Summary] corrections=${corr} (src=${sourceChanges} media=${mediaChanges} framing=${framingChanges} cta-guard=${ctaGuardStripped} kw=${kwViolations} class=${classFixes} niche-map=${nicheMapDrops} typo=${typoFixes})${lossBlock}`,
        `   📊 [Planner Summary] sources: {${dist}}`,
    ].join('\n');
}

// ============================================================
// PROMPT BUILDER
// ============================================================

/**
 * Build the batch visual planning prompt.
 * AI sees ALL scenes at once and plans visuals with full story context.
 */
function buildBatchPrompt(scenes, scriptContext, directorsBrief, options = {}) {
    const { theme, tone, mood, pacing, format, visualStyle, entities, hookEndTime, ctaDetected, ctaStartTime } = scriptContext;
    const { qualityTier, tier, audienceHint } = directorsBrief;
    const nicheId = scriptContext.nicheId || 'general';
    const { getNiche, getSearchPolicy, getKeywordRules } = require('./niches');
    const niche = getNiche(nicheId);
    const nicheAllowedMGs = Array.isArray(niche.allowedMGs) ? niche.allowedMGs : [];
    const nicheAllowsMapChart = nicheAllowedMGs.includes('mapChart');
    const fullscreenMGTypes = [
        'articleHighlight',
        'timeline',
        'bulletList',
        'barChart',
        'donutChart',
        'comparisonCard',
        'rankingList',
        ...(nicheAllowsMapChart ? ['mapChart'] : []),
    ].join(', ');
    const mapAvailabilityRule = nicheAllowsMapChart
        ? '- mapChart IS AVAILABLE for this niche. When the narration discusses geographic regions, borders, straits, trade routes, military positions, or mentions 2+ countries/locations, use fullscreenMG: "mapChart: Location1: label, Location2: label". Maps are more impactful than generic footage for geographic content. Pick the best scene for it, usually the one introducing locations.'
        : '- mapChart is FORBIDDEN for this niche because it is not in allowedMGs. Geographic narration must use real footage, web-image route references, templates, or overlay MGs instead. Do not output fullscreenMG="mapChart: ..." under any condition.';
    const mapFullscreenRules = nicheAllowsMapChart
        ? `     - Scene mentions GEOGRAPHIC LOCATIONS, borders, routes, or geopolitical regions -> "mapChart: Location1: label, Location2: label"
     - Scene describes a SPECIFIC LOCATION being introduced -> "mapChart: Atlanta, Georgia - 1915"
     - IMPORTANT: For narration about straits, trade routes, military positions, borders, or multiple countries, mapChart is STRONGLY preferred over footage. Use it when 2+ locations are mentioned.
     - When using mapChart, also pick a mapVariant based on scene intent:
       - locator -> single place being introduced/spotlit ("the Strait of Hormuz is...")
       - route -> travel/trade/flight path between >=2 points ("ships travel from Shanghai to Rotterdam...")
       - regionHighlight -> one country/region being discussed as a whole ("throughout the Middle East...")
       - comparison -> two or more places contrasted side-by-side ("oil from Saudi Arabia vs Iran...")`
        : `     - Geographic scenes: mapChart is forbidden by this niche allowlist. Do NOT write mapChart in fullscreenMG.
     - For routes, chokepoints, regions, and multi-country scenes, use one of these instead: web-image route/map reference, real documentary/news footage, locationCard/comparisonCard/statCard template, or overlay mgHint.`;
    const mapPlanningRules = nicheAllowsMapChart
        ? `       - MAP=preferred:<m>  -> output fullscreenMG="mapChart: <subjects>" with mapVariant=<m>. Skip other lane choices for this scene.
       - MAP=allowed:<m>    -> if the narration is fundamentally about geography, pick mapChart with mapVariant=<m>. If the narration is mostly about a person/quote/stat that happens to mention a place, do NOT pick mapChart.
       - MAP=forbidden      -> never output mapChart, even if you spot place names. Niche policy or scene class blocks it.
       - MAP=n/a            -> skip map entirely.`
        : `       - MAP=preferred/allowed should not appear in this niche; if it does, treat it as MAP=forbidden because mapChart is outside allowedMGs.
       - MAP=forbidden or MAP=n/a -> never output mapChart. Use footage, web-image references, templates, or overlays instead.`;
    const outputMapContractRules = nicheAllowsMapChart
        ? `  - If MAP=preferred -> fullscreenMG MUST be a mapChart with the indicated mapVariant.
  - If MAP=forbidden -> fullscreenMG MUST NOT be mapChart.`
        : `  - This niche forbids mapChart. Treat every MAP token as forbidden for fullscreenMG output.`;
    const mapPayloadContractRule = nicheAllowsMapChart
        ? '- mapChart payload contract: must list >=1 concrete place name (locator/region) or >=2 places (route/comparison). "mapChart: this region" with no place names is invalid.'
        : '- mapChart is outside this niche allowlist: never output it. Geographic scenes should become footage, web-image references, templates, or overlays.';
    const mapLegendRules = nicheAllowsMapChart
        ? `    forbidden       -> DO NOT output mapChart even if 2+ places appear
    preferred:<m>   -> output fullscreenMG="mapChart: ..." with mapVariant=<m>; do NOT pick another lane
    allowed:<m>     -> mapChart is permitted with that variant; choose it if narration is geographic
    n/a             -> no map signal; choose other lanes`
        : `    forbidden       -> DO NOT output mapChart even if 2+ places appear
    preferred/allowed -> treat as forbidden in this niche because mapChart is outside allowedMGs
    n/a             -> no map signal; choose other lanes`;
    const sourceFamiliesLegend = nicheAllowsMapChart
        ? 'web-image-portrait | web-image-data | mapChart | real-footage | stock-mood'
        : 'web-image-portrait | web-image-data | real-footage | stock-mood';
    const mgFamiliesLegend = nicheAllowsMapChart
        ? 'map | data | callout | intro | typography | overlay-only'
        : 'data | callout | intro | typography | overlay-only';
    const searchPolicy = getSearchPolicy(nicheId);
    const plannerDirectives = options.plannerDirectives || _buildPlannerDirectives(scenes, scriptContext, directorsBrief);

    if (scriptContext && scriptContext.styleBlock) {
        console.log(`   🎨 [VisualPlanner] Style profile injected into batch prompt: "${scriptContext.styleProfile?.name || 'unnamed'}" (${scriptContext.styleBlock.length} chars)`);
    }

    // Resolve build language for display-text enforcement
    const _langNames = { de: 'German', es: 'Spanish', fr: 'French', it: 'Italian', ko: 'Korean', pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian', ja: 'Japanese', zh: 'Chinese', ar: 'Arabic', tr: 'Turkish', hi: 'Hindi', sv: 'Swedish', da: 'Danish', fi: 'Finnish', no: 'Norwegian', cs: 'Czech', ro: 'Romanian', hu: 'Hungarian', el: 'Greek', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay', uk: 'Ukrainian' };
    const buildLang = scriptContext.language || 'en';
    const buildLangName = _langNames[buildLang] || buildLang;
    const isNonEnglish = buildLang && buildLang !== 'en';

    // Build scene list with timing info
    // If Scene Classes pass (USE_SCENE_CLASSES=true) attached class/treatment to scenes,
    // inject them per-line so the planner picks strategy deterministically.
    // The CONSTRAINTS line is ALWAYS rendered — derived from existing signals + niche
    // surface + mapPolicy. It tells the planner the structural envelope for each scene
    // BEFORE it picks a lane, so we don't have to fix bad lane picks after the fact.
    const { getNicheMapPolicy: _getMapPolicy } = require('./niches');
    const _nicheMapPolicy = _getMapPolicy(nicheId);
    const anyClassTagged = scenes.some(s => s.sceneClass);
    let sceneList = '';
    for (const scene of scenes) {
        const duration = (scene.endTime - scene.startTime).toFixed(1);
        const period = `[${_sceneTagString(scene, scenes, scriptContext)}]`;

        sceneList += `SCENE ${scene.index} (${scene.startTime.toFixed(1)}s-${scene.endTime.toFixed(1)}s, ${duration}s) ${period}:\n`;
        if (scene.sceneClass && scene.treatmentHint) {
            const t = scene.treatmentHint;
            const ladder = Array.isArray(scene.fallbackLadder) ? scene.fallbackLadder.join(' → ') : t.primary;
            sceneList += `   CLASS=${scene.sceneClass} | PRIMARY=${t.primary} | LADDER=${ladder} | SOURCE=${t.preferredSource} | RETRIEVE=${scene.retrievability || 'medium'}\n`;
            if (t.blocked && t.blocked.length) {
                sceneList += `   BLOCKED=${t.blocked.join(',')}\n`;
            }
        }
        sceneList += `   CONSTRAINTS: ${_renderSceneConstraintLine(scene, scenes, scriptContext, niche, _nicheMapPolicy)}\n`;
        sceneList += `   "${scene.text}"\n\n`;
    }

    const classLegend = anyClassTagged ? `

SCENE CLASSES & TREATMENT (read before planning):
Each scene carries CLASS (editorial role) and PRIMARY (visual lane to use first). Treat CLASS as the authoritative strategy — do NOT invent a different one.
  - PRIMARY=footage  → choose real footage, set keyword + sourceHint, leave fullscreenMG/templateHint null
  - PRIMARY=map      → set fullscreenMG to a map type; keyword is secondary
  - PRIMARY=graphics → set fullscreenMG to focusWord/callout/statCounter-type; skip footage
  - PRIMARY=template → set templateHint to one of the allowed templates; skip footage
BLOCKED lists lanes you MUST NOT pick for that scene.
RETRIEVE=internal-only means the scene has NO external visual referent — do NOT set keyword or webQuery; use PRIMARY only.
LADDER is the fallback order if PRIMARY is unavailable. Stay on PRIMARY unless clearly wrong.
SOURCE is the concrete footage provider to prefer when PRIMARY=footage (e.g. telegram for news actors, web-image for history).` : '';

    const constraintsLegend = `

PER-SCENE CONSTRAINTS LEGEND (read before planning each scene):
Each scene now carries a deterministic CONSTRAINTS line derived from the narration + niche map policy + niche allowlist + scene class. THESE ARE HARD STRUCTURAL RULES — not suggestions:
  ROLE — primary editorial role of the scene:
    geo-establish | geo-route | geo-region | geo-compare → MAP scene (see MAP DECISION FIRST below)
    person-intro    → first-time named person → portrait or personIntro template; NEVER fullscreenMG
    quote-beat      → direct quote → quoteCard / callout; never raw stock B-roll alone
    stat-beat       → ≥2 numbers in narration → statCard / barChart / donutChart / rankingList preferred
    escalation-news → state actor + military/political verb → real footage (telegram/youtube), NEVER stock
    abstract-breathing-room → mood / metaphor → focusWord / kineticText / mood B-roll
    concept-explainer → no concrete subject → typography or template, AVOID forced footage searches
    product-demo    → tech reveal/launch → real footage of the product/event
    generic         → no signal — pick the most editorial choice
  MAP — map intent for THIS scene:
${mapLegendRules}
  FS-MG — fullscreen MG framing budget:
    allowed         → fullscreenMG (map/graphics/data) is editorially valid here
    discouraged     → prefer overlay mgHint or templateHint instead of replacing the footage
    forbidden       → never set fullscreenMG (hook/CTA scenes)
  STOCK — stock library suitability:
    ok              → pexels/pixabay are valid IF the narration is genuinely abstract
    disallowed      → narration names entities/actors/people — stock libraries have NO matches; pick a real-source family or graphics
  SRC — preferred source family (informational, not a hard override):
    ${sourceFamiliesLegend}
  MG-FAMILIES — which MG types are editorial-fit for this scene:
    ${mgFamiliesLegend}

PLANNING ORDER (FOLLOW STRICTLY — do not collapse maps into the generic fullscreen lane):
  1. MAP DECISION FIRST — for every scene check the MAP token:
${mapPlanningRules}
  2. After locking the map decision, choose the lane for the remaining scenes using ROLE + MG-FAMILIES + STOCK:
       • person-intro       → portrait (web-image) or templateHint=personIntro; sourceHint=web-image; mediaType=image.
       • quote-beat         → templateHint=quoteCard or mgHint=callout. Footage allowed only as backdrop with the overlay.
       • stat-beat          → templateHint=statCard / fullscreenMG=barChart|donutChart|rankingList. Use real numbers from narration.
       • escalation-news    → real footage from the niche's top source (NEVER stock).
       • abstract-breathing-room → typography (focusWord / kineticText) or stock-mood B-roll.
       • concept-explainer  → typography or template. Do NOT force a footage keyword that has no concrete referent.
  3. Respect FS-MG=discouraged by preferring overlay/template instead of replacing the footage.
  4. Respect STOCK=disallowed by routing to the niche's top non-stock source family.

These rules are deterministic. If you ignore them, downstream guards will rewrite your output and the scene loses your editorial framing.`;

    // Build topic anchor from summary + web context
    const summary = scriptContext.summary || '';
    const webContext = scriptContext.webContext || '';
    const eventType = scriptContext.eventType || '';
    const eventAnchor = scriptContext.eventAnchor || '';
    const videoTitle = scriptContext.videoTitle || '';
    let topicBlock = '';
    if (summary || webContext || videoTitle) {
        topicBlock = `\nTOPIC CONTEXT (use this to stay on-topic and pick relevant visuals):`;
        if (videoTitle) {
            topicBlock += `\n- VIDEO TITLE: "${videoTitle}" — This is the video's title. Use it to understand the overall subject and guide your keyword choices.`;
        }
        if (summary) {
            topicBlock += `\n- Summary: ${summary}`;
        }
        if (eventType) {
            const eventLabels = {
                'real-past': '⚠️ This is a REAL EVENT that already happened — search for REAL footage, photos, and news clips. Do NOT use stock footage for scenes about this event.',
                'real-ongoing': '⚠️ This is a REAL ONGOING EVENT — search for REAL footage and news coverage. Do NOT use stock footage for scenes about this event.',
                'speculative': 'This is speculative/hypothetical — use a mix of real reference footage and mood B-roll.',
                'educational': 'This is educational content — use documentary footage, diagrams, and explainers.',
                'fictional': 'This is fictional — use cinematic/stock footage for mood and atmosphere.',
            };
            topicBlock += `\n- Event type: ${eventLabels[eventType] || eventType}`;
        }
        if (eventAnchor) {
            topicBlock += `\n- ⚡ EVENT ANCHOR: "${eventAnchor}" — For scenes directly about THIS event, INCLUDE the event name in your keyword so searches find REAL footage of THIS incident. Example: instead of "ship fire damage" use "${eventAnchor} fire damage". Instead of "crew sleeping on floor" use "${eventAnchor} crew displaced". For generic/background scenes (nature, mood, equipment) you don't need the anchor.`;
        }
        if (webContext) {
            topicBlock += `\n- Research: ${webContext.substring(0, 1500)}`;
        }
        topicBlock += `\n`;
    }

    // Build cross-chunk awareness block
    const previousKeywords = options.previousKeywords || [];
    const globalOutline = options.globalOutline || null;
    let chunkBlock = '';
    if (previousKeywords.length > 0) {
        chunkBlock = `\nALREADY USED KEYWORDS (from previous scenes — DO NOT repeat these):
${previousKeywords.map(k => `- "${k}"`).join('\n')}

You MUST pick DIFFERENT keywords for the scenes below. Vary your visuals!\n`;
    }
    const outlineBlock = _renderGlobalOutlineBlock(globalOutline, scenes);

    let prompt = `You are a visual director planning B-ROLL FOOTAGE for a FACELESS VIDEO.

The AI Director has analyzed this script and provided deep context. Your job is to plan SPECIFIC, SEARCHABLE visuals for EVERY scene that:
1. Match the story's theme, mood, and pacing
2. Create visual variety across the video (don't repeat the same type of shot)
3. Use the ENTITIES and context to be specific (not generic)
4. Consider the story arc (hook → body → CTA)
5. INTELLIGENTLY mix sources: stock video, YouTube clips, and web images
${isNonEnglish ? `
🔴🔴🔴 MANDATORY LANGUAGE RULE — THIS VIDEO IS IN ${buildLangName.toUpperCase()} 🔴🔴🔴
ALL viewer-facing text you write MUST be in ${buildLangName}. This applies to:
- mgHint content text (e.g., "statCounter: 75% Energieeinsparung" NOT "75% Energy Savings")
- fullscreenMG data text (e.g., "comparisonCard: Öffentliches Bild vs Private Realität")
- templateHint content text (e.g., "statCard: Energie -75% Stromrechnung")
- Any labels, titles, descriptions that will appear ON SCREEN
The ONLY exception: keyword, stockQuery, webQuery stay in ENGLISH (search engines need English).
This rule applies to EVERY scene — do NOT switch to English for any display text.
🔴🔴🔴 END LANGUAGE RULE 🔴🔴🔴
` : ''}${topicBlock}
${directorsBrief.freeInstructions ? `\n🔥 USER INSTRUCTIONS (HIGHEST PRIORITY — OVERRIDE ALL DEFAULTS):
${directorsBrief.freeInstructions}

↑ These instructions are MANDATORY. Follow them exactly, even if they conflict with the rules below.\n` : ''}
${(scriptContext && scriptContext.styleBlock) ? `\n${scriptContext.styleBlock}

↑ Use this as INSPIRATION for footage variety and shot composition. Niche rules and theme settings below still take priority for MG types and effects.\n` : ''}
${_renderPlannerDirectiveBlock(plannerDirectives, scriptContext)}
${chunkBlock}
${outlineBlock}
DIRECTOR'S ANALYSIS:
- Theme: ${theme || 'general'}
- Tone: ${tone || 'informative'}
- Mood: ${mood || 'neutral'}
- Pacing: ${pacing || 'moderate'}
- Visual Style: ${visualStyle || 'cinematic'}
- Format: ${format}
${entities.length > 0 ? `- Key Entities: ${entities.join(', ')}` : ''}
${hookEndTime ? `- Hook Period: 0-${hookEndTime}s (needs strong visuals to grab attention)` : ''}
${ctaDetected ? `- CTA Period: ${ctaStartTime}s-end (wind down, show branding/channel elements)` : ''}
${audienceHint ? `- Target Audience: ${audienceHint}` : ''}
- Event Anchor: ${scriptContext.eventAnchor || 'none'}
- Main Points: ${scriptContext.mainPoints?.length ? scriptContext.mainPoints.slice(0, 6).join(' | ') : 'none'}
- Section Labels: ${scriptContext.sections?.length ? scriptContext.sections.map(s => typeof s === 'string' ? s : s?.title).filter(Boolean).slice(0, 8).join(' | ') : 'none'}
- Content Niche: ${niche.name} (${niche.description})
${format === 'listicle' && scriptContext.listicleItems ? require('./listicle-format').getListiclePromptRules(scriptContext.listicleItems) : ''}

SEARCH STRATEGY FOR THIS NICHE:
- For STOCK providers (Pexels/Pixabay): use SHORT, VISUAL keywords (max ${searchPolicy.stockMaxWords || 3} words). These are generic footage libraries — search for what the shot LOOKS LIKE.
${searchPolicy.avoidTerms?.length ? `- AVOID these terms in stock queries: ${searchPolicy.avoidTerms.join(', ')}` : ''}
${searchPolicy.contextTerms?.length ? `- For WEB providers (Bing/Google): adding "${searchPolicy.contextTerms[0]}" helps find relevant results` : ''}
${searchPolicy.entityBoost ? '- Entity names (people, companies) work well in web searches but NOT in stock searches' : ''}
- Fallback keywords if nothing specific works: ${(searchPolicy.fallbackKeywords || []).slice(0, 3).join(', ')}

⚠️ AVAILABLE VIDEO SOURCES FOR THIS NICHE (${niche.name}) — PRIORITY ORDER:
${(() => {
    const sourceDescriptions = {
        telegram: 'Telegram/VK channels — real raw footage (wars, protests, political events)',
        youtube: 'YouTube — match highlights, documentaries, tours, training footage, interviews',
        reddit: 'Reddit — TV broadcast captures, match highlights, drone footage (BEST FOR SPORTS)',
        pexels: 'Pexels — ONLY abstract mood B-roll (sunsets, rain, crowds) — NO specific events/people',
        pixabay: 'Pixabay — ONLY abstract mood B-roll (sunsets, rain, crowds) — NO specific events/people',
        vkVideo: 'VK Video — Russian/international news footage, military clips',
    };
    const videoPriority = niche.footagePriority?.video || ['youtube', 'telegram', 'vkVideo', 'reddit', 'pexels', 'pixabay'];
    return videoPriority.map((src, i) => `  ${i + 1}. ${src} — ${sourceDescriptions[src] || src}`).join('\n');
})()}
- web-image — Bing/Google Images (photos, maps, portraits, data) — always available for images

⚠️ CRITICAL SOURCE RULES:
- You MUST prefer sources #1 and #2 for MOST scenes (aim for 70%+ of video scenes)
- "stock" (pexels/pixabay) = ONLY for abstract/cinematic mood B-roll with NO specific entity (max ~10% of scenes)
- stock does NOT have: match footage, player clips, sports highlights, specific events, named athletes
- If a scene shows ANY real action, person, or event → use the top-priority sources, NOT stock
${(() => {
    const videoPriority = niche.footagePriority?.video || [];
    const topSrc = videoPriority[0] || 'youtube';
    const isStockLast = videoPriority.indexOf('pexels') >= videoPriority.length - 2;
    if (isStockLast) return `- FOR THIS "${niche.name}" NICHE: stock should be RARE. Use "${topSrc}" or "${videoPriority[1] || 'youtube'}" for action/event scenes.`;
    return '';
})()}

QUALITY TIER: ${qualityTier}
${tier.allowVideo ? '- Can use VIDEO clips (preferred for motion and impact)' : '- IMAGES ONLY (no video allowed)'}

AVAILABLE EFFECT PRESETS FOR THIS THEME (${scriptContext.themeId || 'standard'}):
${(() => {
    const EFFECT_PRESETS = require('./effect-presets');
    const activeTheme = scriptContext.themeId || 'standard';
    const presets = Object.entries(EFFECT_PRESETS)
        .filter(([k, p]) => k !== 'none' && p.themes && (p.themes.includes('*') || p.themes.includes(activeTheme)))
        .map(([k, p]) => `${k}: ${p.description || p.label}`)
        .join('\n');
    return presets || 'none available';
})()}
- Pick ONE effect preset per scene from the list above, or "none" for no effect.
- These are pre-made combos (grain+scratches+color grading etc) — NOT individual effects.
- ONLY use presets listed above — do NOT use presets not in the list.
- Don't overuse effects — ~40-50% of scenes should be "none"
- HOOK scenes benefit from subtle effects for visual impact

ALLOWED MOTION GRAPHICS FOR THIS NICHE (${niche.name}):
${nicheAllowedMGs.join(', ')}
- Suggest an MG only when the scene content clearly benefits from one.
- NOT every scene needs an MG — use "none" for scenes that work best as pure footage.
- Fullscreen MGs (focusWord, kineticText) replace the footage entirely — use sparingly for impact.
- Overlay MGs (lowerThird, headline, statCounter, barChart, etc.) appear ON TOP of footage.
${mapAvailabilityRule}

SCENES TO PLAN (${scenes.length} total):
${classLegend}${constraintsLegend}
${sceneList}

PLANNING RULES:

1. VISUAL VARIETY:
   - Look at ALL scenes — plan a visual journey
   - Vary shot types: wide shots, close-ups, aerials, POV, establishing shots
   - Vary subjects: locations → people → objects → actions → data
   - NEVER use the same keyword twice
   - Example: If scene 1 shows "city skyline at night", scene 2 should show something different like "police car with flashing lights"

2. CONTENT TYPE & SOURCE SELECTION (MATCH CONTENT TO BEST SOURCE):

   **Priority 1: SPECIFIC REAL PEOPLE** → web-image
   - When a scene mentions a named person → show their photo
   - Example: "Gene Hackman" → web-image

   **Priority 2: DATA/STATS** → web-image
   - Numbers, charts, graphs, infographics
   - Example: "unemployment rate chart" → web-image

   **Priority 3: REAL EVENTS / ACTION** → use top niche sources (see AVAILABLE VIDEO SOURCES above)
   - Current events, breaking news, match highlights, action footage
   - Use the #1 and #2 sources from the niche priority list above
   - Example: "tennis serve ace" → use top niche source, NOT stock

   **Priority 4: ABSTRACT MOOD / SCENERY** → stock (ONLY if no entity/event)
   - ONLY for: sunsets, rain, generic crowds, abstract backgrounds, nature
   - NOT for: any named person, specific event, sport action, real footage
   - Example: "sunset over stadium" → stock

   **CRITICAL**: Don't default to stock! Stock is a LAST RESORT for abstract mood only. For any real action, person, or event → use the top niche sources.

3. SOURCE HINTS (YOU MUST ACTIVELY CHOOSE THE BEST SOURCE FOR EACH SCENE):

   **"telegram"** — Real raw footage from news/military Telegram & VK channels:
   - Wars, military operations, combat, naval confrontations, missile strikes, troop movements
   - Protests, riots, elections, political speeches, sanctions, summits, diplomacy
   - ANY specific real-world event, conflict, or political development
   - Example: "USS Gerald R Ford underway" → telegram
   - Example: "Northern Red Sea naval operations" → telegram
   - Example: "Ukraine drone strike" → telegram

   **"youtube"** — Documentaries, tours, behind-the-scenes, equipment footage:
   - Military interiors (aircraft carrier bridge, cockpit, engine room, command center)
   - Factory/facility tours, equipment demonstrations, training exercises
   - Historical documentaries, archival footage, analysis clips
   - Vehicle/ship/aircraft walkarounds, how-it-works videos
   - Example: "aircraft carrier damage control training" → youtube
   - Example: "F-35 cockpit view" → youtube
   - Example: "Navy berthing quarters tour" → youtube

   **"stock"** — ONLY for abstract/cinematic mood B-roll with NO specific entity:
   - Nature landscapes (sunsets, storms, oceans), generic aerials
   - Abstract mood shots (dark clouds, fire texture, water ripples)
   - Generic lifestyle (walking, cooking, typing) — NOT military/news content
   - ⚠️ NEVER use stock for: military scenes, ship interiors, specific equipment, named events, investigations, forensics
   - ⚠️ Stock sites do NOT have: military interiors, sabotage footage, NCIS investigations, damaged ships, exhausted soldiers
   - Example: "stormy ocean waves" → stock
   - Example: "woman typing on laptop" → stock

   **"reddit"** — Community-uploaded video clips (BEST FOR SPORTS & MILITARY):
   - Sports highlights: broadcast captures, match clips, reactions (landscape TV footage)
   - Military/combat: drone footage, missile launches, satellite imagery, dashcam
   - Crime: bodycam footage, dashcam chases, press conferences
   - ⚠️ Reddit is ~70% vertical phone recordings — ONLY use for niches with broadcast/drone content
   - ⚠️ DO NOT use reddit for: celebrity, tech, entertainment (barely any hosted video)
   - Example: "tennis match point rally" → reddit (TV broadcast capture)
   - Example: "drone strike footage" → reddit (military subreddits)
   - Example: "police bodycam pursuit" → reddit

   **"web-image"** — Specific photos, maps, data, portraits:
   - Specific real people (photos, portraits, headshots)
   - Maps, routes, geographic locations
   - Data visualizations (charts, graphs, infographics)
   - Historical photos, diagrams, technical illustrations
   - Example: "Elon Musk portrait" → web-image
   - Example: "Persian Gulf naval route map" → web-image

   ⚠️ FOR NEWS/MILITARY NICHES: stock should be RARE (≤10% of scenes). Use telegram for real events, youtube for interiors/equipment/training, web-image for maps/portraits. Stock ONLY for abstract nature/mood shots.

4. MEDIA TYPE SELECTION:
${tier.allowVideo
    ? `   - Prefer VIDEO for: action scenes, locations, events, motion-heavy moments
   - Use IMAGE for: data/stats, specific people, charts, historical photos
   - NICHE PREFERENCE: This "${niche.name}" content works best with ${
       niche.preferredMediaType === 'video' && nicheId.startsWith('news') ? 'HEAVILY VIDEO (aim for ~80-85% video, 15-20% image) — news/military content MUST be dominated by real video footage. Only use image for specific portraits, data charts, or historical photos'
     : niche.preferredMediaType === 'video' ? 'MORE VIDEO clips (aim for ~70% video, 30% image) — this niche needs motion and energy'
     : niche.preferredMediaType === 'image' ? 'MORE IMAGES (aim for ~60-70% image, 30-40% video) — this niche relies on photos, stills, and evidence'
     : 'a BALANCED MIX of video and images (~50/50) — use whichever fits each scene best'
   }
   - But ALWAYS override this preference when the scene content clearly calls for the other type (e.g., a named person → image regardless of niche)`
    : `   - IMAGES ONLY (quality tier: ${qualityTier})`}

5. HOOK PERIOD (first ${hookEndTime || 15}s):
   - Use STRONG, ATTENTION-GRABBING visuals
   - Prefer dynamic VIDEO over static images
   - Match the emotional hook (if dramatic → intense visuals, if mysterious → dark/intriguing)

6. CTA PERIOD (${ctaDetected ? `${ctaStartTime}s onwards` : 'N/A'}):
   - Wind down with calmer visuals
   - Can show branding elements, channel graphics, recap moments

7. ENTITY AWARENESS (CRITICAL):
   - **PEOPLE**: When a scene mentions a REAL PERSON by name → you MUST show THEIR PHOTO
     ${entities.length > 0 ? `• Key people in this story: ${entities.slice(0, 5).join(', ')}` : ''}
     • Use mediaType: "image" (photos of people are images, not video)
     • Use sourceHint: "web-image" (Google Images has their photos)
     • Use their REAL NAME in keyword (e.g., "Gene Hackman portrait photo", "Betsy Arakawa photo")
     • Example: "They found the body of John Smith" → keyword: "John Smith photo", mediaType: image, sourceHint: web-image
   - **LOCATIONS**: Use specific place names (e.g., "Santa Fe mansion" not "luxury house")
   - **COMPANIES**: Show their products/branding (e.g., "Tesla Model 3" not "electric car")
   - **NEWS/CURRENT EVENTS**: When the scene describes a specific real-world event, conflict, or development:
     • Use sourceHint: "telegram" — searches Telegram/VK news channels for real raw footage
     • Use sourceHint: "telegram" for: wars, military operations, missile strikes, naval confrontations, troop movements, combat, protests, elections, political speeches, sanctions, summits, diplomacy
     • The keyword should be the EVENT or TOPIC (e.g., "Iran Saudi Arabia tensions", "NATO summit 2024")
   - **YOUTUBE SCENES**: When the scene describes something found in documentaries or real-world footage that ISN'T breaking news:
     • Use sourceHint: "youtube" — real footage from YouTube (tours, documentaries, reviews, behind-the-scenes)
     • Use "youtube" for: military interiors (aircraft carrier bridge, cockpit, engine room), factory tours, historical footage, equipment demonstrations, vehicle/ship/aircraft walkthroughs, training exercises
     • Example: "inside aircraft carrier command center" → youtube (navy tour videos)
     • Example: "F-35 cockpit view" → youtube (pilot footage, military documentaries)
     • Example: "oil refinery operations" → youtube (industrial documentaries)
   - **STOCK SCENES**: When the scene describes something ABSTRACT or CINEMATIC with no specific entity:
     • Use sourceHint: "stock" — high-quality cinematic B-roll from Pexels/Pixabay
     • Use "stock" for: nature landscapes, sunsets, city aerials, abstract mood shots (dark clouds, stormy seas), generic technology close-ups (screens, circuits), calm establishing shots
     • Example: "stormy ocean waves" → stock (cinematic nature B-roll)
     • Example: "world map" → web-image (specific infographic)
   - **REDDIT SCENES**: When the scene describes sports highlights or military/combat footage with broadcast or drone footage:
     • Use sourceHint: "reddit" — broadcast captures and drone/dashcam footage from subreddits
     • Use "reddit" for: sports highlights (TV broadcast captures), military drone footage, bodycam/dashcam clips, combat footage
     • ⚠️ Do NOT use reddit for: celebrity, tech, entertainment (almost no hosted video on those subs)
     • Example: "UFC knockout highlights" → reddit (broadcast capture)
     • Example: "drone strike on tank column" → reddit (combat footage sub)
   - **BUSINESS/CORPORATE SCENES**: When the niche is business/corporate:
     • Use sourceHint: "youtube" for: real product demos, company HQs, factory tours, CEO interviews, product launches, brand stores, real-world business footage
     • Use sourceHint: "reddit" for: consumer reactions, product comparisons, brand fails/wins, viral business moments
     • Use sourceHint: "stock" ONLY for generic filler: someone typing on laptop, checking bills, office hallway, angry customer on phone, handshake — generic human actions with no specific entity
     • Example: "Nike's new factory in Vietnam" → youtube (real factory footage)
     • Example: "Tesla Cybertruck delivery" → youtube (real delivery event footage)
     • Example: "customers are angry about the price increase" → stock (generic angry person)
     • Example: "the CEO checking quarterly reports" → stock (generic person at desk)
     • ⚠️ Business = REAL PRODUCTS, REAL BRANDS, REAL BUILDINGS. Use youtube/reddit for anything with a named entity. Stock only for faceless generic visuals.
   - **SOURCE DIVERSITY IS MANDATORY** — NO source should appear on more than 50% of video scenes. Spread across providers:
     • telegram → specific real events, named conflicts, actual military/news/political footage
     • reddit → broadcast captures, drone/dashcam footage, bodycam clips, viral clips
     • youtube → documentaries, tours, behind-the-scenes, training footage, equipment reviews
     • stock → abstract/cinematic B-roll ONLY (nature, mood, generic aerials) — max 10% of scenes
     • web-image → maps, portraits, infographics, specific photos
   - DISTRIBUTION TARGET: For a 20-scene news video, aim for ~6-8 telegram, ~5-7 youtube, ~3-5 reddit, ~2-3 web-image, ~0-1 stock
   - DO NOT just default everything to one source. Each scene should use the BEST source for its specific content.
   - Be SPECIFIC, not generic! Use the entity names we found!

   **VAGUE/ABSTRACT NARRATION (for scenes with no concrete visual):**
   - This rule ONLY applies when the narration is truly ABSTRACT (e.g., "sustained behaviors", "documented interviews", "contemporaries verified") with NO concrete visual.
   - In that case, use the TOPIC CONTEXT to pick a CONCRETE, SEARCHABLE visual that relates to the story.
   - Example: topic "Sammy Davis Jr" + narration "documented interviews" → keyword: "Sammy Davis Jr interview 1960s"
   - ⚠️ This rule does NOT apply when the narration IS concrete. If scene says "cuts energy bills by 75%" → that IS concrete → keyword should be about energy bills, NOT the broader topic.
   - TEST: Does this scene's text describe something a viewer could picture? If YES → keyword from the scene text. If NO → use topic context.

   **NO SPOILERS — keyword must match what the VIEWER knows (CRITICAL):**
   - The keyword must reflect what the NARRATION actually says in THIS scene, not what you know from context.
   - If a scene is an INTRODUCTION/TEASER that says "the man who..." or "but first, we need to understand..." WITHOUT naming the person/topic yet → the keyword must be GENERIC (e.g., "Hollywood director 1910s", "old film projector"), NOT the person's name or specific work.
   - The REVEAL should happen in the NEXT scene where the name/topic is actually spoken.
   - Example: Scene says "But first, we need to understand how the man who led..." → keyword: "vintage Hollywood studio", NOT "D.W. Griffith" or "Birth of a Nation"
   - Example: Scene says "Number nine, DW Griffith" → NOW use keyword: "D.W. Griffith portrait"
   - This prevents showing the viewer WHO or WHAT is being discussed before the narrator reveals it.

   **PERSON INTRODUCTION (listicle/ranked items):**
   - When a scene FIRST NAMES a person (e.g., "Number nine, DW Griffith"), the keyword MUST be their name + "portrait" or "photo" for a clear face shot.
   - Example: "Number nine, DW Griffith. Before there were racist..." → keyword: "D.W. Griffith portrait", NOT "Birth of a Nation poster"
   - The PORTRAIT/PHOTO of the person should appear on the scene where they are NAMED, not on earlier teaser scenes or later detail scenes.

8. VISUAL INTENT:
   - Describe the EXACT shot you want
   - Include: camera angle, lighting, subject, action, mood
   - SHOT STYLE FOR THIS NICHE: ${niche.shotStyle || 'Mix of wide shots, close-ups, and varied perspectives.'}
   - Example: "Aerial drone shot of abandoned mansion at twilight with police tape"
   - Example: "Close-up of hands typing on laptop keyboard, data on screen, dark room"

9. FRAMING (how the footage fills the 16:9 frame):
   - "fullscreen" = media fills the entire frame edge-to-edge (DEFAULT for most scenes)
   - "cinematic" = pulled back with a styled background visible behind the footage
   - "floating" = smaller frame with rounded corners, drop shadow, on a styled background (like a photo/slide on a surface)

   USE "fullscreen" FOR (MOST scenes should be this):
   - Generic B-roll: cityscapes, nature, actions, establishing shots
   - Stock video footage — it's already 16:9, looks best filling the frame
   - Any scene where the visual works as a full-bleed background

   USE "cinematic" FOR:
   - Web images of REAL PEOPLE (portraits, headshots) — gives breathing room, looks polished
   - Screenshots, charts, data images, infographics — important content at edges would be cropped
   - News footage with on-screen graphics/tickers — don't crop out the lower-third
   - Historical photos, archival images — respect the original framing
   - Any image where the subject is CENTERED and cropping edges would lose important detail

   USE "floating" FOR (works with BOTH images AND videos):
   - Archival/historical photos or footage — presented like media on a display
   - Key evidence photos, documents, screenshots, or surveillance clips — spotlighted as visual artifacts
   - Dramatic reveal scenes — footage floats in on a contrasting background
   - Transition moments between major sections — visual breathing room
   - Documentary-style presentations — footage as "exhibit" on neutral background
   - Raw video clips that benefit from a framed, cinematic presentation (e.g. leaked footage, CCTV, phone recordings)
   BEST backgrounds for floating: "soft-beige", "paper", "warm-white", "cream", "warm-charcoal", "slate", "blur"
   How many floating scenes depends on the video type — documentaries/history can use more, fast-paced news/crime should use fewer.

   IMPORTANT: Do NOT overuse non-fullscreen framing! Most scenes should still be "fullscreen".
   Use your judgment on how many cinematic/floating scenes fit the video's style and pacing.

   FLOATING ANIMATION (only when framing is "floating"):
   When you pick floating, also choose:
   - floatingAnim: how the frame enters/exits the screen
     • "slideRight" = slides in from right (good for reveals, new evidence, forward momentum)
     • "slideLeft" = slides in from left (good for flashbacks, returns, looking back)
     • "slideUp" = slides up from bottom (dramatic reveals, rising tension, unveiling)
     • "fadeScale" = fades in with scale (quiet moments, reflective, contemplative)
     DIVERSIFY — don't repeat the same animation for consecutive floating scenes.
   - floatingShadow: shadow intensity behind the frame (0.3 = light/subtle, 0.5 = medium, 0.7 = heavy/dramatic)
     • Light (0.3): clean documentary look, archival photos
     • Medium (0.5): standard, works for most
     • Heavy (0.7): dramatic moments, key evidence, dark themes
   When framing is NOT floating, set both to "none".

10. BACKGROUND ID (only when framing is "cinematic" or "floating"):
   When framing is "cinematic" or "floating", choose a background that shows behind the footage.
   - "blur" = blurred duplicate of same footage (good default for cinematic)
   - Or pick from the available gradient backgrounds:
${_buildBackgroundList(theme)}
   Pick the background that best matches the scene mood. Use "blur" as safe default if unsure.
   For "floating" framing, prefer solid/soft backgrounds: soft-beige, paper, warm-white, cream, warm-charcoal, slate.
   When framing is "fullscreen", set backgroundId to "none".

11. KEYWORD FORMAT (CRITICAL — this is THE primary search term):

   ⚠️ STEP 0 — CLASSIFY THE NARRATION BEFORE WRITING ANY KEYWORD:
   Read the scene's quoted text and pick ONE of these four categories. Your choice determines whether you even NEED a keyword.

   (A) CONCRETE — a camera could literally film what the narration describes right now.
       ("container ship entering port", "grocery store aisle", "soldier patrolling")
       → Write a keyword. Continue with the rules below.

   (B) METAPHOR / ABSTRACT — narration describes an idea, comparison, or editing concept, not a filmable scene.
       ("the network is breaking apart", "side-by-side comparison", "inflation is squeezing families",
        "the mechanism that drives this", "a montage of chaos", "the system's grid is collapsing")
       → DO NOT write a keyword. Set keyword="none", sourceHint="none".
       → Go STRAIGHT to fullscreenMG:
          • "focusWord: <1-3 word punch>" for single-concept beats (e.g. "focusWord: Collapse")
          • "kineticText: <short phrase>" for rhythmic/impactful prose (e.g. "kineticText: Breaking Apart")
          • templateHint="keyTakeaway: <line>" if the metaphor IS a conclusion sentence
       → This is not a fallback — it's the CORRECT primary choice for metaphor scenes.

   (C) DATA / NUMBERS — narration states ≥2 numbers, percentages, or ranked items.
       ("exports dropped from 100 to 40", "75% energy savings, 90% insurance cut")
       → Prefer fullscreenMG barChart/donutChart/rankingList OR templateHint statCard.
       → Only write a keyword if you ALSO want footage behind an overlay mgHint.

   (D) NEWS ACTOR — narration names a state/military actor + military/political verb.
       ("Iran navy patrol", "Houthi forces strike", "Russian missile")
       → Write a keyword AND force sourceHint="telegram"${nicheAllowsMapChart ? ' (or fullscreenMG="mapChart" if >=2 locations).' : ' (mapChart is forbidden for this niche; use real footage or web-image references for geography).'}
       → NEVER sourceHint="stock" on actor scenes. Stock libraries have zero matches.

   ADJACENT-SCENE DIVERSITY RULE:
   - If the PREVIOUS scene you just planned used fullscreenMG="focusWord", this scene must NOT also use focusWord. Alternate with kineticText, or go back to footage/template.
   - If 3 scenes in a row would all be typography (focusWord/kineticText), break the run: force one of them to templateHint (keyTakeaway/statCard/imageShowcase) or concrete footage.

   The keyword field must be SHORT (3-6 words) and directly searchable.
   Strategy for this niche (${niche.name}): "${(() => {
       const kr = getKeywordRules(nicheId);
       return kr.strategy || 'balanced';
   })()}"
${(() => {
    const kr = getKeywordRules(nicheId);
    let block = '';
    if (kr.rules && kr.rules.length > 0) {
        block += kr.rules.map(r => `   - ${r}`).join('\n');
    }
    if (kr.examples) {
        if (kr.examples.good) {
            block += `\n   - GOOD: ${kr.examples.good.join(', ')}`;
        }
        if (kr.examples.bad) {
            block += `\n   - BAD: ${kr.examples.bad.join(', ')}`;
        }
    }
    return block;
})()}
   The keyword is NOT a shot description. Save cinematic details for visualIntent.
   If the scene names a person, the keyword MUST be that person's name (+ optional context word).

   ⚠️ KEYWORD MUST MATCH THIS SCENE'S NARRATION (CRITICAL):
   - Read ONLY this scene's quoted text. The keyword must reflect what THIS scene says, not the broader video topic.
   - If scene says "It cuts energy bills by up to 75 percent" → keyword: "energy bill savings home", NOT "thermal imaging house energy"
   - If scene says "insurance premiums by up to 90" → keyword: "home insurance policy document", NOT "monolithic dome insulation"
   - If scene says "and can last for centuries" → keyword: "ancient stone building centuries old", NOT "dome construction materials"
   - The VIDEO TOPIC gives context, but the keyword must match what the NARRATOR IS SAYING in this specific 2-5 second clip.
   - ASK: "If I mute everything else and ONLY hear this scene's text, what footage would I show?" THAT is your keyword.
   - When a scene states a NUMBER or PERCENTAGE, consider whether an mgHint (statCounter) or fullscreenMG is BETTER than footage.

   CRITICAL — NEVER use abstract, metaphorical, or conceptual keywords:
   - BANNED WORDS in keyword (these have NO stock match — they describe ideas, not shots):
     montage, mechanism, inflation, dilemma, analogy, principle, strategy, concept,
     collapse, breaking apart, falling apart, grid collapse, system breaking, network grid,
     symbolism, metaphor, paradigm, dichotomy, framework, equilibrium, dynamic,
     side-by-side comparison, juxtaposition, interplay
   - If you want to write any of these words → STOP. Pick one of these instead:
     (a) a CONCRETE physical shot (what a camera would literally capture in that moment), OR
     (b) fullscreenMG "kineticText" / "focusWord" / "statCounter" — abstract ideas belong on typography, not footage.
   - BAD: "container ship and oil tanker montage" → GOOD: "oil tanker at sea" + set mgHint="kineticText: Oil + Shipping"
   - BAD: "digital network grid breaking apart" → GOOD: fullscreenMG="focusWord: Collapse" (no footage keyword)
   - BAD: "grocery store checkout inflation" → GOOD: "grocery store shelves" + mgHint="statCounter: +8.2% Food Prices"
   - BAD: "complex gear system mechanism close-up" → GOOD: "industrial gears turning" (one concrete object)
   - BAD: "large container ship and small freighter side-by-side" → GOOD: "container ship aerial" (pick ONE subject, not a comparison)
   - Other examples: "warfare principles Sun Tzu" → "military command center screens"; "no-win battery dilemma" → "missile battery operator radar screen"
   - TEST: "Can a camera photograph this exact keyword in one shot, today?" If no → rewrite or flip to MG.

   ⚠️ MAX 3 CONCRETE NOUNS (hard cap for stock-routed scenes):
   - If sourceHint is "stock", keyword must have AT MOST 3 concrete nouns.
   - "HMM Algeciras class ship drone" = 4 nouns + brand (HMM Algeciras) = BANNED. Use "container ship aerial" (2 nouns) instead.
   - "Bab el-Mandeb strait container ship drone" = 4 nouns. Use "container ship strait" (2 nouns).
   - Brand/class names (HMM Algeciras, USS Gerald Ford, F-35) are OK on youtube/telegram/web-image, NEVER on stock.

   ⚠️ NEWS-ACTOR HARD RULE (no exceptions):
   - If the scene text mentions a state/military actor (Iran, Russia, Houthi, Hamas, IDF, NATO, Ukraine, Israel, China, North Korea, Hezbollah, Taliban, ISIS) combined with a military/political verb (navy, forces, strike, patrol, attack, invasion, missile, drone, blockade, sanctions) → ${nicheAllowsMapChart ? 'sourceHint MUST be "telegram" OR fullscreenMG="mapChart".' : 'sourceHint MUST be "telegram"; mapChart is forbidden for this niche.'} NEVER "stock". NEVER "pexels".
   - These events do not exist on stock footage libraries. Routing them to stock guarantees failure.
   - If telegram also feels wrong for the scene, ${nicheAllowsMapChart ? 'use a map fullscreenMG instead of forcing footage.' : 'use youtube/web-image route references, a template, or an overlay instead of stock.'}

   ⚠️ TOPIC ANCHORING (CRITICAL FOR NEWS/POLITICS/MILITARY NICHES):
   - Every keyword MUST be grounded in the SPECIFIC topic of this video.
   - News channels and search engines return the MOST RECENT content matching your words.
   - Generic keywords like "Iran blockade" or "government building" will return footage from whatever conflict is trending TODAY — not from the topic of THIS video.
   - ALWAYS include the specific country, entity, or event anchor in your keyword.
   - BAD: "Tehran control lost" — returns random Iran news, probably unrelated
   - BAD: "two weeks blockade" — returns any blockade from any conflict
   - BAD: "government building" — returns any government building anywhere
   - GOOD: "Iran Strait of Hormuz shipping" — specific to this topic
   - GOOD: "Saudi Arabia oil pipeline Yanbu" — anchored to the exact story
   - GOOD: "Aramco oil terminal Red Sea" — concrete + topic-specific
   - Rule: If the keyword could match footage from a DIFFERENT news story, add the specific entity/location to anchor it.

12. SEARCH-OPTIMIZED QUERIES (CRITICAL FOR QUALITY):
   You must provide TWO different search queries optimized for different providers:

   **stockQuery** (for Pexels, Pixabay, Unsplash — stock footage APIs):
   - MAXIMUM 3 words — shorter = much better results
   - Use VISUAL/GENERIC terms, NOT specific names or events
   - Focus on what the shot LOOKS LIKE, not what it IS about
   - Good: "police car night", "office meeting", "sunset ocean"
   - Bad: "FBI agents raiding Gene Hackman mansion" (too specific, stock won't have this)
   - Bad: "technology" (too vague, returns random results)

   **webQuery** (for Bing, Google — web image search):
   - Can be 4-8 words, specific is BETTER
   - Use REAL NAMES, dates, events — web search is good at this
   - Add context words like "photo", "footage", "press conference"
   - Good: "Gene Hackman 2024 photo", "Tesla Cybertruck reveal event"
   - Bad: "man standing" (too generic for web)
   - NEVER wrap the query in quotation marks — just plain words

   The right stockQuery + webQuery combo is THE difference between good and bad footage!

13. EFFECTS (per-scene effect preset):
   - Pick ONE preset from the AVAILABLE EFFECT PRESETS list above, or "none"
   - Each preset is a curated combo (grain, scratches, color grading, etc.) — DO NOT list individual effects
   - Match preset to scene mood/tone (see descriptions above)
   - ~40-50% of scenes should be "none" — don't overuse
   - HOOK scenes benefit from subtle presets for visual impact

14. MG HINT (OVERLAY motion graphic — appears ON TOP of footage):
   - Format: "<mgType>: <brief content description>" or "none"
   - Overlay MGs appear over the footage. Default is "none".${isNonEnglish ? `\n   - ⚠️ LANGUAGE: The content description text MUST be in ${buildLangName}. Example: "statCounter: 75% Energieeinsparung" NOT "75% Energy Savings"` : ''}
   - ONLY add when the narration has a clear CONTENT SIGNAL:
     • A SPECIFIC NUMBER, PERCENTAGE, or STATISTIC → "statCounter: 75% energy savings" — THIS IS HIGH PRIORITY. When the narrator says a number, the viewer NEEDS to see it on screen.
       Examples: "cuts bills by 75 percent" → "statCounter: 75% Energy Bill Reduction"
                 "over a million new houses" → "statCounter: 1,000,000+ Houses Built Annually"
                 "less than 900 of these homes" → "statCounter: <900 Monolithic Domes in America"
     • A NEW PERSON INTRODUCED BY NAME + TITLE → "lowerThird: DW Griffith, Film Director"
       (Do NOT repeat for the same person in later scenes)
     • A DIRECT QUOTE spoken verbatim → "callout: I believe in white supremacy"
   - Overlay types: lowerThird, headline, statCounter, callout, focusWord, progressBar
   - statCounter is the MOST underused MG — every time you see a number in the narration, strongly consider it
   - Most scenes are pure storytelling — they should have NO MG
   - Do NOT cluster MGs — leave gaps of 2-4 scenes between MGs
   - **NO SPOILER MGs**: A lowerThird must ONLY appear on the scene where the person is FIRST NAMED in the narration text. If a scene says "but first, the man who..." without naming anyone → NO lowerThird. The lowerThird goes on the NEXT scene where the name is actually spoken.

15. FULLSCREEN MG (REPLACES footage — no download needed for this scene):
   - Format: "<mgType>: <content data>" or "none"
   - When set, this scene becomes a FULLSCREEN motion graphic — NO footage is downloaded.
   - This is BETTER than footage when the scene's narration is data-heavy or abstract.${isNonEnglish ? `\n   - ⚠️ LANGUAGE: ALL content data (labels, titles, items, comparisons) MUST be in ${buildLangName}. Example: "comparisonCard: Öffentliches Bild vs Private Realität" NOT English.` : ''}

   ⚠️ CRITICAL DATA RULE — DATA MGs REQUIRE REAL DATA FROM THE NARRATION:
   The types barChart, donutChart, rankingList, timeline, bulletList, comparisonCard
   are DATA MGs — they render charts/lists from labels + numbers. DO NOT invent data.
   If the scene's narration does NOT contain real numbers/comparisons/dates/items,
   DO NOT USE a data MG — pick footage, a template, or a non-data MG instead.
   Data MGs with missing/invented data will be REJECTED and the scene will have no visual.

   - FORMAT for data MGs (title + pipe-separated Label:Number pairs):
     • barChart   → "barChart: <Title> | Label1:Num1 | Label2:Num2 | Label3:Num3"  (≥2 numeric pairs, numbers only)
     • donutChart → "donutChart: <Title> | Label1:Num1 | Label2:Num2"  (≥2 numeric pairs, percentages add to ~100)
     • rankingList→ "rankingList: <Title> | #1 Item:Num | #2 Item:Num | #3 Item:Num"  (≥2 numeric pairs)
     • timeline   → "timeline: <Title> | 1915:Event | 1925:Event | 1999:Event"  (≥2 date:event pairs)
     • bulletList → "bulletList: <Title> | Point 1 | Point 2 | Point 3"  (≥2 items, no colons needed)
     • comparisonCard → "comparisonCard: Item A vs Item B"  (must contain " vs ")

   - USE fullscreenMG WHEN:
     • Scene explicitly states 2+ numbers/stats → barChart (e.g. narration says "exports dropped from 100 to 40") → "barChart: Bab-el-Mandeb Transit | Before:100 | Now:40"
     • Scene compares market shares/percentages that add up → donutChart
     • Scene lists ranked items with numeric values → rankingList
     • Scene lists MULTIPLE dates with events (≥2 years mentioned) → timeline
     • Scene lists ≥2 short points/items (no numbers needed) → bulletList
     • Scene makes an explicit COMPARISON — the word "vs", "versus", "compared to" → comparisonCard
     • Scene discusses an article/document/book → "articleHighlight: Title of Article"
${mapFullscreenRules}

   - DO NOT USE data MG WHEN:
     • The narration only names a topic without numbers (e.g. "Bab-el-Mandeb Transit Volume" alone is NOT enough — there are no numbers)
     • You would have to invent numbers or labels the narration doesn't state
     • The scene has only one data point (charts need ≥2 to make sense)
     → In those cases, use mgHint (overlay), templateHint, or footage instead.

   - Fullscreen MG types: ${fullscreenMGTypes || 'none from this niche allowlist'}
   - When fullscreenMG is set, keyword/stockQuery/webQuery are IGNORED (set to "none")
   - Do NOT overuse — max ~15% of scenes. Most scenes should be footage.
   - NEVER use on HOOK or CTA scenes — those need strong visual footage.

16. TEMPLATE HINT (fullscreen template card on V3 — IMPORTANT visual system):
   - Format: "<templateType>: <brief content>" or "none"${isNonEnglish ? `\n   - ⚠️ LANGUAGE: ALL template content text MUST be in ${buildLangName}. Example: "statCard: Energie -75% Stromrechnung" NOT English.` : ''}
   - Template types: chapterCard, locationCard, quoteCard, keyTakeaway, comparisonCard, timelineCard, factCard, imageShowcase, statCard, personIntro
   - ⚠️ TEMPLATES ARE BETTER THAN BAD FOOTAGE. When a scene's narration is about numbers, data, comparisons, or abstract concepts that won't produce good search results — USE A TEMPLATE instead of forcing a keyword search.
   - USE templateHint WHEN:
     • Narration mentions NUMBERS or PERCENTAGES (1-3 stats) → "statCard: -90% Insurance | -75% Energy Bills" — THIS IS THE MOST IMPORTANT TEMPLATE. Icon+number infographics look professional. Use for: "cuts bills by 75%", "saves up to 90%", "less than 900 homes", etc.
     • Narration mentions MANY stats/numbers (4+) → "factCard: Title | fact1; fact2; fact3; fact4"
     • Narration transitions to a NEW MAJOR SECTION/TOPIC → "chapterCard: Chapter Title"
     • A NEW SPECIFIC LOCATION is introduced for the first time → "locationCard: Place Name, Country"
     • A DIRECT QUOTE is spoken that deserves visual emphasis → "quoteCard: The quote text"
     • In the final 20% of video, a key insight/conclusion → "keyTakeaway: Main point"
     • An explicit COMPARISON (X vs Y) in narration → "comparisonCard: Thing A vs Thing B"
     • Dates/events forming a chronological sequence → "timelineCard: Date1: Event | Date2: Event"
     • Narration references two or three related concepts/people/places worth visualizing → "imageShowcase: Title | image1 desc; image2 desc; image3 desc" (2-3 images, collage variant scatters them like photos on a desk)
     • A NAMED PERSON is introduced for the FIRST TIME → "personIntro: Person Name | Role/Title, Year" — Shows portrait + name + context image. MUCH better than just downloading a portrait photo. Use for: "Wallace Neff", "Buckminster Fuller", "David South", etc. Only on FIRST mention — not for every scene about them.
     • Narration EXPLICITLY COMPARES two things visually (before/after, two countries, two sides) → "splitScreen: Title | Left Label; Right Label" — Vertical split with two images side by side. Use when two contrasting visuals would be impactful.
     • Narration lists 3-5+ items each with a stat/price/detail (weapon costs, country budgets, building specs) → "infographic: Title | Item1 Title | Value | image; Item2 Title | Value | image" — Multi-item visual layout with images, titles, and values. More complex than statCard.
   - personIntro FORMAT: "personIntro: Person Name | Role/Title, Year"
     Examples:
     • "Wallace Neff, an architect..." → "personIntro: Wallace Neff | Architect, 1941"
     • "Buckminster Fuller invented..." → "personIntro: Buckminster Fuller | Inventor & Architect"
     • "David South, the founder..." → "personIntro: David South | Founder, Monolithic Dome Institute"
   - statCard FORMAT: "statCard: <icon hint> <number> <label> | <icon hint> <number> <label>"
     Examples:
     • "cuts energy bills by 75%" → "statCard: energy -75% Energy Bills"
     • "insurance premiums by 90%" → "statCard: shield -90% Insurance Premiums"
     • "75% energy, 90% insurance" (same scene, 2 stats) → "statCard: energy -75% Energy Bills; shield -90% Insurance"
     • "less than 900 homes exist" → "statCard: home <900 Dome Homes in USA"
     Icon hints: energy, shield, home, money, people, globe, chart, clock, building, car, health, tech
     Separate multiple stats with semicolons (;), NOT pipes (|)
   - Aim for 3-5 templates per video — they make the video look PROFESSIONAL
   - NEVER on HOOK or CTA scenes
   - Can't be same scene as fullscreenMG (choose one or the other)
   - Default is "none" for most scenes — but ACTIVELY LOOK for template opportunities in every scene

OUTPUT FORMAT (one line per scene):

SCENE 0: keyword: <search term or none> | stockQuery: <query or none> | webQuery: <query or none> | mediaType: <video|image> | sourceHint: <stock|youtube|web-image|telegram|reddit> | framing: <fullscreen|cinematic|floating> | backgroundId: <none|blur|gradient-id> | floatingAnim: <slideRight|slideLeft|slideUp|fadeScale|none> | floatingShadow: <0.3|0.5|0.7|none> | visualIntent: <shot description> | effects: <presetName or none> | mgHint: <overlay type: desc or none> | fullscreenMG: <fullscreen type: data or none> | mapVariant: <locator|route|regionHighlight|comparison|none> | templateHint: <template type: content or none>
SCENE 1: keyword: <search term or none> | stockQuery: <query or none> | webQuery: <query or none> | mediaType: <video|image> | sourceHint: <stock|youtube|web-image|telegram|reddit> | framing: <fullscreen|cinematic|floating> | backgroundId: <none|blur|gradient-id> | floatingAnim: <slideRight|slideLeft|slideUp|fadeScale|none> | floatingShadow: <0.3|0.5|0.7|none> | visualIntent: <shot description> | effects: <presetName or none> | mgHint: <overlay type: desc or none> | fullscreenMG: <fullscreen type: data or none> | mapVariant: <locator|route|regionHighlight|comparison|none> | templateHint: <template type: content or none>
...

CRITICAL: YOU MUST OUTPUT EXACTLY ${scenes.length} LINES (one per scene).
Each keyword must be UNIQUE, SEARCHABLE, and SHORT (3-6 words). When a person is named in the scene, keyword = their name.
When fullscreenMG is set, keyword/stockQuery/webQuery can be "none" (footage won't be downloaded).
Do NOT put cinematic shot descriptions in keyword — that goes in visualIntent.
stockQuery and webQuery must BOTH be provided for every footage scene.

OUTPUT CONTRACT (HARD RULES — non-negotiable):
- Mutual exclusivity: NEVER set BOTH fullscreenMG AND templateHint on the same scene. Pick ONE lane.
- mgHint may co-exist with footage; mgHint may NOT co-exist with fullscreenMG (the fullscreen replaces everything).
- Per-scene CONSTRAINTS line is law:
${outputMapContractRules}
  • If FS-MG=forbidden → fullscreenMG MUST be "none" (hook/CTA scenes).
  • If STOCK=disallowed → sourceHint MUST NOT be "stock"/"pexels"/"pixabay". Use the niche's top real-source instead.
- Niche allowlist is law: fullscreenMG type MUST be one of [${nicheAllowedMGs.join(', ')}] (or "none"). Anything else will be rewritten downstream.
- Data MGs require real numbers: barChart/donutChart/rankingList/timeline/comparisonCard demand ≥2 numeric pairs from the actual narration. If the narration has no numbers/dates/items, do NOT pick a data MG — pick a template, typography, or footage.
${mapPayloadContractRule}
- ROLE alignment: a person-intro scene must NOT route to stock; a quote-beat scene must NOT route to a barChart; a stat-beat scene with 2+ numbers MUST surface a stat lane (statCard | barChart | donutChart | statCounter).

⚠️ MANDATORY — DO NOT SKIP mgHint AND templateHint FIELDS:
You MUST evaluate EVERY scene for mgHint and templateHint. Do NOT default everything to "none".
- Any scene with a NUMBER/PERCENTAGE → must have mgHint: statCounter OR templateHint: statCard
- Any scene with a named person + title → must have mgHint: lowerThird
- Any scene transitioning to a new major section → consider templateHint: chapterCard
- Any scene with a direct quote → consider templateHint: quoteCard or mgHint: callout
- Expect at LEAST 3-5 mgHints and 2-4 templateHints per video. If you output zero, you are doing it wrong.
- statCard templates save API calls by replacing bad-keyword scenes — use them for stat-heavy narration!${isNonEnglish ? `

🔴 FINAL LANGUAGE REMINDER: This video is in ${buildLangName} (lang=${buildLang}).
ALL on-screen text in mgHint, fullscreenMG, and templateHint MUST be written in ${buildLangName}.
keyword/stockQuery/webQuery stay in English (for search engines). Everything else = ${buildLangName}.
Do NOT write English display text. Do NOT switch to English mid-output. EVERY scene, ${buildLangName} only.` : ''}`;

    return prompt;
}

// ============================================================
// RESPONSE PARSING
// ============================================================

// AI sometimes returns placeholder values like "none" / "n/a" / "-" instead of
// omitting the field. For search strings that would leak into the downloader
// (keyword, stockQuery, webQuery) these must be treated as null so the
// fallback repair path in parseBatchResponse can regenerate a real keyword.
const _PLACEHOLDER_VALUES = new Set(['', 'none', 'n/a', 'na', 'null', 'nil', 'undefined', '-', '--', 'tbd']);
function _sanitizeSearchValue(raw) {
    if (raw == null) return null;
    const stripped = String(raw).replace(/^["']+|["']+$/g, '').trim();
    if (!stripped) return null;
    if (_PLACEHOLDER_VALUES.has(stripped.toLowerCase())) return null;
    return stripped;
}

/**
 * Parse the batch visual plan response.
 * Extracts keyword, mediaType, sourceHint, visualIntent for each scene.
 */
function parseBatchResponse(rawText, scenes, nicheId, themeId, scriptContext, plannerDirectives = null) {
    const entities = scriptContext?.entities || [];
    const enrichedScenes = [];
    const lines = rawText.trim().split('\n').filter(line => {
        const lower = line.toLowerCase().trim();
        return lower.startsWith('scene ') && lower.includes(':');
    });

    // Build a Map<sceneIndex, line> keyed by the global scene.index the prompt used.
    // Detect duplicates and collect unparseable lines so we can hard-fail the batch.
    const lineByIndex = new Map();
    const duplicates = [];
    for (const line of lines) {
        const match = line.match(/scene\s+(\d+)/i);
        if (!match) continue;
        const idx = parseInt(match[1], 10);
        if (lineByIndex.has(idx)) {
            duplicates.push(idx);
        } else {
            lineByIndex.set(idx, line);
        }
    }
    if (duplicates.length > 0) {
        throw new Error(`Duplicate scene number(s) in batch response: ${duplicates.join(', ')}`);
    }

    const missing = [];
    for (const s of scenes) {
        if (!lineByIndex.has(s.index)) missing.push(s.index);
    }
    if (missing.length > 0) {
        throw new Error(`Missing scene number(s) in batch response: ${missing.join(', ')}`);
    }

    for (let i = 0; i < scenes.length; i++) {
        const scene = { ...scenes[i] };

        // Match strictly by global scene.index (not loop index — scenes come in chunks).
        const matchedLine = lineByIndex.get(scene.index);

        if (matchedLine) {
            // Remove "SCENE N: " prefix first
            let content = matchedLine.substring(matchedLine.indexOf(':') + 1).trim();

            // Parse: keyword: X | mediaType: Y | sourceHint: Z | visualIntent: W
            const parts = content.split('|').map(p => p.trim());

            for (const part of parts) {
                const lower = part.toLowerCase();

                if (lower.startsWith('keyword:')) {
                    scene.keyword = _sanitizeSearchValue(part.substring(part.indexOf(':') + 1));
                }
                if (lower.startsWith('stockquery:') || lower.startsWith('stock query:')) {
                    scene.stockQuery = _sanitizeSearchValue(part.substring(part.indexOf(':') + 1));
                }
                if (lower.startsWith('webquery:') || lower.startsWith('web query:')) {
                    scene.webQuery = _sanitizeSearchValue(part.substring(part.indexOf(':') + 1));
                }
                if (lower.startsWith('mediatype:') || lower.startsWith('media type:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    scene.mediaType = val === 'video' ? 'video' : 'image';
                }
                if (lower.startsWith('sourcehint:') || lower.startsWith('source hint:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    if (['stock', 'youtube', 'web-image', 'news', 'telegram', 'reddit'].includes(val)) {
                        scene.sourceHint = val;
                    }
                }
                if (lower.startsWith('visualintent:') || lower.startsWith('visual intent:')) {
                    scene.visualIntent = part.substring(part.indexOf(':') + 1).trim();
                }
                if (lower.startsWith('background:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    if (['blur', 'none'].includes(val)) {
                        scene.background = val;
                    }
                }
                if (lower.startsWith('framing:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    if (['fullscreen', 'cinematic', 'floating'].includes(val)) {
                        scene.framing = val;
                    }
                }
                if (lower.startsWith('floatinganim:') || lower.startsWith('floating anim:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    if (['slideright', 'slideleft', 'slideup', 'fadescale'].includes(val)) {
                        // Normalize to camelCase
                        const animMap = { slideright: 'slideRight', slideleft: 'slideLeft', slideup: 'slideUp', fadescale: 'fadeScale' };
                        scene.floatingAnim = animMap[val] || 'slideRight';
                    }
                }
                if (lower.startsWith('floatingshadow:') || lower.startsWith('floating shadow:')) {
                    const val = parseFloat(part.substring(part.indexOf(':') + 1).trim());
                    if (!isNaN(val) && val >= 0 && val <= 1) {
                        scene.floatingShadow = val;
                    }
                }
                if (lower.startsWith('backgroundid:') || lower.startsWith('background id:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    scene.backgroundId = val;
                }
                if (lower.startsWith('effects:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().toLowerCase();
                    if (val === 'none' || val === '') {
                        scene.effects = [];
                        scene.effectPreset = 'none';
                    } else {
                        // val is a preset name (e.g. "retroDV", "oldFilm")
                        const EFFECT_PRESETS = require('./effect-presets');
                        const presetKey = Object.keys(EFFECT_PRESETS).find(k => k.toLowerCase() === val) || val;
                        const preset = EFFECT_PRESETS[presetKey];
                        // Validate preset is allowed for this theme
                        const activeThemeId = themeId || 'standard';
                        const themeAllowed = preset && preset.themes &&
                            (preset.themes.includes('*') || preset.themes.includes(activeThemeId));
                        if (!themeAllowed && preset) {
                            console.log(`      ⚠️ Preset "${presetKey}" not allowed for theme "${activeThemeId}", skipping`);
                        }
                        if (preset && themeAllowed) {
                            scene.effectPreset = presetKey;
                            scene.effects = preset.effects ? [...preset.effects] : [];
                            scene.effectOverrides = {};
                            if (preset.params) {
                                for (const [fx, params] of Object.entries(preset.params)) {
                                    scene.effectOverrides[fx] = { ...params, enabled: true };
                                }
                            }
                            if (preset.mask) {
                                scene.effectMask = { ...preset.mask };
                            }
                        } else {
                            // Fallback: treat as comma-separated individual effects (backwards compat)
                            scene.effects = val.split(',').map(e => e.trim()).filter(Boolean);
                        }
                    }
                }
                if (lower.startsWith('mghint:') || lower.startsWith('mg hint:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().replace(/^["']+|["']+$/g, '');
                    if (val.toLowerCase() === 'none' || val === '') {
                        scene.mgHint = null;
                    } else {
                        scene.mgHint = val;
                    }
                }
                if (lower.startsWith('fullscreenmg:') || lower.startsWith('fullscreen mg:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().replace(/^["']+|["']+$/g, '');
                    if (val.toLowerCase() === 'none' || val === '') {
                        scene.fullscreenMG = null;
                    } else {
                        scene.fullscreenMG = val;
                        // Fullscreen MG replaces footage — clear download fields
                        scene.keyword = null;
                        scene.stockQuery = null;
                        scene.webQuery = null;
                        scene.mediaType = null;
                        scene.sourceHint = null;
                    }
                }
                if (lower.startsWith('mapvariant:') || lower.startsWith('map variant:')) {
                    const raw = part.substring(part.indexOf(':') + 1).trim().replace(/^["']+|["']+$/g, '').toLowerCase();
                    const variantMap = {
                        locator: 'locator',
                        route: 'route',
                        regionhighlight: 'regionHighlight',
                        region_highlight: 'regionHighlight',
                        'region-highlight': 'regionHighlight',
                        region: 'regionHighlight',
                        comparison: 'comparison',
                        compare: 'comparison',
                    };
                    scene.mapVariant = (raw === 'none' || raw === '') ? null : (variantMap[raw] || null);
                }
                if (lower.startsWith('templatehint:') || lower.startsWith('template hint:')) {
                    const val = part.substring(part.indexOf(':') + 1).trim().replace(/^["']+|["']+$/g, '');
                    if (val.toLowerCase() === 'none' || val === '') {
                        scene.templateHint = null;
                    } else {
                        scene.templateHint = val;
                    }
                }
            }

            // Strip wrapping quotes from parsed values (AI sometimes wraps in quotes)
            const stripQuotes = v => v ? v.replace(/^["']+|["']+$/g, '').trim() : v;
            if (scene.keyword) scene.keyword = stripQuotes(scene.keyword);
            if (scene.stockQuery) scene.stockQuery = stripQuotes(scene.stockQuery);
            if (scene.webQuery) scene.webQuery = stripQuotes(scene.webQuery);
            if (scene.visualIntent) scene.visualIntent = stripQuotes(scene.visualIntent);
            if (scene.templateHint) scene.templateHint = stripQuotes(scene.templateHint);

            // Snapshot the raw AI lane before guardrails rewrite it. This makes
            // map-dropped visible in the Planner Summary when the model ignores
            // a niche that forbids mapChart.
            _snapshotRawAIChoice(scene);
            _dropForbiddenMapChart(scene, nicheId, plannerDirectives, false);

            // templateHint and fullscreenMG are mutually exclusive — fullscreenMG wins
            if (scene.templateHint && scene.fullscreenMG) {
                scene.templateHint = null;
            }

            // Auto-generate stockQuery/webQuery from keyword if AI didn't provide them
            if (scene.keyword && !scene.stockQuery) {
                scene.stockQuery = _autoStockQuery(scene.keyword);
            }
            if (scene.keyword && !scene.webQuery) {
                scene.webQuery = _autoWebQuery(scene.keyword, scene.sourceHint);
            }
        }

        // Fullscreen MG scenes don't need keywords/media — skip fallbacks
        if (!scene.fullscreenMG) {
            // Fallback: Generate keyword from scene text if missing
            if (!scene.keyword || scene.keyword.length < 3) {
                scene.keyword = extractFallbackKeyword(scene.text);
            }

            // Default values
            scene.mediaType = scene.mediaType || 'video';
            scene.sourceHint = scene.sourceHint || 'stock';
        }

        // Person entity override: if keyword matches a known entity name AND the AI
        // didn't set web-image, force it. Stock providers will never have real people.
        const entityTypes = scriptContext?.entityTypes || {};
        if (entities && entities.length > 0 && scene.keyword) {
            const kwLower = scene.keyword.toLowerCase();
            // Check ALL matching entities — if ANY is a person, trigger person lock
            const matchedEntities = entities.filter(e => {
                const eLower = e.toLowerCase();
                return kwLower.includes(eLower) || eLower.includes(kwLower);
            });
            const personEntity = matchedEntities.find(e => entityTypes[e.toLowerCase()] === 'person');
            const hasPortraitHint = /portrait|photo|headshot|face/i.test(kwLower);

            if ((personEntity || hasPortraitHint) && scene.sourceHint !== 'web-image') {
                const name = personEntity || matchedEntities[0];
                console.log(`  🧑 Person detected: "${name}" — forcing web-image`);
                scene.mediaType = 'image';
                scene.sourceHint = 'web-image';
                scene._personLock = true;
                if (!hasPortraitHint) {
                    scene.keyword = `${scene.keyword} photo`;
                }
            }
        }

        // News niche safety net: only override "stock" default (when AI didn't provide sourceHint)
        // If AI explicitly chose a source, trust it — the prompt now teaches per-scene source selection
        if (nicheId && nicheId.startsWith('news') && scene.sourceHint === 'stock') {
            if (scene.mediaType !== 'video') {
                scene.sourceHint = 'web-image'; // images in news should be real photos, not stock
            }
        }

        // ── Niche-aware stock override ──
        // Stock (pexels/pixabay) doesn't have real footage for news/military/sport niches.
        // If AI picked stock for a video scene where stock is last-resort, override to niche's #1 source.
        // Other sources (youtube/telegram/reddit) are left as-is — let the AI decide.
        if (scene.mediaType === 'video' && nicheId) {
            const { getNiche: _getNiche } = require('./niches');
            const _niche = _getNiche(nicheId);
            const videoPriority = _niche.footagePriority?.video || [];

            if (videoPriority.length > 0) {
                const hint = scene.sourceHint || 'stock';
                const isStock = hint === 'stock' || hint === 'pexels' || hint === 'pixabay';
                const stockIdx = Math.max(
                    videoPriority.indexOf('pexels'),
                    videoPriority.indexOf('pixabay')
                );
                const isStockLastResort = stockIdx >= videoPriority.length - 2;

                if (isStock && isStockLastResort) {
                    const topSource = videoPriority[0];
                    console.log(`      🔄 stock → ${topSource} (stock is last-resort for ${_niche.name})`);
                    scene.sourceHint = topSource;
                }
            }
        }

        scene.framing = scene.framing || 'fullscreen';
        // Floating animation defaults (AI may have set these)
        if (scene.framing === 'floating') {
            scene.floatingAnim = scene.floatingAnim || 'slideRight';
            scene.shadow = scene.floatingShadow || 0.5;
        }
        // Derive background from framing + backgroundId
        if (!scene.background) {
            if (scene.framing === 'cinematic' || scene.framing === 'floating') {
                const bgId = scene.backgroundId || (scene.framing === 'floating' ? 'soft-beige' : 'blur');
                if (bgId === 'blur') {
                    scene.background = 'blur';
                } else if (bgId === 'none') {
                    scene.background = 'none';
                } else if (bgId.startsWith('file:')) {
                    // Custom background file: "file:history--vintage-paper.jpg" → "pattern:history--vintage-paper.jpg"
                    scene.background = `pattern:${bgId.replace('file:', '')}`;
                } else if (BACKGROUND_LIBRARY[bgId]) {
                    scene.background = `gradient:${bgId}`;
                } else {
                    scene.background = 'blur'; // Unknown ID, fall back to blur
                }
            } else {
                scene.background = 'none';
            }
        }
        scene.visualIntent = scene.visualIntent || scene.keyword;
        if (!scene.effects) scene.effects = [];
        if (scene.mgHint === undefined) scene.mgHint = null;

        _snapshotRawAIChoice(scene);

        enrichedScenes.push(scene);
    }

    // Source Diversity enforcement moved to _finalizeVisualPlan so it runs
    // ONCE globally across the full scene list (not per-batch).

    return enrichedScenes;
}

/**
 * Extract a fallback keyword from scene text (used when AI fails).
 * Takes the most important nouns/verbs from the scene.
 */
function extractFallbackKeyword(text) {
    // Remove common words
    const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from', 'as', 'is', 'was', 'are', 'were', 'been', 'be', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'may', 'might', 'must', 'can', 'this', 'that', 'these', 'those', 'it', 'its', 'they', 'them', 'their']);

    const words = text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.has(w));

    // Take first 3-4 meaningful words
    const keyword = words.slice(0, 4).join(' ');
    return keyword.length > 0 ? keyword : text.substring(0, 50);
}

// ============================================================
// VIDEO RATIO ENFORCEMENT
// ============================================================

/**
 * Enforce minimum video ratio for niches that need it.
 * News/military niches target 80-85% video. If AI picked too many images,
 * flip the least-important image scenes to video (skip person portraits, data charts).
 */
function _enforceVideoRatio(scenes, nicheId) {
    if (!nicheId) return;

    // Define target ratios per niche prefix
    let targetVideoRatio = null;
    if (nicheId.startsWith('news')) targetVideoRatio = 0.80;
    if (!targetVideoRatio) return;

    const totalScenes = scenes.filter(s => !s.fullscreenMG).length; // exclude fullscreen MGs
    if (totalScenes < 5) return;

    const videoCount = scenes.filter(s => !s.fullscreenMG && s.mediaType === 'video').length;
    const currentRatio = videoCount / totalScenes;

    if (currentRatio >= targetVideoRatio) return; // already meets target

    // How many image→video flips needed?
    const needed = Math.ceil(targetVideoRatio * totalScenes) - videoCount;

    // Rank image scenes by "flippability" — prefer generic scenes, avoid portraits/data
    const KEEP_AS_IMAGE = /portrait|headshot|chart|graph|data|diagram|infographic|photo of|face of/i;
    const imageScenes = scenes
        .filter(s => !s.fullscreenMG && s.mediaType === 'image' && !s._personLock)
        .map(s => ({
            scene: s,
            priority: KEEP_AS_IMAGE.test(s.keyword || '') ? 100 : (s.sourceHint === 'web-image' ? 2 : 1)
        }))
        .sort((a, b) => a.priority - b.priority); // lowest priority = flip first

    let flipped = 0;
    for (const { scene } of imageScenes) {
        if (flipped >= needed) break;
        scene.mediaType = 'video';
        if (scene.sourceHint === 'web-image') scene.sourceHint = 'stock';
        flipped++;
    }

    if (flipped > 0) {
        const newRatio = Math.round(((videoCount + flipped) / totalScenes) * 100);
        console.log(`   📊 Video ratio enforcement: flipped ${flipped} image→video (${Math.round(currentRatio * 100)}% → ${newRatio}% video) [target: ${Math.round(targetVideoRatio * 100)}%]`);
    }
}

// ============================================================
// SOURCE DIVERSITY ENFORCEMENT
// ============================================================

/**
 * Redistribute source hints when one video source dominates too heavily.
 * Ensures visual variety — different providers have different footage styles.
 *
 * Rules:
 * - No single video source should exceed 50% of video scenes
 * - Uses niche footagePriority to know which sources are available
 * - Only reassigns scenes where the source is interchangeable (not person photos, not maps)
 * - Prefers round-robin across top 3 niche sources
 */
// Words that describe ideas/editing/comparisons — they have no stock footage match.
// If the model emits any of these in a keyword, the scene was mis-planned: either the
// narration is metaphorical (→ should be MG/template, not footage) or the model copied
// narrator rhythm instead of picking a concrete shot.
const _BANNED_KEYWORD_TOKENS = [
    'montage', 'mechanism', 'inflation', 'dilemma', 'analogy', 'principle',
    'strategy', 'concept', 'symbolism', 'metaphor', 'paradigm', 'dichotomy',
    'framework', 'equilibrium', 'juxtaposition', 'interplay',
    'side-by-side', 'side by side',
    'breaking apart', 'falling apart', 'grid collapse', 'system breaking',
    'network grid', 'collapsing system'
];

// State+military-actor detector — these scenes must not hit stock.
const _NEWS_ACTORS_RE = /\b(iran|iranian|russia|russian|houthi|houthis|hamas|idf|nato|ukraine|ukrainian|israel|israeli|china|chinese|north korea|hezbollah|taliban|isis|isil|putin|netanyahu|zelensky|khamenei)\b/i;
const _MILITARY_VERBS_RE = /\b(navy|forces|strike|patrol|attack|invasion|missile|drone strike|blockade|sanctions|bombing|airstrike|troop|combat|military|warship|coastline|frontline)\b/i;

function _isAbstractKeyword(kw) {
    if (!kw) return null;
    const lower = kw.toLowerCase();
    for (const token of _BANNED_KEYWORD_TOKENS) {
        if (lower.includes(token)) return token;
    }
    return null;
}

function _countConcreteNouns(kw) {
    if (!kw) return 0;
    // Rough heuristic: words that aren't stop/filler words and aren't articles/conjunctions.
    const STOP = new Set(['the', 'a', 'an', 'and', 'or', 'of', 'in', 'on', 'at', 'to', 'for', 'with', 'by', 'from', 'over', 'under', 'through']);
    return kw.toLowerCase().split(/\s+/).filter(w => w && !STOP.has(w)).length;
}

/**
 * Post-AI keyword compliance. Three rules:
 *   1. Abstract tokens (montage, inflation, ...) → strip keyword, flip to fullscreenMG
 *      or rewrite from visualIntent if concrete fallback exists.
 *   2. News-actor + military verb → force sourceHint to telegram (never stock/pexels).
 *   3. sourceHint=stock AND noun-count > 3 → truncate via _autoStockQuery.
 *
 * Returns an array of { index, reason, before, after, sourceChange } for logging.
 */
function _enforceKeywordCompliance(scenes, scriptContext) {
    const violations = [];
    const { getNiche: _getNiche } = require('./niches');
    const niche = _getNiche(scriptContext.nicheId || 'general');
    const videoPriority = niche.footagePriority?.video || ['youtube', 'telegram', 'reddit'];

    for (const scene of scenes) {
        if (!scene.keyword || scene.keyword === 'none') continue;
        if (scene.fullscreenMG) continue; // already flipped to MG

        const before = scene.keyword;
        const text = String(scene.text || '');

        // Rule 1: abstract token
        const banned = _isAbstractKeyword(scene.keyword);
        if (banned) {
            // Try to rewrite from visualIntent (first 3 concrete nouns), else flip to
            // fullscreenMG focusWord using the most content-bearing word in the narration.
            const intentWords = String(scene.visualIntent || '')
                .toLowerCase().split(/\s+/)
                .filter(w => w && w.length > 3 && !_isAbstractKeyword(w))
                .slice(0, 3);
            if (intentWords.length >= 2) {
                scene.keyword = intentWords.join(' ');
                scene.stockQuery = _autoStockQuery(scene.keyword);
                scene.webQuery = _autoWebQuery(scene.keyword, scene.sourceHint);
                violations.push({ index: scene.index, reason: `banned token "${banned}"`, before, after: scene.keyword });
            } else {
                // No concrete fallback — flip to focusWord MG so scene still renders
                scene.fullscreenMG = `focusWord: ${text.split(/\s+/).slice(0, 4).join(' ')}`;
                scene.keyword = null;
                scene.sourceHint = null;
                violations.push({ index: scene.index, reason: `banned token "${banned}" (no concrete fallback)`, before, after: '→ fullscreenMG focusWord' });
                continue;
            }
        }

        // Rule 2: news-actor + military verb → force telegram
        if (scene.sourceHint === 'stock' || scene.sourceHint === 'pexels' || scene.sourceHint === 'pixabay') {
            if (_NEWS_ACTORS_RE.test(text) && _MILITARY_VERBS_RE.test(text)) {
                const oldSrc = scene.sourceHint;
                scene.sourceHint = videoPriority.includes('telegram') ? 'telegram' : videoPriority[0];
                violations.push({
                    index: scene.index,
                    reason: 'news-actor routed to stock',
                    before: scene.keyword,
                    after: scene.keyword,
                    sourceChange: `${oldSrc} → ${scene.sourceHint}`
                });
            }
        }

        // Rule 3: stock keyword noun cap (max 3)
        if (scene.sourceHint === 'stock' && _countConcreteNouns(scene.keyword) > 3) {
            const truncated = _autoStockQuery(scene.keyword);
            if (truncated && truncated !== scene.keyword) {
                violations.push({ index: scene.index, reason: `stock noun-cap (>3)`, before: scene.keyword, after: truncated });
                scene.keyword = truncated;
                scene.stockQuery = truncated;
            }
        }
    }
    return violations;
}

/**
 * Break long runs of adjacent typography fullscreenMGs (focusWord/kineticText).
 * Rule:
 *   - 2 adjacent scenes with same typography type → flip the 2nd to the other type.
 *   - 3 adjacent typography scenes (any mix) → flip the middle one to keyTakeaway
 *     template if the scene has narrative weight, otherwise alternate types.
 * Only touches scenes whose fullscreenMG starts with focusWord/kineticText — leaves
 * data MGs (barChart, timeline, mapChart) alone.
 */
function _dedupTypographyRuns(scenes) {
    const fixes = [];
    const typoType = (s) => {
        if (!s.fullscreenMG) return null;
        const m = String(s.fullscreenMG).match(/^(focusWord|kineticText)\s*:/i);
        return m ? m[1].toLowerCase() : null;
    };

    for (let i = 0; i < scenes.length; i++) {
        const curr = typoType(scenes[i]);
        if (!curr) continue;

        // Case 1: same type as previous scene → swap the CURRENT one to the other
        const prev = i > 0 ? typoType(scenes[i - 1]) : null;
        if (prev && prev === curr) {
            const other = curr === 'focusword' ? 'kineticText' : 'focusWord';
            const body = String(scenes[i].fullscreenMG).replace(/^[^:]+:/, '').trim();
            const before = scenes[i].fullscreenMG;
            scenes[i].fullscreenMG = `${other}: ${body}`;
            fixes.push({ index: scenes[i].index, before, after: scenes[i].fullscreenMG });
            continue;
        }

        // Case 2: three typography in a row → promote middle to keyTakeaway template
        const prev2 = i >= 2 ? typoType(scenes[i - 2]) : null;
        if (prev && prev2) {
            const mid = scenes[i - 1];
            if (!mid.templateHint) {
                const line = String(mid.text || '').split(/[.!?]/)[0].trim().slice(0, 90);
                if (line.length >= 8) {
                    const beforeMg = mid.fullscreenMG;
                    mid.templateHint = `keyTakeaway: ${line}`;
                    mid.fullscreenMG = null;
                    mid.keyword = mid.keyword || null;
                    fixes.push({ index: mid.index, before: beforeMg, after: `→ templateHint ${mid.templateHint}` });
                }
            }
        }
    }
    return fixes;
}

/**
 * Post-AI class/treatment validator.
 * When USE_SCENE_CLASSES attached sceneClass+treatmentHint per scene, rewrite
 * any scene whose chosen lane conflicts with its class treatment:
 *   - BLOCKED lane chosen → rewrite to PRIMARY lane
 *   - retrievability=internal-only with a keyword → strip keyword, flip to PRIMARY
 *   - fullscreenMG type not in allowedMGs → replace with first allowed MG
 *   - templateHint not in allowedTemplates → replace with first allowed template
 *
 * Returns array of { index, reason, before, after } for logging.
 */
function _enforceClassTreatment(scenes) {
    const fixes = [];
    for (const scene of scenes) {
        if (!scene.sceneClass || !scene.treatmentHint) continue;
        const t = scene.treatmentHint;
        const blocked = new Set(t.blocked || []);

        // Determine current lane
        let currentLane = null;
        if (scene.fullscreenMG) {
            const fsType = String(scene.fullscreenMG).split(':')[0].trim().toLowerCase();
            currentLane = fsType.startsWith('map') ? 'map' : 'graphics';
        } else if (scene.templateHint) {
            currentLane = 'template';
        } else if (scene.keyword && scene.keyword !== 'none') {
            currentLane = 'footage';
        }

        // Rule 1: internal-only classes must not hit external providers
        if (scene.retrievability === 'internal-only' && currentLane === 'footage') {
            const before = `keyword=${scene.keyword} source=${scene.sourceHint}`;
            scene.keyword    = null;
            scene.stockQuery = null;
            scene.webQuery   = null;
            scene.sourceHint = null;
            if (t.primary === 'template' && t.allowedTemplates.length) {
                const line = String(scene.text || '').split(/[.!?]/)[0].trim().slice(0, 80);
                scene.templateHint = `${t.allowedTemplates[0]}: ${line}`;
                currentLane = 'template';
            } else {
                const mg = (t.allowedMGs && t.allowedMGs[0]) || 'focusWord';
                const word = _pickFocusWord(scene.text);
                scene.fullscreenMG = `${mg}: ${word}`;
                currentLane = 'graphics';
            }
            fixes.push({ index: scene.index, reason: 'internal-only → strip footage', before, after: scene.fullscreenMG || scene.templateHint });
            continue;
        }

        // Rule 2: chose a blocked lane → swap to primary lane
        if (currentLane && blocked.has(currentLane)) {
            const before = `${currentLane}:${scene.fullscreenMG || scene.templateHint || scene.keyword}`;
            _coerceSceneToLane(scene, t.primary, t);
            fixes.push({ index: scene.index, reason: `blocked-lane ${currentLane} → primary ${t.primary}`, before, after: scene.fullscreenMG || scene.templateHint || scene.keyword });
            continue;
        }

        // Rule 3: MG type outside allowedMGs
        if (scene.fullscreenMG && t.allowedMGs && t.allowedMGs.length) {
            const fsType = String(scene.fullscreenMG).split(':')[0].trim();
            if (!t.allowedMGs.includes(fsType)) {
                const before = scene.fullscreenMG;
                const rest = String(scene.fullscreenMG).split(':').slice(1).join(':').trim() || _pickFocusWord(scene.text);
                scene.fullscreenMG = `${t.allowedMGs[0]}: ${rest}`;
                fixes.push({ index: scene.index, reason: `MG type not allowed for ${scene.sceneClass}`, before, after: scene.fullscreenMG });
            }
        }

        // Rule 4: templateHint outside allowedTemplates
        if (scene.templateHint && t.allowedTemplates && t.allowedTemplates.length) {
            const tType = String(scene.templateHint).split(':')[0].trim();
            if (!t.allowedTemplates.includes(tType)) {
                const before = scene.templateHint;
                const rest = String(scene.templateHint).split(':').slice(1).join(':').trim() || String(scene.text || '').slice(0, 80);
                scene.templateHint = `${t.allowedTemplates[0]}: ${rest}`;
                fixes.push({ index: scene.index, reason: `template type not allowed for ${scene.sceneClass}`, before, after: scene.templateHint });
            }
        }

        // Rule 5: footage scene should match preferredSource when AI ignored it
        if (currentLane === 'footage' && t.preferredSource && scene.sourceHint && scene.sourceHint !== t.preferredSource) {
            // Only override when source is clearly weaker (stock on news-actor etc.)
            if (t.preferredSource === 'telegram' && (scene.sourceHint === 'stock' || scene.sourceHint === 'pexels' || scene.sourceHint === 'pixabay')) {
                const before = scene.sourceHint;
                scene.sourceHint = t.preferredSource;
                fixes.push({ index: scene.index, reason: `source ${before} → preferred ${t.preferredSource}`, before, after: t.preferredSource });
            }
        }
    }
    return fixes;
}

function _pickFocusWord(text) {
    const t = String(text || '');
    const words = t.match(/\b[A-Za-z]{4,}\b/g) || [];
    for (const w of words) {
        if (!_isAbstractKeyword(w)) return w.toLowerCase();
    }
    return (words[0] || 'focus').toLowerCase();
}

function _coerceSceneToLane(scene, lane, treatment) {
    // Clear existing lane markers
    if (lane !== 'footage')  { scene.keyword = null; scene.stockQuery = null; scene.webQuery = null; }
    if (lane !== 'graphics' && lane !== 'map') scene.fullscreenMG = null;
    if (lane !== 'template') scene.templateHint = null;

    const line = String(scene.text || '').split(/[.!?]/)[0].trim().slice(0, 80);
    if (lane === 'footage') {
        scene.keyword    = scene.keyword || _pickFocusWord(scene.text);
        scene.sourceHint = treatment.preferredSource || scene.sourceHint || 'stock';
        scene.mediaType  = scene.mediaType || 'video';
    } else if (lane === 'map') {
        if (treatment.allowedMGs && treatment.allowedMGs.includes('mapChart')) {
            scene.fullscreenMG = scene.fullscreenMG || 'mapChart: locator';
        } else {
            const mg = (treatment.allowedMGs && treatment.allowedMGs[0]) || 'focusWord';
            scene.fullscreenMG = `${mg}: ${_pickFocusWord(scene.text)}`;
        }
    } else if (lane === 'graphics') {
        const mg = (treatment.allowedMGs && treatment.allowedMGs[0]) || 'focusWord';
        scene.fullscreenMG = `${mg}: ${_pickFocusWord(scene.text)}`;
    } else if (lane === 'template') {
        const tpl = (treatment.allowedTemplates && treatment.allowedTemplates[0]) || 'factCard';
        scene.templateHint = `${tpl}: ${line}`;
    }
}

function _enforceSourceDiversity(scenes, nicheId) {
    const { getNiche: _getNiche } = require('./niches');
    const niche = _getNiche(nicheId || 'general');
    const videoPriority = niche.footagePriority?.video || ['youtube', 'telegram', 'reddit', 'pexels', 'pixabay'];

    // Only consider video scenes with swappable sources
    const LOCKED_HINTS = new Set(['web-image']); // web-image = specific photos, don't touch
    const videoScenes = scenes.filter(s =>
        s.mediaType === 'video' && !s.fullscreenMG && !LOCKED_HINTS.has(s.sourceHint)
    );

    if (videoScenes.length < 6) return; // too few to care about diversity

    // Count source distribution
    const counts = {};
    for (const s of videoScenes) {
        const src = s.sourceHint || 'stock';
        counts[src] = (counts[src] || 0) + 1;
    }

    // Find dominant source
    const maxAllowed = Math.ceil(videoScenes.length * 0.50); // no source should exceed 50%
    let dominant = null;
    let dominantCount = 0;
    for (const [src, count] of Object.entries(counts)) {
        if (count > maxAllowed && count > dominantCount) {
            dominant = src;
            dominantCount = count;
        }
    }

    if (!dominant) return; // distribution is fine

    // How many to reassign from the dominant source
    const excess = dominantCount - maxAllowed;

    // Pick alternative sources from niche priority (skip the dominant one)
    const alternatives = videoPriority.filter(s => s !== dominant && s !== 'pexels' && s !== 'pixabay');
    if (alternatives.length === 0) return;

    // Scenes eligible for reassignment: dominant source, not hook/CTA, not person-specific
    const PERSON_KW = /portrait|headshot|photo of|face of|mugshot/i;
    const eligible = videoScenes.filter(s =>
        (s.sourceHint || 'stock') === dominant &&
        s.sceneType !== 'hook' && s.sceneType !== 'cta' &&
        !PERSON_KW.test(s.keyword || '')
    );

    // Round-robin reassign from the middle of the video (keep first/last scenes stable)
    // Sort by scene index, skip first 2 and last 2
    eligible.sort((a, b) => (a.index || 0) - (b.index || 0));
    const reassignable = eligible.length > 4
        ? eligible.slice(2, -2)  // skip first 2 and last 2
        : eligible.slice(1);     // at least skip the first

    let reassigned = 0;
    for (let i = 0; i < reassignable.length && reassigned < excess; i++) {
        const scene = reassignable[i];
        const newSource = alternatives[reassigned % alternatives.length];
        const oldSource = scene.sourceHint;
        scene.sourceHint = newSource;
        reassigned++;
    }

    if (reassigned > 0) {
        // Recount for logging
        const newCounts = {};
        for (const s of videoScenes) {
            const src = s.sourceHint || 'stock';
            newCounts[src] = (newCounts[src] || 0) + 1;
        }
        const distStr = Object.entries(newCounts).map(([k, v]) => `${k}:${v}`).join(', ');
        console.log(`   🔀 Source diversity: ${dominant} was ${dominantCount}/${videoScenes.length} (${Math.round(dominantCount / videoScenes.length * 100)}%) — redistributed ${reassigned} scenes → [${distStr}]`);
    }
}

// ============================================================
// KEYWORD QUALITY VALIDATOR
// ============================================================

// Words that signal abstract/metaphorical/unsearchable keywords
const ABSTRACT_WORDS = new Set([
    'analogy', 'metaphor', 'concept', 'principle', 'philosophy', 'theory',
    'dilemma', 'paradox', 'irony', 'symbolism', 'allegory', 'notion',
    'abstraction', 'essence', 'elegance', 'implications', 'perspective',
    'dynamics', 'paradigm', 'framework', 'methodology', 'rationale',
    'simulation', 'visualization', 'conceptual', 'hypothetical',
    'anchor', 'intro', 'outro', 'cta', 'transition', 'statement',
    'comparison', 'contrast', 'overview', 'summary', 'recap',
]);

// Phrases that are unsearchable (no real footage exists)
const ABSTRACT_PHRASES = [
    /\b(sun tzu|art of war)\b/i,
    /\b(no[- ]win|win[- ]win)\b/i,
    /\blighthouse\s+emission\b/i,
    /\bpaper\s+(defense|strategy|plan)\b/i,
    /\b(physics|math)\s+(trap|trick|principle)\b/i,
    /\b(cost|price)\s+exchange\b/i,
    /\b(channel|subscribe|like|comment)\s+(comparison|intro|outro|cta)\b/i,
];

/**
 * Extract a concrete keyword from scene text by picking the most visual nouns.
 * Used as fallback when the AI-generated keyword is abstract/unsearchable.
 */
function _extractConcreteKeyword(text, entities) {
    if (!text) return null;

    // If scene mentions entities, use the first entity + context
    if (entities && entities.length > 0) {
        // Find which entity appears in this scene's text
        for (const entity of entities) {
            if (text.toLowerCase().includes(entity.toLowerCase())) {
                return entity;
            }
        }
    }

    // Extract noun phrases — prefer capitalized words (proper nouns), military/tech terms
    const CONCRETE_PATTERNS = [
        // Specific equipment/systems: "F-35C", "Bavar-373", "S-300"
        /\b[A-Z][\w-]*[-]\d+\w*\b/g,
        // Proper nouns (2+ capitalized words): "Cyber Command", "Persian Gulf"
        /\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g,
        // Single proper nouns: "Iran", "Pentagon", "Tomahawk"
        /\b[A-Z][a-z]{3,}\b/g,
    ];

    const found = [];
    for (const pattern of CONCRETE_PATTERNS) {
        const matches = text.match(pattern);
        if (matches) {
            for (const m of matches) {
                // Skip common words that happen to be capitalized (start of sentence)
                const lower = m.toLowerCase();
                if (['the', 'this', 'that', 'when', 'what', 'here', 'there', 'every',
                     'because', 'before', 'after', 'while', 'other', 'something',
                     'nothing', 'everything', 'imagine', 'reverse', 'respect',
                     'not', 'but', 'and', 'start', 'now'].includes(lower)) continue;
                found.push(m);
            }
        }
        if (found.length >= 3) break;
    }

    if (found.length === 0) return null;

    // Take up to 3 unique terms
    const unique = [...new Set(found)].slice(0, 3);
    return unique.join(' ');
}

/**
 * Validate and fix abstract/unsearchable keywords.
 * Runs after AI response is parsed — no extra AI calls needed.
 */
function _validateKeywords(scenes, scriptContext) {
    let fixed = 0;

    for (const scene of scenes) {
        if (!scene.keyword || scene.fullscreenMG) continue;

        const keyword = scene.keyword.toLowerCase();
        const words = keyword.split(/\s+/);

        // Check 1: keyword contains abstract words
        const hasAbstract = words.some(w => ABSTRACT_WORDS.has(w));

        // Check 2: keyword matches abstract phrase patterns
        const hasAbstractPhrase = ABSTRACT_PHRASES.some(re => re.test(keyword));

        // Check 3: keyword has no concrete nouns (all generic/filler words)
        const FILLER_WORDS = new Set([
            'the', 'a', 'an', 'of', 'in', 'on', 'at', 'to', 'for', 'by', 'with',
            'and', 'or', 'but', 'not', 'no', 'is', 'was', 'are', 'were', 'be',
            'this', 'that', 'how', 'why', 'what', 'when', 'where', 'who',
            'new', 'old', 'modern', 'real', 'simple', 'complex',
        ]);
        const meaningfulWords = words.filter(w => w.length > 2 && !FILLER_WORDS.has(w));
        const allAbstract = meaningfulWords.length > 0 && meaningfulWords.every(w => ABSTRACT_WORDS.has(w));

        if (hasAbstract || hasAbstractPhrase || allAbstract) {
            // Build reason string for logging
            const reasons = [];
            if (hasAbstract) reasons.push(`word: "${words.find(w => ABSTRACT_WORDS.has(w))}"`);
            if (hasAbstractPhrase) reasons.push('abstract phrase');
            if (allAbstract) reasons.push('all abstract');

            const replacement = _extractConcreteKeyword(
                scene.text,
                scriptContext?.entities
            );

            if (replacement && replacement !== scene.keyword) {
                const old = scene.keyword;
                scene.keyword = replacement;
                // Also regenerate stockQuery and webQuery
                const oldStock = scene.stockQuery;
                const oldWeb = scene.webQuery;
                scene.stockQuery = _autoStockQuery(replacement);
                scene.webQuery = _autoWebQuery(replacement, scene.sourceHint);
                console.log(`   🔧 Scene ${scene.index}: keyword "${old}" → "${replacement}" [${reasons.join(', ')}]`);
                console.log(`      stock: "${oldStock || ''}" → "${scene.stockQuery}" | web: "${oldWeb || ''}" → "${scene.webQuery}"`);
                fixed++;
            } else {
                console.log(`   ⚠️ Scene ${scene.index}: abstract keyword "${scene.keyword}" [${reasons.join(', ')}] — no concrete replacement found`);
            }
        }
    }

    if (fixed > 0) {
        console.log(`   📝 Fixed ${fixed} abstract keyword(s)`);
    }
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

/**
 * Plan visuals for ALL scenes in one batch AI call.
 * Uses scriptContext from ai-director.js for intelligent planning.
 *
 * @param {Array} scenes - Scenes from ai-director.js
 * @param {Object} scriptContext - Director's analysis
 * @param {Object} directorsBrief - Quality tier, format, audience
 * @returns {Promise<Array>} Enriched scenes with visual planning
 */
async function planVisuals(scenes, scriptContext, directorsBrief) {
    console.log(`\n🎨 Visual Planner — Step 4`);
    console.log(`📡 Provider: ${config.aiProvider.toUpperCase()}`);
    console.log(`🎬 Planning visuals for ${scenes.length} scenes`);
    console.log(`🧠 Using director's context: theme=${scriptContext.theme}, mood=${scriptContext.mood}, pacing=${scriptContext.pacing}, niche=${scriptContext.nicheId || 'general'}`);
    try {
        const { getAIThinking } = require('./ai-provider');
        const t = getAIThinking();
        const provider = (config.aiProvider || 'ollama').toLowerCase();
        const geminiModel = provider === 'gemini' ? (config.gemini?.model || process.env.GEMINI_MODEL || 'gemini') : '';
        console.log(`   🧠 [Step 4 Planner] provider=${provider}${geminiModel ? ` model=${geminiModel}` : ''} thinking=${t.mode} budget=${t.budget}`);
    } catch (_) { /* diagnostic-only, never fail the build */ }
    console.log('');
    const plannerDirectives = _buildPlannerDirectives(scenes, scriptContext, directorsBrief);

    // Auto-chunk based on provider and scene count
    // Ollama: 8 scenes per batch (local model limits)
    // Cloud APIs: 15 scenes per batch (prevents token truncation on tail scenes)
    const isOllama = (config.aiProvider || 'ollama') === 'ollama';
    const CHUNK_SIZE = isOllama ? 8 : 15;
    let globalOutline = null;

    if (scenes.length > CHUNK_SIZE) {
        try {
            globalOutline = await _generateGlobalVisualOutline(scenes, scriptContext, directorsBrief, plannerDirectives);
        } catch (outlineError) {
            console.log(`   ⚠️ [Step 4 Outline] failed: ${outlineError.message} — continuing with chunk-local planning`);
        }
        return await _planVisualsChunked(scenes, scriptContext, directorsBrief, CHUNK_SIZE, plannerDirectives, globalOutline);
    }

    try {
            const prompt = buildBatchPrompt(scenes, scriptContext, directorsBrief, { plannerDirectives, globalOutline });

        // Batch call for ALL scenes — ~150 tokens per scene (keyword + stockQuery + webQuery + intent)
        const maxTokens = Math.max(1000, scenes.length * 200);
        const rawText = await callAI(prompt, { maxTokens });

        if (!rawText) throw new Error('Empty AI response');

        console.log(`   [AI Response Preview]:\n${rawText.substring(0, 400)}${rawText.length > 400 ? '...' : ''}\n`);

        const enrichedScenes = _finalizeVisualPlan(
            parseBatchResponse(rawText, scenes, scriptContext.nicheId, scriptContext.themeId, scriptContext, plannerDirectives),
            scriptContext,
            directorsBrief,
            plannerDirectives
        );

        // Log results
        const fsMGCount = enrichedScenes.filter(s => s.fullscreenMG).length;
        const tplCount = enrichedScenes.filter(s => s.templateHint && !s.fullscreenMG).length;
        const overlayMGCount = enrichedScenes.filter(s => s.mgHint && !s.fullscreenMG && !s.templateHint).length;
        const footageCount = enrichedScenes.length - fsMGCount;
        const plainFootage = enrichedScenes.length - fsMGCount - tplCount - overlayMGCount;
        console.log(`   ✅ Visual plan created for ${enrichedScenes.length} scenes (${footageCount} footage + ${fsMGCount} fullscreen MG):`);
        console.log(`      📊 Breakdown: fs=${fsMGCount}  template=${tplCount}  overlay=${overlayMGCount}  plain-footage=${plainFootage}\n`);
        for (const scene of enrichedScenes.slice(0, 5)) { // Show first 5
            if (scene.fullscreenMG) {
                console.log(`      Scene ${scene.index}: 🎨 [FULLSCREEN MG] ${scene.fullscreenMG}`);
            } else if (scene.templateHint) {
                const kw = scene.keyword ? ` [bg: "${scene.keyword}"]` : '';
                console.log(`      Scene ${scene.index}: 📇 [TEMPLATE HINT] ${scene.templateHint}${kw}`);
            } else {
                const sq = scene.stockQuery ? ` stock:"${scene.stockQuery}"` : '';
                const wq = scene.webQuery ? ` web:"${scene.webQuery}"` : '';
                const fx = scene.effectPreset && scene.effectPreset !== 'none' ? ` fx:${scene.effectPreset}` : (scene.effects && scene.effects.length ? ` fx:[${scene.effects.join(',')}]` : '');
                const mg = scene.mgHint ? ` 🪧 mg:"${scene.mgHint}"` : '';
                console.log(`      Scene ${scene.index}: "${scene.keyword}" [${scene.mediaType}, ${scene.sourceHint}]${sq}${wq}${fx}${mg}`);
            }
        }
        if (enrichedScenes.length > 5) {
            console.log(`      ... and ${enrichedScenes.length - 5} more scenes`);
        }
        console.log('');

        return enrichedScenes;

    } catch (error) {
        console.log(`   ❌ Batch visual planning failed: ${error.message}`);
        console.log('   ↩️ Falling back to per-scene planning...\n');

        // Fallback: Plan each scene individually
        return await planVisualsPerScene(scenes, scriptContext, directorsBrief, globalOutline);
    }
}

/**
 * Chunked batch planning — splits scenes into smaller groups
 * to prevent timeout on large scripts. Works for all providers.
 */
async function _planVisualsChunked(scenes, scriptContext, directorsBrief, chunkSize, plannerDirectives = null, globalOutline = null) {
    plannerDirectives = plannerDirectives || _buildPlannerDirectives(scenes, scriptContext, directorsBrief);
    const chunks = [];
    for (let i = 0; i < scenes.length; i += chunkSize) {
        chunks.push(scenes.slice(i, i + chunkSize));
    }

    console.log(`   🔀 Splitting ${scenes.length} scenes into ${chunks.length} batches of ~${chunkSize}`);
    if (scriptContext.webContext) {
        console.log(`   🌐 Web research context will be injected into each batch`);
    }
    if (scriptContext.summary) {
        console.log(`   📝 Topic summary will anchor each batch`);
    }
    console.log('');

    const allEnriched = [];
    const usedKeywords = []; // Track keywords across chunks to prevent repeats

    for (let c = 0; c < chunks.length; c++) {
        const chunk = chunks[c];
        console.log(`   📦 Batch ${c + 1}/${chunks.length} (scenes ${chunk[0].index}-${chunk[chunk.length - 1].index})...`);
        if (globalOutline) {
            const hinted = chunk.filter(scene => globalOutline.sceneHints[scene.index]).length;
            const seamIds = [chunk[0].index - 2, chunk[0].index - 1, chunk[chunk.length - 1].index + 1, chunk[chunk.length - 1].index + 2];
            const seamCount = seamIds.filter(idx => !!globalOutline.sceneHints[idx]).length;
            console.log(`      🧭 Outline aware: ${hinted}/${chunk.length} scene hints + ${seamCount} seam cues`);
        }

        try {
            const prompt = buildBatchPrompt(chunk, scriptContext, directorsBrief, {
                previousKeywords: usedKeywords,
                plannerDirectives,
                globalOutline,
            });
            const maxTokens = Math.max(1000, chunk.length * 150);
            const rawText = await callAI(prompt, { maxTokens });

            if (!rawText) throw new Error('Empty AI response');

            const enriched = parseBatchResponse(rawText, chunk, scriptContext.nicheId, scriptContext.themeId, scriptContext, plannerDirectives);
            allEnriched.push(...enriched);

            // Collect keywords for next chunk's awareness
            for (const scene of enriched) {
                if (scene.keyword) usedKeywords.push(scene.keyword);
            }

            const batchFs = enriched.filter(s => s.fullscreenMG).length;
            const batchTpl = enriched.filter(s => s.templateHint && !s.fullscreenMG).length;
            const batchOverlay = enriched.filter(s => s.mgHint && !s.fullscreenMG && !s.templateHint).length;
            const batchPlain = enriched.length - batchFs - batchTpl - batchOverlay;
            console.log(`      📊 Batch ${c + 1} breakdown: fs=${batchFs}  template=${batchTpl}  overlay=${batchOverlay}  plain-footage=${batchPlain}`);
            for (const scene of enriched) {
                if (scene.fullscreenMG) {
                    console.log(`      Scene ${scene.index}: 🎨 [FULLSCREEN MG] ${scene.fullscreenMG}`);
                } else if (scene.templateHint) {
                    const kw = scene.keyword ? ` [bg: "${scene.keyword}"]` : '';
                    console.log(`      Scene ${scene.index}: 📇 [TEMPLATE HINT] ${scene.templateHint}${kw}`);
                } else {
                    const mg = scene.mgHint ? ` 🪧 mg:"${scene.mgHint}"` : '';
                    console.log(`      Scene ${scene.index}: "${scene.keyword}" [${scene.mediaType}, ${scene.sourceHint}]${mg}`);
                }
            }
        } catch (error) {
            console.log(`      ⚠️ Batch ${c + 1} failed: ${error.message}, falling back to per-scene...`);
            // Fallback: do this chunk's scenes one by one
            const nicheId = scriptContext.nicheId || '';
            for (const scene of chunk) {
                try {
                    const prompt = buildSingleScenePrompt(scene, chunk, scriptContext, directorsBrief, plannerDirectives, globalOutline);
                    const rawText = await callAI(prompt, { maxTokens: 100 });
                    const parsed = parseSingleSceneResponse(rawText, scene, scriptContext, directorsBrief, plannerDirectives);
                    allEnriched.push(parsed);
                    if (parsed.fullscreenMG) {
                        console.log(`      Scene ${scene.index}: 🎨 [FULLSCREEN MG] ${parsed.fullscreenMG}`);
                    } else if (parsed.templateHint) {
                        const kw = parsed.keyword ? ` [bg: "${parsed.keyword}"]` : '';
                        console.log(`      Scene ${scene.index}: 📇 [TEMPLATE HINT] ${parsed.templateHint}${kw}`);
                    } else {
                        const mg = parsed.mgHint ? ` 🪧 mg:"${parsed.mgHint}"` : '';
                        console.log(`      Scene ${scene.index}: "${parsed.keyword}" [${parsed.mediaType}, ${parsed.sourceHint}]${mg}`);
                    }
                } catch (err) {
                    const fallbackHint = nicheId.startsWith('news') ? 'telegram' : 'stock';
                    allEnriched.push({
                        ...scene,
                        keyword: extractFallbackKeyword(scene.text),
                        mediaType: 'video',
                        sourceHint: fallbackHint,
                        visualIntent: scene.text,
                        effects: [],
                        mgHint: null
                    });
                    console.log(`      Scene ${scene.index}: fallback keyword`);
                }
            }
        }
    }

    const finalized = _finalizeVisualPlan(allEnriched, scriptContext, directorsBrief, plannerDirectives);
    const totalFs = finalized.filter(s => s.fullscreenMG).length;
    const totalTpl = finalized.filter(s => s.templateHint && !s.fullscreenMG).length;
    const totalOverlay = finalized.filter(s => s.mgHint && !s.fullscreenMG && !s.templateHint).length;
    const totalPlain = finalized.length - totalFs - totalTpl - totalOverlay;
    console.log(`\n   ✅ Visual plan created for ${finalized.length} scenes`);
    console.log(`      📊 TOTAL breakdown: fs=${totalFs}  template=${totalTpl}  overlay=${totalOverlay}  plain-footage=${totalPlain}\n`);
    return finalized;
}

// ============================================================
// FALLBACK: PER-SCENE PLANNING
// ============================================================

/**
 * Fallback to old per-scene approach if batch fails.
 * Still uses scriptContext for smarter decisions than old ai-keywords.js.
 */
async function planVisualsPerScene(scenes, scriptContext, directorsBrief, globalOutline = null) {
    const plannerDirectives = _buildPlannerDirectives(scenes, scriptContext, directorsBrief);
    const enrichedScenes = [];

    for (const scene of scenes) {
        const prompt = buildSingleScenePrompt(scene, scenes, scriptContext, directorsBrief, plannerDirectives, globalOutline);

        const nicheId = scriptContext.nicheId || '';
        try {
            const rawText = await callAI(prompt, { maxTokens: 100 });
            const parsed = parseSingleSceneResponse(rawText, scene, scriptContext, directorsBrief, plannerDirectives);
            enrichedScenes.push(parsed);
            console.log(`   Scene ${scene.index}: "${parsed.keyword}" [${parsed.mediaType}, ${parsed.sourceHint}]`);
        } catch (error) {
            // Ultimate fallback: extract from text
            const fallbackHint = nicheId.startsWith('news') ? 'telegram' : 'stock';
            enrichedScenes.push({
                ...scene,
                keyword: extractFallbackKeyword(scene.text),
                mediaType: 'video',
                sourceHint: fallbackHint,
                visualIntent: scene.text,
                effects: [],
                mgHint: null
            });
            console.log(`   Scene ${scene.index}: fallback keyword`);
        }
    }

    console.log('');
    return _finalizeVisualPlan(enrichedScenes, scriptContext, directorsBrief, plannerDirectives);
}

/**
 * Build prompt for a single scene (fallback mode).
 */
function buildSingleScenePrompt(scene, allScenes, scriptContext, directorsBrief, plannerDirectives = null, globalOutline = null) {
    const { theme, mood, entities } = scriptContext;
    const { tier } = directorsBrief;
    const nicheId = scriptContext.nicheId || 'general';
    const { getNiche } = require('./niches');
    const niche = getNiche(nicheId);
    const videoPriority = niche.footagePriority?.video || ['youtube', 'telegram', 'vkVideo', 'reddit', 'pexels', 'pixabay'];
    plannerDirectives = plannerDirectives || _buildPlannerDirectives(allScenes || [scene], scriptContext, directorsBrief);
    const sceneTags = _sceneTagString(scene, allScenes || [scene], scriptContext);
    const outlineBlock = _renderGlobalOutlineBlock(globalOutline, [scene]);

    return `You are planning B-ROLL for a ${theme || 'general'} video with ${mood || 'neutral'} mood.

SCENE ${scene.index} [${sceneTags}]
SCENE TEXT: "${scene.text}"
${entities.length > 0 ? `KEY ENTITIES: ${entities.join(', ')}` : ''}
TOPIC SUMMARY: ${scriptContext.summary || 'none'}
EVENT ANCHOR: ${scriptContext.eventAnchor || 'none'}
${_renderPlannerDirectiveBlock(plannerDirectives, scriptContext)}
${outlineBlock}

AVAILABLE SOURCES (priority order for this ${niche.name} niche): ${videoPriority.join(' → ')}
Pick sourceHint from these. Top sources are BEST for this niche.

OUTPUT FORMAT (one line):
SCENE ${scene.index}: keyword: <searchable keyword or none> | stockQuery: <query or none> | webQuery: <query or none> | mediaType: <${tier.allowVideo ? 'video|image' : 'image'}> | sourceHint: <stock|youtube|web-image|telegram|reddit> | framing: <fullscreen|cinematic|floating> | backgroundId: <none|blur|gradient-id> | floatingAnim: <slideRight|slideLeft|slideUp|fadeScale|none> | floatingShadow: <0.3|0.5|0.7|none> | visualIntent: <shot description> | effects: <presetName or none> | mgHint: <overlay type: desc or none> | fullscreenMG: <fullscreen type: data or none> | templateHint: <template type: content or none>`;
}

/**
 * Parse single scene response.
 */
function parseSingleSceneResponse(rawText, scene, scriptContext, directorsBrief, plannerDirectives = null) {
    const normalized = /scene\s+\d+/i.test(rawText)
        ? rawText
        : `SCENE ${scene.index}: ${rawText.trim()}`;
    return parseBatchResponse(
        normalized,
        [scene],
        scriptContext.nicheId,
        scriptContext.themeId,
        scriptContext,
        plannerDirectives
    )[0];
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    planVisuals,
    buildBatchPrompt,
    parseBatchResponse,
    extractFallbackKeyword
};
