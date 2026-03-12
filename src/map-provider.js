/**
 * Map Provider — Downloads static map images from MapTiler API
 * Free tier: 100K requests/month. Provides styled map tiles as PNG images.
 *
 * Usage: downloadMapForMG(mg, scriptContext, tempDir) → saves PNG, sets mg.mapImageFile
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('./config');

// MapTiler static map styles (match MAP_STYLE_NAMES in ai-motion-graphics.js)
const MAPTILER_STYLE_MAP = {
    dark:      'dataviz-dark',
    natural:   'outdoor-v2',
    satellite: 'satellite',
    light:     'dataviz-light',
    political: 'streets-v2',
};

// Country/region center coordinates [lon, lat] + zoom level hints
const GEO_COORDS = {
    'China': [104, 35, 4], 'United States': [-98, 39, 3.5], 'USA': [-98, 39, 3.5], 'US': [-98, 39, 3.5],
    'India': [78, 22, 4], 'Japan': [138, 36, 5], 'Germany': [10.5, 51.2, 5.5],
    'United Kingdom': [-2, 54, 5], 'UK': [-2, 54, 5], 'France': [2.2, 46.2, 5.5],
    'Brazil': [-51, -10, 3.5], 'Italy': [12.5, 42.5, 5.5], 'Canada': [-106, 56, 3],
    'Russia': [100, 60, 2.5], 'South Korea': [128, 36, 6], 'Australia': [134, -25, 3.5],
    'Spain': [-3.7, 40.4, 5.5], 'Mexico': [-102, 23, 4.5], 'Indonesia': [118, -2, 4],
    'Norway': [9, 62, 4.5], 'Turkey': [35, 39, 5.5], 'Saudi Arabia': [45, 24, 5],
    'South Africa': [25, -29, 5], 'Argentina': [-64, -34, 3.5], 'Nigeria': [8, 10, 5],
    'Egypt': [30, 27, 5.5], 'Thailand': [101, 15, 5.5], 'Vietnam': [108, 16, 5.5],
    'Taiwan': [121, 24, 7], 'Pakistan': [70, 30, 5], 'Philippines': [122, 13, 5.5],
    'Iran': [53, 32, 5], 'Iraq': [44, 33, 5.5], 'Israel': [35, 31.5, 7],
    'Ukraine': [32, 49, 5], 'Poland': [20, 52, 5.5], 'Sweden': [16, 62, 4.5],
    'Singapore': [104, 1.3, 10], 'Malaysia': [102, 4, 5.5], 'Colombia': [-74, 4, 5],
    'Chile': [-71, -33, 4], 'Peru': [-76, -10, 5], 'Venezuela': [-66, 8, 5.5],
    'Algeria': [3, 28, 4.5], 'Libya': [18, 27, 5], 'Morocco': [-6, 32, 5.5],
    'Kenya': [38, 0, 5.5], 'Ethiopia': [39, 9, 5], 'Tanzania': [35, -6, 5.5],
    'Congo': [25, -3, 5], 'Angola': [18, -12, 5], 'Ghana': [-1.5, 8, 6],
    'Afghanistan': [66, 34, 5.5], 'Bangladesh': [90, 24, 6.5],
    'North Korea': [127, 40, 6], 'Myanmar': [96, 20, 5.5],
    'New Zealand': [174, -41, 5], 'Finland': [26, 64, 5],
    'Greece': [22, 39, 6], 'Portugal': [-8, 39.5, 6],
    'Netherlands': [5, 52, 7], 'Belgium': [4.4, 50.8, 7],
    'Switzerland': [8.2, 46.8, 7], 'Austria': [14.5, 47.5, 6.5],
    'Czech Republic': [15.5, 49.8, 6.5], 'Romania': [25, 46, 6],
    'Hungary': [19, 47, 6.5], 'Denmark': [10, 56, 6],
    'Cuba': [-79, 22, 6.5], 'Jamaica': [-77, 18, 8],
    'Qatar': [51, 25.3, 8], 'UAE': [54, 24, 6.5], 'Kuwait': [48, 29.5, 8],
    'Oman': [57, 21, 6], 'Yemen': [48, 15.5, 6], 'Jordan': [36, 31, 7],
    'Lebanon': [35.8, 33.9, 8], 'Syria': [38, 35, 6.5],
    'Europe': [15, 50, 3.5], 'Asia': [90, 35, 2], 'Africa': [20, 5, 2.5],
    'Middle East': [45, 28, 4], 'South America': [-60, -15, 2.5],
    'North America': [-100, 45, 2.5], 'World': [0, 20, 1],
};

/**
 * Download a file via HTTPS, following redirects. Returns Buffer.
 */
function httpsDownload(url, timeout = 15000) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, { timeout }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                httpsDownload(res.headers.location, timeout).then(resolve, reject);
                return;
            }
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode} for ${url}`));
                res.resume();
                return;
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });
}

/**
 * Compute map center and zoom from a list of entity names.
 * If multiple entities, computes bounding box center + appropriate zoom.
 * @param {string[]} entities - Array of location/country names
 * @returns {{ lon: number, lat: number, zoom: number }}
 */
function computeMapView(entities) {
    const coords = entities
        .map(e => GEO_COORDS[e])
        .filter(Boolean);

    if (coords.length === 0) {
        return { lon: 0, lat: 20, zoom: 1.5 }; // World view fallback
    }

    if (coords.length === 1) {
        return { lon: coords[0][0], lat: coords[0][1], zoom: coords[0][2] || 5 };
    }

    // Bounding box of all entities
    let minLon = Infinity, maxLon = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;
    for (const [lon, lat] of coords) {
        minLon = Math.min(minLon, lon);
        maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
    }

    const centerLon = (minLon + maxLon) / 2;
    const centerLat = (minLat + maxLat) / 2;

    // Estimate zoom from span (rough heuristic)
    const lonSpan = maxLon - minLon;
    const latSpan = maxLat - minLat;
    const maxSpan = Math.max(lonSpan, latSpan);

    let zoom;
    if (maxSpan > 200) zoom = 1;
    else if (maxSpan > 100) zoom = 1.5;
    else if (maxSpan > 60) zoom = 2;
    else if (maxSpan > 30) zoom = 3;
    else if (maxSpan > 15) zoom = 4;
    else if (maxSpan > 8) zoom = 5;
    else if (maxSpan > 4) zoom = 6;
    else zoom = 7;

    return { lon: centerLon, lat: centerLat, zoom };
}

/**
 * Build MapTiler static map URL.
 * @param {{ lon, lat, zoom }} view - Map center and zoom
 * @param {string} mapStyle - One of: dark, natural, satellite, light, political
 * @param {string} apiKey - MapTiler API key
 * @returns {string} URL for 1920x1080 PNG
 */
function buildMapUrl(view, mapStyle, apiKey) {
    const style = MAPTILER_STYLE_MAP[mapStyle] || MAPTILER_STYLE_MAP.dark;
    const w = 1920;
    const h = 1080;
    // MapTiler free tier: max 2048px per dimension, no @2x
    return `https://api.maptiler.com/maps/${style}/static/${view.lon},${view.lat},${view.zoom}/${w}x${h}.png?key=${apiKey}`;
}

/**
 * Extract entity names from an MG scene + scriptContext.
 */
function extractEntities(mg, scriptContext) {
    let entities = [];

    // From scriptContext.entities
    if (scriptContext?.entities) {
        entities = [...scriptContext.entities];
    }

    // Also scan mg.text and mg.subtext for known location names
    const textToScan = `${mg.text || ''} ${mg.subtext || ''}`;
    for (const name of Object.keys(GEO_COORDS)) {
        if (name.length > 2 && textToScan.toLowerCase().includes(name.toLowerCase())) {
            if (!entities.includes(name)) entities.push(name);
        }
    }

    return entities;
}

/**
 * Download a static map image for a mapChart MG.
 * Saves to tempDir, sets mg.mapImageFile with the filename.
 *
 * @param {object} mg - The mapChart MG object
 * @param {object} scriptContext - Script context with entities
 * @param {string} tempDir - Directory to save the image
 * @returns {Promise<boolean>} true if downloaded successfully
 */
async function downloadMapForMG(mg, scriptContext, tempDir) {
    const apiKey = config.maptiler?.apiKey;
    if (!apiKey) {
        console.log('   ⚠️ No MAPTILER_API_KEY configured — mapChart will use Canvas2D fallback');
        return false;
    }

    const entities = extractEntities(mg, scriptContext);
    const view = computeMapView(entities);
    const mapStyle = mg.mapStyle || 'dark';
    const url = buildMapUrl(view, mapStyle, apiKey);

    const filename = `map-${mapStyle}-${Date.now()}.png`;
    const filePath = path.join(tempDir, filename);

    try {
        console.log(`   🗺️ Downloading map: ${mapStyle} style, center=[${view.lon.toFixed(1)},${view.lat.toFixed(1)}], zoom=${view.zoom}`);
        console.log(`      Entities: ${entities.length > 0 ? entities.join(', ') : '(none — world view)'}`);
        const buffer = await httpsDownload(url);

        if (buffer.length < 5000) {
            console.log(`   ⚠️ Map image too small (${buffer.length} bytes) — possible API error`);
            return false;
        }

        fs.writeFileSync(filePath, buffer);
        mg.mapImageFile = filename;
        // Store view info so renderer can convert lon/lat → pixel for overlays
        mg._mapView = view;
        console.log(`   ✅ Map saved: ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
        return true;
    } catch (err) {
        console.log(`   ⚠️ Map download failed: ${err.message}`);
        return false;
    }
}

/**
 * Download maps for all mapChart MGs in a list.
 * @param {object[]} allMGs - All MG objects (filters to mapChart internally)
 * @param {object} scriptContext - Script context
 * @param {string} tempDir - Temp directory
 * @returns {Promise<number>} Number of maps downloaded
 */
async function downloadMapsForMGs(allMGs, scriptContext, tempDir) {
    const mapMGs = allMGs.filter(mg => mg.type === 'mapChart');
    if (mapMGs.length === 0) return 0;

    let downloaded = 0;
    for (const mg of mapMGs) {
        const ok = await downloadMapForMG(mg, scriptContext, tempDir);
        if (ok) downloaded++;
    }
    return downloaded;
}

module.exports = { downloadMapForMG, downloadMapsForMGs, computeMapView, GEO_COORDS };
