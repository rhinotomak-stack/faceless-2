/**
 * class-treatment-map.js
 *
 * Fixed editorial scene classes → production treatment mapping.
 *
 * The classifier (scene-classifier.js) tags every scene with one of the 8 classes
 * below. The Visual Planner then consumes the treatment row to:
 *   - bias primary visual strategy (footage / map / graphics / template)
 *   - block incompatible choices (no stock for metaphor, no template for map scene)
 *   - pick the search family the footage will actually resolve in
 *   - derive a retrievability score + pre-computed fallback ladder
 *
 * This is PURE DATA + helpers. No AI calls. No I/O.
 *
 * Class taxonomy (fixed, 8 classes):
 *   actor-event    Named person/org doing something real ("Iran navy patrols")
 *   location-event Named place + what's happening there ("Strait of Hormuz")
 *   object-scene   Concrete thing / physical subject ("cargo ship deck")
 *   data-claim     Numbers, stats, dates, percentages
 *   quote-callout  Direct quote or sharp rhetorical line
 *   concept-metaphor Abstract idea / analogy / symbolism (no concrete referent)
 *   transition-bridge Connecting/linking narration between ideas
 *   hook-tease      Opener / provocation / "what if..." hook beats
 */

// ─────────────────────────────────────────────────────────────
// Treatment rows
// ─────────────────────────────────────────────────────────────
//
// primary              — the editorial lane we want chosen FIRST
// alternates[]         — acceptable swap choices if primary unavailable
// blocked[]            — lanes the validator will rewrite away from
// allowedMGs[]         — overlay MG types that make sense for this class
// allowedTemplates[]   — template types that make sense for this class
// preferredSource      — footage source family to route to when lane=footage
// defaultRetrievability— baseline retrievability (classifier may override)

const CLASS_TREATMENTS = {
    'actor-event': {
        primary: 'footage',
        alternates: ['template'],
        blocked: ['concept-metaphor'],
        allowedMGs: ['lowerThird', 'headline', 'broadcastLogo', 'locationCard'],
        allowedTemplates: ['personIntro', 'factCard', 'splitScreen'],
        preferredSource: 'news-actor',
        defaultRetrievability: 'medium',
    },
    'location-event': {
        primary: 'map',
        alternates: ['footage'],
        blocked: [],
        allowedMGs: ['locationCard', 'headline', 'mapChart'],
        allowedTemplates: ['factCard', 'splitScreen'],
        preferredSource: 'news-location',
        defaultRetrievability: 'medium',
    },
    'object-scene': {
        primary: 'footage',
        alternates: [],
        blocked: [],
        allowedMGs: ['lowerThird'],
        allowedTemplates: ['imageShowcase', 'factCard'],
        preferredSource: 'stock',
        defaultRetrievability: 'easy',
    },
    'data-claim': {
        primary: 'graphics',
        alternates: ['template'],
        blocked: ['concept-metaphor'],
        allowedMGs: ['statCounter', 'dataBar', 'percentageCircle', 'focusWord'],
        allowedTemplates: ['statCard', 'infographic', 'factCard'],
        preferredSource: 'stock',
        defaultRetrievability: 'internal-only',
    },
    'quote-callout': {
        primary: 'graphics',
        alternates: ['template'],
        blocked: [],
        allowedMGs: ['callout', 'focusWord', 'typographyReveal', 'headline'],
        allowedTemplates: ['factCard', 'quoteCard'],
        preferredSource: 'stock',
        defaultRetrievability: 'internal-only',
    },
    'concept-metaphor': {
        primary: 'graphics',
        alternates: ['template'],
        blocked: ['footage'],
        allowedMGs: ['focusWord', 'typographyReveal', 'callout'],
        allowedTemplates: ['factCard', 'imageShowcase'],
        preferredSource: 'stock',
        defaultRetrievability: 'internal-only',
    },
    'transition-bridge': {
        primary: 'footage',
        alternates: ['graphics'],
        blocked: [],
        allowedMGs: ['focusWord'],
        allowedTemplates: [],
        preferredSource: 'stock',
        defaultRetrievability: 'easy',
    },
    'hook-tease': {
        primary: 'footage',
        alternates: ['graphics'],
        blocked: [],
        allowedMGs: ['headline', 'focusWord', 'callout'],
        allowedTemplates: ['factCard'],
        preferredSource: 'stock',
        defaultRetrievability: 'medium',
    },
};

const CLASS_LIST = Object.keys(CLASS_TREATMENTS);

const LANE_TO_SCENE_FIELD = {
    footage:   'keyword',
    map:       'fullscreenMG',
    graphics:  'fullscreenMG',
    template:  'templateHint',
};

// ─────────────────────────────────────────────────────────────
// getClassTreatment(sceneClass) → treatment row (frozen-ish copy)
// ─────────────────────────────────────────────────────────────
function getClassTreatment(sceneClass) {
    const row = CLASS_TREATMENTS[sceneClass];
    if (!row) return CLASS_TREATMENTS['object-scene']; // safe default
    return {
        ...row,
        alternates: row.alternates.slice(),
        blocked: row.blocked.slice(),
        allowedMGs: row.allowedMGs.slice(),
        allowedTemplates: row.allowedTemplates.slice(),
    };
}

// ─────────────────────────────────────────────────────────────
// deriveRetrievability(sceneClass, subSignal)
//   Baseline comes from class; subSignal from classifier can sharpen it.
//   Returns 'easy' | 'medium' | 'hard' | 'internal-only'.
// ─────────────────────────────────────────────────────────────
function deriveRetrievability(sceneClass, subSignal) {
    const base = getClassTreatment(sceneClass).defaultRetrievability;
    if (!subSignal) return base;
    const s = String(subSignal).toLowerCase();

    // Signals that push HARDER (less retrievable)
    if (/\b(metaphor|abstract|hypothetical|analogy|symbolism)\b/.test(s)) return 'internal-only';
    if (/\b(niche|obscure|unreported|rumor|speculation)\b/.test(s)) return 'hard';

    // Signals that push EASIER (more retrievable)
    if (/\b(iconic|world-famous|major-city|headline-event|recent-news)\b/.test(s)) return 'easy';
    if (/\b(public-figure|named-actor|known-location)\b/.test(s)) return 'medium';

    return base;
}

// ─────────────────────────────────────────────────────────────
// deriveFallbackLadder(sceneClass, retrievability)
//   Returns an ordered list of lanes to try in sequence.
//   Pre-computed here so footage-manager / VP don't have to improvise.
//   "internal-only" classes skip footage entirely.
// ─────────────────────────────────────────────────────────────
function deriveFallbackLadder(sceneClass, retrievability) {
    const treatment = getClassTreatment(sceneClass);
    const primary = treatment.primary;
    const alts = treatment.alternates;
    const blocked = new Set(treatment.blocked);

    // internal-only = never touch stock/youtube/web providers
    if (retrievability === 'internal-only') {
        const internal = [primary, ...alts].filter(l => l !== 'footage' && l !== 'map' && !blocked.has(l));
        if (internal.length === 0) internal.push('graphics');
        return dedupe(internal);
    }

    // hard = try primary, then graphics/template before giving up on web fetch
    if (retrievability === 'hard') {
        const ladder = [primary];
        for (const a of alts) ladder.push(a);
        if (!ladder.includes('graphics') && !blocked.has('graphics')) ladder.push('graphics');
        if (!ladder.includes('template') && !blocked.has('template')) ladder.push('template');
        return dedupe(ladder);
    }

    // medium / easy = standard ladder (primary → alternates → graphics as last resort)
    const ladder = [primary, ...alts];
    if (!ladder.includes('graphics') && !blocked.has('graphics')) ladder.push('graphics');
    return dedupe(ladder);
}

// ─────────────────────────────────────────────────────────────
// mergeClassBias(sceneClass, nicheId)
//   Optional per-niche override. Niches expose a `classBias` map:
//     { 'actor-event': { preferredSource: 'telegram', ... }, ... }
//   Niche bias wins when it sets a non-null field; otherwise defaults apply.
// ─────────────────────────────────────────────────────────────
function mergeClassBias(sceneClass, nicheId) {
    const base = getClassTreatment(sceneClass);
    if (!nicheId) return base;

    let niche;
    try {
        const { getNiche } = require('./niches');
        niche = getNiche(nicheId);
    } catch (_) {
        return base;
    }

    const bias = niche && niche.classBias && niche.classBias[sceneClass];
    if (!bias) return base;

    return {
        ...base,
        primary:          bias.primary          || base.primary,
        alternates:       bias.alternates       || base.alternates,
        blocked:          bias.blocked          || base.blocked,
        allowedMGs:       bias.allowedMGs       || base.allowedMGs,
        allowedTemplates: bias.allowedTemplates || base.allowedTemplates,
        preferredSource:  bias.preferredSource  || base.preferredSource,
        defaultRetrievability: bias.defaultRetrievability || base.defaultRetrievability,
    };
}

// ─────────────────────────────────────────────────────────────
// resolvePreferredSource(preferredSourceKey, nicheId)
//   Map the abstract key ('news-actor', 'news-location', 'stock', ...)
//   to a concrete sourceHint the VP + footage-manager understand.
// ─────────────────────────────────────────────────────────────
function resolvePreferredSource(preferredSourceKey, nicheId) {
    if (!preferredSourceKey) return 'stock';
    const isNews = String(nicheId || '').startsWith('news');

    switch (preferredSourceKey) {
        case 'news-actor':
            return isNews ? 'telegram' : 'youtube';
        case 'news-location':
            return isNews ? 'telegram' : 'web-image';
        case 'stock':
            return 'stock';
        case 'youtube':
            return 'youtube';
        case 'web-image':
            return 'web-image';
        case 'telegram':
            return 'telegram';
        case 'reddit':
            return 'reddit';
        default:
            return preferredSourceKey;
    }
}

function dedupe(arr) {
    const seen = new Set();
    const out = [];
    for (const v of arr) {
        if (!v || seen.has(v)) continue;
        seen.add(v);
        out.push(v);
    }
    return out;
}

module.exports = {
    CLASS_TREATMENTS,
    CLASS_LIST,
    LANE_TO_SCENE_FIELD,
    getClassTreatment,
    deriveRetrievability,
    deriveFallbackLadder,
    mergeClassBias,
    resolvePreferredSource,
};
