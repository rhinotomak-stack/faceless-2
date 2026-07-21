#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const html = read('ui/index.html');
const app = read('ui/js/app.js');
const css = read('ui/css/style.css');
const main = read('main.js');
const preload = read('preload.js');
const pipeline = read('src/pipeline/build-video.js');
const schema = read('src/settings/schema.js');
const buildEnv = read('src/settings/build-env.js');
const sourceLoader = read('src/categories/ai-videos/source-loader.js');
const aiVideoGenerate = read('src/categories/ai-videos/generate.js');
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };

for (const retiredId of [
    'sfx-enabled',
    'btn-download-sfx',
    'sfx-volume',
    'sfx-volume-label',
    'build-resume-toggle',
    'ollama-model',
    'ollama-vision-model',
    'music-track',
]) {
    check(!html.includes(`id="${retiredId}"`), `retired control remains in markup: ${retiredId}`);
}

check(!preload.includes('downloadRealSfx'), 'manual SFX downloader remains exposed to the renderer');
check(!main.includes("ipcMain.handle('download-real-sfx'"), 'manual SFX downloader IPC remains');
check(!app.includes('generateSfxClips'), 'editor still generates a second mechanical SFX track');
check(!app.includes('const SFX_MAP'), 'duplicate renderer SFX mapping remains');
check(!app.includes('state.sfxEnabled'), 'retired SFX enable state remains');
check(!app.includes('state.sfxVolume'), 'retired SFX volume state remains');
check(!pipeline.includes('sfxDesigned:'), 'retired SFX editor hint remains in the build plan');
check(app.includes('hydratePlanSfx(Array.isArray(plan.sfxClips) ? plan.sfxClips : [])'), 'editor does not hydrate the exact build-authored SFX track');
check(!main.includes('plan.sfxEnabled !== false'), 'export still honors the retired SFX toggle');
check(pipeline.includes("require('../agents/workers/sound-designer')"), 'agentic Sound Designer is not wired into the build');
check(pipeline.includes('downloadSfxForTransitions'), 'automatic build-time SFX acquisition is missing');
check(pipeline.includes('sfxClips: planSfxClips'), 'build plan does not persist Sound Designer clips');

check(!schema.includes('ollamaModel') && !schema.includes('ollamaVisionModel'), 'retired Ollama settings remain in the schema');
check(!app.includes('elements.ollamaModel'), 'retired Ollama UI code remains');
check(!app.includes('buildResumeToggle'), 'retired Resume UI code remains');
check(!buildEnv.includes('options.buildResume'), 'retired Resume option still changes build behavior');
check(buildEnv.includes("env.BUILD_RESUME = 'false';"), 'normal builds are not explicitly fresh');
check(!css.includes('music-track'), 'removed fake Music track still has CSS');
check(schema.includes("key: 'fastMedia'") && schema.includes("persist: [], group: 'Diagnostics'"), 'fast media still persists like a production preference');
check(html.includes('id="fast-media-group" class="diagnostic-settings"'), 'fast media is not isolated under pipeline diagnostics');
check(app.includes('elements.fastMediaToggle.checked = false;') && app.includes('Run Pipeline Test (Random Media)'), 'fast media is not visibly one-shot in the UI');

check(html.includes('id="subtitles-enabled"'), 'active subtitle render control was accidentally removed');
check(read('src/render/hyperframes-bridge.js').includes('if (!plan || !plan.subtitlesEnabled) return [];'), 'subtitle control no longer affects rendering');

for (const activeModeControl of [
    'production-mode-summary',
    'ai-videos-input-mode',
    'btn-import-ai-script',
    'ai-videos-script-url',
    'fallback-media-settings',
    'veo-ai-video-mode-badge',
]) {
    check(html.includes(`id="${activeModeControl}"`), `production-mode control is missing: ${activeModeControl}`);
}
check(app.includes("mode === 'aiVideos' && aiSource.kind === 'script'"), 'AI Videos still bypasses narration instead of routing by source');
check(app.includes('effective.veoAiVideo = true;') && app.includes("effective.veoScope = 'all';"), 'AI Videos does not enforce generator settings at build time');
check((app.match(/aiVideosInputMode: state\.aiVideosInputMode/g) || []).length >= 2, 'AI Videos input route is not persisted globally and per-project');
check(app.includes('aiVideosScript: state.aiVideosScript ||'), 'AI Videos story text is not persisted with the project');
check(buildEnv.includes("const aiVideosMode = productionMode === 'aiVideos';"), 'build env does not recognize AI Videos as a mandatory generator mode');
check(buildEnv.includes("env.VEO_SCOPE = aiVideosMode ? 'all'"), 'AI Videos build env does not force all eligible scenes into generation');
check(pipeline.includes("scene.sourceHint = aiVideosMode ? 'ai-video' : 'stock';"), 'Smart-AI-off narration path drops AI Videos back to stock');
check(main.includes("ipcMain.handle('read-ai-script-file'") && main.includes('_resolveGrantedFile(event, filePath)'), 'story file import is not protected by a picker grant');
check(main.includes("ipcMain.handle('load-ai-script-url'"), 'story URL import IPC is missing');
check(main.includes('generator?.restore?.();'), 'script generator settings leak into later builds');
check(main.includes('activeAiVideoJob.controller.abort();') && aiVideoGenerate.includes("if (signal?.aborted) throw new Error('Cancelled');"), 'script AI Video generation cannot be cancelled safely');
check(aiVideoGenerate.includes("createHash('sha256')") && aiVideoGenerate.includes('cacheKey'), 'script-generated clips can reuse stale scene-number cache files');
check(main.includes('_cleanupSupersededAiVideoClips(ctx.clips);'), 'superseded script-generated clips are never cleaned after a successful build');
check(sourceLoader.includes("requestSafeBuffer"), 'story URL import bypasses the SSRF-safe downloader');
check(sourceLoader.includes("new AdmZip(buffer)"), 'DOCX/ODT/EPUB story extraction is missing');

if (failures.length) {
    console.error('[settings-surface] failed');
    failures.forEach((failure) => console.error(`  ❌ ${failure}`));
    process.exit(1);
}

console.log('✅ settings surface contains only active controls; SFX authority stays in the build');
