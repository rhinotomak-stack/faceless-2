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
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    const signal = opts.signal;
    const assertNotCancelled = () => {
        if (signal?.aborted) throw new Error('Cancelled');
    };

    // Dry run: describe what WOULD be generated (the default + what tests use).
    if (!opts.generate) {
        return prompts.map((p) => ({ sceneIndex: p.sceneIndex, prompt: p.prompt, file: null, durationSec: durOf(p.sceneIndex), dryRun: true }));
    }

    // Real generation — lazy require so dry runs/tests never load browser/API engines.
    const crypto = require('crypto');
    const path = require('path');
    const selectedBackend = ['veo-fal', 'veo-gemini'].includes(String(opts.backend || '').toLowerCase())
        ? String(opts.backend).toLowerCase()
        : 'kling';
    const providerName = selectedBackend === 'kling' ? 'Kling' : 'Veo';
    const provider = selectedBackend === 'kling'
        ? require('../../media/providers/kling-video-browser')
        : require('../../media/providers/veo-video');
    const enabled = selectedBackend === 'kling' ? provider.isEnabled() : provider.isEnabled();
    if (!enabled) {
        throw new Error(selectedBackend === 'kling'
            ? 'Kling is not ready. Run npm run kling-cookies and sign in before generating.'
            : 'Veo is not ready. Add VEO_API_KEY for the selected Veo backend.');
    }

    const outDir = opts.outDir || process.cwd();
    const out = [];
    for (let i = 0; i < prompts.length; i++) {
        assertNotCancelled();
        const p = prompts[i];
        const cacheKey = crypto.createHash('sha256')
            .update(JSON.stringify({
                prompt: p.prompt,
                backend: selectedBackend,
                resolution: opts.resolution || '720p',
                aspectRatio,
                durationSec: durOf(p.sceneIndex),
            }))
            .digest('hex')
            .slice(0, 14);
        const outFile = path.join(outDir, `ai-video-scene-${p.sceneIndex}-${cacheKey}.mp4`);
        let file = null;
        let error = null;
        onProgress({
            completed: i,
            total: prompts.length,
            sceneIndex: p.sceneIndex,
            message: `${providerName}: generating scene ${i + 1}/${prompts.length}`,
        });
        try {
            if (selectedBackend === 'kling') {
                file = await provider.generateVideoClip({
                    prompt: p.prompt,
                    outFile,
                    durationSec: durOf(p.sceneIndex),
                    aspectRatio,
                    log,
                });
            } else {
                file = await provider.generateVeoClip({
                    prompt: p.prompt,
                    outFile,
                    durationSec: durOf(p.sceneIndex),
                    aspectRatio,
                    resolution: opts.resolution || '720p',
                    signal,
                    log,
                });
            }
            assertNotCancelled();
        } catch (e) {
            if (signal?.aborted || e?.message === 'Cancelled' || e?.message === 'aborted') throw new Error('Cancelled');
            error = e.message || String(e);
            log(`  [AI Videos] scene ${p.sceneIndex} generation failed (${error})`);
        }
        out.push({
            sceneIndex: p.sceneIndex,
            prompt: p.prompt,
            file,
            durationSec: durOf(p.sceneIndex),
            dryRun: false,
            backend: selectedBackend,
            error,
        });
        onProgress({
            completed: i + 1,
            total: prompts.length,
            sceneIndex: p.sceneIndex,
            message: file
                ? `${providerName}: scene ${i + 1}/${prompts.length} ready`
                : `${providerName}: scene ${i + 1}/${prompts.length} failed`,
        });
    }
    return out;
}

module.exports = { generateClips };
