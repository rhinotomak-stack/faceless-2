// Map Assignment Layer — Slice 1 of the map-system rebuild.
//
// Deterministic (no AI) per-scene decision: should this scene become a map?
//
// Produces a disposition for every scene BEFORE the Visual Planner runs so
// the planner can honor a hard gate: must_not_map scenes never receive a
// mapChart fullscreenMG, and must_map scenes are upgraded to mapChart even
// if the AI picked something weaker. Output is advisory input for VP +
// (later slices) the MapCompiler.
//
// Decisions come from:
//   • spatial verb patterns in scene text  ("through the strait of",
//     "across Europe", "from X to Y", "bordering", "located in")
//   • named-place presence (scriptContext.entities + entityTypes)
//   • zone (hook / body / cta)  — CTA is rarely a map
//   • abstract markers          — "imagine", "what if", quoted dialogue,
//                                 inner monologue, metaphor language
//   • niche mapPolicy baseline  — some niches map freely, others never
//
// This module NEVER calls AI. It is fast, pure, and deterministic.

const SPATIAL_VERB_PATTERNS = [
    /\b(through|across|along|into|out of|between|beyond|past)\b\s+(the\s+)?[A-Z]/,
    /\bfrom\s+[A-Z][A-Za-z\- ]{2,30}\s+(to|toward|towards)\s+[A-Z]/,
    /\b(borders?|bordering|located|situated|lies|lying|sits|sat|sitting)\s+(in|on|at|along|between|near|next to|beside)\b/i,
    /\b(stretch(es|ed|ing)?|span(s|ned|ning)?|run(s|ning)?|flows?|cross(es|ed|ing)?)\s+(across|from|between|through|along)\b/i,
    /\b(route|corridor|passage|strait|channel|border|frontier|coastline|shoreline)\b/i,
    /\b(north|south|east|west|northern|southern|eastern|western)\s+(of|coast|border|part|region|tip|edge)\b/i,
    /\b(heads?|head(ed|ing)|travell?(ed|ing)?|sail(ed|ing)?|mov(e|ed|ing)|push(ed|ing)?|advanc(e|ed|ing))\s+(into|toward|towards|through|across|along|from)\b/i,
    // Relational verbs that define a between-relationship: "Bab-el-Mandeb
    // separates Yemen and Djibouti", "Gibraltar divides Europe from Africa",
    // "Panama Canal joins the Atlantic and Pacific". These map as region
    // highlights (held-wide showing all parties), not locator tours — missing
    // them caused "separates Yemen and Djibouti" to render as a sequential pan.
    /\b(separat(es|ed|ing)|divid(es|ed|ing)|split(s|ting)|flank(s|ed|ing)|connect(s|ed|ing)|link(s|ed|ing)|join(s|ed|ing)|face(s|d|ing)?|meet(s|ing))\s+(?:the\s+)?[A-Z]/,
];

const BROAD_ROUTE_REGION_RE = /^(asia|europe|africa|eurasia|middle east|north africa|east asia|southeast asia|south asia|western europe|eastern europe)$/i;
const TRADE_CORRIDOR_TEXT_RE = /\b(container|shipping|ship|ships|vessel|vessels|cargo|freight|trade|traffic|supply\s+chains?|maritime|route|routes|corridor|corridors|gateway|flows?|moves?|travels?|traveling)\b/i;

const ABSTRACT_MARKERS = [
    /\b(imagine|what if|suppose|consider|picture this|think about|let's say)\b/i,
    /\b(means?|meaning|metaphor|represent(s|ed|ing)?|symboliz(e|es|ed|ing))\b/i,
    /\b(feel(s|ing)?|felt|believ(e|ed|ing)|hop(e|ed|ing)|dream(ed|ing|s)?|fear(ed|ing|s)?)\b/i,
    /^".*"$/,                                                 // whole scene is a quoted line
    /\b(like comments? below|subscribe|hit the bell|click|share this|watch|stay tuned)\b/i,
    /\b(today we|in this video|we'll explore|coming up|next time)\b/i,
];

// Niche baseline — what does this niche prefer when the signals are ambiguous?
// The deterministic Map Assignment pass is intentionally limited to the niches
// that benefit from maps as a primary visual language: politics, military,
// history, and nature.
const NICHE_BASELINE = {
    'news.politics':       { baseline: 'can_map', budget: 6 },
    'news.military':       { baseline: 'can_map', budget: 6 },
    'news.economy':        { baseline: 'can_map', budget: 4 },
    'news.tech':           { baseline: 'must_not_map', budget: 2 },
    'news.celebrity':      { baseline: 'must_not_map', budget: 1 },
    'news.sport':          { baseline: 'must_not_map', budget: 1 },
    'explainer.politics':  { baseline: 'can_map', budget: 6 },
    'explainer.military':  { baseline: 'can_map', budget: 6 },
    'explainer.history':   { baseline: 'can_map', budget: 5 },
    'explainer.nature':    { baseline: 'can_map', budget: 4 },
    'explainer.crime':     { baseline: 'can_map', budget: 3 },
    'explainer.business':  { baseline: 'can_map', budget: 3 },
    'explainer.tech':      { baseline: 'must_not_map', budget: 2 },
    'explainer.luxury':    { baseline: 'must_not_map', budget: 1 },
    'explainer.sport':     { baseline: 'must_not_map', budget: 1 },
    'explainer.motivation':{ baseline: 'must_not_map', budget: 0 },
    'explainer.food':      { baseline: 'must_not_map', budget: 1 },
    'explainer.diy':       { baseline: 'must_not_map', budget: 0 },
};

const MAP_ASSIGNMENT_NICHES = new Set([
    'news.politics',
    'news.military',
    'explainer.politics',
    'explainer.military',
    'explainer.history',
    'explainer.nature',
]);

// Global hard cap on fullscreen mapCharts per video, regardless of niche
// budget. Stops geography-heavy niches (politics, military, history) from
// stacking 5-6 fullscreen maps which the post-build reviewer correctly flags
// as overuse. Env-overridable for one-off long-form videos.
const MAX_FULLSCREEN_MAPS_PER_VIDEO = Math.max(1, Math.min(8, parseInt(process.env.MAX_FULLSCREEN_MAPS_PER_VIDEO || '3', 10) || 3));

function _getNicheBaseline(nicheId) {
    const entry = NICHE_BASELINE[nicheId] || { baseline: 'can_map', budget: 3 };
    return { baseline: entry.baseline, budget: Math.min(entry.budget, MAX_FULLSCREEN_MAPS_PER_VIDEO) };
}

// Hard niche allowlist for the Map Assignment step itself. Anything outside
// this list short-circuits to an empty disposition array — no per-scene
// scoring, no log spam.
function _nicheIsMapEligible(nicheId) {
    if (!nicheId || typeof nicheId !== 'string') return false;
    return MAP_ASSIGNMENT_NICHES.has(nicheId);
}

function _nicheAllowsMapChart(scriptContext, nicheCfg = null) {
    const nicheId = scriptContext?.nicheId || 'general';
    const cfg = nicheCfg || (() => {
        try {
            const { getNiche } = require('../data/niches');
            return getNiche(nicheId);
        } catch (err) {
            return null;
        }
    })();
    const allowedMGs = Array.isArray(cfg?.allowedMGs) ? cfg.allowedMGs : [];
    if (allowedMGs.length === 0) return true;
    return allowedMGs.includes('mapChart');
}

// Return the place entities that actually appear in the scene text, in
// document order of the text (so the first-mentioned place is first). Keeps
// the original casing from the entity list so downstream map parsers can
// geocode "Bab-el-Mandeb" — not "bab-el-mandeb".
function _findPlacesInText(text, entities) {
    if (!text) return [];
    const lower = text.toLowerCase();
    const hits = [];
    for (const e of (entities || [])) {
        if (!e || e.length < 3) continue;
        const idx = lower.indexOf(e.toLowerCase());
        if (idx >= 0) hits.push({ name: e, idx });
    }
    const regexPlaces = [
        ['Strait of Hormuz', /\bstrait\s+of\s+hormuz\b/i],
        ['Persian Gulf', /\bpersian\s+gulf\b/i],
        ['Red Sea', /\bred\s+sea\b/i],
        ['Suez Canal', /\bsuez\s+canal\b/i],
        ['Bab el-Mandeb', /\bbab[-\s]?el[-\s]?mandeb\b/i],
        ['Gulf of Aden', /\bgulf\s+of\s+aden\b/i],
        ['Arabian Sea', /\barabian\s+sea\b/i],
    ];
    for (const [name, rx] of regexPlaces) {
        const m = text.match(rx);
        if (m && typeof m.index === 'number') hits.push({ name, idx: m.index });
    }
    hits.sort((a, b) => a.idx - b.idx);
    // Dedupe by lowercase name, preserving first occurrence.
    const seen = new Set();
    const out = [];
    for (const h of hits) {
        const k = h.name.toLowerCase();
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(h.name);
    }
    return out;
}

function _hasSpatialVerb(text) {
    if (!text) return null;
    for (const rx of SPATIAL_VERB_PATTERNS) {
        const m = text.match(rx);
        if (m) return m[0].trim();
    }
    return null;
}

function _hasAbstractMarker(text) {
    if (!text) return null;
    for (const rx of ABSTRACT_MARKERS) {
        const m = text.match(rx);
        if (m) return m[0].trim();
    }
    return null;
}

function _mapInstructionText(scriptContext = {}, options = {}) {
    return [
        scriptContext?._directives?.raw,
        options?.directorsBrief?._directives?.raw,
        options?.directorsBrief?.freeInstructions,
        options?.directorsBrief?.aiInstructions,
        options?.freeInstructions,
        options?.aiInstructions,
        scriptContext?.directorsBrief?.freeInstructions,
        scriptContext?.directorsBrief?.aiInstructions,
        scriptContext?.freeInstructions,
        scriptContext?.aiInstructions,
        scriptContext?.instructions,
        scriptContext?.buildOptions?.aiInstructions,
        process.env.AI_INSTRUCTIONS,
    ].filter(Boolean).join('\n');
}

function _userRequestsAnyMap(scriptContext = {}, options = {}) {
    const text = _mapInstructionText(scriptContext, options).toLowerCase();
    if (!text) return false;
    return /\b(?:use|prefer|show|add|put|include|make|keep|preserve)\s+(?:a\s+)?maps?\b/.test(text)
        || /\bmaps?\s+(?:at|in|on|for|during|first|opening|hook|intro)\b/.test(text)
        || /\b(?:route|locator|map[\s-]*chart|map animation)\b/.test(text);
}

function _userRequestsFirstHookMap(scriptContext = {}, options = {}) {
    const text = _mapInstructionText(scriptContext, options).toLowerCase();
    if (!text) return false;
    const asksMap = /\b(?:use|prefer|show|add|put|include|make)\s+(?:a\s+)?maps?\b/.test(text)
        || /\bmaps?\s+(?:at|in|on|for|during)\s+(?:the\s+)?(?:first|opening|hook|intro)\b/.test(text)
        || /\b(?:route|locator|map[\s-]*chart|map animation)\b/.test(text);
    const asksHook = /\b(?:first|opening|hook|intro)\b/.test(text);
    return asksMap && asksHook;
}

// Choose the initial mapVariant for a must_map upgrade from the disposition
// signals. Previously hardcoded to 'locator' which broke multi-place scenes
// like "trade moves BETWEEN Asia and Europe" (rendered as a sequential pan
// instead of both continents visible). The variant names returned here match
// VP's mapVariant enum: locator | route | regionHighlight | comparison.
function _chooseVariantFromSignals(signals) {
    const verb = String(signals?.spatialVerb || '').toLowerCase();
    const placeCount = Number(signals?.placeCount || 0);
    const matchedPlaces = Array.isArray(signals?.matchedPlaces) ? signals.matchedPlaces : [];
    const sceneText = String(signals?.sceneText || '');
    // Single place → locator, regardless of verb.
    if (placeCount < 2) return 'locator';
    if (/\bbetween\b/.test(verb)
        && matchedPlaces.length >= 2
        && matchedPlaces.slice(0, 2).every(p => BROAD_ROUTE_REGION_RE.test(String(p || '').trim()))
        && TRADE_CORRIDOR_TEXT_RE.test(sceneText)) {
        return 'route';
    }
    // from X to Y / across / through / along / into / toward — a journey.
    if (/\b(from|to|toward|towards|across|through|along|into|heading|sail|mov|travel|advanc)/.test(verb)) {
        return 'route';
    }
    // between / border / among / next to / separates / divides / joins /
    // connects / flanks / faces — a relationship between places; both should
    // be visible simultaneously in one frame.
    if (/\b(?:between|border|bordering|among|next to|beside|near|(?:separat|divid|split|flank|connect|link|join)[a-z]*|faces?|meets?)\b/.test(verb)) {
        return 'regionHighlight';
    }
    // Plain presence of multiple named places → comparison-style held-wide
    // (safer default than locator for ≥2 subjects — avoids sequential pan).
    return 'regionHighlight';
}

function _zoneForScene(scene, scriptContext) {
    const midpoint = (scene.startTime + scene.endTime) / 2;
    const hookEnd = scriptContext.hookEndTime || 0;
    const ctaStart = scriptContext.ctaStartTime || Infinity;
    if (midpoint <= hookEnd) return 'hook';
    if (midpoint >= ctaStart) return 'cta';
    return 'body';
}

// Only entity kinds that geocode to a point/region. Skip people, orgs, events.
// entityTypes is keyed by lowercase name everywhere else in the codebase
// (ai-director stores it that way, VP reads it that way); mirror that here
// so person/org/event names don't get miscounted as places.
function _placeLikeEntities(scriptContext) {
    const { entities = [], entityTypes = {} } = scriptContext || {};
    const places = [];
    for (const e of entities) {
        const t = entityTypes[e.toLowerCase()];
        // If we don't have a type tag, keep the entity — names like "Persian
        // Gulf" or "Red Sea" often reach us untagged and must still count.
        if (!t || t === 'place' || t === 'country' || t === 'city' || t === 'region' || t === 'waterbody') {
            places.push(e);
        }
    }
    return places;
}

/**
 * Assign a map disposition to every scene.
 *
 * @param {Array} scenes                 director scenes (index, text, startTime, endTime)
 * @param {Object} scriptContext         director context (entities, zones, nicheId, ...)
 * @param {Object} styleProfile          optional reference style profile
 * @param {Object} nicheCfg              optional niche config
 * @returns {Array<{sceneIndex, disposition, reason, signals}>}
 */
function assignMapDispositions(scenes, scriptContext, styleProfile = null, nicheCfg = null, options = {}) {
    if (!Array.isArray(scenes)) return [];
    const nicheId = scriptContext?.nicheId || 'general';
    if (!_nicheIsMapEligible(nicheId)) {
        // Hard skip: this niche is not map-eligible, so we don't even score
        // scenes. logDispositions() will print a single "skipped" line when it
        // receives an empty dispositions array.
        return [];
    }
    const { baseline, budget } = _getNicheBaseline(nicheId);
    const mapChartAllowed = _nicheAllowsMapChart(scriptContext, nicheCfg);
    const effectiveBudget = mapChartAllowed ? budget : 0;
    const placeEntities = _placeLikeEntities(scriptContext || {});
    const userRequestsAnyMap = _userRequestsAnyMap(scriptContext || {}, options || {});
    const forceFirstHookMap = _userRequestsFirstHookMap(scriptContext || {}, options || {});
    // Talking-head precedence: any beat inside a fullframe/framed presenter HOLD (span)
    // OWNS that beat — never turn it into a map (presenter-director/floor runs first).
    const presenterAnchorIdx = new Set();
    if (Array.isArray(scriptContext && scriptContext._presenterDispositions)) {
        for (const d of scriptContext._presenterDispositions) {
            // Any presenter beat except a corner PiP owns its frame → never a map.
            // (framed = presenter card; split = presenter + B-roll halves, no mapChart.)
            if (!d || d.layout === 'pip') continue;
            const s = d.startSceneIndex;
            const e = (d.endSceneIndex != null) ? d.endSceneIndex : s;
            for (let idx = s; idx <= e; idx++) presenterAnchorIdx.add(idx);
        }
    }

    const dispositions = scenes.map(scene => {
        const text = scene.text || '';
        const zone = _zoneForScene(scene, scriptContext || {});
        const spatialVerb = _hasSpatialVerb(text);
        const abstractMarker = _hasAbstractMarker(text);
        const matchedPlaces = _findPlacesInText(text, placeEntities);
        const placeCount = matchedPlaces.length;

        const signals = {
            zone,
            spatialVerb,
            abstractMarker,
            placeCount,
            matchedPlaces,
            nicheBaseline: baseline,
            sceneText: text,
            userRequestsAnyMap,
            userRequestsFirstHookMap: forceFirstHookMap,
        };

        // Talking-head: presenter insert owns this beat → never a map.
        if (presenterAnchorIdx.has(scene.index)) {
            return { sceneIndex: scene.index, disposition: 'must_not_map', reason: 'presenter insert owns this beat', signals };
        }

        // The niche allowlist is the top-level authority. If mapChart is not in
        // allowedMGs, do not let geography, user map preferences, or route text
        // create a must_map/can_map disposition. The planner can still use
        // footage, web-image route references, overlays, or templates.
        if (!mapChartAllowed) {
            return { sceneIndex: scene.index, disposition: 'must_not_map', reason: `niche allowlist (${nicheId}) excludes mapChart`, signals };
        }

        // must_not_map wins over everything:
        //   CTA zone, quote-only text, abstract framing, and zero named places
        //   all suppress the map option hard.
        if (zone === 'cta') {
            return { sceneIndex: scene.index, disposition: 'must_not_map', reason: 'CTA zone — closing call, not a map', signals };
        }
        if (forceFirstHookMap && (scene.index === 0 || (scene.startTime || 0) <= 1.5) && (placeCount >= 1 || spatialVerb)) {
            signals.userForcedFirstHookMap = true;
            return { sceneIndex: scene.index, disposition: 'must_map', reason: 'user requested map in first hook', signals, lock: 'user-first-hook-map' };
        }
        if (abstractMarker && placeCount === 0) {
            return { sceneIndex: scene.index, disposition: 'must_not_map', reason: `abstract marker "${abstractMarker}" + no named place`, signals };
        }
        if (placeCount === 0 && !spatialVerb) {
            return { sceneIndex: scene.index, disposition: 'must_not_map', reason: 'no named place + no spatial verb', signals };
        }

        // Niche-level hard block (e.g. motivation, diy):
        if (baseline === 'must_not_map' && !spatialVerb) {
            return { sceneIndex: scene.index, disposition: 'must_not_map', reason: `niche baseline (${nicheId}) + no strong spatial cue`, signals };
        }

        // must_map: strong spatial cue + ≥1 named place, OR from/to route phrase
        if (spatialVerb && placeCount >= 1) {
            return { sceneIndex: scene.index, disposition: 'must_map', reason: `spatial verb "${spatialVerb}" + ${placeCount} named place(s)`, signals };
        }

        // Fallback — has some signals but not strong enough to force.
        if (placeCount >= 2) {
            return { sceneIndex: scene.index, disposition: 'can_map', reason: `${placeCount} named places, no spatial verb`, signals };
        }
        if (placeCount === 1 && spatialVerb) {
            return { sceneIndex: scene.index, disposition: 'can_map', reason: `1 place + spatial phrase (weak)`, signals };
        }
        return { sceneIndex: scene.index, disposition: 'can_map', reason: 'ambiguous — optional map', signals };
    });

    // Global cap on must_map: if strong spatial signals produced more must_maps
    // than the effective budget, demote the weakest must_maps (fewest places,
    // shortest spatial verb) to can_map. The can_map budget cap below then
    // trims those further if needed. Weakest-first preserves the strongest
    // geographic anchors (e.g. route scenes with 3+ places).
    let mustMapCount = dispositions.filter(d => d.disposition === 'must_map').length;
    if (mustMapCount > effectiveBudget) {
        const mustMapRanked = dispositions
            .filter(d => d.disposition === 'must_map' && d.lock !== 'user-first-hook-map')
            .sort((a, b) => {
                const aScore = (a.signals.spatialVerb ? a.signals.spatialVerb.length : 0) + a.signals.placeCount * 4;
                const bScore = (b.signals.spatialVerb ? b.signals.spatialVerb.length : 0) + b.signals.placeCount * 4;
                return aScore - bScore;
            });
        const toDemote = mustMapRanked.slice(0, Math.max(0, mustMapCount - effectiveBudget));
        for (const d of toDemote) {
            d.disposition = 'can_map';
            d.reason = `demoted — global cap ${effectiveBudget} maps exceeded (was must_map: ${d.reason})`;
        }
        mustMapCount = dispositions.filter(d => d.disposition === 'must_map').length;
    }

    // Budget cap: if can_map count exceeds niche budget - must_map count,
    // downgrade the weakest can_map entries to must_not_map. Weakest = fewest
    // named places + no spatial verb.
    const canMapCount = dispositions.filter(d => d.disposition === 'can_map').length;
    const remainingBudget = Math.max(0, effectiveBudget - mustMapCount);
    if (canMapCount > remainingBudget) {
        const canMapRanked = dispositions
            .filter(d => d.disposition === 'can_map')
            .sort((a, b) => {
                const aScore = (a.signals.spatialVerb ? 2 : 0) + a.signals.placeCount;
                const bScore = (b.signals.spatialVerb ? 2 : 0) + b.signals.placeCount;
                return aScore - bScore;
            });
        const toDowngrade = canMapRanked.slice(0, canMapCount - remainingBudget);
        for (const d of toDowngrade) {
            d.disposition = 'must_not_map';
            d.reason = `downgraded — niche budget ${effectiveBudget} exceeded`;
        }
    }

    return dispositions;
}

/**
 * Log the assignment summary in the format the rebuild spec expects.
 * Keep this verbose — easy to grep in production builds.
 */
function logDispositions(dispositions, scriptContext) {
    const nicheId = scriptContext?.nicheId || 'general';
    if (!_nicheIsMapEligible(nicheId)) {
        console.log(`🗺️  Map Assignment skipped — niche "${nicheId}" not in map-eligible list (politics, military, history, nature)`);
        return;
    }
    const { baseline, budget } = _getNicheBaseline(nicheId);
    const mapChartAllowed = _nicheAllowsMapChart(scriptContext);
    const effectiveBudget = mapChartAllowed ? budget : 0;
    const counts = { must_map: 0, can_map: 0, must_not_map: 0 };
    for (const d of dispositions) counts[d.disposition]++;

    console.log('\n════════════════════════════════════════════════════════════');
    console.log('🗺️  Map Assignment (deterministic)');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`   Niche policy: ${nicheId}  baseline=${baseline}  budget=${effectiveBudget}  mapChart=${mapChartAllowed ? 'allowed' : 'forbidden-by-allowedMGs'}`);
    console.log(`   ${dispositions.length} scenes analyzed → must_map=${counts.must_map}  can_map=${counts.can_map}  must_not_map=${counts.must_not_map}`);
    console.log('');
    for (const d of dispositions) {
        const tag = d.disposition.padEnd(12, ' ');
        console.log(`   Scene ${String(d.sceneIndex).padStart(2, ' ')}  ${tag}  ${d.reason}`);
    }
    console.log('');
}

// Build the VP-shaped mapChart payload from matched places.
// Format: "Place A: label, Place B: label" — this is the string the parser
// at ai-motion-graphics.js (the mapChart branch) routes into mg.subtext so
// map-provider's entity parser can geocode the pins directly without
// falling back to the full script-wide entity dump.
function _buildMapChartPayload(places) {
    if (!places || places.length === 0) return null;
    const pairs = places.slice(0, 4).map(p => `${p}: label`).join(', ');
    return `mapChart: ${pairs}`;
}

function _shouldPreserveUserRequestedVPMap(scene, disposition, scriptContext = {}) {
    if (!scene || !disposition) return false;
    if (!disposition.signals?.userRequestsAnyMap && !_userRequestsAnyMap(scriptContext)) return false;
    if (disposition.reason && /cta zone|excludes mapchart|forbidden/i.test(disposition.reason)) return false;

    const zone = disposition.signals?.zone || _zoneForScene(scene, scriptContext || {});
    const budgetBlocked = /budget|global cap|niche budget/i.test(String(disposition.reason || ''));
    const weakGateBlocked = /no named place|no spatial verb|ambiguous/i.test(String(disposition.reason || ''));
    const hookish = zone === 'hook' || (scene.startTime || 0) <= Number(scriptContext?.hookEndTime || 0) || (scene.startTime || 0) <= 12;

    return hookish || budgetBlocked || weakGateBlocked;
}

function _usableVisualValue(value) {
    if (value == null) return false;
    const text = String(value).trim();
    return !!text && !['none', 'null', 'undefined', 'n/a'].includes(text.toLowerCase());
}

const BLOCKED_MAP_KEYWORD_STOPWORDS = new Set([
    'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'over', 'under', 'that', 'this',
    'these', 'those', 'their', 'there', 'where', 'when', 'what', 'which', 'while', 'about',
    'around', 'nearly', 'just', 'still', 'label', 'mapchart', 'scene', 'route'
]);

function _compactSearchWords(value, maxWords = 7) {
    const seen = new Set();
    return String(value || '')
        .replace(/[_|]/g, ' ')
        .replace(/[^a-zA-Z0-9\s-]/g, ' ')
        .split(/\s+/)
        .map(w => w.trim())
        .filter(Boolean)
        .filter(w => {
            const key = w.toLowerCase();
            if (BLOCKED_MAP_KEYWORD_STOPWORDS.has(key)) return false;
            if (key.length < 3 && !/^\d+$/.test(key) && !['el', 'al', 'uk', 'us'].includes(key)) return false;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, maxWords)
        .join(' ');
}

function _mapPayloadText(mapValue) {
    return String(mapValue || '')
        .replace(/^mapchart\s*:/i, '')
        .replace(/\blabel\b/gi, ' ')
        .replace(/\bmarker\b/gi, ' ')
        .replace(/\blocator\b/gi, ' ')
        .replace(/\bregionhighlight\b/gi, ' ')
        .trim();
}

function _fallbackKeywordForBlockedMap(scene, disposition, scriptContext = {}) {
    // Disambiguator terms enrich the raw geographic keyword so providers
    // don't return tourism/diving footage for ambiguous bodies of water
    // (e.g., "Red Sea" → coral reefs). Pull from niche.searchPolicy.contextTerms
    // + mediaHunter.prefer when the scene's keyword carries an ambiguous geo
    // token (sea/gulf/strait/etc.).
    const disambig = _disambiguatorTermsForBlockedMap(scene, scriptContext);

    const places = disposition?.signals && Array.isArray(disposition.signals.matchedPlaces)
        ? disposition.signals.matchedPlaces.filter(Boolean)
        : [];
    if (places.length > 0) {
        const base = `${places.slice(0, 3).join(' ')} aerial view`;
        return disambig ? `${base} ${disambig}` : base;
    }

    const fromMapPayload = _compactSearchWords(_mapPayloadText(scene._mapBlockedBy || scene.fullscreenMG), 6);
    if (fromMapPayload) {
        const lower = fromMapPayload.toLowerCase();
        const suffix = /\b(strait|sea|gulf|canal|coast|coastline|route|shipping|maritime|port)\b/.test(lower)
            ? 'satellite view'
            : 'geopolitical overview';
        const base = `${fromMapPayload} ${suffix}`;
        return disambig ? `${base} ${disambig}` : base;
    }

    const fromSceneText = _compactSearchWords(disposition?.signals?.sceneText || scene.text || scene.visualIntent, 6);
    if (fromSceneText) {
        const base = `${fromSceneText} documentary footage`;
        return disambig ? `${base} ${disambig}` : base;
    }
    return 'geopolitical documentary footage';
}

// Ambiguous geographic tokens — when present, splice niche context terms into
// the keyword so providers don't return tourism content for the place name.
const AMBIGUOUS_GEO_RE = /\b(sea|gulf|strait|canal|bay|coast|coastline|shore|ocean|harbor|harbour|river|delta|island|cape|peninsula)\b/i;

function _disambiguatorTermsForBlockedMap(scene, scriptContext = {}) {
    const keyword = String(scene?.keyword || '').toLowerCase();
    const sceneText = String(scene?.text || scene?.visualIntent || '').toLowerCase();
    const mapPayload = _mapPayloadText(scene?._mapBlockedBy || scene?.fullscreenMG).toLowerCase();
    if (!AMBIGUOUS_GEO_RE.test(keyword) && !AMBIGUOUS_GEO_RE.test(mapPayload) && !AMBIGUOUS_GEO_RE.test(sceneText)) {
        return '';
    }

    // Disambiguate ambiguous geo (e.g. "Red Sea" → coral-reef tourism) using the
    // scene's OWN concrete visual cues (mediaHunter.prefer is AI-generated, per-scene),
    // NOT the niche's thematic word-list (contextTerms like "policy"/"geopolitical").
    // Those don't disambiguate the shot and just pollute the query
    // ("Strait of Hormuz aerial view policy geopolitical"). Keep short concrete tokens.
    const prefer = Array.isArray(scene?.mediaHunter?.prefer) ? scene.mediaHunter.prefer : [];
    const seen = new Set();
    const picks = [];
    for (const t of prefer) {
        const clean = String(t || '').trim().toLowerCase();
        // Concrete cue only: short token/2-word phrase, skip long descriptive prose.
        if (!clean || clean.length < 3 || clean.split(/\s+/).length > 2) continue;
        if (seen.has(clean)) continue;
        seen.add(clean);
        picks.push(clean);
        if (picks.length >= 2) break;
    }
    return picks.join(' ');
}

function _fallbackSourceForBlockedMap(scene, scriptContext = {}) {
    if (_usableVisualValue(scene.sourceHint)) return scene.sourceHint;

    const preferred = scene.treatmentHint?.preferredSource;
    const videoSources = new Set(['youtube', 'reddit', 'storyblocks']);
    if (videoSources.has(preferred)) return preferred;

    try {
        const { getNiche } = require('../data/niches');
        const niche = getNiche(scriptContext?.nicheId || 'general');
        const priority = Array.isArray(niche?.footagePriority?.video) ? niche.footagePriority.video : [];
        const source = priority.find(src => src && src !== 'stock');
        if (source) return source;
    } catch (_) {
        // Keep the map layer deterministic even if niche metadata is unavailable.
    }

    return 'youtube';
}

function _restoreBlockedMapFallback(scene, disposition, scriptContext = {}) {
    if (scene.templateHint && !scene.fullscreenMG) return null;

    // Prefer Sonnet-emitted bgQuery for blocked-map scenes when the VP prompt
    // surfaced BLOCKED=map. AI sees the full narration + niche context and
    // produces a real visual search like "Bab-el-Mandeb cargo ship aerial",
    // not the heuristic "...satellite view policy geopolitical" suffix soup.
    const aiBgQuery = typeof scene._aiBgQuery === 'string' ? scene._aiBgQuery.trim() : '';
    if (!_usableVisualValue(scene.keyword) && aiBgQuery) {
        scene.keyword = aiBgQuery;
    } else if (!_usableVisualValue(scene.keyword)) {
        scene.keyword = _fallbackKeywordForBlockedMap(scene, disposition, scriptContext);
    } else if (AMBIGUOUS_GEO_RE.test(String(scene.keyword))) {
        const disambig = _disambiguatorTermsForBlockedMap(scene, scriptContext);
        if (disambig && !String(scene.keyword).toLowerCase().includes(disambig.split(' ')[0])) {
            scene.keyword = `${scene.keyword} ${disambig}`;
        }
    }
    if (!_usableVisualValue(scene.sourceHint)) {
        scene.sourceHint = _fallbackSourceForBlockedMap(scene, scriptContext);
    }
    if (!_usableVisualValue(scene.mediaType)) {
        scene.mediaType = 'video';
    }
    if (!_usableVisualValue(scene.stockQuery)) {
        scene.stockQuery = scene.keyword;
    }
    if (!_usableVisualValue(scene.webQuery)) {
        scene.webQuery = scene.keyword;
    }

    return {
        keyword: scene.keyword,
        sourceHint: scene.sourceHint,
    };
}

/**
 * Apply the disposition gate to VP-planned scenes AFTER the planner runs.
 * Hard enforcement:
 *   • must_not_map   → strip any fullscreenMG starting with "mapChart" and log
 *   • must_map       → if no mapChart present, synthesize a real mapChart
 *                      payload from scene-matched place entities (never
 *                      the bare string "mapChart: locator", which would
 *                      force the downstream parser into the script-wide
 *                      entity dump fallback).
 * Returns { blocked, upgraded, upgradeSkipped } counts for summary logging.
 */
function enforceDispositions(scenes, dispositions, scriptContext = {}) {
    let blocked = 0, upgraded = 0, upgradeSkipped = 0, fallbackRestored = 0;
    const byIndex = new Map(dispositions.map(d => [d.sceneIndex, d]));
    for (const scene of scenes) {
        const d = byIndex.get(scene.index);
        if (!d) continue;
        const hasMap = typeof scene.fullscreenMG === 'string' && scene.fullscreenMG.toLowerCase().startsWith('mapchart');

        if (d.disposition === 'must_not_map' && hasMap) {
            if (_shouldPreserveUserRequestedVPMap(scene, d, scriptContext)) {
                scene._mapDispositionOverridden = d.reason;
                console.log(`   [VP] Scene ${scene.index} fullscreenMG="${scene.fullscreenMG}" PRESERVED by user map request (${d.reason})`);
                continue;
            }
            console.log(`   [VP] Scene ${scene.index} fullscreenMG="${scene.fullscreenMG}" BLOCKED by must_not_map (${d.reason}) → stripped`);
            scene._mapBlockedBy = scene.fullscreenMG;
            scene.fullscreenMG = null;
            scene.mapVariant = undefined;
            const fallback = _restoreBlockedMapFallback(scene, d, scriptContext);
            if (fallback) {
                console.log(`   [VP] Scene ${scene.index} blocked-map fallback restored: "${fallback.keyword}" [${fallback.sourceHint}]`);
                fallbackRestored++;
            }
            blocked++;
            continue;
        }

        if (d.disposition === 'must_map' && !hasMap) {
            // mapChart is a map lane, not a generic motion-graphics lane. A
            // class may omit mapChart from its normal MG allowlist and still be
            // eligible for a must_map upgrade. Only an explicit lane block can
            // veto the map here.
            const blockedLanes = scene.treatmentHint && Array.isArray(scene.treatmentHint.blocked)
                ? scene.treatmentHint.blocked
                : [];
            if (blockedLanes.includes('map')) {
                console.log(`   [VP] Scene ${scene.index} must_map UPGRADE SKIPPED — class ${scene.sceneClass} blocks map lane (${d.reason})`);
                upgradeSkipped++;
                continue;
            }

            const places = (d.signals && d.signals.matchedPlaces) || [];
            const payload = _buildMapChartPayload(places);
            if (!payload) {
                // must_map requires placeCount >= 1 by the rules above, so this
                // path is defensive. If we somehow got here with zero matched
                // places, refuse the upgrade rather than synthesize the bare
                // "mapChart: locator" string the old code used.
                console.log(`   [VP] Scene ${scene.index} must_map UPGRADE SKIPPED — no matched places (${d.reason})`);
                upgradeSkipped++;
                continue;
            }
            const prev = scene.fullscreenMG || scene.mgHint || 'none';
            scene._mapUpgradedFrom = prev;
            scene.fullscreenMG = payload;
            scene.mgHint = null;
            scene.templateHint = null;
            scene.keyword = null;
            scene.stockQuery = null;
            scene.webQuery = null;
            scene.sourceHint = null;
            scene.mediaType = null;
            // Pick a smart initial variant from the spatial-verb signal + place
            // count. Hardcoding 'locator' here was wrong for multi-place scenes:
            // "trade moves BETWEEN Asia and Europe" was being rendered as a
            // sequential Asia→Europe pan instead of both continents highlighted.
            scene.mapVariant = _chooseVariantFromSignals(d.signals);
            console.log(`   [VP] Scene ${scene.index} ${prev === 'none' ? 'no MG' : `had "${prev}"`} UPGRADED to "${payload}" as variant=${scene.mapVariant} (${d.reason})`);
            upgraded++;
        }
    }
    return { blocked, upgraded, upgradeSkipped, fallbackRestored };
}

module.exports = {
    assignMapDispositions,
    logDispositions,
    enforceDispositions,
    _NICHE_BASELINE: NICHE_BASELINE,
};
