// src/categories/ai-videos/prompt-generator.js
// ============================================================================
// Stage 3 of the AI Videos pipeline: turn each scene's narration text into a
// text-to-video GENERATION PROMPT for the Kling/Veo engine. Deterministic template
// by default (pure, unit-testable). An AI prompt-writer can replace _buildPrompt()
// later behind the same signature — a "tweak", not a rewrite.
// ============================================================================
'use strict';

// A neutral cinematic base style; a per-video style can override via opts.style.
const DEFAULT_STYLE = 'cinematic realistic footage, natural lighting, shallow depth of field, smooth camera motion';
// Things a generator should never render for B-roll.
const NEGATIVE = 'no on-screen text, no captions, no watermark, no logo';

function _clean(value, limit = 300) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function _styleFromOptions(opts = {}) {
    if (_clean(opts.style)) return _clean(opts.style, 500);
    const themeId = _clean(opts.themeId, 80);
    if (themeId && themeId !== 'auto') {
        try {
            const theme = require('../../data/themes').getTheme(themeId);
            if (theme?.description) return `${theme.description}; ${DEFAULT_STYLE}`;
        } catch (_) { }
    }
    const themeLabel = _clean(opts.themeLabel, 120);
    return themeLabel && !/^auto/i.test(themeLabel)
        ? `${themeLabel}; ${DEFAULT_STYLE}`
        : DEFAULT_STYLE;
}

function _buildPrompt(sceneText, opts = {}) {
    const subject = _clean(sceneText, 320);
    const style = _styleFromOptions(opts);
    const context = [];
    const title = _clean(opts.videoTitle, 160);
    const niche = _clean(opts.nicheLabel || opts.nicheId, 120);
    const instructions = _clean(opts.aiInstructions, 420);
    if (title) context.push(`Overall story: ${title}`);
    if (niche && niche !== 'auto' && !/^auto/i.test(niche)) context.push(`Editorial category: ${niche}`);
    if (instructions) context.push(`Creator direction: ${instructions}`);
    // Visual B-roll OF the beat, not a literal reading of it.
    return `Cinematic B-roll depicting: ${subject}. ${context.join('. ')}${context.length ? '. ' : ''}${style}. ${NEGATIVE}.`;
}

// ctx (with ctx.scenes) → prompts[]: { sceneIndex, prompt }.
function generateScenePrompts(ctx, opts = {}) {
    return (ctx && ctx.scenes ? ctx.scenes : []).map((s) => ({
        sceneIndex: s.index,
        prompt: _buildPrompt(s.text, opts),
    }));
}

module.exports = { generateScenePrompts, _buildPrompt, _styleFromOptions, DEFAULT_STYLE };
