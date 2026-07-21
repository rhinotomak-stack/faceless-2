/**
 * TransitionRenderer.js — Shader-based transitions between two scene textures
 * Uses GLSL fragment shaders to blend between outgoing (A) and incoming (B) scenes.
 *
 * Supports 8 shader types: crossfade, wipe, zoom, lightleak, glitch, shape, camera, luma
 */

class TransitionRenderer {
    constructor(gl) {
        this.gl = gl;
        this._programs = {};
    }

    /**
     * Initialize shader programs for available transition types.
     * Must be called after ShaderLib is loaded.
     */
    init() {
        const gl = this.gl;
        const {
            QUAD_VERT, CROSSFADE_FRAG, WIPE_FRAG,
            ZOOM_FRAG, LIGHTLEAK_FRAG, GLITCH_FRAG,
            SHAPE_FRAG, CAMERA_FRAG, LUMA_FRAG,
            ShaderProgram
        } = window.ShaderLib;

        this._programs.crossfade = new ShaderProgram(gl, QUAD_VERT, CROSSFADE_FRAG);
        this._programs.wipe      = new ShaderProgram(gl, QUAD_VERT, WIPE_FRAG);
        this._programs.zoom      = new ShaderProgram(gl, QUAD_VERT, ZOOM_FRAG);
        this._programs.lightleak = new ShaderProgram(gl, QUAD_VERT, LIGHTLEAK_FRAG);
        this._programs.glitch    = new ShaderProgram(gl, QUAD_VERT, GLITCH_FRAG);
        this._programs.shape     = new ShaderProgram(gl, QUAD_VERT, SHAPE_FRAG);
        this._programs.camera    = new ShaderProgram(gl, QUAD_VERT, CAMERA_FRAG);
        this._programs.luma      = new ShaderProgram(gl, QUAD_VERT, LUMA_FRAG);
    }

    /**
     * Render a transition between two textures.
     * Renders directly to the current framebuffer (screen or FBO).
     *
     * @param {WebGLTexture} textureA - Outgoing scene texture
     * @param {WebGLTexture} textureB - Incoming scene texture
     * @param {number} progress - 0.0 = full A, 1.0 = full B
     * @param {string} type - Transition type name
     * @param {function} drawQuad - Function to draw the fullscreen quad
     */
    render(textureA, textureB, progress, type, drawQuad) {
        // Map transition types to shader programs + configs
        const config = TransitionRenderer.TRANSITION_MAP[type] || TransitionRenderer.TRANSITION_MAP.crossfade;
        const program = this._programs[config.shader];
        if (!program) return;

        program.use();
        program.setTexture('u_textureA', 0, textureA);
        program.setTexture('u_textureB', 1, textureB);
        program.set1f('u_progress', progress);

        // Set shader-specific uniforms
        const shader = config.shader;

        if (shader === 'wipe') {
            program.set1i('u_direction', config.direction || 0);
            program.set1f('u_softness', config.softness || 0.03);
        }
        else if (shader === 'zoom') {
            program.set1i('u_mode', config.mode || 0);
        }
        else if (shader === 'lightleak') {
            program.set1i('u_mode', config.mode || 0);
        }
        else if (shader === 'glitch') {
            program.set1i('u_mode', config.mode || 0);
        }
        else if (shader === 'shape') {
            program.set1i('u_mode', config.mode || 0);
            program.set1f('u_softness', config.softness || 0.06);
        }
        else if (shader === 'camera') {
            program.set1i('u_mode', config.mode || 0);
        }
        else if (shader === 'luma') {
            program.set1i('u_mode', config.mode || 0);
            program.set1f('u_softness', config.softness || 0.15);
        }

        drawQuad();
    }

    /**
     * Clean up all shader programs.
     */
    destroy() {
        for (const key of Object.keys(this._programs)) {
            this._programs[key].destroy();
        }
        this._programs = {};
    }

    /**
     * Map from video-plan.json transition type names to shader config.
     * Routes ~50 transition types to 8 GPU shaders with per-type parameters.
     */
    static TRANSITION_MAP = {
        // ── Crossfade shader (smooth dissolves) ──
        crossfade:  { shader: 'crossfade' },
        fade:       { shader: 'crossfade' },
        fade_to_black: { shader: 'crossfade' },
        dissolve:   { shader: 'crossfade' },
        'blur-dissolve': { shader: 'crossfade' },
        'dip-black': { shader: 'crossfade' },
        crossBlur:  { shader: 'crossfade' },
        blur:       { shader: 'crossfade' },
        morph:      { shader: 'crossfade' },
        dreamFade:  { shader: 'crossfade' },
        filmBurn:   { shader: 'crossfade' },
        filmGrain:  { shader: 'crossfade' },
        colorFade:  { shader: 'crossfade' },

        // ── Wipe shader (directional wipes) ──
        wipe:       { shader: 'wipe', direction: 0, softness: 0.08 },
        'wipe-left':  { shader: 'wipe', direction: 0, softness: 0.08 },
        'wipe-right': { shader: 'wipe', direction: 1, softness: 0.08 },
        'wipe-up':    { shader: 'wipe', direction: 2, softness: 0.08 },
        'push-left':  { shader: 'wipe', direction: 0, softness: 0.04 },
        'push-right': { shader: 'wipe', direction: 1, softness: 0.04 },
        'push-up':    { shader: 'wipe', direction: 2, softness: 0.04 },
        slide:      { shader: 'wipe', direction: 0, softness: 0.04 },
        push:       { shader: 'wipe', direction: 0, softness: 0.06 },
        swipe:      { shader: 'wipe', direction: 1, softness: 0.06 },
        splitWipe:  { shader: 'wipe', direction: 0, softness: 0.10 },
        reveal:     { shader: 'wipe', direction: 2, softness: 0.10 },
        shadowWipe: { shader: 'wipe', direction: 0, softness: 0.12 },
        ink:        { shader: 'wipe', direction: 2, softness: 0.15 },

        // ── Zoom shader (zoom in/out/rotate) ──
        zoom:       { shader: 'zoom', mode: 0 },       // zoom in
        'zoom-punch': { shader: 'zoom', mode: 0 },
        'zoom-pull':  { shader: 'zoom', mode: 1 },
        zoomBlur:   { shader: 'zoom', mode: 0 },       // zoom in (with natural blur from scaling)
        zoomOut:    { shader: 'zoom', mode: 1 },       // zoom out
        zoomRotate: { shader: 'zoom', mode: 2 },       // zoom + rotate

        // ── Light Leak shader (warm/cool/flare wash) ──
        lightLeak:  { shader: 'lightleak', mode: 0 },  // warm orange
        warmLeak:   { shader: 'lightleak', mode: 0 },  // warm orange
        coolLeak:   { shader: 'lightleak', mode: 1 },  // cool blue
        flare:      { shader: 'lightleak', mode: 2 },  // white flare
        flash:      { shader: 'lightleak', mode: 2 },  // white flare
        'flash-white': { shader: 'lightleak', mode: 2 },
        'light-sweep': { shader: 'lightleak', mode: 2 },
        cameraFlash:{ shader: 'lightleak', mode: 2 },  // white flare

        // ── Glitch shader (digital distortion) ──
        glitch:     { shader: 'glitch', mode: 0 },     // standard glitch
        rgbSplit:   { shader: 'glitch', mode: 1 },     // RGB split emphasis
        dataMosh:   { shader: 'glitch', mode: 2 },     // data mosh
        pixelate:   { shader: 'glitch', mode: 0 },     // glitch (closest)
        mosaic:     { shader: 'glitch', mode: 0 },     // glitch (closest)
        scanline:   { shader: 'glitch', mode: 1 },     // RGB + scanlines
        static:     { shader: 'glitch', mode: 0 },     // standard glitch
        prismShift: { shader: 'glitch', mode: 1 },     // RGB split

        // ── Shape shader (geometric wipes) ──
        diagonalStripes:  { shader: 'shape', mode: 0, softness: 0.06 },
        rectangles:       { shader: 'shape', mode: 1, softness: 0.05 },
        diamonds:         { shader: 'shape', mode: 2, softness: 0.06 },
        blinds:           { shader: 'shape', mode: 3, softness: 0.05 },
        circles:          { shader: 'shape', mode: 4, softness: 0.06 },
        shutterSlice:     { shader: 'shape', mode: 3, softness: 0.04 },  // blinds variant
        bounce:           { shader: 'shape', mode: 4, softness: 0.08 },  // circles variant

        // ── Camera shader (pan/whip/spin) ──
        panLeft:    { shader: 'camera', mode: 0 },
        panRight:   { shader: 'camera', mode: 1 },
        panUp:      { shader: 'camera', mode: 2 },
        panDown:    { shader: 'camera', mode: 3 },
        whip:       { shader: 'camera', mode: 4 },      // whip pan with motion blur
        'whip-left': { shader: 'camera', mode: 4 },
        'whip-right': { shader: 'camera', mode: 4 },
        whipPan:    { shader: 'camera', mode: 4 },
        spin:       { shader: 'camera', mode: 5 },      // rotation
        'spin-settle': { shader: 'camera', mode: 5 },
        directionalBlur: { shader: 'camera', mode: 4 }, // whip-like motion blur

        // ── Luma shader (luminance-based dissolve) ──
        luma:       { shader: 'luma', mode: 0, softness: 0.15 },  // brights first
        lumaFade:   { shader: 'luma', mode: 0, softness: 0.15 },
        lumaDark:   { shader: 'luma', mode: 1, softness: 0.15 },  // darks first
        ripple:     { shader: 'luma', mode: 0, softness: 0.20 },  // luma (organic feel)
        vignetteBlink: { shader: 'luma', mode: 1, softness: 0.10 },
    };
}

window.TransitionRenderer = TransitionRenderer;
