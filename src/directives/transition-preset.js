'use strict';

function _integer(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : null;
}

function _sceneIndex(scene) {
    for (const value of [
        scene?.originalIndex,
        scene?.sourceSceneIndex,
        scene?.sceneIndex,
        scene?.index,
    ]) {
        const parsed = _integer(value);
        if (parsed != null) return parsed;
    }
    return null;
}

function _transitionTouchesScene(transition, scene) {
    if (!transition || !scene) return false;
    const clipId = scene.clipId != null ? String(scene.clipId) : '';
    if (clipId && (
        String(transition.fromClipId || '') === clipId
        || String(transition.toClipId || '') === clipId
    )) return true;

    const index = _sceneIndex(scene);
    if (index != null && (
        _integer(transition.fromSceneIndex) === index
        || _integer(transition.toSceneIndex) === index
    )) return true;

    const boundary = Number(transition.startTime ?? transition.at);
    if (Number.isFinite(boundary)) {
        const start = Number(scene.startTime);
        const end = Number(scene.endTime);
        if (Number.isFinite(start) && Math.abs(boundary - start) < 0.08) return true;
        if (Number.isFinite(end) && Math.abs(boundary - end) < 0.08) return true;
    }
    return false;
}

function _isVisibleTransition(type) {
    const normalized = String(type || '').toLowerCase();
    return normalized && normalized !== 'cut' && normalized !== 'none';
}

function applyHardCuts(plan, targetScenes = null, bannedTypes = []) {
    if (!plan || typeof plan !== 'object') return { changed: false, scenesChanged: 0, transitionsChanged: 0 };
    const scenes = (Array.isArray(targetScenes) ? targetScenes : plan.scenes || [])
        .filter((scene) => scene && !scene.isMGScene);
    const banned = new Set((bannedTypes || []).map((type) => String(type).toLowerCase()));
    const scoped = Array.isArray(targetScenes);
    let scenesChanged = 0;
    let transitionsChanged = 0;

    for (const scene of scenes) {
        const currentTypes = [
            String(scene.transition?.type || '').toLowerCase(),
            String(scene.transitionType || '').toLowerCase(),
        ].filter(Boolean);
        const shouldCut = banned.size
            ? currentTypes.some((type) => banned.has(type))
            : currentTypes.some((type) => _isVisibleTransition(type));
        if (!shouldCut) continue;
        scene.transition = { type: 'cut', duration: 0 };
        scene.transitionType = 'cut';
        scene._txDirected = true;
        scenesChanged++;
    }

    for (const transition of (plan.transitions || [])) {
        const current = String(transition?.type || '').toLowerCase();
        if (!_isVisibleTransition(current) && !banned.has(current)) continue;
        const inScope = !scoped || scenes.some((scene) => _transitionTouchesScene(transition, scene));
        const shouldCut = inScope && (banned.size === 0 || banned.has(current));
        if (!shouldCut) continue;
        transition.type = 'cut';
        transition.duration = 0;
        transitionsChanged++;
    }

    return {
        changed: scenesChanged > 0 || transitionsChanged > 0,
        scenesChanged,
        transitionsChanged,
    };
}

module.exports = {
    applyHardCuts,
};
