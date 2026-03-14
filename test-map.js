/**
 * Standalone Map Feature Test — run with: node test-map.js
 *
 * Tests:
 *   1. MapTiler tile stitching (primary — free tier tiles)
 *   2. Geoapify static map download (fallback)
 *   3. Entity extraction + view computation
 *   4. Saves test images to ./test-maps/ folder
 *
 * Usage:
 *   node test-map.js                    # Run all tests
 *   node test-map.js maptiler           # Test MapTiler tile stitching only
 *   node test-map.js geoapify           # Test Geoapify only
 *   node test-map.js entities           # Test entity/view logic only
 *   node test-map.js "United States"    # Download map for specific country (both providers)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');

const GEOAPIFY_KEY = process.env.GEOAPIFY_API_KEY || '';
const MAPTILER_KEY = process.env.MAPTILER_API_KEY || '';

const { computeMapView, GEO_COORDS, stitchMapTilerTiles, MAPTILER_STYLE_MAP, GEOAPIFY_STYLE_MAP } = require('./src/map-provider');

const OUT_DIR = path.join(__dirname, 'test-maps');

// ── Download helper ──
function download(url, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                download(res.headers.location, timeout).then(resolve, reject);
                return;
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
                const buf = Buffer.concat(chunks);
                resolve({ status: res.statusCode, buffer: buf, headers: res.headers });
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

// ── MapTiler tile stitching test ──
async function testMapTiler(entities = ['World'], styles = ['dark']) {
    if (!MAPTILER_KEY) {
        console.log('\n  No MAPTILER_API_KEY in .env — skipping');
        return;
    }
    console.log(`\n  Key: ${MAPTILER_KEY.substring(0, 8)}...`);

    const view = computeMapView(entities);
    console.log(`  View: center=[${view.lon.toFixed(1)}, ${view.lat.toFixed(1)}], zoom=${view.zoom}`);
    console.log(`  Entities: ${entities.join(', ')}`);

    for (const styleName of styles) {
        try {
            const t0 = Date.now();
            const buffer = await stitchMapTilerTiles(view, styleName, MAPTILER_KEY);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            const sizeKB = (buffer.length / 1024).toFixed(0);
            console.log(`  ✅ ${styleName}: ${sizeKB} KB (${elapsed}s)`);

            const entityTag = entities.join('-').replace(/\s+/g, '_');
            const filename = `maptiler-${styleName}-${entityTag}.png`;
            fs.writeFileSync(path.join(OUT_DIR, filename), buffer);
            console.log(`     Saved: test-maps/${filename}`);
        } catch (err) {
            console.log(`  ❌ ${styleName}: ${err.message}`);
        }
    }
}

// ── Geoapify static API test ──
async function testGeoapify(entities = ['World'], styles = ['dark']) {
    if (!GEOAPIFY_KEY) {
        console.log('\n  No GEOAPIFY_API_KEY in .env — skipping');
        console.log('  Get a free key: https://myprojects.geoapify.com/');
        return;
    }
    console.log(`\n  Key: ${GEOAPIFY_KEY.substring(0, 8)}...`);

    const view = computeMapView(entities);
    console.log(`  View: center=[${view.lon.toFixed(1)}, ${view.lat.toFixed(1)}], zoom=${view.zoom}`);
    console.log(`  Entities: ${entities.join(', ')}`);

    for (const styleName of styles) {
        const apiStyle = GEOAPIFY_STYLE_MAP[styleName] || styleName;
        const url = `https://maps.geoapify.com/v1/staticmap?style=${apiStyle}&width=1920&height=1080&center=lonlat:${view.lon},${view.lat}&zoom=${view.zoom}&apiKey=${GEOAPIFY_KEY}`;

        try {
            const t0 = Date.now();
            const { status, buffer } = await download(url);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            const sizeKB = (buffer.length / 1024).toFixed(0);
            const ok = status === 200 && buffer.length > 5000;
            console.log(`  ${ok ? '✅' : '❌'} ${styleName} (${apiStyle}): HTTP ${status}, ${sizeKB} KB (${elapsed}s)`);

            if (ok) {
                const entityTag = entities.join('-').replace(/\s+/g, '_');
                const filename = `geoapify-${styleName}-${entityTag}.png`;
                fs.writeFileSync(path.join(OUT_DIR, filename), buffer);
                console.log(`     Saved: test-maps/${filename}`);
            }
        } catch (err) {
            console.log(`  ❌ ${styleName}: ${err.message}`);
        }
    }
}

// ── Entity tests ──
function testEntities() {
    console.log('\n  Testing entity extraction & view computation:\n');

    const testCases = [
        { entities: ['United States'], expected: 'US centered' },
        { entities: ['China', 'Japan', 'South Korea'], expected: 'East Asia view' },
        { entities: ['Germany', 'France', 'Italy'], expected: 'Europe centered' },
        { entities: ['Brazil', 'Argentina', 'Chile'], expected: 'South America' },
        { entities: ['United States', 'China'], expected: 'Pacific view, zoomed out' },
        { entities: ['NonExistent', 'AlsoFake'], expected: 'World fallback' },
        { entities: [], expected: 'World default' },
        { entities: ['Singapore'], expected: 'Tight zoom on city-state' },
    ];

    for (const tc of testCases) {
        const view = computeMapView(tc.entities);
        console.log(`  ✅ [${tc.entities.join(', ') || '(empty)'}]`);
        console.log(`     → center=[${view.lon.toFixed(1)}, ${view.lat.toFixed(1)}], zoom=${view.zoom}  (${tc.expected})`);
    }

    console.log(`\n  Available regions: ${Object.keys(GEO_COORDS).length} entries`);
}

// ── Main ──
async function main() {
    const arg = process.argv[2] || 'all';
    if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

    console.log('╔══════════════════════════════════════════╗');
    console.log('║   Map Provider Test Suite                ║');
    console.log('║   MapTiler (tile stitch) + Geoapify      ║');
    console.log('╚══════════════════════════════════════════╝');

    // Check if arg is a country name
    if (GEO_COORDS[arg]) {
        console.log(`\n🗺️ Testing map for: ${arg}`);
        console.log('\n── MapTiler (tile stitching) ──');
        await testMapTiler([arg], ['dark', 'political']);
        console.log('\n── Geoapify (static API) ──');
        await testGeoapify([arg], ['dark', 'political']);
        console.log('\n  Compare the images in test-maps/ to see which you prefer!');
        return;
    }

    if (arg === 'all' || arg === 'entities') {
        console.log('\n── Entity & View Tests ──');
        testEntities();
    }

    if (arg === 'all' || arg === 'maptiler') {
        console.log('\n── MapTiler Tile Stitching ──');
        const allStyles = Object.keys(MAPTILER_STYLE_MAP);
        console.log(`  Testing all ${allStyles.length} styles...`);
        await testMapTiler(['World'], allStyles);

        console.log('\n  Testing with country focus...');
        await testMapTiler(['Germany', 'France', 'Italy'], ['dark']);
        await testMapTiler(['United States'], ['dark', 'political']);
    }

    if (arg === 'all' || arg === 'geoapify') {
        console.log('\n── Geoapify Static API ──');
        await testGeoapify(['World'], ['dark', 'light', 'political']);
        await testGeoapify(['United States'], ['dark']);
    }

    console.log('\n══════════════════════════════════════════');
    console.log(`Test images saved to: ${OUT_DIR}/`);
    console.log('══════════════════════════════════════════\n');
}

main().catch(err => console.error('Fatal:', err));
