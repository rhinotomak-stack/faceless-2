/**
 * Map Provider — Downloads static map images for mapChart MGs.
 * Provider order:
 *   1. MapTiler (primary) — tile-stitching from free tile API (100K tiles/month)
 *   2. Geoapify (fallback) — static map API (free 3,000 req/day)
 *
 * MapTiler's static maps API requires a paid plan, so we download individual
 * 512×512 tiles and stitch them into a 1920×1080 image using @napi-rs/canvas.
 *
 * Geocoding: MapTiler free tier includes geocoding (100K req/day).
 * Converts city/landmark names → exact lat/lng with dynamic zoom.
 *
 * Usage: downloadMapForMG(mg, scriptContext, tempDir) → saves PNG, sets mg.mapImageFile
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const config = require('./config');

// ── Geocoding cache (avoids repeat API calls within same build) ──
const _geocodeCache = new Map();

// ── MapTiler tile cache (avoids re-downloading identical tiles across maps) ──
// Keyed by `${style}/${z}/${x}/${y}`. Stores raw PNG Buffer. Cleared between builds.
const _tileCache = new Map();

// ── Non-place entity filter ──
// These entities should NEVER reach the geocoder — they're not locations and
// cause garbage matches (e.g. "Houthi forces" → Albania, "Maersk" → Denmark,
// "Hapag-Lloyd" → Alberta). When a non-place slips through, OSM fetches wrong
// country boundaries and the final map is polluted with unrelated regions.
const NON_PLACE_SUFFIX_RE = /\b(Inc|Inc\.|Ltd|Ltd\.|LLC|PLC|Corp|Corp\.|Corporation|Co\.|Company|Companies|AG|SA|GmbH|BV|NV|Holding|Holdings|Group|Groups?|Shipping|Lines?|Airlines?|Motors?|Industries|Solutions|Technologies|Services|Partners|Ventures|Capital)\b/i;
const NON_PLACE_WORD_RE  = /\b(forces|militia|militant|militants|rebels|rebel|insurgents?|fighters|battalion|brigade|regiment|corps|coalition|alliance|cartel|faction|syndicate|terrorists?|party|parties|government|governments|administration|administrations|agency|agencies|ministry|ministries|committee|committees|council|councils|union|unions|organization|organizations|association|associations|federation|confederation|conglomerate)\b/i;
const GENERIC_GLOBAL_RE  = /^(world|global|globe|earth|international|worldwide|everywhere|nowhere|abroad)$/i;

function isLikelyPlace(name, entityTypes) {
    if (!name || typeof name !== 'string') return false;
    const trimmed = name.trim();
    if (trimmed.length < 2) return false;

    // 1. Trust the AI Director's tagging when present
    const tag = entityTypes && entityTypes[trimmed.toLowerCase()];
    if (tag === 'place') return true;
    if (tag === 'person' || tag === 'org' || tag === 'event') return false;

    // 2. Untagged: apply heuristics
    if (GENERIC_GLOBAL_RE.test(trimmed)) return false;     // "World", "Earth", etc.
    if (NON_PLACE_SUFFIX_RE.test(trimmed)) return false;   // Company suffixes
    if (NON_PLACE_WORD_RE.test(trimmed)) return false;     // Groups / orgs / institutions

    return true;
}

function filterPlaces(names, entityTypes, context = 'entities') {
    if (!Array.isArray(names) || names.length === 0) return names || [];
    const kept = [];
    const dropped = [];
    for (const n of names) {
        if (isLikelyPlace(n, entityTypes)) kept.push(n);
        else dropped.push(n);
    }
    if (dropped.length > 0) {
        console.log(`      🚫 Filtered ${dropped.length} non-place ${context}: ${dropped.join(', ')}`);
    }
    return kept;
}

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
    'Earth': [0, 20, 1], 'Globe': [0, 20, 1],
    // Sub-continents / regions — tighter than continents, often the right establishing shot
    'Southeast Asia': [110, 10, 3.5], 'East Asia': [120, 35, 3.5],
    'South Asia': [80, 22, 3.5], 'Central Asia': [70, 45, 3.5],
    'Western Europe': [5, 48, 4.5], 'Eastern Europe': [28, 50, 4],
    'Northern Europe': [18, 62, 3.5], 'Southern Europe': [15, 42, 4.5],
    'Scandinavia': [18, 64, 3.5], 'Balkans': [22, 43, 5], 'Caucasus': [45, 42, 5.5],
    'North Africa': [10, 28, 3.5], 'West Africa': [-5, 10, 4],
    'East Africa': [38, 0, 4], 'Southern Africa': [25, -22, 3.5],
    'Sub-Saharan Africa': [20, -5, 2.8],
    'Central America': [-85, 14, 4.5], 'Caribbean': [-75, 17, 4.5],
    'Latin America': [-70, -10, 2.8], 'Oceania': [145, -25, 2.8],
    'Arabian Peninsula': [46, 23, 4], 'Horn of Africa': [44, 8, 5],
    'Indian Subcontinent': [78, 22, 3.8],
    // Seas / gulfs / straits — often the BEST establishing frame for coastal stories
    'Red Sea': [38, 20, 4.5], 'Gulf of Aden': [48, 12.5, 5.5],
    'Persian Gulf': [52, 27, 5], 'Arabian Sea': [64, 15, 4],
    'Gulf of Oman': [58, 24, 6], 'Strait of Hormuz': [56, 26.5, 7.5],
    'Bab-el-Mandeb': [43.3, 12.6, 7.5], 'Bab el-Mandeb': [43.3, 12.6, 7.5],
    'Mediterranean': [18, 37, 3.8], 'Mediterranean Sea': [18, 37, 3.8],
    'Black Sea': [35, 43.5, 5], 'Caspian Sea': [51, 41.5, 4.8],
    'Baltic Sea': [19, 58, 4.5], 'North Sea': [3, 56, 4.8],
    'South China Sea': [115, 15, 3.8], 'East China Sea': [125, 30, 4.5],
    'Sea of Japan': [135, 40, 4.5], 'Bay of Bengal': [88, 15, 4],
    'Gulf of Mexico': [-90, 25, 4.5], 'Gulf of Guinea': [3, 3, 4.5],
    // Oceans (rarely the right choice but completeness)
    'Pacific Ocean': [-160, 0, 2], 'Atlantic Ocean': [-30, 15, 2.2],
    'Indian Ocean': [75, -10, 2.2], 'Arctic Ocean': [0, 85, 2],
    'Southern Ocean': [0, -65, 2],
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

// ══════════════════════════════════════════════════════════════════
// Geocoding — MapTiler free tier (100K req/day)
// Converts "Berlin", "Tokyo Tower", "Sahara Desert" → exact lon/lat
// ══════════════════════════════════════════════════════════════════

/**
 * Geocode a place name → { lon, lat, type, name, zoom }.
 * type: 'city' | 'country' | 'region' | 'landmark' | 'unknown'
 * zoom: suggested zoom level based on place type.
 * Returns null if geocoding fails or no results.
 */
async function geocodePlace(placeName, apiKey) {
    if (!placeName || !apiKey) return null;

    const cacheKey = placeName.trim().toLowerCase();
    if (_geocodeCache.has(cacheKey)) return _geocodeCache.get(cacheKey);

    // Check hardcoded coords first (instant, no API call) — case-insensitive
    const hardcoded = GEO_COORDS[placeName] || GEO_COORDS[placeName.charAt(0).toUpperCase() + placeName.slice(1).toLowerCase()]
        || Object.entries(GEO_COORDS).find(([k]) => k.toLowerCase() === cacheKey)?.[1];
    if (hardcoded) {
        const result = { lon: hardcoded[0], lat: hardcoded[1], zoom: hardcoded[2] || 5, type: 'country', name: placeName };
        _geocodeCache.set(cacheKey, result);
        return result;
    }

    try {
        const query = encodeURIComponent(placeName.trim());
        // Request multiple results and prefer city/country over street-level matches
        const url = `https://api.maptiler.com/geocoding/${query}.json?key=${apiKey}&limit=5&language=en`;
        const buf = await httpsDownload(url, 8000);
        const data = JSON.parse(buf.toString());

        if (!data.features || data.features.length === 0) {
            _geocodeCache.set(cacheKey, null);
            return null;
        }

        // Prefer city/country/region over street-level results
        // MapTiler sometimes returns a street named "Tokyo" before the city Tokyo
        const RANK = { country: 1, region: 2, subregion: 3, county: 4, municipality: 5, city: 5, town: 6, village: 7, neighbourhood: 8, poi: 9, address: 10 };
        const ranked = data.features.map(f => {
            const pt = f.place_type?.[0] || f.properties?.place_type?.[0] || 'address';
            return { feat: f, rank: RANK[pt] || 10, placeType: pt };
        }).sort((a, b) => a.rank - b.rank);

        // If best result is still a street/POI and the original query had no numbers
        // (not an address), take it but bump zoom down to reasonable level
        let feat = ranked[0].feat;
        const bestType = ranked[0].placeType;
        if ((bestType === 'address' || bestType === 'poi') && ranked.length > 1) {
            // Check if there's a city/region result anywhere
            const better = ranked.find(r => r.rank <= 7);
            if (better) feat = better.feat;
        }
        const [lon, lat] = feat.center || feat.geometry?.coordinates || [0, 0];
        const placeType = feat.place_type?.[0] || feat.properties?.place_type?.[0] || 'unknown';

        // Map MapTiler place_type → zoom level
        const ZOOM_BY_TYPE = {
            'country':       5,
            'region':        7,
            'subregion':     8,
            'county':        9,
            'municipality':  10,
            'city':          11,
            'town':          11,
            'village':       13,
            'neighbourhood': 14,
            'address':       15,
            'poi':           14,
            'landmark':      14,
        };

        // Cap zoom at 12 for video maps — higher zooms show too much street detail
        const rawZoom = ZOOM_BY_TYPE[placeType] || 10;
        const zoom = Math.min(rawZoom, 12);
        const type = ['country'].includes(placeType) ? 'country'
            : ['region', 'subregion', 'county'].includes(placeType) ? 'region'
            : ['city', 'town', 'municipality'].includes(placeType) ? 'city'
            : ['poi', 'landmark', 'address', 'neighbourhood', 'village'].includes(placeType) ? 'landmark'
            : 'unknown';

        const result = {
            lon, lat, zoom, type,
            name: placeName,  // Always preserve the user's original query name
            geoName: feat.text || feat.place_name || placeName,
            fullName: feat.place_name || placeName,
        };
        _geocodeCache.set(cacheKey, result);
        return result;
    } catch (err) {
        console.log(`      ⚠️ Geocode failed for "${placeName}": ${err.message}`);
        _geocodeCache.set(cacheKey, null);
        return null;
    }
}

/**
 * Geocode multiple place names in parallel. Returns array of results (nulls filtered out).
 */
async function geocodePlaces(placeNames, apiKey) {
    const results = await Promise.all(
        placeNames.map(name => geocodePlace(name, apiKey))
    );
    return results.filter(Boolean);
}

/**
 * Compute map center and zoom from a list of entity names.
 * Uses geocoding for precise coordinates when API key is available.
 * Falls back to hardcoded GEO_COORDS dictionary.
 */
async function computeMapView(entities, apiKey) {
    // Try geocoding first if we have an API key
    let resolved = [];
    if (apiKey && entities.length > 0) {
        const geocoded = await geocodePlaces(entities, apiKey);
        resolved = geocoded.map(g => ({
            name: g.name,
            coords: [g.lon, g.lat, g.zoom],
            type: g.type,
            fullName: g.fullName,
        }));
    }

    // Fall back to hardcoded for any entities not geocoded
    if (resolved.length === 0) {
        resolved = entities
            .map(e => ({ name: e, coords: GEO_COORDS[e], type: 'country' }))
            .filter(r => r.coords);
    }

    if (resolved.length === 0) {
        return { lon: 0, lat: 20, zoom: 2, pins: [] };
    }

    // Build pin data for the renderer
    const pins = resolved.map((r, i) => ({
        name: r.name,
        fullName: r.fullName || r.name,
        lon: r.coords[0],
        lat: r.coords[1],
        type: r.type || 'country',
        zoom: r.coords[2] || 5,
    }));

    if (resolved.length === 1) {
        const c = resolved[0].coords;
        return { lon: c[0], lat: c[1], zoom: c[2] || 5, pins };
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
        const geoLon = (minLon + maxLon) / 2;
        const geoLat = (minLat + maxLat) / 2;
        centerLon = primary[0] * 0.6 + geoLon * 0.4;
        centerLat = primary[1] * 0.6 + geoLat * 0.4;
    } else {
        centerLon = (minLon + maxLon) / 2;
        centerLat = (minLat + maxLat) / 2;
    }

    return { lon: centerLon, lat: centerLat, zoom, pins };
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
    const cacheKey = `${style}/${z}/${x}/${y}`;
    if (_tileCache.has(cacheKey)) {
        return Promise.resolve(_tileCache.get(cacheKey));
    }
    // @2x suffix gives 512px retina tiles on the free tier
    const url = `https://api.maptiler.com/maps/${style}/${z}/${x}/${y}@2x.png?key=${apiKey}`;
    return httpsDownload(url, 10000).then(buf => {
        _tileCache.set(cacheKey, buf);
        return buf;
    });
}

/**
 * Stitch MapTiler tiles into a 1920×1080 PNG. Returns Buffer.
 * Uses @napi-rs/canvas for compositing.
 */
async function stitchMapTilerTiles(view, mapStyle, apiKey, outW, outH) {
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const style = MAPTILER_STYLE_MAP[mapStyle] || MAPTILER_STYLE_MAP.dark;
    const canvasW = outW || OUT_W;
    const canvasH = outH || OUT_H;

    const { tiles, z } = computeTileGrid(view, canvasW, canvasH);
    const cachedCount = tiles.filter(t => _tileCache.has(`${style}/${t.z}/${t.x}/${t.y}`)).length;
    console.log(`      MapTiler: stitching ${tiles.length} tiles at z=${z} ${canvasW}×${canvasH} (${style})${cachedCount > 0 ? ` [${cachedCount} cached]` : ''}`);

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
    const canvas = createCanvas(canvasW, canvasH);
    const ctx = canvas.getContext('2d');

    // Fill background matching the map style (covers missing/OOB tiles)
    const BG_COLORS = {
        dark: '#1a1a2e', natural: '#b5d0d0', satellite: '#0b1026',
        light: '#e8e8e8', political: '#aad3df',
    };
    ctx.fillStyle = BG_COLORS[mapStyle] || '#1a1a2e';
    ctx.fillRect(0, 0, canvasW, canvasH);

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
 * Extract location names from an MG scene + scriptContext.
 * Parses the AI-generated subtext format: "Berlin: 3.6M, Tokyo: 13.9M, ..."
 * Also falls back to scriptContext.entities and GEO_COORDS dictionary scan.
 */
function extractEntities(mg, scriptContext) {
    const entityTypes = scriptContext?.entityTypes || {};

    // Meta-directive prefixes VP emits instead of actual place names
    // ("Region: Middle East", "Zoom on Persian Gulf", "Pan to Red Sea", etc.).
    // These describe a camera op — the REAL place is the value side.
    const META_KEY_RE = /^(region|zoom|pan|view|map|focus|overview|closeup|close-up|highlight|scene|labels?)$/i;
    const META_PREFIX_RE = /^(zoom\s+(?:on|in(?:to)?|to)|pan\s+(?:to|across)|view\s+of|focus\s+on|overview\s+of|highlight(?:ing)?|map\s+of|region:?)\s+/i;

    const stripMetaPrefix = (s) => {
        if (!s) return '';
        let out = String(s).trim();
        // Strip up to 2 chained prefixes (e.g. "Map of Region: Asia")
        for (let i = 0; i < 2; i++) {
            const stripped = out.replace(META_PREFIX_RE, '').trim();
            if (stripped === out) break;
            out = stripped;
        }
        return out;
    };

    // Filter at each step so a bad step 1 (e.g. VP description with stray colons)
    // doesn't block fallback to steps 2 and 3.

    // 1. Parse subtext "Location: value" pairs — short fragments only.
    //    Long fragments (>6 words) are almost always descriptive prose, not
    //    real "Location: value" pairs, so skip them. If the key is a
    //    meta-directive ("Region", "Zoom", "Pan"...), use the VALUE as the place.
    let entities = [];
    const subtext = mg.subtext || '';
    if (subtext) {
        const pairs = subtext.split(',').map(s => s.trim()).filter(Boolean);
        for (const pair of pairs) {
            const colonIdx = pair.indexOf(':');
            if (colonIdx > 0) {
                const key = pair.substring(0, colonIdx).trim();
                const val = pair.substring(colonIdx + 1).trim();
                if (META_KEY_RE.test(key)) {
                    // "Region: Middle East" → place is the value
                    if (val && val.length >= 2 && val.split(/\s+/).length <= 6) {
                        entities.push(val);
                    }
                } else if (key.length >= 2 && key.split(/\s+/).length <= 6) {
                    entities.push(key);
                }
            }
        }
    }
    let filtered = filterPlaces(entities, entityTypes, 'entities');
    if (filtered.length > 0) return filtered;

    // 2a. If mg.text is a short meta-directive like "Zoom on Persian Gulf",
    //     stripping the prefix leaves the literal place name — use it directly.
    //     (Avoids needing every place in the GEO_COORDS key list.)
    const textStripped = stripMetaPrefix(mg.text || '');
    if (textStripped && textStripped !== (mg.text || '').trim()) {
        const wordCount = textStripped.split(/\s+/).length;
        if (wordCount >= 1 && wordCount <= 4) {
            filtered = filterPlaces([textStripped], entityTypes, 'entities');
            if (filtered.length > 0) return filtered;
        }
    }

    // 2b. Scan mg.text AND mg.subtext for known GEO_COORDS place names.
    const scanText = `${stripMetaPrefix(mg.text || '')} ${stripMetaPrefix(mg.subtext || '')}`.toLowerCase();
    if (scanText.trim()) {
        entities = [];
        for (const name of Object.keys(GEO_COORDS)) {
            if (name.length > 2 && scanText.includes(name.toLowerCase())) {
                if (!entities.includes(name)) entities.push(name);
            }
        }
        filtered = filterPlaces(entities, entityTypes, 'entities');
        if (filtered.length > 0) return filtered;
    }

    // 3. Fall back to scriptContext.entities (the authoritative list).
    if (Array.isArray(scriptContext?.entities) && scriptContext.entities.length > 0) {
        filtered = filterPlaces([...scriptContext.entities], entityTypes, 'entities');
        if (filtered.length > 0) return filtered;
    }

    return [];
}

/**
 * Download a static map image for a mapChart MG.
 * Tries MapTiler (tile stitching) first, then Geoapify (static API).
 * Now with geocoding: resolves city/landmark names → exact coordinates.
 */
async function downloadMapForMG(mg, scriptContext, tempDir) {
    const maptilerKey = config.maptiler?.apiKey;
    const geoapifyKey = config.geoapify?.apiKey;

    if (!maptilerKey && !geoapifyKey) {
        console.log('   ⚠️ No map API key configured (set MAPTILER_API_KEY or GEOAPIFY_API_KEY)');
        console.log('      mapChart will use Canvas2D fallback');
        return false;
    }

    const entityTypes = scriptContext?.entityTypes || {};

    // Prefer the AI Map Planner's selected waypoints + swarms — that's exactly what
    // the renderer will animate, so those are the only coords we actually need.
    // Using them directly (instead of re-deriving from mg.text/subtext/scriptContext)
    // avoids geocoding 20 unused script-wide entities per map and keeps OSM boundary
    // fetches tight — no more Albania/Australia appearing on Red Sea maps.
    let entities;
    const plannerNames = [];
    const seen = new Set();
    if (Array.isArray(mg._mapWaypoints) && mg._mapWaypoints.length > 0) {
        for (const wp of mg._mapWaypoints) {
            if (wp.name && !seen.has(wp.name)) {
                plannerNames.push(wp.name);
                seen.add(wp.name);
            }
        }
    }
    if (Array.isArray(mg._mapSwarms)) {
        for (const sw of mg._mapSwarms) {
            for (const loc of (sw.locations || [])) {
                if (loc.name && !seen.has(loc.name)) {
                    plannerNames.push(loc.name);
                    seen.add(loc.name);
                }
            }
        }
    }

    if (plannerNames.length > 0) {
        entities = filterPlaces(plannerNames, entityTypes, 'planner waypoints');
        console.log(`      🎯 Using ${entities.length} planner-selected entit${entities.length === 1 ? 'y' : 'ies'} (waypoints + swarms)`);
    } else {
        // Planner didn't run or yielded nothing → derive from mg content as before.
        entities = extractEntities(mg, scriptContext);
    }

    // Use geocoding for precise coordinates (async — MapTiler free tier)
    const view = await computeMapView(entities, maptilerKey);
    const mapStyle = mg.mapStyle || 'dark';
    const filename = `map-${mapStyle}-${Date.now()}.png`;
    const filePath = path.join(tempDir, filename);

    console.log(`   🗺️ Downloading map: ${mapStyle} style, center=[${view.lon.toFixed(1)},${view.lat.toFixed(1)}], zoom=${view.zoom}`);
    console.log(`      Entities: ${entities.length > 0 ? entities.join(', ') : '(none — world view)'}`);
    if (view.pins?.length) {
        for (const pin of view.pins) {
            console.log(`      📍 ${pin.name} (${pin.type}) → [${pin.lon.toFixed(2)}, ${pin.lat.toFixed(2)}] z${pin.zoom}`);
        }
    }

    // Fetch OSM boundary polygons for country + city highlighting
    try {
        const boundaryNames = new Set(entities);
        // Extract country names from geocoded pin fullNames + add city names
        if (view.pins?.length) {
            for (const pin of view.pins) {
                // Add the city/location name itself
                if (pin.name) boundaryNames.add(pin.name);
                const parts = (pin.fullName || '').split(',').map(s => s.trim());
                // Last part is the country
                if (parts.length > 1) boundaryNames.add(parts[parts.length - 1]);
            }
        }
        if (boundaryNames.size > 0) {
            const osmBounds = await fetchOSMBoundaries([...boundaryNames]);
            if (osmBounds.length > 0) {
                mg._osmBoundaries = osmBounds;
                console.log(`      🗺️ OSM boundaries: ${osmBounds.map(b => b.name).join(', ')}`);
            }
        }
    } catch (e) {
        console.log(`      ⚠️ OSM boundary fetch failed: ${e.message}`);
    }

    // ── Big map mode: single large tile for waypoint animations ──
    const useBigMap = mg._mapBigMap && mg._mapWaypoints && mg._mapWaypoints.length > 0 && view.pins?.length > 0;

    if (useBigMap && maptilerKey) {
        try {
            // Compute bounding box of all waypoint + swarm locations
            const wpCoords = [];
            const _addCoord = (name) => {
                if (wpCoords.some(c => c.name.toLowerCase() === name.toLowerCase())) return;
                const lower = name.toLowerCase();
                const pin = view.pins.find(p => p.name.toLowerCase() === lower)
                    || view.pins.find(p => p.name.toLowerCase().includes(lower) || lower.includes(p.name.toLowerCase()));
                if (pin) wpCoords.push({ name, lon: pin.lon, lat: pin.lat });
            };
            for (const wp of mg._mapWaypoints) _addCoord(wp.name);
            if (mg._mapSwarms) {
                for (const sw of mg._mapSwarms) {
                    for (const loc of sw.locations) _addCoord(loc.name);
                }
            }

            if (wpCoords.length > 0) {
                const wpLons = wpCoords.map(w => w.lon);
                const wpLats = wpCoords.map(w => w.lat);
                const centerLon = (Math.min(...wpLons) + Math.max(...wpLons)) / 2;
                const centerLat = (Math.min(...wpLats) + Math.max(...wpLats)) / 2;

                // ── Tile zoom + canvas size ──
                // Pick tile zoom from the TIGHTEST close-up (most demanding for
                // sharpness), then size the canvas so the WIDEST camera shot
                // still fits. Step tile zoom down if canvas would exceed cap.
                // Derivation: on-screen pixels-per-degree at camZoom = 1920*camZoom/80.
                // Tile pixels-per-degree at tile zoom z = 512*2^z/360.
                // Crisp when z ≥ log2(1920 * camZoom * 360 / (80 * 512)) = log2(16.875 * camZoom).
                const HARD_MAX_W = 9216;
                const HARD_MAX_H = 5184;
                const MIN_W = 1920;
                const MIN_H = 1080;
                const TARGET_AR = 16 / 9;

                const camZooms = mg._mapWaypoints.map(w => w.zoom ?? 1.0);
                const minWpZoom = Math.min(...camZooms);
                const maxWpZoom = Math.max(...camZooms);

                const tileZoomForCam = (cz) => Math.ceil(Math.log2(1920 * cz * 360 / (80 * 512)));
                let bigZoom = Math.max(3, Math.min(tileZoomForCam(maxWpZoom), 7));

                const cosLat = Math.max(0.1, Math.cos(centerLat * Math.PI / 180));
                const wideShotLonSpan = 80 / minWpZoom;
                const bboxLonSpan = Math.max(...wpLons) - Math.min(...wpLons);
                const bboxLatSpan = Math.max(...wpLats) - Math.min(...wpLats);

                let BIG_W, BIG_H;
                while (true) {
                    const pxPerDegLon = 512 * Math.pow(2, bigZoom) / 360;
                    const pxPerDegLat = pxPerDegLon / cosLat;

                    const neededLonSpan = Math.max(wideShotLonSpan, bboxLonSpan * 1.3);
                    const neededLatSpan = Math.max(wideShotLonSpan * 9 / 16, bboxLatSpan * 1.3);

                    let w = Math.ceil(neededLonSpan * pxPerDegLon);
                    let h = Math.ceil(neededLatSpan * pxPerDegLat);

                    // Force 16:9 by growing the narrower dimension
                    if (w / h > TARGET_AR) h = Math.ceil(w / TARGET_AR);
                    else w = Math.ceil(h * TARGET_AR);

                    w = Math.max(MIN_W, w);
                    h = Math.max(MIN_H, h);

                    if (w <= HARD_MAX_W && h <= HARD_MAX_H) {
                        BIG_W = w;
                        BIG_H = h;
                        break;
                    }
                    if (bigZoom <= 3) {
                        BIG_W = Math.min(w, HARD_MAX_W);
                        BIG_H = Math.min(h, HARD_MAX_H);
                        break;
                    }
                    bigZoom--;
                }

                // Round up to whole tiles (512 px) so stitching has no partial edges,
                // then re-clamp to cap.
                const roundUp = (n, step) => Math.ceil(n / step) * step;
                BIG_W = Math.min(HARD_MAX_W, roundUp(BIG_W, 512));
                BIG_H = Math.min(HARD_MAX_H, roundUp(BIG_H, 512));

                const bigView = { lon: centerLon, lat: centerLat, zoom: bigZoom, pins: view.pins };

                const tilesEstimate = Math.ceil(BIG_W / 512) * Math.ceil(BIG_H / 512);
                console.log(`      Big map: ${BIG_W}×${BIG_H} tileZ=${bigZoom} (~${tilesEstimate} tiles) camZoom[${minWpZoom.toFixed(1)}→${maxWpZoom.toFixed(1)}] center [${centerLon.toFixed(1)},${centerLat.toFixed(1)}]`);
                const buffer = await stitchMapTilerTiles(bigView, mapStyle, maptilerKey, BIG_W, BIG_H);

                if (buffer.length > 5000) {
                    fs.writeFileSync(filePath, buffer);
                    mg.mapImageFile = filename;
                    mg._mapView = bigView;
                    mg._mapPins = view.pins;
                    mg._bigMapSize = { w: BIG_W, h: BIG_H };
                    mg._wpCoords = wpCoords;
                    console.log(`   ✅ Big map saved: ${filename} (${(buffer.length / 1024).toFixed(0)} KB)`);
                    return true;
                }
                console.log(`      ⚠️ Big map too small (${buffer.length} bytes) — falling back to standard`);
            }
        } catch (err) {
            console.log(`      ⚠️ Big map download failed: ${err.message} — falling back to standard`);
        }
    }

    // Provider 1: MapTiler tile stitching (standard single view)
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
                if (view.pins?.length) mg._mapPins = view.pins;
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
                if (view.pins?.length) mg._mapPins = view.pins;
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

// ══════════════════════════════════════════════════════════════════
// OSM Boundary Fetcher — Nominatim API
// MapTiler renders OSM data, so Nominatim polygons align PERFECTLY
// with the tile borders (unlike Natural Earth which is offset).
// ══════════════════════════════════════════════════════════════════

const _osmBoundaryCache = new Map();

/**
 * Fetch the OSM boundary polygon for a country/region via Nominatim.
 * Returns GeoJSON Feature with geometry (Polygon/MultiPolygon) or null.
 *
 * Nominatim usage policy: max 1 req/sec, must include User-Agent.
 * We cache aggressively so repeated calls for the same place are instant.
 */
async function fetchOSMBoundary(placeName) {
    if (!placeName) return null;
    const cacheKey = placeName.trim().toLowerCase();
    if (_osmBoundaryCache.has(cacheKey)) return _osmBoundaryCache.get(cacheKey);

    // Nominatim aliases for common abbreviations
    const ALIASES = {
        'usa': 'United States of America', 'us': 'United States of America',
        'united states': 'United States of America',
        'uk': 'United Kingdom', 'britain': 'United Kingdom', 'england': 'United Kingdom',
        'uae': 'United Arab Emirates', 'south korea': 'Republic of Korea',
        'north korea': "Democratic People's Republic of Korea",
        'czech republic': 'Czechia', 'russia': 'Russian Federation',
    };
    const query = ALIASES[cacheKey] || placeName.trim();

    // Helper: fetch from Nominatim with given URL
    const _fetchNominatim = (url) => new Promise((resolve, reject) => {
        const urlObj = new (require('url').URL)(url);
        const options = {
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            headers: { 'User-Agent': 'YTAEmpire/1.0 (video-generator)' },
            timeout: 12000,
        };
        const req = require('https').get(options, (res) => {
            if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); res.resume(); return; }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    });

    const _extractPoly = (data) => {
        if (!data?.features?.length) return null;
        const feat = data.features[0];
        return (feat.geometry && (feat.geometry.type === 'Polygon' || feat.geometry.type === 'MultiPolygon')) ? feat : null;
    };

    try {
        const encoded = encodeURIComponent(query);
        const base = `https://nominatim.openstreetmap.org/search?q=${encoded}&format=geojson&polygon_geojson=1&polygon_threshold=0.001&limit=1`;

        // 1. Try country first
        let feat = _extractPoly(await _fetchNominatim(`${base}&featuretype=country`));

        // 2. Try city (gets municipal boundary, not province)
        if (!feat) {
            await new Promise(r => setTimeout(r, 1100)); // rate limit
            feat = _extractPoly(await _fetchNominatim(`${base}&featuretype=city`));
        }

        // 3. Unrestricted fallback (landmarks, regions, etc.)
        if (!feat) {
            await new Promise(r => setTimeout(r, 1100));
            feat = _extractPoly(await _fetchNominatim(base));
        }

        if (feat) {
            _osmBoundaryCache.set(cacheKey, feat);
            const level = feat.properties?.type || feat.properties?.osm_type || 'unknown';
            console.log(`      [OSM] Boundary for "${placeName}": ${feat.geometry.type} (${level}, ${JSON.stringify(feat.geometry).length} bytes)`);
            return feat;
        }

        _osmBoundaryCache.set(cacheKey, null);
        return null;
    } catch (err) {
        console.log(`      ⚠️ OSM boundary fetch failed for "${placeName}": ${err.message}`);
        _osmBoundaryCache.set(cacheKey, null);
        return null;
    }
}

/**
 * Fetch OSM boundaries for multiple places (sequential — Nominatim 1 req/sec policy).
 * Returns array of { name, feature } objects (nulls filtered out).
 */
async function fetchOSMBoundaries(placeNames) {
    const results = [];
    for (let i = 0; i < placeNames.length; i++) {
        const feat = await fetchOSMBoundary(placeNames[i]);
        if (feat) {
            results.push({ name: placeNames[i], feature: feat });
        }
        // Respect Nominatim rate limit: 1 req/sec (skip delay for cached results)
        if (i < placeNames.length - 1 && !_osmBoundaryCache.has(placeNames[i + 1]?.trim().toLowerCase())) {
            await new Promise(r => setTimeout(r, 1100));
        }
    }
    return results;
}

module.exports = {
    downloadMapForMG, downloadMapsForMGs, computeMapView, GEO_COORDS,
    stitchMapTilerTiles, MAPTILER_STYLE_MAP, GEOAPIFY_STYLE_MAP,
    geocodePlace, geocodePlaces, fetchOSMBoundary, fetchOSMBoundaries,
    extractEntities, isLikelyPlace, filterPlaces,
};
