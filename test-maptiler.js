/**
 * Quick MapTiler API test — run with: node test-maptiler.js
 * Tests different sizes, styles, and URL formats to find what works.
 */
require('dotenv').config();
const https = require('https');

const API_KEY = process.env.MAPTILER_API_KEY;
if (!API_KEY) {
    console.log('❌ No MAPTILER_API_KEY in .env');
    process.exit(1);
}
console.log(`🔑 API Key: ${API_KEY.substring(0, 8)}...`);

function testUrl(label, url) {
    return new Promise((resolve) => {
        const req = https.get(url, { timeout: 10000 }, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                const ok = res.statusCode === 200;
                const size = Buffer.byteLength(body);
                console.log(`  ${ok ? '✅' : '❌'} ${label}: HTTP ${res.statusCode} (${(size/1024).toFixed(0)} KB)`);
                if (!ok) {
                    // Show error body for diagnosis
                    try { const err = JSON.parse(body); console.log(`     Error: ${err.message || JSON.stringify(err)}`); } catch(e) { console.log(`     Body: ${body.substring(0, 200)}`); }
                }
                resolve(ok);
            });
        });
        req.on('error', (e) => {
            console.log(`  ❌ ${label}: ${e.message}`);
            resolve(false);
        });
        req.on('timeout', () => { req.destroy(); console.log(`  ❌ ${label}: timeout`); resolve(false); });
    });
}

async function run() {
    const lon = 0, lat = 30, zoom = 2;

    // Test 1: MapTiler (current)
    console.log('\n🗺️ Test 1: MapTiler');
    await testUrl('MapTiler', `https://api.maptiler.com/maps/streets-v2/static/${lon},${lat},${zoom}/512x512.png?key=${API_KEY}`);

    // Test 2: Geoapify (free, 3000/day, no credit card)
    const geoKey = process.env.GEOAPIFY_API_KEY || '';
    if (geoKey) {
        console.log(`\n🌍 Test 2: Geoapify (key: ${geoKey.substring(0,8)}...)`);
        const styles = ['osm-bright', 'dark-matter', 'osm-liberty', 'klokantech-basic', 'positron'];
        for (const style of styles) {
            await testUrl(style, `https://maps.geoapify.com/v1/staticmap?style=${style}&width=1920&height=1080&center=lonlat:${lon},${lat}&zoom=${zoom}&apiKey=${geoKey}`);
        }
        // Test sizes
        console.log('\n📐 Test 3: Geoapify sizes');
        const sizes = [[1920,1080], [1280,720], [800,450]];
        for (const [w,h] of sizes) {
            await testUrl(`${w}x${h}`, `https://maps.geoapify.com/v1/staticmap?style=dark-matter&width=${w}&height=${h}&center=lonlat:${lon},${lat}&zoom=${zoom}&apiKey=${geoKey}`);
        }
    } else {
        console.log('\n🌍 Test 2: Geoapify — no GEOAPIFY_API_KEY in .env');
        console.log('   Get a free key at: https://myprojects.geoapify.com/ (no credit card)');
    }

    console.log('\n✅ Done!');
}

run();
