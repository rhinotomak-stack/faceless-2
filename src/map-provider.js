/**
 * Map Provider — Downloads static map images for mapChart MGs.
 * Provider order:
 *   1. MapTiler (primary) — tile-stitching from free tile API (100K tiles/month)
 *   2. Geoapify (fallback) — static map API (free 3,000 req/day)
 *
 * MapTiler's static maps API requires a paid plan, so we download individual
 * 512×512 tiles and stitch them into a 1920×1080 image using @napi-rs/canvas.
 *
 * Usage: downloadMapForMG(mg, scriptContext, tempDir) → saves PNG, sets mg.mapImageFile
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('./config');

// ── MapTiler style mapping (primary) ──
const MAPTILER_STYLE_MAP = {
    dark:      'dataviz-dark',
    natural:   'outdoor-v2',
    satellite: 'satellite',
    light:     'dataviz-light',
    political: 'streets-v2',
};

// ── Geoapify style mapping (fallback) ──
const GEOAPIFY_STYLE_MAP = {
    dark:      'dark-matter-brown',
    natural:   'osm-liberty',
    satellite: 'dark-matter',
    light:     'positron',
    political: 'osm-bright',
};

// Country/region center coordinates [lon, lat, zoom]
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
 * The first entity is treated as the primary subject — when entities span
 * the globe, the view centers on the primary with a moderate zoom instead
 * of zooming all the way out to fit everything.
 */
function computeMapView(entities) {
    const resolved = entities
        .map(e => ({ name: e, coords: GEO_COORDS[e] }))
        .filter(r => r.coords);

    if (resolved.length === 0) {
        return { lon: 0, lat: 20, zoom: 2 };
    }

    if (resolved.length === 1) {
        const c = resolved[0].coords;
        return { lon: c[0], lat: c[1], zoom: c[2] || 5 };
    }

    let minLon = Infinity, maxLon = -Infinity;
    let minLat = Infinity, maxLat = -Infinity;
    for (const { coords: [lon, lat] } of resolved) {
        minLon = Math.min(minLon, lon);
        maxLon = Math.max(maxLon, lon);
        minLat = Math.min(minLat, lat);
        maxLat = Math.max(maxLat, lat);
    }

    const maxSpan = Math.max(maxLon - minLon, maxLat - minLat);

    let zoom;
    if (maxSpan > 200) zoom = 2;
    else if (maxSpan > 100) zoom = 2;
    else if (maxSpan > 60) zoom = 2.5;
    else if (maxSpan > 30) zoom = 3;
    else if (maxSpan > 15) zoom = 4;
    else if (maxSpan > 8) zoom = 5;
    else if (maxSpan > 4) zoom = 6;
    else zoom = 7;

    // When entities span the whole globe (zoom <= 2), bias center toward
    // the primary entity (first in list) so the main subject is prominent
    const primary = resolved[0].coords;
    let centerLon, centerLat;
    if (zoom <= 2) {
        // 60% weight to primary entity, 40% to geometric center
        const geoLon = (minLon + maxLon) / 2;
        const geoLat = (minLat + maxLat) / 2;
        centerLon = primary[0] * 0.6 + geoLon * 0.4;
        centerLat = primary[1] * 0.6 + geoLat * 0.4;
    } else {
        centerLon = (minLon + maxLon) / 2;
        centerLat = (minLat + maxLat) / 2;
    }

    return { lon: centerLon, lat: centerLat, zoom };
}

// ══════════════════════════════════════════════════════════════════
// MapTiler Tile Stitcher — downloads 512px tiles and composites
// into a single 1920×1080 image using @napi-rs/canvas
// ══════════════════════════════════════════════════════════════════

const TILE_SIZE = 512;   // MapTiler serves 512px tiles
const OUT_W = 1920;
const OUT_H = 1080;

/** Convert lon/lat to fractional tile coordinates at a given zoom */
function lonLatToTile(lon, lat, zoom) {
    const z = Math.pow(2, zoom);
    const x = ((lon + 180) / 360) * z;
    const latRad = lat * Math.PI / 180;
    const y = (1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * z;
    return { x, y };
}

/**
 * Calculate which tiles we need and where to place them on the canvas.
 * Returns { tiles: [{z, x, y, destX, destY}], ... }
 */
function computeTileGrid(view, width = OUT_W, height = OUT_H) {
    // Use integer zoom for tiles (MapTiler tiles only exist at integer zooms)
    // Minimum z=2 to avoid world-wrap duplication at very low zooms
    const z = Math.max(2, Math.floor(view.zoom));
    const maxTile = Math.pow(2, z);

    // Center tile position (fractional)
    const center = lonLatToTile(view.lon, view.lat, z);

    // How many pixels from center to edge
    const halfW = width / 2;
    const halfH = height / 2;

    // Pixel offset of center within its tile
    const centerPixelX = center.x * TILE_SIZE;
    const centerPixelY = center.y * TILE_SIZE;

    // Top-left pixel in the global tile-pixel space
    const originX = centerPixelX - halfW;
    const originY = centerPixelY - halfH;

    // Which tiles cover this region
    const tileMinX = Math.floor(originX / TILE_SIZE);
    const tileMinY = Math.floor(originY / TILE_SIZE);
    const tileMaxX = Math.floor((originX + width - 1) / TILE_SIZE);
    const tileMaxY = Math.floor((originY + height - 1) / TILE_SIZE);

    const tiles = [];
    for (let ty = tileMinY; ty <= tileMaxY; ty++) {
        for (let tx = tileMinX; tx <= tileMaxX; tx++) {
            // Wrap X for world maps, clamp Y
            const wrappedX = ((tx % maxTile) + maxTile) % maxTile;
            if (ty < 0 || ty >= maxTile) continue;

            // Where to draw this tile on our canvas
            const destX = tx * TILE_SIZE - originX;
            const destY = ty * TILE_SIZE - originY;

            tiles.push({ z, x: wrappedX, y: ty, destX: Math.round(destX), destY: Math.round(destY) });
        }
    }

    return { tiles, z };
}

/**
 * Download a single MapTiler tile. Returns Buffer (PNG).
 * Uses @2x retina tiles (512px native) for crisp 1920×1080 output.
 */
function downloadTile(style, z, x, y, apiKey) {
    // @2x suffix gives 512px retina tiles on the free tier
    const url = `https://api.maptiler.com/maps/${style}/${z}/${x}/${y}@2x.png?key=${apiKey}`;
    return httpsDownload(url, 10000);
}

/**
 * Stitch MapTiler tiles into a 1920×1080 PNG. Returns Buffer.
 * Uses @napi-rs/canvas for compositing.
 */
async function stitchMapTilerTiles(view, mapStyle, apiKey) {
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const style = MAPTILER_STYLE_MAP[mapStyle] || MAPTILER_STYLE_MAP.dark;

    const { tiles, z } = computeTileGrid(view);
    console.log(`      MapTiler: stitching ${tiles.length} tiles at z=${z} (${style})`);

    // Download all tiles in parallel (batched to avoid hammering)
    const BATCH_SIZE = 6;
    const tileImages = new Map();

    for (let i = 0; i < tiles.length; i += BATCH_SIZE) {
        const batch = tiles.slice(i, i + BATCH_SIZE);
        const results = await Promise.allSettled(
            batch.map(async (t) => {
                const key = `${t.z}/${t.x}/${t.y}`;
                const buf = await downloadTile(style, t.z, t.x, t.y, apiKey);
                const img = await loadImage(buf);
                tileImages.set(key, { img, tile: t });
            })
        );
        // Log failures
        for (let j = 0; j < results.length; j++) {
            if (results[j].status === 'rejected') {
                const t = batch[j];
                console.log(`      ⚠️ Tile ${t.z}/${t.x}/${t.y} failed: ${results[j].reason?.message}`);
            }
        }
    }

    if (tileImages.size === 0) {
        throw new Error('No tiles downloaded');
    }

    console.log(`      Downloaded ${tileImages.size}/${tiles.length} tiles`);

    // Stitch onto canvas
    const canvas = createCanvas(OUT_W, OUT_H);
    const ctx = canvas.getContext('2d');

    // Fill background matching the map style (covers missing/OOB tiles)
    const BG_COLORS = {
        dark: '#1a1a2e', natural: '#b5d0d0', satellite: '#0b1026',
        light: '#e8e8e8', political: '#aad3df',
    };
    ctx.fillStyle = BG_COLORS[mapStyle] || '#1a1a2e';
    ctx.fillRect(0, 0, OUT_W, OUT_H);

    // Draw tiles (512px native from MapTiler /512/ endpoint)
    for (const tile of tiles) {
        const key = `${tile.z}/${tile.x}/${tile.y}`;
        const entry = tileImages.get(key);
        if (!entry) continue;
        ctx.drawImage(entry.img, tile.destX, tile.destY, TILE_SIZE, TILE_SIZE);
    }

    return canvas.toBuffer('image/png');
}

// ── Geoapify URL builder (fallback) ──

function buildGeoapifyUrl(view, mapStyle, apiKey) {
    const style = GEOAPIFY_STYLE_MAP[mapStyle] || GEOAPIFY_STYLE_MAP.dark;
    return `https://maps.geoapify.com/v1/staticmap?style=${style}&width=1920&height=1080&center=lonlat:${view.lon},${view.lat}&zoom=${view.zoom}&apiKey=${apiKey}`;
}

/**
 * Extract entity names from an MG scene + scriptContext.
 */
function extractEntities(mg, scriptContext) {
    let entities = [];
    if (scriptContext?.entities) {
        entities = [...scriptContext.entities];
    }
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
 * Tries MapTiler (tile stitching) first, then Geoapify (static API).
 */
async function downloadMapForMG(mg, scriptContext, tempDir) {
    const maptilerKey = config.maptiler?.apiKey;
    const geoapifyKey = config.geoapify?.apiKey;

    if (!maptilerKey && !geoapifyKey) {
        console.log('   ⚠️ No map API key configured (set MAPTILER_API_KEY or GEOAPIFY_API_KEY)');
        console.log('      mapChart will use Canvas2D fallback');
        return false;
    }

    const entities = extractEntities(mg, scriptContext);
    const view = computeMapView(entities);
    const mapStyle = mg.mapStyle || 'dark';
    const filename = `map-${mapStyle}-${Date.now()}.png`;
    const filePath = path.join(tempDir, filename);

    console.log(`   🗺️ Downloading map: ${mapStyle} style, center=[${view.lon.toFixed(1)},${view.lat.toFixed(1)}], zoom=${view.zoom}`);
    console.log(`      Entities: ${entities.length > 0 ? entities.join(', ') : '(none — world view)'}`);

    // Provider 1: MapTiler tile stitching
    if (maptilerKey) {
        try {
            console.log(`      Trying MapTiler (tile stitching)...`);
            const buffer = await stitchMapTilerTiles(view, mapStyle, maptilerKey);

            if (buffer.length < 5000) {
                console.log(`      ⚠️ MapTiler: stitched image too small (${buffer.length} bytes) — skipping`);
            } else {
                fs.writeFileSync(filePath, buffer);
                mg.mapImageFile = filename;
                mg._mapView = view;
                console.log(`   ✅ Map saved via MapTiler: ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
                return true;
            }
        } catch (err) {
            console.log(`      ⚠️ MapTiler failed: ${err.message}`);
        }
    }

    // Provider 2: Geoapify static API (fallback)
    if (geoapifyKey) {
        try {
            console.log(`      Trying Geoapify (static API)...`);
            const url = buildGeoapifyUrl(view, mapStyle, geoapifyKey);
            const buffer = await httpsDownload(url);

            if (buffer.length < 5000) {
                console.log(`      ⚠️ Geoapify: image too small (${buffer.length} bytes) — skipping`);
            } else {
                fs.writeFileSync(filePath, buffer);
                mg.mapImageFile = filename;
                mg._mapView = view;
                console.log(`   ✅ Map saved via Geoapify: ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
                return true;
            }
        } catch (err) {
            console.log(`      ⚠️ Geoapify failed: ${err.message}`);
        }
    }

    console.log('   ⚠️ All map providers failed — will use Canvas2D fallback');
    return false;
}

/**
 * Download maps for all mapChart MGs in a list.
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

module.exports = {
    downloadMapForMG, downloadMapsForMGs, computeMapView, GEO_COORDS,
    stitchMapTilerTiles, MAPTILER_STYLE_MAP, GEOAPIFY_STYLE_MAP,
};
