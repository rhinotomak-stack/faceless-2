/**
 * map-render-engine.js — Shared, pure map renderer (GEOLayers-grade).
 *
 * ONE implementation used everywhere:
 *   • HyperFrames runtime (canvas in the generated HF HTML)
 *   • headless capture (node + @napi-rs/canvas, final video frames)
 *   • test harness (regression checks)
 *
 * Pure: no app globals, no DOM assumptions, no network. Inputs are the
 * authoritative MapScene (mapMode + cameraPlan + renderAssets) plus a preloaded
 * basemap image and a time `t`. Output is pixels drawn on a 2D context.
 *
 *   drawMapFrame(ctx, mapScene, {
 *       t,                       // seconds into the scene
 *       duration,                // scene duration in seconds
 *       W, H,                    // output size (default 1920x1080)
 *       basemapImage,            // preloaded Image/Canvas for renderAssets.mapImageFile
 *       opacity,                 // 0..1 (entrance/exit handled by caller)
 *       labelFont,               // optional font family
 *   })
 *
 * Works in both CommonJS (module.exports) and browser (window.MapRenderEngine).
 */
(function (root) {
    'use strict';

    // ── Easing ──
    const clamp01 = (t) => Math.min(1, Math.max(0, t));
    const easeCubicOut = (t) => { t = clamp01(t); return 1 - Math.pow(1 - t, 3); };
    const smoother = (t) => { t = clamp01(t); return t * t * t * (t * (t * 6 - 15) + 10); };

    // ── Style palettes (border + accent colors per basemap style) ──
    const STYLE_PALETTES = {
        satellite: { borders: ['#00e0ff', '#ff7a3d', '#46ff9b', '#ffd24a'], route: '#ffe680', routeGlow: 'rgba(255,210,74,0.35)', pin: '#00e0ff', pinText: '#ffffff', vignette: 0.34 },
        dark:      { borders: ['#00d4ff', '#ff6040', '#40ff90', '#f0c040'], route: '#00d4ff', routeGlow: 'rgba(0,212,255,0.30)', pin: '#00d4ff', pinText: '#ffffff', vignette: 0.30 },
        political: { borders: ['#0a84ff', '#e0322b', '#1f9d55', '#b8860b'], route: '#0a84ff', routeGlow: 'rgba(10,132,255,0.30)', pin: '#0a84ff', pinText: '#ffffff', vignette: 0.12 },
        light:     { borders: ['#2060c0', '#d04030', '#1f9d55', '#b8860b'], route: '#2060c0', routeGlow: 'rgba(32,96,192,0.25)', pin: '#2060c0', pinText: '#ffffff', vignette: 0.10 },
        natural:   { borders: ['#1f9d55', '#d08030', '#2060c0', '#b8860b'], route: '#d08030', routeGlow: 'rgba(208,128,48,0.28)', pin: '#1f9d55', pinText: '#ffffff', vignette: 0.18 },
    };
    const paletteFor = (style) => STYLE_PALETTES[style] || STYLE_PALETTES.satellite;

    // ── Build the tileZ Mercator projection from renderAssets.mapView ──
    // Matches the projection used when the basemap was stitched (z = floor(zoom)).
    function buildProjection(mapView, IMG_W, IMG_H) {
        const TILE = 512;
        const z = Math.max(2, Math.floor(mapView.zoom));
        const n = Math.pow(2, z);
        const cTileX = ((mapView.lon + 180) / 360) * n;
        const cLatRad = mapView.lat * Math.PI / 180;
        const cTileY = (1 - Math.log(Math.tan(cLatRad) + 1 / Math.cos(cLatRad)) / Math.PI) / 2 * n;
        const originPx = cTileX * TILE - IMG_W / 2;
        const originPy = cTileY * TILE - IMG_H / 2;
        const toX = (lon) => ((lon + 180) / 360) * n * TILE - originPx;
        const toY = (lat) => { const r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n * TILE - originPy; };
        return { toX, toY };
    }

    // ── Geometry helpers ──
    function polysOf(geom) {
        if (!geom) return [];
        if (geom.type === 'Polygon') return [geom.coordinates];
        if (geom.type === 'MultiPolygon') return geom.coordinates;
        return [];
    }
    function tracePoly(ctx, geom, toX, toY) {
        for (const poly of polysOf(geom)) for (const ring of poly) {
            if (!ring || ring.length < 3) continue;
            ctx.moveTo(toX(ring[0][0]), toY(ring[0][1]));
            for (let i = 1; i < ring.length; i++) ctx.lineTo(toX(ring[i][0]), toY(ring[i][1]));
            ctx.closePath();
        }
    }
    function polyPerim(geom, toX, toY) {
        let L = 0;
        for (const poly of polysOf(geom)) for (const ring of poly) for (let i = 1; i < ring.length; i++) {
            const dx = toX(ring[i][0]) - toX(ring[i - 1][0]); const dy = toY(ring[i][1]) - toY(ring[i - 1][1]);
            L += Math.sqrt(dx * dx + dy * dy);
        }
        return L;
    }
    function geomBoundsPx(geom, toX, toY, b) {
        for (const poly of polysOf(geom)) for (const ring of poly) for (const pt of ring) {
            const x = toX(pt[0]), y = toY(pt[1]);
            if (x < b.mnX) b.mnX = x; if (y < b.mnY) b.mnY = y;
            if (x > b.mxX) b.mxX = x; if (y > b.mxY) b.mxY = y;
        }
    }

    // ── Camera: returns { camX, camY, scale } in basemap-pixel space ──
    function computeCamera(scene, ra, proj, t, duration, W, H, IMG_W, IMG_H) {
        const { toX, toY } = proj;
        const mode = scene.mapMode || 'locator';
        const osm = ra.osmBoundaries || [];
        const pins = (ra.mapView && ra.mapView.pins) || [];
        const routeGeo = (ra.routeGeometry || []).map(g => ({ px: toX(g.lon), py: toY(g.lat), startTime: g.startTime, endTime: g.endTime }));

        // ROUTE: travel the corridor smoothly by arc-length (no stop-go).
        if (mode === 'route' && routeGeo.length >= 2) {
            // sort the camera path west→east so it never doubles back, while the
            // drawn route line keeps the authored order (handled in draw).
            const path = routeGeo.slice().sort((a, b) => a.px - b.px);
            const segs = []; let total = 0;
            for (let i = 1; i < path.length; i++) { const dx = path[i].px - path[i - 1].px, dy = path[i].py - path[i - 1].py; const len = Math.max(1, Math.hypot(dx, dy)); segs.push({ a: path[i - 1], b: path[i], len }); total += len; }
            // ease-in/out over the whole scene, hold a beat at each end
            const p = smoother(clamp01((t - 0.4) / Math.max(0.1, duration - 0.8)));
            let want = p * total, camX = path[0].px, camY = path[0].py, acc = 0;
            for (const s of segs) { if (want <= acc + s.len) { const f = (want - acc) / s.len; camX = s.a.px + (s.b.px - s.a.px) * f; camY = s.a.py + (s.b.py - s.a.py) * f; break; } acc += s.len; camX = s.b.px; camY = s.b.py; }
            // zoom: frame ~ the longest segment span; gentle push-in
            const spanX = Math.max(...path.map(p => p.px)) - Math.min(...path.map(p => p.px));
            const spanY = Math.max(...path.map(p => p.py)) - Math.min(...path.map(p => p.py));
            const fit = Math.min(W / (Math.max(spanX, 1) * 0.45), H / (Math.max(spanY, 1) * 1.6));
            let scale = Math.max(0.32, Math.min(0.85, fit)) * (1 + 0.06 * smoother(t / Math.max(1, duration)));
            return clampCam(camX, camY, scale, W, H, IMG_W, IMG_H);
        }

        // REGION / LOCATOR / COMPARISON: fit bbox of borders (else pins), gentle drift + slow push-in.
        const b = { mnX: Infinity, mnY: Infinity, mxX: -Infinity, mxY: -Infinity };
        for (const o of osm) if (o.feature) geomBoundsPx(o.feature.geometry, toX, toY, b);
        if (!isFinite(b.mnX)) { for (const p of pins) { const x = toX(p.lon), y = toY(p.lat); b.mnX = Math.min(b.mnX, x); b.mnY = Math.min(b.mnY, y); b.mxX = Math.max(b.mxX, x); b.mxY = Math.max(b.mxY, y); } }
        if (!isFinite(b.mnX)) return clampCam(IMG_W / 2, IMG_H / 2, Math.max(W / IMG_W, H / IMG_H), W, H, IMG_W, IMG_H);
        const cx = (b.mnX + b.mxX) / 2, cy = (b.mnY + b.mxY) / 2;
        const spanX = Math.max(1, b.mxX - b.mnX), spanY = Math.max(1, b.mxY - b.mnY);
        const headroom = pins.length <= 1 ? 1.9 : 1.35;
        const fit = Math.min(W / (spanX * headroom), H / (spanY * headroom));
        const g = smoother(t / Math.max(1, duration));
        const scale = fit * (1 + 0.10 * g);
        const driftR = Math.min(spanX, spanY) * 0.04;
        return clampCam(cx + Math.sin(t * 0.5) * driftR, cy + Math.cos(t * 0.38) * driftR * 0.7, scale, W, H, IMG_W, IMG_H);
    }

    // keep visible window inside the stitched basemap (no black bars)
    function clampCam(camX, camY, scale, W, H, IMG_W, IMG_H) {
        const halfW = (W / 2) / scale, halfH = (H / 2) / scale;
        if (IMG_W >= 2 * halfW) camX = Math.min(IMG_W - halfW, Math.max(halfW, camX)); else camX = IMG_W / 2;
        if (IMG_H >= 2 * halfH) camY = Math.min(IMG_H - halfH, Math.max(halfH, camY)); else camY = IMG_H / 2;
        return { camX, camY, scale };
    }

    // ── Main entry ──
    function drawMapFrame(ctx, scene, opts) {
        opts = opts || {};
        const W = opts.W || 1920, H = opts.H || 1080;
        const t = opts.t || 0;
        const duration = opts.duration || 8;
        const opacity = opts.opacity == null ? 1 : opts.opacity;
        const font = opts.labelFont || 'Arial, sans-serif';
        const ra = scene && scene.renderAssets;
        if (!ra) return false;
        const base = opts.basemapImage || null;
        const IMG_W = (ra.bigMapSize && ra.bigMapSize.w) || (base && base.width) || W;
        const IMG_H = (ra.bigMapSize && ra.bigMapSize.h) || (base && base.height) || H;
        const mapView = ra.mapView || { lon: 0, lat: 20, zoom: 2 };
        const proj = buildProjection(mapView, IMG_W, IMG_H);
        const { toX, toY } = proj;
        const pal = paletteFor(opts.style || scene.mapStyle || 'satellite');

        const osm = ra.osmBoundaries || [];
        const pins = (ra.mapView && ra.mapView.pins) || [];
        const routeGeo = (ra.routeGeometry || []);
        const cam = computeCamera(scene, ra, proj, t, duration, W, H, IMG_W, IMG_H);
        const lw = (px) => px / cam.scale;

        ctx.save();
        ctx.globalAlpha = opacity;

        // world transform
        ctx.save();
        ctx.translate(W / 2, H / 2);
        ctx.scale(cam.scale, cam.scale);
        ctx.translate(-cam.camX, -cam.camY);

        // 1) basemap
        if (base) ctx.drawImage(base, 0, 0, IMG_W, IMG_H);
        else { ctx.fillStyle = '#06101f'; ctx.fillRect(cam.camX - W, cam.camY - H, W * 2, H * 2); }

        // 2) borders — progressive glowing stroke draw-on (staggered)
        osm.forEach((o, i) => {
            const geom = o.feature && o.feature.geometry; if (!geom) return;
            const col = pal.borders[i % pal.borders.length];
            const delay = 0.4 + i * 0.55;
            const sp = easeCubicOut(clamp01((t - delay) / 1.6));
            if (sp <= 0) return;
            const pulse = (Math.sin(t * 1.6 + i) + 1) / 2;
            // tinted fill
            ctx.save(); ctx.beginPath(); tracePoly(ctx, geom, toX, toY); ctx.clip('evenodd');
            ctx.globalAlpha = opacity * 0.20 * sp; ctx.fillStyle = col; ctx.fillRect(cam.camX - W / cam.scale, cam.camY - H / cam.scale, (W / cam.scale) * 2, (H / cam.scale) * 2);
            ctx.restore();
            // progressive stroke
            ctx.save(); ctx.globalAlpha = opacity; ctx.strokeStyle = col; ctx.lineJoin = 'round';
            ctx.lineWidth = lw(3.2); ctx.shadowColor = col; ctx.shadowBlur = lw(13 + pulse * 7);
            if (sp >= 1) { ctx.beginPath(); tracePoly(ctx, geom, toX, toY); ctx.stroke(); }
            else { const total = polyPerim(geom, toX, toY); ctx.setLineDash([total * sp, total]); ctx.beginPath(); tracePoly(ctx, geom, toX, toY); ctx.stroke(); ctx.setLineDash([]); }
            if (sp > 0.4) { ctx.globalAlpha = opacity * 0.16 * pulse; ctx.lineWidth = lw(9); ctx.shadowBlur = lw(26); ctx.beginPath(); tracePoly(ctx, geom, toX, toY); ctx.stroke(); }
            ctx.restore();
        });

        // 3) route — glow + dashed marching ants up to active progress (authored order)
        if ((ra.routePath || scene.mapMode === 'route') && routeGeo.length >= 2) {
            const pts = routeGeo.map(g => ({ px: toX(g.lon), py: toY(g.lat), startTime: g.startTime }));
            const segs = []; for (let i = 1; i < pts.length; i++) { const dx = pts[i].px - pts[i - 1].px, dy = pts[i].py - pts[i - 1].py; segs.push({ a: pts[i - 1], b: pts[i], len: Math.hypot(dx, dy) }); }
            let drawLen = 0; for (const s of segs) drawLen += s.len * easeCubicOut(clamp01((t - (s.b.startTime || 0)) / 1.0));
            if (drawLen > 0) {
                const drawPath = () => { ctx.beginPath(); ctx.moveTo(pts[0].px, pts[0].py); let acc = 0; for (const s of segs) { const rem = drawLen - acc; if (rem <= 0) break; const f = Math.min(1, rem / s.len); ctx.lineTo(s.a.px + (s.b.px - s.a.px) * f, s.a.py + (s.b.py - s.a.py) * f); acc += s.len; if (f < 1) break; } ctx.stroke(); };
                ctx.save();
                ctx.globalAlpha = opacity * 0.5; ctx.strokeStyle = pal.routeGlow; ctx.lineWidth = lw(9); ctx.lineCap = 'round'; ctx.setLineDash([]); drawPath();
                ctx.globalAlpha = opacity * 0.95; ctx.strokeStyle = pal.route; ctx.lineWidth = lw(3.2); ctx.setLineDash([lw(14), lw(9)]); ctx.lineDashOffset = -t * 30; ctx.shadowColor = pal.route; ctx.shadowBlur = lw(6); drawPath();
                ctx.setLineDash([]); ctx.restore();
            }
        }
        ctx.restore(); // end world transform

        // 4) pins + labels (screen space for crisp text)
        const toScreen = (lon, lat) => ({ x: (toX(lon) - cam.camX) * cam.scale + W / 2, y: (toY(lat) - cam.camY) * cam.scale + H / 2 });
        pins.slice(0, 8).forEach((p, i) => {
            const appear = easeCubicOut(clamp01((t - (0.6 + i * 0.35)) / 0.6));
            if (appear <= 0) return;
            const s = toScreen(p.lon, p.lat);
            const col = pal.borders[i % pal.borders.length];
            const r = 9 * appear;
            ctx.save();
            ctx.globalAlpha = opacity * appear;
            // radar ping
            const ping = ((t * 0.7 + i * 0.4) % 2) / 2;
            ctx.globalAlpha = opacity * appear * (1 - ping) * 0.5; ctx.strokeStyle = col; ctx.lineWidth = 2;
            ctx.beginPath(); ctx.arc(s.x, s.y, r + ping * 26, 0, Math.PI * 2); ctx.stroke();
            ctx.globalAlpha = opacity * appear;
            ctx.beginPath(); ctx.arc(s.x, s.y, r + 7, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.14)'; ctx.fill();
            ctx.beginPath(); ctx.arc(s.x, s.y, r, 0, Math.PI * 2); ctx.fillStyle = col; ctx.fill();
            ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.stroke();
            const label = String(p.name || '').toUpperCase();
            if (label) {
                ctx.font = `bold 30px ${font}`; ctx.textBaseline = 'middle';
                const tw = ctx.measureText(label).width;
                ctx.fillStyle = 'rgba(5,10,22,0.82)'; ctx.fillRect(s.x + 16, s.y - 22, tw + 22, 44);
                ctx.fillStyle = pal.pinText; ctx.fillText(label, s.x + 27, s.y + 1);
            }
            ctx.restore();
        });

        // 5) subtle vignette
        if (pal.vignette > 0) {
            const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.62);
            g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(2,6,16,${pal.vignette})`);
            ctx.globalAlpha = opacity; ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
        }

        ctx.restore();
        return true;
    }

    const api = { drawMapFrame, buildProjection, _easing: { easeCubicOut, smoother } };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.MapRenderEngine = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
