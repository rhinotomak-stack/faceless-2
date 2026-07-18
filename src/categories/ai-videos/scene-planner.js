// src/categories/ai-videos/scene-planner.js
// ============================================================================
// Stage 2 of the AI Videos pipeline: split the normalized script into SCENE BEATS
// — one generated clip per beat. Deterministic by default (sentence-grouped to a
// target on-screen size), so it's pure + unit-testable with no AI. An AI splitter
// can be dropped in later behind the same planScenes() signature (that's a "tweak",
// not a rewrite).
// ============================================================================
'use strict';

const TARGET_WORDS_PER_SCENE = 24; // ~ a single clip's worth of narration/on-screen text
const MIN_WORDS_PER_SCENE = 6;     // avoid choppy micro-clips — merge tiny tails
const WORDS_PER_SEC = 2.6;         // rough narration pace → per-scene duration estimate
const MIN_SCENE_SEC = 2;
const MAX_SCENE_SEC = 8;

// Split text into sentences (keeping the terminator), then greedily group them up to
// ~TARGET_WORDS_PER_SCENE so each scene is one coherent beat.
function _sentences(text) {
    return String(text || '')
        .replace(/\s+/g, ' ')
        .match(/[^.!?]+[.!?]*/g) || [];
}
function _wc(s) { return s.split(/\s+/).filter(Boolean).length; }

function _chunk(paragraph) {
    const out = [];
    let buf = '';
    for (const sentRaw of _sentences(paragraph)) {
        const sent = sentRaw.trim();
        if (!sent) continue;
        const candidate = buf ? `${buf} ${sent}` : sent;
        if (buf && _wc(candidate) > TARGET_WORDS_PER_SCENE) {
            out.push(buf);
            buf = sent;
        } else {
            buf = candidate;
        }
    }
    if (buf) out.push(buf);
    // merge a too-small trailing chunk back into the previous one
    if (out.length > 1 && _wc(out[out.length - 1]) < MIN_WORDS_PER_SCENE) {
        out[out.length - 2] = `${out[out.length - 2]} ${out.pop()}`;
    }
    return out;
}

// ctx (from pipeline) → scenes[]. Each scene: { index, text, startTime, duration }.
function planScenes(ctx, opts = {}) {
    const paras = (ctx && ctx.paragraphs && ctx.paragraphs.length)
        ? ctx.paragraphs
        : (ctx && ctx.scriptText ? [ctx.scriptText] : []);
    const scenes = [];
    let idx = 0, t = 0;
    for (const para of paras) {
        for (const text of _chunk(para)) {
            const dur = Math.min(MAX_SCENE_SEC, Math.max(MIN_SCENE_SEC, Math.round(_wc(text) / WORDS_PER_SEC)));
            scenes.push({ index: idx, text: text.trim(), startTime: t, duration: dur });
            t += dur;
            idx++;
        }
    }
    return scenes;
}

module.exports = { planScenes, TARGET_WORDS_PER_SCENE };
