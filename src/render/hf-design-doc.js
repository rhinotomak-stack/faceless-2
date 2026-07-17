/**
 * hf-design-doc.js — Generate the DESIGN block for the composition author.
 *
 * The author skill (skills/hyperframes-template/SKILL.md) requires every
 * composition to trace its palette/typography to a DESIGN doc. This module
 * derives that doc from the project's single source of visual truth:
 * theme tokens (src/themes.js getThemeTokens) + optional Style Studio
 * profile + niche. Pure, no AI call.
 */
'use strict';

let getThemeTokens = () => ({});
try { ({ getThemeTokens } = require('../data/themes')); } catch (_) { /* tokens optional */ }

// Design-intelligence math (WCAG contrast, luminance). Optional at load time.
let _di = null;
try { _di = require('../agents/design-intelligence'); } catch (_) { /* optional */ }

const THEME_MOODS = {
    crime:    'tense, investigative, high-contrast — evidence-room energy, hard shadows, red accents used sparingly like crime-scene tape',
    history:  'archival, documentary gravitas — aged paper warmth, serif confidence, measured pacing',
    modern:   'sleek tech-forward broadcast — glassy panels, precise grids, cool light',
    minimal:  'calm editorial restraint — generous whitespace, one accent, nothing decorative',
    standard: 'clean professional explainer — confident, neutral, broadcast-news polish',
    'warm-editorial': 'warm print-magazine editorial — cream paper, burnt-orange emphasis, serif headlines, hand-crafted calm; charts look like a beautiful almanac, not a dashboard',
    luxury: 'understated opulence — deep black, soft gold lines, champagne serif type, generous spacing; nothing shouts, everything gleams',
    nature: 'documentary naturalism — deep forest tones, organic shapes, soft light; data feels like field notes',
};

// True WCAG relative luminance (sRGB-linearized) when design-intelligence is
// available; falls back to a perceptual average. White→1, black→0.
function _lum(hex) {
    if (_di && typeof _di.relativeLuminance === 'function') return _di.relativeLuminance(hex);
    const m = String(hex || '').match(/^#?([0-9a-f]{6})$/i);
    if (!m) return 0;
    const n = parseInt(m[1], 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

// Deterministic WCAG contrast audit of the theme's own text/background token
// pairs. Any pair below AA (4.5:1 body) is surfaced to the author so it never
// places unreadable text — closes the "white caption on a light panel" gap.
function _contrastNotes(c) {
    if (!_di || typeof _di.validateContrast !== 'function' || typeof _di.flatten !== 'function') return '';
    const bgHex = c.background || '#000000';
    // Panel surfaces are often translucent (rgba) → composite over the canvas
    // so the measured background matches what the eye actually sees.
    const surfEff = _di.flatten(c.surface, bgHex); // {r,g,b} or null
    const pairs = [
        ['text-primary on background', c.textPrimary, c.background],
        ['text-secondary on background', c.textSecondary, c.background],
        ['text-primary on surface/panel', c.textPrimary, surfEff],
        ['text-secondary on surface/panel', c.textSecondary, surfEff],
    ].filter(([, fg, bg]) => fg && bg);
    const lines = [];
    for (const [label, fgRaw, bgRaw] of pairs) {
        // Flatten a translucent text color over its own background before measuring.
        const bgForFlatten = (bgRaw && typeof bgRaw === 'object') ? null : bgRaw;
        const fg = bgForFlatten ? (_di.flatten(fgRaw, bgForFlatten) || fgRaw) : fgRaw;
        const v = _di.validateContrast(fg, bgRaw);
        if (v.unknown) continue; // couldn't parse a color → don't emit a false warning
        if (!v.AA) lines.push(`- ⚠️ ${label} = ${v.ratio}:1 — FAILS WCAG AA (needs 4.5:1). Do NOT use this pair for body text; enlarge/bold it, put it on a scrim, or use a darker/lighter tone.`);
    }
    if (!lines.length) return '';
    return `\n## Contrast (WCAG — enforce)\nEvery text element must clear 4.5:1 against whatever sits behind it (add a scrim/plate over footage). Known unsafe pairs in this palette:\n${lines.join('\n')}\n`;
}

function generateDesignDoc({ themeId = 'standard', styleProfile = null, nicheId = '' } = {}) {
    const tokens = getThemeTokens(themeId) || {};
    const c = tokens.colors || {};
    const t = tokens.typography || {};
    const chrome = tokens.chrome || {};
    const mood = (styleProfile && styleProfile.mood) || THEME_MOODS[themeId] || THEME_MOODS.standard;

    const colorLines = [
        ['primary (brand/emphasis)', c.primary],
        ['accent (highlights/data)', c.accent],
        ['background (canvas)', c.background],
        ['surface (panels/cards)', c.surface],
        ['text-primary', c.textPrimary],
        ['text-secondary', c.textSecondary],
        ['stroke (rules/borders)', c.stroke],
    ].filter(([, v]) => v).map(([k, v]) => `- ${k}: ${v}`).join('\n');

    const notTo = [
        'Default grays (#333/#666/#999), default blues (#3b82f6), Roboto/system-default type',
        'Centered bordered box as the layout for every scene',
        'Uniform fade-in/fade-out on everything',
        chrome.glow === false ? 'Neon glows on text (this theme is glow-free — use weight and contrast instead)' : null,
        chrome.shadowStyle === 'hard' ? 'Soft blurry shadows (this theme uses hard offset shadows)' : null,
        styleProfile && styleProfile.avoid ? String(styleProfile.avoid) : null,
    ].filter(Boolean).map(s => `- ${s}`).join('\n');

    const profileExtra = styleProfile && styleProfile.style_prompt_full
        ? `\n## Style profile (learned from reference video)\n${String(styleProfile.style_prompt_full).slice(0, 900)}\n`
        : '';

    return `# DESIGN — theme "${themeId}"${nicheId ? ` · niche "${nicheId}"` : ''}

## Style Prompt
${mood}. Built for a 1920×1080 faceless YouTube video; every composition must
read instantly at thumbnail size — one dominant element per scene.${_lum(c.background) > 0.4 ? '\nLIGHT CANVAS THEME: the canvas is LIGHT — use text-primary (a dark tone) for text, never white-on-light. Panels are paper tones, not dark slabs. Shadows are soft and warm. Accents carry the color; the canvas stays calm.' : ''}

## Colors (use these exact values)
${colorLines || '- primary: #e8e8e8\n- background: #0b1018\n- text-primary: #ffffff'}

## Typography
- Headings: ${t.headingFont || 'Inter, sans-serif'} — weight ${t.headingWeight || '800'}
- Body: ${t.bodyFont || 'Inter, sans-serif'} — weight ${t.bodyWeight || '500'}
- Numbers/stats: ${t.statFont || t.headingFont || 'Inter, sans-serif'} — weight ${t.statWeight || '900'}

## Chrome
- Corner radius: ${chrome.borderRadius != null ? chrome.borderRadius + 'px' : '10px'} · stroke width: ${chrome.strokeWidth || 2}px
- Shadows: ${chrome.shadowStyle || 'soft'}${chrome.glow ? ' · subtle glow allowed on accents' : ' · no glow'}
- Panel fill: ${c.surface || 'rgba(8,12,20,0.9)'}
${profileExtra}${_contrastNotes(c)}
## What NOT to do
${notTo}
`;
}

module.exports = { generateDesignDoc };
