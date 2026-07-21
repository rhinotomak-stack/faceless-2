'use strict';

const EPSILON = 0.001;

function windowOf(item, fallbackDuration = 0) {
    const startTime = Math.max(0, Number(item?.startTime) || 0);
    const explicitEnd = Number(item?.endTime);
    const endTime = Number.isFinite(explicitEnd) && explicitEnd > startTime
        ? explicitEnd
        : startTime + Math.max(0, Number(item?.duration) || fallbackDuration);
    return { startTime, endTime: Math.max(startTime, endTime) };
}

function overlaps(item, fromSec, toSec) {
    const timing = windowOf(item);
    return timing.endTime > fromSec + EPSILON && timing.startTime < toSec - EPSILON;
}

function scopeRange(scope, plan) {
    const scenes = (plan?.scenes || []).filter((scene) => scene && !scene.isMGScene);
    const totalDuration = Math.max(
        Number(plan?.totalDuration) || 0,
        ...scenes.map((scene) => windowOf(scene).endTime)
    );
    if (scope?.kind === 'project') {
        return { fromSec: 0, toSec: totalDuration };
    }
    const fromSec = Math.max(0, Number(scope?.fromSec) || 0);
    const rawTo = Number(scope?.toSec);
    const toSec = Number.isFinite(rawTo) && rawTo > fromSec
        ? Math.min(totalDuration || rawTo, rawTo)
        : Math.min(totalDuration, fromSec + 0.001);
    return { fromSec, toSec };
}

function _clipRefMatches(scene, ref, fallbackIndex) {
    if (!scene || !ref) return false;
    const refTrack = String(ref.trackId || '');
    const sceneTrack = String(scene.trackId || 'video-track-1');
    if (refTrack && refTrack !== sceneTrack) return false;
    if (ref.clipId && scene.clipId === ref.clipId) return true;
    const sourceIndex = scene.sourceSceneIndex ?? scene.index ?? fallbackIndex;
    if (Number(sourceIndex) !== Number(ref.sourceSceneIndex)) return false;
    const sceneWindow = windowOf(scene);
    return Math.abs(sceneWindow.startTime - Number(ref.startTime || 0)) < 0.05
        && Math.abs(sceneWindow.endTime - Number(ref.endTime || sceneWindow.endTime)) < 0.05;
}

function sceneMatchesClipRefs(scene, refs, fallbackIndex = 0, options = {}) {
    const clipRefs = Array.isArray(refs) ? refs : [];
    if (!scene || !clipRefs.length) return false;
    if (clipRefs.some((ref) => _clipRefMatches(scene, ref, fallbackIndex))) return true;
    if (options.includeDescendants !== true) return false;

    const selectedIds = new Set(
        clipRefs.map((ref) => String(ref?.clipId || '')).filter(Boolean)
    );
    const pacing = scene._agentPacing && typeof scene._agentPacing === 'object'
        ? scene._agentPacing
        : {};
    if (selectedIds.has(String(pacing.sourceClipId || ''))) return true;
    return (Array.isArray(pacing.mergedClipIds) ? pacing.mergedClipIds : [])
        .some((clipId) => selectedIds.has(String(clipId || '')));
}

function resolveSceneTargets(plan, scope, options = {}) {
    const scenes = (plan?.scenes || []).filter((scene) => scene && !scene.isMGScene);
    if (scope?.kind === 'project') return scenes;

    const clipRefs = Array.isArray(scope?.clipRefs) ? scope.clipRefs : [];
    const exact = clipRefs.length
        ? scenes.filter((scene, index) => sceneMatchesClipRefs(
            scene,
            clipRefs,
            index,
            { includeDescendants: options.includeDescendants === true }
        ))
        : [];
    const identityScoped = scope?.kind === 'clips' || scope?.kind === 'playhead';
    if (identityScoped && clipRefs.length) {
        if (exact.length) return exact;
        return options.allowRangeFallback === true ? _resolveRange(scenes, scope, plan) : [];
    }
    if (exact.length && options.preferExact !== false) return exact;

    const ranged = _resolveRange(scenes, scope, plan);
    if (!clipRefs.length || ranged.length) return ranged;
    return exact;
}

function _resolveRange(scenes, scope, plan) {
    const { fromSec, toSec } = scopeRange(scope, plan);
    return scenes.filter((scene) => overlaps(scene, fromSec, toSec));
}

function visualMatchesRefs(visual, refs, collection = '', fallbackIndex = -1) {
    const visualRefs = Array.isArray(refs) ? refs : [];
    if (!visual || !visualRefs.length) return false;
    const id = String(visual.id || visual.clipId || '');
    const replacedId = String(visual._agentReplacesVisualId || '');
    const timing = windowOf(visual, collection === 'templateScenes' ? 4 : 3);
    const type = String(visual.type || visual.templateType || '');
    return visualRefs.some((ref) => {
        const refId = String(ref?.id || '');
        if (refId && (refId === id || refId === replacedId)) return true;
        if (refId && (id || replacedId)) return false;
        if (
            ref?.collection
            && String(ref.collection) === String(collection)
            && Number.isInteger(Number(ref.collectionIndex))
            && Number(ref.collectionIndex) === Number(fallbackIndex)
        ) return true;
        const sameType = !ref?.type || String(ref.type) === type;
        return sameType
            && Math.abs((Number(ref?.startTime) || 0) - timing.startTime) < 0.05
            && Math.abs((Number(ref?.endTime) || timing.endTime) - timing.endTime) < 0.05;
    });
}

function resolveVisualTargets(plan, scope) {
    const arrays = ['mgScenes', 'templateScenes', 'motionGraphics'];
    const all = arrays.flatMap((collection) => (
        Array.isArray(plan?.[collection])
            ? plan[collection].map((visual, index) => ({ collection, index, visual }))
            : []
    ));
    const refs = Array.isArray(scope?.visualRefs) ? scope.visualRefs : [];
    if (refs.length) {
        return all.filter(({ collection, index, visual }) => (
            visualMatchesRefs(visual, refs, collection, index)
        ));
    }
    const { fromSec, toSec } = scopeRange(scope, plan);
    return all.filter(({ visual }) => overlaps(visual, fromSec, toSec));
}

function containingSceneIndex(plan, time) {
    const scenes = plan?.scenes || [];
    let closest = -1;
    let closestDistance = Infinity;
    for (let index = 0; index < scenes.length; index++) {
        const scene = scenes[index];
        if (!scene || scene.isMGScene) continue;
        const timing = windowOf(scene);
        if (time >= timing.startTime - EPSILON && time < timing.endTime + EPSILON) return index;
        const distance = Math.min(Math.abs(time - timing.startTime), Math.abs(time - timing.endTime));
        if (distance < closestDistance) {
            closest = index;
            closestDistance = distance;
        }
    }
    return closest;
}

module.exports = {
    EPSILON,
    containingSceneIndex,
    overlaps,
    resolveSceneTargets,
    resolveVisualTargets,
    sceneMatchesClipRefs,
    scopeRange,
    visualMatchesRefs,
    windowOf,
};
