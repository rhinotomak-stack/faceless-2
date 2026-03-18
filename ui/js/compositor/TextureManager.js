/**
 * TextureManager.js — GPU texture lifecycle management
 * Creates, updates, and releases WebGL2 textures from video/image/canvas sources.
 *
 * Y-orientation architecture (standard WebGL):
 * - Vertex shader (QUAD_VERT) uses standard mapping: no Y-flip.
 *   Screen-top → texcoord y=1, screen-bottom → texcoord y=0.
 * - FLIP_Y=true on texture upload flips HTML sources so their top row
 *   maps to texcoord y=1 (screen-top). This is the standard approach.
 * - FBO textures: rendered content is already in GL coords (bottom-up),
 *   so they naturally display correctly without any extra flip.
 * - Transition shaders (crossfade, wipe) sample with v_texCoord directly,
 *   no extra Y corrections needed.
 */

class TextureManager {
    constructor(gl) {
        this.gl = gl;
        this._textures = new Map(); // id -> { texture, width, height }
    }

    /**
     * Create or update a texture from an HTML source element.
     * Accepts HTMLVideoElement, HTMLImageElement, HTMLCanvasElement, or VideoFrame.
     */
    createOrUpdate(id, source) {
        const gl = this.gl;
        let entry = this._textures.get(id);

        // Determine source dimensions
        let w, h;

        if (typeof VideoFrame !== 'undefined' && source instanceof VideoFrame) {
            w = source.displayWidth;
            h = source.displayHeight;
        } else if (source instanceof HTMLVideoElement) {
            w = source.videoWidth;
            h = source.videoHeight;
            if (!w || !h || source.readyState < 2) {
                if (!entry) entry = this._createPlaceholder(id);
                return entry;
            }
        } else if (source instanceof HTMLImageElement) {
            w = source.naturalWidth;
            h = source.naturalHeight;
            if (!w || !h) {
                if (!entry) entry = this._createPlaceholder(id);
                return entry;
            }
        } else if (source instanceof HTMLCanvasElement) {
            w = source.width;
            h = source.height;
        } else {
            return null;
        }

        // FLIP_Y=true: flip HTML source rows so top-of-image → texcoord y=1 (screen-top).
        // The vertex shader uses standard mapping (no Y-flip), so this is required.
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

        if (!entry) {
            // First time: create the texture
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            entry = { texture, width: w, height: h };
            this._textures.set(id, entry);
        } else {
            // Update existing texture
            gl.bindTexture(gl.TEXTURE_2D, entry.texture);
            if (entry.width !== w || entry.height !== h) {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
                entry.width = w;
                entry.height = h;
            } else {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
            }
        }

        return entry;
    }

    /**
     * Get an existing texture by id.
     */
    get(id) {
        return this._textures.get(id) || null;
    }

    /**
     * Release a single texture.
     */
    release(id) {
        const entry = this._textures.get(id);
        if (entry) {
            this.gl.deleteTexture(entry.texture);
            this._textures.delete(id);
        }
    }

    /**
     * Release all textures.
     */
    releaseAll() {
        for (const [id, entry] of this._textures) {
            this.gl.deleteTexture(entry.texture);
        }
        this._textures.clear();
    }

    /**
     * Create a 1x1 black placeholder texture.
     */
    _createPlaceholder(id) {
        const gl = this.gl;
        const texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
            new Uint8Array([0, 0, 0, 255]));
        const entry = { texture, width: 1, height: 1 };
        this._textures.set(id, entry);
        return entry;
    }
}

window.TextureManager = TextureManager;
