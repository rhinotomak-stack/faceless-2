'use strict';

const { resolveSceneTargets, windowOf } = require('../scope-utils');

const DEFAULT_DURATIONS = Object.freeze({
    cut: 0,
    crossfade: 0.6,
    'blur-dissolve': 0.6,
    'dip-black': 0.7,
    'whip-left': 0.32,
    'whip-right': 0.32,
    'wipe-left': 0.5,
    'wipe-right': 0.5,
    'wipe-up': 0.5,
    'push-left': 0.5,
    'push-right': 0.5,
    'push-up': 0.5,
    'zoom-punch': 0.38,
    'zoom-pull': 0.5,
    'spin-settle': 0.5,
    'flash-white': 0.35,
    'light-sweep': 0.38,
    glitch: 0.38,
});

function _sceneIndex(plan, scene) {
    const index = plan.scenes.indexOf(scene);
    return Number.isInteger(index) ? index : -1;
}

function _sceneByClipId(plan, clipId) {
    return (plan.scenes || []).find((scene) => (
        scene && String(scene.clipId || '') === String(clipId || '')
    )) || null;
}

function _touchesIds(transition, ids) {
    return ids.has(String(transition?.fromClipId || ''))
        || ids.has(String(transition?.toClipId || ''));
}

function _inferredBoundaries(plan, targets) {
    const targetIds = new Set(targets.map((scene) => String(scene.clipId || '')));
    const byTrack = new Map();
    for (const scene of (plan.scenes || [])) {
        if (!scene || scene.isMGScene) continue;
        const track = String(scene.trackId || 'video-track-1');
        if (!byTrack.has(track)) byTrack.set(track, []);
        byTrack.get(track).push(scene);
    }
    const boundaries = [];
    for (const scenes of byTrack.values()) {
        scenes.sort((left, right) => windowOf(left).startTime - windowOf(right).startTime);
        for (let index = 0; index < scenes.length - 1; index++) {
            const from = scenes[index];
            const to = scenes[index + 1];
            if (!targetIds.has(String(from.clipId || '')) && !targetIds.has(String(to.clipId || ''))) continue;
            if (Math.abs(windowOf(from).endTime - windowOf(to).startTime) > 0.08) continue;
            boundaries.push({
                fromClipId: from.clipId,
                toClipId: to.clipId,
                fromSceneIndex: _sceneIndex(plan, from),
                toSceneIndex: _sceneIndex(plan, to),
                startTime: windowOf(to).startTime,
                type: to.transition?.type || to.transitionType || 'cut',
                duration: Number(to.transition?.duration) || 0,
                _inferred: true,
            });
        }
    }
    return boundaries;
}

function _candidateBoundaries(plan, scope) {
    const targets = resolveSceneTargets(plan, scope, { includeDescendants: true });
    if (!targets.length) throw new Error('No exact footage clips match the active transition scope');
    const targetIds = new Set(targets.map((scene) => String(scene.clipId || '')));
    const existing = (plan.transitions || []).filter((transition) => _touchesIds(transition, targetIds));
    const known = new Set(existing.map((transition) => (
        `${transition.fromClipId || ''}->${transition.toClipId || ''}`
    )));
    const inferred = _inferredBoundaries(plan, targets).filter((transition) => (
        !known.has(`${transition.fromClipId || ''}->${transition.toClipId || ''}`)
    ));
    return { targets, targetIds, boundaries: [...existing, ...inferred] };
}

function _selectBoundaries(boundaries, targetIds, scope, boundaryMode) {
    let candidates = boundaries;
    if (boundaryMode === 'incoming') {
        candidates = candidates.filter((transition) => targetIds.has(String(transition.toClipId || '')));
    } else if (boundaryMode === 'outgoing') {
        candidates = candidates.filter((transition) => targetIds.has(String(transition.fromClipId || '')));
    } else if (boundaryMode !== 'all') {
        const currentTime = Number(scope?.currentTime);
        candidates = candidates.slice().sort((left, right) => {
            if (!Number.isFinite(currentTime)) return 0;
            return Math.abs((Number(left.startTime ?? left.at) || 0) - currentTime)
                - Math.abs((Number(right.startTime ?? right.at) || 0) - currentTime);
        }).slice(0, 1);
    }
    return candidates;
}

function _upsertTransition(plan, transition) {
    plan.transitions = Array.isArray(plan.transitions) ? plan.transitions : [];
    if (!transition._inferred) return transition;
    const copy = { ...transition };
    delete copy._inferred;
    plan.transitions.push(copy);
    return copy;
}

function editScopedTransitions(plan, scope, operation = {}) {
    const { targetIds, boundaries } = _candidateBoundaries(plan, scope);
    if (!boundaries.length) throw new Error('No adjacent transition boundary exists for the active selection');
    const selected = _selectBoundaries(
        boundaries,
        targetIds,
        scope,
        operation.boundary || 'nearest'
    );
    if (!selected.length) throw new Error(`No ${operation.boundary || 'matching'} transition boundary exists for the active selection`);

    let changed = 0;
    const edits = [];
    for (const candidate of selected) {
        const transition = _upsertTransition(plan, candidate);
        const before = JSON.stringify(transition);
        const currentType = String(transition.type || 'cut');
        const type = String(operation.type || currentType);
        const currentDuration = Number(transition.duration) || DEFAULT_DURATIONS[currentType] || 0;
        let duration = currentDuration;
        if (Number.isFinite(Number(operation.duration))) {
            duration = Math.max(0, Math.min(2, Number(operation.duration)));
        } else if (Number.isFinite(Number(operation.durationScale))) {
            duration = Math.max(0, Math.min(2, currentDuration * Number(operation.durationScale)));
        } else if (operation.type && type !== currentType) {
            duration = DEFAULT_DURATIONS[type] ?? 0.5;
        }
        if (type === 'cut' || type === 'none') duration = 0;

        transition.type = type === 'none' ? 'cut' : type;
        transition.duration = duration;
        const toScene = _sceneByClipId(plan, transition.toClipId);
        if (toScene) {
            toScene.transition = { type: transition.type, duration };
            toScene.transitionType = transition.type;
            toScene.transitionIn = transition.type;
        }
        if (before !== JSON.stringify(transition)) {
            changed++;
            edits.push({
                fromClipId: transition.fromClipId || '',
                toClipId: transition.toClipId || '',
                startTime: Number(transition.startTime ?? transition.at) || 0,
                type: transition.type,
                duration,
            });
        }
    }
    plan.transitions.sort((left, right) => (
        (Number(left.startTime ?? left.at) || 0) - (Number(right.startTime ?? right.at) || 0)
    ));
    if (!changed) throw new Error('The selected transition already has those exact properties');
    return { changed, edits };
}

module.exports = {
    DEFAULT_DURATIONS,
    editScopedTransitions,
};
