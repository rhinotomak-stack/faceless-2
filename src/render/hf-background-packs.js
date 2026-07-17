/**
 * hf-background-packs.js — Stylist scene backgrounds for the HyperFrames page.
 *
 * The universal backdrop for framed/floating footage stays the DUPLICATE BLUR
 * (a blurred copy of the clip itself — owned by the bridge). These packs are
 * the second lane: designed, theme-token-tinted backgrounds for scenes whose
 * upstream background choice is FLAT (gradient:x / soft-x / style). ONE pack
 * per video — chosen by the effects director (or theme default) — so the
 * backgrounds read as deliberate art direction, not a random wall per scene.
 *
 * Every pack is pure CSS (layers + slow keyframe motion, GPU-friendly:
 * transform/opacity/background-position only) and pulls every color from the
 * theme tokens. No hardcoded niche/word logic — themes own the palette.
 */
'use strict';

function hexA(hex, a) {
    const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return `rgba(120,140,170,${a})`;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function _shade(hex, amt) {
    const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    const mix = (v) => Math.round(amt < 0 ? v * (1 + amt) : v + (255 - v) * amt);
    const r = mix((n >> 16) & 255), g = mix((n >> 8) & 255), b = mix(n & 255);
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
}

function _lum(hex) {
    const m = String(hex || '').trim().match(/^#?([0-9a-f]{6})$/i);
    if (!m) return 0;
    const n = parseInt(m[1], 16);
    return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

function palette(tokens) {
    const c = (tokens && tokens.colors) || {};
    const bg = c.background || '#0a0a0a';
    const isLight = _lum(bg) > 0.5;
    return {
        primary: c.primary || '#38bdf8',
        secondary: c.secondary || '#f97316',
        accent: c.accent || '#34d399',
        bg,
        surface: c.surface || 'rgba(12,16,24,0.92)',
        isLight,
        // derived tones: gradients/vignettes follow the canvas instead of
        // hardcoded near-black (light themes get warm paper depth)
        deep: isLight ? _shade(bg, -0.08) : _shade(bg, -0.6),
        spotTop: isLight ? _shade(bg, 0.05) : _shade(bg, -0.45),
        splitB: isLight ? _shade(bg, -0.06) : '#161d2c',
        paperA: isLight ? _shade(bg, -0.03) : '#0d0b09',
        paperB: isLight ? _shade(bg, -0.09) : '#070605',
        lineTint: isLight ? 'rgba(74,52,30,0.06)' : 'rgba(255,255,255,0.045)',
        vig: isLight ? 'rgba(116,90,58,0.20)' : 'rgba(2,5,10,0.5)',
        vigWarm: isLight ? 'rgba(116,90,58,0.18)' : 'rgba(5,3,2,0.58)',
    };
}

// Each pack: css(p) → shared page CSS (classes + keyframes), html → layer markup
// inside the .hf-scene-floatbg stage. Class names are pack-prefixed.
const PACKS = {
    'studio-gradient': {
        label: 'Studio gradient',
        css: (p) => `
    .hf-bgp-studio { background: radial-gradient(120% 90% at 18% 8%, ${hexA(p.primary, 0.28)}, transparent 55%), radial-gradient(110% 95% at 85% 92%, ${hexA(p.secondary, 0.22)}, transparent 58%), linear-gradient(165deg, ${p.bg}, ${p.deep} 78%); }
    .hf-bgp-studio-glow { position: absolute; inset: -20%; background: radial-gradient(60% 45% at 50% 30%, ${hexA(p.accent, 0.24)}, transparent 70%); animation: hfBgpStudioBreathe 16s ease-in-out infinite; }
    @keyframes hfBgpStudioBreathe { 0%,100% { opacity: 0.55; transform: scale(1); } 50% { opacity: 1; transform: scale(1.06); } }`,
        html: '<div class="hf-bgp-studio-glow"></div>',
        stageClass: 'hf-bgp-studio',
    },
    'spotlight': {
        label: 'Spotlight',
        css: (p) => `
    .hf-bgp-spot { background: linear-gradient(180deg, ${p.spotTop}, ${p.bg} 130%); }
    .hf-bgp-spot-pool { position: absolute; inset: -15%; background: radial-gradient(46% 38% at 50% 36%, ${hexA(p.primary, 0.32)}, ${hexA(p.primary, 0.05)} 52%, transparent 72%); animation: hfBgpSpotBreathe 13s ease-in-out infinite; }
    .hf-bgp-spot-floor { position: absolute; left: 0; right: 0; bottom: 0; height: 34%; background: linear-gradient(0deg, ${hexA(p.primary, 0.13)}, transparent); }
    @keyframes hfBgpSpotBreathe { 0%,100% { transform: scale(1); opacity: 0.85; } 50% { transform: scale(1.05); opacity: 1; } }`,
        html: '<div class="hf-bgp-spot-pool"></div><div class="hf-bgp-spot-floor"></div>',
        stageClass: 'hf-bgp-spot',
    },
    'dot-matrix': {
        label: 'Dot matrix',
        css: (p) => `
    .hf-bgp-dots { background: linear-gradient(170deg, ${p.bg}, ${p.deep} 80%); }
    .hf-bgp-dots-grid { position: absolute; inset: -8%; background-image: radial-gradient(${hexA(p.primary, 0.5)} 1.8px, transparent 2px); background-size: 40px 40px; animation: hfBgpDotsDrift 30s linear infinite; opacity: 0.9; }
    .hf-bgp-dots-vig { position: absolute; inset: 0; background: radial-gradient(85% 75% at 50% 45%, transparent 58%, ${p.vig}); }
    @keyframes hfBgpDotsDrift { from { background-position: 0 0; } to { background-position: 92px 46px; } }`,
        html: '<div class="hf-bgp-dots-grid"></div><div class="hf-bgp-dots-vig"></div>',
        stageClass: 'hf-bgp-dots',
    },
    'blueprint-grid': {
        label: 'Blueprint grid',
        css: (p) => `
    .hf-bgp-blue { background: linear-gradient(160deg, ${p.bg}, ${p.deep} 85%); }
    .hf-bgp-blue-grid { position: absolute; inset: -10%; background-image: linear-gradient(${hexA(p.primary, 0.24)} 1px, transparent 1px), linear-gradient(90deg, ${hexA(p.primary, 0.24)} 1px, transparent 1px), linear-gradient(${hexA(p.primary, 0.11)} 1px, transparent 1px), linear-gradient(90deg, ${hexA(p.primary, 0.11)} 1px, transparent 1px); background-size: 240px 240px, 240px 240px, 48px 48px, 48px 48px; animation: hfBgpBluePan 38s linear infinite; }
    .hf-bgp-blue-glow { position: absolute; inset: 0; background: radial-gradient(70% 55% at 24% 18%, ${hexA(p.accent, 0.24)}, transparent 60%); }
    .hf-bgp-blue-vig { position: absolute; inset: 0; background: radial-gradient(90% 80% at 50% 50%, transparent 60%, ${p.vig}); }
    @keyframes hfBgpBluePan { from { transform: translate(0, 0); } to { transform: translate(-48px, -48px); } }`,
        html: '<div class="hf-bgp-blue-grid"></div><div class="hf-bgp-blue-glow"></div><div class="hf-bgp-blue-vig"></div>',
        stageClass: 'hf-bgp-blue',
    },
    'paper-grain': {
        label: 'Paper grain',
        css: (p) => `
    .hf-bgp-paper { background: linear-gradient(170deg, ${hexA(p.secondary, 0.2)}, transparent 50%), linear-gradient(180deg, ${p.paperA}, ${p.paperB} 85%); }
    .hf-bgp-paper-lines { position: absolute; inset: 0; background-image: repeating-linear-gradient(0deg, ${p.lineTint} 0 1px, transparent 1px 7px); }
    .hf-bgp-paper-stain { position: absolute; inset: -12%; background: radial-gradient(50% 42% at 70% 22%, ${hexA(p.secondary, 0.17)}, transparent 68%); animation: hfBgpPaperDrift 26s ease-in-out infinite alternate; }
    .hf-bgp-paper-vig { position: absolute; inset: 0; background: radial-gradient(88% 78% at 50% 46%, transparent 55%, ${p.vigWarm}); }
    @keyframes hfBgpPaperDrift { from { transform: translate(0,0); } to { transform: translate(-3.5%, 2.5%); } }`,
        html: '<div class="hf-bgp-paper-lines"></div><div class="hf-bgp-paper-stain"></div><div class="hf-bgp-paper-vig"></div>',
        stageClass: 'hf-bgp-paper',
    },
    'bokeh-drift': {
        label: 'Bokeh drift',
        css: (p) => `
    .hf-bgp-bokeh { background: linear-gradient(175deg, ${p.bg}, ${p.deep} 82%); }
    .hf-bgp-bokeh i { position: absolute; border-radius: 50%; filter: blur(70px); opacity: 0.75; }
    .hf-bgp-bokeh i:nth-child(1) { width: 760px; height: 760px; left: -12%; top: -18%; background: ${hexA(p.primary, 0.36)}; animation: hfBgpBok1 27s ease-in-out infinite alternate; }
    .hf-bgp-bokeh i:nth-child(2) { width: 620px; height: 620px; right: -10%; top: 30%; background: ${hexA(p.secondary, 0.3)}; animation: hfBgpBok2 33s ease-in-out infinite alternate; }
    .hf-bgp-bokeh i:nth-child(3) { width: 460px; height: 460px; left: 28%; bottom: -22%; background: ${hexA(p.accent, 0.24)}; animation: hfBgpBok3 24s ease-in-out infinite alternate; }
    @keyframes hfBgpBok1 { to { transform: translate(9%, 12%) scale(1.12); } }
    @keyframes hfBgpBok2 { to { transform: translate(-11%, -9%) scale(0.92); } }
    @keyframes hfBgpBok3 { to { transform: translate(7%, -10%) scale(1.1); } }`,
        html: '<i></i><i></i><i></i>',
        stageClass: 'hf-bgp-bokeh',
    },
    'split-tone': {
        label: 'Split tone',
        css: (p) => `
    .hf-bgp-split { background: linear-gradient(112deg, ${p.bg} 0 54%, ${p.splitB} 54.25% 100%); }
    .hf-bgp-split-seam { position: absolute; top: -10%; bottom: -10%; left: 50%; width: 2px; background: linear-gradient(180deg, transparent, ${hexA(p.accent, 0.55)} 30% 70%, transparent); transform: rotate(22deg) translateX(120px); animation: hfBgpSeam 11s ease-in-out infinite; }
    .hf-bgp-split-glow { position: absolute; inset: 0; background: radial-gradient(55% 45% at 28% 70%, ${hexA(p.primary, 0.16)}, transparent 65%); }
    @keyframes hfBgpSeam { 0%,100% { opacity: 0.35; } 50% { opacity: 0.9; } }`,
        html: '<div class="hf-bgp-split-seam"></div><div class="hf-bgp-split-glow"></div>',
        stageClass: 'hf-bgp-split',
    },
};

const BACKGROUND_PACK_IDS = Object.keys(PACKS);

// Theme defaults when no agent choice exists (graceful degradation).
const THEME_DEFAULTS = {
    crime: 'spotlight',
    history: 'paper-grain',
    modern: 'dot-matrix',
    minimal: 'split-tone',
    standard: 'studio-gradient',
    'warm-editorial': 'paper-grain',
    luxury: 'spotlight',
    nature: 'bokeh-drift',
};

function resolvePackId(requested, themeId) {
    const id = String(requested || '').trim().toLowerCase();
    if (PACKS[id]) return id;
    return THEME_DEFAULTS[String(themeId || '').toLowerCase()] || 'studio-gradient';
}

/**
 * buildBackgroundPack(packId, tokens) → { id, stageClass, html, css }
 * html goes inside the scene's .hf-scene-floatbg stage; css is injected once.
 */
function buildBackgroundPack(packId, tokens) {
    const id = PACKS[packId] ? packId : 'studio-gradient';
    const pack = PACKS[id];
    const p = palette(tokens);
    return { id, stageClass: pack.stageClass, html: pack.html, css: pack.css(p) };
}

module.exports = { buildBackgroundPack, resolvePackId, BACKGROUND_PACK_IDS, THEME_DEFAULTS };
