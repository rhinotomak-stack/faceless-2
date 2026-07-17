/**
 * Motion Graphics Worker
 *
 * Thin wrapper around the existing ai-motion-graphics.js module. Lets the
 * Editor Agent CEO own the MG batch call so build-video.js doesn't run
 * processMotionGraphics directly when EDITOR_AGENT=true.
 *
 * Why a wrapper instead of a full reimplementation:
 *   - ai-motion-graphics.js already encodes the niche-aware MG selection
 *     logic, format rules, registry knowledge, and instruction parsing.
 *   - Rebuilding all of that from scratch would multiply work without
 *     adding value — the editorial AI is already there.
 *   - The wrapper's job is to inject the agent's per-scene context
 *     (scene._editorAgent.framing) so MG placement is aware of which
 *     scenes are floating cards (less space for overlays), which are
 *     fullscreen (room for big MGs), etc.
 */

const { processMotionGraphics } = require('../ai-motion-graphics');

function _framingHintForMGs(scenes) {
    // Build a one-paragraph summary of the agent's framing decisions so
    // the MG selector can be aware. Keeps it short — long context bloats
    // every per-scene prompt.
    const counts = { fullscreen: 0, cinematic: 0, floating: 0, other: 0 };
    for (const s of scenes) {
        const f = s?._editorAgent?.framing?.framing || s?.framing || 'fullscreen';
        if (counts[f] != null) counts[f]++;
        else counts.other++;
    }
    const floatingIdxs = scenes
        .filter(s => (s?._editorAgent?.framing?.framing || s?.framing) === 'floating')
        .map(s => s.index)
        .slice(0, 12);
    const cinematicIdxs = scenes
        .filter(s => (s?._editorAgent?.framing?.framing || s?.framing) === 'cinematic')
        .map(s => s.index)
        .slice(0, 12);
    const lines = [];
    lines.push(`[EDITOR AGENT FRAMING CONTEXT]`);
    lines.push(`Framing breakdown: ${counts.fullscreen} fullscreen, ${counts.cinematic} cinematic, ${counts.floating} floating.`);
    if (floatingIdxs.length) lines.push(`Floating scenes (compact card on canvas; prefer compact MGs or no overlay): ${floatingIdxs.join(', ')}`);
    if (cinematicIdxs.length) lines.push(`Cinematic scenes (pulled-back clip with backdrop; mid-weight MGs OK): ${cinematicIdxs.join(', ')}`);
    return lines.join('\n');
}

async function runMotionGraphicsWorker(scenes, scriptContext, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    const startedAt = Date.now();
    log(`  🎨 [MG Worker] dispatching ${scenes.length} scenes to processMotionGraphics`);

    // Inject agent framing context into the MG instructions so the AI MG
    // selector understands which scenes have constrained layout (floating).
    const framingHint = _framingHintForMGs(scenes);
    const baseInstructions = String(opts.aiInstructions || '').trim();
    const enrichedInstructions = baseInstructions
        ? `${baseInstructions}\n\n${framingHint}`
        : framingHint;

    let result = null;
    try {
        result = await processMotionGraphics(scenes, scriptContext, null, enrichedInstructions);
    } catch (e) {
        log(`  ⚠️ [MG Worker] processMotionGraphics threw — ${e.message?.slice(0, 120)}`);
        return { ok: false, error: e?.message || String(e), result: null };
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const mgsCount = Array.isArray(result?.motionGraphics) ? result.motionGraphics.length : (Array.isArray(result) ? result.length : 0);
    log(`  ✅ [MG Worker] done in ${elapsed}s → ${mgsCount} MGs placed`);
    return { ok: true, result };
}

module.exports = { runMotionGraphicsWorker };
