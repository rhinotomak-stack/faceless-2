'use strict';

const MAX_REQUEST_CHARS = 12_000;
const MAX_HISTORY_ITEMS = 30;
const MAX_HISTORY_CHARS = 8_000;
const MAX_SCOPE_ITEMS = 200;
const MAX_TIMELINE_SECONDS = 24 * 60 * 60;

const SCOPE_KINDS = new Set(['project', 'clips', 'range', 'visual', 'playhead']);
const SCOPE_MODES = new Set(['selection', 'scene', 'project']);

function _text(value, max = 500) {
    return String(value == null ? '' : value).trim().slice(0, max);
}

function _number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function _time(value, fallback = 0) {
    return Math.max(0, Math.min(MAX_TIMELINE_SECONDS, _number(value, fallback)));
}

function _optionalIndex(value) {
    if (value == null || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function normalizeHistory(history) {
    if (!Array.isArray(history)) return [];
    return history.slice(-MAX_HISTORY_ITEMS).map((item) => ({
        role: item?.role === 'model' ? 'model' : 'user',
        text: _text(item?.text, MAX_HISTORY_CHARS),
    })).filter((item) => item.text);
}

function normalizeClipRef(ref, fallbackIndex = 0) {
    const startTime = _time(ref?.startTime, 0);
    const endTime = Math.max(startTime, _time(ref?.endTime, startTime));
    const sourceSceneIndex = Math.trunc(_number(
        ref?.sourceSceneIndex ?? ref?.sceneIndex ?? ref?.index,
        fallbackIndex
    ));
    return {
        clipId: _text(ref?.clipId, 240),
        sourceSceneIndex,
        trackId: _text(ref?.trackId, 80),
        startTime,
        endTime,
        text: _text(ref?.text, 1_500),
        keyword: _text(ref?.keyword, 500),
        mediaType: _text(ref?.mediaType, 40),
    };
}

function normalizeVisualRef(ref, fallbackIndex = 0) {
    const startTime = _time(ref?.startTime, 0);
    const endTime = Math.max(startTime, _time(ref?.endTime, startTime));
    return {
        id: _text(ref?.id || ref?.clipId, 240) || `visual-${fallbackIndex}`,
        type: _text(ref?.type || ref?.templateType, 100),
        collection: _text(ref?.collection, 80),
        collectionIndex: _optionalIndex(ref?.collectionIndex),
        trackId: _text(ref?.trackId, 80),
        startTime,
        endTime,
        sourceClipId: _text(ref?.sourceClipId, 240),
        sourceSceneIndex: _optionalIndex(ref?.sourceSceneIndex),
        sceneIndex: _optionalIndex(ref?.sceneIndex),
        label: _text(ref?.label || ref?.text, 500),
    };
}

function normalizeIconRef(ref, fallbackIndex = 0) {
    const startTime = _time(ref?.startTime, 0);
    const endTime = Math.max(startTime, _time(ref?.endTime, startTime));
    return {
        id: _text(ref?.id, 300) || `icon-${fallbackIndex}`,
        clipId: _text(ref?.clipId || ref?.sourceClipId, 240),
        sourceSceneIndex: _optionalIndex(ref?.sourceSceneIndex),
        sceneIndex: _optionalIndex(ref?.sceneIndex),
        momentIndex: _optionalIndex(ref?.momentIndex),
        kind: _text(ref?.kind, 80),
        label: _text(ref?.label || ref?.concept || ref?.keyword, 500),
        position: _text(ref?.position, 80),
        color: _text(ref?.color, 120),
        scale: Math.max(0.25, Math.min(3, _number(ref?.scale, 1))),
        startTime,
        endTime,
    };
}

function normalizeScope(scope) {
    const raw = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : {};
    const kind = SCOPE_KINDS.has(raw.kind) ? raw.kind : 'project';
    const requestedMode = SCOPE_MODES.has(raw.scopeMode) ? raw.scopeMode : '';
    const scopeMode = kind === 'project'
        ? 'project'
        : (requestedMode === 'scene' ? 'scene' : 'selection');
    const clipRefs = Array.isArray(raw.clipRefs)
        ? raw.clipRefs.slice(0, MAX_SCOPE_ITEMS).map(normalizeClipRef)
        : [];
    const visualRefs = Array.isArray(raw.visualRefs)
        ? raw.visualRefs.slice(0, MAX_SCOPE_ITEMS).map(normalizeVisualRef)
        : [];
    const iconRefs = Array.isArray(raw.iconRefs)
        ? raw.iconRefs.slice(0, MAX_SCOPE_ITEMS).map(normalizeIconRef)
        : [];

    let fromSec = _time(raw.fromSec, 0);
    let toSec = Math.max(fromSec, _time(raw.toSec, fromSec));
    if (kind === 'clips' && clipRefs.length) {
        fromSec = Math.min(...clipRefs.map((ref) => ref.startTime));
        toSec = Math.max(...clipRefs.map((ref) => ref.endTime));
    } else if (kind === 'visual' && visualRefs.length) {
        fromSec = Math.min(...visualRefs.map((ref) => ref.startTime));
        toSec = Math.max(...visualRefs.map((ref) => ref.endTime));
    }

    return {
        kind,
        scopeMode,
        label: _text(raw.label, 240) || 'Whole project',
        fromSec,
        toSec,
        currentTime: _time(raw.currentTime, fromSec),
        totalDuration: _time(raw.totalDuration, toSec),
        contiguous: raw.contiguous !== false,
        clipRefs,
        visualRefs,
        iconRefs,
    };
}

function normalizeAgentRequest(payload) {
    const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const text = _text(raw.text, MAX_REQUEST_CHARS);
    if (!text) {
        const error = new Error('Agent request is empty');
        error.code = 'AGENT_EMPTY_REQUEST';
        throw error;
    }
    return {
        text,
        originalText: _text(raw.originalText || raw.text, MAX_REQUEST_CHARS),
        effort: raw.effort === 'smart' ? 'smart' : 'fast',
        scope: normalizeScope(raw.scope),
        history: normalizeHistory(raw.history),
        contextResolution: raw.contextResolution && typeof raw.contextResolution === 'object'
            ? {
                applied: raw.contextResolution.applied === true,
                inheritedScope: raw.contextResolution.inheritedScope === true,
                capabilityIds: Array.isArray(raw.contextResolution.capabilityIds)
                    ? raw.contextResolution.capabilityIds.slice(0, 16).map((id) => _text(id, 80)).filter(Boolean)
                    : [],
                note: _text(raw.contextResolution.note, 500),
            }
            : {
                applied: false,
                inheritedScope: false,
                capabilityIds: [],
                note: '',
            },
        projectRevision: Math.max(0, Math.trunc(_number(raw.projectRevision, 0))),
        planHash: _text(raw.planHash, 160),
        visualContext: raw.visualContext && typeof raw.visualContext === 'object'
            ? {
                captured: raw.visualContext.captured === true,
                imageBase64: _text(raw.visualContext.imageBase64, 5 * 1024 * 1024),
                mimeType: /^image\/(?:png|jpeg|webp)$/i.test(String(raw.visualContext.mimeType || ''))
                    ? String(raw.visualContext.mimeType).toLowerCase()
                    : 'image/jpeg',
                currentTime: Math.max(0, _number(raw.visualContext.currentTime, 0)),
                renderer: _text(raw.visualContext.renderer, 80),
                width: Math.max(0, Math.trunc(_number(raw.visualContext.width, 0))),
                height: Math.max(0, Math.trunc(_number(raw.visualContext.height, 0))),
            }
            : null,
    };
}

function normalizePlanId(value) {
    const planId = _text(value, 160);
    if (!/^[a-zA-Z0-9._-]{8,160}$/.test(planId)) {
        const error = new Error('Invalid Agent plan id');
        error.code = 'AGENT_INVALID_PLAN_ID';
        throw error;
    }
    return planId;
}

module.exports = {
    MAX_REQUEST_CHARS,
    normalizeAgentRequest,
    normalizeHistory,
    normalizePlanId,
    normalizeScope,
};
