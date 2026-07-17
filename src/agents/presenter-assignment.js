'use strict';
// Presenter Assignment — the DETERMINISTIC FLOOR for talking-head presenter placement.
//
// The PRIMARY owner is the agentic `presenter-director.js` (a brain worker). This module
// is the graceful-degradation fallback used ONLY when that agent is disabled/fails/absent
// (mirrors how Sound Designer keeps a mechanical SFX floor). No AI here.
//
// Doctrine (shared with the director): the video stays B-ROLL-DOMINANT. The presenter is a
// sparse documentary insert — appearing at a few high-value beats (hook/intro, quotes,
// claims, CTA) as a HOLD (a SPAN of consecutive beats, ~8s) so graphics can layer over it.
// NO fixed count cap: the floor is selective (only strong beats) + spread out, so it stays
// naturally sparse without an arbitrary quota.
//
// Two passes: assignPresenterDispositions (BEFORE the Planner → scriptContext._presenterDispositions)
// and enforcePresenterDispositions (AFTER the Planner → stamps scene.presenterInsert + spans).

// Kill switch shared with the director: PRESENTER_INSERTS=0 disables inserts entirely.
const PRESENTER_INSERTS_ENABLED = !['0', 'false', 'off', 'no'].includes(String(process.env.PRESENTER_INSERTS || '').trim().toLowerCase());
// PiP is a P1 render feature — gate its SELECTION until the render branch exists.
const PIP_ENABLED = ['1', 'true', 'on', 'yes'].includes(String(process.env.HF_PRESENTER_PIP || '').trim().toLowerCase());

const QUOTE_RE = /["“][^"”]{6,}["”]|\b(said|says|stated|according to|in (?:his|her|their) words|famously|put it|once wrote|declared)\b/i;
const STAT_RE = /\b\d+(?:[.,]\d+)?\s?(?:%|percent|per cent|billion|million|thousand|trillion)\b|\b(?:rate|ratio|average|statistics?|figures?|data shows?|study found)\b/i;
const OPINION_RE = /\b(I|I'm|I've|I'll|we|we're|we've|let me|in my|honestly|here's the thing|the truth is|trust me|believe me|my point)\b/;
const CONCEPT_RE = /\b(imagine|what if|think about|consider|the idea|the concept|in other words|means that|the point is|here's why)\b/i;

function _zoneForScene(scene, scriptContext) {
    const midpoint = ((scene.startTime || 0) + (scene.endTime || scene.startTime || 0)) / 2;
    const hookEnd = scriptContext.hookEndTime || 0;
    const ctaStart = scriptContext.ctaStartTime || Infinity;
    if (midpoint <= hookEnd) return 'hook';
    if (midpoint >= ctaStart) return 'cta';
    return 'body';
}

function _personEntitiesInText(text, scriptContext) {
    const { entities = [], entityTypes = {} } = scriptContext || {};
    const lower = String(text || '').toLowerCase();
    const found = [];
    for (const e of entities) {
        if (entityTypes[e.toLowerCase()] === 'person' && lower.includes(e.toLowerCase())) found.push(e);
    }
    return found;
}

// Floor policy: guidance for the fallback (NOT count caps). Niches can override via a
// `presenterPolicy` block. holdSeconds = how long a floor hold extends; floorScoreMin =
// how strong a beat must be for the deterministic floor to pick it (keeps the floor sparse).
function getPresenterPolicy(nicheId, nicheCfg = null) {
    const DEFAULT = { minGapScenes: 3, holdSeconds: 8, floorScoreMin: 5, fullframeZones: ['hook', 'cta'] };
    const cfg = nicheCfg || (() => {
        try { const { getNiche } = require('../data/niches'); return getNiche(nicheId); } catch (_) { return null; }
    })();
    const p = (cfg && cfg.presenterPolicy) || {};
    return {
        minGapScenes: Number.isFinite(p.minGapScenes) ? p.minGapScenes : DEFAULT.minGapScenes,
        holdSeconds: Number.isFinite(p.holdSeconds) ? p.holdSeconds : DEFAULT.holdSeconds,
        floorScoreMin: Number.isFinite(p.floorScoreMin) ? p.floorScoreMin : DEFAULT.floorScoreMin,
        fullframeZones: Array.isArray(p.fullframeZones) ? p.fullframeZones : DEFAULT.fullframeZones,
    };
}

// Score a scene's fitness as a presenter beat + suggest layout + role. score 0 = not a candidate.
function _scoreScene(scene, scriptContext) {
    const text = scene.text || '';
    const zone = _zoneForScene(scene, scriptContext);
    const cls = String(scene.sceneClass || '').toLowerCase();
    const persons = _personEntitiesInText(text, scriptContext);
    const isQuote = cls === 'quote-callout' || QUOTE_RE.test(text);
    const isStat = cls === 'data-claim' || STAT_RE.test(text);
    const isPerson = cls === 'actor-event' || persons.length > 0;
    const isOpinion = OPINION_RE.test(text);
    const isConcept = cls === 'concept-metaphor' || CONCEPT_RE.test(text);

    // Presenters are ALWAYS shown FRAMED (a card on a themed background) — never full-screen
    // cover; a flat full-frame photo isn't right for a presenter. (pip is a rare corner aside.)
    let score = 0, role = 'body', layout = 'framed';
    if (zone === 'hook') { score = 10; role = 'hook'; layout = 'framed'; }
    else if (zone === 'cta') { score = 9; role = 'cta'; layout = 'framed'; }
    else if (isQuote) { score = 6; role = 'quote-beat'; layout = 'framed'; }
    else if (isPerson) { score = 5; role = 'person-intro'; layout = 'framed'; }
    else if (isStat) { score = 5; role = 'stat-beat'; layout = 'framed'; }
    else if (isOpinion) { score = 4; role = 'opinion'; layout = PIP_ENABLED ? 'pip' : 'framed'; }
    else if (isConcept) { score = 3; role = 'concept'; layout = 'framed'; }

    return { score, role, layout, zone, signals: { zone, cls, isQuote, isStat, isPerson, isOpinion, isConcept, persons } };
}

/**
 * Deterministic FALLBACK: sparse presenter SPANS. No count cap — selective (floorScoreMin)
 * + spread (minGapScenes) keeps it naturally rare; each pick extends into a ~holdSeconds hold.
 * @returns {Array<{startSceneIndex,endSceneIndex,layout,decorate,reason,signals}>}
 */
function assignPresenterDispositions(scenes, scriptContext, styleProfile = null, nicheCfg = null, options = {}) {
    if (!Array.isArray(scenes) || scenes.length === 0) return [];
    if (!scriptContext || scriptContext.productionMode !== 'talkingHead') return [];   // faceless: hard skip
    if (!PRESENTER_INSERTS_ENABLED) return [];                                          // kill switch
    if (!scriptContext.presenter || !scriptContext.presenter.imageFile) return [];      // no presenter media → degrade to faceless

    const policy = getPresenterPolicy(scriptContext.nicheId || 'general', nicheCfg);

    const scored = scenes
        .map((scene, i) => ({ i, sceneIndex: scene.index, ..._scoreScene(scene, scriptContext) }))
        .filter(s => s.score >= policy.floorScoreMin);   // selectivity, not a count cap
    if (scored.length === 0) return [];

    // Rank strongest-first; stable tie-break on order → deterministic.
    scored.sort((a, b) => (b.score - a.score) || (a.i - b.i));

    // Greedy pick with a spread (min-gap). No hard maximum.
    const chosen = [];
    const chosenPos = [];
    for (const cand of scored) {
        if (chosenPos.some(pos => Math.abs(pos - cand.i) < policy.minGapScenes)) continue;
        chosen.push(cand);
        chosenPos.push(cand.i);
    }
    if (chosen.length === 0) return [];
    chosen.sort((a, b) => a.i - b.i);

    // Extend each pick into a HOLD (~holdSeconds) across the following beats, without
    // crossing into the next pick — so even the floor produces real holds, not blips.
    const spans = [];
    for (let k = 0; k < chosen.length; k++) {
        const p = chosen[k];
        const startScene = scenes[p.i];
        const nextPos = (k + 1 < chosen.length) ? chosen[k + 1].i : scenes.length;
        let endPos = p.i;
        for (let j = p.i + 1; j < scenes.length && j < nextPos; j++) {
            const held = Number(scenes[j].endTime || 0) - Number(startScene.startTime || 0);
            if (held > policy.holdSeconds) break;
            endPos = j;
        }
        spans.push({
            startSceneIndex: scenes[p.i].index,
            endSceneIndex: scenes[endPos].index,
            layout: p.layout,
            decorate: 'normal',
            reason: `${p.role} (${p.zone}, score ${p.score})`,
            signals: p.signals,
        });
    }
    return spans;
}

function _heavier(a, b) { const rank = { light: 1, normal: 2, heavy: 3 }; return (rank[b] || 2) > (rank[a] || 2) ? (b || 'normal') : (a || 'normal'); }

/**
 * Merge TOUCHING/overlapping same-look presenter spans into ONE continuous hold.
 * Two consecutive talking-head beats (e.g. spans [5-6] and [7-8], with no B-roll
 * between) must render as a single unbroken hold — NOT two separate scenes with a
 * cut between them. The director/floor can emit adjacent spans; this guarantees
 * they collapse so the inner cuts are suppressed across the whole hold. Only same
 * layout merges (a framed hold and a split hold stay distinct); pip never merges
 * (it's a single-beat corner aside); a real B-roll gap (≥1 scene between) is kept.
 */
function _mergeAdjacentSpans(dispositions) {
    if (!Array.isArray(dispositions) || dispositions.length < 2) return dispositions || [];
    const sorted = [...dispositions].sort((a, b) => (a.startSceneIndex - b.startSceneIndex) || 0);
    const merged = [];
    for (const d of sorted) {
        const dStart = d.startSceneIndex;
        const dEnd = (d.endSceneIndex != null) ? d.endSceneIndex : d.startSceneIndex;
        const prev = merged[merged.length - 1];
        const prevEnd = prev ? (prev.endSceneIndex != null ? prev.endSceneIndex : prev.startSceneIndex) : -Infinity;
        const sameLook = prev
            && prev.layout === d.layout
            && d.layout !== 'pip'                                   // pip = single-beat aside, never merge
            && (d.layout !== 'split' || (prev.side || null) === (d.side || null)); // split must share a side
        if (prev && sameLook && dStart <= prevEnd + 1) {            // touching (gap 0) or overlapping → one hold
            prev.endSceneIndex = Math.max(prevEnd, dEnd);
            prev.decorate = _heavier(prev.decorate, d.decorate);
            if (d.reason && prev.reason !== d.reason) prev.reason = `${prev.reason || ''} + ${d.reason}`.slice(0, 180);
            prev._mergedFrom = (prev._mergedFrom || 1) + 1;
        } else {
            merged.push({ ...d, endSceneIndex: dEnd });
        }
    }
    return merged;
}

/**
 * Hard enforce AFTER the Planner. Marks EVERY scene in each span as a presenter anchor
 * (same media/layout), stamps span timing (continuous ken-burns) + spanRole + decorate +
 * inner-cut suppression, and suppresses footage on the hold. Presenter MEDIA is filled
 * later by presenter-provider.resolvePresenterMedia.
 * @returns {{anchors:number, holds:number, insets:number}}
 */
function enforcePresenterDispositions(scenes, dispositions, scriptContext = {}) {
    let anchors = 0, holds = 0, insets = 0;
    if (!Array.isArray(scenes) || !Array.isArray(dispositions) || !dispositions.length) return { anchors, holds, insets };
    // Collapse adjacent same-look holds so two consecutive presenter beats read as
    // ONE continuous hold, not two chopped scenes with a cut between them.
    dispositions = _mergeAdjacentSpans(dispositions);
    const byIndex = new Map(scenes.map(s => [s.index, s]));
    const face = { x: 0.5, y: 0.38 };
    let spanId = 0;

    for (const d of dispositions) {
        const start = d.startSceneIndex;
        const end = (d.endSceneIndex != null) ? d.endSceneIndex : d.startSceneIndex;
        // Presenter looks: 'framed' (card, default), 'split' (split-screen with B-roll),
        // 'pip' (rare corner). Fullscreen presenter is removed → anything else maps to 'framed'.
        const layout = ['pip', 'split'].includes(d.layout) ? d.layout : 'framed';
        const decorate = d.decorate || 'normal';
        const spanScenes = [];
        for (let idx = start; idx <= end; idx++) { const s = byIndex.get(idx); if (s) spanScenes.push(s); }
        if (!spanScenes.length) continue;
        spanId++;
        holds++;
        const spanStartT = Number(spanScenes[0].startTime || 0);
        const spanEndT = Number(spanScenes[spanScenes.length - 1].endTime || spanStartT);

        // PiP is a single-beat corner aside: a multi-beat pip would pop in/out at every
        // inner cut (each beat is its own scene wrap → its own pop animation). Stamp only
        // the first beat so it reads as one clean aside. (Fullframe/framed get continuity.)
        if (layout === 'pip') {
            const s0 = spanScenes[0];
            s0.presenterInsert = { layout: 'pip', corner: 'bottom-right', decorate, spanId, spanRole: 'solo', mediaType: null, mediaFile: null };
            insets++;
            console.log(`   [Presenter] pip inset scene ${s0.index} [${decorate}] — ${d.reason || ''}`);
            continue;
        }
        // SPLIT SCREEN: presenter on one side, the scene's B-roll on the other. KEEPS the
        // footage (still planned + downloaded) — the presenter is a half-panel, not a takeover.
        // Can span multiple beats: the presenter half holds while the B-roll half changes.
        if (layout === 'split') {
            const side = d.side === 'right' ? 'right' : (d.side === 'left' ? 'left' : (spanId % 2 === 0 ? 'left' : 'right'));
            spanScenes.forEach((s, i) => {
                const role = spanScenes.length === 1 ? 'solo' : (i === 0 ? 'start' : (i === spanScenes.length - 1 ? 'end' : 'mid'));
                s.presenterInsert = { layout: 'split', side, decorate, spanId, spanRole: role, anchor: { ...face }, mediaType: null, mediaFile: null };
                s._presenterSplit = true;
                s.framing = 'fullscreen'; // the split container is fullscreen (two half-panels inside)
                insets++;
            });
            console.log(`   [Presenter] split hold #${spanId} scenes ${start}-${end} side=${side} — ${d.reason || ''}`);
            continue;
        }
        spanScenes.forEach((s, i) => {
            const role = spanScenes.length === 1 ? 'solo' : (i === 0 ? 'start' : (i === spanScenes.length - 1 ? 'end' : 'mid'));
            // framed: the presenter IS the scene's base media. hostSide places the presenter
            // card on one side of the "presenter stage"; explanation images slide in the other
            // side (bridge). Same side across the whole hold for continuity; alternate per hold.
            s.presenterInsert = { layout, decorate, spanId, spanRole: role, hostSide: (spanId % 2 === 0) ? 'left' : 'right', anchor: { ...face }, mediaType: null, mediaFile: null, caption: null };
            s._presenterAnchor = true;
            s._presenterSpan = { id: spanId, start: spanStartT, end: spanEndT };
            if (role === 'mid' || role === 'end') s._presenterContinuation = true; // suppress cut INTO this beat (continuous hold)
            s.mediaIntent = { ...(s.mediaIntent || {}), policy: { ...((s.mediaIntent || {}).policy || {}), download: 'skip' } };
            s.fullscreenMG = null; s.mapVariant = undefined; s.templateHint = null; s.mgHint = null;
            s.keyword = null; s.stockQuery = null; s.webQuery = null; s.sourceHint = null; s.mediaType = null;
            s.fit = 'cover'; s.fitMode = 'cover'; s.focusX = face.x; s.focusY = face.y;
            // Framed presenter renders as a "presenter stage" (fullscreen): host card on
            // hostSide + an explanation slot on the other side (bridge). Fullscreen so the
            // stage owns the frame; the host card + slot float on a themed backdrop.
            s.framing = 'fullscreen';
            if (!s.background || /^(none|auto)$/i.test(String(s.background))) s.background = 'soft-charcoal';
            anchors++;
        });
        console.log(`   [Presenter] hold #${spanId} scenes ${start}-${end} [${layout}/${decorate}] ${spanStartT.toFixed(1)}-${spanEndT.toFixed(1)}s — ${d.reason || ''}`);
    }
    return { anchors, holds, insets };
}

function logPresenterDispositions(dispositions, scriptContext = {}) {
    if (!Array.isArray(dispositions) || dispositions.length === 0) {
        console.log(`   [Presenter] no holds (mode=${scriptContext.productionMode || 'faceless'})`);
        return;
    }
    const beats = dispositions.reduce((n, d) => n + ((d.endSceneIndex ?? d.startSceneIndex) - d.startSceneIndex + 1), 0);
    console.log(`   [Presenter] ${dispositions.length} hold(s) across ${beats} beat(s):`);
    for (const d of dispositions) {
        const end = d.endSceneIndex ?? d.startSceneIndex;
        console.log(`     scenes ${d.startSceneIndex}-${end}: ${d.layout}/${d.decorate || 'normal'} — ${d.reason || ''}`);
    }
}

module.exports = {
    assignPresenterDispositions,
    enforcePresenterDispositions,
    logPresenterDispositions,
    getPresenterPolicy,
    _scoreScene,
    _mergeAdjacentSpans,
};
