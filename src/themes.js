/**
 * Theme System — Visual layer only
 *
 * Themes control VISUAL presentation:
 * - Color palette (primary, secondary, accent, text)
 * - Font families (heading, body)
 * - Motion graphics visual style (clean, bold, neon, etc.)
 * - Transition visual preferences
 * - Overlay visual preferences
 * - Background canvas styling
 *
 * Themes do NOT control content strategy (MG type selection, footage priority,
 * pacing). That's handled by the Niche system (src/niches.js).
 *
 * The AI Director picks a niche, and each niche has a defaultTheme.
 * User can override the theme independently.
 */

// ============================================================
// THEME DEFINITIONS
// ============================================================

const THEMES = {
    tech: {
        id: 'tech',
        name: 'Tech/Cyberpunk',
        description: 'Futuristic, digital, high-tech visuals',

        background: 'tech-grid',
        canvasBackground: 'matrixDots',
        mgStyle: 'neon',

        colors: {
            primary: '#00ffff',
            secondary: '#ff00ff',
            accent: '#00ff00',
            text: '#ffffff',
            background: '#0a0a0a',
            shadow: 'rgba(0, 255, 255, 0.5)'
        },

        fonts: {
            heading: 'Orbitron, Electrolize, "Courier New", monospace',
            body: '"Roboto Mono", "Source Code Pro", monospace'
        },

        transitions: {
            primary: ['glitch', 'pixelate', 'flash', 'rgbSplit', 'dataMosh', 'scanline'],
            secondary: ['wipe', 'slide', 'zoom', 'static', 'crossBlur'],
            avoid: ['ripple', 'dissolve', 'dreamFade', 'ink']
        },

        overlays: {
            preferred: ['crt', 'vhs', 'scanline', 'digital', 'glitch', 'static', 'grain'],
            avoid: ['paper', 'film', 'vintage'],
            effects: ['grain', 'chromatic'],
            blendMode: 'screen',
            intensity: { min: 0.2, max: 0.5 }
        }
    },

    nature: {
        id: 'nature',
        name: 'Nature Documentary',
        description: 'Natural, organic, earthy visuals',

        background: 'nature',
        canvasBackground: 'organicNoise',
        mgStyle: 'cinematic',

        colors: {
            primary: '#8B4513',
            secondary: '#228B22',
            accent: '#87CEEB',
            text: '#FFFFFF',
            background: '#1a1a1a',
            shadow: 'rgba(0, 0, 0, 0.6)'
        },

        fonts: {
            heading: '"Libre Baskerville", Merriweather, Georgia, serif',
            body: 'Lora, "Open Sans", Georgia, sans-serif'
        },

        transitions: {
            primary: ['dissolve', 'crossBlur', 'fade', 'ripple', 'dreamFade', 'morph'],
            secondary: ['luma', 'blur', 'crossfade', 'lightLeak', 'ink'],
            avoid: ['glitch', 'flash', 'pixelate', 'dataMosh', 'static', 'rgbSplit']
        },

        overlays: {
            preferred: ['dust', 'lightleak', 'film', 'grain', 'bokeh', 'blur'],
            avoid: ['crt', 'vhs', 'glitch', 'scanline', 'digital'],
            effects: ['grain', 'lightLeak', 'blurVignette'],
            blendMode: 'screen',
            intensity: { min: 0.15, max: 0.4 }
        }
    },

    crime: {
        id: 'crime',
        name: 'True Crime/Dark',
        description: 'Dark, moody, high-contrast visuals',

        background: 'dark',
        canvasBackground: 'vignette',
        mgStyle: 'cinematic',

        colors: {
            primary: '#dc143c',
            secondary: '#1a1a1a',
            accent: '#ffd700',
            text: '#FFFFFF',
            background: '#000000',
            shadow: 'rgba(220, 20, 60, 0.4)'
        },

        fonts: {
            heading: 'Oswald, "Bebas Neue", Impact, sans-serif',
            body: '"Barlow Condensed", Lato, Arial, sans-serif'
        },

        transitions: {
            primary: ['flash', 'wipe', 'luma', 'directionalBlur', 'shadowWipe', 'vignetteBlink'],
            secondary: ['fade', 'dissolve', 'colorFade', 'cameraFlash'],
            avoid: ['ripple', 'spin', 'mosaic', 'dreamFade', 'bounce']
        },

        overlays: {
            preferred: ['grain', 'dust', 'scratch', 'damage', 'vignette', 'film', 'noise'],
            avoid: ['lightleak', 'bokeh', 'paper'],
            effects: ['grain', 'dust', 'vignette'],
            blendMode: 'screen',
            intensity: { min: 0.25, max: 0.55 }
        }
    },

    corporate: {
        id: 'corporate',
        name: 'Corporate/Professional',
        description: 'Clean, professional, polished visuals',

        background: 'light',
        canvasBackground: 'gridLines',
        mgStyle: 'clean',

        colors: {
            primary: '#0066cc',
            secondary: '#333333',
            accent: '#00cc66',
            text: '#FFFFFF',
            background: '#f5f5f5',
            shadow: 'rgba(0, 0, 0, 0.3)'
        },

        fonts: {
            heading: 'Montserrat, "Work Sans", Arial, sans-serif',
            body: '"Source Sans Pro", "Open Sans", "Segoe UI", sans-serif'
        },

        transitions: {
            primary: ['push', 'slide', 'fade', 'crossBlur', 'splitWipe'],
            secondary: ['dissolve', 'luma', 'blur', 'morph'],
            avoid: ['glitch', 'pixelate', 'flash', 'dataMosh', 'static', 'rgbSplit', 'spin']
        },

        overlays: {
            preferred: ['paper', 'lightleak', 'blur', 'bokeh'],
            avoid: ['crt', 'vhs', 'glitch', 'damage', 'scratch', 'scanline'],
            effects: ['blurVignette', 'lightLeak'],
            blendMode: 'soft-light',
            intensity: { min: 0.1, max: 0.3 }
        }
    },

    luxury: {
        id: 'luxury',
        name: 'Luxury/Fashion',
        description: 'Elegant, golden, premium visuals',

        background: 'warm',
        canvasBackground: 'softGlow',
        mgStyle: 'elegant',

        colors: {
            primary: '#d4af37',
            secondary: '#1a1a1a',
            accent: '#c0c0c0',
            text: '#FFFFFF',
            background: '#0a0a0a',
            shadow: 'rgba(212, 175, 55, 0.4)'
        },

        fonts: {
            heading: '"Playfair Display", Cinzel, Georgia, serif',
            body: 'Lora, "Libre Baskerville", "Times New Roman", serif'
        },

        transitions: {
            primary: ['dissolve', 'crossBlur', 'colorFade', 'luma', 'flare', 'lightLeak'],
            secondary: ['fade', 'reveal', 'blur', 'dreamFade', 'prismShift'],
            avoid: ['glitch', 'pixelate', 'swipe', 'dataMosh', 'static', 'bounce']
        },

        overlays: {
            preferred: ['lightleak', 'bokeh', 'blur', 'film', 'dust'],
            avoid: ['crt', 'vhs', 'glitch', 'damage', 'scanline', 'scratch'],
            effects: ['lightLeak', 'blurVignette'],
            blendMode: 'screen',
            intensity: { min: 0.15, max: 0.4 }
        }
    },

    sport: {
        id: 'sport',
        name: 'Sports/Action',
        description: 'Bold, high-energy, dynamic visuals',

        background: 'dark',
        canvasBackground: 'energyBurst',
        mgStyle: 'bold',

        colors: {
            primary: '#ff4500',
            secondary: '#ffd700',
            accent: '#00ff00',
            text: '#FFFFFF',
            background: '#0a0a0a',
            shadow: 'rgba(255, 69, 0, 0.5)'
        },

        fonts: {
            heading: '"Bebas Neue", "Fjalla One", Impact, sans-serif',
            body: '"Roboto Condensed", "Barlow Condensed", Arial, sans-serif'
        },

        transitions: {
            primary: ['swipe', 'push', 'directionalBlur', 'zoom', 'whip', 'zoomBlur', 'shutterSlice'],
            secondary: ['wipe', 'flash', 'slide', 'bounce', 'splitWipe'],
            avoid: ['dissolve', 'ripple', 'crossBlur', 'dreamFade', 'ink', 'morph']
        },

        overlays: {
            preferred: ['grain', 'dust', 'lightleak', 'scratch'],
            avoid: ['paper', 'bokeh', 'crt', 'vhs'],
            effects: ['grain', 'dust'],
            blendMode: 'screen',
            intensity: { min: 0.2, max: 0.45 }
        }
    },

    neutral: {
        id: 'neutral',
        name: 'Neutral/Balanced',
        description: 'Clean, versatile, balanced visuals',

        background: 'neutral',
        canvasBackground: 'subtleGrain',
        mgStyle: 'clean',

        colors: {
            primary: '#4a90e2',
            secondary: '#2c3e50',
            accent: '#e74c3c',
            text: '#FFFFFF',
            background: '#1a1a1a',
            shadow: 'rgba(0, 0, 0, 0.5)'
        },

        fonts: {
            heading: 'Nunito, Raleway, Arial, sans-serif',
            body: '"Open Sans", Roboto, Arial, sans-serif'
        },

        transitions: {
            primary: ['fade', 'dissolve', 'slide', 'zoom', 'wipe', 'push'],
            secondary: ['blur', 'crossBlur', 'crossfade', 'lightLeak', 'reveal'],
            avoid: []
        },

        overlays: {
            preferred: ['grain', 'dust', 'lightleak', 'blur', 'bokeh'],
            avoid: [],
            effects: ['grain', 'lightLeak', 'blurVignette', 'dust'],
            blendMode: 'screen',
            intensity: { min: 0.15, max: 0.4 }
        }
    }
};

// ============================================================
// BACKGROUND CANVAS URLS (Stock footage sources)
// ============================================================

// These will be downloaded and cached in assets/backgrounds/
// Similar to overlay-manager.js, but for background textures
const BACKGROUND_SOURCES = {
    'tech-grid': {
        name: 'Tech Grid Animation',
        keywords: ['tech grid animation loop', 'digital matrix background', 'cyber circuit pattern'],
        duration: 10,
        opacity: 0.15,
        preferredType: 'pattern',  // tech looks best with 3D grid patterns
        blurAmount: 25,
        cssGradient: 'radial-gradient(ellipse at center, #0a1628 0%, #000000 100%)'
    },
    'nature': {
        name: 'Nature Texture',
        keywords: ['nature texture loop', 'organic pattern background', 'earth tone gradient'],
        duration: 10,
        opacity: 0.20,
        preferredType: 'blur',  // natural footage looks great blurred
        blurAmount: 30,
        cssGradient: 'radial-gradient(ellipse at center, #1a2a1a 0%, #0a0a0a 100%)'
    },
    'dark': {
        name: 'Dark Gradient',
        keywords: ['dark gradient loop', 'black smoke texture', 'noir atmosphere'],
        duration: 10,
        opacity: 0.25,
        preferredType: 'blur',  // cinematic blur for crime/dark
        blurAmount: 25,
        cssGradient: 'radial-gradient(ellipse at center, #1a1a2a 0%, #000000 100%)'
    },
    'light': {
        name: 'Light Gradient',
        keywords: ['light gradient loop', 'soft white texture', 'clean background'],
        duration: 10,
        opacity: 0.15,
        preferredType: 'pattern',  // corporate/clean looks good with subtle patterns
        blurAmount: 30,
        cssGradient: 'radial-gradient(ellipse at center, #2a2a3a 0%, #1a1a1a 100%)'
    },
    'warm': {
        name: 'Warm Gradient',
        keywords: ['warm gradient loop', 'golden texture', 'luxury background'],
        duration: 10,
        opacity: 0.18,
        preferredType: 'blur',  // luxury = elegant blur
        blurAmount: 28,
        cssGradient: 'radial-gradient(ellipse at center, #2a1a0a 0%, #0a0a0a 100%)'
    },
    'neutral': {
        name: 'Neutral Gradient',
        keywords: ['gray gradient loop', 'neutral texture', 'subtle background'],
        duration: 10,
        opacity: 0.12,
        preferredType: 'blur',  // safe default
        blurAmount: 25,
        cssGradient: 'radial-gradient(ellipse at center, #1a1a1a 0%, #0a0a0a 100%)'
    }
};

// ============================================================
// BUILT-IN BACKGROUND LIBRARY (CSS gradient backgrounds)
// These are rendered as <div> backgrounds — no image files needed.
// User can ALSO add .png/.jpg/.mp4 files to assets/backgrounds/
// ============================================================

const BACKGROUND_LIBRARY = {
    'dark-gradient': {
        name: 'Dark Gradient',
        css: 'radial-gradient(ellipse at 50% 40%, #1a1a2e 0%, #0a0a14 60%, #000000 100%)',
        themes: ['crime', 'dark', 'tech', 'neutral'],
        mood: ['dark', 'dramatic', 'mysterious'],
    },
    'blue-minimal': {
        name: 'Blue Minimal',
        css: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
        themes: ['tech', 'corporate', 'neutral'],
        mood: ['calm', 'professional', 'cool'],
    },
    'dark-blue': {
        name: 'Dark Blue',
        css: 'radial-gradient(ellipse at 50% 50%, #0f2027 0%, #203a43 40%, #2c5364 100%)',
        themes: ['tech', 'corporate', 'crime', 'neutral'],
        mood: ['calm', 'professional', 'dark'],
    },
    'green-gradient': {
        name: 'Green Gradient',
        css: 'linear-gradient(160deg, #0f3443 0%, #34e89e 100%)',
        themes: ['nature', 'health', 'tech'],
        mood: ['calm', 'energetic', 'bright'],
    },
    'warm-sunset': {
        name: 'Warm Sunset',
        css: 'linear-gradient(135deg, #f093fb 0%, #f5576c 50%, #fda085 100%)',
        themes: ['lifestyle', 'entertainment', 'luxury'],
        mood: ['warm', 'energetic', 'bright'],
    },
    'midnight': {
        name: 'Midnight',
        css: 'radial-gradient(ellipse at 30% 50%, #1a0a2e 0%, #0a0014 50%, #000000 100%)',
        themes: ['crime', 'dark', 'luxury', 'entertainment'],
        mood: ['dark', 'dramatic', 'mysterious'],
    },
    'cream': {
        name: 'Cream',
        css: 'linear-gradient(180deg, #fdf6e3 0%, #ede0c8 50%, #d4c5a9 100%)',
        themes: ['lifestyle', 'corporate', 'nature'],
        mood: ['warm', 'calm', 'bright'],
    },
    'grid-texture': {
        name: 'Grid Texture',
        css: 'repeating-linear-gradient(0deg, transparent, transparent 49px, rgba(255,255,255,0.03) 49px, rgba(255,255,255,0.03) 50px), repeating-linear-gradient(90deg, transparent, transparent 49px, rgba(255,255,255,0.03) 49px, rgba(255,255,255,0.03) 50px), linear-gradient(135deg, #0a0a1a 0%, #1a1a2e 100%)',
        themes: ['tech', 'corporate', 'neutral'],
        mood: ['professional', 'dark', 'cool'],
    },
    'red-dark': {
        name: 'Red Dark',
        css: 'radial-gradient(ellipse at 50% 50%, #2a0a0a 0%, #1a0505 50%, #0a0000 100%)',
        themes: ['crime', 'dark', 'entertainment', 'sport'],
        mood: ['dramatic', 'dark', 'energetic'],
    },
    'purple-haze': {
        name: 'Purple Haze',
        css: 'linear-gradient(135deg, #667eea 0%, #764ba2 50%, #3a1c71 100%)',
        themes: ['entertainment', 'tech', 'luxury'],
        mood: ['dramatic', 'cool', 'mysterious'],
    },
    'noir': {
        name: 'Noir',
        css: 'radial-gradient(ellipse at 50% 30%, #1a1a1a 0%, #0a0a0a 40%, #000000 100%)',
        themes: ['crime', 'dark', 'neutral'],
        mood: ['dark', 'dramatic', 'mysterious'],
    },
    'ocean-deep': {
        name: 'Ocean Deep',
        css: 'linear-gradient(180deg, #0c3547 0%, #0a2a3a 40%, #051a2a 100%)',
        themes: ['nature', 'tech', 'corporate'],
        mood: ['calm', 'cool', 'professional'],
    },
};

/**
 * Get backgrounds matching a theme and mood
 * @param {string} themeId - Theme identifier
 * @param {string} mood - Optional mood filter
 * @returns {Array} Matching background entries [{id, name, css}]
 */
function getMatchingBackgrounds(themeId, mood) {
    const results = [];
    for (const [id, bg] of Object.entries(BACKGROUND_LIBRARY)) {
        const themeMatch = bg.themes.includes(themeId);
        const moodMatch = !mood || bg.mood.includes(mood);
        if (themeMatch || moodMatch) {
            results.push({ id, ...bg, score: (themeMatch ? 2 : 0) + (moodMatch ? 1 : 0) });
        }
    }
    // Sort by relevance (theme match + mood match)
    results.sort((a, b) => b.score - a.score);
    return results;
}

// ============================================================
// TRANSITION LIBRARY (21 Types)
// ============================================================

/**
 * Comprehensive transition definitions with properties and SFX
 * Each transition has:
 * - id: unique identifier
 * - name: display name
 * - category: smooth | energetic | dramatic | glitchy
 * - duration: default duration in ms
 * - intensity: low | medium | high (visual impact)
 * - sfx: sound effect file name (optional)
 */
const TRANSITION_LIBRARY = {
    // SMOOTH (Cinematic, documentary)
    fade: {
        id: 'fade',
        name: 'Fade',
        category: 'smooth',
        duration: 500,
        intensity: 'low',
        sfx: null // Silent transition
    },
    dissolve: {
        id: 'dissolve',
        name: 'Dissolve',
        category: 'smooth',
        duration: 600,
        intensity: 'low',
        sfx: null
    },
    crossfade: {
        id: 'crossfade',
        name: 'Cross Fade',
        category: 'smooth',
        duration: 500,
        intensity: 'low',
        sfx: null
    },
    crossBlur: {
        id: 'crossBlur',
        name: 'Cross Blur',
        category: 'smooth',
        duration: 650,
        intensity: 'medium',
        sfx: 'whoosh-soft.mp3'
    },
    ripple: {
        id: 'ripple',
        name: 'Ripple',
        category: 'smooth',
        duration: 700,
        intensity: 'medium',
        sfx: 'water-ripple.mp3'
    },
    blur: {
        id: 'blur',
        name: 'Blur',
        category: 'smooth',
        duration: 550,
        intensity: 'low',
        sfx: null
    },
    luma: {
        id: 'luma',
        name: 'Luma Fade',
        category: 'smooth',
        duration: 600,
        intensity: 'medium',
        sfx: null
    },

    // ENERGETIC (Listicle, fast-paced)
    wipe: {
        id: 'wipe',
        name: 'Wipe',
        category: 'energetic',
        duration: 400,
        intensity: 'medium',
        sfx: 'swipe.mp3'
    },
    slide: {
        id: 'slide',
        name: 'Slide',
        category: 'energetic',
        duration: 450,
        intensity: 'medium',
        sfx: 'slide.mp3'
    },
    zoom: {
        id: 'zoom',
        name: 'Zoom',
        category: 'energetic',
        duration: 400,
        intensity: 'high',
        sfx: 'zoom-in.mp3'
    },
    push: {
        id: 'push',
        name: 'Push',
        category: 'energetic',
        duration: 450,
        intensity: 'medium',
        sfx: 'push.mp3'
    },
    swipe: {
        id: 'swipe',
        name: 'Swipe',
        category: 'energetic',
        duration: 350,
        intensity: 'high',
        sfx: 'swipe-fast.mp3'
    },

    // DRAMATIC (Crime, action, sports)
    flash: {
        id: 'flash',
        name: 'Flash',
        category: 'dramatic',
        duration: 300,
        intensity: 'high',
        sfx: 'camera-flash.mp3'
    },
    directionalBlur: {
        id: 'directionalBlur',
        name: 'Directional Blur',
        category: 'dramatic',
        duration: 500,
        intensity: 'high',
        sfx: 'whoosh-fast.mp3'
    },
    colorFade: {
        id: 'colorFade',
        name: 'Color Fade',
        category: 'dramatic',
        duration: 550,
        intensity: 'medium',
        sfx: null
    },
    spin: {
        id: 'spin',
        name: 'Spin',
        category: 'dramatic',
        duration: 600,
        intensity: 'high',
        sfx: 'spin.mp3'
    },

    // GLITCHY (Tech, cyberpunk)
    glitch: {
        id: 'glitch',
        name: 'Glitch',
        category: 'glitchy',
        duration: 400,
        intensity: 'high',
        sfx: 'glitch.mp3'
    },
    pixelate: {
        id: 'pixelate',
        name: 'Pixelate',
        category: 'glitchy',
        duration: 450,
        intensity: 'high',
        sfx: 'digital-glitch.mp3'
    },
    mosaic: {
        id: 'mosaic',
        name: 'Mosaic',
        category: 'glitchy',
        duration: 500,
        intensity: 'medium',
        sfx: 'pixelate.mp3'
    },

    // ELEGANT (Luxury, fashion)
    reveal: {
        id: 'reveal',
        name: 'Reveal',
        category: 'smooth',
        duration: 700,
        intensity: 'low',
        sfx: null
    },
    filmBurn: {
        id: 'filmBurn',
        name: 'Film Burn',
        category: 'smooth',
        duration: 600,
        intensity: 'medium',
        sfx: null
    },

    // CINEMATIC (Film-style transitions)
    cameraFlash: {
        id: 'cameraFlash',
        name: 'Camera Flash',
        category: 'dramatic',
        duration: 350,
        intensity: 'high',
        sfx: 'camera-shutter.mp3'
    },
    flare: {
        id: 'flare',
        name: 'Lens Flare',
        category: 'cinematic',
        duration: 600,
        intensity: 'medium',
        sfx: 'lens-flare.mp3'
    },
    lightLeak: {
        id: 'lightLeak',
        name: 'Light Leak',
        category: 'cinematic',
        duration: 650,
        intensity: 'medium',
        sfx: null
    },
    vignetteBlink: {
        id: 'vignetteBlink',
        name: 'Vignette Blink',
        category: 'cinematic',
        duration: 400,
        intensity: 'high',
        sfx: 'blink.mp3'
    },
    filmGrain: {
        id: 'filmGrain',
        name: 'Film Grain',
        category: 'cinematic',
        duration: 550,
        intensity: 'low',
        sfx: 'film-projector.mp3'
    },
    shadowWipe: {
        id: 'shadowWipe',
        name: 'Shadow Wipe',
        category: 'cinematic',
        duration: 500,
        intensity: 'medium',
        sfx: 'whoosh-dark.mp3'
    },
    ink: {
        id: 'ink',
        name: 'Ink Bleed',
        category: 'cinematic',
        duration: 700,
        intensity: 'medium',
        sfx: null
    },

    // DYNAMIC (Sports, action, news)
    whip: {
        id: 'whip',
        name: 'Whip Pan',
        category: 'energetic',
        duration: 300,
        intensity: 'high',
        sfx: 'whip-pan.mp3'
    },
    bounce: {
        id: 'bounce',
        name: 'Bounce',
        category: 'energetic',
        duration: 400,
        intensity: 'high',
        sfx: 'bounce.mp3'
    },
    shutterSlice: {
        id: 'shutterSlice',
        name: 'Shutter Slice',
        category: 'energetic',
        duration: 350,
        intensity: 'high',
        sfx: 'shutter.mp3'
    },
    zoomBlur: {
        id: 'zoomBlur',
        name: 'Zoom Blur',
        category: 'energetic',
        duration: 400,
        intensity: 'high',
        sfx: 'zoom-whoosh.mp3'
    },
    splitWipe: {
        id: 'splitWipe',
        name: 'Split Wipe',
        category: 'energetic',
        duration: 450,
        intensity: 'medium',
        sfx: 'swipe.mp3'
    },

    // ORGANIC (Nature, soft transitions)
    morph: {
        id: 'morph',
        name: 'Morph',
        category: 'smooth',
        duration: 800,
        intensity: 'low',
        sfx: null
    },
    dreamFade: {
        id: 'dreamFade',
        name: 'Dream Fade',
        category: 'smooth',
        duration: 750,
        intensity: 'low',
        sfx: null
    },
    prismShift: {
        id: 'prismShift',
        name: 'Prism Shift',
        category: 'cinematic',
        duration: 500,
        intensity: 'medium',
        sfx: 'prism.mp3'
    },

    // TECH / GLITCHY (Extended)
    dataMosh: {
        id: 'dataMosh',
        name: 'Data Mosh',
        category: 'glitchy',
        duration: 400,
        intensity: 'high',
        sfx: 'data-corrupt.mp3'
    },
    scanline: {
        id: 'scanline',
        name: 'Scanline',
        category: 'glitchy',
        duration: 450,
        intensity: 'medium',
        sfx: 'digital-glitch.mp3'
    },
    rgbSplit: {
        id: 'rgbSplit',
        name: 'RGB Split',
        category: 'glitchy',
        duration: 350,
        intensity: 'high',
        sfx: 'glitch.mp3'
    },
    static: {
        id: 'static',
        name: 'TV Static',
        category: 'glitchy',
        duration: 400,
        intensity: 'high',
        sfx: 'tv-static.mp3'
    }
};

/**
 * SFX file paths (relative to assets/sfx/)
 * These are downloaded/cached similar to overlays and backgrounds
 */
const TRANSITION_SFX_SOURCES = {
    'whoosh-soft.mp3': {
        keywords: ['soft whoosh transition sound', 'gentle air swoosh', 'smooth transition sfx'],
        duration: 1.0
    },
    'whoosh-fast.mp3': {
        keywords: ['fast whoosh sound effect', 'quick swoosh', 'speed transition'],
        duration: 0.5
    },
    'swipe.mp3': {
        keywords: ['swipe sound effect', 'screen swipe audio', 'transition swipe'],
        duration: 0.4
    },
    'swipe-fast.mp3': {
        keywords: ['fast swipe sound', 'quick screen transition', 'rapid swipe audio'],
        duration: 0.3
    },
    'slide.mp3': {
        keywords: ['slide transition sound', 'smooth slide audio', 'screen slide sfx'],
        duration: 0.5
    },
    'push.mp3': {
        keywords: ['push transition sound', 'impact transition', 'push sound effect'],
        duration: 0.4
    },
    'zoom-in.mp3': {
        keywords: ['zoom in sound effect', 'camera zoom audio', 'zoom transition'],
        duration: 0.4
    },
    'camera-flash.mp3': {
        keywords: ['camera flash sound', 'photo flash audio', 'flash transition sfx'],
        duration: 0.3
    },
    'glitch.mp3': {
        keywords: ['digital glitch sound', 'tech glitch audio', 'glitch transition'],
        duration: 0.4
    },
    'digital-glitch.mp3': {
        keywords: ['digital error sound', 'pixelated glitch', 'tech malfunction audio'],
        duration: 0.5
    },
    'pixelate.mp3': {
        keywords: ['pixelation sound effect', 'digital pixelate', 'mosaic transition'],
        duration: 0.5
    },
    'water-ripple.mp3': {
        keywords: ['water ripple sound', 'ripple effect audio', 'water drop ripple'],
        duration: 0.7
    },
    'spin.mp3': {
        keywords: ['spin transition sound', 'rotation audio', 'spinning whoosh'],
        duration: 0.6
    },
    'camera-shutter.mp3': {
        keywords: ['camera shutter click sound', 'DSLR shutter', 'photo snap sound effect'],
        duration: 0.4
    },
    'lens-flare.mp3': {
        keywords: ['lens flare sound effect', 'light flare audio', 'cinematic flare whoosh'],
        duration: 0.6
    },
    'blink.mp3': {
        keywords: ['eye blink sound effect', 'quick blink audio', 'fast shutter blink'],
        duration: 0.3
    },
    'film-projector.mp3': {
        keywords: ['film projector sound', 'old movie reel', 'vintage film audio'],
        duration: 0.6
    },
    'whoosh-dark.mp3': {
        keywords: ['dark whoosh sound', 'shadow sweep audio', 'heavy whoosh transition'],
        duration: 0.5
    },
    'whip-pan.mp3': {
        keywords: ['whip pan sound effect', 'fast camera pan', 'whip swish audio'],
        duration: 0.3
    },
    'bounce.mp3': {
        keywords: ['bounce sound effect', 'elastic bounce', 'pop bounce audio'],
        duration: 0.4
    },
    'shutter.mp3': {
        keywords: ['mechanical shutter sound', 'camera shutter slice', 'fast shutter audio'],
        duration: 0.3
    },
    'zoom-whoosh.mp3': {
        keywords: ['zoom whoosh sound', 'fast zoom in audio', 'speed zoom transition'],
        duration: 0.4
    },
    'prism.mp3': {
        keywords: ['prism light sound', 'crystal chime audio', 'glass prism shimmer'],
        duration: 0.5
    },
    'data-corrupt.mp3': {
        keywords: ['data corruption sound', 'digital destroy audio', 'byte error glitch'],
        duration: 0.4
    },
    'tv-static.mp3': {
        keywords: ['tv static noise', 'television static sound', 'white noise burst'],
        duration: 0.5
    }
};

// ============================================================
// DESIGN TOKENS
// ============================================================
// Normalized, reusable design tokens per theme. These unify all
// visual properties (colors, typography, MG chrome, overlays)
// into a single structured object for consistent consumption.
//
// Consumers can use getThemeTokens(themeId) instead of manually
// reading theme.colors.primary, theme.fonts.heading, etc.
//
// MG_STYLE_PRESETS replaces the duplicated MG_STYLES in app.js.

/**
 * MG style presets — visual chrome for each MG style.
 * These are style-level (not theme-level) settings that control
 * how MG chrome (backgrounds, borders, shadows, glow) is rendered.
 */
const MG_STYLE_PRESETS = {
    clean: {
        bg: 'rgba(0,0,0,0.7)',
        glow: false,
        borderRadius: 12,
        strokeWidth: 2,
        shadowStyle: 'soft',       // soft | hard | none | glow
        shadowBlur: 8,
        shadowOffsetY: 2,
        cardStyle: 'filled',       // filled | outline | glass
        lowerThirdStyle: 'bar',    // bar | box | underline | banner | glass | split
        lowerThirdAnimation: 'slideLeft', // slideLeft | wipeRight | popUp | fadeSlide
        chartBarRadius: 4,
        modifier: { saturate: 1.0, brighten: 0, tintHue: null },
    },
    bold: {
        bg: 'rgba(10,10,10,0.92)',
        glow: false,
        borderRadius: 8,
        strokeWidth: 3,
        shadowStyle: 'hard',
        shadowBlur: 12,
        shadowOffsetY: 4,
        cardStyle: 'filled',
        lowerThirdStyle: 'split',
        lowerThirdAnimation: 'popUp',
        chartBarRadius: 2,
        modifier: { saturate: 1.3, brighten: 15, tintHue: null },
    },
    minimal: {
        bg: 'rgba(0,0,0,0.35)',
        glow: false,
        borderRadius: 16,
        strokeWidth: 1,
        shadowStyle: 'none',
        shadowBlur: 4,
        shadowOffsetY: 1,
        cardStyle: 'outline',
        lowerThirdStyle: 'underline',
        lowerThirdAnimation: 'fadeSlide',
        chartBarRadius: 6,
        modifier: { saturate: 0.4, brighten: 40, tintHue: null },
    },
    neon: {
        bg: 'rgba(0,0,15,0.85)',
        glow: true,
        borderRadius: 12,
        strokeWidth: 2,
        shadowStyle: 'glow',
        shadowBlur: 30,
        shadowOffsetY: 0,
        cardStyle: 'outline',
        lowerThirdStyle: 'bar',
        lowerThirdAnimation: 'slideLeft',
        chartBarRadius: 4,
        modifier: { saturate: 1.6, brighten: 50, tintHue: null },
    },
    cinematic: {
        bg: 'rgba(0,0,0,0.92)',
        glow: false,
        borderRadius: 10,
        strokeWidth: 2,
        shadowStyle: 'hard',
        shadowBlur: 24,
        shadowOffsetY: 4,
        cardStyle: 'filled',
        lowerThirdStyle: 'banner',
        lowerThirdAnimation: 'wipeRight',
        chartBarRadius: 3,
        modifier: { saturate: 0.8, brighten: -10, tintHue: 40 },
    },
    elegant: {
        bg: 'rgba(10,0,25,0.82)',
        glow: true,
        borderRadius: 14,
        strokeWidth: 1,
        shadowStyle: 'glow',
        shadowBlur: 16,
        shadowOffsetY: 4,
        cardStyle: 'glass',
        lowerThirdStyle: 'glass',
        lowerThirdAnimation: 'fadeSlide',
        chartBarRadius: 6,
        modifier: { saturate: 1.1, brighten: 10, tintHue: 280 },
    },
};

// ── Per-theme MG overrides ──
// Allows themes sharing the same mgStyle to have distinct MG looks per category.
// E.g. crime + nature both use 'cinematic' mgStyle, but crime needs a red banner lowerThird.
// Structure: MG_THEME_OVERRIDES[themeId][mgCategory] = { style, anim, colors }
const MG_THEME_OVERRIDES = {
    tech: {
        lowerThird: { style: 'bar',       anim: 'slideLeft', colors: null },
    },
    nature: {
        lowerThird: { style: 'underline', anim: 'fadeSlide', colors: null },
    },
    crime: {
        lowerThird: { style: 'banner',    anim: 'wipeRight', colors: { bgFill: '#cc0000', textFill: '#ffffff', accentFill: '#ffffff' } },
    },
    corporate: {
        lowerThird: { style: 'box',       anim: 'slideLeft', colors: { bgFill: '#0055aa', textFill: '#ffffff', accentFill: '#00cc66' } },
    },
    luxury: {
        lowerThird: { style: 'glass',     anim: 'fadeSlide', colors: { bgFill: 'rgba(20,10,5,0.7)', textFill: '#ffffff', accentFill: '#d4af37' } },
    },
    sport: {
        lowerThird: { style: 'split',     anim: 'popUp',     colors: { bgFill: '#ff4500', textFill: '#ffffff', accentFill: '#ffd700' } },
    },
    neutral: {
        lowerThird: { style: 'bar',       anim: 'slideLeft', colors: null },
    },
};

// Backward-compatible accessor for existing code
const LOWER_THIRD_THEME_OVERRIDES = {};
for (const [themeId, cats] of Object.entries(MG_THEME_OVERRIDES)) {
    if (cats.lowerThird) LOWER_THIRD_THEME_OVERRIDES[themeId] = cats.lowerThird;
}

/**
 * Build a complete design token set for a theme.
 * Merges theme colors/fonts with MG style preset chrome.
 *
 * @param {string} themeId
 * @returns {Object} Full token set
 */
function getThemeTokens(themeId) {
    const theme = THEMES[themeId] || THEMES.neutral;
    const stylePreset = MG_STYLE_PRESETS[theme.mgStyle] || MG_STYLE_PRESETS.clean;
    const mod = stylePreset.modifier;

    return {
        // ---- Identity ----
        themeId: theme.id,
        mgStyle: theme.mgStyle,

        // ---- Colors ----
        colors: {
            // Core palette (from theme)
            primary: theme.colors.primary,
            secondary: theme.colors.secondary,
            accent: theme.colors.accent,
            textPrimary: theme.colors.text,
            textSecondary: theme.colors.shadow ? _rgbaToTextSub(theme.colors.shadow) : 'rgba(255,255,255,0.7)',
            background: theme.colors.background,
            surface: stylePreset.bg,
            stroke: theme.colors.primary,
            shadow: theme.colors.shadow,

            // Modifier-adjusted colors for MG rendering
            mgPrimary: _applyModifier(theme.colors.primary, mod),
            mgAccent: _applyModifier(theme.colors.accent, mod),
        },

        // ---- Typography ----
        typography: {
            headingFont: theme.fonts.heading,
            bodyFont: theme.fonts.body,
            captionFont: theme.fonts.body,       // caption uses body font stack
            statFont: theme.fonts.heading,       // stats use heading font (bold/display)
            headingWeight: '900',
            bodyWeight: '500',
            captionWeight: '400',
            statWeight: '900',
            emphasisWeight: '700',
        },

        // ---- MG Chrome ----
        chrome: {
            bg: stylePreset.bg,
            glow: stylePreset.glow,
            borderRadius: stylePreset.borderRadius,
            strokeWidth: stylePreset.strokeWidth,
            shadowStyle: stylePreset.shadowStyle,
            shadowBlur: stylePreset.shadowBlur,
            shadowOffsetY: stylePreset.shadowOffsetY,
            cardStyle: stylePreset.cardStyle,
            lowerThirdStyle: stylePreset.lowerThirdStyle,
            lowerThirdAnimation: stylePreset.lowerThirdAnimation || 'slideLeft',
            lowerThirdOverride: LOWER_THIRD_THEME_OVERRIDES[theme.id] || null,
            mgOverrides: MG_THEME_OVERRIDES[theme.id] || {},
            chartBarRadius: stylePreset.chartBarRadius,
        },

        // ---- Transitions ----
        transitions: {
            primary: theme.transitions.primary,
            secondary: theme.transitions.secondary,
            avoid: theme.transitions.avoid,
        },

        // ---- Overlays ----
        overlays: {
            preferred: theme.overlays.preferred,
            avoid: theme.overlays.avoid,
            effects: theme.overlays.effects,
            blendMode: theme.overlays.blendMode,
            intensityMin: theme.overlays.intensity.min,
            intensityMax: theme.overlays.intensity.max,
        },

        // ---- Background ----
        background: {
            type: theme.background,
            canvasPattern: theme.canvasBackground,
        },

        // ---- Raw modifier (for consumers that apply their own) ----
        modifier: mod,
    };
}

// Color modifier utility (same logic as app.js applyMGStyleModifier)
function _applyModifier(hexColor, mod) {
    if (!hexColor || !mod) return hexColor;
    try {
        const hsl = _hexToHSL(hexColor);
        let { h, s, l } = hsl;
        s = Math.min(100, s * (mod.saturate || 1));
        l = Math.max(5, Math.min(95, l + (mod.brighten || 0)));
        if (mod.tintHue !== null && mod.tintHue !== undefined) h = h * 0.5 + mod.tintHue * 0.5;
        return _hslToHex(h, s, l);
    } catch (e) { return hexColor; }
}

function _hexToHSL(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    const r = parseInt(hex.substring(0, 2), 16) / 255;
    const g = parseInt(hex.substring(2, 4), 16) / 255;
    const b = parseInt(hex.substring(4, 6), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
}

function _hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;
    const a = s * Math.min(l, 1 - l);
    const f = n => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
    const toH = x => Math.round(x * 255).toString(16).padStart(2, '0');
    return `#${toH(f(0))}${toH(f(8))}${toH(f(4))}`;
}

// Convert shadow RGBA to a lighter textSub color
function _rgbaToTextSub(rgba) {
    // If shadow is themed (e.g. cyan glow), derive a matching textSub
    // Otherwise use standard white semi-transparent
    return 'rgba(255,255,255,0.7)';
}

/**
 * Get all MG style preset names
 * @returns {string[]}
 */
function getMGStylePresetNames() {
    return Object.keys(MG_STYLE_PRESETS);
}

/**
 * Get a single MG style preset
 * @param {string} styleName
 * @returns {Object}
 */
function getMGStylePreset(styleName) {
    return MG_STYLE_PRESETS[styleName] || MG_STYLE_PRESETS.clean;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================

// pickThemeFromContent removed — niche detection now lives in src/niches.js
// Theme selection is driven by niche.defaultTheme or user override

/**
 * Get theme object by ID
 * @param {string} themeId - Theme identifier
 * @returns {Object} Theme object
 */
function getTheme(themeId) {
    return THEMES[themeId] || THEMES.neutral;
}

/**
 * Get all available theme IDs
 * @returns {Array<string>} Array of theme IDs
 */
function getThemeIds() {
    return Object.keys(THEMES);
}

/**
 * Get all themes (for UI dropdown)
 * @returns {Array<Object>} Array of theme objects with id, name, description
 */
function getAllThemes() {
    return Object.values(THEMES).map(t => ({
        id: t.id,
        name: t.name,
        description: t.description
    }));
}

/**
 * Get background source info for a theme
 * @param {string} themeId - Theme identifier
 * @returns {Object} Background source info
 */
function getBackgroundSource(themeId) {
    const theme = getTheme(themeId);
    return BACKGROUND_SOURCES[theme.background] || BACKGROUND_SOURCES.neutral;
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    THEMES,
    BACKGROUND_SOURCES,
    BACKGROUND_LIBRARY,
    TRANSITION_LIBRARY,
    TRANSITION_SFX_SOURCES,
    MG_STYLE_PRESETS,
    MG_THEME_OVERRIDES,
    LOWER_THIRD_THEME_OVERRIDES,
    getTheme,
    getThemeIds,
    getAllThemes,
    getBackgroundSource,
    getMatchingBackgrounds,
    getThemeTokens,
    getMGStylePreset,
    getMGStylePresetNames,
};
