/**
 * Deterministic guardrails for viewer-facing planner text.
 *
 * The Visual Planner has whole-video context, which is useful, but it can also
 * pull a word from a neighboring scene and place it too early. These helpers
 * keep prominent text anchored to the scene where the narration actually says it.
 */

const DISPLAY_STOPWORDS = new Set([
    'about', 'above', 'after', 'again', 'against', 'along', 'also', 'another',
    'because', 'before', 'being', 'between', 'could', 'every', 'first', 'from',
    'have', 'into', 'just', 'more', 'most', 'only', 'over', 'same', 'scene',
    'should', 'than', 'that', 'their', 'there', 'these', 'they', 'this', 'through',
    'under', 'very', 'what', 'when', 'where', 'which', 'while', 'with', 'would',
    'matter', 'matters', 'takeaway', 'route', 'routes', 'global', 'trade',
]);

const KEY_TAKEAWAY_SUMMARY_RE = /\b(?:key\s+takeaway|takeaway|in\s+short|the\s+point\s+is|this\s+means|that\s+means|which\s+means|that's\s+why|therefore|ultimately|the\s+result|the\s+conclusion|what\s+matters|why\s+it\s+matters|bottom\s+line)\b/i;

function parseTypedHint(value) {
    if (!value || typeof value !== 'string') return { type: null, content: '' };
    const colonIdx = value.indexOf(':');
    if (colonIdx <= 0) return { type: value.trim() || null, content: '' };
    return {
        type: value.substring(0, colonIdx).trim() || null,
        content: value.substring(colonIdx + 1).trim(),
    };
}

function normalizeWords(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/['']s\b/g, '')
        .replace(/[^a-z0-9%]+/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
}

function distinctiveWords(value) {
    const seen = new Set();
    const words = normalizeWords(value)
        .filter(w => w.length >= 4)
        .filter(w => !DISPLAY_STOPWORDS.has(w))
        .filter(w => !/^\d+$/.test(w))
        .filter(w => {
            if (seen.has(w)) return false;
            seen.add(w);
            return true;
        });
    return words.slice(0, 8);
}

function _stem(word) {
    if (!word || word.length < 5) return word;
    return word.replace(/(?:ing|edly|edly|ed|es|s)$/i, '');
}

function _textHasWord(text, target) {
    if (!target) return false;
    const targetStem = _stem(target);
    return normalizeWords(text).some(word => {
        if (word === target) return true;
        const wordStem = _stem(word);
        return targetStem.length >= 4 && wordStem === targetStem;
    });
}

function sceneContainsWord(scene, target) {
    if (!scene || !target) return false;
    if (_textHasWord(scene.text || '', target)) return true;
    if (Array.isArray(scene.words)) {
        return scene.words.some(w => _textHasWord(w && w.word, target));
    }
    return false;
}

function _adjacentScene(scene, scenes, offset) {
    if (!scene || !Array.isArray(scenes)) return null;
    const idx = Number.isFinite(scene.index) ? scene.index : scenes.indexOf(scene);
    return scenes.find(s => s && s.index === idx + offset) || null;
}

function getAdjacentDisplayTextDriftReason(scene, scenes, displayText, label = 'display text') {
    const words = distinctiveWords(displayText);
    if (words.length === 0) return null;

    const currentHits = words.filter(word => sceneContainsWord(scene, word));
    if (currentHits.length > 0) return null;

    const next = _adjacentScene(scene, scenes, 1);
    const prev = _adjacentScene(scene, scenes, -1);
    const nextHit = next ? words.find(word => sceneContainsWord(next, word)) : null;
    const prevHit = prev ? words.find(word => sceneContainsWord(prev, word)) : null;

    if (nextHit) {
        return `${label} token "${nextHit}" belongs to next scene ${next.index}`;
    }
    if (prevHit) {
        return `${label} token "${prevHit}" belongs to previous scene ${prev.index}`;
    }
    return null;
}

function _totalDuration(scenes, scriptContext = {}) {
    const explicit = Number(scriptContext.totalDuration);
    if (Number.isFinite(explicit) && explicit > 0) return explicit;
    const lastEnd = Math.max(0, ...(Array.isArray(scenes) ? scenes.map(s => Number(s && s.endTime) || 0) : []));
    return lastEnd || 60;
}

function validateTemplateHintPlacement(scene, scenes, scriptContext = {}) {
    const hint = parseTypedHint(scene && scene.templateHint);
    if (!hint.type) return null;

    const driftReason = getAdjacentDisplayTextDriftReason(
        scene,
        scenes,
        hint.content,
        `templateHint ${hint.type}`
    );
    if (driftReason) return driftReason;

    if (hint.type === 'keyTakeaway') {
        const total = _totalDuration(scenes, scriptContext);
        const finalQuarterStart = total * 0.75;
        const sceneStart = Number(scene && scene.startTime) || 0;
        const localText = String(scene && scene.text || '');
        if (sceneStart < finalQuarterStart && !KEY_TAKEAWAY_SUMMARY_RE.test(localText)) {
            return `keyTakeaway before final-quarter summary zone (${sceneStart.toFixed(1)}s < ${finalQuarterStart.toFixed(1)}s)`;
        }
    }

    return null;
}

function validateOverlayHintPlacement(scene, scenes) {
    const hint = parseTypedHint(scene && scene.mgHint);
    if (!hint.type || !hint.content) return null;

    if (hint.type === 'focusWord') {
        const words = distinctiveWords(hint.content);
        if (words.length === 1 && !sceneContainsWord(scene, words[0])) {
            return getAdjacentDisplayTextDriftReason(scene, scenes, hint.content, 'focusWord');
        }
    }

    return null;
}

module.exports = {
    parseTypedHint,
    distinctiveWords,
    sceneContainsWord,
    getAdjacentDisplayTextDriftReason,
    validateTemplateHintPlacement,
    validateOverlayHintPlacement,
};
