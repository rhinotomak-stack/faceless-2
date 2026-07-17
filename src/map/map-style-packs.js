// ══════════════════════════════════════════════════════════════════
// Map Style Packs — orthogonal visual overlay styles for the map MG
//
// A pack defines how the map OVERLAY looks (polygon fills, country
// outlines, route lines, pins, labels, basemap filter). It is
// independent of `mapStyle` which picks the underlying TILE basemap
// (dark / satellite / light / political / natural).
//
// Any tile basemap can combine with any pack. A pack can *prefer* a
// basemap (e.g. invasions prefers satellite), which the picker honors
// when the UI selection is "auto", but the user can override at any
// time by picking both independently in the build settings.
//
// Slot reference:
//   polygon    — country/region polygon fill + stroke + optional glow
//   route      — dashed path between waypoints
//   pin        — location marker dot/ring
//   label      — place name chip (bg, fg, stroke, font)
//   basemap    — optional canvas-filter applied to the tile image
//                (desaturate 0..1, darken 0..1, contrast +/-)
//   preferredMapStyle — hint for `mapStyle=auto` picks
//   extraDetail       — when true, stitcher requests z+1 tiles for
//                       sharper wide shots (≈4× tile count).
//
// The 4 packs mirror the references the user shared:
//   neon         — existing look (preserved byte-for-byte when chosen)
//   invasions    — red-vs-blue bold combat style, white outlines,
//                  white labels, grayscale satellite basemap
//   editorial    — warm orange/red gradient fills, thick black
//                  country outlines, black serif label pills
//   geopolitical — solid subject colors on a political basemap,
//                  thin black strokes, small serif labels
// ══════════════════════════════════════════════════════════════════

const PACKS = {
    // ── NEON (existing look — default; do not change colors here) ──
    // Leaves all slots empty so the renderer falls through to its
    // built-in mapStyle-keyed palette. This is the "classic" pack.
    neon: {
        id: 'neon',
        name: 'Neon',
        description: 'Cyan/green/gold neon overlays (the existing look)',
        preferredMapStyle: null,          // any basemap works
        extraDetail: false,
        basemap: {},
        polygon: {},                       // fallthrough
        route:   {},
        pin:     {},
        label:   {},
    },

    // ── INVASIONS (red aggressor, blue target, white outlines) ──
    invasions: {
        id: 'invasions',
        name: 'Invasions',
        description: 'Bold combat style — red vs blue country fills, white outlines, grayscale satellite basemap',
        preferredMapStyle: 'satellite',
        extraDetail: true,
        basemap: {
            desaturate: 0.85,              // near-grayscale
            darken: 0.15,
            contrast: 1.12,
        },
        polygon: {
            // Primary subject = aggressor red. Secondary = target blue.
            // Renderer picks per-subject role.
            fill:       '#c81f24',
            fillEdge:   '#7a0f12',
            stroke:     '#ffffff',
            strokeWidth: 3.5,
            glow:       'rgba(255,255,255,0.35)',
            // role-based variants (renderer picks by subject.role)
            roles: {
                primary:   { fill: '#c81f24', fillEdge: '#7a0f12', stroke: '#ffffff', glow: 'rgba(200,30,36,0.55)' },
                secondary: { fill: '#1e6fd9', fillEdge: '#0c3a78', stroke: '#ffffff', glow: 'rgba(30,111,217,0.55)' },
                tertiary:  { fill: '#d9a21e', fillEdge: '#7a5a0c', stroke: '#ffffff', glow: 'rgba(217,162,30,0.45)' },
            },
        },
        route: {
            color:     '#ffffff',
            glowColor: 'rgba(255,255,255,0.35)',
            dash:      [14, 6],
            width:     4,
            head:      'arrow',
        },
        pin: {
            color:     '#c81f24',
            glowColor: 'rgba(200,30,36,0.45)',
            ringColor: '#ffffff',
        },
        label: {
            bg:          'rgba(0,0,0,0)',     // no bg, stroked text
            fg:          '#ffffff',
            strokeColor: 'rgba(0,0,0,0.85)',
            strokeWidth: 4,
            font:        "700 28px 'Inter', 'Arial Black', sans-serif",
            letterSpacing: 2,
            uppercase:   true,
            paddingX:    0,
            paddingY:    0,
            cornerRadius: 0,
        },
        title: {
            bg:     'rgba(0,0,0,0.78)',
            border: '#ffffff',
            text:   '#ffffff',
        },
    },

    // ── EDITORIAL (orange-red gradient, black outlines, label pills) ──
    editorial: {
        id: 'editorial',
        name: 'Editorial',
        description: 'Warm orange/red gradient fills, thick black country outlines, dark label pills',
        preferredMapStyle: 'natural',
        extraDetail: true,
        basemap: {
            desaturate: 0.15,
            darken: 0.05,
            contrast: 1.05,
        },
        polygon: {
            fill:       '#e04a1a',
            fillEdge:   '#6b1608',
            fillGradient: true,               // renderer paints radial fill→edge
            stroke:     '#0a0a0a',
            strokeWidth: 4,
            glow:       'rgba(224,74,26,0.35)',
            roles: {
                primary:   { fill: '#e04a1a', fillEdge: '#6b1608', stroke: '#0a0a0a', glow: 'rgba(224,74,26,0.4)' },
                secondary: { fill: '#c03020', fillEdge: '#5a140a', stroke: '#0a0a0a', glow: 'rgba(192,48,32,0.35)' },
                tertiary:  { fill: '#8f4015', fillEdge: '#3a1808', stroke: '#0a0a0a', glow: 'rgba(143,64,21,0.3)' },
            },
        },
        route: {
            color:     '#0a0a0a',
            glowColor: 'rgba(224,74,26,0.35)',
            dash:      [],                    // solid
            width:     5,
            head:      'arrow',
            headColor: '#c81f24',
        },
        pin: {
            color:     '#c81f24',
            glowColor: 'rgba(200,30,36,0.4)',
            ringColor: '#0a0a0a',
            shape:     'teardrop',
        },
        label: {
            bg:          'rgba(10,10,10,0.94)',
            fg:          '#ffffff',
            strokeColor: null,
            strokeWidth: 0,
            font:        "700 24px Georgia, 'Times New Roman', serif",
            letterSpacing: 0,
            uppercase:   false,
            paddingX:    12,
            paddingY:    6,
            cornerRadius: 2,
        },
        title: {
            bg:     'rgba(10,10,10,0.9)',
            border: '#c81f24',
            text:   '#ffffff',
        },
    },

    // ── GEOPOLITICAL (solid color-coded countries, thin strokes) ──
    geopolitical: {
        id: 'geopolitical',
        name: 'Geopolitical',
        description: 'Solid subject-color country fills over political basemap, thin black strokes, small serif labels',
        preferredMapStyle: 'political',
        extraDetail: false,
        basemap: {
            desaturate: 0.0,
            darken: 0.0,
            contrast: 1.0,
        },
        polygon: {
            fill:       '#d62828',
            fillEdge:   '#a01818',
            fillGradient: false,              // flat solid
            stroke:     '#0a0a0a',
            strokeWidth: 2,
            glow:       'rgba(0,0,0,0)',      // no glow
            roles: {
                primary:   { fill: '#d62828', fillEdge: '#a01818', stroke: '#0a0a0a', glow: 'rgba(0,0,0,0)' },
                secondary: { fill: '#4a90d9', fillEdge: '#2060a8', stroke: '#0a0a0a', glow: 'rgba(0,0,0,0)' },
                tertiary:  { fill: '#f0a830', fillEdge: '#b07818', stroke: '#0a0a0a', glow: 'rgba(0,0,0,0)' },
            },
        },
        route: {
            color:     '#0a0a0a',
            glowColor: 'rgba(0,0,0,0.2)',
            dash:      [10, 5],
            width:     2.5,
            head:      'dot',
        },
        pin: {
            color:     '#d62828',
            glowColor: 'rgba(214,40,40,0.3)',
            ringColor: '#0a0a0a',
        },
        label: {
            bg:          'rgba(255,248,235,0.88)',
            fg:          '#1c1008',
            strokeColor: null,
            strokeWidth: 0,
            font:        "600 18px Georgia, 'Times New Roman', serif",
            letterSpacing: 0,
            uppercase:   false,
            paddingX:    8,
            paddingY:    3,
            cornerRadius: 3,
        },
        title: {
            bg:     'rgba(255,248,235,0.92)',
            border: '#8b4513',
            text:   '#1c1008',
        },
    },
};

const DEFAULT_PACK_ID = 'neon';

function listPacks() {
    return Object.values(PACKS).map(p => ({
        id: p.id,
        name: p.name,
        description: p.description,
        preferredMapStyle: p.preferredMapStyle,
    }));
}

function getPack(packId) {
    if (!packId || typeof packId !== 'string') return PACKS[DEFAULT_PACK_ID];
    return PACKS[packId.trim().toLowerCase()] || PACKS[DEFAULT_PACK_ID];
}

/**
 * Pick a pack for a build.
 * Precedence: explicit UI selection > niche preference > theme preference > default.
 * `auto` or missing falls through to theme/niche hints or DEFAULT_PACK_ID.
 */
function pickPack({ uiChoice, nicheId, themeId } = {}) {
    const raw = String(uiChoice || 'auto').trim().toLowerCase();
    if (raw && raw !== 'auto' && PACKS[raw]) return PACKS[raw];

    // Niche-driven defaults (keep minimal — users can always override)
    const nichePrefs = {
        'news.military':      'invasions',
        'news.politics':      'invasions',
        'explainer.military': 'invasions',
        'explainer.history':  'editorial',
        'explainer.crime':    'editorial',
    };
    if (nicheId && nichePrefs[nicheId]) return PACKS[nichePrefs[nicheId]];

    // Theme fallback
    const themePrefs = {
        crime:    'editorial',
        history:  'editorial',
        modern:   'neon',
        minimal:  'geopolitical',
        standard: 'neon',
    };
    if (themeId && themePrefs[themeId]) return PACKS[themePrefs[themeId]];

    return PACKS[DEFAULT_PACK_ID];
}

const api = { PACKS, DEFAULT_PACK_ID, listPacks, getPack, pickPack };

if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
}
if (typeof window !== 'undefined') {
    window.MAP_STYLE_PACKS = api;
}
