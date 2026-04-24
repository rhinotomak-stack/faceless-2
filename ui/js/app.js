/**
 * YTA Empire WEBGL - UI Application
 * FIXED: Playhead - freely draggable, can go to 0, doesn't disappear when panning
 */

// ========================================
// MG Style Themes — from src/themes.js design tokens
// ========================================
// MG_STYLES, THEME_FONTS, THEME_COLORS, getStyledThemeColors, getActiveThemeFonts,
// _resolveActiveTheme are defined in mg-theme-bridge.js (loaded before app.js)
// and shared with qa-studio.html so QA export clips match preview MGs exactly.
// ========================================

// ========================================
// MG Registry helpers — populate variant/animation dropdowns
// ========================================
function _resolveExplainerUrls(mgs) {
    if (!window.electronAPI?.getProjectInfo || !window.electronAPI?.getFileUrl) return;
    for (const mg of mgs) {
        if (mg.type === 'explainer' && mg.explainerImageFile && !mg._explainerImageUrl) {
            window.electronAPI.getProjectInfo().then(async (info) => {
                const imgPath = info.projectDir + '/public/' + mg.explainerImageFile;
                const url = await window.electronAPI.getFileUrl(imgPath);
                if (url) mg._explainerImageUrl = url;
            }).catch(() => {});
        }
    }
}

function _showExplainerControls(show, mg) {
    const scaleRow = document.getElementById('mg-explainer-img-scale-row');
    const shadowRow = document.getElementById('mg-explainer-shadow-row');
    if (!scaleRow) return;
    const display = show ? '' : 'none';
    scaleRow.style.display = display;
    shadowRow.style.display = display;
    if (show && mg) {
        const scaleEl = document.getElementById('mg-explainer-img-scale');
        const scaleVal = document.getElementById('mg-explainer-img-scale-val');
        const shadowEl = document.getElementById('mg-explainer-shadow');
        const imgSc = mg.explainerImgScale != null ? mg.explainerImgScale : 100;
        const shadow = mg.explainerShadow || 'medium';
        if (scaleEl) scaleEl.value = imgSc;
        if (scaleVal) scaleVal.textContent = imgSc + '%';
        if (shadowEl) shadowEl.value = shadow;
    }
}

// Filter Type dropdown to only show types in the same group (overlay↔overlay, fullscreen↔fullscreen)
// Listicle Templates group is always visible — they're a separate category
function _filterTypeDropdownByGroup(mgType) {
    const typeEl = document.getElementById('mg-type');
    if (!typeEl || !window._mgRegistry) return;
    const reg = window._mgRegistry.registry[mgType];
    const currentGroup = reg?.group || 'overlay';
    const isListicle = currentGroup === 'listicle';
    for (const optgroup of typeEl.querySelectorAll('optgroup')) {
        const groupLabel = optgroup.label.toLowerCase();
        const isListicleGroup = groupLabel.includes('listicle');
        const isOverlay = groupLabel.includes('overlay');
        // Listicle group always shown; when editing a listicle, hide overlay/fullscreen
        let show;
        if (isListicleGroup) {
            show = true; // always visible
        } else if (isListicle) {
            show = false; // editing listicle — hide overlay/fullscreen
        } else {
            show = (currentGroup === 'overlay' && isOverlay) || (currentGroup === 'fullscreen' && !isOverlay && !isListicleGroup);
        }
        for (const opt of optgroup.querySelectorAll('option')) {
            opt.disabled = !show;
            opt.style.display = show ? '' : 'none';
        }
    }
}

// Types with actual variant renderers implemented in MGRenderer._variantRenderers
const MG_TYPES_WITH_VARIANTS = new Set(['headline', 'lowerThird', 'callout', 'statCounter', 'typewriter', 'listicleCounter', 'progressTracker', 'listicleGrid']);

// Listicle item types (overlay counters on LI track)
const LISTICLE_TYPES = new Set(['listicleCounter']);

// Listicle template types (fullscreen V3 — separate system from MGs, will grow over time)
const TEMPLATE_TYPES = new Set(['listicleGrid', 'chapterCard', 'locationCard', 'quoteCard', 'keyTakeaway', 'comparisonCard', 'timelineCard', 'factCard', 'imageShowcase', 'statCard', 'personIntro']);

// Fields synced from QA Studio fixes into live state (crop, framing, QA flags)
const QA_SYNCABLE_FIELDS = ['cropTop','cropRight','cropBottom','cropLeft','scale','posY','posX','framingMode','floatingBackground','floatingAnim','floatingShadow','flagForReplacement','qaFixed','qaFixReason','qaReason','qaReplacementKeyword','qaReplacementSource','qaReplacementDiagnosis'];

// ── Template Registry (UI-side) ──
// Single source of truth for per-type variants, animations, labels.
// Mirrors the build-pipeline TEMPLATE_REGISTRY in ai-templates.js.
// When adding a new template type: add entry here + TEMPLATE_TYPES above + index.html dropdown.
const TEMPLATE_REGISTRY = {
    listicleGrid:   { label: 'Listicle Overview',
        variants: { grid: 'Card Grid', strip: 'Strip', stack: 'Stack' },
        animations: { staggerSlide: 'Stagger Slide', cascade: 'Cascade', flipIn: 'Flip In' },
        defaultVariant: 'grid', defaultAnimation: 'staggerSlide' },
    chapterCard:    { label: 'Chapter Card',
        variants: { standard: 'Standard', minimal: 'Minimal', cinematic: 'Cinematic' },
        animations: { fadeSlide: 'Fade Slide', springScale: 'Spring Scale', wipeRight: 'Wipe Right' },
        defaultVariant: 'standard', defaultAnimation: 'fadeSlide' },
    locationCard:   { label: 'Location Card',
        variants: { standard: 'Standard', minimal: 'Minimal', cinematic: 'Cinematic' },
        animations: { fadeSlide: 'Fade Slide', slideLeft: 'Slide Left' },
        defaultVariant: 'standard', defaultAnimation: 'fadeSlide' },
    quoteCard:      { label: 'Quote Card',
        variants: { standard: 'Standard', minimal: 'Minimal', cinematic: 'Cinematic' },
        animations: { fadeSlide: 'Fade Slide', popUp: 'Pop Up' },
        defaultVariant: 'standard', defaultAnimation: 'fadeSlide' },
    keyTakeaway:    { label: 'Key Takeaway',
        variants: { standard: 'Standard', minimal: 'Minimal', cinematic: 'Cinematic' },
        animations: { fadeSlide: 'Fade Slide', springScale: 'Spring Scale' },
        defaultVariant: 'standard', defaultAnimation: 'fadeSlide' },
    comparisonCard: { label: 'Comparison Card',
        variants: { standard: 'Standard', split: 'Split', stacked: 'Stacked' },
        animations: { staggerSlide: 'Stagger Slide', flipIn: 'Flip In' },
        defaultVariant: 'standard', defaultAnimation: 'staggerSlide' },
    timelineCard:   { label: 'Timeline Card',
        variants: { standard: 'Standard', minimal: 'Minimal', cinematic: 'Cinematic' },
        animations: { staggerSlide: 'Stagger Slide', cascade: 'Cascade' },
        defaultVariant: 'standard', defaultAnimation: 'staggerSlide' },
    factCard:       { label: 'Fact Card',
        variants: { splitPanel: 'Split Panel', overlay: 'Overlay Card', sidebar: 'Sidebar', numbered: 'Numbered' },
        animations: { slideRight: 'Slide Right', fadeUp: 'Fade Up', staggerSlide: 'Stagger Slide' },
        defaultVariant: 'splitPanel', defaultAnimation: 'slideRight' },
    imageShowcase:  { label: 'Image Showcase',
        variants: { standard: 'Standard', minimal: 'Minimal', cinematic: 'Cinematic' },
        animations: { slideOpposite: 'Slide Opposite', fadeSlide: 'Fade Slide', springScale: 'Spring Scale' },
        defaultVariant: 'standard', defaultAnimation: 'slideOpposite' },
    statCard:       { label: 'Stat Card',
        variants: { sideBySide: 'Side by Side', stacked: 'Stacked', single: 'Single', triple: 'Triple' },
        animations: { countUp: 'Count Up', staggerSlide: 'Stagger Slide', fadeScale: 'Fade Scale' },
        defaultVariant: 'sideBySide', defaultAnimation: 'countUp' },
    personIntro:    { label: 'Person Intro',
        variants: { standard: 'Standard', cinematic: 'Cinematic', minimal: 'Minimal' },
        animations: { slideRight: 'Slide Right', fadeSlide: 'Fade Slide', springScale: 'Spring Scale' },
        defaultVariant: 'standard', defaultAnimation: 'slideRight' },
};

/**
 * Populate a <select> with options from a { value: label } map.
 * Preserves current value if it exists in the new options.
 */
function _populateTemplateDropdown(selectEl, optionsMap, currentValue, defaultValue) {
    if (!selectEl) return;
    const prev = currentValue || selectEl.value;
    selectEl.innerHTML = '';
    for (const [val, label] of Object.entries(optionsMap)) {
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = label;
        selectEl.appendChild(opt);
    }
    // Keep current value if still valid, otherwise use default
    selectEl.value = (prev && optionsMap[prev]) ? prev : (defaultValue || Object.keys(optionsMap)[0]);
}

function _populateMgVariantDropdown(mgType, currentSubType) {
    const row = document.getElementById('mg-subtype-row');
    const sel = document.getElementById('mg-subtype');
    if (!row || !sel || !window._mgRegistry) { if (row) row.style.display = 'none'; return; }

    // Only show variant dropdown for types that have actual variant renderers
    if (!MG_TYPES_WITH_VARIANTS.has(mgType)) { row.style.display = 'none'; return; }

    const types = window._mgRegistry.getTypesForCategory(mgType);
    if (types.length <= 1) { row.style.display = 'none'; return; }

    sel.innerHTML = '';
    for (const t of types) {
        const opt = document.createElement('option');
        opt.value = t.key;
        opt.textContent = t.label;
        sel.appendChild(opt);
    }
    sel.value = currentSubType || window._mgRegistry.registry[mgType]?.defaultType || types[0]?.key || '';
    row.style.display = '';
}

function _populateMgAnimationDropdown(mgType, currentAnimation) {
    const row = document.getElementById('mg-animation-row');
    const sel = document.getElementById('mg-animation');
    if (!row || !sel || !window._mgRegistry) { if (row) row.style.display = 'none'; return; }

    const anims = window._mgRegistry.getAnimationsForCategory(mgType);
    if (anims.length <= 1) { row.style.display = 'none'; return; }

    sel.innerHTML = '';
    for (const a of anims) {
        const opt = document.createElement('option');
        opt.value = a;
        opt.textContent = a.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
        sel.appendChild(opt);
    }
    sel.value = currentAnimation || anims[0] || '';
    row.style.display = '';
}

// Show/hide listicle template settings and populate dropdowns
function _showListicleControls(mgType, mg) {
    const section = document.getElementById('mg-listicle-section');
    if (!section) return;

    const isListicle = LISTICLE_TYPES.has(mgType);
    section.style.display = isListicle ? '' : 'none';
    if (!isListicle) return;

    // Template dropdown — show variants for this listicle type
    const templateSel = document.getElementById('mg-listicle-template');
    if (templateSel && window._mgRegistry) {
        const types = window._mgRegistry.getTypesForCategory(mgType);
        templateSel.innerHTML = '';
        for (const t of types) {
            const opt = document.createElement('option');
            opt.value = t.key;
            opt.textContent = t.label;
            templateSel.appendChild(opt);
        }
        templateSel.value = mg?.subType || window._mgRegistry.registry[mgType]?.defaultType || '';
    }

    // Animation dropdown
    const animSel = document.getElementById('mg-listicle-anim');
    if (animSel && window._mgRegistry) {
        const anims = window._mgRegistry.getAnimationsForCategory(mgType);
        animSel.innerHTML = '';
        for (const a of anims) {
            const opt = document.createElement('option');
            opt.value = a;
            opt.textContent = a.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
            animSel.appendChild(opt);
        }
        animSel.value = mg?.animation || anims[0] || '';
    }

    // Number field — show for counter/tracker, hide for grid
    const numberRow = document.getElementById('mg-listicle-number-row');
    if (numberRow) numberRow.style.display = mgType === 'listicleGrid' ? 'none' : '';
    const numberEl = document.getElementById('mg-listicle-number');
    if (numberEl && mg) {
        if (mgType === 'listicleCounter') numberEl.value = mg.text || '';
        else if (mgType === 'progressTracker') numberEl.value = mg.text || '';
    }

    // Items field — show for grid, hide for counter/tracker
    const itemsRow = document.getElementById('mg-listicle-items-row');
    if (itemsRow) itemsRow.style.display = mgType === 'listicleGrid' ? '' : 'none';
    const itemsEl = document.getElementById('mg-listicle-items');
    if (itemsEl && mg) {
        const itemCount = mg._listicleItems?.length || (mg.subtext || '').split(',').filter(Boolean).length || 5;
        itemsEl.value = itemCount;
    }

    // Background
    const bgSel = document.getElementById('mg-listicle-bg');
    if (bgSel && mg) bgSel.value = mg.mgBackground || 'auto';
}

const DEFAULT_MG_OVERLAY_SHADOW = 0.55;

function _clampMgOverlayShadow(value) {
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return DEFAULT_MG_OVERLAY_SHADOW;
    return Math.max(0, Math.min(1, parsed));
}

function _syncMgShadowUI(value) {
    const shadow = _clampMgOverlayShadow(value);
    const slider = document.getElementById('mg-global-shadow');
    const label = document.getElementById('mg-global-shadow-val');
    if (slider) slider.value = shadow.toFixed(2);
    if (label) label.textContent = `${Math.round(shadow * 100)}%`;
}

function _setGlobalMgOverlayShadow(value) {
    const shadow = _clampMgOverlayShadow(value);
    state.mgOverlayShadow = shadow;
    _syncMgShadowUI(shadow);

    for (const mg of (state.motionGraphics || [])) {
        mg.overlayShadowStrength = shadow;
        if (mg.mgData) mg.mgData.overlayShadowStrength = shadow;
    }

    if (state.videoPlan) {
        if (!state.videoPlan.scriptContext) state.videoPlan.scriptContext = {};
        state.videoPlan.scriptContext.mgOverlayShadow = shadow;
    }
    if (state.compositor?._scriptContext) {
        state.compositor._scriptContext.mgOverlayShadow = shadow;
    }
}

function _hydrateMgOverlayShadow(plan) {
    const scriptShadow = plan?.scriptContext?.mgOverlayShadow;
    const firstMgShadow = (plan?.motionGraphics || []).find(mg => mg?.overlayShadowStrength != null)?.overlayShadowStrength;
    _setGlobalMgOverlayShadow(scriptShadow != null ? scriptShadow : firstMgShadow);
}

function _getActiveMgCategoryOverride(mgType) {
    const activeTheme = (typeof _resolveActiveTheme === 'function' && _resolveActiveTheme())
        || state.videoPlan?.scriptContext?.themeId
        || null;
    if (!activeTheme || !window._themeTokens?.getTokens) return null;
    try {
        return window._themeTokens.getTokens(activeTheme)?.chrome?.mgOverrides?.[mgType] || null;
    } catch (_err) {
        return null;
    }
}

function _setMgField(active, key, value) {
    active.mg[key] = value;
    if (active.mg.mgData) active.mg.mgData[key] = value;
}

function _deleteMgField(active, key) {
    delete active.mg[key];
    if (active.mg.mgData) delete active.mg.mgData[key];
}

function _applyManualMgStyle(active, style) {
    _setMgField(active, 'style', style);
    _setMgField(active, 'styleManual', true);

    const themeOverride = _getActiveMgCategoryOverride(active.mg.type);
    if (themeOverride?.style && !active.mg.variantManual && active.mg.subType === themeOverride.style) {
        _deleteMgField(active, 'subType');
        _populateMgVariantDropdown(active.mg.type, null);
    }
    if (themeOverride?.anim && !active.mg.animationManual && active.mg.animation === themeOverride.anim) {
        _deleteMgField(active, 'animation');
        _populateMgAnimationDropdown(active.mg.type, null);
    }
}

// THEME_FONTS, THEME_COLORS — defined in mg-theme-bridge.js

// getStyledThemeColors, _resolveActiveTheme — defined in mg-theme-bridge.js

/**
 * Populate the #build-language dropdown from the language registry.
 * Called during init. The "Auto-Detect" option is already in the HTML — this
 * appends supported languages below it. Adding a language to src/languages.js
 * will automatically appear here on next app reload, no HTML edit required.
 */
function populateLanguageDropdown() {
    const sel = document.getElementById('build-language');
    if (!sel) return;
    if (!window._languages?.getLanguageList) {
        console.warn('Language registry not available — dropdown will only show Auto-Detect');
        return;
    }
    const list = window._languages.getLanguageList();
    for (const lang of list) {
        const opt = document.createElement('option');
        opt.value = lang.code;
        // Show "English" for en, "Korean (한국어)" for non-English to make it easy to find
        opt.textContent = lang.code === 'en' ? lang.name : `${lang.name} (${lang.nativeName})`;
        sel.appendChild(opt);
    }
}

// getActiveThemeFonts — defined in mg-theme-bridge.js

function getActiveThemeColors() {
    const activeTheme = _resolveActiveTheme();
    if (!activeTheme || !THEME_COLORS[activeTheme]) return null;
    return THEME_COLORS[activeTheme];
}

/**
 * Get full design tokens for the active theme.
 * Returns null if no theme is active or tokens unavailable.
 */
function getActiveThemeTokens() {
    const activeTheme = _resolveActiveTheme();
    if (!activeTheme || !window._themeTokens) return null;
    return window._themeTokens.getTokens(activeTheme);
}

function parseKeyValuePairs(subtext) {
    if (!subtext || subtext === 'none') return [];
    const raw = subtext.split(',').map(s => s.trim()).filter(Boolean);
    const results = [];
    for (const part of raw) {
        const colonIdx = part.indexOf(':');
        if (colonIdx !== -1) {
            // New key:value pair
            results.push({ label: part.substring(0, colonIdx).trim(), value: part.substring(colonIdx + 1).trim() });
        } else if (results.length > 0 && /^\d+$/.test(part.trim())) {
            // Orphaned numeric fragment (e.g. "000" from "900,000") — merge back into previous value
            results[results.length - 1].value += ',' + part.trim();
        } else if (part.trim()) {
            results.push({ label: part.trim(), value: '0' });
        }
    }
    return results;
}

// ========================================
// State Management
// ========================================
const state = {
    audioFile: null,
    audioPath: null,
    scenes: [],
    isProcessing: false,
    videoPlan: null,
    hasProjectFile: false, // True once a .fvp file exists (enables auto-save)
    currentSceneIndex: 0,
    activeSceneIndices: [], // Active media scene indices (non-overlay, non-MG)
    activeOverlaySceneIndices: [], // Active overlay scene indices
    _mediaUrlCache: {}, // Cache: sceneIndex+ext → mediaUrl (avoids repeated IPC calls)
    _trackActiveEl: { '1': 'a', '2': 'a', '3': 'a' }, // Double-buffer: which element ('a' or 'b') is active per track
    _trackSwapPending: { '1': false, '2': false, '3': false }, // Per-track: deferred swap in progress
    _trackLastHardSyncMs: { '1': 0, '2': 0, '3': 0 }, // Last forced seek time per track (prevents seek thrash)
    _lastPreloadCheck: 0, // Throttle preload checks
    _sceneLoadPending: false, // True while loadActiveScenes is running
    isPlaying: false,
    currentTime: 0,
    totalDuration: 0,
    playbackAnimationFrame: null,
    lastPlaybackTime: 0,
    snapEnabled: true,
    snapThreshold: 10, // pixels
    // Undo/Redo history
    undoStack: [],
    redoStack: [],
    maxUndoLevels: 50,
    // Clipboard for copy/paste
    clipboard: null,
    selectedClipIndex: -1,
    selectedClipIndices: [], // Multi-select: array of selected clip indices
    selectedMgIndex: -1, // Selected motion graphic index
    // Audio clip offset (for dragging audio along timeline)
    audioClipOffset: 0,
    audioClipTrack: 'audio-track',
    // Preview zoom ('fit' or number like 25, 50, 100, 200)
    previewZoom: 'fit',
    // Transition system - disabled (hard cut only)
    transition: {
        style: 'crossfade',
        duration: 0.5,
        isTransitioning: false,
        activeVideoIndex: 0,
        types: ['crossfade', 'fade', 'wipe', 'slide', 'dissolve'],
        metadata: { cut: { name: 'Cut', icon: '✂', description: 'Instant cut' }, crossfade: { name: 'Crossfade', icon: '🔀' }, fade: { name: 'Fade', icon: '🔀' }, wipe: { name: 'Wipe', icon: '🔀' } }
    },
    volume: 1,
    isMuted: false,
    mutedTracks: {}, // { 'video-track-1': true, 'audio-track': true, ... }
    // Available overlays scanned from assets/overlays/
    availableOverlays: [], // [{ filename, name, ext, mediaType, size, path }]
    // Available backgrounds scanned from assets/backgrounds/
    availableBackgrounds: [], // [{ filename, name, ext, mediaType, size, path }]
    // SFX system - auto-placed at transition points
    sfxClips: [],
    sfxEnabled: true,
    sfxVolume: 0.35,
    _sfxAudioPool: [],
    // Motion Graphics system - AI-placed text overlays
    motionGraphics: [],
    mgEnabled: true,
    subtitlesEnabled: false,
    mgStyle: 'clean',
    mgOverlayShadow: DEFAULT_MG_OVERLAY_SHADOW,
    aiInstructions: '',
    videoTitle: '',
    timeline: {
        zoom: 50,
        scrollX: 0,
        minZoom: 0.5,
        maxZoom: 200,
        rulerSecondsOnly: false, // when true, show raw seconds (matches log timestamps) instead of M:SS
        isDraggingPlayhead: false,
        tracks: [
            { id: 'video-track-5', label: 'V5', type: 'video' },
            { id: 'video-track-4', label: 'V4', type: 'video' },
            { id: 'video-track-3', label: 'V3', type: 'video' },
            { id: 'video-track-2', label: 'V2', type: 'video' },
            { id: 'video-track-1', label: 'V1', type: 'video', main: true },
            { id: 'mg-track', label: 'MG', type: 'graphics' },
            { id: 'listicle-track', label: 'LI', type: 'listicle' },
            { id: 'audio-track', label: 'VO', type: 'audio' },
            { id: 'music-track', label: 'MUS', type: 'audio' },
            { id: 'sfx-track', label: 'SFX', type: 'audio' }
        ],
        trackHeights: {
            'video-track-5': 28, 'video-track-4': 28, 'video-track-3': 28, 'video-track-2': 28, 'video-track-1': 40,
            'mg-track': 32, 'listicle-track': 28,
            'audio-track': 36, 'music-track': 28, 'sfx-track': 22
        },
        trackMinHeights: {
            'video-track-5': 22, 'video-track-4': 22, 'video-track-3': 22, 'video-track-2': 22, 'video-track-1': 28,
            'mg-track': 22, 'listicle-track': 20,
            'audio-track': 26, 'music-track': 22, 'sfx-track': 18
        },
        trackMaxHeights: {
            'video-track-5': 120, 'video-track-4': 120, 'video-track-3': 120, 'video-track-2': 120, 'video-track-1': 120,
            'mg-track': 80, 'listicle-track': 60,
            'audio-track': 80, 'music-track': 80, 'sfx-track': 60
        }
    },
    // In/Out point for partial rendering (Premiere-style)
    inPoint: null,              // seconds (null = start of timeline)
    outPoint: null,             // seconds (null = end of timeline)
    // WebGL2 Compositor Engine state
    compositor: null,           // Compositor instance
    compositorActive: false,    // Whether compositor preview is active
};

const TRACK_HEADER_WIDTH = 100;

// ========================================
// Built-in gradient backgrounds (mirrors BACKGROUND_LIBRARY from themes.js)
// ========================================
const GRADIENT_BACKGROUNDS = window.GRADIENT_BACKGROUNDS = {
    'dark-gradient': 'radial-gradient(ellipse at 50% 40%, #1a1a2e 0%, #0a0a14 60%, #000000 100%)',
    'blue-minimal': 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
    'dark-blue': 'radial-gradient(ellipse at 50% 50%, #0f2027 0%, #203a43 40%, #2c5364 100%)',
    'green-gradient': 'linear-gradient(160deg, #0f3443 0%, #34e89e 100%)',
    'warm-sunset': 'linear-gradient(135deg, #f093fb 0%, #f5576c 50%, #fda085 100%)',
    'midnight': 'radial-gradient(ellipse at 30% 50%, #1a0a2e 0%, #0a0014 50%, #000000 100%)',
    'cream': 'linear-gradient(180deg, #fdf6e3 0%, #ede0c8 50%, #d4c5a9 100%)',
    'grid-texture': 'repeating-linear-gradient(0deg, transparent, transparent 49px, rgba(255,255,255,0.03) 49px, rgba(255,255,255,0.03) 50px), repeating-linear-gradient(90deg, transparent, transparent 49px, rgba(255,255,255,0.03) 49px, rgba(255,255,255,0.03) 50px), linear-gradient(135deg, #0a0a1a 0%, #1a1a2e 100%)',
    'red-dark': 'radial-gradient(ellipse at 50% 50%, #2a0a0a 0%, #1a0505 50%, #0a0000 100%)',
    'purple-haze': 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #3a1c71 100%)',
    'noir': 'radial-gradient(ellipse at 50% 30%, #1a1a1a 0%, #0a0a0a 40%, #000000 100%)',
    'ocean-deep': 'linear-gradient(180deg, #0c3547 0%, #0a2a3a 40%, #051a2a 100%)',
    // Soft solid-ish backgrounds (great for floating frame)
    'soft-beige': 'linear-gradient(180deg, #e8dcc8 0%, #d4c5a9 50%, #c4b494 100%)',
    'warm-white': 'linear-gradient(180deg, #f5f0e8 0%, #ebe3d5 50%, #ddd3c0 100%)',
    'soft-gray': 'linear-gradient(180deg, #d0d0d0 0%, #b8b8b8 50%, #a0a0a0 100%)',
    'slate': 'linear-gradient(180deg, #2c3e50 0%, #1a252f 50%, #0e171f 100%)',
    'warm-charcoal': 'linear-gradient(180deg, #3a3530 0%, #2a2520 50%, #1a1510 100%)',
    'paper': 'linear-gradient(180deg, #f0ead6 0%, #e6dcc6 50%, #d6ccb2 100%)',
};

const GRADIENT_BACKGROUND_NAMES = {
    'dark-gradient': 'Dark Gradient', 'blue-minimal': 'Blue Minimal',
    'dark-blue': 'Dark Blue', 'green-gradient': 'Green Gradient',
    'warm-sunset': 'Warm Sunset', 'midnight': 'Midnight',
    'cream': 'Cream', 'grid-texture': 'Grid Texture',
    'red-dark': 'Red Dark', 'purple-haze': 'Purple Haze',
    'noir': 'Noir', 'ocean-deep': 'Ocean Deep',
    'soft-beige': 'Soft Beige', 'warm-white': 'Warm White',
    'soft-gray': 'Soft Gray', 'slate': 'Slate',
    'warm-charcoal': 'Warm Charcoal', 'paper': 'Paper',
};

// ========================================
// DOM Elements
// ========================================
const elements = {
    btnNew: document.getElementById('btn-new'),
    btnOpenProject: document.getElementById('btn-open-project'),
    projectNameLabel: document.getElementById('project-name-label'),
    btnRefresh: document.getElementById('btn-refresh'),
    btnRender: document.getElementById('btn-render'),
    btnQAStudio: document.getElementById('btn-qa-studio'),
    btnQAChat:   document.getElementById('btn-qa-chat'),
    btnGenerate: document.getElementById('btn-generate'),
    btnRemoveAudio: document.getElementById('btn-remove-audio'),
    dropZone: document.getElementById('drop-zone'),
    fileInput: document.getElementById('file-input'),
    audioInfo: document.getElementById('audio-info'),
    audioName: document.getElementById('audio-name'),
    smartAiToggle: document.getElementById('smart-ai-toggle'),
    aiProvider: document.getElementById('ai-provider'),
    ollamaModelRow: document.getElementById('ollama-model-row'),
    ollamaModel: document.getElementById('ollama-model'),
    ollamaVisionModel: document.getElementById('ollama-vision-model'),
    aiThinking: document.getElementById('ai-thinking'),
    aiInstructions: document.getElementById('ai-instructions'),
    videoTitle: document.getElementById('video-title'),
    buildQuality: document.getElementById('build-quality'),
    buildFormat: document.getElementById('build-format'),
    buildNiche: document.getElementById('build-niche'),
    buildTheme: document.getElementById('build-theme'),
    buildLanguage: document.getElementById('build-language'),
    buildStyleProfile: document.getElementById('build-style-profile'),
    btnLearnStyle: document.getElementById('btn-learn-style'),
    learnStyleDialog: document.getElementById('learn-style-dialog'),
    learnStyleUrl: document.getElementById('learn-style-url'),
    learnStyleBrowse: document.getElementById('learn-style-browse'),
    learnStyleStart: document.getElementById('learn-style-start'),
    learnStyleCancel: document.getElementById('learn-style-cancel'),
    learnStyleProgress: document.getElementById('learn-style-progress'),
    learnStyleBar: document.getElementById('learn-style-bar'),
    learnStyleMsg: document.getElementById('learn-style-msg'),
    learnStyleMode: document.getElementById('learn-style-mode'),
    learnStyleUrls: document.getElementById('learn-style-urls'),
    learnStyleName: document.getElementById('learn-style-name'),
    btnCompareStyle: document.getElementById('btn-compare-style'),
    styleComparisonReport: document.getElementById('style-comparison-report'),
    styleComparisonText: document.getElementById('style-comparison-text'),
    styleComparisonClose: document.getElementById('style-comparison-close'),
    mapTestLocations: document.getElementById('map-test-locations'),
    mapTestStyle: document.getElementById('map-test-style'),
    mapTestTitle: document.getElementById('map-test-title'),
    btnMapTest: document.getElementById('btn-map-test'),
    mapTestStatus: document.getElementById('map-test-status'),
    mapZoomSpeed: document.getElementById('map-zoom-speed'),
    mapZoomSpeedVal: document.getElementById('map-zoom-speed-val'),
    mapPolySpeed: document.getElementById('map-poly-speed'),
    mapPolySpeedVal: document.getElementById('map-poly-speed-val'),
    mapEasing: document.getElementById('map-easing'),
    mapPolyColor: document.getElementById('map-poly-color'),
    mapTiltStart: document.getElementById('map-tilt-start'),
    mapTiltEnd: document.getElementById('map-tilt-end'),
    mapTiltVal: document.getElementById('map-tilt-val'),
    mapZoomStart: document.getElementById('map-zoom-start'),
    mapZoomEnd: document.getElementById('map-zoom-end'),
    mapZoomKfVal: document.getElementById('map-zoom-kf-val'),
    mapDuration: document.getElementById('map-duration'),
    mapDurationVal: document.getElementById('map-duration-val'),
    mapPanXStart: document.getElementById('map-pan-x-start'),
    mapPanXEnd: document.getElementById('map-pan-x-end'),
    mapPanXVal: document.getElementById('map-pan-x-val'),
    mapPanYStart: document.getElementById('map-pan-y-start'),
    mapPanYEnd: document.getElementById('map-pan-y-end'),
    mapPanYVal: document.getElementById('map-pan-y-val'),
    mapVariant: document.getElementById('map-variant'),
    mapCinematic: document.getElementById('map-cinematic'),
    // Clip analyzer toggle
    clipAnalyzerToggle: document.getElementById('clip-analyzer-toggle'),
    // Resume build toggle (skip completed steps + reuse cached scene media)
    buildResumeToggle: document.getElementById('build-resume-toggle'),
    // Footage source toggles
    srcPexels: document.getElementById('src-pexels'),
    srcPixabay: document.getElementById('src-pixabay'),
    srcYouTube: document.getElementById('src-youtube'),
    srcTelegram: document.getElementById('src-telegram'),
    srcVKVideo: document.getElementById('src-vk-video'),
    srcReddit: document.getElementById('src-reddit'),
    srcUnsplash: document.getElementById('src-unsplash'),
    srcGoogleCSE: document.getElementById('src-google-cse'),
    srcBing: document.getElementById('src-bing'),
    srcDuckDuckGo: document.getElementById('src-duckduckgo'),
    srcGoogleScrape: document.getElementById('src-google-scrape'),
    transitionStyle: document.getElementById('transition-style'),
    previewPlaceholder: document.getElementById('preview-placeholder'),
    // Multi-track video system
    videoContainer: document.getElementById('video-transition-container'),
    videoTrack1: document.getElementById('video-track-1'),
    videoTrack2: document.getElementById('video-track-2'),
    videoTrack3: document.getElementById('video-track-3'),
    videoTrack1B: document.getElementById('video-track-1-b'),
    videoTrack2B: document.getElementById('video-track-2-b'),
    videoTrack3B: document.getElementById('video-track-3-b'),
    videoTransitionOut: document.getElementById('video-transition-out'),
    // Image track elements (for image scenes)
    imgTrack1: document.getElementById('img-track-1'),
    imgTrack2: document.getElementById('img-track-2'),
    imgTrack3: document.getElementById('img-track-3'),
    imgTransitionOut: document.getElementById('img-transition-out'),
    // Motion Graphics overlay
    mgOverlay: document.getElementById('mg-overlay'),
    // Video controls
    videoControls: document.getElementById('video-controls'),
    btnPlay: document.getElementById('btn-play'),
    btnMute: document.getElementById('btn-mute'),
    btnFullscreen: document.getElementById('btn-fullscreen'),
    volumeSlider: document.getElementById('volume-slider'),
    currentTimeDisplay: document.getElementById('current-time-display'),
    totalTimeDisplay: document.getElementById('total-time-display'),
    // Audio
    previewAudio: document.getElementById('preview-audio'),
    progressContainer: document.getElementById('progress-container'),
    progressFill: document.getElementById('progress-fill'),
    progressText: document.getElementById('progress-text'),
    progressTimer: document.getElementById('progress-timer'),
    btnCancel: document.getElementById('btn-cancel'),
    sceneList: document.getElementById('scene-list'),
    timelineContainer: document.getElementById('timeline-container'),
    leftPanel: document.getElementById('left-panel'),
    rightPanel: document.getElementById('right-panel'),
    resizeLeft: document.getElementById('resize-left'),
    resizeRight: document.getElementById('resize-right'),
    resizeTimeline: document.getElementById('resize-timeline'),
    // Clip properties panel
    clipProperties: document.getElementById('clip-properties'),
    propScale: document.getElementById('prop-scale'),
    propPosX: document.getElementById('prop-pos-x'),
    propPosY: document.getElementById('prop-pos-y'),
    propScaleVal: document.getElementById('prop-scale-val'),
    propPosXVal: document.getElementById('prop-pos-x-val'),
    propPosYVal: document.getElementById('prop-pos-y-val'),
    propVolume: document.getElementById('prop-volume'),
    propVolumeVal: document.getElementById('prop-volume-val'),
    propBackground: document.getElementById('prop-background'),
    propFitMode: document.getElementById('prop-fit-mode'),
    propAnimate: document.getElementById('prop-animate'),
    propAnimateRow: document.getElementById('prop-animate-row'),
    propKbSpeed: document.getElementById('prop-kb-speed'),
    propKbSpeedVal: document.getElementById('prop-kb-speed-val'),
    propKbSpeedRow: document.getElementById('prop-kb-speed-row'),
    propReset: document.getElementById('prop-reset'),
    propCropTop: document.getElementById('prop-crop-top'),
    propCropBottom: document.getElementById('prop-crop-bottom'),
    propCropLeft: document.getElementById('prop-crop-left'),
    propCropRight: document.getElementById('prop-crop-right'),
    propCropTopVal: document.getElementById('prop-crop-top-val'),
    propCropBottomVal: document.getElementById('prop-crop-bottom-val'),
    propCropLeftVal: document.getElementById('prop-crop-left-val'),
    propCropRightVal: document.getElementById('prop-crop-right-val'),
    btnFillFrame: document.getElementById('btn-fill-frame'),
    propBorderRadius: document.getElementById('prop-border-radius'),
    propBorderRadiusVal: document.getElementById('prop-border-radius-val'),
    // Floating frame controls
    propFloatingSection: document.getElementById('prop-floating-section'),
    propFloatingControls: document.getElementById('prop-floating-controls'),
    propFraming: document.getElementById('prop-framing'),
    propShadow: document.getElementById('prop-shadow'),
    propShadowVal: document.getElementById('prop-shadow-val'),
    propFloatingAnim: document.getElementById('prop-floating-anim'),
    propFloatingAnimDur: document.getElementById('prop-floating-anim-dur'),
    propFloatingAnimDurVal: document.getElementById('prop-floating-anim-dur-val'),
    // Track wrappers (for crop/radius)
    trackWrapper1: document.getElementById('track-wrapper-1'),
    trackWrapper2: document.getElementById('track-wrapper-2'),
    trackWrapper3: document.getElementById('track-wrapper-3'),
    // Background layer elements
    bgVideo: document.getElementById('bg-video'),
    bgImage: document.getElementById('bg-image'),
    bgGradient: document.getElementById('bg-gradient'),
    // Preview zoom
    previewContainer: document.getElementById('preview-container'),
    previewZoomSelect: document.getElementById('preview-zoom-select'),
    previewZoomLabel: document.getElementById('preview-zoom-label'),
    // SFX controls
    sfxEnabled: document.getElementById('sfx-enabled'),
    sfxVolume: document.getElementById('sfx-volume'),
    sfxVolumeLabel: document.getElementById('sfx-volume-label'),
    // Motion Graphics controls
    mgEnabled: document.getElementById('mg-enabled'),
    // Subtitles
    subtitlesEnabled: document.getElementById('subtitles-enabled'),
};

// ========================================
// Multi-Track Helper Functions
// ========================================

/**
 * Double-buffer helpers: each track has two video elements (A and B).
 * While one plays, the other preloads the next clip.
 * Switching is instant — just toggle visibility.
 */
function getTrackVideoPair(trackNum) {
    const which = state._trackActiveEl[trackNum] || 'a';
    const a = elements[`videoTrack${trackNum}`];
    const b = elements[`videoTrack${trackNum}B`];
    return {
        active: which === 'a' ? a : b,
        buffer: which === 'a' ? b : a,
    };
}

function swapTrackActive(trackNum) {
    state._trackActiveEl[trackNum] = state._trackActiveEl[trackNum] === 'a' ? 'b' : 'a';
}

function getActiveTrackVideo(trackNum) {
    const which = state._trackActiveEl[trackNum] || 'a';
    if (which === 'a') return elements[`videoTrack${trackNum}`];
    return elements[`videoTrack${trackNum}B`];
}

/**
 * Get all scenes active at a given time across all tracks
 * @param {number} time - Time in seconds
 * @returns {Array<{scene, index}>} - Array of active scenes sorted by track
 */
function getActiveScenesAtTime(time) {
    return state.scenes
        .map((scene, index) => ({ scene, index }))
        .filter(({ scene }) => time >= scene.startTime && time < scene.endTime)
        .sort((a, b) => {
            // Sort by track (lower track number = render first/below)
            const trackA = parseInt(a.scene.trackId?.match(/\d+/)?.[0] || '1');
            const trackB = parseInt(b.scene.trackId?.match(/\d+/)?.[0] || '1');
            return trackA - trackB;
        });
}

// ========================================
// Initialize
// ========================================
// ========================================
// Capture Mode (hidden window for Preview Capture renderer)
// ========================================
const _isCaptureMode = new URLSearchParams(window.location.search).get('mode') === 'capture';

function initCaptureMode() {
    console.log('[CaptureMode] Initializing capture window');

    // Hide ALL UI except the preview video container and MG overlay
    document.querySelectorAll('.header, .sidebar, .timeline-container, .progress-container, .toolbar, .startup-overlay, #notif-center, #video-controls, .preview-zoom-bar, #preview-placeholder').forEach(el => {
        if (el) el.style.display = 'none';
    });

    // Make preview fill the window at exactly 1920x1080
    const previewContainer = document.getElementById('preview-container');
    const videoContainer = document.getElementById('video-container');
    if (previewContainer) {
        previewContainer.style.cssText = 'position:fixed;top:0;left:0;width:1920px;height:1080px;margin:0;padding:0;overflow:hidden;z-index:9999;background:#000;';
    }
    if (videoContainer) {
        videoContainer.classList.remove('hidden');
        videoContainer.style.cssText = 'width:1920px;height:1080px;margin:0;padding:0;';
    }

    // Track which scenes are active to avoid redundant loadActiveScenes calls
    let _captureLastSceneKey = '';
    // Pre-cached media URLs (avoid IPC per frame)
    const _captureMediaCache = {};

    // Listen for plan data from main process
    window.electronAPI.onCaptureLoadPlan(async (planData) => {
        console.log('[CaptureMode] Received plan data');
        try {
            state.videoPlan = planData;
            window._mgBridgeVideoPlan = planData;

            const plan = planData;
            state.scenes = plan.scenes || [];
            state.motionGraphics = plan.motionGraphics || [];
            state.transitions = plan.transitions || [];
            state.totalDuration = plan.totalDuration || 0;
            state.fps = plan.fps || 30;
            state.mgEnabled = plan.mgEnabled !== false; // enable MGs by default
            state.mgStyle = plan.mgStyle || 'clean';
            _hydrateMgOverlayShadow(plan);

            // Assign trackIds if missing
            state.scenes.forEach((s, i) => {
                if (!s.trackId) s.trackId = s.isMGScene ? 'video-track-3' : 'video-track-1';
                if (s.index === undefined) s.index = i;
            });

            // Pre-cache ALL media URLs upfront (avoids per-frame IPC)
            console.log('[CaptureMode] Pre-caching media URLs for', state.scenes.length, 'scenes');
            for (const scene of state.scenes) {
                if (scene.isMGScene || scene.disabled) continue;
                const idx = scene.index !== undefined ? scene.index : state.scenes.indexOf(scene);
                try {
                    const url = await getCachedMediaUrl(idx, scene.mediaExtension);
                    _captureMediaCache[idx] = url;
                    console.log(`[CaptureMode] Cached scene ${idx}: ${url ? url.substring(url.lastIndexOf('/') + 1) : 'null'}`);
                } catch (e) {
                    console.warn(`[CaptureMode] Failed to cache scene ${idx}:`, e.message);
                }
            }

            // Pre-load all video elements so they're ready for seeking
            console.log('[CaptureMode] Pre-loading video elements...');
            const videoLoadPromises = [];
            for (const scene of state.scenes) {
                if (scene.isMGScene || scene.disabled || scene.mediaType === 'image') continue;
                const idx = scene.index !== undefined ? scene.index : state.scenes.indexOf(scene);
                const url = _captureMediaCache[idx];
                if (!url) continue;
                const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
                const vid = elements[`videoTrack${trackNum}`];
                if (!vid) continue;
                // Load and wait for ready
                videoLoadPromises.push(new Promise((resolve) => {
                    if (vid._loadedUrl === url && vid.readyState >= 2) { resolve(); return; }
                    vid.src = url;
                    vid._loadedUrl = url;
                    vid.preload = 'auto';
                    vid.muted = true;
                    const onReady = () => { vid.removeEventListener('canplaythrough', onReady); resolve(); };
                    vid.addEventListener('canplaythrough', onReady);
                    setTimeout(resolve, 10000); // 10s max wait
                    vid.load();
                }));
            }
            await Promise.all(videoLoadPromises);

            console.log('[CaptureMode] All media ready, signaling capture-ready');
            window.electronAPI.sendCaptureReady();
        } catch (e) {
            console.error('[CaptureMode] Error loading plan:', e);
            window.electronAPI.sendCaptureReady();
        }
    });

    // Listen for frame seek requests — OPTIMIZED: only do full scene load on scene change
    window.electronAPI.onCaptureSeekFrame(async (data) => {
        const { frame, fps } = data;
        const timeSec = frame / fps;

        try {
            state.currentTime = timeSec;
            state.fps = fps;

            // Check which scenes are active at this time
            const activeScenes = getActiveScenesAtTime(timeSec);
            const sceneKey = activeScenes.map(({ index }) => index).join(',');

            // Only do full loadActiveScenes when the active scene SET changes
            if (sceneKey !== _captureLastSceneKey) {
                _captureLastSceneKey = sceneKey;
                await loadActiveScenes(activeScenes);
                // After scene change, wait for paint
                await new Promise(r => requestAnimationFrame(r));
            }

            // Quick-seek active video elements to exact frame time
            const seekPromises = [];
            for (const { scene } of activeScenes) {
                if (scene.isMGScene || scene.disabled || scene.mediaType === 'image') continue;
                const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
                const vid = elements[`videoTrack${trackNum}`];
                if (!vid || vid.readyState < 2) continue;

                const sceneTime = (timeSec - scene.startTime) + (scene.mediaOffset || 0);
                // Only seek if more than half a frame off
                if (Math.abs(vid.currentTime - sceneTime) > 0.5 / fps) {
                    seekPromises.push(new Promise((resolve) => {
                        vid.addEventListener('seeked', resolve, { once: true });
                        setTimeout(resolve, 500); // 500ms timeout (not 2s)
                        vid.currentTime = sceneTime;
                    }));
                }
            }
            if (seekPromises.length > 0) {
                await Promise.all(seekPromises);
            }

            // Update Ken Burns / transforms for images at current time
            for (const { scene } of activeScenes) {
                if (scene.mediaType !== 'image' || scene.isMGScene) continue;
                const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
                const img = elements[`imgTrack${trackNum}`];
                if (img) updateKenBurnsTransform(img, scene);
            }

            // Update MG overlays (track 2) — they compute animation from state.currentTime
            // Force bypass throttle by clearing last-active cache (capture needs every frame)
            _mgLastActiveIds = '';
            updateMGOverlay();

            // Single RAF for CSS repaint
            await new Promise(r => requestAnimationFrame(r));

            window.electronAPI.sendCaptureFrameReady();
        } catch (e) {
            console.error('[CaptureMode] Error seeking frame:', e);
            window.electronAPI.sendCaptureFrameReady();
        }
    });
}

async function init() {
    // Check if we're in capture mode (hidden window for Preview Capture renderer)
    if (_isCaptureMode) {
        initCaptureMode();
        console.log('🎬 YTA Empire WEBGL Capture Window Ready');
        return;
    }

    // Add error handlers on video elements to catch loading failures (A and B buffers)
    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
    elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach((video, i) => {
        if (!video) return;
        const label = i < 3 ? `Track ${i + 1}A` : `Track ${i - 2}B`;
        video.addEventListener('error', (e) => {
            const err = video.error;
            console.error(`[Video ${label}] Error: code=${err?.code} message=${err?.message} src=${video.src?.substring(video.src.lastIndexOf('/') + 1)}`);
        });
        video.addEventListener('stalled', () => {
            console.warn(`[Video ${label}] Stalled: src=${video.src?.substring(video.src.lastIndexOf('/') + 1)} readyState=${video.readyState}`);
        });
    });

    // Load and display project info
    loadProjectInfo();

    // Populate language dropdown from the language registry (exposed via preload.js).
    // Adding a language in src/languages.js automatically adds it here — no UI edit needed.
    populateLanguageDropdown();

    setupEventListeners();
    setupElectronListeners();
    setupKeyboardShortcuts();
    setupResizablePanels();
    setupPanelSections();
    setupVideoControls();
    setupClipPropertyListeners();
    setupMgPropertyListeners();
    _initMapPropertiesListeners();
    setupListiclePropertyListeners();
    setupTemplatePropertyListeners();
    // Populate template background dropdown with custom images from assets/backgrounds/
    if (window.electronAPI?.scanBackgrounds) {
        window.electronAPI.scanBackgrounds().then(bgList => {
            const group = document.getElementById('tpl-bg-images');
            if (!group || !bgList || !bgList.length) { if (group) group.remove(); return; }
            for (const bg of bgList) {
                const opt = document.createElement('option');
                opt.value = `image:${bg.filename}`;
                const label = bg.theme ? `${bg.theme} — ${bg.name}` : bg.name;
                opt.textContent = label;
                group.appendChild(opt);
            }
        }).catch(() => {});
    }
    setupPreviewDrag();
    setupPreviewZoom();
    setupNotifCenter();
    loadSettings();
    // Push initial project context to Style Studio agent so it knows the video
    // title / niche / instructions immediately, without waiting for an edit.
    try {
        window.electronAPI?.styleStudioSetProjectContext?.({
            videoTitle: state.videoTitle,
            aiInstructions: state.aiInstructions,
            buildNiche: elements.buildNiche ? elements.buildNiche.value : 'auto',
            buildLanguage: elements.buildLanguage ? elements.buildLanguage.value : 'auto',
            buildStyleProfile: elements.buildStyleProfile ? elements.buildStyleProfile.value : 'none',
        });
    } catch (_) {}
    // Show Ollama model row if Ollama is the active provider
    if (elements.ollamaModelRow) {
        elements.ollamaModelRow.style.display = elements.aiProvider.value === 'ollama' ? 'block' : 'none';
    }

    // Scan available overlays from assets/overlays/
    try {
        state.availableOverlays = await window.electronAPI.scanOverlays();
        console.log(`📁 Found ${state.availableOverlays.length} overlay files in assets/overlays/`);
    } catch (e) {
        console.log('Could not scan overlays folder:', e.message);
        state.availableOverlays = [];
    }

    // Scan available backgrounds from assets/backgrounds/
    try {
        state.availableBackgrounds = await window.electronAPI.scanBackgrounds();
        console.log(`📁 Found ${state.availableBackgrounds.length} background files in assets/backgrounds/`);
    } catch (e) {
        console.log('Could not scan backgrounds folder:', e.message);
        state.availableBackgrounds = [];
    }
    populateBackgroundDropdown();

    // Auto-load last saved project
    try {
        await loadVideoPlan();
        if (state.scenes.length > 0) {
            console.log(`✅ Restored project: ${state.scenes.length} scenes`);
            await jumpToScene(0);
        } else {
            console.warn('⚠️ loadVideoPlan completed but state.scenes is empty');
        }
    } catch (e) {
        console.error('❌ No saved project to restore:', e?.message || e, e?.stack);
    }

    // Initialize WebGL2 Compositor Engine
    initCompositor();

    console.log('🎬 YTA Empire WEBGL UI Ready');
}

function setupEventListeners() {
    elements.dropZone.addEventListener('click', () => elements.fileInput.click());
    elements.dropZone.addEventListener('dragover', (e) => { e.preventDefault(); elements.dropZone.classList.add('drag-over'); });
    elements.dropZone.addEventListener('dragleave', () => elements.dropZone.classList.remove('drag-over'));
    elements.dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        elements.dropZone.classList.remove('drag-over');
        if (e.dataTransfer.files.length > 0) handleFileSelect(e.dataTransfer.files[0]);
    });
    elements.fileInput.addEventListener('change', (e) => { if (e.target.files.length > 0) handleFileSelect(e.target.files[0]); });
    elements.btnRemoveAudio.addEventListener('click', removeAudio);
    elements.btnGenerate.addEventListener('click', generateVideo);
    elements.btnRender.addEventListener('click', renderVideo);
    if (elements.btnQAStudio) elements.btnQAStudio.addEventListener('click', () => window.electronAPI.openQAStudio());
    if (elements.btnQAChat)   elements.btnQAChat.addEventListener('click',   () => window.electronAPI.openQAChat());
    elements.btnCancel.addEventListener('click', cancelProcess);
    elements.btnNew.addEventListener('click', newProject);
    if (elements.btnOpenProject) {
        elements.btnOpenProject.addEventListener('click', openExistingProject);
    }
    elements.btnRefresh.addEventListener('click', refreshApp);
    // Smart AI toggle — dims AI settings when off
    if (elements.smartAiToggle) {
        const updateSmartAI = () => {
            const on = elements.smartAiToggle.checked;
            elements.aiProvider.disabled = !on;
            if (elements.aiInstructions) elements.aiInstructions.disabled = !on;
            if (elements.ollamaModel) elements.ollamaModel.disabled = !on;
            if (elements.ollamaVisionModel) elements.ollamaVisionModel.disabled = !on;
            elements.aiProvider.parentElement.style.opacity = on ? '1' : '0.4';
            if (elements.aiInstructions) elements.aiInstructions.style.opacity = on ? '1' : '0.4';
        };
        elements.smartAiToggle.addEventListener('change', () => { updateSmartAI(); saveSettings(); });
        updateSmartAI();
    }
    if (elements.clipAnalyzerToggle) {
        elements.clipAnalyzerToggle.addEventListener('change', () => saveSettings());
    }
    if (elements.buildResumeToggle) {
        elements.buildResumeToggle.addEventListener('change', () => saveSettings());
    }

    // Qwen Pool reset button + status (uses IPC, not direct Node.js)
    const qwenPoolBtn = document.getElementById('reset-qwen-pool-btn');
    const qwenPoolStatus = document.getElementById('qwen-pool-status');

    function _updateQwenPoolStatus() {
        if (!qwenPoolStatus || !window.electronAPI?.qwenPoolStatus) return;
        window.electronAPI.qwenPoolStatus().then(status => {
            if (status.exhausted > 0) {
                qwenPoolStatus.textContent = `${status.exhausted} model${status.exhausted > 1 ? 's' : ''} exhausted`;
                qwenPoolStatus.style.color = status.exhausted > 12 ? '#f55' : '#fa0';
            } else {
                qwenPoolStatus.textContent = 'all models available';
                qwenPoolStatus.style.color = '#5a5';
            }
        }).catch(() => { qwenPoolStatus.textContent = ''; });
    }

    if (qwenPoolBtn) {
        qwenPoolBtn.addEventListener('click', () => {
            if (!window.electronAPI?.qwenPoolReset) return;
            window.electronAPI.qwenPoolReset().then(result => {
                if (result.success) {
                    qwenPoolStatus.textContent = 'pool reset!';
                    qwenPoolStatus.style.color = '#5a5';
                    setTimeout(() => _updateQwenPoolStatus(), 2000);
                } else {
                    qwenPoolStatus.textContent = 'reset failed';
                    qwenPoolStatus.style.color = '#f55';
                }
            }).catch(() => {
                qwenPoolStatus.textContent = 'reset failed';
                qwenPoolStatus.style.color = '#f55';
            });
        });
        _updateQwenPoolStatus();
    }
    elements.aiProvider.addEventListener('change', () => {
        // Show/hide Ollama model selection
        if (elements.ollamaModelRow) {
            elements.ollamaModelRow.style.display = elements.aiProvider.value === 'ollama' ? 'block' : 'none';
        }
        saveSettings();
    });
    // Ollama model changes
    if (elements.ollamaModel) elements.ollamaModel.addEventListener('change', saveSettings);
    if (elements.ollamaVisionModel) elements.ollamaVisionModel.addEventListener('change', saveSettings);
    if (elements.videoTitle) {
        elements.videoTitle.addEventListener('input', () => {
            state.videoTitle = elements.videoTitle.value;
        });
        elements.videoTitle.addEventListener('change', saveSettings);
    }
    if (elements.aiInstructions) {
        elements.aiInstructions.addEventListener('input', () => {
            state.aiInstructions = elements.aiInstructions.value;
        });
        elements.aiInstructions.addEventListener('change', saveSettings);
    }
    // Global MG animation speed slider
    const globalAnimSpeedEl = document.getElementById('mg-global-anim-speed');
    if (globalAnimSpeedEl) {
        globalAnimSpeedEl.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            document.getElementById('mg-global-anim-speed-val').textContent = `${val.toFixed(1)}x`;
        });
    }
    _syncMgShadowUI(state.mgOverlayShadow);
    const globalShadowEl = document.getElementById('mg-global-shadow');
    if (globalShadowEl) {
        globalShadowEl.addEventListener('input', (e) => {
            _setGlobalMgOverlayShadow(e.target.value);
            refreshCompositorMGs();
        });
    }
    // Footage source toggle listeners
    ['srcPexels', 'srcPixabay', 'srcYouTube', 'srcTelegram', 'srcVKVideo', 'srcReddit', 'srcUnsplash', 'srcGoogleCSE', 'srcBing', 'srcDuckDuckGo', 'srcGoogleScrape'].forEach(key => {
        if (elements[key]) elements[key].addEventListener('change', saveSettings);
    });

    // Style Learner — populate dropdown, wire learn dialog
    setupStyleLearner();
    // Transition style + duration listeners
    if (elements.transitionStyle) {
        elements.transitionStyle.addEventListener('change', () => {
            state.transition.style = elements.transitionStyle.value;
            state.transition.duration = state.transition.style === 'cut' ? 0 : parseFloat(document.getElementById('transition-duration')?.value || 0.5);
            renderTimeline();
            if (state.compositorActive) loadPlanIntoCompositor();
            saveSettings();
        });
    }
    const transDurEl = document.getElementById('transition-duration');
    const transDurVal = document.getElementById('transition-duration-val');
    if (transDurEl) {
        transDurEl.addEventListener('input', () => {
            const val = parseFloat(transDurEl.value);
            state.transition.duration = val;
            if (transDurVal) transDurVal.textContent = `${val.toFixed(1)}s`;
            if (state.compositorActive) loadPlanIntoCompositor();
            saveSettings();
        });
    }
    // SFX controls
    if (elements.sfxEnabled) {
        elements.sfxEnabled.addEventListener('change', () => {
            state.sfxEnabled = elements.sfxEnabled.checked;
            generateSfxClips();
            renderTimeline();
            saveSettings();
        });
    }
    if (elements.sfxVolume) {
        elements.sfxVolume.addEventListener('input', () => {
            state.sfxVolume = parseFloat(elements.sfxVolume.value);
            if (elements.sfxVolumeLabel) elements.sfxVolumeLabel.textContent = `${Math.round(state.sfxVolume * 100)}%`;
            applySfxVolumeLevels();
            renderTimeline();
            saveSettings();
        });
    }
    // Download Real SFX button
    const btnDownloadSfx = document.getElementById('btn-download-sfx');
    const sfxDownloadStatus = document.getElementById('sfx-download-status');
    if (btnDownloadSfx) {
        btnDownloadSfx.addEventListener('click', async () => {
            if (!window.electronAPI?.downloadRealSfx) return;
            btnDownloadSfx.disabled = true;
            btnDownloadSfx.textContent = '⏳ Downloading...';
            if (sfxDownloadStatus) sfxDownloadStatus.textContent = 'Searching Freesound for high-quality SFX...';
            try {
                const result = await window.electronAPI.downloadRealSfx();
                if (result.noKey) {
                    if (sfxDownloadStatus) sfxDownloadStatus.textContent = '⚠ Set FREESOUND_API_KEY in .env first';
                } else if (result.success) {
                    if (sfxDownloadStatus) sfxDownloadStatus.textContent = `✅ ${result.downloaded} downloaded, ${result.skipped} cached, ${result.failed} fallback`;
                    // Re-preload SFX URLs with new files
                    preloadSfxUrls();
                } else {
                    if (sfxDownloadStatus) sfxDownloadStatus.textContent = `❌ ${result.error || 'Download failed'}`;
                }
            } catch (e) {
                if (sfxDownloadStatus) sfxDownloadStatus.textContent = `❌ ${e.message}`;
            }
            btnDownloadSfx.disabled = false;
            btnDownloadSfx.textContent = '🎵 Download Real SFX';
        });
    }
    // Motion Graphics controls
    if (elements.mgEnabled) {
        elements.mgEnabled.addEventListener('change', () => {
            state.mgEnabled = elements.mgEnabled.checked;
            state.mutedTracks['mg-track'] = !state.mgEnabled;
            renderTimeline();
            saveSettings();
        });
    }
    // Subtitles toggle
    if (elements.subtitlesEnabled) {
        elements.subtitlesEnabled.addEventListener('change', () => {
            state.subtitlesEnabled = elements.subtitlesEnabled.checked;
            saveSettings();
        });
    }
    // Niche preset dropdown — save settings on change
    if (elements.buildNiche) {
        elements.buildNiche.addEventListener('change', () => {
            saveSettings();
        });
    }
    // Theme dropdown — refresh MG preview when theme changes
    if (elements.buildTheme) {
        elements.buildTheme.addEventListener('change', () => {
            updateMGOverlay();
            saveSettings();
        });
    }
}

function setupVideoControls() {
    // Create a slightly larger SFX pool so dense sections don't drop nearby hits.
    for (let i = 0; i < 8; i++) {
        const audio = document.createElement('audio');
        audio.preload = 'auto';
        audio.className = 'hidden';
        document.body.appendChild(audio);
        state._sfxAudioPool.push({ element: audio, playing: false });
    }
    // Preload all SFX URLs to avoid IPC latency during playback
    preloadSfxUrls();

    // Play button
    if (elements.btnPlay) {
        elements.btnPlay.addEventListener('click', togglePlayback);
    }

    // Mute button
    if (elements.btnMute) {
        elements.btnMute.addEventListener('click', () => {
            state.isMuted = !state.isMuted;
            elements.btnMute.textContent = state.isMuted ? '🔇' : '🔊';
            applyTrackVolumes();
        });
    }

    // Volume slider
    if (elements.volumeSlider) {
        elements.volumeSlider.addEventListener('input', (e) => {
            state.volume = parseFloat(e.target.value);
            applyTrackVolumes();
        });
    }

    // Fullscreen button
    if (elements.btnFullscreen) {
        elements.btnFullscreen.addEventListener('click', () => {
            if (elements.videoContainer) {
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else {
                    elements.videoContainer.requestFullscreen();
                }
            }
        });
    }
}

function setupElectronListeners() {
    if (window.electronAPI) {
        window.electronAPI.onBuildProgress((data) => updateProgress(data.percent, data.message));
        window.electronAPI.onRenderProgress((data) => updateProgress(data.percent, data.message));

        // Menu commands (Ctrl+Z/C/V/S routed through Electron menu)
        window.electronAPI.onMenuUndo?.(() => undo());
        window.electronAPI.onMenuCopy?.(() => copySelectedClip());
        window.electronAPI.onMenuPaste?.(() => pasteClip());
        window.electronAPI.onMenuSave?.(() => saveProject());
        window.electronAPI.onMenuDelete?.(() => deleteSelectedClips());
        window.electronAPI.onMenuSelectAll?.(() => selectAllClips());
        window.electronAPI.onMenuNew?.(() => newProject());
    }

    // QA Studio pushes fixes directly into memory so auto-save picks them up
    window.electronAPI.onQAPlanUpdated?.((plan) => {
        if (!plan || !plan.scenes) return;
        const sceneByIndex = new Map(state.scenes.map(s => [s.index, s]));
        plan.scenes.forEach((fixedScene, i) => {
            if (!state.videoPlan?.scenes?.[i]) return;
            QA_SYNCABLE_FIELDS.forEach(f => {
                if (fixedScene[f] !== undefined) state.videoPlan.scenes[i][f] = fixedScene[f];
            });
            const stateScene = sceneByIndex.get(fixedScene.index) ?? sceneByIndex.get(i);
            if (stateScene) QA_SYNCABLE_FIELDS.forEach(f => { if (fixedScene[f] !== undefined) stateScene[f] = fixedScene[f]; });
        });
        if (state.compositorActive) loadPlanIntoCompositor();
        showToast('QA fixes applied — compositor updated');
        console.log('[QA] Plan patched from QA Studio — crop/flag fixes active');
    });
}

// ========================================
// Test: Inject all 6 new MG types (Ctrl+Shift+M)
// ========================================
function injectTestMotionGraphics() {
    try {
        if (!state.scenes || state.scenes.length === 0) {
            showNotification('Test MG', 'No scenes loaded — build or load a video first', 'error');
            return;
        }

        const totalDur = state.totalDuration || 60;
        const spacing = Math.max(8, totalDur / 7);
        const style = state.mgStyle || 'clean';

        const testMGs = [
            {
                id: 'test-barchart', type: 'barChart',
                text: 'Market Share 2025',
                subtext: 'Apple:85,Samsung:72,Google:58,Huawei:41,Sony:28',
                duration: 6.0, position: 'center',
            },
            {
                id: 'test-donutchart', type: 'donutChart',
                text: 'Survey Results',
                subtext: 'Agree:45,Disagree:30,Unsure:25',
                duration: 6.0, position: 'center',
            },
            {
                id: 'test-comparison', type: 'comparisonCard',
                text: 'iPhone vs Android',
                subtext: 'Which is better?',
                duration: 5.0, position: 'center',
            },
            {
                id: 'test-timeline', type: 'timeline',
                text: 'Company History',
                subtext: '2018:Founded,2020:Series A,2022:IPO,2024:Global',
                duration: 6.5, position: 'center',
            },
            {
                id: 'test-ranking', type: 'rankingList',
                text: 'Top Languages 2025',
                subtext: 'Python:95,JavaScript:88,TypeScript:76,Rust:62,Go:55',
                duration: 6.0, position: 'center-left',
            },
            {
                id: 'test-kinetic', type: 'kineticText',
                text: 'The Future Is Now',
                subtext: 'Steve Jobs',
                duration: 5.0, position: 'center',
            },
        ];

        // Remove any previously injected test MGs
        state.motionGraphics = (state.motionGraphics || []).filter(mg => !mg.id?.startsWith('test-'));

        // Inject evenly spaced across the video
        testMGs.forEach((mg, i) => {
            const startTime = Math.min(spacing * (i + 0.5), totalDur - mg.duration - 0.5);
            state.motionGraphics.push({
                ...mg,
                startTime: Math.max(0, startTime),
                sceneIndex: 0,
                style,
            });
        });

        renderTracks();
        showNotification('Test MG', 'Injected 6 test motion graphics — seek to each to preview', 'success');
        console.log('[Test MG] Injected 6 test MGs. Timestamps:', state.motionGraphics.filter(m => m.id?.startsWith('test-')).map(m => `${m.type} @ ${m.startTime.toFixed(1)}s`));
    } catch (err) {
        console.error('[Test MG] Error:', err);
        showNotification('Test MG', `Error: ${err.message}`, 'error');
    }
}
// Expose for DevTools console access
window.injectTestMotionGraphics = injectTestMotionGraphics;

/**
 * Snap playhead to the next (+1) or previous (-1) clip edge.
 * Collects all unique start/end times from scenes + motion graphics.
 */
function snapToClipEdge(direction) {
    const edges = new Set();
    for (const s of (state.scenes || [])) {
        if (s.startTime != null) edges.add(+s.startTime.toFixed(3));
        if (s.endTime != null) edges.add(+s.endTime.toFixed(3));
    }
    for (const mg of (state.motionGraphics || [])) {
        if (mg.startTime != null) edges.add(+mg.startTime.toFixed(3));
        if (mg.endTime != null) edges.add(+mg.endTime.toFixed(3));
    }
    const sorted = [...edges].sort((a, b) => a - b);
    if (sorted.length === 0) return;

    const now = +state.currentTime.toFixed(3);
    const EPS = 0.005;
    if (direction > 0) {
        const next = sorted.find(t => t > now + EPS);
        if (next != null) seekToTime(next);
    } else {
        const prev = sorted.slice().reverse().find(t => t < now - EPS);
        if (prev != null) seekToTime(prev);
    }
}

function setupKeyboardShortcuts() {
    document.addEventListener('keydown', (e) => {
        if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;

        // Ctrl shortcuts
        if (e.ctrlKey || e.metaKey) {
            if (e.shiftKey && e.code === 'KeyZ') { e.preventDefault(); redo(); return; }
            if (e.code === 'KeyZ') { e.preventDefault(); undo(); return; }
            if (e.code === 'KeyY') { e.preventDefault(); redo(); return; }
            if (e.code === 'KeyC') { e.preventDefault(); copySelectedClip(); return; }
            if (e.code === 'KeyV') { e.preventDefault(); pasteClip(); return; }
            if (e.code === 'KeyS') { e.preventDefault(); saveProject(); return; }
            if (e.code === 'KeyA') { e.preventDefault(); selectAllClips(); return; }
            if (e.code === 'KeyR') { e.preventDefault(); refreshApp(); return; }
        }

        // F5 to refresh app
        if (e.code === 'F5') { e.preventDefault(); refreshApp(); return; }

        // Delete selected clips (single or multi)
        if ((e.code === 'Delete' || e.code === 'Backspace') && (state.selectedClipIndices.length > 0 || state.selectedClipIndex >= 0)) {
            e.preventDefault(); deleteSelectedClips(); return;
        }

        // Ctrl+Shift+M: Inject test motion graphics (all 6 new types)
        if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.code === 'KeyM') {
            e.preventDefault(); injectTestMotionGraphics(); return;
        }

        // In/Out points (Premiere-style: I = set in, O = set out)
        if (e.code === 'KeyI' && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); setInPoint(state.currentTime); return; }
        if (e.code === 'KeyO' && !e.ctrlKey && !e.shiftKey) { e.preventDefault(); setOutPoint(state.currentTime); return; }

        if (e.code === 'Space') { e.preventDefault(); togglePlayback(); }
        else if (e.shiftKey && e.code === 'KeyF') { e.preventDefault(); zoomToFit(); }
        else if (e.code === 'KeyF') { e.preventDefault(); cutClipAtPlayhead(); }
        else if (e.code === 'ArrowUp') { e.preventDefault(); snapToClipEdge(1); }
        else if (e.code === 'ArrowDown') { e.preventDefault(); snapToClipEdge(-1); }
        else if (e.code === 'ArrowLeft') { e.preventDefault(); seekToTime(state.currentTime - 1); }
        else if (e.code === 'ArrowRight') { e.preventDefault(); seekToTime(state.currentTime + 1); }
        else if (e.code === 'Home') { e.preventDefault(); seekToTime(0); }
        else if (e.code === 'End') { e.preventDefault(); seekToTime(state.totalDuration); }
        else if (e.code === 'Escape') { deselectClip(); clearInOutPoints(); }
    });
}

// ========================================
// In/Out Points (Premiere-style work area)
// ========================================
function setInPoint(timeSec) {
    // If out point exists and in would be >= out, ignore
    if (state.outPoint !== null && timeSec >= state.outPoint) {
        showToast('In point must be before out point', 'warning');
        return;
    }
    state.inPoint = Math.max(0, timeSec);
    showToast(`In: ${formatTime(state.inPoint)}`, 'info');
    renderInOutMarkers();
    updateInOutDisplay();
}

function setOutPoint(timeSec) {
    // If in point exists and out would be <= in, ignore
    if (state.inPoint !== null && timeSec <= state.inPoint) {
        showToast('Out point must be after in point', 'warning');
        return;
    }
    state.outPoint = Math.min(timeSec, state.totalDuration);
    showToast(`Out: ${formatTime(state.outPoint)}`, 'info');
    renderInOutMarkers();
    updateInOutDisplay();
}

function clearInOutPoints() {
    if (state.inPoint === null && state.outPoint === null) return;
    state.inPoint = null;
    state.outPoint = null;
    showToast('In/Out points cleared', 'info');
    renderInOutMarkers();
    updateInOutDisplay();
}

/** Get effective render range in seconds */
function getRenderRange() {
    const inSec = state.inPoint !== null ? state.inPoint : 0;
    const outSec = state.outPoint !== null ? state.outPoint : state.totalDuration;
    return { inSec, outSec, duration: outSec - inSec };
}

/** Draw in/out markers + shaded work area on ruler */
function renderInOutMarkers() {
    const ruler = document.getElementById('timeline-ruler');
    const content = document.getElementById('timeline-content');
    if (!ruler) return;
    const zoom = state.timeline.zoom;

    // Remove old markers from ruler and track content
    ruler.querySelectorAll('.in-out-marker, .in-out-shade, .in-out-workarea').forEach(el => el.remove());
    if (content) content.querySelectorAll('.in-out-track-shade, .in-out-track-border').forEach(el => el.remove());

    const hasIn = state.inPoint !== null;
    const hasOut = state.outPoint !== null;
    if (!hasIn && !hasOut) return;

    const inPx = hasIn ? state.inPoint * zoom : 0;
    const outPx = hasOut ? state.outPoint * zoom : state.totalDuration * zoom;

    // Shaded area before in point (dimmed) — ruler
    if (hasIn && inPx > 0) {
        const shade = document.createElement('div');
        shade.className = 'in-out-shade';
        shade.style.cssText = `left:0; width:${inPx}px;`;
        ruler.appendChild(shade);
    }

    // Shaded area after out point (dimmed) — ruler
    if (hasOut) {
        const shade = document.createElement('div');
        shade.className = 'in-out-shade';
        shade.style.cssText = `left:${outPx}px; right:0;`;
        ruler.appendChild(shade);
    }

    // Work area bar (bright bar between in and out) — ruler
    const workarea = document.createElement('div');
    workarea.className = 'in-out-workarea';
    workarea.style.cssText = `left:${inPx}px; width:${outPx - inPx}px;`;
    ruler.appendChild(workarea);

    // In marker
    if (hasIn) {
        const marker = document.createElement('div');
        marker.className = 'in-out-marker in-marker';
        marker.style.left = `${inPx}px`;
        marker.title = `In: ${formatTime(state.inPoint)}`;
        marker.textContent = 'I';
        ruler.appendChild(marker);
    }

    // Out marker
    if (hasOut) {
        const marker = document.createElement('div');
        marker.className = 'in-out-marker out-marker';
        marker.style.left = `${outPx}px`;
        marker.title = `Out: ${formatTime(state.outPoint)}`;
        marker.textContent = 'O';
        ruler.appendChild(marker);
    }

    // Track-level shading — dim areas outside work area on the tracks themselves
    if (content) {
        if (hasIn && inPx > 0) {
            const shade = document.createElement('div');
            shade.className = 'in-out-track-shade';
            shade.style.cssText = `left:0; width:${inPx}px;`;
            content.appendChild(shade);
        }
        if (hasOut) {
            const shade = document.createElement('div');
            shade.className = 'in-out-track-shade';
            shade.style.cssText = `left:${outPx}px; right:0;`;
            content.appendChild(shade);
        }
        // Vertical boundary lines at in/out points
        if (hasIn) {
            const line = document.createElement('div');
            line.className = 'in-out-track-border';
            line.style.left = `${inPx}px`;
            content.appendChild(line);
        }
        if (hasOut) {
            const line = document.createElement('div');
            line.className = 'in-out-track-border';
            line.style.left = `${outPx}px`;
            content.appendChild(line);
        }
    }
}

/** Update the time display to show in/out range if set */
function updateInOutDisplay() {
    const display = document.getElementById('in-out-display');
    if (!display) return;

    if (state.inPoint === null && state.outPoint === null) {
        display.style.display = 'none';
        return;
    }

    const { inSec, outSec, duration } = getRenderRange();
    display.style.display = 'inline-flex';
    display.innerHTML = `
        <span class="in-out-label">Work Area:</span>
        <span class="in-out-range">${formatTime(inSec)} → ${formatTime(outSec)}</span>
        <span class="in-out-duration">(${formatTime(duration)})</span>
        <button class="in-out-clear" title="Clear In/Out (Esc)" onclick="clearInOutPoints()">✕</button>
    `;
}

// ========================================
// Undo System
// ========================================
function pushUndoState() {
    state.undoStack.push(JSON.parse(JSON.stringify(state.scenes)));
    if (state.undoStack.length > state.maxUndoLevels) {
        state.undoStack.shift();
    }
    // Any new action invalidates the redo stack
    state.redoStack = [];
    // Trigger auto-save to .fvp file (debounced)
    triggerAutoSave();
}

function undo() {
    if (state.undoStack.length === 0) {
        showToast('Nothing to undo', 'info');
        return;
    }
    // Save current state to redo stack before restoring
    state.redoStack.push(JSON.parse(JSON.stringify(state.scenes)));
    state.scenes = state.undoStack.pop();
    state.selectedClipIndex = -1;
    state.selectedClipIndices = [];
    recalcTotalDuration();
    renderTimeline();
    updateClipProperties();
    // Reload preview to match restored scene state
    loadActiveScenes();
    showToast('Undo', 'info');
}

function redo() {
    if (state.redoStack.length === 0) {
        showToast('Nothing to redo', 'info');
        return;
    }
    // Save current state to undo stack before redoing
    state.undoStack.push(JSON.parse(JSON.stringify(state.scenes)));
    state.scenes = state.redoStack.pop();
    state.selectedClipIndex = -1;
    state.selectedClipIndices = [];
    recalcTotalDuration();
    renderTimeline();
    updateClipProperties();
    // Reload preview to match restored scene state
    loadActiveScenes();
    showToast('Redo', 'info');
}

// ========================================
// Clipboard (Copy / Paste / Delete)
// ========================================
function selectClip(index, ctrlKey = false) {
    if (ctrlKey) {
        // Multi-select: toggle this clip in the selection
        const pos = state.selectedClipIndices.indexOf(index);
        if (pos >= 0) {
            state.selectedClipIndices.splice(pos, 1);
        } else {
            state.selectedClipIndices.push(index);
        }
        // Primary selection = last added (for properties panel)
        state.selectedClipIndex = state.selectedClipIndices.length > 0
            ? state.selectedClipIndices[state.selectedClipIndices.length - 1]
            : -1;
    } else {
        // Single select: clear others
        state.selectedClipIndices = [index];
        state.selectedClipIndex = index;
    }
    // Deselect any MG selection
    state.selectedMgIndex = -1;
    document.querySelectorAll('.mg-clip').forEach(c => c.classList.remove('selected'));
    // Update visual selection
    document.querySelectorAll('.timeline-clip').forEach(c => c.classList.remove('selected'));
    state.selectedClipIndices.forEach(idx => {
        const clip = document.querySelector(`.timeline-clip[data-index="${idx}"]`);
        if (clip) clip.classList.add('selected');
    });
    updateClipProperties();
    applySceneTransform(state.selectedClipIndex);
}

function selectAllClips() {
    if (state.scenes.length === 0) return;
    state.selectedClipIndices = state.scenes.map((_, i) => i);
    state.selectedClipIndex = state.selectedClipIndices[state.selectedClipIndices.length - 1];
    document.querySelectorAll('.timeline-clip[data-index]').forEach(c => c.classList.add('selected'));
    updateClipProperties();
    const count = state.selectedClipIndices.length;
    showToast(`Selected all ${count} clips`, 'info');
}

function deselectClip() {
    state.selectedClipIndex = -1;
    state.selectedClipIndices = [];
    state.selectedMgIndex = -1;
    clearSceneTransform();
    document.querySelectorAll('.timeline-clip').forEach(c => c.classList.remove('selected'));
    document.querySelectorAll('.mg-clip').forEach(c => c.classList.remove('selected'));
    updateClipProperties();
}

function copySelectedClip() {
    if (state.selectedClipIndex < 0 || !state.scenes[state.selectedClipIndex]) {
        showToast('No clip selected to copy', 'info');
        return;
    }
    state.clipboard = JSON.parse(JSON.stringify(state.scenes[state.selectedClipIndex]));
    showToast('Clip copied', 'info');
}

function pasteClip() {
    if (!state.clipboard) {
        showToast('Nothing to paste', 'info');
        return;
    }
    pushUndoState();
    const clip = JSON.parse(JSON.stringify(state.clipboard));
    // Place at current playhead position
    const duration = clip.endTime - clip.startTime;
    clip.startTime = state.currentTime;
    clip.endTime = state.currentTime + duration;
    // Keep the original scene index so the correct video file loads (scene-{index}.mp4)
    // Do NOT overwrite clip.index - it must point to the original scene's video file
    state.scenes.push(clip);
    state.scenes.sort((a, b) => a.startTime - b.startTime);
    recalcTotalDuration();
    renderTimeline();
    showToast('Clip pasted', 'info');
}

function deleteSelectedClip() {
    // Legacy single-clip delete, now delegates to multi
    deleteSelectedClips();
}

function deleteSelectedClips() {
    // Collect indices to delete (multi-select or single)
    let toDelete = [...state.selectedClipIndices];
    if (toDelete.length === 0 && state.selectedClipIndex >= 0) {
        toDelete = [state.selectedClipIndex];
    }
    toDelete = toDelete.filter(i => i >= 0 && i < state.scenes.length);
    if (toDelete.length === 0) return;

    pushUndoState();
    // Sort descending so splicing doesn't shift indices
    toDelete.sort((a, b) => b - a);
    for (const idx of toDelete) {
        state.scenes.splice(idx, 1);
    }
    state.selectedClipIndex = -1;
    state.selectedClipIndices = [];
    recalcTotalDuration();
    renderTimeline();
    showToast(`${toDelete.length} clip${toDelete.length > 1 ? 's' : ''} deleted`, 'info');
}

// ========================================
// Cut Clip at Playhead (F key)
// ========================================
function cutClipAtPlayhead() {
    const idx = getSceneAtTime(state.currentTime);
    if (idx < 0) {
        showToast('No clip at playhead to cut', 'info');
        return;
    }
    const scene = state.scenes[idx];

    // Can't cut MG scenes (no media file to split)
    if (scene.isMGScene) {
        showToast('Cannot cut motion graphic scenes', 'info');
        return;
    }

    const cutTime = state.currentTime;

    // Don't cut if too close to edges (min 0.2s per piece)
    if (cutTime - scene.startTime < 0.2 || scene.endTime - cutTime < 0.2) {
        showToast('Clip too short to cut here', 'info');
        return;
    }

    pushUndoState();

    // Create the second half (right side of cut)
    const rightClip = JSON.parse(JSON.stringify(scene));
    rightClip.startTime = cutTime;
    // mediaOffset tracks how far into the source video this clip starts
    rightClip.mediaOffset = (scene.mediaOffset || 0) + (cutTime - scene.startTime);

    // Trim the original (left side of cut)
    scene.endTime = cutTime;

    // Insert right clip after the original
    state.scenes.splice(idx + 1, 0, rightClip);
    recalcTotalDuration();
    renderTimeline();
    showToast('Clip cut at playhead (F)', 'info');
}

// Recalculate totalDuration from scenes + audio
function recalcTotalDuration() {
    const scenesEnd = state.scenes.length > 0 ? Math.max(...state.scenes.map(s => s.endTime)) : 0;
    const audioDur = (elements.previewAudio && isFinite(elements.previewAudio.duration)) ? elements.previewAudio.duration : 0;
    state.totalDuration = Math.max(scenesEnd, audioDur);
}

// ========================================
// Clip Properties (Scale / Position)
// ========================================
function updateClipProperties() {
    const panel = elements.clipProperties;
    const overlayPanel = document.getElementById('overlay-properties');
    const mgPanel = document.getElementById('mg-properties');
    const mapPanel = document.getElementById('map-properties');
    const listiclePanel = document.getElementById('listicle-properties');
    const templatePanel = document.getElementById('template-properties');
    const emptyState = document.getElementById('properties-empty');
    const titleEl = document.getElementById('properties-title');

    // Hide all panels first
    if (panel) panel.classList.add('hidden');
    if (overlayPanel) overlayPanel.classList.add('hidden');
    if (mgPanel) mgPanel.classList.add('hidden');
    if (mapPanel) mapPanel.classList.add('hidden');
    if (listiclePanel) listiclePanel.classList.add('hidden');
    if (templatePanel) templatePanel.classList.add('hidden');

    // MG selected?
    if (state.selectedMgIndex >= 0 && state.motionGraphics[state.selectedMgIndex]) {
        if (emptyState) emptyState.classList.add('hidden');
        const mgTypeLabels = { headline: 'Headline', lowerThird: 'Lower Third', statCounter: 'Stat Counter', callout: 'Callout', bulletList: 'Bullet List', focusWord: 'Focus Word', progressBar: 'Progress Bar', listicleCounter: 'Listicle Item' };
        const mg = state.motionGraphics[state.selectedMgIndex];
        const mgType = mg.type;
        if (titleEl) titleEl.textContent = mgTypeLabels[mgType] || 'Motion Graphic';

        // Listicle types get their own dedicated panel
        if (LISTICLE_TYPES.has(mgType)) {
            updateListicleProperties(mg);
            expandPropertiesSection();
            return;
        }

        updateMgProperties();
        expandPropertiesSection();
        return;
    }

    // No scene selected?
    if (state.selectedClipIndex < 0 || !state.scenes[state.selectedClipIndex]) {
        if (emptyState) emptyState.classList.remove('hidden');
        if (titleEl) titleEl.textContent = 'Properties';
        return;
    }

    const scene = state.scenes[state.selectedClipIndex];

    // Full-screen MG scene on V3 — show MG properties panel
    if (scene.isMGScene) {
        if (emptyState) emptyState.classList.add('hidden');
        const mgData = scene.mgData || scene;
        state.selectedMgIndex = -1; // Not from MG track
        state._selectedMgScene = scene; // Temp reference for panel

        // Map scenes get their own dedicated panel
        if (scene.type === 'mapChart') {
            if (titleEl) titleEl.textContent = 'Map';
            updateMapProperties(scene);
            expandPropertiesSection();
            return;
        }

        // Listicle Templates get their own dedicated panel (separate from MGs)
        if (TEMPLATE_TYPES.has(scene.type)) {
            const reg = TEMPLATE_REGISTRY[scene.type];
            if (titleEl) titleEl.textContent = (reg ? reg.label : null) || 'Template';
            updateTemplateProperties(mgData);
            expandPropertiesSection();
            return;
        }

        const mgTypeLabels = { barChart: 'Bar Chart', donutChart: 'Donut Chart', rankingList: 'Ranking List', timeline: 'Timeline', comparisonCard: 'Comparison', bulletList: 'Bullet List', articleHighlight: 'Article' };
        if (titleEl) titleEl.textContent = mgTypeLabels[scene.type] || 'Motion Graphic';

        updateMgPropertiesForScene(scene);
        expandPropertiesSection();
        return;
    }

    // Regular video/image clip
    if (!panel) return;
    if (emptyState) emptyState.classList.add('hidden');
    if (titleEl) titleEl.textContent = 'Clip Properties';
    panel.classList.remove('hidden');
    expandPropertiesSection();

    const scale = scene.scale !== undefined ? scene.scale : 1;
    const posX = scene.posX || 0;
    const posY = scene.posY || 0;

    if (elements.propScale) { elements.propScale.value = scale; }
    if (elements.propPosX) { elements.propPosX.value = posX; }
    if (elements.propPosY) { elements.propPosY.value = posY; }
    if (elements.propScaleVal) { elements.propScaleVal.value = scale.toFixed(2); }
    if (elements.propPosXVal) { elements.propPosXVal.value = `${posX}%`; }
    if (elements.propPosYVal) { elements.propPosYVal.value = `${posY}%`; }

    // Hide volume for images (no audio)
    const volumeRow = document.getElementById('prop-volume-row');
    const isImage = scene.mediaType === 'image';
    if (volumeRow) volumeRow.style.display = isImage ? 'none' : '';

    const volume = scene.volume !== undefined ? scene.volume : 1;
    if (elements.propVolume) { elements.propVolume.value = volume; }
    if (elements.propVolumeVal) { elements.propVolumeVal.value = `${Math.round(volume * 100)}%`; }

    // Background dropdown
    if (elements.propBackground) {
        elements.propBackground.value = scene.background || 'none';
    }
    // Fit mode dropdown
    if (elements.propFitMode) {
        elements.propFitMode.value = scene.fitMode || 'cover';
    }

    // Overlay-specific controls (compositor directives on any upper track)
    const isV2Overlay = !!scene._compositorDirective;
    const slideDirRow = document.getElementById('prop-slide-dir-row');
    const slideSpeedRow = document.getElementById('prop-slide-speed-row');
    const bgBlurRow = document.getElementById('prop-bg-blur-row');
    const bgRow = elements.propBackground?.closest('.property-row');
    const fitRow = elements.propFitMode?.closest('.property-row');
    if (slideDirRow) slideDirRow.style.display = isV2Overlay ? '' : 'none';
    if (slideSpeedRow) slideSpeedRow.style.display = isV2Overlay ? '' : 'none';
    if (bgBlurRow) bgBlurRow.style.display = isV2Overlay ? '' : 'none';
    if (bgRow) bgRow.style.display = isV2Overlay ? 'none' : '';
    if (fitRow) fitRow.style.display = isV2Overlay ? 'none' : '';
    if (isV2Overlay) {
        const slideDirEl = document.getElementById('prop-slide-dir');
        const bgBlurEl = document.getElementById('prop-bg-blur');
        const slideSpeedEl = document.getElementById('prop-slide-speed');
        const slideSpeedValEl = document.getElementById('prop-slide-speed-val');
        if (slideDirEl) slideDirEl.value = scene.slideDirection || 'auto';
        if (bgBlurEl) bgBlurEl.value = scene.bgBlur || 'none';
        const spd = scene.slideDuration || 0.4;
        if (slideSpeedEl) slideSpeedEl.value = spd;
        if (slideSpeedValEl) slideSpeedValEl.textContent = `${spd}s`;
    }

    // Crop sliders
    const cropTop = scene.cropTop || 0;
    const cropBottom = scene.cropBottom || 0;
    const cropLeft = scene.cropLeft || 0;
    const cropRight = scene.cropRight || 0;
    if (elements.propCropTop) { elements.propCropTop.value = cropTop; }
    if (elements.propCropBottom) { elements.propCropBottom.value = cropBottom; }
    if (elements.propCropLeft) { elements.propCropLeft.value = cropLeft; }
    if (elements.propCropRight) { elements.propCropRight.value = cropRight; }
    if (elements.propCropTopVal) { elements.propCropTopVal.value = `${cropTop}%`; }
    if (elements.propCropBottomVal) { elements.propCropBottomVal.value = `${cropBottom}%`; }
    if (elements.propCropLeftVal) { elements.propCropLeftVal.value = `${cropLeft}%`; }
    if (elements.propCropRightVal) { elements.propCropRightVal.value = `${cropRight}%`; }

    // Border radius slider
    const borderRadius = scene.borderRadius || 0;
    if (elements.propBorderRadius) { elements.propBorderRadius.value = borderRadius; }
    if (elements.propBorderRadiusVal) { elements.propBorderRadiusVal.value = `${borderRadius}%`; }

    // Floating frame section — show for all V1 scenes, expand controls when floating
    if (elements.propFloatingSection) {
        const isV1 = !scene.trackId || scene.trackId === 'video-track-1';
        elements.propFloatingSection.style.display = isV1 ? '' : 'none';
        if (isV1) {
            const framing = scene.framing || 'fullscreen';
            if (elements.propFraming) elements.propFraming.value = framing;
            const isFloating = framing === 'floating';
            if (elements.propFloatingControls) elements.propFloatingControls.style.display = isFloating ? '' : 'none';
            if (isFloating) {
                const shadowVal = typeof scene.shadow === 'number' ? scene.shadow : (scene.shadow ? 0.5 : 0);
                if (elements.propShadow) elements.propShadow.value = shadowVal;
                if (elements.propShadowVal) elements.propShadowVal.value = shadowVal.toFixed(2);
                if (elements.propFloatingAnim) elements.propFloatingAnim.value = scene.floatingAnim || 'slideRight';
                const animDur = scene.floatingAnimDuration || 0.6;
                if (elements.propFloatingAnimDur) elements.propFloatingAnimDur.value = animDur;
                if (elements.propFloatingAnimDurVal) elements.propFloatingAnimDurVal.value = animDur.toFixed(2) + 's';

            }
        }
    }

    // Effects controls
    _populateEffectControls(scene);

    // Animate checkbox (only for images)
    if (elements.propAnimateRow) {
        const isImage = scene.mediaType === 'image';
        elements.propAnimateRow.style.display = isImage ? '' : 'none';
        if (isImage && elements.propAnimate) {
            const kbEnabled = scene.kenBurnsEnabled !== false;
            elements.propAnimate.checked = kbEnabled;
            // Show/hide speed slider based on checkbox
            if (elements.propKbSpeedRow) {
                elements.propKbSpeedRow.style.display = kbEnabled ? '' : 'none';
            }
            if (elements.propKbSpeed) {
                const speed = scene.kenBurnsSpeed !== undefined ? scene.kenBurnsSpeed : 1;
                elements.propKbSpeed.value = speed;
            }
            if (elements.propKbSpeedVal) {
                const speed = scene.kenBurnsSpeed !== undefined ? scene.kenBurnsSpeed : 1;
                elements.propKbSpeedVal.textContent = speed.toFixed(1) + 'x';
            }
        }
    }
}

// ── Effect Presets Registry ──
// Each preset defines: effects[] (shader toggles), params (per-effect values),
// mask (global mask), sliders[] (which UI sliders to show), themes[] (relevant themes)
// To add a new preset: add an entry here — UI builds automatically
// Load effect presets from shared module (via preload) — single source of truth
const EFFECT_PRESETS = window._effectPresets || {
    none: { label: 'None', description: 'No effect', effects: [], params: {}, mask: null, sliders: [], themes: ['*'] }
};

const MASK_TYPES = [
    { value: 'none', label: 'No Mask' },
    { value: 'radialCenter', label: 'Soft Center' },
    { value: 'radialEdge', label: 'Soft Edges' },
    { value: 'linearTB', label: 'Top → Bottom' }
];

function _populateEffectControls(scene) {
    const section = document.getElementById('prop-effects-section');
    const list = document.getElementById('prop-effects-list');
    if (!section || !list) return;

    section.style.display = '';
    list.innerHTML = '';

    if (!scene.effectOverrides) scene.effectOverrides = {};
    if (!scene.effectMask) scene.effectMask = {};

    const activeTheme = _resolveActiveTheme() || 'standard';
    const currentPreset = scene.effectPreset || 'none';

    // ── Preset dropdown ──
    const presetRow = document.createElement('div');
    presetRow.className = 'effect-control-row';
    const presetLabel = document.createElement('span');
    presetLabel.className = 'effect-label';
    presetLabel.textContent = 'Effect';
    const presetSelect = document.createElement('select');
    presetSelect.className = 'property-select effect-preset-select';
    presetSelect.style.cssText = 'flex:1; font-size:0.6rem; height:22px;';

    // Order: 'none' first, then theme-relevant, then rest
    const allKeys = Object.keys(EFFECT_PRESETS);
    const themeFirst = allKeys.filter(k => {
        const p = EFFECT_PRESETS[k];
        return k !== 'none' && p.themes && (p.themes.includes('*') || p.themes.includes(activeTheme));
    });
    const rest = allKeys.filter(k => k !== 'none' && !themeFirst.includes(k));
    const ordered = ['none', ...themeFirst, ...rest];

    for (const key of ordered) {
        const p = EFFECT_PRESETS[key];
        if (!p) continue;
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = p.label;
        // Mark theme-relevant with a star
        if (key !== 'none' && p.themes && p.themes.includes(activeTheme)) {
            opt.textContent = '★ ' + p.label;
        }
        if (key === currentPreset) opt.selected = true;
        presetSelect.appendChild(opt);
    }
    presetSelect.addEventListener('change', () => {
        if (state.selectedClipIndex < 0) return;
        _applyEffectPreset(state.selectedClipIndex, presetSelect.value);
        _populateEffectControls(state.scenes[state.selectedClipIndex]);
        _syncEffectToCompositor(state.selectedClipIndex);
    });
    presetRow.appendChild(presetLabel);
    presetRow.appendChild(presetSelect);
    list.appendChild(presetRow);

    // If none selected, stop here
    if (currentPreset === 'none') return;

    const preset = EFFECT_PRESETS[currentPreset];
    if (!preset) return;

    // ── Preset sliders (Intensity, Speed, Warmth etc) ──
    if (preset.sliders) {
        for (const sl of preset.sliders) {
            if (!scene._presetSliders) scene._presetSliders = {};
            const val = scene._presetSliders[sl.key] !== undefined ? scene._presetSliders[sl.key] : sl.def;

            const row = document.createElement('div');
            row.className = 'effect-control-row';
            const lbl = document.createElement('span');
            lbl.className = 'effect-label';
            lbl.textContent = sl.label;
            const slider = document.createElement('input');
            slider.type = 'range'; slider.className = 'effect-slider';
            slider.min = sl.min; slider.max = sl.max; slider.step = 1; slider.value = val;
            const valSpan = document.createElement('span');
            valSpan.className = 'effect-value';
            valSpan.textContent = Math.round(val);

            slider.addEventListener('input', () => {
                if (state.selectedClipIndex < 0) return;
                const s = state.scenes[state.selectedClipIndex];
                if (!s._presetSliders) s._presetSliders = {};
                const v = parseInt(slider.value);
                s._presetSliders[sl.key] = v;
                valSpan.textContent = v;
                _applyPresetSliders(state.selectedClipIndex);
                _syncEffectToCompositor(state.selectedClipIndex);
            });

            row.appendChild(lbl);
            row.appendChild(slider);
            row.appendChild(valSpan);
            list.appendChild(row);
        }
    }

    // ── Global mask row ──
    const maskRow = document.createElement('div');
    maskRow.className = 'effect-control-row effect-mask-row';
    const maskLabel = document.createElement('span');
    maskLabel.className = 'effect-label';
    maskLabel.textContent = 'Mask';
    const maskSelect = document.createElement('select');
    maskSelect.className = 'property-select effect-mask-select';
    maskSelect.style.cssText = 'flex:0 0 90px; font-size:0.6rem; height:22px;';
    for (const mt of MASK_TYPES) {
        const opt = document.createElement('option');
        opt.value = mt.value;
        opt.textContent = mt.label;
        if (mt.value === (scene.effectMask.type || 'none')) opt.selected = true;
        maskSelect.appendChild(opt);
    }
    const maskSlider = document.createElement('input');
    maskSlider.type = 'range'; maskSlider.className = 'effect-slider';
    maskSlider.min = 0; maskSlider.max = 1; maskSlider.step = 0.05;
    maskSlider.value = scene.effectMask.strength !== undefined ? scene.effectMask.strength : 0.8;
    const maskIsNone = (scene.effectMask.type || 'none') === 'none';
    maskSlider.style.display = maskIsNone ? 'none' : '';
    const maskVal = document.createElement('span');
    maskVal.className = 'effect-value';
    maskVal.textContent = maskIsNone ? '' : Math.round((scene.effectMask.strength || 0.8) * 100) + '%';

    maskSelect.addEventListener('change', () => {
        if (state.selectedClipIndex < 0) return;
        const s = state.scenes[state.selectedClipIndex];
        if (!s.effectMask) s.effectMask = {};
        s.effectMask.type = maskSelect.value;
        const isNone = maskSelect.value === 'none';
        maskSlider.style.display = isNone ? 'none' : '';
        maskVal.textContent = isNone ? '' : Math.round(parseFloat(maskSlider.value) * 100) + '%';
        _syncEffectToCompositor(state.selectedClipIndex);
    });
    maskSlider.addEventListener('input', () => {
        if (state.selectedClipIndex < 0) return;
        const s = state.scenes[state.selectedClipIndex];
        if (!s.effectMask) s.effectMask = {};
        s.effectMask.strength = parseFloat(maskSlider.value);
        maskVal.textContent = Math.round(parseFloat(maskSlider.value) * 100) + '%';
        _syncEffectToCompositor(state.selectedClipIndex);
    });
    maskRow.appendChild(maskLabel);
    maskRow.appendChild(maskSelect);
    maskRow.appendChild(maskSlider);
    maskRow.appendChild(maskVal);
    list.appendChild(maskRow);
}

// Apply a preset — sets effects, params, mask from the preset definition
function _applyEffectPreset(sceneIndex, presetKey) {
    const s = state.scenes[sceneIndex];
    if (!s) return;
    s.effectPreset = presetKey;
    const preset = EFFECT_PRESETS[presetKey];
    if (!preset) return;

    s.effects = preset.effects ? [...preset.effects] : [];
    s.effectOverrides = {};
    if (preset.params) {
        for (const [fx, params] of Object.entries(preset.params)) {
            s.effectOverrides[fx] = { ...params, enabled: true };
        }
    }
    if (preset.mask) {
        s.effectMask = { ...preset.mask };
    } else {
        s.effectMask = { type: 'none', strength: 0.8 };
    }
    // Reset slider values to defaults
    s._presetSliders = {};
    if (preset.sliders) {
        for (const sl of preset.sliders) {
            s._presetSliders[sl.key] = sl.def;
        }
    }
}

// Scale preset params based on slider values (Intensity/Speed/Warmth)
function _applyPresetSliders(sceneIndex) {
    const s = state.scenes[sceneIndex];
    if (!s || !s.effectPreset) return;
    const preset = EFFECT_PRESETS[s.effectPreset];
    if (!preset || !preset.params) return;
    const sliders = s._presetSliders || {};

    // Intensity slider (0-100) scales all effect intensities
    const intensityMul = (sliders.intensity !== undefined ? sliders.intensity : 50) / 50; // 1.0 at 50
    // Speed slider (0-100) scales all speed/animation params
    const speedMul = (sliders.speed !== undefined ? sliders.speed : 50) / 50;
    // Warmth slider (0-100) scales tint strength and light leak warmth
    const warmthMul = (sliders.warmth !== undefined ? sliders.warmth : 50) / 50;
    // Border slider (0-100) scales filmFrame border size
    const borderMul = (sliders.border !== undefined ? sliders.border : 50) / 50;

    // Rebuild overrides from preset base, scaled by sliders
    s.effectOverrides = {};
    for (const [fx, baseParams] of Object.entries(preset.params)) {
        const scaled = { ...baseParams, enabled: true };
        // Scale intensity-like params
        if (scaled.intensity !== undefined) scaled.intensity = baseParams.intensity * intensityMul;
        if (scaled.density !== undefined) scaled.density = baseParams.density * intensityMul;
        if (scaled.desaturation !== undefined) scaled.desaturation = Math.min(1, baseParams.desaturation * intensityMul);
        if (scaled.tintStrength !== undefined) scaled.tintStrength = Math.min(1, baseParams.tintStrength * (warmthMul !== undefined ? warmthMul : intensityMul));
        if (scaled.warmth !== undefined) scaled.warmth = Math.min(1, baseParams.warmth * (warmthMul !== undefined ? warmthMul : 1));
        // Scale speed-like params
        if (scaled.speed !== undefined) scaled.speed = baseParams.speed * speedMul;
        // Scale border-like params (filmFrame)
        if (scaled.border !== undefined) scaled.border = Math.min(0.12, baseParams.border * borderMul);
        if (scaled.radius !== undefined && fx === 'filmFrame') scaled.radius = Math.min(0.08, baseParams.radius * borderMul);
        s.effectOverrides[fx] = scaled;
    }
}

function _fmtEffectVal(fx, val) {
    if (fx === 'chromatic') return val.toFixed(3);
    if (val >= 1) return val.toFixed(1);
    return val.toFixed(2);
}

function _syncEffectToCompositor(sceneIndex) {
    if (!state.compositorActive || !state.compositor || !state.compositor.isInitialized) return;
    const sg = state.compositor.sceneGraph;
    if (!sg) return;
    const srcScene = state.scenes[sceneIndex];
    if (!srcScene) return;
    const target = sg._scenes.find(s => s.index === srcScene.index);
    if (!target) return;
    target.effects = srcScene.effects;
    target.effectOverrides = srcScene.effectOverrides;
    target.effectMask = srcScene.effectMask;
    // Re-render
    const fps = state.compositor.fps;
    const frame = Math.round((state.currentTime || 0) * fps);
    state.compositor.renderFrame(frame);
}

function expandPropertiesSection() {
    const section = document.getElementById('properties-section');
    if (section) section.classList.remove('collapsed');
}

function updateOverlayProperties(scene) {
    const panel = document.getElementById('overlay-properties');
    if (!panel) return;
    panel.classList.remove('hidden');

    const intensity = scene.overlayIntensity !== undefined ? scene.overlayIntensity : 0.5;
    const blend = scene.blendMode || 'screen';
    const scale = scene.scale !== undefined ? scene.scale : 1;

    const intensityEl = document.getElementById('overlay-intensity');
    const intensityVal = document.getElementById('overlay-intensity-val');
    const blendEl = document.getElementById('overlay-blend');
    const scaleEl = document.getElementById('overlay-scale');
    const scaleVal = document.getElementById('overlay-scale-val');

    if (intensityEl) intensityEl.value = intensity;
    if (intensityVal) intensityVal.textContent = `${Math.round(intensity * 100)}%`;
    if (blendEl) blendEl.value = blend;
    if (scaleEl) scaleEl.value = scale;
    if (scaleVal) scaleVal.textContent = scale.toFixed(2);
}

function updateMgProperties() {
    const panel = document.getElementById('mg-properties');
    if (!panel) return;
    panel.classList.remove('hidden');

    const mg = state.motionGraphics[state.selectedMgIndex];
    if (!mg) return;

    const textEl = document.getElementById('mg-text');
    const subtextEl = document.getElementById('mg-subtext');
    const posEl = document.getElementById('mg-position');
    const durEl = document.getElementById('mg-duration');
    const durVal = document.getElementById('mg-duration-val');
    const typeEl = document.getElementById('mg-type');
    const styleEl = document.getElementById('mg-style');

    if (textEl) textEl.value = mg.text || '';
    if (subtextEl) subtextEl.value = mg.subtext || '';
    if (posEl) posEl.value = mg.position || 'center';
    if (durEl) durEl.value = mg.duration || 3;
    if (durVal) durVal.textContent = `${(mg.duration || 3).toFixed(1)}s`;
    if (typeEl) typeEl.value = mg.type || 'headline';
    if (styleEl) styleEl.value = mg.style || state.mgStyle || 'clean';
    _filterTypeDropdownByGroup(mg.type || 'headline');

    // Animation speed slider
    const animSpeedEl = document.getElementById('mg-anim-speed');
    const animSpeedVal = document.getElementById('mg-anim-speed-val');
    if (animSpeedEl) animSpeedEl.value = mg.animationSpeed || 1;
    if (animSpeedVal) animSpeedVal.textContent = `${(mg.animationSpeed || 1).toFixed(1)}x`;

    // Hide background dropdown for overlay MGs (only for fullscreen MG scenes)
    const mgBgRow = document.getElementById('mg-bg-row');
    if (mgBgRow) mgBgRow.style.display = 'none';

    // Show map style row only for mapChart
    const mapStyleRow = document.getElementById('mg-map-style-row');
    const mapStyleEl = document.getElementById('mg-map-style');
    if (mapStyleRow) mapStyleRow.style.display = mg.type === 'mapChart' ? '' : 'none';
    if (mapStyleEl && mg.type === 'mapChart') mapStyleEl.value = mg.mapStyle || 'dark';

    // Show explainer-specific controls
    _showExplainerControls(mg.type === 'explainer', mg);

    // Populate variant and animation dropdowns from registry
    _populateMgVariantDropdown(mg.type, mg.subType);
    _populateMgAnimationDropdown(mg.type, mg.animation);

    // Show listicle template controls if applicable
    _showListicleControls(mg.type, mg);
}

// Show MG properties panel for a V3 full-screen MG scene
function updateMgPropertiesForScene(scene) {
    const panel = document.getElementById('mg-properties');
    if (!panel) return;
    panel.classList.remove('hidden');

    const mg = scene.mgData || scene;
    const textEl = document.getElementById('mg-text');
    const subtextEl = document.getElementById('mg-subtext');
    const posEl = document.getElementById('mg-position');
    const durEl = document.getElementById('mg-duration');
    const durVal = document.getElementById('mg-duration-val');
    const typeEl = document.getElementById('mg-type');
    const styleEl = document.getElementById('mg-style');

    if (textEl) textEl.value = mg.text || scene.text || '';
    if (subtextEl) subtextEl.value = mg.subtext || scene.subtext || '';
    if (posEl) posEl.value = mg.position || scene.position || 'center';
    const dur = scene.endTime - scene.startTime;
    if (durEl) durEl.value = dur || 5;
    if (durVal) durVal.textContent = `${(dur || 5).toFixed(1)}s`;
    if (typeEl) typeEl.value = mg.type || scene.type || 'barChart';
    if (styleEl) styleEl.value = mg.style || scene.style || state.mgStyle || 'clean';
    _filterTypeDropdownByGroup(mg.type || scene.type || 'barChart');

    // Animation speed slider
    const animSpeedEl = document.getElementById('mg-anim-speed');
    const animSpeedVal = document.getElementById('mg-anim-speed-val');
    const animSpeed = mg.animationSpeed || scene.animationSpeed || 1;
    if (animSpeedEl) animSpeedEl.value = animSpeed;
    if (animSpeedVal) animSpeedVal.textContent = `${animSpeed.toFixed(1)}x`;

    // Show background dropdown for fullscreen MG scenes
    const mgBgRow = document.getElementById('mg-bg-row');
    const mgBgEl = document.getElementById('mg-background');
    if (mgBgRow) mgBgRow.style.display = '';
    if (mgBgEl) mgBgEl.value = mg.mgBackground || scene.mgBackground || 'none';

    // Show map style row only for mapChart
    const sceneType = mg.type || scene.type;
    const mapStyleRow = document.getElementById('mg-map-style-row');
    const mapStyleEl = document.getElementById('mg-map-style');
    if (mapStyleRow) mapStyleRow.style.display = sceneType === 'mapChart' ? '' : 'none';
    if (mapStyleEl && sceneType === 'mapChart') mapStyleEl.value = mg.mapStyle || scene.mapStyle || 'dark';

    // Show explainer-specific controls
    _showExplainerControls(sceneType === 'explainer', mg);

    // Populate variant and animation dropdowns from registry
    _populateMgVariantDropdown(sceneType, mg.subType || scene.subType);
    _populateMgAnimationDropdown(sceneType, mg.animation || scene.animation);

    // Show listicle template controls if applicable
    _showListicleControls(sceneType, mg);
}

/**
 * Populate the Map properties panel (#map-properties)
 */
function updateMapProperties(scene) {
    const panel = document.getElementById('map-properties');
    if (!panel) return;
    panel.classList.remove('hidden');

    const mg = scene.mgData || scene;

    // Map style
    const styleEl = document.getElementById('map-prop-style');
    if (styleEl) styleEl.value = mg.mapStyle || scene.mapStyle || 'satellite';

    // Variant
    const variantEl = document.getElementById('map-prop-variant');
    if (variantEl) variantEl.value = mg.mapVariant || scene.mapVariant || 'auto';

    // Title
    const titleEl = document.getElementById('map-prop-title');
    if (titleEl) titleEl.value = mg.text || scene.text || '';

    // Subtext (locations)
    const subtextEl = document.getElementById('map-prop-subtext');
    if (subtextEl) subtextEl.value = mg.subtext || scene.subtext || '';

    // Waypoints — format from _mapWaypoints array to string
    const wpEl = document.getElementById('map-prop-waypoints');
    if (wpEl) {
        const wps = mg._mapWaypoints || scene._mapWaypoints || [];
        const wpStr = wps.map(wp => {
            let s = `${wp.name} ${wp.startTime}-${wp.endTime}`;
            if (wp.zoom != null) s += ` z${wp.zoom}`;
            if (wp.tilt != null) s += ` t${wp.tilt}`;
            if (wp.bearing != null) s += ` b${wp.bearing}`;
            if (wp.orbit != null) s += ` o${wp.orbit}`;
            if (wp.icon) s += ` i${wp.icon}`;
            return s;
        }).join(', ');
        wpEl.value = wpStr;
    }

    // Zoom speed
    const zsEl = document.getElementById('map-prop-zoom-speed');
    const zsVal = document.getElementById('map-prop-zoom-speed-val');
    const zoomSpeed = mg._mapZoomSpeed || 1;
    if (zsEl) zsEl.value = zoomSpeed;
    if (zsVal) zsVal.textContent = `${zoomSpeed.toFixed(1)}x`;

    // Polygon speed
    const psEl = document.getElementById('map-prop-poly-speed');
    const psVal = document.getElementById('map-prop-poly-speed-val');
    const polySpeed = mg._mapPolySpeed || 1;
    if (psEl) psEl.value = polySpeed;
    if (psVal) psVal.textContent = `${polySpeed.toFixed(1)}x`;

    // Easing
    const easEl = document.getElementById('map-prop-easing');
    if (easEl) easEl.value = mg._mapEasing || 'cubic';

    // Poly color
    const pcEl = document.getElementById('map-prop-poly-color');
    if (pcEl) pcEl.value = mg._mapPolyColor || 'auto';

    // Tilt keyframes
    const tiltSEl = document.getElementById('map-prop-tilt-start');
    const tiltEEl = document.getElementById('map-prop-tilt-end');
    const tiltVal = document.getElementById('map-prop-tilt-val');
    const tiltS = mg._mapTiltKfStart ?? 0;
    const tiltE = mg._mapTiltKfEnd ?? 0.5;
    if (tiltSEl) tiltSEl.value = tiltS;
    if (tiltEEl) tiltEEl.value = tiltE;
    if (tiltVal) tiltVal.textContent = `${Math.round(tiltS * 100)}→${Math.round(tiltE * 100)}%`;

    // Zoom keyframes
    const zoomSEl = document.getElementById('map-prop-zoom-start');
    const zoomEEl = document.getElementById('map-prop-zoom-end');
    const zoomVal = document.getElementById('map-prop-zoom-val');
    const zoomS = mg._mapZoomKfStart ?? 0.8;
    const zoomE = mg._mapZoomKfEnd ?? 1.0;
    if (zoomSEl) zoomSEl.value = zoomS;
    if (zoomEEl) zoomEEl.value = zoomE;
    if (zoomVal) zoomVal.textContent = `${zoomS.toFixed(1)}→${zoomE.toFixed(1)}`;

    // Cinematic
    const cinEl = document.getElementById('map-prop-cinematic');
    if (cinEl) cinEl.checked = !!mg._mapCinematic;
}

function _initMapPropertiesListeners() {
    const _getMapScene = () => {
        if (state.selectedClipIndex < 0) return null;
        const scene = state.scenes[state.selectedClipIndex];
        return (scene && scene.type === 'mapChart') ? scene : null;
    };
    const _setMgProp = (key, val) => {
        const scene = _getMapScene();
        if (!scene) return;
        if (scene.mgData) scene.mgData[key] = val;
        scene[key] = val;
        triggerAutoSave(); refreshCompositorMGs();
    };

    document.getElementById('map-prop-style')?.addEventListener('change', e => {
        _setMgProp('mapStyle', e.target.value);
    });
    document.getElementById('map-prop-variant')?.addEventListener('change', e => {
        _setMgProp('mapVariant', e.target.value);
    });
    document.getElementById('map-prop-title')?.addEventListener('input', e => {
        const scene = _getMapScene(); if (!scene) return;
        scene.text = e.target.value;
        if (scene.mgData) scene.mgData.text = e.target.value;
        triggerAutoSave(); refreshCompositorMGs();
    });
    document.getElementById('map-prop-subtext')?.addEventListener('input', e => {
        const scene = _getMapScene(); if (!scene) return;
        scene.subtext = e.target.value;
        if (scene.mgData) scene.mgData.subtext = e.target.value;
        triggerAutoSave(); refreshCompositorMGs();
    });
    document.getElementById('map-prop-zoom-speed')?.addEventListener('input', e => {
        const val = parseFloat(e.target.value);
        _setMgProp('_mapZoomSpeed', val);
        const valEl = document.getElementById('map-prop-zoom-speed-val');
        if (valEl) valEl.textContent = `${val.toFixed(1)}x`;
    });
    document.getElementById('map-prop-poly-speed')?.addEventListener('input', e => {
        const val = parseFloat(e.target.value);
        _setMgProp('_mapPolySpeed', val);
        const valEl = document.getElementById('map-prop-poly-speed-val');
        if (valEl) valEl.textContent = `${val.toFixed(1)}x`;
    });
    document.getElementById('map-prop-easing')?.addEventListener('change', e => {
        _setMgProp('_mapEasing', e.target.value);
    });
    document.getElementById('map-prop-poly-color')?.addEventListener('change', e => {
        _setMgProp('_mapPolyColor', e.target.value);
    });
    // Tilt keyframes
    const tiltHandler = () => {
        const s = parseFloat(document.getElementById('map-prop-tilt-start')?.value || 0);
        const e = parseFloat(document.getElementById('map-prop-tilt-end')?.value || 0.5);
        _setMgProp('_mapTiltKfStart', s);
        _setMgProp('_mapTiltKfEnd', e);
        const valEl = document.getElementById('map-prop-tilt-val');
        if (valEl) valEl.textContent = `${Math.round(s * 100)}→${Math.round(e * 100)}%`;
    };
    document.getElementById('map-prop-tilt-start')?.addEventListener('input', tiltHandler);
    document.getElementById('map-prop-tilt-end')?.addEventListener('input', tiltHandler);
    // Zoom keyframes
    const zoomHandler = () => {
        const s = parseFloat(document.getElementById('map-prop-zoom-start')?.value || 0.8);
        const e = parseFloat(document.getElementById('map-prop-zoom-end')?.value || 1.0);
        _setMgProp('_mapZoomKfStart', s);
        _setMgProp('_mapZoomKfEnd', e);
        const valEl = document.getElementById('map-prop-zoom-val');
        if (valEl) valEl.textContent = `${s.toFixed(1)}→${e.toFixed(1)}`;
    };
    document.getElementById('map-prop-zoom-start')?.addEventListener('input', zoomHandler);
    document.getElementById('map-prop-zoom-end')?.addEventListener('input', zoomHandler);
    // Cinematic
    document.getElementById('map-prop-cinematic')?.addEventListener('change', e => {
        _setMgProp('_mapCinematic', e.target.checked);
    });
    // Waypoints text field — parse on blur
    document.getElementById('map-prop-waypoints')?.addEventListener('change', e => {
        const scene = _getMapScene(); if (!scene) return;
        const text = e.target.value;
        // Parse waypoint format: "Name start-end z<zoom> t<tilt> b<bearing> o<orbit>"
        const wpRegex = /^(.+?)\s+(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(.*)$/;
        const entries = text.split(',').map(s => s.trim()).filter(Boolean);
        const waypoints = [];
        for (const entry of entries) {
            const m = entry.match(wpRegex);
            if (!m) continue;
            const extras = m[4] || '';
            const zM = extras.match(/z(\d+(?:\.\d+)?)/);
            const tM = extras.match(/t(\d+(?:\.\d+)?)/);
            const bM = extras.match(/b(-?\d+(?:\.\d+)?)/);
            const oM = extras.match(/o(-?\d+(?:\.\d+)?)/);
            const iM = extras.match(/i([a-zA-Z][a-zA-Z0-9 _-]*)/);
            let icon = null;
            if (iM) { const raw = iM[1].trim(); if (raw.length >= 2 && !['sz','c'].includes(raw)) icon = raw; }
            waypoints.push({
                name: m[1].trim(),
                startTime: parseFloat(m[2]),
                endTime: parseFloat(m[3]),
                zoom: zM ? parseFloat(zM[1]) : null,
                tilt: tM ? parseFloat(tM[1]) : null,
                bearing: bM ? parseFloat(bM[1]) : null,
                orbit: oM ? parseFloat(oM[1]) : null,
                icon: icon,
            });
        }
        if (waypoints.length > 0) {
            _setMgProp('_mapWaypoints', waypoints);
        }
    });
}

/**
 * Populate the dedicated Listicle Items properties panel (#listicle-properties)
 */
function updateListicleProperties(mg) {
    const panel = document.getElementById('listicle-properties');
    if (!panel) return;
    panel.classList.remove('hidden');

    const mgType = mg.type || 'listicleCounter';

    // Type dropdown
    const typeEl = document.getElementById('li-type');
    if (typeEl) typeEl.value = mgType;

    // Template dropdown — populate variants from registry
    const templateSel = document.getElementById('li-template');
    if (templateSel && window._mgRegistry) {
        const types = window._mgRegistry.getTypesForCategory(mgType);
        templateSel.innerHTML = '';
        for (const t of types) {
            const opt = document.createElement('option');
            opt.value = t.key;
            opt.textContent = t.label;
            templateSel.appendChild(opt);
        }
        templateSel.value = mg.subType || window._mgRegistry.registry[mgType]?.defaultType || '';
    }

    // Animation dropdown — populate from registry
    const animSel = document.getElementById('li-animation');
    if (animSel && window._mgRegistry) {
        const anims = window._mgRegistry.getAnimationsForCategory(mgType);
        animSel.innerHTML = '';
        for (const a of anims) {
            const opt = document.createElement('option');
            opt.value = a;
            opt.textContent = a.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
            animSel.appendChild(opt);
        }
        animSel.value = mg.animation || anims[0] || '';
    }

    // Number field — show for counter/tracker, hide for grid
    const numberRow = document.getElementById('li-number-row');
    if (numberRow) numberRow.style.display = mgType === 'listicleGrid' ? 'none' : '';
    const numberEl = document.getElementById('li-number');
    if (numberEl) numberEl.value = mg.text || '';

    // Title field — show for counter, hide for tracker/grid
    const titleRow = document.getElementById('li-title-row');
    if (titleRow) titleRow.style.display = mgType === 'listicleCounter' ? '' : 'none';
    const titleEl = document.getElementById('li-title');
    if (titleEl) titleEl.value = mg.subtext || '';

    // Style
    const styleSel2 = document.getElementById('li-style');
    if (styleSel2) styleSel2.value = mg.style || 'clean';

    // Position
    const posEl = document.getElementById('li-position');
    if (posEl) posEl.value = mg.position || 'bottomLeft';

    // Duration
    const durEl = document.getElementById('li-duration');
    const durVal = document.getElementById('li-duration-val');
    const dur = mg.duration || 4;
    if (durEl) durEl.value = dur;
    if (durVal) durVal.textContent = `${dur.toFixed(1)}s`;

    // Scale
    const scaleEl = document.getElementById('li-scale');
    const scaleValEl = document.getElementById('li-scale-val');
    const scaleV = mg.scale || 1.3;
    if (scaleEl) scaleEl.value = scaleV;
    if (scaleValEl) scaleValEl.textContent = `${scaleV.toFixed(1)}x`;

    // Animation speed
    const animSpeedEl = document.getElementById('li-anim-speed');
    const animSpeedVal = document.getElementById('li-anim-speed-val');
    const speed = mg.animationSpeed || 1;
    if (animSpeedEl) animSpeedEl.value = speed;
    if (animSpeedVal) animSpeedVal.textContent = `${speed.toFixed(1)}x`;
}

function setupClipPropertyListeners() {
    // Capture undo state once when user starts dragging any property slider
    const propSliders = [elements.propScale, elements.propPosX, elements.propPosY, elements.propVolume,
    elements.propCropTop, elements.propCropBottom, elements.propCropLeft, elements.propCropRight, elements.propBorderRadius];
    propSliders.forEach(slider => {
        if (slider) {
            slider.addEventListener('pointerdown', () => {
                if (state.selectedClipIndex >= 0) pushUndoState();
            });
        }
    });

    if (elements.propScale) {
        elements.propScale.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseFloat(e.target.value);
            state.scenes[state.selectedClipIndex].scale = val;
            if (elements.propScaleVal) elements.propScaleVal.value = val.toFixed(2);
            applySceneTransform(state.selectedClipIndex);
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    if (elements.propPosX) {
        elements.propPosX.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseInt(e.target.value);
            state.scenes[state.selectedClipIndex].posX = val;
            if (elements.propPosXVal) elements.propPosXVal.value = `${val}%`;
            applySceneTransform(state.selectedClipIndex);
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    if (elements.propPosY) {
        elements.propPosY.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseInt(e.target.value);
            state.scenes[state.selectedClipIndex].posY = val;
            if (elements.propPosYVal) elements.propPosYVal.value = `${val}%`;
            applySceneTransform(state.selectedClipIndex);
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    if (elements.propVolume) {
        elements.propVolume.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseFloat(e.target.value);
            state.scenes[state.selectedClipIndex].volume = val;
            if (elements.propVolumeVal) elements.propVolumeVal.value = `${Math.round(val * 100)}%`;
            applyTrackVolumes();
        });
    }
    // Crop sliders
    ['cropTop', 'cropBottom', 'cropLeft', 'cropRight'].forEach(prop => {
        const capProp = prop.charAt(0).toUpperCase() + prop.slice(1);
        const slider = elements[`propCrop${capProp.replace('crop', '').replace('Crop', '')}`] || elements[`prop${capProp}`];
        const valEl = elements[`propCrop${capProp.replace('crop', '').replace('Crop', '')}Val`] || elements[`prop${capProp}Val`];
        // Use direct element references
        const elMap = { cropTop: 'propCropTop', cropBottom: 'propCropBottom', cropLeft: 'propCropLeft', cropRight: 'propCropRight' };
        const valMap = { cropTop: 'propCropTopVal', cropBottom: 'propCropBottomVal', cropLeft: 'propCropLeftVal', cropRight: 'propCropRightVal' };
        const sl = elements[elMap[prop]];
        const vl = elements[valMap[prop]];
        if (sl) {
            sl.addEventListener('input', (e) => {
                if (state.selectedClipIndex < 0) return;
                const val = parseInt(e.target.value);
                state.scenes[state.selectedClipIndex][prop] = val;
                if (vl) vl.value = `${val}%`;
                applySceneTransform(state.selectedClipIndex);
                refreshCompositorScene(state.selectedClipIndex);
            });
        }
    });
    // Border radius slider
    if (elements.propBorderRadius) {
        elements.propBorderRadius.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseInt(e.target.value);
            state.scenes[state.selectedClipIndex].borderRadius = val;
            if (elements.propBorderRadiusVal) elements.propBorderRadiusVal.value = `${val}%`;
            applySceneTransform(state.selectedClipIndex);
            refreshCompositorScene(state.selectedClipIndex);
        });
    }

    // Editable value inputs — commit on Enter or blur
    function setupValueInput(inputEl, sliderEl, { parse, format, apply }) {
        if (!inputEl) return;
        const commit = () => {
            if (state.selectedClipIndex < 0) return;
            const raw = inputEl.value.replace(/%/g, '').trim();
            let val = parse(raw);
            if (isNaN(val)) return;
            // Clamp to slider range
            const min = parseFloat(sliderEl?.min ?? -Infinity);
            const max = parseFloat(sliderEl?.max ?? Infinity);
            val = Math.min(max, Math.max(min, val));
            pushUndoState();
            if (sliderEl) sliderEl.value = val;
            inputEl.value = format(val);
            apply(val);
        };
        inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); inputEl.blur(); }
            if (e.key === 'Escape') { inputEl.blur(); }
        });
        inputEl.addEventListener('blur', commit);
        // Select all on focus for easy overwrite
        inputEl.addEventListener('focus', () => inputEl.select());
    }

    setupValueInput(elements.propScaleVal, elements.propScale, {
        parse: parseFloat,
        format: v => v.toFixed(2),
        apply: v => { state.scenes[state.selectedClipIndex].scale = v; applySceneTransform(state.selectedClipIndex); refreshCompositorScene(state.selectedClipIndex); }
    });
    setupValueInput(elements.propPosXVal, elements.propPosX, {
        parse: parseInt,
        format: v => `${v}%`,
        apply: v => { state.scenes[state.selectedClipIndex].posX = v; applySceneTransform(state.selectedClipIndex); refreshCompositorScene(state.selectedClipIndex); }
    });
    setupValueInput(elements.propPosYVal, elements.propPosY, {
        parse: parseInt,
        format: v => `${v}%`,
        apply: v => { state.scenes[state.selectedClipIndex].posY = v; applySceneTransform(state.selectedClipIndex); refreshCompositorScene(state.selectedClipIndex); }
    });
    setupValueInput(elements.propVolumeVal, elements.propVolume, {
        parse: v => parseFloat(v) / 100,
        format: v => `${Math.round(v * 100)}%`,
        apply: v => { state.scenes[state.selectedClipIndex].volume = v; applyTrackVolumes(); }
    });
    ['cropTop', 'cropBottom', 'cropLeft', 'cropRight'].forEach(prop => {
        const elMap = { cropTop: 'propCropTop', cropBottom: 'propCropBottom', cropLeft: 'propCropLeft', cropRight: 'propCropRight' };
        const valMap = { cropTop: 'propCropTopVal', cropBottom: 'propCropBottomVal', cropLeft: 'propCropLeftVal', cropRight: 'propCropRightVal' };
        setupValueInput(elements[valMap[prop]], elements[elMap[prop]], {
            parse: parseInt,
            format: v => `${v}%`,
            apply: v => { state.scenes[state.selectedClipIndex][prop] = v; applySceneTransform(state.selectedClipIndex); refreshCompositorScene(state.selectedClipIndex); }
        });
    });
    setupValueInput(elements.propBorderRadiusVal, elements.propBorderRadius, {
        parse: parseInt,
        format: v => `${v}%`,
        apply: v => { state.scenes[state.selectedClipIndex].borderRadius = v; applySceneTransform(state.selectedClipIndex); refreshCompositorScene(state.selectedClipIndex); }
    });

    // ── Floating frame controls ──
    if (elements.propFraming) {
        elements.propFraming.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            const scene = state.scenes[state.selectedClipIndex];
            const newFraming = e.target.value;
            scene.framing = newFraming;
            if (newFraming === 'floating') {
                // Apply floating defaults if switching to floating
                if (!scene.shadow && scene.shadow !== 0) scene.shadow = 0.5;
                scene.floatingAnim = scene.floatingAnim || 'slideRight';
                scene.floatingAnimDuration = scene.floatingAnimDuration || 0.6;
                scene.borderRadius = scene.borderRadius || 4;
                if (!scene.background || scene.background === 'none') scene.background = 'blur';
                // Scale down for floating look
                if (scene.scale > 0.7) scene.scale = 0.6;
            } else if (newFraming === 'fullscreen') {
                scene.shadow = 0;
                scene.borderRadius = 0;
                scene.scale = 1;
                scene.background = 'none';
            }
            updateClipProperties();
            applySceneTransform(state.selectedClipIndex);
            refreshCompositorScene(state.selectedClipIndex);
            loadActiveScenes();
        });
    }
    if (elements.propShadow) {
        elements.propShadow.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseFloat(e.target.value);
            state.scenes[state.selectedClipIndex].shadow = val;
            if (elements.propShadowVal) elements.propShadowVal.value = val.toFixed(2);
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    setupValueInput(elements.propShadowVal, elements.propShadow, {
        parse: parseFloat,
        format: v => v.toFixed(2),
        apply: v => { state.scenes[state.selectedClipIndex].shadow = v; refreshCompositorScene(state.selectedClipIndex); }
    });
    if (elements.propFloatingAnim) {
        elements.propFloatingAnim.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            state.scenes[state.selectedClipIndex].floatingAnim = e.target.value;
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    if (elements.propFloatingAnimDur) {
        elements.propFloatingAnimDur.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseFloat(e.target.value);
            state.scenes[state.selectedClipIndex].floatingAnimDuration = val;
            if (elements.propFloatingAnimDurVal) elements.propFloatingAnimDurVal.value = val.toFixed(2) + 's';
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    setupValueInput(elements.propFloatingAnimDurVal, elements.propFloatingAnimDur, {
        parse: v => parseFloat(v.replace('s', '')),
        format: v => v.toFixed(2) + 's',
        apply: v => { state.scenes[state.selectedClipIndex].floatingAnimDuration = v; refreshCompositorScene(state.selectedClipIndex); }
    });
    if (elements.propReset) {
        elements.propReset.addEventListener('click', () => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            const scene = state.scenes[state.selectedClipIndex];
            scene.scale = 1;
            scene.posX = 0;
            scene.posY = 0;
            scene.volume = 1;
            scene.background = 'none';
            scene.fitMode = 'cover';
            scene.cropTop = 0;
            scene.cropBottom = 0;
            scene.cropLeft = 0;
            scene.cropRight = 0;
            scene.borderRadius = 0;
            scene.framing = 'fullscreen';
            scene.shadow = 0;
            scene.floatingAnim = 'slideRight';
            scene.floatingAnimDuration = 0.6;
            updateClipProperties();
            applySceneTransform(state.selectedClipIndex);
            applyTrackVolumes();
            refreshCompositorScene(state.selectedClipIndex);
            loadActiveScenes();
        });
    }
    // Fill Frame button — calculates exact scale to cover the frame given current crop values
    if (elements.btnFillFrame) {
        elements.btnFillFrame.addEventListener('click', () => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            const scene = state.scenes[state.selectedClipIndex];
            const cropT = scene.cropTop    || 0;
            const cropB = scene.cropBottom || 0;
            const cropL = scene.cropLeft   || 0;
            const cropR = scene.cropRight  || 0;
            // Compute scale to fill frame after crop
            const scaleH = (cropL + cropR) > 0 ? 100 / (100 - cropL - cropR) : 1;
            const scaleV = (cropT + cropB) > 0 ? 100 / (100 - cropT - cropB) : 1;
            const fillScale = Math.round(Math.max(scaleH, scaleV) * 100) / 100;
            scene.scale = Math.max(fillScale, 1);
            scene.fitMode = 'cover';
            // Position offset to center visible area (asymmetric crops need translate)
            scene.posX = parseFloat((scene.scale * (cropR - cropL) / 2).toFixed(2));
            scene.posY = parseFloat((scene.scale * (cropB - cropT) / 2).toFixed(2));
            if (elements.propScale)    elements.propScale.value = scene.scale;
            if (elements.propScaleVal) elements.propScaleVal.value = scene.scale.toFixed(2);
            if (elements.propFitMode)  elements.propFitMode.value = 'cover';
            if (elements.propPosX)     elements.propPosX.value = scene.posX;
            if (elements.propPosXVal)  elements.propPosXVal.value = `${scene.posX}%`;
            if (elements.propPosY)     elements.propPosY.value = scene.posY;
            if (elements.propPosYVal)  elements.propPosYVal.value = `${scene.posY}%`;
            applySceneTransform(state.selectedClipIndex);
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    // Background dropdown
    if (elements.propBackground) {
        elements.propBackground.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            state.scenes[state.selectedClipIndex].background = e.target.value;
            refreshCompositorScene(state.selectedClipIndex);
            loadActiveScenes();
        });
    }
    // Fit mode dropdown
    if (elements.propFitMode) {
        elements.propFitMode.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            const scene = state.scenes[state.selectedClipIndex];
            scene.fitMode = e.target.value;
            // If switching to contain without a background, auto-set blur
            if (e.target.value === 'contain' && (!scene.background || scene.background === 'none')) {
                scene.background = 'blur';
                if (elements.propBackground) elements.propBackground.value = 'blur';
            }
            refreshCompositorScene(state.selectedClipIndex);
            loadActiveScenes();
        });
    }
    // V2 overlay: Slide direction
    const slideDirEl = document.getElementById('prop-slide-dir');
    if (slideDirEl) {
        slideDirEl.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            state.scenes[state.selectedClipIndex].slideDirection = e.target.value;
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    // V2 overlay: Slide speed/duration
    const slideSpeedEl = document.getElementById('prop-slide-speed');
    if (slideSpeedEl) {
        slideSpeedEl.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const val = parseFloat(e.target.value);
            state.scenes[state.selectedClipIndex].slideDuration = val;
            const valEl = document.getElementById('prop-slide-speed-val');
            if (valEl) valEl.textContent = `${val}s`;
            refreshCompositorScene(state.selectedClipIndex);
        });
    }
    // V2 overlay: Background blur on video
    const bgBlurEl = document.getElementById('prop-bg-blur');
    if (bgBlurEl) {
        bgBlurEl.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            state.scenes[state.selectedClipIndex].bgBlur = e.target.value;
            refreshCompositorScene(state.selectedClipIndex);
            loadActiveScenes();
        });
    }
    // Animate checkbox
    if (elements.propAnimate) {
        elements.propAnimate.addEventListener('change', (e) => {
            if (state.selectedClipIndex < 0) return;
            pushUndoState();
            state.scenes[state.selectedClipIndex].kenBurnsEnabled = e.target.checked;
            // Show/hide speed slider
            if (elements.propKbSpeedRow) {
                elements.propKbSpeedRow.style.display = e.target.checked ? '' : 'none';
            }
            refreshCompositorScene(state.selectedClipIndex);
            loadActiveScenes();
        });
    }
    // Ken Burns speed slider
    if (elements.propKbSpeed) {
        elements.propKbSpeed.addEventListener('input', (e) => {
            if (state.selectedClipIndex < 0) return;
            const speed = parseFloat(e.target.value) || 1;
            state.scenes[state.selectedClipIndex].kenBurnsSpeed = speed;
            if (elements.propKbSpeedVal) {
                elements.propKbSpeedVal.textContent = speed.toFixed(1) + 'x';
            }
            refreshCompositorScene(state.selectedClipIndex);
            loadActiveScenes();
        });
        elements.propKbSpeed.addEventListener('change', (e) => {
            pushUndoState();
        });
    }
}

/**
 * Populate the Background dropdown with available pattern files from assets/backgrounds/
 */
/**
 * Preload template media (video/image) into a shared cache so MGRenderer
 * can use it immediately without a loading flash.
 */
const _preloadedTemplateMedia = {};
function _preloadTemplateMedia(file, url, offset) {
    if (_preloadedTemplateMedia[file]) return;
    _preloadedTemplateMedia[file] = true;
    const isVideo = /\.(mp4|webm|mov|mkv)$/i.test(file);
    if (isVideo) {
        const video = document.createElement('video');
        video.crossOrigin = 'anonymous';
        video.muted = true;
        video.playsInline = true;
        video.preload = 'auto';
        video.style.display = 'none';
        document.body.appendChild(video);
        video.onloadeddata = () => {
            // Seek to the offset so the first frame is ready
            if (offset > 0 && video.duration > offset) {
                video.currentTime = offset;
            }
            // Inject into MGRenderer's cache if available
            if (state.compositor?.mgRenderer) {
                const mgr = state.compositor.mgRenderer;
                if (!mgr._templateMedia) mgr._templateMedia = {};
                if (!mgr._templateMedia[file]) {
                    mgr._templateMedia[file] = video;
                    console.log(`[Preload] Template media ready: ${file.split(/[/\\]/).pop()}`);
                }
            }
        };
        video.onerror = () => {
            delete _preloadedTemplateMedia[file];
            if (video.parentNode) video.parentNode.removeChild(video);
        };
        video.src = url;
    } else {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            if (state.compositor?.mgRenderer) {
                const mgr = state.compositor.mgRenderer;
                if (!mgr._templateMedia) mgr._templateMedia = {};
                if (!mgr._templateMedia[file]) {
                    mgr._templateMedia[file] = img;
                    console.log(`[Preload] Template media ready: ${file.split(/[/\\]/).pop()}`);
                }
            }
        };
        img.onerror = () => { delete _preloadedTemplateMedia[file]; };
        img.src = url;
    }
}

function populateBackgroundDropdown() {
    const sel = elements.propBackground;
    if (!sel) return;
    // Keep the first two built-in options (None, Blur)
    while (sel.options.length > 2) sel.remove(2);
    // Add built-in gradient backgrounds
    if (Object.keys(GRADIENT_BACKGROUNDS).length > 0) {
        const grp = document.createElement('optgroup');
        grp.label = 'Gradients';
        for (const [id, css] of Object.entries(GRADIENT_BACKGROUNDS)) {
            const opt = document.createElement('option');
            opt.value = `gradient:${id}`;
            opt.textContent = GRADIENT_BACKGROUND_NAMES[id] || id;
            grp.appendChild(opt);
        }
        sel.appendChild(grp);
    }
    // Add pattern files from assets/backgrounds/ — filtered by active theme
    if (state.availableBackgrounds.length > 0) {
        const activeTheme = _resolveActiveTheme();
        // Show only backgrounds matching the current theme (or universal ones with no theme tag)
        const filtered = state.availableBackgrounds.filter(bg => {
            if (!bg.theme) return true;          // universal — always show
            if (!activeTheme) return true;       // no theme resolved — show all
            return bg.theme === activeTheme;     // theme-specific — must match
        });
        if (filtered.length > 0) {
            const grp = document.createElement('optgroup');
            grp.label = activeTheme ? `Custom (${activeTheme})` : 'Custom Files';
            for (const bg of filtered) {
                const opt = document.createElement('option');
                opt.value = `pattern:${bg.filename}`;
                const icon = bg.mediaType === 'video' ? '🎬' : '🖼️';
                opt.textContent = `${icon} ${bg.name}`;
                grp.appendChild(opt);
            }
            sel.appendChild(grp);
        }
    }
}

function setupMgPropertyListeners() {
    const textEl = document.getElementById('mg-text');
    const subtextEl = document.getElementById('mg-subtext');
    const posEl = document.getElementById('mg-position');
    const durEl = document.getElementById('mg-duration');
    const typeEl = document.getElementById('mg-type');
    const styleEl = document.getElementById('mg-style');

    // Helper: get the MG object being edited (overlay MG or V3 fullscreen MG scene)
    function getActiveMG() {
        if (state.selectedMgIndex >= 0 && state.motionGraphics[state.selectedMgIndex]) {
            return { mg: state.motionGraphics[state.selectedMgIndex], isScene: false };
        }
        if (state._selectedMgScene) {
            return { mg: state._selectedMgScene, isScene: true };
        }
        return null;
    }

    if (textEl) {
        textEl.addEventListener('input', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.text = e.target.value;
            if (active.mg.mgData) active.mg.mgData.text = e.target.value;
            renderTracks();
            refreshCompositorMGs();
        });
    }
    if (subtextEl) {
        subtextEl.addEventListener('input', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.subtext = e.target.value;
            if (active.mg.mgData) active.mg.mgData.subtext = e.target.value;
            refreshCompositorMGs();
        });
    }
    if (posEl) {
        posEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.position = e.target.value;
            if (active.mg.mgData) active.mg.mgData.position = e.target.value;
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
        });
    }
    if (durEl) {
        durEl.addEventListener('input', (e) => {
            const active = getActiveMG();
            if (!active) return;
            const val = parseFloat(e.target.value);
            active.mg.duration = val;
            if (active.mg.mgData) active.mg.mgData.duration = val;
            if (active.isScene) {
                active.mg.endTime = active.mg.startTime + val;
            }
            document.getElementById('mg-duration-val').textContent = `${val.toFixed(1)}s`;
            renderTracks();
            refreshCompositorMGs();
        });
    }
    if (typeEl) {
        typeEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.type = e.target.value;
            if (active.mg.mgData) active.mg.mgData.type = e.target.value;
            // Reset subType/animation when type changes
            delete active.mg.subType;
            delete active.mg.animation;
            delete active.mg.variantManual;
            delete active.mg.animationManual;
            if (active.mg.mgData) { delete active.mg.mgData.subType; delete active.mg.mgData.animation; }
            if (active.mg.mgData) { delete active.mg.mgData.variantManual; delete active.mg.mgData.animationManual; }
            // Refresh variant/animation dropdowns for new type
            _populateMgVariantDropdown(e.target.value, null);
            _populateMgAnimationDropdown(e.target.value, null);
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            renderTracks();
            refreshCompositorMGs();
        });
    }

    // Variant (subType) dropdown
    const subTypeEl = document.getElementById('mg-subtype');
    if (subTypeEl) {
        subTypeEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            _setMgField(active, 'subType', e.target.value);
            _setMgField(active, 'variantManual', true);
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
        });
    }

    // Animation profile dropdown
    const animEl = document.getElementById('mg-animation');
    if (animEl) {
        animEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            _setMgField(active, 'animation', e.target.value);
            _setMgField(active, 'animationManual', true);
            refreshCompositorMGs();
        });
    }
    if (styleEl) {
        styleEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            _applyManualMgStyle(active, e.target.value);
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
        });
    }

    // Map style dropdown (only for mapChart type)
    const mapStyleEl = document.getElementById('mg-map-style');
    if (mapStyleEl) {
        mapStyleEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.mapStyle = e.target.value;
            if (active.mg.mgData) active.mg.mgData.mapStyle = e.target.value;
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
        });
    }

    // Show/hide map style row + explainer + listicle controls when type changes
    if (typeEl) {
        typeEl.addEventListener('change', () => {
            const mapStyleRow = document.getElementById('mg-map-style-row');
            if (mapStyleRow) mapStyleRow.style.display = typeEl.value === 'mapChart' ? '' : 'none';
            _showExplainerControls(typeEl.value === 'explainer', null);
            const active = getActiveMG();
            _showListicleControls(typeEl.value, active?.mg || null);
        });
    }

    // Explainer-specific property listeners
    const explScaleEl = document.getElementById('mg-explainer-img-scale');
    if (explScaleEl) {
        explScaleEl.addEventListener('input', (e) => {
            const val = parseInt(e.target.value);
            document.getElementById('mg-explainer-img-scale-val').textContent = val + '%';
            const active = getActiveMG();
            if (!active) return;
            active.mg.explainerImgScale = val;
            if (active.mg.mgData) active.mg.mgData.explainerImgScale = val;
            refreshCompositorMGs();
        });
    }
    const explShadowEl = document.getElementById('mg-explainer-shadow');
    if (explShadowEl) {
        explShadowEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.explainerShadow = e.target.value;
            if (active.mg.mgData) active.mg.mgData.explainerShadow = e.target.value;
            refreshCompositorMGs();
        });
    }

    // MG Background dropdown — populate gradient options and listen for changes
    const mgBgEl = document.getElementById('mg-background');
    if (mgBgEl) {
        // Add gradient options from the built-in library
        if (Object.keys(GRADIENT_BACKGROUNDS).length > 0) {
            const grp = document.createElement('optgroup');
            grp.label = 'Gradients';
            for (const [id] of Object.entries(GRADIENT_BACKGROUNDS)) {
                const opt = document.createElement('option');
                opt.value = `gradient:${id}`;
                opt.textContent = GRADIENT_BACKGROUND_NAMES[id] || id;
                grp.appendChild(opt);
            }
            mgBgEl.appendChild(grp);
        }
        mgBgEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.mgBackground = e.target.value;
            if (active.mg.mgData) active.mg.mgData.mgBackground = e.target.value;
            refreshCompositorMGs();
        });
    }

    // Animation speed slider
    const animSpeedEl = document.getElementById('mg-anim-speed');
    if (animSpeedEl) {
        animSpeedEl.addEventListener('input', (e) => {
            const active = getActiveMG();
            if (!active) return;
            const val = parseFloat(e.target.value);
            active.mg.animationSpeed = val;
            if (active.mg.mgData) active.mg.mgData.animationSpeed = val;
            document.getElementById('mg-anim-speed-val').textContent = `${val.toFixed(1)}x`;
            refreshCompositorMGs();
        });
    }

    // ── Listicle Template Listeners ──
    const listicleTemplateSel = document.getElementById('mg-listicle-template');
    if (listicleTemplateSel) {
        listicleTemplateSel.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            _setMgField(active, 'subType', e.target.value);
            _setMgField(active, 'variantManual', true);
            // Also update the main variant dropdown if visible
            const subTypeEl = document.getElementById('mg-subtype');
            if (subTypeEl) subTypeEl.value = e.target.value;
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
        });
    }

    const listicleAnimSel = document.getElementById('mg-listicle-anim');
    if (listicleAnimSel) {
        listicleAnimSel.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            _setMgField(active, 'animation', e.target.value);
            _setMgField(active, 'animationManual', true);
            refreshCompositorMGs();
        });
    }

    const listicleNumberEl = document.getElementById('mg-listicle-number');
    if (listicleNumberEl) {
        listicleNumberEl.addEventListener('input', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.text = e.target.value;
            if (active.mg.mgData) active.mg.mgData.text = e.target.value;
            // Sync with main text field
            const textEl = document.getElementById('mg-text');
            if (textEl) textEl.value = e.target.value;
            refreshCompositorMGs();
        });
    }

    const listicleItemsEl = document.getElementById('mg-listicle-items');
    if (listicleItemsEl) {
        listicleItemsEl.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg._maxVisibleItems = parseInt(e.target.value) || 5;
            if (active.mg.mgData) active.mg.mgData._maxVisibleItems = parseInt(e.target.value) || 5;
            if (active.isScene) loadActiveScenes();
            refreshCompositorMGs();
        });
    }

    const listicleBgSel = document.getElementById('mg-listicle-bg');
    if (listicleBgSel) {
        listicleBgSel.addEventListener('change', (e) => {
            const active = getActiveMG();
            if (!active) return;
            active.mg.mgBackground = e.target.value === 'auto' ? undefined : e.target.value;
            if (active.mg.mgData) active.mg.mgData.mgBackground = e.target.value === 'auto' ? undefined : e.target.value;
            refreshCompositorMGs();
        });
    }
}

/**
 * Setup event listeners for the dedicated Listicle Items properties panel (#listicle-properties)
 */
function setupListiclePropertyListeners() {
    // Helper: get the active listicle MG (overlay or fullscreen scene)
    function getActiveListicleMG() {
        if (state.selectedMgIndex >= 0 && state.motionGraphics[state.selectedMgIndex]) {
            const mg = state.motionGraphics[state.selectedMgIndex];
            return { mg, isScene: false };
        }
        if (state._selectedMgScene) {
            const mgData = state._selectedMgScene.mgData || state._selectedMgScene;
            return { mg: mgData, isScene: true, scene: state._selectedMgScene };
        }
        return null;
    }

    // Type change — switch between counter/tracker/grid
    const typeEl = document.getElementById('li-type');
    if (typeEl) {
        typeEl.addEventListener('change', (e) => {
            const active = getActiveListicleMG();
            if (!active) return;
            pushUndoState();
            active.mg.type = e.target.value;
            if (active.isScene && active.scene) active.scene.type = e.target.value;
            // Re-populate template/animation dropdowns for new type
            updateListicleProperties(active.mg);
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
            renderTimeline();
        });
    }

    // Template (variant) change
    const templateSel = document.getElementById('li-template');
    if (templateSel) {
        templateSel.addEventListener('change', (e) => {
            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.subType = e.target.value;
            if (active.mg.mgData) active.mg.mgData.subType = e.target.value;
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
        });
    }

    // Style change
    const styleSel = document.getElementById('li-style');
    if (styleSel) {
        styleSel.addEventListener('change', (e) => {
            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.style = e.target.value;
            if (active.mg.mgData) active.mg.mgData.style = e.target.value;
            refreshCompositorMGs();
        });
    }

    // Animation change
    const animSel = document.getElementById('li-animation');
    if (animSel) {
        animSel.addEventListener('change', (e) => {
            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.animation = e.target.value;
            if (active.mg.mgData) active.mg.mgData.animation = e.target.value;
            refreshCompositorMGs();
        });
    }

    // Number field (text for counter/tracker)
    const numberEl = document.getElementById('li-number');
    if (numberEl) {
        numberEl.addEventListener('input', (e) => {
            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.text = e.target.value;
            if (active.mg.mgData) active.mg.mgData.text = e.target.value;
            refreshCompositorMGs();
        });
    }

    // Title field (subtext for counter)
    const titleEl = document.getElementById('li-title');
    if (titleEl) {
        titleEl.addEventListener('input', (e) => {
            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.subtext = e.target.value;
            if (active.mg.mgData) active.mg.mgData.subtext = e.target.value;
            refreshCompositorMGs();
        });
    }

    // Position
    const posEl = document.getElementById('li-position');
    if (posEl) {
        posEl.addEventListener('change', (e) => {
            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.position = e.target.value;
            if (active.mg.mgData) active.mg.mgData.position = e.target.value;
            if (active.isScene) loadActiveScenes(); else updateMGOverlay();
            refreshCompositorMGs();
        });
    }

    // Duration slider
    const durEl = document.getElementById('li-duration');
    if (durEl) {
        durEl.addEventListener('pointerdown', () => pushUndoState());
        durEl.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            const durVal = document.getElementById('li-duration-val');
            if (durVal) durVal.textContent = `${val.toFixed(1)}s`;

            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.duration = val;
            if (active.mg.mgData) active.mg.mgData.duration = val;
            refreshCompositorMGs();
            renderTimeline();
        });
    }

    // Animation speed slider
    const animSpeedEl = document.getElementById('li-anim-speed');
    if (animSpeedEl) {
        animSpeedEl.addEventListener('pointerdown', () => pushUndoState());
        animSpeedEl.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            const animSpeedVal = document.getElementById('li-anim-speed-val');
            if (animSpeedVal) animSpeedVal.textContent = `${val.toFixed(1)}x`;

            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.animationSpeed = val;
            if (active.mg.mgData) active.mg.mgData.animationSpeed = val;
            refreshCompositorMGs();
        });
    }

    // Scale slider
    const scaleEl = document.getElementById('li-scale');
    if (scaleEl) {
        scaleEl.addEventListener('pointerdown', () => pushUndoState());
        scaleEl.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            const scaleVal = document.getElementById('li-scale-val');
            if (scaleVal) scaleVal.textContent = `${val.toFixed(1)}x`;

            const active = getActiveListicleMG();
            if (!active) return;
            active.mg.scale = val;
            if (active.mg.mgData) active.mg.mgData.scale = val;
            refreshCompositorMGs();
        });
    }
}

// ========================================
// Listicle Template Properties (separate system — overview grid, future templates)
// ========================================

/**
 * Populate the Template properties panel (#template-properties).
 * Variant + Animation dropdowns are dynamically populated from TEMPLATE_REGISTRY
 * so each template type shows only its own valid options.
 */
function updateTemplateProperties(mgOrScene) {
    const panel = document.getElementById('template-properties');
    if (!panel) return;
    panel.classList.remove('hidden');

    // Read from scene first (what renderer sees), then mgData fallback
    const scene = state._selectedMgScene || {};
    const mg = scene.type ? scene : mgOrScene;

    const tplType = document.getElementById('tpl-type');
    const tplVariant = document.getElementById('tpl-variant');
    const tplAnimation = document.getElementById('tpl-animation');
    const tplStyle = document.getElementById('tpl-style');
    const tplBackground = document.getElementById('tpl-background');
    const tplAnimSpeed = document.getElementById('tpl-anim-speed');
    const tplAnimSpeedVal = document.getElementById('tpl-anim-speed-val');

    const type = mg.type || 'listicleGrid';
    if (tplType) tplType.value = type;

    // Populate variant + animation dropdowns from registry for THIS template type
    const reg = TEMPLATE_REGISTRY[type];
    if (reg) {
        _populateTemplateDropdown(tplVariant, reg.variants, mg.subType || mg.variant, reg.defaultVariant);
        _populateTemplateDropdown(tplAnimation, reg.animations, mg.animation, reg.defaultAnimation);
    }

    if (tplStyle) tplStyle.value = mg.style || 'clean';
    if (tplBackground) tplBackground.value = mg.mgBackground || '';
    if (tplAnimSpeed) {
        const speed = mg.animationSpeed || mg._animationSpeed || 1.0;
        tplAnimSpeed.value = speed;
        if (tplAnimSpeedVal) tplAnimSpeedVal.textContent = `${speed.toFixed(1)}x`;
    }
}

/**
 * Get active template MG (from V3 scene selection)
 */
function getActiveTemplateMG() {
    const scene = state._selectedMgScene;
    if (!scene || !TEMPLATE_TYPES.has(scene.type)) return null;
    return { scene };
}

/** Set a property on both scene and scene.mgData so renderer always sees it */
function _setTemplateProp(scene, key, value) {
    scene[key] = value;
    if (scene.mgData) scene.mgData[key] = value;
}

/**
 * Setup event listeners for Template properties panel.
 * tpl-type change → re-populates variant/animation dropdowns from TEMPLATE_REGISTRY.
 */
function setupTemplatePropertyListeners() {
    const tplType = document.getElementById('tpl-type');
    if (tplType) {
        tplType.addEventListener('change', (e) => {
            const active = getActiveTemplateMG();
            if (!active) return;
            pushUndoState();
            const newType = e.target.value;
            _setTemplateProp(active.scene, 'type', newType);
            // Update keyword display
            active.scene.keyword = `Template: ${newType}`;
            if (active.scene.mgData) active.scene.mgData.keyword = active.scene.keyword;
            // Re-populate variant/animation with new type's options + set defaults
            const reg = TEMPLATE_REGISTRY[newType];
            if (reg) {
                const tplVariant = document.getElementById('tpl-variant');
                const tplAnimation = document.getElementById('tpl-animation');
                _populateTemplateDropdown(tplVariant, reg.variants, null, reg.defaultVariant);
                _populateTemplateDropdown(tplAnimation, reg.animations, null, reg.defaultAnimation);
                _setTemplateProp(active.scene, 'subType', reg.defaultVariant);
                _setTemplateProp(active.scene, 'variant', reg.defaultVariant);
                _setTemplateProp(active.scene, 'animation', reg.defaultAnimation);
            }
            // Update panel title
            const titleEl = document.getElementById('properties-title');
            if (titleEl) titleEl.textContent = reg?.label || 'Template';
            renderTimeline();
            refreshCompositorMGs();
        });
    }

    const tplVariant = document.getElementById('tpl-variant');
    if (tplVariant) {
        tplVariant.addEventListener('change', (e) => {
            const active = getActiveTemplateMG();
            if (!active) return;
            pushUndoState();
            _setTemplateProp(active.scene, 'subType', e.target.value);
            _setTemplateProp(active.scene, 'variant', e.target.value);
            refreshCompositorMGs();
        });
    }

    const tplAnimation = document.getElementById('tpl-animation');
    if (tplAnimation) {
        tplAnimation.addEventListener('change', (e) => {
            const active = getActiveTemplateMG();
            if (!active) return;
            pushUndoState();
            _setTemplateProp(active.scene, 'animation', e.target.value);
            refreshCompositorMGs();
        });
    }

    const tplStyle = document.getElementById('tpl-style');
    if (tplStyle) {
        tplStyle.addEventListener('change', (e) => {
            const active = getActiveTemplateMG();
            if (!active) return;
            pushUndoState();
            _setTemplateProp(active.scene, 'style', e.target.value);
            refreshCompositorMGs();
        });
    }

    const tplBackground = document.getElementById('tpl-background');
    if (tplBackground) {
        tplBackground.addEventListener('change', (e) => {
            const active = getActiveTemplateMG();
            if (!active) return;
            pushUndoState();
            _setTemplateProp(active.scene, 'mgBackground', e.target.value || undefined);
            refreshCompositorMGs();
        });
    }

    const tplAnimSpeed = document.getElementById('tpl-anim-speed');
    if (tplAnimSpeed) {
        tplAnimSpeed.addEventListener('pointerdown', () => pushUndoState());
        tplAnimSpeed.addEventListener('input', (e) => {
            const val = parseFloat(e.target.value);
            const valEl = document.getElementById('tpl-anim-speed-val');
            if (valEl) valEl.textContent = `${val.toFixed(1)}x`;
            const active = getActiveTemplateMG();
            if (!active) return;
            _setTemplateProp(active.scene, 'animationSpeed', val);
            _setTemplateProp(active.scene, '_animationSpeed', val);
            refreshCompositorMGs();
        });
    }
}

/**
 * Compute effective volume for a scene (clip volume * master volume * track mute)
 */
function getSceneVolume(scene) {
    if (state.isMuted) return 0;
    const trackId = scene.trackId || 'video-track-1';
    if (state.mutedTracks[trackId]) return 0;
    const clipVol = scene.volume !== undefined ? scene.volume : 1;
    return clipVol * state.volume;
}

/**
 * Apply volume to all active video elements and audio based on clip volume + track mute
 */
function applyTrackVolumes() {
    // Video tracks
    if (state.activeSceneIndices) {
        state.activeSceneIndices.forEach(idx => {
            const scene = state.scenes[idx];
            if (!scene) return;
            const trackNum = (scene.trackId || 'video-track-1').match(/(\d)/)?.[1] || '1';
            const video = getActiveTrackVideo(trackNum);
            if (video) {
                video.volume = getSceneVolume(scene);
                video.muted = false; // Let volume control handle it
            }
        });
    }

    // Voice track
    if (elements.previewAudio) {
        const voiceMuted = state.mutedTracks['audio-track'] || false;
        elements.previewAudio.volume = (state.isMuted || voiceMuted) ? 0 : state.volume;
    }
}

/**
 * Apply scale/position transform to a specific video element
 * @param {HTMLVideoElement} videoElement - The video element to transform
 * @param {Object} scene - The scene with scale/position properties
 */
function applySceneTransformToVideo(videoElement, scene) {
    if (!videoElement || !scene) return;

    const scale = scene.scale !== undefined ? scene.scale : 1;
    const posX = scene.posX || 0;
    const posY = scene.posY || 0;

    // Apply transform - translate first then scale
    videoElement.style.transform = `translate(${posX}%, ${posY}%) scale(${scale})`;
    videoElement.style.transformOrigin = 'center center';
    // Fit mode: contain shows full media (vertical/square), cover fills frame (16:9)
    videoElement.style.objectFit = scene.fitMode || 'cover';

    // Crop on the media element (so scaling can push crop edges out of view)
    applyCrop(videoElement, scene);
    videoElement.style.borderRadius = '';

    // Border-radius on the track wrapper (clean rounded corners)
    const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
    const wrapper = elements[`trackWrapper${trackNum}`];
    if (wrapper) {
        applyRadius(wrapper, scene);
        wrapper.style.clipPath = ''; // Ensure no leftover clip-path on wrapper
    }
}

/**
 * Apply transform to a scene by index (finds the scene's track video)
 */
function applySceneTransform(sceneIndex) {
    if (sceneIndex < 0 || !state.scenes[sceneIndex]) return;

    const scene = state.scenes[sceneIndex];
    const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
    const isImage = scene.mediaType === 'image';

    if (isImage) {
        // For images, update via Ken Burns (which combines scene transform + KB animation)
        const img = elements[`imgTrack${trackNum}`];
        if (img) updateKenBurnsTransform(img, scene);
    } else {
        const video = getActiveTrackVideo(trackNum);
        if (video) applySceneTransformToVideo(video, scene);
    }
}

function clearSceneTransform() {
    // Clear transform and crop from all track video/img elements (both A and B buffers)
    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
    elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach(video => {
        if (video) {
            video.style.transform = '';
            video.style.transformOrigin = '';
            video.style.objectFit = '';
            video.style.clipPath = '';
        }
    });
    [elements.imgTrack1, elements.imgTrack2, elements.imgTrack3].forEach(img => {
        if (img) {
            img.style.clipPath = '';
        }
    });
    // Clear radius from track wrappers
    [elements.trackWrapper1, elements.trackWrapper2, elements.trackWrapper3].forEach(wrapper => {
        if (wrapper) {
            wrapper.style.clipPath = '';
            wrapper.style.borderRadius = '';
            wrapper.style.overflow = '';
        }
    });
}

// ========================================
// Preview Drag & Scroll (Scale/Position)
// ========================================
function setupPreviewDrag() {
    const videoFrame = elements.videoContainer;
    const previewArea = elements.previewContainer;
    if (!videoFrame || !previewArea) return;

    // Clip position drag (left button on video frame)
    let isDragging = false;
    let startX = 0, startY = 0;
    let startPosX = 0, startPosY = 0;

    videoFrame.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return; // Only left button
        if (state.selectedClipIndex < 0 || !state.scenes[state.selectedClipIndex]) return;
        if (e.target.closest('.video-controls')) return;

        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const scene = state.scenes[state.selectedClipIndex];
        startPosX = scene.posX || 0;
        startPosY = scene.posY || 0;
        videoFrame.style.cursor = 'grabbing';
        e.preventDefault();
    });

    document.addEventListener('mousemove', (e) => {
        if (!isDragging || state.selectedClipIndex < 0) return;

        const rect = videoFrame.getBoundingClientRect();
        const deltaX = ((e.clientX - startX) / rect.width) * 100;
        const deltaY = ((e.clientY - startY) / rect.height) * 100;

        const scene = state.scenes[state.selectedClipIndex];
        scene.posX = Math.max(-50, Math.min(50, Math.round(startPosX + deltaX)));
        scene.posY = Math.max(-50, Math.min(50, Math.round(startPosY + deltaY)));

        applySceneTransform(state.selectedClipIndex);
        updateClipProperties();
    });

    document.addEventListener('mouseup', () => {
        if (isDragging) {
            isDragging = false;
            videoFrame.style.cursor = '';
        }
    });

    // ========================================
    // Preview zoom & pan (works from entire preview area)
    // ========================================

    // Scroll wheel: smooth zoom (works anywhere in preview area)
    previewArea.addEventListener('wheel', (e) => {
        e.preventDefault();

        const currentZoom = state.previewZoom === 'fit' ? 100 : state.previewZoom;
        const delta = e.deltaY < 0 ? 5 : -5; // Slower zoom: 5% increments
        let newZoom = currentZoom + delta;

        if (newZoom < 25) newZoom = 'fit';
        else if (newZoom > 200) newZoom = 200;
        else newZoom = Math.round(newZoom / 5) * 5;

        setPreviewZoom(newZoom);
    });

    // Right mouse button: pan when zoomed (works anywhere in preview area)
    let isPanning = false;
    let panStartX = 0;
    let panStartY = 0;
    let panScrollLeft = 0;
    let panScrollTop = 0;

    previewArea.addEventListener('mousedown', (e) => {
        if (e.button === 2 && state.previewZoom !== 'fit') { // Right button
            e.preventDefault();
            isPanning = true;
            panStartX = e.clientX;
            panStartY = e.clientY;
            panScrollLeft = previewArea.scrollLeft;
            panScrollTop = previewArea.scrollTop;
            previewArea.style.cursor = 'grabbing';
        }
    });

    previewArea.addEventListener('mousemove', (e) => {
        if (isPanning) {
            e.preventDefault();
            const dx = e.clientX - panStartX;
            const dy = e.clientY - panStartY;
            previewArea.scrollLeft = panScrollLeft - dx;
            previewArea.scrollTop = panScrollTop - dy;
        }
    });

    previewArea.addEventListener('mouseup', (e) => {
        if (e.button === 2 && isPanning) {
            isPanning = false;
            previewArea.style.cursor = '';
        }
    });

    previewArea.addEventListener('mouseleave', () => {
        if (isPanning) {
            isPanning = false;
            previewArea.style.cursor = '';
        }
    });

    // Prevent default context menu on right click when zoomed
    previewArea.addEventListener('contextmenu', (e) => {
        if (state.previewZoom !== 'fit') {
            e.preventDefault();
        }
    });
}

// ========================================
// Preview Zoom (like Premiere Pro Program Monitor)
// ========================================
function setupPreviewZoom() {
    const select = elements.previewZoomSelect;
    if (!select) return;

    select.addEventListener('change', (e) => {
        const val = e.target.value;
        setPreviewZoom(val === 'fit' ? 'fit' : parseInt(val));
    });
}

function setPreviewZoom(zoom) {
    state.previewZoom = zoom;

    const container = elements.previewContainer;
    const videoFrame = elements.videoContainer;
    if (!container || !videoFrame) return;

    // Update label
    if (elements.previewZoomLabel) {
        elements.previewZoomLabel.textContent = zoom === 'fit' ? 'Fit' : `${zoom}%`;
    }

    // Update dropdown to closest preset
    if (elements.previewZoomSelect) {
        const presets = [25, 50, 75, 100, 150, 200];
        if (zoom === 'fit') {
            elements.previewZoomSelect.value = 'fit';
        } else {
            // Find closest preset
            const closest = presets.reduce((prev, curr) =>
                Math.abs(curr - zoom) < Math.abs(prev - zoom) ? curr : prev
            );
            // Only update if exact match, otherwise leave dropdown as is
            if (presets.includes(zoom)) {
                elements.previewZoomSelect.value = String(zoom);
            }
        }
    }

    if (zoom === 'fit') {
        // Fit mode: 16:9 frame fills available space
        container.classList.remove('zoomed');
        videoFrame.style.width = '';
        videoFrame.style.height = '';
        videoFrame.style.minWidth = '';
        videoFrame.style.minHeight = '';
    } else {
        // Specific zoom %: actual pixel size relative to 1920x1080
        const w = Math.round(1920 * zoom / 100);
        const h = Math.round(1080 * zoom / 100);
        container.classList.add('zoomed');
        videoFrame.style.width = `${w}px`;
        videoFrame.style.height = `${h}px`;
        videoFrame.style.minWidth = `${w}px`;
        videoFrame.style.minHeight = `${h}px`;

        // Center scroll position (only on first zoom, not during pan)
        requestAnimationFrame(() => {
            container.scrollLeft = (container.scrollWidth - container.clientWidth) / 2;
            container.scrollTop = (container.scrollHeight - container.clientHeight) / 2;
        });
    }
}

// ========================================
// Save Project
// ========================================
async function saveProject(silent = false) {
    if (!state.videoPlan) {
        if (!silent) showToast('No project to save', 'info');
        return;
    }
    try {
        // Update the plan with current scene state
        state.videoPlan.scenes = state.scenes.filter(s => !s.isMGScene).map((s, i) => ({
            ...s,
            index: i,
            originalStartTime: s.originalStartTime,
            originalEndTime: s.originalEndTime
        }));
        state.videoPlan.mgScenes = state.scenes.filter(s => s.isMGScene && !s.disabled && !s.templateType).map(s => ({ ...s }));
        state.videoPlan.templateScenes = state.scenes.filter(s => s.isMGScene && !s.disabled && s.templateType).map(s => ({ ...s }));
        state.videoPlan.mutedTracks = { ...state.mutedTracks };
        state.videoPlan.totalDuration = state.totalDuration;
        state.videoPlan.transitionStyle = elements.transitionStyle.value;

        // Collect current editor settings
        const settings = {
            aiProvider: elements.aiProvider.value,
            transitionStyle: elements.transitionStyle.value,
            transitionDuration: state.transition.duration,
            volume: state.volume,
            footageSources: getEnabledSources(),
            sfxEnabled: state.sfxEnabled,
            sfxVolume: state.sfxVolume,
            mgEnabled: state.mgEnabled,
            subtitlesEnabled: state.subtitlesEnabled,
            aiInstructions: state.aiInstructions,
            videoTitle: state.videoTitle,
            buildNiche: elements.buildNiche ? elements.buildNiche.value : 'auto',
            buildLanguage: elements.buildLanguage ? elements.buildLanguage.value : 'auto',
            clipAnalyzer: elements.clipAnalyzerToggle?.checked !== false,
            mutedTracks: state.mutedTracks
        };

        // Save as .fvp project file (includes settings + video plan + writes video-plan.json)
        if (window.electronAPI.saveProjectFile) {
            const result = await window.electronAPI.saveProjectFile({ settings, videoPlan: state.videoPlan });
            state.hasProjectFile = true;
            if (!silent && result && result.path) {
                showToast(`Project saved to ${result.path}`, 'success');
            } else if (!silent) {
                showToast('Project saved', 'success');
            }
        } else {
            // Fallback: old save method
            await window.electronAPI.saveVideoPlan(state.videoPlan);
            if (!silent) showToast('Project saved', 'success');
        }
    } catch (e) {
        console.error('Save failed:', e);
        if (!silent) showToast('Save failed', 'error');
    }
}

// Debounced auto-save: saves .fvp file 3 seconds after last change
let _autoSaveTimer = null;
function triggerAutoSave() {
    if (!state.hasProjectFile || !state.videoPlan) return;
    if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
    _autoSaveTimer = setTimeout(() => {
        saveProject(true); // silent save
    }, 3000);
}

function togglePlayback() {
    if (state.scenes.length === 0) return;

    if (state.isPlaying) {
        stopPlayback();
    } else {
        startPlayback();
    }
}

function startPlayback() {
    if (state.isPlaying) return;

    // If at the end, restart from beginning
    if (state.currentTime >= state.totalDuration) {
        state.currentTime = 0;
        state.currentSceneIndex = 0;
        jumpToScene(0).then(() => {
            actuallyStartPlayback();
        });
        return;
    }

    actuallyStartPlayback();
}

function actuallyStartPlayback() {
    const audio = elements.previewAudio;
    const activeScenes = getActiveScenesAtTime(state.currentTime);

    state.isPlaying = true;
    state.lastPlaybackTime = performance.now();

    // Update play button
    if (elements.btnPlay) {
        elements.btnPlay.textContent = '⏸';
    }

    // Start all active track videos
    if (activeScenes.length > 0) {
        activeScenes.forEach(({ scene }) => {
            const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
            const video = getActiveTrackVideo(trackNum);
            if (video && video.src) {
                video.play().catch(e => console.warn('Video play failed:', e));
            }
        });
    } else {
        // In a gap - hide video container, but only show placeholder when the whole project is empty
        elements.videoContainer?.classList.add('hidden');
        if (state.scenes.length === 0) {
            elements.previewPlaceholder.classList.remove('hidden');
        } else {
            elements.previewPlaceholder.classList.add('hidden');
        }
    }

    // Always start audio - it plays through gaps
    if (audio?.src) {
        audio.currentTime = Math.min(state.currentTime, audio.duration || state.totalDuration);
        audio.play().catch(e => console.warn('Audio play failed:', e));
    }

    // Start compositor videos if in compositor mode
    if (state.compositorActive && state.compositor) {
        state.compositor.playVideos(state.currentTime);
    }

    // Start the playback loop
    startPlaybackLoop();
}

function stopPlayback() {
    state.isPlaying = false;

    // Update play button
    if (elements.btnPlay) {
        elements.btnPlay.textContent = '▶';
    }

    // Cancel animation frame
    if (state.playbackAnimationFrame) {
        cancelAnimationFrame(state.playbackAnimationFrame);
        state.playbackAnimationFrame = null;
    }

    // Pause compositor videos
    if (state.compositor) state.compositor.pauseVideos();

    // Reset scene load flag and per-track swap flags
    state._sceneLoadPending = false;
    state._trackSwapPending = { '1': false, '2': false, '3': false };
    state._trackLastHardSyncMs = { '1': 0, '2': 0, '3': 0 };
    state.activeSceneIndices = [];
    state.activeOverlaySceneIndices = [];

    // Flush deferred bgVideo load
    if (elements.bgVideo && elements.bgVideo._pendingSrc) {
        elements.bgVideo.src = elements.bgVideo._pendingSrc;
        elements.bgVideo._pendingSrc = null;
        elements.bgVideo.load();
    }

    // Pause all track video elements (both A and B buffers)
    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
    elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B,
    elements.videoTransitionOut].forEach(video => {
        if (video && !video.paused) {
            video.pause();
        }
        if (video) {
            video.playbackRate = 1;
        }
    });

    // Stop all SFX
    stopAllSfx();

    // Clean up any ongoing transition
    state.transition.isTransitioning = false;
    if (elements.videoTransitionOut) {
        resetVideoTransitionState(elements.videoTransitionOut);
        elements.videoTransitionOut.src = '';
        elements.videoTransitionOut.style.zIndex = '';
    }
    if (elements.imgTransitionOut) {
        elements.imgTransitionOut.classList.remove('incoming', 'outgoing', 'active');
        elements.imgTransitionOut.src = '';
        elements.imgTransitionOut.style.zIndex = '';
        elements.imgTransitionOut.style.opacity = '';
        elements.imgTransitionOut.style.transform = '';
        elements.imgTransitionOut.style.filter = '';
        elements.imgTransitionOut.style.clipPath = '';
        elements.imgTransitionOut.style.visibility = '';
    }
    if (elements.videoContainer) {
        elements.videoContainer.className = 'video-transition-container';
    }

    // Pause audio
    const audio = elements.previewAudio;
    if (audio && !audio.paused) {
        audio.pause();
    }
}


function startPlaybackLoop() {
    if (state.playbackAnimationFrame) {
        cancelAnimationFrame(state.playbackAnimationFrame);
    }

    const loop = () => {
        if (!state.isPlaying) return;

        const audio = elements.previewAudio;

        // === WebGL2 Compositor path (when active, bypasses HTML preview) ===
        if (state.compositorActive && state.compositor && state.compositor.isInitialized) {
            // Audio is still the master clock
            if (audio?.src && !audio.paused) {
                state.currentTime = audio.currentTime;
            }
            // Check end of timeline
            if (state.currentTime >= state.totalDuration) {
                state.currentTime = state.totalDuration;
                stopPlayback();
                updatePlayhead();
                updateTimeDisplay();
                return;
            }
            // Render the frame via WebGL2 engine
            state.compositor.renderAtTime(state.currentTime);
            // Sync audio
            if (audio?.src && !audio.paused) {
                const audioDiff = Math.abs(audio.currentTime - state.currentTime);
                if (audioDiff > 0.2) {
                    audio.currentTime = Math.min(state.currentTime, audio.duration || state.totalDuration);
                }
            }
            // Trigger SFX clips at transition points
            if (state.sfxEnabled && state.sfxClips.length > 0) {
                const ct = state.currentTime;
                state.sfxClips.forEach(sfx => {
                    const sfxEnd = sfx.startTime + sfx.duration;
                    if (ct >= sfx.startTime && ct < sfxEnd && !sfx._triggered) {
                        sfx._triggered = true;
                        playSfxClip(sfx);
                    }
                    if (ct < sfx.startTime || ct >= sfxEnd) {
                        sfx._triggered = false;
                    }
                });
            }
            // Update UI (playhead, time, scene highlight)
            updatePlayhead();
            updateTimeDisplay();
            const activeScenes = getActiveScenesAtTime(state.currentTime);
            const activeMediaScenes = activeScenes.filter(({ scene }) => !scene.isMGScene && !scene.disabled);
            updateSceneHighlight(activeMediaScenes.length > 0 ? activeMediaScenes[0].index : -1);
            // Continue loop
            state.playbackAnimationFrame = requestAnimationFrame(loop);
            return;
        }

        // === Original HTML-based preview path ===
        const activeScenes = getActiveScenesAtTime(state.currentTime);
        const activeMediaScenes = activeScenes.filter(({ scene }) =>
            !scene.isMGScene && !scene.disabled
        );
        // Use audio as the master clock - it plays continuously through gaps
        if (audio?.src && !audio.paused) {
            state.currentTime = audio.currentTime;
        } else if (activeMediaScenes.length > 0) {
            // Use first active video as clock
            const firstScene = activeMediaScenes[0].scene;
            const trackNum = firstScene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
            const video = getActiveTrackVideo(trackNum);
            if (video && video.src && !video.paused) {
                state.currentTime = firstScene.startTime + video.currentTime - (firstScene.mediaOffset || 0);
            }
        }

        // Update time displays
        if (elements.currentTimeDisplay) {
            elements.currentTimeDisplay.textContent = formatTime(state.currentTime, true);
        }
        if (elements.totalTimeDisplay) {
            elements.totalTimeDisplay.textContent = formatTime(state.totalDuration, true);
        }

        // Check if we've reached the end of the timeline
        if (state.currentTime >= state.totalDuration) {
            state.currentTime = state.totalDuration;
            stopPlayback();
            updatePlayhead();
            updateTimeDisplay();
            return;
        }

        // Check if active scenes changed
        const mediaIndices = activeMediaScenes.map(s => s.index).join(',');
        const prevMediaIndices = (state.activeSceneIndices || []).join(',');
        const shouldReload = mediaIndices !== prevMediaIndices;

        if (shouldReload && !state._sceneLoadPending) {
            // Don't update activeSceneIndices yet — wait until load completes
            // This prevents the time sync from running on wrong video during load
            state._sceneLoadPending = true;
            loadActiveScenes(activeScenes).then(() => {
                state._sceneLoadPending = false;
                state.activeSceneIndices = activeMediaScenes.map(s => s.index);
                // After load completes, ensure videos are playing
                if (state.isPlaying) {
                    getActiveScenesAtTime(state.currentTime).forEach(({ scene }) => {
                        if (scene.mediaType === 'image' || scene.isMGScene) return;
                        const tn = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
                        const vid = getActiveTrackVideo(tn);
                        if (vid && vid.paused && vid.src) {
                            vid.play().catch(() => { });
                        }
                    });
                }
                // Immediately preload the NEXT scene after this one finishes loading
                preloadUpcomingScenes(state.currentTime, true);
            }).catch(e => {
                state._sceneLoadPending = false;
                console.error('Scene load error:', e);
            });
        } else if (!shouldReload) {
            // Only sync time when loaded scenes MATCH expected scenes
            const now = performance.now();
            activeMediaScenes.forEach(({ scene }) => {
                const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
                // Skip tracks with a deferred swap in progress — old clip plays naturally
                if (state._trackSwapPending[trackNum]) return;
                const isImage = scene.mediaType === 'image';
                if (isImage) {
                    // Update Ken Burns transform every frame for smooth animation
                    const img = elements[`imgTrack${trackNum}`];
                    if (img) {
                        updateKenBurnsTransform(img, scene);
                    }
                } else {
                    const video = getActiveTrackVideo(trackNum);
                    if (video && !video.paused) {
                        const sceneTime = (state.currentTime - scene.startTime) + (scene.mediaOffset || 0);
                        const drift = sceneTime - video.currentTime;
                        const absDrift = Math.abs(drift);
                        const lastHardSync = state._trackLastHardSyncMs[trackNum] || 0;

                        // Avoid frequent hard seeks: they cause visible stutter.
                        // Hard-seek only for large drift, otherwise gently nudge playbackRate.
                        if (absDrift > 0.35 || (absDrift > 0.18 && now - lastHardSync > 500)) {
                            video.currentTime = Math.max(0, sceneTime);
                            state._trackLastHardSyncMs[trackNum] = now;
                            video.playbackRate = 1;
                        } else if (absDrift > 0.05) {
                            const correction = Math.max(-0.08, Math.min(0.08, drift * 0.35));
                            video.playbackRate = 1 + correction;
                        } else if (video.playbackRate !== 1) {
                            video.playbackRate = 1;
                        }
                    }
                }
            });
        }
        // else: shouldReload BUT _sceneLoadPending — skip both branches
        // Old clip continues playing naturally until new clip is loaded

        // Sync audio to current time (with tolerance)
        if (audio?.src && !audio.paused) {
            const audioDiff = Math.abs(audio.currentTime - state.currentTime);
            if (audioDiff > 0.2) {
                audio.currentTime = Math.min(state.currentTime, audio.duration || state.totalDuration);
            }
        }

        // Trigger SFX clips at transition points
        if (state.sfxEnabled && state.sfxClips.length > 0) {
            const ct = state.currentTime;
            state.sfxClips.forEach(sfx => {
                const sfxEnd = sfx.startTime + sfx.duration;
                if (ct >= sfx.startTime && ct < sfxEnd && !sfx._triggered) {
                    sfx._triggered = true;
                    playSfxClip(sfx);
                }
                if (ct < sfx.startTime || ct >= sfxEnd) {
                    sfx._triggered = false;
                }
            });
        }

        // Preload upcoming scenes' media URLs (fire-and-forget)
        preloadUpcomingScenes(state.currentTime);

        // Update UI (all optimized: cached DOM lookups, skipped when unchanged)
        updatePlayhead();
        updateTimeDisplay();
        updateSceneHighlight(activeMediaScenes.length > 0 ? activeMediaScenes[0].index : -1);
        updateMGOverlay();

        // Continue loop
        state.playbackAnimationFrame = requestAnimationFrame(loop);
    };

    state.playbackAnimationFrame = requestAnimationFrame(loop);
}

// Cache of resolved SFX file URLs to avoid IPC latency on every play
const _sfxUrlCache = {};

async function preloadSfxUrls() {
    // Preload all known SFX file URLs at startup
    const allFiles = new Set();
    for (const v of Object.values(SFX_MAP)) allFiles.add(v.file);
    for (const v of Object.values(MG_SFX_MAP)) allFiles.add(v.file);
    for (const file of allFiles) {
        if (!_sfxUrlCache[file]) {
            try {
                const url = await window.electronAPI.getSfxPath(file);
                if (url) _sfxUrlCache[file] = url;
            } catch (_) { }
        }
    }
}

function playSfxClip(sfx) {
    if (!state.sfxEnabled || state.isMuted) return;
    const poolEntry = state._sfxAudioPool.find(p => !p.playing) || state._sfxAudioPool[0];
    if (!poolEntry) return;
    const audio = poolEntry.element;

    // Use cached URL for instant playback (no IPC delay)
    const url = _sfxUrlCache[sfx.file];
    if (!url) {
        // Fallback: resolve via IPC (will be slow)
        window.electronAPI.getSfxPath(sfx.file).then(resolvedUrl => {
            if (!resolvedUrl) return;
            _sfxUrlCache[sfx.file] = resolvedUrl;
            audio.src = resolvedUrl;
            audio.volume = sfx.volume * state.volume;
            audio.currentTime = 0;
            poolEntry.playing = true;
            audio.play().catch(() => { });
            audio.onended = () => { poolEntry.playing = false; };
            setTimeout(() => { poolEntry.playing = false; }, (sfx.duration + 0.5) * 1000);
        }).catch(() => { });
        return;
    }

    poolEntry.playing = true;
    // If src already matches, just seek to start (avoids reload latency)
    if (audio.src === url) {
        audio.currentTime = 0;
    } else {
        audio.src = url;
    }
    audio.volume = sfx.volume * state.volume;
    audio.play().catch(() => { });
    audio.onended = () => { poolEntry.playing = false; };
    setTimeout(() => { poolEntry.playing = false; }, (sfx.duration + 0.5) * 1000);
}

function stopAllSfx() {
    state.sfxClips.forEach(sfx => { sfx._triggered = false; });
    state._sfxAudioPool.forEach(p => {
        p.element.pause();
        p.element.currentTime = 0;
        p.playing = false;
    });
}

/**
 * Update the Motion Graphics overlay in the preview.
 * Shows/hides MG elements based on current playback time.
 */
let _mgMeasureCanvas = null;

function getMGMeasureContext() {
    if (!_mgMeasureCanvas) {
        _mgMeasureCanvas = document.createElement('canvas');
    }
    return _mgMeasureCanvas.getContext('2d');
}

function getKineticTextPreviewLayout(text, fontFamily, options) {
    const words = String(text || '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .map(word => word.toUpperCase());
    if (words.length === 0) return null;

    const { hasSubtext = false, variant = 'centered', weight = 700 } = options || {};
    const ctx = getMGMeasureContext();
    const maxWidth = 1920 * 0.9;
    const maxHeight = hasSubtext ? 1080 * 0.58 : 1080 * 0.68;
    const maxRows = words.length <= 3 ? 2 : words.length <= 8 ? 3 : 4;
    const maxFontSize = variant === 'punch'
        ? 192
        : words.length <= 3
            ? 176
            : words.length <= 6
                ? 156
                : 136;
    const minFontSize = 60;
    const previewPxPerCqw = 14.4;

    let best = null;
    for (let fontSize = maxFontSize; fontSize >= minFontSize; fontSize -= 4) {
        ctx.font = `${weight} ${fontSize}px ${fontFamily}`;
        const gap = Math.round(Math.max(20, Math.min(40, fontSize * 0.18)));
        const rowHeight = Math.round(fontSize * 1.08);
        const attrFontSize = Math.round(Math.max(28, Math.min(56, fontSize * 0.34)));
        const attrMargin = hasSubtext ? Math.round(Math.max(18, fontSize * 0.5)) : 0;

        const rows = [];
        let currentRow = [];
        let currentWidth = 0;
        for (let i = 0; i < words.length; i++) {
            const width = ctx.measureText(words[i]).width;
            const nextWidth = currentRow.length > 0 ? currentWidth + gap + width : width;
            if (nextWidth > maxWidth && currentRow.length > 0) {
                rows.push({ words: currentRow, width: currentWidth });
                currentRow = [];
                currentWidth = 0;
            }

            currentRow.push({ word: words[i], width, index: i });
            currentWidth = currentRow.length > 1 ? currentWidth + gap + width : width;
        }

        if (currentRow.length > 0) {
            rows.push({ words: currentRow, width: currentWidth });
        }

        const textHeight = rows.length * rowHeight;
        const totalHeight = textHeight + (hasSubtext ? attrMargin + attrFontSize * 1.2 : 0);
        const widestRow = rows.reduce((max, row) => Math.max(max, row.width), 0);

        best = {
            words,
            rows,
            fontSizePx: fontSize,
            fontSizeCqw: fontSize / previewPxPerCqw,
            gapPx: gap,
            gapCqw: gap / previewPxPerCqw,
            attrFontSizePx: attrFontSize,
            attrFontSizeCqw: attrFontSize / previewPxPerCqw,
            attrMarginPx: attrMargin,
            attrMarginCqw: attrMargin / previewPxPerCqw,
            lineHeight: 1.02,
            maxWidthPct: 92,
        };

        if (rows.length <= maxRows && widestRow <= maxWidth && totalHeight <= maxHeight) {
            return best;
        }
    }

    return best;
}

function buildKineticTextPreviewHtml(mg, scene, styleVars, fontFamily, opacity, elapsed, enterDur, posClass, extraClasses) {
    const weightByStyle = { clean: 800, bold: 900, minimal: 500, neon: 900, cinematic: 700, elegant: 600 };
    const layout = getKineticTextPreviewLayout(mg.text || scene.text, fontFamily, {
        hasSubtext: !!(mg.subtext && mg.subtext !== 'none'),
        variant: mg.subType || 'centered',
        weight: weightByStyle[mg.style || scene.style || 'clean'] || 700,
    });

    if (!layout) {
        return `<div class="mg-preview-element mg-pos-center ${extraClasses || ''}" style="${styleVars};opacity:${opacity}"></div>`;
    }

    const kineticStyleVars = `${styleVars};--mg-kinetic-font-size:${layout.fontSizeCqw.toFixed(3)}cqw;--mg-kinetic-gap:${layout.gapCqw.toFixed(3)}cqw;--mg-kinetic-attr-size:${layout.attrFontSizeCqw.toFixed(3)}cqw;--mg-kinetic-attr-margin:${layout.attrMarginCqw.toFixed(3)}cqw;--mg-kinetic-line-height:${layout.lineHeight};--mg-kinetic-max-width:${layout.maxWidthPct}%`;
    const wordsHTML = layout.words.map((word, i) => {
        const wOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.1 - i * 0.12) / 0.15));
        const wScale = 1 + (1 - wOp) * 0.5;
        return `<span class="mg-kinetic-word" style="opacity:${wOp};transform:scale(${wScale})">${escapeHTML(word)}</span>`;
    }).join('');
    const allWordsEnd = enterDur * 0.1 + layout.words.length * 0.12 + 0.3;
    const attrOp = elapsed > allWordsEnd ? Math.min(1, (elapsed - allWordsEnd) / 0.3) : 0;
    const subHtml = mg.subtext && mg.subtext !== 'none'
        ? `<div class="mg-kinetic-attr" style="opacity:${attrOp}">\u2014 ${escapeHTML(mg.subtext)}</div>` : '';

    return `<div class="mg-preview-element mg-kinetic ${posClass} ${extraClasses || ''}" style="${kineticStyleVars};opacity:${opacity}">
        <div class="mg-kinetic-scrim" style="opacity:${Math.min(0.3, elapsed * 2)}"></div>
        <div class="mg-kinetic-words">${wordsHTML}</div>
        ${subHtml}
    </div>`;
}

// Full-screen MG preview for V3 scenes (opaque background + centered content)
function renderFullscreenMGPreview(scene) {
    const mg = scene.mgData || scene;
    const mgStyleName = mg.style || scene.style || state.mgStyle || 'clean';
    const styledColors = getStyledThemeColors(mgStyleName);
    const baseS = MG_STYLES[mgStyleName] || MG_STYLES.clean;
    // Manual style pick → MG_STYLES palette wins; auto-placed → theme wins.
    const manualStyle = mg.styleManual || scene.styleManual;
    const s = styledColors
        ? (manualStyle ? { ...styledColors, ...baseS } : { ...baseS, ...styledColors })
        : baseS;
    const tf = getActiveThemeFonts();
    // Replace double quotes with single quotes in font names to avoid breaking style="" attribute
    const fontH = tf.heading.replace(/"/g, "'");
    const fontB = tf.body.replace(/"/g, "'");
    const styleVars = `--mg-primary:${s.primary};--mg-accent:${s.accent};--mg-bg:${s.bg};--mg-text:${s.text};--mg-text-sub:${s.textSub};--mg-font-heading:${fontH};--mg-font-body:${fontB}`;

    const elapsed = Math.max(0, state.currentTime - (mg.startTime || scene.startTime));
    const duration = mg.duration || (scene.endTime - scene.startTime);
    const enterDur = Math.min(0.5, duration * 0.35);
    const exitDur = Math.min(0.3, duration * 0.2);
    const isExiting = elapsed > duration - exitDur;
    const opacity = isExiting ? Math.max(0, (duration - elapsed) / exitDur) : Math.min(1, elapsed / enterDur);
    const enterDone = elapsed >= enterDur;
    const type = mg.type || scene.type;

    // Background gradients per style
    const bgGradients = {
        clean: 'radial-gradient(ellipse at center, #0a0a2e, #000000)',
        bold: 'radial-gradient(ellipse at center, #1a0000, #0a0a0a)',
        minimal: 'radial-gradient(ellipse at center, #1a1a2e, #0f0f0f)',
        neon: 'radial-gradient(ellipse at center, #000020, #000008)',
        cinematic: 'radial-gradient(ellipse at center, #1a1500, #000000)',
        elegant: 'radial-gradient(ellipse at center, #0a0020, #050010)',
    };
    const bgGrad = bgGradients[mg.style || scene.style] || bgGradients.clean;

    let innerHtml = '';
    switch (type) {
        case 'barChart': {
            const items = parseKeyValuePairs(mg.subtext || scene.subtext);
            const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
            const barsHTML = items.slice(0, 6).map((item, i) => {
                const barProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.3 - i * 0.15) / 0.5));
                const barEased = 1 - Math.pow(1 - barProg, 3);
                const heightPct = ((parseFloat(item.value) || 0) / maxVal) * 100 * barEased;
                return `<div class="mg-bar-col">
                    <div class="mg-bar-value" style="opacity:${Math.min(1, Math.max(0, barProg - 0.3))}">${escapeHTML(item.value)}</div>
                    <div class="mg-bar" style="height:${heightPct}%"></div>
                    <div class="mg-bar-label">${escapeHTML(item.label)}</div>
                </div>`;
            }).join('');
            innerHtml = `<div class="mg-preview-element mg-bar-chart mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text)}</div>
                <div class="mg-bars-container">${barsHTML}</div>
            </div>`;
            break;
        }
        case 'donutChart': {
            const items = parseKeyValuePairs(mg.subtext || scene.subtext);
            const total = items.reduce((sum, i) => sum + (parseFloat(i.value) || 0), 0) || 100;
            const legendHTML = items.slice(0, 5).map((item, i) => {
                const itemOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.5 - i * 0.12) / 0.2));
                return `<div class="mg-donut-legend-item" style="opacity:${itemOp}">
                    <span class="mg-donut-dot" style="background:${i === 0 ? 'var(--mg-primary)' : 'var(--mg-accent)'}"></span>
                    ${escapeHTML(item.label)} ${escapeHTML(item.value)}%
                </div>`;
            }).join('');
            let gradientStops = [], cumPct = 0;
            const colors = ['var(--mg-primary)', 'var(--mg-accent)', 'rgba(255,255,255,0.3)', 'rgba(255,255,255,0.15)'];
            items.slice(0, 5).forEach((item, i) => {
                const pct = (parseFloat(item.value) || 0) / total * 100;
                const drawProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * 0.2) / 0.5));
                const drawnPct = pct * (1 - Math.pow(1 - drawProg, 3));
                gradientStops.push(`${colors[i % colors.length]} ${cumPct}% ${cumPct + drawnPct}%`);
                cumPct += drawnPct;
            });
            gradientStops.push(`transparent ${cumPct}% 100%`);
            innerHtml = `<div class="mg-preview-element mg-donut-chart mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text)}</div>
                <div class="mg-donut-row">
                    <div class="mg-donut-ring" style="background:conic-gradient(from 0deg, ${gradientStops.join(', ')})"><div class="mg-donut-hole"></div></div>
                    <div class="mg-donut-legend">${legendHTML}</div>
                </div>
            </div>`;
            break;
        }
        case 'comparisonCard': {
            const parts = (mg.text || scene.text).split(/\s+vs\.?\s+/i);
            const slideAmt = enterDone ? 0 : (1 - elapsed / enterDur) * 30;
            const vsProg = Math.min(1, Math.max(0, (elapsed - 0.3) / 0.3));
            innerHtml = `<div class="mg-preview-element mg-comparison mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-comp-panel mg-comp-left" style="transform:translateX(${-slideAmt}px)">${escapeHTML(parts[0] || 'A')}</div>
                <div class="mg-comp-vs" style="transform:scale(${vsProg})">VS</div>
                <div class="mg-comp-panel mg-comp-right" style="transform:translateX(${slideAmt}px)">${escapeHTML(parts[1] || 'B')}</div>
            </div>`;
            break;
        }
        case 'timeline': {
            const items = parseKeyValuePairs(mg.subtext || scene.subtext);
            const lineW = enterDone ? 100 : Math.min(100, elapsed / enterDur * 100);
            const markersHTML = items.slice(0, 5).map((item, i) => {
                const pct = items.length > 1 ? (i / (items.length - 1)) * 100 : 50;
                const mOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.3 - i * 0.25) / 0.25));
                return `<div class="mg-tl-marker" style="left:${pct}%;opacity:${mOp}">
                    <div class="mg-tl-year">${escapeHTML(item.label)}</div>
                    <div class="mg-tl-dot"></div>
                    <div class="mg-tl-event">${escapeHTML(item.value)}</div>
                </div>`;
            }).join('');
            innerHtml = `<div class="mg-preview-element mg-timeline mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text)}</div>
                <div class="mg-tl-container">
                    <div class="mg-tl-line" style="width:${lineW}%"></div>
                    ${markersHTML}
                </div>
            </div>`;
            break;
        }
        case 'rankingList': {
            const items = parseKeyValuePairs(mg.subtext || scene.subtext);
            const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
            const rowsHTML = items.slice(0, 6).map((item, i) => {
                const rowOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * 0.18) / 0.25));
                const barProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.35 - i * 0.18) / 0.5));
                const barW = (1 - Math.pow(1 - barProg, 3)) * ((parseFloat(item.value) || 0) / maxVal) * 100;
                return `<div class="mg-rank-row" style="opacity:${rowOp}">
                    <span class="mg-rank-num ${i === 0 ? 'mg-rank-top' : ''}">${i + 1}</span>
                    <div class="mg-rank-content">
                        <div class="mg-rank-header"><span>${escapeHTML(item.label)}</span><span class="mg-rank-val">${escapeHTML(item.value)}</span></div>
                        <div class="mg-rank-track"><div class="mg-rank-bar ${i === 0 ? 'mg-rank-bar-top' : ''}" style="width:${barW}%"></div></div>
                    </div>
                </div>`;
            }).join('');
            innerHtml = `<div class="mg-preview-element mg-ranking mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text)}</div>
                ${rowsHTML}
            </div>`;
            break;
        }
        case 'bulletList': {
            const bulletItems = (mg.text || scene.text).split(/[,;]|\d+\.\s/).filter(s => s.trim());
            const bulletsHTML = bulletItems.map((item, i) => {
                const bOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * 0.2) / 0.3));
                return `<div class="mg-bullet-item" style="opacity:${bOp}"><span class="mg-bullet-marker">▸</span>${escapeHTML(item.trim())}</div>`;
            }).join('');
            innerHtml = `<div class="mg-preview-element mg-bullets-list mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text)}</div>
                ${bulletsHTML}
            </div>`;
            break;
        }
        case 'kineticText': {
            innerHtml = buildKineticTextPreviewHtml(
                mg,
                scene,
                styleVars,
                fontH,
                opacity,
                elapsed,
                enterDur,
                'mg-pos-center',
                'mg-fullscreen'
            );
            break;
        }
        case 'mapChart': {
            // Map visual style presets (matches MotionGraphics.jsx MAP_VISUAL_STYLES)
            const MAP_PREVIEW_STYLES = {
                dark: { ocean: '#0a1628', land: '#1a2744', border: 'rgba(30,58,95,0.4)', marker: null, label: null, labelBg: null, grid: true },
                natural: { ocean: '#1a4a6e', land: '#3a6b4a', border: 'rgba(42,80,56,0.4)', marker: '#ffffff', label: '#ffffff', labelBg: 'rgba(15,30,20,0.88)', grid: false },
                satellite: { ocean: '#050d1a', land: '#141e14', border: 'rgba(26,48,32,0.3)', marker: '#00ffcc', label: '#ffffff', labelBg: 'rgba(5,10,15,0.9)', grid: false },
                light: { ocean: '#d4e6f1', land: '#ecf0f1', border: 'rgba(189,195,199,0.6)', marker: '#e74c3c', label: '#2c3e50', labelBg: 'rgba(255,255,255,0.92)', grid: true },
                political: { ocean: '#b8d4e8', land: '#f0e6d3', border: 'rgba(138,122,106,0.5)', marker: '#c0392b', label: '#2c1810', labelBg: 'rgba(240,230,211,0.92)', grid: true },
            };
            const mps = MAP_PREVIEW_STYLES[mg.mapStyle || 'dark'] || MAP_PREVIEW_STYLES.dark;

            // Country coordinate lookup for geographic positioning
            const MAP_COORDS = {
                'China': [104, 35], 'United States': [-98, 39], 'USA': [-98, 39],
                'India': [78, 22], 'Japan': [138, 36], 'Germany': [10.5, 51.2],
                'United Kingdom': [-2, 54], 'UK': [-2, 54], 'France': [2.2, 46.2],
                'Brazil': [-51, -10], 'Italy': [12.5, 42.5], 'Canada': [-106, 56],
                'Russia': [100, 60], 'South Korea': [128, 36], 'Australia': [134, -25],
                'Spain': [-3.7, 40.4], 'Mexico': [-102, 23], 'Indonesia': [118, -2],
                'Norway': [9, 62], 'Turkey': [35, 39], 'Saudi Arabia': [45, 24],
                'South Africa': [25, -29], 'Argentina': [-64, -34], 'Nigeria': [8, 10],
                'Egypt': [30, 27], 'Thailand': [101, 15], 'Vietnam': [108, 16],
                'Iran': [53, 32], 'Colombia': [-74, 4], 'Chile': [-71, -35],
                'Pakistan': [70, 30], 'Philippines': [122, 13], 'Malaysia': [110, 4],
                'Ukraine': [32, 49], 'Kenya': [38, 0], 'Morocco': [-5, 32],
                'Myanmar': [96, 20], 'Taiwan': [121, 24], 'Afghanistan': [67, 33],
            };
            const items = parseKeyValuePairs(mg.subtext || scene.subtext);
            // Equirectangular projection: lng/lat → x%/y%
            const pinPositions = items.slice(0, 8).map((item, i) => {
                const coords = MAP_COORDS[item.label];
                let x, y;
                if (coords) {
                    x = ((coords[0] + 180) / 360) * 85 + 7;
                    y = ((90 - coords[1]) / 180) * 80 + 5;
                } else {
                    const hash = (item.label || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
                    x = 12 + ((hash * 7 + i * 137) % 76);
                    y = 15 + ((hash * 13 + i * 89) % 60);
                }
                return { ...item, x, y, i };
            });
            const pinColor = mps.marker || 'var(--mg-accent)';
            const pinLabelColor = mps.label || 'var(--mg-text)';
            const pinLabelBg = mps.labelBg || 'var(--mg-bg)';
            const pinsHTML = pinPositions.map((pin) => {
                const pinOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.3 - pin.i * 0.2) / 0.3));
                const bounce = pinOp < 1 ? (1 - pinOp) * 10 : 0;
                return `<div class="mg-map-pin" style="left:${pin.x}%;top:${pin.y}%;opacity:${pinOp};transform:translateY(${-bounce}px)">
                    <div class="mg-map-pin-dot" style="background:${pinColor};box-shadow:0 0 8px ${pinColor}"></div>
                    <div class="mg-map-pin-label" style="color:${pinLabelColor};background:${pinLabelBg}">${escapeHTML(pin.label)}</div>
                    ${pin.value && pin.value !== '0' ? `<div class="mg-map-pin-value" style="color:${pinColor}">${escapeHTML(pin.value)}</div>` : ''}
                </div>`;
            }).join('');
            const gridHTML = mps.grid ? `<div class="mg-map-grid" style="background:linear-gradient(90deg, ${mps.border} 1px, transparent 1px), linear-gradient(0deg, ${mps.border} 1px, transparent 1px);background-size:20% 25%"></div>` : '';
            // Map-specific background (ocean + land representation)
            const mapBg = `radial-gradient(ellipse at center, ${mps.ocean}, ${mps.ocean})`;
            const containerBg = `radial-gradient(ellipse 60% 50% at center, ${mps.land}60, transparent)`;
            innerHtml = `<div class="mg-preview-element mg-map-chart mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title" style="color:${pinLabelColor}">${escapeHTML(mg.text || scene.text)}</div>
                <div class="mg-map-container" style="background:${containerBg};border-color:${mps.border}">
                    ${gridHTML}
                    ${pinsHTML}
                </div>
            </div>`;
            // Override bgGrad for map to use ocean color
            innerHtml = `<div class="mg-fullscreen-bg" style="${styleVars};background:${mapBg}">${innerHtml}</div>`;
            // Return early since we handle the wrapper ourselves
            return innerHtml;
        }
        case 'articleHighlight': {
            // IMAGE MODE: real article screenshot with highlight boxes
            const articleImgUrl = mg._articleImageUrl || scene._articleImageUrl;
            const hlBoxes = mg.highlightBoxes || scene.highlightBoxes || [];
            if (articleImgUrl) {
                const blurAmt = Math.max(0, 12 - elapsed * 12);
                const cardScale = 1 + elapsed * 0.01;
                const rotY = elapsed / (mg.duration || 7) * 6;
                // Build yellow highlighter marker overlays (staggered sweep per phrase)
                let boxesHtml = '';
                for (let bi = 0; bi < hlBoxes.length; bi++) {
                    const b = hlBoxes[bi];
                    const yOff = (bi % 2 === 0) ? 0.3 : -0.2;
                    const rot = (bi % 2 === 0) ? -0.3 : 0.4;
                    const sweepProg = Math.min(1, Math.max(0, (elapsed - 1.2 - bi * 0.3) / 0.5));
                    const sweepEased = 1 - Math.pow(1 - sweepProg, 2.5);
                    if (sweepEased > 0) {
                        boxesHtml += `<div style="position:absolute;left:${(b.x - 1).toFixed(1)}%;top:${(b.y + yOff).toFixed(1)}%;width:${(b.w + 2).toFixed(1)}%;height:${Math.max(b.h, 3.8).toFixed(1)}%;background:rgba(255,230,0,0.38);border-radius:3px;transform:rotate(${rot}deg);mix-blend-mode:multiply;clip-path:inset(0 ${((1 - sweepEased) * 100).toFixed(1)}% 0 0);pointer-events:none"></div>`;
                    }
                }
                innerHtml = `<div class="mg-preview-element mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity};filter:blur(${blurAmt > 0.1 ? blurAmt : 0}px);transform:scale(${cardScale.toFixed(3)}) perspective(1200px) rotateY(${rotY.toFixed(2)}deg)">
                    <div style="position:relative;border-radius:12px;overflow:hidden;box-shadow:0 20px 80px rgba(0,0,0,0.35)">
                        <img src="${articleImgUrl}" style="display:block;width:100%;height:auto;max-height:100%" />
                        ${boxesHtml}
                        <div style="position:absolute;inset:0;background:radial-gradient(ellipse at center, transparent 50%, rgba(0,0,0,0.35) 100%);pointer-events:none"></div>
                    </div>
                </div>`;
                break;
            }
            // HTML CARD MODE (fallback): generated article card
            const rawSub = mg.subtext || scene.subtext || '';
            const pipeParts = rawSub.split('|');
            let artSource = '', artAuthor = '', artDate = '', rawExcerpt = '';
            if (pipeParts.length >= 4) {
                artSource = (pipeParts[0] || '').trim();
                artAuthor = (pipeParts[1] || '').trim();
                artDate = (pipeParts[2] || '').trim();
                rawExcerpt = pipeParts.slice(3).join('|').trim();
            } else if (pipeParts.length === 3) {
                artSource = (pipeParts[0] || '').trim();
                if (/\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(pipeParts[1])) {
                    artDate = (pipeParts[1] || '').trim();
                } else {
                    artAuthor = (pipeParts[1] || '').trim();
                }
                rawExcerpt = (pipeParts[2] || '').trim();
            } else if (pipeParts.length === 2) {
                artSource = (pipeParts[0] || '').trim();
                rawExcerpt = (pipeParts[1] || '').trim();
            } else {
                // No pipes — entire subtext is excerpt
                rawExcerpt = rawSub.trim();
            }
            // Extract highlighted phrases and build excerpt HTML
            const highlightPhrases = [];
            rawExcerpt.replace(/\*\*([^*]+)\*\*/g, (_, p) => highlightPhrases.push(p));
            // Auto-highlight if no ** markers: highlight numbers and key terms
            if (highlightPhrases.length === 0 && rawExcerpt.length > 0) {
                const numMatches = [];
                rawExcerpt.replace(/\d[\d,.]*\s*(?:%|percent|million|billion|trillion|thousand)?/gi, (m) => { numMatches.push(m.trim()); });
                if (numMatches.length > 0) {
                    numMatches.slice(0, 3).forEach(m => highlightPhrases.push(m));
                } else {
                    const common = new Set(['the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'had', 'was', 'one', 'our', 'has', 'with', 'that', 'this', 'from', 'they', 'been', 'have', 'many', 'some', 'them', 'than', 'its', 'over', 'also', 'each', 'which', 'their', 'will', 'there', 'then', 'about', 'would', 'these', 'could', 'after', 'where']);
                    const words = rawExcerpt.split(/\s+/).filter(w => w.replace(/[^a-zA-Z]/g, '').length >= 4 && !common.has(w.toLowerCase().replace(/[^a-z]/g, '')));
                    words.sort((a, b) => b.length - a.length);
                    words.slice(0, 2).forEach(w => highlightPhrases.push(w));
                }
            }
            let excerptHTML = escapeHTML(rawExcerpt.replace(/\*\*([^*]+)\*\*/g, '$1'));
            for (let hi = 0; hi < highlightPhrases.length; hi++) {
                const phrase = escapeHTML(highlightPhrases[hi]);
                const sweepProg = Math.min(1, Math.max(0, (elapsed - 1.2 - hi * 0.4) / 0.5));
                const sweepEased = 1 - Math.pow(1 - sweepProg, 2);
                const sweepW = Math.round(sweepEased * 100);
                excerptHTML = excerptHTML.replace(phrase,
                    `<span class="mg-article-hl-wrap"><span class="mg-article-hl-bg" style="width:${sweepW}%"></span><strong>${phrase}</strong></span>`
                );
            }
            const blurAmt = Math.max(0, 12 - elapsed * 12);
            const cardScale = 1 + elapsed * 0.01;
            const byline = (artAuthor ? `By ${escapeHTML(artAuthor)}` : '') + (artAuthor && artDate ? '  \u00B7  ' : '') + escapeHTML(artDate);
            innerHtml = `<div class="mg-preview-element mg-article-card mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity};filter:blur(${blurAmt > 0.1 ? blurAmt : 0}px);transform:scale(${cardScale.toFixed(3)})">
                ${artSource ? `<div class="mg-article-source">${escapeHTML(artSource)}</div>` : ''}
                <div class="mg-article-headline">${escapeHTML(mg.text || scene.text)}</div>
                <div class="mg-article-sep" style="width:${Math.min(100, enterDone ? 100 : elapsed / enterDur * 100)}%"></div>
                ${byline ? `<div class="mg-article-byline">${byline}</div>` : ''}
                ${rawExcerpt ? `<div class="mg-article-excerpt">\u201C${excerptHTML}\u201D</div>` : ''}
            </div>`;
            break;
        }
        default:
            innerHtml = `<div class="mg-preview-element mg-pos-center mg-fullscreen" style="${styleVars};opacity:${opacity}">
                <div class="mg-chart-title">${escapeHTML(mg.text || scene.text || type)}</div>
            </div>`;
    }

    return `<div class="mg-fullscreen-bg" style="${styleVars};background:${bgGrad}">${innerHtml}</div>`;
}

// Throttled MG overlay — only rebuilds innerHTML when active MG set changes,
// uses lightweight style updates for per-frame animation (opacity, counters)
let _mgLastActiveIds = '';
let _mgLastUpdateTime = 0;
let _mgLastHtml = '';
const _MG_ANIMATION_INTERVAL = 120; // ms between MG redraws (lower CPU -> smoother video preview)

function updateMGOverlay() {
    const overlay = elements.mgOverlay;
    if (!overlay) return;

    if (!state.mgEnabled || !state.motionGraphics || state.motionGraphics.length === 0) {
        if (overlay.children.length > 0) overlay.innerHTML = '';
        _mgLastActiveIds = '';
        _mgLastHtml = '';
        return;
    }

    const ct = state.currentTime;
    const activeMGs = state.motionGraphics.filter(mg =>
        !mg.disabled && ct >= mg.startTime && ct < mg.startTime + mg.duration
    );

    if (activeMGs.length === 0) {
        if (overlay.children.length > 0) overlay.innerHTML = '';
        _mgLastActiveIds = '';
        _mgLastHtml = '';
        return;
    }

    // Check if active MG set changed (new MG appeared/disappeared)
    const currentIds = activeMGs.map(mg => `${mg.type}:${mg.startTime}`).join('|');
    const setChanged = currentIds !== _mgLastActiveIds;
    _mgLastActiveIds = currentIds;

    // Throttle animation updates to ~20fps (full rebuilds always run)
    const now = performance.now();
    if (!setChanged && now - _mgLastUpdateTime < _MG_ANIMATION_INTERVAL) return;
    _mgLastUpdateTime = now;

    // Build HTML for active MG elements
    const tf = getActiveThemeFonts();
    // Replace double quotes with single quotes in font names to avoid breaking style="" attribute
    const fontH = tf.heading.replace(/"/g, "'");
    const fontB = tf.body.replace(/"/g, "'");

    const html = activeMGs.map(mg => {
        // Per-MG style variables (with style-modified theme colors)
        const mgStyleName = mg.style || state.mgStyle || 'clean';
        const styledColors = getStyledThemeColors(mgStyleName);
        const baseS = MG_STYLES[mgStyleName] || MG_STYLES.clean;
        // Manual style pick → MG_STYLES palette wins so the change is visible.
        // Auto-placed MGs → theme colors win (matches AI intent + theme identity).
        const s = styledColors
            ? (mg.styleManual ? { ...styledColors, ...baseS } : { ...baseS, ...styledColors })
            : baseS;
        const styleVars = `--mg-primary:${s.primary};--mg-accent:${s.accent};--mg-bg:${s.bg};--mg-text:${s.text};--mg-text-sub:${s.textSub};--mg-font-heading:${fontH};--mg-font-body:${fontB}`;

        const elapsed = ct - mg.startTime;
        const enterDur = Math.min(0.5, mg.duration * 0.35);
        const exitDur = Math.min(0.3, mg.duration * 0.2);
        const isExiting = elapsed > mg.duration - exitDur;
        const opacity = isExiting
            ? Math.max(0, (mg.duration - elapsed) / exitDur)
            : Math.min(1, elapsed / enterDur);
        const enterDone = elapsed > enterDur;

        const posClass = `mg-pos-${mg.position || 'center'}`;

        switch (mg.type) {
            case 'headline':
                return `<div class="mg-preview-element mg-headline ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-headline-text">${escapeHTML(mg.text)}</div>
                    <div class="mg-headline-bar" style="width:${enterDone ? 100 : Math.min(100, elapsed / enterDur * 100)}%"></div>
                    ${mg.subtext && mg.subtext !== 'none' ? `<div class="mg-headline-sub">${escapeHTML(mg.subtext)}</div>` : ''}
                </div>`;

            case 'lowerThird':
                return `<div class="mg-preview-element mg-lower-third ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-lt-accent"></div>
                    <div class="mg-lt-content">
                        <div class="mg-lt-text">${escapeHTML(mg.text)}</div>
                        ${mg.subtext && mg.subtext !== 'none' ? `<div class="mg-lt-sub">${escapeHTML(mg.subtext)}</div>` : ''}
                    </div>
                </div>`;

            case 'statCounter': {
                const numMatch = mg.text.match(/[\d,.]+/);
                const target = numMatch ? parseFloat(numMatch[0].replace(/,/g, '')) : 0;
                const countProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.4) / 1.0));
                const eased = 1 - Math.pow(1 - countProg, 3);
                const current = target % 1 !== 0
                    ? (target * eased).toFixed(1)
                    : Math.round(target * eased).toLocaleString();
                const prefix = mg.text.substring(0, mg.text.indexOf(numMatch?.[0] || '')).trim();
                const suffix = mg.text.substring(mg.text.indexOf(numMatch?.[0] || '') + (numMatch?.[0]?.length || 0)).trim();
                return `<div class="mg-preview-element mg-stat ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-stat-number">${escapeHTML(prefix)}${current}</div>
                    <div class="mg-stat-label">${escapeHTML(suffix || mg.subtext || '')}</div>
                </div>`;
            }

            case 'callout':
                return `<div class="mg-preview-element mg-callout ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-callout-box">
                        <span class="mg-callout-quote">\u201C</span>
                        <p class="mg-callout-text">${escapeHTML(mg.text)}</p>
                        ${mg.subtext && mg.subtext !== 'none' ? `<p class="mg-callout-attr">\u2014 ${escapeHTML(mg.subtext)}</p>` : ''}
                    </div>
                </div>`;

            case 'bulletList': {
                const items = mg.text.split(/[,;]|\d+\.\s/).map(s => s.trim()).filter(Boolean);
                const staggerDelay = 0.25;
                const bulletsHTML = items.map((item, i) => {
                    const itemOpacity = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * staggerDelay) / 0.3));
                    return `<div class="mg-bullet-item" style="opacity:${itemOpacity}">
                        <span class="mg-bullet-dot"></span>
                        <span>${escapeHTML(item)}</span>
                    </div>`;
                }).join('');
                return `<div class="mg-preview-element mg-bullets ${posClass}" style="${styleVars};opacity:${opacity}">
                    ${bulletsHTML}
                </div>`;
            }

            case 'focusWord': {
                const subHtml = mg.subtext && mg.subtext !== 'none'
                    ? `<div class="mg-focus-sub" style="opacity:${Math.min(1, Math.max(0, (elapsed - enterDur * 0.5) / 0.3))}">${escapeHTML(mg.subtext)}</div>` : '';
                return `<div class="mg-preview-element mg-focus-word ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-focus-scrim" style="opacity:${Math.min(1, elapsed / 0.15)}"></div>
                    <div class="mg-focus-text">${escapeHTML(mg.text)}</div>
                    ${subHtml}
                </div>`;
            }

            case 'progressBar': {
                const numMatch = mg.text.match(/[\d,.]+/);
                const targetPct = numMatch ? Math.min(100, parseFloat(numMatch[0].replace(/,/g, ''))) : 75;
                const label = mg.text.replace(/[\d,.]+%?/, '').trim() || mg.subtext || '';
                const fillProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.5) / 1.2));
                const fillEased = 1 - Math.pow(1 - fillProg, 3);
                const currentPct = Math.round(targetPct * fillEased);
                return `<div class="mg-preview-element mg-progress ${posClass}" style="${styleVars};opacity:${opacity}">
                    ${label ? `<div class="mg-progress-label">${escapeHTML(label)}</div>` : ''}
                    <div class="mg-progress-track"><div class="mg-progress-fill" style="width:${targetPct * fillEased}%"></div></div>
                    <div class="mg-progress-number">${currentPct}%</div>
                </div>`;
            }

            case 'barChart': {
                const items = parseKeyValuePairs(mg.subtext);
                const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
                const barsHTML = items.slice(0, 6).map((item, i) => {
                    const barProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.3 - i * 0.15) / 0.5));
                    const barEased = 1 - Math.pow(1 - barProg, 3);
                    const heightPct = ((parseFloat(item.value) || 0) / maxVal) * 100 * barEased;
                    return `<div class="mg-bar-col">
                        <div class="mg-bar-value" style="opacity:${Math.min(1, Math.max(0, barProg - 0.3))}">${escapeHTML(item.value)}</div>
                        <div class="mg-bar" style="height:${heightPct}%"></div>
                        <div class="mg-bar-label">${escapeHTML(item.label)}</div>
                    </div>`;
                }).join('');
                return `<div class="mg-preview-element mg-bar-chart ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-chart-title">${escapeHTML(mg.text)}</div>
                    <div class="mg-bars-container">${barsHTML}</div>
                </div>`;
            }

            case 'donutChart': {
                const items = parseKeyValuePairs(mg.subtext);
                const total = items.reduce((sum, i) => sum + (parseFloat(i.value) || 0), 0) || 100;
                const legendHTML = items.slice(0, 5).map((item, i) => {
                    const itemOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.5 - i * 0.12) / 0.2));
                    return `<div class="mg-donut-legend-item" style="opacity:${itemOp}">
                        <span class="mg-donut-dot" style="background:${i === 0 ? 'var(--mg-primary)' : 'var(--mg-accent)'}"></span>
                        ${escapeHTML(item.label)} ${escapeHTML(item.value)}%
                    </div>`;
                }).join('');
                let gradientStops = [];
                let cumPct = 0;
                const colors = ['var(--mg-primary)', 'var(--mg-accent)', 'rgba(255,255,255,0.3)', 'rgba(255,255,255,0.15)'];
                items.slice(0, 5).forEach((item, i) => {
                    const pct = (parseFloat(item.value) || 0) / total * 100;
                    const drawProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * 0.2) / 0.5));
                    const drawnPct = pct * (1 - Math.pow(1 - drawProg, 3));
                    gradientStops.push(`${colors[i % colors.length]} ${cumPct}% ${cumPct + drawnPct}%`);
                    cumPct += drawnPct;
                });
                gradientStops.push(`transparent ${cumPct}% 100%`);
                const conicGrad = `conic-gradient(from 0deg, ${gradientStops.join(', ')})`;
                return `<div class="mg-preview-element mg-donut-chart ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-chart-title">${escapeHTML(mg.text)}</div>
                    <div class="mg-donut-row">
                        <div class="mg-donut-ring" style="background:${conicGrad}"><div class="mg-donut-hole"></div></div>
                        <div class="mg-donut-legend">${legendHTML}</div>
                    </div>
                </div>`;
            }

            case 'comparisonCard': {
                const parts = mg.text.split(/\s+vs\.?\s+/i);
                const itemA = parts[0] || 'A';
                const itemB = parts[1] || 'B';
                const slideAmt = enterDone ? 0 : (1 - elapsed / enterDur) * 30;
                const vsProg = Math.min(1, Math.max(0, (elapsed - 0.3) / 0.3));
                return `<div class="mg-preview-element mg-comparison ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-comp-panel mg-comp-left" style="transform:translateX(${-slideAmt}px)">${escapeHTML(itemA)}</div>
                    <div class="mg-comp-vs" style="transform:scale(${vsProg})">VS</div>
                    <div class="mg-comp-panel mg-comp-right" style="transform:translateX(${slideAmt}px)">${escapeHTML(itemB)}</div>
                </div>`;
            }

            case 'timeline': {
                const items = parseKeyValuePairs(mg.subtext);
                const lineW = enterDone ? 100 : Math.min(100, elapsed / enterDur * 100);
                const markersHTML = items.slice(0, 5).map((item, i) => {
                    const pct = items.length > 1 ? (i / (items.length - 1)) * 100 : 50;
                    const mOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.3 - i * 0.25) / 0.25));
                    return `<div class="mg-tl-marker" style="left:${pct}%;opacity:${mOp}">
                        <div class="mg-tl-year">${escapeHTML(item.label)}</div>
                        <div class="mg-tl-dot"></div>
                        <div class="mg-tl-event">${escapeHTML(item.value)}</div>
                    </div>`;
                }).join('');
                return `<div class="mg-preview-element mg-timeline ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-chart-title">${escapeHTML(mg.text)}</div>
                    <div class="mg-tl-container">
                        <div class="mg-tl-line" style="width:${lineW}%"></div>
                        ${markersHTML}
                    </div>
                </div>`;
            }

            case 'rankingList': {
                const items = parseKeyValuePairs(mg.subtext);
                const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
                const rowsHTML = items.slice(0, 6).map((item, i) => {
                    const rowOp = Math.min(1, Math.max(0, (elapsed - enterDur * 0.2 - i * 0.18) / 0.25));
                    const barProg = Math.min(1, Math.max(0, (elapsed - enterDur * 0.35 - i * 0.18) / 0.5));
                    const barW = (1 - Math.pow(1 - barProg, 3)) * ((parseFloat(item.value) || 0) / maxVal) * 100;
                    return `<div class="mg-rank-row" style="opacity:${rowOp}">
                        <span class="mg-rank-num ${i === 0 ? 'mg-rank-top' : ''}">${i + 1}</span>
                        <div class="mg-rank-content">
                            <div class="mg-rank-header"><span>${escapeHTML(item.label)}</span><span class="mg-rank-val">${escapeHTML(item.value)}</span></div>
                            <div class="mg-rank-track"><div class="mg-rank-bar ${i === 0 ? 'mg-rank-bar-top' : ''}" style="width:${barW}%"></div></div>
                        </div>
                    </div>`;
                }).join('');
                return `<div class="mg-preview-element mg-ranking ${posClass}" style="${styleVars};opacity:${opacity}">
                    <div class="mg-chart-title">${escapeHTML(mg.text)}</div>
                    ${rowsHTML}
                </div>`;
            }

            case 'kineticText': {
                return buildKineticTextPreviewHtml(
                    mg,
                    mg,
                    styleVars,
                    fontH,
                    opacity,
                    elapsed,
                    enterDur,
                    posClass,
                    ''
                );
            }

            default:
                return '';
        }
    }).join('');

    if (html !== _mgLastHtml) {
        overlay.innerHTML = html;
        _mgLastHtml = html;
    }
}

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Hard-cut transition between clips (no animation).
 */
async function performTrackTransition(trackVideo, transOut, sceneIndex, newVideoUrl, scene) {
    if (!trackVideo) return;
    trackVideo.pause();
    trackVideo.src = newVideoUrl;
    trackVideo.load();
    const sceneTime = (state.currentTime - scene.startTime) + (scene.mediaOffset || 0);
    trackVideo.currentTime = sceneTime;
    trackVideo.volume = getSceneVolume(scene);
    trackVideo.muted = false;
    trackVideo.classList.remove('outgoing');
    trackVideo.classList.add('active');
    applySceneTransformToVideo(trackVideo, scene);
    if (transOut) { transOut.pause(); transOut.src = ''; }
    state.transition.isTransitioning = false;
    if (state.isPlaying) trackVideo.play().catch(() => { });
}

/**
 * Hard-cut transition between images (no animation).
 */
async function performImageTransition(trackImg, transOutImg, scene, newImgUrl) {
    if (!trackImg) return;
    trackImg.src = newImgUrl;
    updateKenBurnsTransform(trackImg, scene);
    trackImg.classList.remove('outgoing');
    trackImg.classList.add('active');
    state.transition.isTransitioning = false;
}

// Helper to reset video element to clean state
function resetVideoTransitionState(videoElement) {
    if (!videoElement) return;
    videoElement.classList.remove('active', 'outgoing', 'incoming');
    videoElement.style.opacity = '';
    videoElement.style.transform = '';
    videoElement.style.filter = '';
    videoElement.style.clipPath = '';
    videoElement.style.visibility = '';
}

// Simple scene jump (no visual effects)
async function simpleTransitionToScene(nextIndex, wasPlaying) {
    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
    elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach(video => {
        if (video && !video.paused) video.pause();
    });

    const nextScene = state.scenes[nextIndex];
    state.currentTime = nextScene.startTime;
    updateSceneHighlight(nextIndex);
    await loadActiveScenes();

    if (wasPlaying && state.isPlaying) {
        const activeScenes = getActiveScenesAtTime(state.currentTime);
        activeScenes.forEach(({ scene }) => {
            const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
            const video = getActiveTrackVideo(trackNum);
            if (video && video.src) video.play().catch(e => console.warn('Video play failed:', e));
        });
    }
}

// ========================================
// Resizable Panels
// ========================================
function setupResizablePanels() {
    setupPanelResize(elements.resizeLeft, 'left');
    setupPanelResize(elements.resizeRight, 'right');
    setupTimelineResize();
}

function setupPanelResize(handle, side) {
    if (!handle) return;
    let isDragging = false, startX = 0, startWidth = 0;
    handle.addEventListener('mousedown', (e) => {
        isDragging = true; startX = e.clientX;
        startWidth = (side === 'left' ? elements.leftPanel : elements.rightPanel).offsetWidth;
        document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const panel = side === 'left' ? elements.leftPanel : elements.rightPanel;
        const deltaX = e.clientX - startX;
        let newWidth = side === 'left' ? startWidth + deltaX : startWidth - deltaX;
        panel.style.width = `${Math.max(150, Math.min(400, newWidth))}px`;
    });
    document.addEventListener('mouseup', () => { if (isDragging) { isDragging = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; } });
}

function setupTimelineResize() {
    const handle = elements.resizeTimeline;
    if (!handle) return;

    const TL_MIN = 180;
    const TL_MAX = 600;
    const TL_STORAGE_KEY = 'yta.timelineHeight';

    // Restore persisted height on startup so layout doesn't reset every session
    try {
        const saved = parseInt(localStorage.getItem(TL_STORAGE_KEY), 10);
        if (Number.isFinite(saved) && saved >= TL_MIN && saved <= TL_MAX) {
            elements.timelineContainer.style.height = `${saved}px`;
        }
    } catch (_err) { /* localStorage may be unavailable */ }

    let isDragging = false, startY = 0, startHeight = 0;
    handle.addEventListener('mousedown', (e) => {
        isDragging = true; startY = e.clientY; startHeight = elements.timelineContainer.offsetHeight;
        document.body.style.cursor = 'row-resize'; document.body.style.userSelect = 'none'; e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
        if (!isDragging) return;
        const h = Math.max(TL_MIN, Math.min(TL_MAX, startHeight + startY - e.clientY));
        elements.timelineContainer.style.height = `${h}px`;
    });
    document.addEventListener('mouseup', () => {
        if (!isDragging) return;
        isDragging = false;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        // Persist final height
        try {
            const finalH = elements.timelineContainer.offsetHeight;
            if (Number.isFinite(finalH)) localStorage.setItem(TL_STORAGE_KEY, String(finalH));
        } catch (_err) { /* ignore */ }
    });
}

// ========================================
// Collapsible Panel Sections
// ========================================
function setupPanelSections() {
    document.querySelectorAll('.panel-section-header').forEach(header => {
        header.addEventListener('click', () => {
            const section = header.closest('.panel-section-collapsible');
            if (section) section.classList.toggle('collapsed');
        });
    });
}

// ========================================
// File Handling
// ========================================
function handleFileSelect(file) {
    if (!['.mp3', '.wav', 'audio/mpeg', 'audio/wav'].some(t => file.name.toLowerCase().endsWith(t) || file.type === t)) {
        showToast('Please select an MP3 or WAV file', 'error'); return;
    }
    // Use webUtils.getPathForFile for sandboxed Electron (file.path is unavailable in Electron 20+)
    const filePath = window.electronAPI?.getFilePath ? window.electronAPI.getFilePath(file) : (file.path || '');
    state.audioFile = { name: file.name, path: filePath };
    state.audioPath = filePath || file.name;
    elements.audioName.textContent = file.name;
    elements.audioInfo.classList.remove('hidden');
    elements.dropZone.style.display = 'none';
    elements.btnGenerate.disabled = false;
    showToast(`Audio loaded: ${file.name}`, 'success');
    loadAudioFile(filePath);
}

async function loadAudioFile(filePath) {
    if (!elements.previewAudio || !filePath) return;
    try {
        const audioUrl = window.electronAPI?.getFileUrl ? await window.electronAPI.getFileUrl(filePath) : filePath;
        if (audioUrl) {
            elements.previewAudio.src = audioUrl;
            elements.previewAudio.load();
            // Update totalDuration to include full audio length
            elements.previewAudio.addEventListener('loadedmetadata', () => {
                if (elements.previewAudio.duration && isFinite(elements.previewAudio.duration)) {
                    const scenesEnd = state.scenes.length > 0 ? Math.max(...state.scenes.map(s => s.endTime)) : 0;
                    state.totalDuration = Math.max(scenesEnd, elements.previewAudio.duration);
                    updateTimeDisplay();
                }
            }, { once: true });
        }
    } catch (e) { console.error('Failed to load audio:', e); }
}

function removeAudio() {
    state.audioFile = null; state.audioPath = null;
    elements.audioInfo.classList.add('hidden');
    elements.dropZone.style.display = 'block';
    elements.btnGenerate.disabled = true;
    elements.fileInput.value = '';
    clearScenes();
}

// ========================================
// Cancel Process
// ========================================
async function cancelProcess() {
    if (!state.isProcessing) return;
    elements.btnCancel.disabled = true;
    elements.btnCancel.textContent = 'Cancelling...';
    try {
        // Cancel WebGL2 export pipeline if active (direct-spawn FFmpeg in renderer)
        if (state.exportPipeline) {
            console.log('[Cancel] Cancelling WebGL2 export pipeline...');
            state.exportPipeline.cancel();
            // Pipeline cancel is synchronous (sets flag + kills process).
            // The frame loop will throw on next iteration, which renderVideo() catches.
            // Show feedback immediately — don't wait for IPC.
            stopTimer();
            updateProgress(0, '⛔ Export cancelled');
            showToast('Export cancelled', 'info');
        }
        // Also signal main process (for build processes, legacy exports)
        const result = await window.electronAPI?.cancelProcess();
        if (result?.success && !state.exportPipeline) {
            // Only show IPC cancel feedback if there was no pipeline cancel above
            stopTimer();
            updateProgress(0, `⛔ ${result.message || 'Cancelled'}`);
            showToast('Process cancelled', 'error');
        }
    } catch (e) {
        console.error('Cancel error:', e);
    } finally {
        elements.btnCancel.disabled = false;
        elements.btnCancel.textContent = 'Cancel';
        // Force-cleanup state after short delay if renderVideo() is stuck and never resolves
        setTimeout(() => {
            if (state.isProcessing) {
                console.warn('[Cancel] Force cleanup — render loop did not exit cleanly');
                state.isProcessing = false;
                state.exportPipeline = null;
                elements.btnRender.disabled = false;
                elements.btnCancel.disabled = false;
                elements.btnCancel.textContent = 'Cancel';
                // Restore compositor preview mode
                if (state.compositor) {
                    state.compositor._exporting = false;
                    state.compositor._restorePreviewResolution?.();
                }
                setTimeout(() => showProgress(false), 3000);
            }
        }, 2000);
    }
}

// ========================================
// Video Generation
// ========================================
async function generateVideo() {
    if (!state.audioFile || state.isProcessing) return;
    if (!state.audioFile.path) {
        showToast('Audio file path is missing. Please re-import the audio file.', 'error'); return;
    }
    state.isProcessing = true; elements.btnGenerate.disabled = true; showProgress(true); startTimer();
    try {
        updateProgress(5, '📁 Copying audio file...');
        const copyResult = await window.electronAPI?.copyFile(state.audioFile.path, 'input');
        if (copyResult && !copyResult.success) {
            throw new Error(`Failed to copy audio: ${copyResult.error}`);
        }
        updateProgress(10, '🎙️ Transcribing audio with Whisper...');
        const audioFileName = state.audioFile.name || state.audioFile.path?.split(/[\\/]/).pop();
        const result = await window.electronAPI.runBuild({
            aiProvider: elements.aiProvider.value,
            ollamaModel: elements.ollamaModel?.value || 'gemma3:12b',
            ollamaVisionModel: elements.ollamaVisionModel?.value || 'llava',
            transitionStyle: elements.transitionStyle.value,
            audioFileName,
            footageSources: getEnabledSources(),
            aiInstructions: state.aiInstructions,
            videoTitle: state.videoTitle,
            buildQuality: elements.buildQuality.value,
            buildFormat: elements.buildFormat.value,
            buildNiche: elements.buildNiche ? elements.buildNiche.value : 'auto',
            buildTheme: elements.buildTheme.value,
            buildLanguage: elements.buildLanguage ? elements.buildLanguage.value : 'auto',
            buildStyleProfile: elements.buildStyleProfile ? elements.buildStyleProfile.value : 'none',
            smartAI: elements.smartAiToggle ? elements.smartAiToggle.checked : true,
            clipAnalyzer: elements.clipAnalyzerToggle ? elements.clipAnalyzerToggle.checked : true,
            buildResume: elements.buildResumeToggle ? elements.buildResumeToggle.checked : false,
            aiThinking: elements.aiThinking ? elements.aiThinking.value : 'off'
        });
        if (result.success) {
            updateProgress(90, '📋 Loading video plan...'); await loadVideoPlan({ freshBuild: true });
            state.hasProjectFile = true; // Enable auto-save for the new plan
            saveProject(true); // Save .fvp with the fresh build data
            stopTimer();
            const genTime = getElapsedString();
            updateProgress(100, `✅ Ready to render! (${genTime})`); showToast(`Video generated in ${genTime}!`, 'success');
            showNotification('Generation Complete', `Video generated in ${genTime}`);
            elements.btnRender.disabled = false;
            if (state.scenes.length > 0) await jumpToScene(0);
        } else {
            const errorMsg = result.error || 'Build failed';
            if (errorMsg === 'Cancelled') {
                stopTimer(); updateProgress(0, '⛔ Generation cancelled'); showToast('Generation cancelled', 'info'); showNotification('Generation Cancelled', `Stopped after ${getElapsedString()}`, 'cancel');
            } else {
                throw new Error(errorMsg);
            }
        }
    } catch (error) { console.error('❌ Generation error:', error); stopTimer(); showToast(`Error: ${error.message}`, 'error'); }
    finally { state.isProcessing = false; elements.btnGenerate.disabled = false; elements.btnCancel.disabled = false; elements.btnCancel.textContent = 'Cancel'; setTimeout(() => showProgress(false), 5000); }
}

// ========================================
// Video Plan & Scenes
// ========================================
async function loadVideoPlan({ freshBuild = false } = {}) {
    try {
        // Try loading from .fvp project file first (unified save with settings)
        // BUT skip .fvp after a fresh build — it has stale data from the previous build
        let plan = null;
        let fvpSettings = null;
        if (!freshBuild && window.electronAPI.loadProjectFile) {
            console.log('[loadVideoPlan] Attempting .fvp load...');
            const projectData = await window.electronAPI.loadProjectFile();
            if (projectData && projectData.videoPlan) {
                plan = projectData.videoPlan;
                fvpSettings = projectData.settings || null;
                state.hasProjectFile = true;
                console.log(`✅ Loaded from .fvp project file (${plan.scenes?.length || 0} scenes)`);
            } else {
                console.warn('[loadVideoPlan] .fvp returned no videoPlan:', projectData ? Object.keys(projectData) : 'null');
            }
        }

        // Load from video-plan.json (always used after fresh build, fallback otherwise)
        if (!plan) {
            console.log('[loadVideoPlan] Falling back to video-plan.json...');
            plan = await window.electronAPI.loadVideoPlan();
            if (plan) {
                console.log(`✅ Loaded from video-plan.json (${plan.scenes?.length || 0} scenes)`);
            } else {
                console.warn('[loadVideoPlan] video-plan.json also returned null');
            }
        }

        if (plan) {
            // Restore editor settings from .fvp if available
            if (fvpSettings) {
                applyProjectSettings(fvpSettings);
            }

            state.videoPlan = plan;
            window._mgBridgeVideoPlan = plan;
            state._mediaUrlCache = {}; // Clear media URL cache on new plan load
            state._trackActiveEl = { '1': 'a', '2': 'a', '3': 'a' }; // Reset double-buffer state
            state._trackSwapPending = { '1': false, '2': false, '3': false }; // Reset deferred swaps
            // Clear _loadedUrl on all buffer elements
            [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
            elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach(v => {
                if (v) { v._loadedUrl = null; v.src = ''; }
            });

            // Check if this is a saved project (scenes already have trackId = edited by user)
            const isSavedProject = plan.scenes.length > 0 && plan.scenes[0].trackId;

            if (isSavedProject) {
                // Restore scenes as-is (user already edited the layout)
                state.scenes = plan.scenes.map(s => ({
                    ...s,
                    trackId: s.trackId || 'video-track-1'
                }));
                state.totalDuration = plan.totalDuration || Math.max(...state.scenes.map(s => s.endTime));
            } else {
                // Fresh build - keep original timestamps, expand scenes to fill gaps
                // Route images to video-track-2, videos stay on video-track-1
                const processedScenes = [];

                for (let i = 0; i < plan.scenes.length; i++) {
                    const scene = plan.scenes[i];
                    const nextScene = plan.scenes[i + 1];

                    // Extend this scene's endTime to fill gap before next scene
                    let endTime = scene.endTime;
                    if (nextScene && nextScene.startTime > scene.endTime) {
                        endTime = nextScene.startTime;
                    }

                    // Respect existing trackId (set by compositor planner for V2 overlays)
                    // Regular footage (both images and videos) stays on track 1
                    const trackId = scene.trackId || 'video-track-1';

                    processedScenes.push({
                        ...scene,
                        originalStartTime: scene.startTime,
                        originalEndTime: scene.endTime,
                        startTime: scene.startTime,
                        endTime: endTime,
                        trackId: trackId
                    });
                }

                state.scenes = processedScenes;
                state.totalDuration = plan.totalDuration || (processedScenes.length > 0 ? processedScenes[processedScenes.length - 1].endTime : 0);
            }

            state.currentTime = 0;

            if (plan.audio) {
                try {
                    const audioPath = await window.electronAPI.getAudioPath?.(plan.audio);
                    if (audioPath) {
                        state.audioPath = audioPath;
                        state.audioFile = { name: plan.audio, path: audioPath };
                        elements.audioName.textContent = plan.audio;
                        elements.audioInfo.classList.remove('hidden');
                        elements.dropZone.style.display = 'none';
                        elements.btnGenerate.disabled = false;
                        await loadAudioFile(audioPath);
                    }
                } catch (e) { console.warn('Audio loading failed:', e.message); }
            }

            // Enable render button if we have scenes
            if (state.scenes.length > 0) {
                elements.btnRender.disabled = false;
            }

            // Transitions disabled - hard cut only, skip planned transitions

            // Generate SFX for scene change points
            try { generateSfxClips(); } catch (e) { console.warn('SFX generation failed:', e.message); }

            // Load motion graphics from plan
            // Full-screen types (barChart, donutChart, etc.) go on V3 as scene objects
            try {
            const FULLSCREEN_MG_TYPES = new Set(['barChart', 'donutChart', 'rankingList', 'timeline', 'comparisonCard', 'bulletList', 'mapChart', 'articleHighlight', 'listicleGrid']);
            const allMGs = plan.motionGraphics || [];
            // Explainer always stays as overlay MG (never fullscreen V3 scene)
            state.motionGraphics = allMGs.filter(mg => !FULLSCREEN_MG_TYPES.has(mg.type));
            state.mgStyle = plan.mgStyle || 'clean';
            _hydrateMgOverlayShadow(plan);

            // Resolve explainer image URLs for overlay MGs
            _resolveExplainerUrls(state.motionGraphics);

            // Load full-screen MGs onto V3 (from mgScenes, templateScenes, or classified from motionGraphics)
            const fullscreenMGs = [
                ...(plan.mgScenes || []),
                ...(plan.templateScenes || []),
                ...allMGs.filter(mg => FULLSCREEN_MG_TYPES.has(mg.type))
            ];
            // Deduplicate (in case both mgScenes and motionGraphics have the same MG)
            const seenIds = new Set();
            for (const mg of fullscreenMGs) {
                const key = mg.id || `${mg.type}-${mg.startTime}`;
                if (seenIds.has(key)) continue;
                seenIds.add(key);
                // Strip nested mgData to avoid recursive bloat in saved plans
                const { mgData: _nested, ...mgFlat } = mg;
                // Resolve deeply nested mgData to get the actual core data
                let core = mg;
                while (core.mgData) core = core.mgData;
                const sceneObj = {
                    isMGScene: true,
                    trackId: 'video-track-3',
                    mediaType: mg.templateType ? 'template' : 'motion-graphic',
                    startTime: mg.startTime,
                    endTime: mg.endTime || (mg.startTime + mg.duration),
                    duration: Math.round((mg.duration || (mg.endTime - mg.startTime)) * 30),
                    text: mg.text || '',
                    subtext: mg.subtext || mg.subText || '',
                    type: mg.type,
                    position: mg.position || 'center',
                    style: mg.style || state.mgStyle || 'clean',
                    keyword: mg.templateType ? `Template: ${mg.type}` : `MG: ${mg.type}`,
                    mgData: core === mg ? mgFlat : core,
                };
                if (mg.templateType) sceneObj.templateType = true;
                if (mg.variant) sceneObj.variant = mg.variant;
                if (mg.animation) sceneObj.animation = mg.animation;
                if (mg.themeId) sceneObj.themeId = mg.themeId;
                if (mg.items) sceneObj.items = mg.items;
                if (mg.mapStyle) sceneObj.mapStyle = mg.mapStyle;
                // Propagate article image properties for image mode
                if (core.articleImageFile) {
                    sceneObj.articleImageFile = core.articleImageFile;
                    if (sceneObj.mgData) sceneObj.mgData.articleImageFile = core.articleImageFile;
                }
                if (core.highlightBoxes) {
                    sceneObj.highlightBoxes = core.highlightBoxes;
                    if (sceneObj.mgData) sceneObj.mgData.highlightBoxes = core.highlightBoxes;
                }
                // Propagate map image properties
                if (core.mapImageFile) {
                    sceneObj.mapImageFile = core.mapImageFile;
                    if (sceneObj.mgData) sceneObj.mgData.mapImageFile = core.mapImageFile;
                }
                if (core._mapView) {
                    sceneObj._mapView = core._mapView;
                    if (sceneObj.mgData) sceneObj.mgData._mapView = core._mapView;
                }
                if (core._mapPins) {
                    sceneObj._mapPins = core._mapPins;
                    if (sceneObj.mgData) sceneObj.mgData._mapPins = core._mapPins;
                }
                if (core._mapWaypoints) {
                    sceneObj._mapWaypoints = core._mapWaypoints;
                    if (sceneObj.mgData) sceneObj.mgData._mapWaypoints = core._mapWaypoints;
                }
                if (core._bigMapSize) {
                    sceneObj._bigMapSize = core._bigMapSize;
                    if (sceneObj.mgData) sceneObj.mgData._bigMapSize = core._bigMapSize;
                }
                if (core._wpCoords) {
                    sceneObj._wpCoords = core._wpCoords;
                    if (sceneObj.mgData) sceneObj.mgData._wpCoords = core._wpCoords;
                }
                if (core._mapBigMap) {
                    sceneObj._mapBigMap = core._mapBigMap;
                    if (sceneObj.mgData) sceneObj.mgData._mapBigMap = core._mapBigMap;
                }
                if (core._osmBoundaries) {
                    sceneObj._osmBoundaries = core._osmBoundaries;
                    if (sceneObj.mgData) sceneObj.mgData._osmBoundaries = core._osmBoundaries;
                }
                if (core._mapIcons) {
                    sceneObj._mapIcons = core._mapIcons;
                    if (sceneObj.mgData) sceneObj.mgData._mapIcons = core._mapIcons;
                }
                // Phase B prep: authoritative MapScene (subjects, cameraPlan,
                // annotationPlan, geometry, renderAssets). Renderer will consume
                // this directly once the legacy per-field lookups are retired.
                if (core._mapScene) {
                    sceneObj._mapScene = core._mapScene;
                    if (sceneObj.mgData) sceneObj.mgData._mapScene = core._mapScene;
                }
                // Pre-resolve map image URL for preview
                if (core.mapImageFile && window.electronAPI?.getProjectInfo && window.electronAPI?.getFileUrl) {
                    window.electronAPI.getProjectInfo().then(async (info) => {
                        const mapPath = info.projectDir + '/public/' + core.mapImageFile;
                        const url = await window.electronAPI.getFileUrl(mapPath);
                        if (url) {
                            sceneObj._mapImageUrl = url;
                            if (sceneObj.mgData) sceneObj.mgData._mapImageUrl = url;
                        }
                    }).catch(() => { });
                }
                // Propagate explainer image properties
                if (core.explainerImageFile) {
                    sceneObj.explainerImageFile = core.explainerImageFile;
                    if (sceneObj.mgData) sceneObj.mgData.explainerImageFile = core.explainerImageFile;
                }
                if (core.explainerLabel) {
                    sceneObj.explainerLabel = core.explainerLabel;
                    if (sceneObj.mgData) sceneObj.mgData.explainerLabel = core.explainerLabel;
                }
                // Pre-resolve explainer image URL for preview
                if (core.explainerImageFile && window.electronAPI?.getProjectInfo && window.electronAPI?.getFileUrl) {
                    window.electronAPI.getProjectInfo().then(async (info) => {
                        const imgPath = info.projectDir + '/public/' + core.explainerImageFile;
                        const url = await window.electronAPI.getFileUrl(imgPath);
                        if (url) {
                            sceneObj._explainerImageUrl = url;
                            if (sceneObj.mgData) sceneObj.mgData._explainerImageUrl = url;
                        }
                    }).catch(() => { });
                }
                // Propagate listicle grid data (items + thumbnails)
                if (core._listicleItems) {
                    sceneObj._listicleItems = core._listicleItems;
                    if (sceneObj.mgData) sceneObj.mgData._listicleItems = core._listicleItems;
                }
                if (core._itemThumbnails) {
                    sceneObj._itemThumbnails = core._itemThumbnails;
                    if (sceneObj.mgData) sceneObj.mgData._itemThumbnails = core._itemThumbnails;
                    // Pre-resolve thumbnail URLs via Electron IPC
                    // Template item images (tpl-item-*) are in public/, listicle thumbs use getFileUrl directly
                    const isTemplateItems = core._itemThumbnails.some(t => t && t.startsWith('tpl-item-'));
                    if (isTemplateItems && window.electronAPI?.getProjectInfo && window.electronAPI?.getFileUrl) {
                        window.electronAPI.getProjectInfo().then(async (info) => {
                            const urls = await Promise.all(core._itemThumbnails.map(async (thumbFile) => {
                                if (!thumbFile) return null;
                                try {
                                    const fullPath = info.projectDir + '/public/' + thumbFile;
                                    return await window.electronAPI.getFileUrl(fullPath);
                                } catch { return null; }
                            }));
                            sceneObj._itemThumbnailUrls = urls;
                            if (sceneObj.mgData) sceneObj.mgData._itemThumbnailUrls = urls;
                        }).catch(() => { });
                    } else if (window.electronAPI?.getFileUrl) {
                        Promise.all(core._itemThumbnails.map(async (thumbPath) => {
                            if (!thumbPath) return null;
                            try { return await window.electronAPI.getFileUrl(thumbPath); } catch { return null; }
                        })).then(urls => {
                            sceneObj._itemThumbnailUrls = urls;
                            if (sceneObj.mgData) sceneObj.mgData._itemThumbnailUrls = urls;
                        }).catch(() => { });
                    }
                }
                // Pre-resolve article image URL for preview
                if (core.articleImageFile && window.electronAPI?.getSceneMediaPath) {
                    const ext = core.articleImageFile.match(/\.\w+$/)?.[0] || '.jpg';
                    window.electronAPI.getSceneMediaPath(0, ext, 'article').then(async (filePath) => {
                        if (filePath && window.electronAPI.getFileUrl) {
                            const url = await window.electronAPI.getFileUrl(filePath);
                            sceneObj._articleImageUrl = url;
                            if (sceneObj.mgData) sceneObj.mgData._articleImageUrl = url;
                        }
                    }).catch(() => { });
                }
                // Propagate template background image properties
                if (core.templateBgFile) {
                    sceneObj.templateBgFile = core.templateBgFile;
                    if (sceneObj.mgData) sceneObj.mgData.templateBgFile = core.templateBgFile;
                }
                // Pre-resolve template background image URL
                if (core.templateBgFile && window.electronAPI?.getProjectInfo && window.electronAPI?.getFileUrl) {
                    window.electronAPI.getProjectInfo().then(async (info) => {
                        const bgPath = info.projectDir + '/public/' + core.templateBgFile;
                        const url = await window.electronAPI.getFileUrl(bgPath);
                        if (url) {
                            sceneObj._templateBgUrl = url;
                            if (sceneObj.mgData) sceneObj.mgData._templateBgUrl = url;
                        }
                    }).catch(() => { });
                }
                // Propagate template media file (video/image from underlying scene)
                if (core.templateMediaFile) {
                    sceneObj.templateMediaFile = core.templateMediaFile;
                    sceneObj.templateMediaOffset = core.templateMediaOffset || 0;
                    if (sceneObj.mgData) {
                        sceneObj.mgData.templateMediaFile = core.templateMediaFile;
                        sceneObj.mgData.templateMediaOffset = core.templateMediaOffset || 0;
                    }
                }
                // Pre-resolve template media URL and preload the media element
                if (core.templateMediaFile && window.electronAPI?.getFileUrl) {
                    window.electronAPI.getFileUrl(core.templateMediaFile).then(url => {
                        if (url) {
                            sceneObj._templateMediaUrl = url;
                            if (sceneObj.mgData) sceneObj.mgData._templateMediaUrl = url;
                            // Preload media now so it's ready before user seeks to it
                            _preloadTemplateMedia(core.templateMediaFile, url, core.templateMediaOffset || 0);
                        }
                    }).catch(() => { });
                }
                state.scenes.push(sceneObj);
            }
            // Carve out V2 scenes that overlap with full-screen MGs
            // Full-screen MGs ARE the visual — no footage underneath
            if (seenIds.size > 0) {
                const mgRanges = state.scenes
                    .filter(s => s.isMGScene)
                    .map(s => ({ start: s.startTime, end: s.endTime }));
                const carved = [];
                for (const scene of state.scenes) {
                    if (scene.isMGScene) {
                        carved.push(scene);
                        continue;
                    }
                    let parts = [{ start: scene.startTime, end: scene.endTime }];
                    for (const range of mgRanges) {
                        const next = [];
                        for (const p of parts) {
                            if (range.start >= p.end || range.end <= p.start) {
                                next.push(p);
                            } else if (range.start <= p.start && range.end >= p.end) {
                                // fully covered — remove
                            } else if (range.start > p.start && range.end < p.end) {
                                next.push({ start: p.start, end: range.start });
                                next.push({ start: range.end, end: p.end });
                            } else if (range.start <= p.start) {
                                next.push({ start: range.end, end: p.end });
                            } else {
                                next.push({ start: p.start, end: range.start });
                            }
                        }
                        parts = next;
                    }
                    for (const p of parts) {
                        if (p.end - p.start < 0.3) continue;
                        const trimmed = { ...scene };
                        const offset = p.start - scene.startTime;
                        trimmed.startTime = p.start;
                        trimmed.endTime = p.end;
                        if (offset > 0) {
                            trimmed.mediaOffset = (scene.mediaOffset || 0) + offset;
                        }
                        carved.push(trimmed);
                    }
                }
                state.scenes = carved;
                console.log(`Loaded ${seenIds.size} full-screen MGs onto V3 (carved gaps in V2)`);
            }
            } catch (mgError) {
                console.warn('MG/overlay loading failed (scenes still OK):', mgError.message);
            }

            renderScenes();
            renderTimeline();

            // Pre-cache ALL scene media URLs upfront so playback never waits for IPC
            console.log(`[PreCache] Pre-caching media URLs for ${state.scenes.length} scenes...`);
            const cachePromises = state.scenes
                .filter(s => !s.isMGScene)
                .map(async (scene, i) => {
                    // V2 overlay scenes have mediaFile — cache their URL directly
                    if (scene.mediaFile) {
                        const url = await window.electronAPI.getFileUrl(scene.mediaFile).catch(() => null);
                        if (url) {
                            const cacheKey = `${scene.index}:${scene.mediaExtension || ''}:scene`;
                            state._mediaUrlCache[cacheKey] = url;
                            return url;
                        }
                    }
                    const idx = scene.index !== undefined ? scene.index : i;
                    return getCachedMediaUrl(idx, scene.mediaExtension).catch(() => null);
                });
            await Promise.all(cachePromises);
            console.log(`[PreCache] Done. Cached ${Object.keys(state._mediaUrlCache).length} URLs`);

            // Load plan into WebGL2 compositor if it's initialized
            if (state.compositor) {
                loadPlanIntoCompositor().catch(e => console.warn('[Compositor] Plan load deferred:', e.message));
            }

            // Pre-buffer the SECOND video scene into the buffer element for instant first transition
            preloadUpcomingScenes(0, true);
        }
    } catch (error) {
        console.error('❌ Failed to load video plan:', error?.message || error, error?.stack);
    }
}

// ========================================
// Test Plan Loader (DevTools: window._loadTestPlan or paste one-liner)
// ========================================
window._loadTestPlan = async function(plan) {
    if (!plan) {
        // Load from public/test-mg-plan.json via Node fs (preload globals)
        try {
            const _fs = window._nodeFs;
            const _path = window._nodePath;
            // Resolve public/ dir relative to the app root (ui/ is one level down)
            const htmlDir = decodeURIComponent(location.pathname.replace(/^\/([A-Z]:)/, '$1')).replace(/\/[^/]*$/, '');
            const publicDir = _path.join(htmlDir, '..', 'public');
            const testPath = _path.join(publicDir, 'test-mg-plan.json');
            const data = _fs.readFileSync(testPath, 'utf8');
            plan = JSON.parse(data);
        } catch (e) {
            console.error('Failed to load test-mg-plan.json:', e.message);
            return;
        }
    }
    state.videoPlan = plan;
    window._mgBridgeVideoPlan = plan; // sync with mg-theme-bridge.js for MG style resolution
    state._mediaUrlCache = {};
    state.scenes = [];
    state.motionGraphics = [];

    const FULLSCREEN_MG_TYPES = new Set(['barChart', 'donutChart', 'rankingList', 'timeline', 'comparisonCard', 'bulletList', 'mapChart', 'articleHighlight']);
    const allMGs = plan.motionGraphics || [];
    state.motionGraphics = allMGs.filter(mg => !FULLSCREEN_MG_TYPES.has(mg.type));
    state.mgStyle = plan.mgStyle || 'clean';
    _hydrateMgOverlayShadow(plan);

    // Resolve explainer image URLs for overlay MGs
    _resolveExplainerUrls(state.motionGraphics);

    // Process regular scenes
    let nextIndex = 0;
    for (const s of (plan.scenes || [])) {
        const scene = { ...s };
        scene.index = scene.index !== undefined ? scene.index : nextIndex;
        scene.trackId = scene.trackId || 'video-track-1';
        if (!scene.mediaType) scene.mediaType = 'video';
        state.scenes.push(scene);
        nextIndex = Math.max(nextIndex, scene.index + 1);
    }

    // Process fullscreen MG scenes (includes templates from ai-templates.js)
    const fullscreenMGs = [
        ...(plan.mgScenes || []),
        ...(plan.templateScenes || []),
        ...allMGs.filter(mg => FULLSCREEN_MG_TYPES.has(mg.type))
    ];
    for (const mg of fullscreenMGs) {
        const scene = {
            ...mg,
            index: mg.index !== undefined ? mg.index : nextIndex++,
            isMGScene: true,
            mediaType: 'motion-graphic',
            trackId: mg.trackId || 'video-track-3',
        };
        state.scenes.push(scene);
    }

    state.currentTime = 0;
    _cachedPlayhead = null; _cachedTimelineScroll = null; _cachedTimelineTime = null;
    renderTimeline();
    updateClipProperties();
    console.log(`✅ Test plan loaded: ${state.scenes.length} scenes, ${state.motionGraphics.length} overlay MGs`);

    // Pre-cache media URLs for video scenes
    for (const s of state.scenes) {
        if (s.mediaType === 'video' && s.mediaExtension) {
            await getCachedMediaUrl(s.index, s.mediaExtension).catch(() => null);
        }
    }

    // Load into legacy preview
    if (state.scenes.length > 0) {
        await jumpToScene(0);
    }

    if (state.compositor) {
        await loadPlanIntoCompositor();
        console.log('✅ Compositor plan reloaded');
    }
};

// ========================================
// SFX Auto-Placement System
// ========================================
const SFX_MAP = {
    // === Smooth / Cinematic ===
    fade:           { file: 'sfx-fade.mp3', duration: 0.5 },
    fade_to_black:  { file: 'sfx-fade.mp3', duration: 0.4 },
    dissolve:       { file: 'sfx-dissolve.mp3', duration: 0.5 },
    crossfade:      { file: 'sfx-fade.mp3', duration: 0.5 },
    blur:           { file: 'sfx-blur.mp3', duration: 0.5 },
    crossBlur:      { file: 'sfx-blur.mp3', duration: 0.5 },
    luma:           { file: 'sfx-fade.mp3', duration: 0.5 },
    lumaFade:       { file: 'sfx-fade.mp3', duration: 0.5 },
    lumaDark:       { file: 'sfx-fade.mp3', duration: 0.5 },
    ripple:         { file: 'sfx-ripple.mp3', duration: 0.7 },
    reveal:         { file: 'sfx-ink.mp3', duration: 0.6 },
    morph:          { file: 'sfx-blur.mp3', duration: 0.5 },
    dreamFade:      { file: 'sfx-fade.mp3', duration: 0.5 },
    colorFade:      { file: 'sfx-fade.mp3', duration: 0.5 },
    filmBurn:       { file: 'sfx-filmburn.mp3', duration: 0.6 },
    filmGrain:      { file: 'sfx-filmburn.mp3', duration: 0.6 },
    ink:            { file: 'sfx-ink.mp3', duration: 0.6 },
    // === Energetic / Dynamic ===
    slide:          { file: 'sfx-slide.mp3', duration: 0.4 },
    wipe:           { file: 'sfx-wipe.mp3', duration: 0.3 },
    push:           { file: 'sfx-slide.mp3', duration: 0.4 },
    swipe:          { file: 'sfx-wipe.mp3', duration: 0.3 },
    splitWipe:      { file: 'sfx-wipe.mp3', duration: 0.3 },
    shutterSlice:   { file: 'sfx-shutter.mp3', duration: 0.3 },
    bounce:         { file: 'sfx-bounce.mp3', duration: 0.4 },
    // === Zoom ===
    zoom:           { file: 'sfx-zoom.mp3', duration: 0.5 },
    zoomBlur:       { file: 'sfx-zoom.mp3', duration: 0.5 },
    zoomOut:        { file: 'sfx-zoom.mp3', duration: 0.5 },
    zoomRotate:     { file: 'sfx-spin.mp3', duration: 0.6 },
    // === Camera Motion ===
    panLeft:        { file: 'sfx-pan.mp3', duration: 0.4 },
    panRight:       { file: 'sfx-pan.mp3', duration: 0.4 },
    panUp:          { file: 'sfx-pan.mp3', duration: 0.4 },
    panDown:        { file: 'sfx-pan.mp3', duration: 0.4 },
    whip:           { file: 'sfx-whip.mp3', duration: 0.3 },
    whipPan:        { file: 'sfx-whip.mp3', duration: 0.3 },
    directionalBlur:{ file: 'sfx-whip.mp3', duration: 0.3 },
    spin:           { file: 'sfx-spin.mp3', duration: 0.6 },
    // === Light Leaks ===
    flash:          { file: 'sfx-flash.mp3', duration: 0.3 },
    cameraFlash:    { file: 'sfx-camera-flash.mp3', duration: 0.3 },
    flare:          { file: 'sfx-flare.mp3', duration: 0.6 },
    lightLeak:      { file: 'sfx-flare.mp3', duration: 0.6 },
    warmLeak:       { file: 'sfx-warm-leak.mp3', duration: 0.6 },
    coolLeak:       { file: 'sfx-cool-leak.mp3', duration: 0.6 },
    vignetteBlink:  { file: 'sfx-camera-flash.mp3', duration: 0.3 },
    shadowWipe:     { file: 'sfx-wipe.mp3', duration: 0.3 },
    prismShift:     { file: 'sfx-prism.mp3', duration: 0.5 },
    // === Glitch / Tech ===
    glitch:         { file: 'sfx-glitch.mp3', duration: 0.4 },
    pixelate:       { file: 'sfx-glitch.mp3', duration: 0.4 },
    mosaic:         { file: 'sfx-glitch.mp3', duration: 0.4 },
    dataMosh:       { file: 'sfx-glitch.mp3', duration: 0.4 },
    scanline:       { file: 'sfx-static.mp3', duration: 0.5 },
    rgbSplit:       { file: 'sfx-glitch.mp3', duration: 0.4 },
    static:         { file: 'sfx-static.mp3', duration: 0.5 },
    // === Shapes ===
    diagonalStripes:{ file: 'sfx-wipe.mp3', duration: 0.3 },
    rectangles:     { file: 'sfx-shutter.mp3', duration: 0.3 },
    diamonds:       { file: 'sfx-diamond.mp3', duration: 0.4 },
    blinds:         { file: 'sfx-blinds.mp3', duration: 0.4 },
    circles:        { file: 'sfx-fade.mp3', duration: 0.5 },
};

// MG type -> SFX mapping
const MG_SFX_MAP = {
    headline:       { file: 'sfx-mg-pop.mp3', duration: 0.25 },
    lowerThird:     { file: 'sfx-mg-swoosh.mp3', duration: 0.35 },
    callout:        { file: 'sfx-mg-swoosh.mp3', duration: 0.35 },
    focusWord:      { file: 'sfx-mg-pop.mp3', duration: 0.25 },
    statCounter:    { file: 'sfx-mg-tick.mp3', duration: 0.15 },
    progressBar:    { file: 'sfx-mg-tick.mp3', duration: 0.15 },
    bulletList:     { file: 'sfx-mg-pop.mp3', duration: 0.25 },
    barChart:       { file: 'sfx-mg-ding.mp3', duration: 0.4 },
    donutChart:     { file: 'sfx-mg-ding.mp3', duration: 0.4 },
    comparisonCard: { file: 'sfx-mg-ding.mp3', duration: 0.4 },
    timeline:       { file: 'sfx-mg-rise.mp3', duration: 0.5 },
    rankingList:    { file: 'sfx-mg-rise.mp3', duration: 0.5 },
    kineticText:    { file: 'sfx-mg-type.mp3', duration: 0.2 },
    typewriter:     { file: 'sfx-mg-type.mp3', duration: 0.3 },
    subscribeCTA:   { file: 'sfx-mg-chime.mp3', duration: 0.5 },
    mapChart:        { file: 'sfx-mg-ding.mp3', duration: 0.4 },
    explainer:       { file: 'sfx-mg-swoosh.mp3', duration: 0.35 },
    listicleCounter: { file: 'sfx-mg-tick.mp3', duration: 0.15 },
    progressTracker: { file: 'sfx-mg-tick.mp3', duration: 0.15 },
    // Template types (fullscreen MG scenes)
    splitScreen:     { file: 'sfx-mg-swoosh.mp3', duration: 0.35 },
    infographic:     { file: 'sfx-mg-ding.mp3', duration: 0.4 },
    factCard:        { file: 'sfx-mg-pop.mp3', duration: 0.25 },
    statCard:        { file: 'sfx-mg-ding.mp3', duration: 0.4 },
    personIntro:     { file: 'sfx-mg-swoosh.mp3', duration: 0.35 },
    imageShowcase:   { file: 'sfx-mg-pop.mp3', duration: 0.25 },
    listicleGrid:    { file: 'sfx-mg-pop.mp3', duration: 0.25 },
    chapterCard:     { file: 'sfx-mg-swoosh.mp3', duration: 0.35 },
    locationCard:    { file: 'sfx-mg-swoosh.mp3', duration: 0.35 },
    quoteCard:       { file: 'sfx-mg-rise.mp3', duration: 0.5 },
    keyTakeaway:     { file: 'sfx-mg-ding.mp3', duration: 0.4 },
    timelineCard:    { file: 'sfx-mg-rise.mp3', duration: 0.5 },
};

function applySfxVolumeLevels() {
    for (const sfx of (state.sfxClips || [])) {
        const mult = typeof sfx.volumeMultiplier === 'number' ? sfx.volumeMultiplier : 1;
        sfx.volume = +(state.sfxVolume * mult).toFixed(4);
    }
}

function generateSfxClips() {
    if (!state.sfxEnabled) {
        state.sfxClips = [];
        return;
    }

    const clips = [];

    // Group scenes by track — only video tracks get transition SFX
    const trackGroups = {};
    state.scenes.forEach((scene, idx) => {
        if (scene.isMGScene) return; // Skip MG scenes
        const trackId = scene.trackId || 'video-track-1';
        if (!trackId.startsWith('video-track-')) return; // Only video tracks
        if (!trackGroups[trackId]) trackGroups[trackId] = [];
        trackGroups[trackId].push({ scene, idx });
    });

    // For each track, find adjacent scene boundaries (transition points)
    for (const trackId of Object.keys(trackGroups)) {
        const trackScenes = trackGroups[trackId].sort((a, b) => a.scene.startTime - b.scene.startTime);

        for (let i = 1; i < trackScenes.length; i++) {
            const prev = trackScenes[i - 1];
            const curr = trackScenes[i];

            // Check if scenes are adjacent (gap < 0.1s = transition point)
            const gap = curr.scene.startTime - prev.scene.endTime;
            if (Math.abs(gap) > 0.1) continue;

            // Resolve transition type: per-scene override > global force > AI-assigned > fallback
            let transType = curr.scene.transitionType
                || (state.transition.style !== 'auto' ? state.transition.style : null)
                || curr.scene.transition?.type
                || 'crossfade';
            if (transType === 'random') {
                const seed = curr.idx * 7 + 3;
                transType = state.transition.types[seed % state.transition.types.length];
            }

            // No SFX for cuts
            if (transType === 'cut') continue;

            const sfxInfo = SFX_MAP[transType] || SFX_MAP['fade'];

            // Start SFX before the transition point (150ms pre-roll for better sync)
            const preRoll = 0.15;
            const startTime = Math.max(0, curr.scene.startTime - preRoll);

            clips.push({
                id: `sfx-${clips.length}`,
                transitionType: transType,
                sceneIndex: curr.idx,
                startTime: startTime,
                duration: sfxInfo.duration,
                volumeMultiplier: 1,
                volume: state.sfxVolume,
                file: sfxInfo.file
            });
        }
    }

    // MG SFX — trigger on MG enter (overlay MGs)
    if (state.motionGraphics && state.motionGraphics.length > 0) {
        state.motionGraphics.forEach((mg, i) => {
            if (mg.disabled) return;
            const mgSfx = MG_SFX_MAP[mg.type];
            if (!mgSfx) return;
            clips.push({
                id: `sfx-mg-${i}`,
                transitionType: mg.type,
                sceneIndex: -1,
                startTime: mg.startTime || 0,
                duration: mgSfx.duration,
                volumeMultiplier: 0.7,
                volume: state.sfxVolume * 0.7,
                file: mgSfx.file
            });
        });
    }

    // MG SFX — fullscreen MG scenes
    state.scenes.forEach((scene, idx) => {
        if (!scene.isMGScene || scene.disabled) return;
        const mgSfx = MG_SFX_MAP[scene.type];
        if (!mgSfx) return;
        clips.push({
            id: `sfx-mg-scene-${idx}`,
            transitionType: scene.type,
            sceneIndex: idx,
            startTime: scene.startTime || 0,
            duration: mgSfx.duration,
            volumeMultiplier: 0.7,
            volume: state.sfxVolume * 0.7,
            file: mgSfx.file
        });
    });

    state.sfxClips = clips;
    applySfxVolumeLevels();
}

function renderScenes() {
    // Show all scenes including full-screen MG scenes (they are real scenes on V3)
    const displayScenes = state.scenes.filter(s => s.trackId !== undefined || !s.isMGScene || s.isMGScene);
    if (displayScenes.length === 0) { elements.sceneList.innerHTML = '<p class="empty-state">No scenes yet</p>'; return; }
    elements.sceneList.innerHTML = displayScenes.map((scene) => {
        const i = state.scenes.indexOf(scene);
        const trType = scene.transitionType || (state.transition.style !== 'auto' ? state.transition.style : null) || scene.transition?.type || 'crossfade';
        const trIcons = { cut: '✂️', crossfade: '🔀', fade: '🔀', dissolve: '🔀', blur: '🔀', crossBlur: '🔀', luma: '🌗', morph: '🔀', dreamFade: '💭', ripple: '🌊', wipe: '↔️', slide: '↔️', push: '↔️', swipe: '↔️', splitWipe: '↔️', zoom: '🔎', zoomBlur: '🔎', whip: '💨', bounce: '⬆️', shutterSlice: '📷', flash: '⚡', directionalBlur: '💨', colorFade: '🎨', spin: '🌀', cameraFlash: '📸', filmBurn: '🎞️', filmGrain: '🎞️', flare: '✨', lightLeak: '✨', shadowWipe: '🌑', vignetteBlink: '👁️', reveal: '🔀', ink: '🖋️', prismShift: '🔮', glitch: '⚡', pixelate: '🟦', mosaic: '🟦', dataMosh: '⚡', scanline: '📺', rgbSplit: '🌈', static: '📺', fade_to_black: '⬛' };
        const trBadge = i > 0 && !scene.isMGScene ? `<span class="scene-transition-badge" title="${trType}">${trIcons[trType] || '🔀'} ${trType}</span>` : '';
        const mgBadge = scene.isMGScene ? `<span class="scene-mg-badge" title="Motion Graphic: ${scene.type || 'MG'}">🎨 ${scene.type || 'MG'}</span>` : '';
        const qaBadge = scene.flagForReplacement ? `<span class="scene-qa-badge" title="${(scene.qaReason || 'Flagged by QA').replace(/"/g, '&quot;')}">⚠ QA</span>` : '';
        const keyword = scene.isMGScene ? `🎨 MG: ${scene.type || 'motion-graphic'}` : `🔍 ${scene.keyword}`;
        return `<div class="scene-card ${scene.isMGScene ? 'scene-card-mg' : ''} ${scene.flagForReplacement ? 'scene-card-qa-flagged' : ''}" data-index="${i}">
            <div class="scene-number">Scene ${i}${trBadge}${mgBadge}${qaBadge}</div>
            <div class="scene-text">${scene.text || ''}</div>
            <div class="scene-keyword">${keyword}</div>
        </div>`;
    }).join('');
    document.querySelectorAll('.scene-card').forEach(card => {
        card.addEventListener('click', () => jumpToScene(parseInt(card.dataset.index)));
    });
}

// ========================================
// Timeline Rendering - COMPLETELY FIXED
// ========================================
function renderTimeline() {
    const container = elements.timelineContainer;
    const duration = Math.max(state.totalDuration, 60);
    const totalWidth = (duration * state.timeline.zoom) + TRACK_HEADER_WIDTH + 500;

    // Preserve scroll position before innerHTML destroys it
    const prevScroll = state.timeline.scrollX || 0;

    // Reset cached DOM refs — innerHTML destroys old elements
    _cachedPlayhead = null;
    _cachedTimelineScroll = null;
    _cachedTimelineTime = null;

    container.innerHTML = `
        <div class="timeline-header">
            <div class="timeline-header-left">
                <span>Timeline</span>
                <button id="snap-toggle" class="snap-toggle ${state.snapEnabled ? 'active' : ''}" title="Toggle Snap to Clips">
                    <span class="snap-icon">🧲</span>
                    <span class="snap-label">Snap</span>
                </button>
                <button id="time-format-toggle" class="snap-toggle ${state.timeline.rulerSecondsOnly ? 'active' : ''}" title="Toggle ruler time format (M:SS ↔ seconds-only, for matching log timestamps)">
                    <span class="snap-icon">⏱</span>
                    <span class="snap-label">${state.timeline.rulerSecondsOnly ? 'Sec' : 'M:SS'}</span>
                </button>
            </div>
            <div class="timeline-info">
                <div class="zoom-control">
                    <span class="zoom-label">🔍</span>
                    <button id="zoom-fit-btn" class="zoom-fit-btn" title="Fit timeline to view (Shift+F)">Fit</button>
                    <input type="range" id="zoom-slider" class="zoom-slider" min="0" max="1000" value="${zoomToSlider(state.timeline.zoom)}" step="1">
                    <span id="timeline-zoom">${formatZoomLabel(state.timeline.zoom)}</span>
                </div>
                <span class="divider">|</span>
                <span id="timeline-time">${formatTime(state.currentTime, true)} / ${formatTime(state.totalDuration, true)}</span>
                <span id="in-out-display" class="in-out-display"></span>
            </div>
        </div>
        <div class="timeline-body">
            <div class="timeline-ruler" id="timeline-ruler" style="width:${totalWidth}px; margin-left:${TRACK_HEADER_WIDTH}px"></div>
            <div class="timeline-scroll" id="timeline-scroll">
                <div class="timeline-content" id="timeline-content" style="width:${totalWidth}px"></div>
            </div>
            <div class="playhead" id="playhead"><div class="playhead-head"></div><div class="playhead-line"></div></div>
        </div>
    `;

    renderRuler(duration);
    renderTracks();
    updatePlayhead();
    renderInOutMarkers();
    updateInOutDisplay();

    const scroll = document.getElementById('timeline-scroll');
    // Restore scroll position after innerHTML rebuild
    if (prevScroll > 0) scroll.scrollLeft = prevScroll;
    scroll.addEventListener('scroll', () => { state.timeline.scrollX = scroll.scrollLeft; updatePlayhead(); });
    scroll.addEventListener('wheel', (e) => {
        if (e.ctrlKey) { e.preventDefault(); changeZoom(e.deltaY < 0 ? 10 : -10); }
        else if (e.shiftKey || e.altKey) { e.preventDefault(); scroll.scrollLeft += e.deltaY; }
    });

    // Setup zoom slider (logarithmic scale)
    const zoomSlider = document.getElementById('zoom-slider');
    if (zoomSlider) {
        zoomSlider.addEventListener('input', (e) => {
            const newZoom = sliderToZoom(parseFloat(e.target.value));
            applyZoom(newZoom);
        });
    }

    // Fit button - zoom to fit entire timeline in view
    const fitBtn = document.getElementById('zoom-fit-btn');
    if (fitBtn) {
        fitBtn.addEventListener('click', zoomToFit);
    }

    // Setup snap toggle
    const snapToggle = document.getElementById('snap-toggle');
    if (snapToggle) {
        snapToggle.addEventListener('click', () => {
            state.snapEnabled = !state.snapEnabled;
            snapToggle.classList.toggle('active', state.snapEnabled);
            showToast(`Snap ${state.snapEnabled ? 'enabled' : 'disabled'}`, 'info');
        });
    }

    // Setup time format toggle (M:SS ↔ seconds-only, for matching log timestamps)
    const timeFmtToggle = document.getElementById('time-format-toggle');
    if (timeFmtToggle) {
        timeFmtToggle.addEventListener('click', () => {
            state.timeline.rulerSecondsOnly = !state.timeline.rulerSecondsOnly;
            timeFmtToggle.classList.toggle('active', state.timeline.rulerSecondsOnly);
            const lbl = timeFmtToggle.querySelector('.snap-label');
            if (lbl) lbl.textContent = state.timeline.rulerSecondsOnly ? 'Sec' : 'M:SS';
            renderRuler(state.totalDuration);
            const timeEl = document.getElementById('timeline-time');
            if (timeEl) timeEl.textContent = `${formatTime(state.currentTime, true)} / ${formatTime(state.totalDuration, true)}`;
            showToast(`Timeline: ${state.timeline.rulerSecondsOnly ? 'seconds-only' : 'M:SS'}`, 'info');
        });
    }

    setupPlayhead();
    setupRulerClick();
}

function renderRuler(duration) {
    const ruler = document.getElementById('timeline-ruler');
    const zoom = state.timeline.zoom;

    // Adaptive step: ensure ticks are at least ~50px apart, labels ~100px apart
    let step;
    let fractional = false;
    if (zoom >= 200) { step = 0.5; fractional = true; }   // 0.5s ticks at high zoom
    else if (zoom >= 50) step = 1;
    else if (zoom >= 20) step = 5;
    else if (zoom >= 5) step = 10;
    else if (zoom >= 2) step = 30;     // 30s steps
    else if (zoom >= 1) step = 60;     // 1min steps
    else if (zoom >= 0.5) step = 120;  // 2min steps
    else step = 300;                   // 5min steps

    const labelEvery = fractional ? 1 : (step <= 5 ? step * 2 : step);
    const majorEvery = fractional ? 1 : (step <= 10 ? step * 5 : step * 2);

    let html = '';
    for (let t = 0; t <= duration + step; t += step) {
        t = Math.round(t * 100) / 100; // avoid float drift
        const left = t * zoom;
        const isMajor = fractional ? (t % 1 === 0) : (t % majorEvery === 0);
        html += `<div class="ruler-tick ${isMajor ? 'major' : ''}" style="left:${left}px"></div>`;
        const showLabel = fractional ? (t % 1 === 0) : (t % labelEvery === 0);
        if (showLabel) {
            html += `<div class="ruler-label" style="left:${left}px">${formatTime(t, fractional)}</div>`;
        }
    }
    ruler.innerHTML = html;
}

function renderTracks() {
    const content = document.getElementById('timeline-content');
    let html = '';
    const svgMuted = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M11 5L6 9H2v6h4l5 4V5z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>';
    const svgUnmuted = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
    // Determine which video tracks have clips (auto-collapse empty upper tracks)
    const usedVideoTracks = new Set();
    state.scenes.forEach(s => usedVideoTracks.add(s.trackId || 'video-track-1'));

    state.timeline.tracks.forEach((track, trackIndex) => {
        const isMuted = state.mutedTracks[track.id] || false;
        const muteIcon = isMuted ? svgMuted : svgUnmuted;
        const muteClass = isMuted ? 'track-muted' : '';
        let trackHeight = state.timeline.trackHeights[track.id] || 36;

        // Auto-collapse empty upper video tracks (V4, V5) to save space
        const trackNum = parseInt(track.id.match(/\d+/)?.[0] || '0', 10);
        const isEmptyUpper = track.type === 'video' && trackNum > 3 && !usedVideoTracks.has(track.id);
        if (isEmptyUpper) trackHeight = 12;

        const mgTestBtn = track.id === 'mg-track' ? `<button class="mg-test-btn" data-action="inject-test-mg" title="Inject 6 test MGs">+</button>` : '';
        html += `<div class="timeline-row ${muteClass}" data-track="${track.id}" style="height:${trackHeight}px">
            <div class="track-label"><span class="track-label-text">${track.label}</span>${mgTestBtn}<button class="track-mute-btn ${isMuted ? 'muted' : ''}" data-track-mute="${track.id}" title="${isMuted ? 'Unmute' : 'Mute'} track">${muteIcon}</button></div>
            <div class="track-content ${track.type}-track" data-track="${track.id}">`;

        // Audio clip on its current track - use actual audio duration, not totalDuration
        if (track.id === (state.audioClipTrack || 'audio-track') && state.audioFile && state.totalDuration > 0) {
            const audioLeft = (state.audioClipOffset || 0) * state.timeline.zoom;
            const actualAudioDur = (elements.previewAudio && isFinite(elements.previewAudio.duration)) ? elements.previewAudio.duration : state.totalDuration;
            const w = actualAudioDur * state.timeline.zoom;
            // Generate pseudo-waveform bars
            let waveHtml = '<div class="audio-waveform-bars">';
            const barCount = Math.min(Math.floor(w / 3), 500);
            for (let b = 0; b < barCount; b++) { waveHtml += `<div class="waveform-bar" style="height:${20 + Math.random() * 60}%"></div>`; }
            waveHtml += '</div>';
            html += `<div class="timeline-clip audio-clip" data-audio-clip="voice" data-track="audio-track" style="left:${audioLeft}px;width:${w}px" title="${state.audioFile.name}">
                ${waveHtml}
                <span class="clip-label">${state.audioFile.name}</span>
                <button class="audio-clip-delete" title="Remove audio">✕</button>
            </div>`;
        }

        // Motion Graphics clips on mg-track (per-type colors) — listicle types go to listicle-track
        if ((track.id === 'mg-track' || track.id === 'listicle-track') && state.motionGraphics.length > 0) {
            const mgMeta = {
                headline: { icon: 'H', colorClass: 'mg-headline' },
                lowerThird: { icon: 'L3', colorClass: 'mg-lowerthird' },
                statCounter: { icon: '#', colorClass: 'mg-stat' },
                callout: { icon: '"', colorClass: 'mg-callout' },
                bulletList: { icon: '::', colorClass: 'mg-bullets' },
                focusWord: { icon: 'F', colorClass: 'mg-focusword' },
                progressBar: { icon: '%', colorClass: 'mg-progressbar' },
                barChart: { icon: 'BC', colorClass: 'mg-barchart' },
                donutChart: { icon: 'DC', colorClass: 'mg-donutchart' },
                comparisonCard: { icon: 'VS', colorClass: 'mg-comparison' },
                timeline: { icon: 'TL', colorClass: 'mg-timeline-clip' },
                rankingList: { icon: 'RK', colorClass: 'mg-ranking' },
                kineticText: { icon: 'KT', colorClass: 'mg-kinetic' },
                listicleCounter: { icon: '#1', colorClass: 'mg-listicle-counter' },
                progressTracker: { icon: '•••', colorClass: 'mg-listicle-tracker' },
                listicleGrid: { icon: '▦', colorClass: 'mg-listicle-grid' },
            };
            const isListicleTrack = track.id === 'listicle-track';
            state.motionGraphics.forEach((mg, i) => {
                const isListicleMG = LISTICLE_TYPES.has(mg.type);
                // Only render listicle MGs on listicle-track, others on mg-track
                if (isListicleTrack !== isListicleMG) return;

                const left = mg.startTime * state.timeline.zoom;
                const w = mg.duration * state.timeline.zoom;
                const meta = mgMeta[mg.type] || { icon: '?', colorClass: '' };
                const isDisabled = mg.disabled === true;
                const isSelected = state.selectedMgIndex === i;
                const eyeIcon = isDisabled ? '👁️‍🗨️' : '👁️';
                const clampedW = Math.max(w, 20);
                html += `<div class="timeline-clip mg-clip ${meta.colorClass} ${isDisabled ? 'clip-disabled' : ''} ${isSelected ? 'selected' : ''}" data-mg-index="${i}"
                    style="left:${left}px;width:${clampedW}px"
                    title="${mg.type}: ${mg.text} [${mg.startTime.toFixed(2)}s → ${(mg.startTime + mg.duration).toFixed(2)}s] (${mg.duration.toFixed(2)}s)${isDisabled ? ' [OFF]' : ''}">
                    <span class="clip-label">${meta.icon}</span>
                    <button class="clip-toggle-btn" data-toggle-mg="${i}" title="${isDisabled ? 'Enable' : 'Disable'} graphic">${eyeIcon}</button>
                </div>`;
            });
        }

        // SFX clips on sfx-track
        if (track.id === 'sfx-track' && state.sfxClips.length > 0) {
            state.sfxClips.forEach((sfx, i) => {
                const left = sfx.startTime * state.timeline.zoom;
                const w = sfx.duration * state.timeline.zoom;
                const icon = state.transition.metadata[sfx.transitionType]?.icon || '🔊';
                html += `<div class="timeline-clip sfx-clip" data-sfx-index="${i}"
                    style="left:${left}px;width:${Math.max(w, 8)}px"
                    title="SFX: ${sfx.transitionType} (${sfx.duration.toFixed(2)}s)">
                    <span class="clip-label">${icon}</span>
                </div>`;
            });
        }

        // Scene clips on this track
        const trackScenes = state.scenes.filter(s => (s.trackId || 'video-track-1') === track.id);
        let overlayLaneIndex = 0; // Track overlay lane for vertical stacking
        trackScenes.forEach((scene, i) => {
            const idx = state.scenes.indexOf(scene);
            const left = scene.startTime * state.timeline.zoom;
            const width = (scene.endTime - scene.startTime) * state.timeline.zoom;

            // Full-screen MG scene on V3
            if (scene.isMGScene) {
                const mgMeta = {
                    barChart: { name: 'Bar Chart', colorClass: 'mg-barchart' },
                    donutChart: { name: 'Donut Chart', colorClass: 'mg-donutchart' },
                    comparisonCard: { name: 'Comparison', colorClass: 'mg-comparison' },
                    timeline: { name: 'Timeline', colorClass: 'mg-timeline-clip' },
                    rankingList: { name: 'Ranking', colorClass: 'mg-ranking' },
                    bulletList: { name: 'Bullet List', colorClass: 'mg-bullets' },
                    mapChart: { name: 'Map', colorClass: 'mg-mapchart' },
                    articleHighlight: { name: 'Article', colorClass: 'mg-article' },
                };
                const meta = mgMeta[scene.type] || { name: scene.type || 'MG', colorClass: '' };
                const clipName = scene.text ? `${meta.name}: ${scene.text}` : meta.name;
                const isDisabled = scene.disabled === true;
                const eyeIcon = isDisabled ? '👁️‍🗨️' : '👁️';
                html += `<div class="timeline-clip clip-mg-scene ${meta.colorClass} ${isDisabled ? 'clip-disabled' : ''} ${state.selectedClipIndices.includes(idx) ? 'selected' : ''}"
                    data-index="${idx}" style="left:${left}px;width:${width}px"
                    title="${clipName} [${scene.startTime.toFixed(2)}s → ${scene.endTime.toFixed(2)}s] (${(scene.endTime - scene.startTime).toFixed(2)}s)${isDisabled ? ' [OFF]' : ''}">
                    <div class="clip-trim-handle clip-trim-handle-left" data-index="${idx}" data-edge="left"></div>
                    <span class="clip-label">${clipName}</span>
                    <button class="clip-toggle-btn" data-toggle-idx="${idx}" title="${isDisabled ? 'Enable' : 'Disable'} graphic">${eyeIcon}</button>
                    <div class="clip-trim-handle clip-trim-handle-right" data-index="${idx}" data-edge="right"></div>
                </div>`;
                return;
            }

            const isOverlayDirective = scene._compositorDirective;
            const mediaClass = isOverlayDirective ? 'clip-v2-overlay' : (scene.mediaType === 'image' ? 'clip-image' : 'clip-video');
            const isDisabled = scene.disabled === true;
            const eyeIcon = isDisabled ? '👁️‍🗨️' : '👁️';
            // Transition icon between clips (per-scene override > global force > AI-assigned)
            const trType = scene.transitionType || (state.transition.style !== 'auto' ? state.transition.style : null) || scene.transition?.type || 'crossfade';
            const trIcons = { cut: '✂️', crossfade: '🔀', fade: '🔀', dissolve: '🔀', blur: '🔀', crossBlur: '🔀', luma: '🌗', morph: '🔀', dreamFade: '💭', ripple: '🌊', wipe: '↔️', slide: '↔️', push: '↔️', swipe: '↔️', splitWipe: '↔️', zoom: '🔎', zoomBlur: '🔎', whip: '💨', bounce: '⬆️', shutterSlice: '📷', flash: '⚡', directionalBlur: '💨', colorFade: '🎨', spin: '🌀', cameraFlash: '📸', filmBurn: '🎞️', filmGrain: '🎞️', flare: '✨', lightLeak: '✨', shadowWipe: '🌑', vignetteBlink: '👁️', reveal: '🔀', ink: '🖋️', prismShift: '🔮', glitch: '⚡', pixelate: '🟦', mosaic: '🟦', dataMosh: '⚡', scanline: '📺', rgbSplit: '🌈', static: '📺', fade_to_black: '⬛' };
            const trIcon = trIcons[trType] || '🔀';
            // Show transition marker between clips (skip first scene)
            if (i > 0 && trIcon) {
                html += `<div class="transition-marker" style="left:${left - 8}px" title="${trType}">${trIcon}</div>`;
            }
            // Clip separator line for adjacent clips
            if (i > 0) {
                const prevScene = trackScenes[i - 1];
                if (Math.abs(prevScene.endTime - scene.startTime) < 0.05) {
                    html += `<div class="clip-separator" style="left:${left}px"></div>`;
                }
            }

            html += `<div class="timeline-clip ${mediaClass} ${isDisabled ? 'clip-disabled' : ''} ${idx === state.currentSceneIndex ? 'active' : ''} ${state.selectedClipIndices.includes(idx) ? 'selected' : ''}"
                data-index="${idx}" style="left:${left}px;width:${width}px" title="${scene.text || scene.keyword || ''}${isDisabled ? ' [OFF]' : ''}">
                <div class="clip-trim-handle clip-trim-handle-left" data-index="${idx}" data-edge="left"></div>
                <span class="clip-label">${(scene.text || scene.keyword || '').substring(0, 30)}${(scene.text || scene.keyword || '').length > 30 ? '...' : ''}</span>
                <button class="clip-toggle-btn" data-toggle-idx="${idx}" title="${isDisabled ? 'Enable' : 'Disable'} clip">${eyeIcon}</button>
                <div class="clip-trim-handle clip-trim-handle-right" data-index="${idx}" data-edge="right"></div>
            </div>`;
        });

        html += `</div></div>`;
        // Add resize handle between tracks (except after last track)
        if (trackIndex < state.timeline.tracks.length - 1) {
            html += `<div class="track-resize-handle" data-resize-track="${track.id}"></div>`;
        }
    });
    content.innerHTML = html;

    // Clip events
    document.querySelectorAll('.timeline-clip[data-index]').forEach(clip => {
        clip.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('clip-toggle-btn')) return;
            startDragClip(e, clip);
        });
        clip.addEventListener('click', (e) => {
            if (e.target.classList.contains('clip-toggle-btn')) return;
            e.stopPropagation();
            const idx = parseInt(clip.dataset.index);
            selectClip(idx, e.ctrlKey || e.metaKey);
            if (!e.ctrlKey && !e.metaKey) jumpToScene(idx);
        });
    });

    // Trim handle events (must come before general clip drag)
    document.querySelectorAll('.clip-trim-handle').forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            startTrimClip(e, handle);
        });
    });

    // Audio clip drag (horizontal only, locked to audio tracks)
    document.querySelectorAll('.timeline-clip[data-audio-clip]').forEach(audioClip => {
        audioClip.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('audio-clip-delete')) return; // Don't drag when clicking delete
            startDragAudioClip(e, audioClip);
        });
    });

    // Audio clip delete button
    document.querySelectorAll('.audio-clip-delete').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (confirm('Remove audio from project?')) {
                removeAudio();
                renderTimeline();
                showToast('Audio removed', 'info');
            }
        });
    });

    // Click empty track to seek (only if not marquee selecting)
    document.querySelectorAll('.track-content').forEach(tc => {
        tc.addEventListener('click', (e) => {
            if (e.target.classList.contains('track-content') && !state._marqueeUsed) {
                const rect = tc.getBoundingClientRect();
                const time = (e.clientX - rect.left + document.getElementById('timeline-scroll').scrollLeft) / state.timeline.zoom;
                seekToTime(Math.max(0, time));
            }
            state._marqueeUsed = false;
        });
    });

    // Track mute buttons
    document.querySelectorAll('.track-mute-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const trackId = btn.dataset.trackMute;
            state.mutedTracks[trackId] = !state.mutedTracks[trackId];
            const isMuted = state.mutedTracks[trackId];
            btn.textContent = isMuted ? '🔇' : '🔊';
            btn.classList.toggle('muted', isMuted);
            btn.title = (isMuted ? 'Unmute' : 'Mute') + ' track';
            btn.closest('.timeline-row').classList.toggle('track-muted', isMuted);
            applyTrackVolumes();
            // Sync MG track mute with MG enable flag
            if (trackId === 'mg-track') {
                state.mgEnabled = !isMuted;
                if (elements.mgEnabled) elements.mgEnabled.checked = !isMuted;
                saveSettings();
            }
        });
    });

    // MG test inject button
    document.querySelectorAll('[data-action="inject-test-mg"]').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            injectTestMotionGraphics();
        });
    });

    // Per-clip toggle buttons (MG clips)
    document.querySelectorAll('.clip-toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            // Overlay clip toggle
            if (btn.dataset.toggleIdx !== undefined) {
                const idx = parseInt(btn.dataset.toggleIdx);
                const scene = state.scenes[idx];
                if (scene) {
                    scene.disabled = !scene.disabled;
                    renderTracks();
                }
            }
            // MG clip toggle
            if (btn.dataset.toggleMg !== undefined) {
                const mgIdx = parseInt(btn.dataset.toggleMg);
                const mg = state.motionGraphics[mgIdx];
                if (mg) {
                    mg.disabled = !mg.disabled;
                    renderTracks();
                }
            }
        });
    });

    // MG clip click to select and show properties
    document.querySelectorAll('.mg-clip').forEach(clip => {
        clip.addEventListener('click', (e) => {
            if (e.target.classList.contains('clip-toggle-btn')) return; // Don't select when toggling
            e.stopPropagation();
            const mgIdx = parseInt(clip.dataset.mgIndex);
            if (isNaN(mgIdx)) return;
            // Deselect any regular/overlay clip
            state.selectedClipIndex = -1;
            state.selectedClipIndices = [];
            clearSceneTransform();
            document.querySelectorAll('.timeline-clip').forEach(c => c.classList.remove('selected'));
            // Select this MG
            state.selectedMgIndex = mgIdx;
            document.querySelectorAll('.mg-clip').forEach(c => c.classList.remove('selected'));
            clip.classList.add('selected');
            updateClipProperties();
        });
    });

    // Marquee drag-to-select on timeline
    setupMarqueeSelect();

    // Track resize handles
    setupTrackResize();

    // Async load thumbnails for video/image clips
    loadClipThumbnails();
}

// ========================================
// Track Resize
// ========================================
function setupTrackResize() {
    document.querySelectorAll('.track-resize-handle').forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            const trackId = handle.dataset.resizeTrack;
            const startY = e.clientY;
            const startHeight = state.timeline.trackHeights[trackId] || 36;
            handle.classList.add('active');
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';

            const onMove = (me) => {
                const delta = me.clientY - startY;
                const min = state.timeline.trackMinHeights[trackId] || 18;
                const max = state.timeline.trackMaxHeights[trackId] || 120;
                const newHeight = Math.max(min, Math.min(max, startHeight + delta));
                state.timeline.trackHeights[trackId] = newHeight;
                const row = document.querySelector(`.timeline-row[data-track="${trackId}"]`);
                if (row) row.style.height = `${newHeight}px`;
            };

            const onUp = () => {
                handle.classList.remove('active');
                document.body.style.cursor = '';
                document.body.style.userSelect = '';
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    });
}

// ========================================
// Clip Thumbnails
// ========================================
const thumbnailCache = {};

async function loadClipThumbnails() {
    if (!window.electronAPI?.getSceneMediaPath) return;
    document.querySelectorAll('.timeline-clip[data-index]').forEach(async (clipEl) => {
        const idx = parseInt(clipEl.dataset.index);
        const scene = state.scenes[idx];
        if (!scene) return;

        // Check cache first
        if (thumbnailCache[idx] !== undefined) {
            if (thumbnailCache[idx] && clipEl.isConnected) {
                clipEl.style.backgroundImage = `url("${thumbnailCache[idx]}")`;
                clipEl.classList.add('has-thumbnail');
            }
            return;
        }

        try {
            // Try frame-{index}.jpg first (from vision analysis)
            const originalIdx = scene.index !== undefined ? scene.index : idx;
            let framePath = await window.electronAPI.getSceneMediaPath(originalIdx, '.jpg', 'frame');
            if (framePath) {
                const url = await window.electronAPI.getFileUrl(framePath);
                thumbnailCache[idx] = url;
                if (url && clipEl.isConnected) {
                    clipEl.style.backgroundImage = `url("${url}")`;
                    clipEl.classList.add('has-thumbnail');
                }
                return;
            }
            // Fallback: if scene is an image, use it directly
            if (scene.mediaType === 'image') {
                const imgPath = await window.electronAPI.getSceneMediaPath(originalIdx, scene.mediaExtension);
                if (imgPath) {
                    const url = await window.electronAPI.getFileUrl(imgPath);
                    thumbnailCache[idx] = url;
                    if (url && clipEl.isConnected) {
                        clipEl.style.backgroundImage = `url("${url}")`;
                        clipEl.classList.add('has-thumbnail');
                    }
                    return;
                }
            }
            thumbnailCache[idx] = null;
        } catch (e) {
            thumbnailCache[idx] = null;
        }
    });
}

// ========================================
// Marquee Drag-to-Select (like Premiere Pro)
// ========================================
function setupMarqueeSelect() {
    const scroll = document.getElementById('timeline-scroll');
    if (!scroll) return;

    let marquee = document.getElementById('timeline-marquee');
    if (!marquee) {
        marquee = document.createElement('div');
        marquee.id = 'timeline-marquee';
        marquee.className = 'timeline-marquee';
        scroll.style.position = 'relative';
        scroll.appendChild(marquee);
    }

    let isMarquee = false;
    let startX = 0, startY = 0;

    scroll.addEventListener('mousedown', (e) => {
        // Only start marquee on left-click on empty area (not on a clip or handle)
        if (e.button !== 0) return;
        if (e.target.closest('.timeline-clip') || e.target.closest('.clip-trim-handle') || e.target.closest('.playhead') || e.target.closest('.transition-icon')) return;

        isMarquee = true;
        const scrollRect = scroll.getBoundingClientRect();
        startX = e.clientX - scrollRect.left + scroll.scrollLeft;
        startY = e.clientY - scrollRect.top + scroll.scrollTop;

        marquee.style.display = 'none';

        // Deselect if not holding Ctrl
        if (!e.ctrlKey && !e.metaKey) {
            deselectClip();
        }
    });

    document.addEventListener('mousemove', (e) => {
        if (!isMarquee) return;

        const scrollRect = scroll.getBoundingClientRect();
        const curX = e.clientX - scrollRect.left + scroll.scrollLeft;
        const curY = e.clientY - scrollRect.top + scroll.scrollTop;

        const left = Math.min(startX, curX);
        const top = Math.min(startY, curY);
        const width = Math.abs(curX - startX);
        const height = Math.abs(curY - startY);

        // Only show marquee if dragged more than 5px (avoid accidental selections)
        if (width > 5 || height > 5) {
            marquee.style.display = 'block';
            marquee.style.left = left + 'px';
            marquee.style.top = top + 'px';
            marquee.style.width = width + 'px';
            marquee.style.height = height + 'px';

            // Live highlight: check intersection with clips
            highlightClipsInMarquee(left, top, width, height, e.ctrlKey || e.metaKey);
        }
    });

    document.addEventListener('mouseup', (e) => {
        if (!isMarquee) return;
        isMarquee = false;

        if (marquee.style.display === 'block') {
            state._marqueeUsed = true; // Prevent seek on this click
            marquee.style.display = 'none';
        }
    });
}

function highlightClipsInMarquee(mLeft, mTop, mWidth, mHeight, addToExisting) {
    const scroll = document.getElementById('timeline-scroll');
    if (!scroll) return;

    const scrollRect = scroll.getBoundingClientRect();
    const mRight = mLeft + mWidth;
    const mBottom = mTop + mHeight;

    const newSelection = addToExisting ? [...state.selectedClipIndices] : [];

    document.querySelectorAll('.timeline-clip[data-index]').forEach(clip => {
        const idx = parseInt(clip.dataset.index);
        // Use getBoundingClientRect relative to scroll container for accuracy
        const clipRect = clip.getBoundingClientRect();
        const clipLeft = clipRect.left - scrollRect.left + scroll.scrollLeft;
        const clipTop = clipRect.top - scrollRect.top + scroll.scrollTop;
        const clipRight = clipLeft + clipRect.width;
        const clipBottom = clipTop + clipRect.height;

        // Check overlap
        const overlaps = !(clipRight < mLeft || clipLeft > mRight || clipBottom < mTop || clipTop > mBottom);

        if (overlaps && !newSelection.includes(idx)) {
            newSelection.push(idx);
        }
    });

    // Update selection visually
    state.selectedClipIndices = newSelection;
    state.selectedClipIndex = newSelection.length > 0 ? newSelection[newSelection.length - 1] : -1;

    document.querySelectorAll('.timeline-clip[data-index]').forEach(c => {
        const idx = parseInt(c.dataset.index);
        c.classList.toggle('selected', newSelection.includes(idx));
    });
}

// Logarithmic zoom slider: maps 0-1000 slider range to 0.5-200 px/s zoom
// This makes low zoom values (for long videos) easy to fine-tune
function sliderToZoom(sliderVal) {
    const minLog = Math.log(state.timeline.minZoom);
    const maxLog = Math.log(state.timeline.maxZoom);
    return Math.exp(minLog + (sliderVal / 1000) * (maxLog - minLog));
}

function zoomToSlider(zoom) {
    const minLog = Math.log(state.timeline.minZoom);
    const maxLog = Math.log(state.timeline.maxZoom);
    return Math.round(((Math.log(zoom) - minLog) / (maxLog - minLog)) * 1000);
}

function formatZoomLabel(zoom) {
    if (zoom >= 10) return `${Math.round(zoom)}px/s`;
    if (zoom >= 1) return `${zoom.toFixed(1)}px/s`;
    return `${zoom.toFixed(2)}px/s`;
}

function changeZoom(delta) {
    // Scale delta proportionally to current zoom for smooth feel
    const scaledDelta = delta * Math.max(0.1, state.timeline.zoom * 0.15);
    applyZoom(state.timeline.zoom + scaledDelta, true);
}

function zoomToFit() {
    const scroll = document.getElementById('timeline-scroll');
    if (!scroll || state.totalDuration <= 0) return;
    // Calculate zoom so entire duration fits in visible area (with some padding)
    const availableWidth = scroll.clientWidth - 40; // small padding
    const fitZoom = availableWidth / state.totalDuration;
    applyZoom(Math.max(state.timeline.minZoom, Math.min(state.timeline.maxZoom, fitZoom)), true);
    // Scroll to start
    requestAnimationFrame(() => { scroll.scrollLeft = 0; });
}

function applyZoom(newZoom, fullRerender = false) {
    const scroll = document.getElementById('timeline-scroll');
    const oldZoom = state.timeline.zoom;
    newZoom = Math.max(state.timeline.minZoom, Math.min(state.timeline.maxZoom, newZoom));
    if (newZoom === oldZoom) return;

    // Keep playhead centered in viewport after zoom
    const playheadRatio = scroll ? ((state.currentTime * oldZoom - scroll.scrollLeft) / scroll.clientWidth) : 0.5;

    state.timeline.zoom = newZoom;

    if (fullRerender) {
        // Full re-render (from Ctrl+scroll or other non-slider sources)
        renderTimeline();
    } else {
        // Lightweight update - don't rebuild header (preserves slider drag state)
        const duration = Math.max(state.totalDuration, 60);
        const totalWidth = (duration * newZoom) + TRACK_HEADER_WIDTH + 500;

        const ruler = document.getElementById('timeline-ruler');
        const content = document.getElementById('timeline-content');
        if (ruler) { ruler.style.width = `${totalWidth}px`; renderRuler(duration); }
        if (content) { content.style.width = `${totalWidth}px`; }
        renderTracks();
        updatePlayhead();

        // Update zoom label and slider position
        const zoomLabel = document.getElementById('timeline-zoom');
        if (zoomLabel) zoomLabel.textContent = formatZoomLabel(newZoom);
        const slider = document.getElementById('zoom-slider');
        if (slider) slider.value = zoomToSlider(newZoom);
    }

    // Restore scroll so playhead stays at same viewport position
    const newScroll = document.getElementById('timeline-scroll');
    if (newScroll) {
        const newPlayheadAbsX = state.currentTime * newZoom;
        newScroll.scrollLeft = newPlayheadAbsX - playheadRatio * newScroll.clientWidth;
        state.timeline.scrollX = newScroll.scrollLeft;
        updatePlayhead();
    }
}

// ========================================
// PLAYHEAD - FIXED
// ========================================
function setupPlayhead() {
    const playhead = document.getElementById('playhead');
    playhead.addEventListener('mousedown', (e) => {
        e.preventDefault(); e.stopPropagation();
        state.timeline.isDraggingPlayhead = true;
        playhead.classList.add('dragging');
        document.body.style.cursor = 'ew-resize';

        const onMove = (me) => {
            const scroll = document.getElementById('timeline-scroll');
            const body = document.querySelector('.timeline-body');
            const rect = body.getBoundingClientRect();
            const x = me.clientX - rect.left - TRACK_HEADER_WIDTH + scroll.scrollLeft;
            const time = Math.max(0, x / state.timeline.zoom);
            state.currentTime = time;
            updatePlayhead();
            updateTimeDisplay();
            scrubMedia(time);
        };

        const onUp = () => {
            state.timeline.isDraggingPlayhead = false;
            playhead.classList.remove('dragging');
            document.body.style.cursor = '';
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            seekToTime(state.currentTime);
        };

        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function setupRulerClick() {
    document.getElementById('timeline-ruler')?.addEventListener('click', (e) => {
        const rect = e.target.closest('.timeline-ruler').getBoundingClientRect();
        const scroll = document.getElementById('timeline-scroll');
        const x = e.clientX - rect.left + scroll.scrollLeft;
        seekToTime(Math.max(0, x / state.timeline.zoom));
    });
}

// Cached DOM refs for per-frame functions (avoid getElementById every frame)
let _cachedPlayhead = null;
let _cachedTimelineScroll = null;
let _cachedTimelineTime = null;

function updatePlayhead() {
    if (!_cachedPlayhead) _cachedPlayhead = document.getElementById('playhead');
    if (!_cachedTimelineScroll) _cachedTimelineScroll = document.getElementById('timeline-scroll');
    if (!_cachedPlayhead || !_cachedTimelineScroll) return;

    // Calculate position relative to viewport
    const absoluteX = TRACK_HEADER_WIDTH + (state.currentTime * state.timeline.zoom);
    const visibleX = absoluteX - _cachedTimelineScroll.scrollLeft;

    _cachedPlayhead.style.left = `${visibleX}px`;
    _cachedPlayhead.style.display = visibleX < TRACK_HEADER_WIDTH - 10 ? 'none' : 'block';
}

function updateTimeDisplay() {
    if (!_cachedTimelineTime) _cachedTimelineTime = document.getElementById('timeline-time');
    if (_cachedTimelineTime) _cachedTimelineTime.textContent = `${formatTime(state.currentTime, true)} / ${formatTime(state.totalDuration, true)}`;
}

async function scrubMedia(time) {
    const audio = elements.previewAudio;

    // Stop playback while scrubbing
    if (state.isPlaying) {
        stopPlayback();
    }

    // Update audio position
    if (audio?.src) {
        audio.currentTime = Math.min(time, audio.duration || state.totalDuration);
    }

    // Update state current time
    state.currentTime = time;

    // Load all active scenes at this time
    await loadActiveScenes();

    // Get active scenes for highlighting
    const activeScenes = getActiveScenesAtTime(time);
    updateSceneHighlight(activeScenes.length > 0 ? activeScenes[0].index : -1);
}

// ========================================
// Clip Dragging
// ========================================

// Get snap points from all clips except the one being dragged
function getSnapPoints(excludeIndex, trackId) {
    const points = [0]; // Always snap to start

    state.scenes.forEach((scene, i) => {
        if (i === excludeIndex) return;
        // Only snap to clips on same track or all tracks if holding shift
        if (scene.trackId === trackId || trackId === null) {
            points.push(scene.startTime);
            points.push(scene.endTime);
        }
    });

    // Add playhead position
    points.push(state.currentTime);

    // Add total duration
    points.push(state.totalDuration);

    return [...new Set(points)].sort((a, b) => a - b);
}

// Find nearest snap point
function findSnapPoint(time, clipDuration, excludeIndex, trackId) {
    if (!state.snapEnabled) return { start: time, snapped: false };

    const snapPoints = getSnapPoints(excludeIndex, trackId);
    const threshold = state.snapThreshold / state.timeline.zoom; // Convert pixels to time

    // Check snap for clip start
    for (const point of snapPoints) {
        if (Math.abs(time - point) < threshold) {
            return { start: point, snapped: true, snapTo: 'start' };
        }
    }

    // Check snap for clip end
    const clipEnd = time + clipDuration;
    for (const point of snapPoints) {
        if (Math.abs(clipEnd - point) < threshold) {
            return { start: point - clipDuration, snapped: true, snapTo: 'end' };
        }
    }

    return { start: time, snapped: false };
}

function startDragClip(e, clip) {
    e.stopPropagation();
    const idx = parseInt(clip.dataset.index);
    const scene = state.scenes[idx];
    const startX = e.clientX;
    const origTime = scene.startTime;
    const origTrackId = scene.trackId || 'video-track-1';
    const clipDuration = scene.endTime - scene.startTime;
    let moved = false;
    let undoPushed = false;
    let lastSnapped = false;
    clip.classList.add('dragging');

    // Create snap indicator line
    let snapLine = document.createElement('div');
    snapLine.className = 'snap-indicator';
    snapLine.style.display = 'none';
    document.querySelector('.timeline-body')?.appendChild(snapLine);

    const onMove = (me) => {
        if (!moved && !undoPushed) { pushUndoState(); undoPushed = true; }
        moved = true;
        const delta = (me.clientX - startX) / state.timeline.zoom;
        let newTime = Math.max(0, origTime + delta);

        // Apply snapping
        const snapResult = findSnapPoint(newTime, clipDuration, idx, scene.trackId);
        newTime = snapResult.start;

        // Show/hide snap indicator
        if (snapResult.snapped && !lastSnapped) {
            clip.classList.add('snapping');
            const snapX = (snapResult.snapTo === 'end' ? newTime + clipDuration : newTime) * state.timeline.zoom + TRACK_HEADER_WIDTH;
            snapLine.style.left = `${snapX - document.getElementById('timeline-scroll').scrollLeft}px`;
            snapLine.style.display = 'block';
        } else if (!snapResult.snapped && lastSnapped) {
            clip.classList.remove('snapping');
            snapLine.style.display = 'none';
        }
        lastSnapped = snapResult.snapped;

        clip.style.left = `${newTime * state.timeline.zoom}px`;
    };

    const onUp = (ue) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        clip.classList.remove('dragging');
        clip.classList.remove('snapping');
        snapLine.remove();

        if (!moved) return;

        const delta = (ue.clientX - startX) / state.timeline.zoom;
        let newTime = Math.max(0, origTime + delta);

        // Apply snapping on release
        const snapResult = findSnapPoint(newTime, clipDuration, idx, scene.trackId);
        newTime = Math.max(0, snapResult.start);

        scene.startTime = newTime;
        scene.endTime = newTime + clipDuration;

        // Only allow dropping on tracks of the same type (video->video, audio->audio)
        const target = document.elementsFromPoint(ue.clientX, ue.clientY).find(el => el.classList.contains('track-content'));
        if (target) {
            const targetTrackId = target.dataset.track;
            const sourceTrack = state.timeline.tracks.find(t => t.id === origTrackId);
            const targetTrack = state.timeline.tracks.find(t => t.id === targetTrackId);
            // Only switch track if types match
            if (sourceTrack && targetTrack && sourceTrack.type === targetTrack.type) {
                scene.trackId = targetTrackId;
            }
            // Otherwise keep original track
        }

        state.scenes.sort((a, b) => a.startTime - b.startTime);
        renderTimeline();
        // Refresh compositor with updated scene timing/track assignments
        if (state.compositorActive) loadPlanIntoCompositor();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

function startDragAudioClip(e, clip) {
    e.stopPropagation();
    const startX = e.clientX;
    const origOffset = state.audioClipOffset || 0;
    const origTrack = state.audioClipTrack || 'audio-track';
    let moved = false;
    let undoPushed = false;
    clip.classList.add('dragging');

    const onMove = (me) => {
        if (!moved && !undoPushed) { pushUndoState(); undoPushed = true; }
        moved = true;
        const delta = (me.clientX - startX) / state.timeline.zoom;
        const newOffset = Math.max(0, origOffset + delta);
        clip.style.left = `${newOffset * state.timeline.zoom}px`;
    };

    const onUp = (ue) => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        clip.classList.remove('dragging');

        if (!moved) return;

        const delta = (ue.clientX - startX) / state.timeline.zoom;
        state.audioClipOffset = Math.max(0, origOffset + delta);

        // Only allow dropping on audio-type tracks
        const target = document.elementsFromPoint(ue.clientX, ue.clientY).find(el => el.classList.contains('track-content'));
        if (target) {
            const targetTrackId = target.dataset.track;
            const targetTrack = state.timeline.tracks.find(t => t.id === targetTrackId);
            if (targetTrack && targetTrack.type === 'audio') {
                state.audioClipTrack = targetTrackId;
            }
        }

        renderTimeline();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// ========================================
// Clip Edge Trimming
// ========================================
function startTrimClip(e, handle) {
    e.preventDefault();
    const idx = parseInt(handle.dataset.index);
    const edge = handle.dataset.edge; // 'left' or 'right'
    const scene = state.scenes[idx];
    if (!scene) return;

    const startX = e.clientX;
    const origStartTime = scene.startTime;
    const origEndTime = scene.endTime;
    const origMediaOffset = scene.mediaOffset || 0;
    const minDuration = 0.2; // minimum clip duration in seconds
    let moved = false;
    let undoPushed = false;

    const clipEl = handle.closest('.timeline-clip');
    if (clipEl) clipEl.classList.add('trimming');
    document.body.style.cursor = edge === 'left' ? 'w-resize' : 'e-resize';

    const onMove = (me) => {
        if (!moved && !undoPushed) { pushUndoState(); undoPushed = true; }
        moved = true;
        const delta = (me.clientX - startX) / state.timeline.zoom;

        if (edge === 'left') {
            // Trimming left edge: move startTime, adjust mediaOffset
            let newStart = Math.max(0, origStartTime + delta);
            // Enforce minimum duration
            if (origEndTime - newStart < minDuration) newStart = origEndTime - minDuration;
            // Can't go before original media start (mediaOffset can't go negative)
            const mediaOffsetDelta = newStart - origStartTime;
            if (origMediaOffset + mediaOffsetDelta < 0) newStart = origStartTime - origMediaOffset;

            scene.startTime = newStart;
            scene.mediaOffset = origMediaOffset + (newStart - origStartTime);

            // Update clip element live
            if (clipEl) {
                clipEl.style.left = `${newStart * state.timeline.zoom}px`;
                clipEl.style.width = `${(scene.endTime - newStart) * state.timeline.zoom}px`;
            }
        } else {
            // Trimming right edge: just move endTime
            let newEnd = origEndTime + delta;
            // Enforce minimum duration
            if (newEnd - origStartTime < minDuration) newEnd = origStartTime + minDuration;
            // Don't allow negative or zero
            newEnd = Math.max(origStartTime + minDuration, newEnd);

            scene.endTime = newEnd;

            // Update clip element live
            if (clipEl) {
                clipEl.style.width = `${(newEnd - origStartTime) * state.timeline.zoom}px`;
            }
        }
    };

    const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.style.cursor = '';
        if (clipEl) clipEl.classList.remove('trimming');

        if (!moved) return;

        state.scenes.sort((a, b) => a.startTime - b.startTime);
        recalcTotalDuration();
        renderTimeline();
        // Refresh compositor with updated scene timing
        if (state.compositorActive) loadPlanIntoCompositor();
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
}

// ========================================
// Playback Control
// ========================================

// Helper to wait for video to be ready
function waitForVideoReady(video, timeout = 3000) {
    return new Promise((resolve) => {
        if (video.readyState >= 2) {
            resolve();
            return;
        }
        const timeoutId = setTimeout(() => {
            video.removeEventListener('canplay', onReady);
            video.removeEventListener('loadeddata', onReady);
            resolve(); // Resolve anyway after timeout
        }, timeout);

        const onReady = () => {
            clearTimeout(timeoutId);
            video.removeEventListener('canplay', onReady);
            video.removeEventListener('loadeddata', onReady);
            resolve();
        };

        video.addEventListener('canplay', onReady);
        video.addEventListener('loadeddata', onReady);
    });
}

// Clean up video event handlers
function cleanupVideoHandlers() {
    // Clean up handlers from all track videos (both A and B buffers)
    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
    elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach(video => {
        if (video) {
            video.ontimeupdate = null;
            video.onended = null;
            video.onplay = null;
            video.onpause = null;
            video.onerror = null;
            video.onloadeddata = null;
        }
    });
}

async function jumpToScene(index) {
    if (index < 0 || index >= state.scenes.length) return;

    const wasPlaying = state.isPlaying;
    const audio = elements.previewAudio;
    const scene = state.scenes[index];

    // Stop current playback temporarily
    if (wasPlaying) {
        stopPlayback();
    }

    // Clean up old handlers
    cleanupVideoHandlers();

    state.currentTime = scene.startTime;

    // Update UI
    updateSceneHighlight(index);
    updatePlayhead();
    updateTimeDisplay();

    // Sync audio position
    if (audio?.src) {
        audio.currentTime = Math.min(scene.startTime, audio.duration || state.totalDuration);
    }

    // Load all active scenes at this time
    await loadActiveScenes();

    // Resume playback if we were playing
    if (wasPlaying) {
        startPlayback();
    }
}

async function seekToTime(time) {
    const wasPlaying = state.isPlaying;

    // Stop playback during seek
    if (wasPlaying) {
        stopPlayback();
    }

    state.currentTime = Math.max(0, time);

    // Clean up old handlers
    cleanupVideoHandlers();

    // Load all active scenes at this time
    if (state.compositorActive && state.compositor && state.compositor.isInitialized) {
        // WebGL2 compositor: just render the frame
        state.compositor.renderAtTime(state.currentTime);
    } else {
        await loadActiveScenes();
    }

    // Sync audio
    const audio = elements.previewAudio;
    if (audio?.src) {
        audio.currentTime = Math.min(state.currentTime, audio.duration || state.totalDuration);
    }

    // Get active scenes for highlighting
    const activeScenes = getActiveScenesAtTime(state.currentTime);
    updateSceneHighlight(activeScenes.length > 0 ? activeScenes[0].index : -1);
    updatePlayhead();
    updateTimeDisplay();
    if (!state.compositorActive) updateMGOverlay();

    // Resume if was playing and within content
    if (wasPlaying && activeScenes.length > 0) {
        startPlayback();
    }
}

function getSceneAtTime(time) {
    for (let i = state.scenes.length - 1; i >= 0; i--) {
        if (time >= state.scenes[i].startTime && time < state.scenes[i].endTime) return i;
    }
    // Allow sitting exactly at the end of the last scene
    if (state.scenes.length > 0) {
        const last = state.scenes[state.scenes.length - 1];
        if (Math.abs(time - last.endTime) < 0.05) return state.scenes.length - 1;
    }
    return -1;
}

/**
 * Compute Ken Burns start/end transform values for native export.
 * Returns { sStart, sEnd, txStart, txEnd, tyStart, tyEnd } in native units
 * (scale as factor, translate as pixels).
 */
function computeKenBurnsForExport(scene, rtW, rtH) {
    const none = { sStart: 1, sEnd: 1, txStart: 0, txEnd: 0, tyStart: 0, tyEnd: 0 };
    if (scene.kenBurnsEnabled === false) return none;

    const originalIndex = scene.index !== undefined ? scene.index : 0;
    const kbTypes = [
        'zoomIn', 'zoomOut',
        'panLeft', 'panRight', 'panUp', 'panDown',
        'zoomPanRight', 'zoomPanLeft',
        'zoomOutPanRight', 'zoomOutPanLeft',
        'driftTopLeftToBottomRight', 'driftBottomRightToTopLeft',
        'driftTopRightToBottomLeft', 'driftBottomLeftToTopRight',
    ];
    const kbType = kbTypes[(originalIndex * 13 + 7) % kbTypes.length];
    const gentle = scene.fitMode === 'contain';
    const s = gentle ? 0.4 : 1;

    // Helper: evaluate Ken Burns at progress p (0=start, 1=end)
    // Returns { scale, txPct, tyPct } where tx/ty are in % of RT size
    function evalKB(p) {
        let scale = 1, txPct = 0, tyPct = 0;
        switch (kbType) {
            case 'zoomIn':    scale = 1 + (0.03 + p * 0.12) * s; break;
            case 'zoomOut':   scale = 1 + (0.15 - p * 0.12) * s; break;
            case 'panLeft':   scale = 1 + 0.12 * s; txPct = (3 - p * 6) * s; break;
            case 'panRight':  scale = 1 + 0.12 * s; txPct = (-3 + p * 6) * s; break;
            case 'panUp':     scale = 1 + 0.12 * s; tyPct = (3 - p * 6) * s; break;
            case 'panDown':   scale = 1 + 0.12 * s; tyPct = (-3 + p * 6) * s; break;
            case 'zoomPanRight':    scale = 1 + (0.05 + p * 0.1) * s; txPct = (-2 + p * 4) * s; break;
            case 'zoomPanLeft':     scale = 1 + (0.05 + p * 0.1) * s; txPct = (2 - p * 4) * s; break;
            case 'zoomOutPanRight': scale = 1 + (0.15 - p * 0.08) * s; txPct = (-2 + p * 4) * s; break;
            case 'zoomOutPanLeft':  scale = 1 + (0.15 - p * 0.08) * s; txPct = (2 - p * 4) * s; break;
            case 'driftTopLeftToBottomRight':  scale = 1 + 0.15 * s; txPct = (-2 + p * 4) * s; tyPct = (-2 + p * 4) * s; break;
            case 'driftBottomRightToTopLeft':  scale = 1 + 0.15 * s; txPct = (2 - p * 4) * s; tyPct = (2 - p * 4) * s; break;
            case 'driftTopRightToBottomLeft':  scale = 1 + 0.15 * s; txPct = (2 - p * 4) * s; tyPct = (-2 + p * 4) * s; break;
            case 'driftBottomLeftToTopRight':  scale = 1 + 0.15 * s; txPct = (-2 + p * 4) * s; tyPct = (2 - p * 4) * s; break;
        }
        return { scale, txPct, tyPct };
    }

    const kbSpeed = scene.kenBurnsSpeed !== undefined ? scene.kenBurnsSpeed : 1;
    const start = evalKB(0);
    const end = evalKB(Math.min(1, kbSpeed));
    // Convert translate from % of RT to pixels
    return {
        sStart: start.scale,
        sEnd: end.scale,
        txStart: start.txPct / 100 * rtW,
        txEnd: end.txPct / 100 * rtW,
        tyStart: start.tyPct / 100 * rtH,
        tyEnd: end.tyPct / 100 * rtH,
    };
}

/**
 * Update Ken Burns transform on an image element based on current time
 */
function updateKenBurnsTransform(img, scene) {
    // If Ken Burns disabled for this scene, just apply scene transform
    if (scene.kenBurnsEnabled === false) {
        const sceneScale = scene.scale !== undefined ? scene.scale : 1;
        const scenePosX = scene.posX || 0;
        const scenePosY = scene.posY || 0;
        img.style.transform = `translate(${scenePosX}%, ${scenePosY}%) scale(${sceneScale})`;
        img.style.transformOrigin = 'center center';
        // Crop on img, radius on wrapper
        applyCrop(img, scene);
        const tn = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
        const wr = elements[`trackWrapper${tn}`];
        if (wr) { applyRadius(wr, scene); wr.style.clipPath = ''; }
        return;
    }
    const originalIndex = scene.index !== undefined ? scene.index : 0;
    const kbTypes = [
        'zoomIn', 'zoomOut',
        'panLeft', 'panRight', 'panUp', 'panDown',
        'zoomPanRight', 'zoomPanLeft',
        'zoomOutPanRight', 'zoomOutPanLeft',
        'driftTopLeftToBottomRight', 'driftBottomRightToTopLeft',
        'driftTopRightToBottomLeft', 'driftBottomLeftToTopRight',
    ];
    const kbType = kbTypes[(originalIndex * 13 + 7) % kbTypes.length];
    const sceneDur = scene.endTime - scene.startTime;
    const kbSpeed = scene.kenBurnsSpeed !== undefined ? scene.kenBurnsSpeed : 1;
    // Linear motion scaled by speed — higher speed = faster animation
    const rawP = sceneDur > 0 ? Math.max(0, Math.min(1, (state.currentTime - scene.startTime) / sceneDur)) : 0;
    const p = Math.min(1, rawP * kbSpeed);
    // Gentle Ken Burns for contain mode (charts, infographics stay mostly visible)
    const gentle = scene.fitMode === 'contain';
    const s = gentle ? 0.4 : 1; // scale factor for gentle mode
    let kbTransform = '';
    switch (kbType) {
        case 'zoomIn': kbTransform = `scale(${1 + (0.03 + p * 0.12) * s})`; break;
        case 'zoomOut': kbTransform = `scale(${1 + (0.15 - p * 0.12) * s})`; break;
        case 'panLeft': kbTransform = `scale(${1 + 0.12 * s}) translateX(${(3 - p * 6) * s}%)`; break;
        case 'panRight': kbTransform = `scale(${1 + 0.12 * s}) translateX(${(-3 + p * 6) * s}%)`; break;
        case 'panUp': kbTransform = `scale(${1 + 0.12 * s}) translateY(${(3 - p * 6) * s}%)`; break;
        case 'panDown': kbTransform = `scale(${1 + 0.12 * s}) translateY(${(-3 + p * 6) * s}%)`; break;
        case 'zoomPanRight': kbTransform = `scale(${1 + (0.05 + p * 0.1) * s}) translateX(${(-2 + p * 4) * s}%)`; break;
        case 'zoomPanLeft': kbTransform = `scale(${1 + (0.05 + p * 0.1) * s}) translateX(${(2 - p * 4) * s}%)`; break;
        case 'zoomOutPanRight': kbTransform = `scale(${1 + (0.15 - p * 0.08) * s}) translateX(${(-2 + p * 4) * s}%)`; break;
        case 'zoomOutPanLeft': kbTransform = `scale(${1 + (0.15 - p * 0.08) * s}) translateX(${(2 - p * 4) * s}%)`; break;
        case 'driftTopLeftToBottomRight': kbTransform = `scale(${1 + 0.15 * s}) translateX(${(-2 + p * 4) * s}%) translateY(${(-2 + p * 4) * s}%)`; break;
        case 'driftBottomRightToTopLeft': kbTransform = `scale(${1 + 0.15 * s}) translateX(${(2 - p * 4) * s}%) translateY(${(2 - p * 4) * s}%)`; break;
        case 'driftTopRightToBottomLeft': kbTransform = `scale(${1 + 0.15 * s}) translateX(${(2 - p * 4) * s}%) translateY(${(-2 + p * 4) * s}%)`; break;
        case 'driftBottomLeftToTopRight': kbTransform = `scale(${1 + 0.15 * s}) translateX(${(-2 + p * 4) * s}%) translateY(${(2 - p * 4) * s}%)`; break;
    }
    // Combine Ken Burns with scene scale/position
    const sceneScale = scene.scale !== undefined ? scene.scale : 1;
    const scenePosX = scene.posX || 0;
    const scenePosY = scene.posY || 0;
    const sceneTransform = `translate(${scenePosX}%, ${scenePosY}%) scale(${sceneScale})`;
    img.style.transform = kbTransform ? `${sceneTransform} ${kbTransform}` : sceneTransform;
    img.style.transformOrigin = 'center center';
    // Crop on img, radius on wrapper
    applyCrop(img, scene);
    const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
    const wrapper = elements[`trackWrapper${trackNum}`];
    if (wrapper) { applyRadius(wrapper, scene); wrapper.style.clipPath = ''; }
}

/**
 * Apply crop (clip-path) and border-radius to an element
 */
/**
 * Apply crop (clip-path) to a media element (video/img).
 * Crop is on the media so scaling can push cropped edges out of view.
 */
function applyCrop(el, scene) {
    const cropTop = scene.cropTop || 0;
    const cropRight = scene.cropRight || 0;
    const cropBottom = scene.cropBottom || 0;
    const cropLeft = scene.cropLeft || 0;
    if (cropTop || cropRight || cropBottom || cropLeft) {
        el.style.clipPath = `inset(${cropTop}% ${cropRight}% ${cropBottom}% ${cropLeft}%)`;
    } else {
        el.style.clipPath = '';
    }
}

/**
 * Apply border-radius to a wrapper element.
 * Radius is on the wrapper so it clips the entire content area cleanly.
 */
function applyRadius(el, scene) {
    const borderRadius = scene.borderRadius || 0;
    if (borderRadius) {
        el.style.borderRadius = `${borderRadius}%`;
        el.style.overflow = 'hidden';
    } else {
        el.style.borderRadius = '';
        el.style.overflow = '';
    }
}

/**
 * Get cached media URL for a scene (avoids repeated IPC calls)
 */
async function getCachedMediaUrl(sceneIndex, mediaExtension, type) {
    const cacheKey = `${sceneIndex}:${mediaExtension || ''}:${type || 'scene'}`;
    if (state._mediaUrlCache[cacheKey]) return state._mediaUrlCache[cacheKey];

    let mediaPath;
    if (type === 'overlay') {
        mediaPath = await window.electronAPI.getSceneMediaPath(sceneIndex, mediaExtension || '.mp4', 'overlay');
    } else {
        mediaPath = await window.electronAPI.getSceneMediaPath(sceneIndex, mediaExtension);
    }
    if (!mediaPath) {
        console.warn(`[MediaCache] No path for scene ${sceneIndex} ext=${mediaExtension} type=${type || 'scene'}`);
        return null;
    }
    const mediaUrl = await window.electronAPI.getFileUrl(mediaPath);
    if (mediaUrl) {
        state._mediaUrlCache[cacheKey] = mediaUrl;
    } else {
        console.warn(`[MediaCache] No URL for path: ${mediaPath}`);
    }
    return mediaUrl;
}

/**
 * Pre-buffer the NEXT video clip into each track's buffer element.
 * This ensures instant swap when the scene changes during playback.
 * URLs are pre-cached at plan load time; this loads the actual video data.
 */
function preloadUpcomingScenes(currentTime, force) {
    // Throttle: only check every 250ms (or immediately if forced)
    const now = performance.now();
    if (!force && now - state._lastPreloadCheck < 250) return;
    state._lastPreloadCheck = now;

    for (const tn of ['1', '2', '3']) {
        const trackId = `video-track-${tn}`;
        const { buffer } = getTrackVideoPair(tn);
        if (!buffer) continue;
        // Skip if this track has a swap pending (buffer is in use)
        if (state._trackSwapPending[tn]) continue;

        // Find the next video scene on this track (starts after current time, within 15s)
        const nextScene = state.scenes.find(s =>
            s.trackId === trackId &&
            !s.isMGScene && !s.disabled &&
            s.mediaType !== 'image' &&
            s.startTime > currentTime &&
            s.startTime - currentTime < 15
        );
        if (!nextScene) continue;

        const idx = nextScene.index !== undefined ? nextScene.index : state.scenes.indexOf(nextScene);
        const cacheKey = `${idx}:${nextScene.mediaExtension || ''}:scene`;
        const url = state._mediaUrlCache[cacheKey];

        if (url && buffer._loadedUrl !== url) {
            console.log(`[PreBuffer] Preloading scene ${idx} into track ${tn} buffer`);
            buffer.src = url;
            buffer._loadedUrl = url;
            buffer.load();
        }
    }
}

/**
 * Load all scenes that are active at the current time across all tracks
 */
async function loadActiveScenes(activeScenes) {
    // When compositor is active, it handles all rendering — skip HTML scene loading
    if (state.compositorActive && state.compositor && state.compositor.isInitialized) {
        return;
    }
    // Use passed-in activeScenes to avoid duplicate getActiveScenesAtTime call
    if (!activeScenes) activeScenes = getActiveScenesAtTime(state.currentTime);

    // Determine which tracks have active scenes
    const activeTracks = new Set();
    activeScenes.forEach(({ scene }) => {
        if (!scene.isMGScene && !scene.disabled) {
            const tn = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
            activeTracks.add(tn);
        }
    });

    // Apply blur to base video track when any upper-track overlay has bgBlur enabled
    const upperBlurScene = activeScenes.find(({ scene }) => {
        const tn = parseInt(scene.trackId?.match(/\d+/)?.[0] || '1', 10);
        return tn > 1 && !scene.disabled && scene.bgBlur && scene.bgBlur !== 'none';
    });
    const blurLevel = upperBlurScene?.scene?.bgBlur || 'none';
    const blurMap = { none: '', light: 'blur(3px)', medium: 'blur(6px)', heavy: 'blur(10px)' };
    const blurFilter = blurMap[blurLevel] || '';
    const t1Video = elements.videoTrack1;
    const t1VideoB = elements.videoTrack1B;
    const t1Img = elements.imgTrack1;
    if (t1Video) t1Video.style.filter = blurFilter;
    if (t1VideoB) t1VideoB.style.filter = blurFilter;
    if (t1Img) t1Img.style.filter = blurFilter;

    // Only hide tracks that are NOT active (avoids unnecessary DOM thrashing)
    ['1', '2', '3', '4', '5'].forEach(tn => {
        if (!activeTracks.has(tn)) {
            const videoA = elements[`videoTrack${tn}`];
            const videoB = elements[`videoTrack${tn}B`];
            const img = elements[`imgTrack${tn}`];
            if (videoA) videoA.classList.remove('active');
            if (videoB) videoB.classList.remove('active');
            if (img) {
                img.classList.remove('active');
                img.style.transform = '';
                img.style.objectFit = '';
            }
        }
    });
    // Hide background layer (will be re-shown if needed below)
    if (elements.bgVideo) elements.bgVideo.classList.remove('active');
    if (elements.bgImage) elements.bgImage.classList.remove('active');
    if (elements.bgGradient) elements.bgGradient.classList.remove('active');

    if (activeScenes.length === 0) {
        // No active scenes at this frame - hide video container
        if (elements.videoContainer) {
            elements.videoContainer.classList.add('hidden');
        }
        if (elements.videoControls) {
            elements.videoControls.classList.add('hidden');
        }
        // Only show the "Import audio" placeholder when the whole project is empty.
        // Otherwise we're just in a gap — keep placeholder hidden so the compositor frame remains.
        if (state.scenes.length === 0) {
            elements.previewPlaceholder.classList.remove('hidden');
        } else {
            elements.previewPlaceholder.classList.add('hidden');
        }
        return;
    }

    // Show video container
    elements.previewPlaceholder.classList.add('hidden');
    if (elements.videoContainer) {
        elements.videoContainer.classList.remove('hidden');
    }
    if (elements.videoControls) {
        elements.videoControls.classList.remove('hidden');
    }

    // Clear V3 MG preview layer if exists
    const mgV3Layer = document.getElementById('mg-v3-preview');
    if (mgV3Layer) {
        mgV3Layer.classList.remove('active');
        mgV3Layer.innerHTML = '';
    }

    // Load and show each active scene on its track (in parallel for speed)
    const sceneLoadPromises = [];
    for (const { scene, index } of activeScenes) {
        if (scene.disabled) continue; // Skip disabled clips

        // Full-screen MG scene on V3: render as HTML overlay (synchronous, no IPC)
        if (scene.isMGScene) {
            if (state.mutedTracks['video-track-3']) continue;
            const video3A = elements.videoTrack3;
            const video3B = elements.videoTrack3B;
            const img3 = elements.imgTrack3;
            if (video3A) video3A.classList.remove('active');
            if (video3B) video3B.classList.remove('active');
            if (img3) img3.classList.remove('active');

            const layer = document.getElementById('mg-v3-preview');
            if (layer) {
                layer.classList.add('active');
                const html = renderFullscreenMGPreview(scene);
                layer.innerHTML = html;
            }
            continue;
        }

        // Each scene loads in parallel (async IPC calls run concurrently)
        sceneLoadPromises.push((async () => {
            try {
                const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
                const img = elements[`imgTrack${trackNum}`];
                const isImage = scene.mediaType === 'image';

                const originalIndex = scene.index !== undefined ? scene.index : index;
                // V2 overlay scenes have mediaFile set directly — use it instead of index-based lookup
                let mediaUrl;
                if (scene.mediaFile) {
                    mediaUrl = await window.electronAPI.getFileUrl(scene.mediaFile);
                }
                if (!mediaUrl) {
                    mediaUrl = await getCachedMediaUrl(originalIndex, scene.mediaExtension);
                }
                if (!mediaUrl) {
                    console.warn(`[Preview] Scene ${index} (track ${trackNum}): no media URL found for index=${originalIndex} ext=${scene.mediaExtension}`);
                    return;
                }

                // Only log when source actually changes (avoid spamming console)
                const prevUrl = state._lastLoadedUrls && state._lastLoadedUrls[`t${trackNum}`];
                if (prevUrl !== mediaUrl) {
                    console.log(`[Preview] Loading scene ${index} on track ${trackNum}, isImage=${isImage}, url=${mediaUrl.substring(mediaUrl.lastIndexOf('/') + 1)}`);
                    if (!state._lastLoadedUrls) state._lastLoadedUrls = {};
                    state._lastLoadedUrls[`t${trackNum}`] = mediaUrl;
                }

                if (isImage && img) {
                    // IMAGE SCENE: show img, hide both video buffers for this track
                    const videoA = elements[`videoTrack${trackNum}`];
                    const videoB = elements[`videoTrack${trackNum}B`];
                    if (videoA) videoA.classList.remove('active');
                    if (videoB) videoB.classList.remove('active');
                    img.style.objectFit = scene.fitMode || 'cover';

                    const imgSourceChanging = img.src !== mediaUrl;

                    if (imgSourceChanging && img.src && state.isPlaying && !state.transition.isTransitioning) {
                        const transOutImg = elements.imgTransitionOut;
                        const container = elements.videoContainer;
                        if (transOutImg && container) {
                            transOutImg.style.zIndex = parseInt(trackNum) + 5;
                            img.classList.add('active');
                            performImageTransition(img, transOutImg, scene, mediaUrl);
                        }
                    } else {
                        if (imgSourceChanging) img.src = mediaUrl;
                        updateKenBurnsTransform(img, scene);
                        img.classList.add('active');
                    }
                } else {
                    // VIDEO SCENE: double-buffer swap for lag-free playback
                    if (img) img.classList.remove('active');

                    const { active: activeVid, buffer: bufferVid } = getTrackVideoPair(trackNum);
                    const sceneTime = (state.currentTime - scene.startTime) + (scene.mediaOffset || 0);

                    if (activeVid._loadedUrl === mediaUrl) {
                        // Same source already active — just sync time
                        if (Math.abs(activeVid.currentTime - sceneTime) > 0.15) {
                            activeVid.currentTime = sceneTime;
                        }
                        activeVid.volume = getSceneVolume(scene);
                        activeVid.muted = false;
                        activeVid.classList.add('active');
                        applySceneTransformToVideo(activeVid, scene);
                        if (state.isPlaying && activeVid.paused) {
                            activeVid.play().catch(() => { });
                        }
                    } else if (bufferVid._loadedUrl === mediaUrl && bufferVid.readyState >= 2) {
                        // Buffer has this source pre-loaded and ready
                        const transOut = elements.videoTransitionOut;
                        const shouldAnimate = state.isPlaying && !state.transition.isTransitioning
                            && activeVid._loadedUrl && transOut;

                        if (shouldAnimate) {
                            // Animated transition — load into dedicated transition-out element
                            // (browser cache serves it instantly since buffer already fetched it)
                            console.log(`[DoubleBuffer] Animated transition on track ${trackNum}`);
                            state._trackSwapPending[trackNum] = true;

                            transOut.src = mediaUrl;
                            transOut.load();
                            transOut.currentTime = sceneTime;
                            transOut.volume = getSceneVolume(scene);
                            transOut.muted = false;
                            transOut.style.zIndex = parseInt(trackNum) + 5;
                            applySceneTransformToVideo(transOut, scene);

                            // Fire-and-forget — performTrackTransition manages its own lifecycle
                            performTrackTransition(activeVid, transOut, originalIndex, mediaUrl, scene)
                                .then(() => {
                                    state._trackSwapPending[trackNum] = false;
                                    // After transition, activeVid has new source — update tracking
                                    activeVid._loadedUrl = mediaUrl;
                                    bufferVid._loadedUrl = null; // free buffer for next preload
                                }).catch(() => {
                                    state._trackSwapPending[trackNum] = false;
                                });
                        } else {
                            // Instant swap (not playing, already transitioning, or scrubbing)
                            console.log(`[DoubleBuffer] Instant swap on track ${trackNum}: buffer ready`);
                            activeVid.classList.remove('active');
                            activeVid.pause();

                            bufferVid.currentTime = sceneTime;
                            bufferVid.volume = getSceneVolume(scene);
                            bufferVid.muted = false;
                            bufferVid.classList.add('active');
                            applySceneTransformToVideo(bufferVid, scene);
                            if (state.isPlaying) bufferVid.play().catch(() => { });

                            swapTrackActive(trackNum);
                        }
                    } else if (!activeVid._loadedUrl) {
                        // First load on this track — load directly into active element
                        console.log(`[DoubleBuffer] First load on track ${trackNum}`);
                        activeVid.src = mediaUrl;
                        activeVid._loadedUrl = mediaUrl;
                        activeVid.load();
                        activeVid.currentTime = sceneTime;
                        activeVid.volume = getSceneVolume(scene);
                        activeVid.muted = false;
                        activeVid.classList.add('active');
                        applySceneTransformToVideo(activeVid, scene);
                        if (state.isPlaying && activeVid.paused) {
                            activeVid.play().catch(() => { });
                        }
                    } else {
                        // Fallback: NON-BLOCKING — old clip stays visible while buffer loads
                        // The swap happens asynchronously when buffer is ready (no await)
                        console.log(`[DoubleBuffer] Deferred swap on track ${trackNum} (buffer miss)`);
                        state._trackSwapPending[trackNum] = true;

                        // Only re-load if buffer doesn't already have this URL
                        if (bufferVid._loadedUrl !== mediaUrl) {
                            bufferVid.src = mediaUrl;
                            bufferVid._loadedUrl = mediaUrl;
                            bufferVid.load();
                        }

                        // Fire-and-forget: swap when buffer is ready
                        let swapped = false;
                        const doSwap = () => {
                            if (swapped) return;
                            swapped = true;
                            // Guard: if scene is no longer active (user seeked), skip stale swap
                            if (state.currentTime < scene.startTime || state.currentTime >= scene.endTime) {
                                state._trackSwapPending[trackNum] = false;
                                return;
                            }
                            // Use CURRENT time (not stale sceneTime from when load started)
                            const now = (state.currentTime - scene.startTime) + (scene.mediaOffset || 0);
                            activeVid.classList.remove('active');
                            activeVid.pause();

                            bufferVid.currentTime = Math.max(0, now);
                            bufferVid.volume = getSceneVolume(scene);
                            bufferVid.muted = false;
                            bufferVid.classList.add('active');
                            applySceneTransformToVideo(bufferVid, scene);
                            if (state.isPlaying) bufferVid.play().catch(() => { });

                            swapTrackActive(trackNum);
                            state._trackSwapPending[trackNum] = false;
                        };
                        if (bufferVid.readyState >= 2) {
                            doSwap();
                        } else {
                            bufferVid.addEventListener('canplay', doSwap, { once: true });
                            setTimeout(doSwap, 300); // short timeout — old clip plays naturally meanwhile
                        }
                        // Don't await — loadActiveScenes returns immediately, old clip keeps playing
                    }
                }
            } catch (e) {
                console.error('[Preview] Failed to load scene media:', e);
            }
        })());
    }
    // Wait for all scene loads to complete in parallel
    if (sceneLoadPromises.length > 0) await Promise.all(sceneLoadPromises);

    // ===== Background layer rendering =====
    // Find primary visible scene (lowest track, non-overlay, non-MG) and show its background
    const primaryScene = activeScenes.find(s => !s.scene.isMGScene && !s.scene.disabled);
    if (primaryScene && primaryScene.scene.background && primaryScene.scene.background !== 'none') {
        const bgType = primaryScene.scene.background;
        const scene = primaryScene.scene;

        if (bgType === 'blur') {
            // Blur mode: duplicate the same video/image source behind it
            if (elements.bgGradient) elements.bgGradient.classList.remove('active');
            const trackNum = scene.trackId?.match(/video-track-(\d)/)?.[1] || '1';
            const activeVideo = getActiveTrackVideo(trackNum);
            const img = elements[`imgTrack${trackNum}`];
            const isImage = scene.mediaType === 'image';

            if (isImage && img && img.src) {
                // Blur background from image source
                if (elements.bgVideo) elements.bgVideo.classList.remove('active');
                if (elements.bgImage) {
                    if (elements.bgImage.src !== img.src) elements.bgImage.src = img.src;
                    elements.bgImage.style.filter = 'blur(25px)';
                    elements.bgImage.style.transform = 'scale(1.3)';
                    elements.bgImage.classList.add('active');
                }
            } else if (activeVideo && activeVideo.src) {
                // Blur background from video source
                // During playback, DEFER bgVideo.load() to avoid competing with buffer decode
                if (elements.bgImage) elements.bgImage.classList.remove('active');
                if (elements.bgVideo) {
                    if (elements.bgVideo.src !== activeVideo.src) {
                        if (state.isPlaying) {
                            // Defer: just mark the URL, load lazily on next pause/seek
                            elements.bgVideo._pendingSrc = activeVideo.src;
                            elements.bgVideo.classList.add('active');
                        } else {
                            elements.bgVideo.src = activeVideo.src;
                            elements.bgVideo._pendingSrc = null;
                            elements.bgVideo.load();
                        }
                    }
                    if (elements.bgVideo.src && !elements.bgVideo._pendingSrc) {
                        elements.bgVideo.currentTime = activeVideo.currentTime;
                    }
                    elements.bgVideo.classList.add('active');
                    if (state.isPlaying && elements.bgVideo.paused && elements.bgVideo.src) elements.bgVideo.play().catch(() => { });
                }
            } else {
                // Fallback: blur source not yet loaded — show dark gradient instead of pure black
                if (elements.bgImage) elements.bgImage.classList.remove('active');
                if (elements.bgVideo) elements.bgVideo.classList.remove('active');
                if (elements.bgGradient) {
                    elements.bgGradient.style.background = 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)';
                    elements.bgGradient.classList.add('active');
                }
            }
        } else if (bgType.startsWith('pattern:')) {
            // Pattern mode: show a background file from assets/backgrounds/
            if (elements.bgGradient) elements.bgGradient.classList.remove('active');
            const filename = bgType.replace('pattern:', '');
            const bg = state.availableBackgrounds.find(b => b.filename === filename);
            if (bg) {
                try {
                    const bgUrl = await window.electronAPI.getBackgroundUrl(filename);
                    if (bgUrl) {
                        const isImage = bg.mediaType === 'image';
                        if (isImage) {
                            if (elements.bgVideo) elements.bgVideo.classList.remove('active');
                            if (elements.bgImage) {
                                if (elements.bgImage.src !== bgUrl) elements.bgImage.src = bgUrl;
                                elements.bgImage.style.filter = '';
                                elements.bgImage.style.transform = '';
                                elements.bgImage.classList.add('active');
                            }
                        } else {
                            if (elements.bgImage) elements.bgImage.classList.remove('active');
                            if (elements.bgVideo) {
                                if (elements.bgVideo.src !== bgUrl) {
                                    elements.bgVideo.src = bgUrl;
                                    elements.bgVideo.load();
                                }
                                elements.bgVideo.style.filter = '';
                                elements.bgVideo.style.transform = '';
                                elements.bgVideo.classList.add('active');
                                if (state.isPlaying && elements.bgVideo.paused) elements.bgVideo.play().catch(() => { });
                            }
                        }
                    }
                } catch (e) { /* best effort */ }
            }
        } else if (bgType.startsWith('gradient:')) {
            // Gradient mode: show a CSS gradient from the built-in library
            const gradientId = bgType.replace('gradient:', '');
            const gradientCSS = GRADIENT_BACKGROUNDS[gradientId];
            if (gradientCSS && elements.bgGradient) {
                if (elements.bgVideo) elements.bgVideo.classList.remove('active');
                if (elements.bgImage) elements.bgImage.classList.remove('active');
                elements.bgGradient.style.background = gradientCSS;
                elements.bgGradient.classList.add('active');
            }
        }
    }

    // Update MG overlay for current time
    updateMGOverlay();
}

function setupVideoPlayback(scene) {
    // Multi-track system: playback handled in the main playback loop
    // This function is kept for compatibility but is now a no-op
    // All video loading and syncing happens in loadActiveScenes() and the playback loop
}

let _lastHighlightIndex = -1;
let _lastAutoSelectIndex = -1;
function updateSceneHighlight(index) {
    // Skip if highlight hasn't changed
    if (index === _lastHighlightIndex) return;
    _lastHighlightIndex = index;
    document.querySelectorAll('.scene-card').forEach((c, i) => c.classList.toggle('active', i === index));
    document.querySelectorAll('.timeline-clip[data-index]').forEach(c => c.classList.toggle('active', parseInt(c.dataset.index) === index));

    // Auto-select the topmost track scene under playhead for properties panel
    // Skip if user has a multi-selection active (Ctrl+click)
    if (state.selectedClipIndices.length > 1) return;

    // Find ALL active scenes at current time, pick topmost track (highest z-order)
    const activeScenes = getActiveScenesAtTime(state.currentTime);
    const activeMedia = activeScenes.filter(({ scene }) => !scene.isMGScene && !scene.disabled);
    // Last in array = highest track number = topmost visual layer
    const topScene = activeMedia.length > 0 ? activeMedia[activeMedia.length - 1] : null;
    const autoIndex = topScene ? topScene.index : index;

    if (autoIndex >= 0 && autoIndex !== _lastAutoSelectIndex) {
        _lastAutoSelectIndex = autoIndex;
        state.selectedClipIndex = autoIndex;
        state.selectedClipIndices = [autoIndex];
        state.selectedMgIndex = -1;
        // Update visual selection on timeline
        document.querySelectorAll('.timeline-clip').forEach(c => c.classList.remove('selected'));
        document.querySelectorAll('.mg-clip').forEach(c => c.classList.remove('selected'));
        const clip = document.querySelector(`.timeline-clip[data-index="${autoIndex}"]`);
        if (clip) clip.classList.add('selected');
        updateClipProperties();
    }
}

// ========================================
// Render Video
// ========================================
// ========================================
// WebGL2 Compositor Engine Integration
// ========================================

/**
 * Initialize the WebGL2 compositor engine.
 * Called once during init() — creates the engine but does NOT activate it.
 */
function initCompositor() {
    const canvas = document.getElementById('compositor-canvas');
    if (!canvas) {
        console.warn('[Compositor] Canvas element not found');
        return;
    }

    try {
        state.compositor = new Compositor(canvas, {
            width: 1920, height: 1080, fps: 30,
        });
        console.log('[Compositor] Engine created (not yet active)');

        // Wire up the compositor toggle button
        const toggleBtn = document.getElementById('btn-compositor-toggle');
        if (toggleBtn) {
            toggleBtn.style.display = 'inline-block';
            toggleBtn.addEventListener('click', () => {
                setCompositorMode(!state.compositorActive);
            });
        }

        // Wire up preview quality selector
        const qualitySelect = document.getElementById('preview-quality');
        if (qualitySelect) {
            qualitySelect.addEventListener('change', () => {
                const scale = parseFloat(qualitySelect.value) || 0.5;
                if (state.compositor) {
                    state.compositor.setPreviewScale(scale);
                    // Re-render current frame at new resolution
                    if (state.compositorActive && state.compositor.isInitialized) {
                        state.compositor.renderAtTime(state.currentTime);
                    }
                }
            });
        }

        // Auto-activate when WebGL2 renderer is selected + show legacy toggle
        const rendererSelect = document.getElementById('renderer-select');
        const legacyLabel = document.getElementById('legacy-export-label');
        if (rendererSelect) {
            const updateLegacyVisibility = () => {
                if (legacyLabel) legacyLabel.style.display = rendererSelect.value === 'webgl2' ? 'flex' : 'none';
            };
            rendererSelect.addEventListener('change', () => {
                if (rendererSelect.value === 'webgl2' && !state.compositorActive) {
                    setCompositorMode(true);
                }
                updateLegacyVisibility();
            });
            updateLegacyVisibility();
        }
    } catch (e) {
        console.error('[Compositor] Failed to create engine:', e);
        state.compositor = null;
    }
}

/**
 * Toggle between HTML preview and WebGL2 compositor preview.
 */
async function setCompositorMode(active) {
    state.compositorActive = active;
    const canvas = document.getElementById('compositor-canvas');
    const htmlLayers = document.querySelectorAll('.track-wrapper, .mg-overlay, .mg-v3-preview-layer, .bg-media');
    const toggleBtn = document.getElementById('btn-compositor-toggle');
    const qualitySelect = document.getElementById('preview-quality');

    if (active) {
        // Initialize if not yet done
        if (state.compositor && !state.compositor.isInitialized) {
            state.compositor.init();
        }
        // Load plan into compositor if we have one
        if (canvas) canvas.classList.add('active');
        htmlLayers.forEach(el => el.style.visibility = 'hidden');
        if (toggleBtn) {
            toggleBtn.textContent = 'Engine: ON';
            toggleBtn.style.background = '#22c55e';
            toggleBtn.style.color = '#000';
        }
        if (qualitySelect) qualitySelect.style.display = '';
        console.log('[Compositor] Preview mode ENABLED');
        // Load plan (async preload) THEN render — must await so elements are ready
        if (state.compositor && state.videoPlan) {
            await loadPlanIntoCompositor();
        }
        // Render current frame AFTER preload completes so textures are available
        if (state.compositor && state.compositor.isInitialized) {
            state.compositor.renderAtTime(state.currentTime);
        }
    } else {
        if (canvas) canvas.classList.remove('active');
        htmlLayers.forEach(el => el.style.visibility = '');
        if (toggleBtn) {
            toggleBtn.textContent = 'Engine: OFF';
            toggleBtn.style.background = '';
            toggleBtn.style.color = '';
        }
        if (qualitySelect) qualitySelect.style.display = 'none';
        // Pause compositor videos
        if (state.compositor) state.compositor.pauseVideos();
        console.log('[Compositor] Preview mode DISABLED');
    }
}

/**
 * Load the current video plan into the compositor engine.
 * Builds a synthetic plan from the PROCESSED state (state.scenes + state.motionGraphics)
 * so the compositor sees the exact same data as the timeline preview.
 * Uses getCachedMediaUrl as the URL resolver.
 */

/**
 * Lightweight sync: push current MG overlay data into the compositor's
 * scene graph and re-render the current frame.  Does NOT reload videos
 * or rebuild the full plan — safe to call on every property edit.
 */
/**
 * Sync a scene's visual properties (scale, pos, crop, etc.) to the compositor's SceneGraph copy
 * so changes are reflected in the WebGL preview without toggling the engine.
 */
function refreshCompositorScene(sceneIndex) {
    if (!state.compositorActive || !state.compositor || !state.compositor.isInitialized) return;
    const sg = state.compositor.sceneGraph;
    if (!sg) return;
    const srcScene = state.scenes[sceneIndex];
    if (!srcScene) return;

    // Find the matching scene in the SceneGraph's internal copy
    const target = sg._scenes.find(s => s.index === srcScene.index);
    if (!target) return;

    // Sync mutable visual properties
    target.scale = srcScene.scale;
    target.posX = srcScene.posX;
    target.posY = srcScene.posY;
    target.fitMode = srcScene.fitMode;
    target.cropTop = srcScene.cropTop;
    target.cropBottom = srcScene.cropBottom;
    target.cropLeft = srcScene.cropLeft;
    target.cropRight = srcScene.cropRight;
    target.borderRadius = srcScene.borderRadius;
    target.background = srcScene.background;
    target.volume = srcScene.volume;
    target.kenBurnsEnabled = srcScene.kenBurnsEnabled;
    target.kenBurnsSpeed = srcScene.kenBurnsSpeed;
    target.effectOverrides = srcScene.effectOverrides;
    target.effectMask = srcScene.effectMask;
    target.framing = srcScene.framing;
    target.shadow = srcScene.shadow;
    target.floatingAnim = srcScene.floatingAnim;
    target.floatingAnimDuration = srcScene.floatingAnimDuration;

    // Re-render current frame
    const fps = state.compositor.fps;
    const frame = Math.round((state.currentTime || 0) * fps);
    state.compositor.renderFrame(frame);
}

function refreshCompositorMGs() {
    if (!state.compositorActive || !state.compositor || !state.compositor.isInitialized) return;
    const sg = state.compositor.sceneGraph;
    if (!sg) return;

    // Sync overlay MGs (the _mgs array inside SceneGraph)
    const fps = state.compositor.fps;
    const activeMGs = (state.motionGraphics || []).filter(mg => !mg.disabled);
    sg._mgs = activeMGs.map(mg => {
        const startFrame = Math.round((mg.startTime || 0) * fps);
        const dur = mg.duration || 3;
        const endFrame = Math.round((mg.startTime + dur) * fps);
        return {
            ...mg,
            _startFrame: startFrame,
            _endFrame: endFrame,
            _totalFrames: endFrame - startFrame,
            _animationSpeed: mg.animationSpeed || 1.0,
            overlayShadowStrength: mg.overlayShadowStrength != null ? mg.overlayShadowStrength : state.mgOverlayShadow,
        };
    });

    // Sync fullscreen MG scenes (_scenes that are isMGScene)
    const mgScenes = state.scenes.filter(s => s.isMGScene);
    for (const mgScene of mgScenes) {
        // Match by index first, then fall back to startTime for mgScenes missing index
        const existing = sg._scenes.find(s => s.isMGScene && (
            (s.index != null && mgScene.index != null && s.index === mgScene.index) ||
            (s.index == null && Math.abs((s.startTime || 0) - (mgScene.startTime || 0)) < 0.01)
        ));
        if (existing) {
            // Recompute frame range from seconds
            const startFrame = Math.round((mgScene.startTime || 0) * fps);
            const endFrame = Math.round((mgScene.endTime || (mgScene.startTime + (mgScene.duration || 3))) * fps);
            // Update all mutable fields including duration, frames, animation speed, and background
            Object.assign(existing, {
                type: mgScene.type, text: mgScene.text, subtext: mgScene.subtext,
                style: mgScene.style, subType: mgScene.subType, animation: mgScene.animation,
                position: mgScene.position,
                data: mgScene.data, mgData: mgScene.mgData,
                mgBackground: mgScene.mgBackground,
                duration: mgScene.duration,
                startTime: mgScene.startTime, endTime: mgScene.endTime,
                _startFrame: startFrame, _endFrame: endFrame,
                _totalFrames: endFrame - startFrame,
                _animationSpeed: mgScene.animationSpeed || 1.0,
                _listicleItems: mgScene._listicleItems,
                _itemThumbnails: mgScene._itemThumbnails,
                _itemThumbnailUrls: mgScene._itemThumbnailUrls,
                // Map properties
                _mapPolyColor: mgScene._mapPolyColor,
                _mapWaypoints: mgScene._mapWaypoints,
                _mapBigMap: mgScene._mapBigMap,
                _bigMapSize: mgScene._bigMapSize,
                _wpCoords: mgScene._wpCoords,
                _osmBoundaries: mgScene._osmBoundaries,
                _mapZoomSpeed: mgScene._mapZoomSpeed,
                _mapPolySpeed: mgScene._mapPolySpeed,
                _mapEasing: mgScene._mapEasing,
                _mapTiltKfStart: mgScene._mapTiltKfStart,
                _mapTiltKfEnd: mgScene._mapTiltKfEnd,
                _mapZoomKfStart: mgScene._mapZoomKfStart,
                _mapZoomKfEnd: mgScene._mapZoomKfEnd,
                _mapCinematic: mgScene._mapCinematic,
                mapStyle: mgScene.mapStyle,
                mapVariant: mgScene.mapVariant,
                _mapIcons: mgScene._mapIcons,
            });
        }
    }

    // Re-render current frame
    const frame = Math.round((state.currentTime || 0) * fps);
    state.compositor.renderFrame(frame);
}

async function loadPlanIntoCompositor() {
    if (!state.compositor || !state.videoPlan) return;

    try {
        // Build a plan from the processed state so compositor matches the timeline exactly.
        // state.videoPlan has the RAW plan; state.scenes has the processed/carved/reordered scenes.
        // Build scenes list for compositor
        const compositorScenes = state.scenes.filter(s => !s.isMGScene).map((s, i) => ({
            ...s,
            index: s.index !== undefined ? s.index : i,
        }));

        // Build transitions array from adjacent scenes on the same track.
        // The SceneGraph expects { fromSceneIndex, toSceneIndex, type, duration }.
        // The UI stores transitions as per-scene `transitionType` or global `state.transition.style`.
        const transitions = [];
        const globalStyle = state.transition.style || 'cut';
        const globalDuration = state.transition.duration || 0.5;
        const trackGroups = {};
        for (const s of compositorScenes) {
            const tid = s.trackId || 'video-track-1';
            if (!trackGroups[tid]) trackGroups[tid] = [];
            trackGroups[tid].push(s);
        }
        for (const tid of Object.keys(trackGroups)) {
            const sorted = trackGroups[tid].sort((a, b) => a.startTime - b.startTime);
            for (let i = 1; i < sorted.length; i++) {
                const prev = sorted[i - 1];
                const curr = sorted[i];
                // Only add transition if scenes are adjacent (gap < 0.1s)
                if (Math.abs(curr.startTime - prev.endTime) > 0.1) continue;
                let type = curr.transitionType
                    || (globalStyle !== 'auto' ? globalStyle : null)
                    || curr.transition?.type
                    || 'crossfade';
                if (type === 'random') {
                    const seed = curr.index * 7 + 3;
                    const types = state.transition.types.length > 0 ? state.transition.types : ['crossfade'];
                    type = types[seed % types.length];
                }
                if (type === 'cut' || type === 'none') continue;
                // Use AI-assigned duration when in auto mode, else global slider
                const dur = (globalStyle === 'auto' && curr.transition?.duration)
                    ? curr.transition.duration
                    : globalDuration;
                transitions.push({
                    fromSceneIndex: prev.index,
                    toSceneIndex: curr.index,
                    type,
                    duration: dur,
                });
            }
        }

        console.log(`[Compositor] Built ${transitions.length} transitions (style: ${globalStyle}, duration: ${globalDuration}s)`);
        if (transitions.length > 0) console.log('[Compositor] First transition:', JSON.stringify(transitions[0]));

        const compositorPlan = {
            fps: state.videoPlan.fps || 30,
            totalDuration: state.totalDuration || state.videoPlan.totalDuration,
            scriptContext: state.videoPlan.scriptContext || {},
            scenes: compositorScenes,
            // Fullscreen MG scenes
            mgScenes: state.scenes.filter(s => s.isMGScene).map(s => ({ ...s })),
            // Overlay motion graphics
            motionGraphics: (state.motionGraphics || [])
                .filter(mg => !mg.disabled)
                .map(mg => ({
                    ...mg,
                    overlayShadowStrength: mg.overlayShadowStrength != null ? mg.overlayShadowStrength : state.mgOverlayShadow,
                })),
            // Transitions (built from adjacent scenes above)
            transitions,
        };

        await state.compositor.loadPlan(compositorPlan, async (sceneIndex, ext) => {
            return getCachedMediaUrl(sceneIndex, ext);
        }, async (mediaFile) => {
            // Resolve full file path to a file:// URL for compositor overlay scenes
            if (window.electronAPI.getFileUrl) {
                return window.electronAPI.getFileUrl(mediaFile).catch(() => null);
            }
            return null;
        });

        // Render current frame after preload so loaded textures are visible immediately
        if (state.compositor.isInitialized) {
            state.compositor.renderAtTime(state.currentTime || 0);
        }
    } catch (e) {
        console.error('[Compositor] Failed to load plan:', e);
    }
}


/**
 * Run WebGL2 export pipeline.
 * Renders all frames via the engine and pipes to FFmpeg via IPC.
 */
async function renderVideoWebGL2() {
    if (!state.compositor || !state.videoPlan) {
        showToast('Compositor not initialized or no plan loaded', 'error');
        return;
    }

    // Ensure compositor is initialized and plan is loaded
    if (!state.compositor.isInitialized) {
        state.compositor.init();
    }
    await loadPlanIntoCompositor();

    const legacyToggle = document.getElementById('legacy-export-toggle');
    const useLegacy = legacyToggle && legacyToggle.checked;
    const fps = state.videoPlan.fps || 30;

    const pipeline = new ExportPipeline(state.compositor);
    state.exportPipeline = pipeline; // Store so cancelProcess() can reach it
    pipeline.onProgress((data) => {
        const mode = useLegacy ? 'Legacy' : 'Optimized';
        updateProgress(data.percent, `[${mode}] Rendering frame ${data.currentFrame}/${data.totalFrames} (${data.fps} fps)`);
    });

    // Run validation hashes before export (logs to console for A/B comparison)
    const totalFrames = state.compositor.totalFrames;
    const testFrames = [0, 100, Math.min(500, totalFrames - 1), totalFrames - 1].filter((f, i, a) => a.indexOf(f) === i);
    console.log(`[WebGL2 Export] Running frame hash validation on frames: ${testFrames.join(', ')}`);
    const hashes = await pipeline.validate(testFrames);
    console.log('[WebGL2 Export] Validation hashes:', JSON.stringify(hashes));

    // In/Out point support: convert seconds to frames
    const { inSec, outSec } = getRenderRange();
    const startFrame = Math.round(inSec * fps);
    const endFrame = Math.round(outSec * fps);
    const hasRange = state.inPoint !== null || state.outPoint !== null;
    if (hasRange) {
        console.log(`[WebGL2 Export] In/Out range: ${inSec.toFixed(2)}s-${outSec.toFixed(2)}s → frames ${startFrame}-${endFrame}`);
    }

    try {
        const result = await pipeline.start({
            width: 1920,
            height: 1080,
            fps,
            legacy: useLegacy,
            startFrame: hasRange ? startFrame : undefined,
            endFrame: hasRange ? endFrame : undefined,
        });
        return result;
    } finally {
        state.exportPipeline = null;
    }
}

async function renderVideo() {
    if (!state.videoPlan || state.isProcessing) return;
    state.isProcessing = true; elements.btnRender.disabled = true; showProgress(true); startTimer();
    try {
        // Save current scene state + transition style + SFX into the plan before rendering
        // Separate MG scenes from regular scenes for the renderer
        state.videoPlan.scenes = state.scenes.filter(s => !s.isMGScene).map((s, i) => ({ ...s, index: i }));
        state.videoPlan.mgScenes = state.scenes.filter(s => s.isMGScene && !s.disabled && !s.templateType).map(s => ({ ...s }));
        state.videoPlan.templateScenes = state.scenes.filter(s => s.isMGScene && !s.disabled && s.templateType).map(s => ({ ...s }));
        state.videoPlan.totalDuration = state.totalDuration;
        state.videoPlan.transitionStyle = elements.transitionStyle.value;
        // Add SFX data to plan
        generateSfxClips();
        state.videoPlan.sfxEnabled = state.sfxEnabled;
        state.videoPlan.sfxVolume = state.sfxVolume;
        state.videoPlan.sfxClips = state.sfxClips.map(sfx => ({
            file: sfx.file,
            startTime: sfx.startTime,
            duration: sfx.duration,
            volume: sfx.volume
        }));
        // Subtitles flag
        state.videoPlan.subtitlesEnabled = state.subtitlesEnabled;
        // Add motion graphics data to plan
        state.videoPlan.mgEnabled = state.mgEnabled;
        state.videoPlan.mgStyle = state.mgStyle;
        state.videoPlan.motionGraphics = state.motionGraphics.filter(mg => !mg.disabled).map(mg => {
            const base = {
                id: mg.id,
                type: mg.type,
                text: mg.text,
                subtext: mg.subtext || '',
                startTime: mg.startTime,
                duration: mg.duration,
                position: mg.position,
                sceneIndex: mg.sceneIndex,
                style: mg.style || state.mgStyle || 'clean',
                subType: mg.subType || undefined,
                animation: mg.animation || undefined,
                animationSpeed: mg.animationSpeed || undefined,
                overlayShadowStrength: mg.overlayShadowStrength != null ? mg.overlayShadowStrength : state.mgOverlayShadow,
                styleManual: mg.styleManual === true ? true : undefined,
                variantManual: mg.variantManual === true ? true : undefined,
                animationManual: mg.animationManual === true ? true : undefined,
            };
            // Preserve explainer-specific fields
            if (mg.type === 'explainer') {
                if (mg.explainerImageFile) base.explainerImageFile = mg.explainerImageFile;
                if (mg.explainerLabel) base.explainerLabel = mg.explainerLabel;
                if (mg.explainerQuery) base.explainerQuery = mg.explainerQuery;
                if (mg.explainerBgOpacity != null) base.explainerBgOpacity = mg.explainerBgOpacity;
                if (mg.explainerImgScale != null) base.explainerImgScale = mg.explainerImgScale;
                if (mg.explainerShadow) base.explainerShadow = mg.explainerShadow;
            }
            // Preserve articleHighlight-specific fields
            if (mg.articleImageFile) base.articleImageFile = mg.articleImageFile;
            if (mg.highlightBoxes) base.highlightBoxes = mg.highlightBoxes;
            // Preserve mapChart-specific fields
            if (mg.mapImageFile) base.mapImageFile = mg.mapImageFile;
            if (mg._mapView) base._mapView = mg._mapView;
            if (mg._mapPins) base._mapPins = mg._mapPins;
            return base;
        });
        // Save muted tracks so Composition.jsx can mute audio accordingly
        state.videoPlan.mutedTracks = { ...state.mutedTracks };
        // Global MG animation speed
        const globalAnimSpeed = parseFloat(document.getElementById('mg-global-anim-speed')?.value) || 1.0;
        if (!state.videoPlan.scriptContext) state.videoPlan.scriptContext = {};
        state.videoPlan.scriptContext.mgAnimationSpeed = globalAnimSpeed;
        state.videoPlan.scriptContext.mgOverlayShadow = state.mgOverlayShadow;
        await window.electronAPI.saveVideoPlan(state.videoPlan);

        updateProgress(5, 'Starting WebGL2 WYSIWYG render...');
        let result = await renderVideoWebGL2();
        if (result.success) {
            stopTimer();
            const renderTime = getElapsedString();
            updateProgress(100, `✅ Video rendered! (${renderTime})`);
            showToast(`Video rendered in ${renderTime}!`, 'success');
            showNotification('Render Complete', `Video rendered in ${renderTime}`);
            if (result.outputPath) showFinalVideo(result.outputPath);
        } else {
            stopTimer();
            const errorMsg = result.error || 'Render failed';
            if (errorMsg === 'Cancelled' || errorMsg.includes('cancelled') || errorMsg.includes('Cancelled')) {
                updateProgress(0, '⛔ Render cancelled');
                showToast('Render cancelled', 'info');
                showNotification('Render Cancelled', `Stopped after ${getElapsedString()}`, 'cancel');
            } else {
                const shortError = errorMsg.length > 100 ? errorMsg.substring(0, 100) + '...' : errorMsg;
                updateProgress(0, `❌ ${errorMsg}`);
                showToast(`Render error: ${shortError}`, 'error');
                showNotification('Render Failed', shortError, 'error');
                console.error('❌ Render error:', errorMsg);
            }
        }
    } catch (e) {
        stopTimer();
        console.error('❌ Render error:', e);
        const errMsg = e.message.length > 100 ? e.message.substring(0, 100) + '...' : e.message;
        showToast(`Render error: ${errMsg}`, 'error');
        showNotification('Render Failed', errMsg, 'error');
        updateProgress(0, `❌ ${e.message}`);
    } finally {
        state.isProcessing = false;
        elements.btnRender.disabled = false;
        elements.btnCancel.disabled = false;
        elements.btnCancel.textContent = 'Cancel';
        setTimeout(() => showProgress(false), 5000);
    }
}

async function showFinalVideo(videoPath) {
    try {
        // Stop any existing playback
        stopPlayback();
        cleanupVideoHandlers();

        const url = await window.electronAPI.getFileUrl(videoPath);
        if (url && elements.previewVideo && elements.previewPlaceholder) {
            elements.previewPlaceholder.classList.add('hidden');
            elements.previewVideo.classList.remove('hidden');
            elements.previewVideo.src = url;
            elements.previewVideo.play();
        } else if (url) {
            console.warn('[showFinalVideo] Preview elements not found, skipping video display');
        }
        showToast('Video rendered!', 'success');
    } catch (e) {
        console.error('Failed to show final video:', e);
    }
}

// ========================================
// UI Helpers
// ========================================
function showProgress(show) { elements.progressContainer.classList.toggle('hidden', !show); if (!show) stopTimer(); }
function updateProgress(percent, message) { elements.progressFill.style.width = `${percent}%`; elements.progressText.textContent = message; }

// Build / Render timer
let _timerInterval = null;
let _timerStart = 0;
function startTimer() {
    stopTimer();
    _timerStart = Date.now();
    updateTimerDisplay();
    _timerInterval = setInterval(updateTimerDisplay, 1000);
}
function stopTimer() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
}
function updateTimerDisplay() {
    const elapsed = Math.floor((Date.now() - _timerStart) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    parts.push(`${String(m).padStart(2, '0')}m`);
    parts.push(`${String(s).padStart(2, '0')}s`);
    if (elements.progressTimer) elements.progressTimer.textContent = parts.join(' ');
}
function getElapsedString() {
    const elapsed = Math.floor((Date.now() - _timerStart) / 1000);
    const h = Math.floor(elapsed / 3600);
    const m = Math.floor((elapsed % 3600) / 60);
    const s = elapsed % 60;
    const parts = [];
    if (h > 0) parts.push(`${h}h`);
    if (m > 0 || h > 0) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
}
// ========================================
// Notification Center (persisted, 3-day max)
// ========================================
const NOTIF_STORAGE_KEY = 'faceless_notifications';
const NOTIF_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

function loadNotifications() {
    try {
        const raw = localStorage.getItem(NOTIF_STORAGE_KEY);
        if (!raw) return [];
        const items = JSON.parse(raw);
        const cutoff = Date.now() - NOTIF_MAX_AGE_MS;
        return items.filter(n => n.timestamp > cutoff);
    } catch { return []; }
}

function saveNotifications(items) {
    localStorage.setItem(NOTIF_STORAGE_KEY, JSON.stringify(items));
}

function addNotification(title, body, type = 'success') {
    const items = loadNotifications();
    items.unshift({ title, body, type, timestamp: Date.now(), read: false });
    // Keep max 50 entries
    if (items.length > 50) items.length = 50;
    saveNotifications(items);
    renderNotifList();
    updateNotifBadge();
}

function renderNotifList() {
    const list = document.getElementById('notif-list');
    if (!list) return;
    const items = loadNotifications();
    if (items.length === 0) {
        list.innerHTML = '<div class="notif-empty">No notifications yet</div>';
        return;
    }
    list.innerHTML = items.map((n, i) => `
        <div class="notif-item ${n.read ? '' : 'unread'}" data-notif-index="${i}">
            <div class="notif-dot ${n.type}"></div>
            <div class="notif-body">
                <div class="notif-title">${n.title}</div>
                <div class="notif-desc">${n.body}</div>
            </div>
            <div class="notif-time">${formatNotifTime(n.timestamp)}</div>
        </div>
    `).join('');
}

function updateNotifBadge() {
    const badge = document.getElementById('notif-badge');
    if (!badge) return;
    const unread = loadNotifications().filter(n => !n.read).length;
    badge.textContent = unread;
    badge.classList.toggle('hidden', unread === 0);
}

function markAllRead() {
    const items = loadNotifications();
    items.forEach(n => n.read = true);
    saveNotifications(items);
    updateNotifBadge();
    renderNotifList();
}

function clearAllNotifications() {
    saveNotifications([]);
    renderNotifList();
    updateNotifBadge();
}

function formatNotifTime(ts) {
    const diff = Date.now() - ts;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function setupNotifCenter() {
    const bell = document.getElementById('notif-bell');
    const dropdown = document.getElementById('notif-dropdown');
    const clearBtn = document.getElementById('notif-clear');
    if (!bell || !dropdown) return;

    bell.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = !dropdown.classList.contains('hidden');
        if (isOpen) {
            dropdown.classList.add('hidden');
        } else {
            dropdown.classList.remove('hidden');
            markAllRead();
        }
    });

    clearBtn?.addEventListener('click', (e) => {
        e.stopPropagation();
        clearAllNotifications();
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.notif-center')) {
            dropdown.classList.add('hidden');
        }
    });

    // Initial render
    renderNotifList();
    updateNotifBadge();
}

function showNotification(title, body, type = 'success') {
    // Store in notification center
    addNotification(title, body, type);

    // OS-level notification
    if (window.electronAPI?.showNotification) {
        window.electronAPI.showNotification(title, body);
    } else if ('Notification' in window && Notification.permission === 'granted') {
        new Notification(title, { body });
    } else if ('Notification' in window && Notification.permission !== 'denied') {
        Notification.requestPermission().then(p => { if (p === 'granted') new Notification(title, { body }); });
    }
    // Also show a persistent banner in-app
    const isCancelled = type === 'cancel';
    const icon = isCancelled ? '&#10007;' : '&#10003;';
    document.querySelector('.completion-banner')?.remove();
    const banner = document.createElement('div');
    banner.className = `completion-banner ${isCancelled ? 'banner-cancel' : ''}`;
    banner.innerHTML = `<span class="completion-icon">${icon}</span><div class="completion-text"><strong>${title}</strong><span>${body}</span></div><button class="completion-close">&times;</button>`;
    document.body.appendChild(banner);
    setTimeout(() => banner.classList.add('show'), 10);
    banner.querySelector('.completion-close').addEventListener('click', () => {
        banner.classList.remove('show');
        setTimeout(() => banner.remove(), 300);
    });
    // Auto-dismiss after 30s
    setTimeout(() => { if (banner.parentNode) { banner.classList.remove('show'); setTimeout(() => banner.remove(), 300); } }, 30000);
}
function showToast(message, type = 'info') {
    document.querySelector('.toast')?.remove();
    const toast = document.createElement('div'); toast.className = `toast ${type}`; toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.classList.add('show'), 10);
    setTimeout(() => { toast.classList.remove('show'); setTimeout(() => toast.remove(), 300); }, 3000);
}
function formatTime(s, precise) {
    if (state.timeline?.rulerSecondsOnly) {
        return precise ? `${s.toFixed(2)}s` : `${Math.floor(s)}s`;
    }
    const m = Math.floor(s / 60);
    const sec = s % 60;
    if (precise) {
        // Show M:SS.ff (2 decimal places)
        return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
    }
    return `${m}:${Math.floor(sec).toString().padStart(2, '0')}`;
}

function clearScenes() {
    // Stop playback and clean up
    stopPlayback();
    cleanupVideoHandlers();

    // Reset state
    state.scenes = [];
    state.videoPlan = null;
    window._mgBridgeVideoPlan = null;
    state.currentSceneIndex = 0;
    state.currentTime = 0;
    state.totalDuration = 0;
    state.isPlaying = false;
    state.playbackAnimationFrame = null;
    state.transition.isTransitioning = false;
    state.transition.activeVideoIndex = 0;

    // Clear UI
    elements.sceneList.innerHTML = '<p class="empty-state">No scenes yet</p>';
    elements.timelineContainer.innerHTML = '<div class="timeline-header"><span>Timeline</span><span>0:00</span></div><div class="timeline-empty">Import audio to see timeline</div>';

    // Reset video elements using helper
    if (elements.previewVideo) {
        elements.previewVideo.pause();
        elements.previewVideo.currentTime = 0;
        elements.previewVideo.src = '';
        resetVideoTransitionState(elements.previewVideo);
    }
    if (elements.previewVideoNext) {
        elements.previewVideoNext.pause();
        elements.previewVideoNext.currentTime = 0;
        elements.previewVideoNext.src = '';
        resetVideoTransitionState(elements.previewVideoNext);
    }

    // Hide video container, show placeholder
    if (elements.videoContainer) {
        elements.videoContainer.classList.add('hidden');
        elements.videoContainer.className = 'video-transition-container hidden';
    }
    if (elements.videoControls) {
        elements.videoControls.classList.add('hidden');
    }
    elements.previewPlaceholder.classList.remove('hidden');

    // Reset audio element
    if (elements.previewAudio) {
        elements.previewAudio.pause();
        elements.previewAudio.currentTime = 0;
    }
}

// ========================================
// Style Learner — Reference Style Dropdown + Learn Dialog
// ========================================
async function refreshStyleProfileDropdown() {
    const sel = elements.buildStyleProfile;
    if (!sel || !window.electronAPI?.scanStyleProfiles) return;
    try {
        const profiles = await window.electronAPI.scanStyleProfiles();
        const prevValue = sel.value;
        // Reset, keeping "None"
        sel.innerHTML = '<option value="none">None (AI decides)</option>';
        for (const p of (profiles || [])) {
            const opt = document.createElement('option');
            opt.value = p.path;
            const dur = p.videoDuration ? ` · ${Math.round(p.videoDuration / 60)}min` : '';
            opt.textContent = `${p.name || 'unnamed'}${dur}`;
            sel.appendChild(opt);
        }
        // Restore selection (current value, or pending from loadSettings, or "none")
        const restore = state._pendingStyleProfile || prevValue || 'none';
        if (Array.from(sel.options).some(o => o.value === restore)) {
            sel.value = restore;
        } else {
            sel.value = 'none';
        }
        delete state._pendingStyleProfile;
    } catch (e) {
        console.warn('[StyleLearner] Failed to scan style profiles:', e?.message || e);
    }
}

function setupStyleLearner() {
    if (!elements.btnLearnStyle) return;

    // Save selection on change
    if (elements.buildStyleProfile) {
        elements.buildStyleProfile.addEventListener('change', saveSettings);
    }

    // Open Style Studio (replaces the old inline learn dialog)
    elements.btnLearnStyle.addEventListener('click', async () => {
        try {
            if (window.electronAPI?.openStyleStudio) {
                await window.electronAPI.openStyleStudio();
            } else {
                // Fallback to legacy inline dialog if studio IPC missing
                const dlg = elements.learnStyleDialog;
                if (dlg) dlg.style.display = (dlg.style.display === 'none' ? 'block' : 'none');
            }
        } catch (e) {
            console.error('[StyleStudio] Failed to open:', e);
        }
    });

    // Mode toggle: single vs multi
    if (elements.learnStyleMode) {
        elements.learnStyleMode.addEventListener('change', () => {
            const isMulti = elements.learnStyleMode.value === 'multi';
            if (elements.learnStyleUrl) elements.learnStyleUrl.style.display = isMulti ? 'none' : 'block';
            if (elements.learnStyleUrls) elements.learnStyleUrls.style.display = isMulti ? 'block' : 'none';
            if (elements.learnStyleName) elements.learnStyleName.style.display = isMulti ? 'block' : 'none';
            if (elements.learnStyleBrowse) elements.learnStyleBrowse.style.display = isMulti ? 'none' : '';
        });
    }

    // Cancel
    if (elements.learnStyleCancel) {
        elements.learnStyleCancel.addEventListener('click', () => {
            elements.learnStyleDialog.style.display = 'none';
            elements.learnStyleProgress.style.display = 'none';
            elements.learnStyleUrl.value = '';
            if (elements.learnStyleUrls) elements.learnStyleUrls.value = '';
            if (elements.learnStyleName) elements.learnStyleName.value = '';
        });
    }

    // Browse local file
    if (elements.learnStyleBrowse) {
        elements.learnStyleBrowse.addEventListener('click', async () => {
            if (!window.electronAPI?.pickVideoFile) return;
            try {
                const filePath = await window.electronAPI.pickVideoFile();
                if (filePath) elements.learnStyleUrl.value = filePath;
            } catch (e) {
                console.warn('[StyleLearner] file pick failed:', e?.message || e);
            }
        });
    }

    // Listen to progress events from main process
    if (window.electronAPI?.onLearnStyleProgress) {
        window.electronAPI.onLearnStyleProgress((data) => {
            if (!elements.learnStyleBar || !elements.learnStyleMsg) return;
            const pct = Math.max(0, Math.min(100, data.percent || 0));
            elements.learnStyleBar.style.width = `${pct}%`;
            elements.learnStyleMsg.textContent = data.message || `${pct}%`;
        });
    }

    // Start analysis (single or multi)
    if (elements.learnStyleStart) {
        elements.learnStyleStart.addEventListener('click', async () => {
            const isMulti = elements.learnStyleMode?.value === 'multi';

            if (isMulti) {
                // Multi-video channel learning
                const urlsRaw = (elements.learnStyleUrls?.value || '').trim();
                const urls = urlsRaw.split('\n').map(u => u.trim()).filter(Boolean);
                if (urls.length === 0) {
                    showToast('Enter at least one YouTube URL (one per line)', 'error');
                    return;
                }
                if (!window.electronAPI?.learnStyleMulti) {
                    showToast('Multi-video learning not available', 'error');
                    return;
                }
                const profileName = (elements.learnStyleName?.value || '').trim() || undefined;
                elements.learnStyleProgress.style.display = 'block';
                elements.learnStyleBar.style.width = '0%';
                elements.learnStyleMsg.textContent = `Analyzing ${urls.length} videos...`;
                elements.learnStyleStart.disabled = true;
                try {
                    const result = await window.electronAPI.learnStyleMulti(urls, profileName);
                    if (result && result.success) {
                        elements.learnStyleBar.style.width = '100%';
                        const mergedLabel = result.profile?.mergedFrom ? ` (merged from ${result.profile.mergedFrom} videos)` : '';
                        elements.learnStyleMsg.textContent = `Done: ${result.profile?.name || 'profile'}${mergedLabel}`;
                        showToast(`Channel style learned: ${result.profile?.name || 'profile'}${mergedLabel}`, 'success');
                        await refreshStyleProfileDropdown();
                        if (result.path) {
                            elements.buildStyleProfile.value = result.path;
                            saveSettings();
                        }
                        setTimeout(() => {
                            elements.learnStyleDialog.style.display = 'none';
                            elements.learnStyleProgress.style.display = 'none';
                            elements.learnStyleUrls.value = '';
                            if (elements.learnStyleName) elements.learnStyleName.value = '';
                        }, 2000);
                    } else {
                        const err = (result && result.error) || 'Unknown error';
                        elements.learnStyleMsg.textContent = `Error: ${err}`;
                        showToast(`Multi-learn failed: ${err}`, 'error');
                    }
                } catch (e) {
                    elements.learnStyleMsg.textContent = `Error: ${e.message || e}`;
                    showToast(`Multi-learn error: ${e.message || e}`, 'error');
                } finally {
                    elements.learnStyleStart.disabled = false;
                }
            } else {
                // Single video learning (existing flow)
                const input = (elements.learnStyleUrl.value || '').trim();
                if (!input) {
                    showToast('Enter a YouTube URL or pick a local video file', 'error');
                    return;
                }
                if (!window.electronAPI?.learnStyle) {
                    showToast('Style Learner not available', 'error');
                    return;
                }
                elements.learnStyleProgress.style.display = 'block';
                elements.learnStyleBar.style.width = '0%';
                elements.learnStyleMsg.textContent = 'Starting...';
                elements.learnStyleStart.disabled = true;
                try {
                    const result = await window.electronAPI.learnStyle(input);
                    if (result && result.success) {
                        elements.learnStyleBar.style.width = '100%';
                        elements.learnStyleMsg.textContent = `Done: ${result.profile?.name || 'profile'}`;
                        showToast(`Learned style: ${result.profile?.name || 'profile'}`, 'success');
                        await refreshStyleProfileDropdown();
                        if (result.path) {
                            elements.buildStyleProfile.value = result.path;
                            saveSettings();
                        }
                        setTimeout(() => {
                            elements.learnStyleDialog.style.display = 'none';
                            elements.learnStyleProgress.style.display = 'none';
                            elements.learnStyleUrl.value = '';
                        }, 1500);
                    } else {
                        const err = (result && result.error) || 'Unknown error';
                        elements.learnStyleMsg.textContent = `Error: ${err}`;
                        showToast(`Style learner failed: ${err}`, 'error');
                    }
                } catch (e) {
                    elements.learnStyleMsg.textContent = `Error: ${e.message || e}`;
                    showToast(`Style learner error: ${e.message || e}`, 'error');
                } finally {
                    elements.learnStyleStart.disabled = false;
                }
            }
        });
    }

    // Compare style with current build
    if (elements.btnCompareStyle) {
        elements.btnCompareStyle.addEventListener('click', async () => {
            const profilePath = elements.buildStyleProfile?.value;
            if (!profilePath || profilePath === 'none') {
                showToast('Select a style profile first', 'error');
                return;
            }
            if (!state.videoPlan || !state.videoPlan.scenes?.length) {
                showToast('Load a video plan first (run a build or load a project)', 'error');
                return;
            }
            if (!window.electronAPI?.compareStyle) {
                showToast('Style comparison not available', 'error');
                return;
            }
            try {
                const result = await window.electronAPI.compareStyle(profilePath, state.videoPlan);
                if (result && result.success && elements.styleComparisonText) {
                    elements.styleComparisonText.textContent = result.report;
                    elements.styleComparisonReport.style.display = 'block';
                } else {
                    showToast(`Comparison failed: ${result?.error || 'unknown'}`, 'error');
                }
            } catch (e) {
                showToast(`Comparison error: ${e.message || e}`, 'error');
            }
        });
    }

    // Close comparison report
    if (elements.styleComparisonClose) {
        elements.styleComparisonClose.addEventListener('click', () => {
            if (elements.styleComparisonReport) elements.styleComparisonReport.style.display = 'none';
        });
    }

    // Initial population
    refreshStyleProfileDropdown();

    // ── Map Preview Test handler ──
    if (elements.btnMapTest) {
        elements.btnMapTest.addEventListener('click', async () => {
            const locStr = (elements.mapTestLocations?.value || '').trim();
            if (!locStr) {
                elements.mapTestStatus.textContent = 'Enter at least one location';
                return;
            }
            // Parse waypoint format: "United States 0-3 z1.0, Texas 3-8 z3.0 t0.3 b15 o20"
            // z<zoom>    = per-waypoint camera zoom level
            // t<tilt>    = per-waypoint 3D perspective tilt (0-0.6)
            // b<bearing>  = static bearing/rotation in degrees (e.g. b15 = 15°)
            // o<orbit>   = orbit speed in deg/sec (camera slowly rotates around the point)
            // Or plain: "Berlin, Tokyo, Moscow"
            const parts = locStr ? locStr.split(',').map(s => s.trim()).filter(Boolean) : [];
            const waypoints = [];
            const locations = [];
            const wpRegex = /^(.+?)\s+(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(.*)$/;
            let hasWaypoints = false;
            // Preserve user casing exactly when ANY uppercase char is present
            // (so "Bab-el-Mandeb Strait" survives intact). Auto-title-case only
            // all-lowercase input as a convenience.
            const normalizeName = (s) => {
                const t = s.trim();
                if (/[A-Z]/.test(t)) return t;
                return t.split(/\s+/).map(w =>
                    w.split('-').map(sub => sub ? sub.charAt(0).toUpperCase() + sub.slice(1) : sub).join('-')
                ).join(' ');
            };
            for (const part of parts) {
                const m = part.match(wpRegex);
                if (m) {
                    hasWaypoints = true;
                    const name = normalizeName(m[1]);
                    const extras = m[4] || '';
                    const zMatch = extras.match(/z(\d+(?:\.\d+)?)/);
                    const tMatch = extras.match(/t(\d+(?:\.\d+)?)/);
                    const bMatch = extras.match(/b(-?\d+(?:\.\d+)?)/);
                    const oMatch = extras.match(/o(-?\d+(?:\.\d+)?)/);
                    waypoints.push({
                        name,
                        startTime: parseFloat(m[2]),
                        endTime: parseFloat(m[3]),
                        zoom: zMatch ? parseFloat(zMatch[1]) : null,
                        tilt: tMatch ? parseFloat(tMatch[1]) : null,
                        bearing: bMatch ? parseFloat(bMatch[1]) : null,
                        orbit: oMatch ? parseFloat(oMatch[1]) : null,
                    });
                    locations.push(name);
                } else {
                    locations.push(normalizeName(part));
                }
            }
            const mapStyle = elements.mapTestStyle?.value || 'dark';
            const title = elements.mapTestTitle?.value || '';

            // Slice 4 (Apr 23): AI Planner mode removed. Waypoints are now
            // materialized deterministically from MapScene inside map-provider.js
            // — a UI-level AI planner emulation no longer matches the real
            // pipeline, so the Map Test tool runs in pure manual/locations mode.
            _injectMapTest(locations, mapStyle, title, hasWaypoints ? waypoints : null);
        });
    }

    // ── Map slider live-update labels ──
    if (elements.mapDuration) {
        elements.mapDuration.addEventListener('input', () => {
            elements.mapDurationVal.textContent = elements.mapDuration.value + 's';
        });
    }
    if (elements.mapZoomSpeed) {
        elements.mapZoomSpeed.addEventListener('input', () => {
            elements.mapZoomSpeedVal.textContent = parseFloat(elements.mapZoomSpeed.value).toFixed(1) + '×';
        });
    }
    if (elements.mapPolySpeed) {
        elements.mapPolySpeed.addEventListener('input', () => {
            elements.mapPolySpeedVal.textContent = parseFloat(elements.mapPolySpeed.value).toFixed(1) + '×';
        });
    }
    // Keyframe slider labels
    const _updateTiltLabel = () => {
        const s = Math.round(parseFloat(elements.mapTiltStart?.value || 0) * 100);
        const e = Math.round(parseFloat(elements.mapTiltEnd?.value || 0) * 100);
        if (elements.mapTiltVal) elements.mapTiltVal.textContent = `${s}→${e}%`;
    };
    const _updateZoomKfLabel = () => {
        const s = parseFloat(elements.mapZoomStart?.value || 0.8).toFixed(1);
        const e = parseFloat(elements.mapZoomEnd?.value || 1.0).toFixed(1);
        if (elements.mapZoomKfVal) elements.mapZoomKfVal.textContent = `${s}→${e}`;
    };
    if (elements.mapTiltStart) elements.mapTiltStart.addEventListener('input', _updateTiltLabel);
    if (elements.mapTiltEnd) elements.mapTiltEnd.addEventListener('input', _updateTiltLabel);
    if (elements.mapZoomStart) elements.mapZoomStart.addEventListener('input', _updateZoomKfLabel);
    if (elements.mapZoomEnd) elements.mapZoomEnd.addEventListener('input', _updateZoomKfLabel);
    const _updatePanXLabel = () => {
        const s = parseInt(elements.mapPanXStart?.value || 0);
        const e = parseInt(elements.mapPanXEnd?.value || 0);
        if (elements.mapPanXVal) elements.mapPanXVal.textContent = `${s}→${e}`;
    };
    const _updatePanYLabel = () => {
        const s = parseInt(elements.mapPanYStart?.value || 0);
        const e = parseInt(elements.mapPanYEnd?.value || 0);
        if (elements.mapPanYVal) elements.mapPanYVal.textContent = `${s}→${e}`;
    };
    if (elements.mapPanXStart) elements.mapPanXStart.addEventListener('input', _updatePanXLabel);
    if (elements.mapPanXEnd) elements.mapPanXEnd.addEventListener('input', _updatePanXLabel);
    if (elements.mapPanYStart) elements.mapPanYStart.addEventListener('input', _updatePanYLabel);
    if (elements.mapPanYEnd) elements.mapPanYEnd.addEventListener('input', _updatePanYLabel);
}

/**
 * Find a country feature from GeoJSON by name (case-insensitive, partial match).
 * Returns the GeoJSON feature or null.
 */
function _findCountryFeature(locationName) {
    const geo = window._countryGeoJSON;
    if (!geo || !geo.features) return null;
    const lower = locationName.toLowerCase();
    // Exact name match first
    let feat = geo.features.find(f =>
        f.properties.name?.toLowerCase() === lower ||
        f.properties.nameLong?.toLowerCase() === lower ||
        f.properties.sov?.toLowerCase() === lower
    );
    if (feat) return feat;
    // Partial match (e.g. "USA" → "United States of America")
    const ALIASES = {
        'usa': 'United States of America', 'us': 'United States of America', 'united states': 'United States of America',
        'uk': 'United Kingdom', 'britain': 'United Kingdom', 'england': 'United Kingdom',
        'uae': 'United Arab Emirates', 'south korea': 'South Korea', 'north korea': 'North Korea',
        'czech republic': 'Czechia', 'czechia': 'Czechia',
    };
    const alias = ALIASES[lower];
    if (alias) return geo.features.find(f => f.properties.name === alias || f.properties.nameLong === alias);
    // Contains match
    feat = geo.features.find(f => f.properties.name?.toLowerCase().includes(lower) || f.properties.nameLong?.toLowerCase().includes(lower));
    return feat || null;
}

/**
 * Draw a filled country polygon on a canvas context.
 * toX/toY convert lon/lat to canvas pixel coordinates.
 */
function _drawCountryPolygon(ctx, feature, toX, toY, fillColor, strokeColor, strokeWidth) {
    if (!feature || !feature.geometry) return;
    const geom = feature.geometry;
    const rings = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];

    for (const polygon of rings) {
        for (const ring of polygon) {
            if (ring.length < 3) continue;
            ctx.beginPath();
            const startX = toX(ring[0][0]);
            const startY = toY(ring[0][1]);
            ctx.moveTo(startX, startY);
            for (let i = 1; i < ring.length; i++) {
                ctx.lineTo(toX(ring[i][0]), toY(ring[i][1]));
            }
            ctx.closePath();
            if (fillColor) {
                ctx.fillStyle = fillColor;
                ctx.fill();
            }
            if (strokeColor) {
                ctx.strokeStyle = strokeColor;
                ctx.lineWidth = strokeWidth || 1.5;
                ctx.stroke();
            }
        }
    }
}

/**
 * Inject a temporary mapChart MG scene at the current playhead for testing.
 * Uses geocoded pins from the build pipeline if available, otherwise
 * creates a mapChart with subtext for the renderer to resolve.
 */
function _injectMapTest(locations, mapStyle, title, waypoints, swarms) {
    const statusEl = document.getElementById('map-test-status');
    const setStatus = (msg) => { if (statusEl) statusEl.textContent = msg; };

    // Read slider values
    const zoomSpeed = parseFloat(elements.mapZoomSpeed?.value) || 1;
    const polySpeed = parseFloat(elements.mapPolySpeed?.value) || 1;
    const easing = elements.mapEasing?.value || 'cubic';
    const variantOverride = elements.mapVariant?.value || 'auto';
    const polyColorChoice = elements.mapPolyColor?.value || 'auto';
    const tiltStart = parseFloat(elements.mapTiltStart?.value) || 0;
    const tiltEnd = parseFloat(elements.mapTiltEnd?.value) || 0;
    const zoomKfStart = parseFloat(elements.mapZoomStart?.value) || 0.8;
    const zoomKfEnd = parseFloat(elements.mapZoomEnd?.value) || 1.0;
    const panXStart = parseInt(elements.mapPanXStart?.value) || 0;
    const panXEnd = parseInt(elements.mapPanXEnd?.value) || 0;
    const panYStart = parseInt(elements.mapPanYStart?.value) || 0;
    const panYEnd = parseInt(elements.mapPanYEnd?.value) || 0;
    const cinematic = elements.mapCinematic?.checked || false;

    // Duration: from slider, or auto-detect from waypoint max endTime
    let sceneDur = parseInt(elements.mapDuration?.value) || 7;
    if (waypoints && waypoints.length > 0) {
        const maxEnd = Math.max(...waypoints.map(w => w.endTime));
        if (maxEnd > sceneDur) sceneDur = Math.ceil(maxEnd);
        // Auto-update duration slider to reflect waypoint range
        if (elements.mapDuration) {
            elements.mapDuration.value = sceneDur;
            if (elements.mapDurationVal) elements.mapDurationVal.textContent = sceneDur + 's';
        }
    }

    // Build subtext in the format the mapChart renderer expects: "Berlin: 1, Tokyo: 2, ..."
    const subtext = locations.map((loc, i) => `${loc}: #${i + 1}`).join(', ');
    const playhead = state.currentTime || 0;

    // Remove any previous map test scene
    state.scenes = (state.scenes || []).filter(s => s.id !== '__map_test__');

    // Determine variant
    const effectiveVariant = variantOverride !== 'auto' ? variantOverride : null;

    // Create a fullscreen V3 scene for the map
    const testScene = {
        id: '__map_test__',
        startTime: playhead,
        endTime: playhead + sceneDur,
        duration: sceneDur * 30, // frames
        trackId: 'video-track-3',
        type: 'mapChart',
        mapStyle: mapStyle,
        text: title || `${locations.slice(0, 3).join(', ')}`,
        subtext: subtext,
        position: 'center',
        subType: effectiveVariant,
        _animationSpeed: 1,
        _durationFrames: sceneDur * 30,
        _mapZoomSpeed: zoomSpeed,
        _mapPolySpeed: polySpeed,
        _mapEasing: easing,
        _mapTiltStart: tiltStart,
        _mapTiltEnd: tiltEnd,
        _mapZoomKfStart: zoomKfStart,
        _mapZoomKfEnd: zoomKfEnd,
        _mapPanXStart: panXStart,
        _mapPanXEnd: panXEnd,
        _mapPanYStart: panYStart,
        _mapPanYEnd: panYEnd,
        _mapPolyColor: polyColorChoice,
        _mapCinematic: cinematic,
        _mapWaypoints: waypoints || null,
        _mapSwarms: (swarms && swarms.length > 0) ? swarms : null,
        _mapBigMap: !!(waypoints && waypoints.length > 0),
        mgData: {
            type: 'mapChart',
            mapStyle: mapStyle,
            text: title || `${locations.slice(0, 3).join(', ')}`,
            subtext: subtext,
            position: 'center',
            subType: effectiveVariant,
            _animationSpeed: 1,
            _durationFrames: sceneDur * 30,
            _mapZoomSpeed: zoomSpeed,
            _mapPolySpeed: polySpeed,
            _mapEasing: easing,
            _mapTiltStart: tiltStart,
            _mapTiltEnd: tiltEnd,
            _mapZoomKfStart: zoomKfStart,
            _mapZoomKfEnd: zoomKfEnd,
            _mapPanXStart: panXStart,
            _mapPanXEnd: panXEnd,
            _mapPanYStart: panYStart,
            _mapPanYEnd: panYEnd,
            _mapPolyColor: polyColorChoice,
            _mapCinematic: cinematic,
            _mapWaypoints: waypoints || null,
            _mapSwarms: (swarms && swarms.length > 0) ? swarms : null,
            _mapBigMap: !!(waypoints && waypoints.length > 0),
        },
    };

    // Try to geocode via the backend for real pin placement
    const mapProvider = window._mapProvider;
    const config = window._appConfig || {};
    const apiKey = config.maptiler?.apiKey;

    if (mapProvider && mapProvider.geocodePlaces && apiKey) {
        setStatus('Geocoding locations...');
        mapProvider.geocodePlaces(locations, apiKey).then(async (pins) => {
            if (!pins || pins.length === 0) {
                setStatus('No geocoding results — using fallback');
                _finalizeMapTest(testScene, setStatus);
                return;
            }

            testScene._mapPins = pins;
            testScene.mgData._mapPins = pins;
            setStatus(`Geocoded ${pins.length}/${locations.length} — fetching OSM boundaries...`);

            // Resolve boundaries: only for locations the user actually typed
            // Natural Earth for countries, OSM for cities — don't auto-add parent countries
            const countryFeatures = [];
            const cityNames = [];
            for (const loc of locations) {
                const feat = _findCountryFeature(loc);
                if (feat) {
                    countryFeatures.push({ name: loc, feature: feat, level: 'country' });
                    console.log(`[Map Test] Country boundary: "${feat.properties.name}"`);
                } else {
                    cityNames.push(loc);
                }
            }

            // OSM boundaries for cities (municipal admin polygons)
            if (cityNames.length > 0 && mapProvider.fetchOSMBoundary) {
                setStatus(`Fetching city boundaries for ${cityNames.join(', ')}...`);
                for (const cityName of cityNames) {
                    try {
                        const feat = await mapProvider.fetchOSMBoundary(cityName);
                        if (feat?.geometry) {
                            countryFeatures.push({ name: cityName, feature: feat, level: 'city' });
                            console.log(`[Map Test] City boundary: "${cityName}" (${feat.geometry.type})`);
                        }
                    } catch (e) {
                        console.warn(`[Map Test] City boundary fetch failed for "${cityName}":`, e.message);
                    }
                }
            }

            if (countryFeatures.length > 0) {
                testScene._countryFeatures = countryFeatures;
                testScene.mgData._countryFeatures = countryFeatures;
                setStatus(`${countryFeatures.length} boundaries loaded — downloading tiles...`);
            }

            // Compute view from pins
            const lons = pins.map(p => p.lon);
            const lats = pins.map(p => p.lat);

            if (waypoints && waypoints.length > 0) {
                // ═══ SINGLE BIG MAP FOR ALL WAYPOINTS ═══
                // Like GEOlayers: one large map image covering all locations,
                // camera pans across it. No tile switching, no hard edges.

                // Resolve waypoint coordinates
                const wpCoords = [];
                for (let wi = 0; wi < waypoints.length; wi++) {
                    const wp = waypoints[wi];
                    const wpLower = wp.name.toLowerCase();
                    let pin = pins.find(p => p.name.toLowerCase() === wpLower);
                    if (!pin) pin = pins.find(p => p.name.toLowerCase().includes(wpLower) || wpLower.includes(p.name.toLowerCase()));
                    if (pin) {
                        wpCoords.push({ name: wp.name, lon: pin.lon, lat: pin.lat, wpIdx: wi });
                    } else {
                        const cf = countryFeatures.find(c => c.name.toLowerCase() === wpLower);
                        if (cf && cf.feature) {
                            const geom = cf.feature.geometry;
                            const ring = geom.type === 'Polygon' ? geom.coordinates[0] : geom.type === 'MultiPolygon' ? geom.coordinates[0][0] : [];
                            if (ring.length > 0) {
                                let sLon = 0, sLat = 0;
                                for (const c of ring) { sLon += c[0]; sLat += c[1]; }
                                wpCoords.push({ name: wp.name, lon: sLon / ring.length, lat: sLat / ring.length, wpIdx: wi });
                            }
                        }
                    }
                }

                if (wpCoords.length > 0) {
                    // Compute bounding box of all waypoints with padding
                    const wpLons = wpCoords.map(w => w.lon);
                    const wpLats = wpCoords.map(w => w.lat);
                    const minLon = Math.min(...wpLons), maxLon = Math.max(...wpLons);
                    const minLat = Math.min(...wpLats), maxLat = Math.max(...wpLats);
                    const centerLon = (minLon + maxLon) / 2;
                    const centerLat = (minLat + maxLat) / 2;

                    // Tile zoom: must be LOW enough that at the minimum per-wp zoom (camScale),
                    // the entire country/region fits in the 1920x1080 viewport.
                    // At tile zoom z, world = 2^z * 512 px. Viewport shows 1920/camScale px of world.
                    // US ≈ 60° lon → need 60/360 * worldPx ≤ viewportPx
                    // For waypoint maps: use zoom 4 (good country-level detail, allows state zoom-ins)
                    // Higher per-wp camScale values handle the close-up views.
                    const hasPerWpZoom = waypoints.some(w => w.zoom != null);
                    let bigZoom;
                    if (hasPerWpZoom) {
                        // Per-waypoint zoom: tile zoom should show full continent at lowest camScale
                        // Find the lowest per-wp zoom to determine needed coverage
                        const minWpZoom = Math.min(...waypoints.map(w => w.zoom ?? 1.0));
                        // At camScale = minWpZoom, viewport = 1920/minWpZoom px
                        // We want ~80° of longitude visible (enough for large countries + margin)
                        // 80/360 * 2^z * 512 = 1920/minWpZoom → 2^z = 1920/(minWpZoom * 512 * 80/360)
                        const neededDeg = 80;
                        bigZoom = Math.floor(Math.log2(1920 / (minWpZoom * 512 * neededDeg / 360)));
                        bigZoom = Math.max(3, Math.min(bigZoom, 5)); // clamp 3-5 for waypoint maps
                    } else {
                        const lonSpan = Math.max(maxLon - minLon, 5);
                        bigZoom = Math.floor(Math.log2(360 / lonSpan * 2));
                        bigZoom = Math.max(3, Math.min(bigZoom, 7));
                    }

                    // Canvas size: 3x frame in each dimension for panning headroom
                    const BIG_W = 1920 * 3;  // 5760
                    const BIG_H = 1080 * 3;  // 3240

                    const bigView = { lon: centerLon, lat: centerLat, zoom: bigZoom };
                    testScene._mapView = bigView;
                    testScene.mgData._mapView = bigView;
                    testScene._bigMapSize = { w: BIG_W, h: BIG_H };
                    testScene.mgData._bigMapSize = { w: BIG_W, h: BIG_H };
                    // Store waypoint coords for camera panning
                    testScene._wpCoords = wpCoords;
                    testScene.mgData._wpCoords = wpCoords;

                    // Download single big map
                    _downloadMapTestTilesBig(testScene, bigView, BIG_W, BIG_H, apiKey, mapStyle, setStatus);
                } else {
                    _finalizeMapTest(testScene, setStatus);
                }
            } else if (pins.length === 1) {
                testScene._mapView = { lon: pins[0].lon, lat: pins[0].lat, zoom: pins[0].zoom, pins };
                testScene.mgData._mapView = testScene._mapView;
                _downloadMapTestTiles(testScene, pins, apiKey, mapStyle, setStatus);
            } else {
                const minLon = Math.min(...lons), maxLon = Math.max(...lons);
                const minLat = Math.min(...lats), maxLat = Math.max(...lats);
                const span = Math.max(maxLon - minLon, maxLat - minLat);
                let zoom = span > 100 ? 2 : span > 60 ? 2.5 : span > 30 ? 3 : span > 15 ? 4 : span > 8 ? 5 : span > 4 ? 6 : 7;
                testScene._mapView = { lon: (minLon + maxLon) / 2, lat: (minLat + maxLat) / 2, zoom, pins };
                testScene.mgData._mapView = testScene._mapView;
                _downloadMapTestTiles(testScene, pins, apiKey, mapStyle, setStatus);
            }
        }).catch(e => {
            setStatus(`Geocoding failed: ${e.message} — using fallback`);
            _finalizeMapTest(testScene, setStatus);
        });
        return;
    }

    // No geocoding available — just inject with subtext and let renderer handle it
    setStatus('No geocoding — using built-in coordinates');
    _finalizeMapTest(testScene, setStatus);
}

async function _downloadMapTestTiles(testScene, pins, apiKey, mapStyle, setStatus) {
    try {
        const mapProvider = window._mapProvider;
        if (mapProvider && mapProvider.stitchMapTilerTiles && testScene._mapView) {
            setStatus('Downloading map tiles...');
            const STYLE_MAP = mapProvider.MAPTILER_STYLE_MAP || { dark: 'dataviz-dark', natural: 'outdoor-v2', satellite: 'satellite', light: 'dataviz-light', political: 'streets-v2' };
            const style = STYLE_MAP[mapStyle] || STYLE_MAP.dark;

            // Stitch tiles into a buffer, then convert to a blob URL for the renderer
            const buffer = await mapProvider.stitchMapTilerTiles(testScene._mapView, mapStyle, apiKey);
            if (buffer && buffer.length > 5000) {
                // Convert Node Buffer → Blob → URL for HTMLImageElement
                const blob = new Blob([buffer], { type: 'image/png' });
                const blobUrl = URL.createObjectURL(blob);
                const filename = `__map_test_${Date.now()}.png`;
                testScene.mapImageFile = filename;
                testScene.mgData.mapImageFile = filename;
                testScene._mapImageUrl = blobUrl;
                testScene.mgData._mapImageUrl = blobUrl;
                setStatus(`Map tiles loaded (${(buffer.length / 1024).toFixed(0)} KB) — injecting scene...`);
            }
        }
    } catch (e) {
        setStatus(`Tile download failed: ${e.message} — using polygon fallback`);
    }
    _finalizeMapTest(testScene, setStatus);
}

async function _downloadMapTestTilesWaypoints(testScene, wpViews, apiKey, mapStyle, setStatus) {
    const mapProvider = window._mapProvider;
    if (!mapProvider || !mapProvider.stitchMapTilerTiles || wpViews.length === 0) {
        _finalizeMapTest(testScene, setStatus);
        return;
    }
    try {
        const wpTileUrls = {};
        const wpTileViews = {};
        for (let vi = 0; vi < wpViews.length; vi++) {
            const wv = wpViews[vi];
            const idx = wv.wpIdx != null ? wv.wpIdx : vi; // Use waypoint index, not array position
            setStatus(`Downloading tiles for "${wv.name}" (${vi + 1}/${wpViews.length})...`);
            const buffer = await mapProvider.stitchMapTilerTiles(wv, mapStyle, apiKey);
            if (buffer && buffer.length > 5000) {
                const blob = new Blob([buffer], { type: 'image/png' });
                wpTileUrls[idx] = URL.createObjectURL(blob);
                wpTileViews[idx] = wv;
            }
        }
        testScene._wpTileUrls = wpTileUrls;
        testScene.mgData._wpTileUrls = wpTileUrls;
        testScene._wpTileViews = wpTileViews;
        testScene.mgData._wpTileViews = wpTileViews;
        // Set first waypoint as the default mapImageUrl for fallback
        if (wpTileUrls[0]) {
            testScene._mapImageUrl = wpTileUrls[0];
            testScene.mgData._mapImageUrl = wpTileUrls[0];
            testScene.mapImageFile = `__map_wp_0.png`;
            testScene.mgData.mapImageFile = testScene.mapImageFile;
        }
        const count = Object.keys(wpTileUrls).length;
        setStatus(`${count} waypoint tile sets loaded — injecting scene...`);
    } catch (e) {
        setStatus(`Waypoint tiles failed: ${e.message} — using polygon fallback`);
    }
    _finalizeMapTest(testScene, setStatus);
}

async function _downloadMapTestTilesBig(testScene, bigView, bigW, bigH, apiKey, mapStyle, setStatus) {
    const mapProvider = window._mapProvider;
    if (!mapProvider || !mapProvider.stitchMapTilerTiles) {
        _finalizeMapTest(testScene, setStatus);
        return;
    }
    try {
        setStatus(`Downloading large map (${bigW}×${bigH} at z${Math.floor(bigView.zoom)})...`);
        const buffer = await mapProvider.stitchMapTilerTiles(bigView, mapStyle, apiKey, bigW, bigH);
        if (buffer && buffer.length > 5000) {
            const blob = new Blob([buffer], { type: 'image/png' });
            const blobUrl = URL.createObjectURL(blob);
            const filename = `__map_big_${Date.now()}.png`;
            testScene.mapImageFile = filename;
            testScene.mgData.mapImageFile = filename;
            testScene._mapImageUrl = blobUrl;
            testScene.mgData._mapImageUrl = blobUrl;
            setStatus(`Big map loaded (${(buffer.length / 1024).toFixed(0)} KB) — injecting scene...`);
        }
    } catch (e) {
        setStatus(`Big map download failed: ${e.message} — using polygon fallback`);
    }
    _finalizeMapTest(testScene, setStatus);
}

function _finalizeMapTest(testScene, setStatus) {
    // If a project is loaded with scenes, inject onto timeline
    const hasProject = state.scenes && state.scenes.length > 0;

    if (hasProject) {
        state.scenes = state.scenes.filter(s => s.id !== '__map_test__');
        state.scenes.push(testScene);
        state.currentTime = testScene.startTime;
        try {
            renderTracks();
            loadActiveScenes();
            _cachedPlayhead = null;
            _cachedTimelineScroll = null;
            _cachedTimelineTime = null;
        } catch (e) {
            console.warn('[Map Test] renderTracks failed:', e.message);
        }
        setStatus(`✓ Map injected at ${testScene.startTime.toFixed(1)}s — seek to preview`);
        showNotification('Map Test', `Injected mapChart with ${testScene.subtext.split(',').length} locations`, 'success');
    } else {
        // No project loaded — show map in a popup preview window
        _showMapTestPopup(testScene, setStatus);
    }
}

function _showMapTestPopup(testScene, setStatus) {
    // Remove previous popup
    const old = document.getElementById('map-test-popup');
    if (old) old.remove();

    const popup = document.createElement('div');
    popup.id = 'map-test-popup';
    popup.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;align-items:center;justify-content:center;';

    // Close button
    const closeBtn = document.createElement('div');
    closeBtn.textContent = '✕ Close';
    closeBtn.style.cssText = 'position:absolute;top:16px;right:24px;color:#aaa;font-size:14px;cursor:pointer;padding:8px 16px;background:rgba(255,255,255,0.08);border-radius:6px;';
    closeBtn.onclick = () => { popup.remove(); cancelAnimationFrame(popup._raf); };
    popup.appendChild(closeBtn);

    // Canvas
    const canvas = document.createElement('canvas');
    canvas.width = 1920;
    canvas.height = 1080;
    canvas.style.cssText = 'width:80vw;max-width:1280px;aspect-ratio:16/9;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6);';
    popup.appendChild(canvas);

    // Transport controls bar
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:10px;width:80vw;max-width:1280px;';

    const playBtn = document.createElement('div');
    playBtn.textContent = '⏸';
    playBtn.style.cssText = 'color:#fff;font-size:18px;cursor:pointer;padding:4px 10px;background:rgba(255,255,255,0.1);border-radius:4px;user-select:none;min-width:28px;text-align:center;';
    controls.appendChild(playBtn);

    const restartBtn = document.createElement('div');
    restartBtn.textContent = '⏮';
    restartBtn.style.cssText = 'color:#aaa;font-size:16px;cursor:pointer;padding:4px 8px;background:rgba(255,255,255,0.06);border-radius:4px;user-select:none;';
    controls.appendChild(restartBtn);

    const scrub = document.createElement('input');
    scrub.type = 'range'; scrub.min = '0'; scrub.max = '1000'; scrub.value = '0';
    scrub.style.cssText = 'flex:1;accent-color:#00d4ff;height:14px;cursor:pointer;';
    controls.appendChild(scrub);

    const timeLabel = document.createElement('span');
    timeLabel.style.cssText = 'color:#00d4ff;font-size:12px;min-width:80px;text-align:right;font-family:monospace;';
    timeLabel.textContent = '0.0 / 0.0s';
    controls.appendChild(timeLabel);

    popup.appendChild(controls);

    // Info text
    const info = document.createElement('div');
    info.style.cssText = 'color:#888;font-size:12px;margin-top:6px;';
    info.textContent = `${testScene.text} — ${testScene.subtext} — ${testScene.mgData.mapStyle} style`;
    popup.appendChild(info);

    document.body.appendChild(popup);

    // Render the map using MGRenderer directly
    const ctx = canvas.getContext('2d');
    const mgData = { ...testScene.mgData };

    // Playback state
    let mapImg = null;
    let playing = true;
    let frame = 0;
    const fps = 30;
    const totalFrames = (mgData._durationFrames || 7 * fps);
    const totalDurSec = totalFrames / fps;

    // Play/pause
    playBtn.onclick = () => {
        playing = !playing;
        playBtn.textContent = playing ? '⏸' : '▶';
        if (playing) requestAnimationFrame(animate);
    };
    // Restart
    restartBtn.onclick = () => { frame = 0; scrub.value = '0'; if (!playing) drawFrame(); };
    // Scrub
    let scrubbing = false;
    scrub.addEventListener('input', () => {
        scrubbing = true;
        frame = Math.round((parseInt(scrub.value) / 1000) * totalFrames);
        drawFrame();
    });
    scrub.addEventListener('change', () => { scrubbing = false; });
    // Space to toggle play
    const onKey = (e) => { if (e.code === 'Space' && document.getElementById('map-test-popup')) { e.preventDefault(); playBtn.click(); } };
    document.addEventListener('keydown', onKey);
    const origClose = closeBtn.onclick;
    closeBtn.onclick = () => { document.removeEventListener('keydown', onKey); origClose(); };

    function drawFrame() {
        ctx.clearRect(0, 0, 1920, 1080);
        const elapsed = frame / fps;
        const enterProgress = Math.min(1, elapsed / 1.5);
        _renderMapTestFrame(ctx, frame, fps, mgData, mapImg, { opacity: 1, enterProgress });
        timeLabel.textContent = `${elapsed.toFixed(1)} / ${totalDurSec.toFixed(1)}s`;
        if (!scrubbing) scrub.value = String(Math.round((frame / totalFrames) * 1000));
    }

    function animate() {
        if (!document.getElementById('map-test-popup') || !playing) return;
        drawFrame();
        frame = (frame + 1) % totalFrames;
        popup._raf = requestAnimationFrame(animate);
    }

    function loadAndRender() {
        if (mgData._mapImageUrl) {
            const img = new Image();
            img.onload = () => { mapImg = img; requestAnimationFrame(animate); };
            img.onerror = () => requestAnimationFrame(animate);
            img.src = mgData._mapImageUrl;
        } else {
            requestAnimationFrame(animate);
        }
    }

    loadAndRender();
    setStatus('✓ Map preview — Space to play/pause, drag to scrub');
}

// Icon image cache for map waypoints (keyword/name → HTMLImageElement)
const _mapIconImgCache = {};

function _renderMapTestFrame(ctx, frame, fps, mg, mapImg, anim) {
    // Resolve map data from mgData if not on the scene object directly
    const _mgd = mg.mgData || mg;
    if (!mg._bigMapSize && _mgd._bigMapSize) mg._bigMapSize = _mgd._bigMapSize;
    if (!mg._mapWaypoints && _mgd._mapWaypoints) mg._mapWaypoints = _mgd._mapWaypoints;
    if (!mg._wpCoords && _mgd._wpCoords) mg._wpCoords = _mgd._wpCoords;
    if (!mg._mapBigMap && _mgd._mapBigMap) mg._mapBigMap = _mgd._mapBigMap;
    if (!mg._mapIcons && _mgd._mapIcons) mg._mapIcons = _mgd._mapIcons;
    if (!mg._osmBoundaries && _mgd._osmBoundaries) mg._osmBoundaries = _mgd._osmBoundaries;
    if (!mg._mapRoutePath && _mgd._mapRoutePath) mg._mapRoutePath = _mgd._mapRoutePath;
    if (!mg.subType && _mgd.subType) mg.subType = _mgd.subType;
    if (!mg.mapVariant && _mgd.mapVariant) mg.mapVariant = _mgd.mapVariant;
    const W = 1920, H = 1080;
    const elapsed = frame / fps;
    const totalDur = (mg._durationFrames || 7 * fps) / fps;
    const { opacity, enterProgress } = anim;

    // ── Palette ──
    const PALS = {
        dark: { pin: '#00d4ff', pinGlow: 'rgba(0,212,255,0.35)', pinRing: 'rgba(0,212,255,0.5)', label: '#fff', labelBg: 'rgba(8,18,35,0.92)', route: 'rgba(0,212,255,0.6)', routeGlow: 'rgba(0,212,255,0.18)', titleBg: 'rgba(8,18,35,0.88)', titleBorder: '#00d4ff', titleText: '#fff', vignette: 'rgba(0,0,0,0.35)', highlight: 'rgba(0,212,255,0.12)', highlightRing: 'rgba(0,212,255,0.3)', arc: '#00d4ff', arcGlow: 'rgba(0,212,255,0.25)', radius: 'rgba(0,212,255,0.08)', radiusRing: 'rgba(0,212,255,0.35)', borderGlow: 'rgba(0,212,255,0.5)' },
        natural: { pin: '#f0c040', pinGlow: 'rgba(240,192,64,0.35)', pinRing: 'rgba(240,192,64,0.5)', label: '#fff', labelBg: 'rgba(12,28,18,0.9)', route: 'rgba(240,192,64,0.6)', routeGlow: 'rgba(240,192,64,0.18)', titleBg: 'rgba(12,28,18,0.88)', titleBorder: '#90d070', titleText: '#fff', vignette: 'rgba(0,15,5,0.3)', highlight: 'rgba(240,192,64,0.1)', highlightRing: 'rgba(240,192,64,0.25)', arc: '#f0c040', arcGlow: 'rgba(240,192,64,0.25)', radius: 'rgba(240,192,64,0.06)', radiusRing: 'rgba(240,192,64,0.3)', borderGlow: 'rgba(240,192,64,0.5)' },
        satellite: { pin: '#00ffaa', pinGlow: 'rgba(0,255,170,0.35)', pinRing: 'rgba(0,255,170,0.5)', label: '#e0f0e8', labelBg: 'rgba(3,8,12,0.92)', route: 'rgba(0,255,170,0.55)', routeGlow: 'rgba(0,255,170,0.15)', titleBg: 'rgba(3,8,12,0.9)', titleBorder: '#00ffaa', titleText: '#e0f0e8', vignette: 'rgba(0,0,0,0.45)', highlight: 'rgba(0,255,170,0.1)', highlightRing: 'rgba(0,255,170,0.25)', arc: '#00ffaa', arcGlow: 'rgba(0,255,170,0.2)', radius: 'rgba(0,255,170,0.06)', radiusRing: 'rgba(0,255,170,0.3)', borderGlow: 'rgba(0,255,170,0.5)' },
        light: { pin: '#d04030', pinGlow: 'rgba(208,64,48,0.3)', pinRing: 'rgba(208,64,48,0.45)', label: '#1a2a3a', labelBg: 'rgba(255,255,255,0.95)', route: 'rgba(208,64,48,0.5)', routeGlow: 'rgba(208,64,48,0.15)', titleBg: 'rgba(255,255,255,0.92)', titleBorder: '#2060a0', titleText: '#1a2a3a', vignette: 'rgba(100,120,140,0.12)', highlight: 'rgba(208,64,48,0.08)', highlightRing: 'rgba(208,64,48,0.2)', arc: '#d04030', arcGlow: 'rgba(208,64,48,0.2)', radius: 'rgba(208,64,48,0.06)', radiusRing: 'rgba(208,64,48,0.25)', borderGlow: 'rgba(208,64,48,0.4)' },
        political: { pin: '#b83020', pinGlow: 'rgba(184,48,32,0.35)', pinRing: 'rgba(184,48,32,0.5)', label: '#1c1008', labelBg: 'rgba(240,228,208,0.94)', route: 'rgba(184,48,32,0.55)', routeGlow: 'rgba(184,48,32,0.15)', titleBg: 'rgba(240,228,208,0.92)', titleBorder: '#8b4513', titleText: '#1c1008', vignette: 'rgba(60,40,20,0.18)', highlight: 'rgba(184,48,32,0.08)', highlightRing: 'rgba(184,48,32,0.2)', arc: '#b83020', arcGlow: 'rgba(184,48,32,0.2)', radius: 'rgba(184,48,32,0.06)', radiusRing: 'rgba(184,48,32,0.25)', borderGlow: 'rgba(184,48,32,0.4)' },
    };
    const pal = PALS[mg.mapStyle || 'dark'] || PALS.dark;

    // ── Polygon color palettes ──
    const POLY_COLORS = {
        dark:      { fill: '#00d4ff', fillEdge: '#0088cc', stroke: '#00d4ff', glow: 'rgba(0,212,255,0.6)' },
        natural:   { fill: '#f0c040', fillEdge: '#c09020', stroke: '#d0a830', glow: 'rgba(240,192,64,0.5)' },
        satellite: { fill: '#00ffaa', fillEdge: '#009966', stroke: '#00ffaa', glow: 'rgba(0,255,170,0.5)' },
        light:     { fill: '#d04030', fillEdge: '#a02820', stroke: '#c03828', glow: 'rgba(208,64,48,0.5)' },
        political: { fill: '#b83020', fillEdge: '#801810', stroke: '#a02818', glow: 'rgba(184,48,32,0.5)' },
    };
    const POLY_COLOR_OVERRIDES = {
        cyan:    { fill: '#00d4ff', fillEdge: '#0088cc', stroke: '#00d4ff', glow: 'rgba(0,212,255,0.6)' },
        red:     { fill: '#ff3030', fillEdge: '#cc1818', stroke: '#ff3030', glow: 'rgba(255,48,48,0.6)' },
        green:   { fill: '#30ff60', fillEdge: '#18cc40', stroke: '#30ff60', glow: 'rgba(48,255,96,0.6)' },
        gold:    { fill: '#f0c040', fillEdge: '#c09020', stroke: '#f0c040', glow: 'rgba(240,192,64,0.6)' },
        magenta: { fill: '#ff40ff', fillEdge: '#cc20cc', stroke: '#ff40ff', glow: 'rgba(255,64,255,0.6)' },
        orange:  { fill: '#ff8020', fillEdge: '#cc6010', stroke: '#ff8020', glow: 'rgba(255,128,32,0.6)' },
        white:   { fill: '#ffffff', fillEdge: '#bbbbbb', stroke: '#ffffff', glow: 'rgba(255,255,255,0.5)' },
        blue:    { fill: '#4080ff', fillEdge: '#2050cc', stroke: '#4080ff', glow: 'rgba(64,128,255,0.6)' },
    };
    const polyColorKey = mg._mapPolyColor || 'auto';
    const polyPal = (polyColorKey !== 'auto' && POLY_COLOR_OVERRIDES[polyColorKey])
        ? POLY_COLOR_OVERRIDES[polyColorKey]
        : (POLY_COLORS[mg.mapStyle || 'dark'] || POLY_COLORS.dark);

    // ── Slider-driven speed + easing ──
    const zoomSpd = mg._mapZoomSpeed || 1;
    const polySpd = mg._mapPolySpeed || 1;
    const easingMode = mg._mapEasing || 'cubic';

    // Easing functions
    const _ease = (t, mode) => {
        t = Math.min(1, Math.max(0, t));
        switch (mode) {
            case 'elastic': { const c4 = (2 * Math.PI) / 3; return t === 0 ? 0 : t === 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1; }
            case 'expo':    return t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
            case 'linear':  return t;
            default:        return 1 - Math.pow(1 - t, 3); // cubic
        }
    };

    // ── Cinematic mode flag ──
    const cinematicMode = mg._mapCinematic || false;

    // ── Keyframe time (shared by tilt + zoom) ──
    const kfT = Math.min(1, elapsed / totalDur);
    const kfEased = _ease(kfT, easingMode);

    // ── Projection: single map for everything (including waypoints) ──
    // Big map mode: image is larger than 1920x1080, camera pans across it
    const bigMapSize = mg._bigMapSize || null;
    const IMG_W = bigMapSize ? bigMapSize.w : W;
    const IMG_H = bigMapSize ? bigMapSize.h : H;
    const mapView = mg._mapView || null;

    const _projCache = _renderMapTestFrame._projCache || (_renderMapTestFrame._projCache = {});
    let toX, toY;
    if (mapView) {
        const cacheKey = `${mapView.lon}_${mapView.lat}_${mapView.zoom}_${IMG_W}_${IMG_H}`;
        if (_projCache[cacheKey]) {
            toX = _projCache[cacheKey].toX;
            toY = _projCache[cacheKey].toY;
        } else {
            const TILE_SZ = 512;
            const z = Math.max(2, Math.floor(mapView.zoom));
            const n = Math.pow(2, z);
            const cTileX = ((mapView.lon + 180) / 360) * n;
            const cLatRad = mapView.lat * Math.PI / 180;
            const cTileY = (1 - Math.log(Math.tan(cLatRad) + 1 / Math.cos(cLatRad)) / Math.PI) / 2 * n;
            const originPx = cTileX * TILE_SZ - IMG_W / 2;
            const originPy = cTileY * TILE_SZ - IMG_H / 2;
            const proj = {
                toX: (lon) => ((lon + 180) / 360) * n * TILE_SZ - originPx,
                toY: (lat) => { const latR = lat * Math.PI / 180; return (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n * TILE_SZ - originPy; },
            };
            _projCache[cacheKey] = proj;
            toX = proj.toX;
            toY = proj.toY;
        }
    } else {
        toX = (lon) => ((lon + 180) / 360) * W * 0.88 + W * 0.06;
        toY = (lat) => ((90 - lat) / 180) * H * 0.82 + H * 0.06;
    }

    // ═══ WAYPOINT SYSTEM ═══
    // Single big map: camera pans between waypoint positions on the same image
    const _waypoints = mg._mapWaypoints || null;
    const _wpPins = mg._mapPins || [];
    const _wpCoords = mg._wpCoords || [];
    let activeWpIdx = -1, wpTransition = 0, wpCamX = IMG_W / 2, wpCamY = IMG_H / 2;
    let prevWpIdx = -1;

    const hasWaypoints = _waypoints && _waypoints.length > 0;
    const wpPositions = [];
    if (hasWaypoints) {
        // Resolve waypoint pixel positions on the big map
        for (const wp of _waypoints) {
            const wpLower = wp.name.toLowerCase();
            // Try _wpCoords first (set during big map creation), then geocoded pins
            let coord = _wpCoords.find(c => c.name.toLowerCase() === wpLower);
            if (!coord) {
                let pin = _wpPins.find(p => p.name.toLowerCase() === wpLower);
                if (!pin) pin = _wpPins.find(p => p.name.toLowerCase().includes(wpLower) || wpLower.includes(p.name.toLowerCase()));
                if (pin) coord = { lon: pin.lon, lat: pin.lat };
            }
            if (coord) {
                wpPositions.push({ ...wp, lon: coord.lon, lat: coord.lat, px: toX(coord.lon), py: toY(coord.lat) });
            } else {
                wpPositions.push({ ...wp, lon: 0, lat: 0, px: IMG_W / 2, py: IMG_H / 2 });
            }
        }

        // Find active waypoint
        for (let wi = wpPositions.length - 1; wi >= 0; wi--) {
            if (elapsed >= wpPositions[wi].startTime) { activeWpIdx = wi; break; }
        }
        if (activeWpIdx < 0) activeWpIdx = 0;
        prevWpIdx = activeWpIdx > 0 ? activeWpIdx - 1 : -1;

        const awp = wpPositions[activeWpIdx];
        const wpElapsed = elapsed - awp.startTime;
        const transitionDur = 1.2 / zoomSpd;
        wpTransition = Math.min(1, wpElapsed / transitionDur);
        const wpEase = _ease(wpTransition, easingMode);

        // Camera pans smoothly between waypoint positions on the big map
        if (prevWpIdx >= 0 && wpTransition < 1) {
            const prev = wpPositions[prevWpIdx];
            wpCamX = prev.px + (awp.px - prev.px) * wpEase;
            wpCamY = prev.py + (awp.py - prev.py) * wpEase;
        } else {
            wpCamX = awp.px;
            wpCamY = awp.py;
        }
    }

    // ── Camera ──
    const multiPin = (mg._mapPins || []).length >= 2;
    const sceneVariant = mg._mapScene?.mapMode === 'region' ? 'regionHighlight' : mg._mapScene?.mapMode;
    const variant = mg.subType || mg.mapVariant || _mgd.subType || _mgd.mapVariant || sceneVariant || 'standard';
    let camScale, driftX, driftY, tiltAmount;

    // Flag for waypoint-on-big-map transform (used below)
    let wpBigMapCamera = false;

    if (hasWaypoints && wpPositions.length > 0) {
        // ═══ WAYPOINT CAMERA ═══
        // Per-waypoint zoom: each waypoint can have its own zoom level (z parameter)
        // Falls back to global keyframes if no per-wp zoom set
        const globalZS = mg._mapZoomKfStart ?? (bigMapSize ? 1.2 : 0.8);
        const globalZE = mg._mapZoomKfEnd ?? (bigMapSize ? 1.8 : 1.2);
        const awp = wpPositions[activeWpIdx];
        const hasPerWpZoom = wpPositions.some(wp => wp.zoom != null);

        const isRoute = variant === 'route';
        const isComparison = variant === 'comparison';
        const wideCap = isRoute ? 1.1 : (isComparison ? 1.5 : null);
        const clampWpZoom = (z) => wideCap != null ? Math.min(z, wideCap) : z;

        if (hasPerWpZoom && bigMapSize) {
            // Per-waypoint zoom: interpolate between waypoint zoom levels during transitions
            const curZoom = clampWpZoom(awp.zoom ?? globalZS);
            if (prevWpIdx >= 0 && wpTransition < 1) {
                const prevZoom = clampWpZoom(wpPositions[prevWpIdx].zoom ?? globalZS);
                camScale = prevZoom + (curZoom - prevZoom) * _ease(wpTransition, easingMode);
            } else {
                // Within a waypoint, apply subtle zoom animation (5% range)
                const wpDur = awp.endTime - awp.startTime;
                const wpLocalT = Math.min(1, (elapsed - awp.startTime) / Math.max(0.1, wpDur));
                camScale = curZoom + curZoom * 0.05 * wpLocalT;
            }
        } else {
            camScale = globalZS + (globalZE - globalZS) * kfEased;
            if (wideCap != null) camScale = Math.min(camScale, wideCap);
        }

        if (bigMapSize) {
            wpBigMapCamera = true;
            driftX = 0;
            driftY = 0;
            if (wideCap != null && wpPositions.length > 1) {
                const xs = wpPositions.map(p => p.px);
                const ys = wpPositions.map(p => p.py);
                const minX = Math.min(...xs), maxX = Math.max(...xs);
                const minY = Math.min(...ys), maxY = Math.max(...ys);
                const headroom = isRoute ? 1.6 : 1.4;
                const rawSpanX = Math.max(1, maxX - minX);
                const rawSpanY = Math.max(1, maxY - minY);
                const paddedFit = Math.min(W / (rawSpanX * headroom), H / (rawSpanY * headroom));
                const endpointFit = Math.min(W / rawSpanX, H / rawSpanY);
                const fillScale = Math.max(W / IMG_W, H / IMG_H);
                const fitScale = Math.min(Math.max(paddedFit, fillScale), endpointFit);
                wpCamX = (minX + maxX) / 2;
                wpCamY = (minY + maxY) / 2;
                camScale = isRoute ? fitScale : Math.min(camScale, fitScale);
                if (!_renderMapTestFrame._bboxFitLogged) _renderMapTestFrame._bboxFitLogged = new Set();
                const bboxKey = `${mg.sceneIndex ?? mg.startTime ?? 'preview'}:${variant}`;
                if (!_renderMapTestFrame._bboxFitLogged.has(bboxKey)) {
                    _renderMapTestFrame._bboxFitLogged.add(bboxKey);
                    console.log(`[MapPreview] bbox-fit variant=${variant} wp=${wpPositions.length} camScale=${camScale.toFixed(3)} fit=${fitScale.toFixed(3)}`);
                }
            }
        } else {
            driftX = (W / 2 - wpCamX);
            driftY = (H / 2 - wpCamY);
        }

        // Per-waypoint tilt: interpolate between waypoint tilt values
        const hasPerWpTilt = wpPositions.some(wp => wp.tilt != null);
        if (hasPerWpTilt) {
            const curTilt = awp.tilt ?? 0;
            if (prevWpIdx >= 0 && wpTransition < 1) {
                const prevTilt = wpPositions[prevWpIdx].tilt ?? 0;
                tiltAmount = prevTilt + (curTilt - prevTilt) * _ease(wpTransition, easingMode);
            } else {
                tiltAmount = curTilt;
            }
        } else {
            const tiltS = mg._mapTiltStart || 0;
            const tiltE2 = mg._mapTiltEnd ?? tiltS;
            tiltAmount = tiltS + (tiltE2 - tiltS) * kfEased;
        }

    } else if (cinematicMode) {
        // ═══ CINEMATIC 3-PHASE CAMERA ═══
        const p1End = 0.20, p2End = 0.50;
        const progress = kfT;

        if (progress <= p1End) {
            const t1 = progress / p1End;
            const e1 = _ease(t1, easingMode);
            camScale = 0.7 + e1 * 0.05;
            driftX = (1 - e1) * 15;
            driftY = (1 - e1) * 8;
            tiltAmount = 0;
        } else if (progress <= p2End) {
            const t2 = (progress - p1End) / (p2End - p1End);
            const e2 = _ease(t2, easingMode);
            camScale = 0.75 + e2 * 0.75;
            driftX = e2 * -10;
            driftY = e2 * -5;
            tiltAmount = e2 * 0.15;
        } else {
            const t3 = (progress - p2End) / (1 - p2End);
            const e3 = _ease(t3, easingMode);
            camScale = 1.5 + e3 * 0.15;
            tiltAmount = 0.15 + e3 * 0.45;
            const orbitAngle = t3 * Math.PI * 0.6;
            const orbitRadius = 30 + e3 * 15;
            driftX = -10 + Math.sin(orbitAngle) * orbitRadius;
            driftY = -5 + Math.cos(orbitAngle) * orbitRadius * 0.4;
        }
    } else {
        // ═══ STANDARD KEYFRAME CAMERA ═══
        const zKfS = mg._mapZoomKfStart ?? 0.8;
        const zKfE = mg._mapZoomKfEnd ?? 1.0;
        camScale = zKfS + (zKfE - zKfS) * kfEased;

        if (variant === 'locator' || variant === 'regionHighlight') {
            const driftT = Math.min(1, elapsed / (0.8 / zoomSpd));
            driftX = (1 - _ease(driftT, easingMode)) * 30;
            driftY = (1 - _ease(driftT, easingMode)) * 18;
        } else if (variant === 'route') {
            const ZOOM_DUR = 1.0 / zoomSpd;
            const panT = Math.min(1, Math.max(0, (elapsed - ZOOM_DUR) / Math.max(1, totalDur - ZOOM_DUR)));
            const panE = panT * panT * (3 - 2 * panT);
            driftX = panE * 15 - 8;
            driftY = panE * 10 - 5;
        } else {
            const driftT = Math.min(1, elapsed / (1.2 / zoomSpd));
            const dE = _ease(driftT, easingMode);
            driftX = (1 - dE) * 20;
            driftY = (1 - dE) * 12;
        }

        const tiltS = mg._mapTiltStart || 0;
        const tiltE2 = mg._mapTiltEnd ?? tiltS;
        tiltAmount = tiltS + (tiltE2 - tiltS) * kfEased;
    }

    // ── Pan keyframes: interpolate X/Y offset and add to drift ──
    const panXS = mg._mapPanXStart || 0;
    const panXE = mg._mapPanXEnd || 0;
    const panYS = mg._mapPanYStart || 0;
    const panYE = mg._mapPanYEnd || 0;
    if (panXS !== 0 || panXE !== 0 || panYS !== 0 || panYE !== 0) {
        driftX += panXS + (panXE - panXS) * kfEased;
        driftY += panYS + (panYE - panYS) * kfEased;
    }

    // ── Per-waypoint bearing & orbit ──
    let bearingDeg = 0;
    if (hasWaypoints && wpPositions.length > 0) {
        const hasPerWpBearing = wpPositions.some(wp => wp.bearing != null || wp.orbit != null);
        if (hasPerWpBearing) {
            const awpCam = wpPositions[activeWpIdx];
            // Static bearing (b parameter)
            const curBearing = awpCam.bearing ?? 0;
            // Orbit: continuous rotation (o parameter = deg/sec)
            const curOrbit = awpCam.orbit ?? 0;
            const wpLocalElapsed = elapsed - awpCam.startTime;
            let targetBearing = curBearing + curOrbit * wpLocalElapsed;

            if (prevWpIdx >= 0 && wpTransition < 1) {
                const prevWp = wpPositions[prevWpIdx];
                const prevBearing = prevWp.bearing ?? 0;
                const prevOrbit = prevWp.orbit ?? 0;
                const prevLocalElapsed = elapsed - prevWp.startTime;
                const prevTotal = prevBearing + prevOrbit * prevLocalElapsed;
                bearingDeg = prevTotal + (targetBearing - prevTotal) * _ease(wpTransition, easingMode);
            } else {
                bearingDeg = targetBearing;
            }
        }
    }
    const bearingRad = bearingDeg * Math.PI / 180;
    const useBearing = Math.abs(bearingDeg) > 0.1;

    // ── 3D PERSPECTIVE TILT ──
    const useTilt = tiltAmount > 0.01;
    const _mainCtxP = ctx;
    let _tiltOffscreen = null;

    if (useTilt || useBearing) {
        if (!_renderMapTestFrame._tiltCanvas) {
            _renderMapTestFrame._tiltCanvas = document.createElement('canvas');
            _renderMapTestFrame._tiltCanvas.width = W;
            _renderMapTestFrame._tiltCanvas.height = H;
        }
        _tiltOffscreen = _renderMapTestFrame._tiltCanvas;
        _tiltOffscreen.getContext('2d').clearRect(0, 0, W, H);
        ctx = _tiltOffscreen.getContext('2d');
    }

    ctx.save();
    if (wpBigMapCamera) {
        // Big map waypoint: scale + rotate around waypoint, centered on screen
        ctx.translate(W / 2, H / 2);
        if (useBearing) ctx.rotate(bearingRad);
        ctx.scale(camScale, camScale);
        ctx.translate(-wpCamX, -wpCamY);
    } else {
        ctx.translate(W / 2 + driftX, H / 2 + driftY);
        if (useBearing) ctx.rotate(bearingRad);
        ctx.scale(camScale, camScale);
        ctx.translate(-W / 2, -H / 2);
    }

    // ── Background ──
    if (mapImg) {
        ctx.globalAlpha = opacity * Math.min(1, enterProgress * 2);
        ctx.drawImage(mapImg, 0, 0, IMG_W, IMG_H);
        ctx.globalAlpha = opacity;
    } else {
        ctx.fillStyle = '#0b1426';
        ctx.fillRect(0, 0, IMG_W, IMG_H);
    }

    // ── Parse pins ──
    const pins = [];
    if (mg._mapPins && mg._mapPins.length) {
        const pairs = (mg.subtext || '').split(',').map(s => s.trim());
        mg._mapPins.forEach((gp, i) => {
            const pairVal = pairs[i] ? pairs[i].split(':')[1]?.trim() || '' : '';
            pins.push({ x: toX(gp.lon), y: toY(gp.lat), label: gp.name, value: pairVal, i, type: gp.type || 'city' });
        });
    } else {
        const pairs = (mg.subtext || '').split(',').map(s => s.trim()).filter(Boolean);
        pairs.forEach((pair, i) => {
            const [label] = pair.split(':');
            const val = pair.split(':')[1]?.trim() || '';
            const hash = (label || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
            pins.push({ x: W * 0.15 + ((hash * 7 + i * 137) % 70) / 100 * W, y: H * 0.2 + ((hash * 13 + i * 89) % 55) / 100 * H, label: label.trim(), value: val, i, type: 'unknown' });
        });
    }

    // ══ 1. COUNTRY POLYGON FILLS (gradient + mask reveal + stroke animation) ══
    const cFeats = mg._countryFeatures || [];
    // Helpers
    const _tracePolyP = (polys) => {
        for (const polygon of polys) { for (const ring of polygon) { if (ring.length < 3) continue; ctx.moveTo(toX(ring[0][0]), toY(ring[0][1])); for (let i = 1; i < ring.length; i++) ctx.lineTo(toX(ring[i][0]), toY(ring[i][1])); ctx.closePath(); } }
    };
    const _polyBoundsP = (polys) => {
        let mnX = Infinity, mnY = Infinity, mxX = -Infinity, mxY = -Infinity;
        for (const polygon of polys) { for (const ring of polygon) { for (const pt of ring) { const px = toX(pt[0]), py = toY(pt[1]); if (px < mnX) mnX = px; if (py < mnY) mnY = py; if (px > mxX) mxX = px; if (py > mxY) mxY = py; } } }
        return { x: mnX, y: mnY, w: mxX - mnX, h: mxY - mnY, cx: (mnX + mxX) / 2, cy: (mnY + mxY) / 2 };
    };

    // Helper: match a name to a waypoint (exact then partial)
    const _findWpMatch = (name) => {
        if (!wpPositions.length) return null;
        const lower = (name || '').toLowerCase();
        let m = wpPositions.find(wp => wp.name.toLowerCase() === lower);
        if (!m) m = wpPositions.find(wp => wp.name.toLowerCase().includes(lower) || lower.includes(wp.name.toLowerCase()));
        return m || null;
    };

    // ── Per-polygon color cycle for multiple locations ──
    const POLY_CYCLE = [
        { fill: '#00d4ff', fillEdge: '#0088cc', stroke: '#00d4ff', glow: 'rgba(0,212,255,0.6)' },   // cyan
        { fill: '#ff6040', fillEdge: '#cc3820', stroke: '#ff6040', glow: 'rgba(255,96,64,0.6)' },    // coral-red
        { fill: '#40ff90', fillEdge: '#20cc60', stroke: '#40ff90', glow: 'rgba(64,255,144,0.6)' },   // emerald
        { fill: '#f0c040', fillEdge: '#c09020', stroke: '#f0c040', glow: 'rgba(240,192,64,0.6)' },   // gold
        { fill: '#a060ff', fillEdge: '#7030cc', stroke: '#a060ff', glow: 'rgba(160,96,255,0.6)' },   // purple
        { fill: '#ff40a0', fillEdge: '#cc2070', stroke: '#ff40a0', glow: 'rgba(255,64,160,0.6)' },   // magenta-pink
        { fill: '#40c0ff', fillEdge: '#2090cc', stroke: '#40c0ff', glow: 'rgba(64,192,255,0.6)' },   // sky blue
        { fill: '#ff8020', fillEdge: '#cc6010', stroke: '#ff8020', glow: 'rgba(255,128,32,0.6)' },   // orange
    ];
    const usePolyCycle = cFeats.length > 1 && polyColorKey === 'auto';

    if (cFeats.length > 0) {
        for (let ci = 0; ci < cFeats.length; ci++) {
            const cf = cFeats[ci];
            if (!cf.feature || !cf.feature.geometry) continue;
            // Per-polygon color: cycle through distinct colors when multiple places
            const cpPal = usePolyCycle ? POLY_CYCLE[ci % POLY_CYCLE.length] : polyPal;
            // Waypoint-aware timing: polygon appears at its waypoint's startTime
            let polyDelay;
            const wpMatch = _findWpMatch(cf.name);
            if (wpPositions.length > 0) {
                if (wpMatch) {
                    polyDelay = wpMatch.startTime + 0.2;
                    // Big map: show all polygons (they're on the same image, camera handles centering)
                    // Per-tile mode: only show polygon when its waypoint is active
                    if (!bigMapSize) {
                        const wpIdx = wpPositions.indexOf(wpMatch);
                        if (wpIdx !== activeWpIdx && wpIdx !== prevWpIdx) continue;
                    }
                } else {
                    polyDelay = (0.15 + ci * 0.25) / polySpd;
                }
            } else {
                polyDelay = (0.15 + ci * 0.25) / polySpd;
            }
            const polyT = Math.min(1, Math.max(0, (elapsed - polyDelay) / (0.7 / polySpd)));
            if (polyT <= 0) continue;
            const polyEase = _ease(polyT, easingMode);
            const pulse = (Math.sin(elapsed * 1.5 * polySpd + ci * 0.8) + 1) / 2;
            const geom = cf.feature.geometry;
            const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
            const bounds = _polyBoundsP(polys);

            // ── Mask reveal: circular wipe from polygon center ──
            ctx.save();
            if (polyEase < 1) {
                const maxR = Math.sqrt(bounds.w * bounds.w + bounds.h * bounds.h) * 0.6;
                ctx.beginPath();
                ctx.arc(bounds.cx, bounds.cy, maxR * polyEase, 0, Math.PI * 2);
                ctx.clip();
            }
            // Clip to polygon boundary
            ctx.beginPath();
            _tracePolyP(polys);
            ctx.clip('evenodd');

            // ── Gradient fill (radial from center) ──
            const gradR = Math.max(bounds.w, bounds.h) * 0.7;
            const fillGrad = ctx.createRadialGradient(bounds.cx, bounds.cy, 0, bounds.cx, bounds.cy, gradR);
            fillGrad.addColorStop(0, cpPal.fill);
            fillGrad.addColorStop(1, cpPal.fillEdge);
            ctx.globalAlpha = opacity * polyEase * (0.25 + pulse * 0.08);
            ctx.fillStyle = fillGrad;
            ctx.fillRect(0, 0, IMG_W, IMG_H);

            // Inner shimmer
            const shimX = bounds.cx + Math.sin(elapsed * 0.7 * polySpd + ci) * bounds.w * 0.3;
            const shimY = bounds.cy + Math.cos(elapsed * 0.5 * polySpd + ci) * bounds.h * 0.2;
            const shimGrad = ctx.createRadialGradient(shimX, shimY, 0, shimX, shimY, gradR * 0.5);
            shimGrad.addColorStop(0, 'rgba(255,255,255,0.08)');
            shimGrad.addColorStop(1, 'rgba(255,255,255,0.0)');
            ctx.globalAlpha = opacity * polyEase * 0.6;
            ctx.fillStyle = shimGrad;
            ctx.fillRect(0, 0, IMG_W, IMG_H);
            ctx.restore();

            // ── Progressive stroke animation ──
            ctx.save();
            ctx.globalAlpha = opacity * polyEase * (0.5 + pulse * 0.25);
            ctx.strokeStyle = cpPal.stroke;
            ctx.lineWidth = 3;
            ctx.shadowColor = cpPal.glow;
            ctx.shadowBlur = 10 + pulse * 10;

            const strokeProgress = Math.min(1, Math.max(0, (elapsed - polyDelay - 0.2 / polySpd) / (1.0 / polySpd)));
            const strokeEase = _ease(strokeProgress, easingMode);

            if (strokeEase >= 1) {
                ctx.beginPath(); _tracePolyP(polys); ctx.stroke();
            } else if (strokeEase > 0) {
                let totalLen = 0;
                for (const polygon of polys) { for (const ring of polygon) { for (let ri = 1; ri < ring.length; ri++) { const dx = toX(ring[ri][0]) - toX(ring[ri-1][0]); const dy = toY(ring[ri][1]) - toY(ring[ri-1][1]); totalLen += Math.sqrt(dx*dx + dy*dy); } } }
                ctx.setLineDash([totalLen * strokeEase, totalLen]);
                ctx.lineDashOffset = 0;
                ctx.beginPath(); _tracePolyP(polys); ctx.stroke();
                ctx.setLineDash([]);
            }

            // Second glow pass (neon effect)
            if (strokeEase > 0.3) {
                ctx.globalAlpha = opacity * polyEase * pulse * 0.15;
                ctx.lineWidth = 8;
                ctx.shadowBlur = 25;
                ctx.beginPath(); _tracePolyP(polys); ctx.stroke();
            }
            ctx.shadowBlur = 0;
            ctx.restore();
            ctx.globalAlpha = opacity;
        }
    }

    // ══ 2. RADIUS / IMPACT CIRCLES (expanding concentric rings) ══
    for (const pin of pins) {
        let hlDelay;
        if (wpPositions.length > 0) {
            const wpMatch = _findWpMatch(pin.label);
            if (wpMatch) {
                hlDelay = wpMatch.startTime + 0.3;
                if (!bigMapSize) {
                    const wpIdx = wpPositions.indexOf(wpMatch);
                    if (wpIdx !== activeWpIdx && wpIdx !== prevWpIdx) continue;
                }
            } else {
                hlDelay = 0.2 + pin.i * 0.12;
            }
        } else {
            hlDelay = 0.2 + pin.i * 0.12;
        }
        const hlT = Math.min(1, Math.max(0, (elapsed - hlDelay) / 0.8));
        if (hlT <= 0) continue;
        const eHL = 1 - Math.pow(1 - hlT, 2);
        const baseR = pin.type === 'city' ? 40 : pin.type === 'landmark' ? 30 : 60;
        const hlR = baseR * eHL;
        const pulse = (Math.sin(elapsed * 2 + pin.i) + 1) / 2;
        // Outer expanding ring (radar-style)
        const radarT = ((elapsed * 0.6 + pin.i * 0.4) % 2) / 2;
        const radarR = hlR * 0.5 + hlR * 1.5 * radarT;
        const radarAlpha = (1 - radarT) * 0.3;
        ctx.globalAlpha = opacity * eHL * radarAlpha;
        ctx.strokeStyle = pal.radiusRing;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(pin.x, pin.y, radarR, 0, Math.PI * 2); ctx.stroke();
        // Inner filled glow
        const outerR = hlR + pulse * 12;
        ctx.globalAlpha = opacity * eHL * 0.5;
        const g = ctx.createRadialGradient(pin.x, pin.y, hlR * 0.2, pin.x, pin.y, outerR);
        g.addColorStop(0, pal.radius);
        g.addColorStop(0.5, pal.radius);
        g.addColorStop(1, 'transparent');
        ctx.fillStyle = g;
        ctx.beginPath(); ctx.arc(pin.x, pin.y, outerR, 0, Math.PI * 2); ctx.fill();
        // Static highlight ring
        ctx.strokeStyle = pal.highlightRing;
        ctx.lineWidth = 1.5;
        ctx.globalAlpha = opacity * eHL * 0.4;
        ctx.beginPath(); ctx.arc(pin.x, pin.y, hlR, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = opacity;
    }

    // ══ 3. FLIGHT ARCS (curved 3D-style arcs between locations) ══
    // Only route/comparison variants get arcs — locator/regionHighlight should NOT connect pins.
    const _arcVariants = new Set(['route', 'comparison']);
    if (_arcVariants.has(variant) && pins.length >= 2) {
        for (let i = 0; i < pins.length - 1; i++) {
            const a = pins[i], b = pins[i + 1];
            const dist = Math.hypot(b.x - a.x, b.y - a.y);
            const arcHeight = dist * 0.35; // arc rises proportional to distance
            const midX = (a.x + b.x) / 2;
            const midY = (a.y + b.y) / 2 - arcHeight;

            // Arc reveal: progressive draw from A to B
            let arcDelay;
            if (wpPositions.length > 0) {
                const wpB = _findWpMatch(b.label);
                arcDelay = wpB ? wpB.startTime + 0.3 : 0.8 + i * 0.5;
            } else {
                arcDelay = 0.8 + i * 0.5;
            }
            const arcDur = 1.0;
            const arcT = Math.min(1, Math.max(0, (elapsed - arcDelay) / arcDur));
            if (arcT <= 0) continue;
            const arcE = 1 - Math.pow(1 - arcT, 2); // ease-out

            // Draw arc progressively using line segments
            const SEGS = 60;
            const drawSegs = Math.ceil(SEGS * arcE);

            // Glow layer
            ctx.globalAlpha = opacity * 0.3;
            ctx.strokeStyle = pal.arcGlow;
            ctx.lineWidth = 10;
            ctx.beginPath();
            for (let s = 0; s <= drawSegs; s++) {
                const t = s / SEGS;
                const px = (1-t)*(1-t)*a.x + 2*(1-t)*t*midX + t*t*b.x;
                const py = (1-t)*(1-t)*a.y + 2*(1-t)*t*midY + t*t*b.y;
                if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.stroke();

            // Main arc line
            ctx.globalAlpha = opacity * 0.85;
            ctx.strokeStyle = pal.arc;
            ctx.lineWidth = 3;
            ctx.shadowColor = pal.pin;
            ctx.shadowBlur = 8;
            ctx.beginPath();
            for (let s = 0; s <= drawSegs; s++) {
                const t = s / SEGS;
                const px = (1-t)*(1-t)*a.x + 2*(1-t)*t*midX + t*t*b.x;
                const py = (1-t)*(1-t)*a.y + 2*(1-t)*t*midY + t*t*b.y;
                if (s === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
            }
            ctx.stroke();
            ctx.shadowBlur = 0;

            // Traveling dot along arc (only after arc fully drawn)
            if (arcE >= 0.99) {
                const dotT = ((elapsed - arcDelay - arcDur) * 0.5 + i * 0.3) % 1;
                const dt = dotT;
                const dx = (1-dt)*(1-dt)*a.x + 2*(1-dt)*dt*midX + dt*dt*b.x;
                const dy = (1-dt)*(1-dt)*a.y + 2*(1-dt)*dt*midY + dt*dt*b.y;
                const tg = ctx.createRadialGradient(dx, dy, 0, dx, dy, 14);
                tg.addColorStop(0, pal.pin); tg.addColorStop(1, 'transparent');
                ctx.globalAlpha = opacity * 0.8;
                ctx.fillStyle = tg; ctx.beginPath(); ctx.arc(dx, dy, 14, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = pal.pin; ctx.shadowColor = pal.pin; ctx.shadowBlur = 12;
                ctx.beginPath(); ctx.arc(dx, dy, 5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
            }
            ctx.globalAlpha = opacity;
        }
    }

    // ══ 4. PIN MARKERS + LEADER LINES + LABELS ══
    for (const pin of pins) {
        let pinDelay;
        if (wpPositions.length > 0) {
            const wpMatch = _findWpMatch(pin.label);
            if (wpMatch) {
                pinDelay = wpMatch.startTime + 0.5;
                if (!bigMapSize) {
                    const wpIdx = wpPositions.indexOf(wpMatch);
                    if (wpIdx !== activeWpIdx && wpIdx !== prevWpIdx) continue;
                }
            } else {
                pinDelay = 0.5 + pin.i * 0.22;
            }
        } else {
            pinDelay = 0.5 + pin.i * 0.22;
        }
        const pT = Math.min(1, Math.max(0, (elapsed - pinDelay) / 0.4));
        if (pT <= 0) continue;
        const eased = 1 - Math.pow(1 - pT, 3);
        const bounce = pT < 1 ? (1 - pT) * 16 : 0;
        const py = pin.y - bounce;
        ctx.globalAlpha = eased * opacity;

        // Pulse rings
        if (pT >= 1) {
            const p1 = (Math.sin(elapsed * 3 + pin.i * 1.5) + 1) / 2;
            ctx.strokeStyle = pal.pinRing; ctx.lineWidth = 2;
            ctx.globalAlpha = eased * opacity * (0.15 + p1 * 0.25);
            ctx.beginPath(); ctx.arc(pin.x, py, 20 + p1 * 16, 0, Math.PI * 2); ctx.stroke();
            ctx.globalAlpha = eased * opacity;
        }

        // Glow
        const glowR = pin.type === 'city' || pin.type === 'landmark' ? 36 : 28;
        const gg = ctx.createRadialGradient(pin.x, py, 0, pin.x, py, glowR);
        gg.addColorStop(0, pal.pinGlow); gg.addColorStop(1, 'transparent');
        ctx.fillStyle = gg; ctx.beginPath(); ctx.arc(pin.x, py, glowR, 0, Math.PI * 2); ctx.fill();

        // Pin dot or icon
        const dotR = pin.type === 'city' || pin.type === 'landmark' ? 9 : 7;
        // Check for icon — look up by pin label, then try waypoint match
        let _iconKey = pin.label || pin.name;
        let _iconImg = _mapIconImgCache[_iconKey];
        if (!_iconImg) {
            const _wps = mg._mapWaypoints || [];
            for (const _wp of _wps) {
                if (!_wp.icon) continue;
                const _wL = (_wp.name || '').toLowerCase();
                const _pL = (pin.label || '').toLowerCase();
                if (_wL === _pL || _wL.includes(_pL) || _pL.includes(_wL)) {
                    _iconImg = _mapIconImgCache[_wp.name];
                    if (_iconImg) { _iconKey = _wp.name; break; }
                }
            }
        }
        // Lazy-load ALL icons from _mapIcons (bulk preload once)
        if (mg._mapIcons && !mg._mapIconsPreloaded) {
            mg._mapIconsPreloaded = true;
            for (const [iName, iconPath] of Object.entries(mg._mapIcons)) {
                if (_mapIconImgCache[iName] || _mapIconImgCache['__loading_' + iName]) continue;
                _mapIconImgCache['__loading_' + iName] = true;
                const img = new Image();
                img.onload = () => { _mapIconImgCache[iName] = img; };
                img.onerror = () => { _mapIconImgCache['__loading_' + iName] = false; };
                if (iconPath.startsWith('http') || iconPath.startsWith('data:') || iconPath.startsWith('file:')) {
                    img.src = iconPath;
                } else if (window.electronAPI?.getFileUrl) {
                    window.electronAPI.getFileUrl(iconPath).then(url => { if (url) img.src = url; });
                } else {
                    img.src = `file:///${iconPath.replace(/\\/g, '/')}`;
                }
            }
        }

        if (_iconImg && _iconImg.complete && _iconImg.naturalWidth > 0) {
            // Draw icon with circular background
            const iconSize = 40 * eased;
            ctx.save();
            ctx.shadowColor = pal.pin; ctx.shadowBlur = 14;
            ctx.fillStyle = 'rgba(10,15,30,0.7)';
            ctx.beginPath(); ctx.arc(pin.x, py, iconSize / 2 + 4, 0, Math.PI * 2); ctx.fill();
            ctx.strokeStyle = pal.pin; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(pin.x, py, iconSize / 2 + 4, 0, Math.PI * 2); ctx.stroke();
            ctx.shadowBlur = 0;
            ctx.beginPath(); ctx.arc(pin.x, py, iconSize / 2 + 2, 0, Math.PI * 2); ctx.clip();
            ctx.drawImage(_iconImg, pin.x - iconSize / 2, py - iconSize / 2, iconSize, iconSize);
            ctx.restore();
        } else {
            // Standard pin dot
            ctx.fillStyle = pal.pin; ctx.shadowColor = pal.pin; ctx.shadowBlur = 18;
            ctx.beginPath(); ctx.arc(pin.x, py, dotR * eased, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
        }

        // Outer ring
        ctx.strokeStyle = pal.pin; ctx.lineWidth = 2;
        ctx.globalAlpha = eased * opacity * eased;
        ctx.beginPath(); ctx.arc(pin.x, py, 14 + (1 - eased) * 14, 0, Math.PI * 2); ctx.stroke();
        ctx.globalAlpha = eased * opacity;

        // Leader line + label tag (GEOlayers-style: compact pill, small font, anchored to pin)
        const lDelay = pinDelay + 0.15;
        const lT = Math.min(1, Math.max(0, (elapsed - lDelay) / 0.35));
        if (lT <= 0) continue;
        const lE = 1 - Math.pow(1 - lT, 3);
        ctx.globalAlpha = eased * opacity * lE;

        // Compact label: small font, tight pill shape, offset to the right of pin
        const labelFont = 'bold 13px "Segoe UI", Arial, sans-serif';
        ctx.font = labelFont;
        const lW = ctx.measureText(pin.label).width;
        const tagH = 22;
        const tagPad = 8;
        const tagW = lW + tagPad * 2;
        const tagX = pin.x + 16; // offset right of pin dot
        const tagY = py - tagH / 2 - 2; // vertically centered on pin

        // Thin leader line from pin to tag
        ctx.strokeStyle = pal.pin;
        ctx.lineWidth = 1;
        ctx.globalAlpha = eased * opacity * lE * 0.5;
        ctx.beginPath();
        ctx.moveTo(pin.x + dotR + 2, py);
        ctx.lineTo(tagX, py - 1);
        ctx.stroke();
        ctx.globalAlpha = eased * opacity * lE;

        // Tag background (dark pill with slight transparency)
        ctx.fillStyle = 'rgba(10,15,30,0.75)';
        ctx.shadowColor = 'rgba(0,0,0,0.3)';
        ctx.shadowBlur = 6;
        ctx.shadowOffsetY = 2;
        const r = tagH / 2; // full round corners
        ctx.beginPath();
        ctx.moveTo(tagX + r, tagY);
        ctx.lineTo(tagX + tagW - r, tagY);
        ctx.arc(tagX + tagW - r, tagY + r, r, -Math.PI / 2, Math.PI / 2);
        ctx.lineTo(tagX + r, tagY + tagH);
        ctx.arc(tagX + r, tagY + r, r, Math.PI / 2, -Math.PI / 2);
        ctx.fill();
        ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Subtle left accent (thin vertical bar inside pill)
        ctx.fillStyle = pal.pin;
        ctx.globalAlpha = eased * opacity * lE * 0.7;
        ctx.fillRect(tagX + 3, tagY + 4, 2, tagH - 8);
        ctx.globalAlpha = eased * opacity * lE;

        // Label text
        ctx.fillStyle = '#e8ecf0';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = labelFont;
        ctx.fillText(pin.label, tagX + tagPad, tagY + tagH / 2 + 1);

        // Value (if any) — small, below the tag
        if (pin.value) {
            ctx.font = '11px "Segoe UI", Arial, sans-serif';
            ctx.fillStyle = pal.pin;
            ctx.globalAlpha = eased * opacity * lE * 0.8;
            ctx.fillText(pin.value, tagX + tagPad, tagY + tagH + 12);
            ctx.globalAlpha = eased * opacity * lE;
        }
    }

    ctx.restore(); // end camera transform

    // ── Bearing-only (no tilt): just composite the rotated offscreen ──
    if (useBearing && !useTilt && _tiltOffscreen) {
        ctx = _mainCtxP;
        ctx.drawImage(_tiltOffscreen, 0, 0);
    }

    // ── PERSPECTIVE WARP: After Effects-style 3D camera tilt ──
    // Pivot at BOTTOM edge, camera looks down at an angle.
    // Bottom of map stays wide & anchored, top recedes to vanishing point.
    if (useTilt && _tiltOffscreen) {
        ctx = _mainCtxP;
        const src = _tiltOffscreen;
        const tilt = tiltAmount;
        const STRIPS = 220;
        const srcStripH = H / STRIPS;

        // AE-style: plane pivots at bottom edge, tilts away from camera.
        // Camera is at (0, camY, 0) looking toward the plane.
        // Plane bottom edge at y=0, top edge at y=1 (which tilts INTO the screen).
        // After rotation around bottom edge by angle A:
        //   row at t (0=bottom, 1=top): y3d = t * cos(A), z3d = t * sin(A)
        // Camera projects with focal length f.
        const angle = tilt * 70 * (Math.PI / 180); // tilt 0→1 = 0→70°
        const cosA = Math.cos(angle);
        const sinA = Math.sin(angle);
        const focalLen = 1.4; // focal length — lower = stronger perspective

        const projY = new Float32Array(STRIPS + 1);
        const projScale = new Float32Array(STRIPS + 1);

        for (let i = 0; i <= STRIPS; i++) {
            // t=0 is bottom of source (stays anchored), t=1 is top (recedes)
            const t = 1 - (i / STRIPS); // invert: strip 0 = top of source = t=1 (far)
            const z = t * sinA + focalLen; // depth: bottom (t=0) = focalLen, top (t=1) = sinA + focalLen
            const scale = focalLen / z; // perspective scale: bottom ≈ 1.0, top < 1.0
            const yProj = t * cosA / z; // projected Y (bottom=0, top compresses)
            projScale[i] = scale;
            projY[i] = yProj;
        }

        // Map projected Y to screen pixels.
        // Bottom of map anchored near screen bottom, top compresses upward.
        const bottomScreen = H; // anchor at actual bottom edge
        const projMax = projY[0]; // top of source = farthest = smallest projected extent
        const projMin = projY[STRIPS]; // bottom of source = closest = 0
        const projRange = projMax - projMin;
        // Fill full frame height — no black bar at top
        const visibleH = H;

        const screenY = new Float32Array(STRIPS + 1);
        for (let i = 0; i <= STRIPS; i++) {
            // Map from projY range to screen: bottom anchored, top floats up
            const norm = (projY[i] - projMin) / projRange; // 0=bottom, 1=top
            screenY[i] = bottomScreen - norm * visibleH;
        }

        // Background
        const bgColor = (mg.mapStyle === 'light' || mg.mapStyle === 'political') ? '#b8c4d0' : '#060a14';
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, 0, W, H);

        // Draw strips — all strips fill full width (no black edges)
        for (let i = 0; i < STRIPS; i++) {
            const srcY = i * srcStripH;
            const dstY = screenY[i];
            const dstH = Math.abs(screenY[i + 1] - screenY[i]) + 0.5;
            const avgScale = (projScale[i] + projScale[i + 1]) / 2;
            // Always fill full width — scale source crop wider for narrowed strips
            const dstW = W;
            const srcCropW = W / avgScale;
            const srcX = (W - srcCropW) / 2;

            ctx.drawImage(src, Math.max(0, srcX), srcY, Math.min(srcCropW, W), srcStripH + 1,
                0, dstY, dstW, dstH);
        }

        // Horizon haze — atmospheric fade at the top (where map recedes)
        const hazeBottom = screenY[0]; // top-most strip position
        const hazeH = Math.max(hazeBottom * 0.6, 30);
        if (tilt > 0.1) {
            const haze = ctx.createLinearGradient(0, hazeBottom - hazeH * 0.3, 0, hazeBottom + hazeH);
            const hazeBase = (mg.mapStyle === 'light' || mg.mapStyle === 'political') ? '180,190,200' : '8,14,28';
            haze.addColorStop(0, `rgba(${hazeBase},${0.6 * tilt})`);
            haze.addColorStop(0.4, `rgba(${hazeBase},${0.25 * tilt})`);
            haze.addColorStop(1, `rgba(${hazeBase},0)`);
            ctx.fillStyle = haze;
            ctx.fillRect(0, 0, W, hazeBottom + hazeH);
        }

        // Subtle ground shadow at bottom edge
        const floorH = H * 0.04;
        const floor = ctx.createLinearGradient(0, H - floorH, 0, H);
        floor.addColorStop(0, 'rgba(0,0,0,0)');
        floor.addColorStop(1, `rgba(0,0,0,${0.15 * tilt})`);
        ctx.fillStyle = floor;
        ctx.fillRect(0, H - floorH, W, floorH);
    }

    // ══ 5. TITLE BAR (outside camera) ══
    const title = mg.text || '';
    if (title) {
        const tT = Math.min(1, Math.max(0, (elapsed - 0.1) / 0.5));
        const tE = 1 - Math.pow(1 - tT, 3);
        if (tT > 0) {
            ctx.globalAlpha = opacity * tE;
            ctx.font = 'bold 42px Arial';
            const tw = ctx.measureText(title).width;
            const bW = tw + 80, bH = 68;
            const bX = (W - bW) / 2, bY = 24 - (1 - tE) * 30;
            ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 20; ctx.shadowOffsetY = 5;
            ctx.fillStyle = pal.titleBg;
            ctx.beginPath();
            ctx.moveTo(bX + 14, bY); ctx.lineTo(bX + bW - 14, bY); ctx.quadraticCurveTo(bX + bW, bY, bX + bW, bY + 14);
            ctx.lineTo(bX + bW, bY + bH - 14); ctx.quadraticCurveTo(bX + bW, bY + bH, bX + bW - 14, bY + bH);
            ctx.lineTo(bX + 14, bY + bH); ctx.quadraticCurveTo(bX, bY + bH, bX, bY + bH - 14);
            ctx.lineTo(bX, bY + 14); ctx.quadraticCurveTo(bX, bY, bX + 14, bY);
            ctx.fill();
            ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
            ctx.fillStyle = pal.titleBorder;
            ctx.fillRect(bX + 14, bY + bH - 4, bW - 28, 4);
            ctx.fillStyle = pal.titleText; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
            ctx.fillText(title, W / 2, bY + bH / 2);
        }
    }

    // ── Location count badge (bottom-left) ──
    if (pins.length > 0) {
        const iT = Math.min(1, Math.max(0, (elapsed - 0.8) / 0.4));
        if (iT > 0) {
            const iE = 1 - Math.pow(1 - iT, 2);
            ctx.globalAlpha = opacity * iE * 0.7;
            const locText = `${pins.length} location${pins.length > 1 ? 's' : ''}`;
            ctx.font = '600 16px Arial';
            const ltw = ctx.measureText(locText).width;
            ctx.fillStyle = pal.titleBg;
            ctx.beginPath();
            ctx.moveTo(38, H - 38); ctx.lineTo(38 + ltw + 24, H - 38);
            ctx.lineTo(38 + ltw + 24, H - 10); ctx.lineTo(38, H - 10); ctx.closePath(); ctx.fill();
            ctx.fillStyle = pal.pin; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.fillText(locText, 50, H - 24);
        }
    }

    // ── Vignette ──
    const vg = ctx.createRadialGradient(W / 2, H / 2, W * 0.25, W / 2, H / 2, W * 0.7);
    vg.addColorStop(0, 'transparent'); vg.addColorStop(1, pal.vignette);
    ctx.fillStyle = vg; ctx.globalAlpha = opacity;
    ctx.fillRect(0, 0, W, H);
    ctx.globalAlpha = 1;
}

function saveSettings() {
    localStorage.setItem('faceless-settings', JSON.stringify({
        smartAI: elements.smartAiToggle?.checked !== false,
        aiProvider: elements.aiProvider.value,
        ollamaModel: elements.ollamaModel?.value || 'gemma3:12b',
        ollamaVisionModel: elements.ollamaVisionModel?.value || 'llava',
        transitionStyle: elements.transitionStyle.value,
        transitionDuration: state.transition.duration,
        volume: state.volume,
        footageSources: getEnabledSources(),
        sfxEnabled: state.sfxEnabled,
        sfxVolume: state.sfxVolume,
        mgEnabled: state.mgEnabled,
        subtitlesEnabled: state.subtitlesEnabled,
        aiInstructions: state.aiInstructions,
        videoTitle: state.videoTitle,
        mutedTracks: state.mutedTracks,
        buildNiche: elements.buildNiche ? elements.buildNiche.value : 'auto',
        buildLanguage: elements.buildLanguage ? elements.buildLanguage.value : 'auto',
        buildStyleProfile: elements.buildStyleProfile ? elements.buildStyleProfile.value : 'none',
        clipAnalyzer: elements.clipAnalyzerToggle?.checked !== false,
        buildResume: elements.buildResumeToggle?.checked === true
    }));
    // Also trigger .fvp auto-save so settings persist per-project
    triggerAutoSave();
    // Push live project context to the Style Studio agent (main process) so it
    // knows the current video title / niche / instructions even without a .fvp.
    try {
        window.electronAPI?.styleStudioSetProjectContext?.({
            videoTitle: state.videoTitle,
            aiInstructions: state.aiInstructions,
            buildNiche: elements.buildNiche ? elements.buildNiche.value : 'auto',
            buildLanguage: elements.buildLanguage ? elements.buildLanguage.value : 'auto',
            buildStyleProfile: elements.buildStyleProfile ? elements.buildStyleProfile.value : 'none',
        });
    } catch (_) {}
}

function getEnabledSources() {
    return {
        pexels: elements.srcPexels?.checked ?? true,
        pixabay: elements.srcPixabay?.checked ?? true,
        youtube: elements.srcYouTube?.checked ?? false,
        telegram: elements.srcTelegram?.checked ?? true,
        vkVideo: elements.srcVKVideo?.checked ?? true,
        reddit: elements.srcReddit?.checked ?? true,
        unsplash: elements.srcUnsplash?.checked ?? true,
        googleCSE: elements.srcGoogleCSE?.checked ?? false,
        bing: elements.srcBing?.checked ?? false,
        duckduckgo: elements.srcDuckDuckGo?.checked ?? true,
        googleScrape: elements.srcGoogleScrape?.checked ?? true,
    };
}

function loadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem('faceless-settings'));
        if (s) {
            if (elements.smartAiToggle) elements.smartAiToggle.checked = s.smartAI !== false;
            elements.aiProvider.value = s.aiProvider || 'ollama';
            // Restore Ollama model selections
            if (elements.ollamaModel) elements.ollamaModel.value = s.ollamaModel || 'gemma3:12b';
            if (elements.ollamaVisionModel) elements.ollamaVisionModel.value = s.ollamaVisionModel || 'llava';
            if (elements.ollamaModelRow) {
                elements.ollamaModelRow.style.display = (s.aiProvider || 'ollama') === 'ollama' ? 'block' : 'none';
            }
            // Restore transition settings
            // Ignore old saved 'cut' with duration 0 — that was the hardcoded default before transitions were enabled
            // Also migrate old 'crossfade' defaults to 'auto' for AI-driven transitions
            const savedTransDur = s.transitionDuration !== undefined ? s.transitionDuration : -1;
            if (s.transitionStyle && !(s.transitionStyle === 'cut' && savedTransDur <= 0)) {
                state.transition.style = s.transitionStyle;
                state.transition.duration = savedTransDur > 0 ? savedTransDur : 0.5;
            } else {
                state.transition.style = 'auto';
                state.transition.duration = 0.5;
            }
            if (elements.transitionStyle) elements.transitionStyle.value = state.transition.style;
            const _tdEl = document.getElementById('transition-duration');
            const _tdVal = document.getElementById('transition-duration-val');
            if (_tdEl) _tdEl.value = state.transition.duration;
            if (_tdVal) _tdVal.textContent = `${state.transition.duration.toFixed(1)}s`;
            state.volume = s.volume !== undefined ? s.volume : 1;
            if (elements.volumeSlider) {
                elements.volumeSlider.value = state.volume;
            }
            // Restore SFX settings
            state.sfxEnabled = s.sfxEnabled !== undefined ? s.sfxEnabled : true;
            state.sfxVolume = s.sfxVolume !== undefined ? s.sfxVolume : 0.35;
            if (elements.sfxEnabled) elements.sfxEnabled.checked = state.sfxEnabled;
            if (elements.sfxVolume) elements.sfxVolume.value = state.sfxVolume;
            if (elements.sfxVolumeLabel) elements.sfxVolumeLabel.textContent = `${Math.round(state.sfxVolume * 100)}%`;
            // Restore Motion Graphics settings
            state.mgEnabled = s.mgEnabled !== undefined ? s.mgEnabled : true;
            if (elements.mgEnabled) elements.mgEnabled.checked = state.mgEnabled;
            // Restore Subtitles setting
            state.subtitlesEnabled = s.subtitlesEnabled !== undefined ? s.subtitlesEnabled : false;
            if (elements.subtitlesEnabled) elements.subtitlesEnabled.checked = state.subtitlesEnabled;
            // Restore Video Title
            state.videoTitle = s.videoTitle || '';
            if (elements.videoTitle) elements.videoTitle.value = state.videoTitle;
            // Restore AI Instructions
            state.aiInstructions = s.aiInstructions || '';
            if (elements.aiInstructions) elements.aiInstructions.value = state.aiInstructions;
            // Restore Niche Preset
            if (elements.buildNiche && s.buildNiche) elements.buildNiche.value = s.buildNiche;
            if (elements.buildLanguage && s.buildLanguage) elements.buildLanguage.value = s.buildLanguage;
            if (elements.buildStyleProfile && s.buildStyleProfile) {
                // Defer setting until dropdown is populated
                state._pendingStyleProfile = s.buildStyleProfile;
            }
            // Restore Clip Analyzer toggle
            if (elements.clipAnalyzerToggle) elements.clipAnalyzerToggle.checked = s.clipAnalyzer !== false;
            // Restore Resume Build toggle (default OFF — fresh build unless user opts in)
            if (elements.buildResumeToggle) elements.buildResumeToggle.checked = s.buildResume === true;
            // Restore track mute state
            if (s.mutedTracks) state.mutedTracks = s.mutedTracks;
            // Restore footage source toggles
            if (s.footageSources) {
                if (elements.srcPexels) elements.srcPexels.checked = s.footageSources.pexels ?? true;
                if (elements.srcPixabay) elements.srcPixabay.checked = s.footageSources.pixabay ?? true;
                if (elements.srcYouTube) elements.srcYouTube.checked = s.footageSources.youtube ?? false;
                if (elements.srcTelegram) elements.srcTelegram.checked = s.footageSources.telegram ?? true;
                if (elements.srcVKVideo) elements.srcVKVideo.checked = s.footageSources.vkVideo ?? true;
                if (elements.srcReddit) elements.srcReddit.checked = s.footageSources.reddit ?? true;
                if (elements.srcUnsplash) elements.srcUnsplash.checked = s.footageSources.unsplash ?? true;
                if (elements.srcGoogleCSE) elements.srcGoogleCSE.checked = s.footageSources.googleCSE ?? false;
                if (elements.srcBing) elements.srcBing.checked = s.footageSources.bing ?? false;
                if (elements.srcDuckDuckGo) elements.srcDuckDuckGo.checked = s.footageSources.duckduckgo ?? true;
                if (elements.srcGoogleScrape) elements.srcGoogleScrape.checked = s.footageSources.googleScrape ?? true;
            }
        }
    } catch (e) { }
}

// Apply settings from .fvp project file (same logic as loadSettings but from object, not localStorage)
function applyProjectSettings(s) {
    if (!s) return;
    try {
        elements.aiProvider.value = s.aiProvider || 'ollama';
        if (elements.ollamaModel) elements.ollamaModel.value = s.ollamaModel || 'gemma3:12b';
        if (elements.ollamaVisionModel) elements.ollamaVisionModel.value = s.ollamaVisionModel || 'llava';
        if (elements.ollamaModelRow) {
            elements.ollamaModelRow.style.display = (s.aiProvider || 'ollama') === 'ollama' ? 'block' : 'none';
        }
        // Restore transition settings (detect old 'cut' defaults and override)
        const savedTransDur2 = s.transitionDuration !== undefined ? s.transitionDuration : -1;
        if (s.transitionStyle && !(s.transitionStyle === 'cut' && savedTransDur2 <= 0)) {
            state.transition.style = s.transitionStyle;
            state.transition.duration = savedTransDur2 > 0 ? savedTransDur2 : 0.5;
        } else {
            state.transition.style = 'auto';
            state.transition.duration = 0.5;
        }
        if (elements.transitionStyle) elements.transitionStyle.value = state.transition.style;
        const _tdEl2 = document.getElementById('transition-duration');
        const _tdVal2 = document.getElementById('transition-duration-val');
        if (_tdEl2) _tdEl2.value = state.transition.duration;
        if (_tdVal2) _tdVal2.textContent = `${state.transition.duration.toFixed(1)}s`;
        state.volume = s.volume !== undefined ? s.volume : 1;
        if (elements.volumeSlider) elements.volumeSlider.value = state.volume;
        // SFX
        state.sfxEnabled = s.sfxEnabled !== undefined ? s.sfxEnabled : true;
        state.sfxVolume = s.sfxVolume !== undefined ? s.sfxVolume : 0.35;
        if (elements.sfxEnabled) elements.sfxEnabled.checked = state.sfxEnabled;
        if (elements.sfxVolume) elements.sfxVolume.value = state.sfxVolume;
        if (elements.sfxVolumeLabel) elements.sfxVolumeLabel.textContent = `${Math.round(state.sfxVolume * 100)}%`;
        // MG
        state.mgEnabled = s.mgEnabled !== undefined ? s.mgEnabled : true;
        if (elements.mgEnabled) elements.mgEnabled.checked = state.mgEnabled;
        // Subtitles
        state.subtitlesEnabled = s.subtitlesEnabled !== undefined ? s.subtitlesEnabled : false;
        if (elements.subtitlesEnabled) elements.subtitlesEnabled.checked = state.subtitlesEnabled;
        // Video Title
        state.videoTitle = s.videoTitle || '';
        if (elements.videoTitle) elements.videoTitle.value = state.videoTitle;
        // AI Instructions
        state.aiInstructions = s.aiInstructions || '';
        if (elements.aiInstructions) elements.aiInstructions.value = state.aiInstructions;
        // Niche Preset
        if (elements.buildNiche && s.buildNiche) elements.buildNiche.value = s.buildNiche;
        if (elements.buildLanguage && s.buildLanguage) elements.buildLanguage.value = s.buildLanguage;
        // Track mute
        if (s.mutedTracks) state.mutedTracks = s.mutedTracks;
        // Footage sources
        if (s.footageSources) {
            if (elements.srcPexels) elements.srcPexels.checked = s.footageSources.pexels ?? true;
            if (elements.srcPixabay) elements.srcPixabay.checked = s.footageSources.pixabay ?? true;
            if (elements.srcYouTube) elements.srcYouTube.checked = s.footageSources.youtube ?? false;
            if (elements.srcTelegram) elements.srcTelegram.checked = s.footageSources.telegram ?? true;
            if (elements.srcVKVideo) elements.srcVKVideo.checked = s.footageSources.vkVideo ?? true;
            if (elements.srcReddit) elements.srcReddit.checked = s.footageSources.reddit ?? true;
            if (elements.srcUnsplash) elements.srcUnsplash.checked = s.footageSources.unsplash ?? true;
            if (elements.srcGoogleCSE) elements.srcGoogleCSE.checked = s.footageSources.googleCSE ?? false;
            if (elements.srcBing) elements.srcBing.checked = s.footageSources.bing ?? false;
            if (elements.srcDuckDuckGo) elements.srcDuckDuckGo.checked = s.footageSources.duckduckgo ?? true;
            if (elements.srcGoogleScrape) elements.srcGoogleScrape.checked = s.footageSources.googleScrape ?? true;
        }
        console.log('✅ Applied project settings from .fvp file');
    } catch (e) {
        console.warn('Could not apply project settings:', e);
    }
}

async function loadProjectInfo() {
    try {
        if (!window.electronAPI.getProjectInfo) return;
        const info = await window.electronAPI.getProjectInfo();
        if (info && info.projectName && elements.projectNameLabel) {
            elements.projectNameLabel.textContent = `— ${info.projectName}`;
            elements.projectNameLabel.title = `Project: ${info.projectDir}\nClick to open folder`;
            elements.projectNameLabel.style.cursor = 'pointer';
            elements.projectNameLabel.onclick = () => {
                if (info.projectDir && window.electronAPI.openFile) {
                    window.electronAPI.openFile(info.projectDir);
                }
            };
        }
    } catch (e) {
        console.warn('Could not load project info:', e);
    }
}

async function newProject() {
    if (state.isProcessing) {
        showToast('Please wait for current process to finish', 'error');
        return;
    }

    if (window.electronAPI.launchNewInstance) {
        showNewProjectDialog();
        return;
    }

    // Fallback: reset current project (no multi-instance support)
    resetCurrentProject();
}

function showNewProjectDialog() {
    // Remove existing dialog if any
    const existing = document.getElementById('new-project-dialog');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'new-project-dialog';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#1e1e2e;border:1px solid #444;border-radius:12px;padding:28px 32px;width:480px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
    dialog.innerHTML = `
        <h2 style="margin:0 0 20px;font-size:1.2rem;color:#e0e0e0;font-weight:600;">New Project</h2>
        <div style="margin-bottom:16px;">
            <label style="display:block;margin-bottom:6px;font-size:0.85rem;color:#aaa;">Project Name</label>
            <input id="np-name" type="text" placeholder="My Video Project" value="Untitled Project"
                   style="width:100%;padding:10px 12px;background:#12121a;border:1px solid #555;border-radius:6px;color:#fff;font-size:0.95rem;outline:none;box-sizing:border-box;"
                   onfocus="this.select()" />
        </div>
        <div style="margin-bottom:20px;">
            <label style="display:block;margin-bottom:6px;font-size:0.85rem;color:#aaa;">Location</label>
            <div style="display:flex;gap:8px;">
                <input id="np-location" type="text" readonly placeholder="Choose a folder..."
                       style="flex:1;padding:10px 12px;background:#12121a;border:1px solid #555;border-radius:6px;color:#ccc;font-size:0.85rem;outline:none;cursor:pointer;box-sizing:border-box;" />
                <button id="np-browse" style="padding:10px 16px;background:#333;border:1px solid #555;border-radius:6px;color:#fff;cursor:pointer;font-size:0.85rem;white-space:nowrap;">Browse...</button>
            </div>
        </div>
        <div id="np-preview" style="margin-bottom:20px;padding:10px 12px;background:#12121a;border-radius:6px;font-size:0.8rem;color:#666;font-family:monospace;"></div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
            <button id="np-cancel" style="padding:10px 20px;background:transparent;border:1px solid #555;border-radius:6px;color:#aaa;cursor:pointer;font-size:0.9rem;">Cancel</button>
            <button id="np-create" style="padding:10px 24px;background:#4a6cf7;border:none;border-radius:6px;color:#fff;cursor:pointer;font-size:0.9rem;font-weight:600;" disabled>Create Project</button>
        </div>
    `;
    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const nameInput = document.getElementById('np-name');
    const locationInput = document.getElementById('np-location');
    const browseBtn = document.getElementById('np-browse');
    const previewEl = document.getElementById('np-preview');
    const createBtn = document.getElementById('np-create');
    const cancelBtn = document.getElementById('np-cancel');

    let selectedLocation = '';

    function updatePreview() {
        const name = nameInput.value.trim();
        if (name && selectedLocation) {
            previewEl.style.color = '#888';
            previewEl.textContent = selectedLocation + '\\' + name + '\\';
            createBtn.disabled = false;
        } else {
            previewEl.style.color = '#666';
            previewEl.textContent = name ? 'Choose a location...' : '';
            createBtn.disabled = true;
        }
    }

    nameInput.addEventListener('input', updatePreview);
    nameInput.focus();

    browseBtn.addEventListener('click', async () => {
        const folder = await window.electronAPI.selectFolder('Choose project location');
        if (folder) {
            selectedLocation = folder;
            locationInput.value = folder;
            updatePreview();
        }
    });

    locationInput.addEventListener('click', () => browseBtn.click());

    cancelBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    createBtn.addEventListener('click', async () => {
        const projectName = nameInput.value.trim();
        if (!projectName || !selectedLocation) return;

        createBtn.disabled = true;
        createBtn.textContent = 'Creating...';

        const result = await window.electronAPI.launchNewInstance({
            projectName: projectName,
            location: selectedLocation
        });

        if (result && result.success) {
            showToast(`Project "${projectName}" created`, 'success');
            overlay.remove();
        } else {
            showToast('Failed to create project', 'error');
            createBtn.disabled = false;
            createBtn.textContent = 'Create Project';
        }
    });

    // Enter key to create
    nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !createBtn.disabled) createBtn.click();
        if (e.key === 'Escape') overlay.remove();
    });
}

function resetCurrentProject() {
    if (state.audioFile && !confirm('Reset current project? This clears the current work.')) return;

    stopPlayback();
    cleanupVideoHandlers();
    removeAudio();

    state.selectedClipIndex = -1;
    state.selectedClipIndices = [];

    [elements.videoTrack1, elements.videoTrack2, elements.videoTrack3,
    elements.videoTrack1B, elements.videoTrack2B, elements.videoTrack3B].forEach(video => {
        if (video) {
            video.pause();
            video.currentTime = 0;
            video.src = '';
            video._loadedUrl = null;
            video.classList.remove('active');
        }
    });
    state._trackActiveEl = { '1': 'a', '2': 'a', '3': 'a' };
    [elements.imgTrack1, elements.imgTrack2, elements.imgTrack3].forEach(img => {
        if (img) {
            img.src = '';
            img.classList.remove('active');
        }
    });

    elements.previewPlaceholder.classList.remove('hidden');
    elements.btnRender.disabled = true;
    showProgress(false);
    showToast('New project started', 'success');
}

function showOpenProjectDialog() {
    const existing = document.getElementById('open-project-dialog');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'open-project-dialog';
    overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.7);z-index:10000;display:flex;align-items:center;justify-content:center;';

    const dialog = document.createElement('div');
    dialog.style.cssText = 'background:#1e1e2e;border:1px solid #444;border-radius:12px;padding:24px 28px;width:460px;max-width:90vw;box-shadow:0 20px 60px rgba(0,0,0,0.5);';
    dialog.innerHTML = `
        <h2 style="margin:0 0 10px;font-size:1.2rem;color:#e0e0e0;font-weight:600;">Open Project</h2>
        <p style="margin:0 0 18px;color:#aaa;line-height:1.45;">Choose how you want to open your project.</p>
        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:12px;">
            <button id="op-open-folder" style="padding:11px 14px;background:#2e3a70;border:1px solid #5b6bd8;border-radius:8px;color:#fff;cursor:pointer;font-size:0.95rem;font-weight:600;text-align:left;">Open Project Folder</button>
            <button id="op-open-file" style="padding:11px 14px;background:#2a2f3f;border:1px solid #555;border-radius:8px;color:#fff;cursor:pointer;font-size:0.95rem;font-weight:600;text-align:left;">Open .fvp Project File</button>
        </div>
        <div id="op-status" style="min-height:18px;margin-bottom:12px;color:#888;font-size:0.85rem;"></div>
        <div style="display:flex;justify-content:flex-end;">
            <button id="op-cancel" style="padding:9px 16px;background:transparent;border:1px solid #555;border-radius:6px;color:#aaa;cursor:pointer;font-size:0.9rem;">Cancel</button>
        </div>
    `;

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);

    const openFolderBtn = document.getElementById('op-open-folder');
    const openFileBtn = document.getElementById('op-open-file');
    const cancelBtn = document.getElementById('op-cancel');
    const statusEl = document.getElementById('op-status');

    const setBusy = (busy, text = '') => {
        openFolderBtn.disabled = busy;
        openFileBtn.disabled = busy;
        cancelBtn.disabled = busy;
        openFolderBtn.style.opacity = busy ? '0.6' : '1';
        openFileBtn.style.opacity = busy ? '0.6' : '1';
        statusEl.textContent = text;
    };

    const runOpen = async (kind) => {
        const openFolder = window.electronAPI.openExistingProjectFolder;
        const openFile = window.electronAPI.openExistingProjectFile;
        if (!openFolder || !openFile) {
            statusEl.style.color = '#ff8f8f';
            statusEl.textContent = 'Open project APIs are unavailable.';
            return;
        }
        setBusy(true, kind === 'folder' ? 'Selecting folder...' : 'Selecting .fvp file...');
        try {
            const result = kind === 'folder' ? await openFolder() : await openFile();
            if (result && result.success) {
                showToast('Project window opened', 'success');
                overlay.remove();
                return;
            }
            setBusy(false, '');
            if (result && result.cancelled) return;
            statusEl.style.color = '#ff8f8f';
            statusEl.textContent = result?.error || 'Failed to open project.';
        } catch (e) {
            setBusy(false, '');
            statusEl.style.color = '#ff8f8f';
            statusEl.textContent = e?.message || 'Failed to open project.';
        }
    };

    openFolderBtn.addEventListener('click', () => runOpen('folder'));
    openFileBtn.addEventListener('click', () => runOpen('file'));
    cancelBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.getElementById('open-project-dialog')) {
            overlay.remove();
        }
    }, { once: true });
}

async function openExistingProject() {
    if (state.isProcessing) {
        showToast('Please wait for current process to finish', 'error');
        return;
    }

    // Prefer custom in-app chooser dialog (no native mode prompt popup)
    if (window.electronAPI.openExistingProjectFolder && window.electronAPI.openExistingProjectFile) {
        showOpenProjectDialog();
        return;
    }

    // Backward compatibility fallback
    if (window.electronAPI.openExistingProject) {
        const result = await window.electronAPI.openExistingProject();
        if (result && result.success) {
            showToast('Project window opened', 'success');
        }
    }
}

async function refreshApp() {
    if (state.isProcessing) {
        showToast('Please wait for current process to finish', 'error');
        return;
    }
    // Auto-save current state before refresh so no work is lost
    if (state.scenes.length > 0 && window.electronAPI.saveProjectFile) {
        try {
            await saveProject();
            console.log('✅ Auto-saved before refresh');
        } catch (e) {
            console.warn('Auto-save before refresh failed:', e.message);
        }
    }
    showToast('Refreshing...', 'info');
    // Reload the window - picks up any file changes without restarting the server
    window.location.reload();
}

// ========================================
// Electron API Fallback
// ========================================
if (!window.electronAPI) {
    window.electronAPI = {
        runBuild: async () => ({ success: true }), runRender: async () => ({ success: true, outputPath: '' }),
        loadVideoPlan: async () => ({
            totalDuration: 30, scenes: [
                { text: 'Welcome to this video...', keyword: 'city skyline', startTime: 0, endTime: 5 },
                { text: 'Today we will discuss...', keyword: 'business meeting', startTime: 5, endTime: 12 },
                { text: 'The most important thing...', keyword: 'success', startTime: 12, endTime: 20 },
                { text: 'Thank you for watching!', keyword: 'sunset ocean', startTime: 20, endTime: 30 }
            ]
        }),
        copyFile: async () => true, getSceneVideoPath: async () => null, getSceneMediaPath: async () => null, getFileUrl: async () => null, getAudioPath: async () => null,
        openExistingProject: async () => ({ success: false, cancelled: true }),
        openExistingProjectFolder: async () => ({ success: false, cancelled: true }),
        openExistingProjectFile: async () => ({ success: false, cancelled: true }),
        onBuildProgress: () => { }, onRenderProgress: () => { },
        cancelProcess: async () => ({ success: true, message: 'Cancelled' }),
        showNotification: () => { }
    };
}

document.addEventListener('DOMContentLoaded', init);
