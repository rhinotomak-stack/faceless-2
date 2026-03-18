/**
 * MGRenderer.js — Motion Graphics renderer via Canvas2D -> WebGL texture
 * Renders MG overlays to an offscreen canvas, then uploads as a texture.
 *
 * All 14 canvas MG types ported from src/canvas-mg-renderer.js.
 */

class MGRenderer {
    constructor(textureManager, fps) {
        this.textureManager = textureManager;
        this.fps = fps;
        // Offscreen canvas for 2D drawing
        this._canvas = document.createElement('canvas');
        this._canvas.width = 1920;
        this._canvas.height = 1080;
        this._ctx = this._canvas.getContext('2d', { willReadFrequently: false });
        // Preview scale (1.0 = full, 0.5 = half-res for faster Canvas2D)
        this._previewScale = 1.0;
        // Cache for loaded map images (mapImageFile → HTMLImageElement)
        this._mapImages = {};
        this._mapImageLoading = {};
        // Cache for loaded explainer images (explainerImageFile → HTMLImageElement)
        this._explainerImages = {};
        this._explainerImageLoading = {};
        // Cache for loaded article images (articleImageFile → HTMLImageElement)
        this._articleImages = {};
        this._articleImageLoading = {};

        // ── Registry-driven rendering ──
        // Category renderers: 'mgType' → function(ctx, frame, fps, mg, s, anim, scriptContext)
        // Each category's main dispatcher (handles setup + variant resolution)
        this._categoryRenderers = {
            headline:       (ctx, f, fps, mg, s, a, sc) => this._renderHeadline(ctx, f, fps, mg, s, a),
            lowerThird:     (ctx, f, fps, mg, s, a, sc) => this._renderLowerThird(ctx, f, fps, mg, s, a),
            callout:        (ctx, f, fps, mg, s, a, sc) => this._renderCallout(ctx, f, fps, mg, s, a),
            focusWord:      (ctx, f, fps, mg, s, a, sc) => this._renderFocusWord(ctx, f, fps, mg, s, a),
            statCounter:    (ctx, f, fps, mg, s, a, sc) => this._renderStatCounter(ctx, f, fps, mg, s, a),
            bulletList:     (ctx, f, fps, mg, s, a, sc) => this._renderBulletList(ctx, f, fps, mg, s, a),
            progressBar:    (ctx, f, fps, mg, s, a, sc) => this._renderProgressBar(ctx, f, fps, mg, s, a),
            barChart:       (ctx, f, fps, mg, s, a, sc) => this._renderBarChart(ctx, f, fps, mg, s, a),
            donutChart:     (ctx, f, fps, mg, s, a, sc) => this._renderDonutChart(ctx, f, fps, mg, s, a),
            comparisonCard: (ctx, f, fps, mg, s, a, sc) => this._renderComparisonCard(ctx, f, fps, mg, s, a),
            timeline:       (ctx, f, fps, mg, s, a, sc) => this._renderTimeline(ctx, f, fps, mg, s, a),
            rankingList:    (ctx, f, fps, mg, s, a, sc) => this._renderRankingList(ctx, f, fps, mg, s, a),
            kineticText:    (ctx, f, fps, mg, s, a, sc) => this._renderKineticText(ctx, f, fps, mg, s, a),
            typewriter:     (ctx, f, fps, mg, s, a, sc) => this._renderTypewriter(ctx, f, fps, mg, s, a),
            subscribeCTA:   (ctx, f, fps, mg, s, a, sc) => this._renderSubscribeCTA(ctx, f, fps, mg, s, a),
            mapChart:       (ctx, f, fps, mg, s, a, sc) => { this._ensureMapImage(mg); this._renderMapChart(ctx, f, fps, mg, s, a, sc); },
            explainer:      (ctx, f, fps, mg, s, a, sc) => { this._ensureExplainerImage(mg); this._renderExplainer(ctx, f, fps, mg, s, a, sc); },
            articleHighlight: (ctx, f, fps, mg, s, a, sc) => { this._ensureArticleImage(mg); this._renderArticleHighlight(ctx, f, fps, mg, s, a); },
        };

        // Variant renderers: 'category:variant' → function(ctx, mg, s, anim, a, setup)
        // 'setup' is a category-specific context object (e.g. {bx, by, bw, bh, colors} for lowerThird)
        this._variantRenderers = {
            // Headline variants
            'headline:standard':    (ctx, mg, s, anim, a, p) => this._renderHL_Standard(ctx, mg, s, anim, a, p),
            'headline:stamp':       (ctx, mg, s, anim, a, p) => this._renderHL_Stamp(ctx, mg, s, anim, a, p),
            'headline:typewriter':  (ctx, mg, s, anim, a, p) => this._renderHL_Typewriter(ctx, mg, s, anim, a, p),
            // LowerThird variants
            'lowerThird:bar':       (ctx, mg, s, anim, a, p) => this._renderLT_Bar(ctx, mg, s, anim, a, p.bx, p.by, p.bw, p.bh, p.colors),
            'lowerThird:box':       (ctx, mg, s, anim, a, p) => this._renderLT_Box(ctx, mg, s, anim, a, p.bx, p.by, p.bw, p.bh, p.colors),
            'lowerThird:underline': (ctx, mg, s, anim, a, p) => this._renderLT_Underline(ctx, mg, s, anim, a, p.bx, p.by, p.bw, p.bh, p.colors),
            'lowerThird:banner':    (ctx, mg, s, anim, a, p) => this._renderLT_Banner(ctx, mg, s, anim, a, p.by, p.colors),
            'lowerThird:glass':     (ctx, mg, s, anim, a, p) => this._renderLT_Glass(ctx, mg, s, anim, a, p.bx, p.by, p.bw, p.bh, p.colors),
            'lowerThird:split':     (ctx, mg, s, anim, a, p) => this._renderLT_Split(ctx, mg, s, anim, a, p.bx, p.by, p.bw, p.bh, p.colors),
            // Callout variants
            'callout:standard':     (ctx, mg, s, anim, a, p) => this._renderCO_Standard(ctx, mg, s, anim, a, p),
            'callout:minimal':      (ctx, mg, s, anim, a, p) => this._renderCO_Minimal(ctx, mg, s, anim, a, p),
            'callout:accent':       (ctx, mg, s, anim, a, p) => this._renderCO_Accent(ctx, mg, s, anim, a, p),
            // StatCounter variants
            'statCounter:standard': (ctx, mg, s, anim, a, p) => this._renderSC_Standard(ctx, mg, s, anim, a, p),
            'statCounter:ticker':   (ctx, mg, s, anim, a, p) => this._renderSC_Ticker(ctx, mg, s, anim, a, p),
            'statCounter:ring':     (ctx, mg, s, anim, a, p) => this._renderSC_Ring(ctx, mg, s, anim, a, p),
            // Typewriter variants
            'typewriter:standard':  (ctx, mg, s, anim, a, p) => this._renderTW_Standard(ctx, mg, s, anim, a, p),
            'typewriter:naked':     (ctx, mg, s, anim, a, p) => this._renderTW_Naked(ctx, mg, s, anim, a, p),
        };

        // Animation computers: 'animType' → function(frame, fps, anim, mg) → state object
        this._animComputers = {
            slideLeft:   (f, fps, anim, mg) => this._computeAnim_slideLeft(f, fps, anim, mg),
            wipeRight:   (f, fps, anim, mg) => this._computeAnim_wipeRight(f, fps, anim, mg),
            popUp:       (f, fps, anim, mg) => this._computeAnim_popUp(f, fps, anim, mg),
            fadeSlide:   (f, fps, anim, mg) => this._computeAnim_fadeSlide(f, fps, anim, mg),
            springScale: (f, fps, anim, mg) => this._computeAnim_springScale(f, fps, anim, mg),
        };
    }

    // ── Public registration API ──
    // Call these to extend the renderer with new categories, variants, or animations
    // without editing any existing code.

    /**
     * Register a new MG category renderer.
     * @param {string} type - MG type key (e.g. 'myNewType')
     * @param {Function} fn - (ctx, frame, fps, mg, s, anim, scriptContext) => void
     */
    registerCategory(type, fn) {
        this._categoryRenderers[type] = fn;
    }

    /**
     * Register a variant renderer for a category.
     * @param {string} category - MG type key (e.g. 'lowerThird')
     * @param {string} variant - Variant key (e.g. 'military')
     * @param {Function} fn - (ctx, mg, s, anim, animState, setup) => void
     */
    registerVariant(category, variant, fn) {
        this._variantRenderers[`${category}:${variant}`] = fn;
    }

    /**
     * Register an animation computer.
     * @param {string} animType - Animation key (e.g. 'glitchIn')
     * @param {Function} fn - (frame, fps, anim, mg) => state object
     */
    registerAnimation(animType, fn) {
        this._animComputers[animType] = fn;
    }

    /**
     * Set preview scale. Resizes the offscreen canvas.
     * Drawing code still uses 1920x1080 coordinates via ctx.scale().
     */
    setPreviewScale(scale) {
        this._previewScale = Math.max(0.25, Math.min(1.0, scale));
        const w = Math.round(1920 * this._previewScale);
        const h = Math.round(1080 * this._previewScale);
        if (this._canvas.width !== w || this._canvas.height !== h) {
            this._canvas.width = w;
            this._canvas.height = h;
            console.log(`[MGRenderer] Canvas resized to ${w}x${h} (scale: ${this._previewScale})`);
        }
    }

    /**
     * Lazily load a map image for mapChart MGs. Non-blocking.
     * Once loaded, subsequent renders will draw it as background.
     */
    _ensureMapImage(mg) {
        const file = mg.mapImageFile;
        const url = mg._mapImageUrl;
        if (!file || this._mapImages[file] || this._mapImageLoading[file]) return;
        if (!url) return; // URL not yet resolved by app.js
        this._mapImageLoading[file] = true;
        const img = new Image();
        img.onload = () => {
            this._mapImages[file] = img;
            delete this._mapImageLoading[file];
            console.log(`[MGRenderer] Map image loaded: ${file}`);
        };
        img.onerror = () => {
            delete this._mapImageLoading[file];
            console.warn(`[MGRenderer] Failed to load map image: ${file}`);
        };
        img.src = url;
    }

    /**
     * Lazily load an article screenshot image. Non-blocking.
     */
    _ensureArticleImage(mg) {
        const file = mg.articleImageFile;
        const url = mg._articleImageUrl;
        if (!file || this._articleImages[file] || this._articleImageLoading[file]) return;
        if (!url) return;
        this._articleImageLoading[file] = true;
        const img = new Image();
        img.onload = () => {
            this._articleImages[file] = img;
            delete this._articleImageLoading[file];
            console.log(`[MGRenderer] Article image loaded: ${file}`);
        };
        img.onerror = () => {
            delete this._articleImageLoading[file];
            console.warn(`[MGRenderer] Failed to load article image: ${file}`);
        };
        img.src = url;
    }

    /**
     * Lazily load an explainer transparent PNG. Non-blocking.
     */
    _ensureExplainerImage(mg) {
        const file = mg.explainerImageFile;
        const url = mg._explainerImageUrl;
        if (!file || this._explainerImages[file] || this._explainerImageLoading[file]) return;
        if (!url) return; // URL not yet resolved by app.js
        this._explainerImageLoading[file] = true;
        const img = new Image();
        img.onload = () => {
            this._explainerImages[file] = img;
            delete this._explainerImageLoading[file];
            console.log(`[MGRenderer] Explainer image loaded: ${file}`);
        };
        img.onerror = () => {
            delete this._explainerImageLoading[file];
            console.warn(`[MGRenderer] Failed to load explainer image: ${file}`);
        };
        img.src = url;
    }

    /**
     * Render a motion graphic for the given local frame.
     * Returns a TextureManager entry { texture, width, height } or null.
     */
    renderMG(mg, localFrame, scriptContext) {
        const ctx = this._ctx;
        const s_ = this._previewScale;
        // Scale canvas context so all drawing code uses 1920x1080 coordinates
        ctx.setTransform(s_, 0, 0, s_, 0, 0);
        ctx.clearRect(0, 0, 1920, 1080);

        const s = this._getStyle(mg, scriptContext);
        const anim = AnimationUtils.computeAnimationState(localFrame, this.fps, {
            ...mg,
            _animationSpeed: mg._animationSpeed || 1.0,
        });

        // Draw MG background if set
        this._renderMGBackground(ctx, mg, anim);

        // Registry-driven dispatch — no switch needed
        const renderer = this._categoryRenderers[mg.type];
        let rendered = false;
        if (renderer) {
            renderer(ctx, localFrame, this.fps, mg, s, anim, scriptContext);
            rendered = true;
        } else if (mg.text) {
            // Fallback: render unknown MG types as a headline so text is visible
            this._renderHeadline(ctx, localFrame, this.fps, mg, s, anim);
            rendered = true;
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
        const baseS = (typeof MG_STYLES !== 'undefined' ? MG_STYLES[styleName] : null) || {
            primary: '#3b82f6', accent: '#f59e0b', bg: 'rgba(0,0,0,0.7)',
            text: '#ffffff', textSub: 'rgba(255,255,255,0.75)', glow: false,
        };

        let styled = null;
        if (typeof getStyledThemeColors === 'function') {
            styled = getStyledThemeColors(styleName);
        }
        const s = styled ? { ...baseS, ...styled } : { ...baseS };

        if (typeof getActiveThemeFonts === 'function') {
            const tf = getActiveThemeFonts();
            if (tf) {
                s.fontHeading = tf.heading.replace(/"/g, "'");
                s.fontBody = tf.body.replace(/"/g, "'");
            }
        }
        if (!s.fontHeading) s.fontHeading = 'Arial, sans-serif';
        if (!s.fontBody) s.fontBody = 'Arial, sans-serif';

        // Attach per-theme MG overrides (per-category)
        // Use the UI's active theme (dropdown) first, fall back to scriptContext
        const activeTheme = (typeof _resolveActiveTheme === 'function' && _resolveActiveTheme())
            || scriptContext?.themeId || null;
        if (window._themeTokens && activeTheme) {
            try {
                const tokens = window._themeTokens.getTokens(activeTheme);
                // Full per-category override map
                if (tokens?.chrome?.mgOverrides) {
                    s._mgOverrides = tokens.chrome.mgOverrides;
                }
                // _ltOverride kept for any external code that may read it
                if (tokens?.chrome?.lowerThirdOverride) {
                    s._ltOverride = tokens.chrome.lowerThirdOverride;
                }
            } catch (e) { /* ignore — fallback to style preset */ }
        }

        return s;
    }

    // ========================================================================
    // MG BACKGROUND RENDERING
    // ========================================================================

    _renderMGBackground(ctx, mg, anim) {
        const bg = mg.mgBackground;
        if (!bg || bg === 'none') return;

        const W = 1920, H = 1080;
        const alpha = Math.min(1, anim.opacity);

        ctx.save();

        if (bg === 'scrim-light') {
            ctx.fillStyle = `rgba(0,0,0,${(0.2 * alpha).toFixed(3)})`;
            ctx.fillRect(0, 0, W, H);
        } else if (bg === 'scrim') {
            ctx.fillStyle = `rgba(0,0,0,${(0.4 * alpha).toFixed(3)})`;
            ctx.fillRect(0, 0, W, H);
        } else if (bg === 'scrim-dark') {
            ctx.fillStyle = `rgba(0,0,0,${(0.6 * alpha).toFixed(3)})`;
            ctx.fillRect(0, 0, W, H);
        } else if (bg === 'solid-black') {
            ctx.globalAlpha = alpha;
            ctx.fillStyle = '#000000';
            ctx.fillRect(0, 0, W, H);
        } else if (bg === 'solid-dark') {
            ctx.globalAlpha = alpha;
            ctx.fillStyle = '#111111';
            ctx.fillRect(0, 0, W, H);
        } else if (bg.startsWith('gradient:')) {
            const gradientId = bg.replace('gradient:', '');
            const gradients = window.GRADIENT_BACKGROUNDS;
            const css = gradients ? gradients[gradientId] : null;
            if (css) {
                ctx.globalAlpha = alpha;
                this._drawCSSGradientOnCanvas(ctx, css, W, H);
            }
        }

        ctx.restore();
    }

    /**
     * Parse and draw a CSS gradient string onto a Canvas2D context.
     * Supports linear-gradient and radial-gradient with common syntax.
     */
    _drawCSSGradientOnCanvas(ctx, css, W, H) {
        // Split layered gradients (e.g., "repeating-linear-gradient(...), linear-gradient(...)")
        const layers = this._splitGradientLayers(css);
        // Draw back-to-front
        for (let i = layers.length - 1; i >= 0; i--) {
            this._drawSingleGradientOnCanvas(ctx, layers[i].trim(), W, H);
        }
    }

    _splitGradientLayers(css) {
        const layers = [];
        let depth = 0, start = 0;
        for (let i = 0; i < css.length; i++) {
            if (css[i] === '(') depth++;
            else if (css[i] === ')') depth--;
            else if (css[i] === ',' && depth === 0) {
                layers.push(css.slice(start, i));
                start = i + 1;
            }
        }
        layers.push(css.slice(start));
        return layers;
    }

    _drawSingleGradientOnCanvas(ctx, css, W, H) {
        const isRadial = css.startsWith('radial-gradient');
        const isLinear = css.startsWith('linear-gradient') || css.startsWith('repeating-linear-gradient');
        if (!isRadial && !isLinear) return;

        const inner = css.match(/\((.+)\)$/s);
        if (!inner) return;
        const content = inner[1];

        if (isLinear) {
            let angle = 180; // default: top to bottom
            let stopsStr = content;
            const angleMatch = content.match(/^(\d+)deg\s*,\s*/);
            if (angleMatch) {
                angle = parseFloat(angleMatch[1]);
                stopsStr = content.slice(angleMatch[0].length);
            }
            const rad = (angle - 90) * Math.PI / 180;
            const cx = W / 2, cy = H / 2;
            const len = Math.abs(W * Math.cos(rad)) + Math.abs(H * Math.sin(rad));
            const dx = Math.cos(rad) * len / 2;
            const dy = Math.sin(rad) * len / 2;
            const grad = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
            this._addStops(grad, stopsStr);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, W, H);
        } else {
            // Radial gradient
            let cx = W * 0.5, cy = H * 0.5;
            let stopsStr = content;
            const posMatch = content.match(/^ellipse\s+at\s+(\d+)%\s+(\d+)%\s*,\s*/);
            if (posMatch) {
                cx = W * parseFloat(posMatch[1]) / 100;
                cy = H * parseFloat(posMatch[2]) / 100;
                stopsStr = content.slice(posMatch[0].length);
            }
            const radius = Math.max(W, H);
            const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
            this._addStops(grad, stopsStr);
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, W, H);
        }
    }

    _addStops(grad, stopsStr) {
        const parts = stopsStr.split(/,(?![^(]*\))/);
        const stops = [];
        for (const p of parts) {
            const m = p.trim().match(/^(.+?)\s+(\d+(?:\.\d+)?)(%|px)?\s*$/);
            if (m) {
                stops.push({ color: m[1].trim(), pos: parseFloat(m[2]) / 100 });
            } else {
                stops.push({ color: p.trim(), pos: null });
            }
        }
        // Auto-distribute stops without explicit position
        for (let i = 0; i < stops.length; i++) {
            if (stops[i].pos === null) {
                if (i === 0) stops[i].pos = 0;
                else if (i === stops.length - 1) stops[i].pos = 1;
                else {
                    let prev = i - 1, next = i + 1;
                    while (next < stops.length && stops[next].pos === null) next++;
                    const p0 = stops[prev].pos || 0;
                    const p1 = (next < stops.length ? stops[next].pos : 1) || 1;
                    stops[i].pos = p0 + (p1 - p0) * (i - prev) / (next - prev);
                }
            }
        }
        for (const s of stops) {
            try { grad.addColorStop(Math.max(0, Math.min(1, s.pos)), s.color); } catch (e) { /* skip invalid */ }
        }
    }

    // ========================================================================
    // POSITION HELPERS
    // ========================================================================

    static CANVAS_POS = {
        'center':       { anchorX: 0.5, anchorY: 0.5, padX: 0, padY: 0 },
        'bottom-left':  { anchorX: 0, anchorY: 1, padX: 77, padY: -86 },
        'bottom-right': { anchorX: 1, anchorY: 1, padX: -77, padY: -86 },
        'top':          { anchorX: 0.5, anchorY: 0, padX: 0, padY: 54 },
        'center-left':  { anchorX: 0, anchorY: 0.5, padX: 96, padY: 0 },
        'top-left':     { anchorX: 0, anchorY: 0, padX: 77, padY: 54 },
    };

    static _getPosXY(position, contentW, contentH) {
        const a = MGRenderer.CANVAS_POS[position] || MGRenderer.CANVAS_POS['center'];
        const x = a.anchorX * 1920 + a.padX - a.anchorX * contentW;
        const y = a.anchorY * 1080 + a.padY - a.anchorY * contentH;
        return { x, y };
    }

    // ========================================================================
    // DRAWING HELPERS
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

    static _roundRect(ctx, x, y, w, h, r) {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.arcTo(x + w, y, x + w, y + r, r);
        ctx.lineTo(x + w, y + h - r);
        ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
        ctx.lineTo(x + r, y + h);
        ctx.arcTo(x, y + h, x, y + h - r, r);
        ctx.lineTo(x, y + r);
        ctx.arcTo(x, y, x + r, y, r);
        ctx.closePath();
    }

    static _parseKeyValuePairs(subtext) {
        if (!subtext || subtext === 'none') return [];
        const raw = subtext.split(',').map(s => s.trim()).filter(Boolean);
        const results = [];
        for (const part of raw) {
            const colonIdx = part.indexOf(':');
            if (colonIdx !== -1) {
                results.push({ label: part.substring(0, colonIdx).trim(), value: part.substring(colonIdx + 1).trim() });
            } else if (results.length > 0 && /^\d+$/.test(part.trim())) {
                results[results.length - 1].value += ',' + part.trim();
            } else if (part.trim()) {
                results.push({ label: part.trim(), value: '0' });
            }
        }
        return results;
    }

    static _wrapTextWords(ctx, text, maxWidth) {
        const words = text.split(/\s+/);
        if (words.length <= 1) return [text];
        const lines = [];
        let currentLine = words[0];
        for (let i = 1; i < words.length; i++) {
            const test = currentLine + ' ' + words[i];
            if (ctx.measureText(test).width <= maxWidth) {
                currentLine = test;
            } else {
                lines.push(currentLine);
                currentLine = words[i];
            }
        }
        lines.push(currentLine);
        return lines;
    }

    // ========================================================================
    // 1. HEADLINE
    // ========================================================================

    _renderHeadline(ctx, frame, fps, mg, s, anim) {
        const variant = this._resolveVariant(mg, s, 'headline');
        const animType = this._resolveAnimation(mg, s, 'headline');
        const colors = this._resolveColors(s, 'headline');

        // Shared position computation
        const position = mg.position || 'center';
        const isLeft = position.includes('left');
        const isRight = position.includes('right');

        MGRenderer._setFont(ctx, '900', 72, s.fontHeading);
        const textW = ctx.measureText(mg.text || '').width;
        const contentW = Math.max(800, textW + 40);
        const pos = MGRenderer._getPosXY(position, contentW, 200);

        let cx, textAlign;
        if (isLeft) {
            cx = pos.x + 20;
            textAlign = 'left';
        } else if (isRight) {
            cx = pos.x + contentW - 20;
            textAlign = 'right';
        } else {
            cx = pos.x + contentW / 2;
            textAlign = 'center';
        }
        const cy = pos.y + 100;

        const a = this._computeAnimation(animType, frame, fps, anim, mg);

        ctx.save();
        ctx.globalAlpha = Math.min(1, anim.isExiting ? anim.exitProgress : anim.opacity);

        this._dispatchVariant(ctx, 'headline', variant, mg, s, anim, a,
            { cx, cy, textAlign, contentW, colors, frame, fps });

        ctx.restore();
    }

    // ── Headline Variant: STANDARD (spring scale + gradient bar + subtext) ──
    _renderHL_Standard(ctx, mg, s, anim, a, p) {
        const { opacity, isExiting, exitProgress, idleScale } = anim;
        const scale = a.scale || 1;
        const translateY = a.slideY || 0;
        const blur = a.blur || 0;
        const barWidth = (a.barSpring || 0) * 300;
        const subOpacity = isExiting ? exitProgress : (a.subSpring || 0);

        ctx.translate(p.cx, p.cy + translateY);
        ctx.scale(scale * idleScale, scale * idleScale);

        if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;

        ctx.fillStyle = p.colors?.textFill || s.text;
        ctx.textAlign = p.textAlign;
        ctx.textBaseline = 'middle';
        MGRenderer._setFont(ctx, '900', 72, s.fontHeading);
        MGRenderer._drawTextShadowed(ctx, mg.text || '', 0, -30, s, true);

        ctx.filter = 'none';

        if (barWidth > 1) {
            const barX = p.textAlign === 'right' ? -barWidth : p.textAlign === 'center' ? -barWidth / 2 : 0;
            const barC1 = p.colors?.accentFill || s.primary;
            const barC2 = p.colors?.accentFill || s.accent;
            MGRenderer._drawGradientRect(ctx, barX, 15, barWidth, 4, barC1, barC2);
        }

        if (mg.subtext && subOpacity > 0.01) {
            ctx.globalAlpha = Math.min(1, opacity) * subOpacity;
            MGRenderer._setFont(ctx, '500', 26, s.fontBody);
            ctx.fillStyle = p.colors?.accentFill || s.accent;
            ctx.textAlign = p.textAlign;
            MGRenderer._drawTextShadowed(ctx, mg.subtext, 0, 50, s, false);
        }
    }

    // ── Headline Variant: STAMP (bold impact stamp with scale-bounce) ──
    _renderHL_Stamp(ctx, mg, s, anim, a, p) {
        const { opacity, isExiting, exitProgress, idleScale } = anim;
        // Stamp uses an aggressive bounce scale
        const stampScale = a.stampScale || 1;
        const stampAlpha = a.stampAlpha || 1;
        const subOpacity = isExiting ? exitProgress : (a.subSpring || 0);

        ctx.translate(p.cx, p.cy);
        ctx.scale(stampScale * idleScale, stampScale * idleScale);
        ctx.globalAlpha = Math.min(1, opacity) * stampAlpha;

        // Bold outline/shadow for stamp effect
        const accentColor = p.colors?.accentFill || s.primary;
        MGRenderer._setFont(ctx, '900', 82, s.fontHeading);
        ctx.textAlign = p.textAlign;
        ctx.textBaseline = 'middle';

        // Thick stroke outline
        ctx.strokeStyle = accentColor;
        ctx.lineWidth = 6;
        ctx.lineJoin = 'round';
        ctx.strokeText(mg.text || '', 0, -20);

        // Fill
        ctx.fillStyle = p.colors?.textFill || s.text;
        ctx.fillText(mg.text || '', 0, -20);

        // Accent line below
        const lineW = ctx.measureText(mg.text || '').width * 0.8;
        const lineX = p.textAlign === 'right' ? -lineW : p.textAlign === 'center' ? -lineW / 2 : 0;
        ctx.fillStyle = accentColor;
        ctx.fillRect(lineX, 25, lineW * Math.min(1, (a.textSpring || 1)), 5);

        if (mg.subtext && subOpacity > 0.01) {
            ctx.globalAlpha = Math.min(1, opacity) * subOpacity;
            MGRenderer._setFont(ctx, '600', 28, s.fontBody);
            ctx.fillStyle = p.colors?.accentFill || s.accent;
            ctx.textAlign = p.textAlign;
            ctx.fillText(mg.subtext, 0, 60);
        }
    }

    // ── Headline Variant: TYPEWRITER (character-by-character reveal with cursor) ──
    _renderHL_Typewriter(ctx, mg, s, anim, a, p) {
        const { opacity, isExiting, exitProgress, idleScale } = anim;
        const fullText = mg.text || '';
        const revealPct = a.revealProgress || 0;
        const charCount = Math.floor(fullText.length * Math.min(1, revealPct));
        const visibleText = fullText.substring(0, charCount);
        const subOpacity = isExiting ? exitProgress : (a.subSpring || 0);

        ctx.translate(p.cx, p.cy);
        ctx.scale(idleScale, idleScale);

        MGRenderer._setFont(ctx, '700', 68, s.fontHeading);
        ctx.fillStyle = p.colors?.textFill || s.text;
        ctx.textAlign = p.textAlign;
        ctx.textBaseline = 'middle';
        MGRenderer._drawTextShadowed(ctx, visibleText, 0, -25, s, true);

        // Blinking cursor
        const cursorW = ctx.measureText(visibleText).width;
        if (revealPct < 1.05) {
            const blink = Math.sin(p.frame * 0.3) > 0;
            if (blink) {
                const cursorX = p.textAlign === 'left' ? cursorW + 4
                    : p.textAlign === 'right' ? 4
                    : cursorW / 2 + 4;
                ctx.fillStyle = p.colors?.accentFill || s.primary;
                ctx.fillRect(cursorX, -55, 3, 60);
            }
        }

        if (mg.subtext && subOpacity > 0.01) {
            ctx.globalAlpha = Math.min(1, opacity) * subOpacity;
            MGRenderer._setFont(ctx, '500', 26, s.fontBody);
            ctx.fillStyle = p.colors?.accentFill || s.accent;
            ctx.textAlign = p.textAlign;
            MGRenderer._drawTextShadowed(ctx, mg.subtext, 0, 50, s, false);
        }
    }

    // ========================================================================
    // 2. LOWER THIRD
    // ========================================================================

    // ========================================================================
    // 2. LOWER THIRD — Multi-variant dispatcher
    // Variants: bar, box, underline, banner, glass, split
    // Animations: slideLeft, wipeRight, popUp, fadeSlide
    // ========================================================================

    // ── Generic variant dispatcher ──
    // Works for ANY category that has registered variants.
    // Categories without variants simply don't call this.
    //
    // To add variants to a new category (e.g. headline):
    //   1. Add types to MG_REGISTRY['headline'] in mg-registry.js
    //   2. Register variants: this.registerVariant('headline', 'stamp', fn)
    //   3. Define a setup function that returns category-specific context
    //   4. Call _dispatchVariant() from your category's main render method
    //
    _dispatchVariant(ctx, category, variant, mg, s, anim, animState, setup) {
        const key = `${category}:${variant}`;
        const fn = this._variantRenderers[key]
                || this._variantRenderers[`${category}:standard`]
                || this._variantRenderers[`${category}:bar`]; // lowerThird compat
        if (fn) {
            fn(ctx, mg, s, anim, animState, setup);
        }
    }

    // ── Compute animation from registry ──
    _computeAnimation(animType, frame, fps, anim, mg) {
        const computer = this._animComputers[animType] || this._animComputers['slideLeft'];
        return computer ? computer(frame, fps, anim, mg) : {};
    }

    // ── Resolve variant for any category ──
    // Priority: mg.subType (user) > theme override > style preset > registry default
    _resolveVariant(mg, s, category) {
        if (mg.subType) return mg.subType;
        const ov = s._mgOverrides?.[category];
        if (ov?.style) return ov.style;
        // Category-specific style preset fallback (lowerThird has lowerThirdStyle)
        if (category === 'lowerThird' && s.lowerThirdStyle) return s.lowerThirdStyle;
        // Registry default
        const reg = window._mgRegistry?.registry?.[category];
        return reg?.defaultType || 'standard';
    }

    // ── Resolve animation for any category ──
    _resolveAnimation(mg, s, category) {
        if (mg.animation) return mg.animation;
        const ov = s._mgOverrides?.[category];
        if (ov?.anim) return ov.anim;
        if (category === 'lowerThird' && s.lowerThirdAnimation) return s.lowerThirdAnimation;
        const reg = window._mgRegistry?.registry?.[category];
        const subType = this._resolveVariant(mg, s, category);
        return reg?.types?.[subType]?.animation || reg?.animations?.[0] || 'slideLeft';
    }

    // ── Resolve colors for any category ──
    _resolveColors(s, category) {
        return s._mgOverrides?.[category]?.colors || null;
    }

    // ── LowerThird setup + dispatch ──
    _renderLowerThird(ctx, frame, fps, mg, s, anim) {
        const variant = this._resolveVariant(mg, s, 'lowerThird');
        const animType = this._resolveAnimation(mg, s, 'lowerThird');
        const colors = this._resolveColors(s, 'lowerThird');

        // Measure text to compute dynamic box width
        const padding = 48;
        const minW = 250, maxW = 900;
        MGRenderer._setFont(ctx, '700', 36, s.fontHeading);
        const titleW = ctx.measureText(mg.text || '').width;
        MGRenderer._setFont(ctx, '500', 22, s.fontBody);
        const subW = mg.subtext ? ctx.measureText(mg.subtext).width : 0;
        const contentW = Math.max(titleW, subW);
        const boxW = Math.max(minW, Math.min(maxW, contentW + padding));
        const boxH = mg.subtext ? 100 : 70;
        const margin = 60;

        const pos = (mg.position || 'bottom-left').toLowerCase().replace(/\s+/g, '-');
        let baseX, baseY;
        if (pos.includes('top')) { baseY = margin + 20; }
        else { baseY = 1080 - boxH - margin; }
        if (pos.includes('right')) { baseX = 1920 - boxW - margin; }
        else if (pos === 'center' || pos === 'top' || pos === 'bottom') { baseX = (1920 - boxW) / 2; }
        else { baseX = margin; }

        const a = this._computeAnimation(animType, frame, fps, anim, mg);

        ctx.save();
        ctx.globalAlpha = Math.min(1, anim.isExiting ? anim.exitProgress : anim.opacity);

        this._dispatchVariant(ctx, 'lowerThird', variant, mg, s, anim, a,
            { bx: baseX, by: baseY, bw: boxW, bh: boxH, colors });

        ctx.restore();
    }

    // ── Individual animation computers (registered in constructor) ──
    // Each returns an animation state object used by variant renderers.
    // To add a new animation: add a method + register in constructor's _animComputers.

    _computeAnim_slideLeft(frame, fps, anim, mg) {
        const { springValue, interpolate } = AnimationUtils;
        const speed = anim.speed;
        const r = {};
        r.clipAmount = interpolate(anim.enterSpring, [0, 1], [0, 100]);
        r.barScaleY = springValue(Math.max(0, frame - Math.round((0.15 / speed) * fps)), fps, { damping: 20, stiffness: 120, durationInFrames: Math.round((0.35 / speed) * fps) });
        const td = Math.round((0.2 / speed) * fps);
        r.textSpring = springValue(Math.max(0, frame - td), fps, { damping: 18, stiffness: 100, durationInFrames: Math.round((0.3 / speed) * fps) });
        r.textSlideX = interpolate(r.textSpring, [0, 1], [-15, 0]);
        r.subSpring = springValue(Math.max(0, frame - Math.round((0.35 / speed) * fps)), fps, { damping: 18, stiffness: 100 });
        // Headline compat: provide scale/slideY/bar fields
        r.scale = interpolate(anim.enterSpring, [0, 1], [0.95, 1]);
        r.slideY = r.textSlideX; // slight slide
        r.barSpring = r.barScaleY;
        r.stampScale = r.scale;
        r.stampAlpha = interpolate(anim.enterLinear, [0, 0.15], [0, 1], { extrapolateRight: 'clamp' });
        r.revealProgress = interpolate(anim.enterLinear, [0, 1], [0, 1.1]);
        return r;
    }

    _computeAnim_wipeRight(frame, fps, anim, mg) {
        const { springValue, interpolate } = AnimationUtils;
        const speed = anim.speed;
        const r = {};
        r.wipeProgress = interpolate(anim.enterSpring, [0, 1], [0, 1]);
        const td = Math.round((0.25 / speed) * fps);
        r.textSpring = springValue(Math.max(0, frame - td), fps, { damping: 16, stiffness: 90, durationInFrames: Math.round((0.3 / speed) * fps) });
        r.textSlideX = interpolate(r.textSpring, [0, 1], [-20, 0]);
        r.subSpring = springValue(Math.max(0, frame - Math.round((0.4 / speed) * fps)), fps, { damping: 18, stiffness: 100 });
        // Headline compat
        r.scale = interpolate(anim.enterSpring, [0, 1], [0.95, 1]);
        r.slideY = 0;
        r.barSpring = r.textSpring;
        r.stampScale = r.scale;
        r.stampAlpha = interpolate(anim.enterLinear, [0, 0.15], [0, 1], { extrapolateRight: 'clamp' });
        r.revealProgress = interpolate(anim.enterLinear, [0, 1], [0, 1.1]);
        return r;
    }

    _computeAnim_popUp(frame, fps, anim, mg) {
        const { springValue, interpolate } = AnimationUtils;
        const speed = anim.speed;
        const r = {};
        r.scaleY = springValue(frame, fps, { damping: 12, stiffness: 150, durationInFrames: Math.round((0.4 / speed) * fps) });
        r.scale = r.scaleY; // alias for headline variants
        r.stampScale = r.scaleY;
        r.stampAlpha = interpolate(anim.enterLinear, [0, 0.1], [0, 1], { extrapolateRight: 'clamp' });
        r.slideY = interpolate(r.scaleY, [0, 1], [40, 0]);
        const td = Math.round((0.15 / speed) * fps);
        r.textSpring = springValue(Math.max(0, frame - td), fps, { damping: 18, stiffness: 100, durationInFrames: Math.round((0.3 / speed) * fps) });
        r.textSlideX = 0;
        r.subSpring = springValue(Math.max(0, frame - Math.round((0.3 / speed) * fps)), fps, { damping: 18, stiffness: 100 });
        r.revealProgress = interpolate(anim.enterLinear, [0, 1], [0, 1.1]);
        r.barSpring = r.textSpring;
        return r;
    }

    _computeAnim_fadeSlide(frame, fps, anim, mg) {
        const { interpolate } = AnimationUtils;
        const r = {};
        r.fadeIn = interpolate(anim.enterLinear, [0, 0.6], [0, 1], { extrapolateRight: 'clamp' });
        r.slideY = interpolate(anim.enterSpring, [0, 1], [20, 0]);
        r.textSpring = r.fadeIn;
        r.textSlideX = 0;
        r.subSpring = interpolate(anim.enterLinear, [0.2, 0.8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        // Headline compat
        r.scale = 1;
        r.barSpring = r.textSpring;
        r.stampScale = 1;
        r.stampAlpha = r.fadeIn;
        r.revealProgress = interpolate(anim.enterLinear, [0, 1], [0, 1.1]);
        return r;
    }

    // ── springScale animation (default for headline:standard) ──
    // Produces: scale, slideY, blur, barSpring, subSpring — used by headline variants
    _computeAnim_springScale(frame, fps, anim, mg) {
        const { springValue, interpolate } = AnimationUtils;
        const speed = anim.speed;
        const r = {};
        r.scale = anim.isExiting
            ? interpolate(anim.exitProgress, [0, 1], [0.97, 1])
            : interpolate(anim.enterSpring, [0, 1], [0.88, 1]);
        r.slideY = anim.isExiting
            ? interpolate(anim.exitProgress, [0, 1], [-12, 0])
            : interpolate(anim.enterSpring, [0, 1], [30, 0]);
        r.blur = anim.isExiting ? 0 : interpolate(anim.enterLinear, [0, 0.6], [6, 0], { extrapolateRight: 'clamp' });
        const barDelay = Math.round((0.25 / speed) * fps);
        r.barSpring = springValue(Math.max(0, frame - barDelay), fps, {
            damping: 20, stiffness: 100, durationInFrames: Math.round((0.3 / speed) * fps),
        });
        const subDelay = Math.round((0.2 / speed) * fps);
        r.subSpring = anim.isExiting ? anim.exitProgress
            : springValue(Math.max(0, frame - subDelay), fps, { damping: 18, stiffness: 100 });
        r.textSpring = r.barSpring;
        // Stamp-specific: aggressive bounce scale for stamp variant
        r.stampScale = anim.isExiting
            ? interpolate(anim.exitProgress, [0, 1], [0.5, 1])
            : springValue(frame, fps, { damping: 8, stiffness: 200, durationInFrames: Math.round((0.35 / speed) * fps) });
        r.stampAlpha = interpolate(anim.enterLinear, [0, 0.15], [0, 1], { extrapolateRight: 'clamp' });
        // Typewriter-specific: character reveal
        const revealDur = Math.round((1.2 / speed) * fps);
        r.revealProgress = Math.min(1.1, frame / Math.max(1, revealDur));
        return r;
    }

    // ── Variant: BAR (thin vertical gradient bar + text) ──
    // Used by: tech, neutral
    _renderLT_Bar(ctx, mg, s, anim, a, bx, by, bw, bh, colors) {
        const { opacity, isExiting, exitProgress } = anim;

        ctx.beginPath();
        ctx.rect(bx, by - 20, bw * ((a.clipAmount || 100) / 100), bh + 40);
        ctx.clip();

        // Accent bar
        const accentH = 120 * (a.barScaleY || 1);
        const barColor1 = colors?.accentFill || s.primary;
        const barColor2 = colors?.accentFill || s.accent;
        MGRenderer._drawGradientRect(ctx, bx, by + bh / 2 - accentH / 2, 4, accentH, barColor1, barColor2, 'vertical');

        // Main text
        MGRenderer._setFont(ctx, '700', 36, s.fontHeading);
        ctx.fillStyle = colors?.textFill || s.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.globalAlpha = Math.min(1, opacity) * (a.textSpring || 1);
        MGRenderer._drawTextShadowed(ctx, mg.text || '', bx + 20 + (a.textSlideX || 0), by + 10, s, true);

        // Subtext
        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : (a.subSpring || 0));
            MGRenderer._setFont(ctx, '500', 22, s.fontBody);
            ctx.fillStyle = colors?.accentFill || s.accent;
            MGRenderer._drawTextShadowed(ctx, mg.subtext, bx + 20, by + 55, s, false);
        }
    }

    // ── Variant: BOX (solid colored background rectangle) ──
    // Used by: corporate
    _renderLT_Box(ctx, mg, s, anim, a, bx, by, bw, bh, colors) {
        const { opacity, isExiting, exitProgress } = anim;
        const hasSub = !!mg.subtext;
        const totalH = hasSub ? bh + 15 : bh - 10;

        // Clip for slideLeft entrance
        if (a.clipAmount !== undefined) {
            ctx.beginPath();
            ctx.rect(bx - 5, by - 5, (bw + 10) * (a.clipAmount / 100), totalH + 10);
            ctx.clip();
        }

        // Background box
        const bgColor = colors?.bgFill || s.primary;
        const radius = s.borderRadius || 8;
        MGRenderer._roundRect(ctx, bx, by, bw, totalH, radius);
        ctx.fillStyle = bgColor;
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 16;
        ctx.shadowOffsetY = 4;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Main text
        MGRenderer._setFont(ctx, '700', 36, s.fontHeading);
        ctx.fillStyle = colors?.textFill || '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.globalAlpha = Math.min(1, opacity) * (a.textSpring || 1);
        ctx.fillText(mg.text || '', bx + 24 + (a.textSlideX || 0), by + 18);

        // Subtext
        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : (a.subSpring || 0));
            MGRenderer._setFont(ctx, '500', 20, s.fontBody);
            ctx.fillStyle = (colors?.accentFill || s.accent);
            ctx.fillText(mg.subtext, bx + 24, by + 62);
        }
    }

    // ── Variant: UNDERLINE (text with animated gradient underline) ──
    // Used by: nature
    _renderLT_Underline(ctx, mg, s, anim, a, bx, by, bw, bh, colors) {
        const { opacity, isExiting, exitProgress } = anim;
        const slideY = a.slideY || 0;
        const fadeIn = a.fadeIn !== undefined ? a.fadeIn : 1;

        ctx.globalAlpha = Math.min(1, opacity) * fadeIn;

        // Main text
        MGRenderer._setFont(ctx, '700', 36, s.fontHeading);
        ctx.fillStyle = colors?.textFill || s.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        const textY = by + 10 + slideY;
        MGRenderer._drawTextShadowed(ctx, mg.text || '', bx, textY, s, true);

        // Measure text for underline width
        const textW = ctx.measureText(mg.text || '').width;
        const underlineW = Math.min(textW + 10, bw) * (a.textSpring || 0);
        if (underlineW > 1) {
            const c1 = colors?.accentFill || s.primary;
            const c2 = colors?.accentFill || s.accent;
            MGRenderer._drawGradientRect(ctx, bx, textY + 44, underlineW, 3, c1, c2);
        }

        // Subtext
        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : (a.subSpring || 0));
            MGRenderer._setFont(ctx, '500', 22, s.fontBody);
            ctx.fillStyle = colors?.accentFill || s.accent;
            MGRenderer._drawTextShadowed(ctx, mg.subtext, bx, textY + 54, s, false);
        }
    }

    // ── Variant: BANNER (full-width broadcast bar with accent stripe) ──
    // Used by: crime (red bg, white text)
    _renderLT_Banner(ctx, mg, s, anim, a, baseY, colors) {
        const { opacity, isExiting, exitProgress } = anim;
        const hasSub = !!mg.subtext;
        const bannerH = hasSub ? 80 : 60;
        const stripeH = 4;

        // Wipe entrance: clip from left
        const wipe = a.wipeProgress !== undefined ? a.wipeProgress : 1;
        if (wipe < 1) {
            ctx.beginPath();
            ctx.rect(0, baseY - stripeH, 1920 * wipe, bannerH + stripeH + 2);
            ctx.clip();
        }

        // Main banner fill
        const bgColor = colors?.bgFill || s.primary;
        ctx.fillStyle = bgColor;
        ctx.fillRect(0, baseY, 1920, bannerH);

        // Top accent stripe
        const stripeColor = colors?.accentFill || s.accent;
        ctx.fillStyle = stripeColor;
        ctx.fillRect(0, baseY - stripeH, 1920, stripeH);

        // Main text (left-aligned)
        ctx.globalAlpha = Math.min(1, opacity) * (a.textSpring || 1);
        MGRenderer._setFont(ctx, '700', hasSub ? 30 : 34, s.fontHeading);
        ctx.fillStyle = colors?.textFill || '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(mg.text || '', 50 + (a.textSlideX || 0), baseY + (hasSub ? 8 : 14));

        // Subtext (below main text or right-aligned)
        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : (a.subSpring || 0));
            MGRenderer._setFont(ctx, '500', 20, s.fontBody);
            ctx.fillStyle = (colors?.textFill || '#ffffff') + 'cc';
            ctx.fillText(mg.subtext, 50, baseY + 44);
        }
    }

    // ── Variant: GLASS (frosted semi-transparent box with border) ──
    // Used by: luxury
    _renderLT_Glass(ctx, mg, s, anim, a, bx, by, bw, bh, colors) {
        const { opacity, isExiting, exitProgress } = anim;
        const slideY = a.slideY || 0;
        const fadeIn = a.fadeIn !== undefined ? a.fadeIn : 1;
        const hasSub = !!mg.subtext;
        const totalH = hasSub ? bh + 15 : bh - 10;
        const radius = s.borderRadius || 14;

        ctx.globalAlpha = Math.min(1, opacity) * fadeIn;

        // Glass background
        MGRenderer._roundRect(ctx, bx, by + slideY, bw, totalH, radius);
        ctx.fillStyle = colors?.bgFill || 'rgba(10,10,20,0.6)';
        ctx.shadowColor = (colors?.accentFill || s.primary) + '30';
        ctx.shadowBlur = 20;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Border
        MGRenderer._roundRect(ctx, bx, by + slideY, bw, totalH, radius);
        ctx.strokeStyle = (colors?.accentFill || s.primary) + '50';
        ctx.lineWidth = 1.5;
        ctx.stroke();

        // Inner highlight line at top
        ctx.beginPath();
        ctx.moveTo(bx + radius, by + slideY + 1);
        ctx.lineTo(bx + bw - radius, by + slideY + 1);
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Main text
        MGRenderer._setFont(ctx, '600', 34, s.fontHeading);
        ctx.fillStyle = colors?.textFill || s.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.globalAlpha = Math.min(1, opacity) * (a.textSpring || fadeIn);
        MGRenderer._drawTextShadowed(ctx, mg.text || '', bx + 24, by + slideY + 16, s, true);

        // Subtext
        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : (a.subSpring || 0));
            MGRenderer._setFont(ctx, '400', 20, s.fontBody);
            ctx.fillStyle = colors?.accentFill || s.accent;
            ctx.fillText(mg.subtext, bx + 24, by + slideY + 58);
        }
    }

    // ── Variant: SPLIT (two-tone: colored left label + dark right name) ──
    // Used by: sport
    _renderLT_Split(ctx, mg, s, anim, a, bx, by, bw, bh, colors) {
        const { opacity, isExiting, exitProgress } = anim;
        const slideY = a.slideY || 0;
        const scaleY = a.scaleY !== undefined ? a.scaleY : 1;
        // Measure left label to size it dynamically
        MGRenderer._setFont(ctx, '800', 16, s.fontHeading);
        const labelText = (mg.subtext || 'INFO').toUpperCase();
        const labelW = ctx.measureText(labelText).width;
        const leftW = Math.max(80, labelW + 40);
        // Measure right name text
        MGRenderer._setFont(ctx, '700', 32, s.fontHeading);
        const nameW = ctx.measureText(mg.text || '').width;
        const rightW = Math.max(120, nameW + 44);
        const totalH = bh - 15;
        const radius = s.borderRadius || 8;
        const drawY = by + slideY;

        ctx.globalAlpha = Math.min(1, opacity) * scaleY;

        // Shadow
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 16;
        ctx.shadowOffsetY = 4;

        // Left colored section (rounded left corners)
        ctx.beginPath();
        ctx.moveTo(bx + radius, drawY);
        ctx.lineTo(bx + leftW, drawY);
        ctx.lineTo(bx + leftW, drawY + totalH);
        ctx.lineTo(bx + radius, drawY + totalH);
        ctx.arcTo(bx, drawY + totalH, bx, drawY + totalH - radius, radius);
        ctx.lineTo(bx, drawY + radius);
        ctx.arcTo(bx, drawY, bx + radius, drawY, radius);
        ctx.closePath();
        ctx.fillStyle = colors?.bgFill || s.primary;
        ctx.fill();

        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Right dark section (rounded right corners)
        ctx.beginPath();
        ctx.moveTo(bx + leftW, drawY);
        ctx.lineTo(bx + leftW + rightW - radius, drawY);
        ctx.arcTo(bx + leftW + rightW, drawY, bx + leftW + rightW, drawY + radius, radius);
        ctx.lineTo(bx + leftW + rightW, drawY + totalH - radius);
        ctx.arcTo(bx + leftW + rightW, drawY + totalH, bx + leftW + rightW - radius, drawY + totalH, radius);
        ctx.lineTo(bx + leftW, drawY + totalH);
        ctx.closePath();
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.fill();

        // Left label text (subtext or category, uppercase) — labelText already measured above
        ctx.globalAlpha = Math.min(1, opacity) * (a.textSpring || scaleY);
        MGRenderer._setFont(ctx, '800', 16, s.fontHeading);
        ctx.fillStyle = colors?.textFill || '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(labelText, bx + leftW / 2, drawY + totalH / 2);

        // Right name text
        MGRenderer._setFont(ctx, '700', 32, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(mg.text || '', bx + leftW + 20 + (a.textSlideX || 0), drawY + totalH / 2);
    }

    // ========================================================================
    // 3. STAT COUNTER — dispatcher + 3 variants
    // ========================================================================

    // ── StatCounter setup + dispatch ──
    _renderStatCounter(ctx, frame, fps, mg, s, anim) {
        const { interpolate } = AnimationUtils;
        const { isExiting, exitProgress, opacity, idleScale, enterFrames, totalFrames, enterSpring, enterLinear } = anim;

        const variant = this._resolveVariant(mg, s, 'statCounter');
        const colors = this._resolveColors(s, 'statCounter');

        // Parse number, prefix, suffix from text
        const numberMatch = (mg.text || '').match(/[\d,.]+/);
        const targetNumber = numberMatch ? parseFloat(numberMatch[0].replace(/,/g, '')) : 0;
        const prefix = (mg.text || '').substring(0, (mg.text || '').indexOf(numberMatch?.[0] || '')).trim();
        const suffix = (mg.text || '').substring((mg.text || '').indexOf(numberMatch?.[0] || '') + (numberMatch?.[0]?.length || 0)).trim();
        const isPercent = suffix.includes('%') || prefix.includes('%');

        // Smooth count-up with easeOutQuart (slower decel than cubic)
        const countStart = Math.round(enterFrames * 0.3);
        const countEnd = Math.max(countStart + 1, Math.min(enterFrames + Math.round(fps * 1.5), totalFrames - 15));
        const rawCount = interpolate(frame, [countStart, countEnd], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const easeOutQuart = t => 1 - Math.pow(1 - t, 4);
        const countProgress = easeOutQuart(rawCount);

        const currentNumber = targetNumber % 1 !== 0
            ? (targetNumber * countProgress).toFixed(1)
            : Math.round(targetNumber * countProgress).toLocaleString();

        // Entrance animation — simple scale+fade, no animation computer needed
        const entScale = interpolate(enterSpring, [0, 1], [0.85, 1]);
        const entSlideY = interpolate(enterSpring, [0, 1], [20, 0]);
        const entBlur = interpolate(enterLinear, [0, 0.5], [5, 0], { extrapolateRight: 'clamp' });
        const labelSpring = interpolate(enterLinear, [0.3, 0.8], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const scale = entScale * (isExiting ? interpolate(exitProgress, [0, 1], [0.95, 1]) : 1);

        // Box dimensions
        const boxW = variant === 'ticker' ? 500 : 400;
        const boxH = variant === 'ring' ? 260 : 150;
        const pos = MGRenderer._getPosXY(mg.position || 'center', boxW, boxH);

        ctx.save();
        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);

        this._dispatchVariant(ctx, 'statCounter', variant, mg, s, anim, null, {
            bx: pos.x, by: pos.y, bw: boxW, bh: boxH, colors,
            currentNumber, prefix, suffix, countProgress, targetNumber, isPercent,
            scale, entSlideY, entBlur, labelSpring, idleScale,
            label: suffix || mg.subtext || '',
        });

        ctx.restore();
    }

    // ── StatCounter variant: Standard (big centered number + label below) ──
    _renderSC_Standard(ctx, mg, s, anim, _a, setup) {
        const { bx, by, bw, bh, colors, currentNumber, prefix, label,
                scale, entSlideY, entBlur, labelSpring, idleScale } = setup;
        const { opacity } = anim;

        const accentFill = colors?.accentFill || s.accent;
        const textFill = colors?.textFill || s.text;

        const cx = bx + bw / 2;
        const cy = by + bh / 2;

        ctx.translate(cx, cy + entSlideY);
        ctx.scale(scale * idleScale, scale * idleScale);
        if (entBlur > 0.5) ctx.filter = `blur(${entBlur.toFixed(1)}px)`;

        // Number
        MGRenderer._setFont(ctx, '900', 96, s.fontHeading);
        ctx.fillStyle = accentFill;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.85)';
        ctx.shadowBlur = 12;
        ctx.shadowOffsetY = 4;
        ctx.fillText(`${prefix}${currentNumber}`, 0, -10);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        ctx.filter = 'none';

        // Label
        if (label) {
            ctx.globalAlpha = Math.min(1, opacity) * labelSpring;
            MGRenderer._setFont(ctx, '600', 28, s.fontBody);
            ctx.fillStyle = textFill;
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = 4;
            ctx.fillText(label, 0, 50);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }
    }

    // ── StatCounter variant: Ticker (horizontal card — number left, label right) ──
    _renderSC_Ticker(ctx, mg, s, anim, _a, setup) {
        const { bx, by, bw, bh, colors, currentNumber, prefix, label,
                scale, entSlideY, entBlur, labelSpring, idleScale } = setup;
        const { opacity } = anim;

        const bgFill = colors?.bgFill || s.bg;
        const accentFill = colors?.accentFill || s.accent;
        const textFill = colors?.textFill || s.text;

        const cx = bx + bw / 2;
        const cy = by + bh / 2;

        ctx.translate(cx, cy + entSlideY);
        ctx.scale(scale * idleScale, scale * idleScale);
        if (entBlur > 0.5) ctx.filter = `blur(${entBlur.toFixed(1)}px)`;

        // Card background
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 14;
        ctx.shadowOffsetY = 3;
        MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 10);
        ctx.fillStyle = bgFill;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Left accent stripe
        ctx.fillStyle = accentFill;
        MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, 5, bh, 3);
        ctx.fill();

        ctx.filter = 'none';

        // Number on left
        MGRenderer._setFont(ctx, '900', 72, s.fontHeading);
        ctx.fillStyle = accentFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${prefix}${currentNumber}`, -bw / 2 + 24, 0);

        // Vertical separator
        const numW = ctx.measureText(`${prefix}${currentNumber}`).width;
        const sepX = -bw / 2 + 24 + numW + 20;
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(sepX, -bh / 2 + 16);
        ctx.lineTo(sepX, bh / 2 - 16);
        ctx.stroke();

        // Label on right
        if (label) {
            ctx.globalAlpha = Math.min(1, opacity) * labelSpring;
            MGRenderer._setFont(ctx, '600', 26, s.fontBody);
            ctx.fillStyle = textFill;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, sepX + 16, 0);
        }
    }

    // ── StatCounter variant: Ring (circular progress arc around number) ──
    _renderSC_Ring(ctx, mg, s, anim, _a, setup) {
        const { bx, by, bw, bh, colors, currentNumber, prefix, label, countProgress,
                targetNumber, isPercent, scale, entSlideY, entBlur, labelSpring, idleScale } = setup;
        const { opacity } = anim;

        const accentFill = colors?.accentFill || s.accent;
        const textFill = colors?.textFill || s.text;

        const cx = bx + bw / 2;
        const cy = by + bh / 2 - 20;

        ctx.translate(cx, cy + entSlideY);
        ctx.scale(scale * idleScale, scale * idleScale);
        if (entBlur > 0.5) ctx.filter = `blur(${entBlur.toFixed(1)}px)`;

        // Ring parameters
        const ringR = 80;
        const ringW = 8;
        const arcFill = isPercent ? countProgress * (targetNumber / 100) : countProgress;

        // Background ring (track)
        ctx.beginPath();
        ctx.arc(0, 0, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = ringW;
        ctx.stroke();

        // Progress ring — fills clockwise from top
        if (countProgress > 0) {
            const startAngle = -Math.PI / 2;
            const endAngle = startAngle + (Math.PI * 2 * Math.min(1, arcFill));
            ctx.beginPath();
            ctx.arc(0, 0, ringR, startAngle, endAngle);
            ctx.strokeStyle = accentFill;
            ctx.lineWidth = ringW;
            ctx.lineCap = 'round';
            ctx.stroke();
        }

        ctx.filter = 'none';

        // Number inside ring
        MGRenderer._setFont(ctx, '900', 64, s.fontHeading);
        ctx.fillStyle = accentFill;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = 8;
        ctx.fillText(`${prefix}${currentNumber}`, 0, 0);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Label below ring
        if (label) {
            ctx.globalAlpha = Math.min(1, opacity) * labelSpring;
            MGRenderer._setFont(ctx, '600', 26, s.fontBody);
            ctx.fillStyle = textFill;
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = 4;
            ctx.fillText(label, 0, ringR + 36);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }
    }

    // ========================================================================
    // 4. CALLOUT
    // ========================================================================

    // ── Callout setup + dispatch (same pattern as lowerThird) ──
    _renderCallout(ctx, frame, fps, mg, s, anim) {
        const variant = this._resolveVariant(mg, s, 'callout');
        const animType = this._resolveAnimation(mg, s, 'callout');
        const colors = this._resolveColors(s, 'callout');

        // Measure text for dynamic box sizing
        MGRenderer._setFont(ctx, 'italic 600', 34, s.fontHeading);
        const textWidth = Math.min(ctx.measureText(mg.text || '').width + 80, 1920 * 0.7);
        const boxW = Math.max(400, textWidth);
        const boxH = mg.subtext ? 160 : 120;
        const pos = MGRenderer._getPosXY(mg.position || 'center', boxW, boxH);

        const a = this._computeAnimation(animType, frame, fps, anim, mg);

        ctx.save();
        ctx.globalAlpha = Math.min(1, anim.isExiting ? anim.exitProgress : anim.opacity);

        this._dispatchVariant(ctx, 'callout', variant, mg, s, anim, a,
            { bx: pos.x, by: pos.y, bw: boxW, bh: boxH, colors });

        ctx.restore();
    }

    // ── Callout variant: Standard (quote box with decorative quote mark) ──
    _renderCO_Standard(ctx, mg, s, anim, a, setup) {
        const { bx, by, bw, bh, colors } = setup;
        const { interpolate } = AnimationUtils;
        const { isExiting, exitProgress, opacity, idleScale } = anim;

        const bgFill = colors?.bgFill || s.bg;
        const textFill = colors?.textFill || s.text;
        const accentFill = colors?.accentFill || s.primary;
        const subFill = colors?.textFill || s.textSub || 'rgba(255,255,255,0.75)';

        const scale = (a.scale || 1) * (isExiting ? interpolate(exitProgress, [0, 1], [0.97, 1]) : 1);

        ctx.translate(bx + bw / 2, by + bh / 2 + (a.slideY || 0));
        ctx.scale(scale * idleScale, scale * idleScale);
        if (a.blur > 0.5) ctx.filter = `blur(${a.blur.toFixed(1)}px)`;

        if (s.glow) {
            ctx.shadowColor = accentFill + '30';
            ctx.shadowBlur = 10;
        } else {
            ctx.shadowColor = 'rgba(0,0,0,0.4)';
            ctx.shadowBlur = 16;
            ctx.shadowOffsetY = 4;
        }
        MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 12);
        ctx.fillStyle = bgFill;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
        ctx.strokeStyle = accentFill;
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.filter = 'none';

        // Quote mark with staggered entrance
        ctx.globalAlpha = Math.min(1, opacity) * (a.subSpring || 1) * 0.6;
        MGRenderer._setFont(ctx, '900', 64, s.fontHeading);
        ctx.fillStyle = accentFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('\u201C', -bw / 2 + 20, -bh / 2 - 24);

        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);
        MGRenderer._setFont(ctx, 'italic 600', 34, s.fontHeading);
        ctx.fillStyle = textFill;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 4;
        ctx.fillText(mg.text || '', (a.textSlideX || 0), mg.subtext ? -15 : 0);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (a.subSpring || 1);
            MGRenderer._setFont(ctx, '500', 20, s.fontBody);
            ctx.fillStyle = subFill;
            ctx.fillText(`\u2014 ${mg.subtext}`, 0, bh / 2 - 30);
        }
    }

    // ── Callout variant: Minimal (clean text, thin bottom line, no quote mark) ──
    _renderCO_Minimal(ctx, mg, s, anim, a, setup) {
        const { bx, by, bw, bh, colors } = setup;
        const { isExiting, exitProgress, opacity, idleScale } = anim;

        const textFill = colors?.textFill || s.text;
        const accentFill = colors?.accentFill || s.primary;
        const subFill = colors?.textFill || s.textSub || 'rgba(255,255,255,0.75)';

        const scale = (a.scale || 1) * (isExiting ? 0.97 + exitProgress * 0.03 : 1);

        ctx.translate(bx + bw / 2, by + bh / 2 + (a.slideY || 0));
        ctx.scale(scale * idleScale, scale * idleScale);
        if (a.blur > 0.5) ctx.filter = `blur(${a.blur.toFixed(1)}px)`;

        // Subtle frosted background — barely there
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 6);
        ctx.fill();

        ctx.filter = 'none';

        // Main text — clean, no italic
        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);
        MGRenderer._setFont(ctx, '600', 34, s.fontHeading);
        ctx.fillStyle = textFill;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 4;
        ctx.fillText(mg.text || '', (a.textSlideX || 0), mg.subtext ? -15 : 0);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Animated underline
        const lineW = bw * 0.6 * (a.clipX != null ? a.clipX : (a.subSpring || 1));
        ctx.strokeStyle = accentFill;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-lineW / 2, bh / 2 - 45);
        ctx.lineTo(lineW / 2, bh / 2 - 45);
        ctx.stroke();

        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (a.subSpring || 1);
            MGRenderer._setFont(ctx, '400', 20, s.fontBody);
            ctx.fillStyle = subFill;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(mg.subtext, 0, bh / 2 - 25);
        }
    }

    // ── Callout variant: Accent (left accent bar, blockquote style) ──
    _renderCO_Accent(ctx, mg, s, anim, a, setup) {
        const { bx, by, bw, bh, colors } = setup;
        const { interpolate } = AnimationUtils;
        const { isExiting, exitProgress, opacity, idleScale } = anim;

        const bgFill = colors?.bgFill || s.bg;
        const textFill = colors?.textFill || s.text;
        const accentFill = colors?.accentFill || s.primary;
        const subFill = colors?.textFill || s.textSub || 'rgba(255,255,255,0.75)';

        const scale = (a.scale || 1) * (isExiting ? interpolate(exitProgress, [0, 1], [0.97, 1]) : 1);

        ctx.translate(bx + bw / 2, by + bh / 2 + (a.slideY || 0));
        ctx.scale(scale * idleScale, scale * idleScale);
        if (a.blur > 0.5) ctx.filter = `blur(${a.blur.toFixed(1)}px)`;

        // Dark background card
        ctx.shadowColor = 'rgba(0,0,0,0.5)';
        ctx.shadowBlur = 12;
        ctx.shadowOffsetY = 3;
        MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 8);
        ctx.fillStyle = bgFill;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Left accent bar — animated height via clipX/subSpring
        const barW = 5;
        const barH = bh * (a.clipX != null ? a.clipX : (a.subSpring || 1));
        ctx.fillStyle = accentFill;
        MGRenderer._roundRect(ctx, -bw / 2, -barH / 2, barW, barH, 3);
        ctx.fill();

        ctx.filter = 'none';

        // Main text — left-aligned, offset from accent bar
        const textX = -bw / 2 + 28;
        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);
        MGRenderer._setFont(ctx, 'italic 600', 34, s.fontHeading);
        ctx.fillStyle = textFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 4;
        ctx.fillText(mg.text || '', textX + (a.textSlideX || 0), mg.subtext ? -15 : 0);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (a.subSpring || 1);
            MGRenderer._setFont(ctx, '500', 20, s.fontBody);
            ctx.fillStyle = subFill;
            ctx.textAlign = 'left';
            ctx.fillText(`\u2014 ${mg.subtext}`, textX, bh / 2 - 30);
        }
    }

    // ========================================================================
    // 5. BULLET LIST
    // ========================================================================

    _renderBulletList(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;

        // Parse items from subtext (label:value pairs) — same as rankingList/barChart/etc.
        let items = MGRenderer._parseKeyValuePairs(mg.subtext);
        // Fallback: split mg.text by commas if no subtext items
        if (items.length === 0 && mg.text) {
            items = (mg.text || '').split(/[,;]|\d+\.\s/).map(t => t.trim()).filter(Boolean)
                .map(t => ({ label: t, value: '' }));
        }
        const staggerDelay = Math.round(fps * 0.25);
        const maxItems = Math.min(items.length, 8);
        const rowH = 55;
        const listW = 1920 * 0.55;
        const titleH = mg.text && items.length > 0 && items[0].label !== mg.text ? 60 : 0;
        const totalH = titleH + maxItems * rowH;
        const dotR = 7;

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        const pos = MGRenderer._getPosXY(mg.position || 'center-left', listW, totalH);
        ctx.translate(pos.x, pos.y);
        ctx.scale(idleScale, idleScale);

        // Heading (mg.text) — only if different from first item
        if (titleH > 0) {
            MGRenderer._setFont(ctx, '700', 36, s.fontHeading);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 6;
            ctx.fillText(mg.text, 0, 0);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }

        items.slice(0, maxItems).forEach((item, i) => {
            const rowDelay = Math.round(enterFrames * 0.2 + i * staggerDelay);
            const rowSpring = springValue(Math.max(0, frame - rowDelay), fps, { damping: 16, stiffness: 120 });
            const slideX = interpolate(rowSpring, [0, 1], [50, 0]);
            const rowBlur = interpolate(rowSpring, [0, 0.5], [3, 0], { extrapolateRight: 'clamp' });
            const ry = titleH + i * rowH;

            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : rowSpring);

            ctx.save();
            if (rowBlur > 0.5) ctx.filter = `blur(${rowBlur.toFixed(1)}px)`;

            // Accent bullet dot
            ctx.beginPath();
            ctx.arc(dotR + slideX, ry + rowH / 2, dotR, 0, Math.PI * 2);
            ctx.fillStyle = s.accent;
            ctx.fill();

            // Label text — clean rendering (no glow passes)
            MGRenderer._setFont(ctx, '600', 28, s.fontBody);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = 4;
            ctx.fillText(item.label, dotR * 2 + 16 + slideX, ry + rowH / 2);

            // Value on the right (if present)
            if (item.value && item.value !== '0') {
                MGRenderer._setFont(ctx, '700', 24, s.fontHeading);
                ctx.fillStyle = s.accent;
                ctx.textAlign = 'right';
                ctx.fillText(item.value, listW + slideX, ry + rowH / 2);
            }

            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            // Subtle separator line
            if (i < maxItems - 1) {
                ctx.fillStyle = 'rgba(255,255,255,0.08)';
                ctx.fillRect(dotR * 2 + 16 + slideX, ry + rowH - 2, listW - dotR * 2 - 16, 1);
            }

            ctx.filter = 'none';
            ctx.restore();
        });

        ctx.restore();
    }

    // ========================================================================
    // 6. FOCUS WORD
    // ========================================================================

    _renderFocusWord(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterLinear, isExiting, exitProgress, opacity } = anim;
        const speed = mg._animationSpeed || 1.0;

        const snapSpring = springValue(frame, fps, { damping: 20, stiffness: 250, durationInFrames: Math.round((0.4 / speed) * fps) });
        const scale = isExiting
            ? interpolate(exitProgress, [0, 1], [1.3, 1])
            : interpolate(snapSpring, [0, 1], [1.8, 1]);
        const blur = isExiting
            ? interpolate(exitProgress, [0, 1], [6, 0])
            : interpolate(enterLinear, [0, 0.3], [8, 0], { extrapolateRight: 'clamp' });
        const letterSpacing = interpolate(snapSpring, [0, 1], [20, 2]);
        const scrimOpacity = interpolate(enterLinear, [0, 0.15], [0, 0.3], { extrapolateRight: 'clamp' }) * (isExiting ? exitProgress : 1);

        ctx.save();

        // Dark scrim overlay
        ctx.fillStyle = `rgba(0,0,0,${scrimOpacity.toFixed(3)})`;
        ctx.fillRect(0, 0, 1920, 1080);

        ctx.globalAlpha = Math.min(1, opacity);
        ctx.translate(1920 / 2, 1080 / 2);
        ctx.scale(scale, scale);
        if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;

        const word = (mg.text || '').toUpperCase();

        const maxTextWidth = 1920 * 0.8;
        let fontSize = 96;
        MGRenderer._setFont(ctx, '900', fontSize, s.fontHeading);
        let lines = MGRenderer._wrapTextWords(ctx, word, maxTextWidth);
        while (lines.length > 2 && fontSize > 48) {
            fontSize -= 4;
            MGRenderer._setFont(ctx, '900', fontSize, s.fontHeading);
            lines = MGRenderer._wrapTextWords(ctx, word, maxTextWidth);
        }

        ctx.fillStyle = s.accent;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        const lineHeight = fontSize * 1.1;
        const totalTextHeight = lines.length * lineHeight;
        const startY = -totalTextHeight / 2 + lineHeight / 2;

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
            const lineText = lines[lineIdx];
            const lineY = startY + lineIdx * lineHeight;

            if (letterSpacing > 3) {
                const chars = lineText.split('');
                const charWidths = chars.map(c => ctx.measureText(c).width);
                const totalW = charWidths.reduce((a, b) => a + b, 0) + (chars.length - 1) * letterSpacing;
                let cx = -totalW / 2;
                for (let i = 0; i < chars.length; i++) {
                    const charX = cx + charWidths[i] / 2;
                    if (s.glow) {
                        ctx.shadowColor = s.accent + '40';
                        ctx.shadowBlur = 80;
                        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0;
                        ctx.fillText(chars[i], charX, lineY);
                        ctx.shadowColor = s.accent + 'cc';
                        ctx.shadowBlur = 40;
                        ctx.fillText(chars[i], charX, lineY);
                    } else {
                        ctx.shadowColor = 'rgba(0,0,0,0.9)';
                        ctx.shadowBlur = 30;
                        ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 4;
                        ctx.fillText(chars[i], charX, lineY);
                    }
                    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
                    ctx.fillText(chars[i], charX, lineY);
                    cx += charWidths[i] + letterSpacing;
                }
            } else {
                MGRenderer._drawTextShadowed(ctx, lineText, 0, lineY, s, true);
            }
        }

        ctx.filter = 'none';

        if (mg.subtext) {
            const subOpacity = interpolate(enterLinear, [0.5, 0.75], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
                * (isExiting ? exitProgress : 1);
            ctx.globalAlpha = Math.min(1, opacity) * subOpacity;
            MGRenderer._setFont(ctx, '500', 28, s.fontBody);
            ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.75)';
            const subY = startY + lines.length * lineHeight + 20;
            MGRenderer._drawTextShadowed(ctx, mg.subtext, 0, subY, s, false);
        }

        ctx.restore();
    }

    // ========================================================================
    // 7. PROGRESS BAR
    // ========================================================================

    _renderProgressBar(ctx, frame, fps, mg, s, anim) {
        const { interpolate, easeOutCubic } = AnimationUtils;
        const { isExiting, exitProgress, opacity, idleScale, enterFrames, totalFrames } = anim;

        // Use animation system — respects user's animation dropdown choice
        const animType = this._resolveAnimation(mg, s, 'progressBar');
        const a = this._computeAnimation(animType, frame, fps, anim, mg);

        const numMatch = (mg.text || '').match(/[\d,.]+/);
        const targetPct = numMatch ? Math.min(100, parseFloat(numMatch[0].replace(/,/g, ''))) : 75;
        const label = (mg.text || '').replace(/[\d,.]+%?/, '').trim() || mg.subtext || '';

        const fillStart = Math.round(enterFrames * 0.5);
        const fillEnd = Math.max(fillStart + 1, Math.min(enterFrames + Math.round(fps * 0.3), totalFrames - 15));
        const fillProgress = easeOutCubic(interpolate(frame, [fillStart, fillEnd], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
        const currentPct = Math.round(targetPct * fillProgress);

        const scale = (a.scale || 1) * (isExiting ? interpolate(exitProgress, [0, 1], [0.97, 1]) : 1);

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        const barW = 1920 * 0.6;
        const pos = MGRenderer._getPosXY(mg.position || 'center', barW, 120);
        const cx = pos.x + barW / 2;
        const cy = pos.y + 60;

        ctx.translate(cx, cy + (a.slideY || 0));
        ctx.scale(scale * idleScale, scale * idleScale);

        // Label — clean rendering
        if (label) {
            MGRenderer._setFont(ctx, '700', 28, s.fontBody);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = 4;
            ctx.fillText(label, 0, -40);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }

        const trackW = barW;
        const trackH = 24;
        MGRenderer._roundRect(ctx, -trackW / 2, -trackH / 2, trackW, trackH, 12);
        ctx.fillStyle = 'rgba(255,255,255,0.1)';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.1)';
        ctx.lineWidth = 1;
        ctx.stroke();

        const fillW = trackW * (targetPct * fillProgress / 100);
        if (fillW > 1) {
            MGRenderer._roundRect(ctx, -trackW / 2, -trackH / 2, fillW, trackH, 12);
            const grad = ctx.createLinearGradient(-trackW / 2, 0, -trackW / 2 + fillW, 0);
            grad.addColorStop(0, s.primary);
            grad.addColorStop(1, s.accent);
            ctx.fillStyle = grad;
            if (s.glow) { ctx.shadowColor = s.primary + '80'; ctx.shadowBlur = 16; }
            ctx.fill();
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }

        // Percentage — clean rendering
        MGRenderer._setFont(ctx, '900', 48, s.fontHeading);
        ctx.fillStyle = s.accent;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.85)';
        ctx.shadowBlur = 8;
        ctx.shadowOffsetY = 3;
        ctx.fillText(`${currentPct}%`, 0, 45);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        ctx.restore();
    }

    // ========================================================================
    // 8. BAR CHART
    // ========================================================================

    _renderBarChart(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate, easeOutCubic } = AnimationUtils;
        const { enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
        const items = MGRenderer._parseKeyValuePairs(mg.subtext);
        const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
        const staggerDelay = Math.round(fps * 0.15);
        const barCount = Math.min(items.length, 6);

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        const chartW = 1920 * 0.6;
        const chartH = 300;
        const pos = MGRenderer._getPosXY(mg.position || 'center', chartW, chartH + 80);
        const cx = pos.x + chartW / 2;
        const topY = pos.y;

        ctx.translate(cx, topY);
        ctx.scale(idleScale, idleScale);

        // Title — clean rendering
        MGRenderer._setFont(ctx, '700', 36, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 6;
        ctx.fillText(mg.text || '', 0, 0);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        const barAreaW = chartW;
        const barGap = 20;
        const singleBarW = (barAreaW - (barCount - 1) * barGap) / barCount;
        const barAreaTop = 60;
        const barAreaH = chartH;

        for (let i = 0; i < barCount; i++) {
            const item = items[i];
            const barDelay = Math.round(enterFrames * 0.3 + i * staggerDelay);
            const barSpring = springValue(Math.max(0, frame - barDelay), fps, { damping: 14, stiffness: 80 });
            const numVal = parseFloat(item.value) || 0;
            const heightPct = (numVal / maxVal);
            const barH = heightPct * barSpring * (barAreaH - 40);
            const bx = -barAreaW / 2 + i * (singleBarW + barGap);
            const by = barAreaTop + barAreaH - barH;

            const valDelay = barDelay + Math.round(fps * 0.2);
            const valOpacity = interpolate(frame, [valDelay, valDelay + Math.round(fps * 0.15)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : valOpacity);
            // Value label — clean rendering
            MGRenderer._setFont(ctx, '700', 24, s.fontHeading);
            ctx.fillStyle = s.accent;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = 4;
            ctx.fillText(item.value, bx + singleBarW / 2, by - 6);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            ctx.globalAlpha = Math.min(1, opacity);
            if (barH > 0) {
                const grad = ctx.createLinearGradient(0, by, 0, by + barH);
                grad.addColorStop(0, s.accent);
                grad.addColorStop(1, s.primary);
                ctx.fillStyle = grad;
                MGRenderer._roundRect(ctx, bx, by, singleBarW, barH, 6);
                if (s.glow) { ctx.shadowColor = s.primary + '60'; ctx.shadowBlur = 12; }
                ctx.fill();
                ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
            }

            MGRenderer._setFont(ctx, '500', 18, s.fontBody);
            ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.75)';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillText(item.label, bx + singleBarW / 2, barAreaTop + barAreaH + 8);
        }

        ctx.restore();
    }

    // ========================================================================
    // 9. DONUT CHART
    // ========================================================================

    _renderDonutChart(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate, easeOutCubic } = AnimationUtils;
        const { enterSpring, enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
        const items = MGRenderer._parseKeyValuePairs(mg.subtext);
        const total = items.reduce((sum, i) => sum + (parseFloat(i.value) || 0), 0) || 100;
        const radius = 100;
        const strokeWidth = 30;
        const staggerDelay = Math.round(fps * 0.2);
        const segColors = [s.primary, s.accent, s.primary + 'bb', s.accent + 'bb', s.primary + '88'];

        const scale = isExiting
            ? interpolate(exitProgress, [0, 1], [0.95, 1])
            : interpolate(enterSpring, [0, 1], [0.7, 1]);

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        const pos = MGRenderer._getPosXY(mg.position || 'center', 520, 300);

        ctx.translate(pos.x + 260, pos.y + 150);
        ctx.scale(scale * idleScale, scale * idleScale);

        // Title — clean rendering
        MGRenderer._setFont(ctx, '700', 32, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 6;
        ctx.fillText(mg.text || '', 0, -140);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        ctx.lineWidth = strokeWidth;
        ctx.lineCap = 'round';
        let cumulativeAngle = -Math.PI / 2;

        items.slice(0, 5).forEach((item, i) => {
            const pct = (parseFloat(item.value) || 0) / total;
            const segAngle = pct * Math.PI * 2;
            const drawDelay = Math.round(enterFrames * 0.2 + i * staggerDelay);
            const drawProgress = easeOutCubic(interpolate(frame, [drawDelay, drawDelay + Math.round(fps * 0.5)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
            const drawAngle = segAngle * drawProgress;

            if (drawAngle > 0.01) {
                ctx.beginPath();
                ctx.arc(-130, 20, radius, cumulativeAngle, cumulativeAngle + drawAngle);
                ctx.strokeStyle = segColors[i % segColors.length];
                ctx.stroke();
            }
            cumulativeAngle += segAngle;
        });

        const centerDelay = Math.round(enterFrames * 0.4);
        const centerOpacity = interpolate(frame, [centerDelay, centerDelay + Math.round(fps * 0.3)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : centerOpacity);
        // Center percentage — clean rendering
        MGRenderer._setFont(ctx, '900', 36, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = 4;
        const mainPct = items.length > 0 ? Math.round((parseFloat(items[0].value) || 0) / total * 100) : 0;
        ctx.fillText(`${mainPct}%`, -130, 20);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        items.slice(0, 5).forEach((item, i) => {
            const legendDelay = Math.round(enterFrames * 0.5 + i * Math.round(fps * 0.12));
            const legendOpacity = interpolate(frame, [legendDelay, legendDelay + Math.round(fps * 0.2)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : legendOpacity);

            const ly = -40 + i * 30;
            ctx.beginPath();
            ctx.arc(30, ly, 7, 0, Math.PI * 2);
            ctx.fillStyle = segColors[i % segColors.length];
            ctx.fill();
            MGRenderer._setFont(ctx, '500', 20, s.fontBody);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(item.label, 45, ly);
            ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.75)';
            MGRenderer._setFont(ctx, '600', 20, s.fontBody);
            ctx.fillText(`${item.value}%`, 45 + ctx.measureText(item.label).width + 10, ly);
        });

        ctx.restore();
    }

    // ========================================================================
    // 10. COMPARISON CARD
    // ========================================================================

    _renderComparisonCard(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterSpring, isExiting, exitProgress, opacity, idleScale, speed } = anim;

        const parts = (mg.text || '').split(/\s+vs\.?\s+/i);
        const itemA = parts[0] || 'A';
        const itemB = parts[1] || 'B';

        const slideX = isExiting
            ? interpolate(exitProgress, [0, 1], [60, 0])
            : interpolate(enterSpring, [0, 1], [200, 0]);

        const vsDelay = Math.round((0.3 / speed) * fps);
        const vsSpring = springValue(Math.max(0, frame - vsDelay), fps, { damping: 12, stiffness: 150, durationInFrames: Math.round((0.4 / speed) * fps) });

        const subDelay = Math.round((0.5 / speed) * fps);
        const subOpacity = interpolate(frame, [subDelay, subDelay + Math.round((0.3 / speed) * fps)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        const boxW = 1920 * 0.35;
        const boxH = 120;
        const gap = 100;
        const totalW = boxW * 2 + gap;
        const pos = MGRenderer._getPosXY(mg.position || 'center', totalW, boxH);
        const cx = pos.x + totalW / 2;
        const cy = pos.y + boxH / 2;

        ctx.translate(cx, cy);
        ctx.scale(idleScale, idleScale);

        // Left box
        ctx.save();
        ctx.translate(-boxW / 2 - gap / 2 - slideX, 0);
        MGRenderer._roundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, 16);
        ctx.fillStyle = s.primary + '25';
        ctx.fill();
        ctx.strokeStyle = s.primary + '40';
        ctx.lineWidth = 2;
        ctx.stroke();
        // Item A text — clean rendering (has card background, no glow needed)
        MGRenderer._setFont(ctx, '800', 42, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = 6;
        ctx.fillText(itemA.toUpperCase(), 0, 0);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        ctx.restore();

        // Right box
        ctx.save();
        ctx.translate(boxW / 2 + gap / 2 + slideX, 0);
        MGRenderer._roundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, 16);
        ctx.fillStyle = s.accent + '25';
        ctx.fill();
        ctx.strokeStyle = s.accent + '40';
        ctx.lineWidth = 2;
        ctx.stroke();
        // Item B text — clean rendering
        MGRenderer._setFont(ctx, '800', 42, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.7)';
        ctx.shadowBlur = 6;
        ctx.fillText(itemB.toUpperCase(), 0, 0);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        ctx.restore();

        // VS circle
        ctx.save();
        ctx.scale(vsSpring, vsSpring);
        ctx.beginPath();
        ctx.arc(0, 0, 40, 0, Math.PI * 2);
        const vsGrad = ctx.createLinearGradient(-40, -40, 40, 40);
        vsGrad.addColorStop(0, s.primary);
        vsGrad.addColorStop(1, s.accent);
        ctx.fillStyle = vsGrad;
        if (s.glow) { ctx.shadowColor = s.primary + '80'; ctx.shadowBlur = 24; }
        else { ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 20; }
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        MGRenderer._setFont(ctx, '900', 28, s.fontHeading);
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('VS', 0, 0);
        ctx.restore();

        // Subtext — clean rendering
        if (mg.subtext && mg.subtext !== 'none') {
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : subOpacity);
            MGRenderer._setFont(ctx, '500', 22, s.fontBody);
            ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.75)';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.6)';
            ctx.shadowBlur = 3;
            ctx.fillText(mg.subtext, 0, boxH / 2 + 40);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }

        ctx.restore();
    }

    // ========================================================================
    // 11. TIMELINE
    // ========================================================================

    _renderTimeline(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterSpring, enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
        let items = MGRenderer._parseKeyValuePairs(mg.subtext);
        const staggerDelay = Math.round(fps * 0.25);
        const lineWidth = interpolate(enterSpring, [0, 1], [0, 100]);

        // If no subtext items, try to extract date range from title text
        if (items.length === 0 && mg.text) {
            const dateMatch = mg.text.match(/(\d{4})s?\s*[\u2192\-\u2013\u2014to]+\s*(\d{4})s?/i);
            if (dateMatch) {
                const startYear = parseInt(dateMatch[1]);
                const endYear = parseInt(dateMatch[2]);
                const span = endYear - startYear;
                const step = span <= 20 ? 5 : span <= 50 ? 10 : 20;
                for (let y = startYear; y <= endYear; y += step) {
                    items.push({ label: String(y) + 's', value: '' });
                }
                if (items.length > 0 && parseInt(items[items.length - 1].label) < endYear) {
                    items.push({ label: String(endYear) + 's', value: '' });
                }
            }
        }

        const tlW = 1920 * 0.80;

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        // Center everything on screen
        ctx.translate(960, 540);
        ctx.scale(idleScale, idleScale);

        // Title — clean text shadow, no glow
        if (mg.text) {
            MGRenderer._setFont(ctx, '700', 46, s.fontHeading);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = 8;
            ctx.shadowOffsetY = 2;
            ctx.fillText(mg.text, 0, -120);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
        }

        // Thin gradient timeline line
        const lineH = 3;
        const lineW = tlW * lineWidth / 100;
        if (lineW > 0) {
            const lineGrad = ctx.createLinearGradient(-tlW / 2, 0, -tlW / 2 + lineW, 0);
            lineGrad.addColorStop(0, s.primary);
            lineGrad.addColorStop(1, s.accent);
            ctx.fillStyle = lineGrad;
            ctx.fillRect(-tlW / 2, -lineH / 2, lineW, lineH);
        }

        // Markers along the line
        const dotR = 9;
        items.slice(0, 6).forEach((item, i) => {
            const pct = items.length > 1 ? i / (items.length - 1) : 0.5;
            const mx = -tlW / 2 + pct * tlW;
            const markerDelay = Math.round(enterFrames * 0.3 + i * staggerDelay);
            const markerSpring = springValue(Math.max(0, frame - markerDelay), fps, { damping: 16, stiffness: 120 });
            const slideY = interpolate(markerSpring, [0, 1], [-12, 0]);

            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : markerSpring);

            // Dot — filled circle with dark ring for contrast against line
            ctx.beginPath();
            ctx.arc(mx, slideY, dotR, 0, Math.PI * 2);
            ctx.fillStyle = s.accent;
            ctx.fill();
            // Dark ring to separate dot from line
            ctx.strokeStyle = 'rgba(0,0,0,0.5)';
            ctx.lineWidth = 2;
            ctx.stroke();
            // Subtle outer glow
            if (s.glow) {
                ctx.beginPath();
                ctx.arc(mx, slideY, dotR + 3, 0, Math.PI * 2);
                ctx.strokeStyle = s.accent + '30';
                ctx.lineWidth = 2;
                ctx.stroke();
            }

            // Year/label above the dot
            MGRenderer._setFont(ctx, '700', 25, s.fontHeading);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 4;
            ctx.fillText(item.label, mx, -dotR - 18 + slideY);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            // Event text below the dot
            if (item.value) {
                MGRenderer._setFont(ctx, '500', 21, s.fontBody);
                ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.75)';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                ctx.shadowColor = 'rgba(0,0,0,0.6)';
                ctx.shadowBlur = 3;
                const maxEventW = items.length > 1 ? tlW / items.length * 0.85 : tlW * 0.5;
                const eventLines = MGRenderer._wrapTextWords(ctx, item.value, maxEventW);
                for (let li = 0; li < eventLines.length; li++) {
                    ctx.fillText(eventLines[li], mx, dotR + 18 + slideY + li * 26);
                }
                ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
            }
        });

        ctx.restore();
    }

    // ========================================================================
    // 11b. TYPEWRITER — dispatcher + 2 variants
    // ========================================================================

    _renderTypewriter(ctx, frame, fps, mg, s, anim) {
        const variant = this._resolveVariant(mg, s, 'typewriter');
        const animType = this._resolveAnimation(mg, s, 'typewriter');
        const colors = this._resolveColors(s, 'typewriter');

        const a = this._computeAnimation(animType, frame, fps, anim, mg);

        const fullText = mg.text || '';
        const revealPct = a.revealProgress || 0;
        const charCount = Math.floor(fullText.length * Math.min(1, revealPct));
        const visibleText = fullText.substring(0, charCount);

        // Box sizing
        MGRenderer._setFont(ctx, '700', 42, s.fontHeading);
        const fullW = Math.min(ctx.measureText(fullText).width + 60, 1920 * 0.75);
        const boxW = Math.max(350, fullW);
        const boxH = mg.subtext ? 130 : 90;
        const pos = MGRenderer._getPosXY(mg.position || 'center', boxW, boxH);

        ctx.save();
        ctx.globalAlpha = Math.min(1, anim.isExiting ? anim.exitProgress : anim.opacity);

        this._dispatchVariant(ctx, 'typewriter', variant, mg, s, anim, a, {
            bx: pos.x, by: pos.y, bw: boxW, bh: boxH, colors,
            visibleText, fullText, revealPct, charCount,
        });

        ctx.restore();
    }

    // ── Typewriter variant: Standard (dark backdrop + text + cursor) ──
    _renderTW_Standard(ctx, mg, s, anim, a, setup) {
        const { bx, by, bw, bh, colors, visibleText, revealPct } = setup;
        const { interpolate } = AnimationUtils;
        const { opacity, idleScale } = anim;

        const bgFill = colors?.bgFill || s.bg || 'rgba(0,0,0,0.65)';
        const textFill = colors?.textFill || s.text;
        const accentFill = colors?.accentFill || s.primary;
        const subFill = colors?.textFill || s.textSub || 'rgba(255,255,255,0.7)';

        const cx = bx + bw / 2;
        const cy = by + bh / 2 + (a.slideY || 0);
        ctx.translate(cx, cy);
        ctx.scale(idleScale, idleScale);

        // Dark backdrop
        ctx.shadowColor = 'rgba(0,0,0,0.4)';
        ctx.shadowBlur = 12;
        ctx.fillStyle = bgFill;
        MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 8);
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Accent bottom line
        ctx.fillStyle = accentFill;
        ctx.fillRect(-bw / 2, bh / 2 - 3, bw, 3);

        // Main text
        MGRenderer._setFont(ctx, '700', 42, s.fontHeading);
        ctx.fillStyle = textFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.6)';
        ctx.shadowBlur = 4;
        const textX = -bw / 2 + 28;
        const textY = mg.subtext ? -12 : 0;
        ctx.fillText(visibleText, textX, textY);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        // Blinking cursor
        this._drawTW_Cursor(ctx, textX, textY, visibleText, accentFill, revealPct, a);

        // Subtext
        if (mg.subtext) {
            const subAlpha = interpolate(revealPct, [0.7, 1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            ctx.globalAlpha = Math.min(1, opacity) * subAlpha;
            MGRenderer._setFont(ctx, '500', 22, s.fontBody);
            ctx.fillStyle = subFill;
            ctx.textAlign = 'left';
            ctx.fillText(mg.subtext, textX, bh / 2 - 24);
        }
    }

    // ── Typewriter variant: Naked (no background, just text + cursor + shadow) ──
    _renderTW_Naked(ctx, mg, s, anim, a, setup) {
        const { bx, by, bw, bh, colors, visibleText, revealPct } = setup;
        const { interpolate } = AnimationUtils;
        const { opacity, idleScale } = anim;

        const textFill = colors?.textFill || s.text;
        const accentFill = colors?.accentFill || s.primary;
        const subFill = colors?.textFill || s.textSub || 'rgba(255,255,255,0.7)';

        const cx = bx + bw / 2;
        const cy = by + bh / 2 + (a.slideY || 0);
        ctx.translate(cx, cy);
        ctx.scale(idleScale, idleScale);

        // Main text — no background, stronger shadow for readability
        MGRenderer._setFont(ctx, '700', 46, s.fontHeading);
        ctx.fillStyle = textFill;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.shadowColor = 'rgba(0,0,0,0.85)';
        ctx.shadowBlur = 10;
        ctx.shadowOffsetY = 3;
        const textX = -bw / 2 + 28;
        const textY = mg.subtext ? -12 : 0;
        ctx.fillText(visibleText, textX, textY);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

        // Blinking cursor
        this._drawTW_Cursor(ctx, textX, textY, visibleText, accentFill, revealPct, a);

        // Subtext
        if (mg.subtext) {
            const subAlpha = interpolate(revealPct, [0.7, 1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            ctx.globalAlpha = Math.min(1, opacity) * subAlpha;
            MGRenderer._setFont(ctx, '500', 24, s.fontBody);
            ctx.fillStyle = subFill;
            ctx.textAlign = 'left';
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = 6;
            ctx.fillText(mg.subtext, textX, bh / 2 - 24);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }
    }

    // ── Shared: typewriter blinking cursor ──
    _drawTW_Cursor(ctx, textX, textY, visibleText, accentFill, revealPct, a) {
        const cursorW = ctx.measureText(visibleText).width;
        const cursorOn = revealPct < 1.05 ? true : Math.sin((a.revealProgress || 0) * 60) > 0;
        if (cursorOn) {
            ctx.fillStyle = accentFill;
            ctx.fillRect(textX + cursorW + 3, textY - 20, 3, 40);
        }
    }

    // ========================================================================
    // 12. RANKING LIST
    // ========================================================================

    _renderRankingList(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate, easeOutCubic } = AnimationUtils;
        const { enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
        const items = MGRenderer._parseKeyValuePairs(mg.subtext);
        const maxVal = Math.max(...items.map(i => parseFloat(i.value) || 0), 1);
        const staggerDelay = Math.round(fps * 0.18);

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        const listW = 1920 * 0.55;
        const rowH = 50;
        const pos = MGRenderer._getPosXY(mg.position || 'center-left', listW, items.length * rowH + 60);

        ctx.translate(pos.x, pos.y);
        ctx.scale(idleScale, idleScale);

        // Title — clean rendering, no glow passes
        MGRenderer._setFont(ctx, '700', 34, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.shadowColor = 'rgba(0,0,0,0.8)';
        ctx.shadowBlur = 6;
        ctx.fillText(mg.text || '', 0, 0);
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        items.slice(0, 6).forEach((item, i) => {
            const rowDelay = Math.round(enterFrames * 0.2 + i * staggerDelay);
            const rowSpring = springValue(Math.max(0, frame - rowDelay), fps, { damping: 16, stiffness: 120 });
            const slideX = interpolate(rowSpring, [0, 1], [50, 0]);
            const rowBlur = interpolate(rowSpring, [0, 0.5], [3, 0], { extrapolateRight: 'clamp' });
            const numVal = parseFloat(item.value) || 0;
            const barDelay = rowDelay + Math.round(fps * 0.15);
            const barRaw = interpolate(frame, [barDelay, barDelay + Math.round(fps * 0.6)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
            const barWidth = easeOutCubic(barRaw) * (numVal / maxVal) * (listW - 60);
            const isTop = i === 0;
            const ry = 50 + i * rowH;

            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : rowSpring);

            ctx.save();
            if (rowBlur > 0.5) ctx.filter = `blur(${rowBlur.toFixed(1)}px)`;

            // Rank number — clean rendering
            MGRenderer._setFont(ctx, '900', 30, s.fontHeading);
            ctx.fillStyle = isTop ? s.accent : (s.textSub || 'rgba(255,255,255,0.75)');
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowColor = 'rgba(0,0,0,0.7)';
            ctx.shadowBlur = 4;
            ctx.fillText(`${i + 1}`, 24 + slideX, ry + 20);

            // Label — clean rendering
            MGRenderer._setFont(ctx, '600', 22, s.fontBody);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(item.label, 60 + slideX, ry + 12);
            ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

            MGRenderer._setFont(ctx, '700', 20, s.fontHeading);
            ctx.fillStyle = s.accent;
            ctx.textAlign = 'right';
            ctx.textBaseline = 'middle';
            ctx.fillText(item.value, listW + slideX, ry + 12);

            ctx.filter = 'none';

            ctx.fillStyle = 'rgba(255,255,255,0.1)';
            MGRenderer._roundRect(ctx, 60 + slideX, ry + 28, listW - 60, 8, 4);
            ctx.fill();

            if (barWidth > 0) {
                const barGrad = ctx.createLinearGradient(60, 0, 60 + barWidth, 0);
                barGrad.addColorStop(0, isTop ? s.accent : s.primary + '99');
                barGrad.addColorStop(1, isTop ? s.primary : s.primary + '55');
                ctx.fillStyle = barGrad;
                MGRenderer._roundRect(ctx, 60 + slideX, ry + 28, barWidth, 8, 4);
                ctx.fill();
            }

            ctx.restore();
        });

        ctx.restore();
    }

    // ========================================================================
    // 13. KINETIC TEXT
    // ========================================================================

    _renderKineticText(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterLinear, isExiting, exitProgress, opacity } = anim;

        const words = (mg.text || '').split(/\s+/);
        const staggerDelay = Math.round(fps * 0.08);

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        MGRenderer._setFont(ctx, '800', 60, s.fontHeading);
        const wordWidths = words.map(w => ctx.measureText(w).width);
        const gap = 18;
        const maxRowW = 1920 * 0.7;

        const rows = [];
        let currentRow = [];
        let currentW = 0;
        for (let i = 0; i < words.length; i++) {
            if (currentW + wordWidths[i] + (currentRow.length > 0 ? gap : 0) > maxRowW && currentRow.length > 0) {
                rows.push(currentRow);
                currentRow = [];
                currentW = 0;
            }
            currentRow.push({ word: words[i], width: wordWidths[i], index: i });
            currentW += wordWidths[i] + gap;
        }
        if (currentRow.length > 0) rows.push(currentRow);

        const rowHeight = 80;
        const totalH = rows.length * rowHeight;
        const startY = 1080 / 2 - totalH / 2;

        rows.forEach((row, ri) => {
            const rowW = row.reduce((a, r) => a + r.width, 0) + (row.length - 1) * gap;
            let rx = 1920 / 2 - rowW / 2;

            row.forEach((entry) => {
                const wordDelay = entry.index * staggerDelay;
                const wordSpring = springValue(Math.max(0, frame - wordDelay), fps, { damping: 16, stiffness: 120 });
                const wordScale = interpolate(wordSpring, [0, 1], [1.5, 1]);
                const wordOpacity = wordSpring;
                const wordBlur = interpolate(wordSpring, [0, 0.5], [6, 0], { extrapolateRight: 'clamp' });

                ctx.save();
                ctx.globalAlpha = Math.min(1, opacity) * wordOpacity * (isExiting ? exitProgress : 1);
                ctx.translate(rx + entry.width / 2, startY + ri * rowHeight + rowHeight / 2);
                ctx.scale(wordScale, wordScale);
                if (wordBlur > 0.5) ctx.filter = `blur(${wordBlur.toFixed(1)}px)`;

                MGRenderer._setFont(ctx, '800', 60, s.fontHeading);
                ctx.fillStyle = s.text;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';
                MGRenderer._drawTextShadowed(ctx, entry.word, 0, 0, s, true);

                ctx.restore();
                rx += entry.width + gap;
            });
        });

        ctx.restore();
    }

    // ========================================================================
    // 14. SUBSCRIBE CTA
    // ========================================================================

    _renderSubscribeCTA(ctx, frame, fps, mg, s, anim) {
        const { interpolate } = AnimationUtils;
        const { totalFrames, opacity } = anim;

        const progress = frame / totalFrames;
        const pulseScale = Math.sin(progress * Math.PI * 4 * 2) * 0.05 + 1;
        const fadeIn = interpolate(frame, [0, Math.round(0.3 * fps)], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const fadeOut = interpolate(frame, [totalFrames - Math.round(0.4 * fps), totalFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const alpha = Math.min(fadeIn, fadeOut);

        ctx.save();
        ctx.globalAlpha = Math.min(1, alpha);

        const text = mg.text || 'Subscribe';
        MGRenderer._setFont(ctx, 'bold', 28, s.fontHeading);
        const textW = ctx.measureText(text).width;
        const pillW = textW + 100;
        const pillH = 60;

        const pos = MGRenderer._getPosXY(mg.position || 'bottom-right', pillW, pillH);
        const cx = pos.x + pillW / 2;
        const cy = pos.y + pillH / 2;

        ctx.translate(cx, cy);
        ctx.scale(pulseScale, pulseScale);

        MGRenderer._roundRect(ctx, -pillW / 2, -pillH / 2, pillW, pillH, 30);
        const grad = ctx.createLinearGradient(-pillW / 2, 0, pillW / 2, 0);
        grad.addColorStop(0, s.primary);
        grad.addColorStop(1, s.accent);
        ctx.fillStyle = grad;
        if (s.glow) { ctx.shadowColor = s.primary + '80'; ctx.shadowBlur = 20; }
        else { ctx.shadowColor = 'rgba(0,0,0,0.5)'; ctx.shadowBlur = 12; }
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        MGRenderer._setFont(ctx, 'normal', 32, 'Segoe UI Emoji, Arial');
        ctx.fillText('\uD83D\uDD14', -pillW / 2 + 36, 1);
        MGRenderer._setFont(ctx, 'bold', 28, s.fontHeading);
        ctx.fillText(text, 18, 0);

        ctx.restore();
    }

    // ========================================================================
    // 15. MAP CHART
    // ========================================================================

    _renderMapChart(ctx, frame, fps, mg, s, anim, scriptContext) {
        const { opacity, enterProgress } = anim;
        const W = 1920, H = 1080;
        const elapsed = frame / fps;
        const speed = mg._animationSpeed || 1;

        // ── Overlay color palettes per map style ──
        const OVERLAY_STYLES = {
            dark: {
                pin: '#00d4ff', pinGlow: 'rgba(0,212,255,0.35)', pinRing: 'rgba(0,212,255,0.5)',
                label: '#ffffff', labelBg: 'rgba(8,18,35,0.92)',
                route: 'rgba(0,212,255,0.6)', routeGlow: 'rgba(0,212,255,0.18)',
                titleBg: 'rgba(8,18,35,0.88)', titleBorder: '#00d4ff', titleText: '#ffffff',
                vignette: 'rgba(0,0,0,0.35)', dataCard: 'rgba(10,22,45,0.9)',
                rankBadge: '#00d4ff', rankText: '#0b1426',
            },
            natural: {
                pin: '#f0c040', pinGlow: 'rgba(240,192,64,0.35)', pinRing: 'rgba(240,192,64,0.5)',
                label: '#ffffff', labelBg: 'rgba(12,28,18,0.9)',
                route: 'rgba(240,192,64,0.6)', routeGlow: 'rgba(240,192,64,0.18)',
                titleBg: 'rgba(12,28,18,0.88)', titleBorder: '#90d070', titleText: '#ffffff',
                vignette: 'rgba(0,15,5,0.3)', dataCard: 'rgba(15,35,22,0.9)',
                rankBadge: '#f0c040', rankText: '#12301a',
            },
            satellite: {
                pin: '#00ffaa', pinGlow: 'rgba(0,255,170,0.35)', pinRing: 'rgba(0,255,170,0.5)',
                label: '#e0f0e8', labelBg: 'rgba(3,8,12,0.92)',
                route: 'rgba(0,255,170,0.55)', routeGlow: 'rgba(0,255,170,0.15)',
                titleBg: 'rgba(3,8,12,0.9)', titleBorder: '#00ffaa', titleText: '#e0f0e8',
                vignette: 'rgba(0,0,0,0.45)', dataCard: 'rgba(5,12,18,0.9)',
                rankBadge: '#00ffaa', rankText: '#030a14',
            },
            light: {
                pin: '#d04030', pinGlow: 'rgba(208,64,48,0.3)', pinRing: 'rgba(208,64,48,0.45)',
                label: '#1a2a3a', labelBg: 'rgba(255,255,255,0.95)',
                route: 'rgba(208,64,48,0.5)', routeGlow: 'rgba(208,64,48,0.15)',
                titleBg: 'rgba(255,255,255,0.92)', titleBorder: '#2060a0', titleText: '#1a2a3a',
                vignette: 'rgba(100,120,140,0.12)', dataCard: 'rgba(255,255,255,0.94)',
                rankBadge: '#2060a0', rankText: '#ffffff',
            },
            political: {
                pin: '#b83020', pinGlow: 'rgba(184,48,32,0.35)', pinRing: 'rgba(184,48,32,0.5)',
                label: '#1c1008', labelBg: 'rgba(240,228,208,0.94)',
                route: 'rgba(184,48,32,0.55)', routeGlow: 'rgba(184,48,32,0.15)',
                titleBg: 'rgba(240,228,208,0.92)', titleBorder: '#8b4513', titleText: '#1c1008',
                vignette: 'rgba(60,40,20,0.18)', dataCard: 'rgba(240,228,208,0.92)',
                rankBadge: '#8b4513', rankText: '#f0e8d0',
            },
        };
        const pal = OVERLAY_STYLES[mg.mapStyle || 'dark'] || OVERLAY_STYLES.dark;

        // ── Country coordinates (lon, lat) for pin placement ──
        const MAP_COORDS = {
            'China': [104, 35], 'United States': [-98, 39], 'USA': [-98, 39], 'US': [-98, 39],
            'India': [78, 22], 'Japan': [138, 36], 'Germany': [10.5, 51.2],
            'United Kingdom': [-2, 54], 'UK': [-2, 54], 'France': [2.2, 46.2],
            'Brazil': [-51, -10], 'Italy': [12.5, 42.5], 'Canada': [-106, 56],
            'Russia': [100, 60], 'South Korea': [128, 36], 'Australia': [134, -25],
            'Spain': [-3.7, 40.4], 'Mexico': [-102, 23], 'Indonesia': [118, -2],
            'Norway': [9, 62], 'Turkey': [35, 39], 'Saudi Arabia': [45, 24],
            'South Africa': [25, -29], 'Argentina': [-64, -34], 'Nigeria': [8, 10],
            'Egypt': [30, 27], 'Thailand': [101, 15], 'Vietnam': [108, 16],
            'Taiwan': [121, 24], 'Pakistan': [70, 30], 'Philippines': [122, 13],
            'Iran': [53, 32], 'Iraq': [44, 33], 'Israel': [35, 31.5],
            'Ukraine': [32, 49], 'Poland': [20, 52], 'Sweden': [16, 62],
            'Singapore': [104, 1.3], 'Malaysia': [102, 4], 'Colombia': [-74, 4],
            'Chile': [-71, -33], 'Peru': [-76, -10], 'Venezuela': [-66, 8],
            'Algeria': [3, 28], 'Libya': [18, 27], 'Morocco': [-6, 32],
            'Kenya': [38, 0], 'Ethiopia': [39, 9], 'Tanzania': [35, -6],
            'Congo': [25, -3], 'Angola': [18, -12], 'Ghana': [-1.5, 8],
            'Afghanistan': [66, 34], 'Bangladesh': [90, 24],
            'North Korea': [127, 40], 'Myanmar': [96, 20],
            'New Zealand': [174, -41], 'Finland': [26, 64],
            'Greece': [22, 39], 'Portugal': [-8, 39.5],
            'Netherlands': [5, 52], 'Belgium': [4.4, 50.8],
            'Switzerland': [8.2, 46.8], 'Austria': [14.5, 47.5],
            'Czech Republic': [15.5, 49.8], 'Romania': [25, 46],
            'Hungary': [19, 47], 'Denmark': [10, 56],
            'Cuba': [-79, 22], 'Jamaica': [-77, 18],
            'Qatar': [51, 25.3], 'UAE': [54, 24], 'Kuwait': [48, 29.5],
            'Oman': [57, 21], 'Yemen': [48, 15.5], 'Jordan': [36, 31],
            'Lebanon': [35.8, 33.9], 'Syria': [38, 35],
            'Windsor': [-83, 42.3], 'Detroit': [-83.05, 42.3], 'Michigan': [-84.5, 44.3],
            'Ontario': [-85, 50], 'Alberta': [-114, 52],
        };

        // ── Determine map view (center + zoom) ──
        const mapView = mg._mapView || null;

        // ── Helper: lon/lat → pixel position on the map image ──
        // When we have _mapView (from MapTiler), use Mercator projection matching the tile
        // Otherwise fall back to simple equirectangular for the polygon fallback
        let toX, toY;
        if (mapView) {
            // Mercator projection: lon/lat → pixel, matching MapTiler's static map
            const centerLon = mapView.lon;
            const centerLat = mapView.lat;
            const zoom = mapView.zoom;
            const scale = Math.pow(2, zoom) * 256; // pixels per world at this zoom
            const cx = W / 2;
            const cy = H / 2;
            const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
            const centerMercY = mercY(centerLat);
            toX = (lon) => cx + (lon - centerLon) / 360 * scale;
            toY = (lat) => cy - (mercY(lat) - centerMercY) / (2 * Math.PI) * scale;
        } else {
            toX = (lon) => ((lon + 180) / 360) * W * 0.88 + W * 0.06;
            toY = (lat) => ((90 - lat) / 180) * H * 0.82 + H * 0.06;
        }

        // ── 1. BACKGROUND: API map image or polygon fallback ──
        const hasMapImage = mg.mapImageFile && this._mapImages && this._mapImages[mg.mapImageFile];
        if (hasMapImage) {
            // Draw the pre-loaded MapTiler image as background
            const mapImg = this._mapImages[mg.mapImageFile];
            ctx.globalAlpha = opacity * Math.min(1, enterProgress * 2);
            ctx.drawImage(mapImg, 0, 0, W, H);
            ctx.globalAlpha = opacity;
        } else {
            // Polygon fallback (no API key or image not loaded)
            this._renderMapChartFallbackBg(ctx, mg, W, H, opacity, enterProgress, pal);
        }

        // ── 2. Gather pin entities ──
        let items = MGRenderer._parseKeyValuePairs(mg.subtext || '');
        if (items.length === 0 && scriptContext?.entities) {
            items = scriptContext.entities
                .filter(e => MAP_COORDS[e])
                .map(e => ({ label: e, value: '' }));
        }
        if (items.length === 0 && mg.text) {
            const textEntities = Object.keys(MAP_COORDS).filter(name =>
                name.length > 2 && mg.text.toLowerCase().includes(name.toLowerCase())
            );
            items = textEntities.map(e => ({ label: e, value: '' }));
        }

        const pinPositions = items.slice(0, 10).map((item, i) => {
            const coords = MAP_COORDS[item.label];
            let x, y;
            if (coords) {
                x = toX(coords[0]);
                y = toY(coords[1]);
            } else {
                const hash = (item.label || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
                x = W * 0.12 + ((hash * 7 + i * 137) % 76) / 100 * W;
                y = H * 0.15 + ((hash * 13 + i * 89) % 60) / 100 * H;
            }
            return { ...item, x, y, i };
        });

        // ── 3. Animated route lines between pins ──
        if (pinPositions.length >= 2) {
            const routeReveal = Math.min(1, Math.max(0, (enterProgress - 0.3) * 2.5));
            if (routeReveal > 0) {
                ctx.globalAlpha = opacity * routeReveal * 0.7;

                // Route glow
                ctx.strokeStyle = pal.routeGlow;
                ctx.lineWidth = 8;
                for (let i = 0; i < pinPositions.length - 1; i++) {
                    const a = pinPositions[i], b = pinPositions[i + 1];
                    const cpY = Math.min(a.y, b.y) - 40 - Math.abs(a.x - b.x) * 0.1;
                    ctx.beginPath();
                    ctx.moveTo(a.x, a.y);
                    ctx.quadraticCurveTo((a.x + b.x) / 2, cpY, b.x, b.y);
                    ctx.stroke();
                }

                // Dashed animated route line
                ctx.strokeStyle = pal.route;
                ctx.lineWidth = 2.5;
                ctx.setLineDash([8, 6]);
                ctx.lineDashOffset = -elapsed * 40 * speed;
                for (let i = 0; i < pinPositions.length - 1; i++) {
                    const a = pinPositions[i], b = pinPositions[i + 1];
                    const cpY = Math.min(a.y, b.y) - 40 - Math.abs(a.x - b.x) * 0.1;
                    ctx.beginPath();
                    ctx.moveTo(a.x, a.y);
                    ctx.quadraticCurveTo((a.x + b.x) / 2, cpY, b.x, b.y);
                    ctx.stroke();
                }
                ctx.setLineDash([]);
                ctx.lineDashOffset = 0;

                // Traveling dot along each route segment
                for (let i = 0; i < pinPositions.length - 1; i++) {
                    const dotT = ((elapsed * 0.4 * speed) + i * 0.3) % 1;
                    const a = pinPositions[i], b = pinPositions[i + 1];
                    const cpY = Math.min(a.y, b.y) - 40 - Math.abs(a.x - b.x) * 0.1;
                    const t = dotT;
                    const dotX = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * ((a.x + b.x) / 2) + t * t * b.x;
                    const dotY = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * cpY + t * t * b.y;

                    // Trail glow
                    const trailGrad = ctx.createRadialGradient(dotX, dotY, 0, dotX, dotY, 12);
                    trailGrad.addColorStop(0, pal.pin);
                    trailGrad.addColorStop(1, 'transparent');
                    ctx.fillStyle = trailGrad;
                    ctx.beginPath();
                    ctx.arc(dotX, dotY, 12, 0, Math.PI * 2);
                    ctx.fill();

                    // Dot
                    ctx.fillStyle = pal.pin;
                    ctx.shadowColor = pal.pin;
                    ctx.shadowBlur = 10;
                    ctx.beginPath();
                    ctx.arc(dotX, dotY, 4, 0, Math.PI * 2);
                    ctx.fill();
                    ctx.shadowBlur = 0;
                }

                ctx.globalAlpha = opacity;
            }
        }

        // ── 4. Pin markers with labels ──
        const pinEnterDur = 0.4 / speed;
        for (const pin of pinPositions) {
            const pinDelay = 0.4 + pin.i * 0.18;
            const pinProgress = Math.min(1, Math.max(0, (elapsed - pinDelay) / pinEnterDur));
            if (pinProgress <= 0) continue;

            const eased = 1 - Math.pow(1 - pinProgress, 3);
            const bounce = pinProgress < 1 ? (1 - pinProgress) * 12 : 0;
            const py = pin.y - bounce;
            const pinAlpha = eased * opacity;
            ctx.globalAlpha = pinAlpha;

            // Expanding ripple ring (continuous pulse after enter)
            if (pinProgress >= 1) {
                const pulse = (Math.sin(elapsed * 3 * speed + pin.i * 1.5) + 1) / 2;
                const pulseR = 18 + pulse * 14;
                ctx.strokeStyle = pal.pinRing;
                ctx.lineWidth = 1.5;
                ctx.globalAlpha = pinAlpha * (0.12 + pulse * 0.22);
                ctx.beginPath();
                ctx.arc(pin.x, py, pulseR, 0, Math.PI * 2);
                ctx.stroke();
                // Second ripple (offset phase)
                const pulse2 = (Math.sin(elapsed * 3 * speed + pin.i * 1.5 + Math.PI) + 1) / 2;
                const pulseR2 = 24 + pulse2 * 10;
                ctx.globalAlpha = pinAlpha * (0.06 + pulse2 * 0.12);
                ctx.beginPath();
                ctx.arc(pin.x, py, pulseR2, 0, Math.PI * 2);
                ctx.stroke();
                ctx.globalAlpha = pinAlpha;
            }

            // Glow halo
            const glowGrad = ctx.createRadialGradient(pin.x, py, 0, pin.x, py, 28);
            glowGrad.addColorStop(0, pal.pinGlow);
            glowGrad.addColorStop(1, 'transparent');
            ctx.fillStyle = glowGrad;
            ctx.beginPath();
            ctx.arc(pin.x, py, 28, 0, Math.PI * 2);
            ctx.fill();

            // Pin dot (filled circle)
            ctx.fillStyle = pal.pin;
            ctx.shadowColor = pal.pin;
            ctx.shadowBlur = 16;
            ctx.beginPath();
            ctx.arc(pin.x, py, 7 * eased, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;

            // Outer ring (enter animation)
            ctx.strokeStyle = pal.pin;
            ctx.lineWidth = 2;
            const ringRadius = 12 + (1 - eased) * 14;
            ctx.globalAlpha = pinAlpha * eased;
            ctx.beginPath();
            ctx.arc(pin.x, py, ringRadius, 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = pinAlpha;

            // ── Label card ──
            const labelText = pin.label || '';
            const valueText = pin.value && pin.value !== '0' ? pin.value : '';
            const font = s.fontFamily || 'Arial';
            ctx.font = `bold 22px ${font}`;
            const labelW = ctx.measureText(labelText).width;
            const valueW = valueText ? ctx.measureText(valueText).width : 0;
            const boxW = Math.max(labelW, valueW) + 32;
            const boxH = valueText ? 62 : 40;
            const boxX = pin.x - boxW / 2;
            const boxY = py - 34 - boxH;

            // Card shadow + background
            ctx.shadowColor = 'rgba(0,0,0,0.35)';
            ctx.shadowBlur = 12;
            ctx.shadowOffsetY = 3;
            ctx.fillStyle = pal.labelBg;
            ctx.beginPath();
            MGRenderer._roundRect(ctx, boxX, boxY, boxW, boxH, 8);
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;

            // Rank badge (numbered circle on the left)
            const badgeR = 14;
            const badgeX = boxX + badgeR + 6;
            const badgeY = boxY + boxH / 2;
            ctx.fillStyle = pal.rankBadge;
            ctx.beginPath();
            ctx.arc(badgeX, badgeY, badgeR, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillStyle = pal.rankText;
            ctx.font = `bold 14px ${font}`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(String(pin.i + 1), badgeX, badgeY);

            // Pointer triangle
            ctx.fillStyle = pal.labelBg;
            ctx.beginPath();
            ctx.moveTo(pin.x - 6, boxY + boxH);
            ctx.lineTo(pin.x + 6, boxY + boxH);
            ctx.lineTo(pin.x, boxY + boxH + 8);
            ctx.closePath();
            ctx.fill();

            // Label text
            ctx.fillStyle = pal.label;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.font = `bold 22px ${font}`;
            ctx.fillText(labelText, pin.x + 8, boxY + (valueText ? 20 : boxH / 2));

            // Value text
            if (valueText) {
                ctx.fillStyle = pal.pin;
                ctx.font = `bold 18px ${font}`;
                ctx.fillText(valueText, pin.x + 8, boxY + 44);
            }

            ctx.globalAlpha = 1;
        }

        // ── 5. Title bar ──
        const title = mg.text || '';
        if (title) {
            ctx.globalAlpha = opacity * Math.min(1, enterProgress * 3);
            const font = s.fontFamily || 'Arial';
            ctx.font = `bold 40px ${font}`;
            const titleW = ctx.measureText(title).width;
            const barW = titleW + 70;
            const barH = 64;
            const barX = (W - barW) / 2;
            const barY = 28;

            // Title card shadow + background
            ctx.shadowColor = 'rgba(0,0,0,0.35)';
            ctx.shadowBlur = 18;
            ctx.shadowOffsetY = 4;
            ctx.fillStyle = pal.titleBg;
            ctx.beginPath();
            MGRenderer._roundRect(ctx, barX, barY, barW, barH, 12);
            ctx.fill();
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;

            // Accent border (bottom + left stripe)
            ctx.fillStyle = pal.titleBorder;
            ctx.fillRect(barX + 12, barY + barH - 3, barW - 24, 3);
            ctx.beginPath();
            MGRenderer._roundRect(ctx, barX, barY, 5, barH, 12);
            ctx.fill();
            ctx.fillRect(barX + 2, barY, 5, barH);

            // Title text
            ctx.fillStyle = pal.titleText;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(title, W / 2, barY + barH / 2);

            ctx.globalAlpha = opacity;
        }

        // ── 6. Vignette overlay ──
        const vignetteGrad = ctx.createRadialGradient(W / 2, H / 2, W * 0.25, W / 2, H / 2, W * 0.7);
        vignetteGrad.addColorStop(0, 'transparent');
        vignetteGrad.addColorStop(1, pal.vignette);
        ctx.fillStyle = vignetteGrad;
        ctx.fillRect(0, 0, W, H);

        ctx.globalAlpha = 1;
    }

    /**
     * Polygon fallback background for mapChart when no API map image is available.
     */
    _renderMapChartFallbackBg(ctx, mg, W, H, opacity, enterProgress, pal) {
        // Fallback ocean/land colors per style
        const FALLBACK_BG = {
            dark:      { ocean: '#0b1426', oceanGrad: '#0f1d35', land: '#1c3050', stroke: '#2a4a6e', grid: 'rgba(30,70,120,0.15)', gridAccent: 'rgba(40,90,150,0.25)' },
            natural:   { ocean: '#0e3350', oceanGrad: '#164468', land: '#2e6b3e', stroke: '#3a8050', grid: 'rgba(42,80,56,0.15)', gridAccent: 'rgba(50,100,70,0.25)' },
            satellite: { ocean: '#030a14', oceanGrad: '#081420', land: '#1a2818', stroke: '#253a22', grid: 'rgba(20,45,30,0.12)', gridAccent: 'rgba(30,60,40,0.2)' },
            light:     { ocean: '#c8dff0', oceanGrad: '#d8ecf8', land: '#e8ece8', stroke: '#b8c8b8', grid: 'rgba(150,170,190,0.2)', gridAccent: 'rgba(130,155,180,0.3)' },
            political: { ocean: '#8cb8d8', oceanGrad: '#a0cce8', land: '#e8dcc8', stroke: '#c0a888', grid: 'rgba(140,130,115,0.18)', gridAccent: 'rgba(120,108,90,0.28)' },
        };
        const fb = FALLBACK_BG[mg.mapStyle || 'dark'] || FALLBACK_BG.dark;

        // Ocean gradient
        const oceanGrad = ctx.createLinearGradient(0, 0, 0, H);
        oceanGrad.addColorStop(0, fb.oceanGrad);
        oceanGrad.addColorStop(0.5, fb.ocean);
        oceanGrad.addColorStop(1, fb.oceanGrad);
        ctx.fillStyle = oceanGrad;
        ctx.fillRect(0, 0, W, H);

        // Simplified continent polygons
        const CONTINENTS = [
            [[12,14],[20,12],[28,14],[32,18],[30,22],[34,26],[32,32],[28,38],[26,42],[22,44],[18,42],[14,38],[10,34],[8,28],[10,22],[12,18]],
            [[22,44],[24,46],[26,50],[24,52],[22,50],[20,48]],
            [[24,52],[28,52],[32,54],[34,58],[34,64],[32,72],[30,78],[26,82],[22,78],[20,72],[20,66],[22,58]],
            [[46,14],[50,12],[54,14],[56,18],[54,22],[52,26],[50,28],[48,30],[46,28],[44,24],[44,20],[44,16]],
            [[46,30],[50,28],[54,30],[56,34],[58,40],[58,48],[56,56],[54,62],[50,66],[46,64],[44,58],[42,50],[42,42],[44,36]],
            [[56,26],[60,24],[64,26],[62,30],[58,32],[56,30]],
            [[56,14],[62,10],[68,8],[76,10],[82,14],[86,16],[88,22],[86,28],[82,32],[78,34],[74,36],[70,34],[66,30],[62,26],[58,22],[56,18]],
            [[74,36],[78,38],[82,40],[84,44],[80,48],[76,46],[74,42]],
            [[66,30],[70,34],[68,42],[64,40],[62,34]],
            [[80,58],[86,56],[90,58],[92,62],[90,68],[86,70],[82,68],[80,64]],
            [[82,48],[84,48],[86,50],[84,52],[82,50]],
            [[86,50],[88,50],[90,52],[88,54],[86,52]],
        ];

        const landReveal = Math.min(1, enterProgress * 2.5);
        ctx.globalAlpha = opacity * landReveal;
        ctx.fillStyle = fb.land;
        for (const pts of CONTINENTS) {
            ctx.beginPath();
            ctx.moveTo(pts[0][0] / 100 * W, pts[0][1] / 100 * H);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] / 100 * W, pts[i][1] / 100 * H);
            ctx.closePath();
            ctx.fill();
        }
        ctx.strokeStyle = fb.stroke;
        ctx.lineWidth = 1.5;
        for (const pts of CONTINENTS) {
            ctx.beginPath();
            ctx.moveTo(pts[0][0] / 100 * W, pts[0][1] / 100 * H);
            for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0] / 100 * W, pts[i][1] / 100 * H);
            ctx.closePath();
            ctx.stroke();
        }

        // Grid lines
        const toXfb = (lon) => ((lon + 180) / 360) * W * 0.88 + W * 0.06;
        const toYfb = (lat) => ((90 - lat) / 180) * H * 0.82 + H * 0.06;
        const gridReveal = Math.min(1, Math.max(0, enterProgress * 3 - 0.5));
        ctx.globalAlpha = opacity * gridReveal * 0.6;
        ctx.strokeStyle = fb.grid;
        ctx.lineWidth = 0.8;
        for (let lat = -60; lat <= 80; lat += 30) {
            const y = toYfb(lat);
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }
        for (let lon = -150; lon <= 180; lon += 30) {
            const x = toXfb(lon);
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        }
        ctx.strokeStyle = fb.gridAccent;
        ctx.lineWidth = 1.2;
        const eqY = toYfb(0);
        ctx.beginPath(); ctx.moveTo(0, eqY); ctx.lineTo(W, eqY); ctx.stroke();
        const pmX = toXfb(0);
        ctx.beginPath(); ctx.moveTo(pmX, 0); ctx.lineTo(pmX, H); ctx.stroke();

        ctx.globalAlpha = opacity;
    }

    // ========================================================================
    // EXPLAINER RENDERER
    // ========================================================================

    /**
     * Render an explainer MG: themed gradient background + transparent PNG image + label.
     * Variant/animation resolved via registry.
     */
    _renderExplainer(ctx, frame, fps, mg, s, anim, scriptContext) {
        const W = 1920, H = 1080;
        const { opacity } = anim;
        const speed = mg._animationSpeed || 1;
        const elapsed = frame / fps;

        // ── Resolve variant & animation ──
        const variant = this._resolveVariant(mg, s, 'explainer') || 'standard';
        const animType = this._resolveAnimation(mg, s, 'explainer') || 'fadeSlide';

        // Explainer is always an overlay card on top of video.
        // center = larger card centered, corner positions = smaller card in corner.
        const isCorner = mg.position && mg.position !== 'center';

        // ── Read custom properties ──
        const imgScaleMult = (mg.explainerImgScale != null ? mg.explainerImgScale : 100) / 100;
        const shadowStyle = mg.explainerShadow || 'medium';

        ctx.save();
        ctx.globalAlpha = opacity;

        const primary = s.primary || '#3b82f6';
        const accent = s.accent || '#f59e0b';

        // ── Compute card positioning ──
        // All drawing uses local coords (0,0 = card center), then translate+scale to position
        let maxImgW, maxImgH, fontSize, subFontSize;
        let anchorX, anchorY;

        if (isCorner) {
            // Corner: compact card
            maxImgW = 200; maxImgH = 180;
            fontSize = 22; subFontSize = 15;
            const pos = mg.position || 'bottom-right';
            const margin = 60;
            if (pos.includes('left')) { anchorX = margin + maxImgW / 2; }
            else { anchorX = W - margin - maxImgW / 2; }
            if (pos.includes('top')) { anchorY = margin + maxImgH / 2 + 20; }
            else { anchorY = H - margin - 60; }
        } else {
            // Center: larger card
            maxImgW = 350; maxImgH = 300;
            fontSize = 32; subFontSize = 20;
            anchorX = W / 2;
            anchorY = H * 0.45;
        }

        // Card draws at local origin (0,0), transformed to anchor point + scale
        ctx.translate(anchorX, anchorY);
        ctx.scale(imgScaleMult, imgScaleMult);

        // Image area at local (0,0), label below
        const imgAreaCenterX = 0;
        const imgAreaCenterY = 0;
        const labelCenterX = 0;
        const labelY_base = maxImgH / 2 + 25;

        // ── Compute animation state ──
        let imgAlpha = opacity;
        let imgOffsetX = 0, imgOffsetY = 0;
        let imgScale = 1;
        let labelAlpha = opacity;
        let labelOffsetY = 0;

        const enterDur = 0.6 / speed;
        const exitDur = 0.4 / speed;
        const totalDur = (mg.duration || 5);
        const exitStart = totalDur - exitDur;
        const t = elapsed;

        const enterT = Math.min(1, t / enterDur);
        const easeEnter = 1 - Math.pow(1 - enterT, 3);

        let exitT = 0;
        if (t > exitStart) {
            exitT = Math.min(1, (t - exitStart) / exitDur);
        }
        const easeExit = 1 - Math.pow(1 - exitT, 2);

        // Slide direction depends on position for overlay mode
        const slideFromRight = !isCorner || (mg.position || '').includes('right');
        const slideDist = isCorner ? 250 : 400;

        if (animType === 'slideLeft' || variant === 'slideRight') {
            imgOffsetX = (1 - easeEnter) * (slideFromRight ? slideDist : -slideDist);
            imgAlpha = opacity * easeEnter;
            if (exitT > 0) {
                imgOffsetX = easeExit * (slideFromRight ? -slideDist * 0.75 : slideDist * 0.75);
                imgAlpha = opacity * (1 - easeExit);
            }
        } else if (animType === 'popUp') {
            const spring = easeEnter > 0.7 ? 1 + Math.sin((easeEnter - 0.7) / 0.3 * Math.PI) * 0.05 : easeEnter;
            imgScale = 0.3 + spring * 0.7;
            imgAlpha = opacity * Math.min(1, enterT * 2);
            imgOffsetY = (1 - easeEnter) * 80;
            if (exitT > 0) {
                imgScale = 1 - easeExit * 0.3;
                imgAlpha = opacity * (1 - easeExit);
            }
        } else {
            // fadeSlide (default)
            imgAlpha = opacity * easeEnter;
            imgOffsetY = (1 - easeEnter) * 60;
            if (exitT > 0) {
                imgAlpha = opacity * (1 - easeExit);
                imgOffsetY = -easeExit * 40;
            }
        }

        // Label appears slightly after image
        const labelDelay = 0.15 / speed;
        const labelEnterT = Math.min(1, Math.max(0, (t - labelDelay) / enterDur));
        const easeLabelEnter = 1 - Math.pow(1 - labelEnterT, 3);
        labelAlpha = opacity * easeLabelEnter;
        labelOffsetY = (1 - easeLabelEnter) * 30;
        if (exitT > 0) {
            labelAlpha = opacity * (1 - easeExit);
        }

        // ── Draw the image ──
        const imgFile = mg.explainerImageFile;
        const loadedImg = imgFile ? this._explainerImages[imgFile] : null;

        // Shadow presets
        const SHADOW_PRESETS = {
            none:   { color: 'transparent', blur: 0, offY: 0 },
            soft:   { color: 'rgba(0,0,0,0.25)', blur: 20, offY: 6 },
            medium: { color: 'rgba(0,0,0,0.5)', blur: 30, offY: 10 },
            heavy:  { color: 'rgba(0,0,0,0.7)', blur: 50, offY: 15 },
            glow:   { color: this._hexToRgba(primary, 0.5), blur: 40, offY: 0 },
        };
        const shadow = SHADOW_PRESETS[shadowStyle] || SHADOW_PRESETS.medium;

        if (loadedImg) {
            const natW = loadedImg.naturalWidth || loadedImg.width;
            const natH = loadedImg.naturalHeight || loadedImg.height;
            const scale = Math.min(maxImgW / natW, maxImgH / natH) * imgScale;
            const drawW = natW * scale;
            const drawH = natH * scale;
            const drawX = imgAreaCenterX - drawW / 2 + imgOffsetX;
            const drawY = imgAreaCenterY - drawH / 2 + imgOffsetY;

            ctx.globalAlpha = imgAlpha;
            ctx.shadowColor = shadow.color;
            ctx.shadowBlur = shadow.blur;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = shadow.offY;
            ctx.drawImage(loadedImg, drawX, drawY, drawW, drawH);
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
        } else {
            // Placeholder: pulsing circle with "Loading..."
            ctx.globalAlpha = imgAlpha * 0.4;
            const pulseR = (isCorner ? 40 : 60) + Math.sin(elapsed * 2) * 10;
            ctx.beginPath();
            ctx.arc(imgAreaCenterX + imgOffsetX, imgAreaCenterY + imgOffsetY, pulseR * imgScale, 0, Math.PI * 2);
            ctx.fillStyle = primary;
            ctx.fill();

            ctx.globalAlpha = imgAlpha * 0.6;
            MGRenderer._setFont(ctx, '400', isCorner ? 14 : 18, s.fontBody);
            ctx.fillStyle = '#ffffff';
            const dots = '.'.repeat(1 + Math.floor(elapsed * 2) % 3);
            ctx.textAlign = 'center';
            ctx.fillText('Loading' + dots, imgAreaCenterX + imgOffsetX, imgAreaCenterY + imgOffsetY + pulseR * imgScale + 25);
        }

        // ── Draw the label ──
        const labelText = mg.explainerLabel || mg.text || '';
        const subText = mg.subtext || '';
        if (labelText) {
            ctx.globalAlpha = labelAlpha;
            const labelY = labelY_base + labelOffsetY;

            MGRenderer._setFont(ctx, '700', fontSize, s.fontHeading);
            ctx.textAlign = 'center';
            const titleW = ctx.measureText(labelText).width;
            MGRenderer._setFont(ctx, '400', subFontSize, s.fontBody);
            const subW = subText ? ctx.measureText(subText).width : 0;
            const pillW = Math.max(titleW, subW) + (isCorner ? 40 : 60);
            const pillH = subText ? (isCorner ? 70 : 90) : (isCorner ? 45 : 60);
            const pillX = labelCenterX - pillW / 2;
            const pillY = labelY - pillH / 2;

            // Semi-transparent pill bg
            ctx.fillStyle = 'rgba(0,0,0,0.65)';
            const pillR = 12;
            ctx.beginPath();
            ctx.moveTo(pillX + pillR, pillY);
            ctx.lineTo(pillX + pillW - pillR, pillY);
            ctx.quadraticCurveTo(pillX + pillW, pillY, pillX + pillW, pillY + pillR);
            ctx.lineTo(pillX + pillW, pillY + pillH - pillR);
            ctx.quadraticCurveTo(pillX + pillW, pillY + pillH, pillX + pillW - pillR, pillY + pillH);
            ctx.lineTo(pillX + pillR, pillY + pillH);
            ctx.quadraticCurveTo(pillX, pillY + pillH, pillX, pillY + pillH - pillR);
            ctx.lineTo(pillX, pillY + pillR);
            ctx.quadraticCurveTo(pillX, pillY, pillX + pillR, pillY);
            ctx.closePath();
            ctx.fill();

            // Accent line
            ctx.fillStyle = primary;
            ctx.fillRect(pillX + 12, pillY, pillW - 24, 3);

            // Title
            MGRenderer._setFont(ctx, '700', fontSize, s.fontHeading);
            ctx.fillStyle = s.text || '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            const titleY = subText ? pillY + pillH * 0.38 : pillY + pillH / 2;
            ctx.fillText(labelText, labelCenterX, titleY);

            if (subText) {
                MGRenderer._setFont(ctx, '400', subFontSize, s.fontBody);
                ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.75)';
                ctx.fillText(subText, labelCenterX, pillY + pillH * 0.7);
            }
        }

        ctx.restore();
    }

    // ========================================================================
    // 17. ARTICLE HIGHLIGHT
    // ========================================================================

    _renderArticleHighlight(ctx, frame, fps, mg, s, anim) {
        const { interpolate } = AnimationUtils;
        const { enterSpring, isExiting, exitProgress, opacity } = anim;
        const elapsed = frame / fps;
        const dur = mg.duration || 7;

        const articleImg = mg.articleImageFile ? this._articleImages[mg.articleImageFile] : null;

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        if (articleImg) {
            // ── IMAGE MODE: article screenshot with highlight boxes ──
            const blurAmt = Math.max(0, 12 - elapsed * 12);
            const cardScale = 1 + elapsed * 0.01;
            const rotY = elapsed / dur * 6;

            // Center the image within 1920x1080 maintaining aspect ratio
            const imgAR = articleImg.naturalWidth / articleImg.naturalHeight;
            const maxW = 1920 * 0.85;
            const maxH = 1080 * 0.85;
            let drawW, drawH;
            if (imgAR > maxW / maxH) {
                drawW = maxW;
                drawH = maxW / imgAR;
            } else {
                drawH = maxH;
                drawW = maxH * imgAR;
            }
            const drawX = (1920 - drawW) / 2;
            const drawY = (1080 - drawH) / 2;

            ctx.translate(960, 540);
            ctx.scale(cardScale, cardScale);
            ctx.translate(-960, -540);

            // Card shadow
            ctx.shadowColor = 'rgba(0,0,0,0.35)';
            ctx.shadowBlur = 80;
            ctx.shadowOffsetY = 20;

            // Rounded clip for the card
            MGRenderer._roundRect(ctx, drawX, drawY, drawW, drawH, 12);
            ctx.clip();

            // Draw the article image
            ctx.drawImage(articleImg, drawX, drawY, drawW, drawH);

            // Reset shadow for overlays
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;

            // Yellow highlighter sweep boxes
            const hlBoxes = mg.highlightBoxes || [];
            for (let bi = 0; bi < hlBoxes.length; bi++) {
                const b = hlBoxes[bi];
                const yOff = (bi % 2 === 0) ? 0.3 : -0.2;
                const rot = (bi % 2 === 0) ? -0.3 : 0.4;
                const sweepProg = Math.min(1, Math.max(0, (elapsed - 1.2 - bi * 0.3) / 0.5));
                const sweepEased = 1 - Math.pow(1 - sweepProg, 2.5);
                if (sweepEased > 0) {
                    const bx = drawX + (b.x - 1) / 100 * drawW;
                    const by = drawY + (b.y + yOff) / 100 * drawH;
                    const bw = (b.w + 2) / 100 * drawW;
                    const bh = Math.max(b.h, 3.8) / 100 * drawH;
                    ctx.save();
                    ctx.translate(bx + bw / 2, by + bh / 2);
                    ctx.rotate(rot * Math.PI / 180);
                    // Clip to reveal sweep
                    const visibleW = bw * sweepEased;
                    ctx.beginPath();
                    ctx.rect(-bw / 2, -bh / 2, visibleW, bh);
                    ctx.clip();
                    ctx.fillStyle = 'rgba(255,230,0,0.38)';
                    MGRenderer._roundRect(ctx, -bw / 2, -bh / 2, bw, bh, 3);
                    ctx.fill();
                    ctx.restore();
                }
            }

            // Vignette overlay
            const vigGrad = ctx.createRadialGradient(960, 540, 200, 960, 540, 900);
            vigGrad.addColorStop(0, 'transparent');
            vigGrad.addColorStop(1, 'rgba(0,0,0,0.35)');
            ctx.fillStyle = vigGrad;
            ctx.fillRect(drawX, drawY, drawW, drawH);
        } else {
            // ── CARD MODE: generated article card ──
            const rawSub = mg.subtext || '';
            const pipeParts = rawSub.split('|');
            let artSource = '', artAuthor = '', artDate = '', rawExcerpt = '';
            if (pipeParts.length >= 4) {
                artSource = (pipeParts[0] || '').trim();
                artAuthor = (pipeParts[1] || '').trim();
                artDate = (pipeParts[2] || '').trim();
                rawExcerpt = pipeParts.slice(3).join('|').trim();
            } else if (pipeParts.length === 3) {
                artSource = (pipeParts[0] || '').trim();
                if (/\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i.test(pipeParts[1])) {
                    artDate = (pipeParts[1] || '').trim();
                } else {
                    artAuthor = (pipeParts[1] || '').trim();
                }
                rawExcerpt = (pipeParts[2] || '').trim();
            } else if (pipeParts.length === 2) {
                artSource = (pipeParts[0] || '').trim();
                rawExcerpt = (pipeParts[1] || '').trim();
            } else {
                rawExcerpt = rawSub.trim();
            }

            // Strip ** markdown markers for plain text
            const cleanExcerpt = rawExcerpt.replace(/\*\*([^*]+)\*\*/g, '$1');

            // Extract highlight phrases
            const highlightPhrases = [];
            rawExcerpt.replace(/\*\*([^*]+)\*\*/g, (_, p) => highlightPhrases.push(p));
            if (highlightPhrases.length === 0 && cleanExcerpt.length > 0) {
                cleanExcerpt.replace(/\d[\d,.]*\s*(?:%|percent|million|billion|trillion|thousand)?/gi, (m) => {
                    if (highlightPhrases.length < 3) highlightPhrases.push(m.trim());
                });
            }

            const blurAmt = Math.max(0, 12 - elapsed * 12);
            const cardScale = 1 + elapsed * 0.01;
            const enterDur = 0.4;
            const enterDone = elapsed >= enterDur;

            ctx.translate(960, 540);
            ctx.scale(cardScale, cardScale);
            ctx.translate(-960, -540);

            // Card dimensions
            const cardW = 1920 * 0.65;
            const cardH = 1080 * 0.65;
            const cardX = (1920 - cardW) / 2;
            const cardY = (1080 - cardH) / 2;

            // Card background
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 60;
            ctx.shadowOffsetY = 10;
            MGRenderer._roundRect(ctx, cardX, cardY, cardW, cardH, 16);
            ctx.fillStyle = '#1a1a2e';
            ctx.fill();
            ctx.shadowColor = 'transparent';
            ctx.shadowBlur = 0;
            ctx.shadowOffsetY = 0;

            let yPos = cardY + 50;

            // Source
            if (artSource) {
                MGRenderer._setFont(ctx, '700', 20, s.fontBody);
                ctx.fillStyle = s.primary || '#3b82f6';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                ctx.fillText(artSource.toUpperCase(), cardX + 40, yPos);
                yPos += 40;
            }

            // Headline
            MGRenderer._setFont(ctx, '800', 44, s.fontHeading);
            ctx.fillStyle = s.text || '#ffffff';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            const headlineLines = MGRenderer._wrapTextWords(ctx, mg.text || '', cardW - 80);
            for (const line of headlineLines) {
                ctx.fillText(line, cardX + 40, yPos);
                yPos += 56;
            }
            yPos += 10;

            // Separator line with animation
            const sepW = enterDone ? cardW - 80 : (cardW - 80) * (elapsed / enterDur);
            const sepGrad = ctx.createLinearGradient(cardX + 40, 0, cardX + 40 + sepW, 0);
            sepGrad.addColorStop(0, s.primary || '#3b82f6');
            sepGrad.addColorStop(1, s.accent || '#f59e0b');
            ctx.fillStyle = sepGrad;
            ctx.fillRect(cardX + 40, yPos, sepW, 3);
            yPos += 25;

            // Byline
            const byline = (artAuthor ? `By ${artAuthor}` : '') +
                (artAuthor && artDate ? '  ·  ' : '') + artDate;
            if (byline) {
                MGRenderer._setFont(ctx, '500', 20, s.fontBody);
                ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.6)';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';
                ctx.fillText(byline, cardX + 40, yPos);
                yPos += 36;
            }

            // Excerpt with highlight sweep
            if (cleanExcerpt) {
                yPos += 10;
                MGRenderer._setFont(ctx, '400', 24, s.fontBody);
                ctx.fillStyle = 'rgba(255,255,255,0.85)';
                ctx.textAlign = 'left';
                ctx.textBaseline = 'top';

                const excerptLines = MGRenderer._wrapTextWords(ctx, `\u201C${cleanExcerpt}\u201D`, cardW - 80);
                for (let li = 0; li < excerptLines.length; li++) {
                    const lineText = excerptLines[li];
                    const lineY = yPos + li * 34;

                    // Draw highlight sweep behind matching phrases
                    for (let hi = 0; hi < highlightPhrases.length; hi++) {
                        const phrase = highlightPhrases[hi];
                        const idx = lineText.indexOf(phrase);
                        if (idx === -1) continue;
                        const sweepProg = Math.min(1, Math.max(0, (elapsed - 1.2 - hi * 0.4) / 0.5));
                        const sweepEased = 1 - Math.pow(1 - sweepProg, 2);
                        if (sweepEased > 0) {
                            const beforeW = ctx.measureText(lineText.substring(0, idx)).width;
                            const phraseW = ctx.measureText(phrase).width;
                            ctx.fillStyle = 'rgba(255,230,0,0.3)';
                            ctx.fillRect(cardX + 40 + beforeW, lineY - 2, phraseW * sweepEased, 30);
                        }
                    }

                    ctx.fillStyle = 'rgba(255,255,255,0.85)';
                    ctx.fillText(lineText, cardX + 40, lineY);
                }
            }
        }

        ctx.restore();
    }

    /**
     * Convert hex color to rgba string.
     */
    _hexToRgba(hex, alpha) {
        if (hex.startsWith('rgba') || hex.startsWith('rgb')) return hex;
        const h = hex.replace('#', '');
        if (h.length < 6) return `rgba(0,0,0,${alpha})`;
        const r = parseInt(h.substring(0, 2), 16);
        const g = parseInt(h.substring(2, 4), 16);
        const b = parseInt(h.substring(4, 6), 16);
        return `rgba(${r},${g},${b},${alpha})`;
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
