/**
 * Directive utilities — shared time/scene resolvers + MG-name normalization for
 * the per-scene / time-targeted directive applier (see directive-compiler.js
 * and build-video.js applySceneDirectives).
 *
 * Consolidates logic that used to live as divergent ad-hoc copies inside
 * build-video.js (_parseTimestamp/_resolveMGAlias/_forceFullscreenMG) and
 * build-orchestrator.js (scene-covering-a-time), so scene resolution is done
 * one way everywhere.
 */
'use strict';

const DIRECTIVE_MG_ALIASES = {
    'map': 'mapChart', 'maps': 'mapChart', 'map animation': 'mapChart', 'map chart': 'mapChart',
    'split screen': 'splitScreen', 'split-screen': 'splitScreen', 'splitscreen': 'splitScreen',
    'infographic': 'infographic', 'infographics': 'infographic',
    'comparison': 'comparisonCard', 'compare': 'comparisonCard',
    'stat': 'statCard', 'stats': 'statCard', 'statistics': 'statCard',
    'fact': 'factCard', 'facts': 'factCard',
    'chart': 'barChart', 'bar chart': 'barChart',
    'timeline': 'timelineCard',
    'quote': 'quoteCard',
    'chapter': 'chapterCard',
    'person': 'personIntro', 'person intro': 'personIntro',
    'location': 'locationCard',
    'image showcase': 'imageShowcase', 'showcase': 'imageShowcase',
    'donut': 'donutChart', 'donut chart': 'donutChart',
    'ranking': 'rankingList',
};

// "22s" → 22, "1:30" → 90, "0:22" → 22, "3m" → 180. Tolerates a dot-typo for a
// colon ("0.22s" → 22s) only when the fractional part is ≤59 and 2 digits.
function parseTimestamp(str) {
    if (str == null) return null;
    if (typeof str === 'number') return Number.isFinite(str) ? str : null;
    str = String(str).trim().toLowerCase();
    const mmss = str.match(/^(\d{1,3}):(\d{2})$/);
    if (mmss) return parseInt(mmss[1]) * 60 + parseInt(mmss[2]);
    const dotMMSS = str.match(/^(\d{1,3})\.(\d{2})\s*s?(?:ec(?:onds?)?)?$/);
    if (dotMMSS) {
        const mm = parseInt(dotMMSS[1]);
        const ss = parseInt(dotMMSS[2]);
        if (ss <= 59) return mm * 60 + ss;
    }
    const sec = str.match(/^(\d+(?:\.\d+)?)\s*s(?:ec(?:onds?)?)?$/);
    if (sec) return parseFloat(sec[1]);
    const min = str.match(/^(\d+(?:\.\d+)?)\s*m(?:in(?:utes?)?)?$/);
    if (min) return parseFloat(min[1]) * 60;
    const bare = str.match(/^(\d+(?:\.\d+)?)$/);
    if (bare) return parseFloat(bare[1]);
    return null;
}

// Normalize a user-written graphic name to a canonical MG/template type id.
function resolveMGAlias(text) {
    if (!text) return null;
    text = String(text).trim().toLowerCase().replace(/['"]/g, '');
    if (DIRECTIVE_MG_ALIASES[text]) return DIRECTIVE_MG_ALIASES[text];
    try {
        const { FULLSCREEN_MG_TYPES } = require('../agents/ai-motion-graphics');
        if (FULLSCREEN_MG_TYPES && FULLSCREEN_MG_TYPES.has(text)) return text;
    } catch (_) { /* optional */ }
    try {
        const { TEMPLATE_TYPES } = require('../agents/ai-templates');
        if (TEMPLATE_TYPES && TEMPLATE_TYPES.has(text)) return text;
    } catch (_) { /* optional */ }
    for (const [alias, type] of Object.entries(DIRECTIVE_MG_ALIASES)) {
        if (text.includes(alias) || alias.includes(text)) return type;
    }
    return null;
}

function _start(s) { return Number(s.startTime) || 0; }
function _end(s) { const e = Number(s.endTime); return Number.isFinite(e) ? e : _start(s) + 3; }

// Scenes whose span contains time t (seconds). start <= t < end.
function coversTime(scenes, t) {
    const tt = Number(t);
    return (scenes || []).filter(s => s && _start(s) <= tt && _end(s) > tt);
}

// Scenes whose span overlaps [a, b) (seconds).
function coversRange(scenes, a, b) {
    const aa = Number(a), bb = Number(b);
    return (scenes || []).filter(s => s && _start(s) < bb && _end(s) > aa);
}

// Scenes within the opening [0, t] window (overlap-based).
function coversFirst(scenes, t) {
    return coversRange(scenes, 0, Number(t));
}

// Resolve a USER-FACING 1-based scene number to the plan's 0-based scene.index.
// Fixes the historical off-by-one where "scene 5" matched scene.index === 5.
function resolveSceneIndex(scenes, oneBased) {
    const n = parseInt(oneBased, 10);
    if (!Number.isFinite(n)) return null;
    return (scenes || []).find(s => s && s.index === n - 1) || null;
}

// Resolve a directive `when` clause to the scene(s) it targets.
function resolveWhen(when, scenes) {
    if (!when) return [];
    switch (when.kind) {
        case 'time': return coversTime(scenes, when.at);
        case 'range': return coversRange(scenes, when.from, when.to);
        case 'first': return coversFirst(scenes, when.to);
        case 'sceneIndex': { const s = resolveSceneIndex(scenes, when.sceneFrom); return s ? [s] : []; }
        case 'sceneRange': { const out = []; for (let n = when.sceneFrom; n <= when.sceneTo; n++) { const s = resolveSceneIndex(scenes, n); if (s) out.push(s); } return out; }
        default: return [];
    }
}

// Deterministic per-scene / time-targeted directive applier. Reads a compiled
// directives.perScene[] (from directive-compiler) and applies each entry's
// set/remove to the scene(s) its `when` resolves to. Every written field is
// recorded on scene._directiveLock (a serializable array) so CEO workers + the
// compliance loop honor the creator's explicit per-scene order. Pure — no I/O
// beyond console logging. Shared by build-video (Step 4.1) and directive-actuator
// (post-build acting agent).
function applySceneDirectives(directives, scenes, scriptContext, opts = {}) {
    const perScene = directives && Array.isArray(directives.perScene) ? directives.perScene : null;
    if (!perScene || !perScene.length || !Array.isArray(scenes) || !scenes.length) return 0;
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);

    const lockField = (scene, field) => {
        if (!Array.isArray(scene._directiveLock)) scene._directiveLock = [];
        if (!scene._directiveLock.includes(field)) scene._directiveLock.push(field);
    };

    let touched = 0;
    for (const entry of perScene) {
        const targets = resolveWhen(entry.when, scenes);
        if (!targets.length) {
            log(`   ⚠️ [Directive] per-scene order "${entry.raw || entry.when.kind}" matched no scenes`);
            continue;
        }
        for (const scene of targets) {
            const set = entry.set || {};
            const remove = Array.isArray(entry.remove) ? entry.remove : [];
            for (const field of remove) {
                scene[field] = null;
                if ((field === 'fullscreenMG' || field === 'templateHint') && !scene.sourceHint) scene.sourceHint = 'stock';
                lockField(scene, field);
            }
            if (set.fullscreenMG) {
                scene.fullscreenMG = `${set.fullscreenMG}: ${String(scene.text || '').slice(0, 80)}`;
                scene.keyword = null; scene.stockQuery = null; scene.sourceHint = null;
                lockField(scene, 'fullscreenMG');
            }
            if (set.templateHint) {
                scene.templateHint = `${set.templateHint}: ${String(scene.text || '').slice(0, 80)}`;
                scene.keyword = null; scene.stockQuery = null; scene.sourceHint = null;
                lockField(scene, 'templateHint');
            }
            if (set.framing) { scene.framing = set.framing; lockField(scene, 'framing'); }
            if (set.transition) { scene.transition = { type: set.transition.type, duration: set.transition.duration }; scene._txDirected = true; lockField(scene, 'transition'); }
            if (set.mediaType) { scene.mediaType = set.mediaType; lockField(scene, 'mediaType'); }
            if (set.sourceHint) { scene.sourceHint = set.sourceHint; lockField(scene, 'sourceHint'); }
            if (set.keyword) { scene.keyword = set.keyword; scene.visualIntent = set.keyword; lockField(scene, 'keyword'); }
            if (set.effect) { scene._directiveEffect = { ...(scene._directiveEffect || {}), ...set.effect }; lockField(scene, 'effect'); }
            touched++;
            const changed = Object.keys(set).concat(remove.map(r => '-' + r));
            log(`   ⚡ [Directive] ${entry.when.kind} → scene ${scene.index}: ${changed.join(', ')}`);
        }
    }
    return touched;
}

module.exports = {
    DIRECTIVE_MG_ALIASES,
    parseTimestamp,
    resolveMGAlias,
    coversTime,
    coversRange,
    coversFirst,
    resolveSceneIndex,
    resolveWhen,
    applySceneDirectives,
};
