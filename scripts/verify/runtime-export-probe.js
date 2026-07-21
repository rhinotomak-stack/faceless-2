#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..', '..');
const PROJECT_ROOT = process.env.YTA_RUNTIME_PROJECT_DIR
    ? path.resolve(process.env.YTA_RUNTIME_PROJECT_DIR)
    : ROOT;
const TEST_DIRS = [
    path.join(PROJECT_ROOT, 'temp'),
    path.join(PROJECT_ROOT, 'output'),
];
const browserWSEndpoint = process.argv[2];

if (!browserWSEndpoint) {
    console.error('usage: node scripts/verify/runtime-export-probe.js <browserWsEndpoint>');
    process.exit(2);
}

function snapshotArtifacts() {
    const files = new Set();
    for (const dir of TEST_DIRS) {
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir)) {
            if (/^(?:webgl-video-|video-).+\.mp4$/i.test(name)) {
                files.add(path.resolve(dir, name));
            }
        }
    }
    return files;
}

function cleanupCreatedArtifacts(before) {
    const removed = [];
    const after = snapshotArtifacts();
    for (const filePath of after) {
        if (before.has(filePath)) continue;
        const allowed = TEST_DIRS.some((dir) => {
            const relative = path.relative(path.resolve(dir), filePath);
            return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
        });
        if (!allowed) continue;
        try {
            fs.unlinkSync(filePath);
            removed.push(filePath);
        } catch (_) { }
    }
    return removed;
}

(async () => {
    const before = snapshotArtifacts();
    let browser;
    try {
        browser = await puppeteer.connect({ browserWSEndpoint, defaultViewport: null });
        const pages = await browser.pages();
        const page = pages.find((candidate) => /ui\/index\.html/i.test(candidate.url()));
        if (!page) throw new Error('main renderer page not found');

        const result = await page.evaluate(async () => {
            const api = window.electronAPI;
            const makeFrame = () => {
                const pixels = new Uint8Array(256 * 256 * 4);
                for (let index = 3; index < pixels.length; index += 4) pixels[index] = 255;
                return pixels.buffer;
            };

            let activeExportId = null;
            try {
                const start = await api.startWebGLExport({
                    width: 256,
                    height: 256,
                    fps: 30,
                    totalFrames: 3,
                });
                if (start?.success) activeExportId = start.exportId;

                const concurrentStart = await api.startWebGLExport({
                    width: 256,
                    height: 256,
                    fps: 30,
                    totalFrames: 1,
                });
                const staleBatch = await api.sendExportFramesBatch({
                    exportId: 'stale-export-id',
                    frames: [{ frameIndex: 0, buffer: makeFrame() }],
                });
                const wrongSizeBatch = await api.sendExportFramesBatch({
                    exportId: activeExportId,
                    frames: [{ frameIndex: 0, buffer: new Uint8Array(4).buffer }],
                });
                const validBatch = await api.sendExportFramesBatch({
                    exportId: activeExportId,
                    frames: [
                        { frameIndex: 0, buffer: makeFrame() },
                        { frameIndex: 1, buffer: makeFrame() },
                        { frameIndex: 2, buffer: makeFrame() },
                    ],
                });
                const staleFinish = await api.finishWebGLExport('stale-export-id');
                const finish = await api.finishWebGLExport(activeExportId);
                activeExportId = null;
                const outputUrl = finish?.outputPath ? await api.getFileUrl(finish.outputPath) : null;

                const incompleteStart = await api.startWebGLExport({
                    width: 256,
                    height: 256,
                    fps: 30,
                    totalFrames: 2,
                });
                if (incompleteStart?.success) activeExportId = incompleteStart.exportId;
                const oneFrame = await api.sendExportFramesBatch({
                    exportId: activeExportId,
                    frames: [{ frameIndex: 0, buffer: makeFrame() }],
                });
                const incompleteFinish = await api.finishWebGLExport(activeExportId);
                activeExportId = null;

                const cancelStart = await api.startWebGLExport({
                    width: 256,
                    height: 256,
                    fps: 30,
                    totalFrames: 1,
                });
                if (cancelStart?.success) activeExportId = cancelStart.exportId;
                const cancel = await api.cancelWebGLExport(activeExportId);
                activeExportId = null;

                return {
                    start,
                    concurrentStart,
                    staleBatch,
                    wrongSizeBatch,
                    validBatch,
                    staleFinish,
                    finish,
                    outputUrl,
                    incompleteStart,
                    oneFrame,
                    incompleteFinish,
                    cancelStart,
                    cancel,
                };
            } finally {
                if (activeExportId) {
                    await api.cancelWebGLExport(activeExportId).catch(() => { });
                }
            }
        });

        const checks = [
            ['valid export starts with a unique ID', result.start?.success === true && typeof result.start.exportId === 'string'],
            ['concurrent export start is rejected', result.concurrentStart?.success === false],
            ['stale batch ID is rejected', result.staleBatch?.success === false && /stale|invalid/i.test(result.staleBatch?.error || '')],
            ['wrong-sized frame is rejected', result.wrongSizeBatch?.success === false && /size mismatch/i.test(result.wrongSizeBatch?.error || '')],
            ['three-frame bounded batch is accepted', result.validBatch?.success === true && result.validBatch.written === 3],
            ['stale finish ID is rejected', result.staleFinish?.success === false && /stale|invalid/i.test(result.staleFinish?.error || '')],
            ['real FFmpeg export finishes', result.finish?.success === true && typeof result.finish.outputPath === 'string'],
            ['finished output exists behind project asset protocol', typeof result.outputUrl === 'string' && result.outputUrl.startsWith('asset:')],
            ['incomplete export setup succeeds', result.incompleteStart?.success === true && result.oneFrame?.success === true],
            ['incomplete frame count is rejected', result.incompleteFinish?.success === false && /incomplete export/i.test(result.incompleteFinish?.error || '')],
            ['fresh export can start after failed finish', result.cancelStart?.success === true],
            ['owned export cancellation succeeds', result.cancel?.success === true],
        ];

        console.log('\n=== RUNTIME EXPORT PROBE ===');
        let passed = 0;
        for (const [name, ok] of checks) {
            if (ok) passed++;
            console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
        }
        console.log(`\n${passed === checks.length ? 'ALL PASS' : 'SOME FAILED'} (${passed}/${checks.length})`);
        process.exitCode = passed === checks.length ? 0 : 1;
    } finally {
        if (browser) await browser.disconnect().catch(() => { });
        const removed = cleanupCreatedArtifacts(before);
        if (removed.length) console.log(`[cleanup] removed ${removed.length} runtime export artifact(s)`);
    }
})().catch((error) => {
    console.error(`RUNTIME EXPORT PROBE ERROR: ${error.message}`);
    process.exitCode = 3;
});
