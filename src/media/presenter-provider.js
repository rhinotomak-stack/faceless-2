'use strict';
/**
 * presenter-provider.js — the SWAPPABLE presenter media source for talking-head mode.
 *
 * The whole talking-head editing/compositing pipeline treats the presenter as an
 * abstract media source. TODAY that source is a single STATIC person image (the same
 * image for every insert — one consistent host). LATER it becomes a per-scene
 * lip-synced AVATAR VIDEO clip returned by an external API (HeyGen/Synthesia/etc).
 *
 * The ONLY thing that changes when the avatar API arrives is this file (+ flipping
 * scriptContext.presenter.mode to 'avatar'). Selection, layout, budget, framing,
 * side-graphics and z-order in presenter-assignment.js / hyperframes-bridge.js are
 * identical for image and video.
 *
 *   createPresenterProvider(scriptContext) -> provider
 *   provider.getPresenterMedia(scene, scriptContext) -> { type:'image'|'video', file } | null
 *   resolvePresenterMedia(scenes, scriptContext, opts) -> Promise<number>   // the single pipeline seam
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv']);

function mediaTypeForFile(file) {
    const ext = path.extname(String(file || '')).toLowerCase();
    return VIDEO_EXTS.has(ext) ? 'video' : 'image';
}

// ── Static image presenter (current) ─────────────────────────────────────────
// One image for the whole video. Instant, deterministic, no network.
class StaticImagePresenterProvider {
    constructor(scriptContext) {
        this.imageFile = (scriptContext && scriptContext.presenter && scriptContext.presenter.imageFile) || null;
    }
    getPresenterMedia(/* scene, scriptContext */) {
        if (!this.imageFile) return null;
        return { type: 'image', file: this.imageFile };
    }
}

// ── Avatar presenter (future) ─────────────────────────────────────────────────
// STUB: when the avatar API is wired, call it here with the scene's VO segment /
// text and return a per-scene lip-synced clip { type:'video', file }. Cache per
// scene index. Until wired it falls back to the static image so builds still work.
class AvatarPresenterProvider {
    constructor(scriptContext) {
        this.scriptContext = scriptContext;
        this.fallbackImage = (scriptContext && scriptContext.presenter && scriptContext.presenter.imageFile) || null;
    }
    async getPresenterMedia(/* scene, scriptContext */) {
        // TODO(avatar): POST scene VO segment + presenter identity image to the avatar
        // API, download the lip-synced clip, cache it, and return { type:'video', file }.
        if (this.fallbackImage) return { type: mediaTypeForFile(this.fallbackImage), file: this.fallbackImage };
        return null;
    }
}

// ── Kling AI-Human browser-bridge presenter (real lip-synced avatar via the
// consumer web account, no paid API key) ─────────────────────────────────────
// Per presenter scene: slice that scene's narration audio, drive the Kling web UI
// (providers/kling-avatar-browser.js) to lip-sync the presenter PHOTO to it, cache
// the clip per (image+time-range). ANY failure → static-image fallback so a build
// never breaks. Slow (a browser generation per scene) but the presenter is sparse.
// Multi-beat holds get one clip per beat (they play back-to-back through the
// suppressed-cut hold); single-beat holds are seamless. Cache makes rebuilds free.
class KlingBrowserPresenterProvider {
    constructor(scriptContext, opts = {}) {
        const p = (scriptContext && scriptContext.presenter) || {};
        this.imageFile = p.imageFile || null;
        this.fallbackImage = this.imageFile;
        this.audioFile = opts.audioFile || null;
        this.ffmpegPath = opts.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
        this.log = opts.log || console;
        const base = opts.projectDir ? path.resolve(opts.projectDir) : process.cwd();
        this.workDir = path.join(base, 'temp', '.kling-avatar');
        try { fs.mkdirSync(this.workDir, { recursive: true }); } catch (_) {}
        this.minSeconds = Math.max(0.6, Number(process.env.KLING_MIN_SECONDS || 0.8));
    }

    _static() { return this.fallbackImage ? { type: mediaTypeForFile(this.fallbackImage), file: this.fallbackImage } : null; }

    _sliceAudio(start, end, key) {
        if (!this.audioFile || !fs.existsSync(this.audioFile)) return null;
        const out = path.join(this.workDir, `voice-${key}.wav`);
        if (fs.existsSync(out) && fs.statSync(out).size > 2000) return out;
        try {
            require('child_process').execFileSync(this.ffmpegPath, [
                '-y', '-ss', String(Math.max(0, start)), '-to', String(end),
                '-i', this.audioFile, '-vn', '-ar', '44100', '-ac', '1', out,
            ], { stdio: 'ignore', timeout: 60_000 });
            return (fs.existsSync(out) && fs.statSync(out).size > 2000) ? out : null;
        } catch (e) {
            if (this.log.warn) this.log.warn(`[Presenter] audio slice failed: ${e.message}`);
            return null;
        }
    }

    async getPresenterMedia(scene /*, scriptContext */) {
        if (!this.imageFile) return null;
        const start = Number(scene && scene.startTime) || 0;
        const end = Number(scene && scene.endTime) || 0;
        if (!(end > start) || (end - start) < this.minSeconds) return this._static(); // too short to lip-sync
        const key = crypto.createHash('sha1').update(`${this.imageFile}|${start.toFixed(2)}|${end.toFixed(2)}`).digest('hex').slice(0, 16);
        const clip = path.join(this.workDir, `clip-${key}.mp4`);
        if (fs.existsSync(clip) && fs.statSync(clip).size > 10_000) return { type: 'video', file: clip }; // cached
        const slice = this._sliceAudio(start, end, key);
        if (!slice) return this._static();
        let bridge = null;
        try { bridge = require('./providers/kling-avatar-browser'); } catch (_) { return this._static(); }
        if (!bridge.cookiesPresent || !bridge.cookiesPresent()) {
            if (this.log.warn) this.log.warn('[Presenter] Kling cookies missing — run `npm run kling-cookies`; using static image');
            return this._static();
        }
        try {
            if (this.log.info) this.log.info(`[Presenter] Kling avatar → scene ${scene.index} (${(end - start).toFixed(1)}s)…`);
            await bridge.generateAvatarClip({ imageFile: this.imageFile, audioFile: slice, outFile: clip, log: (m) => (this.log.info ? this.log.info(m) : console.log(m)) });
            return { type: 'video', file: clip };
        } catch (e) {
            if (this.log.warn) this.log.warn(`[Presenter] Kling avatar failed for scene ${scene.index}: ${e.message} — static image`);
            return this._static();
        }
    }
}

function _klingEnabled(scriptContext) {
    if (/^(1|true|on|yes)$/i.test(String(process.env.KLING_AVATAR || '').trim())) return true;
    const p = scriptContext && scriptContext.presenter;
    return !!(p && p.mode === 'avatar' && /kling/i.test(String(p.avatarBackend || '')));
}

function createPresenterProvider(scriptContext, opts = {}) {
    const log = opts.log || console;
    if (_klingEnabled(scriptContext)) {
        let bridge = null;
        try { bridge = require('./providers/kling-avatar-browser'); } catch (_) { /* puppeteer/bridge missing */ }
        if (bridge && bridge.cookiesPresent && bridge.cookiesPresent()) {
            return new KlingBrowserPresenterProvider(scriptContext, opts);
        }
        if (log.warn) log.warn('[Presenter] Kling avatar requested but no cookies (.kling-cookies.json) — run `npm run kling-cookies`; using static image');
    }
    const mode = (scriptContext && scriptContext.presenter && scriptContext.presenter.mode) || 'static';
    if (mode === 'avatar') return new AvatarPresenterProvider(scriptContext);
    return new StaticImagePresenterProvider(scriptContext);
}

/**
 * The SINGLE place the provider is invoked in the pipeline (build-video Step ~6.8).
 * Fills presenter media onto every scene that carries a `presenterInsert`:
 *   fullframe / framed → the scene's OWN mediaFile IS the presenter media
 *                        (rides the normal scene render path).
 *   pip                → presenterInsert.mediaFile holds it (base scene stays B-roll).
 * Static resolution is synchronous; the avatar impl awaits its API here.
 * @returns {Promise<number>} count of insert scenes filled.
 */
async function resolvePresenterMedia(scenes, scriptContext, opts = {}) {
    const log = opts.log || console;
    if (!Array.isArray(scenes) || !scriptContext || scriptContext.productionMode !== 'talkingHead') return 0;
    if (!scriptContext.presenter || !scriptContext.presenter.imageFile) return 0;

    const provider = createPresenterProvider(scriptContext, opts);
    let filled = 0;
    for (const scene of scenes) {
        const ins = scene && scene.presenterInsert;
        if (!ins || !ins.layout) continue;
        let media = null;
        try {
            media = await provider.getPresenterMedia(scene, scriptContext);
        } catch (e) {
            if (log.warn) log.warn(`[Presenter] media fetch failed for scene ${scene.index}: ${e.message}`);
            media = null;
        }
        if (!media || !media.file) continue;
        ins.mediaType = media.type;
        ins.mediaFile = media.file;
        if (ins.layout !== 'pip' && ins.layout !== 'split') {
            // framed: the presenter IS the scene's base media. (pip/split keep the B-roll base.)
            scene.mediaFile = media.file;
            scene.mediaType = media.type;
        }
        filled++;
    }
    if (filled && log.info) log.info(`[Presenter] Resolved presenter media for ${filled} insert scene(s)`);
    return filled;
}

module.exports = {
    createPresenterProvider,
    StaticImagePresenterProvider,
    AvatarPresenterProvider,
    KlingBrowserPresenterProvider,
    resolvePresenterMedia,
    mediaTypeForFile,
};
