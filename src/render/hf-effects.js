/**
 * hf-effects.js — High-quality, ANIMATED, deterministic scene effects for
 * HyperFrames.
 *
 * Replaces the static CSS approximations in sceneEffectTreatment with living
 * effect layers driven by the master GSAP timeline: drifting grain, sweeping
 * light leaks, film flicker, breathing vignettes, letterbox, color grades,
 * bloom. Every tween lives on the paused master timeline at the scene's
 * offset → frame at time t is a pure function of t (seek-deterministic, safe
 * for the capture renderer).
 *
 * Same architecture split as maps/templates: the AGENT (effects director)
 * reasons about which recipe fits a scene; this REGISTRY renders the recipe
 * with hand-tuned quality. The agent never writes effect CSS.
 *
 *   buildSceneEffects(scene, ns, offset, duration, opts)
 *     -> { html, timelineJS, filter } | null
 *   EFFECT_IDS — vocabulary for the agentic director
 *   sharedEffectsCSS(grainUrl) — one-time CSS block for the page
 */
'use strict';

const clamp01 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; };

// ── Color-grade presets (CSS filter on the footage + optional tint layer) ──
const GRADES = {
    'teal-orange': { filter: 'saturate(1.12) contrast(1.07) hue-rotate(-6deg)', tint: 'rgba(8,64,72,0.16)', blend: 'soft-light' },
    'warm-film':   { filter: 'saturate(1.05) contrast(1.04) sepia(0.14)', tint: 'rgba(255,176,96,0.13)', blend: 'soft-light' },
    'cold-steel':  { filter: 'saturate(0.82) contrast(1.1) hue-rotate(8deg)', tint: 'rgba(64,96,144,0.16)', blend: 'soft-light' },
    'noir':        { filter: 'grayscale(1) contrast(1.18) brightness(0.96)', tint: 'rgba(0,0,0,0.1)', blend: 'multiply' },
    'faded':       { filter: 'saturate(0.78) contrast(0.94) brightness(1.05)', tint: 'rgba(228,222,208,0.1)', blend: 'soft-light' },
    'vivid':       { filter: 'saturate(1.22) contrast(1.08)', tint: '', blend: '' },
    'sepia-archival': { filter: 'sepia(0.55) contrast(1.05) brightness(0.97) saturate(0.9)', tint: 'rgba(214,178,120,0.12)', blend: 'soft-light' },
    'vhs-wash':    { filter: 'saturate(0.72) contrast(0.95) brightness(1.04) hue-rotate(-4deg)', tint: 'rgba(214,96,196,0.07)', blend: 'soft-light' },
    'neon-night':  { filter: 'saturate(1.3) contrast(1.12) brightness(0.97) hue-rotate(6deg)', tint: 'rgba(56,40,168,0.12)', blend: 'soft-light' },
};

// ── Effect builders ──
// Each returns { html, timeline } for one scene instance. `lw` = layer wrapper
// helper producing a namespaced absolutely-positioned layer.
const layer = (id, cls, style = '') => `<div id="${id}" class="hf-fx ${cls}"${style ? ` style="${style}"` : ''}></div>`;

const EFFECTS = {
    // Animated film grain — stepped background-position jumps (12 jumps/sec),
    // the classic "boiling" grain. Deterministic: one stepped tween.
    grain(ns, off, dur, o) {
        const op = (0.1 + clamp01(o.intensity) * 0.32).toFixed(3);
        const id = `${ns}-fx-grain`;
        return {
            html: layer(id, 'hf-fx-grain', `opacity:${op};`),
            timeline: `tl.to("#${id}",{backgroundPosition:"+=1980px +=1540px",duration:${dur.toFixed(3)},ease:"steps(${Math.max(6, Math.round(dur * 12))})"},${off.toFixed(3)});`,
        };
    },
    // Dust/speckle drifting slowly upward-left (screen blend, sparse tile).
    dust(ns, off, dur, o) {
        const op = (0.05 + clamp01(o.intensity) * 0.22).toFixed(3);
        const id = `${ns}-fx-dust`;
        return {
            html: layer(id, 'hf-fx-dust', `opacity:${op};`),
            timeline: `tl.to("#${id}",{backgroundPosition:"-=${Math.round(dur * 26)}px -=${Math.round(dur * 34)}px",duration:${dur.toFixed(3)},ease:"none"},${off.toFixed(3)});`,
        };
    },
    // Light leak — a warm gradient blade that SWEEPS across the frame once
    // every ~5s, breathing in/out. The static version looked like a stain.
    lightLeak(ns, off, dur, o) {
        const i = clamp01(o.intensity);
        const warm = clamp01(o.warmth == null ? 0.65 : o.warmth);
        const a = (0.25 + i * 0.45).toFixed(3);
        const col = `rgba(255,${Math.round(170 + warm * 60)},${Math.round(130 - warm * 80)},${a})`;
        const id = `${ns}-fx-leak`;
        const sweeps = Math.max(1, Math.floor(dur / 5));
        const sweepDur = Math.min(3.4, dur * 0.6);
        return {
            html: layer(id, 'hf-fx-leak', `background:linear-gradient(105deg, transparent 30%, ${col} 50%, transparent 70%);opacity:0;`),
            timeline: [
                `tl.fromTo("#${id}",{xPercent:-80,opacity:0},{xPercent:80,opacity:${(0.5 + i * 0.5).toFixed(2)},duration:${sweepDur.toFixed(2)},ease:"sine.inOut",repeat:${sweeps - 1},repeatDelay:${Math.max(0, (dur - sweeps * sweepDur) / Math.max(1, sweeps)).toFixed(2)}},${off.toFixed(3)});`,
                `tl.to("#${id}",{opacity:0,duration:0.5,ease:"power1.in"},${(off + dur - 0.55).toFixed(3)});`,
            ].join('\n'),
        };
    },
    // Film flicker — subtle luminance oscillation (white overlay micro-pulses).
    flicker(ns, off, dur, o) {
        const peak = (0.02 + clamp01(o.intensity) * 0.05).toFixed(3);
        const id = `${ns}-fx-flicker`;
        const cycles = Math.max(2, Math.floor(dur / 0.24));
        return {
            html: layer(id, 'hf-fx-flicker'),
            timeline: `tl.fromTo("#${id}",{opacity:0},{opacity:${peak},duration:0.12,yoyo:true,repeat:${cycles * 2 - 1},ease:"sine.inOut"},${off.toFixed(3)});`,
        };
    },
    // Vignette with a slow breathe (radius pulses gently — alive, not painted on).
    vignette(ns, off, dur, o) {
        const i = clamp01(o.intensity);
        const inner = Math.round(30 + (1 - clamp01(o.radius == null ? 0.5 : o.radius)) * 22);
        const a = (0.18 + i * 0.5).toFixed(3);
        const id = `${ns}-fx-vig`;
        return {
            html: layer(id, 'hf-fx-vig', `background:radial-gradient(ellipse at 50% 50%, transparent ${inner}%, rgba(0,0,0,${a}) 100%);`),
            timeline: `tl.fromTo("#${id}",{scale:1},{scale:1.045,duration:${Math.max(2, dur / 2).toFixed(2)},yoyo:true,repeat:${dur > 4 ? 1 : 0},ease:"sine.inOut"},${off.toFixed(3)});`,
        };
    },
    // letterbox REMOVED (June 11): its bars rendered inside the scene frame —
    // on framed/scaled clips they read as a black-bar BUG, not cinema. If it
    // ever returns it must be a page-level layer outside the scene frames.
    // Cached recipes containing "letterbox" are auto-skipped (unknown id).
    // Soft bloom — a screen-blend radial glow that swells slowly.
    bloom(ns, off, dur, o) {
        const a = (0.08 + clamp01(o.intensity) * 0.2).toFixed(3);
        const id = `${ns}-fx-bloom`;
        return {
            html: layer(id, 'hf-fx-bloom', `background:radial-gradient(ellipse at 50% 38%, rgba(255,250,238,${a}), transparent 58%);opacity:0.7;`),
            timeline: `tl.fromTo("#${id}",{opacity:0.45,scale:1},{opacity:1,scale:1.07,duration:${Math.max(2.2, dur / 2).toFixed(2)},yoyo:true,repeat:${dur > 4.5 ? 1 : 0},ease:"sine.inOut"},${off.toFixed(3)});`,
        };
    },
    // Chromatic edge fringe — static red/cyan edge tint (cheap, convincing).
    chromaticEdge(ns, off, dur, o) {
        const a = (0.04 + clamp01(o.intensity) * 0.1).toFixed(3);
        const id = `${ns}-fx-chroma`;
        return {
            html: layer(id, 'hf-fx-chroma', `background:linear-gradient(90deg, rgba(255,40,40,${a}) 0%, transparent 7%, transparent 93%, rgba(40,220,255,${a}) 100%);`),
            timeline: '',
        };
    },

    // ── Retro / film family ──
    // Old-film scratches: sparse vertical hairlines jumping positions in steps
    // + opacity flutter. The classic projector-print damage.
    filmScratches(ns, off, dur, o) {
        const i = clamp01(o.intensity);
        const op = (0.1 + i * 0.3).toFixed(3);
        const id = `${ns}-fx-scratch`;
        const steps = Math.max(6, Math.round(dur * 9));
        return {
            html: layer(id, 'hf-fx-scratch', `opacity:${op};`),
            timeline: [
                `tl.to("#${id}",{backgroundPositionX:"+=1373px",duration:${dur.toFixed(3)},ease:"steps(${steps})"},${off.toFixed(3)});`,
                `tl.fromTo("#${id}",{opacity:${(op * 0.4).toFixed(3)}},{opacity:${op},duration:0.18,yoyo:true,repeat:${Math.max(2, Math.floor(dur / 0.36)) * 2 - 1},ease:"steps(2)"},${off.toFixed(3)});`,
            ].join('\n'),
        };
    },
    // Vintage frame: rounded-corner dark border ring + breathing inner edge
    // fade — the "old photograph / projected memory" framing.
    vintageFrame(ns, off, dur, o) {
        const i = clamp01(o.intensity);
        const ring = `${ns}-fx-vframe`;
        const fade = `${ns}-fx-vfade`;
        return {
            html: layer(ring, 'hf-fx-vframe', `border-width:${Math.round(18 + i * 26)}px;border-radius:${Math.round(30 + i * 18)}px;`)
                + layer(fade, 'hf-fx-vfade', `border-radius:${Math.round(26 + i * 16)}px;box-shadow:inset 0 0 ${Math.round(70 + i * 110)}px rgba(0,0,0,${(0.45 + i * 0.35).toFixed(2)});`),
            timeline: `tl.fromTo("#${fade}",{opacity:0.85},{opacity:1,duration:${Math.max(1.8, dur / 2).toFixed(2)},yoyo:true,repeat:${dur > 3.8 ? 1 : 0},ease:"sine.inOut"},${off.toFixed(3)});`,
        };
    },
    // Old TV / CRT: scanlines + a soft bright band rolling down + micro flicker.
    oldTv(ns, off, dur, o) {
        const i = clamp01(o.intensity);
        const lines = `${ns}-fx-crtlines`;
        const roll = `${ns}-fx-crtroll`;
        const rolls = Math.max(1, Math.floor(dur / 3.2));
        return {
            html: layer(lines, 'hf-fx-crtlines', `opacity:${(0.12 + i * 0.26).toFixed(3)};`)
                + layer(roll, 'hf-fx-crtroll', `opacity:${(0.3 + i * 0.4).toFixed(3)};`),
            timeline: [
                `tl.fromTo("#${roll}",{yPercent:-130},{yPercent:130,duration:${Math.min(3.4, dur / rolls).toFixed(2)},ease:"none",repeat:${rolls - 1},repeatDelay:${Math.max(0, (dur - rolls * Math.min(3.4, dur / rolls)) / Math.max(1, rolls)).toFixed(2)}},${off.toFixed(3)});`,
                `tl.fromTo("#${lines}",{opacity:${(0.1 + i * 0.18).toFixed(3)}},{opacity:${(0.14 + i * 0.3).toFixed(3)},duration:0.1,yoyo:true,repeat:${Math.max(4, Math.floor(dur / 0.2)) * 2 - 1},ease:"steps(2)"},${off.toFixed(3)});`,
            ].join('\n'),
        };
    },
    // VHS: red/cyan ghost layers with stepped jitter + a tracking-noise band
    // that jumps between heights. Pair with the "vhs-wash" grade.
    vhs(ns, off, dur, o) {
        const i = clamp01(o.intensity);
        const r = `${ns}-fx-vhsr`;
        const c = `${ns}-fx-vhsc`;
        const band = `${ns}-fx-vhsband`;
        const jumps = Math.max(3, Math.round(dur / 0.9));
        return {
            html: layer(r, 'hf-fx-vhsr', `opacity:${(0.09 + i * 0.15).toFixed(3)};`)
                + layer(c, 'hf-fx-vhsc', `opacity:${(0.09 + i * 0.15).toFixed(3)};`)
                + layer(band, 'hf-fx-vhsband', `opacity:${(0.12 + i * 0.3).toFixed(3)};top:18%;`),
            timeline: [
                `tl.to("#${r}",{x:${(2 + i * 4).toFixed(1)},duration:${dur.toFixed(3)},ease:"steps(${Math.max(8, Math.round(dur * 6))})"},${off.toFixed(3)});`,
                `tl.to("#${c}",{x:${(-2 - i * 4).toFixed(1)},duration:${dur.toFixed(3)},ease:"steps(${Math.max(8, Math.round(dur * 6))})"},${off.toFixed(3)});`,
                `tl.to("#${band}",{top:"82%",duration:${dur.toFixed(3)},ease:"steps(${jumps})"},${off.toFixed(3)});`,
                `tl.to("#${band}",{backgroundPositionX:"+=900px",duration:${dur.toFixed(3)},ease:"steps(${Math.max(10, Math.round(dur * 14))})"},${off.toFixed(3)});`,
            ].join('\n'),
        };
    },
    // TV static — fast-boiling noise wash (ambience for "signal lost"/archival
    // gaps; at low intensity it reads as broadcast texture).
    staticNoise(ns, off, dur, o) {
        const op = (0.06 + clamp01(o.intensity) * 0.22).toFixed(3);
        const id = `${ns}-fx-static`;
        return {
            html: layer(id, 'hf-fx-static', `opacity:${op};`),
            timeline: `tl.to("#${id}",{backgroundPosition:"+=1700px +=1300px",duration:${dur.toFixed(3)},ease:"steps(${Math.max(12, Math.round(dur * 22))})"},${off.toFixed(3)});`,
        };
    },
    // Digital glitch pulses: short RGB-split bursts every ~2s, dead-still
    // between bursts (the CapCut "glitch" preset rhythm).
    glitchPulse(ns, off, dur, o) {
        const i = clamp01(o.intensity);
        const r = `${ns}-fx-glr`;
        const c = `${ns}-fx-glc`;
        const period = 2.2;
        const bursts = Math.max(1, Math.floor((dur - 0.4) / period));
        const burstDur = 0.16;
        const amp = (4 + i * 9).toFixed(1);
        const peak = (0.18 + i * 0.24).toFixed(3);
        return {
            html: layer(r, 'hf-fx-glr', 'opacity:0;') + layer(c, 'hf-fx-glc', 'opacity:0;'),
            timeline: [
                `tl.fromTo("#${r}",{x:-${amp},opacity:0},{x:${amp},opacity:${peak},duration:${burstDur},ease:"steps(3)",yoyo:true,yoyoEase:"steps(2)",repeat:1${bursts > 1 ? `,repeatDelay:0` : ''}},${(off + 0.6).toFixed(3)});`,
                `tl.fromTo("#${c}",{x:${amp},opacity:0},{x:-${amp},opacity:${peak},duration:${burstDur},ease:"steps(3)",yoyo:true,yoyoEase:"steps(2)",repeat:1},${(off + 0.6).toFixed(3)});`,
                ...(bursts > 1 ? [
                    `tl.fromTo("#${r}",{x:-${amp},opacity:0},{x:${amp},opacity:${peak},duration:${burstDur},ease:"steps(3)",yoyo:true,repeat:1},${(off + 0.6 + period).toFixed(3)});`,
                    `tl.fromTo("#${c}",{x:${amp},opacity:0},{x:-${amp},opacity:${peak},duration:${burstDur},ease:"steps(3)",yoyo:true,repeat:1},${(off + 0.6 + period).toFixed(3)});`,
                ] : []),
            ].join('\n'),
        };
    },

    // ── Light family ──
    // Soft vertical light streaks drifting across (the "projector window
    // light" look from vintage edits).
    lightStreaks(ns, off, dur, o) {
        const i = clamp01(o.intensity);
        const id = `${ns}-fx-streaks`;
        return {
            html: layer(id, 'hf-fx-streaks', `opacity:${(0.1 + i * 0.26).toFixed(3)};`),
            timeline: [
                `tl.fromTo("#${id}",{xPercent:-14},{xPercent:14,duration:${dur.toFixed(3)},ease:"sine.inOut"},${off.toFixed(3)});`,
                `tl.fromTo("#${id}",{opacity:${(0.06 + i * 0.14).toFixed(3)}},{opacity:${(0.14 + i * 0.3).toFixed(3)},duration:${Math.max(1.4, dur / 2.4).toFixed(2)},yoyo:true,repeat:1,ease:"sine.inOut"},${off.toFixed(3)});`,
            ].join('\n'),
        };
    },
    // Anamorphic lens flare: a horizontal glow line + core that sweeps once.
    lensFlare(ns, off, dur, o) {
        const i = clamp01(o.intensity);
        const id = `${ns}-fx-flare`;
        const sweepDur = Math.min(2.8, dur * 0.65);
        return {
            html: layer(id, 'hf-fx-flare', `opacity:0;`),
            timeline: `tl.fromTo("#${id}",{xPercent:-46,opacity:0},{xPercent:46,opacity:${(0.35 + i * 0.45).toFixed(2)},duration:${sweepDur.toFixed(2)},ease:"sine.inOut",yoyo:true,repeat:1},${(off + Math.max(0, (dur - sweepDur * 2) / 2)).toFixed(3)});`,
        };
    },

    // ── Atmosphere family ──
    // Fog/haze: two soft blobs drifting opposite directions (depth + mood).
    fogDrift(ns, off, dur, o) {
        const i = clamp01(o.intensity);
        const a = `${ns}-fx-foga`;
        const b = `${ns}-fx-fogb`;
        return {
            html: layer(a, 'hf-fx-foga', `opacity:${(0.3 + i * 0.4).toFixed(3)};`)
                + layer(b, 'hf-fx-fogb', `opacity:${(0.14 + i * 0.24).toFixed(3)};`),
            timeline: [
                `tl.fromTo("#${a}",{xPercent:-8},{xPercent:8,duration:${dur.toFixed(3)},ease:"sine.inOut"},${off.toFixed(3)});`,
                `tl.fromTo("#${b}",{xPercent:7},{xPercent:-7,duration:${dur.toFixed(3)},ease:"sine.inOut"},${off.toFixed(3)});`,
            ].join('\n'),
        };
    },
    // Floating embers/particles rising (war/fire/dramatic atmosphere).
    embers(ns, off, dur, o) {
        const i = clamp01(o.intensity);
        const a = `${ns}-fx-embera`;
        const b = `${ns}-fx-emberb`;
        return {
            html: layer(a, 'hf-fx-embera', `opacity:${(0.4 + i * 0.5).toFixed(3)};`)
                + layer(b, 'hf-fx-emberb', `opacity:${(0.3 + i * 0.4).toFixed(3)};`),
            timeline: [
                `tl.to("#${a}",{backgroundPositionY:"-=${Math.round(dur * 46)}px",backgroundPositionX:"+=${Math.round(dur * 9)}px",duration:${dur.toFixed(3)},ease:"none"},${off.toFixed(3)});`,
                `tl.to("#${b}",{backgroundPositionY:"-=${Math.round(dur * 74)}px",backgroundPositionX:"-=${Math.round(dur * 13)}px",duration:${dur.toFixed(3)},ease:"none"},${off.toFixed(3)});`,
                `tl.fromTo("#${a}",{opacity:${(0.18 + i * 0.28).toFixed(3)}},{opacity:${(0.3 + i * 0.45).toFixed(3)},duration:0.5,yoyo:true,repeat:${Math.max(2, Math.floor(dur / 1)) * 2 - 1},ease:"sine.inOut"},${off.toFixed(3)});`,
            ].join('\n'),
        };
    },
};

const EFFECT_IDS = Object.keys(EFFECTS);
const GRADE_IDS = Object.keys(GRADES);

// One-time CSS for the page. Layers sit inside .hf-scene-frame above media.
function sharedEffectsCSS(grainUrl) {
    return `
    .hf-fx { position: absolute; inset: 0; pointer-events: none; }
    .hf-fx-grain { mix-blend-mode: overlay; background-size: 220px 220px; background-repeat: repeat; ${grainUrl ? `background-image: url("${grainUrl}");` : ''} }
    .hf-fx-dust { mix-blend-mode: screen; background-size: 560px 560px; background-repeat: repeat; ${grainUrl ? `background-image: url("${grainUrl}");` : ''} }
    .hf-fx-leak { mix-blend-mode: screen; }
    .hf-fx-flicker { background: #fff; mix-blend-mode: overlay; opacity: 0; }
    .hf-fx-vig { mix-blend-mode: multiply; }
    .hf-fx-lb { left: 0; right: 0; background: #000; position: absolute; }
    .hf-fx-lb-top { top: 0; }
    .hf-fx-lb-bottom { bottom: 0; }
    .hf-fx-bloom { mix-blend-mode: screen; }
    .hf-fx-chroma { mix-blend-mode: screen; }
    .hf-fx-scratch { mix-blend-mode: overlay; background-image: repeating-linear-gradient(90deg, transparent 0 137px, rgba(255,255,255,0.85) 137px 139px, transparent 138px 311px, rgba(20,10,5,0.75) 311px 313px, transparent 312.5px 521px, rgba(255,255,255,0.6) 521px 522.5px, transparent 522px 760px); }
    .hf-fx-vframe { border-style: solid; border-color: rgba(4,3,2,0.92); box-sizing: border-box; inset: -2px; }
    .hf-fx-vfade { mix-blend-mode: multiply; }
    .hf-fx-crtlines { background-image: repeating-linear-gradient(0deg, rgba(0,0,0,0.72) 0 1.6px, transparent 1.6px 3.2px); mix-blend-mode: multiply; }
    .hf-fx-crtroll { height: 16%; top: 0; bottom: auto; background: linear-gradient(180deg, transparent, rgba(255,255,255,0.5) 50%, transparent); mix-blend-mode: overlay; }
    .hf-fx-vhsr { background: linear-gradient(90deg, rgba(255,40,60,0.5), rgba(255,40,60,0.18)); mix-blend-mode: screen; }
    .hf-fx-vhsc { background: linear-gradient(270deg, rgba(40,230,255,0.5), rgba(40,230,255,0.18)); mix-blend-mode: screen; }
    .hf-fx-vhsband { height: 22px; bottom: auto; background-size: 180px 22px; background-repeat: repeat-x; mix-blend-mode: screen; filter: contrast(1.6) brightness(1.4); ${grainUrl ? `background-image: url("${grainUrl}");` : ''} }
    .hf-fx-static { mix-blend-mode: screen; background-size: 160px 160px; background-repeat: repeat; filter: contrast(1.5); ${grainUrl ? `background-image: url("${grainUrl}");` : ''} }
    .hf-fx-glr { background: repeating-linear-gradient(0deg, rgba(255,30,50,0.42) 0 11px, transparent 11px 89px, rgba(255,30,50,0.28) 89px 98px, transparent 98px 207px); mix-blend-mode: screen; }
    .hf-fx-glc { background: repeating-linear-gradient(0deg, transparent 0 47px, rgba(30,220,255,0.42) 47px 60px, transparent 60px 161px, rgba(30,220,255,0.26) 161px 169px); mix-blend-mode: screen; }
    .hf-fx-streaks { background: linear-gradient(94deg, transparent 12%, rgba(255,252,240,0.5) 17%, transparent 24%, transparent 58%, rgba(255,250,232,0.32) 64%, transparent 72%); mix-blend-mode: screen; filter: blur(14px); }
    .hf-fx-flare { background: radial-gradient(62% 4.5% at 50% 50%, rgba(200,228,255,1), rgba(120,180,255,0.45) 55%, transparent 78%), radial-gradient(9% 15% at 50% 50%, rgba(255,255,255,0.95), transparent 72%); mix-blend-mode: screen; filter: blur(3px); }
    .hf-fx-foga { background: radial-gradient(58% 42% at 28% 64%, rgba(210,216,226,0.8), transparent 74%); mix-blend-mode: screen; filter: blur(34px); }
    .hf-fx-fogb { background: radial-gradient(52% 38% at 74% 36%, rgba(202,210,222,0.66), transparent 75%); mix-blend-mode: screen; filter: blur(40px); }
    .hf-fx-embera, .hf-fx-emberb { mix-blend-mode: screen; background-repeat: repeat; }
    .hf-fx-embera { background-image: radial-gradient(circle at 34px 118px, rgba(255,150,60,1) 0 3.4px, transparent 4.8px), radial-gradient(circle at 152px 47px, rgba(255,190,90,0.95) 0 2.6px, transparent 3.8px), radial-gradient(circle at 95px 201px, rgba(255,120,40,1) 0 3px, transparent 4.4px), radial-gradient(circle at 219px 163px, rgba(255,200,120,0.9) 0 2px, transparent 3px), radial-gradient(circle at 13px 257px, rgba(255,160,70,0.85) 0 2.4px, transparent 3.6px); background-size: 281px 311px; }
    .hf-fx-emberb { background-image: radial-gradient(circle at 71px 33px, rgba(255,170,80,0.9) 0 2.2px, transparent 3.2px), radial-gradient(circle at 187px 142px, rgba(255,140,50,0.85) 0 1.8px, transparent 2.8px), radial-gradient(circle at 241px 229px, rgba(255,180,90,0.7) 0 1.5px, transparent 2.4px); background-size: 307px 263px; filter: blur(0.4px); }
    .hf-fx-tint { position: absolute; inset: 0; pointer-events: none; }
    .hf-media-error .hf-fx { display: none; }`;
}

// Normalize a recipe entry list from either the agentic director
// (scene._effectRecipe = [{ id, intensity, ... }]) or legacy effectOverrides.
const CLEAN_CLASSES = new Set(['data-claim']); // grade-only beats — no film texture over charts/numbers

function recipeFromScene(scene) {
    // Clean classes (data/chart) → deliberately NO texture; base grade only. The
    // sentinel is re-derived from sceneClass every render, so it survives reload.
    if (scene && CLEAN_CLASSES.has(scene.sceneClass)) { const a = []; a.__clean = true; return a; }
    // A PRESENT _effectRecipe array is authoritative — even EMPTY means the agent
    // deliberately chose "no delta" (the base look still applies via mergeBaseLook);
    // it must NOT silently fall through to the legacy effectOverrides grade below.
    if (Array.isArray(scene && scene._effectRecipe)) {
        return scene._effectRecipe
            .filter(e => e && (EFFECTS[e.id] || GRADES[e.id]))
            .slice(0, 5)
            .map(e => ({ ...e, intensity: clamp01(e.intensity == null ? 0.4 : e.intensity) }));
    }
    // Legacy fallback ONLY when there is no agentic recipe at all (HF_FX_AGENT=0).
    const ov = scene?.effectOverrides || {};
    const out = [];
    const map = { grain: 'grain', dust: 'dust', lightLeak: 'lightLeak', blurVignette: 'vignette', vignette: 'vignette' };
    for (const [key, id] of Object.entries(map)) {
        const e = ov[key];
        if (e && e.enabled !== false && clamp01(e.intensity) > 0.005) {
            out.push({ id, intensity: clamp01(e.intensity), warmth: e.warmth, radius: e.radius });
        }
    }
    return out;
}

// Composite the video-wide BASE LOOK (film stock) with a scene's sparse DELTA.
// = base texture (skipped for clean scenes) + delta effects (delta intensity wins
// per id) + exactly ONE grade (a scene's own flashback grade delta, else the base
// grade). This is what makes the whole video read as a single film stock with
// sparse standout beats. baseLook = plan._hfBaseLook (or absent → recipe unchanged).
function mergeBaseLook(recipe, baseLook) {
    if (!baseLook) return recipe;
    const delta = Array.isArray(recipe) ? recipe : [];
    const isClean = delta.length === 0 && recipe && recipe.__clean === true;
    const out = [];
    if (!isClean) for (const t of (baseLook.texture || [])) out.push({ ...t });
    for (const d of delta) {
        if (GRADES[d.id]) continue; // grade handled below (single owner)
        const i = out.findIndex(e => e.id === d.id);
        if (i >= 0) out[i] = { ...d }; else out.push({ ...d });
    }
    const sceneGrade = delta.find(d => GRADES[d.id]);
    const grade = sceneGrade ? sceneGrade.id : baseLook.grade;
    // Reserve the grade slot: cap the NON-grade stack FIRST, then append the
    // single grade — so a long flashback recipe can never slice the grade off
    // (which would silently drop the whole scene's color to the legacy fallback).
    const capped = out.slice(0, 5);
    if (grade && GRADES[grade]) capped.push({ id: grade });
    return capped;
}

/**
 * Build the effect stack for one scene.
 * Returns { html, timelineJS, filter } — filter is the color-grade CSS filter
 * for the media element (legacy colorGrade overrides still apply upstream).
 */
// Edge-based effects only make sense on FULL-FRAME footage. Inside a framed/
// scaled clip (cinematic 0.85, floating, manual scale) they darken the clip's
// own edges — reads as dirt/black bars on the media, the exact bug class the
// user kept seeing. Texture (grain/dust/flicker) and color grades stay fine.
const FULLFRAME_ONLY = new Set([
    'vignette', 'bloom', 'chromaticEdge', 'lightLeak',
    // edge/frame-anchored CapCut-class looks — wrong on framed/scaled clips
    'vintageFrame', 'oldTv', 'vhs', 'lensFlare', 'lightStreaks',
]);

function buildSceneEffects(scene, ns, offset, duration, opts = {}) {
    let recipe = mergeBaseLook(recipeFromScene(scene), opts.baseLook);
    if (opts.framed) recipe = recipe.filter(e => !FULLFRAME_ONLY.has(e.id));
    if (!recipe.length) return null;
    const htmlParts = [];
    const tlParts = [];
    let filter = '';
    let tintLayer = '';
    for (const entry of recipe) {
        if (GRADES[entry.id]) {
            const g = GRADES[entry.id];
            filter = g.filter;
            if (g.tint) tintLayer = `<div class="hf-fx hf-fx-tint" style="background:${g.tint};mix-blend-mode:${g.blend};"></div>`;
            continue;
        }
        const built = EFFECTS[entry.id](ns, offset, Math.max(1, duration), entry);
        if (built.html) htmlParts.push(built.html);
        if (built.timeline) tlParts.push(built.timeline);
    }
    if (tintLayer) htmlParts.push(tintLayer);
    if (!htmlParts.length && !filter) return null;
    return { html: htmlParts.join('\n        '), timelineJS: tlParts.join('\n'), filter };
}

module.exports = { buildSceneEffects, sharedEffectsCSS, EFFECT_IDS, GRADE_IDS, GRADES, recipeFromScene, mergeBaseLook };
