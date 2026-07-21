'use strict';

const { applyPacingEdit } = require('../workers/pacing-editor');
const { resolveSceneTargets, scopeRange, windowOf } = require('../scope-utils');

function _operation(speed, intensity, request) {
    return {
        capabilityId: 'pacing',
        specialist: 'Pacing Editor',
        action: 'restructure',
        args: { speed, intensity },
        speed,
        intensity,
        scope: request.scope,
        risk: 'structural',
        description: `${speed === 'slow' ? 'slow down' : 'speed up'} the selected visual rhythm`,
        progress: {
            phase: 'pacing',
            message: 'Pacing Editor is rebuilding the selected cut rhythm while preserving narration...',
        },
    };
}

function planFast({ directives, request }) {
    const pacing = directives?.pacing;
    if (!pacing?.speed) return { operations: [], claimedDirectiveKeys: [] };
    if (request.scope.kind === 'visual') {
        return {
            operations: [],
            claimedDirectiveKeys: ['pacing'],
            unsupported: ['Structural pacing needs footage clips or an In/Out range, not only a selected graphic.'],
        };
    }
    if (request.scope.contiguous === false) {
        return {
            operations: [],
            claimedDirectiveKeys: ['pacing'],
            unsupported: ['Structural pacing needs one contiguous selection. Use In/Out or select adjacent clips.'],
        };
    }
    return {
        operations: [_operation(pacing.speed, pacing.intensity || 'normal', request)],
        claimedDirectiveKeys: ['pacing'],
        supported: [`Pacing Editor: ${pacing.speed} structural pacing`],
    };
}

function normalizeInvocation(invocation, context) {
    const action = String(invocation?.action || '');
    const args = invocation?.args || {};
    const speed = args.speed || (action === 'faster' ? 'fast' : (action === 'slower' ? 'slow' : ''));
    if (!['fast', 'slow'].includes(speed)) return null;
    if (context.request.scope.kind === 'visual' || context.request.scope.contiguous === false) return null;
    const intensity = ['slight', 'normal', 'strong'].includes(args.intensity) ? args.intensity : 'normal';
    return _operation(speed, intensity, context.request);
}

function manifest() {
    return {
        id: 'pacing',
        specialist: 'Pacing Editor',
        domain: 'timeline-structure',
        description: 'Splits or merges visual beats while preserving narration timing and timeline coverage.',
        scopes: ['clips', 'range', 'playhead', 'project'],
        risk: 'structural',
        actions: ['faster', 'slower', 'restructure'],
        directiveKeys: ['pacing'],
        vocabulary: { speeds: ['fast', 'slow'], intensities: ['slight', 'normal', 'strong'] },
    };
}

function execute({ plan, operation }) {
    const result = applyPacingEdit(plan, operation.scope, operation.args);
    return {
        changed: result.changed,
        structuralRange: { fromSec: result.fromSec, toSec: result.toSec },
        stats: {
            pacingSplits: result.splitCount || 0,
            pacingMerges: result.mergeCount || 0,
        },
    };
}

function inspect(plan, scope) {
    const targets = resolveSceneTargets(plan, scope, { includeDescendants: true });
    const durations = targets.map((scene) => {
        const timing = windowOf(scene);
        return timing.endTime - timing.startTime;
    }).filter((duration) => duration > 0);
    const range = scopeRange(scope, plan);
    return {
        targetCount: targets.length,
        fromSec: range.fromSec,
        toSec: range.toSec,
        contiguous: scope?.contiguous !== false,
        averageBeatSec: durations.length
            ? Number((durations.reduce((sum, duration) => sum + duration, 0) / durations.length).toFixed(3))
            : 0,
        shortestBeatSec: durations.length ? Number(Math.min(...durations).toFixed(3)) : 0,
        longestBeatSec: durations.length ? Number(Math.max(...durations).toFixed(3)) : 0,
        clipIds: targets.slice(0, 64).map((scene) => scene.clipId || ''),
    };
}

module.exports = { execute, inspect, manifest, normalizeInvocation, planFast };
