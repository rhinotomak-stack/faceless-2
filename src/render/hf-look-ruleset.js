'use strict';
/**
 * hf-look-ruleset.js — the colorist's rulebook (single source of truth for the
 * video's "look"). Pure data + resolvers, no AI, no rendering.
 *
 * Doctrine (from color-grading research):
 *  - ONE "film stock" per video: a single base GRADE + a subtle texture floor
 *    runs through EVERY scene. Consistency is rule #1; the look evolves, never jumps.
 *  - Contrast ∝ tension, saturation ∝ scope, warm/cool = emotional foundation.
 *  - Documentary/explainer baseline = RESTRAINT; every departure from neutral is
 *    a deliberate signal. Era looks (sepia/VHS/scratches) are punctuation for
 *    archival/flashback beats only — one era family per video.
 *
 * The Effects Director derives the base look DETERMINISTICALLY from theme+niche
 * (plan._hfBaseLook) and lets the AI choose only sparse per-scene STANDOUT deltas
 * + which scenes are flashbacks + the background pack. hf-effects.mergeBaseLook
 * composites base + delta at render so the whole video reads as one film.
 *
 * All ids below are from the fixed hf-effects vocabulary (9 grades / 17 effects).
 */

// THEME → base film stock (grade + subtle always-on texture). Theme is the
// primary driver of the look. Light-canvas themes carry NO vignette/bloom.
const THEME_BASE = {
    crime:            { grade: 'cold-steel',  texture: [{ id: 'grain', intensity: 0.16 }, { id: 'vignette', intensity: 0.24 }] },
    history:          { grade: 'warm-film',    texture: [{ id: 'grain', intensity: 0.12 }, { id: 'dust', intensity: 0.06 }] },
    modern:           { grade: 'teal-orange',  texture: [{ id: 'grain', intensity: 0.06 }] },
    minimal:          { grade: 'faded',        texture: [] },
    standard:         { grade: 'teal-orange',  texture: [{ id: 'grain', intensity: 0.08 }] },
    'warm-editorial': { grade: 'warm-film',    texture: [{ id: 'grain', intensity: 0.06 }] }, // light canvas: no vignette
    luxury:           { grade: 'warm-film',    texture: [{ id: 'grain', intensity: 0.06 }, { id: 'vignette', intensity: 0.26 }] },
    nature:           { grade: 'vivid',        texture: [{ id: 'grain', intensity: 0.06 }, { id: 'fogDrift', intensity: 0.12 }] },
};

// NICHE → grade override (content strategy can tilt the theme's base) + which
// era family (if any) this video is allowed + a niche ambience allowance.
// eraFamily null = era looks FORBIDDEN this video. Unlisted niche → keep theme.
const NICHE_OVERRIDE = {
    'explainer.crime':      { grade: 'cold-steel', eraFamily: 'projected' },
    'explainer.history':    { grade: 'sepia-archival', eraFamily: 'projected' },
    'explainer.military':   { grade: 'cold-steel', eraFamily: 'projected', atmos: 'embers' },
    'explainer.nature':     { grade: 'vivid', eraFamily: null, atmos: 'fogDrift' },
    'explainer.luxury':     { grade: 'warm-film', eraFamily: null },
    'explainer.motivation': { grade: 'warm-film', eraFamily: null },
    'explainer.tech':       { grade: 'cold-steel', eraFamily: null, modernFx: 'glitchPulse' },
    'explainer.food':       { grade: 'warm-film', eraFamily: null },
    'explainer.sport':      { grade: 'vivid', eraFamily: null },
    'explainer.business':   { grade: 'teal-orange', eraFamily: null },
    'explainer.politics':   { grade: 'cold-steel', eraFamily: null },
    'explainer.diy':        { grade: 'vivid', eraFamily: null },
    // news.* — broadcast urgency, clean, NEVER era looks (present-day objectivity)
    'news.politics':  { grade: 'cold-steel', eraFamily: null },
    'news.economy':   { grade: 'cold-steel', eraFamily: null },
    'news.military':  { grade: 'cold-steel', eraFamily: null, atmos: 'embers' },
    'news.celebrity': { grade: 'teal-orange', eraFamily: null },
    'news.tech':      { grade: 'cold-steel', eraFamily: null, modernFx: 'glitchPulse' },
    'news.sport':     { grade: 'vivid', eraFamily: null },
};

// Era families — the ONLY era ids allowed, one family per video, archival/flashback only.
const ERA_FAMILIES = {
    projected: { grade: 'sepia-archival', fx: ['vintageFrame', 'filmScratches', 'flicker'] }, // old-film / memory
    broadcast: { grade: 'vhs-wash', fx: ['oldTv', 'staticNoise'] },                            // 70s-90s TV archive
    homevideo: { grade: 'vhs-wash', fx: ['vhs', 'staticNoise'] },                              // 90s found-footage
};
const ERA_ALL = new Set(['vintageFrame', 'filmScratches', 'oldTv', 'vhs', 'staticNoise', 'flicker', 'sepia-archival', 'vhs-wash']);

// Scene CLASS → the sparse STANDOUT delta a scene may earn on top of the base.
// This is both the deterministic fallback (AI off/failed) AND the prompt guidance.
// Empty = base stock only (most scenes). data-claim is CLEAN (no texture over charts).
const CLASS_DELTA = {
    'hook-tease':        [{ id: 'vignette', intensity: 0.30 }],
    'concept-metaphor':  [{ id: 'fogDrift', intensity: 0.20 }],
    'data-claim':        [],
    'quote-callout':     [{ id: 'vignette', intensity: 0.22 }],
    'transition-bridge': [],
    'location-event':    [{ id: 'lightLeak', intensity: 0.30 }],
    'object-scene':      [],
};

// Classes that must stay CLEAN — base GRADE for color coherence, but NO texture
// (grain/vignette over a chart/number reads as dirt and hurts legibility).
const CLEAN_CLASSES = new Set(['data-claim']);

// Standout budget: at most this fraction of footage scenes carry any delta.
const STANDOUT_MAX_FRACTION = 0.30;
const LENS_FLARE_BUDGET = 2;

/** Resolve the ONE base film stock for the whole video (deterministic). */
function resolveBaseLook(themeId, nicheId) {
    const t = String(themeId || 'standard').toLowerCase();
    const n = String(nicheId || '').toLowerCase();
    const base = THEME_BASE[t] || THEME_BASE.standard;
    const ov = NICHE_OVERRIDE[n];
    const grade = (ov && ov.grade) ? ov.grade : base.grade;
    const texture = (base.texture || []).map(e => ({ ...e }));
    // Niche ambience (military embers, nature fog) rides the base as a low, sustained
    // "invisible" layer across the whole video (dedup so a theme+niche match isn't doubled).
    if (ov && ov.atmos && !texture.some(t => t.id === ov.atmos)) {
        texture.push({ id: ov.atmos, intensity: ov.atmos === 'embers' ? 0.10 : 0.14 });
    }
    // era family: explicit niche value wins; otherwise history theme implies 'projected', else none.
    let eraFamily = null;
    if (ov && Object.prototype.hasOwnProperty.call(ov, 'eraFamily')) eraFamily = ov.eraFamily;
    else if (t === 'history') eraFamily = 'projected';
    return {
        grade,
        texture,
        eraFamily: eraFamily || null,
        atmos: (ov && ov.atmos) || null,
        modernFx: (ov && ov.modernFx) || null,
    };
}

/** Deterministic per-scene delta (fallback when the AI is off/failed). */
function classDelta(sceneClass, role) {
    const d = (CLASS_DELTA[sceneClass] || []).map(e => ({ ...e }));
    if ((role === 'cta' || role === 'outro') && !d.some(e => e.id === 'bloom')) d.push({ id: 'bloom', intensity: 0.2 });
    return d;
}

module.exports = {
    THEME_BASE, NICHE_OVERRIDE, ERA_FAMILIES, ERA_ALL, CLASS_DELTA, CLEAN_CLASSES,
    STANDOUT_MAX_FRACTION, LENS_FLARE_BUDGET, resolveBaseLook, classDelta,
};
