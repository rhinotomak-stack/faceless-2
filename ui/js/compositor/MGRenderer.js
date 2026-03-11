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

        let rendered = false;
        switch (mg.type) {
            case 'headline':
                this._renderHeadline(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            case 'lowerThird':
                this._renderLowerThird(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            case 'callout':
                this._renderCallout(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            case 'focusWord':
                this._renderFocusWord(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            case 'statCounter':
                this._renderStatCounter(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            case 'bulletList':
                this._renderBulletList(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            case 'progressBar':
                this._renderProgressBar(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            case 'barChart':
                this._renderBarChart(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            case 'donutChart':
                this._renderDonutChart(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            case 'comparisonCard':
                this._renderComparisonCard(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            case 'timeline':
                this._renderTimeline(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            case 'rankingList':
                this._renderRankingList(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            case 'kineticText':
                this._renderKineticText(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            case 'subscribeCTA':
                this._renderSubscribeCTA(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            case 'mapChart':
                this._renderMapChart(ctx, localFrame, this.fps, mg, s, anim);
                rendered = true;
                break;
            default:
                // Fallback: render any unknown MG type as a headline so text is visible
                if (mg.text) {
                    this._renderHeadline(ctx, localFrame, this.fps, mg, s, anim);
                    rendered = true;
                }
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
        const { springValue, interpolate } = AnimationUtils;
        const { enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, speed } = anim;

        const scale = isExiting
            ? interpolate(exitProgress, [0, 1], [0.97, 1])
            : interpolate(enterSpring, [0, 1], [0.88, 1]);
        const translateY = isExiting
            ? interpolate(exitProgress, [0, 1], [-12, 0])
            : interpolate(enterSpring, [0, 1], [30, 0]);
        const blur = isExiting ? 0 : interpolate(enterLinear, [0, 0.6], [6, 0], { extrapolateRight: 'clamp' });

        const barDelay = Math.round((0.25 / speed) * fps);
        const barSpring = springValue(Math.max(0, frame - barDelay), fps, {
            damping: 20, stiffness: 100, durationInFrames: Math.round((0.3 / speed) * fps),
        });
        const barWidth = barSpring * 300;

        const subDelay = Math.round(0.2 * fps);
        const subSpring = springValue(Math.max(0, frame - subDelay), fps, { damping: 18, stiffness: 100 });
        const subOpacity = isExiting ? exitProgress : subSpring;

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        const position = mg.position || 'center';
        const isLeft = position.includes('left');
        const isRight = position.includes('right');

        MGRenderer._setFont(ctx, '900', 72, s.fontHeading);
        const textW = ctx.measureText(mg.text || '').width;
        const contentW = Math.max(800, textW + 40);
        const pos = MGRenderer._getPosXY(position, contentW, 200);

        let cx, textAlign, textX, barX;
        if (isLeft) {
            cx = pos.x + 20;
            textAlign = 'left';
            textX = 0;
            barX = 0;
        } else if (isRight) {
            cx = pos.x + contentW - 20;
            textAlign = 'right';
            textX = 0;
            barX = -barWidth;
        } else {
            cx = pos.x + contentW / 2;
            textAlign = 'center';
            textX = 0;
            barX = -barWidth / 2;
        }
        const cy = pos.y + 100;

        ctx.translate(cx, cy + translateY);
        ctx.scale(scale * idleScale, scale * idleScale);

        if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;

        ctx.fillStyle = s.text;
        ctx.textAlign = textAlign;
        ctx.textBaseline = 'middle';
        MGRenderer._drawTextShadowed(ctx, mg.text || '', textX, -30, s, true);

        ctx.filter = 'none';

        if (barWidth > 1) {
            MGRenderer._drawGradientRect(ctx, barX, 15, barWidth, 4, s.primary, s.accent);
        }

        if (mg.subtext && subOpacity > 0.01) {
            ctx.globalAlpha = Math.min(1, opacity) * subOpacity;
            MGRenderer._setFont(ctx, '500', 26, s.fontBody);
            ctx.fillStyle = s.accent;
            ctx.textAlign = textAlign;
            MGRenderer._drawTextShadowed(ctx, mg.subtext, textX, 50, s, false);
        }

        ctx.restore();
    }

    // ========================================================================
    // 2. LOWER THIRD
    // ========================================================================

    _renderLowerThird(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, speed } = anim;

        const clipAmount = interpolate(enterSpring, [0, 1], [0, 100]);
        const barScaleY = springValue(Math.max(0, frame - Math.round((0.15 / speed) * fps)), fps, {
            damping: 20, stiffness: 120, durationInFrames: Math.round((0.35 / speed) * fps),
        });

        const textDelay = Math.round((0.2 / speed) * fps);
        const textSpring = springValue(Math.max(0, frame - textDelay), fps, {
            damping: 18, stiffness: 100, durationInFrames: Math.round((0.3 / speed) * fps),
        });
        const textSlideX = interpolate(textSpring, [0, 1], [-15, 0]);

        const subDelay = Math.round((0.35 / speed) * fps);
        const subSpring = springValue(Math.max(0, frame - subDelay), fps, { damping: 18, stiffness: 100 });

        ctx.save();
        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);

        // Compute position based on mg.position
        const pos = (mg.position || 'bottom-left').toLowerCase().replace(/\s+/g, '-');
        const boxW = 700, boxH = 200, margin = 60;
        let baseX, baseY;
        if (pos.includes('top')) {
            baseY = margin + 20;
        } else {
            baseY = 1080 - boxH - margin;
        }
        if (pos.includes('right')) {
            baseX = 1920 - boxW - margin;
        } else if (pos === 'center' || pos === 'top' || pos === 'bottom') {
            baseX = (1920 - boxW) / 2;
        } else {
            baseX = margin;
        }

        ctx.beginPath();
        ctx.rect(baseX, baseY - 20, boxW * (clipAmount / 100), boxH);
        ctx.clip();

        const accentH = 120 * barScaleY;
        MGRenderer._drawGradientRect(ctx, baseX, baseY + 60 - accentH / 2, 4, accentH, s.primary, s.accent, 'vertical');

        MGRenderer._setFont(ctx, '700', 36, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.globalAlpha = Math.min(1, opacity) * textSpring;
        MGRenderer._drawTextShadowed(ctx, mg.text || '', baseX + 20 + textSlideX, baseY + 20, s, true);

        if (mg.subtext) {
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : subSpring);
            MGRenderer._setFont(ctx, '500', 22, s.fontBody);
            ctx.fillStyle = s.accent;
            MGRenderer._drawTextShadowed(ctx, mg.subtext, baseX + 20, baseY + 65, s, false);
        }

        ctx.restore();
    }

    // ========================================================================
    // 3. STAT COUNTER
    // ========================================================================

    _renderStatCounter(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate, easeOutCubic } = AnimationUtils;
        const { enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, enterFrames, totalFrames } = anim;

        const numberMatch = (mg.text || '').match(/[\d,.]+/);
        const targetNumber = numberMatch ? parseFloat(numberMatch[0].replace(/,/g, '')) : 0;
        const prefix = (mg.text || '').substring(0, (mg.text || '').indexOf(numberMatch?.[0] || '')).trim();
        const suffix = (mg.text || '').substring((mg.text || '').indexOf(numberMatch?.[0] || '') + (numberMatch?.[0]?.length || 0)).trim();

        const countStart = Math.round(enterFrames * 0.4);
        const countEnd = Math.max(countStart + 1, Math.min(enterFrames + fps, totalFrames - 15));
        const rawCount = interpolate(frame, [countStart, countEnd], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const countProgress = easeOutCubic(rawCount);

        const currentNumber = targetNumber % 1 !== 0
            ? (targetNumber * countProgress).toFixed(1)
            : Math.round(targetNumber * countProgress).toLocaleString();

        const scale = isExiting
            ? interpolate(exitProgress, [0, 1], [0.95, 1])
            : interpolate(enterSpring, [0, 1], [0.5, 1]);
        const blur = isExiting ? 0 : interpolate(enterLinear, [0, 0.4], [4, 0], { extrapolateRight: 'clamp' });

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        const pos = MGRenderer._getPosXY(mg.position || 'center', 400, 150);
        const cx = pos.x + 200;
        const cy = pos.y + 75;

        ctx.translate(cx, cy);
        ctx.scale(scale * idleScale, scale * idleScale);
        if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;

        MGRenderer._setFont(ctx, '900', 96, s.fontHeading);
        ctx.fillStyle = s.accent;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        MGRenderer._drawTextShadowed(ctx, `${prefix}${currentNumber}`, 0, -10, s, true);

        ctx.filter = 'none';

        const label = suffix || mg.subtext || '';
        if (label) {
            MGRenderer._setFont(ctx, '600', 28, s.fontBody);
            ctx.fillStyle = s.text;
            MGRenderer._drawTextShadowed(ctx, label, 0, 50, s, false);
        }

        ctx.restore();
    }

    // ========================================================================
    // 4. CALLOUT
    // ========================================================================

    _renderCallout(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, speed } = anim;

        const scale = isExiting
            ? interpolate(exitProgress, [0, 1], [0.97, 1])
            : interpolate(enterSpring, [0, 1], [0.92, 1]);
        const blur = isExiting ? 0 : interpolate(enterLinear, [0, 0.5], [3, 0], { extrapolateRight: 'clamp' });

        const quoteDelay = Math.round((0.1 / speed) * fps);
        const quoteSpring = springValue(Math.max(0, frame - quoteDelay), fps, {
            damping: 16, stiffness: 100, durationInFrames: Math.round((0.3 / speed) * fps),
        });
        const quoteY = interpolate(quoteSpring, [0, 1], [-15, 0]);

        ctx.save();
        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);

        MGRenderer._setFont(ctx, '600', 34, s.fontHeading);
        const textWidth = Math.min(ctx.measureText(mg.text || '').width + 80, 1920 * 0.7);
        const boxW = Math.max(400, textWidth);
        const boxH = mg.subtext ? 160 : 120;
        const pos = MGRenderer._getPosXY(mg.position || 'center', boxW, boxH);

        ctx.translate(pos.x + boxW / 2, pos.y + boxH / 2);
        ctx.scale(scale * idleScale, scale * idleScale);
        if (blur > 0.5) ctx.filter = `blur(${blur.toFixed(1)}px)`;

        if (s.glow) {
            ctx.shadowColor = s.primary + '30';
            ctx.shadowBlur = 10;
        } else {
            ctx.shadowColor = 'rgba(0,0,0,0.4)';
            ctx.shadowBlur = 16;
            ctx.shadowOffsetY = 4;
        }
        MGRenderer._roundRect(ctx, -boxW / 2, -boxH / 2, boxW, boxH, 12);
        ctx.fillStyle = s.bg;
        ctx.fill();
        ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
        ctx.strokeStyle = s.primary;
        ctx.lineWidth = 2;
        ctx.stroke();

        ctx.filter = 'none';

        ctx.globalAlpha = Math.min(1, opacity) * quoteSpring * 0.6;
        MGRenderer._setFont(ctx, '900', 64, s.fontHeading);
        ctx.fillStyle = s.primary;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText('\u201C', -boxW / 2 + 20, -boxH / 2 - 24 + quoteY);

        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : opacity);
        MGRenderer._setFont(ctx, 'italic 600', 34, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        MGRenderer._drawTextShadowed(ctx, mg.text || '', 0, mg.subtext ? -15 : 0, s, false);

        if (mg.subtext) {
            MGRenderer._setFont(ctx, '500', 20, s.fontBody);
            ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.75)';
            ctx.fillText(`\u2014 ${mg.subtext}`, 0, boxH / 2 - 30);
        }

        ctx.restore();
    }

    // ========================================================================
    // 5. BULLET LIST
    // ========================================================================

    _renderBulletList(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterSpring, enterFrames, isExiting, exitProgress } = anim;
        const items = (mg.text || '').split(/[,;]|\d+\.\s/).map(t => t.trim()).filter(Boolean);
        const staggerDelay = Math.round(fps * 0.25);

        ctx.save();
        ctx.globalAlpha = Math.min(1, isExiting ? exitProgress : enterSpring);

        const pos = MGRenderer._getPosXY(mg.position || 'center-left', 600, items.length * 50);

        items.forEach((item, i) => {
            const itemDelay = Math.round(enterFrames * 0.2 + i * staggerDelay);
            const itemSpring = springValue(Math.max(0, frame - itemDelay), fps, { damping: 16, stiffness: 120 });
            const slideX = interpolate(itemSpring, [0, 1], [40, 0]);
            const itemBlur = interpolate(itemSpring, [0, 0.5], [3, 0], { extrapolateRight: 'clamp' });

            const y = pos.y + i * 50;
            ctx.globalAlpha = Math.min(1, (isExiting ? exitProgress : 1)) * itemSpring;

            ctx.save();
            if (itemBlur > 0.5) ctx.filter = `blur(${itemBlur.toFixed(1)}px)`;

            ctx.beginPath();
            ctx.arc(pos.x + 5 + slideX, y + 15, 5, 0, Math.PI * 2);
            ctx.fillStyle = s.accent;
            ctx.fill();
            if (s.glow) {
                ctx.shadowColor = s.accent + '80';
                ctx.shadowBlur = 8;
                ctx.fill();
                ctx.shadowColor = 'transparent';
                ctx.shadowBlur = 0;
            }

            MGRenderer._setFont(ctx, '600', 30, s.fontBody);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            MGRenderer._drawTextShadowed(ctx, item, pos.x + 26 + slideX, y + 15, s, false);

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
        const { springValue, interpolate, easeOutCubic } = AnimationUtils;
        const { enterSpring, enterLinear, isExiting, exitProgress, opacity, idleScale, enterFrames, totalFrames } = anim;

        const numMatch = (mg.text || '').match(/[\d,.]+/);
        const targetPct = numMatch ? Math.min(100, parseFloat(numMatch[0].replace(/,/g, ''))) : 75;
        const label = (mg.text || '').replace(/[\d,.]+%?/, '').trim() || mg.subtext || '';

        const fillStart = Math.round(enterFrames * 0.5);
        const fillEnd = Math.max(fillStart + 1, Math.min(enterFrames + Math.round(fps * 0.3), totalFrames - 15));
        const fillProgress = easeOutCubic(interpolate(frame, [fillStart, fillEnd], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }));
        const currentPct = Math.round(targetPct * fillProgress);

        const scale = isExiting
            ? interpolate(exitProgress, [0, 1], [0.97, 1])
            : interpolate(enterSpring, [0, 1], [0.9, 1]);

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        const barW = 1920 * 0.6;
        const pos = MGRenderer._getPosXY(mg.position || 'center', barW, 120);
        const cx = pos.x + barW / 2;
        const cy = pos.y + 60;

        ctx.translate(cx, cy);
        ctx.scale(scale * idleScale, scale * idleScale);

        if (label) {
            MGRenderer._setFont(ctx, '700', 28, s.fontBody);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            MGRenderer._drawTextShadowed(ctx, label, 0, -40, s, false);
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

        MGRenderer._setFont(ctx, '900', 48, s.fontHeading);
        ctx.fillStyle = s.accent;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        MGRenderer._drawTextShadowed(ctx, `${currentPct}%`, 0, 45, s, true);

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

        MGRenderer._setFont(ctx, '700', 36, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        MGRenderer._drawTextShadowed(ctx, mg.text || '', 0, 0, s, true);

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
            MGRenderer._setFont(ctx, '700', 24, s.fontHeading);
            ctx.fillStyle = s.accent;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            MGRenderer._drawTextShadowed(ctx, item.value, bx + singleBarW / 2, by - 6, s, false);

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

        MGRenderer._setFont(ctx, '700', 32, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        MGRenderer._drawTextShadowed(ctx, mg.text || '', 0, -140, s, true);

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
        MGRenderer._setFont(ctx, '900', 36, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const mainPct = items.length > 0 ? Math.round((parseFloat(items[0].value) || 0) / total * 100) : 0;
        MGRenderer._drawTextShadowed(ctx, `${mainPct}%`, -130, 20, s, false);

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
        MGRenderer._setFont(ctx, '800', 42, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        MGRenderer._drawTextShadowed(ctx, itemA.toUpperCase(), 0, 0, s, true);
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
        MGRenderer._setFont(ctx, '800', 42, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        MGRenderer._drawTextShadowed(ctx, itemB.toUpperCase(), 0, 0, s, true);
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

        // Subtext
        if (mg.subtext && mg.subtext !== 'none') {
            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : subOpacity);
            MGRenderer._setFont(ctx, '500', 22, s.fontBody);
            ctx.fillStyle = s.textSub || 'rgba(255,255,255,0.75)';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            MGRenderer._drawTextShadowed(ctx, mg.subtext, 0, boxH / 2 + 40, s, false);
        }

        ctx.restore();
    }

    // ========================================================================
    // 11. TIMELINE
    // ========================================================================

    _renderTimeline(ctx, frame, fps, mg, s, anim) {
        const { springValue, interpolate } = AnimationUtils;
        const { enterSpring, enterFrames, isExiting, exitProgress, opacity, idleScale } = anim;
        const items = MGRenderer._parseKeyValuePairs(mg.subtext);
        const staggerDelay = Math.round(fps * 0.25);
        const lineWidth = interpolate(enterSpring, [0, 1], [0, 100]);

        ctx.save();
        ctx.globalAlpha = Math.min(1, opacity);

        const tlW = 1920 * 0.75;
        const pos = MGRenderer._getPosXY(mg.position || 'center', tlW, 200);
        const cx = pos.x + tlW / 2;
        const cy = pos.y + 100;

        ctx.translate(cx, cy);
        ctx.scale(idleScale, idleScale);

        if (mg.text) {
            MGRenderer._setFont(ctx, '700', 32, s.fontHeading);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            MGRenderer._drawTextShadowed(ctx, mg.text, 0, -70, s, true);
        }

        const lineW = tlW * lineWidth / 100;
        if (lineW > 0) {
            MGRenderer._drawGradientRect(ctx, -tlW / 2, -1.5, lineW, 3, s.primary, s.accent);
            if (s.glow) {
                ctx.shadowColor = s.primary + '60';
                ctx.shadowBlur = 8;
                ctx.fillRect(-tlW / 2, -1.5, lineW, 3);
                ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
            }
        }

        items.slice(0, 5).forEach((item, i) => {
            const pct = items.length > 1 ? i / (items.length - 1) : 0.5;
            const mx = -tlW / 2 + pct * tlW;
            const markerDelay = Math.round(enterFrames * 0.3 + i * staggerDelay);
            const markerSpring = springValue(Math.max(0, frame - markerDelay), fps, { damping: 16, stiffness: 120 });
            const slideY = interpolate(markerSpring, [0, 1], [-25, 0]);

            ctx.globalAlpha = Math.min(1, opacity) * (isExiting ? exitProgress : markerSpring);

            MGRenderer._setFont(ctx, '700', 22, s.fontHeading);
            ctx.fillStyle = s.accent;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            MGRenderer._drawTextShadowed(ctx, item.label, mx, -12 + slideY, s, false);

            ctx.beginPath();
            ctx.arc(mx, slideY, 7, 0, Math.PI * 2);
            ctx.fillStyle = s.accent;
            ctx.strokeStyle = s.text;
            ctx.lineWidth = 2;
            ctx.fill();
            ctx.stroke();
            if (s.glow) { ctx.shadowColor = s.accent + '80'; ctx.shadowBlur = 10; ctx.fill(); ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; }

            MGRenderer._setFont(ctx, '500', 18, s.fontBody);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            MGRenderer._drawTextShadowed(ctx, item.value, mx, 16 + slideY, s, false);
        });

        ctx.restore();
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

        MGRenderer._setFont(ctx, '700', 34, s.fontHeading);
        ctx.fillStyle = s.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        MGRenderer._drawTextShadowed(ctx, mg.text || '', 0, 0, s, true);

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

            MGRenderer._setFont(ctx, '900', 30, s.fontHeading);
            ctx.fillStyle = isTop ? s.accent : (s.textSub || 'rgba(255,255,255,0.75)');
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            MGRenderer._drawTextShadowed(ctx, `${i + 1}`, 24 + slideX, ry + 20, s, isTop);

            MGRenderer._setFont(ctx, '600', 22, s.fontBody);
            ctx.fillStyle = s.text;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            MGRenderer._drawTextShadowed(ctx, item.label, 60 + slideX, ry + 12, s, false);

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

    _renderMapChart(ctx, frame, fps, mg, s, anim) {
        const { interpolate } = AnimationUtils;
        const { totalFrames, opacity, enterProgress } = anim;
        const W = 1920, H = 1080;

        // Map visual styles
        const MAP_STYLES = {
            dark:      { ocean: '#0a1628', land: '#1a2744', border: 'rgba(30,58,95,0.4)', pin: '#00d4ff', label: '#ffffff', labelBg: 'rgba(10,22,40,0.88)' },
            natural:   { ocean: '#1a4a6e', land: '#3a6b4a', border: 'rgba(42,80,56,0.4)', pin: '#ffffff', label: '#ffffff', labelBg: 'rgba(15,30,20,0.88)' },
            satellite: { ocean: '#050d1a', land: '#141e14', border: 'rgba(26,48,32,0.3)', pin: '#00ffcc', label: '#ffffff', labelBg: 'rgba(5,10,15,0.9)' },
            light:     { ocean: '#d4e6f1', land: '#ecf0f1', border: 'rgba(189,195,199,0.6)', pin: '#e74c3c', label: '#2c3e50', labelBg: 'rgba(255,255,255,0.92)' },
            political: { ocean: '#b8d4e8', land: '#f0e6d3', border: 'rgba(138,122,106,0.5)', pin: '#c0392b', label: '#2c1810', labelBg: 'rgba(240,230,211,0.92)' },
        };
        const mps = MAP_STYLES[mg.mapStyle || 'dark'] || MAP_STYLES.dark;

        // Country coordinates for geographic positioning
        const MAP_COORDS = {
            'China': [104, 35], 'United States': [-98, 39], 'USA': [-98, 39],
            'India': [78, 22], 'Japan': [138, 36], 'Germany': [10.5, 51.2],
            'United Kingdom': [-2, 54], 'UK': [-2, 54], 'France': [2.2, 46.2],
            'Brazil': [-51, -10], 'Italy': [12.5, 42.5], 'Canada': [-106, 56],
            'Russia': [100, 60], 'South Korea': [128, 36], 'Australia': [134, -25],
            'Spain': [-3.7, 40.4], 'Mexico': [-102, 23], 'Indonesia': [118, -2],
            'Norway': [9, 62], 'Turkey': [35, 39], 'Saudi Arabia': [45, 24],
            'South Africa': [25, -29], 'Argentina': [-64, -34], 'Nigeria': [8, 10],
            'Egypt': [30, 27], 'Thailand': [101, 15], 'Vietnam': [108, 16],
            'Taiwan': [121, 24], 'Pakistan': [70, 30], 'Philippines': [122, 13],
        };

        // 1. Fill ocean background
        ctx.fillStyle = mps.ocean;
        ctx.fillRect(0, 0, W, H);

        // 2. Draw land mass (simplified ellipse continents)
        ctx.fillStyle = mps.land;
        const continents = [
            // [cx%, cy%, rx%, ry%] — rough continent shapes
            [25, 35, 12, 18],   // North America
            [30, 62, 7, 14],    // South America
            [52, 35, 10, 20],   // Europe/Africa
            [55, 62, 7, 12],    // Southern Africa
            [72, 35, 15, 18],   // Asia
            [78, 68, 8, 8],     // Australia
        ];
        for (const [cx, cy, rx, ry] of continents) {
            ctx.beginPath();
            ctx.ellipse(cx / 100 * W, cy / 100 * H, rx / 100 * W, ry / 100 * H, 0, 0, Math.PI * 2);
            ctx.fill();
        }

        // 3. Draw grid lines
        ctx.strokeStyle = mps.border;
        ctx.lineWidth = 1;
        for (let x = 0; x < W; x += W / 8) {
            ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        }
        for (let y = 0; y < H; y += H / 6) {
            ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
        }

        // 4. Title
        const title = mg.text || '';
        if (title) {
            ctx.font = `bold 42px ${s.fontFamily || 'Arial'}`;
            ctx.fillStyle = mps.label;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.shadowColor = 'rgba(0,0,0,0.5)';
            ctx.shadowBlur = 8;
            ctx.fillText(title, W / 2, 40);
            ctx.shadowBlur = 0;
        }

        // 5. Parse items and place pins
        const items = MGRenderer._parseKeyValuePairs(mg.subtext || '');
        const pinPositions = items.slice(0, 8).map((item, i) => {
            const coords = MAP_COORDS[item.label];
            let x, y;
            if (coords) {
                x = ((coords[0] + 180) / 360) * W * 0.85 + W * 0.07;
                y = ((90 - coords[1]) / 180) * H * 0.80 + H * 0.05;
            } else {
                const hash = (item.label || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
                x = W * 0.12 + ((hash * 7 + i * 137) % 76) / 100 * W;
                y = H * 0.15 + ((hash * 13 + i * 89) % 60) / 100 * H;
            }
            return { ...item, x, y, i };
        });

        const elapsed = frame / fps;
        const enterDur = 0.5 / (mg._animationSpeed || 1);

        for (const pin of pinPositions) {
            const pinProgress = Math.min(1, Math.max(0, (elapsed - enterDur * 0.3 - pin.i * 0.15) / 0.3));
            if (pinProgress <= 0) continue;

            const bounce = pinProgress < 1 ? (1 - pinProgress) * 10 : 0;
            const py = pin.y - bounce;
            const pinAlpha = pinProgress * opacity;

            ctx.globalAlpha = pinAlpha;

            // Pin dot with glow
            ctx.fillStyle = mps.pin;
            ctx.shadowColor = mps.pin;
            ctx.shadowBlur = 12;
            ctx.beginPath();
            ctx.arc(pin.x, py, 8, 0, Math.PI * 2);
            ctx.fill();
            ctx.shadowBlur = 0;

            // Pin ring
            ctx.strokeStyle = mps.pin;
            ctx.lineWidth = 2;
            const ringRadius = 14 + (1 - pinProgress) * 10;
            ctx.beginPath();
            ctx.arc(pin.x, py, ringRadius, 0, Math.PI * 2);
            ctx.stroke();

            // Label background
            const labelText = pin.label || '';
            const valueText = pin.value && pin.value !== '0' ? pin.value : '';
            ctx.font = `bold 20px ${s.fontFamily || 'Arial'}`;
            const labelW = ctx.measureText(labelText).width;
            const valueW = valueText ? ctx.measureText(valueText).width : 0;
            const boxW = Math.max(labelW, valueW) + 20;
            const boxH = valueText ? 52 : 32;
            const boxX = pin.x - boxW / 2;
            const boxY = py - 28 - boxH;

            ctx.fillStyle = mps.labelBg;
            ctx.beginPath();
            MGRenderer._roundRect(ctx, boxX, boxY, boxW, boxH, 6);
            ctx.fill();

            // Label text
            ctx.fillStyle = mps.label;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(labelText, pin.x, boxY + (valueText ? 16 : boxH / 2));

            // Value text
            if (valueText) {
                ctx.fillStyle = mps.pin;
                ctx.font = `bold 18px ${s.fontFamily || 'Arial'}`;
                ctx.fillText(valueText, pin.x, boxY + 38);
            }

            ctx.globalAlpha = 1;
        }
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
