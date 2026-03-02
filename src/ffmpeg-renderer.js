'use strict';

const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');

// Version marker — if you see this in the log, the latest code is loaded
const RENDERER_VERSION = 'v6-order-fix-2026-03-02';

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------

const FFMPEG_PATH = process.env.FFMPEG_PATH || 'C:\\ffmg\\bin\\ffmpeg.exe';
const FFPROBE_PATH = process.env.FFPROBE_PATH || 'C:\\ffmg\\bin\\ffprobe.exe';
const OUTPUT_WIDTH = 1920;
const OUTPUT_HEIGHT = 1080;
const PARALLEL_LIMIT = 2; // Keep at 2 to avoid NVENC session contention on consumer GPUs

// Fast + close quality defaults (override via env if needed)
const NVENC_PRESET_FAST = process.env.FFMPEG_NVENC_PRESET || 'p4';
const NVENC_PRESET_COMPAT = process.env.FFMPEG_NVENC_COMPAT_PRESET || 'medium';
const PREP_VIDEO_BITRATE = process.env.FFMPEG_PREP_BITRATE || '6M';
const FINAL_VIDEO_BITRATE = process.env.FFMPEG_FINAL_BITRATE || '18M';
const FINAL_VIDEO_MAXRATE = process.env.FFMPEG_FINAL_MAXRATE || '24M';
const FINAL_VIDEO_BUFSIZE = process.env.FFMPEG_FINAL_BUFSIZE || '48M';
const CPU_FALLBACK_CRF = process.env.FFMPEG_CPU_CRF || '26';

// ---------------------------------------------------------------------------
// UTILITIES
// ---------------------------------------------------------------------------

function log(msg) { console.log(`  [FFmpeg] ${msg}`); }
function logError(msg) { console.error(`  [FFmpeg] ❌ ${msg}`); }

// Timing helper
function timer(label) {
    const start = Date.now();
    return () => {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        log(`⏱ ${label}: ${elapsed}s`);
        return parseFloat(elapsed);
    };
}

/**
 * Get scene duration in SECONDS.
 * scene.duration may be in frames (e.g., 553 for a 18.4s scene at 30fps).
 * endTime - startTime is always in seconds and is the reliable source.
 */
function getSceneDurationSec(scene, fps) {
    if (scene.endTime != null && scene.startTime != null && scene.endTime > scene.startTime) {
        return scene.endTime - scene.startTime;
    }
    // Fallback: if duration > totalDuration or seems like frames, convert
    const d = scene.duration || 0;
    if (d > 100) return d / (fps || 30); // likely frames
    return d;
}

// Cache NVENC probe result
let _nvencAvailable = null;

async function probeNvenc() {
    if (_nvencAvailable !== null) return _nvencAvailable;
    try {
        await new Promise((resolve, reject) => {
            const args = [
                '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=0.1',
                '-c:v', 'h264_nvenc', '-preset', 'p4',
                '-f', 'null', '-'
            ];
            execFile(FFMPEG_PATH, args, { timeout: 10000 }, (err) => {
                if (err) reject(err); else resolve();
            });
        });
        _nvencAvailable = true;
        log('✓ NVENC GPU encoder available');
    } catch {
        _nvencAvailable = false;
        log('✗ NVENC not available — will use CPU (libx264)');
    }
    return _nvencAvailable;
}

function errorText(err) {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    if (err instanceof Error) return err.stack || err.message || String(err);
    try { return JSON.stringify(err); } catch { return String(err); }
}

async function parallelWithLimit(tasks, limit) {
    const results = [];
    let i = 0;
    async function next() {
        const idx = i++;
        if (idx >= tasks.length) return;
        results[idx] = await tasks[idx]();
        await next();
    }
    await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => next()));
    return results;
}

function probeMedia(filePath) {
    return new Promise((resolve, reject) => {
        execFile(FFPROBE_PATH, [
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height,duration,codec_name',
            '-show_entries', 'format=duration',
            '-of', 'json',
            filePath
        ], { timeout: 15000 }, (err, stdout) => {
            if (err) return reject(err);
            try {
                const data = JSON.parse(stdout);
                const stream = data.streams?.[0] || {};
                // CRITICAL: prefer format.duration over stream.duration.
                // stream.duration can report source duration for tpad/trimmed clips, not output duration.
                const dur = parseFloat(data.format?.duration) || parseFloat(stream.duration) || 0;
                resolve({ width: stream.width || 0, height: stream.height || 0, duration: dur, codec: stream.codec_name });
            } catch (e) { reject(e); }
        });
    });
}

// Track ALL active FFmpeg processes for cancellation (parallel prep spawns multiple)
const _activeProcesses = new Set();
let _cancelled = false;

function cancelRender() {
    _cancelled = true;
    log(`Cancelling render — killing ${_activeProcesses.size} active FFmpeg process(es)...`);
    for (const proc of _activeProcesses) {
        try {
            // On Windows, kill the entire process tree
            if (process.platform === 'win32' && proc.pid) {
                require('child_process').exec(`taskkill /pid ${proc.pid} /f /t`, () => {});
            } else {
                proc.kill('SIGTERM');
            }
        } catch (e) { /* ignore */ }
    }
    _activeProcesses.clear();
}

function runFFmpeg(args, onProgress, totalDuration, timeoutMs, silenceTimeoutMs) {
    return new Promise((resolve, reject) => {
        if (_cancelled) return reject(new Error('Cancelled'));
        const proc = spawn(FFMPEG_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        _activeProcesses.add(proc);
        let stderr = '';
        let settled = false;
        let lastProgressTime = Date.now();
        const startTime = Date.now();

        const killProc = () => {
            try {
                if (process.platform === 'win32' && proc.pid) {
                    require('child_process').exec(`taskkill /pid ${proc.pid} /f /t`, () => {});
                } else {
                    proc.kill('SIGTERM');
                }
            } catch (e) { /* ignore */ }
        };

        const settle = (fn) => { if (!settled) { settled = true; clearInterval(watchdog); _activeProcesses.delete(proc); fn(); } };

        proc.stderr.on('data', (data) => {
            const text = data.toString();
            stderr += text;
            lastProgressTime = Date.now();
            if (onProgress && totalDuration) {
                const m = text.match(/time=(\d+):(\d+):(\d+\.\d+)/);
                if (m) {
                    const rawSecs = parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3]);
                    const secs = Math.min(rawSecs, totalDuration);
                    const pct = Math.min(99, Math.round((secs / totalDuration) * 100));
                    onProgress(pct, secs);
                }
            }
        });

        // Watchdog: silence detection + hard timeout
        const watchdog = setInterval(() => {
            const silentMs = Date.now() - lastProgressTime;
            const totalMs = Date.now() - startTime;
            // Kill if silent for too long (default 30s, compose step gets more)
            const silenceLimit = silenceTimeoutMs || 30000;
            if (silentMs > silenceLimit && !settled) {
                log(`FFmpeg silent for ${Math.round(silentMs / 1000)}s (limit ${Math.round(silenceLimit / 1000)}s), killing process...`);
                killProc();
            }
            // Hard timeout — kill if scene takes way too long
            if (timeoutMs && totalMs > timeoutMs && !settled) {
                log(`FFmpeg hard timeout (${Math.round(totalMs / 1000)}s > ${Math.round(timeoutMs / 1000)}s limit), killing...`);
                killProc();
            }
        }, 5000);

        proc.on('close', (code) => {
            settle(() => {
                if (_cancelled) reject(new Error('Cancelled'));
                else if (code === 0 || code === null) resolve(stderr);
                else reject(new Error(`FFmpeg exited with code ${code}\n${stderr.slice(-1000)}`));
            });
        });
        proc.on('error', (err) => { settle(() => reject(err)); });
    });
}

// ---------------------------------------------------------------------------
// PASS 1: SCENE PREPARATION
// ---------------------------------------------------------------------------

async function prepareScene(scene, publicDir, prepDir, fps) {
    const outFile = path.join(prepDir, `prep-${scene.index}.mp4`);
    if (fs.existsSync(outFile)) return outFile;

    const mediaPath = resolveMediaPath(scene.mediaFile, publicDir);
    if (!mediaPath || !fs.existsSync(mediaPath)) {
        log(`Scene ${scene.index}: no media, generating black clip`);
        return generateBlackClip(outFile, getSceneDurationSec(scene, fps), fps);
    }

    if (scene.mediaType === 'image') {
        return prepareImageScene(mediaPath, outFile, scene, fps);
    }
    return prepareVideoScene(mediaPath, outFile, scene, fps);
}

function resolveMediaPath(mediaFile, publicDir) {
    if (!mediaFile) return null;
    if (fs.existsSync(mediaFile)) return mediaFile;
    // Try in public dir
    const basename = path.basename(mediaFile);
    const inPublic = path.join(publicDir, basename);
    if (fs.existsSync(inPublic)) return inPublic;
    return null;
}

async function generateBlackClip(outFile, duration, fps) {
    const useGpu = _nvencAvailable;
    const encArgs = useGpu
        ? ['-c:v', 'h264_nvenc', '-preset', NVENC_PRESET_FAST, '-b:v', PREP_VIDEO_BITRATE]
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', CPU_FALLBACK_CRF];
    await runFFmpeg([
        '-f', 'lavfi', '-i', `color=c=black:s=${OUTPUT_WIDTH}x${OUTPUT_HEIGHT}:r=${fps}:d=${duration}`,
        ...encArgs, '-pix_fmt', 'yuv420p', '-an', '-y', outFile
    ]);
    return outFile;
}

async function prepareVideoScene(mediaPath, outFile, scene, fps) {
    const duration = getSceneDurationSec(scene, fps);
    const offset = scene.mediaOffset || 0;
    const scale = scene.scale || 1;
    const posX = scene.posX || 0;
    const posY = scene.posY || 0;
    const fitMode = scene.fitMode || 'cover';

    // Build video filter
    let vf = [];

    // Fit mode: cover (fill frame, crop excess) or contain (fit inside, pad black)
    if (fitMode === 'cover') {
        vf.push(`scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase`);
        vf.push(`crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}`);
    } else {
        vf.push(`scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease`);
        vf.push(`pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`);
    }

    // Apply scale/position transforms if non-default
    if (scale !== 1 || posX !== 0 || posY !== 0) {
        const sw = Math.round(OUTPUT_WIDTH * scale);
        const sh = Math.round(OUTPUT_HEIGHT * scale);
        const ox = Math.round(OUTPUT_WIDTH / 2 + (posX / 100) * OUTPUT_WIDTH - sw / 2);
        const oy = Math.round(OUTPUT_HEIGHT / 2 + (posY / 100) * OUTPUT_HEIGHT - sh / 2);
        // Scale content, then place on black canvas
        vf = [
            vf.join(','),  // first normalize to 1920x1080
            `scale=${sw}:${sh}`,
            `pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:${Math.max(0, -ox)}:${Math.max(0, -oy)}:black`,
            `crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:${Math.max(0, ox)}:${Math.max(0, oy)}`
        ];
    }

    // Set FPS and reset timestamps
    vf.push(`fps=${fps}`);
    // tpad freezes the last frame if source is shorter than needed.
    // Use a fixed frame count (not stop=-1 which creates infinite stream and corrupts duration metadata).
    const padFrames = Math.ceil(duration * fps) + fps; // pad up to 1 extra second of frames
    vf.push(`tpad=stop_mode=clone:stop=${padFrames}`);
    vf.push(`setpts=PTS-STARTPTS`);

    const useGpu = _nvencAvailable;
    const encArgs = useGpu
        ? ['-c:v', 'h264_nvenc', '-preset', NVENC_PRESET_FAST, '-b:v', PREP_VIDEO_BITRATE]
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', CPU_FALLBACK_CRF];

    const args = [
        ...(offset > 0 ? ['-ss', String(offset)] : []),
        '-i', mediaPath,
        '-t', String(duration),
        '-vf', vf.join(','),
        ...encArgs,
        '-pix_fmt', 'yuv420p',
        '-an', '-y', outFile
    ];

    // Timeout: max 90s or 15x the scene duration — whichever is larger.
    // If a scene takes longer than this, something is wrong — kill it and use black fallback.
    const timeoutMs = Math.max(90000, Math.round(duration * 15 * 1000));
    await runFFmpeg(args, null, null, timeoutMs);

    // Verify the prepared clip has correct duration
    try {
        const info = await probeMedia(outFile);
        if (info.duration > 0 && Math.abs(info.duration - duration) > 0.5) {
            log(`⚠ Scene ${scene.index}: expected ${duration.toFixed(2)}s, got ${info.duration.toFixed(2)}s`);
        }
    } catch (e) { /* ignore probe errors */ }

    return outFile;
}

async function prepareImageScene(mediaPath, outFile, scene, fps) {
    const duration = getSceneDurationSec(scene, fps);
    const fitMode = scene.fitMode || 'cover';

    // Static image → video: scale to 1920x1080, encode just enough frames.
    // No zoompan/crop-pan (both are CPU-intensive and extremely slow).
    // Ken Burns effect is subtle and not worth the 10-100x slowdown for prep.
    let vf;
    if (fitMode === 'cover') {
        vf = `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=increase,crop=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}`;
    } else {
        vf = `scale=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:force_original_aspect_ratio=decrease,pad=${OUTPUT_WIDTH}:${OUTPUT_HEIGHT}:(ow-iw)/2:(oh-ih)/2:black`;
    }

    vf += `,fps=${fps},setpts=PTS-STARTPTS`;

    const useGpu = _nvencAvailable;
    const encArgs = useGpu
        ? ['-c:v', 'h264_nvenc', '-preset', NVENC_PRESET_FAST, '-b:v', PREP_VIDEO_BITRATE]
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', CPU_FALLBACK_CRF];

    // Timeout: 60s or 10x duration — images should be fast (no decoding overhead)
    const timeoutMs = Math.max(60000, Math.round(duration * 10 * 1000));
    await runFFmpeg([
        '-loop', '1', '-i', mediaPath,
        '-t', String(duration),
        '-vf', vf,
        ...encArgs,
        '-pix_fmt', 'yuv420p',
        '-an', '-y', outFile
    ], null, null, timeoutMs);
    return outFile;
}

// ---------------------------------------------------------------------------
// MG PRE-RENDERING — Canvas (fast) + Remotion fallback (complex types)
// ---------------------------------------------------------------------------

/**
 * Pre-render all MGs as individual WebM clips.
 *
 * Uses @napi-rs/canvas for 14 common MG types (~200fps, no browser).
 * Falls back to Remotion batch render for complex types (mapChart, articleHighlight, animatedIcons).
 * If @napi-rs/canvas is not installed, uses Remotion for everything.
 */
async function preRenderMGs(plan, publicDir, prepDir, progressCallback) {
    const mgClipDir = path.join(prepDir, 'mg-clips');
    if (!fs.existsSync(mgClipDir)) fs.mkdirSync(mgClipDir, { recursive: true });

    const overlayMGs = plan.motionGraphics || [];
    const scriptContext = plan.scriptContext || {};
    const fps = plan.fps || 30;

    // Collect full-screen MG scenes
    const normalizeMgScene = (scene) => {
        const startT = Number(scene?.startTime) || 0;
        let endT = Number(scene?.endTime);
        let dur = Number(scene?.duration);
        if (Number.isFinite(dur) && dur > 1000) dur = dur / 1000;
        if (!Number.isFinite(endT) || endT <= startT) {
            endT = startT + (Number.isFinite(dur) && dur > 0 ? dur : 3);
        }
        return { ...scene, isMGScene: true, startTime: startT, endTime: endT, duration: Math.max(0.1, endT - startT) };
    };

    const mgSceneCandidates = [
        ...((plan.mgScenes || []).map(normalizeMgScene)),
        ...((plan.scenes || []).filter(s => s.isMGScene && !s.disabled).map(normalizeMgScene)),
    ];
    const seenMg = new Set();
    const fullscreenMGs = mgSceneCandidates
        .filter(s => !s.disabled && s.endTime > s.startTime)
        .sort((a, b) => (a.startTime || 0) - (b.startTime || 0))
        .filter((s) => {
            const key = `${s.type || 'mg'}|${(s.startTime || 0).toFixed(3)}|${(s.endTime || 0).toFixed(3)}|${s.text || s.headline || ''}`;
            if (seenMg.has(key)) return false;
            seenMg.add(key);
            return true;
        });

    const totalMGs = overlayMGs.length + fullscreenMGs.length;
    if (totalMGs === 0) {
        log('No MGs to pre-render');
        return mgClipDir;
    }

    // Try loading canvas renderer
    let canvasRenderer = null;
    try {
        canvasRenderer = require('./canvas-mg-renderer');
    } catch (e) {
        log(`Canvas MG renderer not available (${e.message}), using Remotion for all MGs`);
    }

    // Partition MGs into canvas-renderable vs Remotion-only
    const canvasMGs = [];
    const remotionOverlayMGs = [];
    const remotionFullscreenMGs = [];
    // Scene-level keys that must NOT leak into MG data (they come from the spread of scene.mgData
    // which is a copy of the scene object itself in some plans)
    const SCENE_ONLY_KEYS = new Set(['isMGScene', 'trackId', 'mediaType', 'keyword', 'sceneIndex', 'index', 'mediaFile', 'originalStartTime', 'originalEndTime']);

    for (let i = 0; i < overlayMGs.length; i++) {
        const mg = overlayMGs[i];
        const mgData = {
            type: mg.type, text: mg.text || '', subtext: mg.subtext || '',
            style: mg.style || plan.mgStyle || 'clean',
            position: mg.position || 'bottom-left',
            duration: mg.duration || 3,
            animationSpeed: mg.animationSpeed,
            ...(mg.mgData || {}),
        };
        // Force startTime=0 for standalone pre-render (mgData spread may inject timeline time)
        mgData.startTime = 0;
        for (const key of SCENE_ONLY_KEYS) delete mgData[key];
        if (mgData.duration > 100) mgData.duration = mg.duration || 3;
        if (canvasRenderer && canvasRenderer.canRenderWithCanvas(mgData.type)) {
            canvasMGs.push({ mg: mgData, isFullScreen: false, originalIndex: i, category: 'overlay' });
        } else {
            remotionOverlayMGs.push({ mg: mgData, originalIndex: i });
        }
    }

    // ALL fullscreen MGs rendered via Remotion (individual renders, CPU, more reliable)
    for (let i = 0; i < fullscreenMGs.length; i++) {
        const scene = fullscreenMGs[i];
        const mgData = {
            type: scene.type, text: scene.text || '', subtext: scene.subtext || '',
            style: scene.style || plan.mgStyle || 'clean',
            duration: scene.duration || 3,
            animationSpeed: scene.animationSpeed || (scene.mgData && scene.mgData.animationSpeed),
            ...(scene.mgData || {}),
            // position MUST be after the spread — fullscreen MGs are always centered
            // (matches Composition.jsx renderScene logic; mgData spread can contain
            // non-center positions from the AI pipeline which would misplace content)
            position: 'center',
        };
        // CRITICAL: override fields that must be fixed for pre-rendering
        // scene.mgData may contain startTime/endTime from the timeline (e.g., 8.31s) which
        // would break the standalone Remotion render that starts at frame 0
        mgData.startTime = 0;
        // Clean scene-level metadata that leaked through the spread
        for (const key of SCENE_ONLY_KEYS) delete mgData[key];
        // Ensure duration is in seconds (scene.mgData.duration should be correct,
        // but scene.duration can be in frames from the UI)
        if (mgData.duration > 100) {
            // Likely frames — use endTime - startTime from the normalized scene
            mgData.duration = scene.endTime - scene.startTime;
        }
        if (mgData.type === 'mapChart') {
            mgData.mapStyle = scene.mapStyle || (scene.mgData && scene.mgData.mapStyle) || plan.mapStyle || 'dark';
        }
        // DIAGNOSTIC: log every fullscreen MG's key fields
        log(`FS-MG[${i}] type="${mgData.type}" dur=${mgData.duration}s text="${(mgData.text || '').slice(0, 40)}" subtext="${(mgData.subtext || '').slice(0, 40)}" style="${mgData.style}" pos="${mgData.position}"`);
        remotionFullscreenMGs.push({ mg: mgData, originalIndex: i, scene });
    }

    log(`MG rendering: ${canvasMGs.length} overlays via Canvas, ${remotionOverlayMGs.length} overlays via Remotion, ${remotionFullscreenMGs.length} fullscreen via Remotion`);

    // ---- Phase 1: Canvas render (fast) ----
    if (canvasMGs.length > 0) {
        const canvasTimer = timer('Canvas MG render');
        progressCallback({ percent: 26, message: `Canvas-rendering ${canvasMGs.length} MGs...` });

        await canvasRenderer.renderAll(canvasMGs, mgClipDir, fps, scriptContext, (pct) => {
            const p = 26 + Math.round(pct * 6);
            progressCallback({ percent: Math.min(32, p), message: `Canvas MGs: ${Math.round(pct * 100)}%` });
        });

        canvasTimer();
    }

    // ---- Phase 2: Remotion rendering ----
    // Overlay Remotion MGs: batch render (VP8 WebM for alpha transparency)
    // Fullscreen MGs: individual render (H.264 mp4, more reliable, proper static file serving)
    const needsRemotion = remotionOverlayMGs.length > 0 || remotionFullscreenMGs.length > 0;
    if (needsRemotion) {
        let bundleFn, renderMediaFn, selectCompositionFn;
        try {
            const bundler = require('@remotion/bundler');
            const renderer = require('@remotion/renderer');
            bundleFn = bundler.bundle;
            renderMediaFn = renderer.renderMedia;
            selectCompositionFn = renderer.selectComposition;
        } catch (e) {
            logError(`Remotion renderer not available: ${e.message}`);
            return mgClipDir;
        }

        const appRoot = path.resolve(__dirname, '..');
        const rootFile = path.join(appRoot, 'src', 'remotion', 'Root.jsx');

        // Windows: find Remotion binaries
        let binariesDirectory = null;
        if (process.platform === 'win32') {
            const remotionBinRoot = path.join(appRoot, 'temp', 'remotion-binaries');
            if (fs.existsSync(remotionBinRoot)) {
                if (fs.existsSync(path.join(remotionBinRoot, 'remotion.exe'))) {
                    binariesDirectory = remotionBinRoot;
                } else {
                    const subdirs = fs.readdirSync(remotionBinRoot).filter(d => {
                        try { return fs.statSync(path.join(remotionBinRoot, d)).isDirectory(); } catch { return false; }
                    });
                    for (const sd of subdirs) {
                        const candidate = path.join(remotionBinRoot, sd);
                        if (fs.existsSync(path.join(candidate, 'remotion.exe'))) {
                            binariesDirectory = candidate;
                            break;
                        }
                    }
                }
                if (binariesDirectory) log(`Using Remotion binaries: ${binariesDirectory}`);
            }
        }

        let bundleLocation;
        try {
            const bundleTimer = timer('MG Remotion bundle');
            progressCallback({ percent: 33, message: 'Bundling Remotion for MGs...' });
            bundleLocation = await bundleFn({ entryPoint: rootFile, publicDir });
            bundleTimer();
        } catch (e) {
            logError(`Remotion bundle failed: ${e.message}`);
            return mgClipDir;
        }

        // Pre-load world-110m.json for mapChart MGs (belt-and-suspenders: avoids fetch issues)
        const hasMapChart = [...remotionOverlayMGs, ...remotionFullscreenMGs].some(e => e.mg.type === 'mapChart');
        if (hasMapChart) {
            const geoPath = path.join(publicDir, 'world-110m.json');
            if (fs.existsSync(geoPath)) {
                try {
                    const geoJson = JSON.parse(fs.readFileSync(geoPath, 'utf-8'));
                    for (const entry of [...remotionOverlayMGs, ...remotionFullscreenMGs]) {
                        if (entry.mg.type === 'mapChart') {
                            entry.mg._preloadedGeo = geoJson;
                        }
                    }
                    log('Pre-loaded world-110m.json for mapChart MGs');
                } catch (e) {
                    logError(`Failed to pre-load world-110m.json: ${e.message}`);
                }
            }
        }

        const binOpts = binariesDirectory ? { binariesDirectory } : {};

        // ---- Phase 2a: Batch render overlay Remotion MGs (VP8 for alpha) ----
        if (remotionOverlayMGs.length > 0) {
            const batchItems = [];
            const mgManifest = [];
            let offsetFrames = 0;

            for (const entry of remotionOverlayMGs) {
                const dur = entry.mg.duration || 3;
                const durFrames = Math.max(1, Math.round(dur * fps));
                batchItems.push({ mg: entry.mg, isFullScreen: false, offsetFrames, durationFrames: durFrames });
                mgManifest.push({ type: 'overlay', index: entry.originalIndex, batchStartSec: offsetFrames / fps, durationSec: dur });
                offsetFrames += durFrames;
            }

            const totalBatchDuration = offsetFrames / fps;
            const batchFile = path.join(mgClipDir, 'mg-batch.webm');

            try {
                const mgRenderTimer = timer('MG Remotion overlay batch');
                progressCallback({ percent: 34, message: `Batch-rendering ${remotionOverlayMGs.length} overlay MGs...` });

                const composition = await selectCompositionFn({
                    serveUrl: bundleLocation, id: 'MGBatch',
                    inputProps: { items: batchItems, scriptContext, totalDuration: totalBatchDuration },
                    ...binOpts,
                });

                await renderMediaFn({
                    composition, serveUrl: bundleLocation, codec: 'vp8',
                    outputLocation: batchFile, chromiumOptions: { gl: 'angle' },
                    concurrency: 6, ...binOpts,
                    onProgress: ({ progress }) => {
                        progressCallback({ percent: 34 + Math.round(progress * 3), message: `Remotion overlay MGs: ${Math.round(progress * 100)}%` });
                    },
                });
                mgRenderTimer();

                // Split batch into individual clips
                for (const item of mgManifest) {
                    const outFile = path.join(mgClipDir, `mg-${item.type}-${item.index}.webm`);
                    try {
                        await new Promise((resolve, reject) => {
                            execFile(FFMPEG_PATH, [
                                '-y', '-i', batchFile,
                                '-ss', item.batchStartSec.toFixed(3),
                                '-t', item.durationSec.toFixed(3),
                                '-c:v', 'copy', '-an', outFile
                            ], { timeout: 30000 }, (err) => { if (err) reject(err); else resolve(); });
                        });
                        if (fs.existsSync(outFile)) {
                            const sizeKB = (fs.statSync(outFile).size / 1024).toFixed(0);
                            log(`Remotion overlay MG ${item.index} (${remotionOverlayMGs[0]?.mg?.type}): ${sizeKB}KB`);
                        }
                    } catch (e) {
                        logError(`Split Remotion overlay MG ${item.index} failed: ${e.message}`);
                    }
                }
            } catch (e) {
                logError(`Remotion overlay batch render failed: ${e.message}`);
            }
        }

        // ---- Phase 2b: Individual render each fullscreen MG via Remotion ----
        if (remotionFullscreenMGs.length > 0) {
            log(`Rendering ${remotionFullscreenMGs.length} fullscreen MGs individually via Remotion (H.264)...`);

            for (let i = 0; i < remotionFullscreenMGs.length; i++) {
                if (_cancelled) break;

                const entry = remotionFullscreenMGs[i];
                const outFile = path.join(mgClipDir, `mg-fullscreen-${entry.originalIndex}.mp4`);
                const dur = entry.mg.duration || 3;

                // DIAGNOSTIC: save exact inputProps to JSON for debugging
                try {
                    const debugFile = path.join(mgClipDir, `mg-fullscreen-${entry.originalIndex}-debug.json`);
                    fs.writeFileSync(debugFile, JSON.stringify({ mg: entry.mg, scriptContext: { themeId: scriptContext.themeId, mgStyle: scriptContext.mgStyle }, duration: dur, isFullScreen: true }, null, 2));
                    log(`FS-MG[${entry.originalIndex}] debug saved: ${debugFile}`);
                } catch (_) {}

                try {
                    progressCallback({
                        percent: 34 + Math.round(((i + 1) / remotionFullscreenMGs.length) * 5),
                        message: `Fullscreen MG ${i + 1}/${remotionFullscreenMGs.length} (${entry.mg.type})...`,
                    });

                    log(`FS-MG[${entry.originalIndex}] Remotion render: type=${entry.mg.type} dur=${dur}s durationInFrames=${Math.ceil(dur * fps)}`);

                    const composition = await selectCompositionFn({
                        serveUrl: bundleLocation, id: 'MGPreRender',
                        inputProps: { mg: entry.mg, scriptContext, duration: dur, isFullScreen: true },
                        ...binOpts,
                    });

                    await renderMediaFn({
                        composition, serveUrl: bundleLocation, codec: 'h264',
                        outputLocation: outFile, chromiumOptions: { gl: 'angle' },
                        ...binOpts,
                    });

                    if (fs.existsSync(outFile)) {
                        const sizeKB = (fs.statSync(outFile).size / 1024).toFixed(0);
                        log(`Fullscreen MG ${entry.originalIndex} (${entry.mg.type}): ${sizeKB}KB ✓`);
                    } else {
                        logError(`Fullscreen MG ${entry.originalIndex} (${entry.mg.type}): output file missing!`);
                    }
                } catch (e) {
                    logError(`Fullscreen MG ${entry.originalIndex} (${entry.mg.type}) render failed: ${e.message}`);
                }
            }
        }
    }

    progressCallback({ percent: 40, message: 'MG rendering complete' });
    return mgClipDir;
}

// ---------------------------------------------------------------------------
// PASS 1.6: PRE-RENDER TRANSITIONS VIA REMOTION
// Renders each non-cut transition as an opaque H.264 clip using the exact
// same enter/exit styles + overlay effects as the preview (Composition.jsx).
// These clips are overlaid in the compose step for pixel-perfect sync.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// PASS 2: FILTER GRAPH BUILDER
// ---------------------------------------------------------------------------

async function buildFilterGraph(plan, prepDir, overlayPrepDir, publicDir, timeWindow = null) {
    const fps = plan.fps || 30;
    const tw = timeWindow; // shorthand

    // Filter scenes to time window
    const filterScenes = (scenes) => {
        if (!tw) return scenes;
        return scenes.filter(s => {
            const start = s.startTime || 0;
            const end = s.endTime || (start + getSceneDurationSec(s, fps));
            return start < tw.endTime && end > tw.startTime;
        });
    };

    const track1Scenes = filterScenes(getTrackScenes(plan, 'video-track-1'));
    const track2Scenes = filterScenes(getTrackScenes(plan, 'video-track-2'));
    const track3Scenes = filterScenes(getTrackScenes(plan, 'video-track-3'));

    // Log compose order for track-1 (this is the actual playback order)
    if (track1Scenes.length > 0) {
        log(`COMPOSE ORDER (track-1, ${track1Scenes.length} scenes):`);
        track1Scenes.forEach((s, i) => {
            log(`  [${i}] scene.index=${s.index} startTime=${(s.startTime || 0).toFixed(2)}s endTime=${(s.endTime || 0).toFixed(2)}s file=prep-${s.index}.mp4`);
        });
        // Sanity check: warn if scene indices don't match chronological order
        const indexOrder = track1Scenes.map(s => s.index);
        const isSorted = indexOrder.every((v, i) => i === 0 || v > indexOrder[i - 1]);
        if (!isSorted) {
            log(`⚠ NOTE: Scene indices are NOT sequential (${indexOrder.join(',')}). This is normal when scenes were reordered in the timeline or images are on track-2. Compose uses startTime order, not index order.`);
        }
    }
    if (track2Scenes.length > 0) log(`Track-2 overlays: ${track2Scenes.length} scenes`);
    if (track3Scenes.length > 0) log(`Track-3 overlays: ${track3Scenes.length} scenes`);

    // Transitions disabled — all hard cuts

    const inputs = [];     // -i arguments
    const filters = [];    // filter_complex lines
    let labelCounter = 0;
    const nextLabel = (prefix) => `${prefix}${labelCounter++}`;

    // -----------------------------------------------------------------------
    // Section A: Build chunk-duration timeline base (scenes only, no gap fillers)
    // -----------------------------------------------------------------------
    const chunkStart = tw ? tw.startTime : 0;
    const chunkEnd = tw ? tw.endTime : (plan.totalDuration || 90);
    const totalDur = chunkEnd - chunkStart;

    // Build inputs for each scene, inserting black gap fillers where track-1 has gaps
    // (e.g., where images play on track-2). Without gap fillers, xfade compresses the
    // timeline and overlay tracks get misaligned.
    const t1Prepared = [];
    let prevEnd = chunkStart; // Track where the last scene ended

    for (const scene of track1Scenes) {
        const sceneStart = scene.startTime || 0;
        const sceneDurSec = getSceneDurationSec(scene, fps);

        // Insert black gap filler if there's a gap before this scene
        const gapDur = sceneStart - prevEnd;
        if (gapDur > 0.1) {
            const gapFile = path.join(prepDir, `gap-before-${scene.index}.mp4`);
            if (!fs.existsSync(gapFile)) {
                await generateBlackClip(gapFile, gapDur, fps);
            }
            const gapIdx = inputs.length;
            inputs.push(gapFile);
            t1Prepared.push({ scene: { index: `gap-${scene.index}`, startTime: prevEnd, endTime: sceneStart }, inputIdx: gapIdx, label: `${gapIdx}:v`, actualDuration: gapDur, isGap: true });
            log(`Gap filler: ${prevEnd.toFixed(2)}s-${sceneStart.toFixed(2)}s (${gapDur.toFixed(2)}s black)`);
        }

        const prepFile = path.join(prepDir, `prep-${scene.index}.mp4`);
        if (!fs.existsSync(prepFile)) {
            log(`⚠ Scene ${scene.index}: prep missing, generating black`);
            await generateBlackClip(prepFile, sceneDurSec, fps);
        }

        const inputIdx = inputs.length;
        inputs.push(prepFile);

        let actualDuration = sceneDurSec;
        try {
            const info = await probeMedia(prepFile);
            if (info.duration > 0) {
                if (info.duration > sceneDurSec * 2) {
                    log(`⚠ Scene ${scene.index}: probed ${info.duration.toFixed(2)}s >> expected ${sceneDurSec.toFixed(2)}s — using planned duration`);
                } else {
                    actualDuration = info.duration;
                    if (Math.abs(actualDuration - sceneDurSec) > 0.5) {
                        log(`Scene ${scene.index}: plan=${sceneDurSec.toFixed(2)}s actual=${actualDuration.toFixed(2)}s`);
                    }
                }
            }
        } catch (e) { /* fallback to sceneDurSec */ }

        t1Prepared.push({ scene, inputIdx, label: `${inputIdx}:v`, actualDuration });
        prevEnd = scene.endTime || (sceneStart + sceneDurSec);
    }

    // If the last scene ends before the chunk, extend the last clip to cover the full duration
    // (prevents video freezing before audio finishes)
    if (t1Prepared.length > 0) {
        if (chunkEnd - prevEnd > 0.2) {
            log(`Extending last scene to cover chunk end (scenes end at ${prevEnd.toFixed(2)}s, chunk ends at ${chunkEnd.toFixed(2)}s)`);
            t1Prepared[t1Prepared.length - 1].actualDuration += (chunkEnd - prevEnd);
        }
    }

    // Chain all scenes with hard cuts (xfade with minimal duration)
    let baseLabel = null;
    if (t1Prepared.length === 0) {
        const fullBlack = path.join(prepDir, `gap-full.mp4`);
        await generateBlackClip(fullBlack, totalDur, fps);
        const blackInput = inputs.length;
        inputs.push(fullBlack);
        baseLabel = `[${blackInput}:v]`;
    } else if (t1Prepared.length === 1) {
        baseLabel = `[${t1Prepared[0].label}]`;
    } else {
        let prevLabel = `[${t1Prepared[0].label}]`;
        let runningOffset = t1Prepared[0].actualDuration;

        for (let i = 1; i < t1Prepared.length; i++) {
            const curr = t1Prepared[i];
            const outLabel = nextLabel('x');

            // Hard cut — instant transition between all segments
            const cutDur = 0.04;
            const offset = Math.max(0, runningOffset - cutDur);
            filters.push(
                `${prevLabel}[${curr.label}]xfade=transition=fade:duration=${cutDur}:offset=${offset.toFixed(3)}[${outLabel}]`
            );
            runningOffset = offset + curr.actualDuration;
            prevLabel = `[${outLabel}]`;
        }
        baseLabel = prevLabel;

        log(`Track-1 timeline: ${t1Prepared.length} scenes, total ${runningOffset.toFixed(2)}s`);
    }

    // -----------------------------------------------------------------------
    // Section B: Track-2 and Track-3 overlays — hard cut (no fades)
    // -----------------------------------------------------------------------
    for (const trackScenes of [track2Scenes, track3Scenes]) {
        for (const scene of trackScenes) {
            const prepFile = path.join(prepDir, `prep-${scene.index}.mp4`);
            if (!fs.existsSync(prepFile)) continue;

            const inputIdx = inputs.length;
            inputs.push(prepFile);

            const absStart = scene.startTime || 0;
            const absEnd = scene.endTime || (absStart + scene.duration);

            const startT = Math.max(0, toChunkRelative(absStart, tw));
            const endT = Math.min(totalDur, toChunkRelative(absEnd, tw));

            const delayedLabel = nextLabel('d');
            filters.push(
                `[${inputIdx}:v]setpts=PTS+${startT.toFixed(3)}/TB[${delayedLabel}]`
            );

            const outLabel = nextLabel('t');
            filters.push(
                `${baseLabel}[${delayedLabel}]overlay=0:0:eof_action=pass:enable='between(t,${startT.toFixed(3)},${endT.toFixed(3)})'[${outLabel}]`
            );
            baseLabel = `[${outLabel}]`;
        }
    }

    // -----------------------------------------------------------------------
    // Section E: Motion Graphics (canvas-rendered FFV1 MKV clips with alpha)
    // Times adjusted to chunk-relative. Only MGs overlapping the time window are included.
    // -----------------------------------------------------------------------
    const mgClipDir = overlayPrepDir;
    const allMgs = plan.motionGraphics || [];
    // Filter overlay MGs to time window (use absolute index for clip filename)
    if (mgClipDir && allMgs.length > 0) {
        let overlaysInChunk = 0;
        for (let overlayIdx = 0; overlayIdx < allMgs.length; overlayIdx++) {
            const mg = allMgs[overlayIdx];
            const absStart = mg.startTime || 0;
            const dur = mg.duration || 3;
            const absEnd = absStart + dur;

            // Skip MGs outside this chunk
            if (tw && (absStart >= tw.endTime || absEnd <= tw.startTime)) continue;

            let clipFile = path.join(mgClipDir, `mg-overlay-${overlayIdx}.mkv`);
            if (!fs.existsSync(clipFile)) clipFile = path.join(mgClipDir, `mg-overlay-${overlayIdx}.webm`);
            if (!fs.existsSync(clipFile)) continue;

            const startT = Math.max(0, toChunkRelative(absStart, tw));
            const endT = Math.min(totalDur, toChunkRelative(absEnd, tw));

            const inputIdx = inputs.length;
            inputs.push(clipFile);

            const delayedLabel = nextLabel('mgd');
            filters.push(
                `[${inputIdx}:v]setpts=PTS+${startT.toFixed(3)}/TB[${delayedLabel}]`
            );

            const outLabel = nextLabel('mgo');
            filters.push(
                `${baseLabel}[${delayedLabel}]overlay=0:0:format=auto:eof_action=pass:enable='between(t,${startT.toFixed(3)},${endT.toFixed(3)})'[${outLabel}]`
            );
            baseLabel = `[${outLabel}]`;
            overlaysInChunk++;
        }
        if (overlaysInChunk > 0) log(`Overlaying ${overlaysInChunk} MG clips in filter graph`);
    }

    // Full-screen MG scenes
    if (mgClipDir) {
        const normalizeMgScene = (scene) => {
            const startT = Number(scene?.startTime) || 0;
            let endT = Number(scene?.endTime);
            let dur = Number(scene?.duration);
            if (Number.isFinite(dur) && dur > 1000) dur = dur / 1000;
            if (!Number.isFinite(endT) || endT <= startT) {
                endT = startT + (Number.isFinite(dur) && dur > 0 ? dur : 3);
            }
            return { ...scene, isMGScene: true, startTime: startT, endTime: endT, duration: Math.max(0.1, endT - startT) };
        };

        const mgSceneCandidates = [
            ...((plan.mgScenes || []).map(normalizeMgScene)),
            ...((plan.scenes || []).filter(s => s.isMGScene && !s.disabled).map(normalizeMgScene)),
        ];
        const seenMg = new Set();
        const mgScenes = mgSceneCandidates
            .filter(s => !s.disabled && s.endTime > s.startTime)
            .sort((a, b) => (a.startTime || 0) - (b.startTime || 0))
            .filter((s) => {
                const key = `${s.type || 'mg'}|${(s.startTime || 0).toFixed(3)}|${(s.endTime || 0).toFixed(3)}|${s.text || s.headline || ''}`;
                if (seenMg.has(key)) return false;
                seenMg.add(key);
                return true;
            });

        if (mgScenes.length > 0) {
            let fsInChunk = 0;
            for (let fsIdx = 0; fsIdx < mgScenes.length; fsIdx++) {
                const scene = mgScenes[fsIdx];
                const absStart = scene.startTime || 0;
                const absEnd = scene.endTime || (absStart + (scene.duration || 3));

                // Skip fullscreen MGs outside this chunk
                if (tw && (absStart >= tw.endTime || absEnd <= tw.startTime)) continue;

                let clipFile = path.join(mgClipDir, `mg-fullscreen-${fsIdx}.mp4`);
                if (!fs.existsSync(clipFile)) clipFile = path.join(mgClipDir, `mg-fullscreen-${fsIdx}.mkv`);
                if (!fs.existsSync(clipFile)) clipFile = path.join(mgClipDir, `mg-fullscreen-${fsIdx}.webm`);
                if (!fs.existsSync(clipFile)) {
                    log(`⚠ Fullscreen MG ${fsIdx} (${scene.type || 'unknown'}) clip not found — skipping`);
                    continue;
                }

                const startT = Math.max(0, toChunkRelative(absStart, tw));
                const endT = Math.min(totalDur, toChunkRelative(absEnd, tw));

                const inputIdx = inputs.length;
                inputs.push(clipFile);

                const delayedLabel = nextLabel('mgd');
                filters.push(
                    `[${inputIdx}:v]setpts=PTS+${startT.toFixed(3)}/TB[${delayedLabel}]`
                );

                const outLabel = nextLabel('mgo');
                filters.push(
                    `${baseLabel}[${delayedLabel}]overlay=0:0:format=auto:eof_action=pass:enable='between(t,${startT.toFixed(3)},${endT.toFixed(3)})'[${outLabel}]`
                );
                baseLabel = `[${outLabel}]`;
                fsInChunk++;
            }
            if (fsInChunk > 0) log(`Overlaying ${fsInChunk} fullscreen MG clips in filter graph`);
        }
    }

    // Final output normalization for encoder compatibility:
    // - enforce constant FPS
    // - force yuv420p (widely supported by h264_nvenc + libx264)
    // - ensure even dimensions
    // - normalize SAR
    const videoOutLabel = nextLabel('vout');
    filters.push(
        `${baseLabel}fps=${fps},format=yuv420p,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[${videoOutLabel}]`
    );

    return { inputs, filters, videoOutLabel, fps };
}

function getTrackScenes(plan, trackId) {
    return (plan.scenes || [])
        .filter(s => (s.trackId || 'video-track-1') === trackId && !s.disabled && !s.isMGScene)
        .sort((a, b) => {
            // Primary: sort by startTime (chronological order)
            const timeDiff = (a.startTime || 0) - (b.startTime || 0);
            if (timeDiff !== 0) return timeDiff;
            // Tiebreaker: sort by index (preserve array order when startTimes are equal)
            return (a.index || 0) - (b.index || 0);
        });
}

// ---------------------------------------------------------------------------
// CHUNKED RENDERING — split timeline into manageable chunks
// ---------------------------------------------------------------------------

/**
 * Filter items that overlap a time window.
 * @param {Array} items
 * @param {{ startTime: number, endTime: number }|null} tw - null = no filter
 * @param {Function} getStart - item => startTime
 * @param {Function} getEnd - item => endTime
 */
function filterByTimeWindow(items, tw, getStart, getEnd) {
    if (!tw) return items;
    return items.filter(item => getStart(item) < tw.endTime && getEnd(item) > tw.startTime);
}

/** Convert absolute time to chunk-relative time. */
function toChunkRelative(t, tw) {
    if (!tw) return t;
    return Math.max(0, t - tw.startTime);
}

/**
 * Split the timeline into ~60s chunks, snapping boundaries to scene ends
 * so no scene is ever cut in half.
 * Returns [{ startTime, endTime, chunkIndex }].
 * Videos <= 3 min return a single chunk (no splitting).
 */
function computeChunkBoundaries(plan, targetChunkSec = 60) {
    const totalDur = plan.totalDuration || 0;
    const fps = plan.fps || 30;
    if (totalDur <= 180) {
        return [{ startTime: 0, endTime: totalDur, chunkIndex: 0 }];
    }

    const track1 = getTrackScenes(plan, 'video-track-1');
    // Build sorted list of scene end times for snapping
    const sceneEnds = track1.map(s => {
        const end = s.endTime != null ? s.endTime : (s.startTime || 0) + getSceneDurationSec(s, fps);
        return { start: s.startTime || 0, end };
    }).sort((a, b) => a.start - b.start);

    const chunks = [];
    let cursor = 0;
    let chunkIdx = 0;

    while (cursor < totalDur - 0.1) {
        const targetEnd = cursor + targetChunkSec;

        // If close enough to end, take it all
        if (targetEnd >= totalDur - 10) {
            chunks.push({ startTime: cursor, endTime: totalDur, chunkIndex: chunkIdx });
            break;
        }

        // Find scene that spans the target boundary
        const spanning = sceneEnds.find(s => s.start < targetEnd && s.end > targetEnd);
        let snapEnd;

        if (spanning) {
            // Include the full scene — extend chunk to scene end
            snapEnd = spanning.end;
        } else {
            // No scene at boundary — use target directly
            snapEnd = targetEnd;
        }

        // Sanity: don't let chunks be empty
        if (snapEnd <= cursor + 0.1) snapEnd = targetEnd;

        chunks.push({ startTime: cursor, endTime: snapEnd, chunkIndex: chunkIdx });
        cursor = snapEnd;
        chunkIdx++;
    }

    // Merge trailing chunk if too short (< 10s)
    if (chunks.length >= 2) {
        const last = chunks[chunks.length - 1];
        if (last.endTime - last.startTime < 10) {
            chunks[chunks.length - 2].endTime = last.endTime;
            chunks.pop();
        }
    }

    return chunks;
}

// ---------------------------------------------------------------------------
// AUDIO MIXING
// ---------------------------------------------------------------------------

function buildAudioMix(plan, publicDir, inputs, timeWindow = null) {
    const audioFilters = [];
    let audioStreams = [];
    const tw = timeWindow;
    const chunkStart = tw ? tw.startTime : 0;
    const chunkEnd = tw ? tw.endTime : Infinity;

    // Voice-over — trim to chunk window if needed
    const audioFile = resolveMediaPath(plan.audio, publicDir);
    if (audioFile && fs.existsSync(audioFile)) {
        const audioIdx = inputs.length;
        inputs.push(audioFile);
        const isMuted = plan.mutedTracks?.['audio-track'];
        if (!isMuted) {
            if (tw) {
                // Trim voiceover to chunk time range and reset PTS
                const voLabel = `vo${audioIdx}`;
                audioFilters.push(
                    `[${audioIdx}:a]atrim=start=${tw.startTime.toFixed(3)}:end=${tw.endTime.toFixed(3)},asetpts=PTS-STARTPTS[${voLabel}]`
                );
                audioStreams.push(`[${voLabel}]`);
            } else {
                audioStreams.push(`[${audioIdx}:a]`);
            }
        }
    }

    // SFX clips — only include those overlapping this chunk's time window
    if (plan.sfxEnabled !== false && !plan.mutedTracks?.['sfx-track'] && plan.sfxClips?.length) {
        const sfxVolume = plan.sfxVolume || 0.35;

        for (const sfx of plan.sfxClips) {
            const sfxStart = sfx.startTime || 0;
            const sfxDur = sfx.duration || 2;
            // Skip SFX outside this chunk
            if (tw && (sfxStart >= chunkEnd || sfxStart + sfxDur < chunkStart)) continue;

            const sfxPath = findSfxFile(sfx.file, publicDir);
            if (!sfxPath) continue;

            const sfxIdx = inputs.length;
            inputs.push(sfxPath);
            const sfxLabel = `sfx${sfxIdx}`;
            // Chunk-relative delay
            const delayMs = Math.max(0, Math.round((sfxStart - chunkStart) * 1000));
            const vol = (sfx.volume || sfxVolume).toFixed(2);

            audioFilters.push(
                `[${sfxIdx}:a]adelay=${delayMs}|${delayMs},volume=${vol}[${sfxLabel}]`
            );
            audioStreams.push(`[${sfxLabel}]`);
        }
    }

    if (audioStreams.length === 0) {
        return { audioFilters: [], audioOutLabel: null };
    }

    // Mix all audio streams
    const audioOutLabel = 'aout';
    if (audioStreams.length === 1) {
        audioFilters.push(`${audioStreams[0]}acopy[${audioOutLabel}]`);
    } else {
        audioFilters.push(
            `${audioStreams.join('')}amix=inputs=${audioStreams.length}:duration=first:dropout_transition=0:normalize=0[${audioOutLabel}]`
        );
    }

    return { audioFilters, audioOutLabel };
}

function findSfxFile(filename, publicDir) {
    if (!filename) return null;
    // Check public dir
    const inPublic = path.join(publicDir, filename);
    if (fs.existsSync(inPublic)) return inPublic;
    // Check assets/sfx
    const assetsDir = path.join(path.dirname(publicDir), 'assets', 'sfx');
    // Try project root assets
    const appRoot = path.dirname(require.main?.filename || __dirname);
    const inAssets = path.join(appRoot, 'assets', 'sfx', filename);
    if (fs.existsSync(inAssets)) return inAssets;
    return null;
}

// ---------------------------------------------------------------------------
// SUBTITLES
// ---------------------------------------------------------------------------

function buildSubtitleFilter(plan, baseLabel) {
    if (!plan.subtitlesEnabled) return { filters: [], label: baseLabel };

    const filters = [];
    let currentLabel = baseLabel;

    for (const scene of (plan.scenes || [])) {
        if (!scene.text || scene.text.trim() === '') continue;
        const text = scene.text.replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/\\/g, '\\\\');
        const startT = scene.startTime || 0;
        const endT = scene.endTime || (startT + scene.duration);
        const outLabel = `sub${scene.index}`;

        filters.push(
            `${currentLabel}drawtext=text='${text}':fontsize=32:fontcolor=white:borderw=2:bordercolor=black:x=(w-text_w)/2:y=h-100:enable='between(t,${startT.toFixed(3)},${endT.toFixed(3)})'[${outLabel}]`
        );
        currentLabel = `[${outLabel}]`;
    }

    return { filters, label: currentLabel };
}

// ---------------------------------------------------------------------------
// MAIN RENDER FUNCTION
// ---------------------------------------------------------------------------

async function renderWithFFmpeg(plan, options = {}) {
    _cancelled = false;
    _activeProcesses.clear();

    const {
        publicDir,
        outputPath,
        progressCallback = () => {},
        ffmpegPath = FFMPEG_PATH
    } = options;

    const fps = plan.fps || 30;
    const totalDuration = plan.totalDuration || 60;
    const tempDir = path.join(path.dirname(publicDir), 'temp');
    const prepDir = path.join(tempDir, 'ffmpeg-prep');

    // Clean and recreate prep directory (avoid stale files from previous runs)
    if (fs.existsSync(prepDir)) {
        try {
            const oldFiles = fs.readdirSync(prepDir);
            for (const f of oldFiles) {
                const fp = path.join(prepDir, f);
                try {
                    if (fs.statSync(fp).isDirectory()) {
                        // Remove subdirectories (e.g., mg-clips)
                        const subFiles = fs.readdirSync(fp);
                        for (const sf of subFiles) fs.unlinkSync(path.join(fp, sf));
                        fs.rmdirSync(fp);
                    } else {
                        fs.unlinkSync(fp);
                    }
                } catch (e2) { /* ignore individual file errors */ }
            }
        } catch (e) { /* ignore */ }
    } else {
        fs.mkdirSync(prepDir, { recursive: true });
    }

    const totalTimer = timer('TOTAL RENDER');

    // ==== Probe NVENC at startup ====
    await probeNvenc();

    log(`FFmpeg renderer ${RENDERER_VERSION} loaded`);
    log(`Starting FFmpeg${_nvencAvailable ? ' GPU' : ' CPU'} render (${totalDuration.toFixed(1)}s, ${fps}fps, parallel=${PARALLEL_LIMIT})`);
    log(`Output: ${outputPath}`);

    // ==== PASS 1: Prepare scenes ====
    const pass1Timer = timer('Pass 1 — Scene prep');
    progressCallback({ percent: 5, message: 'Preparing scene clips...' });

    // Sort scenes by startTime so parallel prep processes them in chronological order
    const allScenes = (plan.scenes || [])
        .filter(s => !s.isMGScene && !s.disabled)
        .sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
    let preparedCount = 0;

    log(`Scene order (sorted by startTime, ${allScenes.length} scenes):`);
    allScenes.forEach(s => {
        const dur = getSceneDurationSec(s, fps);
        log(`  Scene ${s.index}: ${(s.startTime || 0).toFixed(2)}s-${(s.endTime || 0).toFixed(2)}s track=${s.trackId || 'video-track-1'} ${(s.mediaType || 'video')} dur=${dur.toFixed(2)}s`);
    });

    const prepareTasks = allScenes.map((scene) => async () => {
        try {
            const t0 = Date.now();
            await prepareScene(scene, publicDir, prepDir, fps);
            const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
            log(`  Scene ${scene.index} (${scene.mediaType || 'video'}): ${elapsed}s`);
            preparedCount++;
            const pct = 5 + Math.round((preparedCount / allScenes.length) * 35);
            progressCallback({ percent: pct, message: `Preparing: ${preparedCount}/${allScenes.length} scenes` });
        } catch (e) {
            logError(`Scene ${scene.index} prep failed: ${e.message}`);
            // Generate black clip fallback
            await generateBlackClip(
                path.join(prepDir, `prep-${scene.index}.mp4`),
                getSceneDurationSec(scene, fps),
                fps
            );
        }
    });

    await parallelWithLimit(prepareTasks, PARALLEL_LIMIT);
    pass1Timer();
    log(`Prepared ${preparedCount}/${allScenes.length} scenes`);

    // ==== PASS 1.5: Pre-render MGs via Remotion ====
    const pass15Timer = timer('Pass 1.5 — MG pre-render (Remotion)');
    let mgClipDir = null;
    const hasMGs = (plan.motionGraphics || []).length > 0 ||
                   (plan.mgScenes || []).length > 0 ||
                   (plan.scenes || []).some(s => s.isMGScene && !s.disabled);
    if (hasMGs) {
        try {
            mgClipDir = await preRenderMGs(plan, publicDir, prepDir, progressCallback);
        } catch (e) {
            logError(`MG pre-rendering failed: ${e.message}`);
            log('MGs will be skipped in this render');
        }
    }
    pass15Timer();

    // ==== PASS 2: Chunked compose + encode ====
    const pass2Timer = timer('Pass 2 — Chunked compose + encode');
    const chunks = computeChunkBoundaries(plan, 60);
    log(`Rendering in ${chunks.length} chunk(s): ${chunks.map(c => `[${c.startTime.toFixed(1)}-${c.endTime.toFixed(1)}s]`).join(', ')}`);

    // Track if NVENC fails — skip GPU attempts for subsequent chunks
    let nvencFailed = !_nvencAvailable;

    // Helper: build input args from inputs array
    function buildInputArgs(inputs) {
        const args = [];
        for (const inp of inputs) {
            const file = typeof inp === 'object' ? inp.file : inp;
            const streamLoop = typeof inp === 'object' && inp.streamLoop;
            if (file.startsWith('color=') || file.startsWith('nullsrc')) {
                args.push('-f', 'lavfi', '-i', file);
            } else {
                if (streamLoop) args.push('-stream_loop', '-1');
                args.push('-i', file);
            }
        }
        return args;
    }

    // Helper: encode a single chunk with NVENC → CPU fallback
    async function encodeChunk(inputArgs, filterFile, videoOutLabel, audioOutLabel, chunkDuration, chunkOutFile, chunkLabel) {
        const silenceTimeout = Math.max(120000, Math.round(chunkDuration * 3000));

        const runEncode = (ffmpegArgs, modeLabel) => runFFmpeg(ffmpegArgs, (pct, secs) => {
            progressCallback({
                percent: Math.min(95, 42 + Math.round(pct * 0.5)),
                message: `${chunkLabel} ${modeLabel}: ${secs.toFixed(1)}s / ${chunkDuration.toFixed(1)}s`
            });
        }, chunkDuration, null, silenceTimeout);

        const commonOutputArgs = (encArgs) => [
            '-filter_complex_script', filterFile,
            '-map', `[${videoOutLabel}]`,
            ...(audioOutLabel ? ['-map', `[${audioOutLabel}]`] : []),
            ...encArgs,
            '-pix_fmt', 'yuv420p',
            ...(audioOutLabel ? ['-c:a', 'aac', '-b:a', '192k'] : []),
            '-t', String(Math.ceil(chunkDuration + 0.5)),
            '-y', chunkOutFile
        ];

        // Try NVENC if not previously failed
        if (!nvencFailed) {
            const nvencArgs = ['-c:v', 'h264_nvenc', '-preset', NVENC_PRESET_FAST,
                '-b:v', FINAL_VIDEO_BITRATE, '-maxrate:v', FINAL_VIDEO_MAXRATE,
                '-bufsize:v', FINAL_VIDEO_BUFSIZE, '-profile:v', 'high'];
            try {
                await runEncode([...inputArgs, ...commonOutputArgs(nvencArgs)], 'GPU');
                return;
            } catch (e) {
                log(`${chunkLabel} NVENC failed: ${errorText(e).slice(-500)}`);
                // Try compat preset
                try {
                    const compatArgs = ['-c:v', 'h264_nvenc', '-preset', NVENC_PRESET_COMPAT,
                        '-b:v', FINAL_VIDEO_BITRATE, '-profile:v', 'high'];
                    await runEncode([...inputArgs, ...commonOutputArgs(compatArgs)], 'GPU compat');
                    return;
                } catch (e2) {
                    log(`${chunkLabel} NVENC compat also failed, falling back to CPU for all remaining chunks`);
                    nvencFailed = true;
                }
            }
        }

        // CPU fallback
        const cpuArgs = ['-c:v', 'libx264', '-preset', 'medium', '-crf', CPU_FALLBACK_CRF];
        await runEncode([...inputArgs, ...commonOutputArgs(cpuArgs)], 'CPU');
    }

    const chunkOutputs = [];

    for (const chunk of chunks) {
        if (_cancelled) throw new Error('Cancelled');

        const chunkDuration = chunk.endTime - chunk.startTime;
        const chunkFile = path.join(prepDir, `chunk-${chunk.chunkIndex}.mp4`);
        const chunkFilterFile = path.join(prepDir, `filter_graph_chunk${chunk.chunkIndex}.txt`);
        const chunkLabel = chunks.length > 1 ? `Chunk ${chunk.chunkIndex + 1}/${chunks.length}` : 'Compose';

        const basePct = chunks.length > 1
            ? 42 + Math.round((chunk.chunkIndex / chunks.length) * 50)
            : 42;
        progressCallback({ percent: basePct, message: `${chunkLabel}: building filter graph...` });

        const timeWindow = { startTime: chunk.startTime, endTime: chunk.endTime };
        const { inputs, filters, videoOutLabel } = await buildFilterGraph(plan, prepDir, mgClipDir, publicDir, timeWindow);
        const { audioFilters, audioOutLabel } = buildAudioMix(plan, publicDir, inputs, timeWindow);
        const allFilters = [...filters, ...audioFilters];

        fs.writeFileSync(chunkFilterFile, allFilters.join(';\n'));
        log(`${chunkLabel}: ${allFilters.length} filters, ${inputs.length} inputs, ${chunkDuration.toFixed(1)}s (${chunk.startTime.toFixed(1)}-${chunk.endTime.toFixed(1)})`);

        const inputArgs = buildInputArgs(inputs);

        try {
            await encodeChunk(inputArgs, chunkFilterFile, videoOutLabel, audioOutLabel, chunkDuration, chunkFile, chunkLabel);

            if (!fs.existsSync(chunkFile) || fs.statSync(chunkFile).size < 1000) {
                throw new Error(`${chunkLabel} output missing or empty`);
            }
            chunkOutputs.push(chunkFile);
            log(`✓ ${chunkLabel} done`);
        } catch (e) {
            logError(`${chunkLabel} failed: ${errorText(e).slice(-1500)}`);
            throw new Error(`${chunkLabel} failed: ${e.message}`);
        }
    }

    // ==== PASS 3: Stitch chunks (if multiple) ====
    if (chunkOutputs.length === 1) {
        // Single chunk — just rename to output
        fs.renameSync(chunkOutputs[0], outputPath);
        log('Single chunk — moved to output path');
    } else {
        const pass3Timer = timer('Pass 3 — Concat stitch');
        progressCallback({ percent: 96, message: 'Stitching chunks...' });

        const concatListFile = path.join(prepDir, 'concat_list.txt');
        const concatContent = chunkOutputs.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n');
        fs.writeFileSync(concatListFile, concatContent);

        log(`Stitching ${chunkOutputs.length} chunks via concat demuxer`);
        await runFFmpeg([
            '-f', 'concat', '-safe', '0', '-i', concatListFile,
            '-c', 'copy',
            '-movflags', '+faststart',
            '-y', outputPath
        ]);

        pass3Timer();
    }

    // Cleanup prep directory (keep filter graphs + mg-clips for debugging)
    try {
        const prepFiles = fs.readdirSync(prepDir);
        for (const f of prepFiles) {
            if (f.startsWith('filter_graph') || f === 'mg-clips' || f === 'concat_list.txt') continue;
            const fp = path.join(prepDir, f);
            try {
                if (fs.statSync(fp).isDirectory()) {
                    const subFiles = fs.readdirSync(fp);
                    for (const sf of subFiles) fs.unlinkSync(path.join(fp, sf));
                    fs.rmdirSync(fp);
                } else {
                    fs.unlinkSync(fp);
                }
            } catch (e2) { /* ignore */ }
        }
    } catch (e) { /* ignore cleanup errors */ }

    pass2Timer();
    const totalSec = totalTimer();

    if (fs.existsSync(outputPath)) {
        const sizeMB = (fs.statSync(outputPath).size / (1024 * 1024)).toFixed(1);
        log(`✅ Render complete: ${outputPath} (${sizeMB} MB) in ${totalSec}s`);
        log(`Encoder: ${nvencFailed ? 'libx264 (CPU)' : 'h264_nvenc (GPU)'}`);
        return { success: true, outputPath };
    }

    return { success: false, error: 'Output file not found after render' };
}

// ---------------------------------------------------------------------------
// EXPORTS
// ---------------------------------------------------------------------------

module.exports = { renderWithFFmpeg, cancelRender };
