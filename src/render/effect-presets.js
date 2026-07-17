/**
 * Effect Presets — Pre-made effect combos like CapCut's "Retro DV", "Old Film" etc.
 *
 * Each preset bundles multiple shader effects with tuned params, a global mask,
 * and adjustable sliders (intensity, speed, warmth).
 *
 * Adding a new preset:
 * 1. Add an entry below with unique key (camelCase)
 * 2. Set effects[] (which shader effects to enable)
 * 3. Set params{} (per-effect parameters)
 * 4. Set mask (global radial/linear mask or null)
 * 5. Set sliders[] (user-adjustable high-level controls)
 * 6. Set themes[] (which themes this preset appears for, or ['*'] for all)
 * 7. Set description (shown to AI for selection)
 *
 * IMPORTANT: Intensity slider defaults must be 20-40 (subtle).
 * Mask strength must be 0.4-1.0 (always noticeable).
 *
 * Available shader effects:
 *   grain, dust, vignette, blurVignette, chromatic, lightLeak,
 *   scratch, colorGrade, scanLine, flicker, filmFrame
 */

const EFFECT_PRESETS = {
    none: {
        label: 'None',
        description: 'No effect',
        effects: [],
        params: {},
        mask: null,
        sliders: [],
        themes: ['*']
    },

    // ─── Retro / Film ───
    retroDV: {
        label: 'Retro DV',
        description: 'Old camcorder look — grain, scratches, scan lines, warm desaturated color, flicker. Great for archival/history footage.',
        effects: ['grain', 'scratch', 'scanLine', 'colorGrade', 'flicker', 'vignette'],
        params: {
            grain:      { intensity: 0.16, scale: 1.2 },
            scratch:    { intensity: 0.25, speed: 1.2, density: 0.5 },
            scanLine:   { intensity: 0.10, count: 500, speed: 3.0 },
            colorGrade: { desaturation: 0.3, tintR: 1.0, tintG: 0.95, tintB: 0.85, tintStrength: 0.4 },
            flicker:    { intensity: 0.06, speed: 1.0 },
            vignette:   { intensity: 0.5, radius: 0.35, softness: 0.5 }
        },
        mask: { type: 'radialCenter', strength: 0.6 },
        sliders: [
            { key: 'intensity', label: 'Intensity', min: 0, max: 100, def: 30 },
            { key: 'speed', label: 'Speed', min: 0, max: 100, def: 50 }
        ],
        themes: ['history', 'crime', 'standard']
    },

    oldFilm: {
        label: 'Old Film',
        description: 'Aged film stock — heavy grain, dust, scratches, sepia tone, flicker, dark vignette. Best for old era/historical scenes.',
        effects: ['grain', 'dust', 'scratch', 'colorGrade', 'flicker', 'vignette'],
        params: {
            grain:      { intensity: 0.24, scale: 1.0 },
            dust:       { intensity: 0.18, density: 0.45 },
            scratch:    { intensity: 0.35, speed: 0.8, density: 0.6 },
            colorGrade: { desaturation: 0.7, tintR: 1.0, tintG: 0.9, tintB: 0.7, tintStrength: 0.5 },
            flicker:    { intensity: 0.10, speed: 0.8 },
            vignette:   { intensity: 0.7, radius: 0.28, softness: 0.45 }
        },
        mask: { type: 'radialCenter', strength: 0.7 },
        sliders: [
            { key: 'intensity', label: 'Intensity', min: 0, max: 100, def: 35 },
            { key: 'speed', label: 'Speed', min: 0, max: 100, def: 40 }
        ],
        themes: ['history']
    },

    vintageWarm: {
        label: 'Vintage Warm',
        description: 'Warm nostalgic glow — light grain, warm light leaks, slight desaturation, soft vignette. Dreamy/elegant feel.',
        effects: ['grain', 'lightLeak', 'colorGrade', 'vignette'],
        params: {
            grain:      { intensity: 0.12, scale: 1.5 },
            lightLeak:  { intensity: 0.20, warmth: 0.85 },
            colorGrade: { desaturation: 0.15, tintR: 1.0, tintG: 0.92, tintB: 0.8, tintStrength: 0.35 },
            vignette:   { intensity: 0.45, radius: 0.4, softness: 0.5 }
        },
        mask: { type: 'radialCenter', strength: 0.6 },
        sliders: [
            { key: 'intensity', label: 'Intensity', min: 0, max: 100, def: 30 },
            { key: 'warmth', label: 'Warmth', min: 0, max: 100, def: 50 }
        ],
        themes: ['history', 'standard']
    },

    retroSparkle: {
        label: 'Retro Sparkle',
        description: 'Shimmering retro — light grain, bright dust particles, warm light leaks, subtle chromatic aberration, flicker. Festive/sparkly.',
        effects: ['grain', 'dust', 'lightLeak', 'chromatic', 'flicker'],
        params: {
            grain:     { intensity: 0.10, scale: 1.3 },
            dust:      { intensity: 0.20, density: 0.5 },
            lightLeak: { intensity: 0.22, warmth: 0.7 },
            chromatic: { intensity: 0.004, angle: 0.0 },
            flicker:   { intensity: 0.05, speed: 1.2 }
        },
        mask: { type: 'radialCenter', strength: 0.5 },
        sliders: [
            { key: 'intensity', label: 'Intensity', min: 0, max: 100, def: 25 },
            { key: 'speed', label: 'Speed', min: 0, max: 100, def: 50 }
        ],
        themes: ['history', 'modern']
    },

    // ─── Cinematic / Dark ───
    filmNoir: {
        label: 'Film Noir',
        description: 'Dark cinematic — heavy desaturation, strong vignette, grain, light scratches. Moody, dramatic, crime/dark scenes.',
        effects: ['grain', 'colorGrade', 'vignette', 'scratch'],
        params: {
            grain:      { intensity: 0.20, scale: 1.0 },
            colorGrade: { desaturation: 0.85, tintR: 0.95, tintG: 0.95, tintB: 1.0, tintStrength: 0.3 },
            vignette:   { intensity: 0.8, radius: 0.25, softness: 0.4 },
            scratch:    { intensity: 0.15, speed: 0.6, density: 0.3 }
        },
        mask: { type: 'radialCenter', strength: 0.7 },
        sliders: [
            { key: 'intensity', label: 'Intensity', min: 0, max: 100, def: 35 }
        ],
        themes: ['crime', 'history']
    },

    cinematic: {
        label: 'Cinematic',
        description: 'Modern cinema look — subtle grain, blurred edges (depth of field), cool color grade, slight chromatic. Clean but polished.',
        effects: ['grain', 'blurVignette', 'colorGrade', 'chromatic'],
        params: {
            grain:        { intensity: 0.08, scale: 1.8 },
            blurVignette: { intensity: 0.4, radius: 0.5, blurAmount: 3.5 },
            colorGrade:   { desaturation: 0.1, tintR: 0.95, tintG: 0.98, tintB: 1.0, tintStrength: 0.2 },
            chromatic:    { intensity: 0.003, angle: 0.0 }
        },
        mask: { type: 'radialCenter', strength: 0.5 },
        sliders: [
            { key: 'intensity', label: 'Intensity', min: 0, max: 100, def: 30 }
        ],
        themes: ['crime', 'modern', 'minimal']
    },

    // ─── Clean / Modern ───
    cleanGlow: {
        label: 'Clean Glow',
        description: 'Soft modern glow — blurred edges, subtle light leak, minimal grain. Clean, professional, contemporary.',
        effects: ['blurVignette', 'lightLeak', 'grain'],
        params: {
            blurVignette: { intensity: 0.3, radius: 0.55, blurAmount: 2.5 },
            lightLeak:    { intensity: 0.12, warmth: 0.5 },
            grain:        { intensity: 0.05, scale: 2.0 }
        },
        mask: { type: 'radialCenter', strength: 0.4 },
        sliders: [
            { key: 'intensity', label: 'Intensity', min: 0, max: 100, def: 25 }
        ],
        themes: ['modern', 'minimal', 'standard']
    },

    vhsGlitch: {
        label: 'VHS Glitch',
        description: 'VHS tape distortion — scan lines, chromatic aberration, grain, color shift, flicker, scratches. Retro tech/glitch aesthetic.',
        effects: ['scanLine', 'chromatic', 'grain', 'colorGrade', 'flicker', 'scratch'],
        params: {
            scanLine:   { intensity: 0.18, count: 300, speed: 8.0 },
            chromatic:  { intensity: 0.008, angle: 1.57 },
            grain:      { intensity: 0.18, scale: 1.0 },
            colorGrade: { desaturation: 0.2, tintR: 0.9, tintG: 1.0, tintB: 1.0, tintStrength: 0.3 },
            flicker:    { intensity: 0.08, speed: 1.5 },
            scratch:    { intensity: 0.20, speed: 1.5, density: 0.4 }
        },
        mask: { type: 'radialCenter', strength: 0.5 },
        sliders: [
            { key: 'intensity', label: 'Intensity', min: 0, max: 100, def: 30 },
            { key: 'speed', label: 'Speed', min: 0, max: 100, def: 50 }
        ],
        themes: ['crime', 'modern']
    },

    // ─── Film Frame / Vintage ───
    vintageFrame: {
        label: 'Vintage Frame',
        description: 'Vintage film projector look — black border with rounded inner frame, subtle grain, warm vignette. Gives footage an old-school projected feel. Great for documentary, archival, or artistic scenes.',
        effects: ['filmFrame', 'grain', 'vignette', 'colorGrade'],
        params: {
            filmFrame:  { border: 0.04, radius: 0.03, softness: 0.012, darken: 1.0 },
            grain:      { intensity: 0.10, scale: 1.2 },
            vignette:   { intensity: 0.5, radius: 0.3, softness: 0.45 },
            colorGrade: { desaturation: 0.12, tintR: 1.0, tintG: 0.95, tintB: 0.88, tintStrength: 0.25 }
        },
        mask: null,
        sliders: [
            { key: 'intensity', label: 'Intensity', min: 0, max: 100, def: 30 },
            { key: 'border', label: 'Border Size', min: 0, max: 100, def: 40 }
        ],
        themes: ['history', 'crime', 'standard']
    },

    filmProjector: {
        label: 'Film Projector',
        description: 'Full old projector effect — thick black frame with rounded corners, heavy grain, dust, scratches, flicker, sepia tone. Maximum retro film authenticity.',
        effects: ['filmFrame', 'grain', 'dust', 'scratch', 'flicker', 'vignette', 'colorGrade'],
        params: {
            filmFrame:  { border: 0.055, radius: 0.04, softness: 0.015, darken: 1.0 },
            grain:      { intensity: 0.22, scale: 1.0 },
            dust:       { intensity: 0.16, density: 0.4 },
            scratch:    { intensity: 0.28, speed: 0.7, density: 0.5 },
            flicker:    { intensity: 0.08, speed: 0.9 },
            vignette:   { intensity: 0.65, radius: 0.25, softness: 0.4 },
            colorGrade: { desaturation: 0.55, tintR: 1.0, tintG: 0.88, tintB: 0.7, tintStrength: 0.45 }
        },
        mask: null,
        sliders: [
            { key: 'intensity', label: 'Intensity', min: 0, max: 100, def: 35 },
            { key: 'border', label: 'Border Size', min: 0, max: 100, def: 55 }
        ],
        themes: ['history']
    }
};

module.exports = EFFECT_PRESETS;
