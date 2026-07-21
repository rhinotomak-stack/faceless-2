#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yta-qa-path-smoke-'));
const projectDir = path.join(smokeRoot, 'project');
const outsideProjectFile = path.join(smokeRoot, 'outside.mp4');
const outsideMediaRootFile = path.join(projectDir, 'outside-roots.mp4');
const previousProjectDir = process.env.PROJECT_DIR;

(async () => {
    try {
        fs.mkdirSync(path.join(projectDir, 'public'), { recursive: true });
        fs.mkdirSync(path.join(projectDir, 'temp'), { recursive: true });
        fs.writeFileSync(outsideProjectFile, 'outside');
        fs.writeFileSync(outsideMediaRootFile, 'outside media roots');
        process.env.PROJECT_DIR = projectDir;

        const { replaceSceneMedia } = require('../../src/studio/qa-replacer');
        const attempts = [
            await replaceSceneMedia({ mediaFile: outsideProjectFile, keyword: 'blocked' }),
            await replaceSceneMedia({ mediaFile: outsideMediaRootFile, keyword: 'blocked' }),
            await replaceSceneMedia({ mediaFile: '../outside-roots.mp4', keyword: 'blocked' }),
        ];

        const rejected = attempts.every((result) =>
            result?.success === false
            && /inside the active project/i.test(String(result.error || ''))
        );
        if (!rejected) {
            console.error('[qa-replacer-security] an out-of-scope replacement destination was accepted');
            process.exitCode = 1;
            return;
        }
        console.log('✅ QA replacement rejects paths outside project media roots');
    } finally {
        if (previousProjectDir === undefined) delete process.env.PROJECT_DIR;
        else process.env.PROJECT_DIR = previousProjectDir;

        const resolved = path.resolve(smokeRoot);
        const tempRoot = path.resolve(os.tmpdir());
        const safePrefix = tempRoot.endsWith(path.sep) ? tempRoot : tempRoot + path.sep;
        if (!resolved.startsWith(safePrefix) || !path.basename(resolved).startsWith('yta-qa-path-smoke-')) {
            throw new Error(`Refusing to clean unsafe smoke directory: ${resolved}`);
        }
        fs.rmSync(resolved, { recursive: true, force: true });
    }
})().catch((error) => {
    console.error(`[qa-replacer-security] ${error.message}`);
    process.exit(1);
});
