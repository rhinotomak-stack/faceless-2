'use strict';

const fs = require('fs');
const path = require('path');
const timeline = require('../../project/timeline-contract');

function _isWithin(rootPath, candidatePath) {
    const root = path.resolve(rootPath);
    const candidate = path.resolve(candidatePath);
    if (process.platform === 'win32') {
        const rootLower = root.toLowerCase();
        const candidateLower = candidate.toLowerCase();
        return candidateLower === rootLower || candidateLower.startsWith(`${rootLower}${path.sep}`);
    }
    return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function _safeId(value, fallback = 'agent') {
    return timeline.safeToken(value, fallback).slice(0, 96);
}

function createAssetStage({ projectDir, transactionId }) {
    const root = path.resolve(projectDir);
    const id = _safeId(transactionId, `agent-${Date.now().toString(36)}`);
    const stagingRoot = path.resolve(root, 'temp', 'agent-staging', id);
    const finalRoot = path.resolve(root, 'public', 'agent-assets', id);
    if (!_isWithin(path.join(root, 'temp', 'agent-staging'), stagingRoot)
        || !_isWithin(path.join(root, 'public', 'agent-assets'), finalRoot)) {
        throw new Error('Agent asset stage escaped the project');
    }
    fs.mkdirSync(stagingRoot, { recursive: true });
    return {
        version: 1,
        transactionId: id,
        projectDir: root,
        stagingRoot,
        finalRoot,
        assets: [],
    };
}

function stageDownloadedFile(stage, sourcePath, options = {}) {
    if (!stage?.stagingRoot || !stage?.finalRoot) throw new Error('Missing Agent asset stage');
    const source = path.resolve(String(sourcePath || ''));
    if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
        throw new Error(`Agent media worker returned a missing file: ${sourcePath || '(empty)'}`);
    }
    const projectTemp = path.resolve(stage.projectDir, 'temp');
    if (!_isWithin(projectTemp, source)) {
        throw new Error('Agent media worker returned a file outside the project temp directory');
    }

    const ext = String(options.ext || path.extname(source) || '.bin').toLowerCase();
    const base = _safeId(options.baseName || path.basename(source, path.extname(source)), 'asset');
    let filename = `${base}${ext.startsWith('.') ? ext : `.${ext}`}`;
    let suffix = 2;
    while (stage.assets.some((asset) => asset.filename === filename)) {
        filename = `${base}-${suffix++}${ext.startsWith('.') ? ext : `.${ext}`}`;
    }

    const stagedPath = path.resolve(stage.stagingRoot, filename);
    const finalPath = path.resolve(stage.finalRoot, filename);
    if (!_isWithin(stage.stagingRoot, stagedPath) || !_isWithin(stage.finalRoot, finalPath)) {
        throw new Error('Agent asset filename escaped its transaction directory');
    }
    fs.copyFileSync(source, stagedPath);
    const relativePath = path.posix.join(
        'agent-assets',
        stage.transactionId,
        filename
    );
    const asset = {
        filename,
        stagedPath,
        finalPath,
        relativePath,
        size: fs.statSync(stagedPath).size,
    };
    stage.assets.push(asset);
    return asset;
}

function publicManifest(stage) {
    return {
        version: 1,
        transactionId: stage.transactionId,
        stagingRoot: stage.stagingRoot,
        finalRoot: stage.finalRoot,
        assets: stage.assets.map((asset) => ({ ...asset })),
    };
}

function commitAssets(manifest, { projectDir } = {}) {
    if (!manifest?.assets?.length) return [];
    const root = path.resolve(projectDir);
    const allowedStageRoot = path.resolve(root, 'temp', 'agent-staging');
    const allowedFinalRoot = path.resolve(root, 'public', 'agent-assets');
    const committed = [];
    try {
        for (const asset of manifest.assets) {
            const stagedPath = path.resolve(String(asset.stagedPath || ''));
            const finalPath = path.resolve(String(asset.finalPath || ''));
            if (!_isWithin(allowedStageRoot, stagedPath) || !_isWithin(allowedFinalRoot, finalPath)) {
                throw new Error('Agent asset manifest escaped the project');
            }
            if (!fs.existsSync(stagedPath) || !fs.statSync(stagedPath).isFile()) {
                throw new Error(`Staged Agent asset is missing: ${asset.filename || path.basename(stagedPath)}`);
            }
            fs.mkdirSync(path.dirname(finalPath), { recursive: true });
            fs.copyFileSync(stagedPath, finalPath, fs.constants.COPYFILE_EXCL);
            committed.push(finalPath);
        }
        return committed;
    } catch (error) {
        rollbackCommittedAssets(committed, { projectDir: root });
        throw error;
    }
}

function rollbackCommittedAssets(paths, { projectDir } = {}) {
    const root = path.resolve(projectDir);
    const allowedFinalRoot = path.resolve(root, 'public', 'agent-assets');
    for (const candidate of (paths || [])) {
        try {
            const resolved = path.resolve(candidate);
            if (_isWithin(allowedFinalRoot, resolved) && fs.existsSync(resolved)) fs.unlinkSync(resolved);
        } catch (_) { }
    }
}

function cleanupStage(manifest, { projectDir } = {}) {
    if (!manifest?.stagingRoot) return;
    try {
        const root = path.resolve(projectDir);
        const allowedStageRoot = path.resolve(root, 'temp', 'agent-staging');
        const stagingRoot = path.resolve(manifest.stagingRoot);
        if (_isWithin(allowedStageRoot, stagingRoot) && fs.existsSync(stagingRoot)) {
            fs.rmSync(stagingRoot, { recursive: true, force: true });
        }
    } catch (_) { }
}

module.exports = {
    cleanupStage,
    commitAssets,
    createAssetStage,
    publicManifest,
    rollbackCommittedAssets,
    stageDownloadedFile,
};
