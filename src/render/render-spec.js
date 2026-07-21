'use strict';

(function exposeRenderSpec(root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.YtaRenderSpec = api;
}(typeof window !== 'undefined' ? window : null, function createRenderSpec() {
    const VERSION = 1;
    const QUALITY_VALUES = new Set(['draft', 'standard', 'high']);
    const RENDERERS = new Set(['hyperframes', 'webgl2']);

    function _number(value, fallback) {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function _dimension(value, fallback, label) {
        const parsed = _number(value, fallback);
        if (!Number.isInteger(parsed) || parsed < 16 || parsed > 7680 || parsed % 2 !== 0) {
            throw new Error(`Invalid render ${label}: ${value}`);
        }
        return parsed;
    }

    function normalizeRenderSpec(raw = {}, plan = {}) {
        const renderer = RENDERERS.has(raw.renderer) ? raw.renderer : 'hyperframes';
        const quality = QUALITY_VALUES.has(raw.quality) ? raw.quality : 'standard';
        const width = _dimension(raw.width, _dimension(plan.width, 1920, 'width'), 'width');
        const height = _dimension(raw.height, _dimension(plan.height, 1080, 'height'), 'height');
        const fps = _number(raw.fps, _number(plan.fps, 30));
        if (!(fps >= 1 && fps <= 120)) throw new Error(`Invalid render fps: ${raw.fps}`);

        const deterministic = raw.deterministic === true;
        const workersRaw = Math.floor(_number(raw.workers, deterministic ? 1 : 4));
        const workers = deterministic ? 1 : Math.max(1, Math.min(8, workersRaw));
        return {
            version: VERSION,
            renderer,
            quality,
            format: 'mp4',
            width,
            height,
            fps,
            deterministic,
            legacy: raw.legacy === true,
            gpu: deterministic ? false : raw.gpu !== false,
            browserGpu: deterministic ? false : raw.browserGpu !== false,
            workers,
            strict: deterministic || raw.strict === true,
        };
    }

    function webglEncoderPolicy(spec) {
        const normalized = normalizeRenderSpec(spec, spec);
        const cpu = {
            draft: { preset: 'veryfast', crf: 28 },
            standard: { preset: 'medium', crf: 22 },
            high: { preset: 'slow', crf: 18 },
        }[normalized.quality];
        const nvenc = {
            draft: { preset: 'p2', bitrate: '10M', maxrate: '14M', bufsize: '28M' },
            standard: { preset: 'p4', bitrate: '18M', maxrate: '24M', bufsize: '48M' },
            high: { preset: 'p6', bitrate: '28M', maxrate: '36M', bufsize: '72M' },
        }[normalized.quality];
        return { cpu, nvenc };
    }

    return {
        VERSION,
        normalizeRenderSpec,
        webglEncoderPolicy,
    };
}));
