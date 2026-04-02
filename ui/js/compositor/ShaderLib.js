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
    // Standard mapping: [-1,1] clip coords to [0,1] UV coords
    // NO Y-flip here — FLIP_Y=true on texture upload handles orientation
    v_texCoord = vec2(a_position.x * 0.5 + 0.5, a_position.y * 0.5 + 0.5);
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
// DROP SHADOW FRAGMENT — Soft rounded-rect shadow (no texture, pure geometry)
// ============================================================================
const DROP_SHADOW_FRAG = `#version 300 es
precision highp float;

uniform vec4 u_transform; // x=scaleX, y=scaleY, z=offsetX, w=offsetY
uniform float u_borderRadius; // corner radius (0-0.5)
uniform float u_opacity; // shadow opacity
uniform float u_softness; // shadow blur softness (larger = softer edge)

in vec2 v_texCoord;
out vec4 fragColor;

float roundedBoxSDF(vec2 p, vec2 halfSize, float radius) {
    vec2 d = abs(p) - halfSize + radius;
    return length(max(d, 0.0)) - radius;
}

void main() {
    // Map texCoord to the shadow rect position
    vec2 uv = (v_texCoord - 0.5) / u_transform.xy + 0.5 - u_transform.zw;
    vec2 pos = uv - 0.5;
    float r = u_borderRadius * 0.5;
    float dist = roundedBoxSDF(pos, vec2(0.5), r);
    // Soft falloff: inside = 1.0, outside fades to 0.0 over u_softness range
    float shadow = 1.0 - smoothstep(-u_softness * 0.5, u_softness, dist);
    fragColor = vec4(0.0, 0.0, 0.0, shadow * u_opacity);
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

// Scratch params (animated vertical film scratches)
uniform float u_scratchOn;
uniform float u_scratchIntensity;   // 0-1
uniform float u_scratchSpeed;       // animation speed multiplier
uniform float u_scratchDensity;     // 0-1 how many scratches

// Color Grade params (desaturation + tint)
uniform float u_colorGradeOn;
uniform float u_desaturation;       // 0-1 (0=full color, 1=grayscale)
uniform float u_tintR;              // tint color RGB (0-1)
uniform float u_tintG;
uniform float u_tintB;
uniform float u_tintStrength;       // 0-1 how strong the tint

// Scan Lines params
uniform float u_scanLineOn;
uniform float u_scanLineIntensity;  // 0-1 darkness of lines
uniform float u_scanLineCount;      // number of lines across height
uniform float u_scanLineSpeed;      // scroll speed (0 = static)

// Flicker params (brightness variation per frame)
uniform float u_flickerOn;
uniform float u_flickerIntensity;   // 0-1
uniform float u_flickerSpeed;       // speed of flicker

// Film Frame params (rounded inner frame with black border)
uniform float u_filmFrameOn;
uniform float u_filmFrameBorder;      // border inset in UV space (0.02-0.08)
uniform float u_filmFrameRadius;      // corner radius in UV space (0.01-0.06)
uniform float u_filmFrameSoftness;    // edge feather softness (0.005-0.03)
uniform float u_filmFrameDarken;      // how dark the border gets (0-1, 1=pure black)

// Global effect mask: applies to ALL effects on this scene
// type: 0=none, 1=radialCenter (soft center), 2=radialEdge (soft edges), 3=linearTB (top→bottom)
uniform float u_effectMaskType;
uniform float u_effectMaskStr;

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

// ---- Global Effect Mask ----
// Returns 0-1 multiplier applied to ALL effects on the scene
float effectMask(vec2 uv) {
    if (u_effectMaskType < 0.5) return 1.0; // none
    float dist = length(uv - 0.5) * 2.0; // 0 at center, ~1.4 at corners
    float m = 1.0;
    if (u_effectMaskType < 1.5) {
        // radialCenter: clean center, full effect at edges
        // At str=1: center ~40% of frame is clean, effect kicks in toward edges
        float d = clamp(dist / 1.4, 0.0, 1.0); // normalize so corners = 1.0
        float edge = 0.25 + (1.0 - u_effectMaskStr) * 0.35; // inner radius: 0.25 (str=1) to 0.6 (str=0)
        m = smoothstep(edge, edge + 0.45, d);
    } else if (u_effectMaskType < 2.5) {
        // radialEdge: full effect at center, clean edges
        float d = clamp(dist / 1.4, 0.0, 1.0);
        float outer = 0.7 + (1.0 - u_effectMaskStr) * 0.25; // outer radius: 0.7 (str=1) to 0.95 (str=0)
        m = 1.0 - smoothstep(outer - 0.35, outer, d);
    } else {
        // linearTB: full at top, fades toward bottom
        m = smoothstep(1.0, 0.15 + (1.0 - u_effectMaskStr) * 0.5, uv.y);
    }
    return m;
}

// ---- Grain ----
vec3 applyGrain(vec3 color, vec2 uv, float mask) {
    vec2 grainUV = uv * u_resolution / u_grainScale;
    float noise = hash(grainUV + fract(u_time * 7.23)) * 2.0 - 1.0;
    return color + noise * u_grainIntensity * mask;
}

// ---- Dust ----
vec3 applyDust(vec3 color, vec2 uv, float mask) {
    float t = u_time * 0.3;
    vec2 dustUV = uv * u_resolution * 0.08;
    float n1 = hash(floor(dustUV) + floor(t));
    float n2 = hash(floor(dustUV * 0.5 + 17.0) + floor(t * 0.7));
    float speck = step(1.0 - u_dustDensity * 0.02, n1) * n1;
    speck += step(1.0 - u_dustDensity * 0.015, n2) * n2 * 0.6;
    return color + speck * u_dustIntensity * mask;
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
vec3 applyChromatic(vec3 color, vec2 uv, float mask) {
    vec2 dir = vec2(cos(u_chromaticAngle), sin(u_chromaticAngle)) * u_chromaticIntensity * mask;
    float r = texture(u_texture, clamp(uv + dir, 0.0, 1.0)).r;
    float b = texture(u_texture, clamp(uv - dir, 0.0, 1.0)).b;
    return vec3(r, color.g, b);
}

// ---- Light Leak ----
vec3 applyLightLeak(vec3 color, vec2 uv, float mask) {
    float t = u_time * 0.15;
    float n = valueNoise(uv * 3.0 + t);
    float leak1 = smoothstep(0.6, 0.0, length(uv - vec2(0.85, 0.15)));
    float leak2 = smoothstep(0.5, 0.0, length(uv - vec2(0.1, 0.9)));
    float leak = (leak1 + leak2 * 0.6) * n;
    vec3 leakColor = mix(vec3(1.0), vec3(1.0, 0.7, 0.3), u_lightLeakWarmth);
    return color + leakColor * leak * u_lightLeakIntensity * mask;
}

// ---- Film Scratches ----
vec3 applyScratch(vec3 color, vec2 uv, float mask) {
    float t = u_time * u_scratchSpeed;
    // Multiple scratch layers at different speeds
    float scratch = 0.0;
    for (float i = 0.0; i < 3.0; i++) {
        float seed = i * 17.3 + 5.7;
        // Random X position that changes over time
        float scratchX = fract(hash(vec2(floor(t * (2.0 + i)), seed)) + i * 0.3);
        // Thin vertical line
        float dist = abs(uv.x - scratchX);
        float width = 0.001 + 0.001 * hash(vec2(floor(t * (1.5 + i)), seed + 3.0));
        float line = smoothstep(width, 0.0, dist);
        // Fade in/out over time
        float life = fract(t * (0.8 + i * 0.3) + seed);
        float fade = smoothstep(0.0, 0.1, life) * smoothstep(1.0, 0.7, life);
        // Only show based on density threshold
        float show = step(1.0 - u_scratchDensity, hash(vec2(floor(t * (1.0 + i * 0.5)), seed + 7.0)));
        scratch += line * fade * show;
    }
    // Scratches are bright white lines
    return color + vec3(scratch * u_scratchIntensity * mask);
}

// ---- Color Grade ----
vec3 applyColorGrade(vec3 color, vec2 uv) {
    // Desaturate
    float luma = dot(color, vec3(0.299, 0.587, 0.114));
    vec3 gray = vec3(luma);
    color = mix(color, gray, u_desaturation);
    // Apply tint
    vec3 tint = vec3(u_tintR, u_tintG, u_tintB);
    color = mix(color, color * tint, u_tintStrength);
    return color;
}

// ---- Scan Lines ----
vec3 applyScanLines(vec3 color, vec2 uv, float mask) {
    float y = uv.y * u_scanLineCount + u_time * u_scanLineSpeed;
    float line = sin(y * 3.14159) * 0.5 + 0.5;
    line = pow(line, 3.0); // sharpen the lines
    float darken = 1.0 - line * u_scanLineIntensity * mask;
    return color * darken;
}

// ---- Flicker ----
vec3 applyFlicker(vec3 color, vec2 uv) {
    // Semi-random brightness variation per frame
    float t = u_time * u_flickerSpeed;
    float flick = hash(vec2(floor(t * 12.0), 0.0));
    // Smooth it slightly
    float flick2 = hash(vec2(floor(t * 12.0) + 1.0, 0.0));
    float f = mix(flick, flick2, fract(t * 12.0));
    // Center around 1.0, scale by intensity
    float brightness = 1.0 + (f - 0.5) * u_flickerIntensity;
    return color * brightness;
}

// ---- Film Frame (rounded inner rectangle with black border) ----
vec3 applyFilmFrame(vec3 color, vec2 uv) {
    // Remap UV so (0,0) is center, accounting for aspect ratio
    vec2 aspect = vec2(u_resolution.x / u_resolution.y, 1.0);
    vec2 center = uv - 0.5;

    // Inner frame bounds (inset from edges by border amount)
    float border = u_filmFrameBorder;
    vec2 halfSize = vec2(0.5 - border) * aspect;
    float radius = u_filmFrameRadius;

    // Signed distance to rounded rectangle (in aspect-corrected space)
    vec2 p = abs(center) * aspect;
    vec2 q = p - halfSize + radius;
    float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - radius;

    // Soft feathered edge: 0 inside frame, 1 outside
    float edge = smoothstep(-u_filmFrameSoftness, u_filmFrameSoftness * 0.5, dist);

    // Darken towards black at edges
    color = mix(color, vec3(0.0), edge * u_filmFrameDarken);

    return color;
}

void main() {
    vec2 uv = v_texCoord;
    vec3 color = texture(u_texture, uv).rgb;

    // Compute global mask once — applied to maskable effects
    float mask = effectMask(uv);

    // Apply effects in order
    if (u_chromaticOn > 0.5) color = applyChromatic(color, uv, mask);
    if (u_blurVignetteOn > 0.5) color = applyBlurVignette(color, uv);
    if (u_colorGradeOn > 0.5) color = applyColorGrade(color, uv);
    if (u_flickerOn > 0.5) color = applyFlicker(color, uv);
    if (u_vignetteOn > 0.5) color = applyVignette(color, uv);
    if (u_scanLineOn > 0.5) color = applyScanLines(color, uv, mask);
    if (u_grainOn > 0.5) color = applyGrain(color, uv, mask);
    if (u_dustOn > 0.5) color = applyDust(color, uv, mask);
    if (u_scratchOn > 0.5) color = applyScratch(color, uv, mask);
    if (u_lightLeakOn > 0.5) color = applyLightLeak(color, uv, mask);

    // Film frame must be LAST — overlays black border on top of everything
    if (u_filmFrameOn > 0.5) color = applyFilmFrame(color, uv);

    fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}`;

// Export to global scope (loaded via <script> tag)
window.ShaderLib = {
    QUAD_VERT,
    BLIT_FRAG,
    BLUR_BLIT_FRAG,
    DROP_SHADOW_FRAG,
    CROSSFADE_FRAG,
    WIPE_FRAG,
    EFFECTS_FRAG,
    ShaderProgram,
    compileShader,
    createProgram,
};
