'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const projectStore = require('../../project/project-store');
const { normalizeScope } = require('./schemas');

const SESSION_VERSION = 1;
const MAX_TURNS = 80;
const MAX_TURN_CHARS = 12_000;
const MAX_RECENT_SESSIONS = 8;

function _root(projectDir) {
    const projectRoot = path.resolve(String(projectDir || ''));
    const root = path.resolve(projectRoot, '.yta', 'agent');
    const rootKey = process.platform === 'win32' ? root.toLowerCase() : root;
    const projectKey = process.platform === 'win32' ? projectRoot.toLowerCase() : projectRoot;
    if (rootKey !== projectKey && !rootKey.startsWith(`${projectKey}${path.sep}`)) {
        throw new Error('Agent session path escaped the project');
    }
    return root;
}

function _indexPath(projectDir) {
    return path.join(_root(projectDir), 'sessions.json');
}

function _sessionPath(projectDir, id) {
    const safeId = String(id || '');
    if (!/^[a-zA-Z0-9._-]+$/.test(safeId)) {
        throw new Error('Invalid Agent session id');
    }
    return path.join(_root(projectDir), 'sessions', `${safeId}.json`);
}

function _readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function _newId() {
    return `session-${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

function _emptyIndex() {
    return {
        version: SESSION_VERSION,
        activeSessionId: '',
        recentSessionIds: [],
    };
}

function _loadIndex(projectDir) {
    const parsed = _readJson(_indexPath(projectDir), _emptyIndex());
    return {
        version: SESSION_VERSION,
        activeSessionId: String(parsed?.activeSessionId || ''),
        recentSessionIds: Array.isArray(parsed?.recentSessionIds)
            ? [...new Set(parsed.recentSessionIds.map(String).filter(Boolean))]
            : [],
    };
}

function _saveIndex(projectDir, index) {
    projectStore.atomicWriteJson(_indexPath(projectDir), {
        version: SESSION_VERSION,
        activeSessionId: String(index.activeSessionId || ''),
        recentSessionIds: index.recentSessionIds.slice(0, MAX_RECENT_SESSIONS),
    });
}

function _emptySession(id = _newId()) {
    const now = new Date().toISOString();
    return {
        version: SESSION_VERSION,
        id,
        createdAt: now,
        updatedAt: now,
        turns: [],
        context: {
            lastPlan: null,
            lastExecution: null,
        },
    };
}

function _boundedText(value, max = MAX_TURN_CHARS) {
    return String(value == null ? '' : value).trim().slice(0, max);
}

function _sanitizeTurn(turn) {
    const text = _boundedText(turn?.text);
    if (!text) return null;
    return {
        id: /^[a-zA-Z0-9._-]+$/.test(String(turn?.id || ''))
            ? String(turn.id)
            : `turn-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`,
        role: turn?.role === 'model' ? 'model' : 'user',
        kind: _boundedText(turn?.kind || 'message', 80) || 'message',
        text,
        createdAt: _boundedText(turn?.createdAt, 80) || new Date().toISOString(),
    };
}

function _sanitizeOperation(operation) {
    return {
        capabilityId: _boundedText(operation?.capabilityId, 80),
        specialist: _boundedText(operation?.specialist, 160),
        action: _boundedText(operation?.action, 120),
        description: _boundedText(operation?.description, 1_000),
    };
}

function _sanitizeEditContext(value) {
    if (!value || typeof value !== 'object') return null;
    const operations = Array.isArray(value.operations)
        ? value.operations.slice(0, 16).map(_sanitizeOperation)
        : [];
    const rawCapabilityIds = Array.isArray(value.capabilityIds)
        ? value.capabilityIds
        : operations.map((operation) => operation.capabilityId);
    return {
        request: _boundedText(value.request),
        resolvedRequest: _boundedText(value.resolvedRequest),
        summary: _boundedText(value.summary, 2_000),
        effort: value.effort === 'smart' ? 'smart' : 'fast',
        scope: normalizeScope(value.scope),
        capabilityIds: [...new Set(
            rawCapabilityIds
                .map((id) => _boundedText(id, 80))
                .filter(Boolean)
        )],
        operations,
        transactionId: _boundedText(value.transactionId, 200),
        createdAt: _boundedText(value.createdAt, 80) || new Date().toISOString(),
    };
}

function _sanitizeSession(raw, fallbackId = '') {
    const id = /^[a-zA-Z0-9._-]+$/.test(String(raw?.id || ''))
        ? String(raw.id)
        : (fallbackId || _newId());
    const session = _emptySession(id);
    session.createdAt = _boundedText(raw?.createdAt, 80) || session.createdAt;
    session.updatedAt = _boundedText(raw?.updatedAt, 80) || session.updatedAt;
    session.turns = (Array.isArray(raw?.turns) ? raw.turns : [])
        .map(_sanitizeTurn)
        .filter(Boolean)
        .slice(-MAX_TURNS);
    session.context = {
        lastPlan: _sanitizeEditContext(raw?.context?.lastPlan),
        lastExecution: _sanitizeEditContext(raw?.context?.lastExecution),
    };
    return session;
}

function _saveSession(projectDir, session) {
    const sanitized = _sanitizeSession({
        ...session,
        updatedAt: new Date().toISOString(),
    }, session.id);
    projectStore.atomicWriteJson(_sessionPath(projectDir, sanitized.id), sanitized);
    return sanitized;
}

function _removeSession(projectDir, id) {
    try {
        const target = path.resolve(_sessionPath(projectDir, id));
        const sessionsRoot = path.resolve(_root(projectDir), 'sessions');
        const targetKey = process.platform === 'win32' ? target.toLowerCase() : target;
        const rootKey = process.platform === 'win32' ? sessionsRoot.toLowerCase() : sessionsRoot;
        if (targetKey.startsWith(`${rootKey}${path.sep}`) && fs.existsSync(target)) {
            fs.unlinkSync(target);
        }
    } catch (_) { }
}

function startSession(projectDir) {
    const session = _saveSession(projectDir, _emptySession());
    const index = _loadIndex(projectDir);
    index.activeSessionId = session.id;
    index.recentSessionIds = [
        session.id,
        ...index.recentSessionIds.filter((id) => id !== session.id),
    ];
    const stale = index.recentSessionIds.slice(MAX_RECENT_SESSIONS);
    index.recentSessionIds = index.recentSessionIds.slice(0, MAX_RECENT_SESSIONS);
    _saveIndex(projectDir, index);
    stale.forEach((id) => _removeSession(projectDir, id));
    return session;
}

function loadSession(projectDir) {
    const index = _loadIndex(projectDir);
    if (!index.activeSessionId) return startSession(projectDir);
    const parsed = _readJson(_sessionPath(projectDir, index.activeSessionId), null);
    if (!parsed) return startSession(projectDir);
    return _sanitizeSession(parsed, index.activeSessionId);
}

function _pushTurn(session, turn) {
    const sanitized = _sanitizeTurn(turn);
    if (!sanitized) return;
    session.turns.push(sanitized);
    session.turns = session.turns.slice(-MAX_TURNS);
}

function recordExchange(projectDir, exchange = {}) {
    const session = loadSession(projectDir);
    const originalRequest = _boundedText(exchange.originalRequest || exchange.request);
    const resolvedRequest = _boundedText(exchange.resolvedRequest || originalRequest);
    _pushTurn(session, {
        role: 'user',
        kind: 'request',
        text: originalRequest,
    });

    const result = exchange.result || {};
    const modelText = result.kind === 'answer'
        ? _boundedText(result.answer || '(No answer)')
        : result.executable
            ? `Proposed edit: ${_boundedText(result.summary || originalRequest, 2_000)}`
            : result.alreadySatisfied
                ? `Already satisfied: ${_boundedText(result.summary || originalRequest, 2_000)}`
                : `Could not safely prepare that edit: ${_boundedText(
                    (result.unsupported || []).join(' ') || result.summary || originalRequest,
                    2_000
                )}`;
    _pushTurn(session, {
        role: 'model',
        kind: result.kind === 'answer' ? 'answer' : 'plan',
        text: modelText,
    });

    if (result.kind === 'edit') {
        session.context.lastPlan = _sanitizeEditContext({
            request: originalRequest,
            resolvedRequest,
            summary: result.summary,
            effort: result.effort || exchange.effort,
            scope: result.scope || exchange.scope,
            capabilityIds: result.capabilityIds,
            operations: result.operations,
        });
    }
    return _saveSession(projectDir, session);
}

function recordExecution(projectDir, execution = {}) {
    const session = loadSession(projectDir);
    const summary = _boundedText(execution.summary || 'Agent edit applied', 2_000);
    _pushTurn(session, {
        role: 'model',
        kind: 'execution',
        text: `Applied and verified: ${summary}`,
    });
    session.context.lastExecution = _sanitizeEditContext({
        request: execution.request,
        resolvedRequest: execution.resolvedRequest,
        summary,
        effort: execution.effort,
        scope: execution.scope,
        capabilityIds: execution.capabilityIds,
        operations: execution.operations,
        transactionId: execution.transactionId,
    });
    return _saveSession(projectDir, session);
}

function recordActivity(projectDir, text, kind = 'activity') {
    const session = loadSession(projectDir);
    _pushTurn(session, {
        role: 'model',
        kind,
        text,
    });
    return _saveSession(projectDir, session);
}

function historyForModel(sessionValue, currentRequest = '') {
    const session = _sanitizeSession(sessionValue || {});
    const history = session.turns
        .filter((turn) => turn.role === 'user' || turn.role === 'model')
        .slice(-28)
        .map((turn) => ({ role: turn.role, text: turn.text }));
    const current = _boundedText(currentRequest);
    const last = history[history.length - 1];
    if (current && !(last?.role === 'user' && last.text === current)) {
        history.push({ role: 'user', text: current });
    }
    return history.slice(-30);
}

function publicSession(sessionValue) {
    const session = _sanitizeSession(sessionValue || {});
    return {
        id: session.id,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        turns: session.turns.map((turn) => ({ ...turn })),
        context: {
            lastPlan: session.context.lastPlan,
            lastExecution: session.context.lastExecution,
        },
    };
}

module.exports = {
    historyForModel,
    loadSession,
    publicSession,
    recordActivity,
    recordExchange,
    recordExecution,
    startSession,
};
