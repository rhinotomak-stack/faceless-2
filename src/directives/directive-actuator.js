/**
 * Directive Actuator — the "talk to the system, it does it" bridge for the
 * POST-BUILD acting agent (QA chat / timeline right-click free-text).
 *
 * Instead of a parallel intent parser, it REUSES the build-time machinery:
 *   1. compile the free-text order → structured directives (directive-compiler)
 *   2. apply per-scene field writes to the loaded plan (directive-util.applySceneDirectives)
 *   3. run the compliance fixers for the global slices (compliance-loop.auditCompliance)
 *      — the same deterministic writers that enforce "hard cuts / no grain / fullscreen /
 *      no maps / no icons" during the build
 *   4. return the scenes whose footage must be RE-DOWNLOADED (keyword/source/mediaType
 *      changes), so the caller routes those through the real media system (never a fake).
 *
 * So an order typed after the build produces the exact same result as if it had
 * been typed before the build — one contract, one enforcement path.
 */
'use strict';

const { compileDirectives, directivesFloor } = require('./directive-compiler');
const { applySceneDirectives, resolveWhen } = require('./directive-util');
const { auditCompliance } = require('./compliance-loop');
const { applyFramingPreset } = require('./framing-preset');
const { applySceneEffectPreset } = require('./effect-preset');

const ACTION_SLICES = ['footage', 'effects', 'transitions', 'framing', 'graphics', 'icons', 'maps'];

// Does a compiled directives object carry anything ACTIONABLE (an order), vs a
// pure Q&A message ("why is scene 3 blurry?") that has no actionable slice?
function hasActions(d) {
    if (!d) return false;
    if (Array.isArray(d.perScene) && d.perScene.length) return true;
    return ACTION_SLICES.some(k => d[k] && Object.keys(d[k]).length);
}

// Compile a free-text order into structured directives (+ a human summary). Used
// by the chat router to decide order-vs-question and to show a confirm chip.
async function previewOrder(text, ctx = {}, opts = {}) {
    const order = String(text || '').trim();
    if (!order) return { directives: null, summary: '', hasActions: false };
    let directives = null;
    try {
        directives = await compileDirectives({ freeInstructions: order }, ctx, { projectDir: null, log: opts.log || (() => {}) });
    } catch (_) { directives = null; }
    if (!directives) directives = directivesFloor(order);
    return { directives, summary: (directives && directives.summary) || order, hasActions: hasActions(directives) };
}

// Merge a freshly-compiled order's slices over the plan's existing directives.
function _mergeDirectives(existing, incoming) {
    const out = { ...(existing || {}) };
    for (const k of ['footage', 'effects', 'transitions', 'framing', 'graphics', 'icons', 'maps', 'pacing']) {
        if (incoming[k]) out[k] = { ...(out[k] || {}), ...incoming[k] };
    }
    if (Array.isArray(incoming.perScene) && incoming.perScene.length) {
        out.perScene = [...(Array.isArray(existing && existing.perScene) ? existing.perScene : []), ...incoming.perScene];
    }
    out.raw = incoming.raw || out.raw;
    out.summary = incoming.summary || out.summary;
    out.overrideHouseRules = true;
    return out;
}

/**
 * Apply a compiled order to an EXISTING built plan (mutates plan in place).
 * @returns {{changed:number, needsFootage:Array<{index,keyword,sourceHint,mediaType}>, report:Object|null}}
 */
async function applyOrderToPlan(plan, directives, opts = {}) {
    if (!plan || !directives) return { changed: 0, needsFootage: [], report: null };
    plan.scriptContext = plan.scriptContext || {};
    plan.scriptContext._directives = _mergeDirectives(plan.scriptContext._directives, directives);

    const scenes = (plan.scenes || []).filter(s => s && !s.isMGScene);
    const touched = applySceneDirectives(directives, scenes, plan.scriptContext, { log: opts.log });

    let report = null;
    try { report = await auditCompliance(plan, { log: opts.log }); } catch (_) { /* non-fatal */ }

    // Footage re-download needs: per-scene keyword/source/mediaType changes that are
    // NOT MG/template lanes. Global footage prefs (avoidStock/preferReal/banned) are
    // advisory (steer future picks) — not an automatic full re-fetch.
    const needsFootage = [];
    for (const entry of (Array.isArray(directives.perScene) ? directives.perScene : [])) {
        const set = entry.set || {};
        if (set.fullscreenMG || set.templateHint) continue;
        if (!(set.keyword || set.mediaType || set.sourceHint)) continue;
        for (const s of resolveWhen(entry.when, scenes)) {
            needsFootage.push({ index: s.index, keyword: set.keyword || s.keyword, sourceHint: set.sourceHint || s.sourceHint, mediaType: set.mediaType || s.mediaType });
        }
    }
    return { changed: touched, needsFootage, report };
}

/**
 * Apply a free-text order to a SINGLE scene (timeline right-click free-text).
 * Maps the order's global slices onto this one scene deterministically.
 * @returns {{success:boolean, error?:string, scene?:Object, change?:string}}
 */
async function applyOrderToScene(scene, order, scriptContext = {}, opts = {}) {
    if (!scene) return { success: false, error: 'no scene supplied' };
    const { directives } = await previewOrder(order, { themeId: scriptContext.themeId, nicheId: scriptContext.nicheId }, opts);
    if (!directives) return { success: false, error: 'could not parse instruction' };
    const changes = [];
    if (directives.framing && directives.framing.force) {
        const applied = applyFramingPreset(scene, directives.framing.force);
        if (applied.changed) changes.push(`framing → ${directives.framing.force}`);
    }
    if (directives.transitions && directives.transitions.style === 'hard-cuts') { scene.transition = { type: 'cut', duration: 0 }; scene._txDirected = true; changes.push('transition → cut'); }
    if (directives.effects && directives.effects.noGrain) {
        if (applySceneEffectPreset(scene, { noGrain: true }).changed) changes.push('no grain');
    }
    if (directives.effects && directives.effects.grade) {
        if (applySceneEffectPreset(scene, { grade: directives.effects.grade }).changed) {
            changes.push(`grade → ${directives.effects.grade}`);
        }
    }
    if (directives.maps && directives.maps.want === 'none' && /^mapchart/i.test(String(scene.fullscreenMG || ''))) { scene.fullscreenMG = null; if (!scene.sourceHint) scene.sourceHint = 'stock'; changes.push('removed map'); }
    if (directives.icons && directives.icons.allow === false && Array.isArray(scene._iconMoments)) { scene._iconMoments = []; changes.push('removed icons'); }
    if (!changes.length) return { success: false, error: 'no actionable per-scene change from that instruction' };
    return { success: true, scene, change: changes.join(', ') };
}

module.exports = { previewOrder, applyOrderToPlan, applyOrderToScene, hasActions };
