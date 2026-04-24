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
// explainer.politics, explainer.military, news.military, news.politics map
// readily. explainer.nature and explainer.history also benefit from location
// shots. Pure commentary / motivational / diy niches rarely need maps.
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

function _getNicheBaseline(nicheId) {
    return NICHE_BASELINE[nicheId] || { baseline: 'can_map', budget: 3 };
}

// Return the place entities that actually appear in the scene text, in
// document order of the text (so the first-mentioned place is first). Keeps
// the original casing from the entity list so downstream map parsers can
// geocode "Bab-el-Mandeb" — not "bab-el-mandeb".
function _findPlacesInText(text, entities) {
    if (!text || !entities || !entities.length) return [];
    const lower = text.toLowerCase();
    const hits = [];
    for (const e of entities) {
        if (!e || e.length < 3) continue;
        const idx = lower.indexOf(e.toLowerCase());
        if (idx >= 0) hits.push({ name: e, idx });
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
function assignMapDispositions(scenes, scriptContext, styleProfile = null, nicheCfg = null) {
    if (!Array.isArray(scenes)) return [];
    const nicheId = scriptContext?.nicheId || 'general';
    const { baseline, budget } = _getNicheBaseline(nicheId);
    const placeEntities = _placeLikeEntities(scriptContext || {});

    const dispositions = scenes.map(scene => {
        const text = scene.text || '';
        const zone = _zoneForScene(scene, scriptContext || {});
        const spatialVerb = _hasSpatialVerb(text);
        const abstractMarker = _hasAbstractMarker(text);
        const matchedPlaces = _findPlacesInText(text, placeEntities);
        const placeCount = matchedPlaces.length;

        const signals = { zone, spatialVerb, abstractMarker, placeCount, matchedPlaces, nicheBaseline: baseline, sceneText: text };

        // must_not_map wins over everything:
        //   CTA zone, quote-only text, abstract framing, and zero named places
        //   all suppress the map option hard.
        if (zone === 'cta') {
            return { sceneIndex: scene.index, disposition: 'must_not_map', reason: 'CTA zone — closing call, not a map', signals };
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

    // Budget cap: if can_map count exceeds niche budget - must_map count,
    // downgrade the weakest can_map entries to must_not_map. Weakest = fewest
    // named places + no spatial verb.
    const mustMapCount = dispositions.filter(d => d.disposition === 'must_map').length;
    const canMapCount = dispositions.filter(d => d.disposition === 'can_map').length;
    const remainingBudget = Math.max(0, budget - mustMapCount);
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
            d.reason = `downgraded — niche budget ${budget} exceeded`;
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
    const { baseline, budget } = _getNicheBaseline(nicheId);
    const counts = { must_map: 0, can_map: 0, must_not_map: 0 };
    for (const d of dispositions) counts[d.disposition]++;

    console.log('\n════════════════════════════════════════════════════════════');
    console.log('🗺️  Map Assignment (deterministic)');
    console.log('════════════════════════════════════════════════════════════');
    console.log(`   Niche policy: ${nicheId}  baseline=${baseline}  budget=${budget}`);
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
function enforceDispositions(scenes, dispositions) {
    let blocked = 0, upgraded = 0, upgradeSkipped = 0;
    const byIndex = new Map(dispositions.map(d => [d.sceneIndex, d]));
    for (const scene of scenes) {
        const d = byIndex.get(scene.index);
        if (!d) continue;
        const hasMap = typeof scene.fullscreenMG === 'string' && scene.fullscreenMG.toLowerCase().startsWith('mapchart');

        if (d.disposition === 'must_not_map' && hasMap) {
            console.log(`   [VP] Scene ${scene.index} fullscreenMG="${scene.fullscreenMG}" BLOCKED by must_not_map (${d.reason}) → stripped`);
            scene._mapBlockedBy = scene.fullscreenMG;
            scene.fullscreenMG = null;
            scene.mapVariant = undefined;
            blocked++;
            continue;
        }

        if (d.disposition === 'must_map' && !hasMap) {
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
            // Pick a smart initial variant from the spatial-verb signal + place
            // count. Hardcoding 'locator' here was wrong for multi-place scenes:
            // "trade moves BETWEEN Asia and Europe" was being rendered as a
            // sequential Asia→Europe pan instead of both continents highlighted.
            scene.mapVariant = _chooseVariantFromSignals(d.signals);
            console.log(`   [VP] Scene ${scene.index} ${prev === 'none' ? 'no MG' : `had "${prev}"`} UPGRADED to "${payload}" as variant=${scene.mapVariant} (${d.reason})`);
            upgraded++;
        }
    }
    return { blocked, upgraded, upgradeSkipped };
}

module.exports = {
    assignMapDispositions,
    logDispositions,
    enforceDispositions,
    _NICHE_BASELINE: NICHE_BASELINE,
};
