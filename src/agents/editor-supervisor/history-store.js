'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const projectStore = require('../../project/project-store');

const HISTORY_VERSION = 1;
const MAX_TRANSACTIONS = 20;

function _root(projectDir) {
    const projectRoot = path.resolve(projectDir);
    const root = path.resolve(projectRoot, '.yta', 'agent');
    if (root !== projectRoot && !root.startsWith(`${projectRoot}${path.sep}`)) {
        throw new Error('Agent history path escaped the project');
    }
    return root;
}

function _indexPath(projectDir) {
    return path.join(_root(projectDir), 'index.json');
}

function _transactionPath(projectDir, id) {
    if (!/^[a-zA-Z0-9._-]+$/.test(String(id || ''))) {
        throw new Error('Invalid Agent transaction id');
    }
    return path.join(_root(projectDir), 'transactions', `${id}.json`);
}

function _emptyIndex() {
    return { version: HISTORY_VERSION, undo: [], redo: [] };
}

function _readJson(filePath, fallback = null) {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function _loadIndex(projectDir) {
    const parsed = _readJson(_indexPath(projectDir), _emptyIndex());
    return {
        version: HISTORY_VERSION,
        undo: Array.isArray(parsed?.undo) ? parsed.undo.filter(Boolean).map(String) : [],
        redo: Array.isArray(parsed?.redo) ? parsed.redo.filter(Boolean).map(String) : [],
    };
}

function _saveIndex(projectDir, index) {
    projectStore.atomicWriteJson(_indexPath(projectDir), {
        version: HISTORY_VERSION,
        undo: index.undo.slice(-MAX_TRANSACTIONS),
        redo: index.redo.slice(-MAX_TRANSACTIONS),
    });
}

function _newId() {
    return `${Date.now().toString(36)}-${crypto.randomBytes(8).toString('hex')}`;
}

function _removeTransaction(projectDir, id) {
    try {
        const target = path.resolve(_transactionPath(projectDir, id));
        const transactionsRoot = path.resolve(_root(projectDir), 'transactions');
        if (target.startsWith(`${transactionsRoot}${path.sep}`) && fs.existsSync(target)) {
            fs.unlinkSync(target);
        }
    } catch (_) { }
}

function recordCommit(projectDir, transaction) {
    const id = _newId();
    const saved = {
        version: HISTORY_VERSION,
        id,
        createdAt: new Date().toISOString(),
        summary: String(transaction?.summary || 'Agent edit').slice(0, 1_000),
        request: String(transaction?.request || '').slice(0, 12_000),
        scope: transaction?.scope || { kind: 'project', label: 'Whole project' },
        beforeRevision: Number(transaction?.beforeRevision) || 0,
        afterRevision: Number(transaction?.afterRevision) || 0,
        beforePlanHash: String(transaction?.beforePlanHash || ''),
        afterPlanHash: String(transaction?.afterPlanHash || ''),
        beforePlan: transaction?.beforePlan,
        afterPlan: transaction?.afterPlan,
        stats: transaction?.stats || {},
        diff: transaction?.diff || null,
        qualityReport: transaction?.qualityReport || null,
        visualQa: transaction?.visualQa || null,
        operationGraph: Array.isArray(transaction?.operationGraph) ? transaction.operationGraph : [],
        operationResults: Array.isArray(transaction?.operationResults) ? transaction.operationResults : [],
        recoveries: Array.isArray(transaction?.recoveries) ? transaction.recoveries : [],
        decisionLog: Array.isArray(transaction?.decisionLog) ? transaction.decisionLog : [],
        assetManifest: transaction?.assetManifest || null,
    };
    if (!saved.beforePlan || !saved.afterPlan) {
        throw new Error('Agent transaction requires before and after plans');
    }

    projectStore.atomicWriteJson(_transactionPath(projectDir, id), saved);
    const index = _loadIndex(projectDir);
    const staleRedo = [...index.redo];
    index.redo = [];
    index.undo.push(id);
    while (index.undo.length > MAX_TRANSACTIONS) {
        _removeTransaction(projectDir, index.undo.shift());
    }
    _saveIndex(projectDir, index);
    staleRedo.forEach((oldId) => {
        if (!index.undo.includes(oldId)) _removeTransaction(projectDir, oldId);
    });
    return saved;
}

function _candidate(projectDir, lane) {
    const index = _loadIndex(projectDir);
    const id = index[lane][index[lane].length - 1];
    if (!id) return null;
    const transaction = _readJson(_transactionPath(projectDir, id), null);
    if (!transaction) {
        index[lane].pop();
        _saveIndex(projectDir, index);
        return null;
    }
    return transaction;
}

function getUndoCandidate(projectDir) {
    return _candidate(projectDir, 'undo');
}

function getRedoCandidate(projectDir) {
    return _candidate(projectDir, 'redo');
}

function _moveTop(projectDir, from, to, id) {
    const index = _loadIndex(projectDir);
    if (index[from][index[from].length - 1] !== id) {
        throw new Error('Agent history changed before the operation completed');
    }
    index[from].pop();
    index[to].push(id);
    _saveIndex(projectDir, index);
}

function markUndone(projectDir, id) {
    _moveTop(projectDir, 'undo', 'redo', id);
}

function markRedone(projectDir, id) {
    _moveTop(projectDir, 'redo', 'undo', id);
}

function listHistory(projectDir) {
    const index = _loadIndex(projectDir);
    const summarize = (id) => {
        const transaction = _readJson(_transactionPath(projectDir, id), null);
        if (!transaction) return null;
        return {
            id: transaction.id,
            createdAt: transaction.createdAt,
            summary: transaction.summary,
            request: transaction.request,
            scope: transaction.scope,
            stats: transaction.stats,
            diff: transaction.diff,
            qualityReport: transaction.qualityReport,
            visualQa: transaction.visualQa,
            operationResults: transaction.operationResults,
            recoveries: transaction.recoveries,
        };
    };
    return {
        undo: index.undo.map(summarize).filter(Boolean).reverse(),
        redo: index.redo.map(summarize).filter(Boolean).reverse(),
    };
}

module.exports = {
    getRedoCandidate,
    getUndoCandidate,
    listHistory,
    markRedone,
    markUndone,
    recordCommit,
};
