/**
 * design-intelligence.js — pure, dependency-free color & typography math.
 *
 * Clean-room JS reimplementation of the design-intelligence ideas surveyed in
 * OPENMONTAGE-BORROW-PLAN.md item #5 (technique + WCAG constants only — no code
 * copied). Everything here is deterministic and side-effect-free so it can be
 * used by hf-design-doc (shape the author's palette), hf-visual-lint, themes.js,
 * and the perfectionist reviewer without any AI call.
 *
 * The load-bearing gap this closes: we had NO real WCAG contrast math anywhere,
 * so light-on-light / low-contrast text could ship. `hf-design-doc.js:_lum` was
 * a *perceptual* average (0.299/0.587/0.114), which is fine for a rough
 * light/dark split but is NOT the sRGB-linearized relative luminance WCAG needs.
 */
'use strict';

// ── Parsing ──────────────────────────────────────────────────────────────
function hexToRgb(hex) {
    let s = String(hex || '').trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(s)) return null;
    const n = parseInt(s, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// Parse hex OR rgb()/rgba() into {r,g,b,a}. Returns null for anything else
// (named colors, gradients, currentColor) so callers can skip rather than
// compute a bogus ratio. Theme tokens are frequently rgba() panels.
function parseColor(str) {
    const s = String(str || '').trim();
    const hex = hexToRgb(s);
    if (hex) return { ...hex, a: 1 };
    const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i);
    if (m) {
        return {
            r: Math.max(0, Math.min(255, Number(m[1]))),
            g: Math.max(0, Math.min(255, Number(m[2]))),
            b: Math.max(0, Math.min(255, Number(m[3]))),
            a: m[4] != null ? Math.max(0, Math.min(1, Number(m[4]))) : 1,
        };
    }
    return null;
}

// Composite a (possibly translucent) color over an opaque backdrop → opaque rgb.
function flatten(color, backdropHex = '#000000') {
    const c = parseColor(color);
    if (!c) return null;
    if (c.a >= 1) return { r: c.r, g: c.g, b: c.b };
    const bg = parseColor(backdropHex) || { r: 0, g: 0, b: 0 };
    return {
        r: c.r * c.a + bg.r * (1 - c.a),
        g: c.g * c.a + bg.g * (1 - c.a),
        b: c.b * c.a + bg.b * (1 - c.a),
    };
}

function rgbToHex(r, g, b) {
    const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
    return '#' + [r, g, b].map((v) => clamp(v).toString(16).padStart(2, '0')).join('');
}

// ── WCAG 2.1 luminance + contrast ────────────────────────────────────────
// Per spec: linearize each sRGB channel, then L = 0.2126 R + 0.7152 G + 0.0722 B.
function _channelLinear(c8) {
    const c = c8 / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// Accepts a hex/rgb/rgba string OR a pre-flattened {r,g,b}. Returns null when
// the color can't be parsed so contrast callers can skip it. Alpha is ignored
// here (translucent colors should be flattened by the caller first).
function relativeLuminance(color) {
    const rgb = (color && typeof color === 'object' && 'r' in color) ? color : parseColor(color);
    if (!rgb) return null;
    return 0.2126 * _channelLinear(rgb.r) + 0.7152 * _channelLinear(rgb.g) + 0.0722 * _channelLinear(rgb.b);
}

/** WCAG contrast ratio (1..21), or null if either color is unparseable. */
function contrastRatio(fg, bg) {
    const l1 = relativeLuminance(fg);
    const l2 = relativeLuminance(bg);
    if (l1 == null || l2 == null) return null;
    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);
    return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Validate a foreground/background pair against WCAG AA/AAA.
 * largeText = ≥24px (or ≥18.66px bold) → relaxed thresholds (3:1 AA / 4.5:1 AAA).
 * Unparseable input → { unknown:true, passes:true } so it never emits a false warning.
 */
function validateContrast(fg, bg, { largeText = false } = {}) {
    const ratio = contrastRatio(fg, bg);
    if (ratio == null) return { ratio: null, AA: true, AAA: true, passes: true, unknown: true, largeText };
    const round = Math.round(ratio * 100) / 100;
    const AA = largeText ? ratio >= 3 : ratio >= 4.5;
    const AAA = largeText ? ratio >= 4.5 : ratio >= 7;
    return { ratio: round, AA, AAA, passes: AA, largeText };
}

/** Given a background, pick whichever candidate reads best (default black/white). */
function pickReadableText(bg, candidates = ['#000000', '#ffffff']) {
    let best = candidates[0];
    let bestRatio = -1;
    for (const c of candidates) {
        const r = contrastRatio(c, bg);
        if (r != null && r > bestRatio) { bestRatio = r; best = c; }
    }
    return { color: best, ratio: bestRatio < 0 ? null : Math.round(bestRatio * 100) / 100 };
}

// ── Typography: modular scale ────────────────────────────────────────────
// ratio: 1.2 minor-third, 1.25 major-third, 1.333 perfect-fourth, 1.5 fifth…
function computeTypeScale(base = 32, ratio = 1.25, { up = 3, down = 2 } = {}) {
    const scale = {};
    for (let i = -down; i <= up; i++) scale[i] = Math.round(base * Math.pow(ratio, i) * 100) / 100;
    return scale;
}

// ── Color harmony (HSL) ──────────────────────────────────────────────────
function rgbToHsl(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return null;
    const r = rgb.r / 255, g = rgb.g / 255, b = rgb.b / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2;
    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h /= 6;
    }
    return { h: h * 360, s: s * 100, l: l * 100 };
}

function hslToHex(h, s, l) {
    h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(100, s)) / 100; l = Math.max(0, Math.min(100, l)) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/** Derive an accent set from a base color. scheme: complementary|analogous|triadic. */
function generateHarmony(baseHex, scheme = 'complementary') {
    const hsl = rgbToHsl(baseHex);
    if (!hsl) return [];
    const at = (deg) => hslToHex(hsl.h + deg, hsl.s, hsl.l);
    switch (scheme) {
        case 'analogous':     return [at(-30), baseHex, at(30)];
        case 'triadic':       return [baseHex, at(120), at(240)];
        case 'complementary':
        default:              return [baseHex, at(180)];
    }
}

module.exports = {
    hexToRgb,
    parseColor,
    flatten,
    rgbToHex,
    relativeLuminance,
    contrastRatio,
    validateContrast,
    pickReadableText,
    computeTypeScale,
    rgbToHsl,
    hslToHex,
    generateHarmony,
};
