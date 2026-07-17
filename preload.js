/**
 * YTA Empire WEBGL - Electron Preload Script
 * Exposes Electron IPC + Node.js primitives to the renderer.
 * Both windows use contextIsolation: false, so direct window assignment works.
 */

const { ipcRenderer, webUtils } = require('electron');
const { spawn } = require('child_process');
const _nodePath = require('path');
const _nodeFs = require('fs');

// Expose Node.js primitives for direct FFmpeg spawn (bypasses IPC for frame data)
window._nodeSpawn = spawn;
window._nodePath = _nodePath;
window._nodeFs = _nodeFs;

// Expose theme tokens to renderer (single source of truth from src/themes.js)
try {
    const themes = require('./src/data/themes');
    window._themeTokens = {
        getTokens: (themeId) => themes.getThemeTokens(themeId),
        getStylePreset: (styleName) => themes.getMGStylePreset(styleName),
        stylePresetNames: themes.getMGStylePresetNames(),
        themeIds: themes.getThemeIds(),
        applyModifier: (hexColor, mod) => themes.applyModifier(hexColor, mod),
    };
} catch (e) {
    console.warn('Theme tokens not available:', e.message);
}

// Expose MG Registry to renderer (categories, types, animations)
try {
    const mgReg = require('./src/render/mg-registry');
    window._mgRegistry = {
        registry: mgReg.MG_REGISTRY,
        getTypesForCategory: mgReg.getTypesForCategory,
        getAnimationsForCategory: mgReg.getAnimationsForCategory,
        resolveSubType: mgReg.resolveSubType,
        resolveAnimation: mgReg.resolveAnimation,
    };
} catch (e) {
    console.warn('MG Registry not available:', e.message);
}

// Expose Effect Presets to renderer (pre-made effect combos)
try {
    window._effectPresets = require('./src/render/effect-presets');
} catch (e) {
    console.warn('Effect presets not available:', e.message);
}

// Expose Language registry + helpers to renderer (multi-language support)
// The renderer uses these to: resolve language-specific font stacks for MGRenderer,
// populate the language dropdown in the build settings panel, and load Google Fonts
// for non-Latin scripts (e.g. Korean) on demand.
try {
    const languages = require('./src/data/languages');
    const langHelper = require('./src/data/language-helper');
    window._languages = {
        LANGUAGES: languages.LANGUAGES,
        DEFAULT_LANGUAGE: languages.DEFAULT_LANGUAGE,
        getLanguage: languages.getLanguage,
        isValidLanguage: languages.isValidLanguage,
        getSupportedLanguages: languages.getSupportedLanguages,
        getLanguageList: languages.getLanguageList,
    };
    window._languageHelper = {
        resolveLanguageFonts: langHelper.resolveLanguageFonts,
        getGoogleFontsUrl: langHelper.getGoogleFontsUrl,
        isRTL: langHelper.isRTL,
        resolveBuildLanguage: langHelper.resolveBuildLanguage,
    };
} catch (e) {
    console.warn('Language registry not available:', e.message);
}

// Expose QA Studio Agent to renderer (deep per-scene analysis — separate window)
try {
    window._qaStudioAgent = require('./src/studio/qa-studio-agent');
} catch (e) {
    console.warn('QA Studio Agent not available:', e.message);
}

// Expose QA Chat Agent to renderer (developer chat to test niche knowledge)
try {
    window._qaChatAgent = require('./src/studio/qa-chat-agent');
} catch (e) {
    console.warn('QA Chat Agent not available:', e.message);
}

// Expose QA Replacer to renderer (surgical scene re-download + article re-screenshot on Apply Fixes)
try {
    const qaReplacer = require('./src/studio/qa-replacer');
    window._qaReplacer = qaReplacer; // { replaceSceneMedia, rescreenhotArticle }
} catch (e) {
    console.warn('QA Replacer not available:', e.message);
}


// Expose Scene Actions to renderer (timeline right-click: retry footage / CEO edit)
try {
    window._sceneActions = require('./src/agents/scene-actions'); // { retrySceneMedia, ceoEditScene }
} catch (e) {
    console.warn('Scene Actions not available:', e.message);
}

// Expose Vision Box control to renderer (auto start/stop the AWS GPU box around retries)
try {
    window._visionBox = require('./src/vision/vision-box'); // { isConfigured, status, ensureReady, stop, ... }
} catch (e) {
    console.warn('Vision Box control not available:', e.message);
}


// Expose country boundary GeoJSON to renderer (production map-scene polygon fills in MGRenderer)
try {
    const geoPath = _nodePath.join(__dirname, 'assets', 'geo', 'countries-slim.json');
    if (_nodeFs.existsSync(geoPath)) {
        window._countryGeoJSON = JSON.parse(_nodeFs.readFileSync(geoPath, 'utf8'));
        console.log(`[Geo] Loaded ${window._countryGeoJSON.features.length} country boundaries`);
    }
} catch (e) {
    console.warn('Country GeoJSON not available:', e.message);
}

// Expose Electron IPC methods to the renderer process
window.electronAPI = {
    // Copy file to project folder
    copyFile: (sourcePath, destFolder) => {
        return ipcRenderer.invoke('copy-file', sourcePath, destFolder);
    },

    // Copy a presenter image into the active project's assets/ folder (talking-head mode)
    copyPresenterImage: (sourcePath) => {
        return ipcRenderer.invoke('copy-presenter-image', sourcePath);
    },

    // Run the build pipeline
    runBuild: (options) => {
        return ipcRenderer.invoke('run-build', options);
    },

    // Switch the creative brain (AI Provider dropdown) live
    setAiProvider: (value) => {
        return ipcRenderer.invoke('set-ai-provider', value);
    },

    // Load video plan
    loadVideoPlan: () => {
        return ipcRenderer.invoke('load-video-plan');
    },

    // Save video plan
    saveVideoPlan: (plan) => {
        return ipcRenderer.invoke('save-video-plan', plan);
    },

    // QA results persistence — auto-save/load so closing QA Studio doesn't lose analysis
    saveQAResults: (data) => ipcRenderer.invoke('save-qa-results', data),
    loadQAResults: () => ipcRenderer.invoke('load-qa-results'),

    // Push QA-fixed plan to main window memory (called from QA Studio after applying fixes)
    pushPlanToMain: (plan) => ipcRenderer.invoke('push-plan-to-main', plan),

    // Main window listens for QA Studio pushing fixes (called in app.js)
    onQAPlanUpdated: (callback) => ipcRenderer.on('qa-plan-updated', (event, plan) => callback(plan)),

    // Get scene video path (backward compat)
    getSceneVideoPath: (sceneIndex) => {
        return ipcRenderer.invoke('get-scene-video-path', sceneIndex);
    },

    // Get scene media path (video or image, with extension hint and optional prefix)
    getSceneMediaPath: (sceneIndex, extension, prefix) => {
        return ipcRenderer.invoke('get-scene-media-path', sceneIndex, extension, prefix);
    },

    // Run timeline scene actions in the main process so media downloads use Node
    // networking, not renderer/XHR rules.
    sceneAction: (payload) => ipcRenderer.invoke('scene-action', payload || {}),
    onSceneActionProgress: (callback) => {
        ipcRenderer.removeAllListeners('scene-action-progress');
        ipcRenderer.on('scene-action-progress', (event, data) => callback(data));
        return () => ipcRenderer.removeAllListeners('scene-action-progress');
    },

    // Conversational ACTING agent: compile a free-text order → apply to the built
    // plan (per-scene + compliance fixers) → re-download footage → refresh preview.
    qaPreviewOrder: (text) => ipcRenderer.invoke('qa-preview-order', { text }),
    qaApplyOrder: (text) => ipcRenderer.invoke('qa-apply-order', { text }),
    qaUndo: () => ipcRenderer.invoke('qa-undo'),

    // Open a web URL in the default browser (Media Log link clicks)
    openExternal: (url) => ipcRenderer.invoke('open-external', url),

    // Get audio path
    getAudioPath: (filename) => {
        return ipcRenderer.invoke('get-audio-path', filename);
    },

    // Get file URL for video playback
    getFileUrl: (filePath) => {
        return ipcRenderer.invoke('get-file-url', filePath);
    },

    // Open output folder
    openOutputFolder: () => {
        return ipcRenderer.invoke('open-output-folder');
    },

    // Open current project logs folder
    openProjectLogs: () => {
        return ipcRenderer.invoke('open-project-logs');
    },

    // Open live tail window for current project log
    tailProjectLogs: () => {
        return ipcRenderer.invoke('tail-project-logs');
    },

    // Get current log file path
    getCurrentLogFile: () => {
        return ipcRenderer.invoke('get-current-log-file');
    },

    // Open file in default app
    openFile: (filePath) => {
        return ipcRenderer.invoke('open-file', filePath);
    },

    // File dialog
    selectFile: (options) => {
        return ipcRenderer.invoke('select-file', options);
    },

    // Folder dialog
    selectFolder: (title) => {
        return ipcRenderer.invoke('select-folder', title);
    },

    // Listen for progress updates
    onBuildProgress: (callback) => {
        ipcRenderer.on('build-progress', (event, data) => callback(data));
    },

    // Structured Build Log events (phase/scene/note) for the in-app log panel.
    onBuildEvent: (callback) => {
        ipcRenderer.on('build-event', (event, data) => callback(data));
    },

    onRenderProgress: (callback) => {
        ipcRenderer.on('render-progress', (event, data) => callback(data));
    },

    // Menu commands from main process
    onMenuUndo: (callback) => { ipcRenderer.on('menu-undo', () => callback()); },
    onMenuCopy: (callback) => { ipcRenderer.on('menu-copy', () => callback()); },
    onMenuPaste: (callback) => { ipcRenderer.on('menu-paste', () => callback()); },
    onMenuSave: (callback) => { ipcRenderer.on('menu-save', () => callback()); },
    onMenuDelete: (callback) => { ipcRenderer.on('menu-delete', () => callback()); },
    onMenuSelectAll: (callback) => { ipcRenderer.on('menu-select-all', () => callback()); },
    onMenuNew: (callback) => { ipcRenderer.on('menu-new', () => callback()); },

    // Show OS notification
    showNotification: (title, body) => {
        ipcRenderer.invoke('show-notification', title, body);
    },

    // Cancel active build/render process
    cancelProcess: () => {
        return ipcRenderer.invoke('cancel-process');
    },

    // Get SFX file path for preview playback
    getSfxPath: (filename) => {
        return ipcRenderer.invoke('get-sfx-path', filename);
    },

    // Download real SFX from Freesound API
    downloadRealSfx: () => {
        return ipcRenderer.invoke('download-real-sfx');
    },

    // Scan assets/overlays/ folder for available overlay files
    scanOverlays: () => {
        return ipcRenderer.invoke('scan-overlays');
    },

    // Get overlay file URL for preview playback
    getOverlayUrl: (filename) => {
        return ipcRenderer.invoke('get-overlay-url', filename);
    },

    // Scan assets/backgrounds/ folder for available background pattern files
    scanBackgrounds: () => {
        return ipcRenderer.invoke('scan-backgrounds');
    },

    // Get background file URL for preview
    getBackgroundUrl: (filename) => {
        return ipcRenderer.invoke('get-background-url', filename);
    },

    // Get filesystem path from a File object (required for sandboxed Electron 20+)
    getFilePath: (file) => webUtils.getPathForFile(file),

    // Desktop shortcut
    createDesktopShortcut: () => ipcRenderer.invoke('create-desktop-shortcut'),

    // Multi-instance / project management
    getProjectInfo: () => ipcRenderer.invoke('get-project-info'),
    launchNewInstance: (options) => ipcRenderer.invoke('launch-new-instance', options),
    openExistingProject: () => ipcRenderer.invoke('open-existing-project'),
    openExistingProjectFolder: () => ipcRenderer.invoke('open-existing-project-folder'),
    openExistingProjectFile: () => ipcRenderer.invoke('open-existing-project-file'),
    startupCreateProject: () => ipcRenderer.invoke('startup-create-project'),
    startupOpenProjectFolder: () => ipcRenderer.invoke('startup-open-project-folder'),
    startupOpenProjectFile: () => ipcRenderer.invoke('startup-open-project-file'),
    startupCancel: () => ipcRenderer.invoke('startup-cancel'),

    // Register .fvp file association with Windows
    registerFvpAssociation: () => ipcRenderer.invoke('register-fvp-association'),

    // Qwen model pool management
    qwenPoolStatus: () => ipcRenderer.invoke('qwen-pool-status'),
    qwenPoolReset: () => ipcRenderer.invoke('qwen-pool-reset'),
    qwenVisionKeysStatus: () => ipcRenderer.invoke('qwen-vision-keys-status'),
    qwenVisionKeysSave: (payload) => ipcRenderer.invoke('qwen-vision-keys-save', payload || {}),
    visionHealthStatus: () => ipcRenderer.invoke('vision-health-status'),
    visionHealthLiveCheck: (options) => ipcRenderer.invoke('vision-health-live-check', options || {}),
    getVisionBackend: () => ipcRenderer.invoke('get-vision-backend'),
    setVisionBackend: (backend) => ipcRenderer.invoke('set-vision-backend', backend),
    lightningPoolList: () => ipcRenderer.invoke('lightning-pool-list'),
    lightningPoolAdd: (account) => ipcRenderer.invoke('lightning-pool-add', account || {}),
    lightningPoolRemove: (id) => ipcRenderer.invoke('lightning-pool-remove', id),
    lightningPoolReset: (id) => ipcRenderer.invoke('lightning-pool-reset', id),
    lightningPoolUpdate: (id, patch) => ipcRenderer.invoke('lightning-pool-update', { id, patch }),
    lightningPoolGetActive: () => ipcRenderer.invoke('lightning-pool-get-active'),
    lightningPoolSetActive: (id) => ipcRenderer.invoke('lightning-pool-set-active', id),
    lightningProvision: (id) => ipcRenderer.invoke('lightning-provision', id),
    lightningCheck: (id) => ipcRenderer.invoke('lightning-check', id),
    lightningValidate: (account) => ipcRenderer.invoke('lightning-validate', account || {}),
    onLightningProvisionProgress: (cb) => ipcRenderer.on('lightning-provision-progress', (e, d) => cb(d)),
    openFootageResources: () => ipcRenderer.invoke('open-footage-resources'),
    footageResourcesGet: () => ipcRenderer.invoke('footage-resources-get'),
    footageResourcesSet: (payload) => ipcRenderer.invoke('footage-resources-set', payload || {}),
    resourceEnvStatus: () => ipcRenderer.invoke('resource-env-status'),
    resourceEnvSave: (payload) => ipcRenderer.invoke('resource-env-save', payload || {}),
    resourceEnvClean: () => ipcRenderer.invoke('resource-env-clean'),
    resourceEnvLiveCheck: (options) => ipcRenderer.invoke('resource-env-live-check', options || {}),
    cloudAccountSlotsStatus: () => ipcRenderer.invoke('cloud-account-slots-status'),
    cloudAccountSlotsSave: (payload) => ipcRenderer.invoke('cloud-account-slots-save', payload || {}),
    cloudAccountSlotCheck: (payload) => ipcRenderer.invoke('cloud-account-slot-check', payload || {}),
    onFootageResourcesUpdated: (callback) => {
        ipcRenderer.removeAllListeners('footage-resources-updated');
        ipcRenderer.on('footage-resources-updated', (event, data) => callback(data));
    },

    // Style Learner — analyze reference video(s), scan saved profiles, compare, pick local file
    learnStyle: (input) => ipcRenderer.invoke('learn-style', input),
    learnStyleMulti: (urls, name) => ipcRenderer.invoke('learn-style-multi', urls, name),
    compareStyle: (profilePath, videoPlan) => ipcRenderer.invoke('compare-style', profilePath, videoPlan),
    scanStyleProfiles: () => ipcRenderer.invoke('scan-style-profiles'),
    pickVideoFile: () => ipcRenderer.invoke('pick-video-file'),
    onLearnStyleProgress: (callback) => {
        ipcRenderer.removeAllListeners('learn-style-progress');
        ipcRenderer.on('learn-style-progress', (event, data) => callback(data));
    },

    // Project file (.fvp) save/load
    saveProjectFile: (data) => ipcRenderer.invoke('save-project-file', data),
    loadProjectFile: () => ipcRenderer.invoke('load-project-file'),
    getRecentProjects: () => ipcRenderer.invoke('get-recent-projects'),
    addRecentProject: () => ipcRenderer.invoke('add-recent-project'),

    // ========================================
    // WebGL2 Compositor Engine - Export
    // ========================================

    // Legacy IPC export (kept for backward compat)
    startWebGLExport: (options) => {
        return ipcRenderer.invoke('start-webgl-export', options);
    },
    sendExportFrame: (frameBuffer) => {
        return ipcRenderer.invoke('export-frame', frameBuffer);
    },
    sendExportFramesBatch: (batchPayload) => {
        return ipcRenderer.invoke('export-frames-batch', batchPayload);
    },
    finishWebGLExport: () => {
        return ipcRenderer.invoke('finish-webgl-export');
    },
    cancelWebGLExport: () => {
        return ipcRenderer.invoke('cancel-webgl-export');
    },

    // Remove listeners (cleanup)
    removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
    },

    // Get export config (FFmpeg path, encoder args, output paths) for direct-spawn mode
    getExportConfig: (options) => {
        return ipcRenderer.invoke('get-export-config', options);
    },

    // Mux audio onto a finished video file (uses main process for path resolution)
    muxAudio: (videoFile, outputFile, audioTrimStartSec, audioTrimEndSec) => {
        return ipcRenderer.invoke('mux-audio', videoFile, outputFile, audioTrimStartSec, audioTrimEndSec);
    },

    // HyperFrames bridge render path
    hyperframesGenerateProject: (payload) => ipcRenderer.invoke('hyperframes-generate-project', payload || {}),
    hyperframesRender: (payload) => ipcRenderer.invoke('hyperframes-render', payload || {}),

    // Open QA Studio in a separate window
    openQAStudio: () => ipcRenderer.invoke('open-qa-studio'),

    // Open QA Chat (developer niche knowledge tester)
    openQAChat: () => ipcRenderer.invoke('open-qa-chat'),

    // ========================================
    // Style Studio Agent — conversational style analyst
    // ========================================
    openStyleStudio: () => ipcRenderer.invoke('open-style-studio'),
    styleStudioStart: (input, options) => ipcRenderer.invoke('style-studio-start', input, options),
    styleStudioAddVideo: (sessionId, input) => ipcRenderer.invoke('style-studio-add-video', sessionId, input),
    styleStudioChat: (sessionId, message) => ipcRenderer.invoke('style-studio-chat', sessionId, message),
    styleStudioAnalyzeScript: (sessionId) => ipcRenderer.invoke('style-studio-analyze-script', sessionId),
    styleStudioExtractProfile: (sessionId) => ipcRenderer.invoke('style-studio-extract-profile', sessionId),
    styleStudioSaveProfile: (sessionId, name) => ipcRenderer.invoke('style-studio-save-profile', sessionId, name),
    styleStudioEndSession: (sessionId) => ipcRenderer.invoke('style-studio-end-session', sessionId),
    styleStudioSessionInfo: (sessionId) => ipcRenderer.invoke('style-studio-session-info', sessionId),
    styleStudioSetCodeAccess: (sessionId, enabled) => ipcRenderer.invoke('style-studio-set-code-access', sessionId, enabled),
    styleStudioSetProjectContext: (ctx) => ipcRenderer.invoke('style-studio-set-project-context', ctx),
    // Session persistence
    styleStudioCheckSaved: () => ipcRenderer.invoke('style-studio-check-saved'),
    styleStudioRestore: () => ipcRenderer.invoke('style-studio-restore'),
    styleStudioDiscardSaved: () => ipcRenderer.invoke('style-studio-discard-saved'),
    // Memory
    styleStudioLoadMemory: () => ipcRenderer.invoke('style-studio-load-memory'),
    styleStudioSaveMemory: (text, category) => ipcRenderer.invoke('style-studio-save-memory', text, category),
    styleStudioDeleteMemory: (index) => ipcRenderer.invoke('style-studio-delete-memory', index),
    styleStudioClearMemory: () => ipcRenderer.invoke('style-studio-clear-memory'),
    // In-studio audio transcription (Whisper)
    styleStudioPickAudio: () => ipcRenderer.invoke('style-studio-pick-audio'),
    styleStudioTranscribeAudio: (audioPath, options) => ipcRenderer.invoke('style-studio-transcribe-audio', audioPath, options),
    styleStudioGetTranscriptInfo: () => ipcRenderer.invoke('style-studio-get-transcript-info'),
    onStyleStudioTranscribeProgress: (callback) => {
        ipcRenderer.removeAllListeners('style-studio-transcribe-progress');
        ipcRenderer.on('style-studio-transcribe-progress', (event, data) => callback(data));
    },
    onStyleStudioProgress: (callback) => {
        ipcRenderer.removeAllListeners('style-studio-progress');
        ipcRenderer.on('style-studio-progress', (event, data) => callback(data));
    },
};

console.log('✅ Electron preload script loaded');
