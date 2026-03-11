/**
 * Unified Theme System
 *
 * VidRush-inspired theming where ONE theme controls:
 * - Background canvas (subtle texture video behind all footage)
 * - Motion graphics style (clean, bold, neon, etc.)
 * - Color palette (primary, secondary, accent, text)
 * - Font families (heading, body)
 *
 * AI Director picks the best theme based on video content.
 * User can override via settings.
 */

// ============================================================
// THEME DEFINITIONS
// ============================================================

const THEMES = {
    tech: {
        id: 'tech',
        name: 'Tech/Cyberpunk',
        description: 'Futuristic, digital, high-tech content',

        // Background canvas (video texture behind all footage)
        background: 'tech-grid',
        canvasBackground: 'matrixDots',

        // Motion graphics style
        mgStyle: 'neon',

        // Allowed MG types for this niche
        allowedMGs: ['kineticText', 'statCounter', 'barChart', 'focusWord', 'animatedIcons', 'progressBar', 'headline', 'comparisonCard'],

        // Color palette
        colors: {
            primary: '#00ffff',      // Neon cyan
            secondary: '#ff00ff',    // Neon magenta
            accent: '#00ff00',       // Neon green
            text: '#ffffff',         // White text

            background: '#0a0a0a',   // Near black
            shadow: 'rgba(0, 255, 255, 0.5)'
        },

        // Font families
        fonts: {
            heading: 'Orbitron, Electrolize, "Courier New", monospace',
            body: '"Roboto Mono", "Source Code Pro", monospace'
        },

        // Preferred transitions for this theme
        transitions: {
            primary: ['glitch', 'pixelate', 'flash', 'rgbSplit', 'dataMosh', 'scanline'],
            secondary: ['wipe', 'slide', 'zoom', 'static', 'crossBlur'],
            avoid: ['ripple', 'dissolve', 'dreamFade', 'ink']
        },

        // Preferred overlays for this theme (matched against filenames in assets/overlays/)
        overlays: {
            preferred: ['crt', 'vhs', 'scanline', 'digital', 'glitch', 'static', 'grain'],
            avoid: ['paper', 'film', 'vintage'],
            effects: ['grain', 'chromatic'],
            blendMode: 'screen',
            intensity: { min: 0.2, max: 0.5 }
        },

        // Keywords that match this theme
        keywords: ['tech', 'ai', 'cyber', 'hack', 'digital', 'code', 'robot', 'future', 'virtual', 'computer', 'software', 'data']
    },

    nature: {
        id: 'nature',
        name: 'Nature Documentary',
        description: 'Natural, organic, wildlife, environment',

        background: 'nature',
        canvasBackground: 'organicNoise',
        mgStyle: 'cinematic',

        allowedMGs: ['headline', 'lowerThird', 'callout', 'mapChart', 'timeline', 'focusWord', 'bulletList', 'statCounter'],

        colors: {
            primary: '#8B4513',      // Earth brown
            secondary: '#228B22',    // Forest green
            accent: '#87CEEB',       // Sky blue
            text: '#FFFFFF',         // White text
            background: '#1a1a1a',   // Dark background
            shadow: 'rgba(0, 0, 0, 0.6)'
        },

        fonts: {
            heading: '"Libre Baskerville", Merriweather, Georgia, serif',
            body: 'Lora, "Open Sans", Georgia, sans-serif'
        },

        // Preferred transitions for this theme
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
        },

        keywords: ['nature', 'wildlife', 'animal', 'environment', 'climate', 'earth', 'ocean', 'forest', 'plant', 'bird', 'ecosystem', 'conservation']
    },

    crime: {
        id: 'crime',
        name: 'True Crime/Dark',
        description: 'Crime, mystery, thriller, dark content',

        background: 'dark',
        canvasBackground: 'vignette',
        mgStyle: 'cinematic',

        allowedMGs: ['headline', 'lowerThird', 'callout', 'timeline', 'articleHighlight', 'focusWord', 'mapChart', 'kineticText'],

        colors: {
            primary: '#dc143c',      // Crime red
            secondary: '#1a1a1a',    // Dark gray
            accent: '#ffd700',       // Gold (evidence tag)
            text: '#FFFFFF',         // White text
            background: '#000000',   // Pure black
            shadow: 'rgba(220, 20, 60, 0.4)'
        },

        fonts: {
            heading: 'Oswald, "Bebas Neue", Impact, sans-serif',
            body: '"Barlow Condensed", Lato, Arial, sans-serif'
        },

        // Preferred transitions for this theme
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
        },

        keywords: ['crime', 'murder', 'investigation', 'detective', 'mystery', 'thriller', 'police', 'fbi', 'criminal', 'suspect', 'evidence', 'court']
    },

    corporate: {
        id: 'corporate',
        name: 'Corporate/Professional',
        description: 'Business, professional, educational content',

        background: 'light',
        canvasBackground: 'gridLines',
        mgStyle: 'clean',

        allowedMGs: ['barChart', 'donutChart', 'timeline', 'statCounter', 'bulletList', 'comparisonCard', 'lowerThird', 'progressBar', 'headline', 'articleHighlight'],

        colors: {
            primary: '#0066cc',      // Corporate blue
            secondary: '#333333',    // Dark gray
            accent: '#00cc66',       // Success green
            text: '#FFFFFF',         // White text
            background: '#f5f5f5',   // Light gray
            shadow: 'rgba(0, 0, 0, 0.3)'
        },

        fonts: {
            heading: 'Montserrat, "Work Sans", Arial, sans-serif',
            body: '"Source Sans Pro", "Open Sans", "Segoe UI", sans-serif'
        },

        // Preferred transitions for this theme
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
        },

        keywords: ['business', 'corporate', 'professional', 'company', 'startup', 'market', 'finance', 'economy', 'education', 'study', 'academic', 'research']
    },

    luxury: {
        id: 'luxury',
        name: 'Luxury/Fashion',
        description: 'High-end, elegant, fashion, lifestyle',

        background: 'warm',
        canvasBackground: 'softGlow',
        mgStyle: 'elegant',

        allowedMGs: ['headline', 'lowerThird', 'focusWord', 'kineticText', 'callout', 'statCounter', 'donutChart', 'rankingList'],

        colors: {
            primary: '#d4af37',      // Gold
            secondary: '#1a1a1a',    // Black
            accent: '#c0c0c0',       // Silver
            text: '#FFFFFF',         // White text
            background: '#0a0a0a',   // Near black
            shadow: 'rgba(212, 175, 55, 0.4)'
        },

        fonts: {
            heading: '"Playfair Display", Cinzel, Georgia, serif',
            body: 'Lora, "Libre Baskerville", "Times New Roman", serif'
        },

        // Preferred transitions for this theme
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
        },

        keywords: ['luxury', 'fashion', 'beauty', 'style', 'elegant', 'premium', 'designer', 'haute', 'couture', 'wedding', 'jewelry', 'art']
    },

    sport: {
        id: 'sport',
        name: 'Sports/Action',
        description: 'Sports, action, high-energy content',

        background: 'dark',
        canvasBackground: 'energyBurst',
        mgStyle: 'bold',

        allowedMGs: ['statCounter', 'rankingList', 'comparisonCard', 'headline', 'focusWord', 'kineticText', 'progressBar', 'barChart', 'lowerThird'],

        colors: {
            primary: '#ff4500',      // Orange red
            secondary: '#ffd700',    // Gold
            accent: '#00ff00',       // Energy green
            text: '#FFFFFF',         // White text
            background: '#0a0a0a',   // Near black
            shadow: 'rgba(255, 69, 0, 0.5)'
        },

        fonts: {
            heading: '"Bebas Neue", "Fjalla One", Impact, sans-serif',
            body: '"Roboto Condensed", "Barlow Condensed", Arial, sans-serif'
        },

        // Preferred transitions for this theme
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
        },

        keywords: ['sport', 'game', 'team', 'player', 'athlete', 'competition', 'championship', 'match', 'race', 'fight', 'extreme', 'action']
    },

    neutral: {
        id: 'neutral',
        name: 'Neutral/Balanced',
        description: 'General-purpose, balanced, versatile',

        background: 'neutral',
        canvasBackground: 'subtleGrain',
        mgStyle: 'clean',

        allowedMGs: ['headline', 'lowerThird', 'statCounter', 'callout', 'bulletList', 'focusWord', 'progressBar', 'barChart', 'donutChart', 'comparisonCard', 'timeline', 'rankingList', 'kineticText', 'mapChart', 'articleHighlight', 'animatedIcons'],

        colors: {
            primary: '#4a90e2',      // Soft blue
            secondary: '#2c3e50',    // Dark slate
            accent: '#e74c3c',       // Soft red
            text: '#FFFFFF',         // White text
            background: '#1a1a1a',   // Dark background
            shadow: 'rgba(0, 0, 0, 0.5)'
        },

        fonts: {
            heading: 'Nunito, Raleway, Arial, sans-serif',
            body: '"Open Sans", Roboto, Arial, sans-serif'
        },

        // Preferred transitions for this theme
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
        },

        keywords: [] // Fallback theme
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
// HELPER FUNCTIONS
// ============================================================

/**
 * Pick the best theme based on video content analysis
 * @param {Object} scriptContext - AI Director's analysis (summary, tone, mood, entities)
 * @returns {string} Theme ID
 */
function pickThemeFromContent(scriptContext) {
    if (!scriptContext || !scriptContext.summary) {
        return 'neutral'; // Fallback
    }

    const text = (
        scriptContext.summary + ' ' +
        (scriptContext.tone || '') + ' ' +
        (scriptContext.mood || '') + ' ' +
        (scriptContext.entities || []).join(' ')
    ).toLowerCase();

    // Score each theme based on keyword matches
    const scores = {};
    for (const [themeId, theme] of Object.entries(THEMES)) {
        if (themeId === 'neutral') continue; // Skip neutral in scoring

        let score = 0;
        for (const keyword of theme.keywords) {
            if (text.includes(keyword)) {
                score += 1;
            }
        }
        scores[themeId] = score;
    }

    // Find highest scoring theme
    let bestTheme = 'neutral';
    let bestScore = 0;
    for (const [themeId, score] of Object.entries(scores)) {
        if (score > bestScore) {
            bestScore = score;
            bestTheme = themeId;
        }
    }

    return bestTheme;
}

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
    pickThemeFromContent,
    getTheme,
    getThemeIds,
    getAllThemes,
    getBackgroundSource,
    getMatchingBackgrounds
};
