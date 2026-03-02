/**
 * Compositor.js — WYSIWYG WebGL2 Compositor Engine
 *
 * Single render(frameIndex) method that produces identical output for:
 *   1) Real-time preview (renders to on-screen canvas via requestAnimationFrame)
 *   2) Offline export (renders frame-by-frame, readPixels -> FFmpeg)
 *
 * Compositing pipeline per frame:
 *   1. Clear to black
 *   2. For each active video/image scene (sorted by track): upload texture, blit
 *   3. If transition active: blend via TransitionRenderer shader
 *   4. For each active MG overlay: render Canvas2D -> texture, alpha-blend
 *   5. (Export mode): readPixels -> Uint8Array
 */

class Compositor {
    /**
     * @param {HTMLCanvasElement} canvas - The target canvas element
     * @param {object} opts - { width, height, fps }
     */
    constructor(canvas, opts) {
        this.canvas = canvas;
        this.width = (opts && opts.width) || 1920;
        this.height = (opts && opts.height) || 1080;
        this.fps = (opts && opts.fps) || 30;

        this.gl = null;
        this.sceneGraph = null;
        this.textureManager = null;
        this.mgRenderer = null;
        this.transitionRenderer = null;

        // Video elements keyed by scene index
        this._videoElements = {};
        // Cached media URLs keyed by scene index
        this._mediaUrls = {};
        // URL resolver function (async: sceneIndex -> url)
        this._urlResolver = null;
        // Script context from plan
        this._scriptContext = null;

        // Shader programs
        this._blitProgram = null;
        this._quadVAO = null;

        this._initialized = false;
        this._currentFrame = -1;
        this._exporting = false;

        // Flip buffer for export (readPixels returns bottom-up)
        this._flipBuf = null;
    }

    // ========================================================================
    // LIFECYCLE
    // ========================================================================

    /**
     * Initialize WebGL2 context, compile shaders, allocate buffers.
     */
    init() {
        if (this._initialized) return;

        this.canvas.width = this.width;
        this.canvas.height = this.height;

        const gl = this.canvas.getContext('webgl2', {
            alpha: false,              // Opaque canvas (composites on black)
            premultipliedAlpha: false,
            preserveDrawingBuffer: true,  // Required for readPixels in export
            antialias: false,
            powerPreference: 'high-performance',
        });

        if (!gl) {
            throw new Error('WebGL2 not available — cannot initialize compositor');
        }
        this.gl = gl;

        // Compile blit shader
        const { QUAD_VERT, BLIT_FRAG, ShaderProgram } = window.ShaderLib;
        this._blitProgram = new ShaderProgram(gl, QUAD_VERT, BLIT_FRAG);

        // Create fullscreen quad VAO
        this._quadVAO = this._createQuadVAO(gl);

        // Sub-components
        this.textureManager = new TextureManager(gl);
        this.mgRenderer = new MGRenderer(this.textureManager, this.fps);
        this.transitionRenderer = new TransitionRenderer(gl);
        this.transitionRenderer.init();

        this._initialized = true;
        console.log('[Compositor] Initialized WebGL2 engine', this.width, 'x', this.height, '@', this.fps, 'fps');
    }

    /**
     * Destroy all GPU resources and video elements.
     */
    destroy() {
        if (this.textureManager) this.textureManager.releaseAll();
        if (this.transitionRenderer) this.transitionRenderer.destroy();
        if (this._blitProgram) this._blitProgram.destroy();
        if (this._quadVAO && this.gl) {
            this.gl.deleteVertexArray(this._quadVAO);
        }
        if (this.mgRenderer) this.mgRenderer.destroy();

        // Pause and release video elements
        for (const key of Object.keys(this._videoElements)) {
            const vid = this._videoElements[key];
            vid.pause();
            vid.src = '';
            vid.load();
        }
        this._videoElements = {};
        this._mediaUrls = {};

        this.gl = null;
        this._initialized = false;
        console.log('[Compositor] Destroyed');
    }

    // ========================================================================
    // PLAN LOADING
    // ========================================================================

    /**
     * Load a video-plan.json into the compositor.
     * Creates SceneGraph, preloads video elements.
     *
     * @param {object} plan - The video-plan.json object
     * @param {function} urlResolver - async (sceneIndex, extension) => url string
     */
    async loadPlan(plan, urlResolver) {
        if (!this._initialized) this.init();

        this._urlResolver = urlResolver;
        this._scriptContext = plan.scriptContext || {};
        this.fps = plan.fps || this.fps;

        // Build frame-based scene graph
        this.sceneGraph = new SceneGraph(this.fps);
        this.sceneGraph.loadFromPlan(plan);

        // Preload video/image elements for all non-MG scenes
        const mediaScenes = this.sceneGraph.scenes.filter(s => !s.isMGScene && s.mediaType !== 'motion-graphic');
        await this._preloadMedia(mediaScenes);

        console.log('[Compositor] Plan loaded:', this.sceneGraph.totalFrames, 'frames,',
            mediaScenes.length, 'media scenes,', this.sceneGraph.motionGraphics.length, 'MG overlays');
    }

    /**
     * Create hidden <video>/<img> elements for media scenes and start loading.
     */
    async _preloadMedia(scenes) {
        // Release old elements
        for (const key of Object.keys(this._videoElements)) {
            const vid = this._videoElements[key];
            vid.pause();
            vid.src = '';
        }
        this._videoElements = {};
        this._mediaUrls = {};

        const loadPromises = [];

        for (const scene of scenes) {
            const idx = scene.index;
            if (idx == null || this._videoElements[idx]) continue;

            const ext = scene.mediaExtension || '.mp4';
            const isImage = scene.mediaType === 'image' || /\.(jpg|jpeg|png|webp|gif)$/i.test(ext);

            if (isImage) {
                // Create an <img> element
                const img = new Image();
                img.crossOrigin = 'anonymous';
                const p = this._resolveUrl(idx, ext).then(url => {
                    if (url) {
                        img.src = url;
                        this._mediaUrls[idx] = url;
                    }
                });
                loadPromises.push(p);
                this._videoElements[idx] = img; // Store in same map, type-check at render time
            } else {
                // Create a hidden <video> element
                const video = document.createElement('video');
                video.muted = true;
                video.preload = 'auto';
                video.playsInline = true;
                video.crossOrigin = 'anonymous';
                // Prevent the video from being visible/audible
                video.style.display = 'none';
                document.body.appendChild(video);

                const p = this._resolveUrl(idx, ext).then(url => {
                    if (url) {
                        video.src = url;
                        this._mediaUrls[idx] = url;
                    }
                });
                loadPromises.push(p);
                this._videoElements[idx] = video;
            }
        }

        await Promise.all(loadPromises);
    }

    async _resolveUrl(sceneIndex, ext) {
        if (this._urlResolver) {
            try {
                return await this._urlResolver(sceneIndex, ext);
            } catch (e) {
                console.warn('[Compositor] Failed to resolve URL for scene', sceneIndex, e);
                return null;
            }
        }
        return null;
    }

    // ========================================================================
    // RENDER
    // ========================================================================

    /**
     * Render at a given time in seconds (convenience for preview playback).
     */
    renderAtTime(timeSeconds) {
        const frame = Math.round(timeSeconds * this.fps);
        this.renderFrame(frame);
    }

    /**
     * Core render method. Composites all active layers for the given frame.
     * This is THE single entry point for both preview and export.
     */
    renderFrame(frame) {
        if (!this._initialized || !this.gl || !this.sceneGraph) return;
        const gl = this.gl;
        this._currentFrame = frame;

        gl.viewport(0, 0, this.width, this.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // 1. Get active scenes at this frame
        const activeScenes = this.sceneGraph.getActiveScenesAtFrame(frame);

        // 2. Check for transitions
        const transition = this.sceneGraph.getTransitionAtFrame(frame);

        // 3. Render scenes
        if (transition && transition.sceneA && transition.sceneB) {
            // Transition active: need textures from both scenes
            const texA = this._getSceneTexture(transition.sceneA, frame);
            const texB = this._getSceneTexture(transition.sceneB, frame);

            if (texA && texB) {
                this.transitionRenderer.render(
                    texA.texture, texB.texture,
                    transition.progress, transition.type,
                    () => this._drawQuad()
                );
            } else {
                // Fallback: render whichever is available
                this._renderSceneTexture(texA || texB, 1.0);
            }

            // Also render non-transitioning scenes on other tracks
            for (const { scene, trackNum } of activeScenes) {
                if (scene.index === transition.sceneA.index || scene.index === transition.sceneB.index) continue;
                const tex = this._getSceneTexture(scene, frame);
                if (tex) {
                    gl.enable(gl.BLEND);
                    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                    this._renderSceneTexture(tex, 1.0, scene);
                    gl.disable(gl.BLEND);
                }
            }
        } else {
            // No transition: render each scene by track order
            for (let i = 0; i < activeScenes.length; i++) {
                const { scene, trackNum } = activeScenes[i];

                // Handle fullscreen MG scenes (isMGScene on track-3)
                if (scene.isMGScene || scene.mediaType === 'motion-graphic') {
                    // Render the MG as a fullscreen graphic
                    const localFrame = frame - scene._startFrame;
                    const mgTex = this.mgRenderer.renderMG(scene, localFrame, this._scriptContext);
                    if (mgTex) {
                        if (i > 0) {
                            gl.enable(gl.BLEND);
                            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                        }
                        this._blitTexture(mgTex.texture, 1.0, 1, 1, 0, 0);
                        if (i > 0) gl.disable(gl.BLEND);
                    }
                    continue;
                }

                const tex = this._getSceneTexture(scene, frame);
                if (!tex) continue;

                if (i === 0) {
                    // First track: opaque blit (base layer)
                    this._renderSceneTexture(tex, 1.0, scene);
                } else {
                    // Upper tracks: alpha blend
                    gl.enable(gl.BLEND);
                    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                    this._renderSceneTexture(tex, 1.0, scene);
                    gl.disable(gl.BLEND);
                }
            }
        }

        // 4. Render overlay motion graphics
        const activeMGs = this.sceneGraph.getActiveMGsAtFrame(frame);
        if (activeMGs.length > 0) {
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

            for (const { mg, localFrame } of activeMGs) {
                const mgTex = this.mgRenderer.renderMG(mg, localFrame, this._scriptContext);
                if (mgTex) {
                    this._blitTexture(mgTex.texture, 1.0, 1, 1, 0, 0);
                }
            }

            gl.disable(gl.BLEND);
        }
    }

    // ========================================================================
    // TEXTURE & BLIT HELPERS
    // ========================================================================

    /**
     * Get/update the texture for a scene at the given frame.
     * For videos: uploads the current video frame as a texture.
     * For images: uses cached texture (or creates one).
     */
    _getSceneTexture(scene, frame) {
        const idx = scene.index;
        const el = this._videoElements[idx];
        if (!el) return null;

        const texId = `scene-${idx}`;

        if (el instanceof HTMLVideoElement) {
            // Sync video time for preview mode
            if (!this._exporting && el.readyState >= 2) {
                const localTime = (frame - scene._startFrame) / this.fps;
                const mediaOffset = scene.mediaOffset || 0;
                const targetTime = localTime + mediaOffset;
                // Only seek if drift is significant (avoid constant seeks)
                if (Math.abs(el.currentTime - targetTime) > 0.1) {
                    el.currentTime = targetTime;
                }
            }
            return this.textureManager.createOrUpdate(texId, el);
        } else if (el instanceof HTMLImageElement) {
            if (el.naturalWidth > 0) {
                return this.textureManager.createOrUpdate(texId, el);
            }
        }

        return this.textureManager.get(texId);
    }

    /**
     * Render a scene texture with fit-mode transform (cover/contain + scale/offset).
     */
    _renderSceneTexture(texEntry, opacity, scene) {
        if (!texEntry || !texEntry.texture) return;

        // Compute fit-mode transform
        let scaleX = 1, scaleY = 1, offsetX = 0, offsetY = 0;

        if (scene) {
            const srcAspect = texEntry.width / texEntry.height;
            const dstAspect = this.width / this.height;
            const fitMode = scene.fitMode || 'cover';

            if (fitMode === 'cover') {
                if (srcAspect > dstAspect) {
                    // Source wider than dest: scale Y to fill, X crops
                    scaleX = dstAspect / srcAspect;
                } else {
                    // Source taller than dest: scale X to fill, Y crops
                    scaleY = srcAspect / dstAspect;
                }
            } else if (fitMode === 'contain') {
                if (srcAspect > dstAspect) {
                    scaleY = srcAspect / dstAspect;
                } else {
                    scaleX = dstAspect / srcAspect;
                }
            }

            // Apply user scale
            const userScale = scene.scale || 1;
            scaleX *= userScale;
            scaleY *= userScale;

            // Apply position offset (posX/posY are percentages)
            offsetX = (scene.posX || 0) / 100;
            offsetY = (scene.posY || 0) / 100;
        }

        this._blitTexture(texEntry.texture, opacity, scaleX, scaleY, offsetX, offsetY);
    }

    /**
     * Blit a texture to the current framebuffer with transform and opacity.
     */
    _blitTexture(texture, opacity, scaleX, scaleY, offsetX, offsetY) {
        this._blitProgram.use();
        this._blitProgram.setTexture('u_texture', 0, texture);
        this._blitProgram.set1f('u_opacity', opacity);
        this._blitProgram.set4f('u_transform', scaleX, scaleY, offsetX, offsetY);
        this._drawQuad();
    }

    /**
     * Draw the fullscreen quad.
     */
    _drawQuad() {
        const gl = this.gl;
        gl.bindVertexArray(this._quadVAO);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
    }

    /**
     * Create a VAO with a fullscreen quad (2 triangles as a triangle strip).
     */
    _createQuadVAO(gl) {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);

        const positions = new Float32Array([
            -1, -1,  // bottom-left
             1, -1,  // bottom-right
            -1,  1,  // top-left
             1,  1,  // top-right
        ]);

        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);

        // a_position is at location 0 (set in vertex shader)
        const posLoc = gl.getAttribLocation(this._blitProgram.program, 'a_position');
        gl.enableVertexAttribArray(posLoc);
        gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

        gl.bindVertexArray(null);
        return vao;
    }

    // ========================================================================
    // EXPORT HELPERS
    // ========================================================================

    /**
     * Read pixels from the current framebuffer as a Uint8Array (RGBA).
     * Flips vertically (WebGL is bottom-up, video is top-down).
     */
    readPixels() {
        const gl = this.gl;
        const w = this.width;
        const h = this.height;
        const size = w * h * 4;

        if (!this._flipBuf || this._flipBuf.length !== size) {
            this._flipBuf = new Uint8Array(size);
        }

        const pixels = new Uint8Array(size);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        // Flip vertically (swap rows)
        const rowSize = w * 4;
        for (let y = 0; y < h; y++) {
            const srcOffset = y * rowSize;
            const dstOffset = (h - 1 - y) * rowSize;
            this._flipBuf.set(pixels.subarray(srcOffset, srcOffset + rowSize), dstOffset);
        }

        return this._flipBuf;
    }

    /**
     * Compute a fast hash of the current framebuffer for WYSIWYG validation.
     * Uses FNV-1a sampling (every 64th byte for speed).
     */
    computeFrameHash() {
        const gl = this.gl;
        const pixels = new Uint8Array(this.width * this.height * 4);
        gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        let hash = 2166136261; // FNV offset basis
        for (let i = 0; i < pixels.length; i += 64) {
            hash ^= pixels[i];
            hash = Math.imul(hash, 16777619); // FNV prime
        }
        return (hash >>> 0).toString(16).padStart(8, '0');
    }

    // ========================================================================
    // VIDEO PLAYBACK CONTROL (for preview mode)
    // ========================================================================

    /**
     * Start playing all active video elements (for preview).
     */
    playVideos(currentTimeSeconds) {
        for (const scene of (this.sceneGraph ? this.sceneGraph.scenes : [])) {
            const vid = this._videoElements[scene.index];
            if (!(vid instanceof HTMLVideoElement)) continue;

            const sceneStart = scene._startFrame / this.fps;
            const sceneEnd = scene._endFrame / this.fps;

            if (currentTimeSeconds >= sceneStart && currentTimeSeconds < sceneEnd) {
                const localTime = currentTimeSeconds - sceneStart + (scene.mediaOffset || 0);
                vid.currentTime = localTime;
                vid.play().catch(() => {});
            }
        }
    }

    /**
     * Pause all video elements.
     */
    pauseVideos() {
        for (const key of Object.keys(this._videoElements)) {
            const el = this._videoElements[key];
            if (el instanceof HTMLVideoElement) {
                el.pause();
            }
        }
    }

    /**
     * Seek a video element to a specific frame (for export mode).
     * Returns a promise that resolves when the seek is complete.
     */
    async seekVideoToFrame(sceneIndex, frame) {
        const vid = this._videoElements[sceneIndex];
        if (!(vid instanceof HTMLVideoElement) || vid.readyState < 2) return;

        const targetTime = frame / this.fps;
        vid.currentTime = targetTime;

        await new Promise((resolve) => {
            const onSeeked = () => {
                vid.removeEventListener('seeked', onSeeked);
                resolve();
            };
            vid.addEventListener('seeked', onSeeked);
            // Timeout fallback in case seeked never fires
            setTimeout(resolve, 200);
        });
    }

    // ========================================================================
    // GETTERS
    // ========================================================================

    get currentFrame() { return this._currentFrame; }
    get totalFrames() { return this.sceneGraph ? this.sceneGraph.totalFrames : 0; }
    get isExporting() { return this._exporting; }
    get isInitialized() { return this._initialized; }
}

window.Compositor = Compositor;
