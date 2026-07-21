'use strict';

const { sceneMatchesClipRefs, scopeRange, windowOf } = require('./scope-utils');

const STAGE_BY_CAPABILITY = Object.freeze({
    pacing: 10,
    media: 20,
    timeline: 25,
    framing: 30,
    effects: 30,
    graphics: 30,
    icons: 30,
    audio: 35,
    captions: 35,
    transitions: 40,
});

const STAGE_LABELS = Object.freeze({
    10: 'Restructure',
    20: 'Source media',
    25: 'Timeline setup',
    30: 'Compose',
    35: 'Polish',
    40: 'Reconcile',
    50: 'Verify',
});

function _safeToken(value, fallback) {
    const token = String(value || '')
        .replace(/[^a-zA-Z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 72);
    return token || fallback;
}

function _stage(operation) {
    return STAGE_BY_CAPABILITY[operation?.capabilityId] || 30;
}

function _visualBelongsToScenes(visual, scenes) {
    const visualWindow = windowOf(visual, visual?.templateType ? 4 : 3);
    return scenes.some(({ scene, index }) => {
        const clipId = String(scene.clipId || '');
        if (clipId && String(visual?.sourceClipId || '') === clipId) return true;
        const sourceSceneIndex = Number(scene.sourceSceneIndex ?? scene.index ?? index);
        if (
            Number(visual?.sourceSceneIndex) === sourceSceneIndex
            || Number(visual?.sceneIndex) === sourceSceneIndex
            || Number(visual?.sceneIndex) === index
        ) return true;
        const sceneWindow = windowOf(scene);
        return visualWindow.endTime > sceneWindow.startTime + 0.001
            && visualWindow.startTime < sceneWindow.endTime - 0.001;
    });
}

function _compositionRefs(plan, targetScenes, scope) {
    let visualRefs = Array.isArray(scope?.visualRefs) ? scope.visualRefs : [];
    let iconRefs = Array.isArray(scope?.iconRefs) ? scope.iconRefs : [];
    if (scope?.scopeMode === 'scene') {
        const seen = new Set();
        visualRefs = [];
        for (const collection of ['mgScenes', 'templateScenes', 'motionGraphics']) {
            (plan?.[collection] || []).forEach((visual, collectionIndex) => {
                if (!visual || visual.disabled === true || !_visualBelongsToScenes(visual, targetScenes)) return;
                const timing = windowOf(visual, collection === 'templateScenes' ? 4 : 3);
                const id = String(visual.id || visual.clipId || '');
                const key = id || `${collection}:${collectionIndex}:${timing.startTime}:${timing.endTime}`;
                if (seen.has(key)) return;
                seen.add(key);
                visualRefs.push({
                    id: id || `visual-${collectionIndex}-${Math.round(timing.startTime * 1000)}`,
                    type: String(visual.type || visual.templateType || 'motion-graphic'),
                    collection,
                    collectionIndex,
                    trackId: String(visual.trackId || 'video-track-3'),
                    startTime: timing.startTime,
                    endTime: timing.endTime,
                    sourceClipId: String(visual.sourceClipId || ''),
                    sourceSceneIndex: Number.isFinite(Number(visual.sourceSceneIndex))
                        ? Number(visual.sourceSceneIndex)
                        : null,
                    sceneIndex: Number.isFinite(Number(visual.sceneIndex))
                        ? Number(visual.sceneIndex)
                        : null,
                    label: String(visual.text || visual.keyword || visual.type || 'Motion graphic').slice(0, 500),
                });
            });
        }
    }
    if (scope?.scopeMode === 'scene' || iconRefs.length) {
        iconRefs = targetScenes.flatMap(({ scene, index }) => {
            const sceneWindow = windowOf(scene);
            const clipId = String(scene.clipId || `scene-${scene.sourceSceneIndex ?? scene.index ?? index}`);
            return (Array.isArray(scene._iconMoments) ? scene._iconMoments : []).map((moment, momentIndex) => {
                const at = Math.max(0, Number(moment?.at) || 0);
                const duration = Math.max(0.05, Number(moment?.dur ?? moment?.duration) || 2);
                return {
                    id: `${clipId}:icon:${momentIndex}`,
                    clipId,
                    sourceSceneIndex: Number(scene.sourceSceneIndex ?? scene.index ?? index),
                    sceneIndex: index,
                    momentIndex,
                    kind: String(moment?.kind || 'icon'),
                    label: String(moment?.concept || moment?.label || moment?.kind || 'Scene icon').slice(0, 500),
                    position: String(moment?.position || 'top-right'),
                    color: String(moment?.color || ''),
                    scale: Number.isFinite(Number(moment?.scale)) ? Number(moment.scale) : 1,
                    startTime: sceneWindow.startTime + at,
                    endTime: Math.min(sceneWindow.endTime, sceneWindow.startTime + at + duration),
                };
            });
        });
    }
    return { visualRefs, iconRefs };
}

function buildOperationGraph(operations = []) {
    const usedIds = new Set();
    const prepared = operations.map((operation, index) => {
        const baseId = _safeToken(
            operation?.operationId,
            `op-${index + 1}-${operation?.capabilityId || 'edit'}-${operation?.action || 'apply'}`
        );
        let operationId = baseId;
        let suffix = 2;
        while (usedIds.has(operationId)) operationId = `${baseId}-${suffix++}`;
        usedIds.add(operationId);
        return {
            ...operation,
            operationId,
            stage: _stage(operation),
            _sourceOrder: index,
        };
    });
    const ids = new Set(prepared.map((operation) => operation.operationId));
    const pacingIds = prepared
        .filter((operation) => operation.capabilityId === 'pacing')
        .map((operation) => operation.operationId);

    const nodes = prepared.map((operation) => {
        const dependencies = new Set(
            (Array.isArray(operation.dependsOn) ? operation.dependsOn : [])
                .map(String)
                .filter((id) => ids.has(id) && id !== operation.operationId)
        );
        if (operation.capabilityId !== 'pacing') {
            pacingIds.forEach((id) => dependencies.add(id));
        }
        if (operation.capabilityId === 'transitions') {
            prepared
                .filter((candidate) => (
                    candidate.operationId !== operation.operationId
                    && candidate.capabilityId !== 'transitions'
                ))
                .forEach((candidate) => dependencies.add(candidate.operationId));
        }
        return {
            ...operation,
            dependsOn: [...dependencies],
        };
    }).sort((left, right) => (
        left.stage - right.stage || left._sourceOrder - right._sourceOrder
    )).map(({ _sourceOrder, ...operation }) => operation);

    const stages = [];
    for (const operation of nodes) {
        let stage = stages.find((entry) => entry.id === operation.stage);
        if (!stage) {
            stage = {
                id: operation.stage,
                label: STAGE_LABELS[operation.stage] || 'Edit',
                operationIds: [],
            };
            stages.push(stage);
        }
        stage.operationIds.push(operation.operationId);
    }

    return {
        operations: nodes,
        stages,
    };
}

function rebaseScopeAfterStructuralEdit(scope, plan, structuralRange) {
    if (!scope || scope.kind === 'project' || scope.kind === 'visual') return scope;
    const fallback = scopeRange(scope, plan);
    const fromSec = Math.max(0, Number(structuralRange?.fromSec ?? fallback.fromSec) || 0);
    const toSec = Math.max(fromSec, Number(structuralRange?.toSec ?? fallback.toSec) || fromSec);
    const identityScoped = scope.kind === 'clips' || scope.kind === 'playhead';
    const selectedTracks = new Set(
        (scope.clipRefs || []).map((ref) => String(ref?.trackId || '')).filter(Boolean)
    );
    const targetScenes = (plan?.scenes || [])
        .map((scene, index) => ({ scene, index }))
        .filter(({ scene, index }) => {
            if (!scene || scene.isMGScene) return false;
            const timing = windowOf(scene);
            const overlapsRange = timing.endTime > fromSec + 0.001
                && timing.startTime < toSec - 0.001;
            if (!overlapsRange) return false;
            if (!identityScoped) return true;
            const trackId = String(scene.trackId || 'video-track-1');
            if (selectedTracks.size && !selectedTracks.has(trackId)) return false;
            return sceneMatchesClipRefs(
                scene,
                scope.clipRefs,
                index,
                { includeDescendants: true }
            );
        })
        .slice(0, 200);
    const clipRefs = targetScenes.map(({ scene, index }) => ({
            clipId: String(scene.clipId || ''),
            sourceSceneIndex: Number(
                scene.sourceSceneIndex
                ?? scene.index
                ?? index
            ),
            trackId: String(scene.trackId || ''),
            startTime: Number(scene.startTime) || 0,
            endTime: Number(scene.endTime) || 0,
            text: String(scene.text || '').slice(0, 1_500),
            keyword: String(scene.keyword || scene.searchKeyword || '').slice(0, 500),
            mediaType: String(scene.mediaType || ''),
        }));
    const compositionRefs = _compositionRefs(plan, targetScenes, scope);
    return {
        ...scope,
        kind: identityScoped ? 'clips' : 'range',
        label: scope.label || 'Restructured selection',
        fromSec,
        toSec,
        currentTime: Math.max(fromSec, Math.min(toSec, Number(scope.currentTime) || fromSec)),
        totalDuration: Number(plan?.totalDuration) || scope.totalDuration || toSec,
        contiguous: true,
        clipRefs,
        visualRefs: compositionRefs.visualRefs,
        iconRefs: compositionRefs.iconRefs,
    };
}

module.exports = {
    STAGE_BY_CAPABILITY,
    buildOperationGraph,
    rebaseScopeAfterStructuralEdit,
};
