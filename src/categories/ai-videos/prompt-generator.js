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

function _buildPrompt(sceneText, opts = {}) {
    const subject = String(sceneText || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const style = (opts.style || DEFAULT_STYLE).trim();
    // Visual B-roll OF the beat, not a literal reading of it.
    return `Cinematic B-roll depicting: ${subject}. ${style}. ${NEGATIVE}.`;
}

// ctx (with ctx.scenes) → prompts[]: { sceneIndex, prompt }.
function generateScenePrompts(ctx, opts = {}) {
    return (ctx && ctx.scenes ? ctx.scenes : []).map((s) => ({
        sceneIndex: s.index,
        prompt: _buildPrompt(s.text, opts),
    }));
}

module.exports = { generateScenePrompts, _buildPrompt, DEFAULT_STYLE };
