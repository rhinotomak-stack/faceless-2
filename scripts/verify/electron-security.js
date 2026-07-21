#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'ui', 'js', 'app.js'), 'utf8');
const qaStudio = fs.readFileSync(path.join(ROOT, 'ui', 'js', 'qa-studio-app.js'), 'utf8');
const styleStudio = fs.readFileSync(path.join(ROOT, 'ui', 'js', 'style-studio-app.js'), 'utf8');
const mgRenderer = fs.readFileSync(path.join(ROOT, 'ui', 'js', 'compositor', 'MGRenderer.js'), 'utf8');
const exportPipeline = fs.readFileSync(path.join(ROOT, 'ui', 'js', 'compositor', 'ExportPipeline.js'), 'utf8');
const uiDir = path.join(ROOT, 'ui');
const failures = [];

function check(condition, message) {
    if (!condition) failures.push(message);
}

const browserWindowCount = (main.match(/new BrowserWindow\s*\(/g) || []).length;
const hardenedWindows = [
    'startupWindow',
    'footageResourcesWindow',
    'mainWindow',
    'qaStudioWindow',
    'styleStudioWindow',
].reduce((total, name) => {
    const matches = main.match(new RegExp(`hardenRendererWindow\\(${name},\\s*['"]`, 'g')) || [];
    return total + matches.length;
}, 0);

check(browserWindowCount > 0, 'no BrowserWindow construction sites found');
check(
    hardenedWindows === browserWindowCount,
    `expected every BrowserWindow to be hardened (${browserWindowCount} windows, ${hardenedWindows} hardening calls)`
);
check(
    (main.match(/contextIsolation:\s*true/g) || []).length === browserWindowCount,
    'every BrowserWindow must enable contextIsolation'
);
check(
    (main.match(/sandbox:\s*true/g) || []).length === browserWindowCount,
    'every BrowserWindow must enable the Chromium sandbox'
);
check(
    (main.match(/nodeIntegration:\s*false/g) || []).length === browserWindowCount,
    'every BrowserWindow must disable nodeIntegration'
);
check(!main.includes("appendSwitch('no-sandbox'"), 'Electron app enables --no-sandbox');
check(!main.includes("appendSwitch('disable-gpu-sandbox'"), 'Electron app disables the GPU sandbox');
check(main.includes('app.enableSandbox()'), 'app-wide sandbox enablement is missing');
check(
    main.includes("/^(1|true|on)$/i.test(String(process.env.YTA_REMOTE_DEBUG"),
    'remote debugging is not explicit opt-in'
);
check(main.includes('contents.setWindowOpenHandler'), 'new-window blocking is missing');
check(main.includes("contents.on('will-navigate'"), 'top-level navigation blocking is missing');
check(main.includes("contents.on('will-attach-webview'"), 'webview blocking is missing');
check(main.includes('setPermissionCheckHandler'), 'permission check denial is missing');
check(main.includes('setPermissionRequestHandler'), 'permission request denial is missing');
check(main.includes("scheme: 'hf-preview'"), 'isolated HyperFrames preview scheme is missing');
check(main.includes("protocol.handle('hf-preview'"), 'isolated HyperFrames preview handler is missing');
check(main.includes("'Accept-Ranges': 'bytes'") && main.includes("'Content-Range'"), 'local media protocols do not support byte-range seeking');
check(!main.includes('bypassCSP: true'), 'a custom protocol still bypasses CSP');
check(!preload.includes('window._nodeSpawn'), 'preload exposes child_process.spawn to renderers');
check(!preload.includes('window._nodePath'), 'preload exposes Node path helpers to renderers');
check(!preload.includes('window._nodeFs'), 'preload exposes Node filesystem helpers to renderers');
check(!preload.includes("require('child_process')"), 'preload loads child_process');
check(preload.includes('contextBridge.exposeInMainWorld'), 'preload does not use contextBridge');
check(!/require\(['"]\.{1,2}\//.test(preload), 'sandboxed preload loads an application module');
check(!preload.includes('window._qaStudioAgent'), 'preload exposes QA Studio module directly');
check(!preload.includes('window._qaChatAgent'), 'preload exposes QA Chat module directly');
check(!preload.includes('window._qaReplacer'), 'preload exposes QA replacer module directly');
check(main.includes('IPC_ROLE_CHANNELS'), 'role-scoped IPC allowlist is missing');
check(main.includes('_rendererRoles.get(event.sender.id)'), 'IPC handlers are not bound to the sender window role');
check(!app.includes('window._nodeFs') && !app.includes('window._nodePath'), 'main renderer still uses raw Node globals');
check(!qaStudio.includes('window._nodeSpawn') && !qaStudio.includes('window._nodeFs') && !qaStudio.includes('window._nodePath'), 'QA Studio still uses raw Node globals');
check(!exportPipeline.includes('_spawn(') && !exportPipeline.includes('child_process'), 'ExportPipeline still spawns processes in the renderer');
check(main.includes("ipcMain.handle('qa-pre-crop-media'"), 'narrow QA pre-crop IPC is missing');
check(preload.includes('qaPreCropMedia:'), 'QA pre-crop IPC is not exposed through preload');
check(main.includes('candidate = fileURLToPath(candidate)'), 'legacy file URLs are not validated before asset conversion');
check(!qaStudio.includes("new URL('file:///"), 'QA Studio still constructs direct local file URLs');
check(qaStudio.includes('window.electronAPI.getFileUrl(candidate)'), 'QA Studio media does not use confined asset IPC');
check(!mgRenderer.includes("iconPath.startsWith('file:')"), 'MG renderer still trusts direct file URLs');
check(main.includes('const safeResults = _boundedPlainObject(data, 8 * 1024 * 1024);'), 'QA results IPC is not size-bounded');

for (const retiredChannel of ['get-export-config', 'mux-audio', 'export-frame']) {
    check(!main.includes(`ipcMain.handle('${retiredChannel}'`), `retired IPC channel remains: ${retiredChannel}`);
    check(!preload.includes(`ipcRenderer.invoke('${retiredChannel}'`), `retired preload IPC remains: ${retiredChannel}`);
}

check(exportPipeline.includes('const IPC_FRAME_BATCH_SIZE = 3;'), 'renderer export batch bound is missing');
check(exportPipeline.includes('exportId: this._exportId'), 'renderer frame batches are not bound to an export ID');
check(main.includes('const WEBGL_EXPORT_BATCH_SIZE = 3;'), 'main export batch bound is missing');
check(main.includes('entry.frameIndex !== expectedIndex'), 'main does not reject out-of-order export frames');
check(main.includes('buffer.length !== expectedSize'), 'main does not reject wrong-sized export frames');
check(main.includes('exp.framesWritten !== exp.totalFrames'), 'main does not verify the final export frame count');
check(main.includes('exp.ownerWebContentsId !== event.sender.id'), 'main export IPC is not bound to its renderer owner');
check(main.includes("throw new Error('Stale or invalid export ID')"), 'main export IPC does not reject stale export IDs');

const forbiddenRendererFragments = [
    "${scene.text || ''}</div>",
    "title=\"${scene.text || scene.keyword || ''}",
    'title="${mg.type}: ${mg.text}',
    'title="${clipName}',
    '<span class="clip-label">${clipName}</span>',
    '<div class="notif-title">${n.title}</div>',
    '<div class="notif-desc">${n.body}</div>',
    '<strong>${title}</strong><span>${body}</span>',
];

for (const fragment of forbiddenRendererFragments) {
    check(!app.includes(fragment), `unsafe renderer HTML interpolation remains: ${fragment}`);
}

check(app.includes('text.textContent = scene.text ||'), 'scene sidebar text is not assigned through textContent');
check(app.includes('title.textContent = n.title ||'), 'notification titles are not assigned through textContent');
check(app.includes('description.textContent = n.body ||'), 'notification bodies are not assigned through textContent');
check(app.includes('escapeHTML(clipText)'), 'timeline clip titles are not escaped');
check(app.includes('escapeHTML(mg.text)'), 'timeline MG text is not escaped');
check(!app.includes('title="${state.audioFile.name}'), 'audio filename is interpolated into timeline HTML');
check(!app.includes('<span class="clip-label">${state.audioFile.name}</span>'), 'audio filename label is not escaped');
check(!styleStudio.includes('style="background:${color}'), 'Style Studio interpolates an unvalidated CSS color');

for (const name of fs.readdirSync(uiDir).filter((file) => file.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(uiDir, name), 'utf8');
    check(html.includes('Content-Security-Policy'), `${name} has no Content Security Policy`);
    check(!/script-src[^;]*(?:'unsafe-inline'|'unsafe-eval')/i.test(html), `${name} allows unsafe inline/eval scripts`);
    check(!/\son[a-z]+\s*=/i.test(html), `${name} contains an inline event handler`);
}

const indexHtml = fs.readFileSync(path.join(uiDir, 'index.html'), 'utf8');
check(
    /id="hyperframes-preview-frame"[^>]*sandbox="allow-scripts"/.test(indexHtml),
    'HyperFrames preview iframe sandbox is missing'
);
check(
    !/id="hyperframes-preview-frame"[^>]*sandbox="[^"]*allow-same-origin/.test(indexHtml),
    'HyperFrames preview iframe unnecessarily preserves its origin'
);

if (failures.length) {
    console.error('[electron-security] failed');
    for (const failure of failures) console.error(`  ❌ ${failure}`);
    process.exit(1);
}

console.log(`[electron-security] ${browserWindowCount} BrowserWindow creation sites hardened`);
console.log('✅ Electron navigation and renderer HTML guards present');
