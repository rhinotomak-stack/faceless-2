/**
 * TransitionRenderer.js — Shader-based transitions between two scene textures
 * Uses GLSL fragment shaders to blend between outgoing (A) and incoming (B) scenes.
 *
 * For Slice 0: crossfade and wipe transitions.
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
        const { QUAD_VERT, CROSSFADE_FRAG, WIPE_FRAG, ShaderProgram } = window.ShaderLib;

        this._programs.crossfade = new ShaderProgram(gl, QUAD_VERT, CROSSFADE_FRAG);
        this._programs.wipe = new ShaderProgram(gl, QUAD_VERT, WIPE_FRAG);
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
        if (config.shader === 'wipe') {
            program.set1i('u_direction', config.direction || 0);
            program.set1f('u_softness', config.softness || 0.03);
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
     * This maps the ~40 transition types from ai-transitions.js to
     * the available GPU shaders. Unmapped types fall back to crossfade.
     */
    static TRANSITION_MAP = {
        // Smooth / dissolve-like -> crossfade shader
        crossfade:  { shader: 'crossfade' },
        fade:       { shader: 'crossfade' },
        dissolve:   { shader: 'crossfade' },
        crossBlur:  { shader: 'crossfade' },
        blur:       { shader: 'crossfade' },
        morph:      { shader: 'crossfade' },
        dreamFade:  { shader: 'crossfade' },
        filmBurn:   { shader: 'crossfade' },
        filmGrain:  { shader: 'crossfade' },
        colorFade:  { shader: 'crossfade' },

        // Directional wipes -> wipe shader
        wipe:       { shader: 'wipe', direction: 0, softness: 0.03 },  // left
        slide:      { shader: 'wipe', direction: 0, softness: 0.01 },  // left, hard edge
        push:       { shader: 'wipe', direction: 0, softness: 0.02 },
        swipe:      { shader: 'wipe', direction: 1, softness: 0.02 },  // right
        splitWipe:  { shader: 'wipe', direction: 0, softness: 0.04 },
        reveal:     { shader: 'wipe', direction: 2, softness: 0.05 },  // down
        shadowWipe: { shader: 'wipe', direction: 0, softness: 0.06 },
        ink:        { shader: 'wipe', direction: 2, softness: 0.08 },  // down, soft

        // High-intensity -> crossfade (until dedicated shaders are added)
        zoom:       { shader: 'crossfade' },
        flash:      { shader: 'crossfade' },
        whip:       { shader: 'crossfade' },
        bounce:     { shader: 'crossfade' },
        glitch:     { shader: 'crossfade' },
        ripple:     { shader: 'crossfade' },
        luma:       { shader: 'crossfade' },
        flare:      { shader: 'crossfade' },
        lightLeak:  { shader: 'crossfade' },
        spin:       { shader: 'crossfade' },
        pixelate:   { shader: 'crossfade' },
        mosaic:     { shader: 'crossfade' },
        dataMosh:   { shader: 'crossfade' },
        scanline:   { shader: 'crossfade' },
        rgbSplit:   { shader: 'crossfade' },
        static:     { shader: 'crossfade' },
        prismShift: { shader: 'crossfade' },
        shutterSlice: { shader: 'crossfade' },
        zoomBlur:   { shader: 'crossfade' },
        directionalBlur: { shader: 'crossfade' },
        cameraFlash: { shader: 'crossfade' },
        vignetteBlink: { shader: 'crossfade' },
    };
}

window.TransitionRenderer = TransitionRenderer;
