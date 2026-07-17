#!/usr/bin/env node
/**
 * test-map-pipeline.js — Faithful, isolated test of the MAP intent pipeline.
 *
 * Runs the EXACT same map modules the app's build pipeline runs
 * (src/map-compiler.compileMapScenes → src/map-provider.downloadMapForMG),
 * on a deliberately hard "stress" scene, then dumps every piece of scene-intent
 * data the renderer would consume. Goal: confirm — BEFORE we build the new
 * HyperFrames map renderer — that the data layer actually produces:
 *   - mapMode inferred from narration (route vs region vs locator)
 *   - geocoded subjects (incl. straits / canals / seas, not just countries)
 *   - cameraPlan.stops (per-subject pan/zoom choreography)
 *   - OSM boundary polygons for water-bodies
 *   - a stitched basemap PNG
 *   - renderAssets (the self-contained snapshot the renderer reads)
 *
 * Usage:  node test-map-pipeline.js
 * Output: .tmp/map-test/  (mapscene.json + the stitched basemap PNG)
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '.tmp', 'map-test');
fs.mkdirSync(OUT_DIR, { recursive: true });

const { compileMapScenes } = require('./src/map-compiler');
const { downloadMapForMG } = require('./src/map-provider');

// ── Stress test scene: a Shanghai → Rotterdam shipping route that threads
// through the Bab el-Mandeb Strait and the Suez Canal. This exercises:
//   • route-mode inference from narration ("sail from ... to ... through ...")
//   • multi-subject camera choreography
//   • water-body subjects (strait + canal) that are NOT in the country GeoJSON
//     → forces the OSM boundary path the HyperFrames SVG map can't do today.
const SCENE = {
    index: 18,
    text: 'Every day, cargo ships sail from Shanghai all the way to Rotterdam, '
        + 'threading through the narrow Bab el-Mandeb Strait and then the Suez Canal '
        + 'before reaching Europe.',
    fullscreenMG: 'mapChart: Shanghai: label, Rotterdam: label, Bab el-Mandeb Strait: label, Suez Canal: label',
    mapVariant: 'route',
};

const SCRIPT_CONTEXT = {
    nicheId: 'news.economy',
    entities: ['Shanghai', 'Rotterdam', 'Bab el-Mandeb Strait', 'Suez Canal'],
    entityTypes: {
        'Shanghai': 'place',
        'Rotterdam': 'place',
        'Bab el-Mandeb Strait': 'place',
        'Suez Canal': 'place',
    },
};

const DISPOSITIONS = [{
    sceneIndex: 18,
    disposition: 'must_map',
    reason: 'global shipping route between two ports through chokepoints',
    signals: {
        spatialVerb: 'sail',
        matchedPlaces: ['Shanghai', 'Rotterdam', 'Bab el-Mandeb Strait', 'Suez Canal'],
    },
}];

function hr(t) { console.log('\n' + '─'.repeat(70) + '\n  ' + t + '\n' + '─'.repeat(70)); }
function ok(b) { return b ? '✅' : '❌'; }

(async () => {
    hr('STEP 1 — compileMapScenes (narration → MapScene intent)');
    const { compiled, skipped } = compileMapScenes([SCENE], SCRIPT_CONTEXT, DISPOSITIONS);
    if (skipped && skipped.length) console.log('  skipped:', JSON.stringify(skipped));
    if (!compiled || !compiled.length) {
        console.error('  ❌ Compiler produced no MapScene. Aborting.');
        process.exit(1);
    }
    const mapScene = compiled[0];
    SCENE._mapScene = mapScene;
    console.log(`  mapMode:    ${mapScene.mapMode}  (purpose: ${mapScene.mapPurpose})`);
    console.log(`  subjects:   ${mapScene.subjects.map(s => `${s.name}[${s.role}/${s.kind}]`).join(', ')}`);
    console.log(`  framing:    ${mapScene.cameraPlan && mapScene.cameraPlan.framing}`);
    console.log(`  stops:      ${mapScene.cameraPlan && mapScene.cameraPlan.stops ? mapScene.cameraPlan.stops.length : 'null (pre-provider)'}`);
    console.log(`  renderAssets (pre-provider): ${mapScene.renderAssets === null ? 'null (expected)' : 'present'}`);

    hr('STEP 2 — downloadMapForMG (geocode + camera stops + OSM + basemap)');
    const mg = {
        type: 'mapChart',
        subType: 'route',
        mapVariant: 'route',
        mapStyle: 'satellite',
        category: 'fullscreen',
        sceneIndex: 18,
        duration: 8,
        subtext: 'Shanghai: label, Rotterdam: label, Bab el-Mandeb Strait: label, Suez Canal: label',
        _mapScene: mapScene,
    };

    const t0 = Date.now();
    let result;
    try {
        result = await downloadMapForMG(mg, SCRIPT_CONTEXT, OUT_DIR, [SCENE]);
    } catch (err) {
        console.error('  ❌ downloadMapForMG threw:', err && err.stack || err);
        process.exit(1);
    }
    console.log(`  downloadMapForMG returned: ${result} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

    hr('STEP 3 — what the renderer would actually receive');
    const ra = mg._mapScene && mg._mapScene.renderAssets;
    const stops = mg._mapScene && mg._mapScene.cameraPlan && mg._mapScene.cameraPlan.stops;
    const osm = mg._osmBoundaries || (ra && ra.osmBoundaries) || [];
    const wps = mg._mapWaypoints || (ra && ra.waypoints) || [];
    const pins = (ra && ra.mapView && ra.mapView.pins) || [];
    const routeGeo = (ra && ra.routeGeometry) || [];

    console.log(`  ${ok(!!ra)} renderAssets populated`);
    console.log(`  ${ok(!!mg.mapImageFile)} basemap stitched → ${mg.mapImageFile || '(none)'}`);
    console.log(`  ${ok(stops && stops.length > 0)} cameraPlan.stops: ${stops ? stops.length : 0}`);
    if (stops) {
        for (const s of stops) {
            console.log(`        • ${String(s.label || s.subjectId || '?').padEnd(22)} `
                + `lon=${Number(s.lon).toFixed(2)} lat=${Number(s.lat).toFixed(2)} `
                + `z=${Number(s.zoom).toFixed(2)} t=[${Number(s.startTime).toFixed(1)}→${Number(s.endTime).toFixed(1)}]`);
        }
    }
    console.log(`  ${ok(pins.length > 0)} geocoded pins: ${pins.length}`);
    for (const p of pins) {
        console.log(`        📍 ${String(p.name).padEnd(22)} [${Number(p.lon).toFixed(2)}, ${Number(p.lat).toFixed(2)}] type=${p.type || '?'}`);
    }
    console.log(`  ${ok(osm.length > 0)} OSM boundary polygons: ${osm.length}`);
    for (const b of osm) {
        const rings = b.feature && b.feature.geometry
            ? (b.feature.geometry.type === 'Polygon'
                ? b.feature.geometry.coordinates.length
                : (b.feature.geometry.coordinates || []).length)
            : 0;
        const pts = b.feature && b.feature.geometry
            ? JSON.stringify(b.feature.geometry.coordinates).split('],').length
            : 0;
        console.log(`        🗺️  ${String(b.name).padEnd(22)} type=${b.feature && b.feature.geometry && b.feature.geometry.type} rings=${rings} ~pts=${pts}`);
    }
    console.log(`  ${ok(wps.length > 0)} waypoints (camera path): ${wps.length}`);
    console.log(`  ${ok(routeGeo.length > 0)} routeGeometry nodes: ${routeGeo.length}`);
    console.log(`  bigMapSize: ${ra && ra.bigMapSize ? `${ra.bigMapSize.w}x${ra.bigMapSize.h}` : '(none)'}`);

    hr('STEP 4 — dump artifacts');
    const dump = {
        mapMode: mg._mapScene.mapMode,
        mapPurpose: mg._mapScene.mapPurpose,
        subjects: mg._mapScene.subjects,
        cameraPlan: mg._mapScene.cameraPlan,
        annotationPlan: mg._mapScene.annotationPlan,
        renderAssets: mg._mapScene.renderAssets,
        mapImageFile: mg.mapImageFile,
        _osmBoundariesNames: osm.map(b => b.name),
    };
    const jsonPath = path.join(OUT_DIR, 'mapscene.json');
    fs.writeFileSync(jsonPath, JSON.stringify(dump, null, 2));
    console.log(`  wrote ${jsonPath}`);
    if (mg.mapImageFile) {
        const png = path.join(OUT_DIR, mg.mapImageFile);
        console.log(`  basemap PNG: ${png}`);
        console.log(`  (open it to confirm the geographic framing is correct)`);
    }

    hr('VERDICT');
    const dataRich = !!ra && !!mg.mapImageFile && stops && stops.length > 0 && osm.length > 0;
    if (dataRich) {
        console.log('  ✅ The intent pipeline produces rich data when the provider runs.');
        console.log('     → The gap is purely the HyperFrames RENDERER. Safe to build the port.');
    } else {
        console.log('  ⚠️ Some intent data is missing — see ❌ above. Renderer port alone');
        console.log('     would NOT be enough; the data pipeline needs a fix first.');
    }
    console.log('');
})();
