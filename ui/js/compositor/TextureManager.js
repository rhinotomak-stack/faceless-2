/**
 * TextureManager.js — GPU texture lifecycle management
 * Creates, updates, and releases WebGL2 textures from video/image/canvas sources.
 */

class TextureManager {
    constructor(gl) {
        this.gl = gl;
        this._textures = new Map(); // id -> { texture, width, height }
    }

    /**
     * Create or update a texture from an HTML source element.
     * Accepts HTMLVideoElement, HTMLImageElement, or HTMLCanvasElement.
     * For video: call every frame to upload the latest decoded frame.
     * For images/canvas: call once or when content changes.
     */
    createOrUpdate(id, source) {
        const gl = this.gl;
        let entry = this._textures.get(id);

        // Determine source dimensions
        let w, h;
        if (source instanceof HTMLVideoElement) {
            w = source.videoWidth;
            h = source.videoHeight;
            // Skip if video hasn't decoded a frame yet
            if (!w || !h || source.readyState < 2) {
                if (!entry) {
                    // Create 1x1 black placeholder
                    entry = this._createPlaceholder(id);
                }
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

        if (!entry) {
            // First time: create the texture
            const texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, texture);
            // Set parameters for non-power-of-2 textures
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            // Upload from source
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
            entry = { texture, width: w, height: h };
            this._textures.set(id, entry);
        } else {
            // Update existing texture
            gl.bindTexture(gl.TEXTURE_2D, entry.texture);
            // If size changed, re-allocate; otherwise just upload
            if (entry.width !== w || entry.height !== h) {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
                entry.width = w;
                entry.height = h;
            } else {
                // texSubImage2D is slightly faster for same-size updates
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
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
            new Uint8Array([0, 0, 0, 255]));
        const entry = { texture, width: 1, height: 1 };
        this._textures.set(id, entry);
        return entry;
    }
}

window.TextureManager = TextureManager;
