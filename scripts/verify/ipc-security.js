#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(ROOT, 'preload.js'), 'utf8');
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

check(!main.includes("ipcMain.handle('copy-file'"), 'legacy arbitrary-destination copy-file IPC remains');
check(main.includes("ipcMain.handle('import-audio-file'"), 'safe audio import IPC is missing');
check(main.includes('const destPath = INPUT_PATH;'), 'audio import destination is not fixed to project input');
check(!preload.includes('copyFile:'), 'renderer still receives raw copy-file capability');
check(!preload.includes('getFilePath:'), 'renderer receives arbitrary native file paths from preload');
check(main.includes('_resolveGrantedFile(event, sourcePath)'), 'presenter copy is not bound to a picker grant');
check(main.includes('const allowedPrefixes = new Set'), 'scene media prefix allowlist is missing');
check(main.includes('const allowedExtensions = new Set'), 'scene media extension allowlist is missing');
check(main.includes('safeFilename !== String(filename)'), 'basename traversal checks are missing');
check(main.includes('_resolveExistingFileWithin(_projectReadableRoots(), candidate)'), 'get-file-url is not root-confined');
check(main.includes('candidate = fileURLToPath(candidate)'), 'legacy file URLs bypass path confinement');
check(!main.includes('...options\n    });'), 'select-file still spreads renderer-controlled dialog options');
check(main.includes('_resolveGrantedFile(event, audioPath)'), 'Style Studio transcription is not picker-bound');
check(main.includes('_resolveExistingFileWithin([previewRoot]'), 'HyperFrames protocol does not resolve real paths');
check(main.includes('_resolveExistingFileWithin(allowedRoots, filePath)'), 'asset protocol does not resolve real paths');
check(main.includes('const _projectLockNonce = crypto.randomBytes'), 'project lock has no per-process nonce');
check(main.includes("if (error.code !== 'EEXIST')"), 'project lock does not fail closed on unexpected errors');
check(
    main.includes('_writeProjectLockExclusive(lockFile, resolvedProjectDir)'),
    'stale lock recovery is not exclusive'
);

if (failures.length) {
    console.error('[ipc-security] failed');
    failures.forEach((failure) => console.error(`  ❌ ${failure}`));
    process.exit(1);
}
console.log('✅ IPC filesystem capabilities and protocol paths are confined');
