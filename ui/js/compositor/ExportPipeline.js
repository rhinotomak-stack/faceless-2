/**
 * ExportPipeline.js — Offline render loop for WebGL2 compositor export
 *
 * Drives the compositor frame-by-frame:
 *   renderFrame(f) -> readPixels() -> FFmpeg stdin (direct pipe, no IPC)
 *
 * FFmpeg is spawned directly in the renderer process via require('child_process').
 * This bypasses Electron IPC entirely for frame data, eliminating the ~8MB
 * structured clone per frame that caused GC pauses.
 *
 * Audio is muxed via a lightweight IPC call after all frames are written.
 *
 * Two export paths:
 *   - Legacy: per-frame HTMLVideoElement seeking + RAF yield + sync readPixels
 *   - Optimized: WebCodecs sequential decode + PBO async readback
 */

// Node.js modules — exposed by preload.js (contextIsolation: false + sandbox: false)
const _spawn = window._nodeSpawn;
const _path  = window._nodePath;
const _fs    = window._nodeFs;

// FFmpeg executable — same path as main.js uses
const FFMPEG_PATH = (typeof process !== 'undefined' && process.env && process.env.FFMPEG_PATH)
    || 'C:\\ffmg\\bin\\ffmpeg.exe';

// Max PBO frames in-flight before draining. Independent of pboCount.
const MAX_INFLIGHT_PBOS = 3;

class ExportPipeline {
    /**
     * @param {Compositor} compositor - The initialized compositor engine
     */
    constructor(compositor) {
        this.compositor = compositor;
        this._cancelled = false;
        this._progressCallback = null;
        this._running = false;
        // Ring buffer pool
        this._pool = null;
        this._poolSize = 0;
        this._poolIndex = 0;
        // PBO async readback state
        this._pboEnabled = false;
        // Direct FFmpeg process
        this._ffmpegProc = null;
        this._framesWritten = 0;
        this._bytesWritten = 0;
        this._lastLogTime = 0;
        this._lastLogFrames = 0;
    }

    /**
     * Register a progress callback.
     * @param {function} cb - (data: { percent, currentFrame, totalFrames, fps }) => void
     */
    onProgress(cb) {
        this._progressCallback = cb;
    }

    /**
     * Run the full export pipeline.
     *
     * @param {object} options - Export options
     * @param {number} options.width - Output width (default 1920)
     * @param {number} options.height - Output height (default 1080)
     * @param {number} options.fps - Frames per second (default 30)
     * @param {boolean} options.legacy - Force legacy export path (per-frame seek + RAF)
     * @returns {Promise<{success: boolean, outputPath?: string, error?: string}>}
     */
    async start(options) {
        if (this._running) {
            return { success: false, error: 'Export already in progress' };
        }

        const width = (options && options.width) || this.compositor.width;
        const height = (options && options.height) || this.compositor.height;
        const fps = (options && options.fps) || this.compositor.fps;
        const totalFrames = this.compositor.totalFrames;

        if (totalFrames <= 0) {
            return { success: false, error: 'No frames to export (empty timeline)' };
        }

        const legacy = !!(options && options.legacy);
        const expectedFrameSize = width * height * 4;

        this._running = true;
        this._cancelled = false;
        this._framesWritten = 0;
        this._bytesWritten = 0;
        this._lastLogTime = Date.now();
        this._lastLogFrames = 0;
        this.compositor._exporting = true;
        // Switch to full resolution for export
        this.compositor._setExportResolution();

        // Verify Node.js require() is available (needs contextIsolation: false + sandbox: false)
        if (typeof _spawn !== 'function') {
            return { success: false, error: 'Direct-spawn not available. Check contextIsolation/sandbox settings.' };
        }

        console.log(`[ExportPipeline] Starting ${legacy ? 'LEGACY' : 'OPTIMIZED'} DIRECT-SPAWN export: ${totalFrames} frames, ${width}x${height} @ ${fps}fps`);
        const startTime = performance.now();

        let videoFile = null;
        let outputFile = null;

        try {
            // 1. Get export config from main process (encoder args, output paths)
            const config = await window.electronAPI.getExportConfig({
                width, height, fps, totalFrames,
            });
            if (!config || !config.success) {
                throw new Error(config?.error || 'Failed to get export config');
            }

            videoFile = config.videoFile;
            outputFile = config.outputFile;

            // 2. Spawn FFmpeg directly in renderer process (no IPC for frame data!)
            const ffmpegPath = config.ffmpegPath || FFMPEG_PATH;
            const ffmpegArgs = [
                '-y',
                '-f', 'rawvideo',
                '-pixel_format', 'rgba',
                '-video_size', `${width}x${height}`,
                '-framerate', String(fps),
                '-i', 'pipe:0',
                ...config.encArgs,
                '-pix_fmt', 'yuv420p',
                '-an',
                videoFile
            ];

            console.log(`[ExportPipeline] Spawning FFmpeg: ${ffmpegPath} ${ffmpegArgs.join(' ')}`);
            const ffmpegProc = _spawn(ffmpegPath, ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            });
            this._ffmpegProc = ffmpegProc;

            let ffmpegStderr = '';
            ffmpegProc.stderr.on('data', (data) => {
                ffmpegStderr += data.toString();
            });

            // Handle unexpected FFmpeg death
            let ffmpegDead = false;
            ffmpegProc.on('error', (err) => {
                ffmpegDead = true;
                console.error('[ExportPipeline] FFmpeg process error:', err.message);
            });
            ffmpegProc.on('close', (code) => {
                if (code !== 0 && !this._cancelled) {
                    ffmpegDead = true;
                    console.error(`[ExportPipeline] FFmpeg exited unexpectedly with code ${code}`);
                }
            });

            // 3. Allocate ring buffer pool
            this._initPool(width, height);

            // 3b. Try to enable PBO async readback (WebGL2 only)
            this._pboEnabled = false;
            if (this.compositor.gl instanceof WebGL2RenderingContext) {
                this._pboEnabled = this.compositor.initPBOs(width, height);
            }
            if (this._pboEnabled) {
                console.log(`[WebGL Export] ▶▶▶ PBO MODE: ON, PBOs=${this.compositor._pboCount}, maxInflight=${MAX_INFLIGHT_PBOS} ◀◀◀`);
            } else {
                const reason = !(this.compositor.gl instanceof WebGL2RenderingContext) ? 'not WebGL2' : 'init failed';
                console.log(`[WebGL Export] ▶▶▶ PBO MODE: OFF (reason: ${reason}) ◀◀◀`);
            }

            // 4. Pause all video playback, prepare for seeking
            this.compositor.pauseVideos();

            // 5. Run frame loop (legacy or optimized) — writes directly to FFmpeg stdin
            const writeFrame = async (buffer) => {
                if (ffmpegDead) throw new Error('FFmpeg process died');
                if (this._cancelled) throw new Error('Export cancelled');

                // Write the raw RGBA buffer directly to FFmpeg stdin — zero IPC!
                // stdin.write accepts Uint8Array directly — no Buffer.from needed
                const canWrite = ffmpegProc.stdin.write(new Uint8Array(buffer));
                this._framesWritten++;
                this._bytesWritten += buffer.byteLength;

                // Backpressure: wait for FFmpeg to drain before accepting more frames
                if (!canWrite) {
                    await new Promise((resolve, reject) => {
                        ffmpegProc.stdin.once('drain', resolve);
                        ffmpegProc.stdin.once('error', reject);
                    });
                }

                // Periodic logging
                const now = Date.now();
                if (now - this._lastLogTime >= 1000) {
                    const elapsed = (now - this._lastLogTime) / 1000;
                    const recentFrames = this._framesWritten - this._lastLogFrames;
                    const recentFps = (recentFrames / elapsed).toFixed(1);
                    const totalMB = (this._bytesWritten / (1024 * 1024)).toFixed(0);
                    console.log(`[ExportPipeline] ${this._framesWritten}/${totalFrames} frames | ${recentFps} fps | ${totalMB} MB written (direct)`);
                    this._lastLogTime = now;
                    this._lastLogFrames = this._framesWritten;
                }
            };

            if (legacy || !this._canUseOptimizedPath()) {
                await this._runLegacyFrameLoop(fps, totalFrames, startTime, writeFrame);
            } else {
                await this._runOptimizedFrameLoop(fps, totalFrames, startTime, writeFrame);
            }

            // 6. Close FFmpeg stdin and wait for it to finish encoding
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    try { ffmpegProc.kill('SIGTERM'); } catch (_) { }
                    reject(new Error('FFmpeg encoding timeout (120s)'));
                }, 120000);

                ffmpegProc.on('close', (code) => {
                    clearTimeout(timeout);
                    if (code === 0) {
                        resolve();
                    } else {
                        reject(new Error(`FFmpeg exited with code ${code}\n${ffmpegStderr.slice(-500)}`));
                    }
                });
                ffmpegProc.on('error', (err) => {
                    clearTimeout(timeout);
                    reject(err);
                });

                ffmpegProc.stdin.end();
            });

            console.log(`[ExportPipeline] Video encoded: ${videoFile} (${this._framesWritten} frames)`);

            // 7. Mux audio via IPC (lightweight, one-time call)
            const muxResult = await window.electronAPI.muxAudio(videoFile, outputFile);
            if (!muxResult || !muxResult.success) {
                throw new Error(muxResult?.error || 'Audio mux failed');
            }

            const totalElapsed = ((performance.now() - startTime) / 1000).toFixed(1);
            console.log(`[ExportPipeline] Export complete in ${totalElapsed}s: ${muxResult.outputPath}`);

            return { success: true, outputPath: muxResult.outputPath };

        } catch (err) {
            console.error('[ExportPipeline] Export failed:', err.message);
            // Kill FFmpeg if still running
            if (this._ffmpegProc && !this._ffmpegProc.killed) {
                try {
                    this._ffmpegProc.stdin.destroy();
                    this._ffmpegProc.kill('SIGTERM');
                } catch (_) { }
            }
            return { success: false, error: err.message };

        } finally {
            this._running = false;
            this._ffmpegProc = null;
            this.compositor._exporting = false;
            this.compositor._restorePreviewResolution();
            this.compositor._resetVideosForPreview();
            if (this._pboEnabled) {
                this.compositor.destroyPBOs();
                this._pboEnabled = false;
            }
            this._destroyPool();
        }
    }

    /**
     * Allocate ring buffer pool for zero-copy readPixels.
     * Pool size = 4 so we always have free buffers while writes complete.
     */
    _initPool(width, height) {
        const frameBytes = width * height * 4;
        this._poolSize = 4;
        this._pool = new Array(this._poolSize);
        for (let i = 0; i < this._poolSize; i++) {
            this._pool[i] = new Uint8Array(frameBytes);
        }
        this._poolIndex = 0;
        console.log(`[ExportPipeline] Ring buffer pool: ${this._poolSize} x ${(frameBytes / 1024 / 1024).toFixed(1)}MB = ${(this._poolSize * frameBytes / 1024 / 1024).toFixed(1)}MB total`);
    }

    /**
     * Get the next buffer from the ring pool and advance the index.
     * @returns {Uint8Array}
     */
    _nextPoolBuffer() {
        const buf = this._pool[this._poolIndex];
        this._poolIndex = (this._poolIndex + 1) % this._poolSize;
        return buf;
    }

    /**
     * Release pool memory.
     */
    _destroyPool() {
        this._pool = null;
        this._poolSize = 0;
        this._poolIndex = 0;
    }

    /**
     * Check if the optimized export path is available.
     */
    _canUseOptimizedPath() {
        return typeof VideoFrameSource !== 'undefined'
            && typeof VideoDecoder !== 'undefined';
    }

    // ========================================================================
    // LEGACY FRAME LOOP
    // ========================================================================

    /**
     * Legacy export: per-frame HTMLVideoElement seeking + RAF yield + sync readPixels.
     * @param {function} writeFrame - async (ArrayBuffer) => void — writes to FFmpeg stdin
     */
    async _runLegacyFrameLoop(fps, totalFrames, startTime, writeFrame) {
        let usePBO = this._pboEnabled;
        console.log(`[ExportPipeline] Legacy loop: pbo=${usePBO}`);
        let lastProgressTime = 0;

        // PBO pipeline FIFO
        const pending = [];
        let consecutiveTimeouts = 0;

        for (let frame = 0; frame < totalFrames; frame++) {
            if (this._cancelled) throw new Error('Export cancelled');

            // Seek all active videos to this frame
            const activeScenes = this.compositor.sceneGraph.getActiveScenesAtFrame(frame);
            let didSeek = false;
            for (const { scene } of activeScenes) {
                if (scene.isMGScene || scene.mediaType === 'motion-graphic') continue;
                const localFrame = frame - scene._startFrame;
                const mediaOffsetFrames = Math.round((scene.mediaOffset || 0) * fps);
                await this.compositor.seekVideoToFrame(scene, localFrame + mediaOffsetFrames);
                didSeek = true;
            }

            if (didSeek) {
                // setTimeout(0) instead of RAF — avoids 16.6ms vsync cap per frame
                await new Promise(resolve => setTimeout(resolve, 0));
            }

            // Render the frame
            this.compositor.renderFrame(frame);

            if (usePBO) {
                while (pending.length >= MAX_INFLIGHT_PBOS) {
                    const old = pending.shift();
                    const fenceOk = await this.compositor.awaitFence(old.sync);

                    if (!fenceOk) {
                        consecutiveTimeouts++;
                        console.warn(`[ExportPipeline] PBO fence timeout #${consecutiveTimeouts} at frame ${old.frame}`);

                        if (consecutiveTimeouts >= 2) {
                            console.warn(`[ExportPipeline] ${consecutiveTimeouts} consecutive timeouts -> disabling PBO`);
                            pending.unshift(old);
                            for (const p of pending) {
                                this.compositor.renderFrame(p.frame);
                                const target = this._nextPoolBuffer();
                                this.compositor.readPixelsInto(target);
                                await writeFrame(target.buffer);
                                if (p.sync) try { this.compositor.gl.deleteSync(p.sync); } catch (_) { }
                            }
                            pending.length = 0;
                            usePBO = false;
                            this._pboEnabled = false;
                            this.compositor.destroyPBOs();
                            break;
                        }
                    } else {
                        consecutiveTimeouts = 0;
                    }

                    const target = this._nextPoolBuffer();
                    this.compositor.readBackPBO(old.pboIndex, target);
                    await writeFrame(target.buffer);
                }

                if (usePBO) {
                    const pboIndex = this.compositor.readPixelsIntoPBO();
                    const sync = this.compositor.createFence();
                    pending.push({ frame, pboIndex, sync });
                } else {
                    const target = this._nextPoolBuffer();
                    this.compositor.readPixelsInto(target);
                    await writeFrame(target.buffer);
                }
            } else {
                const target = this._nextPoolBuffer();
                this.compositor.readPixelsInto(target);
                await writeFrame(target.buffer);
            }

            this._reportProgress(frame, totalFrames, startTime, lastProgressTime, (t) => { lastProgressTime = t; });
        }

        // PBO DRAIN
        while (pending.length > 0) {
            const old = pending.shift();
            const fenceOk = await this.compositor.awaitFence(old.sync);
            if (!fenceOk) {
                console.warn(`[ExportPipeline] PBO fence timeout during drain at frame ${old.frame}`);
                this.compositor.renderFrame(old.frame);
                const target = this._nextPoolBuffer();
                this.compositor.readPixelsInto(target);
                await writeFrame(target.buffer);
                for (const p of pending) {
                    if (p.sync) try { this.compositor.gl.deleteSync(p.sync); } catch (_) { }
                    this.compositor.renderFrame(p.frame);
                    const t = this._nextPoolBuffer();
                    this.compositor.readPixelsInto(t);
                    await writeFrame(t.buffer);
                }
                pending.length = 0;
                this.compositor.destroyPBOs();
                break;
            }
            const target = this._nextPoolBuffer();
            this.compositor.readBackPBO(old.pboIndex, target);
            await writeFrame(target.buffer);
        }
    }

    // ========================================================================
    // OPTIMIZED FRAME LOOP (WebCodecs + PBO)
    // ========================================================================

    /**
     * Optimized export: WebCodecs sequential decode — no per-frame seeking/RAF.
     * @param {function} writeFrame - async (ArrayBuffer) => void — writes to FFmpeg stdin
     */
    async _runOptimizedFrameLoop(fps, totalFrames, startTime, writeFrame) {
        const vfs = new VideoFrameSource();
        const webcodecScenes = new Set();
        const legacyScenes = new Set();

        // 1. Init WebCodecs decoders for all video scenes
        const allScenes = this.compositor.sceneGraph.scenes;
        const initPromises = [];

        for (const scene of allScenes) {
            if (scene.isMGScene || scene.mediaType === 'motion-graphic') continue;
            if (scene.mediaType === 'image') continue;
            const idx = scene.index;
            const key = this.compositor._sceneKey(scene);
            const url = this.compositor._mediaUrls[key];
            if (!url) {
                legacyScenes.add(idx);
                console.log(`[ExportPipeline] Fallback to LEGACY for scene ${idx} (no media URL)`);
                continue;
            }

            const ext = (scene.mediaExtension || '.mp4').toLowerCase();
            if (ext !== '.mp4') {
                legacyScenes.add(idx);
                console.log(`[ExportPipeline] Fallback to LEGACY for scene ${idx} (non-MP4: ${ext})`);
                continue;
            }

            initPromises.push(
                vfs.init(idx, url, fps).then(ok => {
                    if (ok) {
                        webcodecScenes.add(idx);
                        const state = vfs._decoders.get(idx);
                        const codec = state && state.codecConfig ? state.codecConfig.codec : 'unknown';
                        console.log(`[ExportPipeline] Using OPTIMIZED WebCodecs for scene ${idx} (${codec})`);
                    } else {
                        legacyScenes.add(idx);
                        console.log(`[ExportPipeline] Fallback to LEGACY for scene ${idx} (WebCodecs init failed)`);
                    }
                })
            );
        }

        await Promise.all(initPromises);
        console.log(`[ExportPipeline] Optimized: ${webcodecScenes.size} WebCodecs, ${legacyScenes.size} legacy scenes`);

        if (webcodecScenes.size === 0) {
            console.warn('[ExportPipeline] No WebCodecs decoders initialized, falling back to legacy');
            vfs.closeAll();
            return this._runLegacyFrameLoop(fps, totalFrames, startTime, writeFrame);
        }

        // 2. Frame loop
        let usePBO = this._pboEnabled;
        console.log(`[ExportPipeline] Optimized loop: pbo=${usePBO}`);
        let lastProgressTime = 0;
        const exportFrameSources = new Map();
        this.compositor._exportFrameSources = exportFrameSources;

        const pending = [];
        let consecutiveTimeouts = 0;

        try {
            for (let frame = 0; frame < totalFrames; frame++) {
                if (this._cancelled) throw new Error('Export cancelled');

                const activeScenes = this.compositor.sceneGraph.getActiveScenesAtFrame(frame);
                exportFrameSources.clear();
                let didLegacySeek = false;

                for (const { scene } of activeScenes) {
                    if (scene.isMGScene || scene.mediaType === 'motion-graphic') continue;
                    if (scene.mediaType === 'image') continue;
                    const idx = scene.index;
                    const localFrame = frame - scene._startFrame;
                    const mediaOffsetFrames = Math.round((scene.mediaOffset || 0) * fps);
                    const timeSec = (localFrame + mediaOffsetFrames) / fps;

                    if (webcodecScenes.has(idx)) {
                        const videoFrame = await vfs.getFrameAtTime(idx, timeSec);
                        if (videoFrame) {
                            exportFrameSources.set(idx, videoFrame);
                        } else {
                            await this.compositor.seekVideoToFrame(scene, localFrame + mediaOffsetFrames);
                            didLegacySeek = true;
                        }
                    } else if (legacyScenes.has(idx)) {
                        await this.compositor.seekVideoToFrame(scene, localFrame + mediaOffsetFrames);
                        didLegacySeek = true;
                    }
                }

                if (didLegacySeek) {
                    // Use setTimeout(0) instead of RAF — RAF is capped at 16.6ms (60Hz)
                    // which adds 16ms per frame to every scene with a legacy seek fallback.
                    // setTimeout(0) yields to the event loop without the vsync cap.
                    await new Promise(resolve => setTimeout(resolve, 0));
                }

                this.compositor.renderFrame(frame);

                // Close VideoFrames immediately after render
                for (const [idx, vf] of exportFrameSources.entries()) {
                    try { vf.close(); } catch (_) { }
                    const decState = vfs._decoders.get(idx);
                    if (decState && decState.currentFrame === vf) {
                        decState.currentFrame = null;
                    }
                }

                if (usePBO) {
                    while (pending.length >= MAX_INFLIGHT_PBOS) {
                        const old = pending.shift();
                        const fenceOk = await this.compositor.awaitFence(old.sync);

                        if (!fenceOk) {
                            consecutiveTimeouts++;
                            console.warn(`[ExportPipeline] PBO fence timeout #${consecutiveTimeouts} at frame ${old.frame}`);

                            if (consecutiveTimeouts >= 2) {
                                console.warn(`[ExportPipeline] ${consecutiveTimeouts} consecutive timeouts -> disabling PBO + WebCodecs`);
                                vfs.closeAll();
                                for (const idx of webcodecScenes) legacyScenes.add(idx);
                                webcodecScenes.clear();
                                exportFrameSources.clear();
                                this.compositor._exportFrameSources = null;

                                pending.unshift(old);
                                for (const p of pending) {
                                    if (p.sync) try { this.compositor.gl.deleteSync(p.sync); } catch (_) { }
                                    const activeAtFrame = this.compositor.sceneGraph.getActiveScenesAtFrame(p.frame);
                                    for (const { scene } of activeAtFrame) {
                                        if (scene.isMGScene || scene.mediaType === 'motion-graphic' || scene.mediaType === 'image') continue;
                                        const lf = p.frame - scene._startFrame;
                                        const mof = Math.round((scene.mediaOffset || 0) * fps);
                                        await this.compositor.seekVideoToFrame(scene, lf + mof);
                                    }
                                    await new Promise(resolve => setTimeout(resolve, 0));
                                    this.compositor.renderFrame(p.frame);
                                    const target = this._nextPoolBuffer();
                                    this.compositor.readPixelsInto(target);
                                    await writeFrame(target.buffer);
                                }
                                pending.length = 0;
                                usePBO = false;
                                this._pboEnabled = false;
                                this.compositor.destroyPBOs();
                                break;
                            }
                        } else {
                            consecutiveTimeouts = 0;
                        }

                        const target = this._nextPoolBuffer();
                        this.compositor.readBackPBO(old.pboIndex, target);
                        await writeFrame(target.buffer);
                    }

                    if (usePBO) {
                        const pboIndex = this.compositor.readPixelsIntoPBO();
                        const sync = this.compositor.createFence();
                        pending.push({ frame, pboIndex, sync });
                    } else {
                        const activeAtFrame = this.compositor.sceneGraph.getActiveScenesAtFrame(frame);
                        for (const { scene } of activeAtFrame) {
                            if (scene.isMGScene || scene.mediaType === 'motion-graphic' || scene.mediaType === 'image') continue;
                            const lf = frame - scene._startFrame;
                            const mof = Math.round((scene.mediaOffset || 0) * fps);
                            await this.compositor.seekVideoToFrame(scene, lf + mof);
                        }
                        await new Promise(resolve => setTimeout(resolve, 0));
                        this.compositor.renderFrame(frame);
                        const target = this._nextPoolBuffer();
                        this.compositor.readPixelsInto(target);
                        await writeFrame(target.buffer);
                    }
                } else {
                    const target = this._nextPoolBuffer();
                    this.compositor.readPixelsInto(target);
                    await writeFrame(target.buffer);
                }

                this._reportProgress(frame, totalFrames, startTime, lastProgressTime, (t) => { lastProgressTime = t; });
            }

            // PBO DRAIN
            while (pending.length > 0) {
                const old = pending.shift();
                const fenceOk = await this.compositor.awaitFence(old.sync);
                if (!fenceOk) {
                    console.warn(`[ExportPipeline] PBO fence timeout during drain at frame ${old.frame}`);
                    vfs.closeAll();
                    exportFrameSources.clear();
                    this.compositor._exportFrameSources = null;

                    const allRemaining = [old, ...pending];
                    pending.length = 0;
                    for (const p of allRemaining) {
                        if (p.sync) try { this.compositor.gl.deleteSync(p.sync); } catch (_) { }
                        const activeAtFrame = this.compositor.sceneGraph.getActiveScenesAtFrame(p.frame);
                        for (const { scene } of activeAtFrame) {
                            if (scene.isMGScene || scene.mediaType === 'motion-graphic' || scene.mediaType === 'image') continue;
                            const lf = p.frame - scene._startFrame;
                            const mof = Math.round((scene.mediaOffset || 0) * fps);
                            await this.compositor.seekVideoToFrame(scene, lf + mof);
                        }
                        await new Promise(resolve => setTimeout(resolve, 0));
                        this.compositor.renderFrame(p.frame);
                        const t = this._nextPoolBuffer();
                        this.compositor.readPixelsInto(t);
                        await writeFrame(t.buffer);
                    }
                    this.compositor.destroyPBOs();
                    break;
                }
                const target = this._nextPoolBuffer();
                this.compositor.readBackPBO(old.pboIndex, target);
                await writeFrame(target.buffer);
            }
        } finally {
            this.compositor._exportFrameSources = null;
            vfs.closeAll();
        }
    }

    // ========================================================================
    // VALIDATION
    // ========================================================================

    /**
     * Validate frame hashes: render specific frames and log their hashes.
     *
     * @param {number[]} testFrames - Frame indices to validate
     * @returns {Promise<Array<{frame: number, hash: string}>>}
     */
    async validate(testFrames) {
        if (!this.compositor || !this.compositor.isInitialized || !this.compositor.sceneGraph) {
            console.error('[Validation] Compositor not ready');
            return [];
        }

        const totalFrames = this.compositor.totalFrames;
        const fps = this.compositor.fps;
        const results = [];

        const wasExporting = this.compositor._exporting;
        this.compositor._exporting = true;
        this.compositor.pauseVideos();

        try {
            for (const frame of testFrames) {
                if (frame < 0 || frame >= totalFrames) {
                    console.warn(`[Validation] Frame ${frame} out of range (0-${totalFrames - 1}), skipping`);
                    continue;
                }

                const activeScenes = this.compositor.sceneGraph.getActiveScenesAtFrame(frame);
                for (const { scene } of activeScenes) {
                    if (scene.isMGScene || scene.mediaType === 'motion-graphic') continue;
                    const localFrame = frame - scene._startFrame;
                    const mediaOffsetFrames = Math.round((scene.mediaOffset || 0) * fps);
                    await this.compositor.seekVideoToFrame(scene, localFrame + mediaOffsetFrames);
                }
                await new Promise(resolve => setTimeout(resolve, 0));

                this.compositor.renderFrame(frame);
                const hash = this.compositor.computeFrameHash();
                results.push({ frame, hash });
                console.log(`[Validation] Frame ${frame}: hash=${hash}`);
            }
        } finally {
            this.compositor._exporting = wasExporting;
            this.compositor._resetVideosForPreview();
        }

        return results;
    }

    // ========================================================================
    // HELPERS
    // ========================================================================

    /**
     * Throttled progress reporting.
     */
    _reportProgress(frame, totalFrames, startTime, lastProgressTime, setLastTime) {
        const now = performance.now();
        if (now - lastProgressTime > 100 || frame === totalFrames - 1) {
            setLastTime(now);
            const percent = Math.round(((frame + 1) / totalFrames) * 100);
            const elapsed = (now - startTime) / 1000;
            const currentFps = elapsed > 0 ? ((frame + 1) / elapsed).toFixed(1) : '0';

            if (this._progressCallback) {
                this._progressCallback({
                    percent,
                    currentFrame: frame + 1,
                    totalFrames,
                    fps: currentFps,
                    elapsed: elapsed.toFixed(1),
                });
            }
        }
    }

    /**
     * Cancel an in-progress export.
     */
    cancel() {
        this._cancelled = true;
        if (this._ffmpegProc && !this._ffmpegProc.killed) {
            try {
                this._ffmpegProc.stdin.destroy();
                this._ffmpegProc.kill('SIGTERM');
            } catch (_) { }
        }
    }
}

window.ExportPipeline = ExportPipeline;
