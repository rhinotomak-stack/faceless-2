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
        // Media file resolver (async: absolutePath -> url) for overlay scenes with mediaFile
        this._mediaFileResolver = null;
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

        // EXPORT-ONLY: WebCodecs VideoFrame overrides for optimized export.
        // - null during preview (default) — _getSceneTexture ignores it
        // - Set to Map<sceneIndex, VideoFrame> ONLY by ExportPipeline._runOptimizedFrameLoop()
        // - Guarded by this._exporting in _getSceneTexture (never checked in preview)
        // - Cleared to null by _resetVideosForPreview() and ExportPipeline finally block
        this._exportFrameSources = null;

        // PBO async readback (export-only, initialized by initPBOs)
        this._pbos = null;           // Array of WebGLBuffer
        this._pboCount = 4;
        this._pboWriteIndex = 0;     // next PBO to write into
        this._pboFrameBytes = 0;     // w * h * 4
        this._pboReady = false;

        // Preview resolution scaling (0.5 = half-res for performance)
        this._previewScale = 0.5;

    }

    // ========================================================================
    // LIFECYCLE
    // ========================================================================

    /**
     * Initialize WebGL2 context, compile shaders, allocate buffers.
     */
    init() {
        if (this._initialized) return;

        // Use preview resolution for canvas (CSS scales it up)
        const rw = this._renderWidth();
        const rh = this._renderHeight();
        this.canvas.width = rw;
        this.canvas.height = rh;

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

        // Compile blit shaders
        const { QUAD_VERT, BLIT_FRAG, BLUR_BLIT_FRAG, ShaderProgram } = window.ShaderLib;
        this._blitProgram = new ShaderProgram(gl, QUAD_VERT, BLIT_FRAG);
        this._blurBlitProgram = new ShaderProgram(gl, QUAD_VERT, BLUR_BLIT_FRAG);

        // Gradient background cache: gradientId → WebGL texture
        this._gradientCache = {};
        this._gradientCanvas = document.createElement('canvas');
        this._gradientCanvas.width = this.width;
        this._gradientCanvas.height = this.height;
        this._gradientCtx = this._gradientCanvas.getContext('2d');

        // Create fullscreen quad VAO
        this._quadVAO = this._createQuadVAO(gl);

        // Sub-components
        this.textureManager = new TextureManager(gl);
        this.mgRenderer = new MGRenderer(this.textureManager, this.fps);
        this.mgRenderer.setPreviewScale(this._previewScale);
        this.transitionRenderer = new TransitionRenderer(gl);
        this.transitionRenderer.init();

        // Transition FBOs — offscreen render targets for scene-A and scene-B
        this._transitionFBOs = [
            this._createFBO(gl, rw, rh),
            this._createFBO(gl, rw, rh),
        ];

        this._initialized = true;
        console.log('[Compositor] Initialized WebGL2 engine', rw, 'x', rh, `(preview scale ${this._previewScale})`, '@', this.fps, 'fps');
    }

    /**
     * Destroy all GPU resources and video elements.
     */
    destroy() {
        if (this.textureManager) this.textureManager.releaseAll();
        if (this.transitionRenderer) this.transitionRenderer.destroy();
        if (this._blitProgram) this._blitProgram.destroy();
        if (this._blurBlitProgram) this._blurBlitProgram.destroy();
        // Clean up gradient textures
        if (this._gradientCache && this.gl) {
            for (const tex of Object.values(this._gradientCache)) {
                this.gl.deleteTexture(tex);
            }
            this._gradientCache = {};
        }
        if (this._quadVAO && this.gl) {
            this.gl.deleteVertexArray(this._quadVAO);
        }
        // Clean up transition FBOs
        if (this._transitionFBOs && this.gl) {
            for (const fbo of this._transitionFBOs) {
                this.gl.deleteFramebuffer(fbo.fbo);
                this.gl.deleteTexture(fbo.texture);
            }
            this._transitionFBOs = null;
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

        this.destroyPBOs();

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
    async loadPlan(plan, urlResolver, mediaFileResolver) {
        if (!this._initialized) this.init();

        this._urlResolver = urlResolver;
        this._mediaFileResolver = mediaFileResolver || null;
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
        // Release old elements (remove from DOM too)
        for (const key of Object.keys(this._videoElements)) {
            const el = this._videoElements[key];
            if (el instanceof HTMLVideoElement) {
                el.pause();
                el.src = '';
                el.load();
                if (el.parentNode) el.parentNode.removeChild(el);
            }
        }
        this._videoElements = {};
        this._mediaUrls = {};

        // First pass: resolve all URLs in parallel
        // Use track-aware keys to avoid collisions when V1 and V2 scenes share the same index
        const urlMap = {};
        const urlPromises = scenes.map(async (scene) => {
            const idx = scene.index;
            if (idx == null) return;
            const key = this._sceneKey(scene);
            const ext = scene.mediaExtension || '.mp4';
            // Use mediaFile directly for compositor overlays (their filenames don't match index pattern)
            let url = null;
            if (scene.mediaFile && this._mediaFileResolver) {
                url = await this._mediaFileResolver(scene.mediaFile);
            }
            if (!url) {
                url = await this._resolveUrl(idx, ext);
            }
            if (url) urlMap[key] = { url, ext, idx };
        });
        await Promise.all(urlPromises);

        // Second pass: create elements and wait for load
        // Load images in parallel (lightweight), but batch videos to avoid
        // overwhelming browser with too many simultaneous video loads
        const imagePromises = [];
        const videoScenes = [];

        for (const scene of scenes) {
            const idx = scene.index;
            if (idx == null) continue;
            const key = this._sceneKey(scene);
            if (!urlMap[key]) continue;
            const { url, ext } = urlMap[key];
            const isImage = scene.mediaType === 'image' || /\.(jpg|jpeg|png|webp|gif)$/i.test(ext);

            this._mediaUrls[key] = url;

            if (isImage) {
                const img = new Image();
                img.crossOrigin = 'anonymous';
                this._videoElements[key] = img;
                imagePromises.push(new Promise(resolve => {
                    img.onload = resolve;
                    img.onerror = () => { console.warn(`[Compositor] Failed to load image for scene ${key}`); resolve(); };
                    img.src = url;
                    setTimeout(resolve, 5000);
                }));
            } else {
                videoScenes.push({ scene, url, key });
            }
        }

        // Create all video elements upfront so they start loading in parallel
        for (const { scene, url, key } of videoScenes) {
            const video = document.createElement('video');
            video.muted = true;
            video.preload = 'auto';
            video.playsInline = true;
            video.crossOrigin = 'anonymous';
            video.style.display = 'none';
            document.body.appendChild(video);
            this._videoElements[key] = video;
            video.src = url;
        }

        // Wait for all videos to reach canplaythrough (fully buffered for local files)
        const videoPromises = videoScenes.map(({ key }) => {
            const video = this._videoElements[key];
            return new Promise(resolve => {
                if (video.readyState >= 3) { resolve(); return; } // HAVE_FUTURE_DATA or better
                let resolved = false;
                const done = () => {
                    if (resolved) return;
                    resolved = true;
                    video.removeEventListener('canplaythrough', onReady);
                    video.removeEventListener('loadeddata', onFallback);
                    video.removeEventListener('error', onError);
                    clearTimeout(timer);
                    resolve();
                };
                const onReady = () => done();
                const onFallback = () => {
                    // canplaythrough might not fire for some codecs, accept loadeddata after a delay
                    setTimeout(done, 500);
                };
                const onError = () => {
                    console.warn(`[Compositor] Failed to load video for scene ${key}`);
                    done();
                };
                video.addEventListener('canplaythrough', onReady);
                video.addEventListener('loadeddata', onFallback);
                video.addEventListener('error', onError);
                const timer = setTimeout(() => {
                    console.warn(`[Compositor] Timeout loading video for scene ${key} (readyState=${video.readyState})`);
                    done();
                }, 20000);
            });
        });

        // Wait for all images and videos
        await Promise.all([...imagePromises, ...videoPromises]);
        console.log(`[Compositor] Preloaded ${imagePromises.length} images and ${videoScenes.length} videos`);
    }

    /**
     * Generate a unique key for a scene across tracks.
     * Prevents V1 and V2 scenes with the same index from colliding.
     */
    _sceneKey(scene) {
        const track = scene.trackId || 'video-track-1';
        return `${track}-${scene.index}`;
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
    // SLIDE ANIMATION FOR UPPER-TRACK OVERLAYS
    // ========================================================================

    /**
     * Apply slide-in/out animation to an upper-track scene.
     * Modifies posX/posY on the scene object (should be a shallow copy).
     * Slides from off-screen to final position with ease-out, reverses on exit.
     */
    _applySlideAnimation(scene, frame) {
        // Skip if animation explicitly disabled
        if (scene.slideAnimation === false) return;

        const slideDuration = scene.slideDuration || 0.4; // seconds
        const slideFrames = Math.round(slideDuration * this.fps);
        if (slideFrames < 1) return;

        const localFrame = frame - scene._startFrame;
        const totalFrames = scene._endFrame - scene._startFrame;
        const outFrame = totalFrames - localFrame;

        let t = 1; // 1 = fully visible at target position
        if (localFrame < slideFrames) {
            // Slide in
            t = localFrame / slideFrames;
            t = 1 - Math.pow(1 - t, 3); // ease-out cubic
        } else if (outFrame < slideFrames) {
            // Slide out
            t = outFrame / slideFrames;
            t = 1 - Math.pow(1 - t, 3); // ease-out cubic
        }

        if (t >= 0.999) return; // No animation needed, fully at target

        // Determine slide direction
        const posX = scene.posX || 0;
        const posY = scene.posY || 0;
        const scaleVal = Math.max(scene.scale || 1, 0.05);
        // Off-screen offset: enough to push fully out regardless of scale
        // For compositor overlays using viewport rendering, 100% is enough to push off-screen
        const offAmount = scene._compositorDirective ? 120 : (120 / scaleVal);

        // Use explicit direction if set, otherwise auto-detect from position
        const dir = scene.slideDirection || 'auto';

        if (dir === 'right') {
            scene.posX = posX + (1 - t) * offAmount;
        } else if (dir === 'left') {
            scene.posX = posX - (1 - t) * offAmount;
        } else if (dir === 'top') {
            scene.posY = posY - (1 - t) * offAmount;
        } else if (dir === 'bottom') {
            scene.posY = posY + (1 - t) * offAmount;
        } else {
            // Auto: pick direction from nearest edge
            if (Math.abs(posX) > 5) {
                const autoDir = posX >= 0 ? 1 : -1;
                scene.posX = posX + (1 - t) * offAmount * autoDir;
            } else if (posY > 10) {
                scene.posY = posY + (1 - t) * offAmount;
            } else if (posY < -10) {
                scene.posY = posY - (1 - t) * offAmount;
            } else {
                scene.posX = posX + (1 - t) * offAmount;
            }
        }
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

        const rw = this._renderWidth();
        const rh = this._renderHeight();
        gl.viewport(0, 0, rw, rh);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // 1. Get active scenes at this frame
        const activeScenes = this.sceneGraph.getActiveScenesAtFrame(frame);

        // 2. Check for transitions
        const transition = this.sceneGraph.getTransitionAtFrame(frame);

        // 3. Render scenes
        if (transition && transition.sceneA && transition.sceneB) {
            // Transition active: render each scene with full transforms to FBOs,
            // then transition between the composited FBO textures.
            const fboTexA = this._renderSceneToFBO(this._transitionFBOs[0], transition.sceneA, frame);
            const fboTexB = this._renderSceneToFBO(this._transitionFBOs[1], transition.sceneB, frame);

            if (fboTexA && fboTexB) {
                this.transitionRenderer.render(
                    fboTexA, fboTexB,
                    transition.progress, transition.type,
                    () => this._drawQuad()
                );
            } else {
                // Fallback: render whichever is available
                const fallbackScene = fboTexA ? transition.sceneA : transition.sceneB;
                const fallbackTex = this._getSceneTexture(fallbackScene, frame);
                if (fallbackTex) this._renderSceneTexture(fallbackTex, 1.0, fallbackScene);
            }

            // Also render non-transitioning scenes on other tracks
            for (const { scene, trackNum } of activeScenes) {
                if (scene.index === transition.sceneA.index || scene.index === transition.sceneB.index) continue;
                const tex = this._getSceneTexture(scene, frame);
                if (tex) {
                    gl.enable(gl.BLEND);
                    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                    if (scene._compositorDirective) {
                        const overlayScene = Object.assign({}, scene, { background: 'none' });
                        this._applySlideAnimation(overlayScene, frame);
                        this._renderOverlayTexture(tex, 1.0, overlayScene);
                    } else {
                        this._renderSceneTexture(tex, 1.0, scene);
                    }
                    gl.disable(gl.BLEND);
                }
            }
        } else {
            // No transition: render each scene by track order
            for (let i = 0; i < activeScenes.length; i++) {
                const { scene, trackNum } = activeScenes[i];

                // Handle fullscreen MG scenes (isMGScene on track-3)
                if (scene.isMGScene || scene.mediaType === 'motion-graphic') {
                    const localFrame = frame - scene._startFrame;
                    const mgTex = this._getMGTexture(scene, localFrame, this._scriptContext);
                    if (mgTex) {
                        if (i > 0) {
                            gl.enable(gl.BLEND);
                            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                        }
                        const bp = this._mgBlitParams(mgTex);
                        this._blitTexture(mgTex.texture, 1.0, bp.sx, bp.sy, bp.ox, bp.oy);
                        if (i > 0) gl.disable(gl.BLEND);
                    }
                    continue;
                }

                const tex = this._getSceneTexture(scene, frame);
                if (!tex) continue;

                if (i === 0) {
                    // First track: opaque blit (base layer)
                    // Check if any upper-track scene has bgBlur → dim base layer
                    const upperWithBlur = activeScenes.find(a => a.trackNum > 1 && a.scene.bgBlur && a.scene.bgBlur !== 'none');
                    if (upperWithBlur) {
                        const dimMap = { light: 0.85, medium: 0.7, heavy: 0.55 };
                        const dimAlpha = dimMap[upperWithBlur.scene.bgBlur] || 1.0;
                        this._renderSceneTexture(tex, dimAlpha, scene);
                    } else {
                        this._renderSceneTexture(tex, 1.0, scene);
                    }
                } else if (scene._compositorDirective) {
                    // Compositor overlay: render as a floating image using viewport
                    gl.enable(gl.BLEND);
                    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                    const overlayScene = Object.assign({}, scene, { background: 'none' });
                    this._applySlideAnimation(overlayScene, frame);
                    this._renderOverlayTexture(tex, 1.0, overlayScene);
                    gl.disable(gl.BLEND);
                } else {
                    // Upper tracks (non-overlay): alpha blend, slide animation
                    gl.enable(gl.BLEND);
                    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
                    const upperScene = Object.assign({}, scene, { background: 'none' });
                    this._applySlideAnimation(upperScene, frame);
                    this._renderSceneTexture(tex, 1.0, upperScene);
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
                const mgTex = this._getMGTexture(mg, localFrame, this._scriptContext);
                if (mgTex) {
                    const bp = this._mgBlitParams(mgTex);
                    this._blitTexture(mgTex.texture, 1.0, bp.sx, bp.sy, bp.ox, bp.oy);
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
        const key = this._sceneKey(scene);
        const texId = `scene-${key}`;

        // EXPORT-ONLY: use WebCodecs VideoFrame if provided by optimized export loop
        if (this._exporting && this._exportFrameSources && this._exportFrameSources.has(idx)) {
            const vf = this._exportFrameSources.get(idx);
            if (vf) return this.textureManager.createOrUpdate(texId, vf);
        }

        const el = this._videoElements[key];
        if (!el) return null;

        if (el instanceof HTMLVideoElement) {
            // Sync video time for preview mode
            if (!this._exporting && el.readyState >= 2) {
                const localTime = (frame - scene._startFrame) / this.fps;
                const mediaOffset = scene.mediaOffset || 0;
                // Clamp to valid range (during transitions, frame may be outside scene bounds)
                const targetTime = Math.max(0, localTime + mediaOffset);
                // Only seek if drift is significant (avoid constant seeks)
                if (Math.abs(el.currentTime - targetTime) > 0.1) {
                    el.currentTime = Math.min(targetTime, el.duration || targetTime);
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

    // ========================================================================
    // BAKE-AND-PLAY: MG TEXTURE FROM PRE-RENDERED CACHE
    // ========================================================================

    /**
     * Get MG texture — live Canvas2D rendering. FULLY SYNCHRONOUS.
     * Called from renderFrame() hot path.
     */
    _getMGTexture(mg, localFrame, scriptContext) {
        const result = this.mgRenderer.renderMG(mg, localFrame, scriptContext);
        if (result) result._tile = null;
        return result;
    }

    /**
     * Render a scene texture with fit-mode transform (cover/contain + scale/offset).
     */
    _renderSceneTexture(texEntry, opacity, scene) {
        if (!texEntry || !texEntry.texture) return;

        const srcAspect = texEntry.width / texEntry.height;
        const dstAspect = this.width / this.height;

        // Compute fit-mode transform
        let scaleX = 1, scaleY = 1, offsetX = 0, offsetY = 0;
        const fitMode = scene ? (scene.fitMode || 'cover') : 'cover';

        if (scene) {
            if (fitMode === 'cover') {
                if (srcAspect > dstAspect) {
                    scaleX = srcAspect / dstAspect;
                } else {
                    scaleY = dstAspect / srcAspect;
                }
            } else if (fitMode === 'contain') {
                if (srcAspect > dstAspect) {
                    scaleY = dstAspect / srcAspect;
                } else {
                    scaleX = srcAspect / dstAspect;
                }
            }

            // Apply user scale
            const userScale = scene.scale || 1;
            scaleX *= userScale;
            scaleY *= userScale;

            // Apply position offset (posX/posY are percentages)
            offsetX = (scene.posX || 0) / 100;
            offsetY = (scene.posY || 0) / 100;

            // Ken Burns animation for images (skip compositor overlays — they have slide animation)
            if (scene.mediaType === 'image' && scene.kenBurnsEnabled !== false && !scene._compositorDirective) {
                const kb = this._computeKenBurns(scene);
                scaleX *= kb.scale;
                scaleY *= kb.scale;
                offsetX += kb.translateX / 100;
                offsetY += kb.translateY / 100;
            }
        }

        // Background rendering
        const bg = scene ? (scene.background || 'none') : 'none';
        const needsBgLayer = bg !== 'none';

        if (needsBgLayer) {
            const gl = this.gl;
            if (bg === 'blur') {
                // Blur: render blurred cover-fill behind the video
                let bgSx = 1, bgSy = 1;
                if (srcAspect > dstAspect) {
                    bgSx = srcAspect / dstAspect;
                } else {
                    bgSy = dstAspect / srcAspect;
                }
                this._blurBlitProgram.use();
                this._blurBlitProgram.setTexture('u_texture', 0, texEntry.texture);
                this._blurBlitProgram.set1f('u_opacity', opacity);
                this._blurBlitProgram.set4f('u_transform', bgSx, bgSy, 0, 0);
                this._blurBlitProgram.set2f('u_texelSize', 1.0 / texEntry.width, 1.0 / texEntry.height);
                this._drawQuad();
            } else if (bg.startsWith('gradient:')) {
                // Gradient: render CSS gradient from cache
                const gradTex = this._getGradientTexture(bg);
                if (gradTex) {
                    this._blitTexture(gradTex, opacity, 1, 1, 0, 0, null);
                }
            }
            // Draw the video on top with blending
            gl.enable(gl.BLEND);
            gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            this._blitTexture(texEntry.texture, opacity, scaleX, scaleY, offsetX, offsetY, scene);
            gl.disable(gl.BLEND);
        } else {
            this._blitTexture(texEntry.texture, opacity, scaleX, scaleY, offsetX, offsetY, scene);
        }
    }

    /**
     * Render a compositor overlay image using gl.viewport for true screen-space positioning.
     * Unlike _renderSceneTexture (which uses UV manipulation for cover/contain),
     * this renders the image at actual pixel size/position — like a floating panel.
     */
    _renderOverlayTexture(texEntry, opacity, scene) {
        if (!texEntry || !texEntry.texture) return;
        const gl = this.gl;
        const rw = this._renderWidth();
        const rh = this._renderHeight();

        const overlayScale = scene.scale || 0.45;
        const srcAspect = texEntry.width / texEntry.height;

        // Compute overlay size in pixels (contain: fit within overlayScale portion of canvas)
        let imgW, imgH;
        const maxW = rw * overlayScale;
        const maxH = rh * overlayScale;
        if (srcAspect > maxW / maxH) {
            imgW = maxW;
            imgH = maxW / srcAspect;
        } else {
            imgH = maxH;
            imgW = maxH * srcAspect;
        }

        // Position: posX/posY are percentages (-50 to 50), center = 0
        // posY: negative = up (toward top), positive = down (toward bottom) in app space
        const posXPct = (scene.posX || 0) / 100;
        const posYPct = (scene.posY || 0) / 100;
        const cx = rw / 2 + posXPct * rw;
        const cy = rh / 2 + posYPct * rh;  // cy in top-down app space
        const vpX = Math.round(cx - imgW / 2);
        // GL viewport Y=0 is bottom of screen, so invert Y
        const vpY = Math.round(rh - cy - imgH / 2);

        // Set viewport to overlay region
        gl.viewport(vpX, vpY, Math.round(imgW), Math.round(imgH));

        // Render with identity transform (image fills the viewport exactly)
        this._blitTexture(texEntry.texture, opacity, 1, 1, 0, 0, scene);

        // Restore full viewport
        gl.viewport(0, 0, rw, rh);
    }

    /**
     * Get or create a WebGL texture for a CSS gradient background.
     * Renders the gradient to an offscreen canvas and uploads once, cached by ID.
     */
    _getGradientTexture(bgValue) {
        // bgValue is "gradient:<id>"
        if (this._gradientCache[bgValue]) return this._gradientCache[bgValue];

        const gradientId = bgValue.replace('gradient:', '');
        // Access the global GRADIENT_BACKGROUNDS map (defined in app.js)
        const cssGradient = window.GRADIENT_BACKGROUNDS?.[gradientId];
        if (!cssGradient) return null;

        const gl = this.gl;
        const canvas = this._gradientCanvas;
        const ctx = this._gradientCtx;

        // Render CSS gradient via a temporary div measured by the browser
        // Canvas2D doesn't support CSS gradients directly, so we use a workaround:
        // draw a filled rect with the gradient applied via a temp element
        const tmpDiv = document.createElement('div');
        tmpDiv.style.cssText = `position:fixed;left:-9999px;top:-9999px;width:${canvas.width}px;height:${canvas.height}px;background:${cssGradient};`;
        document.body.appendChild(tmpDiv);

        // Use html2canvas-like approach: draw the div to canvas via foreignObject SVG
        // Simpler: parse common gradient patterns and draw natively
        document.body.removeChild(tmpDiv);

        // Fallback: parse the gradient CSS and draw natively on canvas
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        this._drawCSSGradient(ctx, cssGradient, canvas.width, canvas.height);

        // Upload to WebGL texture
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

        this._gradientCache[bgValue] = tex;
        return tex;
    }

    /**
     * Render a CSS gradient string onto a Canvas2D context.
     * Parses linear-gradient and radial-gradient with angle/position + color stops.
     */
    _drawCSSGradient(ctx, css, w, h) {
        // Handle layered gradients (comma-separated at top level outside parens)
        const layers = this._splitGradientLayers(css);

        // Draw layers back-to-front (last layer is the base)
        for (let i = layers.length - 1; i >= 0; i--) {
            this._drawSingleGradient(ctx, layers[i].trim(), w, h);
        }
    }

    _splitGradientLayers(css) {
        // Split on commas that are followed by a gradient function name
        // e.g. "linear-gradient(...), radial-gradient(...)" → 2 layers
        const layers = [];
        let depth = 0, current = '', pos = 0;
        for (let i = 0; i < css.length; i++) {
            const ch = css[i];
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            if (ch === ',' && depth === 0) {
                const rest = css.substring(i + 1).trim();
                if (rest.match(/^(linear|radial|repeating|conic)-gradient/)) {
                    layers.push(current.trim());
                    current = '';
                    continue;
                }
            }
            current += ch;
        }
        if (current.trim()) layers.push(current.trim());
        return layers;
    }

    _drawSingleGradient(ctx, css, w, h) {
        // Parse color stops from inside the gradient function
        const innerMatch = css.match(/gradient\((.+)\)$/s);
        if (!innerMatch) {
            ctx.fillStyle = '#0a0a0a';
            ctx.fillRect(0, 0, w, h);
            return;
        }

        const inner = innerMatch[1];

        if (css.startsWith('linear-gradient') || css.startsWith('repeating-linear-gradient')) {
            const repeating = css.startsWith('repeating');
            // Extract angle (default 180deg = top to bottom)
            const angleMatch = inner.match(/^\s*(\d+)deg\s*,\s*/);
            let angle = 180;
            let stopsStr = inner;
            if (angleMatch) {
                angle = parseFloat(angleMatch[1]);
                stopsStr = inner.substring(angleMatch[0].length);
            }
            const stops = this._parseGradientStops(stopsStr);
            if (stops.length === 0) return;

            const rad = (angle - 90) * Math.PI / 180;
            const dx = Math.cos(rad), dy = Math.sin(rad);
            // Extend gradient line to cover the entire canvas
            const extent = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
            const cx = w / 2, cy = h / 2;
            const grad = ctx.createLinearGradient(
                cx - dx * extent, cy - dy * extent,
                cx + dx * extent, cy + dy * extent
            );
            for (const s of stops) {
                try { grad.addColorStop(Math.min(1, Math.max(0, s.pos)), s.color); } catch (e) { /* skip invalid color */ }
            }
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
        } else if (css.startsWith('radial-gradient') || css.startsWith('repeating-radial-gradient')) {
            // Extract center position
            const posMatch = inner.match(/^\s*ellipse\s+at\s+([\d.]+)%\s+([\d.]+)%\s*,\s*/);
            let cx = w / 2, cy = h / 2;
            let stopsStr = inner;
            if (posMatch) {
                cx = (parseFloat(posMatch[1]) / 100) * w;
                cy = (parseFloat(posMatch[2]) / 100) * h;
                stopsStr = inner.substring(posMatch[0].length);
            }
            const stops = this._parseGradientStops(stopsStr);
            if (stops.length === 0) return;

            const radius = Math.sqrt(w * w + h * h) / 2 * 1.2;
            const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
            for (const s of stops) {
                try { grad.addColorStop(Math.min(1, Math.max(0, s.pos)), s.color); } catch (e) { /* skip invalid color */ }
            }
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, w, h);
        } else {
            ctx.fillStyle = '#0a0a0a';
            ctx.fillRect(0, 0, w, h);
        }
    }

    /**
     * Parse CSS gradient color stops like "#color1 0%, #color2 50%, #color3 100%"
     * Also handles pixel stops (e.g. "transparent 49px") by normalizing to fractions.
     */
    _parseGradientStops(stopsStr) {
        const stops = [];
        const parts = [];
        let depth = 0, current = '';
        for (const ch of stopsStr) {
            if (ch === '(') depth++;
            else if (ch === ')') depth--;
            if (ch === ',' && depth === 0) {
                parts.push(current.trim());
                current = '';
            } else {
                current += ch;
            }
        }
        if (current.trim()) parts.push(current.trim());

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i].trim();
            // Match color + percentage
            const mPct = part.match(/^(.+?)\s+([\d.]+)%\s*$/);
            if (mPct) {
                stops.push({ color: mPct[1].trim(), pos: parseFloat(mPct[2]) / 100 });
                continue;
            }
            // Match color + pixel value (normalize to 0-1 assuming 1920px width)
            const mPx = part.match(/^(.+?)\s+([\d.]+)px\s*$/);
            if (mPx) {
                stops.push({ color: mPx[1].trim(), pos: parseFloat(mPx[2]) / 1920 });
                continue;
            }
            // No position: distribute evenly
            stops.push({ color: part, pos: i / Math.max(1, parts.length - 1) });
        }
        return stops;
    }

    /**
     * Compute blit params (scaleX, scaleY, offsetX, offsetY) from MG tile metadata.
     * If tile covers the full canvas (tileW==canvasW, tileH==canvasH), returns identity (1,1,0,0).
     * For sub-tiles, computes UV scale/offset to position the tile correctly.
     */
    _mgBlitParams(mgTex) {
        if (!mgTex._tile || (mgTex._tile.w === this.width && mgTex._tile.h === this.height && mgTex._tile.x === 0 && mgTex._tile.y === 0)) {
            return { sx: 1, sy: 1, ox: 0, oy: 0 };
        }
        const t = mgTex._tile;
        // Tile covers a sub-region of the canvas. The blit shader maps UVs as:
        //   uv = (v_texCoord - 0.5) / scale + 0.5 - offset
        // To place the tile at (tileX, tileY) with size (tileW, tileH) on canvas (W, H):
        //   scaleX = tileW / canvasW, scaleY = tileH / canvasH
        //   offsetX = (tileX / canvasW) + (tileW / canvasW) / 2 - 0.5
        //   offsetY = (tileY / canvasH) + (tileH / canvasH) / 2 - 0.5
        const sx = t.w / this.width;
        const sy = t.h / this.height;
        const ox = (t.x / this.width) + sx / 2 - 0.5;
        const oy = (t.y / this.height) + sy / 2 - 0.5;
        return { sx, sy, ox, oy };
    }

    /**
     * Blit a texture to the current framebuffer with transform and opacity.
     */
    _blitTexture(texture, opacity, scaleX, scaleY, offsetX, offsetY, scene) {
        this._blitProgram.use();
        this._blitProgram.setTexture('u_texture', 0, texture);
        this._blitProgram.set1f('u_opacity', opacity);
        this._blitProgram.set4f('u_transform', scaleX, scaleY, offsetX, offsetY);

        // Crop: convert percentages (0-100) to fractions (0-1)
        const cropT = scene ? (scene.cropTop || 0) / 100 : 0;
        const cropR = scene ? (scene.cropRight || 0) / 100 : 0;
        const cropB = scene ? (scene.cropBottom || 0) / 100 : 0;
        const cropL = scene ? (scene.cropLeft || 0) / 100 : 0;
        this._blitProgram.set4f('u_crop', cropT, cropR, cropB, cropL);

        // Border radius: convert percentage (0-100) to fraction (0-1)
        const radius = scene ? (scene.borderRadius || 0) / 100 : 0;
        this._blitProgram.set1f('u_borderRadius', radius);

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
            -1, 1,  // top-left
            1, 1,  // top-right
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

    /**
     * Create a framebuffer object with an attached color texture.
     */
    _createFBO(gl, width, height) {
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        const fbo = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);

        return { fbo, texture, width, height };
    }

    /**
     * Compute Ken Burns scale and translate for a scene at the current frame.
     * Returns { scale, translateX, translateY } where translate is in percentage.
     */
    _computeKenBurns(scene) {
        const none = { scale: 1, translateX: 0, translateY: 0 };
        if (!scene || scene.kenBurnsEnabled === false) return none;

        const originalIndex = scene.index !== undefined ? scene.index : 0;
        const kbTypes = [
            'zoomIn', 'zoomOut',
            'panLeft', 'panRight', 'panUp', 'panDown',
            'zoomPanRight', 'zoomPanLeft',
            'zoomOutPanRight', 'zoomOutPanLeft',
            'driftTopLeftToBottomRight', 'driftBottomRightToTopLeft',
            'driftTopRightToBottomLeft', 'driftBottomLeftToTopRight',
        ];
        const kbType = kbTypes[(originalIndex * 13 + 7) % kbTypes.length];

        const startFrame = scene._startFrame || 0;
        const endFrame = scene._endFrame || startFrame;
        const totalFrames = endFrame - startFrame;
        const kbSpeed = scene.kenBurnsSpeed !== undefined ? scene.kenBurnsSpeed : 1;
        const rawP = totalFrames > 0
            ? Math.max(0, Math.min(1, (this._currentFrame - startFrame) / totalFrames))
            : 0;
        const p = Math.min(1, rawP * kbSpeed);

        const gentle = scene.fitMode === 'contain';
        const s = gentle ? 0.4 : 1;

        let scale = 1, tx = 0, ty = 0;
        switch (kbType) {
            case 'zoomIn':    scale = 1 + (0.03 + p * 0.12) * s; break;
            case 'zoomOut':   scale = 1 + (0.15 - p * 0.12) * s; break;
            case 'panLeft':   scale = 1 + 0.12 * s; tx = (3 - p * 6) * s; break;
            case 'panRight':  scale = 1 + 0.12 * s; tx = (-3 + p * 6) * s; break;
            case 'panUp':     scale = 1 + 0.12 * s; ty = (3 - p * 6) * s; break;
            case 'panDown':   scale = 1 + 0.12 * s; ty = (-3 + p * 6) * s; break;
            case 'zoomPanRight':     scale = 1 + (0.05 + p * 0.1) * s; tx = (-2 + p * 4) * s; break;
            case 'zoomPanLeft':      scale = 1 + (0.05 + p * 0.1) * s; tx = (2 - p * 4) * s; break;
            case 'zoomOutPanRight':  scale = 1 + (0.15 - p * 0.08) * s; tx = (-2 + p * 4) * s; break;
            case 'zoomOutPanLeft':   scale = 1 + (0.15 - p * 0.08) * s; tx = (2 - p * 4) * s; break;
            case 'driftTopLeftToBottomRight':  scale = 1 + 0.15 * s; tx = (-2 + p * 4) * s; ty = (-2 + p * 4) * s; break;
            case 'driftBottomRightToTopLeft':  scale = 1 + 0.15 * s; tx = (2 - p * 4) * s; ty = (2 - p * 4) * s; break;
            case 'driftTopRightToBottomLeft':  scale = 1 + 0.15 * s; tx = (2 - p * 4) * s; ty = (-2 + p * 4) * s; break;
            case 'driftBottomLeftToTopRight':  scale = 1 + 0.15 * s; tx = (-2 + p * 4) * s; ty = (2 - p * 4) * s; break;
        }
        return { scale, translateX: tx, translateY: ty };
    }

    /**
     * Render a scene (with full transform: background, scale, crop, border-radius)
     * to an offscreen FBO, then return the FBO texture.
     */
    _renderSceneToFBO(fboEntry, scene, frame) {
        const gl = this.gl;
        const tex = this._getSceneTexture(scene, frame);
        if (!tex) return null;

        // Bind the FBO and render the scene into it
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboEntry.fbo);
        gl.viewport(0, 0, fboEntry.width, fboEntry.height);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // Use the full scene rendering pipeline (background, transform, crop, etc.)
        this._renderSceneTexture(tex, 1.0, scene);

        // Restore rendering to the screen framebuffer
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this._renderWidth(), this._renderHeight());

        return fboEntry.texture;
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
     * Read pixels directly into a caller-provided Uint8Array (RGBA, top-down).
     * Avoids allocating a new buffer per frame — ideal for ring-buffer export.
     *
     * Reads GL framebuffer into `target`, then flips rows in-place using a
     * single-row temp buffer (~7.5 KB for 1920px width).
     *
     * @param {Uint8Array} target - Pre-allocated buffer, must be width*height*4 bytes
     */
    readPixelsInto(target) {
        const gl = this.gl;
        const w = this.width;
        const h = this.height;
        const rowSize = w * 4;

        // GPU → CPU: one copy directly into the caller's buffer
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, target);

        // In-place vertical flip using a single-row temp buffer
        if (!this._rowBuf || this._rowBuf.length !== rowSize) {
            this._rowBuf = new Uint8Array(rowSize);
        }
        const halfH = h >>> 1;
        for (let y = 0; y < halfH; y++) {
            const top = y * rowSize;
            const bot = (h - 1 - y) * rowSize;
            // swap top row ↔ bottom row via temp
            this._rowBuf.set(target.subarray(top, top + rowSize));
            target.set(target.subarray(bot, bot + rowSize), top);
            target.set(this._rowBuf, bot);
        }
    }

    // ========================================================================
    // PBO ASYNC READBACK (export-only)
    // ========================================================================

    /**
     * Create 3 PBOs for async readback. Call once at export start.
     * @param {number} width
     * @param {number} height
     * @returns {boolean} true if PBOs created successfully
     */
    initPBOs(width, height) {
        const gl = this.gl;
        if (!gl || !(gl instanceof WebGL2RenderingContext)) {
            console.warn('[WebGL Export] initPBOs FAILED: not a WebGL2 context');
            return false;
        }

        const frameBytes = width * height * 4;
        this._pboFrameBytes = frameBytes;
        this._pboCount = 4;
        this._pboWriteIndex = 0;
        this._pbos = [];

        try {
            for (let i = 0; i < this._pboCount; i++) {
                const pbo = gl.createBuffer();
                if (!pbo) throw new Error(`Failed to create PBO ${i}`);
                gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
                gl.bufferData(gl.PIXEL_PACK_BUFFER, frameBytes, gl.STREAM_READ);
                this._pbos.push(pbo);
            }
            gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
            this._pboReady = true;
            console.log(`[WebGL Export] initPBOs SUCCESS: ${this._pboCount} PBOs, bytes=${frameBytes}`);
            return true;
        } catch (err) {
            console.warn(`[WebGL Export] initPBOs FAILED: ${err.message}`);
            this.destroyPBOs();
            return false;
        }
    }

    /**
     * Initiate async readPixels into the current PBO (non-blocking).
     * The GPU begins DMA transfer in the background.
     * @returns {number} PBO index written to, or -1 if not ready
     */
    readPixelsIntoPBO() {
        if (!this._pboReady) return -1;
        const gl = this.gl;
        const idx = this._pboWriteIndex;

        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbos[idx]);
        // When PIXEL_PACK_BUFFER is bound, last param is byte offset into PBO (not a pointer)
        gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, 0);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

        this._pboWriteIndex = (idx + 1) % this._pboCount;
        return idx;
    }

    /**
     * Read back data from a PBO into a CPU buffer + vertical flip.
     * Blocks until DMA is complete (should already be done if 1+ frame has passed).
     * @param {number} pboIndex - Which PBO to read from
     * @param {Uint8Array} target - Pre-allocated buffer from pool
     */
    readBackPBO(pboIndex, target) {
        const gl = this.gl;
        const w = this.width;
        const h = this.height;
        const rowSize = w * 4;

        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this._pbos[pboIndex]);
        gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, target, 0, this._pboFrameBytes);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

        // In-place vertical flip — identical to readPixelsInto
        if (!this._rowBuf || this._rowBuf.length !== rowSize) {
            this._rowBuf = new Uint8Array(rowSize);
        }
        const halfH = h >>> 1;
        for (let y = 0; y < halfH; y++) {
            const top = y * rowSize;
            const bot = (h - 1 - y) * rowSize;
            this._rowBuf.set(target.subarray(top, top + rowSize));
            target.set(target.subarray(bot, bot + rowSize), top);
            target.set(this._rowBuf, bot);
        }
    }

    /**
     * Create a GPU fence after readPixelsIntoPBO to track DMA completion.
     * Call gl.flush() to ensure the fence is submitted to the GPU.
     * @returns {WebGLSync|null} Sync object, or null if not supported
     */
    createFence() {
        const gl = this.gl;
        if (!gl || !gl.fenceSync) return null;
        const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
        gl.flush();
        return sync;
    }

    /**
     * Wait for a GPU fence to be signaled, yielding to the event loop
     * between polls (no busy-wait). Deletes the sync object when done.
     * @param {WebGLSync} sync - Fence from createFence()
     * @param {number} [timeoutMs=1500] - Max wait before giving up
     * @returns {Promise<boolean>} true if fence was satisfied, false if timed out
     */
    async awaitFence(sync, timeoutMs) {
        if (!sync) return true;
        const gl = this.gl;
        if (!gl) return true; // context gone, sync is orphaned — proceed to readback
        const deadline = performance.now() + (timeoutMs || 1500);

        while (performance.now() < deadline) {
            const status = gl.clientWaitSync(sync, gl.SYNC_FLUSH_COMMANDS_BIT, 0);
            if (status === gl.ALREADY_SIGNALED || status === gl.CONDITION_SATISFIED) {
                gl.deleteSync(sync);
                return true;
            }
            // Yield to event loop — let GPU finish DMA without blocking
            await new Promise(r => setTimeout(r, 0));
        }

        // Timed out — delete sync and proceed (getBufferSubData will stall if needed)
        console.warn('[Compositor] Fence timed out, proceeding with stall');
        gl.deleteSync(sync);
        return false;
    }

    /**
     * Delete all PBO buffers. Called at export end or on error.
     */
    destroyPBOs() {
        if (this._pbos && this.gl) {
            for (const pbo of this._pbos) {
                if (pbo) this.gl.deleteBuffer(pbo);
            }
        }
        this._pbos = null;
        this._pboReady = false;
        this._pboWriteIndex = 0;
        this._pboFrameBytes = 0;
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
            const vid = this._videoElements[this._sceneKey(scene)];
            if (!(vid instanceof HTMLVideoElement)) continue;

            const sceneStart = scene._startFrame / this.fps;
            const sceneEnd = scene._endFrame / this.fps;

            if (currentTimeSeconds >= sceneStart && currentTimeSeconds < sceneEnd) {
                const localTime = currentTimeSeconds - sceneStart + (scene.mediaOffset || 0);
                vid.currentTime = localTime;
                vid.play().catch(() => { });
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
     * Returns a promise that resolves when the seek is complete and frame is decoded.
     */
    async seekVideoToFrame(sceneOrIndex, frame) {
        // Accept either a scene object (track-aware) or raw index (legacy/export compat)
        const key = typeof sceneOrIndex === 'object' ? this._sceneKey(sceneOrIndex) : sceneOrIndex;
        const vid = this._videoElements[key];
        if (!(vid instanceof HTMLVideoElement)) return;

        // If video hasn't loaded yet, wait for it (don't skip — causes black frames)
        if (vid.readyState < 2) {
            await new Promise((resolve) => {
                let resolved = false;
                const done = () => {
                    if (resolved) return;
                    resolved = true;
                    vid.removeEventListener('loadeddata', onLoaded);
                    vid.removeEventListener('error', onError);
                    clearTimeout(timer);
                    resolve();
                };
                const onLoaded = () => done();
                const onError = () => {
                    console.warn(`[Compositor] Video for scene ${sceneIndex} failed to load`);
                    done();
                };
                vid.addEventListener('loadeddata', onLoaded);
                vid.addEventListener('error', onError);
                // If already loaded by now (race), resolve immediately
                if (vid.readyState >= 2) { done(); return; }
                const timer = setTimeout(() => {
                    console.warn(`[Compositor] Timeout waiting for video scene ${sceneIndex} to load`);
                    done();
                }, 15000);
            });
            if (vid.readyState < 2) return; // Truly failed to load
        }

        const targetTime = frame / this.fps;

        // Skip seek if already at this exact time
        if (Math.abs(vid.currentTime - targetTime) < 0.001) return;

        // Register seeked listener BEFORE setting currentTime to avoid race condition
        await new Promise((resolve) => {
            let resolved = false;
            const done = () => {
                if (resolved) return;
                resolved = true;
                vid.removeEventListener('seeked', onSeeked);
                clearTimeout(timer);
                resolve();
            };
            const onSeeked = () => done();
            vid.addEventListener('seeked', onSeeked);
            // Set currentTime AFTER listener is registered
            vid.currentTime = targetTime;
            // Timeout fallback in case seeked never fires
            const timer = setTimeout(done, 500);
        });
    }

    /**
     * Reset video elements after export so preview works again.
     * Seeks all videos to time 0 and ensures they are ready for playback.
     */
    _resetVideosForPreview() {
        // Always clear export-only VideoFrame overrides
        this._exportFrameSources = null;

        for (const key of Object.keys(this._videoElements)) {
            const el = this._videoElements[key];
            if (el instanceof HTMLVideoElement) {
                el.pause();
                el.currentTime = 0;
            }
        }
        // Clear texture cache so next renderFrame uploads fresh frames
        if (this.textureManager) {
            for (const scene of (this.sceneGraph ? this.sceneGraph.scenes : [])) {
                if (!scene.isMGScene && scene.mediaType !== 'motion-graphic') {
                    this.textureManager.release(`scene-${this._sceneKey(scene)}`);
                }
            }
        }
    }

    // ========================================================================
    // PREVIEW RESOLUTION SCALING
    // ========================================================================

    /** Current render width — scaled for preview, full for export */
    _renderWidth() {
        if (this._exporting) return this.width;
        return Math.round(this.width * this._previewScale);
    }

    /** Current render height — scaled for preview, full for export */
    _renderHeight() {
        if (this._exporting) return this.height;
        return Math.round(this.height * this._previewScale);
    }

    /**
     * Set preview scale factor (0.25 = quarter, 0.5 = half, 1.0 = full).
     * Resizes canvas and FBOs immediately.
     */
    setPreviewScale(scale) {
        this._previewScale = Math.max(0.25, Math.min(1.0, scale));
        if (this._initialized && !this._exporting) {
            this._applyResolution();
        }
        // Also scale the MG offscreen canvas
        if (this.mgRenderer) {
            this.mgRenderer.setPreviewScale(this._previewScale);
        }
    }

    /**
     * Resize canvas + FBOs to match current render resolution.
     * Called when switching between preview and export modes.
     */
    _applyResolution() {
        const gl = this.gl;
        if (!gl) return;

        const rw = this._renderWidth();
        const rh = this._renderHeight();

        this.canvas.width = rw;
        this.canvas.height = rh;

        // Resize transition FBOs
        if (this._transitionFBOs) {
            for (const fbo of this._transitionFBOs) {
                gl.bindTexture(gl.TEXTURE_2D, fbo.texture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, rw, rh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                fbo.width = rw;
                fbo.height = rh;
            }
            gl.bindTexture(gl.TEXTURE_2D, null);
        }

        console.log(`[Compositor] Resolution set to ${rw}x${rh} (scale: ${this._previewScale})`);
    }

    /**
     * Switch to full resolution for export. Call before starting export.
     */
    _setExportResolution() {
        this.canvas.width = this.width;
        this.canvas.height = this.height;
        const gl = this.gl;
        if (gl && this._transitionFBOs) {
            for (const fbo of this._transitionFBOs) {
                gl.bindTexture(gl.TEXTURE_2D, fbo.texture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
                fbo.width = this.width;
                fbo.height = this.height;
            }
            gl.bindTexture(gl.TEXTURE_2D, null);
        }
        // MG renderer at full res for export
        if (this.mgRenderer) this.mgRenderer.setPreviewScale(1.0);
        console.log(`[Compositor] Export resolution: ${this.width}x${this.height}`);
    }

    /**
     * Restore preview resolution after export completes.
     */
    _restorePreviewResolution() {
        if (!this._exporting) {
            this._applyResolution();
            // Restore MG renderer to preview scale
            if (this.mgRenderer) this.mgRenderer.setPreviewScale(this._previewScale);
        }
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
