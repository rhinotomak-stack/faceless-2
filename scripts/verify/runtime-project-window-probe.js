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
const electronPath = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-runtime-project-window-'));
const projectADir = path.join(fixtureRoot, 'project-a');
const projectBDir = path.join(fixtureRoot, 'project-b');
const userDataRoot = path.join(fixtureRoot, 'user-data');

function writeJson(filePath, value) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function makeProject(projectDir, marker) {
    const plan = {
        totalDuration: 4,
        fps: 30,
        scenes: [{
            index: 0,
            sourceSceneIndex: 0,
            clipId: `${marker}-scene`,
            trackId: 'video-track-1',
            startTime: 0,
            endTime: 4,
            text: marker,
        }],
    };
    const envelope = {
        version: 2,
        revision: 1,
        savedAt: new Date().toISOString(),
        settings: { videoTitle: marker },
        videoPlan: plan,
    };
    writeJson(path.join(projectDir, `${path.basename(projectDir)}.fvp`), envelope);
    writeJson(path.join(projectDir, 'public', 'video-plan.json'), plan);
    writeJson(path.join(projectDir, 'temp', 'video-plan.json'), plan);
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function getFreePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
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

async function terminatePidTree(pid) {
    if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return;
    await new Promise(resolve => {
        execFile(
            'taskkill',
            ['/pid', String(pid), '/f', '/t'],
            { windowsHide: true, timeout: 10_000 },
            () => resolve()
        );
    });
}

async function terminateTree(child) {
    if (!child || child.exitCode != null) return;
    await terminatePidTree(child.pid);
}

async function waitForExit(child, timeoutMs = 15_000) {
    if (!child || child.exitCode != null) return child?.exitCode;
    return Promise.race([
        new Promise(resolve => child.once('exit', code => resolve(code))),
        new Promise((_, reject) => setTimeout(
            () => reject(new Error('Routing Electron instance did not exit')),
            timeoutMs
        )),
    ]);
}

async function waitForFile(filePath, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (fs.existsSync(filePath)) return;
        await wait(250);
    }
    throw new Error(`Timed out waiting for ${filePath}`);
}

function cleanupFixture() {
    const tempRoot = path.resolve(os.tmpdir());
    const resolved = path.resolve(fixtureRoot);
    const relative = path.relative(tempRoot, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)
        || !path.basename(resolved).startsWith('yta-runtime-project-window-')) {
        throw new Error(`Refusing to clean unexpected fixture path: ${resolved}`);
    }
    fs.rmSync(resolved, { recursive: true, force: true });
}

(async () => {
    makeProject(projectADir, 'project-a-loaded');
    makeProject(projectBDir, 'project-b-loaded');

    const logs = [];
    let primary = null;
    let routeA = null;
    let routeB = null;
    let projectBPid = null;
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

        primary = spawn(electronPath, [ROOT, '--dev'], {
            cwd: ROOT,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        primary.stdout.on('data', data => logs.push(`[primary] ${data}`));
        primary.stderr.on('data', data => logs.push(`[primary:err] ${data}`));

        const browserWSEndpoint = await waitForEndpoint(endpointUrl);
        browser = await puppeteer.connect({ browserWSEndpoint, defaultViewport: null });
        let page = null;
        const pageDeadline = Date.now() + 30_000;
        while (!page && Date.now() < pageDeadline) {
            page = (await browser.pages()).find(candidate => /ui\/index\.html/i.test(candidate.url()));
            if (!page) await wait(200);
        }
        if (!page) throw new Error('Primary workspace renderer did not open');
        await page.waitForFunction(
            () => typeof window.electronAPI?.getProjectInfo === 'function',
            { timeout: 30_000 }
        );

        const initialInfo = await page.evaluate(() => window.electronAPI.getProjectInfo());
        assert.strictEqual(initialInfo.isDefaultProject, true, 'primary must start in the default workspace');

        // First project: a normal secondary launch is consumed by the empty workspace.
        routeA = spawn(electronPath, [ROOT, '--dev', `--project=${projectADir}`], {
            cwd: ROOT,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        await waitForExit(routeA);

        let projectAInfo = null;
        const switchDeadline = Date.now() + 30_000;
        while (Date.now() < switchDeadline) {
            try {
                projectAInfo = await page.evaluate(() => window.electronAPI.getProjectInfo());
                if (path.resolve(projectAInfo.projectDir) === path.resolve(projectADir)) break;
            } catch (_) {
                // Same renderer is reloading during the in-place switch.
            }
            await wait(250);
        }
        assert.strictEqual(path.resolve(projectAInfo.projectDir), path.resolve(projectADir));
        assert.strictEqual(page.isClosed(), false, 'the empty workspace renderer must survive the first switch');
        const projectALock = JSON.parse(fs.readFileSync(path.join(projectADir, '.lock'), 'utf8'));
        assert.strictEqual(projectALock.pid, primary.pid, 'primary process must own the first project');
        assert.strictEqual(fs.existsSync(path.join(userDataRoot, 'workspace', '.lock')), false);
        assert.strictEqual(
            fs.existsSync(path.join(projectADir, '.yta-project.json')),
            true,
            'opening a legacy project must add the authoritative project marker'
        );

        // Second project: primary is already named, so it launches an isolated child.
        routeB = spawn(electronPath, [ROOT, '--dev', `--project=${projectBDir}`], {
            cwd: ROOT,
            env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        await waitForExit(routeB);
        const projectBLockPath = path.join(projectBDir, '.lock');
        await waitForFile(projectBLockPath);
        const projectBLock = JSON.parse(fs.readFileSync(projectBLockPath, 'utf8'));
        projectBPid = Number(projectBLock.pid);
        assert.ok(Number.isInteger(projectBPid) && projectBPid > 0);
        assert.notStrictEqual(projectBPid, primary.pid, 'second project must run in another process');
        process.kill(projectBPid, 0);
        await waitForFile(path.join(projectBDir, '.yta-project.json'));

        const stillProjectA = await page.evaluate(() => window.electronAPI.getProjectInfo());
        assert.strictEqual(
            path.resolve(stillProjectA.projectDir),
            path.resolve(projectADir),
            'opening project B must not replace or close project A'
        );
        const primaryPages = (await browser.pages()).filter(candidate => /ui\/index\.html/i.test(candidate.url()));
        assert.strictEqual(primaryPages.length, 1, 'primary process must keep its original project renderer');
        const projectALockAfter = JSON.parse(fs.readFileSync(path.join(projectADir, '.lock'), 'utf8'));
        assert.strictEqual(projectALockAfter.pid, primary.pid, 'project A lock must remain owned by primary');

        console.log('\n=== RUNTIME PROJECT WINDOW PROBE ===');
        console.log('[PASS] app starts with one empty workspace');
        console.log('[PASS] first project replaces the empty workspace in place');
        console.log('[PASS] original renderer survives the first project switch');
        console.log('[PASS] empty workspace lock is released');
        console.log('[PASS] first legacy project is upgraded with a project marker');
        console.log('[PASS] second project launches in another process');
        console.log('[PASS] second project process is alive and owns its lock');
        console.log('[PASS] second legacy project is upgraded with a project marker');
        console.log('[PASS] first project remains open and unchanged');
        console.log('[PASS] first project retains its own lock');
        console.log('\nALL PASS (10/10)');
    } catch (error) {
        console.error(`RUNTIME PROJECT WINDOW PROBE ERROR: ${error.message}`);
        const tail = logs.join('').split(/\r?\n/).slice(-80).join('\n');
        if (tail) console.error(tail);
        process.exitCode = 1;
    } finally {
        if (browser) await browser.disconnect().catch(() => { });
        await terminateTree(routeA);
        await terminateTree(routeB);
        await terminatePidTree(projectBPid);
        await terminateTree(primary);
        await wait(500);
        cleanupFixture();
    }
})();
