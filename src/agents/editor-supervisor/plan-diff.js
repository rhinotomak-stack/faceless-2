'use strict';

const crypto = require('crypto');
const {
    overlaps,
    sceneMatchesClipRefs,
    scopeRange,
    visualMatchesRefs,
    windowOf,
} = require('./scope-utils');

const VISUAL_COLLECTIONS = ['mgScenes', 'templateScenes', 'motionGraphics', 'overlayScenes'];
const MEDIA_FIELDS = [
    'mediaFile', 'mediaPath', 'videoFile', 'videoPath', 'imageFile', 'imagePath',
    'assetFile', 'assetPath', 'mediaType', 'mediaOffset', 'sourceProvider',
    'sourceHint', 'keyword', 'searchKeyword', 'mediaWidth', 'mediaHeight',
    'aspectRatio', 'isVertical',
];
const FRAMING_FIELDS = [
    'framing', 'framingMode', 'fit', 'fitMode', 'scale', 'posX', 'posY',
    'background', 'backgroundId', 'floatingBackground', 'borderRadius', 'shadow',
    'floatingShadow', 'floatingAnim', 'floatingAnimDuration',
    'cropTop', 'cropRight', 'cropBottom', 'cropLeft', 'focusX', 'focusY',
    '_verticalContain', '_verticalContainReason',
];
const EFFECT_FIELDS = [
    'effects', 'effectOverrides', '_effectRecipe', 'colorGrade', 'grade',
];
const ICON_FIELDS = ['_iconMoments'];
const TIMELINE_FIELDS = [
    'trackId', 'disabled', 'mediaOffset', 'kenBurns', 'kenBurnsEnabled',
    'kenBurnsSpeed', 'slideDirection', 'slideSpeed',
];
const CAPTION_FIELDS = [
    'subtitlesEnabled', 'captionStyle', 'captionKaraoke',
    'captionWordsPerCue', 'captionMaxDuration',
];

function _clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function _stable(value) {
    if (Array.isArray(value)) return value.map(_stable);
    if (value && typeof value === 'object') {
        return Object.keys(value).sort().reduce((result, key) => {
            result[key] = _stable(value[key]);
            return result;
        }, {});
    }
    return value;
}

function _hash(value) {
    return crypto.createHash('sha256')
        .update(JSON.stringify(_stable(value)))
        .digest('hex');
}

function _pick(source, fields) {
    return fields.reduce((result, field) => {
        if (source?.[field] !== undefined) result[field] = source[field];
        return result;
    }, {});
}

function _sceneIdentity(scene, index) {
    return String(scene?.clipId || `scene-${index}`);
}

function _visualIdentity(visual, collection, index) {
    return String(visual?.id || visual?.clipId || `${collection}-${index}`);
}

function _meaningfulScene(scene) {
    return {
        startTime: Number(scene?.startTime) || 0,
        endTime: Number(scene?.endTime) || 0,
        text: String(scene?.text || ''),
        words: _clone(scene?.words || []),
        media: _pick(scene, MEDIA_FIELDS),
        framing: _pick(scene, FRAMING_FIELDS),
        effects: _pick(scene, EFFECT_FIELDS),
        icons: _pick(scene, ICON_FIELDS),
        timeline: _pick(scene, TIMELINE_FIELDS),
        transition: _clone(scene?.transition || null),
        transitionType: scene?.transitionType || '',
        fullscreenMG: scene?.fullscreenMG ?? null,
        templateHint: scene?.templateHint ?? null,
        disabled: scene?.disabled === true,
    };
}

function _meaningfulVisual(visual) {
    const copy = _clone(visual || {});
    const timing = windowOf(copy);
    delete copy.sceneIndex;
    delete copy.sourceSceneIndex;
    delete copy.index;
    delete copy.clipId;
    delete copy.startTime;
    delete copy.endTime;
    delete copy.duration;
    delete copy.durationFrames;
    delete copy.durationUnit;
    return {
        ...copy,
        timing,
    };
}

function _fieldChanged(before, after, fields) {
    return _hash(_pick(before, fields)) !== _hash(_pick(after, fields));
}

function _transitionSet(plan) {
    return (plan?.transitions || []).map((transition) => ({
        fromClipId: transition?.fromClipId || '',
        toClipId: transition?.toClipId || '',
        startTime: Number(transition?.startTime ?? transition?.at) || 0,
        type: transition?.type || '',
        duration: Number(transition?.duration) || 0,
    }));
}

function _transitionIdentity(transition, index) {
    return [
        transition?.fromClipId || '',
        transition?.toClipId || '',
        Number(transition?.startTime ?? transition?.at) || 0,
        index,
    ].join(':');
}

function _sfxIdentity(clip, index) {
    return [
        clip?.id || '',
        clip?.file || '',
        Number(clip?.startTime) || 0,
        index,
    ].join(':');
}

function _audioState(plan) {
    return _pick(plan, [
        'audio', 'audioFile', 'audioPath', 'narrationFile', 'narrationPath',
        'narrationVolume', 'musicBed', 'musicBedGain',
    ]);
}

function _captionState(plan) {
    return _pick(plan, CAPTION_FIELDS);
}

function _sceneInScope(scene, index, scope, plan) {
    if (!scope || scope.kind === 'project') return true;
    if (scope.kind === 'visual') return false;
    const clipRefs = Array.isArray(scope.clipRefs) ? scope.clipRefs : [];
    if ((scope.kind === 'clips' || scope.kind === 'playhead') && clipRefs.length) {
        return sceneMatchesClipRefs(scene, clipRefs, index, { includeDescendants: true });
    }
    const range = scopeRange(scope, plan);
    return overlaps(scene, range.fromSec, range.toSec);
}

function _selectedClipIds(scope, plan) {
    const ids = new Set(
        (scope?.clipRefs || []).map((ref) => String(ref?.clipId || '')).filter(Boolean)
    );
    for (const [index, scene] of (plan?.scenes || []).entries()) {
        if (!scene || scene.isMGScene) continue;
        if (_sceneInScope(scene, index, scope, plan)) ids.add(String(scene.clipId || ''));
    }
    return ids;
}

function _visualInScope(visual, scope, plan, collection = '', fallbackIndex = -1) {
    if (!scope || scope.kind === 'project') return true;
    const visualRefs = Array.isArray(scope.visualRefs) ? scope.visualRefs : [];
    if (visualRefs.length && visualMatchesRefs(visual, visualRefs, collection, fallbackIndex)) return true;
    if (scope.kind === 'visual' && visualRefs.length) return false;
    if (scope.kind === 'clips' || scope.kind === 'playhead') {
        const selectedIds = _selectedClipIds(scope, plan);
        if (selectedIds.has(String(visual?.sourceClipId || ''))) return true;
        const sceneIndex = Number(visual?.sceneIndex);
        if (Number.isInteger(sceneIndex) && plan?.scenes?.[sceneIndex]) {
            return _sceneInScope(plan.scenes[sceneIndex], sceneIndex, scope, plan);
        }
        const sourceSceneIndex = Number(visual?.sourceSceneIndex);
        if (Number.isFinite(sourceSceneIndex)) {
            return (scope.clipRefs || []).some((ref) => (
                Number(ref?.sourceSceneIndex) === sourceSceneIndex
            ));
        }
        return false;
    }
    const range = scopeRange(scope, plan);
    return overlaps(visual, range.fromSec, range.toSec);
}

function _transitionInScope(transition, scope, plan) {
    if (!scope || scope.kind === 'project') return true;
    if (scope.kind === 'visual') return false;
    if (scope.kind === 'clips' || scope.kind === 'playhead') {
        const selectedIds = _selectedClipIds(scope, plan);
        return selectedIds.has(String(transition?.fromClipId || ''))
            || selectedIds.has(String(transition?.toClipId || ''));
    }
    const range = scopeRange(scope, plan);
    const at = Number(transition?.startTime ?? transition?.at);
    return Number.isFinite(at)
        && at >= range.fromSec - 0.05
        && at <= range.toSec + 0.05;
}

function summarizePlanDiff(beforePlan, afterPlan, scope) {
    const beforeScenes = (beforePlan?.scenes || []).filter((scene) => scene && !scene.isMGScene);
    const afterScenes = (afterPlan?.scenes || []).filter((scene) => scene && !scene.isMGScene);
    const beforeById = new Map(beforeScenes.map((scene, index) => [_sceneIdentity(scene, index), scene]));
    const afterById = new Map(afterScenes.map((scene, index) => [_sceneIdentity(scene, index), scene]));
    const commonIds = [...beforeById.keys()].filter((id) => afterById.has(id));

    let scenesChanged = 0;
    let mediaChanged = 0;
    let framingChanged = 0;
    let effectsChanged = 0;
    let iconsChanged = 0;
    let timingChanged = 0;
    let timelinePropertiesChanged = 0;
    for (const id of commonIds) {
        const before = beforeById.get(id);
        const after = afterById.get(id);
        if (_hash(_meaningfulScene(before)) !== _hash(_meaningfulScene(after))) scenesChanged++;
        if (_fieldChanged(before, after, MEDIA_FIELDS)) mediaChanged++;
        if (_fieldChanged(before, after, FRAMING_FIELDS)) framingChanged++;
        if (_fieldChanged(before, after, EFFECT_FIELDS)) effectsChanged++;
        if (_fieldChanged(before, after, ICON_FIELDS)) iconsChanged++;
        if (_fieldChanged(before, after, TIMELINE_FIELDS)) timelinePropertiesChanged++;
        if (
            Math.abs((Number(before.startTime) || 0) - (Number(after.startTime) || 0)) > 0.001
            || Math.abs((Number(before.endTime) || 0) - (Number(after.endTime) || 0)) > 0.001
        ) timingChanged++;
    }

    const beforeVisuals = new Map();
    const afterVisuals = new Map();
    for (const collection of VISUAL_COLLECTIONS) {
        (beforePlan?.[collection] || []).forEach((visual, index) => {
            beforeVisuals.set(`${collection}:${_visualIdentity(visual, collection, index)}`, {
                collection,
                visual,
            });
        });
        (afterPlan?.[collection] || []).forEach((visual, index) => {
            afterVisuals.set(`${collection}:${_visualIdentity(visual, collection, index)}`, {
                collection,
                visual,
            });
        });
    }
    const commonVisualIds = [...beforeVisuals.keys()].filter((id) => afterVisuals.has(id));
    const graphicsUpdated = commonVisualIds.filter((id) => (
        _hash(_meaningfulVisual(beforeVisuals.get(id).visual))
        !== _hash(_meaningfulVisual(afterVisuals.get(id).visual))
    )).length;

    let outsideScopeSceneChanges = 0;
    let outsideScopeVisualChanges = 0;
    let outsideScopeTransitionChanges = 0;
    let outsideScopeAudioChanges = 0;
    if (scope?.kind !== 'project') {
        const outsideBeforeScenes = beforeScenes.filter((scene, index) => (
            !_sceneInScope(scene, index, scope, beforePlan)
        ));
        const outsideBeforeSceneIds = new Set();
        for (const [index, scene] of outsideBeforeScenes.entries()) {
            const id = _sceneIdentity(scene, index);
            outsideBeforeSceneIds.add(id);
            const after = afterById.get(id);
            if (!after || _hash(_meaningfulScene(scene)) !== _hash(_meaningfulScene(after))) {
                outsideScopeSceneChanges++;
            }
        }
        for (const [index, scene] of afterScenes.filter((item, itemIndex) => (
            !_sceneInScope(item, itemIndex, scope, afterPlan)
        )).entries()) {
            const id = _sceneIdentity(scene, index);
            if (!outsideBeforeSceneIds.has(id) && !beforeById.has(id)) outsideScopeSceneChanges++;
        }
        const outsideBeforeVisualIds = new Set();
        for (const [id, entry] of beforeVisuals) {
            if (_visualInScope(entry.visual, scope, beforePlan, entry.collection)) continue;
            outsideBeforeVisualIds.add(id);
            const after = afterVisuals.get(id);
            if (!after || _hash(_meaningfulVisual(entry.visual)) !== _hash(_meaningfulVisual(after.visual))) {
                outsideScopeVisualChanges++;
            }
        }
        for (const [id, entry] of afterVisuals) {
            if (_visualInScope(entry.visual, scope, afterPlan, entry.collection)) continue;
            if (!outsideBeforeVisualIds.has(id) && !beforeVisuals.has(id)) outsideScopeVisualChanges++;
        }

        const beforeOutsideTransitions = new Map(
            (beforePlan?.transitions || [])
                .filter((transition) => !_transitionInScope(transition, scope, beforePlan))
                .map((transition, index) => [_transitionIdentity(transition, index), transition])
        );
        const afterOutsideTransitions = new Map(
            (afterPlan?.transitions || [])
                .filter((transition) => !_transitionInScope(transition, scope, afterPlan))
                .map((transition, index) => [_transitionIdentity(transition, index), transition])
        );
        for (const [id, transition] of beforeOutsideTransitions) {
            const after = afterOutsideTransitions.get(id);
            if (!after || _hash(transition) !== _hash(after)) outsideScopeTransitionChanges++;
        }
        for (const id of afterOutsideTransitions.keys()) {
            if (!beforeOutsideTransitions.has(id)) outsideScopeTransitionChanges++;
        }

        const range = scopeRange(scope, beforePlan);
        const sfxOutside = (clip) => !overlaps(clip, range.fromSec, range.toSec);
        const beforeOutsideSfx = new Map(
            (beforePlan?.sfxClips || [])
                .filter(sfxOutside)
                .map((clip, index) => [_sfxIdentity(clip, index), clip])
        );
        const afterOutsideSfx = new Map(
            (afterPlan?.sfxClips || [])
                .filter(sfxOutside)
                .map((clip, index) => [_sfxIdentity(clip, index), clip])
        );
        for (const [id, clip] of beforeOutsideSfx) {
            const after = afterOutsideSfx.get(id);
            if (!after || _hash(clip) !== _hash(after)) outsideScopeAudioChanges++;
        }
        for (const id of afterOutsideSfx.keys()) {
            if (!beforeOutsideSfx.has(id)) outsideScopeAudioChanges++;
        }
    }

    const beforeTransitions = _transitionSet(beforePlan);
    const afterTransitions = _transitionSet(afterPlan);
    const beforeDuration = Number(beforePlan?.totalDuration) || 0;
    const afterDuration = Number(afterPlan?.totalDuration) || 0;
    const beforeAudio = _pick(beforePlan, [
        'audioFile', 'audioPath', 'narrationFile', 'narrationPath', 'audioDuration',
    ]);
    const afterAudio = _pick(afterPlan, [
        'audioFile', 'audioPath', 'narrationFile', 'narrationPath', 'audioDuration',
    ]);
    const beforeSfx = beforePlan?.sfxClips || [];
    const afterSfx = afterPlan?.sfxClips || [];
    const audioChanged = _hash(_audioState(beforePlan)) === _hash(_audioState(afterPlan)) ? 0 : 1;
    const captionsChanged = _hash(_captionState(beforePlan)) === _hash(_captionState(afterPlan)) ? 0 : 1;
    const sfxChanged = _hash(beforeSfx) === _hash(afterSfx)
        ? 0
        : Math.max(beforeSfx.length, afterSfx.length, 1);
    const subtitlesChanged = Boolean(beforePlan?.subtitlesEnabled)
        === Boolean(afterPlan?.subtitlesEnabled)
        ? 0
        : 1;

    return {
        scenesBefore: beforeScenes.length,
        scenesAfter: afterScenes.length,
        scenesAdded: [...afterById.keys()].filter((id) => !beforeById.has(id)).length,
        scenesRemoved: [...beforeById.keys()].filter((id) => !afterById.has(id)).length,
        scenesChanged,
        mediaChanged,
        framingChanged,
        effectsChanged,
        iconsChanged,
        timingChanged,
        timelinePropertiesChanged,
        graphicsAdded: [...afterVisuals.keys()].filter((id) => !beforeVisuals.has(id)).length,
        graphicsRemoved: [...beforeVisuals.keys()].filter((id) => !afterVisuals.has(id)).length,
        graphicsUpdated,
        transitionsChanged: _hash(beforeTransitions) === _hash(afterTransitions)
            ? 0
            : Math.max(beforeTransitions.length, afterTransitions.length, 1),
        audioChanged,
        sfxChanged,
        captionsChanged,
        subtitlesChanged,
        totalDurationDelta: Number((afterDuration - beforeDuration).toFixed(6)),
        narrationPreserved: _hash(beforeAudio) === _hash(afterAudio)
            && Math.abs(afterDuration - beforeDuration) < 0.001,
        outsideScopeSceneChanges,
        outsideScopeVisualChanges,
        outsideScopeTransitionChanges,
        outsideScopeAudioChanges,
        scopeLeakCount: outsideScopeSceneChanges
            + outsideScopeVisualChanges
            + outsideScopeTransitionChanges
            + outsideScopeAudioChanges,
    };
}

function hasMeaningfulChange(diff) {
    return !!diff && (
        diff.scenesAdded > 0
        || diff.scenesRemoved > 0
        || diff.scenesChanged > 0
        || diff.graphicsAdded > 0
        || diff.graphicsRemoved > 0
        || diff.graphicsUpdated > 0
        || diff.transitionsChanged > 0
        || diff.audioChanged > 0
        || diff.sfxChanged > 0
        || diff.captionsChanged > 0
        || diff.subtitlesChanged > 0
        || Math.abs(Number(diff.totalDurationDelta) || 0) > 0.001
    );
}

module.exports = {
    hasMeaningfulChange,
    summarizePlanDiff,
};
