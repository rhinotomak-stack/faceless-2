/**
 * ShaderLib.js — GLSL shader sources + WebGL2 compilation utilities
 * Part of the WYSIWYG WebGL2 Compositor Engine
 */

// ============================================================================
// VERTEX SHADER — Fullscreen quad, shared by all fragment shaders
// ============================================================================
const QUAD_VERT = `#version 300 es
in vec2 a_position;
out vec2 v_texCoord;
void main() {
    gl_Position = vec4(a_position, 0.0, 1.0);
    // Map [-1,1] clip coords to [0,1] UV coords
    // Flip Y so top-left = (0,0) matching video/image convention
    v_texCoord = vec2(a_position.x * 0.5 + 0.5, 1.0 - (a_position.y * 0.5 + 0.5));
}`;

// ============================================================================
// BLIT FRAGMENT — Texture blit with opacity + fit-mode transform
// ============================================================================
const BLIT_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_texture;
uniform float u_opacity;
// u_transform: x=scaleX, y=scaleY, z=offsetX, w=offsetY (in UV space)
uniform vec4 u_transform;

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
    // Apply fit-mode transform: scale and offset UVs
    vec2 uv = (v_texCoord - 0.5) / u_transform.xy + 0.5 - u_transform.zw;

    // Pixels outside [0,1] are transparent
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        fragColor = vec4(0.0);
        return;
    }

    vec4 color = texture(u_texture, uv);
    fragColor = vec4(color.rgb, color.a * u_opacity);
}`;

// ============================================================================
// CROSSFADE FRAGMENT — Blend between two textures
// ============================================================================
const CROSSFADE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_textureA;
uniform sampler2D u_textureB;
uniform float u_progress; // 0.0 = full A, 1.0 = full B

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
    vec4 colorA = texture(u_textureA, v_texCoord);
    vec4 colorB = texture(u_textureB, v_texCoord);
    fragColor = mix(colorA, colorB, u_progress);
}`;

// ============================================================================
// WIPE FRAGMENT — Directional wipe transition with soft edge
// ============================================================================
const WIPE_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_textureA;
uniform sampler2D u_textureB;
uniform float u_progress;
uniform int u_direction;   // 0=left, 1=right, 2=down, 3=up
uniform float u_softness;  // 0.0 = hard edge, 0.05 = soft

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
    float edge;
    if (u_direction == 0)      edge = v_texCoord.x;
    else if (u_direction == 1) edge = 1.0 - v_texCoord.x;
    else if (u_direction == 2) edge = v_texCoord.y;
    else                       edge = 1.0 - v_texCoord.y;

    float t = smoothstep(u_progress - u_softness, u_progress + u_softness, edge);

    vec4 colorA = texture(u_textureA, v_texCoord);
    vec4 colorB = texture(u_textureB, v_texCoord);
    fragColor = mix(colorB, colorA, t);
}`;

// ============================================================================
// WebGL2 Compilation Utilities
// ============================================================================

function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const info = gl.getShaderInfoLog(shader);
        gl.deleteShader(shader);
        throw new Error(`Shader compile error: ${info}`);
    }
    return shader;
}

function createProgram(gl, vertSource, fragSource) {
    const vert = compileShader(gl, gl.VERTEX_SHADER, vertSource);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSource);
    const program = gl.createProgram();
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const info = gl.getProgramInfoLog(program);
        gl.deleteProgram(program);
        gl.deleteShader(vert);
        gl.deleteShader(frag);
        throw new Error(`Program link error: ${info}`);
    }
    // Shaders can be detached after linking
    gl.detachShader(program, vert);
    gl.detachShader(program, frag);
    gl.deleteShader(vert);
    gl.deleteShader(frag);
    return program;
}

/**
 * ShaderProgram wrapper — caches uniform locations, provides typed setters.
 */
class ShaderProgram {
    constructor(gl, vertSource, fragSource) {
        this.gl = gl;
        this.program = createProgram(gl, vertSource, fragSource);
        this._uniforms = {};
    }

    use() {
        this.gl.useProgram(this.program);
    }

    _loc(name) {
        if (!(name in this._uniforms)) {
            this._uniforms[name] = this.gl.getUniformLocation(this.program, name);
        }
        return this._uniforms[name];
    }

    set1f(name, v) { this.gl.uniform1f(this._loc(name), v); }
    set1i(name, v) { this.gl.uniform1i(this._loc(name), v); }
    set4f(name, x, y, z, w) { this.gl.uniform4f(this._loc(name), x, y, z, w); }

    /**
     * Bind a texture to a texture unit and set the sampler uniform.
     */
    setTexture(name, unit, texture) {
        this.gl.activeTexture(this.gl.TEXTURE0 + unit);
        this.gl.bindTexture(this.gl.TEXTURE_2D, texture);
        this.gl.uniform1i(this._loc(name), unit);
    }

    destroy() {
        if (this.program) {
            this.gl.deleteProgram(this.program);
            this.program = null;
        }
    }
}

// Export to global scope (loaded via <script> tag)
window.ShaderLib = {
    QUAD_VERT,
    BLIT_FRAG,
    CROSSFADE_FRAG,
    WIPE_FRAG,
    ShaderProgram,
    compileShader,
    createProgram,
};
