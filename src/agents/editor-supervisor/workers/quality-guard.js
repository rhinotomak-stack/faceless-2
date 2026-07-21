'use strict';

const timeline = require('../../../project/timeline-contract');
const { verifyPacing } = require('../../../pipeline/pacing-verify');
const { summarizePlanDiff } = require('../plan-diff');
const { containingSceneIndex, windowOf } = require('../scope-utils');

function _repairVisualSceneIndexes(plan) {
    let repaired = 0;
    for (const collection of ['mgScenes', 'templateScenes', 'motionGraphics', 'overlayScenes']) {
        if (!Array.isArray(plan[collection])) continue;
        for (const visual of plan[collection]) {
            const index = containingSceneIndex(plan, Number(visual.startTime) || 0);
            if (index < 0 || Number(visual.sceneIndex) === index) continue;
            visual.sceneIndex = index;
            visual.sourceSceneIndex = plan.scenes[index].sourceSceneIndex ?? plan.scenes[index].index ?? index;
            repaired++;
        }
    }
    return repaired;
}

function _repairTransitions(plan) {
    const ids = new Set((plan.scenes || []).map((scene) => String(scene.clipId || '')));
    const before = Array.isArray(plan.transitions) ? plan.transitions.length : 0;
    plan.transitions = (plan.transitions || []).filter((transition) => {
        if (transition.fromClipId && !ids.has(String(transition.fromClipId))) return false;
        if (transition.toClipId && !ids.has(String(transition.toClipId))) return false;
        return true;
    });
    return before - plan.transitions.length;
}

function _validateCoverage(plan, options = {}) {
    const findings = [];
    const affectedRange = options.affectedRange || null;
    const structural = options.structural === true;
    const tracks = new Map();
    for (const scene of (plan.scenes || [])) {
        if (!scene || scene.isMGScene) continue;
        const track = scene.trackId || 'video-track-1';
        if (!tracks.has(track)) tracks.set(track, []);
        tracks.get(track).push(scene);
    }
    for (const [track, scenes] of tracks) {
        const ordered = scenes.slice().sort((a, b) => Number(a.startTime) - Number(b.startTime));
        for (let index = 0; index < ordered.length; index++) {
            const timing = windowOf(ordered[index]);
            if (!(timing.endTime > timing.startTime + 0.049)) {
                findings.push({
                    severity: 'fail',
                    code: 'invalid_scene_duration',
                    message: `${track} clip ${ordered[index].clipId || index} has an invalid duration`,
                });
            }
            if (index === 0) continue;
            const previous = windowOf(ordered[index - 1]);
            const boundaryInScope = !affectedRange
                || (timing.startTime >= affectedRange.fromSec - 0.08
                    && timing.startTime <= affectedRange.toSec + 0.08);
            if (structural && boundaryInScope && timing.startTime < previous.endTime - 0.05) {
                findings.push({
                    severity: 'fail',
                    code: 'scene_overlap',
                    message: `${track} clips overlap at ${timing.startTime.toFixed(2)}s`,
                });
            }
            if (structural && boundaryInScope && track === 'video-track-1' && timing.startTime > previous.endTime + 0.08) {
                findings.push({
                    severity: 'fail',
                    code: 'base_track_gap',
                    message: `Base video track has a ${(timing.startTime - previous.endTime).toFixed(2)}s gap`,
                });
            }
        }
    }
    return findings;
}

function _validateAffectedWordSync(plan, affectedRange) {
    if (!affectedRange) return [];
    const findings = [];
    for (const scene of (plan.scenes || [])) {
        const timing = windowOf(scene);
        if (timing.endTime <= affectedRange.fromSec || timing.startTime >= affectedRange.toSec) continue;
        const words = Array.isArray(scene.words) ? scene.words : [];
        if (words.length < 4) continue;
        const outside = words.filter((word) => {
            const start = Number(word?.start ?? word?.startTime);
            const end = Number(word?.end ?? word?.endTime ?? start);
            return !Number.isFinite(start) || end < timing.startTime - 0.6 || start > timing.endTime + 0.6;
        }).length;
        if (outside / words.length > 0.25) {
            findings.push({
                severity: 'fail',
                code: 'affected_word_scene_drift',
                message: `Clip ${scene.clipId} has ${outside}/${words.length} narration words outside its edited window`,
            });
        }
    }
    return findings;
}

function _validateMediaContracts(plan) {
    const findings = [];
    for (const scene of (plan?.scenes || [])) {
        if (!scene?._agentMediaReplacement) continue;
        const staleAliases = [
            'videoFile', 'videoPath', 'imageFile', 'imagePath', 'assetFile', 'assetPath',
        ].filter((field) => scene[field] && scene[field] !== scene.mediaFile);
        if (staleAliases.length) {
            findings.push({
                severity: 'fail',
                code: 'replacement_media_alias_conflict',
                message: `Clip ${scene.clipId} retained stale media aliases: ${staleAliases.join(', ')}`,
            });
        }
        const cropTotal = ['cropTop', 'cropRight', 'cropBottom', 'cropLeft']
            .reduce((sum, field) => sum + Math.abs(Number(scene[field]) || 0), 0);
        if (cropTotal > 0.001 || scene.focusX != null || scene.focusY != null) {
            findings.push({
                severity: 'fail',
                code: 'replacement_media_stale_crop',
                message: `Clip ${scene.clipId} retained crop/focus data from its previous asset`,
            });
        }
        const width = Number(scene.mediaWidth);
        const height = Number(scene.mediaHeight);
        if ((Number.isFinite(width) && width < 0) || (Number.isFinite(height) && height < 0)) {
            findings.push({
                severity: 'fail',
                code: 'replacement_media_invalid_dimensions',
                message: `Clip ${scene.clipId} has invalid replacement media dimensions`,
            });
        }
    }
    return findings;
}

function _validateScopeIntegrity(beforePlan, plan, scope) {
    if (!beforePlan || !scope || scope.kind === 'project') return [];
    const diff = summarizePlanDiff(beforePlan, plan, scope);
    if (!diff.scopeLeakCount) return [];
    return [{
        severity: 'fail',
        code: 'agent_scope_leak',
        message: `${diff.scopeLeakCount} timeline item(s) outside the exact selected scope changed`,
        diff,
    }];
}

function validateAgentDraft(plan, options = {}) {
    const beforeDuration = Number(options.beforePlan?.totalDuration) || 0;
    const fps = Math.max(1, Number(plan?.fps) || 30);
    const normalized = timeline.normalizePlan(plan);
    normalized.scenes = timeline.serializeScenes(normalized.scenes, {
        fps,
        totalDuration: beforeDuration || normalized.totalDuration,
    });
    if (beforeDuration > 0) normalized.totalDuration = beforeDuration;

    const duplicateIds = [];
    const ids = new Set();
    for (const scene of normalized.scenes) {
        if (ids.has(scene.clipId)) duplicateIds.push(scene.clipId);
        ids.add(scene.clipId);
    }
    if (duplicateIds.length) {
        throw new Error(`Agent draft contains duplicate clip ids: ${duplicateIds.slice(0, 3).join(', ')}`);
    }

    const repairedVisualIndexes = _repairVisualSceneIndexes(normalized);
    const removedOrphanTransitions = _repairTransitions(normalized);
    const coverageFindings = _validateCoverage(normalized, options);
    const wordSyncFindings = _validateAffectedWordSync(normalized, options.affectedRange);
    const mediaFindings = _validateMediaContracts(normalized);
    const scopeFindings = _validateScopeIntegrity(options.beforePlan, normalized, options.scope);
    const pacing = verifyPacing(normalized);
    const advisoryPacing = (pacing.findings || []).map((finding) => ({
        ...finding,
        severity: finding.severity === 'fail' ? 'warn' : finding.severity,
    }));
    const findings = [
        ...coverageFindings,
        ...wordSyncFindings,
        ...mediaFindings,
        ...scopeFindings,
        ...advisoryPacing,
    ];
    const failures = [...coverageFindings, ...wordSyncFindings, ...mediaFindings, ...scopeFindings]
        .filter((finding) => finding.severity === 'fail');
    if (failures.length) {
        const error = new Error(`Agent quality guard stopped the edit: ${failures[0].message}`);
        error.code = 'AGENT_QUALITY_GUARD_FAILED';
        error.findings = findings;
        throw error;
    }
    return {
        plan: normalized,
        report: {
            status: findings.length ? 'passed-with-warnings' : 'passed',
            findings,
            repairedVisualIndexes,
            removedOrphanTransitions,
            pacing: pacing.metrics || {},
        },
    };
}

module.exports = {
    validateAgentDraft,
};
