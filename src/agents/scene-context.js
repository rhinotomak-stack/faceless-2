/**
 * Scene Context Builder — assembles the rich, AI-friendly snapshot of a
 * scene that the Editor Agent CEO + workers see. The CEO uses this
 * context (plus the representative frame) to decide editorial actions.
 *
 * Stays decoupled from the rest of the codebase: takes the scene object,
 * the scriptContext, and the neighbouring scenes; produces a flat JSON
 * blob that can be dropped into any AI prompt.
 */

const _SUMMARY_FIELDS_TO_TRIM = 320;

function _clean(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function _shortText(value, max = _SUMMARY_FIELDS_TO_TRIM) {
    const text = _clean(value);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function _ratio(w, h) {
    if (!w || !h) return null;
    return Math.round((w / h) * 100) / 100;
}

function _formatTime(s) {
    if (!Number.isFinite(s)) return '0s';
    return `${Math.round(s * 10) / 10}s`;
}

function _neighbourSummary(scene) {
    if (!scene) return null;
    return {
        index: scene.index ?? null,
        framing: scene.framing || null,
        background: scene.background || null,
        hasFullscreenMG: !!scene.fullscreenMG,
        hasTemplate: !!(scene.template || scene._template),
        sourceHint: scene.sourceHint || null,
        keyword: _shortText(scene.searchKeyword || scene.keyword || '', 80),
    };
}

function _clipDescription(scene) {
    // clip-analyzer.js stamps this on the scene when it ran during download.
    const analysis = scene._clipAnalysis || scene.clipAnalysis || null;
    if (!analysis) return null;
    return {
        description: _shortText(analysis.description || '', 200),
        motion: _clean(analysis.motion || ''),
        issues: Array.isArray(analysis.issues) ? analysis.issues.slice(0, 4) : [],
        score: Number(analysis.score) || null,
    };
}

function buildSceneContext(scene, scriptContext = {}, neighbours = {}) {
    if (!scene) return null;
    const duration = (Number(scene.endTime) - Number(scene.startTime)) || 0;
    const width = Number(scene.mediaWidth || 0);
    const height = Number(scene.mediaHeight || 0);

    return {
        scene: {
            index: scene.index ?? null,
            originalIndex: scene.originalIndex ?? null,
            startTime: _formatTime(scene.startTime),
            endTime: _formatTime(scene.endTime),
            duration: _formatTime(duration),
            text: _shortText(scene.text || scene.transcript || '', 280),
            visualIntent: _shortText(scene.visualIntent || '', 200),
            searchKeyword: _shortText(scene.searchKeyword || scene.keyword || '', 100),
            sourceHint: scene.sourceHint || null,
            mediaType: scene.mediaType || null,
            // Director-supplied classifications, if any
            role: scene.role || scene._sceneClass || null,
            phase: scene.phase || null,
            // VP-supplied framing intent, if any
            framingHint: scene.framing || null,
            mgHint: scene.mgHint || null,
            // Existing fullscreen MG marker — relevant for inserts decisions
            isFullscreenMG: !!scene.fullscreenMG,
        },
        media: {
            file: scene.mediaFile ? scene.mediaFile.split(/[\\/]/).pop() : null,
            width,
            height,
            aspectRatio: _ratio(width, height),
            visionScore: Number(scene.visionScore) || null,
            duration: _formatTime(duration),
        },
        clipAnalysis: _clipDescription(scene),
        script: {
            niche: scriptContext?.nicheId || scriptContext?.niche || null,
            theme: scriptContext?.themeId || scriptContext?.theme || null,
            tone: scriptContext?.tone || null,
            pacing: scriptContext?.pacing || null,
            summary: _shortText(scriptContext?.summary || scriptContext?.videoTopic || '', 260),
            entities: Array.isArray(scriptContext?.entities) ? scriptContext.entities.slice(0, 8) : [],
        },
        neighbours: {
            prev: _neighbourSummary(neighbours.prev),
            next: _neighbourSummary(neighbours.next),
        },
    };
}

module.exports = { buildSceneContext };
