/**
 * Editor Agent — Transitions worker.
 *
 * Owns scene-to-scene transition decisions, moved out of the AI Director.
 * Runs ONCE over the whole scene list at the end of the Editor Agent pass —
 * AFTER framing is stamped — so it sees each scene's final framing and can be
 * made framing-aware over time.
 *
 * For now it reuses the Director's algorithmic assignTransitions (theme-aware
 * 70/30 rule, zero AI cost) but as the EDITOR's responsibility: the Director
 * defers to this when EDITOR_AGENT=true (see ai-director.js).
 *
 * assignTransitions stamps `scene.transition = { type, duration }` on each scene,
 * which flows into video-plan.json → the HyperFrames bridge (transition overlays).
 */
async function runTransitionsWorker(scenes, scriptContext = {}, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    if (!Array.isArray(scenes) || scenes.length === 0) {
        return { ok: true, result: null };
    }

    // Lazy require — ai-director is heavy and already loaded by build-video;
    // requiring it lazily avoids any load-order surprises.
    let assignTransitions;
    try {
        ({ assignTransitions } = require('../ai-director'));
    } catch (e) {
        log(`  ⚠️ [Transitions Worker] could not load assignTransitions — ${e.message?.slice(0, 120)}`);
        return { ok: false, error: e?.message || String(e) };
    }
    if (typeof assignTransitions !== 'function') {
        log('  ⚠️ [Transitions Worker] assignTransitions not available');
        return { ok: false, error: 'assignTransitions not a function' };
    }

    try {
        assignTransitions(scenes, scriptContext);
        const counts = {};
        for (const s of scenes) {
            const t = (s && s.transition && s.transition.type) || 'cut';
            counts[t] = (counts[t] || 0) + 1;
        }
        const summary = Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}=${v}`)
            .join(', ');
        log(`  🎬 [Transitions Worker] assigned ${scenes.length} scene transitions: ${summary}`);
        return { ok: true, result: { counts } };
    } catch (e) {
        log(`  ⚠️ [Transitions Worker] failed — ${e.message?.slice(0, 120)}`);
        return { ok: false, error: e?.message || String(e) };
    }
}

module.exports = { runTransitionsWorker };
