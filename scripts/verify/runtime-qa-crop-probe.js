#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const { PNG } = require('pngjs');

const ROOT = path.resolve(__dirname, '..', '..');
const PROJECT_ROOT = process.env.YTA_RUNTIME_PROJECT_DIR
    ? path.resolve(process.env.YTA_RUNTIME_PROJECT_DIR)
    : ROOT;
const PUBLIC_DIR = path.join(PROJECT_ROOT, 'public');
const browserWSEndpoint = process.argv[2];

if (!browserWSEndpoint) {
    console.error('usage: node scripts/verify/runtime-qa-crop-probe.js <browserWsEndpoint>');
    process.exit(2);
}

const probeName = `qa-crop-runtime-probe-${process.pid}`;
const probePath = path.join(PUBLIC_DIR, `${probeName}.png`);

function removeProbeArtifacts() {
    if (!fs.existsSync(PUBLIC_DIR)) return;
    for (const name of fs.readdirSync(PUBLIC_DIR)) {
        if (name === `${probeName}.png` || name.startsWith(`${probeName}.qa-`)) {
            const candidate = path.resolve(PUBLIC_DIR, name);
            const relative = path.relative(PUBLIC_DIR, candidate);
            if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
                try { fs.unlinkSync(candidate); } catch (_) { }
            }
        }
    }
}

(async () => {
    let browser;
    try {
        // Attach first. On Windows, delaying the initial DevTools WebSocket
        // connection while doing fixture work can race Electron startup/reset.
        browser = await puppeteer.connect({ browserWSEndpoint, defaultViewport: null });
        const pages = await browser.pages();
        const page = pages.find((candidate) => /ui\/index\.html/i.test(candidate.url()));
        if (!page) throw new Error('main renderer page not found');

        fs.mkdirSync(PUBLIC_DIR, { recursive: true });
        const png = new PNG({ width: 100, height: 100 });
        for (let offset = 0; offset < png.data.length; offset += 4) {
            png.data[offset] = 220;
            png.data[offset + 1] = 40;
            png.data[offset + 2] = 40;
            png.data[offset + 3] = 255;
        }
        fs.writeFileSync(probePath, PNG.sync.write(png));

        const ipcResult = await page.evaluate(async (mediaFile) => {
            const zeroCrop = await window.electronAPI.qaPreCropMedia({
                mediaFile,
                crop: {},
            });
            const validCrop = await window.electronAPI.qaPreCropMedia({
                mediaFile,
                crop: { cropLeft: 10, cropRight: 10 },
            });
            return { zeroCrop, validCrop };
        }, probePath);

        const cropped = PNG.sync.read(fs.readFileSync(probePath));
        const leftovers = fs.readdirSync(PUBLIC_DIR).filter((name) => name.startsWith(`${probeName}.qa-`));
        const checks = [
            ['zero-size crop is rejected', ipcResult.zeroCrop?.success === false],
            ['valid in-project crop succeeds', ipcResult.validCrop?.success === true],
            ['crop keeps the original media path',
                fs.realpathSync.native(ipcResult.validCrop?.mediaFile || '').toLowerCase()
                    === fs.realpathSync.native(probePath).toLowerCase()],
            ['FFmpeg crop changed 100x100 to 80x100', cropped.width === 80 && cropped.height === 100],
            ['transaction left no temp or backup files', leftovers.length === 0],
        ];

        console.log('\n=== RUNTIME QA CROP PROBE ===');
        let passed = 0;
        for (const [name, ok] of checks) {
            if (ok) passed++;
            console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}`);
        }
        console.log(`\n${passed === checks.length ? 'ALL PASS' : 'SOME FAILED'} (${passed}/${checks.length})`);
        process.exitCode = passed === checks.length ? 0 : 1;
    } finally {
        if (browser) await browser.disconnect().catch(() => { });
        removeProbeArtifacts();
    }
})().catch((error) => {
    console.error(`RUNTIME QA CROP PROBE ERROR: ${error.message}`);
    process.exitCode = 3;
});
