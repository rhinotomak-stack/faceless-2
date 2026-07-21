'use strict';

const registry = require('./capabilities/registry');
const { routeRecoveryRequest } = require('./capabilities/smart-router');
const { rebaseScopeAfterStructuralEdit } = require('./operation-graph');
const { hasMeaningfulChange, summarizePlanDiff } = require('./plan-diff');
const { cleanupStage } = require('./transaction-assets');

const RISK_WEIGHT = Object.freeze({
    low: 0,
    moderate: 1,
    expensive: 2,
    structural: 3,
});

const NON_RECOVERABLE_CODES = new Set([
    'AGENT_OPERATION_SCOPE_LEAK',
    'AGENT_SCOPE_LEAK',
    'AGENT_PLAN_CONFLICT',
    'PROJECT_REVISION_CONFLICT',
    'PROJECT_PLAN_CONFLICT',
    'AGENT_QUALITY_GUARD_FAILED',
]);

function _clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function _mergeNumericStats(target, source) {
    for (const [key, value] of Object.entries(source || {})) {
        if (!Number.isFinite(Number(value))) continue;
        target[key] = (Number(target[key]) || 0) + Number(value);
    }
}

function _mergeAssetManifest(current, incoming) {
    if (!incoming) return current;
    if (!current) return incoming;
    if (
        String(current.transactionId || '') !== String(incoming.transactionId || '')
        || String(current.stagingRoot || '') !== String(incoming.stagingRoot || '')
        || String(current.finalRoot || '') !== String(incoming.finalRoot || '')
    ) {
        throw new Error('Specialist asset stages do not belong to one Agent transaction');
    }
    const assets = new Map();
    for (const asset of [...(current.assets || []), ...(incoming.assets || [])]) {
        assets.set(String(asset.finalPath || asset.relativePath || asset.filename), asset);
    }
    return {
        ...current,
        assets: [...assets.values()],
    };
}

function _mergeRange(current, incoming) {
    if (!incoming) return current;
    const fromSec = Number(incoming.fromSec);
    const toSec = Number(incoming.toSec);
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec <= fromSec) return current;
    if (!current) return { fromSec, toSec };
    return {
        fromSec: Math.min(current.fromSec, fromSec),
        toSec: Math.max(current.toSec, toSec),
    };
}

function _compactScope(scope) {
    return {
        kind: scope?.kind || 'project',
        label: scope?.label || 'Whole project',
        fromSec: Number(scope?.fromSec) || 0,
        toSec: Number(scope?.toSec) || 0,
        targetCount: Math.max(
            Number(scope?.clipRefs?.length) || 0,
            Number(scope?.visualRefs?.length) || 0,
            Number(scope?.iconRefs?.length) || 0
        ),
    };
}

function _operationSignature(operation) {
    return JSON.stringify({
        capabilityId: operation?.capabilityId,
        action: operation?.action,
        args: operation?.args,
        scope: operation?.scope,
    });
}

function _isAlreadySatisfied(error) {
    return /\balready\b|\bsatisf(?:y|ied)\b/i.test(String(error?.message || ''));
}

function _isRecoverable(error) {
    if (!error) return false;
    if (NON_RECOVERABLE_CODES.has(String(error.code || ''))) return false;
    return !/\b(?:escaped the project|outside the project|invalid path|permission denied|not authorized)\b/i
        .test(String(error.message || ''));
}

function _sameOrLowerRisk(candidate, approved) {
    return (RISK_WEIGHT[candidate?.risk] ?? 1) <= (RISK_WEIGHT[approved?.risk] ?? 1);
}

function _forceApprovedScope(candidate, approved) {
    return registry.validateOperation({
        ...candidate,
        scope: _clone(approved.scope),
        risk: candidate.risk || approved.risk,
    }, {
        request: { scope: approved.scope },
    });
}

function _cleanupManifests(manifests, options = {}, keepManifest = null) {
    const keepRoot = String(keepManifest?.stagingRoot || '');
    const cleaned = new Set();
    for (const manifest of manifests || []) {
        const stagingRoot = String(manifest?.stagingRoot || '');
        if (!stagingRoot || stagingRoot === keepRoot || cleaned.has(stagingRoot)) continue;
        cleanupStage(manifest, { projectDir: options.projectDir });
        cleaned.add(stagingRoot);
    }
}

async function _findRecovery(plan, operation, error, context) {
    const inspection = registry.inspectCapabilities(plan, operation.scope);
    let candidate = null;
    try {
        candidate = await registry.recoverCapabilityOperation(plan, operation, error, {
            request: {
                text: context.request,
                originalText: context.originalRequest,
                effort: context.effort,
                scope: operation.scope,
            },
            inspection,
            completedOperations: context.completedOperations,
            options: context.options,
        });
    } catch (recoveryError) {
        context.options.log?.(
            `${operation.specialist} recovery hook failed; supervisor fallback remains available: ${recoveryError.message}`
        );
    }
    let strategy = candidate ? 'specialist' : '';

    if (!candidate && context.effort === 'smart') {
        const smartRecovery = context.options.routeRecoveryRequest || routeRecoveryRequest;
        const routed = await smartRecovery({
            request: {
                text: context.request,
                originalText: context.originalRequest,
                effort: context.effort,
                scope: operation.scope,
            },
            plan,
            failedOperation: operation,
            failure: {
                code: String(error?.code || ''),
                message: String(error?.message || '').slice(0, 2_000),
            },
            inspection,
            completedOperations: context.completedOperations,
            log: context.options.log,
        });
        candidate = routed?.operation || null;
        strategy = candidate ? 'supervisor' : '';
    }

    if (!candidate) return null;
    const scoped = _forceApprovedScope(candidate, operation);
    if (!_sameOrLowerRisk(scoped, operation)) return null;
    return { operation: scoped, strategy };
}

async function runAutonomousOperations(initialPlan, operationsValue, context = {}) {
    const operations = Array.isArray(operationsValue) ? operationsValue : [];
    const options = context.options || {};
    const maxAttempts = context.effort === 'smart' ? 3 : 2;
    let working = _clone(initialPlan);
    let assetManifest = null;
    let structuralRange = null;
    let changed = 0;
    const stats = {};
    const operationResults = [];
    const recoveries = [];
    const decisionLog = [];
    const completedOperations = [];
    const stagedManifests = [];

    for (let index = 0; index < operations.length; index++) {
        const approvedOperation = operations[index];
        const effectiveOperation = structuralRange
            ? {
                ...approvedOperation,
                scope: rebaseScopeAfterStructuralEdit(
                    approvedOperation.scope,
                    working,
                    structuralRange
                ),
            }
            : approvedOperation;
        let attemptOperation = effectiveOperation;
        const attempts = [];
        const seen = new Set();
        let completed = false;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            const signature = _operationSignature(attemptOperation);
            seen.add(signature);
            const basePercent = 15 + Math.round((index / Math.max(1, operations.length)) * 55);
            options.progress?.(
                attempt > 1 ? 'recovery-attempt' : (attemptOperation.progress?.phase || attemptOperation.capabilityId),
                attempt > 1
                    ? `${attemptOperation.specialist} is retrying with a verified recovery plan...`
                    : (attemptOperation.progress?.message || `${attemptOperation.specialist} is applying the edit...`),
                Math.min(76, basePercent + (attempt - 1) * 4)
            );

            const operationBefore = _clone(working);
            const attemptDraft = _clone(working);
            let specialistResult = null;
            let failure = null;
            let evidence = null;
            try {
                specialistResult = await registry.executeCapabilityOperation(attemptDraft, attemptOperation, {
                    ...options,
                    effort: context.effort,
                    transactionId: context.transactionId,
                    attempt,
                });
                evidence = summarizePlanDiff(operationBefore, attemptDraft, attemptOperation.scope);
                if (attemptOperation.scope?.kind !== 'project' && evidence.scopeLeakCount > 0) {
                    const error = new Error(
                        `${attemptOperation.specialist} attempted to change ${evidence.scopeLeakCount} item(s) outside the exact selected scope`
                    );
                    error.code = 'AGENT_OPERATION_SCOPE_LEAK';
                    error.diff = evidence;
                    throw error;
                }
                if (!(specialistResult.changed > 0) || !hasMeaningfulChange(evidence)) {
                    const error = new Error(
                        `${attemptOperation.specialist} did not produce a verifiable timeline change`
                    );
                    error.code = 'AGENT_OPERATION_NO_CHANGE';
                    throw error;
                }
            } catch (error) {
                failure = error;
            }

            if (!failure) {
                working = attemptDraft;
                changed += specialistResult.changed;
                _mergeNumericStats(stats, specialistResult.stats);
                if (specialistResult.assetManifest) stagedManifests.push(specialistResult.assetManifest);
                try {
                    assetManifest = _mergeAssetManifest(assetManifest, specialistResult.assetManifest);
                } catch (error) {
                    _cleanupManifests(stagedManifests, options);
                    error.assetManifest = null;
                    throw error;
                }
                structuralRange = _mergeRange(structuralRange, specialistResult.structuralRange);
                const status = attempt > 1 ? 'completed-after-recovery' : 'completed';
                attempts.push({
                    attempt,
                    capabilityId: attemptOperation.capabilityId,
                    action: attemptOperation.action,
                    status: 'verified',
                    changed: specialistResult.changed,
                });
                operationResults.push({
                    operationId: approvedOperation.operationId,
                    capabilityId: attemptOperation.capabilityId,
                    specialist: attemptOperation.specialist,
                    action: attemptOperation.action,
                    description: attemptOperation.description,
                    approvedCapabilityId: approvedOperation.capabilityId,
                    approvedAction: approvedOperation.action,
                    status,
                    changed: specialistResult.changed,
                    stats: specialistResult.stats,
                    evidence,
                    attempts,
                    recoveryCount: Math.max(0, attempt - 1),
                    scope: _compactScope(attemptOperation.scope),
                });
                completedOperations.push(attemptOperation);
                decisionLog.push({
                    phase: 'verify',
                    status,
                    message: `${attemptOperation.specialist} produced a scope-safe, verifiable timeline change.`,
                });
                options.log?.(`${attemptOperation.specialist}: ${specialistResult.changed} timeline item(s) changed`);
                completed = true;
                break;
            }

            if (specialistResult?.assetManifest) stagedManifests.push(specialistResult.assetManifest);
            if (_isAlreadySatisfied(failure)) {
                attempts.push({
                    attempt,
                    capabilityId: attemptOperation.capabilityId,
                    action: attemptOperation.action,
                    status: 'already-satisfied',
                    error: String(failure.message || '').slice(0, 1_000),
                });
                operationResults.push({
                    operationId: approvedOperation.operationId,
                    capabilityId: attemptOperation.capabilityId,
                    specialist: attemptOperation.specialist,
                    action: attemptOperation.action,
                    description: attemptOperation.description,
                    status: 'already-satisfied-by-prior-operation',
                    changed: 0,
                    stats: {},
                    evidence: summarizePlanDiff(operationBefore, working, attemptOperation.scope),
                    attempts,
                    recoveryCount: Math.max(0, attempt - 1),
                    scope: _compactScope(attemptOperation.scope),
                });
                decisionLog.push({
                    phase: 'verify',
                    status: 'already-satisfied',
                    message: `${attemptOperation.specialist} confirmed the approved condition was already satisfied.`,
                });
                completed = true;
                break;
            }

            attempts.push({
                attempt,
                capabilityId: attemptOperation.capabilityId,
                action: attemptOperation.action,
                status: 'failed',
                code: String(failure.code || ''),
                error: String(failure.message || '').slice(0, 1_000),
            });
            if (!_isRecoverable(failure) || attempt >= maxAttempts) {
                _cleanupManifests(stagedManifests, options);
                failure.attempts = attempts;
                failure.recoveries = recoveries;
                failure.decisionLog = decisionLog;
                failure.assetManifest = null;
                throw failure;
            }

            options.progress?.(
                'recover',
                `The first ${attemptOperation.specialist} attempt did not verify. Inspecting live capabilities and preparing a safe recovery...`,
                Math.min(78, basePercent + 3)
            );
            let recovery;
            try {
                recovery = await _findRecovery(working, attemptOperation, failure, {
                    request: context.request,
                    originalRequest: context.originalRequest,
                    effort: context.effort,
                    completedOperations,
                    options,
                });
            } catch (recoveryError) {
                _cleanupManifests(stagedManifests, options);
                failure.recoveryError = String(recoveryError.message || '').slice(0, 1_000);
                failure.attempts = attempts;
                failure.recoveries = recoveries;
                failure.decisionLog = decisionLog;
                failure.assetManifest = null;
                throw failure;
            }
            const recoverySignature = recovery ? _operationSignature(recovery.operation) : '';
            const repeatedNoChange = seen.has(recoverySignature)
                && String(failure.code || '') === 'AGENT_OPERATION_NO_CHANGE';
            const repeatedTwice = seen.has(recoverySignature) && attempt > 1;
            if (!recovery || repeatedNoChange || repeatedTwice) {
                _cleanupManifests(stagedManifests, options);
                failure.attempts = attempts;
                failure.recoveries = recoveries;
                failure.decisionLog = decisionLog;
                failure.assetManifest = null;
                throw failure;
            }

            const recoveryRecord = {
                operationId: approvedOperation.operationId,
                attempt,
                strategy: recovery.strategy,
                fromCapabilityId: attemptOperation.capabilityId,
                fromAction: attemptOperation.action,
                toCapabilityId: recovery.operation.capabilityId,
                toAction: recovery.operation.action,
                reason: String(failure.message || '').slice(0, 1_000),
                description: recovery.operation.description,
            };
            recoveries.push(recoveryRecord);
            decisionLog.push({
                phase: 'recover',
                status: 'retrying',
                message: `${recovery.operation.specialist} prepared a lower-or-equal-risk recovery inside the approved scope.`,
            });
            attemptOperation = {
                ...recovery.operation,
                operationId: `${approvedOperation.operationId}-recovery-${attempt}`,
                stage: approvedOperation.stage,
                dependsOn: approvedOperation.dependsOn,
            };
        }

        if (!completed) {
            const error = new Error(`${approvedOperation.specialist} could not complete the approved edit`);
            error.code = 'AGENT_OPERATION_INCOMPLETE';
            _cleanupManifests(stagedManifests, options);
            error.assetManifest = null;
            error.recoveries = recoveries;
            error.decisionLog = decisionLog;
            throw error;
        }
    }

    _cleanupManifests(stagedManifests, options, assetManifest);
    return {
        plan: working,
        assetManifest,
        structuralRange,
        changed,
        stats,
        operationResults,
        recoveries,
        decisionLog,
    };
}

module.exports = {
    runAutonomousOperations,
};
