// src/settings/build-env.js
// ============================================================================
// The ONE place that turns runBuild `options` into the child-process env for the
// pipeline. Extracted from main.js verbatim (behavior-preserving) so it's unit-
// testable against a frozen reference (scripts/verify-settings.js). Uniform
// settings are driven by the schema; fan-outs / conditional logic stay explicit.
// Returns { env, isSmartAI, repeatFromStep } — main.js needs isSmartAI for --dumb.
// ============================================================================
'use strict';
const path = require('path');
const { SETTINGS } = require('./schema');

function applyOptionsToEnv(options = {}, { projectDir, baseEnv = process.env } = {}) {
    const env = { ...baseEnv, FORCE_COLOR: '0', PROJECT_DIR: projectDir };

    // Runtime + project-scoped strings (always set, exactly as main.js did).
    if (options.audioFileName) env.BUILD_AUDIO_FILE = options.audioFileName;
    if (options.footageSources) env.FOOTAGE_SOURCES = JSON.stringify(options.footageSources);
    env.VIDEO_TITLE = String(options.videoTitle || '').trim();
    env.AI_INSTRUCTIONS = String(options.aiInstructions || '').trim();

    // Uniform conditional settings (build:'if') — set only when truthy.
    for (const s of SETTINGS) {
        if (s.build === 'if' && s.env && options[s.key]) env[s.env] = options[s.key];
    }

    // Kling avatar bridge (fan-out).
    if (options.klingAvatar) {
        env.KLING_AVATAR = '1';
        env.KLING_RESOLUTION = options.klingResolution || '1080p';
        if (options.klingAvatarPrompt) env.KLING_AVATAR_PROMPT = options.klingAvatarPrompt;
    }

    // AI-video generator (fan-out): veoBackend -> {AI_VIDEO_BACKEND, VEO_BACKEND},
    // veoResolution -> {VEO_RESOLUTION, KLING_VIDEO_RESOLUTION}.
    if (options.veoAiVideo) {
        env.VEO_AI_VIDEO = '1';
        env.VEO_SCOPE = options.veoScope || 'directives';
        const gen = String(options.veoBackend || 'kling').toLowerCase();
        if (gen === 'veo-fal') { env.AI_VIDEO_BACKEND = 'veo'; env.VEO_BACKEND = 'fal'; }
        else if (gen === 'veo-gemini') { env.AI_VIDEO_BACKEND = 'veo'; env.VEO_BACKEND = 'gemini'; }
        else { env.AI_VIDEO_BACKEND = 'kling'; }
        if (options.veoResolution) {
            env.VEO_RESOLUTION = options.veoResolution;
            env.KLING_VIDEO_RESOLUTION = options.veoResolution;
        }
    }

    if (options.fastMedia) env.BUILD_FAST_MEDIA = 'true';
    if (options.buildStyleProfile && options.buildStyleProfile !== 'none') env.BUILD_STYLE_PROFILE = options.buildStyleProfile;

    // Smart AI (also drives the --dumb CLI arg in main.js via the returned flag).
    const isSmartAI = options.smartAI !== false && options.smartAI !== 'false';
    env.SMART_AI = isSmartAI ? 'true' : 'false';

    const clipAnalyzerOn = options.clipAnalyzer !== false && options.clipAnalyzer !== 'false';
    env.CLIP_ANALYZER_ENABLED = clipAnalyzerOn ? 'true' : 'false';

    // Resume + repeat-from-step (repeat-from-media forces resume ON + may force-fresh footage).
    const resumeOn = options.buildResume === true || options.buildResume === 'true';
    env.BUILD_RESUME = resumeOn ? 'true' : 'false';
    const repeatFromStep = String(options.repeatFromStep || '').trim();
    if (repeatFromStep) {
        env.BUILD_REPEAT_FROM = repeatFromStep;
        if (['media', 'download-media', 'footage', 'step5', 'step-5'].includes(repeatFromStep.toLowerCase())) {
            env.BUILD_RESUME = 'true';
            if (options.forceFreshFootage) env.BUILD_FORCE_FRESH_FOOTAGE = 'true';
        }
    }

    // AI thinking mode (accepts the geminiThinking alias, as main.js did).
    env.AI_THINKING = options.aiThinking || options.geminiThinking || 'off';

    // Project-local .env for the pipeline.
    env.DOTENV_PATH = path.join(projectDir, '.env');

    return { env, isSmartAI, repeatFromStep };
}

module.exports = { applyOptionsToEnv };
