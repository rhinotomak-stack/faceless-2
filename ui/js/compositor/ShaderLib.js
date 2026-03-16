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

// ============================================================================
// EFFECTS FRAGMENT — Post-process effects applied per-scene
// All 6 effects in one shader, toggled by uniforms.
// ============================================================================
const EFFECTS_FRAG = `#version 300 es
precision highp float;

uniform sampler2D u_texture;
uniform vec2 u_resolution;   // canvas width, height in pixels
uniform float u_time;         // time in seconds (for animated effects)
uniform vec2 u_texelSize;     // 1/width, 1/height

// Effect toggles (0.0 = off, 1.0 = on)
uniform float u_grainOn;
uniform float u_dustOn;
uniform float u_vignetteOn;
uniform float u_blurVignetteOn;
uniform float u_chromaticOn;
uniform float u_lightLeakOn;

// Grain params
uniform float u_grainIntensity;  // 0-1, typically 0.06-0.18
uniform float u_grainScale;      // pixel scale, 1.0-2.0

// Dust params
uniform float u_dustIntensity;   // 0-1
uniform float u_dustDensity;     // 0-1 (threshold)

// Vignette params
uniform float u_vignetteIntensity; // 0-1, how dark the edges get
uniform float u_vignetteRadius;    // 0-1, where darkening starts (0=center, 1=edge)
uniform float u_vignetteSoftness;  // 0-1, falloff smoothness

// BlurVignette params
uniform float u_blurVigIntensity;  // 0-1
uniform float u_blurVigRadius;     // 0-1
uniform float u_blurVigAmount;     // blur kernel radius in texels

// Chromatic params
uniform float u_chromaticIntensity; // UV offset for R/B channels, typically 0.003-0.01
uniform float u_chromaticAngle;     // direction angle in radians

// LightLeak params
uniform float u_lightLeakIntensity; // 0-1
uniform float u_lightLeakWarmth;    // 0-1 (0=neutral, 1=warm orange)

in vec2 v_texCoord;
out vec4 fragColor;

// ---- Noise functions ----
float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float valueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f); // smoothstep
    float a = hash(i);
    float b = hash(i + vec2(1.0, 0.0));
    float c = hash(i + vec2(0.0, 1.0));
    float d = hash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// ---- Grain ----
vec3 applyGrain(vec3 color, vec2 uv) {
    vec2 grainUV = uv * u_resolution / u_grainScale;
    float noise = hash(grainUV + fract(u_time * 7.23)) * 2.0 - 1.0;
    return color + noise * u_grainIntensity;
}

// ---- Dust ----
vec3 applyDust(vec3 color, vec2 uv) {
    // Sparse bright specks — slow-moving over time
    float t = u_time * 0.3;
    vec2 dustUV = uv * u_resolution * 0.08;
    float n1 = hash(floor(dustUV) + floor(t));
    float n2 = hash(floor(dustUV * 0.5 + 17.0) + floor(t * 0.7));
    float speck = step(1.0 - u_dustDensity * 0.02, n1) * n1;
    speck += step(1.0 - u_dustDensity * 0.015, n2) * n2 * 0.6;
    return color + speck * u_dustIntensity;
}

// ---- Vignette ----
vec3 applyVignette(vec3 color, vec2 uv) {
    vec2 center = uv - 0.5;
    float dist = length(center) * 1.414; // normalize so corners = 1.0
    float vig = smoothstep(u_vignetteRadius, u_vignetteRadius + u_vignetteSoftness, dist);
    return color * (1.0 - vig * u_vignetteIntensity);
}

// ---- BlurVignette ----
vec3 applyBlurVignette(vec3 color, vec2 uv) {
    vec2 center = uv - 0.5;
    float dist = length(center) * 1.414;
    float blurFactor = smoothstep(u_blurVigRadius, u_blurVigRadius + 0.4, dist) * u_blurVigIntensity;

    if (blurFactor < 0.01) return color;

    // 8-tap blur scaled by blurFactor
    float r = u_blurVigAmount * blurFactor;
    vec3 blurred = vec3(0.0);
    blurred += texture(u_texture, clamp(uv + vec2( r,  0.0) * u_texelSize, 0.0, 1.0)).rgb;
    blurred += texture(u_texture, clamp(uv + vec2(-r,  0.0) * u_texelSize, 0.0, 1.0)).rgb;
    blurred += texture(u_texture, clamp(uv + vec2( 0.0, r)  * u_texelSize, 0.0, 1.0)).rgb;
    blurred += texture(u_texture, clamp(uv + vec2( 0.0,-r)  * u_texelSize, 0.0, 1.0)).rgb;
    blurred += texture(u_texture, clamp(uv + vec2( r,  r) * 0.707 * u_texelSize, 0.0, 1.0)).rgb;
    blurred += texture(u_texture, clamp(uv + vec2(-r,  r) * 0.707 * u_texelSize, 0.0, 1.0)).rgb;
    blurred += texture(u_texture, clamp(uv + vec2( r, -r) * 0.707 * u_texelSize, 0.0, 1.0)).rgb;
    blurred += texture(u_texture, clamp(uv + vec2(-r, -r) * 0.707 * u_texelSize, 0.0, 1.0)).rgb;
    blurred /= 8.0;

    return mix(color, blurred, blurFactor);
}

// ---- Chromatic Aberration ----
vec3 applyChromatic(vec3 color, vec2 uv) {
    vec2 dir = vec2(cos(u_chromaticAngle), sin(u_chromaticAngle)) * u_chromaticIntensity;
    float r = texture(u_texture, clamp(uv + dir, 0.0, 1.0)).r;
    float b = texture(u_texture, clamp(uv - dir, 0.0, 1.0)).b;
    return vec3(r, color.g, b);
}

// ---- Light Leak ----
vec3 applyLightLeak(vec3 color, vec2 uv) {
    // Animated warm gradient from edges
    float t = u_time * 0.15;
    float n = valueNoise(uv * 3.0 + t);
    // Leak from top-right and bottom-left corners
    float leak1 = smoothstep(0.6, 0.0, length(uv - vec2(0.85, 0.15)));
    float leak2 = smoothstep(0.5, 0.0, length(uv - vec2(0.1, 0.9)));
    float leak = (leak1 + leak2 * 0.6) * n;
    // Warm color: interpolate between white and warm orange based on warmth
    vec3 leakColor = mix(vec3(1.0), vec3(1.0, 0.7, 0.3), u_lightLeakWarmth);
    return color + leakColor * leak * u_lightLeakIntensity;
}

void main() {
    vec2 uv = v_texCoord;
    vec3 color = texture(u_texture, uv).rgb;

    // Apply effects in order: chromatic first (re-samples texture), then color effects
    if (u_chromaticOn > 0.5) color = applyChromatic(color, uv);
    if (u_blurVignetteOn > 0.5) color = applyBlurVignette(color, uv);
    if (u_vignetteOn > 0.5) color = applyVignette(color, uv);
    if (u_grainOn > 0.5) color = applyGrain(color, uv);
    if (u_dustOn > 0.5) color = applyDust(color, uv);
    if (u_lightLeakOn > 0.5) color = applyLightLeak(color, uv);

    fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

// Export to global scope (loaded via <script> tag)
window.ShaderLib = {
    QUAD_VERT,
    BLIT_FRAG,
    BLUR_BLIT_FRAG,
    CROSSFADE_FRAG,
    WIPE_FRAG,
    EFFECTS_FRAG,
    ShaderProgram,
    compileShader,
    createProgram,
};
