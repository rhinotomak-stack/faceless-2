#!/usr/bin/env node
// scripts/fix-dirname-paths.js — one-off P1 follow-up.
// Files that moved one folder DEEPER in P1 need one extra '..' in their
// __dirname-relative FILE paths (assets/, .env, temp/, root data files) — these
// aren't require() paths so verify:paths couldn't catch them. editor-agent/* and
// workers/* kept their depth, so they're excluded.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

// Moved from src/ -> src/<folder>/  (and providers/ -> media/providers/): depth +1.
const PLUS1 = [
    'src/data/themes.js', 'src/settings/recipe-loader.js', 'src/pipeline/build-video.js',
    'src/settings/config.js', 'src/agents/directors-brief.js', 'src/agents/ai-visual-planner.js',
    'src/brain/ai-provider.js', 'src/media/footage-manager.js', 'src/media/icon-provider.js',
    'src/studio/qa-features-context.js', 'src/studio/style-studio-agent.js', 'src/agents/smart-segment.js',
    'src/studio/qa-studio-agent.js', 'src/vision/lightning-rotation.js', 'src/vision/lightning-box.js',
    'src/vision/qwen-model-discovery.js', 'src/render/hf-template-author.js', 'src/studio/style-learner.js',
    'src/media/music-provider.js', 'src/media/sfx-provider.js', 'src/media/providers/ytdlp-utils.js',
];

// Root-reaching paths start with `.join(__dirname, '..'` — add one level.
// (matches path.join AND _path.join; a trailing arg like `, '..')` becomes `, '..', '..')`.)
let patched = 0, edits = 0;
for (const rel of PLUS1) {
    const f = path.join(ROOT, rel);
    const before = fs.readFileSync(f, 'utf8');
    const after = before.split(".join(__dirname, '..'").join(".join(__dirname, '..', '..'");
    if (after !== before) { fs.writeFileSync(f, after); patched++; edits += (before.match(/\.join\(__dirname, '\.\.'/g) || []).length; }
}

// Direct-child references to data files that STAYED at src/ (not moved by migrate-p1).
const CHILD = [
    ['src/brain/ai-provider.js', "path.join(__dirname, 'qwen-vision-generated-pools.json')", "path.join(__dirname, '..', 'qwen-vision-generated-pools.json')"],
    ['src/vision/qwen-model-discovery.js', "path.join(__dirname, 'qwen-vision-generated-pools.json')", "path.join(__dirname, '..', 'qwen-vision-generated-pools.json')"],
    ['src/vision/lightning-box.js', "path.join(__dirname, 'lightning-control.py')", "path.join(__dirname, '..', 'lightning-control.py')"],
];
for (const [rel, from, to] of CHILD) {
    const f = path.join(ROOT, rel);
    const s = fs.readFileSync(f, 'utf8');
    if (s.includes(from)) { fs.writeFileSync(f, s.split(from).join(to)); edits++; }
    else console.log(`  ⚠ direct-child pattern not found in ${rel} (already fixed?)`);
}
console.log(`patched ${patched} files, ~${edits} __dirname sites (+1 level)`);
