/**
 * music-provider.js — free background-music-bed provider (OPENMONTAGE-BORROW-PLAN #14).
 *
 * Feeds the ducking mixer we already built (audio-mixer.js reads plan.musicBed).
 * Sources a single mood-matched, royalty-free instrumental bed:
 *   1. LOCAL-FIRST — any file in MUSIC_LIBRARY_DIR or assets/music/ wins (zero API).
 *   2. Freesound (music, long duration, CC0 preferred) via the same token as SFX.
 *
 * DEFAULT OFF — set MUSIC_BED=1 to enable. Any failure returns {skipped|failed}
 * and the build proceeds bedless (audio-mixer degrades to loudnorm-only).
 * Clean-room from OpenMontage's freesound_music technique (AGPLv3); code is ours.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const config = require('../settings/config');

let searchFreesound = null;
try { ({ searchFreesound } = require('./sfx-provider')); } catch (_) { /* optional */ }

const MUSIC_DIR = path.join(__dirname, '..', '..', 'assets', 'music');
const AUDIO_RE = /\.(mp3|m4a|aac|ogg|wav)$/i;

function _enabled() { return /^(1|true|on|yes)$/i.test(String(process.env.MUSIC_BED || '').trim()); }
function _slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'bed'; }

function _download(url, dest, depth = 0) {
    return new Promise((resolve, reject) => {
        if (depth > 4) return reject(new Error('too many redirects'));
        const mod = url.startsWith('http:') ? http : https;
        const file = fs.createWriteStream(dest);
        const req = mod.get(url, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                file.close(); fs.unlink(dest, () => {});
                return _download(res.headers.location, dest, depth + 1).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) { file.close(); fs.unlink(dest, () => {}); return reject(new Error(`HTTP ${res.statusCode}`)); }
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve(dest)));
        });
        req.on('error', (e) => { file.close(); fs.unlink(dest, () => {}); reject(e); });
        req.setTimeout(30_000, () => { req.destroy(new Error('timeout')); });
    });
}

// Niche-AGNOSTIC mood query derived from Director data (no niche/word hardcoding).
function _buildQuery(ctx = {}) {
    const mood = String(ctx.mood || ctx.tone || '').split(/[,;/]/)[0].trim();
    const pacingMood = `${ctx.pacing || ''} ${ctx.mood || ''} ${ctx.tone || ''}`;
    const bits = [];
    if (mood) bits.push(mood);
    if (/slow|calm|somber|reflective|solemn|elegiac/i.test(pacingMood)) bits.push('ambient');
    else if (/fast|energetic|intense|urgent|driving|upbeat/i.test(pacingMood)) bits.push('driving');
    bits.push('cinematic', 'instrumental', 'underscore', 'background');
    return [...new Set(bits.filter(Boolean))].join(' ');
}

/**
 * @returns {Promise<{file?:string, source?:string, attribution?:object, skipped?:boolean, failed?:boolean, reason?:string}>}
 * `file` is a bare filename resolved by main.js against PUBLIC/TEMP/INPUT.
 */
async function downloadMusicBed({ scriptContext = {}, log = () => {} } = {}) {
    if (!_enabled()) return { skipped: true, reason: 'MUSIC_BED not enabled' };
    try { if (!fs.existsSync(MUSIC_DIR)) fs.mkdirSync(MUSIC_DIR, { recursive: true }); } catch (_) {}

    // 1) Local-first — a user-supplied library file wins, zero API cost.
    for (const d of [process.env.MUSIC_LIBRARY_DIR, MUSIC_DIR].filter(Boolean)) {
        try {
            const f = (fs.readdirSync(d) || []).find((x) => AUDIO_RE.test(x) && !x.endsWith('.freesound'));
            if (f) {
                if (path.resolve(d) !== path.resolve(MUSIC_DIR)) {
                    try { fs.copyFileSync(path.join(d, f), path.join(MUSIC_DIR, f)); } catch (_) {}
                }
                log(`[Music] using existing bed: ${f}`);
                return { file: f, source: 'library' };
            }
        } catch (_) { /* dir missing */ }
    }

    const token = config.freesound?.apiKey;
    if (!token) { log('[Music] no FREESOUND_API_KEY — skipping music bed'); return { skipped: true, reason: 'no key' }; }
    if (!searchFreesound) return { skipped: true, reason: 'searchFreesound unavailable' };

    const query = _buildQuery(scriptContext);
    const name = `bed-${_slug(query)}.mp3`;
    const dest = path.join(MUSIC_DIR, name);
    if (fs.existsSync(dest)) { log(`[Music] cached bed: ${name}`); return { file: name, source: 'cache' }; }

    let results = [];
    try { results = await searchFreesound(query, { minDuration: 30, maxDuration: 600, token }); }
    catch (e) { log(`[Music] search failed: ${e.message}`); return { failed: true }; }

    // Prefer long, popular, CC0.
    const scored = (results || [])
        .filter((r) => r.previewUrl)
        .map((r) => ({ r, s: Math.min((r.downloads || 0) / 1000, 5) + ((r.license || '').includes('Creative Commons 0') ? 2 : 0) + (r.duration >= 60 ? 1 : 0) }))
        .sort((a, b) => b.s - a.s);
    const best = scored[0] && scored[0].r;
    if (!best) { log('[Music] no suitable bed found'); return { failed: true }; }

    try { await _download(best.previewUrl, dest); }
    catch (e) { log(`[Music] download failed: ${e.message}`); try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch (_) {} return { failed: true }; }

    try {
        fs.writeFileSync(dest + '.freesound', JSON.stringify({ id: best.id, name: best.name, license: best.license, attributionUrl: `https://freesound.org/s/${best.id}/`, query }));
    } catch (_) {}
    log(`[Music] downloaded "${best.name}" (${Math.round(best.duration)}s, ${best.license}) → ${name}`);
    return { file: name, source: 'freesound', attribution: best };
}

module.exports = { downloadMusicBed };
