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
    const themeId = opts.themeId && opts.themeId !== 'auto' ? opts.themeId : 'standard';
    const nicheId = opts.nicheId && opts.nicheId !== 'auto' ? opts.nicheId : 'general';
    const vertical = String(opts.aspectRatio || '16:9') === '9:16';
    const high = String(opts.resolution || '720p').toLowerCase() === '1080p';
    const landscape = high ? { width: 1920, height: 1080 } : { width: 1280, height: 720 };
    const dimensions = vertical
        ? { width: landscape.height, height: landscape.width }
        : landscape;
    const scenes = (ctx && ctx.scenes ? ctx.scenes : []).map((s) => {
        const clip = clips.find((c) => c.sceneIndex === s.index) || null;
        return {
            index: s.index,
            text: s.text,
            keyword: s.text,
            visualIntent: s.text,
            startTime: s.startTime,
            endTime: s.startTime + s.duration,
            duration: s.duration,
            durationUnit: 'seconds',
            mediaFile: clip && clip.file ? clip.file : null,
            mediaType: clip && clip.file ? 'video' : 'gradient',
            mediaExtension: clip && clip.file ? '.mp4' : null,
            mediaWidth: clip && clip.file ? dimensions.width : 0,
            mediaHeight: clip && clip.file ? dimensions.height : 0,
            sourceProvider: clip?.backend || null,
            sourceHint: 'ai-video',
            trackId: 'video-track-1',
            backgroundId: clip && clip.file ? undefined : 'dark-gradient',
            _aiVideoPrompt: clip ? clip.prompt : null,
            _dryRun: clip ? !!clip.dryRun : true,
            _generationError: clip?.error || null,
        };
    });
    const totalDuration = scenes.reduce((m, s) => Math.max(m, s.startTime + s.duration), 0);
    const generationWarnings = clips
        .filter((clip) => clip?.error)
        .map((clip) => ({ sceneIndex: clip.sceneIndex, error: clip.error }));
    return {
        scenes,
        mgScenes: [],
        transitions: [],
        overlayScenes: [],
        sfxClips: [],
        totalDuration,
        fps: opts.fps || 30,
        width: dimensions.width,
        height: dimensions.height,
        themeId,
        productionMode: 'aiVideos',
        scriptContext: {
            productionMode: 'aiVideos',
            format: 'aiVideo',
            themeId,
            nicheId,
            title: opts.videoTitle || '',
            qualityTier: opts.qualityTier || 'standard',
            aiInstructions: opts.aiInstructions || '',
            inputSource: 'script',
            _source: 'ai-videos-script',
        },
        generationWarnings,
        _generatedFrom: 'ai-videos-script',
    };
}

module.exports = { buildPlan };
