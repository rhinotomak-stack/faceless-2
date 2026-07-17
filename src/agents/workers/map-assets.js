/**
 * Map Assets Worker
 *
 * Thin wrapper around map-provider.downloadMapsForMGs. Handles map
 * background tile stitching + waypoint icon downloads for mapChart MGs.
 *
 * Runs after MG worker so it has access to all mapChart MGs produced.
 */

const { downloadMapsForMGs } = require('../../map/map-provider');

async function runMapAssetsWorker(allMGs, scriptContext, tempDir, allScenes, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    const mapMGs = (allMGs || []).filter(mg => mg && (mg.type === 'mapChart' || mg.type === 'map'));
    if (mapMGs.length === 0) {
        return { ok: true, count: 0 };
    }
    const startedAt = Date.now();
    log(`  🗺️ [Map Worker] downloading map tiles + icons for ${mapMGs.length} map MGs`);

    let count = 0;
    try {
        count = await downloadMapsForMGs(allMGs, scriptContext, tempDir, allScenes);
    } catch (e) {
        log(`  ⚠️ [Map Worker] downloadMapsForMGs threw — ${e.message?.slice(0, 120)}`);
        return { ok: false, error: e?.message || String(e), count: 0 };
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`  ✅ [Map Worker] done in ${elapsed}s → ${count} map assets`);
    return { ok: true, count };
}

module.exports = { runMapAssetsWorker };
