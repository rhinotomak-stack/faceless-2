// src/categories/ai-videos/generate.js
// ============================================================================
// Stage 4 of the AI Videos pipeline: generate one clip per prompt.
//
// DRY-RUN by default — returns clip descriptors WITHOUT calling the generator, so
// the pipeline runs end-to-end (and is unit-tested) with no credits, no browser, no
// login. Real generation runs only with opts.generate === true, reusing the existing
// Kling browser engine (src/media/providers/kling-video-browser). The heavy engine is
// lazily required only on the real path, so dry-run / tests never load it.
// ============================================================================
'use strict';

async function generateClips(ctx, opts = {}) {
    const prompts = (ctx && ctx.prompts) ? ctx.prompts : [];
    const scenes = (ctx && ctx.scenes) ? ctx.scenes : [];
    const durOf = (i) => { const s = scenes.find((x) => x.index === i); return s ? s.duration : 5; };
    const aspectRatio = opts.aspectRatio || '16:9';
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);

    // Dry run: describe what WOULD be generated (the default + what tests use).
    if (!opts.generate) {
        return prompts.map((p) => ({ sceneIndex: p.sceneIndex, prompt: p.prompt, file: null, durationSec: durOf(p.sceneIndex), dryRun: true }));
    }

    // Real generation — lazy require so nothing loads the browser engine unless asked.
    const path = require('path');
    const kling = require('../../media/providers/kling-video-browser');
    const outDir = opts.outDir || process.cwd();
    const out = [];
    for (const p of prompts) {
        const outFile = path.join(outDir, `ai-video-scene-${p.sceneIndex}.mp4`);
        let file = null;
        try {
            file = await kling.generateVideoClip({ prompt: p.prompt, outFile, durationSec: durOf(p.sceneIndex), aspectRatio, log });
        } catch (e) {
            log(`  [AI Videos] scene ${p.sceneIndex} generation failed (${e.message}) — leaving empty for fallback`);
        }
        out.push({ sceneIndex: p.sceneIndex, prompt: p.prompt, file, durationSec: durOf(p.sceneIndex), dryRun: false });
    }
    return out;
}

module.exports = { generateClips };
