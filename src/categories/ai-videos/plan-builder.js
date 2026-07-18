// src/categories/ai-videos/plan-builder.js
// ============================================================================
// Stage 5 of the AI Videos pipeline: assemble scenes + generated clips into a
// video-plan object the HyperFrames renderer can load. Pure + unit-testable.
// (A dry-run plan has mediaFile:null on every scene; a real run has the generated
// clip paths — the shape is identical, so wiring the renderer is the same either way.)
// ============================================================================
'use strict';

function buildPlan(ctx, opts = {}) {
    const clips = (ctx && ctx.clips) ? ctx.clips : [];
    const scenes = (ctx && ctx.scenes ? ctx.scenes : []).map((s) => {
        const clip = clips.find((c) => c.sceneIndex === s.index) || null;
        return {
            index: s.index,
            text: s.text,
            startTime: s.startTime,
            duration: s.duration,
            mediaFile: clip && clip.file ? clip.file : null,
            sourceHint: 'ai-video',
            trackId: 'video-track-1',
            _aiVideoPrompt: clip ? clip.prompt : null,
            _dryRun: clip ? !!clip.dryRun : true,
        };
    });
    const totalDuration = scenes.reduce((m, s) => Math.max(m, s.startTime + s.duration), 0);
    return {
        scenes,
        totalDuration,
        fps: opts.fps || 30,
        productionMode: 'aiVideos',
        scriptContext: { productionMode: 'aiVideos', format: 'aiVideo', _source: 'ai-videos-script' },
        _generatedFrom: 'ai-videos-script',
    };
}

module.exports = { buildPlan };
