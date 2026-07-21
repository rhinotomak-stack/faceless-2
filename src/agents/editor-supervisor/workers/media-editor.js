'use strict';

const fs = require('fs');
const path = require('path');
const { sanitizeSourceHint } = require('../../../media/source-policy');
const {
    cleanupStage,
    createAssetStage,
    publicManifest,
    stageDownloadedFile,
} = require('../transaction-assets');
const { resolveSceneTargets, windowOf } = require('../scope-utils');

const MEDIA_REFERENCE_FIELDS = [
    'mediaFile', 'mediaPath', 'localPath',
    'videoFile', 'videoPath',
    'imageFile', 'imagePath',
    'assetFile', 'assetPath',
];
const MEDIA_GEOMETRY_FIELDS = [
    'cropTop', 'cropRight', 'cropBottom', 'cropLeft',
    'focusX', 'focusY',
    'mediaWidth', 'mediaHeight', 'aspectRatio', 'isVertical',
    '_verticalContain', '_verticalContainReason',
];
const MEDIA_QA_FIELDS = [
    'flagForReplacement',
    'qaFixed', 'qaReplaced', 'qaFixReason', 'qaFixCount',
    'qaReason', 'qaReplacementKeyword', 'qaReplacementSource',
    'qaReplacementDiagnosis', 'watermark', 'watermarkLocation',
    'cropFix', 'fixStrategy', '_clipAnalysis', 'clipAnalysis',
];

function _safeWords(value, maxWords = 8) {
    const stop = new Set([
        'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for',
        'with', 'that', 'this', 'these', 'those', 'is', 'are', 'was', 'were',
        'be', 'been', 'being', 'it', 'its', 'as', 'at', 'by', 'from',
    ]);
    return String(value || '')
        .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
        .split(/\s+/)
        .filter((word) => word && !stop.has(word.toLowerCase()))
        .slice(0, maxWords)
        .join(' ');
}

function _queryForScene(scene, operation, targetCount) {
    const explicit = String(operation.query || '').trim();
    const subject = _safeWords(
        scene.searchKeyword
        || scene.keyword
        || scene.text
        || '',
        8
    );
    const style = String(operation.style || '').trim();
    if (explicit && targetCount === 1) return [explicit, style].filter(Boolean).join(' ').trim();
    if (explicit) return [subject, explicit, style].filter(Boolean).join(' ').trim();
    return [subject, style].filter(Boolean).join(' ').trim();
}

async function _defaultDownloader({ scene, query, mediaType, sourceHint, filenameBase, scriptContext }) {
    const footage = require('../../../media/footage-manager');
    footage.initProviders(scriptContext || {});
    const duration = Math.max(1, windowOf(scene).endTime - windowOf(scene).startTime);
    return footage.downloadMedia(
        query,
        mediaType,
        filenameBase,
        duration,
        sourceHint,
        scriptContext?.nicheId || '',
        scene,
        {
            forceKeywordQuery: true,
            rebuildMediaAgent: true,
            cleanupRaceScratch: true,
        }
    );
}

function _testDownloaderFromEnvironment(projectDir) {
    if (!/^(1|true|on)$/i.test(String(process.env.YTA_REMOTE_DEBUG || ''))) return null;
    const source = String(process.env.YTA_AGENT_TEST_MEDIA_SOURCE || '').trim();
    if (!source) return null;
    const resolved = path.resolve(source);
    const tempRoot = path.resolve(projectDir, 'temp');
    const publicRoot = path.resolve(projectDir, 'public');
    const allowed = [tempRoot, publicRoot].some((root) => (
        process.platform === 'win32'
            ? resolved.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)
            : resolved.startsWith(`${root}${path.sep}`)
    ));
    if (!allowed || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
    return async ({ mediaType }) => ({
        path: resolved,
        ext: path.extname(resolved),
        provider: 'runtime-test-fixture',
        mediaType,
        visionScore: 10,
    });
}

async function replaceScopedMedia(plan, scope, operation, options = {}) {
    const targets = resolveSceneTargets(plan, scope, { includeDescendants: true });
    if (!targets.length) throw new Error('No timeline clips are available for media replacement');
    const maxTargets = operation.effort === 'smart' ? 16 : 8;
    if (targets.length > maxTargets) {
        throw new Error(`Media replacement is limited to ${maxTargets} clips per Agent transaction; select a smaller range`);
    }

    const stage = createAssetStage({
        projectDir: options.projectDir,
        transactionId: options.transactionId,
    });
    const downloader = options.mediaDownloader
        || _testDownloaderFromEnvironment(options.projectDir)
        || _defaultDownloader;
    const scriptContext = plan.scriptContext || {};
    const results = [];

    try {
        for (let index = 0; index < targets.length; index++) {
            const scene = targets[index];
            const query = _queryForScene(scene, operation, targets.length);
            if (!query) throw new Error(`Could not derive a replacement search for clip ${scene.clipId || index}`);
            const mediaType = operation.mediaType === 'image' || operation.mediaType === 'video'
                ? operation.mediaType
                : (String(scene.mediaType).toLowerCase() === 'image' ? 'image' : 'video');
            const sourceHint = sanitizeSourceHint(
                operation.sourceHint || scene.sourceHint || (operation.style?.includes('archival') ? 'youtube' : ''),
                mediaType === 'image' ? 'web-image' : 'youtube'
            ) || '';
            const filenameBase = `agent-${stage.transactionId}-${index}-${Date.now().toString(36)}`;
            options.log?.(`Media worker ${index + 1}/${targets.length}: searching "${query}"`);
            const downloaded = await downloader({
                scene,
                query,
                mediaType,
                sourceHint,
                filenameBase,
                scriptContext,
            });
            const downloadedPath = downloaded?.path || downloaded;
            if (!downloadedPath || typeof downloadedPath !== 'string' || !fs.existsSync(downloadedPath)) {
                throw new Error(`No acceptable replacement media was found for "${query}"`);
            }
            const replacementScore = Number(downloaded?.visionScore);
            if (Number.isFinite(replacementScore) && replacementScore > 0 && replacementScore < 4) {
                throw new Error(`Replacement media for "${query}" failed visual quality review (${replacementScore}/10)`);
            }
            const ext = downloaded?.ext || path.extname(downloadedPath) || (mediaType === 'image' ? '.jpg' : '.mp4');
            const asset = stageDownloadedFile(stage, downloadedPath, {
                ext,
                baseName: `${scene.clipId || `scene-${index}`}-${mediaType}`,
            });
            if (path.basename(downloadedPath).startsWith(filenameBase)) {
                try { fs.unlinkSync(downloadedPath); } catch (_) { }
            }
            const previousMedia = MEDIA_REFERENCE_FIELDS
                .map((field) => scene[field])
                .find(Boolean) || '';
            for (const field of [
                ...MEDIA_REFERENCE_FIELDS,
                ...MEDIA_GEOMETRY_FIELDS,
                ...MEDIA_QA_FIELDS,
            ]) delete scene[field];

            scene.mediaFile = asset.relativePath;
            scene.mediaPath = asset.relativePath;
            scene.mediaExtension = ext;
            scene.mediaType = downloaded?.mediaType || mediaType;
            scene.sourceProvider = downloaded?.provider || 'agent-media';
            scene.sourceHint = sourceHint || scene.sourceHint;
            scene.searchKeyword = query;
            scene.keyword = query;
            scene.mediaOffset = 0;
            if (Number.isFinite(replacementScore)) scene.visionScore = replacementScore;
            else delete scene.visionScore;
            const mediaWidth = Number(downloaded?.mediaWidth ?? downloaded?.width);
            const mediaHeight = Number(downloaded?.mediaHeight ?? downloaded?.height);
            if (mediaWidth > 0 && mediaHeight > 0) {
                scene.mediaWidth = mediaWidth;
                scene.mediaHeight = mediaHeight;
                scene.aspectRatio = mediaWidth / mediaHeight;
                scene.isVertical = mediaHeight > mediaWidth;
            }
            scene._agentMediaReplacement = {
                query,
                provider: scene.sourceProvider,
                transactionId: stage.transactionId,
                previousMedia,
            };
            results.push({
                clipId: scene.clipId,
                query,
                provider: scene.sourceProvider,
                relativePath: asset.relativePath,
            });
        }
    } catch (error) {
        cleanupStage(publicManifest(stage), { projectDir: options.projectDir });
        throw error;
    }

    return {
        changed: results.length,
        replacements: results,
        assetManifest: publicManifest(stage),
    };
}

module.exports = {
    replaceScopedMedia,
};
