'use strict';

/**
 * Shared MG style utilities — used by both MotionGraphics.jsx (Remotion)
 * and canvas-mg-renderer.js (FFmpeg pipeline).
 *
 * Contains: color palettes, theme integration, position presets,
 * shadow helpers, and data parsers. NO React dependencies.
 */

// ========================================
// STYLE THEMES — color palettes per visual tone
// ========================================
const STYLES = {
    clean:    { primary: '#3b82f6', accent: '#f59e0b', bg: 'rgba(0,0,0,0.7)',    text: '#ffffff', textSub: 'rgba(255,255,255,0.75)', glow: false },
    bold:     { primary: '#ef4444', accent: '#fbbf24', bg: 'rgba(10,10,10,0.92)', text: '#ffffff', textSub: 'rgba(255,255,255,0.85)', glow: false },
    minimal:  { primary: '#e5e7eb', accent: '#94a3b8', bg: 'rgba(0,0,0,0.35)',    text: '#f8fafc', textSub: 'rgba(255,255,255,0.5)',  glow: false },
    neon:     { primary: '#00ff88', accent: '#ff00ff', bg: 'rgba(0,0,15,0.85)',   text: '#ffffff', textSub: 'rgba(255,255,255,0.7)',  glow: true  },
    cinematic:{ primary: '#d4af37', accent: '#c0c0c0', bg: 'rgba(0,0,0,0.92)',    text: '#f5f0e8', textSub: 'rgba(245,240,232,0.55)', glow: false },
    elegant:  { primary: '#8b5cf6', accent: '#f472b6', bg: 'rgba(10,0,25,0.82)',  text: '#ffffff', textSub: 'rgba(255,255,255,0.6)',  glow: true  },
};

// Style modifiers — each style transforms colors differently
const STYLE_MODIFIERS = {
    clean:     { bgOpacity: 0.7,  glow: false, saturate: 1.0, brighten: 0,   tintHue: null },
    bold:      { bgOpacity: 0.92, glow: false, saturate: 1.3, brighten: 15,  tintHue: null },
    minimal:   { bgOpacity: 0.35, glow: false, saturate: 0.4, brighten: 40,  tintHue: null },
    neon:      { bgOpacity: 0.85, glow: true,  saturate: 1.6, brighten: 50,  tintHue: null },
    cinematic: { bgOpacity: 0.92, glow: false, saturate: 0.8, brighten: -10, tintHue: 40  },
    elegant:   { bgOpacity: 0.82, glow: true,  saturate: 1.1, brighten: 10,  tintHue: 280 },
};

// ========================================
// Color conversion utilities
// ========================================
function hexToHSL(hex) {
    hex = hex.replace('#', '');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    const r = parseInt(hex.substring(0,2), 16) / 255;
    const g = parseInt(hex.substring(2,4), 16) / 255;
    const b = parseInt(hex.substring(4,6), 16) / 255;
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    let h = 0, s = 0, l = (max+min)/2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = ((g-b)/d + (g<b?6:0)) / 6;
        else if (max === g) h = ((b-r)/d + 2) / 6;
        else h = ((r-g)/d + 4) / 6;
    }
    return { h: h*360, s: s*100, l: l*100 };
}

function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360;
    s = Math.max(0, Math.min(100, s)) / 100;
    l = Math.max(0, Math.min(100, l)) / 100;
    const a = s * Math.min(l, 1-l);
    const f = n => { const k = (n + h/30) % 12; return l - a * Math.max(-1, Math.min(k-3, 9-k, 1)); };
    const toHex = x => Math.round(x*255).toString(16).padStart(2,'0');
    return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function applyStyleModifier(color, mod) {
    try {
        const hsl = hexToHSL(color);
        let { h, s, l } = hsl;
        s = Math.min(100, s * mod.saturate);
        l = Math.max(5, Math.min(95, l + mod.brighten));
        if (mod.tintHue !== null) h = h * 0.5 + mod.tintHue * 0.5;
        return hslToHex(h, s, l);
    } catch { return color; }
}

// ========================================
// Theme-aware style resolver
// ========================================
let THEMES_MODULE = null;
try {
    THEMES_MODULE = require('./themes.js');
} catch (e) {
    // themes.js not available (e.g. in Remotion bundle context)
}

/**
 * Get theme-aware style (colors + fonts).
 * MG style modifies how theme colors are displayed (saturation, glow, bg opacity).
 */
function getStyle(mg, scriptContext) {
    const styleName = mg.style || 'clean';
    const baseStyle = STYLES[styleName] || STYLES.clean;
    const mod = STYLE_MODIFIERS[styleName] || STYLE_MODIFIERS.clean;

    if (!scriptContext || !scriptContext.themeId || !THEMES_MODULE || !THEMES_MODULE.getTheme) {
        return { ...baseStyle, fontHeading: 'Arial, sans-serif', fontBody: 'Arial, sans-serif' };
    }

    try {
        const theme = THEMES_MODULE.getTheme(scriptContext.themeId);
        const themePrimary = theme.colors.primary || baseStyle.primary;
        const themeAccent = theme.colors.accent || baseStyle.accent;
        const primary = applyStyleModifier(themePrimary, mod);
        const accent = applyStyleModifier(themeAccent, mod);
        const bgBase = styleName === 'neon' ? '0,0,15' : styleName === 'elegant' ? '10,0,25' : '0,0,0';

        return {
            primary, accent,
            bg: `rgba(${bgBase},${mod.bgOpacity})`,
            text: baseStyle.text,
            textSub: baseStyle.textSub,
            glow: mod.glow,
            fontHeading: theme.fonts.heading || 'Arial, sans-serif',
            fontBody: theme.fonts.body || 'Arial, sans-serif',
        };
    } catch (err) {
        return { ...baseStyle, fontHeading: 'Arial, sans-serif', fontBody: 'Arial, sans-serif' };
    }
}

function makeShadow(s, strong) {
    if (s.glow) {
        return strong
            ? `0 0 30px ${s.primary}90, 0 0 60px ${s.primary}40, 0 2px 12px rgba(0,0,0,0.9)`
            : `0 0 20px ${s.primary}60, 0 0 40px ${s.primary}25, 0 2px 8px rgba(0,0,0,0.7)`;
    }
    return strong
        ? '0 4px 24px rgba(0,0,0,0.85), 0 2px 8px rgba(0,0,0,0.5)'
        : '0 2px 12px rgba(0,0,0,0.7), 0 1px 4px rgba(0,0,0,0.4)';
}

// ========================================
// Position presets (1920x1080)
// ========================================
const POSITIONS = {
    'center':       { justifyContent: 'center', alignItems: 'center' },
    'bottom-left':  { justifyContent: 'flex-end', alignItems: 'flex-start', padding: '0 0 120px 60px' },
    'bottom-right': { justifyContent: 'flex-end', alignItems: 'flex-end', padding: '0 60px 120px 0' },
    'top':          { justifyContent: 'flex-start', alignItems: 'center', paddingTop: 80 },
    'center-left':  { justifyContent: 'center', alignItems: 'flex-start', paddingLeft: 80 },
};

// ========================================
// Data parser for chart/ranking/timeline types
// ========================================
function parseKeyValuePairs(subtext) {
    if (!subtext || subtext === 'none') return [];
    const raw = subtext.split(',').map(s => s.trim()).filter(Boolean);
    const results = [];
    for (const part of raw) {
        const colonIdx = part.indexOf(':');
        if (colonIdx !== -1) {
            results.push({ label: part.substring(0, colonIdx).trim(), value: part.substring(colonIdx + 1).trim() });
        } else if (results.length > 0 && /^\d+$/.test(part.trim())) {
            results[results.length - 1].value += ',' + part.trim();
        } else if (part.trim()) {
            results.push({ label: part.trim(), value: '0' });
        }
    }
    return results;
}

// ========================================
// Fullscreen MG backgrounds (radial gradients)
// ========================================
const MG_BACKGROUNDS = {
    clean:     ['#0a0a2e', '#000000'],
    bold:      ['#1a0000', '#0a0a0a'],
    minimal:   ['#1a1a2e', '#0f0f0f'],
    neon:      ['#000020', '#000008'],
    cinematic: ['#1a1500', '#000000'],
    elegant:   ['#0a0020', '#050010'],
};

// ========================================
// EXPORTS
// ========================================
module.exports = {
    STYLES,
    STYLE_MODIFIERS,
    hexToHSL,
    hslToHex,
    applyStyleModifier,
    getStyle,
    makeShadow,
    POSITIONS,
    parseKeyValuePairs,
    MG_BACKGROUNDS,
};
