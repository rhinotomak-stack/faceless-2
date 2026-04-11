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
    const themes = require('./src/themes');
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
    const mgReg = require('./src/mg-registry');
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
    window._effectPresets = require('./src/effect-presets');
} catch (e) {
    console.warn('Effect presets not available:', e.message);
}

// Expose Language registry + helpers to renderer (multi-language support)
// The renderer uses these to: resolve language-specific font stacks for MGRenderer,
// populate the language dropdown in the build settings panel, and load Google Fonts
// for non-Latin scripts (e.g. Korean) on demand.
try {
    const languages = require('./src/languages');
    const langHelper = require('./src/language-helper');
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
    window._qaStudioAgent = require('./src/qa-studio-agent');
} catch (e) {
    console.warn('QA Studio Agent not available:', e.message);
}

// Expose QA Chat Agent to renderer (developer chat to test niche knowledge)
try {
    window._qaChatAgent = require('./src/qa-chat-agent');
} catch (e) {
    console.warn('QA Chat Agent not available:', e.message);
}

// Expose QA Replacer to renderer (surgical scene re-download + article re-screenshot on Apply Fixes)
try {
    const qaReplacer = require('./src/qa-replacer');
    window._qaReplacer = qaReplacer; // { replaceSceneMedia, rescreenhotArticle }
} catch (e) {
    console.warn('QA Replacer not available:', e.message);
}


// Expose Map Provider to renderer (geocoding + tile stitching for map test preview)
try {
    const mapProvider = require('./src/map-provider');
    const appConfig = require('./src/config');
    window._mapProvider = mapProvider;
    window._appConfig = appConfig;
    // Load country boundary GeoJSON for polygon highlighting
    const geoPath = _nodePath.join(__dirname, 'assets', 'geo', 'countries-slim.json');
    if (_nodeFs.existsSync(geoPath)) {
        window._countryGeoJSON = JSON.parse(_nodeFs.readFileSync(geoPath, 'utf8'));
        console.log(`[Geo] Loaded ${window._countryGeoJSON.features.length} country boundaries`);
    }
} catch (e) {
    console.warn('Map Provider not available:', e.message);
}

// Expose Electron IPC methods to the renderer process
window.electronAPI = {
    // Copy file to project folder
    copyFile: (sourcePath, destFolder) => {
        return ipcRenderer.invoke('copy-file', sourcePath, destFolder);
    },

    // Run the build pipeline
    runBuild: (options) => {
        return ipcRenderer.invoke('run-build', options);
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

    // Style Learner — analyze reference video, scan saved profiles, pick local file
    learnStyle: (input) => ipcRenderer.invoke('learn-style', input),
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

    // Open QA Studio in a separate window
    openQAStudio: () => ipcRenderer.invoke('open-qa-studio'),

    // Open QA Chat (developer niche knowledge tester)
    openQAChat: () => ipcRenderer.invoke('open-qa-chat'),
};

console.log('✅ Electron preload script loaded');
