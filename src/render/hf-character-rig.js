/**
 * hf-character-rig.js — inline character MG for no-findable-footage scenes
 * (OPENMONTAGE-BORROW-PLAN #19). Clean-room from OpenMontage's character rig
 * (AGPLv3 Python) — technique only, code is ours.
 *
 * Emits a HyperFrames authored composition {html, css, timeline} that PASSES
 * hf-template-author.validateComposition (the load-bearing linter):
 *   - timeline uses ONLY tl.set / tl.fromTo / tl.to (no onUpdate/Math.random/window.)
 *   - FINITE integer repeats baked as literals (frame capture forbids repeat:-1)
 *   - every id/selector namespaced; no external URLs; opens with gsap.set (entrance guard)
 *
 * The character is built from namespaced HTML/CSS divs (not SVG) so every
 * animated property is a plain CSS transform GSAP handles cleanly under headless
 * capture. Theme-accent-driven. v1 = one friendly figure: enter, bob, wave, blink.
 */
'use strict';

let getThemeTokens = () => ({});
try { ({ getThemeTokens } = require('../data/themes')); } catch (_) { /* optional */ }

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const intRepeat = (total, period) => Math.max(0, Math.floor(total / period) - 1);

/**
 * @param {object} o { ns, duration, themeId, caption }
 * @returns {{html:string, css:string, timeline:string, effects?:string[]}|null}
 */
function buildCharacterComp({ ns, duration = 4, themeId = 'standard', caption = '' } = {}) {
    if (!ns || typeof ns !== 'string') return null;
    const dur = Math.max(1.5, Number(duration) || 4);
    const tokens = getThemeTokens(themeId) || {};
    const c = tokens.colors || {};
    const accent = /^#|rgb/i.test(String(c.accent || '')) ? c.accent : '#22d3ee';
    const primary = /^#|rgb/i.test(String(c.primary || '')) ? c.primary : accent;
    const skin = '#f2c9a0';

    // Finite idle-loop repeat counts (literals baked into the timeline string).
    const idleStart = 0.6;
    const idleSpan = Math.max(0.6, dur - idleStart - 0.3);
    const bob = intRepeat(idleSpan, 2.0);       // slow body bob
    const wave = intRepeat(idleSpan, 0.8);      // hand wave (faster)
    const blinks = Math.max(1, Math.min(4, intRepeat(idleSpan, 2.4))); // discrete blinks
    const capText = String(caption || '').slice(0, 60);

    const html = `
      <div id="${ns}-char" class="${ns}-char">
        <div id="${ns}-armR" class="${ns}-arm ${ns}-armR"></div>
        <div id="${ns}-armL" class="${ns}-arm ${ns}-armL"></div>
        <div id="${ns}-body" class="${ns}-body"></div>
        <div id="${ns}-head" class="${ns}-head">
          <div id="${ns}-eyeL" class="${ns}-eye ${ns}-eyeL"></div>
          <div id="${ns}-eyeR" class="${ns}-eye ${ns}-eyeR"></div>
          <div id="${ns}-mouth" class="${ns}-mouth"></div>
        </div>
      </div>${capText ? `
      <div id="${ns}-cap" class="${ns}-cap">${esc(capText)}</div>` : ''}`;

    const css = `
    .${ns}-char { position: absolute; left: 50%; top: 42%; width: 300px; height: 360px; transform: translate(-50%, -50%); opacity: 0; }
    .${ns}-body { position: absolute; left: 50%; top: 150px; width: 180px; height: 200px; margin-left: -90px; background: ${primary}; border-radius: 90px 90px 60px 60px; box-shadow: 0 24px 60px rgba(0,0,0,0.45); }
    .${ns}-head { position: absolute; left: 50%; top: 0; width: 170px; height: 170px; margin-left: -85px; background: ${skin}; border-radius: 50%; box-shadow: inset 0 -10px 24px rgba(0,0,0,0.12); }
    .${ns}-eye { position: absolute; top: 66px; width: 24px; height: 30px; background: #1b1b1b; border-radius: 50%; }
    .${ns}-eyeL { left: 44px; }
    .${ns}-eyeR { right: 44px; }
    .${ns}-mouth { position: absolute; left: 50%; top: 104px; width: 64px; height: 30px; margin-left: -32px; border-bottom: 8px solid #1b1b1b; border-radius: 0 0 40px 40px; }
    .${ns}-arm { position: absolute; top: 168px; width: 44px; height: 130px; background: ${primary}; border-radius: 30px; }
    .${ns}-armL { left: 34px; }
    .${ns}-armR { right: 34px; }
    .${ns}-cap { position: absolute; left: 50%; bottom: 150px; transform: translateX(-50%); color: ${accent}; font-family: var(--hf-heading-font, Inter, sans-serif); font-weight: 800; font-size: 44px; letter-spacing: -0.01em; text-align: center; max-width: 1200px; opacity: 0; text-shadow: 0 3px 18px rgba(0,0,0,0.6); }`;

    const timeline = `
    tl.set('#${ns}-char', { opacity: 0, scale: 0.82, y: 26 }, 0);
    tl.set('#${ns}-armR', { rotation: 6, transformOrigin: 'top center' }, 0);
    tl.set('#${ns}-cap', { opacity: 0, y: 14 }, 0);
    tl.fromTo('#${ns}-char', { opacity: 0, scale: 0.82, y: 26 }, { opacity: 1, scale: 1, y: 0, duration: 0.55, ease: 'back.out(1.7)' }, 0);
    tl.to('#${ns}-char', { y: -16, duration: 1.0, ease: 'sine.inOut', yoyo: true, repeat: ${bob} }, ${idleStart});
    tl.to('#${ns}-armR', { rotation: -26, duration: 0.4, ease: 'sine.inOut', yoyo: true, repeat: ${wave}, transformOrigin: 'top center' }, ${idleStart});
    tl.to('#${ns}-eyeL, #${ns}-eyeR', { scaleY: 0.12, duration: 0.09, yoyo: true, repeat: 1, repeatDelay: 2.2, ease: 'none', transformOrigin: 'center', immediateRender: false }, 1.1);
    tl.fromTo('#${ns}-cap', { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.4, ease: 'power2.out' }, 0.7);`;

    return { html: html.trim(), css: css.trim(), timeline: timeline.trim(), effects: [] };
}

function isEnabled() {
    return /^(1|true|on|yes)$/i.test(String(process.env.HF_CHARACTER_MG || '').trim());
}

const _num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

// A scene with no usable footage: not already a graphic/template/map, and either
// no media file or a failed / static-fallback download.
function _isNoFootage(s) {
    if (!s || s.isMGScene || s.fullscreenMG || s.templateType || s.mgType) return false;
    if (s.trackId && s.trackId !== 'video-track-1') return false;
    return !s.mediaFile || s.mediaDownloadStatus === 'failed' || s.mediaDownloadStatus === 'agenticGraphicFallback';
}

/**
 * Author character MGs onto plan.mgScenes for no-footage scenes (OPT-IN
 * HF_CHARACTER_MG). Each comp is validated through the real linter before it is
 * attached; failures are dropped (the static fallback stays). Mutates plan.
 * @returns {{rigged:number, candidates:number, dropped:number, skipped?:boolean}}
 */
function authorCharacterScenes(plan, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    if (!isEnabled()) return { rigged: 0, skipped: true };
    let validateComposition = null;
    try { ({ validateComposition } = require('./hf-template-author')); } catch (_) { /* validate optional */ }
    try {
        const scenes = (plan && Array.isArray(plan.scenes)) ? plan.scenes : [];
        const themeId = (plan.scriptContext && plan.scriptContext.themeId) || plan.themeId || 'standard';
        const candidates = scenes.filter(_isNoFootage);
        if (!candidates.length) return { rigged: 0, candidates: 0 };

        // Don't turn a footage-starved build into a puppet show.
        const cap = Math.max(1, Math.ceil(scenes.length * Number(process.env.HF_CHARACTER_MAX_FRAC || 0.25)));
        if (!Array.isArray(plan.mgScenes)) plan.mgScenes = [];
        const covered = (st, en) => plan.mgScenes.some((m) => {
            const ms = _num(m.startTime), me = _num(m.endTime, ms + _num(m.duration));
            return Math.max(ms, st) < Math.min(me, en);
        });

        let rigged = 0, dropped = 0;
        for (const s of candidates) {
            if (rigged >= cap) break;
            const st = _num(s.startTime), en = _num(s.endTime, st + _num(s.duration));
            const dur = en - st;
            if (!(dur >= 1.5) || covered(st, en)) continue;
            const ns = `char${_num(s.index, rigged)}`;
            const caption = String(s.ideaLowerThird || '').trim().slice(0, 48)
                || String(s.text || '').trim().split(/\s+/).slice(0, 4).join(' ');
            const comp = buildCharacterComp({ ns, duration: dur, themeId, caption });
            if (!comp) { dropped++; continue; }
            if (validateComposition) {
                const v = validateComposition(comp, ns, dur, [], { type: 'character', text: caption, narration: s.text || '' });
                if (!v.ok) { dropped++; log(`  🧍 [Character MG] scene ${s.index} comp failed lint (${(v.errors || [])[0] || '?'}) — keeping fallback`); continue; }
            }
            plan.mgScenes.push({
                id: `character-${ns}`,
                type: 'character',
                startTime: st,
                endTime: en,
                duration: dur,
                sceneIndex: s.index,
                _authoredComposition: comp,
                _authoredNs: ns,
                _authoredAssets: [],
            });
            rigged++;
        }
        log(`  🧍 [Character MG] ${candidates.length} no-footage scene(s), ${rigged} rigged (lint-passed), ${dropped} dropped (cap ${cap})`);
        return { rigged, candidates: candidates.length, dropped };
    } catch (e) {
        log(`  🧍 [Character MG] skipped: ${String(e.message || e).slice(0, 100)}`);
        return { rigged: 0, failed: true };
    }
}

module.exports = { buildCharacterComp, authorCharacterScenes, isEnabled };
