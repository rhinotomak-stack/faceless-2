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
// u_crop: x=top, y=right, z=bottom, w=left (0-1 fractions of texture)
uniform vec4 u_crop;
// u_borderRadius: 0.0 = sharp, 0.5 = fully rounded (fraction of half-size)
uniform float u_borderRadius;

in vec2 v_texCoord;
out vec4 fragColor;

float roundedBoxSDF(vec2 p, vec2 halfSize, float radius) {
    vec2 d = abs(p) - halfSize + radius;
    return length(max(d, 0.0)) - radius;
}

void main() {
    // Apply fit-mode transform: scale and offset UVs
    vec2 uv = (v_texCoord - 0.5) / u_transform.xy + 0.5 - u_transform.zw;

    // Pixels outside [0,1] are transparent
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        fragColor = vec4(0.0);
        return;
    }

    // Border radius — applied in the image's UV space so it follows scale/position
    float alpha = 1.0;
    if (u_borderRadius > 0.001) {
        vec2 pos = uv - 0.5; // center of image UV space
        float r = u_borderRadius * 0.5;
        float dist = roundedBoxSDF(pos, vec2(0.5), r);
        // Scale smoothstep edge by transform to keep consistent anti-aliasing
        float edgeWidth = 0.003 / min(u_transform.x, u_transform.y);
        if (dist > edgeWidth) { fragColor = vec4(0.0); return; }
        alpha = 1.0 - smoothstep(0.0, edgeWidth, dist);
    }

    // Apply crop: discard pixels in cropped regions of the texture
    if (uv.y < u_crop.x || uv.x > 1.0 - u_crop.y ||
        uv.y > 1.0 - u_crop.z || uv.x < u_crop.w) {
        fragColor = vec4(0.0);
        return;
    }

    vec4 color = texture(u_texture, uv);
    fragColor = vec4(color.rgb, color.a * u_opacity * alpha);
}`;

// ============================================================================
// BLUR BLIT FRAGMENT — Blurred texture blit for background fill
// ============================================================================
const BLUR_BLIT_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_texture;
uniform float u_opacity;
uniform vec4 u_transform;
uniform vec2 u_texelSize; // 1/width, 1/height in UV space

in vec2 v_texCoord;
out vec4 fragColor;

void main() {
    vec2 uv = (v_texCoord - 0.5) / u_transform.xy + 0.5 - u_transform.zw;
    uv = clamp(uv, 0.0, 1.0);

    // 13-tap blur: center + inner ring (r1) + outer ring (r2)
    float r1 = 12.0, r2 = 30.0;
    vec2 ts = u_texelSize;

    vec4 c = texture(u_texture, uv) * 0.12;
    // Inner ring — 4 axis-aligned samples
    c += texture(u_texture, clamp(uv + vec2(r1, 0.0) * ts, 0.0, 1.0)) * 0.1;
    c += texture(u_texture, clamp(uv - vec2(r1, 0.0) * ts, 0.0, 1.0)) * 0.1;
    c += texture(u_texture, clamp(uv + vec2(0.0, r1) * ts, 0.0, 1.0)) * 0.1;
    c += texture(u_texture, clamp(uv - vec2(0.0, r1) * ts, 0.0, 1.0)) * 0.1;
    // Outer ring — 4 axis-aligned + 4 diagonal
    c += texture(u_texture, clamp(uv + vec2(r2, 0.0) * ts, 0.0, 1.0)) * 0.07;
    c += texture(u_texture, clamp(uv - vec2(r2, 0.0) * ts, 0.0, 1.0)) * 0.07;
    c += texture(u_texture, clamp(uv + vec2(0.0, r2) * ts, 0.0, 1.0)) * 0.07;
    c += texture(u_texture, clamp(uv - vec2(0.0, r2) * ts, 0.0, 1.0)) * 0.07;
    c += texture(u_texture, clamp(uv + vec2(r2, r2) * 0.707 * ts, 0.0, 1.0)) * 0.03;
    c += texture(u_texture, clamp(uv - vec2(r2, r2) * 0.707 * ts, 0.0, 1.0)) * 0.03;
    c += texture(u_texture, clamp(uv + vec2(r2, -r2) * 0.707 * ts, 0.0, 1.0)) * 0.03;
    c += texture(u_texture, clamp(uv - vec2(r2, -r2) * 0.707 * ts, 0.0, 1.0)) * 0.03;
    // Total weights = 0.12 + 4*0.1 + 4*0.07 + 4*0.03 = 0.12 + 0.4 + 0.28 + 0.12 = 0.92
    c /= 0.92;

    // Slightly darken for background effect
    fragColor = vec4(c.rgb * 0.7, u_opacity);
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
    // FBO textures are Y-flipped compared to default framebuffer
    vec2 tc = vec2(v_texCoord.x, 1.0 - v_texCoord.y);
    vec4 colorA = texture(u_textureA, tc);
    vec4 colorB = texture(u_textureB, tc);
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
    // FBO textures are Y-flipped compared to default framebuffer
    vec2 tc = vec2(v_texCoord.x, 1.0 - v_texCoord.y);
    float edge;
    if (u_direction == 0)      edge = tc.x;
    else if (u_direction == 1) edge = 1.0 - tc.x;
    else if (u_direction == 2) edge = tc.y;
    else                       edge = 1.0 - tc.y;

    float t = smoothstep(u_progress - u_softness, u_progress + u_softness, edge);

    vec4 colorA = texture(u_textureA, tc);
    vec4 colorB = texture(u_textureB, tc);
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
    set2f(name, x, y) { this.gl.uniform2f(this._loc(name), x, y); }
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
    BLUR_BLIT_FRAG,
    CROSSFADE_FRAG,
    WIPE_FRAG,
    ShaderProgram,
    compileShader,
    createProgram,
};
