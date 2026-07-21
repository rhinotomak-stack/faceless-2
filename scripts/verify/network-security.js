#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const {
    createByteLimitTransform,
    isPublicAddress,
    resolvePublicUrl,
} = require('../../src/security/safe-download');

const ROOT = path.resolve(__dirname, '..', '..');

assert.strictEqual(isPublicAddress('127.0.0.1'), false);
assert.strictEqual(isPublicAddress('10.1.2.3'), false);
assert.strictEqual(isPublicAddress('169.254.169.254'), false);
assert.strictEqual(isPublicAddress('192.168.1.1'), false);
assert.strictEqual(isPublicAddress('::1'), false);
assert.strictEqual(isPublicAddress('fc00::1'), false);
assert.strictEqual(isPublicAddress('8.8.8.8'), true);

assert.rejects(() => resolvePublicUrl('file:///etc/passwd'), /Blocked download protocol/);
assert.rejects(() => resolvePublicUrl('http://127.0.0.1/secret'), /private|reserved/i);
assert.rejects(() => resolvePublicUrl('http://user:pass@example.com/'), /credentials/i);

(async () => {
    await assert.rejects(
        pipeline(
            Readable.from([Buffer.alloc(8), Buffer.alloc(8)]),
            createByteLimitTransform(10),
            async function* consume(source) { for await (const chunk of source) yield chunk; }
        ),
        /exceeded/
    );

    const sourceFiles = fs.readdirSync(path.join(ROOT, 'src'), { recursive: true })
        .filter((name) => name.endsWith('.js'))
        .map((name) => path.join(ROOT, 'src', name));
    const unsafeStreams = [];
    for (const file of sourceFiles) {
        const text = fs.readFileSync(file, 'utf8');
        if (file.endsWith(path.join('security', 'safe-download.js'))) continue;
        if (/responseType\s*:\s*['"]stream['"]/.test(text)) unsafeStreams.push(path.relative(ROOT, file));
        if (/max(?:Content|Body)Length\s*:\s*Infinity/.test(text)) unsafeStreams.push(path.relative(ROOT, file));
    }
    assert.deepStrictEqual(unsafeStreams, [], `unsafe download paths: ${unsafeStreams.join(', ')}`);
    console.log('✅ media downloads reject private networks and enforce byte limits');
})().catch((error) => {
    console.error(`[network-security] ${error.stack || error.message}`);
    process.exit(1);
});
