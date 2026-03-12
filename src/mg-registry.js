/**
 * MG Registry — Central source of truth for all MG categories and their types/variants.
 *
 * Each category defines:
 * - label: Display name
 * - group: 'overlay' or 'fullscreen'
 * - types: Map of variant key → { label, animation, themeOverridable }
 * - animations: Available animation profiles for this category
 * - defaultType: Fallback when no subType is set
 * - fields: Which sidebar fields are relevant for this category
 *
 * The UI dynamically generates the "Variant" dropdown from types.
 * The renderer resolves subType → render function via dispatcher pattern.
 *
 * Adding a new variant:
 *   1. Add entry to MG_REGISTRY[category].types
 *   2. Add _render{Category}_{Variant}() method in MGRenderer.js
 *   3. Add case in that category's dispatcher
 */

const MG_REGISTRY = {
    // ── Overlay MGs ──
    headline: {
        label: 'Headline',
        group: 'overlay',
        types: {
            standard:  { label: 'Standard',      animation: 'springScale' },
            stamp:     { label: 'Stamp',          animation: 'popUp' },
            typewriter:{ label: 'Typewriter',     animation: 'slideLeft' },
        },
        animations: ['springScale', 'popUp', 'slideLeft', 'fadeSlide'],
        defaultType: 'standard',
        fields: ['text', 'subtext', 'position'],
    },

    lowerThird: {
        label: 'Lower Third',
        group: 'overlay',
        types: {
            bar:       { label: 'Bar',            animation: 'slideLeft',  themeOverridable: true },
            box:       { label: 'Box',            animation: 'slideLeft',  themeOverridable: true },
            underline: { label: 'Underline',      animation: 'fadeSlide',  themeOverridable: true },
            banner:    { label: 'Banner',         animation: 'wipeRight',  themeOverridable: true },
            glass:     { label: 'Glass',          animation: 'fadeSlide',  themeOverridable: true },
            split:     { label: 'Split',          animation: 'popUp',      themeOverridable: true },
        },
        animations: ['slideLeft', 'wipeRight', 'popUp', 'fadeSlide'],
        defaultType: 'bar',
        fields: ['text', 'subtext', 'position'],
    },

    callout: {
        label: 'Callout',
        group: 'overlay',
        types: {
            standard:  { label: 'Quote Box',      animation: 'springScale' },
            minimal:   { label: 'Minimal',        animation: 'fadeSlide' },
            accent:    { label: 'Accent Bar',     animation: 'slideLeft' },
        },
        animations: ['springScale', 'fadeSlide', 'slideLeft', 'popUp'],
        defaultType: 'standard',
        fields: ['text', 'subtext', 'position'],
    },

    statCounter: {
        label: 'Stat Counter',
        group: 'overlay',
        types: {
            standard:  { label: 'Standard',       animation: 'countUp' },
            ticker:    { label: 'Ticker',         animation: 'slideLeft' },
            ring:      { label: 'Ring Gauge',     animation: 'popUp' },
        },
        animations: ['countUp', 'slideLeft', 'popUp', 'fadeSlide'],
        defaultType: 'standard',
        fields: ['text', 'subtext', 'position'],
    },

    focusWord: {
        label: 'Focus Word',
        group: 'overlay',
        types: {
            standard:  { label: 'Standard',       animation: 'springScale' },
        },
        animations: ['springScale', 'popUp', 'fadeSlide'],
        defaultType: 'standard',
        fields: ['text', 'position'],
    },

    progressBar: {
        label: 'Progress Bar',
        group: 'overlay',
        types: {
            standard:  { label: 'Standard',       animation: 'slideLeft' },
        },
        animations: ['slideLeft', 'wipeRight'],
        defaultType: 'standard',
        fields: ['text', 'subtext', 'position'],
    },

    // ── Full Screen MGs ──
    barChart: {
        label: 'Bar Chart',
        group: 'fullscreen',
        types: {
            standard:  { label: 'Standard',       animation: 'staggerBars' },
        },
        animations: ['staggerBars', 'popUp'],
        defaultType: 'standard',
        fields: ['text', 'subtext'],
    },

    donutChart: {
        label: 'Donut Chart',
        group: 'fullscreen',
        types: {
            standard:  { label: 'Standard',       animation: 'spinReveal' },
        },
        animations: ['spinReveal'],
        defaultType: 'standard',
        fields: ['text', 'subtext'],
    },

    rankingList: {
        label: 'Ranking List',
        group: 'fullscreen',
        types: {
            standard:  { label: 'Standard',       animation: 'staggerSlide' },
        },
        animations: ['staggerSlide'],
        defaultType: 'standard',
        fields: ['text', 'subtext'],
    },

    timeline: {
        label: 'Timeline',
        group: 'fullscreen',
        types: {
            standard:  { label: 'Standard',       animation: 'staggerSlide' },
        },
        animations: ['staggerSlide'],
        defaultType: 'standard',
        fields: ['text', 'subtext'],
    },

    comparisonCard: {
        label: 'Comparison',
        group: 'fullscreen',
        types: {
            standard:  { label: 'Standard',       animation: 'springScale' },
        },
        animations: ['springScale'],
        defaultType: 'standard',
        fields: ['text', 'subtext'],
    },

    bulletList: {
        label: 'Bullet List',
        group: 'fullscreen',
        types: {
            standard:  { label: 'Standard',       animation: 'staggerSlide' },
        },
        animations: ['staggerSlide'],
        defaultType: 'standard',
        fields: ['text', 'subtext'],
    },

    mapChart: {
        label: 'Map',
        group: 'fullscreen',
        types: {
            standard:  { label: 'Standard',       animation: 'fadeSlide' },
        },
        animations: ['fadeSlide'],
        defaultType: 'standard',
        fields: ['text', 'subtext'],
    },

    kineticText: {
        label: 'Kinetic Text',
        group: 'fullscreen',
        types: {
            standard:  { label: 'Standard',       animation: 'springScale' },
        },
        animations: ['springScale'],
        defaultType: 'standard',
        fields: ['text'],
    },

    subscribeCTA: {
        label: 'Subscribe CTA',
        group: 'overlay',
        types: {
            standard:  { label: 'Standard',       animation: 'popUp' },
        },
        animations: ['popUp', 'slideLeft'],
        defaultType: 'standard',
        fields: ['text', 'subtext', 'position'],
    },

    articleHighlight: {
        label: 'Article Highlight',
        group: 'fullscreen',
        types: {
            standard:  { label: 'Standard',       animation: 'fadeSlide' },
        },
        animations: ['fadeSlide'],
        defaultType: 'standard',
        fields: ['text', 'subtext'],
    },
};

/**
 * Resolve the effective subType for an MG.
 * Priority: mg.subType (user-set) > theme override > style preset > registry default
 *
 * @param {Object} mg - The MG data object
 * @param {Object} [themeOverride] - Theme override object (from MG_THEME_OVERRIDES)
 * @param {Object} [stylePreset] - Style preset (from MG_STYLE_PRESETS via MG_STYLES)
 * @returns {string} The resolved subType key
 */
function resolveSubType(mg, themeOverride, stylePreset) {
    // 1. User explicitly set it
    if (mg.subType) return mg.subType;

    const reg = MG_REGISTRY[mg.type];
    if (!reg) return 'standard';

    // 2. Theme override (e.g. crime → banner for lowerThird)
    if (themeOverride?.style && reg.types[themeOverride.style]) {
        return themeOverride.style;
    }

    // 3. Style preset (e.g. cinematic style → banner for lowerThird)
    // Only for lowerThird for now (existing pattern); extend per-category as needed
    if (mg.type === 'lowerThird' && stylePreset?.lowerThirdStyle) {
        return stylePreset.lowerThirdStyle;
    }

    // 4. Registry default
    return reg.defaultType;
}

/**
 * Resolve the effective animation for an MG's subType.
 * Priority: mg.animation (user-set) > theme override > type default > registry default
 */
function resolveAnimation(mg, subType, themeOverride) {
    if (mg.animation) return mg.animation;

    const reg = MG_REGISTRY[mg.type];
    if (!reg) return 'springScale';

    // Theme override animation
    if (themeOverride?.anim) return themeOverride.anim;

    // Type-specific default
    const typeEntry = reg.types[subType];
    if (typeEntry?.animation) return typeEntry.animation;

    // Fallback: first animation in list
    return reg.animations[0] || 'springScale';
}

/**
 * Get the list of available types for a category.
 * Returns [{key, label}] for populating UI dropdowns.
 */
function getTypesForCategory(category) {
    const reg = MG_REGISTRY[category];
    if (!reg) return [];
    return Object.entries(reg.types).map(([key, val]) => ({ key, label: val.label }));
}

/**
 * Get the list of available animations for a category.
 */
function getAnimationsForCategory(category) {
    const reg = MG_REGISTRY[category];
    if (!reg) return [];
    return reg.animations;
}

// ── Exports ──
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        MG_REGISTRY,
        resolveSubType,
        resolveAnimation,
        getTypesForCategory,
        getAnimationsForCategory,
    };
}
