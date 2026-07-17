/**
 * keyword-glow.js — word-synced keyword emphasis overlay (OPENMONTAGE-BORROW-PLAN #18).
 *
 * A short keyword/phrase pops + glows over the footage on the exact word that
 * names it (WhisperX word timings), then fades. Sparse and MOTIVATED — like the
 * icon-director, used everywhere it is noise; used on a key term it lands.
 *
 * DETERMINISTIC (no AI call): picks Director-tagged entities (scriptContext.entities)
 * that actually appear in a footage scene's narration. Sets scene._keywordGlow =
 * [{phrase, at, dur, position}] which the bridge renders inside the scene wrap.
 *
 * OPT-IN: HF_KEYWORD_GLOW=1 (default OFF → no field set → render byte-identical).
 */
'use strict';

function isEnabled() {
    // OPT-IN — unset/OFF must mean OFF (do NOT mirror icon-director's isDisabled()).
    return /^(1|true|on|yes)$/i.test(String(process.env.HF_KEYWORD_GLOW || '').trim());
}

const toSec = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
const isFootage = (s) => s && s.mediaFile && !s.isMGScene && !s.fullscreenMG && !s.templateType
    && s.mediaType !== 'none' && Array.isArray(s.words) && s.words.length >= 4
    && (!s.trackId || s.trackId === 'video-track-1');

function _entityList(scriptContext) {
    const raw = (scriptContext && scriptContext.entities) || [];
    const out = [];
    for (const e of raw) {
        const name = typeof e === 'string' ? e : (e && (e.name || e.text || e.value || e.label));
        const s = String(name || '').trim();
        // Usable glow phrases: 1-3 words, not trivially short.
        if (s && s.length >= 3 && s.split(/\s+/).length <= 3) out.push(s);
    }
    return [...new Set(out)];
}

/**
 * @param {object} plan  video-plan.json (mutated: sets scene._keywordGlow)
 * @param {object} opts  { log }
 * @returns {{decided:number, scenes:number, skipped?:boolean, reused?:boolean, failed?:boolean}}
 */
function directKeywordGlow(plan, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    if (!isEnabled()) return { decided: 0, skipped: true };
    try {
        const scenes = (plan && Array.isArray(plan.scenes)) ? plan.scenes : [];
        const footage = scenes.filter(isFootage);
        if (footage.length < 2) return { decided: 0, skipped: true, scenes: footage.length };

        // OPEN-MODE reuse: a saved plan already carries decisions → don't recompute.
        if (scenes.some((s) => Array.isArray(s._keywordGlow))) {
            const n = scenes.reduce((a, s) => a + (Array.isArray(s._keywordGlow) ? s._keywordGlow.length : 0), 0);
            log(`  ✨ [Keyword Glow] reused from saved project (${n} glow(s), 0 recompute)`);
            return { decided: n, scenes: footage.length, reused: true };
        }

        const entities = _entityList(plan.scriptContext);
        const MIN_GAP = Number(process.env.HF_KEYWORD_GLOW_GAP_SEC || 8);
        const cap = Math.max(1, Math.ceil(footage.length * Number(process.env.HF_KEYWORD_GLOW_MAX_FRAC || 0.25)));
        let decided = 0;
        let lastGlowAbs = -Infinity;

        for (const scene of footage) {
            scene._keywordGlow = []; // set on every footage scene so open-mode reuse is reliable
            if (decided >= cap || !entities.length) continue;
            const sceneStart = toSec(scene.startTime);
            const sceneEnd = toSec(scene.endTime, sceneStart + toSec(scene.duration));
            const dur = Math.max(0, sceneEnd - sceneStart);
            if (dur < 2) continue;
            const textLow = String(scene.text || '').toLowerCase();
            const words = scene.words;

            // First Director entity that actually appears in this scene's narration.
            let picked = null;
            for (const ent of entities) {
                const entLow = ent.toLowerCase();
                if (!textLow.includes(entLow)) continue;
                const firstTok = entLow.split(/\s+/)[0].replace(/[^\p{L}\p{N}]/gu, '');
                const w = words.find((ww) => String(ww.word || ww.text || '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '') === firstTok);
                const wStart = w ? toSec(w.start, toSec(w.startTime)) : NaN;
                const atAbs = Number.isFinite(wStart) ? wStart : sceneStart + 0.5;
                picked = { phrase: ent, atAbs };
                break;
            }
            if (!picked) continue;
            if (picked.atAbs - lastGlowAbs < MIN_GAP) continue; // density budget across the video

            const at = Math.max(0.15, Math.min(dur - 1.2, picked.atAbs - sceneStart));
            const glowDur = Math.min(2.2, Math.max(1.2, dur - at - 0.3));
            if (glowDur < 1.0) continue;
            scene._keywordGlow = [{ phrase: picked.phrase, at: +at.toFixed(2), dur: +glowDur.toFixed(2), position: 'lower-center' }];
            decided++;
            lastGlowAbs = picked.atAbs;
        }

        log(`  ✨ [Keyword Glow] ${decided} glow(s) placed across ${footage.length} footage scene(s) (cap ${cap}, ≥${MIN_GAP}s apart)`);
        return { decided, scenes: footage.length };
    } catch (e) {
        log(`  ⚠️ [Keyword Glow] skipped: ${String(e.message || e).slice(0, 100)}`);
        return { decided: 0, failed: true };
    }
}

module.exports = { directKeywordGlow, isEnabled };
