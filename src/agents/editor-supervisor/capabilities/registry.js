'use strict';

const fs = require('fs');
const path = require('path');

const CAPABILITY_FILE = /^[a-z0-9][a-z0-9-]*\.js$/i;
const RESERVED_FILES = new Set(['registry.js', 'smart-router.js']);
const RISK_LEVELS = new Set(['low', 'moderate', 'expensive', 'structural']);

let discovered = null;
const registered = new Map();

function _clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function _readManifest(capability, source = 'capability') {
    if (!capability || typeof capability !== 'object') {
        throw new Error(`${source} must export a capability object`);
    }
    if (typeof capability.manifest !== 'function') {
        throw new Error(`${source} must export manifest()`);
    }
    if (typeof capability.execute !== 'function') {
        throw new Error(`${source} must export execute()`);
    }
    const manifest = capability.manifest();
    const id = String(manifest?.id || '').trim();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/i.test(id)) {
        throw new Error(`${source} has an invalid capability id`);
    }
    const actions = Array.isArray(manifest.actions)
        ? [...new Set(manifest.actions.map((action) => String(action || '').trim()).filter(Boolean))]
        : [];
    if (!actions.length) throw new Error(`${source} must declare at least one action`);
    const scopes = Array.isArray(manifest.scopes)
        ? [...new Set(manifest.scopes.map((scope) => String(scope || '').trim()).filter(Boolean))]
        : [];
    if (!scopes.length) throw new Error(`${source} must declare at least one scope`);
    const risk = RISK_LEVELS.has(manifest.risk) ? manifest.risk : 'moderate';
    return {
        ..._clone(manifest),
        id,
        specialist: String(manifest.specialist || id),
        actions,
        scopes,
        risk,
        directiveKeys: Array.isArray(manifest.directiveKeys)
            ? [...new Set(manifest.directiveKeys.map((key) => String(key || '').trim()).filter(Boolean))]
            : [],
    };
}

function _discover() {
    if (discovered) return discovered;
    discovered = new Map();
    const files = fs.readdirSync(__dirname, { withFileTypes: true })
        .filter((entry) => entry.isFile()
            && CAPABILITY_FILE.test(entry.name)
            && !RESERVED_FILES.has(entry.name))
        .map((entry) => entry.name)
        .sort((left, right) => left.localeCompare(right));
    for (const filename of files) {
        const modulePath = path.join(__dirname, filename);
        const capability = require(modulePath);
        const manifest = _readManifest(capability, filename);
        if (discovered.has(manifest.id)) {
            throw new Error(`Duplicate Editor Agent capability id: ${manifest.id}`);
        }
        discovered.set(manifest.id, {
            capability,
            manifest,
            source: modulePath,
        });
    }
    return discovered;
}

function _all() {
    const result = new Map(_discover());
    for (const [id, entry] of registered) result.set(id, entry);
    return result;
}

function listCapabilities() {
    return [..._all().values()];
}

function listManifests() {
    return listCapabilities().map((entry) => _clone(entry.manifest));
}

function getCapability(idValue) {
    return _all().get(String(idValue || '').trim()) || null;
}

function registerCapability(capability, options = {}) {
    const manifest = _readManifest(capability, options.source || 'registered capability');
    const existing = getCapability(manifest.id);
    if (existing && options.replace !== true) {
        throw new Error(`Editor Agent capability "${manifest.id}" is already registered`);
    }
    registered.set(manifest.id, {
        capability,
        manifest,
        source: options.source || 'runtime',
    });
    return _clone(manifest);
}

function unregisterCapability(idValue) {
    return registered.delete(String(idValue || '').trim());
}

function reloadCapabilities() {
    discovered = null;
    return listManifests();
}

function _scopeKind(operation, context) {
    return String(operation?.scope?.kind || context?.request?.scope?.kind || '');
}

function validateOperation(operation, context = {}) {
    if (!operation || typeof operation !== 'object') throw new Error('Capability operation must be an object');
    const capabilityId = String(operation.capabilityId || '').trim();
    const entry = getCapability(capabilityId);
    if (!entry) throw new Error(`Unknown Editor Agent capability: ${capabilityId || '(empty)'}`);
    const action = String(operation.action || '').trim();
    if (!entry.manifest.actions.includes(action)) {
        throw new Error(`${entry.manifest.specialist} does not expose action "${action || '(empty)'}"`);
    }
    const scope = operation.scope || context?.request?.scope;
    const scopeKind = _scopeKind({ ...operation, scope }, context);
    if (!scope || !entry.manifest.scopes.includes(scopeKind)) {
        throw new Error(`${entry.manifest.specialist} does not support ${scopeKind || 'that'} scope`);
    }
    return {
        ...operation,
        capabilityId: entry.manifest.id,
        specialist: entry.manifest.specialist,
        action,
        args: operation.args && typeof operation.args === 'object' ? _clone(operation.args) : {},
        scope: _clone(scope),
        risk: RISK_LEVELS.has(operation.risk) ? operation.risk : entry.manifest.risk,
        description: String(operation.description || `${entry.manifest.specialist}: ${action}`),
        progress: operation.progress && typeof operation.progress === 'object'
            ? {
                phase: String(operation.progress.phase || entry.manifest.id),
                message: String(operation.progress.message || `${entry.manifest.specialist} is applying the edit...`),
            }
            : {
                phase: entry.manifest.id,
                message: `${entry.manifest.specialist} is applying the edit...`,
            },
    };
}

function tryNormalizeInvocation(invocation, context = {}) {
    try {
        const capabilityId = String(
            invocation?.capabilityId
            || invocation?.capability
            || invocation?.specialistId
            || ''
        ).trim();
        const entry = getCapability(capabilityId);
        if (!entry) throw new Error(`Unknown Editor Agent capability: ${capabilityId || '(empty)'}`);
        if (typeof entry.capability.normalizeInvocation !== 'function') {
            throw new Error(`${entry.manifest.specialist} cannot normalize smart invocations`);
        }
        const operation = entry.capability.normalizeInvocation(invocation, context);
        if (!operation) throw new Error(`${entry.manifest.specialist} rejected that action or scope`);
        return { operation: validateOperation(operation, context), error: null };
    } catch (error) {
        return { operation: null, error };
    }
}

function normalizeInvocation(invocation, context = {}) {
    const result = tryNormalizeInvocation(invocation, context);
    if (!result.operation) throw result.error;
    return result.operation;
}

function planDeterministic(context = {}) {
    const operations = [];
    const claimedDirectiveKeys = [];
    const supported = [];
    const unsupported = [];
    for (const entry of listCapabilities()) {
        if (typeof entry.capability.planFast !== 'function') continue;
        try {
            const planned = entry.capability.planFast(context) || {};
            claimedDirectiveKeys.push(...(planned.claimedDirectiveKeys || []));
            supported.push(...(planned.supported || []));
            unsupported.push(...(planned.unsupported || []));
            for (const operation of (planned.operations || [])) {
                operations.push(validateOperation(operation, context));
            }
        } catch (error) {
            context.log?.(`${entry.manifest.specialist} planning skipped: ${error.message}`);
            unsupported.push(`${entry.manifest.specialist} could not safely plan this request.`);
        }
    }
    return {
        operations,
        claimedDirectiveKeys: [...new Set(claimedDirectiveKeys.filter(Boolean))],
        supported: [...new Set(supported.filter(Boolean))],
        unsupported: [...new Set(unsupported.filter(Boolean))],
    };
}

async function executeCapabilityOperation(plan, operation, options = {}) {
    const validated = validateOperation(operation, { request: { scope: operation?.scope } });
    const entry = getCapability(validated.capabilityId);
    const result = await entry.capability.execute({
        plan,
        operation: validated,
        options,
    });
    return {
        changed: Number(result?.changed) || 0,
        stats: result?.stats && typeof result.stats === 'object' ? result.stats : {},
        assetManifest: result?.assetManifest || null,
        structuralRange: result?.structuralRange || null,
        diagnostics: result?.diagnostics || null,
    };
}

async function recoverCapabilityOperation(plan, operation, error, context = {}) {
    const validated = validateOperation(operation, { request: { scope: operation?.scope } });
    const entry = getCapability(validated.capabilityId);
    if (typeof entry?.capability?.recover !== 'function') return null;
    const raw = await entry.capability.recover({
        plan,
        operation: validated,
        error,
        context,
    });
    if (!raw) return null;

    const candidate = raw.operation || raw.invocation || raw;
    if (!candidate || typeof candidate !== 'object') return null;
    if (candidate.specialist || candidate.progress || candidate.risk) {
        return validateOperation({
            ...candidate,
            scope: candidate.scope || validated.scope,
        }, {
            request: { scope: candidate.scope || validated.scope },
        });
    }
    const normalized = tryNormalizeInvocation(candidate, {
        request: {
            ...(context.request || {}),
            scope: candidate.scope || validated.scope,
        },
        plan,
        existingOperations: context.completedOperations || [],
        log: context.options?.log,
    });
    if (!normalized.operation) throw normalized.error;
    return normalized.operation;
}

function inspectCapabilities(plan, scope) {
    const inspections = {};
    for (const entry of listCapabilities()) {
        if (typeof entry.capability.inspect !== 'function') continue;
        try {
            inspections[entry.manifest.id] = entry.capability.inspect(plan, scope);
        } catch (_) { }
    }
    return inspections;
}

module.exports = {
    executeCapabilityOperation,
    getCapability,
    inspectCapabilities,
    listCapabilities,
    listManifests,
    normalizeInvocation,
    planDeterministic,
    recoverCapabilityOperation,
    registerCapability,
    reloadCapabilities,
    tryNormalizeInvocation,
    unregisterCapability,
    validateOperation,
};
