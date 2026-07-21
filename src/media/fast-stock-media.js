'use strict';
/**
 * fast-stock-media.js — one-shot FAST PIPELINE TEST media (BUILD_FAST_MEDIA=1).
 *
 * The real media pipeline is slow because, per scene, it plans a query, downloads
 * multiple candidates, vision-scores frames, and clip-vets them. For quickly testing
 * the rest of the build (Director → Planner → presenter/talking-head → MGs → templates
 * → transitions → SFX → effects → render) that per-scene gauntlet is pure overhead.
 *
 * This diagnostic path skips semantic matching. It pulls enough random real stock for
 * the current build, downloads each asset once, and assigns each asset to at most one
 * scene. The footage does not match the script, but a test build must still avoid
 * silently recycling the same small pool across an entire timeline.
 *
 * Falls back to a distinct labeled placeholder card per scene when no key/network is
 * available, so pipeline testing can proceed without duplicate visual assets.
 *
 * Returns the same shape as footage-manager.downloadAllMedia: { scenes, stats }.
 */
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../settings/config');
const { requestSafeBuffer } = require('../security/safe-download');

const DL_CONCURRENCY = 6;
const MAX_POOL_PAGES = 8;
const PEXELS_PAGE_SIZE = 80;
const PIXABAY_PAGE_SIZE = 200;
const MAX_MEDIA_BYTES = 120 * 1024 * 1024;

function _log(opts, msg) {
    (opts && typeof opts.log === 'function' ? opts.log : console.log)(msg);
}

function _enabledSources() {
    const defaults = { pexels: true, pixabay: true };
    try {
        const raw = process.env.FOOTAGE_SOURCES;
        if (raw) return { ...defaults, ...JSON.parse(raw) };
    } catch (_) {}
    return defaults;
}

function _sceneKind(scene) {
    const mediaType = String(scene?.mediaType || '').toLowerCase();
    const sourceHint = String(scene?.sourceHint || '').toLowerCase();
    return mediaType === 'image' || /(?:web-?image|image|still|photo)/.test(sourceHint)
        ? 'image'
        : 'video';
}

function _countDemand(scenes) {
    const demand = { image: 0, video: 0 };
    for (const scene of scenes || []) demand[_sceneKind(scene)]++;
    return demand;
}

function _poolTarget(required) {
    const count = Math.max(0, Number(required) || 0);
    if (!count) return 0;
    return count + Math.min(8, Math.max(2, Math.ceil(count * 0.15)));
}

function _assetUrlKey(rawUrl) {
    try {
        const parsed = new URL(String(rawUrl || ''));
        parsed.hash = '';
        return parsed.href.toLowerCase();
    } catch (_) {
        return String(rawUrl || '').trim().toLowerCase();
    }
}

function _uniqueAssets(assets, limit = Infinity) {
    const out = [];
    const seen = new Set();
    for (const entry of assets || []) {
        const asset = typeof entry === 'string' ? { url: entry } : entry;
        const url = String(asset?.url || '').trim();
        const key = _assetUrlKey(url);
        if (!url || !key || seen.has(key)) continue;
        seen.add(key);
        out.push({ ...asset, url });
        if (out.length >= limit) break;
    }
    return out;
}

function _pickPexelsVideoFile(files) {
    const mp4 = (files || []).filter((file) => file?.link && /mp4/i.test(file.file_type || 'video/mp4'));
    const testReady = mp4
        .filter((file) => (Number(file.width) || 0) >= 960)
        .sort((a, b) => (Number(a.width) || 0) - (Number(b.width) || 0));
    return testReady[0]
        || mp4.sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0))[0]
        || null;
}

async function _pexelsPool(targets, opts) {
    const key = config.pexels && config.pexels.apiKey;
    const imgs = [];
    const vids = [];
    if (!key || _enabledSources().pexels === false) return { imgs, vids };

    const imageTarget = Math.max(0, Number(targets?.image) || 0);
    const videoTarget = Math.max(0, Number(targets?.video) || 0);
    if (imageTarget > 0) {
        try {
            for (let page = 1; page <= MAX_POOL_PAGES && imgs.length < imageTarget; page++) {
                const r = await axios.get('https://api.pexels.com/v1/curated', {
                    params: {
                        page,
                        per_page: Math.min(PEXELS_PAGE_SIZE, Math.max(1, imageTarget - imgs.length)),
                    },
                    headers: { Authorization: key },
                    timeout: 15000,
                });
                const photos = (r.data && r.data.photos) || [];
                if (!photos.length) break;
                for (const photo of photos) {
                    const url = photo.src && (photo.src.large2x || photo.src.large || photo.src.original);
                    if (url) imgs.push({ url, provider: 'pexels', remoteId: photo.id || null });
                }
            }
        } catch (error) {
            _log(opts, `[FastMedia] Pexels photos failed: ${String(error.message || error).slice(0, 100)}`);
        }
    }
    if (videoTarget > 0) {
        try {
            for (let page = 1; page <= MAX_POOL_PAGES && vids.length < videoTarget; page++) {
                const r = await axios.get('https://api.pexels.com/videos/popular', {
                    params: {
                        page,
                        per_page: Math.min(PEXELS_PAGE_SIZE, Math.max(1, videoTarget - vids.length)),
                        min_width: 960,
                    },
                    headers: { Authorization: key },
                    timeout: 15000,
                });
                const videos = (r.data && r.data.videos) || [];
                if (!videos.length) break;
                for (const video of videos) {
                    const pick = _pickPexelsVideoFile(video.video_files);
                    if (pick) vids.push({ url: pick.link, provider: 'pexels', remoteId: video.id || null });
                }
            }
        } catch (error) {
            _log(opts, `[FastMedia] Pexels videos failed: ${String(error.message || error).slice(0, 100)}`);
        }
    }
    return {
        imgs: _uniqueAssets(imgs, imageTarget),
        vids: _uniqueAssets(vids, videoTarget),
    };
}

async function _pixabayPool(targets, opts) {
    const key = config.pixabay && config.pixabay.apiKey;
    const imgs = [];
    const vids = [];
    if (!key || _enabledSources().pixabay === false) return { imgs, vids };

    const imageTarget = Math.max(0, Number(targets?.image) || 0);
    const videoTarget = Math.max(0, Number(targets?.video) || 0);
    if (imageTarget > 0) {
        try {
            for (let page = 1; page <= MAX_POOL_PAGES && imgs.length < imageTarget; page++) {
                const r = await axios.get('https://pixabay.com/api/', {
                    params: {
                        key,
                        page,
                        editors_choice: true,
                        per_page: Math.min(PIXABAY_PAGE_SIZE, Math.max(3, imageTarget - imgs.length)),
                        safesearch: true,
                    },
                    timeout: 15000,
                });
                const hits = (r.data && r.data.hits) || [];
                if (!hits.length) break;
                for (const hit of hits) {
                    const url = hit.largeImageURL || hit.webformatURL;
                    if (url) imgs.push({ url, provider: 'pixabay', remoteId: hit.id || null });
                }
            }
        } catch (error) {
            _log(opts, `[FastMedia] Pixabay photos failed: ${String(error.message || error).slice(0, 100)}`);
        }
    }
    if (videoTarget > 0) {
        try {
            for (let page = 1; page <= MAX_POOL_PAGES && vids.length < videoTarget; page++) {
                const r = await axios.get('https://pixabay.com/api/videos/', {
                    params: {
                        key,
                        page,
                        per_page: Math.min(PIXABAY_PAGE_SIZE, Math.max(3, videoTarget - vids.length)),
                        safesearch: true,
                    },
                    timeout: 15000,
                });
                const hits = (r.data && r.data.hits) || [];
                if (!hits.length) break;
                for (const hit of hits) {
                    const video = hit.videos && (hit.videos.medium || hit.videos.small || hit.videos.large);
                    if (video?.url) vids.push({ url: video.url, provider: 'pixabay', remoteId: hit.id || null });
                }
            }
        } catch (error) {
            _log(opts, `[FastMedia] Pixabay videos failed: ${String(error.message || error).slice(0, 100)}`);
        }
    }
    return {
        imgs: _uniqueAssets(imgs, imageTarget),
        vids: _uniqueAssets(vids, videoTarget),
    };
}

function _looksLikeMedia(buffer, kind) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 1024) return false;
    if (kind === 'image') {
        const isJpeg = buffer[0] === 0xff && buffer[1] === 0xd8;
        const isPng = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        const isWebp = buffer.subarray(0, 4).toString('ascii') === 'RIFF'
            && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
        return isJpeg || isPng || isWebp;
    }
    return buffer.subarray(0, 32).includes(Buffer.from('ftyp'));
}

async function _downloadPool(assets, kind, targetCount, tempDir, opts, seenHashes) {
    const unique = _uniqueAssets(assets);
    const out = [];
    let cursor = 0;
    async function worker() {
        while (out.length < targetCount) {
            const idx = cursor++;
            if (idx >= unique.length) return;
            const asset = unique[idx];
            const ext = kind === 'image' ? '.jpg' : '.mp4';
            try {
                const r = await requestSafeBuffer(
                    asset.url,
                    { timeout: 60000 },
                    { maxRedirects: 5, maxBytes: MAX_MEDIA_BYTES }
                );
                const data = Buffer.from(r.data);
                if (!_looksLikeMedia(data, kind)) throw new Error(`response is not a valid ${kind}`);
                const hash = crypto.createHash('sha256').update(data).digest('hex');
                if (seenHashes.has(hash) || out.length >= targetCount) continue;
                const dest = path.join(tempDir, `faststock-${kind}-${hash.slice(0, 12)}-${idx}${ext}`);
                fs.writeFileSync(dest, data);
                seenHashes.add(hash);
                out.push({ ...asset, path: dest, kind, hash, _owned: true });
            } catch (error) {
                _log(opts, `[FastMedia] ${kind} download failed: ${String(error.message || error).slice(0, 90)}`);
            }
        }
    }
    const workers = Math.min(DL_CONCURRENCY, unique.length, Math.max(1, targetCount));
    await Promise.all(Array.from({ length: workers }, worker));
    return out;
}

function _placeholderCard(scene, dest) {
    let createCanvas;
    try {
        ({ createCanvas } = require('@napi-rs/canvas'));
    } catch (_) {
        return null;
    }
    try {
        const W = 1920;
        const H = 1080;
        const canvas = createCanvas(W, H);
        const ctx = canvas.getContext('2d');
        const hue = (Number(scene.index) * 47) % 360;
        const g = ctx.createLinearGradient(0, 0, W, H);
        g.addColorStop(0, `hsl(${hue},55%,32%)`);
        g.addColorStop(1, `hsl(${(hue + 40) % 360},55%,14%)`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        ctx.fillStyle = 'rgba(255,255,255,0.92)';
        ctx.font = 'bold 220px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(`#${scene.index}`, W / 2, H / 2 - 40);
        ctx.font = '48px sans-serif';
        const keyword = String(
            scene.keyword || scene.visualIntent || (scene.text || '').slice(0, 48) || 'test'
        ).slice(0, 48);
        ctx.fillText(keyword, W / 2, H / 2 + 80);
        ctx.font = '32px sans-serif';
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.fillText('⚡ FAST PIPELINE TEST PLACEHOLDER', W / 2, H - 70);
        fs.writeFileSync(dest, canvas.toBuffer('image/png'));
        return dest;
    } catch (_) {
        return null;
    }
}

function _normalizePrefetched(files, kind) {
    return (files || []).map((entry, index) => {
        if (typeof entry === 'string') {
            return { path: entry, provider: 'fast-test-fixture', kind, remoteId: index };
        }
        return {
            ...entry,
            path: entry?.path || entry?.file || '',
            provider: entry?.provider || 'fast-test-fixture',
            kind,
        };
    }).filter((entry) => entry.path && fs.existsSync(entry.path));
}

function _sceneFileBase(scene, fallbackIndex) {
    const raw = scene?.index ?? fallbackIndex;
    const safe = String(raw).replace(/[^a-z0-9_-]/gi, '-').replace(/-+/g, '-');
    return safe || String(fallbackIndex);
}

function _materializeAsset(asset, scene, fallbackIndex, tempDir) {
    const ext = asset.kind === 'image' ? '.jpg' : '.mp4';
    const dest = path.join(tempDir, `scene-${_sceneFileBase(scene, fallbackIndex)}${ext}`);
    try {
        const src = path.resolve(asset.path);
        const target = path.resolve(dest);
        if (src.toLowerCase() === target.toLowerCase()) return target;
        try {
            if (fs.existsSync(target)) fs.unlinkSync(target);
        } catch (_) {}
        try {
            fs.renameSync(src, target);
        } catch (error) {
            if (error.code !== 'EXDEV') throw error;
            fs.copyFileSync(src, target);
            fs.unlinkSync(src);
        }
        return target;
    } catch (_) {
        return null;
    }
}

function _setSceneMedia(scene, file, mediaType, provider, details = {}) {
    if (scene.plannedSourceHint == null) scene.plannedSourceHint = scene.sourceHint || null;
    scene.mediaFile = file;
    scene.mediaExtension = path.extname(file) || (mediaType === 'image' ? '.jpg' : '.mp4');
    scene.mediaType = mediaType;
    scene.sourceProvider = provider;
    scene.sourceHint = 'stock';
    scene.mediaDownloadStatus = details.placeholder ? 'fallback' : 'accepted';
    scene._fileIndex = scene.index;
    scene._fastStock = true;
    scene.mediaDiagnostics = {
        ...(scene.mediaDiagnostics || {}),
        fastTest: {
            diagnosticOnly: true,
            semanticMatching: false,
            uniqueAsset: true,
            provider,
            remoteId: details.remoteId ?? null,
            contentHash: details.hash || null,
            placeholder: Boolean(details.placeholder),
        },
    };
}

function _cleanupUnusedAssets(assets) {
    for (const asset of assets || []) {
        if (!asset?._owned || !asset.path) continue;
        try {
            if (fs.existsSync(asset.path)) fs.unlinkSync(asset.path);
        } catch (_) {}
    }
}

/**
 * @returns {Promise<{scenes:Array, stats:Object}>} same shape as downloadAllMedia
 */
async function fastTestMedia(scenes, opts = {}) {
    const list = Array.isArray(scenes) ? scenes.filter(Boolean) : [];
    const tempDir = opts.tempDir || (config.paths && config.paths.temp) || process.cwd();
    try {
        fs.mkdirSync(tempDir, { recursive: true });
    } catch (_) {}

    const demand = _countDemand(list);
    const target = {
        image: _poolTarget(demand.image),
        video: _poolTarget(demand.video),
    };

    let imgFiles;
    let vidFiles;
    if (opts.prefetchedFiles) {
        imgFiles = _normalizePrefetched(opts.prefetchedFiles.images, 'image');
        vidFiles = _normalizePrefetched(opts.prefetchedFiles.videos, 'video');
        _log(opts, `[FastMedia] fixture pool: ${imgFiles.length} images + ${vidFiles.length} videos`);
    } else {
        const pexels = await _pexelsPool(target, opts);
        const missing = {
            image: Math.max(0, target.image - pexels.imgs.length),
            video: Math.max(0, target.video - pexels.vids.length),
        };
        const pixabay = (missing.image || missing.video)
            ? await _pixabayPool(missing, opts)
            : { imgs: [], vids: [] };
        const pool = {
            imgs: _uniqueAssets([...pexels.imgs, ...pixabay.imgs], target.image),
            vids: _uniqueAssets([...pexels.vids, ...pixabay.vids], target.video),
        };
        _log(
            opts,
            `[FastMedia] unique stock candidates: ${pool.imgs.length} images + ${pool.vids.length} videos `
            + `(need ${demand.image} + ${demand.video}; no scene-level reuse)`
        );
        const seenHashes = new Set();
        [imgFiles, vidFiles] = await Promise.all([
            _downloadPool(pool.imgs, 'image', target.image, tempDir, opts, seenHashes),
            _downloadPool(pool.vids, 'video', target.video, tempDir, opts, seenHashes),
        ]);
        _log(opts, `[FastMedia] unique downloads: ${imgFiles.length} images + ${vidFiles.length} videos`);
    }

    const imageQueue = [...imgFiles];
    const videoQueue = [...vidFiles];
    const placeholderFactory = typeof opts.placeholderFactory === 'function'
        ? opts.placeholderFactory
        : _placeholderCard;
    let cards = 0;
    let stock = 0;
    let failed = 0;

    for (let n = 0; n < list.length; n++) {
        const scene = list[n];
        const wantedKind = _sceneKind(scene);
        const preferred = wantedKind === 'image' ? imageQueue : videoQueue;
        const alternate = wantedKind === 'image' ? videoQueue : imageQueue;
        const asset = preferred.shift() || alternate.shift() || null;
        let file = null;
        let mediaType = asset?.kind || null;
        if (asset) file = _materializeAsset(asset, scene, n, tempDir);

        if (!file) {
            const dest = path.join(tempDir, `scene-${_sceneFileBase(scene, n)}.png`);
            file = placeholderFactory(scene, dest);
            mediaType = 'image';
            if (file) {
                cards++;
                _setSceneMedia(scene, file, mediaType, 'fast-test-placeholder', { placeholder: true });
            }
        } else {
            stock++;
            _setSceneMedia(scene, file, mediaType, asset.provider || 'faststock', {
                remoteId: asset.remoteId,
                hash: asset.hash,
            });
        }
        if (!file) failed++;
    }

    _cleanupUnusedAssets([...imageQueue, ...videoQueue]);
    _log(
        opts,
        `[FastMedia] assigned ${stock} unique stock + ${cards} unique placeholder(s) across ${list.length} scene(s)`
        + (failed ? `; ${failed} failed` : '')
    );
    return {
        scenes: list,
        stats: {
            total: list.length,
            faststock: stock,
            faststockCards: cards,
            directAccepted: stock,
            providerFallbackAccepted: cards,
            agenticGraphicFallback: 0,
            failed,
        },
    };
}

module.exports = {
    fastTestMedia,
    __test: {
        countDemand: _countDemand,
        poolTarget: _poolTarget,
        sceneKind: _sceneKind,
        uniqueAssets: _uniqueAssets,
    },
};
