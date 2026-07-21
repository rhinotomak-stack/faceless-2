/**
 * sfx-provider.js — Download real SFX from Freesound API
 * Searches for transition & MG sound effects, downloads HQ previews, caches locally.
 *
 * Freesound API: token auth for search + preview download (no OAuth2 needed).
 * Fallback: keeps existing synthetic SFX if download fails.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const config = require('../settings/config');

const SFX_DIR = path.join(__dirname, '..', '..', 'assets', 'sfx');

// ============================================================
// SFX CATALOG — What to search for each sound effect file
// Each entry: target filename → search config
// ============================================================
const SFX_CATALOG = {
    // ── Transition SFX ──
    'sfx-fade.mp3': {
        queries: ['soft whoosh transition', 'gentle air swoosh', 'smooth fade sound'],
        maxDuration: 1.5,
        minDuration: 0.2,
        category: 'transition',
    },
    'sfx-dissolve.mp3': {
        queries: ['soft shimmer dissolve', 'gentle shimmer transition', 'airy dissolve sound'],
        maxDuration: 1.5,
        minDuration: 0.2,
        category: 'transition',
    },
    'sfx-slide.mp3': {
        queries: ['slide swoosh', 'screen slide transition', 'fast slide sound effect'],
        maxDuration: 1.0,
        minDuration: 0.1,
        category: 'transition',
    },
    'sfx-wipe.mp3': {
        queries: ['fast swipe wipe', 'screen wipe sound', 'quick wipe transition'],
        maxDuration: 0.8,
        minDuration: 0.1,
        category: 'transition',
    },
    'sfx-zoom.mp3': {
        queries: ['zoom in whoosh', 'camera zoom sound', 'zoom transition swoosh'],
        maxDuration: 1.2,
        minDuration: 0.2,
        category: 'transition',
    },
    'sfx-blur.mp3': {
        queries: ['soft blur whoosh', 'airy blur transition', 'defocus sound'],
        maxDuration: 1.2,
        minDuration: 0.2,
        category: 'transition',
    },
    'sfx-flash.mp3': {
        queries: ['camera flash snap', 'bright flash pop', 'photo flash sound'],
        maxDuration: 0.8,
        minDuration: 0.05,
        category: 'transition',
    },
    'sfx-filmburn.mp3': {
        queries: ['film burn crackle', 'film projector crackle', 'old film sound'],
        maxDuration: 1.5,
        minDuration: 0.3,
        category: 'transition',
    },
    'sfx-glitch.mp3': {
        queries: ['digital glitch stutter', 'glitch sound effect', 'digital error buzz'],
        maxDuration: 1.0,
        minDuration: 0.1,
        category: 'transition',
    },
    'sfx-camera-flash.mp3': {
        queries: ['camera shutter click', 'DSLR shutter sound', 'camera snap click'],
        maxDuration: 0.8,
        minDuration: 0.05,
        category: 'transition',
    },
    'sfx-whip.mp3': {
        queries: ['whip pan swoosh', 'fast whip sound', 'whip crack swoosh'],
        maxDuration: 0.8,
        minDuration: 0.05,
        category: 'transition',
    },
    'sfx-bounce.mp3': {
        queries: ['bounce pop sound', 'elastic bounce', 'bouncy pop effect'],
        maxDuration: 1.0,
        minDuration: 0.1,
        category: 'transition',
    },
    'sfx-ripple.mp3': {
        queries: ['water ripple sound', 'water drop ripple', 'ripple shimmer'],
        maxDuration: 1.5,
        minDuration: 0.2,
        category: 'transition',
    },
    'sfx-spin.mp3': {
        queries: ['spinning whoosh', 'rotation swoosh sound', 'spin transition'],
        maxDuration: 1.2,
        minDuration: 0.2,
        category: 'transition',
    },
    'sfx-shutter.mp3': {
        queries: ['mechanical shutter click', 'camera shutter sound', 'fast shutter click'],
        maxDuration: 0.8,
        minDuration: 0.05,
        category: 'transition',
    },
    'sfx-flare.mp3': {
        queries: ['lens flare shimmer', 'light flare whoosh', 'bright lens flare'],
        maxDuration: 1.5,
        minDuration: 0.2,
        category: 'transition',
    },
    'sfx-static.mp3': {
        queries: ['tv static noise', 'television static burst', 'white noise static'],
        maxDuration: 1.2,
        minDuration: 0.2,
        category: 'transition',
    },
    'sfx-ink.mp3': {
        queries: ['ink drop spread', 'liquid spread sound', 'ink splash soft'],
        maxDuration: 1.5,
        minDuration: 0.2,
        category: 'transition',
    },
    'sfx-prism.mp3': {
        queries: ['crystal shimmer chime', 'glass prism ring', 'crystal bell shimmer'],
        maxDuration: 1.2,
        minDuration: 0.2,
        category: 'transition',
    },
    // ── NEW transition types ──
    'sfx-pan.mp3': {
        queries: ['camera pan swoosh', 'smooth pan transition', 'directional pan sound'],
        maxDuration: 1.0,
        minDuration: 0.1,
        category: 'transition',
    },
    'sfx-warm-leak.mp3': {
        queries: ['warm light shimmer', 'warm glow sound', 'soft warm transition'],
        maxDuration: 1.5,
        minDuration: 0.3,
        category: 'transition',
    },
    'sfx-cool-leak.mp3': {
        queries: ['cool breeze shimmer', 'icy whoosh', 'cold air transition'],
        maxDuration: 1.5,
        minDuration: 0.3,
        category: 'transition',
    },
    'sfx-blinds.mp3': {
        queries: ['window blinds open', 'blinds shutter sound', 'venetian blinds'],
        maxDuration: 1.0,
        minDuration: 0.2,
        category: 'transition',
    },
    'sfx-diamond.mp3': {
        queries: ['diamond reveal sparkle', 'geometric wipe sound', 'shape transition swoosh'],
        maxDuration: 1.0,
        minDuration: 0.1,
        category: 'transition',
    },

    // ── Sound-design primitives (the designer's cinematic toolkit) ──
    'sfx-impact.mp3': {
        queries: ['cinematic impact hit', 'trailer impact boom', 'deep impact hit short'],
        maxDuration: 1.2,
        minDuration: 0.2,
        category: 'design',
    },
    'sfx-riser.mp3': {
        queries: ['tension riser uplifter', 'cinematic riser build up', 'rising tension whoosh'],
        maxDuration: 2.5,
        minDuration: 0.6,
        category: 'design',
    },
    'sfx-boom.mp3': {
        queries: ['cinematic sub boom braam', 'deep bass boom hit', 'trailer braam boom'],
        maxDuration: 2.0,
        minDuration: 0.4,
        category: 'design',
    },

    // ── MG SFX ──
    'sfx-mg-pop.mp3': {
        queries: ['UI pop up sound', 'notification pop', 'quick pop in'],
        maxDuration: 0.8,
        minDuration: 0.05,
        category: 'mg',
    },
    'sfx-mg-tick.mp3': {
        queries: ['counter tick sound', 'clock tick single', 'mechanical tick'],
        maxDuration: 0.5,
        minDuration: 0.03,
        category: 'mg',
    },
    'sfx-mg-swoosh.mp3': {
        queries: ['UI swoosh slide in', 'interface swoosh', 'menu slide sound'],
        maxDuration: 0.8,
        minDuration: 0.1,
        category: 'mg',
    },
    'sfx-mg-ding.mp3': {
        queries: ['notification ding bell', 'achievement ding', 'bright bell ding'],
        maxDuration: 1.0,
        minDuration: 0.1,
        category: 'mg',
    },
    'sfx-mg-type.mp3': {
        queries: ['typewriter key press', 'keyboard click single', 'typing sound single key'],
        maxDuration: 0.6,
        minDuration: 0.03,
        category: 'mg',
    },
    'sfx-mg-rise.mp3': {
        queries: ['rising tone notification', 'ascending sound effect', 'level up rise'],
        maxDuration: 1.2,
        minDuration: 0.2,
        category: 'mg',
    },
    'sfx-mg-chime.mp3': {
        queries: ['notification chime bell', 'two tone chime', 'subscribe bell sound'],
        maxDuration: 1.2,
        minDuration: 0.2,
        category: 'mg',
    },
};

// ============================================================
// FREESOUND API
// ============================================================

const FREESOUND_BASE = 'https://freesound.org/apiv2';

/**
 * Search Freesound for sounds matching a query.
 * Returns array of { id, name, duration, rating, previewUrl }
 */
async function searchFreesound(query, { maxDuration = 2, minDuration = 0.1, token }) {
    const filter = `duration:[${minDuration} TO ${maxDuration}]`;
    const fields = 'id,name,duration,avg_rating,num_downloads,previews,license,tags';
    const url = `${FREESOUND_BASE}/search/text/?query=${encodeURIComponent(query)}&filter=${encodeURIComponent(filter)}&fields=${fields}&page_size=15&sort=score&token=${token}`;

    const data = await _fetchJSON(url);
    if (!data || !data.results) return [];

    return data.results.map(s => ({
        id: s.id,
        name: s.name,
        duration: s.duration,
        rating: s.avg_rating || 0,
        downloads: s.num_downloads || 0,
        previewUrl: s.previews?.['preview-hq-mp3'] || s.previews?.['preview-lq-mp3'] || null,
        license: s.license,
        tags: s.tags || [],
    })).filter(s => s.previewUrl);
}

/**
 * Download a file from a URL to a local path.
 */
function downloadFile(url, destPath) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        const req = proto.get(url, { headers: { 'User-Agent': 'YTA-Empire-WEBGL/1.0' } }, (res) => {
            // Follow redirects
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
            }
            const file = fs.createWriteStream(destPath);
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(destPath); });
            file.on('error', (e) => { fs.unlinkSync(destPath); reject(e); });
        });
        req.on('error', reject);
        req.setTimeout(15000, () => { req.destroy(); reject(new Error('Download timeout')); });
    });
}

/**
 * Score a sound result for quality/relevance.
 * Higher = better match for short transition/MG SFX.
 */
function _scoreSound(sound, catalog) {
    let score = 0;

    // Prefer highly downloaded sounds (popularity = quality proxy)
    score += Math.min(sound.downloads / 1000, 5); // max 5 pts

    // Prefer well-rated sounds
    score += (sound.rating || 0) * 1.5; // max ~7.5 pts

    // Prefer sounds closer to target duration range center
    const targetCenter = (catalog.maxDuration + catalog.minDuration) / 2;
    const durDiff = Math.abs(sound.duration - targetCenter);
    score += Math.max(0, 3 - durDiff * 3); // max 3 pts, penalize far from center

    // Slight preference for CC0 (no attribution needed)
    if (sound.license && sound.license.includes('Creative Commons 0')) {
        score += 2;
    }

    return score;
}

/**
 * Download SFX for specific transition types only (on-demand).
 * Used when the build knows which transitions are in the plan.
 *
 * @param {string[]} transitionTypes - e.g. ['crossfade', 'panLeft', 'glitch']
 * @param {object} options
 * @returns {Promise<{ downloaded: number, skipped: number, failed: number }>}
 */
async function downloadSfxForTransitions(transitionTypes, { mgTypes = [], log } = {}) {
    // Map transition + MG types to their SFX filenames
    const neededFiles = new Set();
    for (const type of transitionTypes) {
        const sfxFile = TRANSITION_TO_SFX[type];
        if (sfxFile && SFX_CATALOG[sfxFile]) {
            neededFiles.add(sfxFile);
        }
    }
    for (const type of mgTypes) {
        const sfxFile = MG_TO_SFX[type];
        if (sfxFile && SFX_CATALOG[sfxFile]) {
            neededFiles.add(sfxFile);
        }
    }

    if (neededFiles.size === 0) return { downloaded: 0, skipped: 0, failed: 0 };

    const token = config.freesound?.apiKey;
    if (!token) {
        if (log) log.warn('No FREESOUND_API_KEY — using synthetic SFX');
        return { downloaded: 0, skipped: 0, failed: 0, noKey: true };
    }

    if (!fs.existsSync(SFX_DIR)) fs.mkdirSync(SFX_DIR, { recursive: true });

    let downloaded = 0, skipped = 0, failed = 0;

    for (const filename of neededFiles) {
        const destPath = path.join(SFX_DIR, filename);
        const catalog = SFX_CATALOG[filename];

        // Skip only if already a real Freesound download (sidecar marker)
        if (_isFreesoundDownload(destPath)) {
            skipped++;
            continue;
        }

        let success = false;
        for (const query of catalog.queries) {
            try {
                const results = await searchFreesound(query, {
                    maxDuration: catalog.maxDuration,
                    minDuration: catalog.minDuration,
                    token,
                });
                if (results.length === 0) continue;

                const scored = results.map(s => ({ ...s, score: _scoreSound(s, catalog) }));
                scored.sort((a, b) => b.score - a.score);
                const best = scored[0];

                await downloadFile(best.previewUrl, destPath);
                _markFreesoundDownload(destPath, best);
                if (log) log.dim(`  ✓ ${filename} ← "${best.name}" (${best.duration.toFixed(1)}s)`);
                downloaded++;
                success = true;
                break;
            } catch (_) { continue; }
        }

        if (!success) {
            failed++;
            if (log) log.dim(`  ✗ ${filename} — keeping fallback`);
        }

        await _sleep(250);
    }

    return { downloaded, skipped, failed };
}

// ============================================================
// TRANSITION TYPE → SFX FILE MAPPING
// Authoritative build-pipeline fallback map.
// ============================================================
const TRANSITION_TO_SFX = {
    // Smooth / dissolve
    fade:           'sfx-fade.mp3',
    fade_to_black:  'sfx-fade.mp3',
    dissolve:       'sfx-dissolve.mp3',
    crossfade:      'sfx-fade.mp3',
    blur:           'sfx-blur.mp3',
    crossBlur:      'sfx-blur.mp3',
    morph:          'sfx-blur.mp3',
    dreamFade:      'sfx-fade.mp3',
    colorFade:      'sfx-fade.mp3',
    luma:           'sfx-fade.mp3',
    lumaFade:       'sfx-fade.mp3',
    lumaDark:       'sfx-fade.mp3',

    // Film / cinematic
    filmBurn:       'sfx-filmburn.mp3',
    filmGrain:      'sfx-filmburn.mp3',
    reveal:         'sfx-ink.mp3',
    ink:            'sfx-ink.mp3',
    shadowWipe:     'sfx-wipe.mp3',
    ripple:         'sfx-ripple.mp3',

    // Energetic wipes
    wipe:           'sfx-wipe.mp3',
    slide:          'sfx-slide.mp3',
    push:           'sfx-slide.mp3',
    swipe:          'sfx-wipe.mp3',
    splitWipe:      'sfx-wipe.mp3',

    // Zoom
    zoom:           'sfx-zoom.mp3',
    zoomBlur:       'sfx-zoom.mp3',
    zoomOut:        'sfx-zoom.mp3',
    zoomRotate:     'sfx-spin.mp3',

    // Camera motion
    panLeft:        'sfx-pan.mp3',
    panRight:       'sfx-pan.mp3',
    panUp:          'sfx-pan.mp3',
    panDown:        'sfx-pan.mp3',
    whip:           'sfx-whip.mp3',
    whipPan:        'sfx-whip.mp3',
    directionalBlur:'sfx-whip.mp3',
    spin:           'sfx-spin.mp3',
    bounce:         'sfx-bounce.mp3',

    // Light leaks
    lightLeak:      'sfx-flare.mp3',
    warmLeak:       'sfx-warm-leak.mp3',
    coolLeak:       'sfx-cool-leak.mp3',
    flare:          'sfx-flare.mp3',
    flash:          'sfx-flash.mp3',
    cameraFlash:    'sfx-camera-flash.mp3',
    vignetteBlink:  'sfx-camera-flash.mp3',

    // Glitch / tech
    glitch:         'sfx-glitch.mp3',
    pixelate:       'sfx-glitch.mp3',
    mosaic:         'sfx-glitch.mp3',
    dataMosh:       'sfx-glitch.mp3',
    scanline:       'sfx-static.mp3',
    rgbSplit:       'sfx-glitch.mp3',
    static:         'sfx-static.mp3',
    prismShift:     'sfx-prism.mp3',

    // Shapes
    diagonalStripes:'sfx-wipe.mp3',
    rectangles:     'sfx-shutter.mp3',
    diamonds:       'sfx-diamond.mp3',
    blinds:         'sfx-blinds.mp3',
    circles:        'sfx-fade.mp3',
    shutterSlice:   'sfx-shutter.mp3',

    // ── Canonical modern transition vocabulary (transition-director / bridge) ──
    'push-left': 'sfx-slide.mp3', 'push-right': 'sfx-slide.mp3', 'push-up': 'sfx-slide.mp3',
    'wipe-left': 'sfx-wipe.mp3', 'wipe-right': 'sfx-wipe.mp3', 'wipe-up': 'sfx-wipe.mp3',
    'whip-left': 'sfx-whip.mp3', 'whip-right': 'sfx-whip.mp3',
    'zoom-punch': 'sfx-zoom.mp3', 'zoom-pull': 'sfx-zoom.mp3', 'spin-settle': 'sfx-spin.mp3',
    'blur-dissolve': 'sfx-blur.mp3', 'dip-black': 'sfx-fade.mp3', 'flash-white': 'sfx-flash.mp3',
    'light-sweep': 'sfx-warm-leak.mp3', 'fire-burn': 'sfx-filmburn.mp3', 'lens-flare': 'sfx-flare.mp3',
};

// MG type → SFX file for the build-pipeline fallback.
const MG_TO_SFX = {
    // Overlay MGs
    headline:        'sfx-mg-pop.mp3',
    lowerThird:      'sfx-mg-swoosh.mp3',
    callout:         'sfx-mg-swoosh.mp3',
    focusWord:       'sfx-mg-pop.mp3',
    statCounter:     'sfx-mg-tick.mp3',
    progressBar:     'sfx-mg-tick.mp3',
    bulletList:      'sfx-mg-pop.mp3',
    barChart:        'sfx-mg-ding.mp3',
    donutChart:      'sfx-mg-ding.mp3',
    comparisonCard:  'sfx-mg-ding.mp3',
    timeline:        'sfx-mg-rise.mp3',
    rankingList:     'sfx-mg-rise.mp3',
    kineticText:     'sfx-mg-type.mp3',
    typewriter:      'sfx-mg-type.mp3',
    subscribeCTA:    'sfx-mg-chime.mp3',
    mapChart:        'sfx-mg-ding.mp3',
    explainer:       'sfx-mg-swoosh.mp3',
    listicleCounter: 'sfx-mg-tick.mp3',
    progressTracker: 'sfx-mg-tick.mp3',
    // Fullscreen template MGs
    splitScreen:     'sfx-mg-swoosh.mp3',
    infographic:     'sfx-mg-ding.mp3',
    factCard:        'sfx-mg-pop.mp3',
    statCard:        'sfx-mg-ding.mp3',
    personIntro:     'sfx-mg-swoosh.mp3',
    imageShowcase:   'sfx-mg-pop.mp3',
    listicleGrid:    'sfx-mg-pop.mp3',
    chapterCard:     'sfx-mg-swoosh.mp3',
    locationCard:    'sfx-mg-swoosh.mp3',
    quoteCard:       'sfx-mg-rise.mp3',
    keyTakeaway:     'sfx-mg-ding.mp3',
    timelineCard:    'sfx-mg-rise.mp3',
};

// ============================================================
// UTILITIES
// ============================================================

/**
 * Sidecar marker — proves a SFX file came from Freesound (not synthetic).
 * Stored alongside the .mp3 as `.mp3.freesound` with download metadata.
 */
function _isFreesoundDownload(mp3Path) {
    if (!fs.existsSync(mp3Path)) return false;
    return fs.existsSync(mp3Path + '.freesound');
}

function _markFreesoundDownload(mp3Path, sound) {
    try {
        fs.writeFileSync(mp3Path + '.freesound', JSON.stringify({
            id: sound.id,
            name: sound.name,
            duration: sound.duration,
            license: sound.license,
            downloadedAt: Date.now(),
        }, null, 2));
    } catch (_) { /* non-fatal */ }
}

function _fetchJSON(url) {
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        proto.get(url, { headers: { 'User-Agent': 'YTA-Empire-WEBGL/1.0' } }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                return _fetchJSON(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Freesound API HTTP ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => { data += chunk; });
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(new Error('Invalid JSON from Freesound')); }
            });
        }).on('error', reject);
    });
}

function _sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// The sound designer's cinematic toolkit (impact / riser / boom). Fetched once
// per build so the agent always has hits + risers, not just transition whooshes.
const SOUND_DESIGN_KIT = ['sfx-impact.mp3', 'sfx-riser.mp3', 'sfx-boom.mp3'];
async function downloadSoundDesignKit({ log } = {}) {
    const token = config.freesound?.apiKey;
    if (!token) return { downloaded: 0, skipped: 0, failed: 0, noKey: true };
    if (!fs.existsSync(SFX_DIR)) fs.mkdirSync(SFX_DIR, { recursive: true });
    let downloaded = 0, skipped = 0, failed = 0;
    for (const filename of SOUND_DESIGN_KIT) {
        const catalog = SFX_CATALOG[filename];
        if (!catalog) continue;
        const destPath = path.join(SFX_DIR, filename);
        if (_isFreesoundDownload(destPath)) { skipped++; continue; }
        let success = false;
        for (const query of catalog.queries) {
            try {
                const results = await searchFreesound(query, { maxDuration: catalog.maxDuration, minDuration: catalog.minDuration, token });
                if (!results.length) continue;
                const scored = results.map(s => ({ ...s, score: _scoreSound(s, catalog) })).sort((a, b) => b.score - a.score);
                await downloadFile(scored[0].previewUrl, destPath);
                _markFreesoundDownload(destPath, scored[0]);
                if (log) log.dim(`  ✓ ${filename} ← "${scored[0].name}"`);
                downloaded++; success = true; break;
            } catch (_) { continue; }
        }
        if (!success) { failed++; if (log) log.dim(`  ✗ ${filename} — no results (designer will skip it)`); }
        await _sleep(250);
    }
    return { downloaded, skipped, failed };
}

module.exports = {
    SFX_CATALOG,
    TRANSITION_TO_SFX,
    MG_TO_SFX,
    downloadSfxForTransitions,
    downloadSoundDesignKit,
    searchFreesound,
};
