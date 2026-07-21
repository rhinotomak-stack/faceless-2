'use strict';

const timeline = require('../../../project/timeline-contract');
const {
    containingSceneIndex,
    resolveSceneTargets,
    scopeRange,
    windowOf,
} = require('../scope-utils');

const MIN_BEAT_SEC = 0.75;
const EPSILON = 0.001;

function _clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function _relativeMoments(moments, sourceSceneStart, sliceStart, sliceEnd) {
    if (!Array.isArray(moments)) return moments;
    const sliceOffset = sliceStart - sourceSceneStart;
    const sliceDuration = sliceEnd - sliceStart;
    return moments.map((moment) => {
        const relativeStart = Number(moment?.at) || 0;
        const duration = Math.max(0.05, Number(moment?.dur ?? moment?.duration) || 1);
        const relativeEnd = relativeStart + duration;
        const visibleStart = Math.max(relativeStart, sliceOffset);
        const visibleEnd = Math.min(relativeEnd, sliceOffset + sliceDuration);
        if (visibleEnd <= visibleStart + EPSILON) return null;
        const result = {
            ...moment,
            at: visibleStart - sliceOffset,
        };
        if (moment?.dur != null) result.dur = visibleEnd - visibleStart;
        if (moment?.duration != null) result.duration = visibleEnd - visibleStart;
        return result;
    }).filter(Boolean);
}

function _sliceScene(scene, startTime, endTime, pieceIndex, pieceCount, fps) {
    const sourceWindow = windowOf(scene);
    const result = _clone(scene);
    const duration = endTime - startTime;
    const baseId = timeline.safeToken(scene.clipId || `clip-${scene.index || 0}`, 'clip');
    result.clipId = `${baseId}-pace-${Math.round(startTime * 1000)}-${Math.round(endTime * 1000)}-${pieceIndex}`;
    result.startTime = startTime;
    result.endTime = endTime;
    result.duration = duration;
    result.durationFrames = Math.max(1, Math.round(duration * fps));
    result.durationUnit = 'seconds';
    result._agentPacing = {
        ...(scene._agentPacing && typeof scene._agentPacing === 'object' ? scene._agentPacing : {}),
        sourceClipId: scene?._agentPacing?.sourceClipId || scene.clipId,
    };
    result.mediaOffset = Math.max(0, (Number(scene.mediaOffset) || 0) + (startTime - sourceWindow.startTime));
    if (Array.isArray(scene.words)) {
        result.words = scene.words.filter((word) => {
            const wordStart = Number(word?.start ?? word?.startTime);
            const wordEnd = Number(word?.end ?? word?.endTime ?? wordStart);
            if (!Number.isFinite(wordStart)) return false;
            const midpoint = (wordStart + (Number.isFinite(wordEnd) ? wordEnd : wordStart)) / 2;
            const isLastPiece = pieceIndex === pieceCount - 1;
            return midpoint >= startTime - EPSILON
                && (isLastPiece ? midpoint <= endTime + EPSILON : midpoint < endTime - EPSILON);
        }).map((word) => ({ ...word }));
        result.text = result.words.map((word) => word.word || word.text || '').filter(Boolean).join(' ').trim()
            || result.text;
    }
    if (Array.isArray(scene._iconMoments)) {
        result._iconMoments = _relativeMoments(scene._iconMoments, sourceWindow.startTime, startTime, endTime);
    }
    if (Array.isArray(scene._keywordGlow)) {
        result._keywordGlow = _relativeMoments(scene._keywordGlow, sourceWindow.startTime, startTime, endTime);
    }
    if (pieceIndex > 0) {
        result.fullscreenMG = null;
        result.templateHint = null;
        delete result._presenterSpan;
    }
    if (pieceIndex < pieceCount - 1) {
        result.transition = { type: 'cut', duration: 0 };
        result.transitionType = 'cut';
        result._txDirected = true;
    }
    return result;
}

function _splitAtEdges(scenes, fromSec, toSec, fps, shouldEdit) {
    const split = [];
    for (const scene of scenes) {
        const timing = windowOf(scene);
        if (shouldEdit && !shouldEdit(scene)) {
            split.push(scene);
            continue;
        }
        const cuts = [timing.startTime, timing.endTime];
        if (fromSec > timing.startTime + EPSILON && fromSec < timing.endTime - EPSILON) cuts.push(fromSec);
        if (toSec > timing.startTime + EPSILON && toSec < timing.endTime - EPSILON) cuts.push(toSec);
        cuts.sort((a, b) => a - b);
        const unique = cuts.filter((value, index) => index === 0 || Math.abs(value - cuts[index - 1]) > EPSILON);
        if (unique.length === 2) {
            split.push(scene);
            continue;
        }
        for (let index = 0; index < unique.length - 1; index++) {
            split.push(_sliceScene(scene, unique[index], unique[index + 1], index, unique.length - 1, fps));
        }
    }
    return split;
}

function _candidateCuts(scene, desiredDuration) {
    const timing = windowOf(scene);
    const duration = timing.endTime - timing.startTime;
    const count = Math.max(1, Math.min(8, Math.ceil(duration / Math.max(MIN_BEAT_SEC, desiredDuration))));
    if (count <= 1) return [];
    const words = Array.isArray(scene.words) ? scene.words : [];
    const cuts = [];
    for (let part = 1; part < count; part++) {
        const ideal = timing.startTime + duration * (part / count);
        const candidates = words.map((word) => Number(word?.end ?? word?.endTime))
            .filter((time) => (
                Number.isFinite(time)
                && time > timing.startTime + MIN_BEAT_SEC
                && time < timing.endTime - MIN_BEAT_SEC
                && Math.abs(time - ideal) <= Math.max(1.25, desiredDuration * 0.45)
            ))
            .sort((a, b) => Math.abs(a - ideal) - Math.abs(b - ideal));
        const picked = candidates[0] || ideal;
        if (!cuts.length || picked - cuts[cuts.length - 1] >= MIN_BEAT_SEC) cuts.push(picked);
    }
    return cuts.filter((cut, index) => (
        cut - (index ? cuts[index - 1] : timing.startTime) >= MIN_BEAT_SEC
        && timing.endTime - cut >= MIN_BEAT_SEC
    ));
}

function _speedFactor(speed, intensity) {
    if (speed === 'slow') {
        if (intensity === 'strong') return 2.2;
        if (intensity === 'slight') return 1.3;
        return 1.65;
    }
    if (intensity === 'strong') return 0.42;
    if (intensity === 'slight') return 0.78;
    return 0.58;
}

function _punchIn(scene, beatIndex) {
    if (!scene?.mediaFile && !scene?.mediaPath && !scene?.videoFile && !scene?.imageFile) return;
    const current = Number(scene.scale);
    const base = Number.isFinite(current) && current > 0 ? current : 1;
    scene.scale = Math.max(0.1, Math.min(4, base + (beatIndex % 2 === 0 ? 0.06 : 0.1)));
    scene._agentPacingPunch = true;
}

function _fasterScenes(scenes, fromSec, toSec, desiredDuration, fps, shouldEdit) {
    const output = [];
    let splitCount = 0;
    let beatIndex = 0;
    for (const scene of scenes) {
        const timing = windowOf(scene);
        const inScope = timing.startTime >= fromSec - EPSILON
            && timing.endTime <= toSec + EPSILON
            && (!shouldEdit || shouldEdit(scene));
        if (!inScope || timing.endTime - timing.startTime <= Math.max(2.2, desiredDuration * 1.25)) {
            output.push(scene);
            continue;
        }
        const cuts = _candidateCuts(scene, desiredDuration);
        if (!cuts.length) {
            output.push(scene);
            continue;
        }
        const points = [timing.startTime, ...cuts, timing.endTime];
        for (let index = 0; index < points.length - 1; index++) {
            const piece = _sliceScene(scene, points[index], points[index + 1], index, points.length - 1, fps);
            if (index > 0) _punchIn(piece, beatIndex++);
            piece._agentPacing = { speed: 'fast', sourceClipId: scene.clipId };
            output.push(piece);
        }
        splitCount += cuts.length;
    }
    return { scenes: output, splitCount };
}

function _mergeGroup(group, speed, fps) {
    if (group.length === 1) return group[0];
    const first = group[0];
    const last = group[group.length - 1];
    const visualSource = group.find((scene) => (
        scene.mediaFile || scene.mediaPath || scene.videoFile || scene.imageFile
    )) || first;
    const merged = {
        ..._clone(first),
        ...Object.fromEntries([
            'mediaFile', 'mediaPath', 'videoFile', 'videoPath', 'imageFile', 'imagePath',
            'mediaExtension', 'mediaType', 'sourceProvider', 'sourceHint', 'mediaOffset',
            'mediaWidth', 'mediaHeight',
        ].filter((key) => visualSource[key] != null).map((key) => [key, _clone(visualSource[key])])),
    };
    merged.clipId = `${timeline.safeToken(first.clipId || 'clip', 'clip')}-pace-merge-${Math.round(first.startTime * 1000)}-${Math.round(last.endTime * 1000)}`;
    merged.startTime = Number(first.startTime) || 0;
    merged.endTime = Number(last.endTime) || merged.startTime;
    merged.duration = merged.endTime - merged.startTime;
    merged.durationFrames = Math.max(1, Math.round(merged.duration * fps));
    merged.durationUnit = 'seconds';
    merged.text = group.map((scene) => String(scene.text || '').trim()).filter(Boolean).join(' ').trim();
    merged.words = group.flatMap((scene) => Array.isArray(scene.words) ? scene.words.map((word) => ({ ...word })) : []);
    merged._iconMoments = group.flatMap((scene) => {
        const offset = (Number(scene.startTime) || 0) - merged.startTime;
        return (Array.isArray(scene._iconMoments) ? scene._iconMoments : []).map((moment) => ({
            ...moment,
            at: (Number(moment.at) || 0) + offset,
        }));
    });
    merged.transition = _clone(last.transition || { type: speed === 'slow' ? 'crossfade' : 'cut', duration: speed === 'slow' ? 0.5 : 0 });
    merged.transitionType = last.transitionType || merged.transition.type;
    merged._agentPacing = {
        speed: 'slow',
        mergedClipIds: group.flatMap((scene) => (
            Array.isArray(scene?._agentPacing?.mergedClipIds)
                ? scene._agentPacing.mergedClipIds
                : [scene?._agentPacing?.sourceClipId || scene.clipId]
        )),
    };
    merged._agentPacingSources = group.map((scene) => ({
        clipId: scene.clipId,
        mediaFile: scene.mediaFile,
        mediaPath: scene.mediaPath,
        effects: _clone(scene.effects || []),
        effectRecipe: _clone(scene._effectRecipe || []),
        framing: scene.framing || scene.framingMode || '',
    }));
    return merged;
}

function _slowerScenes(scenes, fromSec, toSec, desiredDuration, fps, shouldEdit) {
    const output = [];
    let mergeCount = 0;
    let group = [];
    const flush = () => {
        if (!group.length) return;
        output.push(_mergeGroup(group, 'slow', fps));
        mergeCount += Math.max(0, group.length - 1);
        group = [];
    };
    for (const scene of scenes) {
        const timing = windowOf(scene);
        const inScope = timing.startTime >= fromSec - EPSILON
            && timing.endTime <= toSec + EPSILON
            && (!shouldEdit || shouldEdit(scene));
        if (!inScope) {
            flush();
            output.push(scene);
            continue;
        }
        if (!group.length) {
            group.push(scene);
            continue;
        }
        const first = group[0];
        const previous = group[group.length - 1];
        const contiguous = Math.abs((Number(previous.endTime) || 0) - timing.startTime) <= 0.05;
        const sameTrack = (first.trackId || 'video-track-1') === (scene.trackId || 'video-track-1');
        const mergedDuration = timing.endTime - Number(first.startTime || 0);
        if (!contiguous || !sameTrack || mergedDuration > desiredDuration * 1.25) {
            flush();
            group.push(scene);
        } else {
            group.push(scene);
            if (mergedDuration >= desiredDuration * 0.8) flush();
        }
    }
    flush();
    return { scenes: output, mergeCount };
}

function _rebuildTransitions(plan, fromSec, toSec, speed, shouldEdit) {
    const sceneIds = new Set((plan.scenes || []).map((scene) => String(scene.clipId || '')));
    const editedIds = new Set((plan.scenes || [])
        .filter((scene) => !scene.isMGScene && (!shouldEdit || shouldEdit(scene)))
        .map((scene) => String(scene.clipId || '')));
    const preserved = (plan.transitions || []).filter((transition) => {
        if (transition.fromClipId && !sceneIds.has(String(transition.fromClipId))) return false;
        if (transition.toClipId && !sceneIds.has(String(transition.toClipId))) return false;
        return !editedIds.has(String(transition.fromClipId || ''))
            && !editedIds.has(String(transition.toClipId || ''));
    });
    const generated = [];
    const scenes = (plan.scenes || []).filter((scene) => !scene.isMGScene)
        .slice()
        .sort((a, b) => Number(a.startTime) - Number(b.startTime));
    for (let index = 0; index < scenes.length - 1; index++) {
        const from = scenes[index];
        const to = scenes[index + 1];
        const boundary = Number(to.startTime) || 0;
        if (boundary < fromSec - 0.05 || boundary > toSec + 0.05) continue;
        if ((from.trackId || 'video-track-1') !== (to.trackId || 'video-track-1')) continue;
        const fromEdited = editedIds.has(String(from.clipId || ''));
        const toEdited = editedIds.has(String(to.clipId || ''));
        if (!fromEdited && !toEdited) continue;
        const type = speed === 'fast' ? 'cut' : 'crossfade';
        const duration = speed === 'fast' ? 0 : 0.5;
        generated.push({
            fromClipId: from.clipId,
            toClipId: to.clipId,
            fromSceneIndex: from.index,
            toSceneIndex: to.index,
            startTime: boundary,
            type,
            duration,
            _agentPacing: true,
        });
        if (toEdited) {
            to.transition = { type, duration };
            to.transitionType = type;
            to.transitionIn = type;
        }
    }
    plan.transitions = [...preserved, ...generated].sort((a, b) => (
        Number(a.startTime ?? a.at) - Number(b.startTime ?? b.at)
    ));
}

function _remapVisuals(plan) {
    for (const collection of ['mgScenes', 'templateScenes', 'motionGraphics', 'overlayScenes']) {
        if (!Array.isArray(plan[collection])) continue;
        for (const visual of plan[collection]) {
            const index = containingSceneIndex(plan, Number(visual.startTime) || 0);
            if (index < 0) continue;
            visual.sceneIndex = index;
            visual.sourceSceneIndex = plan.scenes[index].sourceSceneIndex ?? plan.scenes[index].index ?? index;
        }
    }
}

function applyPacingEdit(plan, scope, options = {}) {
    if (!plan || !Array.isArray(plan.scenes)) throw new Error('Pacing edit requires a video plan');
    if (scope?.contiguous === false) throw new Error('Structural pacing requires one contiguous selection or In/Out range');
    const speed = options.speed === 'slow' ? 'slow' : 'fast';
    const intensity = ['slight', 'normal', 'strong'].includes(options.intensity) ? options.intensity : 'normal';
    const fps = Math.max(1, Number(plan.fps) || 30);
    const originalDuration = Number(plan.totalDuration) || 0;
    const { fromSec, toSec } = scopeRange(scope, plan);
    if (!(toSec > fromSec + 0.25)) throw new Error('The selected pacing range is too short');
    const identityScoped = scope?.kind === 'clips' || scope?.kind === 'playhead';
    const originalTargets = resolveSceneTargets(plan, scope, { includeDescendants: true });
    if (!originalTargets.length) throw new Error('No exact footage clips match the active pacing selection');
    const selectedIds = new Set(originalTargets.map((scene) => String(scene.clipId || '')));
    const shouldEdit = identityScoped
        ? (scene) => {
            if (selectedIds.has(String(scene.clipId || ''))) return true;
            if (selectedIds.has(String(scene?._agentPacing?.sourceClipId || ''))) return true;
            return (scene?._agentPacing?.mergedClipIds || [])
                .some((clipId) => selectedIds.has(String(clipId || '')));
        }
        : (scene) => {
            const timing = windowOf(scene);
            return timing.endTime > fromSec + EPSILON && timing.startTime < toSec - EPSILON;
        };
    let scenes = timeline.serializeScenes(plan.scenes, { fps, totalDuration: plan.totalDuration });
    scenes = _splitAtEdges(scenes, fromSec, toSec, fps, shouldEdit);
    const selected = scenes.filter((scene) => {
        const timing = windowOf(scene);
        return timing.startTime >= fromSec - EPSILON
            && timing.endTime <= toSec + EPSILON
            && shouldEdit(scene);
    });
    if (!selected.length) throw new Error('No timeline clips overlap the selected pacing range');
    const averageDuration = selected.reduce((sum, scene) => sum + windowOf(scene).endTime - windowOf(scene).startTime, 0) / selected.length;
    const desiredDuration = Math.max(
        speed === 'fast' ? 1.2 : 2.5,
        averageDuration * _speedFactor(speed, intensity)
    );

    const result = speed === 'fast'
        ? _fasterScenes(scenes, fromSec, toSec, desiredDuration, fps, shouldEdit)
        : _slowerScenes(scenes, fromSec, toSec, desiredDuration, fps, shouldEdit);
    plan.scenes = timeline.serializeScenes(result.scenes, { fps, totalDuration: plan.totalDuration });
    if (originalDuration > 0) plan.totalDuration = originalDuration;
    _rebuildTransitions(plan, fromSec, toSec, speed, shouldEdit);
    _remapVisuals(plan);

    const changed = speed === 'fast' ? result.splitCount : result.mergeCount;
    if (!changed) {
        throw new Error(speed === 'fast'
            ? 'The selected clips are already too short to create a faster structural cut safely'
            : 'The selected range has no adjacent clips that can be merged safely');
    }
    return {
        changed,
        speed,
        intensity,
        fromSec,
        toSec,
        originalSceneCount: scenes.length,
        sceneCount: plan.scenes.length,
        splitCount: result.splitCount || 0,
        mergeCount: result.mergeCount || 0,
        desiredDuration,
    };
}

module.exports = {
    applyPacingEdit,
};
