/**
 * Explainer Images Worker
 *
 * Thin wrapper around explainer-image-provider.downloadExplainerImages.
 * Receives the explainerImage MGs produced by the MG worker and downloads
 * the supporting reference images for each.
 */

const { downloadExplainerImages } = require('../../media/explainer-image-provider');

async function runExplainerImagesWorker(explainerMGs, scriptContext, tempDir, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    if (!Array.isArray(explainerMGs) || explainerMGs.length === 0) {
        return { ok: true, count: 0 };
    }
    const startedAt = Date.now();
    log(`  🖼️ [Explainer Worker] downloading reference images for ${explainerMGs.length} explainer MGs`);

    let count = 0;
    try {
        count = await downloadExplainerImages(explainerMGs, tempDir, scriptContext);
    } catch (e) {
        log(`  ⚠️ [Explainer Worker] downloadExplainerImages threw — ${e.message?.slice(0, 120)}`);
        return { ok: false, error: e?.message || String(e), count: 0 };
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`  ✅ [Explainer Worker] done in ${elapsed}s → ${count} explainer images`);
    return { ok: true, count };
}

module.exports = { runExplainerImagesWorker };
