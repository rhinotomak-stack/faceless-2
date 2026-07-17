/**
 * scene-optimizer.js — Phase 2.5 Refinement
 *
 * Dynamic-programming span selection with a span-level objective.
 *
 * For a candidate cut set producing scenes S_1..S_k:
 *
 *   Total = Σ_scenes [  cohesionReward(S)
 *                     - durationDeviationPenalty(S, zoneTarget)
 *                     - baselineScenePenalty ]
 *         + Σ_chosenCuts boundary.score
 *         - Σ_chosenCuts cutPenalty
 *
 * The baselineScenePenalty + cutPenalty counter the tendency to over-cut when
 * many boundaries have mildly positive scores.
 *
 * Zone duration bands act as a soft constraint: spans outside their band pay
 * an escalating penalty but are not hard-rejected. This keeps the DP always
 * solvable; the outer try/catch in ai-director.js can still fall back to
 * legacy if this module throws.
 */

'use strict';

const COH_WEIGHT        = 0.25;
const DEV_WEIGHT        = 0.8;
const BASELINE_PENALTY  = 0.05;
// Recalibrated 2026-04-20 (second pass, from real explainer.politics build):
// 498s script with CUT_PENALTY=0.45 produced 113 scenes (avg body 3.8s vs
// bodyBand [5.5,14]). topicShift alone was clearing the penalty on 64 cuts.
// Raised to 0.6 so cuts need real multi-signal support.
const CUT_PENALTY       = 0.6;
// Also raised from 2.5 → 6.0. With under=0.31 for a 3.8s body vs lo=5.5, the
// old 2.5 gave penalty=0.24 — trivially beaten by a single 0.7 topicShift.
// 6.0 raises that to 0.58 before the niche's bandResistance multiplier.
const BAND_VIOLATION_W  = 6.0;

// Dead-air guard: any internal pause above this length inside a span creates
// visible silence mid-scene during playback (the narrator stops, but the
// visual/MG keeps playing). Penalty weight is set so it overwhelms even a
// heavy band-violation penalty — i.e. we'd rather accept a sub-band short
// scene than swallow 3+ seconds of silence into the middle of a scene.
const DEAD_AIR_MAX_INTERNAL_SEC = 1.8;
const DEAD_AIR_PENALTY_WEIGHT   = 25;

function _zoneOf(time, scriptContext) {
    const hookEnd = parseFloat(scriptContext && scriptContext.hookEndTime);
    const ctaStart = parseFloat(scriptContext && scriptContext.ctaStartTime);
    if (!isNaN(hookEnd) && time < hookEnd) return 'hook';
    if (!isNaN(ctaStart) && time >= ctaStart) return 'cta';
    return 'body';
}

function _bandFor(zone, nicheCfg) {
    const ss = (nicheCfg && nicheCfg) || {};
    if (zone === 'hook') return ss.hookBand || [1.8, 4.5];
    if (zone === 'cta')  return ss.ctaBand  || [5.0, 15.0];
    return ss.bodyBand || [3.0, 12.0];
}

/**
 * Resolve style-profile target duration for a given mid-time in OUR video.
 * Supports all three style-learner.js output shapes:
 *   1. pacing.segments[]  (richest)
 *   2. pacing.sections.{intro|body|conclusion}.avgSceneDuration
 *   3. pacing.avgSceneDuration (scalar)
 * Proportional time mapping: t_ref = t_ours * (refDur / ourDur).
 */
function _styleTargetForSpan(midTime, styleProfile, ourDuration, zone) {
    if (!styleProfile || !styleProfile.pacing) return null;
    const pacing = styleProfile.pacing;
    const refDur = styleProfile.videoDuration || 0;
    const mappedTime = (ourDuration && refDur) ? midTime * (refDur / ourDuration) : midTime;

    const segs = Array.isArray(pacing.segments) ? pacing.segments : null;
    if (segs && segs.length) {
        for (const s of segs) {
            const st = s.startTime || 0, en = s.endTime || Infinity;
            if (mappedTime >= st && mappedTime <= en) {
                if (s.avgSceneDuration > 0) return s.avgSceneDuration;
            }
        }
        const tail = segs[segs.length - 1];
        if (tail && tail.avgSceneDuration > 0) return tail.avgSceneDuration;
    }

    if (pacing.sections) {
        const key = zone === 'hook' ? 'intro' : zone === 'cta' ? 'conclusion' : 'body';
        const sec = pacing.sections[key];
        if (sec && sec.avgSceneDuration > 0) return sec.avgSceneDuration;
        for (const k of ['body', 'intro', 'conclusion']) {
            const s = pacing.sections[k];
            if (s && s.avgSceneDuration > 0) return s.avgSceneDuration;
        }
    }

    if (typeof pacing.avgSceneDuration === 'number' && pacing.avgSceneDuration > 0) {
        return pacing.avgSceneDuration;
    }

    return null;
}

/**
 * Resolve the EFFECTIVE duration target used for the quadratic deviation term.
 * Blends the raw style-profile target with the zone band midpoint using the
 * per-zone `nicheCfg.styleBlend` weight, then CLAMPS into the band.
 *
 * For explainer niches we set body ~0.15, meaning 85% of the target comes from
 * the niche band midpoint. This stops a reference video with 3s/scene average
 * from dragging 498s longform scripts into news-tempo body cuts.
 *
 * Returns { effective, raw, blend, bandMid, clamped }.
 */
function _effectiveTarget(rawStyleTarget, zone, band, nicheCfg) {
    const [lo, hi] = band;
    const bandMid = (lo + hi) / 2;
    const blendMap = (nicheCfg && nicheCfg.styleBlend) || {};
    const blend = (typeof blendMap[zone] === 'number') ? blendMap[zone] : 0.5;

    let effective;
    let clamped = false;
    if (rawStyleTarget && rawStyleTarget > 0) {
        const mixed = blend * rawStyleTarget + (1 - blend) * bandMid;
        effective = Math.max(lo, Math.min(hi, mixed));
        if (effective !== mixed) clamped = true;
    } else {
        effective = bandMid;
    }
    return { effective, raw: rawStyleTarget || null, blend, bandMid, clamped };
}

/**
 * Compute the per-span objective.
 */
function _spanObjective(units, fromIdx, toIdxInclusive, scriptContext, styleProfile, nicheCfg, ourDuration, shortBodyTracker) {
    const first = units[fromIdx];
    const last  = units[toIdxInclusive];
    const startTime = first.startTime;
    const endTime   = last.endTime;
    const dur       = endTime - startTime;
    const midTime   = (startTime + endTime) / 2;

    const zone = _zoneOf(midTime, scriptContext);
    const band = _bandFor(zone, nicheCfg);
    const [lo, hi] = band;

    // Effective target: blend style profile with band midpoint, clamp to band.
    const rawStyleTarget = _styleTargetForSpan(midTime, styleProfile, ourDuration, zone);
    const tgt = _effectiveTarget(rawStyleTarget, zone, band, nicheCfg);
    const target = tgt.effective;

    // Cohesion reward — log-scaled on word count so it plateaus.
    let totalWords = 0;
    for (let k = fromIdx; k <= toIdxInclusive; k++) {
        totalWords += (units[k].words ? units[k].words.length : 0);
    }
    const cohesion = COH_WEIGHT * Math.log(1 + totalWords);

    // Duration-deviation penalty vs effective target.
    const dev = (dur - target) / Math.max(0.5, target);
    let deviationPenalty = DEV_WEIGHT * (dev * dev);

    // Dead-air penalty: hard penalty for any internal pause (between units
    // inside the span) that exceeds the threshold. Scenes should NEVER span
    // a long silence — that produces visible dead air on the timeline.
    // Threshold is per-niche tunable via nicheCfg.deadAirMaxInternalSec.
    const daThreshold = (nicheCfg && typeof nicheCfg.deadAirMaxInternalSec === 'number')
        ? nicheCfg.deadAirMaxInternalSec : DEAD_AIR_MAX_INTERNAL_SEC;
    let deadAirPenalty = 0;
    let maxInternalPause = 0;
    for (let k = fromIdx + 1; k <= toIdxInclusive; k++) {
        const pb = units[k].pauseBefore || 0;
        if (pb > daThreshold) {
            const excess = pb - daThreshold;
            deadAirPenalty += DEAD_AIR_PENALTY_WEIGHT * (excess * excess);
        }
        if (pb > maxInternalPause) maxInternalPause = pb;
    }

    // Band violation: steep additional penalty if dur < lo or > hi.
    // For body zones, multiply the under-band penalty by `nicheCfg.bandResistance`
    // so explainer niches push harder against sub-band body spans.
    let bandPenalty = 0;
    if (dur < lo) {
        const under = (lo - dur) / lo;
        const resistance = (zone === 'body' && typeof nicheCfg.bandResistance === 'number')
            ? nicheCfg.bandResistance : 1.0;
        bandPenalty = BAND_VIOLATION_W * under * under * resistance;
        // Track heavy-pressure body candidates so the summary log can show that
        // the penalty is actually firing on sub-band spans.
        if (shortBodyTracker && zone === 'body' && bandPenalty >= 0.8) {
            shortBodyTracker.heavyPressure++;
        }
        if (shortBodyTracker && zone === 'body') {
            shortBodyTracker.subBandCandidates++;
        }
    } else if (dur > hi) {
        const over = (dur - hi) / hi;
        bandPenalty = BAND_VIOLATION_W * over * over;
    }

    const baseline = BASELINE_PENALTY;

    return {
        total: cohesion - deviationPenalty - bandPenalty - deadAirPenalty - baseline,
        parts: { cohesion, deviationPenalty, bandPenalty, deadAirPenalty, maxInternalPause, baseline, target, rawStyleTarget, blend: tgt.blend, bandMid: tgt.bandMid, zone, dur },
    };
}

/**
 * Build a scene object from a span of units.
 */
function _buildScene(units, fromIdx, toIdxInclusive, sceneIndex, fps) {
    const slice = units.slice(fromIdx, toIdxInclusive + 1);
    const startTime = slice[0].startTime;
    const endTime   = slice[slice.length - 1].endTime;
    const text      = slice.map(u => u.text).join(' ').trim();
    const words     = [];
    for (const u of slice) {
        if (u.words && u.words.length) {
            for (const w of u.words) words.push({ word: w.word, start: w.start, end: w.end });
        }
    }
    return {
        index: sceneIndex,
        text,
        startTime,
        endTime,
        duration: Math.round((endTime - startTime) * (fps || 30)),
        words,
    };
}

/**
 * Main entry. Returns Scene[] with the legacy contract shape.
 *
 * @param {Array} units
 * @param {Array} boundaries  length units.length - 1
 * @param {Object} scriptContext
 * @param {Object|null} styleProfile
 * @param {Object} nicheCfg  result of getNicheSplitConfig(nicheId)
 * @param {number} fps
 */
function optimizeScenes(units, boundaries, scriptContext, styleProfile, nicheCfg, fps, audioDuration) {
    if (!Array.isArray(units) || units.length === 0) return [];
    if (units.length === 1) {
        const only = _buildScene(units, 0, 0, 0, fps);
        if (audioDuration && audioDuration > only.endTime) {
            only.endTime = audioDuration;
            only.duration = Math.round((only.endTime - only.startTime) * (fps || 30));
        }
        return [only];
    }

    const N = units.length;
    const ourDuration = units[N - 1].endTime;

    // Style-pacing shape detection for diagnostic logging.
    const styleShape = !styleProfile ? 'none' :
                       !styleProfile.pacing ? 'no-pacing' :
                       Array.isArray(styleProfile.pacing.segments) && styleProfile.pacing.segments.length ? 'segments' :
                       styleProfile.pacing.sections ? 'sections' :
                       typeof styleProfile.pacing.avgSceneDuration === 'number' ? 'scalar' :
                       'unknown';

    // dp[i] = best objective for scenes covering units[0..i-1] (ending at i)
    const dp = new Array(N + 1).fill(-Infinity);
    const parent = new Array(N + 1).fill(-1);
    dp[0] = 0;

    // Tracks how often body-zone spans under the lower band bound were
    // evaluated with heavy bandPenalty — i.e. pressure being applied to
    // reject short body scenes. A sample effective-target value is also
    // captured for the log.
    const shortBodyTracker = { subBandCandidates: 0, heavyPressure: 0 };
    let sampleBodyTarget = null;
    let sampleBodyTargetRaw = null;
    let sampleBodyBlend = null;
    let sampleBodyMid = null;

    // Max span length (in units) — bounded for performance on very long scripts.
    // A span rarely needs >60 units; cap the search window.
    const MAX_SPAN_UNITS = 60;

    for (let i = 1; i <= N; i++) {
        const jLo = Math.max(0, i - MAX_SPAN_UNITS);
        for (let j = jLo; j < i; j++) {
            if (dp[j] === -Infinity) continue;

            const obj = _spanObjective(units, j, i - 1, scriptContext, styleProfile, nicheCfg, ourDuration, shortBodyTracker);
            if (obj.parts.zone === 'body' && sampleBodyTarget === null) {
                sampleBodyTarget = obj.parts.target;
                sampleBodyTargetRaw = obj.parts.rawStyleTarget;
                sampleBodyBlend = obj.parts.blend;
                sampleBodyMid = obj.parts.bandMid;
            }
            const cutTerm = (j > 0) ? (boundaries[j - 1].score - CUT_PENALTY) : 0;
            const candidate = dp[j] + obj.total + cutTerm;

            if (candidate > dp[i]) {
                dp[i] = candidate;
                parent[i] = j;
            }
        }
    }

    if (dp[N] === -Infinity) {
        throw new Error('Optimizer failed: no feasible cut set (DP produced -Infinity)');
    }

    // Backtrack to recover cut positions (span boundaries).
    const spans = []; // array of [fromIdx, toIdxInclusive]
    let cur = N;
    while (cur > 0) {
        const prev = parent[cur];
        spans.push([prev, cur - 1]);
        cur = prev;
    }
    spans.reverse();

    // Build scenes.
    const scenes = spans.map(([a, b], idx) => _buildScene(units, a, b, idx, fps));

    // --- Seamless coverage pass ---
    // Speech-unit boundaries only cover spoken words; the silent pauses between
    // units belong to no scene, which produces visible gaps on the timeline and
    // "No active scenes at frame" warnings from the compositor. Extend each
    // scene's endTime to the next scene's startTime (absorb the pause into the
    // preceding scene). Tail scene extends to audioDuration when provided.
    // Word-level timings stay untouched so subtitles remain frame-accurate.
    let absorbedGaps = 0;
    let totalAbsorbedSec = 0;
    for (let i = 0; i < scenes.length - 1; i++) {
        const gap = scenes[i + 1].startTime - scenes[i].endTime;
        if (gap > 0.01) {
            scenes[i].endTime = scenes[i + 1].startTime;
            absorbedGaps++;
            totalAbsorbedSec += gap;
        }
    }
    const tail = scenes[scenes.length - 1];
    if (audioDuration && audioDuration > tail.endTime + 0.01) {
        totalAbsorbedSec += audioDuration - tail.endTime;
        tail.endTime = audioDuration;
        absorbedGaps++;
    }
    if (absorbedGaps > 0) {
        for (const s of scenes) {
            s.duration = Math.round((s.endTime - s.startTime) * (fps || 30));
        }
        console.log(`[Optimizer] seamless coverage: absorbed ${absorbedGaps} gap(s) totaling ${totalAbsorbedSec.toFixed(2)}s — scenes now cover the full timeline`);
    }

    // --- Logs ---
    const zoneCounts = { hook: 0, body: 0, cta: 0 };
    const zoneDurs   = { hook: 0, body: 0, cta: 0 };
    for (const s of scenes) {
        const mid = (s.startTime + s.endTime) / 2;
        const z = _zoneOf(mid, scriptContext);
        zoneCounts[z]++;
        zoneDurs[z] += (s.endTime - s.startTime);
    }
    const avg = (z) => zoneCounts[z] ? (zoneDurs[z] / zoneCounts[z]).toFixed(1) : '—';
    console.log(`[Optimizer] ${N} units → ${scenes.length} scenes (hook=${zoneCounts.hook} body=${zoneCounts.body} cta=${zoneCounts.cta})`);
    console.log(`[Optimizer] avg duration: hook=${avg('hook')}s body=${avg('body')}s cta=${avg('cta')}s`);

    // --- Effective-target diagnostic (body zone sample) ---
    // Shows how the raw style-profile target was blended with the band midpoint
    // and clamped to the band. This is the number that actually drives the
    // deviation penalty in _spanObjective.
    if (sampleBodyTarget !== null) {
        const bodyBand = _bandFor('body', nicheCfg);
        const rawStr = sampleBodyTargetRaw !== null ? sampleBodyTargetRaw.toFixed(1) + 's' : 'none';
        console.log(`[Optimizer] effective target (body): raw=${rawStr} blend=${sampleBodyBlend} bandMid=${sampleBodyMid.toFixed(1)}s → effective=${sampleBodyTarget.toFixed(1)}s (bandBody=[${bodyBand[0]},${bodyBand[1]}])`);
    }

    // --- Under-band body pressure diagnostic ---
    // Counts DP candidate evaluations where a body-zone span fell below the
    // lower band bound with a heavy (≥0.8) penalty. A high value = the
    // under-band penalty was actively firing, which is what we want.
    const bodyChosenUnderBand = scenes.filter(s => {
        const mid = (s.startTime + s.endTime) / 2;
        if (_zoneOf(mid, scriptContext) !== 'body') return false;
        const [lo] = _bandFor('body', nicheCfg);
        return (s.endTime - s.startTime) < lo;
    }).length;
    const br = (typeof nicheCfg.bandResistance === 'number') ? nicheCfg.bandResistance : 1.0;
    console.log(`[Optimizer] under-band body pressure: ${shortBodyTracker.heavyPressure}/${shortBodyTracker.subBandCandidates} sub-band candidates had penalty≥0.8 (bandResistance=${br}) — chosen body scenes still under band: ${bodyChosenUnderBand}/${zoneCounts.body}`);

    // --- Span-level style-pacing diagnostic ---
    // The DP's quadratic deviation term uses the EFFECTIVE target (blended style
    // × band midpoint, clamped). The RAW style target is informational only —
    // if it disagrees strongly with the niche band, the blend pulls it in.
    // Log BOTH so the log reader doesn't confuse "deviation from raw style"
    // (which can legitimately be huge) with "deviation from what the DP
    // actually optimized against" (which should be small when the system is
    // working). The healthy-vs-concerning verdict uses the EFFECTIVE deviation.
    let pacingResolved = 0, pacingUnresolved = 0;
    let pacingDevRawSum = 0, pacingDevEffSum = 0, pacingDevCount = 0;
    for (const s of scenes) {
        const mid = (s.startTime + s.endTime) / 2;
        const z = _zoneOf(mid, scriptContext);
        const rawT = _styleTargetForSpan(mid, styleProfile, ourDuration, z);
        if (rawT && rawT > 0) {
            pacingResolved++;
            const spanSec = s.endTime - s.startTime;
            const band   = _bandFor(z, nicheCfg);
            const effT   = _effectiveTarget(rawT, z, band, nicheCfg).effective;
            pacingDevRawSum += Math.abs((spanSec - rawT) / rawT);
            pacingDevEffSum += Math.abs((spanSec - effT) / effT);
            pacingDevCount++;
        } else {
            pacingUnresolved++;
        }
    }
    const pacingTotal = pacingResolved + pacingUnresolved;
    if (pacingTotal > 0) {
        const pct = (pacingResolved / pacingTotal * 100).toFixed(0);
        const avgDevRaw = pacingDevCount ? (pacingDevRawSum / pacingDevCount) : 0;
        const avgDevEff = pacingDevCount ? (pacingDevEffSum / pacingDevCount) : 0;
        const active = pacingResolved > 0;
        // Verdict uses EFFECTIVE deviation — that's what the DP objective cares about.
        const note = !active ? 'NOT ACTIVE (no style profile or shape unreadable)'
                   : avgDevEff < 0.15 ? 'scenes tracking effective target closely'
                   : avgDevEff < 0.40 ? 'moderate deviation from effective target — band guiding outcome'
                   : 'large deviation from effective target — cut signals / band pressure dominating';
        console.log(`[Optimizer] style-pacing (SPAN-LEVEL, PRIMARY): shape=${styleShape} unit=seconds resolved=${pacingResolved}/${pacingTotal} (${pct}%) avg|dev|-vs-RAW=${(avgDevRaw * 100).toFixed(0)}% avg|dev|-vs-EFFECTIVE(DP)=${(avgDevEff * 100).toFixed(0)}% [${note}]`);
    }

    // Dead-air sanity check on chosen spans — should be 0 after dead-air guard.
    let spansWithDeadAir = 0;
    const daThresholdLog = (nicheCfg && typeof nicheCfg.deadAirMaxInternalSec === 'number')
        ? nicheCfg.deadAirMaxInternalSec : DEAD_AIR_MAX_INTERNAL_SEC;
    let worstInternalPause = 0;
    for (const [a, b] of spans) {
        for (let k = a + 1; k <= b; k++) {
            const pb = units[k].pauseBefore || 0;
            if (pb > daThresholdLog) {
                spansWithDeadAir++;
                if (pb > worstInternalPause) worstInternalPause = pb;
                break;
            }
        }
    }
    console.log(`[Optimizer] dead-air guard: ${spansWithDeadAir}/${scenes.length} chosen spans contain internal pause > ${daThresholdLog}s (worst=${worstInternalPause.toFixed(2)}s)`);

    // Chosen cut times
    const chosenCuts = spans.slice(0, -1).map(([, b]) => units[b].endTime.toFixed(1) + 's');
    console.log(`[Optimizer] chose cuts at: [${chosenCuts.join(', ')}]`);

    // Dominant feature per chosen cut — which signal drove each decision?
    if (boundaries && boundaries.length) {
        const chosenAfterUnitIdxs = spans.slice(0, -1).map(([, b]) => b);
        const chosenBoundaries = chosenAfterUnitIdxs
            .map(idx => boundaries.find(b => b.afterUnitIndex === idx))
            .filter(Boolean);
        const dominantCounts = {};
        for (const b of chosenBoundaries) {
            let topKey = null, topVal = -Infinity;
            for (const [k, v] of Object.entries(b.contributions)) {
                if (v > topVal) { topVal = v; topKey = k; }
            }
            if (topKey) dominantCounts[topKey] = (dominantCounts[topKey] || 0) + 1;
        }
        const dominantStr = Object.entries(dominantCounts)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
        if (dominantStr) console.log(`[Optimizer] dominant feature per chosen cut: ${dominantStr}`);

        // Strong candidates that were REJECTED by the optimizer.
        const chosenSet = new Set(chosenAfterUnitIdxs);
        const strongRejected = boundaries
            .filter(b => b.score >= 0.7 && !chosenSet.has(b.afterUnitIndex))
            .slice(0, 10)
            .map(b => `(${b.atTime.toFixed(1)}s/${b.zone}/${b.score.toFixed(2)})`);
        if (strongRejected.length) {
            console.log(`[Optimizer] rejected strong candidates: [${strongRejected.join(', ')}]`);
        }
    }

    // Scene-duration distribution (quick histogram — reveals clustering at band edges)
    const buckets = { '<2s': 0, '2-4s': 0, '4-6s': 0, '6-8s': 0, '8-12s': 0, '>12s': 0 };
    for (const s of scenes) {
        const d = s.endTime - s.startTime;
        if      (d < 2)  buckets['<2s']++;
        else if (d < 4)  buckets['2-4s']++;
        else if (d < 6)  buckets['4-6s']++;
        else if (d < 8)  buckets['6-8s']++;
        else if (d < 12) buckets['8-12s']++;
        else             buckets['>12s']++;
    }
    const histStr = Object.entries(buckets).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(`[Optimizer] scene-dur distribution: ${histStr}`);

    return scenes;
}

module.exports = {
    optimizeScenes,
    _constants: { COH_WEIGHT, DEV_WEIGHT, BASELINE_PENALTY, CUT_PENALTY, BAND_VIOLATION_W },
};
