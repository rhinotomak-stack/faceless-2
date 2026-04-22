/**
 * speech-units.js — Phase 1 Smart Splitter
 *
 * Builds pause/VAD-like "speech units" from Whisper's word-level timestamps.
 * Replaces the legacy punctuation-based micro-splitter (_splitAtPunctuation).
 *
 * Unit shape matches legacy microScenes so downstream code is compatible:
 *   { index, text, startTime, endTime, duration, words[],
 *     pauseBefore, pauseAfter, crossedSegment, entityProtected }
 */

'use strict';

// Module-level defaults — USED ONLY when no niche config is passed to
// buildSpeechUnits(). In production the caller (ai-director.js) passes
// nicheCfg.unitThresholds, which comes from niches.js and can be overridden
// per-niche. These defaults remain for backward-compatible callers and tests.
const DEFAULT_THRESHOLDS = {
    minUnitDur:   0.8,
    maxUnitDur:   6.0,
    pauseHardSec: 0.8,
    pauseSoftSec: 0.4,
    entityWindow: 3,
    // Whisper segment boundaries are advisory. They only promote a unit break
    // when they coincide with at least this much real silence — otherwise
    // they're ignored (a segment edge with no pause is a Whisper chunking
    // artifact, not a genuine narration boundary). Per-niche overrides in
    // niches.js raise this for explainer body narration.
    segmentHintMinPause: 0.25,
};

/**
 * Flatten segments → words, tagging each word with its Whisper segment index.
 */
function _flattenWithSegmentIndex(transcription) {
    const out = [];
    const segments = (transcription && transcription.segments) || [];
    for (let si = 0; si < segments.length; si++) {
        const seg = segments[si];
        const ws = seg && seg.words;
        if (!ws || !ws.length) continue;
        for (const w of ws) {
            if (!w || typeof w.start !== 'number' || typeof w.end !== 'number') continue;
            out.push({
                word: String(w.word || '').trim(),
                start: w.start,
                end: w.end,
                segmentIndex: si,
            });
        }
    }
    return out;
}

/**
 * Normalize a token for entity matching: lowercase, strip trailing punctuation.
 */
function _norm(token) {
    return String(token || '').toLowerCase().replace(/[.,!?;:"'()\[\]]+$/g, '').replace(/^["'(\[]/g, '');
}

/**
 * Best-effort local entity protection.
 * If a multi-word entity from scriptContext.entities straddles the candidate
 * break point between word[i] and word[i+1], return the adjusted break index
 * (either before or after the phrase) — whichever is closer. Returns `null`
 * if no straddling entity is found, meaning the caller should keep i.
 *
 * Only checks a small window of ENTITY_WINDOW words on each side — this is
 * intentional so we never build a global entity index.
 */
function _findEntityProtectedBreak(words, i, entitiesMulti, entityWindow) {
    if (!entitiesMulti.length) return null;
    const lo = Math.max(0, i - entityWindow + 1);
    const hi = Math.min(words.length, i + entityWindow + 1);
    const windowTokens = [];
    for (let k = lo; k < hi; k++) windowTokens.push(_norm(words[k].word));

    for (const phrase of entitiesMulti) {
        const p = phrase.tokens;
        if (p.length < 2) continue;
        // Slide the phrase across the window. Find every occurrence and check
        // whether the break (between index i and i+1) falls inside it.
        for (let off = 0; off <= windowTokens.length - p.length; off++) {
            let matched = true;
            for (let k = 0; k < p.length; k++) {
                if (windowTokens[off + k] !== p[k]) { matched = false; break; }
            }
            if (!matched) continue;
            const absStart = lo + off;
            const absEnd   = absStart + p.length - 1; // inclusive last word index of phrase
            // Break is between word[i] and word[i+1], i.e. splits phrase if absStart<=i<absEnd
            if (absStart <= i && i < absEnd) {
                // Decide: move break BEFORE the phrase (to absStart-1) or AFTER (to absEnd)
                const distBefore = i - (absStart - 1);
                const distAfter  = absEnd - i;
                const adjusted = distAfter <= distBefore ? absEnd : Math.max(0, absStart - 1);
                return adjusted;
            }
        }
    }
    return null;
}

/**
 * Pre-compute multi-word entity phrases from scriptContext.entities.
 * Single-word entities don't need protection (no "inside" to break).
 */
function _prepareEntityPhrases(scriptContext) {
    const entities = (scriptContext && Array.isArray(scriptContext.entities)) ? scriptContext.entities : [];
    const multi = [];
    for (const e of entities) {
        if (!e) continue;
        const tokens = String(e).split(/\s+/).map(_norm).filter(Boolean);
        if (tokens.length >= 2) multi.push({ tokens });
    }
    return multi;
}

/**
 * Emit a unit from the accumulated word buffer.
 */
function _emitUnit(buf, nextWordStart, allEndTime, indexCounter, crossedSegment, entityProtected, lastPauseAfter) {
    if (!buf.length) return null;
    const startTime = buf[0].start;
    const endOfLast = buf[buf.length - 1].end;
    // pauseAfter = gap to the next word; if we're at the tail, use (allEndTime - endOfLast) or 0
    const pauseAfter = nextWordStart !== null
        ? Math.max(0, nextWordStart - endOfLast)
        : Math.max(0, (allEndTime || endOfLast) - endOfLast);
    return {
        index: indexCounter,
        text: buf.map(w => w.word).join(' ').trim(),
        startTime,
        endTime: endOfLast,
        duration: endOfLast - startTime,
        words: buf.map(w => ({ word: w.word, start: w.start, end: w.end })),
        pauseBefore: 0,      // will be patched in second pass
        pauseAfter,
        crossedSegment: !!crossedSegment,
        entityProtected: !!entityProtected,
        _pauseAfter: pauseAfter,
    };
}

/**
 * Main entry point.
 *
 * @param {Object} transcription Full Whisper output (not pre-flattened).
 * @param {Object} scriptContext Parsed context, used for entity protection.
 * @param {number} fps Frames per second (only needed by downstream scene assembler,
 *   kept here for signature parity).
 * @param {Object} [nicheCfg] Optional niche split config. When present, its
 *   `unitThresholds` override module-level defaults. Backward-compatible.
 * @returns {Array} speech units, same fields as legacy microScenes plus extras.
 */
function buildSpeechUnits(transcription, scriptContext, fps, nicheCfg) {
    const words = _flattenWithSegmentIndex(transcription);
    if (!words.length) {
        console.log('[SpeechUnits] no word-level timestamps available — returning []');
        return [];
    }

    const th = Object.assign({}, DEFAULT_THRESHOLDS, (nicheCfg && nicheCfg.unitThresholds) || {});
    const { minUnitDur: MIN_UNIT_DUR, maxUnitDur: MAX_UNIT_DUR,
            pauseHardSec: PAUSE_HARD_SEC, pauseSoftSec: PAUSE_SOFT_SEC,
            entityWindow: ENTITY_WINDOW,
            segmentHintMinPause: SEGMENT_HINT_MIN_PAUSE } = th;

    const entitiesMulti = _prepareEntityPhrases(scriptContext);
    const audioDuration = (transcription && transcription.duration) || words[words.length - 1].end;

    const units = [];
    let buf = [];
    let bufSegmentIndex = words[0].segmentIndex;
    let entityProtectedThisUnit = false;
    let hardPauses = 0, softPauses = 0, segmentHints = 0, entityAdjusted = 0, maxDurBreaks = 0;

    let i = 0;
    while (i < words.length) {
        const w = words[i];
        buf.push(w);
        const isLast = i === words.length - 1;
        const next = isLast ? null : words[i + 1];

        // Compute live state of the pending unit
        const unitStart = buf[0].start;
        const unitEnd   = w.end;
        const unitDur   = unitEnd - unitStart;
        const pauseToNext = next ? Math.max(0, next.start - unitEnd) : 0;
        const crossedSeg  = next && next.segmentIndex !== bufSegmentIndex;

        // Decide whether to close the unit at position i (i.e. break BEFORE next word)
        let shouldBreak = false;
        let reason = null;

        if (isLast) {
            shouldBreak = true;
            reason = 'eof';
        } else if (pauseToNext >= PAUSE_HARD_SEC) {
            shouldBreak = true;
            reason = 'hardPause';
        } else if (unitDur >= MIN_UNIT_DUR && pauseToNext >= PAUSE_SOFT_SEC) {
            shouldBreak = true;
            reason = 'softPause';
        } else if (unitDur >= MIN_UNIT_DUR && crossedSeg && pauseToNext >= SEGMENT_HINT_MIN_PAUSE) {
            // Segment boundaries are advisory: only promote them to a break if
            // they coincide with enough silence. Without this gate, Whisper's
            // chunking artifacts (segments split mid-thought with ~0ms gaps)
            // caused roughly a third of all units to be born at segment edges,
            // fragmenting body narration.
            shouldBreak = true;
            reason = 'segmentHint';
        } else if (unitDur >= MAX_UNIT_DUR) {
            shouldBreak = true;
            reason = 'maxDur';
        }

        if (shouldBreak && !isLast) {
            // Local entity protection: see if this break splits a known phrase.
            const adjusted = _findEntityProtectedBreak(words, i, entitiesMulti, ENTITY_WINDOW);
            if (adjusted !== null && adjusted !== i) {
                entityAdjusted++;
                entityProtectedThisUnit = true;
                if (adjusted > i) {
                    // Extend the buffer forward to include the rest of the phrase.
                    for (let k = i + 1; k <= adjusted; k++) buf.push(words[k]);
                    i = adjusted;
                } else if (adjusted < i) {
                    // Rewind: drop words after `adjusted` from the buffer.
                    while (buf.length && buf[buf.length - 1] !== words[adjusted]) buf.pop();
                    i = adjusted;
                }
            }
        }

        if (shouldBreak) {
            if (reason === 'hardPause') hardPauses++;
            else if (reason === 'softPause') softPauses++;
            else if (reason === 'segmentHint') segmentHints++;
            else if (reason === 'maxDur') maxDurBreaks++;

            const nextStart = (i + 1 < words.length) ? words[i + 1].start : null;
            const unit = _emitUnit(buf, nextStart, audioDuration, units.length,
                /* crossedSegment */ i + 1 < words.length && words[i + 1].segmentIndex !== bufSegmentIndex,
                entityProtectedThisUnit,
                pauseToNext);
            if (unit) units.push(unit);

            buf = [];
            entityProtectedThisUnit = false;
            if (i + 1 < words.length) bufSegmentIndex = words[i + 1].segmentIndex;
        }
        i++;
    }

    // Second pass: fill `pauseBefore` from previous unit's pauseAfter.
    // Preserve seconds-based span as `durationSec` BEFORE overwriting `duration`
    // with frames. Downstream scoring logic (scene-boundary-scorer, optimizer)
    // must use `durationSec` so it stays in the same unit system as
    // `startTime/endTime` and style-profile targets. `duration` remains frames
    // for legacy-contract compatibility with the final scene shape.
    for (let k = 0; k < units.length; k++) {
        units[k].pauseBefore = k === 0 ? 0 : units[k - 1].pauseAfter;
        units[k].durationSec = units[k].endTime - units[k].startTime;
        units[k].duration    = Math.round(units[k].durationSec * (fps || 30));
        delete units[k]._pauseAfter;
    }

    const avgDur = units.length
        ? (units.reduce((s, u) => s + (u.endTime - u.startTime), 0) / units.length)
        : 0;
    console.log(`[SpeechUnits] built ${units.length} units (avgDur=${avgDur.toFixed(2)}s, hard=${hardPauses}, soft=${softPauses}, segmentHint=${segmentHints}, maxDur=${maxDurBreaks}, entityProtected=${entityAdjusted}) [thresholds: min=${MIN_UNIT_DUR}s max=${MAX_UNIT_DUR}s pauseHard=${PAUSE_HARD_SEC}s pauseSoft=${PAUSE_SOFT_SEC}s segMinPause=${SEGMENT_HINT_MIN_PAUSE}s]`);

    return units;
}

module.exports = {
    buildSpeechUnits,
    // Exposed defaults for testability / introspection
    DEFAULT_THRESHOLDS,
};
