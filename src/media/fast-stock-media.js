'use strict';
/**
 * fast-stock-media.js — FAST TEST media (BUILD_FAST_MEDIA=1).
 *
 * The real media pipeline is slow because, per scene, it plans a query, downloads
 * MULTIPLE candidates, vision-scores frames, and clip-vets them. For quickly testing
 * the REST of the build (Director → Planner → presenter/talking-head → MGs → templates
 * → transitions → SFX → effects → render) that per-scene gauntlet is pure overhead.
 *
 * This module SKIPS all of it: it pulls a small POOL of random real stock once (Pexels
 * curated photos + popular videos — no query, no vision), downloads it, and round-robins
 * it across scenes by media type. The footage does NOT match the script — that's the
 * point: real footage look, a fraction of the time. Falls back to labeled placeholder
 * cards (canvas) when no key / network fails, so the test always proceeds.
 *
 * Returns the same shape as footage-manager.downloadAllMedia: { scenes, stats }.
 */
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const config = require('../settings/config');

const IMG_POOL = 16;
const VID_POOL = 14;
const DL_CONCURRENCY = 6;

function _log(opts, msg) { (opts && typeof opts.log === 'function' ? opts.log : console.log)(msg); }

async function _pexelsPool() {
    const key = config.pexels && config.pexels.apiKey;
    const imgs = [], vids = [];
    if (!key) return { imgs, vids };
    try {
        const r = await axios.get('https://api.pexels.com/v1/curated', { params: { per_page: IMG_POOL }, headers: { Authorization: key }, timeout: 15000 });
        for (const p of (r.data && r.data.photos) || []) {
            const u = p.src && (p.src.large2x || p.src.large || p.src.original);
            if (u) imgs.push(u);
        }
    } catch (e) { _log(null, `[FastMedia] pexels photos failed: ${String(e.message || e).slice(0, 80)}`); }
    try {
        const r = await axios.get('https://api.pexels.com/videos/popular', { params: { per_page: VID_POOL, min_width: 1280 }, headers: { Authorization: key }, timeout: 15000 });
        for (const v of (r.data && r.data.videos) || []) {
            const files = (v.video_files || []).filter(f => f && f.link);
            // smallest HD (>=1280w) mp4 keeps downloads quick; else the biggest available.
            const hd = files.filter(f => (f.width || 0) >= 1280 && /mp4/i.test(f.file_type || 'video/mp4')).sort((a, b) => (a.width || 0) - (b.width || 0));
            const pick = hd[0] || files.sort((a, b) => (b.width || 0) - (a.width || 0))[0];
            if (pick) vids.push(pick.link);
        }
    } catch (e) { _log(null, `[FastMedia] pexels videos failed: ${String(e.message || e).slice(0, 80)}`); }
    return { imgs, vids };
}

async function _pixabayPool() {
    const key = config.pixabay && config.pixabay.apiKey;
    const imgs = [], vids = [];
    if (!key) return { imgs, vids };
    try {
        const r = await axios.get('https://pixabay.com/api/', { params: { key, editors_choice: true, per_page: IMG_POOL, safesearch: true }, timeout: 15000 });
        for (const h of (r.data && r.data.hits) || []) { if (h.largeImageURL || h.webformatURL) imgs.push(h.largeImageURL || h.webformatURL); }
    } catch (_) {}
    try {
        const r = await axios.get('https://pixabay.com/api/videos/', { params: { key, per_page: VID_POOL, safesearch: true }, timeout: 15000 });
        for (const h of (r.data && r.data.hits) || []) {
            const v = h.videos && (h.videos.medium || h.videos.small || h.videos.large);
            if (v && v.url) vids.push(v.url);
        }
    } catch (_) {}
    return { imgs, vids };
}

async function _downloadPool(urls, kind, tempDir, opts) {
    const out = [];
    let i = 0;
    async function worker() {
        while (i < urls.length) {
            const idx = i++;
            const url = urls[idx];
            const ext = kind === 'image' ? '.jpg' : '.mp4';
            const dest = path.join(tempDir, `faststock-${kind}-${idx}${ext}`);
            try {
                const r = await axios.get(url, { responseType: 'arraybuffer', timeout: 60000, maxContentLength: 120 * 1024 * 1024 });
                fs.writeFileSync(dest, Buffer.from(r.data));
                out.push(dest);
            } catch (e) { _log(opts, `[FastMedia] ${kind} dl failed: ${String(e.message || e).slice(0, 70)}`); }
        }
    }
    await Promise.all(Array.from({ length: Math.min(DL_CONCURRENCY, urls.length) }, worker));
    return out;
}

// Labeled gradient card fallback (canvas). Distinct hue per scene so structure is readable.
function _placeholderCard(scene, dest) {
    let createCanvas;
    try { ({ createCanvas } = require('@napi-rs/canvas')); } catch (_) { return null; }
    try {
        const W = 1920, H = 1080;
        const canvas = createCanvas(W, H);
        const ctx = canvas.getContext('2d');
        const hue = (Number(scene.index) * 47) % 360;
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, `hsl(${hue},55%,32%)`);
        g.addColorStop(1, `hsl(${(hue + 40) % 360},55%,14%)`);
        ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.font = 'bold 220px sans-serif'; ctx.textAlign = 'center';
        ctx.fillText(`#${scene.index}`, W / 2, H / 2 - 40);
        ctx.font = '48px sans-serif';
        const kw = String(scene.keyword || scene.visualIntent || (scene.text || '').slice(0, 48) || 'test').slice(0, 48);
        ctx.fillText(kw, W / 2, H / 2 + 80);
        ctx.font = '32px sans-serif'; ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fillText('⚡ FAST TEST PLACEHOLDER', W / 2, H - 70);
        fs.writeFileSync(dest, canvas.toBuffer('image/png'));
        return dest;
    } catch (_) { return null; }
}

/**
 * @returns {Promise<{scenes:Array, stats:Object}>} same shape as downloadAllMedia
 */
async function fastTestMedia(scenes, opts = {}) {
    const list = Array.isArray(scenes) ? scenes.filter(Boolean) : [];
    const tempDir = (opts.tempDir) || (config.paths && config.paths.temp) || process.cwd();
    try { fs.mkdirSync(tempDir, { recursive: true }); } catch (_) {}

    // 1) fetch a random pool once (Pexels → Pixabay top-up)
    let pool = await _pexelsPool();
    if (pool.imgs.length < 4 || pool.vids.length < 3) {
        const px = await _pixabayPool();
        pool = { imgs: [...pool.imgs, ...px.imgs], vids: [...pool.vids, ...px.vids] };
    }
    _log(opts, `[FastMedia] stock pool: ${pool.imgs.length} images + ${pool.vids.length} videos`);

    // 2) download the pool once (parallel, capped)
    const [imgFiles, vidFiles] = await Promise.all([
        _downloadPool(pool.imgs, 'image', tempDir, opts),
        _downloadPool(pool.vids, 'video', tempDir, opts),
    ]);
    _log(opts, `[FastMedia] downloaded pool: ${imgFiles.length} images + ${vidFiles.length} videos`);

    // 3) round-robin assign by scene media type; card fallback when a lane is empty
    let ii = 0, vi = 0, cards = 0, stock = 0;
    for (let n = 0; n < list.length; n++) {
        const scene = list[n];
        const wantsImage = String(scene.mediaType || '').toLowerCase() === 'image' || /image/.test(String(scene.sourceHint || ''));
        let file = null, mediaType = null;
        if (wantsImage && imgFiles.length) { file = imgFiles[ii++ % imgFiles.length]; mediaType = 'image'; }
        else if (!wantsImage && vidFiles.length) { file = vidFiles[vi++ % vidFiles.length]; mediaType = 'video'; }
        else if (imgFiles.length) { file = imgFiles[ii++ % imgFiles.length]; mediaType = 'image'; }
        else if (vidFiles.length) { file = vidFiles[vi++ % vidFiles.length]; mediaType = 'video'; }
        if (!file) {
            // no stock at all → labeled placeholder card
            const dest = path.join(tempDir, `faststock-card-${scene.index}.png`);
            file = _placeholderCard(scene, dest);
            mediaType = 'image';
            if (file) cards++;
        } else { stock++; }
        if (!file) continue; // canvas unavailable + no stock — leave scene to the solid-color fallback
        scene.mediaFile = file;
        scene.mediaExtension = path.extname(file) || (mediaType === 'image' ? '.jpg' : '.mp4');
        scene.mediaType = mediaType;
        scene.sourceProvider = 'faststock';
        scene.sourceHint = mediaType === 'image' ? 'web-image' : 'stock';
        scene.mediaDownloadStatus = 'accepted';
        scene._fileIndex = scene.index;
        scene._fastStock = true;
    }
    _log(opts, `[FastMedia] assigned ${stock} stock + ${cards} card placeholder(s) across ${list.length} scene(s)`);
    return { scenes: list, stats: { faststock: stock, faststockCards: cards, directAccepted: stock } };
}

module.exports = { fastTestMedia };
