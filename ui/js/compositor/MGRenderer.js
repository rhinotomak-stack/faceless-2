/**
 * MGRenderer.js — Motion Graphics renderer via Canvas2D -> WebGL texture
 * Renders MG overlays to an offscreen canvas, then uploads as a texture.
 *
 * For Slice 0: only 'headline' type is implemented.
 * The rendering code is ported directly from src/canvas-mg-renderer.js.
 */

class MGRenderer {
    constructor(textureManager, fps) {
        this.textureManager = textureManager;
        this.fps = fps;
        // Offscreen canvas for 2D drawing (full 1920x1080)
        this._canvas = document.createElement('canvas');
        this._canvas.width = 1920;
        this._canvas.height = 1080;
        this._ctx = this._canvas.getContext('2d', { willReadFrequently: false });
    }

    /**
     * Render a motion graphic for the given local frame.
     * Returns a TextureManager entry { texture, width, height } or null.
     *
     * @param {object} mg - MG spec object from video-plan.json
     * @param {number} localFrame - Frame number relative to MG start (0 = first frame)
     * @param {object} scriptContext - Script context from plan (for theme)
     */
    renderMG(mg, localFrame, scriptContext) {
        const ctx = this._ctx;
        ctx.clearRect(0, 0, 1920, 1080);

        const s = this._getStyle(mg, scriptContext);
        const anim = AnimationUtils.computeAnimationState(localFrame, this.fps, {
            ...mg,
            _animationSpeed: mg._animationSpeed || 1.0,
        });

        let rendered = false;
        switch (mg.type) {
            case 'headline':
                this._renderHeadline(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            // Future MG types will be added here
            default:
                break;
        }

        if (!rendered) return null;

        // Upload the canvas to a WebGL texture
        const texId = `mg-${mg.type}-${mg._startFrame || 0}`;
        return this.textureManager.createOrUpdate(texId, this._canvas);
    }

    // ========================================================================
    // STYLE RESOLUTION (mirrors the app.js getStyledThemeColors + MG_STYLES)
    // ========================================================================

    _getStyle(mg, scriptContext) {
        const styleName = mg.style || 'clean';
        // Use the global MG_STYLES from app.js (already in scope)
        const baseS = (typeof MG_STYLES !== 'undefined' ? MG_STYLES[styleName] : null) || {
            primary: '#3b82f6', accent: '#f59e0b', bg: 'rgba(0,0,0,0.7)',
            text: '#ffffff', textSub: 'rgba(255,255,255,0.75)', glow: false,
        };

        // Try to get theme-styled colors (uses app.js globals)
        let styled = null;
        if (typeof getStyledThemeColors === 'function') {
            styled = getStyledThemeColors(styleName);
        }
        const s = styled ? { ...baseS, ...styled } : { ...baseS };

        // Get theme fonts
        if (typeof getActiveThemeFonts === 'function') {
            const tf = getActiveThemeFonts();
            if (tf) {
                s.fontHeading = tf.heading.replace(/"/g, "'");
                s.fontBody = tf.body.replace(/"/g, "'");
            }
        }
        if (!s.fontHeading) s.fontHeading = 'Arial, sans-serif';
        if (!s.fontBody) s.fontBody = 'Arial, sans-serif';

        return s;
    }

    // ========================================================================
    // POSITION HELPERS (ported from canvas-mg-renderer.js)
    // ========================================================================

    static CANVAS_POS = {
        'center':       { anchorX: 0.5, anchorY: 0.5, padX: 0, padY: 0 },
        'bottom-left':  { anchorX: 0, anchorY: 1, padX: 60, padY: -120 },
        'bottom-right': { anchorX: 1, anchorY: 1, padX: -60, padY: -120 },
        'top':          { anchorX: 0.5, anchorY: 0, padX: 0, padY: 80 },
        'center-left':  { anchorX: 0, anchorY: 0.5, padX: 80, padY: 0 },
        'top-left':     { anchorX: 0, anchorY: 0, padX: 80, padY: 80 },
    };

    static _getPosXY(position, contentW, contentH) {
        const a = MGRenderer.CANVAS_POS[position] || MGRenderer.CANVAS_POS['center'];
        const x = a.anchorX * 1920 + a.padX - a.anchorX * contentW;
        const y = a.anchorY * 1080 + a.padY - a.anchorY * contentH;
        return { x, y };
    }

    // ========================================================================
    // DRAWING HELPERS (ported from canvas-mg-renderer.js)
    // ========================================================================

    static _setFont(ctx, weight, size, family) {
        const fam = (family || 'Arial, sans-serif').replace(/"/g, "'");
        ctx.font = `${weight} ${size}px ${fam}`;
    }

    static _drawTextShadowed(ctx, text, x, y, s, strong) {
        if (s.glow) {
            ctx.shadowColor = strong ? 'rgba(0,0,0,0.9)' : 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = strong ? 12 : 8;
            ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 2;
            ctx.fillText(text, x, y);
            ctx.shadowColor = s.primary + (strong ? '90' : '60');
            ctx.shadowBlur = strong ? 30 : 20;
            ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
            ctx.fillText(text, x, y);
            ctx.shadowColor = s.primary + (strong ? '40' : '25');
            ctx.shadowBlur = strong ? 60 : 40;
            ctx.fillText(text, x, y);
        } else {
            ctx.shadowColor = strong ? 'rgba(0,0,0,0.85)' : 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = strong ? 24 : 12;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = strong ? 4 : 2;
            ctx.fillText(text, x, y);
            ctx.shadowColor = strong ? 'rgba(0,0,0,0.5)' : 'rgba(0,0,0,0.4)';
            ctx.shadowBlur = strong ? 8 : 4;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = strong ? 2 : 1;
            ctx.fillText(text, x, y);
        }
        // Crisp text on top (no shadow)
        ctx.shadowColor = 'transparent';
        ctx.shadowBlur = 0;
        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
        ctx.fillText(text, x, y);
    }

    static _drawGradientRect(ctx, x, y, w, h, color1, color2, direction) {
        if (!direction) direction = 'horizontal';
        const grad = direction === 'horizontal'
            ? ctx.createLinearGradient(x, y, x + w, y)
            : ctx.createLinearGradient(x, y, x, y + h);
        grad.addColorStop(0, color1);
        grad.addColorStop(1, color2);
        ctx.fillStyle = grad;
        ctx.fillRect(x, y, w, h);
    }

    // ========================================================================
    // HEADLINE RENDERER (ported from canvas-mg-renderer.js renderHeadline)
    // ========================================================================

    _renderHeadline(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, speed } = anim;

        const scale = isExiting
            ? interpolate(exitProgress, [0, 1], [0.97, 1])
            : interpolate(enterSpring, [0, 1], [0.88, 1]);
        const translateY = isExiting
            ? interpolate(exitProgress, [0, 1], [-12, 0])
            : interpolate(enterSpring, [0, 1], [30, 0]);
        const blur = isExiting ? 0 : interpolate(enterLinear, [0, 0.6], [6, 0], { extrapolateRight: 'clamp' });

        // Accent bar — delay 0.25s, damping 20, duration 0.3s
        const barDelay = Math.round((0.25 / speed) * fps);
        const barSpring = springValue(Math.max(0, frame - barDelay), fps, {
            damping: 20, stiffness: 100, durationInFrames: Math.round((0.3 / speed) * fps),
        });
        const barWidth = barSpring * 300;

        // Subtext — delay 0.2s, damping 18
        const subDelay = Math.round(0.2 * fps);
        const subSpring = springValue(Math.max(0, frame - subDelay), fps, { damping: 18, stiffness: 100 });
        const subOpacity = isExiting ? exitProgress : subSpring;

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        // Position
        const pos = MGRenderer._getPosXY(mg.position || 'center', 800, 200);
        const cx = pos.x + 400;
        const cy = pos.y + 100;

        ctx.translate(cx, cy + translateY);
        ctx.scale(scale * idleScale, scale * idleScale);

        if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;

        // Main text
        MGRenderer._setFont(ctx, '900', 72, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        MGRenderer._drawTextShadowed(ctx, mg.text || '', 0, -30, s, true);

        ctx.filter = 'none';

        // Accent bar
        if (barWidth > 1) {
            MGRenderer._drawGradientRect(ctx, -barWidth / 2, 15, barWidth, 4, s.primary, s.accent);
        }

        // Subtext
        if (mg.subtext && subOpacity > 0.01) {
            ctx.globalAlpha = Math.min(1, opacity) * subOpacity;
            MGRenderer._setFont(ctx, '500', 26, s.fontBody);
            ctx.fillStyle = s.accent;
            MGRenderer._drawTextShadowed(ctx, mg.subtext, 0, 50, s, false);
        }

        ctx.restore();
    }

    /**
     * Cleanup resources.
     */
    destroy() {
        this._canvas = null;
        this._ctx = null;
    }
}

window.MGRenderer = MGRenderer;
