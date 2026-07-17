/**
 * scene-boundary-scorer.js — Phase 2.5 Refinement
 *
 * For each gap between consecutive speech units, compute a weighted score
 * reflecting how "cut-worthy" that boundary is.
 *
 * Features (all 0..1 raw, except zoneAlignment which is a signed nudge):
 *   - pauseScore         — smoothstep over unit[i].pauseAfter
 *   - entityShift        — fraction of next-side entities not present on prev side
 *   - entityTypeShift    — Jaccard distance between prev/next entity-TYPE sets
 *   - numericShift       — digits/%/$/year appear on one side only
 *   - contrastMarker     — next unit starts with "but/however/meanwhile/..."
 *   - pronounReset       — prev unit is pronoun-led, next starts with proper noun
 *   - segmentHint        — next unit crossed a Whisper segment boundary
 *   - topicShift         — stopword-filtered Jaccard distance between prev/next content tokens
 *   - zoneAlignment      — SIGNED nudge: hook +0.2, body 0, cta -0.3 (multiplied by weight)
 *   - stylePacingHint    — boost when in-progress span duration is near style-profile target
 *
 * Weights come from the niche config (sceneSplit.weights) with default fallbacks.
 */

'use strict';

const DEFAULT_WEIGHTS = {
    pause: 1.0,
    entity: 0.9,
    entityType: 0.7,
    numeric: 0.5,
    contrast: 0.8,
    pronoun: 0.4,
    segmentHint: 0.3,
    topic: 0.6,
    zoneAlignment: 1.0,
    stylePacing: 0.6,
};

// Zone nudge values — SIGNED. Centered on body=0 so this no longer acts as a floor.
const ZONE_NUDGE = { hook: +0.2, body: 0.0, cta: -0.3 };

const CONTRAST_RE = /^(but|however|meanwhile|instead|yet|still|now|then|although|despite|nonetheless|nevertheless)\b/i;
const PRONOUN_RE  = /^(it|they|he|she|we|you|this|that|those|these)\b/i;
const NUMERIC_RE  = /(\$?\d[\d,]*\.?\d*%?|\b(?:19|20)\d{2}\b)/;

// English stopwords for topic-shift content filter. Intentionally small &
// deterministic — we want to strip grammar noise, not do real NLP.
const STOPWORDS = new Set([
    'a','an','the','and','or','but','if','then','so','because','as','of','at','by','for',
    'with','about','against','between','into','through','during','before','after','above',
    'below','to','from','up','down','in','out','on','off','over','under','again','further',
    'is','are','was','were','be','been','being','have','has','had','having','do','does','did',
    'doing','will','would','should','could','may','might','must','shall','can','cannot',
    'i','you','he','she','it','we','they','them','their','our','your','my','me','us','him','her',
    'this','that','these','those','what','which','who','whom','whose','why','how','when','where',
    'not','no','yes','very','just','only','also','too','than','then','there','here','now','up','down',
    's','t','d','ll','re','ve','m','o',
]);

function _lower(s) { return String(s || '').toLowerCase(); }

function _tokens(s) {
    return _lower(s).replace(/[.,!?;:"'()\[\]]/g, ' ').split(/\s+/).filter(Boolean);
}

function _contentTokens(s) {
    return _tokens(s).filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

function _normEntity(s) { return _lower(s).replace(/[.,!?;:"'()\[\]]/g, '').trim(); }

/**
 * Smoothstep from 0..1 between edges a,b.
 */
function _smoothstep(x, a, b) {
    if (x <= a) return 0;
    if (x >= b) return 1;
    const t = (x - a) / (b - a);
    return t * t * (3 - 2 * t);
}

/**
 * Zone classifier — returns 'hook' | 'body' | 'cta'
 */
function _zoneOf(time, scriptContext) {
    const hookEnd = parseFloat(scriptContext && scriptContext.hookEndTime);
    const ctaStart = parseFloat(scriptContext && scriptContext.ctaStartTime);
    if (!isNaN(hookEnd) && time < hookEnd) return 'hook';
    if (!isNaN(ctaStart) && time >= ctaStart) return 'cta';
    return 'body';
}

/**
 * Build a set of lowercase entity tokens/phrases and a name→type map.
 */
function _prepareEntityLookup(scriptContext) {
    const names = (scriptContext && Array.isArray(scriptContext.entities)) ? scriptContext.entities : [];
    const types = (scriptContext && scriptContext.entityTypes) || {};
    const set = new Set();
    const typeMap = {};
    for (const e of names) {
        if (!e) continue;
        const norm = _normEntity(e);
        if (!norm) continue;
        set.add(norm);
        // Also add individual words (length ≥3) for partial-match fallback
        for (const tok of norm.split(/\s+/)) {
            if (tok.length >= 3) set.add(tok);
        }
        const t = types[e] || types[norm] || null;
        if (t) typeMap[norm] = t;
    }
    return { set, typeMap };
}

/**
 * Return the SET of all entity keys found in a given text window.
 * Prefers longer matches: 3-word > 2-word > 1-word tokens are all added.
 */
function _allEntitiesIn(text, lookup) {
    const found = new Set();
    if (!lookup.set.size) return found;
    const toks = _tokens(text);
    for (let n = 3; n >= 1; n--) {
        for (let i = 0; i + n <= toks.length; i++) {
            const phrase = toks.slice(i, i + n).join(' ');
            if (lookup.set.has(phrase)) found.add(phrase);
        }
    }
    return found;
}

function _typeSetFromEntitySet(entitySet, typeMap) {
    const types = new Set();
    for (const e of entitySet) {
        const t = typeMap[e];
        if (t) types.add(t);
    }
    return types;
}

/**
 * Jaccard distance between two sets. 0 = identical, 1 = disjoint.
 * Returns 0 if both sets are empty (no signal available).
 */
function _jaccardDistance(a, b) {
    if (!a.size && !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    const union = a.size + b.size - inter;
    if (union <= 0) return 0;
    return 1 - (inter / union);
}

/**
 * Style-profile target scene duration at a given time.
 *
 * Supports all three shapes we've seen from style-learner.js:
 *   1. pacing.segments[]  (richest, per time-range)
 *   2. pacing.sections.{intro|body|conclusion}.avgSceneDuration
 *   3. pacing.avgSceneDuration  (scalar fallback)
 *
 * Uses proportional time mapping: t_ref = t_ours * (refDur / ourDur).
 * ourDur comes from the transcription (passed in as ourDuration).
 */
function _styleTargetAt(time, styleProfile, ourDuration, zone) {
    if (!styleProfile || !styleProfile.pacing) return null;
    const pacing = styleProfile.pacing;
    const refDur = styleProfile.videoDuration || 0;
    // Map our-time → reference-time proportionally, when both durations are known.
    const mappedTime = (ourDuration && refDur) ? time * (refDur / ourDuration) : time;

    // 1. segments[] — richest shape
    const segs = Array.isArray(pacing.segments) ? pacing.segments : null;
    if (segs && segs.length) {
        for (const s of segs) {
            const st = s.startTime || 0;
            const en = s.endTime || (refDur || Infinity);
            if (mappedTime >= st && mappedTime <= en) {
                if (s.avgSceneDuration > 0) return s.avgSceneDuration;
            }
        }
        const tail = segs[segs.length - 1];
        if (tail && tail.avgSceneDuration > 0) return tail.avgSceneDuration;
    }

    // 2. sections by zone
    if (pacing.sections) {
        const key = zone === 'hook' ? 'intro' : zone === 'cta' ? 'conclusion' : 'body';
        const sec = pacing.sections[key];
        if (sec && sec.avgSceneDuration > 0) return sec.avgSceneDuration;
        // Any section with a value works as a last fallback
        for (const k of ['body', 'intro', 'conclusion']) {
            const s = pacing.sections[k];
            if (s && s.avgSceneDuration > 0) return s.avgSceneDuration;
        }
    }

    // 3. scalar
    if (typeof pacing.avgSceneDuration === 'number' && pacing.avgSceneDuration > 0) {
        return pacing.avgSceneDuration;
    }

    return null;
}

/**
 * Symmetric closeness-to-target score in 0..1.
 *
 * Gaussian falloff on normalized deviation:
 *   dev = (actual - target) / target
 *   score = exp(-3 * dev^2)
 *
 * At target: 1.0
 * At ±50% off: ≈0.47
 * At ±100% off (2× or 0×): ≈0.05
 *
 * Highest AT the target, drops off symmetrically above and below. Replaces the
 * earlier `_smoothstep(u.duration, target*0.6, target*1.4)` which was not a
 * closeness function (it saturated to 1.0 for anything ≥ target*1.4).
 *
 * Both args must be in the SAME unit system (here: seconds).
 */
function _closenessToTarget(actualSec, targetSec) {
    if (!targetSec || targetSec <= 0) return 0;
    if (!(actualSec > 0)) return 0;
    const dev = (actualSec - targetSec) / targetSec;
    return Math.exp(-3 * dev * dev);
}

/**
 * Deterministic topic shift using stopword-filtered Jaccard on content tokens.
 * Returns 0..1. Higher = more topic change.
 */
function _topicShift(prevText, nextText) {
    // Use trailing chunk of prev + leading chunk of next (≈150 chars each)
    const prevChunk = String(prevText || '').slice(-180);
    const nextChunk = String(nextText || '').slice(0, 180);
    const a = new Set(_contentTokens(prevChunk));
    const b = new Set(_contentTokens(nextChunk));
    if (!a.size || !b.size) return 0;
    return _jaccardDistance(a, b);
}

/**
 * Compute features for the gap between units[i] and units[i+1].
 *
 * @param {Object} gateCounters  { topicGated: number, topicFullyWeighted: number }
 *   Mutated so the summary log can show how often topicShift was attenuated.
 */
function _scoreGap(units, i, scriptContext, styleProfile, nicheCfg, entityLookup, ourDuration, styleTelemetry, gateCounters) {
    const u = units[i];
    const n = units[i + 1];
    const weights = Object.assign({}, DEFAULT_WEIGHTS, (nicheCfg && nicheCfg.weights) || {});
    const atTime = n.startTime;
    const zone = _zoneOf(atTime, scriptContext);

    // --- Pause ---
    const pauseSensitivity = (nicheCfg && typeof nicheCfg.pauseSensitivity === 'number') ? nicheCfg.pauseSensitivity : 1.0;
    const pauseRaw = _smoothstep(u.pauseAfter, 0.25, 1.5) * pauseSensitivity;
    const pauseScore = Math.min(1, pauseRaw);

    // --- Entity features (set-based) ---
    const uText = u.text;
    const nText = n.text;
    const uEntSet = _allEntitiesIn(uText.slice(-120), entityLookup);
    const nEntSet = _allEntitiesIn(nText.slice(0, 120), entityLookup);

    // New entities appearing on the next side (that weren't on the prev side)
    let newInNext = 0;
    for (const e of nEntSet) if (!uEntSet.has(e)) newInNext++;
    const entityShift = nEntSet.size > 0 ? Math.min(1, newInNext / nEntSet.size) : 0;

    // Entity TYPE shift via Jaccard distance on type sets
    const uTypes = _typeSetFromEntitySet(uEntSet, entityLookup.typeMap);
    const nTypes = _typeSetFromEntitySet(nEntSet, entityLookup.typeMap);
    const entityTypeShift = _jaccardDistance(uTypes, nTypes);

    // --- Numeric / lexical markers ---
    const uHasNum = NUMERIC_RE.test(uText);
    const nHasNum = NUMERIC_RE.test(nText);
    const numericShift = (uHasNum !== nHasNum) ? 1.0 : 0.0;

    const contrastMarker = CONTRAST_RE.test(nText.trim()) ? 1.0 : 0.0;
    const pronounReset = (PRONOUN_RE.test(uText.trim()) && /^[A-Z][a-z]+/.test(nText.trim())) ? 1.0 : 0.0;
    const segmentHint = n.crossedSegment ? 1.0 : 0.0;

    // --- Topic shift (stopword-filtered Jaccard on content tokens) ---
    const topicShift = _topicShift(uText, nText);

    // --- Zone nudge (signed) ---
    const zoneAlignment = ZONE_NUDGE[zone] !== undefined ? ZONE_NUDGE[zone] : 0;

    // --- Style pacing hint (boundary-level, intentionally weak) ---
    // At boundary scoring time we only see ONE speech unit, not a full candidate
    // scene span, so this hint can only proxy "is this unit alone near target?".
    // The AUTHORITATIVE style-pacing judgment lives in scene-optimizer.js
    // `_spanObjective` where the full candidate scene span duration is known.
    // Use seconds (durationSec) — NOT the frame-based `duration` field.
    let stylePacingHint = 0;
    const target = _styleTargetAt(atTime, styleProfile, ourDuration, zone);
    if (target && target > 0) {
        styleTelemetry.resolved++;
        const unitSec = (typeof u.durationSec === 'number')
            ? u.durationSec
            : (u.endTime - u.startTime); // defensive fallback
        const closeness = _closenessToTarget(unitSec, target);
        // Only boost when there's a real pause cue — otherwise a mid-sentence
        // unit that happens to be target-sized would vote for a cut anyway.
        stylePacingHint = closeness * pauseScore;
    } else {
        styleTelemetry.unresolved++;
    }

    // --- Topic gating (body zone only, niche-configurable) ---
    // topicShift can solo-drive cuts by flagging every paragraph-level topic
    // change. In the body zone, we require an ANCHOR signal alongside topic
    // before letting it contribute fully. Anchors are "hard" semantic or
    // prosodic cues: pause, explicit entity change, contrast word, number
    // appearance, or a typed-entity category flip. Without an anchor,
    // topicShift's raw value is attenuated to 25% so the DP needs other
    // evidence to cut there.
    let topicEffective = topicShift;
    const topicGatingEnabled = nicheCfg && nicheCfg.topicGating === true;
    if (topicGatingEnabled && zone === 'body' && topicShift > 0) {
        const hasAnchor = (
            pauseScore      >= 0.4 ||
            entityShift     > 0    ||
            contrastMarker  > 0    ||
            numericShift    > 0    ||
            entityTypeShift > 0.2
        );
        if (!hasAnchor) {
            topicEffective = topicShift * 0.25;
            gateCounters.topicGated++;
        } else {
            gateCounters.topicFullyWeighted++;
        }
    }

    const features = {
        pauseScore, entityShift, entityTypeShift, numericShift,
        contrastMarker, pronounReset, segmentHint, topicShift,
        zoneAlignment, stylePacingHint,
    };

    const contributions = {
        pauseScore:      pauseScore      * weights.pause,
        entityShift:     entityShift     * weights.entity,
        entityTypeShift: entityTypeShift * weights.entityType,
        numericShift:    numericShift    * weights.numeric,
        contrastMarker:  contrastMarker  * weights.contrast,
        pronounReset:    pronounReset    * weights.pronoun,
        segmentHint:     segmentHint     * weights.segmentHint,
        topicShift:      topicEffective  * (weights.topic || 0),
        zoneAlignment:   zoneAlignment   * weights.zoneAlignment,
        stylePacingHint: stylePacingHint * weights.stylePacing,
    };

    let score = 0;
    for (const k in contributions) score += contributions[k];

    return { afterUnitIndex: i, atTime, score, features, contributions, zone };
}

/**
 * Main entry. Returns Boundary[] of length units.length - 1.
 *
 * @param {Array} units   Speech units from buildSpeechUnits
 * @param {Object} scriptContext
 * @param {Object|null} styleProfile  directorsBrief.styleProfile or null
 * @param {Object} nicheCfg  from getNicheSplitConfig(nicheId)
 * @param {number} [ourDuration] Current video's duration in seconds (for style proportional mapping)
 * @returns {Array} boundaries
 */
function scoreBoundaries(units, scriptContext, styleProfile, nicheCfg, ourDuration) {
    if (!Array.isArray(units) || units.length < 2) return [];
    const entityLookup = _prepareEntityLookup(scriptContext);
    const styleTelemetry = { resolved: 0, unresolved: 0 };
    const gateCounters  = { topicGated: 0, topicFullyWeighted: 0 };

    const our = ourDuration || (units.length ? units[units.length - 1].endTime : 0);

    const boundaries = [];
    for (let i = 0; i < units.length - 1; i++) {
        boundaries.push(_scoreGap(units, i, scriptContext, styleProfile, nicheCfg, entityLookup, our, styleTelemetry, gateCounters));
    }

    // Summary log: top 10 by score
    const sorted = boundaries.slice().sort((a, b) => b.score - a.score);
    const top = sorted.slice(0, 10).map(b => `(${b.atTime.toFixed(1)}s/${b.zone}/${b.score.toFixed(2)})`);
    const avg = boundaries.length
        ? (boundaries.reduce((s, b) => s + b.score, 0) / boundaries.length)
        : 0;
    console.log(`[BoundaryScorer] scored ${boundaries.length} candidates: avg=${avg.toFixed(2)}, top10=[${top.join(', ')}]`);

    // Per-feature contribution summary — critical for tuning.
    if (boundaries.length) {
        const contribSum = {};
        for (const b of boundaries) {
            for (const k in b.contributions) {
                contribSum[k] = (contribSum[k] || 0) + b.contributions[k];
            }
        }
        const avgContribs = {};
        for (const [k, v] of Object.entries(contribSum)) {
            avgContribs[k] = v / boundaries.length;
        }
        const avgStr = Object.entries(avgContribs)
            .map(([k, v]) => `${k}=${v.toFixed(2)}`)
            .join(' ');
        console.log(`[BoundaryScorer] avg contrib: ${avgStr}`);

        // Dead-feature warning: any feature (besides zoneAlignment which is
        // intentionally signed & often small) with |avg contrib| < 0.02 is
        // effectively inert and either mis-configured or data-starved.
        const dead = [];
        for (const [k, v] of Object.entries(avgContribs)) {
            if (k === 'zoneAlignment') continue;
            if (Math.abs(v) < 0.02) dead.push(k);
        }
        if (dead.length) {
            console.log(`[BoundaryScorer] ⚠ dead features (avg contrib < 0.02): ${dead.join(', ')}`);
        }

        // Topic-gating telemetry: when nicheCfg.topicGating=true, how often did
        // topicShift fire in body zone WITHOUT an anchor signal and get
        // attenuated to 25%? High attenuation count = gating is preventing
        // topicShift from solo-driving body cuts.
        const gateActive = nicheCfg && nicheCfg.topicGating === true;
        if (gateActive) {
            const total = gateCounters.topicGated + gateCounters.topicFullyWeighted;
            const pct = total > 0 ? (gateCounters.topicGated / total * 100).toFixed(0) : '0';
            console.log(`[BoundaryScorer] topic-gating (body zone): ${gateCounters.topicGated}/${total} gated (${pct}%), ${gateCounters.topicFullyWeighted} full-weighted — topicShift attenuated to 25% when no anchor (pause/entity/contrast/numeric/entityType)`);
        }

        // Style-pacing telemetry: how often we actually found a target?
        const styleTotal = styleTelemetry.resolved + styleTelemetry.unresolved;
        if (styleTotal > 0) {
            const pct = (styleTelemetry.resolved / styleTotal * 100).toFixed(0);
            const shape = !styleProfile ? 'none' :
                          !styleProfile.pacing ? 'no-pacing' :
                          Array.isArray(styleProfile.pacing.segments) && styleProfile.pacing.segments.length ? 'segments' :
                          styleProfile.pacing.sections ? 'sections' :
                          typeof styleProfile.pacing.avgSceneDuration === 'number' ? 'scalar' :
                          'unknown';
            const avgPacingContrib = avgContribs.stylePacingHint != null ? avgContribs.stylePacingHint : 0;
            const note = styleTelemetry.resolved === 0 ? 'NOT ACTIVE'
                       : Math.abs(avgPacingContrib) < 0.02 ? 'negligible at boundary level — primary judgment is span-level in optimizer'
                       : 'active at boundary level';
            console.log(`[BoundaryScorer] style-pacing: shape=${shape} unit=seconds resolved=${styleTelemetry.resolved}/${styleTotal} (${pct}%) avgContrib=${avgPacingContrib.toFixed(3)} [${note}]`);
        }
    }

    return boundaries;
}

module.exports = {
    scoreBoundaries,
    DEFAULT_WEIGHTS,
    ZONE_NUDGE,
};
