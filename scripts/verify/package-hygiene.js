#!/usr/bin/env node
'use strict';

const { execSync } = require('child_process');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const raw = execSync('npm pack --dry-run --json', {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
});
const report = JSON.parse(raw)[0];
const forbidden = [
    /^\.claude\//,
    /^\.lock$/,
    /(?:^|\/)\.yta-project\.json$/,
    /^\.fvp-registered$/,
    /(?:^|\/)recent-projects\.json$/,
    /(?:^|\/)\.qa-exhausted-models\.json$/,
    /(?:^|\/)\.qwen-exhausted-models\.json$/,
    /^public\//,
    /^hyperframes\//,
    /\.fvp$/i,
    /^storyblocks-login-dump\.png$/i,
    /^temp-reddit-search.*\.html$/i,
];
const leaked = report.files
    .map((entry) => entry.path.replace(/\\/g, '/'))
    .filter((filePath) => forbidden.some((pattern) => pattern.test(filePath)));
if (leaked.length) {
    console.error('[package-hygiene] forbidden files included:');
    leaked.forEach((filePath) => console.error(`  ❌ ${filePath}`));
    process.exit(1);
}
if (report.unpackedSize > 200 * 1024 * 1024) {
    console.error(`[package-hygiene] unpacked package exceeds 200 MB: ${report.unpackedSize}`);
    process.exit(1);
}
console.log(`✅ package whitelist clean (${report.files.length} files, ${(report.size / 1024 / 1024).toFixed(1)} MB archive)`);
