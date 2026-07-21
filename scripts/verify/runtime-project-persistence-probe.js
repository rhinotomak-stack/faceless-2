#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const puppeteer = require('puppeteer-core');

const ROOT = path.resolve(__dirname, '..', '..');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-runtime-persist-'));
const publicDir = path.join(fixtureRoot, 'public');
const tempDir = path.join(fixtureRoot, 'temp');
const fvpPath = path.join(fixtureRoot, `${path.basename(fixtureRoot)}.fvp`);
const electronPath = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const userDataRoot = path.join(fixtureRoot, 'user-data');

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function waitForEndpoint(endpointUrl, timeoutMs = 45_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(endpointUrl);
            if (response.ok) {
                const data = await response.json();
                if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
            }
        } catch (_) { }
        await wait(250);
    }
    throw new Error('Timed out waiting for Electron DevTools endpoint');
}

async function terminateTree(child) {
    if (!child || child.exitCode != null) return;
    await new Promise((resolve) => {
        execFile(
            'taskkill',
            ['/pid', String(child.pid), '/f', '/t'],
            { windowsHide: true, timeout: 10_000 },
            () => resolve()
        );
    });
}

function cleanupFixture() {
    const tempRoot = path.resolve(os.tmpdir());
    const resolved = path.resolve(fixtureRoot);
    const relative = path.relative(tempRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
        || !path.basename(resolved).startsWith('yta-runtime-persist-')) {
        throw new Error(`Refusing to clean unexpected fixture path: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
}

(async () => {
    const stalePlan = {
        totalDuration: 5,
        fps: 30,
        scenes: [{ index: 0, trackId: 'video-track-1', startTime: 0, endTime: 5, text: 'stale-fvp-plan' }],
    };
    const buildPlan = {
        totalDuration: 7,
        fps: 30,
        scenes: [{ index: 0, trackId: 'video-track-1', startTime: 0, endTime: 7, text: 'newer-build-plan' }],
        motionGraphics: [{
            id: 'persist-lower-third',
            type: 'lowerThird',
            startTime: 1,
            duration: 3,
            text: 'Persistence',
            disabled: true,
            variant: 'box',
            colors: {
                primary: '#ef4444',
                background: 'rgba(10,20,30,0.7)',
            },
            items: [{ label: 'A', value: '1' }],
            visualIntent: 'preserve this complete visual contract',
            agenticComposition: {
                layout: 'lower-third',
                safeZone: 'bottom-left',
                motion: { entrance: 'wipeRight', speed: 1.2 },
            },
            _authoredComposition: {
                html: '<div>Persistence</div>',
                css: '.x{color:red}',
                timeline: 'const tl = gsap.timeline();',
            },
            _authoredAssets: [{ token: '__HF_ASSET_0__', path: 'asset.png' }],
        }],
    };
    const settings = {
        videoTitle: 'Persistence Fixture',
        aiInstructions: 'Keep the project instructions after reload',
        buildTheme: 'history',
    };
    writeJson(fvpPath, {
        version: 1,
        savedAt: new Date(Date.now() - 60_000).toISOString(),
        settings,
        videoPlan: stalePlan,
    });
    const publicPlanPath = path.join(publicDir, 'video-plan.json');
    writeJson(publicPlanPath, buildPlan);
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(publicPlanPath, future, future);

    const logs = [];
    let child = null;
    let browser = null;
    try {
        const debugPort = await getFreePort();
        const endpointUrl = `http://127.0.0.1:${debugPort}/json/version`;
        const env = {
            ...process.env,
            YTA_REMOTE_DEBUG: '1',
            YTA_REMOTE_DEBUG_PORT: String(debugPort),
            YTA_TEST_USER_DATA_DIR: userDataRoot,
            EXPORT_V2: '0',
        };
        delete env.ELECTRON_RUN_AS_NODE;
        child = spawn(
            electronPath,
            [ROOT, '--dev', `--project=${fixtureRoot}`],
            {
                cwd: ROOT,
                env,
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            }
        );
        child.stdout.on('data', (data) => logs.push(data.toString()));
        child.stderr.on('data', (data) => logs.push(data.toString()));

        const browserWSEndpoint = await waitForEndpoint(endpointUrl);
        browser = await puppeteer.connect({ browserWSEndpoint, defaultViewport: null });
        let page = null;
        const deadline = Date.now() + 30_000;
        while (!page && Date.now() < deadline) {
            page = (await browser.pages()).find((candidate) => /ui\/index\.html/i.test(candidate.url()));
            if (!page) await wait(200);
        }
        if (!page) throw new Error('Main renderer page did not open');
        await page.waitForFunction(
            () => typeof window.electronAPI?.loadProjectFile === 'function'
                && typeof window.electronAPI?.getProjectInfo === 'function',
            { timeout: 30_000 }
        );
        const projectInfo = await page.evaluate(() => window.electronAPI.getProjectInfo());
        assert.strictEqual(
            path.resolve(projectInfo.projectDir),
            path.resolve(fixtureRoot),
            'DevTools endpoint belongs to a different Electron project; refusing to mutate it'
        );
        let restoredUi = null;
        const restoreDeadline = Date.now() + 30_000;
        while (Date.now() < restoreDeadline) {
            restoredUi = await page.evaluate(() => ({
                videoTitle: document.getElementById('video-title')?.value,
                aiInstructions: document.getElementById('ai-instructions')?.value,
            }));
            if (restoredUi.videoTitle === settings.videoTitle
                && restoredUi.aiInstructions === settings.aiInstructions) break;
            await wait(200);
        }
        assert.deepStrictEqual(restoredUi, {
            videoTitle: settings.videoTitle,
            aiInstructions: settings.aiInstructions,
        });
        const persistedGraphic = await page.evaluate(() => (
            syncVideoPlanFromEditor().motionGraphics.find((graphic) => graphic.id === 'persist-lower-third')
        ));
        assert.ok(persistedGraphic, 'disabled overlay graphic must remain persisted');
        assert.strictEqual(persistedGraphic.disabled, true);
        assert.strictEqual(persistedGraphic.variant, 'box');
        assert.strictEqual(persistedGraphic.colors.primary, '#ef4444');
        assert.strictEqual(persistedGraphic.agenticComposition.motion.speed, 1.2);
        assert.deepStrictEqual(persistedGraphic.items, [{ label: 'A', value: '1' }]);
        assert.strictEqual(persistedGraphic._authoredComposition.html, '<div>Persistence</div>');
        assert.strictEqual(persistedGraphic._authoredAssets[0].token, '__HF_ASSET_0__');

        const initial = await page.evaluate(async () => {
            const loaded = await window.electronAPI.loadProjectFile();
            const loadedText = loaded.videoPlan.scenes[0].text;
            const loadedSettings = loaded.settings;
            loaded.videoPlan.scenes[0].text = 'plan-only-ipc-save';
            const save = await window.electronAPI.saveVideoPlan(loaded.videoPlan);
            const afterSave = await window.electronAPI.loadProjectFile();
            return { loadedText, loadedSettings, save, afterSave };
        });

        assert.strictEqual(initial.loadedText, 'newer-build-plan');
        assert.deepStrictEqual(initial.loadedSettings, settings);
        assert.strictEqual(initial.save.success, true);
        assert.strictEqual(initial.afterSave.videoPlan.scenes[0].text, 'plan-only-ipc-save');
        assert.deepStrictEqual(initial.afterSave.settings, settings);

        const externalPlan = {
            totalDuration: 9,
            fps: 30,
            scenes: [{ index: 0, trackId: 'video-track-1', startTime: 0, endTime: 9, text: 'external-build-after-open' }],
        };
        writeJson(publicPlanPath, externalPlan);
        const later = new Date(Date.now() + 10_000);
        fs.utimesSync(publicPlanPath, later, later);

        const afterExternalBuild = await page.evaluate(async () => (
            window.electronAPI.loadProjectFile()
        ));
        assert.strictEqual(afterExternalBuild.videoPlan.scenes[0].text, 'external-build-after-open');
        assert.ok(String(afterExternalBuild.source).startsWith('reconciled:public/video-plan.json'));
        assert.deepStrictEqual(afterExternalBuild.settings, settings);

        const publicPlan = readJson(path.join(publicDir, 'video-plan.json'));
        const tempPlan = readJson(path.join(tempDir, 'video-plan.json'));
        const envelope = readJson(fvpPath);
        assert.deepStrictEqual(publicPlan, externalPlan);
        assert.deepStrictEqual(tempPlan, externalPlan);
        assert.deepStrictEqual(envelope.videoPlan, externalPlan);
        assert.deepStrictEqual(envelope.settings, settings);
        assert.strictEqual(envelope.version, 2);
        assert.ok(envelope.revision >= 3);

        const freshBuildFields = {
            videoTitle: 'Fresh Build Title',
            aiInstructions: 'Fresh build instructions must beat stale project settings',
        };
        const freshBuildResult = await page.evaluate(async (fields) => {
            const title = document.getElementById('video-title');
            const instructions = document.getElementById('ai-instructions');
            title.value = fields.videoTitle;
            instructions.value = fields.aiInstructions;
            title.dispatchEvent(new Event('input', { bubbles: true }));
            instructions.dispatchEvent(new Event('input', { bubbles: true }));

            await loadVideoPlan({ freshBuild: true });
            const afterReload = {
                videoTitle: title.value,
                aiInstructions: instructions.value,
            };
            const save = await saveProject(true);
            return { afterReload, save };
        }, freshBuildFields);
        assert.deepStrictEqual(freshBuildResult.afterReload, freshBuildFields);
        assert.strictEqual(freshBuildResult.save.success, true);
        const afterFreshBuildSave = readJson(fvpPath);
        assert.strictEqual(afterFreshBuildSave.settings.videoTitle, freshBuildFields.videoTitle);
        assert.strictEqual(afterFreshBuildSave.settings.aiInstructions, freshBuildFields.aiInstructions);

        console.log('\n=== RUNTIME PROJECT PERSISTENCE PROBE ===');
        console.log('[PASS] newer build JSON superseded stale .fvp');
        console.log('[PASS] plan-only IPC save preserved project settings');
        console.log('[PASS] external build after open was detected and reconciled');
        console.log('[PASS] .fvp/public/temp converged on one plan');
        console.log('[PASS] project envelope migrated to version 2');
        console.log('[PASS] title and AI instructions restored into the project UI');
        console.log('[PASS] fresh-build reload preserved live title and AI instructions');
        console.log('[PASS] complete disabled motion-graphic contracts survived editor serialization');
        console.log('\nALL PASS (8/8)');
    } catch (error) {
        console.error(`RUNTIME PROJECT PERSISTENCE PROBE ERROR: ${error.message}`);
        const tail = logs.join('').split(/\r?\n/).slice(-40).join('\n');
        if (tail) console.error(tail);
        process.exitCode = 1;
    } finally {
        if (browser) await browser.disconnect().catch(() => { });
        await terminateTree(child);
        await wait(300);
        cleanupFixture();
    }
})();
