'use strict';

/**
 * Agentic Motion QA
 *
 * The Motion Director chooses creative intent. This worker verifies the final
 * HyperFrames composition, applies bounded repairs to the plan, regenerates it,
 * and verifies the repaired result before render.
 *
 * It intentionally does not expose another editor/settings surface. The normal
 * workflow remains:
 *   plan -> author/direct -> Motion QA -> render
 *
 * HyperFrames provides the renderer-aware proof:
 *   - lint/check for contract, runtime and layout findings
 *   - keyframes JSON for statically-authored GSAP/CSS/Anime motion
 *   - snapshots for optional multi-frame vision review
 *
 * The bridge also emits hyperframes-motion-manifest.json. It covers dynamic
 * helper/loop motion that HyperFrames' static keyframe parser cannot resolve.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const timelineContract = require('../../project/timeline-contract');

const VERSION = 2;
const VISUAL_GROUPS = ['motionGraphics', 'mgScenes', 'templateScenes'];
const SAFE_ZONES = new Set([
    'auto',
    'center',
    'center-left',
    'center-right',
    'bottom-left',
    'bottom-right',
    'top-left',
    'top-right',
]);
const MOVE_FALLBACK = {
    'bottom-left': 'top-right',
    'bottom-right': 'top-left',
    'top-left': 'bottom-right',
    'top-right': 'bottom-left',
    'center-left': 'center-right',
    'center-right': 'center-left',
    center: 'bottom-left',
    auto: 'bottom-left',
};
const INFORMATIONAL_HYPERFRAMES_CODES = new Set([
    // The bridge deliberately emits one self-contained composition because it
    // is generated, disposable output. Source maintainability lives in the
    // bridge modules, not in hand-editing this HTML file.
    'composition_file_too_large',
]);
const MICRO_VISUAL_TYPES = new Set([
    'focus-word',
    'listicle-counter',
    'progress-tracker',
    'progress-bar',
    'stat-counter',
    'subscribe-cta',
]);

function flagOff(name) {
    return /^(0|false|off|no)$/i.test(String(process.env[name] || '').trim());
}

function enabled() {
    return !flagOff('HF_MOTION_QA');
}

function numeric(value, fallback = NaN) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function compactText(value, max = 140) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, Math.max(0, max - 1)).trim()}…` : text;
}

function token(value, fallback = '') {
    const out = String(value || '')
        .trim()
        .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
        .replace(/[^a-z0-9]+/gi, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .toLowerCase();
    return out || fallback;
}

function itemWindow(item, fallbackDuration = 3) {
    const start = Math.max(0, numeric(item?.startTime ?? item?.start ?? item?.at, 0));
    const explicitEnd = numeric(item?.endTime ?? item?.end);
    const duration = Math.max(
        0.05,
        numeric(
            item?.durationSeconds
            ?? item?.durationSec
            ?? item?.displayDuration
            ?? item?.duration,
            fallbackDuration
        )
    );
    const end = explicitEnd > start ? explicitEnd : start + duration;
    return { start, end, duration: Math.max(0.05, end - start) };
}

function itemText(item) {
    const nested = item?.mgData && typeof item.mgData === 'object' ? item.mgData : null;
    return [
        item?.text,
        item?.title,
        item?.headline,
        item?.templateText,
        item?.subtext,
        item?.subtitle,
        item?.templateSubtext,
        nested?.text,
        nested?.title,
        nested?.headline,
        nested?.subtext,
        nested?.subtitle,
        ...(Array.isArray(item?.items)
            ? item.items.map((entry) => (
                typeof entry === 'string'
                    ? entry
                    : `${entry?.label || entry?.text || ''} ${entry?.value || ''}`
            ))
            : []),
        ...(Array.isArray(nested?.items)
            ? nested.items.map((entry) => (
                typeof entry === 'string'
                    ? entry
                    : `${entry?.label || entry?.text || ''} ${entry?.value || ''}`
            ))
            : []),
    ].filter(Boolean).join(' ');
}

const SEMANTIC_STOPWORDS = new Set([
    'a', 'an', 'and', 'are', 'as', 'at', 'by', 'for', 'from', 'in', 'is',
    'it', 'of', 'on', 'or', 'the', 'to', 'was', 'were', 'with',
]);

function plainSemanticText(value) {
    return String(value || '')
        .replace(/<[^>]*>/g, ' ')
        .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => {
            try { return String.fromCodePoint(parseInt(hex, 16)); } catch (_) { return ' '; }
        })
        .replace(/&#(\d+);/g, (_match, decimal) => {
            try { return String.fromCodePoint(parseInt(decimal, 10)); } catch (_) { return ' '; }
        })
        .replace(/&nbsp;|&ensp;|&emsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&quot;/gi, '"')
        .replace(/&apos;|&#39;/gi, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizedSemanticText(value) {
    return plainSemanticText(value)
        .toLowerCase()
        .replace(/([$€£¥])\s+/g, '$1')
        .replace(/[^a-z0-9$€£¥%]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function numericFacts(value) {
    const matches = plainSemanticText(value).match(/[-+]?\d[\d,]*(?:\.\d+)?(?:\s*%)?/g) || [];
    const facts = [];
    for (const raw of matches) {
        const percent = /%/.test(raw);
        const parsed = Number(raw.replace(/[%\s,]/g, ''));
        if (!Number.isFinite(parsed)) continue;
        const normalized = Number.isInteger(parsed)
            ? String(parsed)
            : String(Number(parsed.toFixed(6)));
        facts.push(`${normalized}${percent ? '%' : ''}`);
    }
    return facts;
}

function semanticProfile(item) {
    const text = itemText(item);
    const normalized = normalizedSemanticText(text);
    const facts = new Set(numericFacts(text));
    const tokens = new Set(
        normalized
            .split(' ')
            .filter(word => word.length > 1 && !SEMANTIC_STOPWORDS.has(word) && !/^\d/.test(word))
    );
    return { normalized, facts, tokens };
}

function semanticProfilesMatch(a, b) {
    if (!a.normalized || !b.normalized) return false;
    if (a.normalized === b.normalized && a.normalized.length >= 3) return true;

    const sharedFacts = [...a.facts].filter(fact => b.facts.has(fact));
    if (sharedFacts.length > 0) {
        const sharedLabels = [...a.tokens].filter(label => b.tokens.has(label));
        if (sharedLabels.length > 0) return true;
        if (a.tokens.size === 0 || b.tokens.size === 0) return true;
    }

    const shorter = a.normalized.length <= b.normalized.length ? a.normalized : b.normalized;
    const longer = shorter === a.normalized ? b.normalized : a.normalized;
    return shorter.length >= 8 && longer.includes(shorter);
}

function windowsAreRelated(a, b, maxGap = 0.8) {
    const gap = Math.max(0, Math.max(a.start, b.start) - Math.min(a.end, b.end));
    return gap <= maxGap;
}

function authoredDuplicateNumericFact(item) {
    const authored = item?._authoredComposition || item?.mgData?._authoredComposition;
    if (!authored?.html) return null;
    const itemType = token(item.type || item.mgType || item.templateType, '');
    if (!new Set(['stat-card', 'stat-counter']).has(itemType)) return null;
    if (listItemCount(item) > 1) return null;

    const intendedFacts = new Set(numericFacts(itemText(item)));
    if (intendedFacts.size === 0) return null;
    const counts = new Map();
    for (const fact of numericFacts(authored.html)) {
        counts.set(fact, (counts.get(fact) || 0) + 1);
    }
    return [...intendedFacts].find(fact => (counts.get(fact) || 0) >= 2) || null;
}

function wordCount(item) {
    const matches = itemText(item).match(/\S+/g);
    return matches ? matches.length : 0;
}

function listItemCount(item) {
    const candidates = [
        item?.items,
        item?.mgData?.items,
        item?.templateData?.items,
        item?.agenticComposition?.items,
    ];
    const list = candidates.find(Array.isArray);
    return list ? list.length : 0;
}

function normalizeSpeed(value, fallback = 1) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return clamp(parsed, 0.25, 3);
    const raw = token(value, 'normal');
    if (raw.includes('very-slow')) return 0.55;
    if (raw.includes('slow') || raw.includes('calm') || raw.includes('gentle')) return 0.75;
    if (raw.includes('rapid') || raw.includes('snappy')) return 1.6;
    if (raw.includes('fast') || raw.includes('quick') || raw.includes('energetic')) return 1.35;
    return fallback;
}

function currentSpeed(item) {
    return normalizeSpeed(
        item?.agenticComposition?.motion?.speed
        ?? item?.animationSpeed
        ?? item?._animationSpeed
        ?? item?.mgData?.animationSpeed,
        1
    );
}

function safeZoneOf(item, kind) {
    const candidate = token(
        item?.agenticComposition?.safeZone
        || item?.safeZone
        || item?.position
        || item?.layout,
        kind === 'overlay' ? 'auto' : 'center'
    );
    return SAFE_ZONES.has(candidate) ? candidate : (kind === 'overlay' ? 'auto' : 'center');
}

function isManual(item, field) {
    if (!item) return false;
    if (item.manual === true || item._manual === true) return true;
    const names = field === 'timing'
        ? ['timingManual', 'durationManual', 'startTimeManual', '_timingManual']
        : field === 'position'
            ? ['positionManual', 'safeZoneManual', 'layoutManual', '_positionManual']
            : ['animationManual', 'motionManual', 'animationSpeedManual', '_motionManual'];
    return names.some((name) => item[name] === true || item?.mgData?.[name] === true);
}

function setTiming(item, start, end, fps) {
    const duration = Math.max(0.05, end - start);
    item.startTime = start;
    item.endTime = start + duration;
    item.duration = duration;
    item.durationSeconds = duration;
    item.durationFrames = Math.max(1, Math.round(duration * fps));
    item.durationUnit = 'seconds';
    delete item._hfTiming;
}

function ensureAgenticMotion(item) {
    if (!item.agenticComposition || typeof item.agenticComposition !== 'object' || Array.isArray(item.agenticComposition)) {
        item.agenticComposition = {};
    }
    if (!item.agenticComposition.motion || typeof item.agenticComposition.motion !== 'object' || Array.isArray(item.agenticComposition.motion)) {
        item.agenticComposition.motion = {};
    }
    return item.agenticComposition.motion;
}

function setSpeed(item, speed) {
    const normalized = Number(clamp(speed, 0.55, 1.6).toFixed(3));
    ensureAgenticMotion(item).speed = normalized;
    item.animationSpeed = normalized;
    if (item.mgData && typeof item.mgData === 'object') item.mgData.animationSpeed = normalized;
    return normalized;
}

function setStagger(item, stagger) {
    const normalized = Number(clamp(stagger, 0.01, 0.18).toFixed(3));
    ensureAgenticMotion(item).stagger = normalized;
    return normalized;
}

function setDensity(item, density = 'compact') {
    if (!item.agenticComposition || typeof item.agenticComposition !== 'object' || Array.isArray(item.agenticComposition)) {
        item.agenticComposition = {};
    }
    item.agenticComposition.density = density;
    item.agenticComposition.style = {
        ...(item.agenticComposition.style || {}),
        density,
    };
    item.agenticComposition.constraints = {
        ...(item.agenticComposition.constraints || {}),
        readable: true,
        noOverlap: true,
        maxTextLines: Math.min(3, numeric(item.agenticComposition?.constraints?.maxTextLines, 3)),
    };
}

function setSafeZone(item, safeZone) {
    const normalized = SAFE_ZONES.has(token(safeZone)) ? token(safeZone) : 'bottom-left';
    if (!item.agenticComposition || typeof item.agenticComposition !== 'object' || Array.isArray(item.agenticComposition)) {
        item.agenticComposition = {};
    }
    item.agenticComposition.safeZone = normalized;
    item.safeZone = normalized;
    item.position = normalized;
    return normalized;
}

function simplifyMotion(item) {
    const motion = ensureAgenticMotion(item);
    motion.entrance = 'fade-slide';
    motion.emphasis = 'none';
    motion.exit = 'soft-out';
    motion.stagger = 0.04;
    motion.speed = 1;
    item.animation = 'fadeSlide';
    item.animationSpeed = 1;
    if (item.mgData && typeof item.mgData === 'object') {
        item.mgData.animation = 'fadeSlide';
        item.mgData.animationSpeed = 1;
    }
}

function fallbackAuthoredComposition(item) {
    const nested = item?.mgData && typeof item.mgData === 'object' ? item.mgData : null;
    const hadAuthored = Boolean(item?._authoredComposition || nested?._authoredComposition);
    for (const target of [item, nested]) {
        if (!target) continue;
        delete target._authoredComposition;
        delete target._authoredAssets;
        delete target._authoredNs;
        delete target._authoredRendered;
    }
    return hadAuthored;
}

function stableSceneIdentity(scene) {
    for (const value of [
        scene?.originalIndex,
        scene?.sourceSceneIndex,
        scene?.sceneIndex,
        scene?.index,
    ]) {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) return parsed;
    }
    return null;
}

function visualSceneIdentity(item) {
    const nested = item?.mgData && typeof item.mgData === 'object' ? item.mgData : null;
    for (const value of [
        item?.originalSceneIndex,
        item?.sourceSceneIndex,
        item?.targetSceneIndex,
        item?.sceneIndex,
        nested?.originalSceneIndex,
        nested?.sourceSceneIndex,
        nested?.targetSceneIndex,
        nested?.sceneIndex,
    ]) {
        const parsed = Number(value);
        if (Number.isInteger(parsed)) return parsed;
    }
    return null;
}

function findOwnerScene(plan, start, end, item = null) {
    const candidates = (plan?.scenes || [])
        .map((scene) => {
            const window = itemWindow(scene, 3);
            const overlap = Math.max(0, Math.min(end, window.end) - Math.max(start, window.start));
            return { scene, window, overlap };
        })
        .filter(candidate => candidate.overlap > 0.02);
    if (candidates.length === 0) return null;

    const identity = visualSceneIdentity(item);
    if (identity != null) {
        const exact = candidates.find(candidate => stableSceneIdentity(candidate.scene) === identity);
        if (exact) return exact.scene;
    }

    candidates.sort((a, b) => b.overlap - a.overlap || a.window.start - b.window.start);
    return candidates[0].scene;
}

function nextSceneBoundary(plan, start) {
    const starts = (plan?.scenes || [])
        .map(scene => itemWindow(scene, 3).start)
        .filter(sceneStart => sceneStart > start + 0.05)
        .sort((a, b) => a - b);
    return starts[0] ?? null;
}

function collectVisualRefs(plan) {
    const refs = [];
    for (const group of VISUAL_GROUPS) {
        const kind = group === 'motionGraphics' ? 'overlay' : (group === 'mgScenes' ? 'fullscreen' : 'template');
        const list = Array.isArray(plan?.[group]) ? plan[group] : [];
        list.forEach((item, index) => {
            if (!item || item.disabled) return;
            const window = itemWindow(item, kind === 'template' ? 4 : 3);
            const owner = findOwnerScene(plan, window.start, window.end, item);
            refs.push({
                group,
                index,
                kind,
                item,
                owner,
                ...window,
                safeZone: safeZoneOf(item, kind),
                type: token(item.type || item.mgType || item.templateType, 'graphic'),
            });
        });
    }
    return refs;
}

function motionBudget(ref) {
    const speed = currentSpeed(ref.item);
    const words = wordCount(ref.item);
    const items = listItemCount(ref.item);
    const stage = ref.kind !== 'overlay';
    const micro = !stage && MICRO_VISUAL_TYPES.has(ref.type);
    const entrance = (stage ? 0.56 : (micro ? 0.18 : 0.44)) / speed;
    const exit = (stage ? 0.34 : (micro ? 0.12 : 0.27)) / speed;
    const requestedStagger = numeric(ref.item?.agenticComposition?.motion?.stagger, 0.055);
    const staggerTail = items > 1 ? Math.min(0.9, requestedStagger * (items - 1) / speed) : 0;
    const readableHold = micro
        ? clamp(0.28 + words * 0.045 + items * 0.06, 0.32, 1.15)
        : clamp(
            (stage ? 1.45 : 0.95) + words * (stage ? 0.105 : 0.09) + items * (stage ? 0.22 : 0.13),
            stage ? 1.8 : 1.2,
            stage ? 6.2 : 4.2
        );
    return {
        speed,
        words,
        items,
        entrance,
        exit,
        staggerTail,
        readableHold,
        required: entrance + Math.max(readableHold, staggerTail + (micro ? 0.2 : 0.7)) + exit,
    };
}

function laneFor(ref) {
    if (ref.kind !== 'overlay') return 'stage';
    return `overlay:${ref.safeZone}`;
}

function repairRecord(code, ref, before, after, reason) {
    return {
        code,
        target: `${ref.group}:${ref.index}`,
        group: ref.group,
        index: ref.index,
        type: ref.type,
        before,
        after,
        reason,
    };
}

function repairSemanticRedundancy(plan, findings = []) {
    const repairs = [];
    let refs = collectVisualRefs(plan);

    for (const ref of refs) {
        if (ref.kind === 'overlay') continue;
        const duplicateFact = authoredDuplicateNumericFact(ref.item);
        if (!duplicateFact || !fallbackAuthoredComposition(ref.item)) continue;
        repairs.push(repairRecord(
            'authored_semantic_duplicate_fallback',
            ref,
            { authored: true, repeatedFact: duplicateFact },
            { authored: false },
            'The authored composition repeated the same numeric fact in multiple visual roles, so Motion QA restored the clean deterministic renderer.'
        ));
    }

    refs = collectVisualRefs(plan);
    const stageRefs = refs.filter(ref => ref.kind !== 'overlay');
    const overlayRefs = refs.filter(ref => ref.kind === 'overlay');
    for (const stageRef of stageRefs) {
        const stageProfile = semanticProfile(stageRef.item);
        for (const overlayRef of overlayRefs) {
            if (overlayRef.item.disabled || !windowsAreRelated(stageRef, overlayRef)) continue;
            const overlayProfile = semanticProfile(overlayRef.item);
            if (!semanticProfilesMatch(stageProfile, overlayProfile)) continue;

            if (isManual(overlayRef.item, 'timing')) {
                findings.push({
                    severity: 'warn',
                    code: 'manual_semantic_duplicate',
                    target: `${overlayRef.group}:${overlayRef.index}`,
                    message: `${overlayRef.type} repeats the adjacent ${stageRef.type}, but Motion QA preserved the manually controlled overlay.`,
                });
                continue;
            }

            overlayRef.item.disabled = true;
            repairs.push(repairRecord(
                'semantic_duplicate_suppressed',
                overlayRef,
                { disabled: false },
                { disabled: true, preserved: `${stageRef.group}:${stageRef.index}` },
                'A stage visual and adjacent overlay communicated the same fact; the overlay was suppressed so the viewer sees one treatment.'
            ));
        }
    }

    return repairs;
}

/**
 * Fast plan-level QA. This runs during build and again before render. It does
 * not call AI or launch a browser.
 */
function prepareMotionPlan(plan, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : () => {};
    const repairs = [];
    const findings = [];
    if (!plan || typeof plan !== 'object') {
        return { status: 'fail', findings: [{ severity: 'error', code: 'missing_plan', message: 'Motion QA requires a video plan.' }], repairs };
    }
    if (!enabled()) return { status: 'skipped', findings: [], repairs, skipped: true };

    const fps = Math.max(1, numeric(plan.fps, 30));
    const totalDuration = Math.max(0.1, numeric(plan.totalDuration, 0.1));
    repairs.push(...repairSemanticRedundancy(plan, findings));
    const refs = collectVisualRefs(plan);
    const lanes = new Map();
    for (const ref of refs) {
        const lane = laneFor(ref);
        if (!lanes.has(lane)) lanes.set(lane, []);
        lanes.get(lane).push(ref);
    }
    for (const laneRefs of lanes.values()) laneRefs.sort((a, b) => a.start - b.start || a.end - b.end);

    for (const ref of refs) {
        const budget = motionBudget(ref);
        const ownerWindow = ref.owner ? itemWindow(ref.owner, totalDuration) : null;
        const laneRefs = lanes.get(laneFor(ref)) || [];
        const laneIndex = laneRefs.indexOf(ref);
        const next = laneRefs[laneIndex + 1] || null;
        const laneLimit = next ? next.start - 0.08 : totalDuration;
        const boundary = nextSceneBoundary(plan, ref.start);
        const ownerLimit = ownerWindow
            ? ownerWindow.end
            : Math.min(ref.end, boundary ?? ref.end);
        const maxEnd = Math.max(ref.start + 0.05, Math.min(totalDuration, laneLimit, ownerLimit));

        if (!isManual(ref.item, 'motion') && (budget.speed < 0.55 || budget.speed > 1.6)) {
            const nextSpeed = setSpeed(ref.item, clamp(budget.speed, 0.65, 1.35));
            repairs.push(repairRecord(
                'motion_speed_clamped',
                ref,
                budget.speed,
                nextSpeed,
                'Animation speed was outside the reliable/readable range.'
            ));
        }

        let current = itemWindow(ref.item, ref.kind === 'template' ? 4 : 3);
        if (!isManual(ref.item, 'timing') && current.duration + 0.03 < budget.required) {
            const desiredEnd = Math.min(maxEnd, current.start + budget.required);
            if (desiredEnd > current.end + 0.04) {
                const before = { startTime: current.start, endTime: current.end, duration: current.duration };
                setTiming(ref.item, current.start, desiredEnd, fps);
                current = itemWindow(ref.item, current.duration);
                repairs.push(repairRecord(
                    'readable_hold_extended',
                    ref,
                    before,
                    { startTime: current.start, endTime: current.end, duration: current.duration },
                    `Extended the visual so its ${budget.words} words/${budget.items} items have a readable hold.`
                ));
            }
        }

        current = itemWindow(ref.item, ref.kind === 'template' ? 4 : 3);
        const remainingDeficit = budget.required - current.duration;
        if (remainingDeficit > 0.12 && !isManual(ref.item, 'motion')) {
            const beforeSpeed = currentSpeed(ref.item);
            const ratio = clamp(budget.required / Math.max(current.duration, 0.4), 1, 1.35);
            const nextSpeed = setSpeed(ref.item, Math.max(beforeSpeed, ratio));
            if (Math.abs(nextSpeed - beforeSpeed) > 0.01) {
                repairs.push(repairRecord(
                    'motion_fitted_to_window',
                    ref,
                    beforeSpeed,
                    nextSpeed,
                    'The available scene window was too short, so entrance/exit motion was accelerated within a safe limit.'
                ));
            }
            if (budget.items > 2) {
                const availableForStagger = Math.max(0.08, current.duration - 1.15);
                const maxStagger = clamp(availableForStagger / Math.max(1, budget.items - 1), 0.02, 0.11);
                const beforeStagger = numeric(ref.item?.agenticComposition?.motion?.stagger, 0.055);
                if (beforeStagger > maxStagger + 0.005) {
                    const afterStagger = setStagger(ref.item, maxStagger);
                    repairs.push(repairRecord(
                        'stagger_fitted_to_window',
                        ref,
                        beforeStagger,
                        afterStagger,
                        'Stagger was consuming the readable hold.'
                    ));
                }
            }
            if (wordCount(ref.item) > (ref.kind === 'overlay' ? 24 : 42)) {
                setDensity(ref.item, 'compact');
                repairs.push(repairRecord(
                    'dense_motion_compacted',
                    ref,
                    'standard',
                    'compact',
                    'Dense text could not fit the available window safely.'
                ));
            }
        }

        current = itemWindow(ref.item, ref.kind === 'template' ? 4 : 3);
        const minimum = ref.kind === 'overlay'
            ? (MICRO_VISUAL_TYPES.has(ref.type) ? 0.5 : 0.9)
            : 1.25;
        if (current.duration < minimum - 0.01) {
            findings.push({
                severity: 'error',
                code: 'visual_window_too_short',
                target: `${ref.group}:${ref.index}`,
                message: `${ref.type} has only ${current.duration.toFixed(2)}s; it cannot show a reliable entrance, readable state and exit.`,
            });
        }
    }

    // Same-lane collisions are repaired after individual duration expansion.
    for (const [lane, laneRefs] of lanes.entries()) {
        for (let i = 0; i < laneRefs.length - 1; i++) {
            const currentRef = laneRefs[i];
            const nextRef = laneRefs[i + 1];
            const current = itemWindow(currentRef.item, 3);
            const overlap = current.end - nextRef.start;
            if (overlap <= 0.08) continue;

            const collisionMinimum = currentRef.kind === 'overlay'
                ? (MICRO_VISUAL_TYPES.has(currentRef.type) ? 0.5 : 0.9)
                : 1.25;
            if (!isManual(currentRef.item, 'timing') && nextRef.start - current.start >= collisionMinimum) {
                const before = { startTime: current.start, endTime: current.end, duration: current.duration };
                const end = Math.max(current.start + 0.05, nextRef.start - 0.08);
                setTiming(currentRef.item, current.start, end, fps);
                const after = itemWindow(currentRef.item, 3);
                repairs.push(repairRecord(
                    'motion_collision_trimmed',
                    currentRef,
                    before,
                    { startTime: after.start, endTime: after.end, duration: after.duration },
                    `${lane} contained overlapping visuals.`
                ));
            } else if (
                currentRef.kind === 'overlay'
                && !isManual(nextRef.item, 'position')
                && safeZoneOf(currentRef.item, currentRef.kind) === safeZoneOf(nextRef.item, nextRef.kind)
            ) {
                const beforeZone = safeZoneOf(nextRef.item, nextRef.kind);
                const afterZone = setSafeZone(nextRef.item, MOVE_FALLBACK[beforeZone] || 'top-right');
                repairs.push(repairRecord(
                    'motion_collision_repositioned',
                    nextRef,
                    beforeZone,
                    afterZone,
                    'Two simultaneous overlays occupied the same safe zone.'
                ));
            } else {
                findings.push({
                    severity: 'warn',
                    code: 'manual_motion_overlap',
                    target: `${currentRef.group}:${currentRef.index}`,
                    message: `${lane} visuals overlap by ${overlap.toFixed(2)}s, but Motion QA preserved manual timing/position.`,
                });
            }
        }
    }

    const hard = findings.filter((finding) => finding.severity === 'error').length;
    const status = hard ? 'fail' : (findings.length ? 'warn' : 'pass');
    if (repairs.length) log(`[Motion QA] Preflight repaired ${repairs.length} motion issue(s).`);
    return {
        version: VERSION,
        status,
        checked: refs.length,
        findings,
        repairs,
    };
}

function resolveHyperframesCli(appRoot) {
    const local = path.join(appRoot || process.cwd(), 'node_modules', 'hyperframes', 'dist', 'cli.js');
    if (fs.existsSync(local)) return local;
    try { return require.resolve('hyperframes/dist/cli.js'); } catch (_) { return null; }
}

function parseJsonOutput(raw) {
    const text = String(raw || '').trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch (_) { /* try bounded extraction */ }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
        try { return JSON.parse(text.slice(start, end + 1)); } catch (_) { return null; }
    }
    return null;
}

function runCli({
    cli,
    command,
    args = [],
    cwd,
    env = {},
    timeoutMs = 180_000,
    onProcess,
    isCancelled,
}) {
    return new Promise((resolve) => {
        if (!cli) {
            resolve({ ok: false, unavailable: true, code: null, stdout: '', stderr: 'HyperFrames CLI missing', json: null });
            return;
        }
        const child = spawn(process.execPath, [cli, command, ...args], {
            cwd,
            shell: false,
            windowsHide: true,
            env: { ...process.env, FORCE_COLOR: '0', ...env },
        });
        if (typeof onProcess === 'function') onProcess(child, `motion-qa:${command}`);

        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const append = (current, chunk) => (current + String(chunk || '')).slice(-16 * 1024 * 1024);
        child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
        child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGTERM'); } catch (_) { /* noop */ }
        }, timeoutMs);

        child.on('error', (error) => {
            clearTimeout(timer);
            if (typeof onProcess === 'function') onProcess(null, `motion-qa:${command}`, child);
            resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n${error.message}`, json: parseJsonOutput(stdout), timedOut });
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (typeof onProcess === 'function') onProcess(null, `motion-qa:${command}`, child);
            resolve({
                ok: code === 0,
                cancelled: typeof isCancelled === 'function' && isCancelled(),
                code,
                stdout,
                stderr,
                json: parseJsonOutput(stdout),
                timedOut,
            });
        });
    });
}

function readJson(filePath, fallback = null) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (_) { return fallback; }
}

function summarizeHyperframesFinding(finding, section) {
    const code = finding?.code || `${section}_finding`;
    return {
        severity: finding?.severity === 'error'
            ? 'error'
            : (finding?.severity === 'warning' && !INFORMATIONAL_HYPERFRAMES_CODES.has(code) ? 'warn' : 'info'),
        code,
        section,
        selector: finding?.selector || '',
        elementId: finding?.elementId || '',
        message: compactText(finding?.message || finding?.fixHint || 'HyperFrames diagnostic finding', 260),
    };
}

function collectCliFindings(diagnostics) {
    const findings = [];
    const lint = diagnostics?.lint?.json;
    for (const finding of lint?.findings || []) {
        if (finding?.severity === 'error' || finding?.severity === 'warning') {
            findings.push(summarizeHyperframesFinding(finding, 'lint'));
        }
    }

    const check = diagnostics?.check?.json;
    for (const section of ['runtime', 'layout', 'motion', 'contrast']) {
        for (const finding of check?.[section]?.findings || []) {
            if (finding?.severity === 'error' || finding?.severity === 'warning') {
                findings.push(summarizeHyperframesFinding(finding, section));
            }
        }
    }
    if (diagnostics?.lint?.unavailable || diagnostics?.check?.unavailable || diagnostics?.keyframes?.unavailable) {
        findings.push({
            severity: 'warn',
            code: 'hyperframes_diagnostics_unavailable',
            section: 'tooling',
            message: 'One or more bundled HyperFrames diagnostics were unavailable; render contract checks were reduced.',
        });
    }
    if (diagnostics?.lint && !diagnostics.lint.ok && !diagnostics.lint.json && !diagnostics.lint.unavailable) {
        findings.push({
            severity: 'error',
            code: 'hyperframes_lint_failed',
            section: 'lint',
            message: compactText(diagnostics.lint.stderr || diagnostics.lint.stdout || 'HyperFrames lint failed without a report.', 260),
        });
    }
    if (diagnostics?.check && !diagnostics.check.ok && !diagnostics.check.json && !diagnostics.check.unavailable) {
        findings.push({
            severity: 'warn',
            code: 'hyperframes_check_failed',
            section: 'check',
            message: compactText(diagnostics.check.stderr || diagnostics.check.stdout || 'HyperFrames runtime check failed without a report.', 260),
        });
    }
    if (diagnostics?.keyframes && !diagnostics.keyframes.ok && !diagnostics.keyframes.json && !diagnostics.keyframes.unavailable) {
        findings.push({
            severity: 'info',
            code: 'hyperframes_keyframes_unavailable',
            section: 'keyframes',
            message: compactText(diagnostics.keyframes.stderr || diagnostics.keyframes.stdout || 'HyperFrames keyframe extraction failed without a report.', 260),
        });
    }
    return findings;
}

function keyframeSummary(keyframesJson, manifest) {
    const compositions = Array.isArray(keyframesJson?.compositions) ? keyframesJson.compositions : [];
    const staticTweens = compositions.reduce((sum, comp) => sum + (Array.isArray(comp?.tweens) ? comp.tweens.length : 0), 0);
    const cssKeyframes = compositions.reduce((sum, comp) => sum + (Array.isArray(comp?.cssKeyframes) ? comp.cssKeyframes.length : 0), 0);
    const traces = compositions.reduce((sum, comp) => sum + (Array.isArray(comp?.traces) ? comp.traces.length : 0), 0);
    const manifestSubjects = (manifest?.graphics?.length || 0)
        + (manifest?.scenes?.length || 0)
        + (manifest?.transitions?.length || 0);
    return {
        staticTweens,
        cssKeyframes,
        traces,
        manifestSubjects,
        dynamicSubjectsCoveredByManifest: Math.max(0, manifestSubjects - staticTweens),
    };
}

function proofTimesFromManifest(manifest, limit = 4) {
    const candidates = [];
    for (const graphic of manifest?.graphics || []) {
        const start = numeric(graphic.start, 0);
        const duration = Math.max(0.1, numeric(graphic.duration, 0.1));
        const risk = (numeric(graphic.wordCount, 0) * 0.15)
            + (numeric(graphic.itemCount, 0) * 0.8)
            + (graphic.authored ? 2 : 0)
            + (duration < 2 ? 2 : 0);
        candidates.push({
            id: graphic.id,
            risk,
            times: [
                { time: start + Math.min(0.16, duration * 0.08), phase: 'entrance' },
                { time: start + duration * 0.48, phase: 'hero' },
            ],
        });
    }
    candidates.sort((a, b) => b.risk - a.risk);
    const selected = [];
    for (const candidate of candidates.slice(0, 2)) {
        for (const point of candidate.times) selected.push({ ...point, id: candidate.id });
    }
    if (!selected.length) {
        for (const transition of (manifest?.transitions || []).slice(0, limit)) {
            const boundary = numeric(transition.boundary, numeric(transition.start, 0) + numeric(transition.duration, 0) / 2);
            selected.push({ id: transition.id, phase: 'transition', time: boundary });
        }
    }
    if (!selected.length && numeric(manifest?.duration, 0) > 0) {
        const duration = numeric(manifest.duration, 0);
        selected.push(
            { id: 'timeline', phase: 'opening', time: Math.min(0.25, duration * 0.05) },
            { id: 'timeline', phase: 'middle', time: duration * 0.5 },
            { id: 'timeline', phase: 'ending', time: Math.max(0, duration - 0.15) }
        );
    }
    const seen = new Set();
    return selected
        .map((entry) => ({ ...entry, time: Number(Math.max(0, entry.time).toFixed(3)) }))
        .filter((entry) => {
            const key = entry.time.toFixed(3);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, limit);
}

function listSnapshotFrameNames(outDir) {
    if (!fs.existsSync(outDir)) return [];
    const names = fs.readdirSync(outDir);
    const numberedFrames = names
        .filter((name) => /^frame-.*\.(png|jpe?g)$/i.test(name))
        .sort();
    if (numberedFrames.length) return numberedFrames;
    return names
        .filter((name) => /\.(png|jpe?g)$/i.test(name) && !/contact[-_ ]?sheet/i.test(name))
        .sort();
}

async function captureProofSnapshots({
    cli,
    projectDir,
    appRoot,
    manifest,
    proof: proofValue,
    browserPath,
    onProcess,
    isCancelled,
}) {
    const proof = Array.isArray(proofValue) && proofValue.length
        ? proofValue.slice(0, 8).map((entry, index) => ({
            id: compactText(entry?.id || `proof-${index + 1}`, 120),
            phase: compactText(entry?.phase || 'proof', 80),
            time: Number(Math.max(0, numeric(entry?.time, 0)).toFixed(3)),
        }))
        : proofTimesFromManifest(manifest, 4);
    if (!proof.length) return { proof, files: [], result: null };
    const outDir = path.join(projectDir, 'motion-qa-snapshots');
    const resolvedProject = path.resolve(projectDir);
    const resolvedOut = path.resolve(outDir);
    if (resolvedOut !== resolvedProject && !resolvedOut.startsWith(`${resolvedProject}${path.sep}`)) {
        throw new Error(`Motion QA snapshot path escaped the generated project: ${resolvedOut}`);
    }
    try { fs.rmSync(resolvedOut, { recursive: true, force: true }); } catch (_) { /* noop */ }
    const result = await runCli({
        cli,
        command: 'snapshot',
        args: [
            projectDir,
            '--output', outDir,
            '--at', proof.map((entry) => entry.time).join(','),
            '--no-end',
            '--describe=false',
        ],
        cwd: appRoot,
        env: browserPath ? {
            HYPERFRAMES_BROWSER_PATH: browserPath,
            PRODUCER_HEADLESS_SHELL_PATH: browserPath,
        } : {},
        timeoutMs: 180_000,
        onProcess,
        isCancelled,
    });
    const frameNames = listSnapshotFrameNames(outDir);
    const files = frameNames.map((name, index) => ({
        file: path.join(outDir, name),
        ...(proof[index] || { id: 'timeline', phase: 'proof', time: 0 }),
    }));
    return { proof, files, result };
}

async function visionReviewSnapshots(snapshotFiles, manifest) {
    if (flagOff('HF_MOTION_QA_VISION') || !snapshotFiles.length) {
        return { status: 'skipped', repairs: [], reason: 'disabled-or-no-snapshots' };
    }
    let provider;
    try { provider = require('../../brain/ai-provider'); } catch (_) {
        return { status: 'skipped', repairs: [], reason: 'vision-provider-unavailable' };
    }
    if (!provider.isVisionAIAvailable()) {
        return { status: 'skipped', repairs: [], reason: 'vision-provider-unavailable' };
    }

    const frames = snapshotFiles.slice(0, 4).map((entry) => ({
        base64: fs.readFileSync(entry.file).toString('base64'),
        mimeType: path.extname(entry.file).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
        timestamp: entry.time,
    }));
    const labels = snapshotFiles.slice(0, 4).map((entry, index) => (
        `Frame ${index + 1}: ${entry.id} ${entry.phase} at ${Number(entry.time).toFixed(2)}s`
    )).join('\n');
    const subjects = (manifest?.graphics || []).map((graphic) => ({
        id: graphic.id,
        target: `${graphic.sourceGroup}:${graphic.sourceIndex}`,
        type: graphic.type,
        kind: graphic.kind,
        start: graphic.start,
        duration: graphic.duration,
        authored: graphic.authored,
        safeZone: graphic.safeZone,
        animation: graphic.animation,
        text: graphic.textPreview,
    }));
    const prompt = `You are the automatic Motion QA critic for a professional YouTube video editor.

The frames are deterministic proof frames from one HyperFrames composition:
${labels}

Animated subjects:
${JSON.stringify(subjects.slice(0, 20), null, 2)}

Judge ONLY clear production defects:
- important text or graphics outside the frame
- text collisions or unreadable density
- an entrance that still hides the message at the hero frame
- motion that is distractingly fast/slow
- overlapping overlays occupying the same area
- a broken authored composition that should safely fall back

Do not redesign good work. Do not change copy, facts, media, story, colors or theme.
Return strict JSON only:
{
  "verdict": "pass|repair",
  "repairs": [
    {
      "id": "exact subject id",
      "action": "speed-up|slow-down|simplify|compact|move|fallback-authored|extend-hold",
      "value": "optional safe zone or seconds",
      "reason": "short concrete defect"
    }
  ]
}
Maximum 3 repairs. If the evidence is ambiguous, return pass.`;

    try {
        const raw = await provider.callVideoAI(prompt, frames, { maxTokens: 450 });
        const { parseJsonObject } = require('../../brain/strict-json');
        const parsed = parseJsonObject(raw);
        const validIds = new Set((manifest?.graphics || []).map((graphic) => graphic.id));
        const validActions = new Set(['speed-up', 'slow-down', 'simplify', 'compact', 'move', 'fallback-authored', 'extend-hold']);
        const repairs = (Array.isArray(parsed?.repairs) ? parsed.repairs : [])
            .filter((repair) => validIds.has(repair?.id) && validActions.has(repair?.action))
            .slice(0, 3)
            .map((repair) => ({
                id: repair.id,
                action: repair.action,
                value: repair.value,
                reason: compactText(repair.reason, 180),
            }));
        return {
            status: repairs.length ? 'repair' : 'pass',
            verdict: parsed?.verdict || (repairs.length ? 'repair' : 'pass'),
            repairs,
        };
    } catch (error) {
        return { status: 'skipped', repairs: [], reason: compactText(error.message, 180) };
    }
}

function sourceRefFromManifest(plan, manifestEntry) {
    const group = manifestEntry?.sourceGroup;
    const index = Number(manifestEntry?.sourceIndex);
    if (!VISUAL_GROUPS.includes(group) || !Number.isInteger(index)) return null;
    const item = plan?.[group]?.[index];
    if (!item) return null;
    const kind = group === 'motionGraphics' ? 'overlay' : (group === 'mgScenes' ? 'fullscreen' : 'template');
    const window = itemWindow(item, kind === 'template' ? 4 : 3);
    return {
        group,
        index,
        item,
        kind,
        type: token(item.type || item.mgType || item.templateType, 'graphic'),
        owner: findOwnerScene(plan, window.start, window.end, item),
        ...window,
    };
}

function applyManifestTimingRepairs(plan, manifest) {
    const repairs = [];
    const fps = Math.max(1, numeric(plan?.fps, 30));
    for (const entry of manifest?.graphics || []) {
        if (!entry?.timingClamped) continue;
        const ref = sourceRefFromManifest(plan, entry);
        if (!ref || isManual(ref.item, 'timing')) continue;
        const start = Math.max(0, numeric(entry.start, ref.start));
        const duration = Math.max(0.05, numeric(entry.duration, ref.duration));
        if (Math.abs(ref.start - start) < 0.01 && Math.abs(ref.duration - duration) < 0.01) continue;
        const before = { startTime: ref.start, endTime: ref.end, duration: ref.duration };
        setTiming(ref.item, start, start + duration, fps);
        repairs.push(repairRecord(
            'bridge_timing_persisted',
            ref,
            before,
            { startTime: start, endTime: start + duration, duration },
            'Persisted the bridge timing guard result so future builds start from the verified timing.'
        ));
    }
    return repairs;
}

function diagnosticEntryForFinding(manifest, finding) {
    const needle = `${finding?.selector || ''} ${finding?.elementId || ''} ${finding?.message || ''}`;
    return (manifest?.graphics || []).find((entry) => needle.includes(entry.id)) || null;
}

function applyDiagnosticRepairs(plan, manifest, findings) {
    const repairs = [];
    for (const finding of findings || []) {
        const message = `${finding.code || ''} ${finding.message || ''}`.toLowerCase();
        if (!/(overflow|outside|collision|overlap|invisible|opacity|unreadable|clipped)/.test(message)) continue;
        const entry = diagnosticEntryForFinding(manifest, finding);
        const ref = sourceRefFromManifest(plan, entry);
        if (!entry || !ref) continue;

        if (entry.authored && fallbackAuthoredComposition(ref.item)) {
            repairs.push(repairRecord(
                'authored_motion_fallback',
                ref,
                'authored-composition',
                'agentic-fixed-renderer',
                finding.message
            ));
            continue;
        }
        if (!isManual(ref.item, 'motion')) {
            setDensity(ref.item, 'compact');
            simplifyMotion(ref.item);
            repairs.push(repairRecord(
                'motion_simplified_after_diagnostic',
                ref,
                'complex',
                'compact/fade-slide',
                finding.message
            ));
        }
    }
    return repairs;
}

function applyVisionRepairs(plan, manifest, vision) {
    const repairs = [];
    const fps = Math.max(1, numeric(plan?.fps, 30));
    const byId = new Map((manifest?.graphics || []).map((entry) => [entry.id, entry]));
    for (const proposed of vision?.repairs || []) {
        const entry = byId.get(proposed.id);
        const ref = sourceRefFromManifest(plan, entry);
        if (!entry || !ref) continue;
        const reason = proposed.reason || 'Vision Motion QA repair';
        if (proposed.action === 'fallback-authored') {
            if (fallbackAuthoredComposition(ref.item)) {
                repairs.push(repairRecord('vision_authored_fallback', ref, 'authored-composition', 'agentic-fixed-renderer', reason));
            }
        } else if (proposed.action === 'simplify' && !isManual(ref.item, 'motion')) {
            simplifyMotion(ref.item);
            repairs.push(repairRecord('vision_motion_simplified', ref, 'complex', 'fade-slide', reason));
        } else if (proposed.action === 'compact' && !isManual(ref.item, 'motion')) {
            setDensity(ref.item, 'compact');
            repairs.push(repairRecord('vision_layout_compacted', ref, 'standard', 'compact', reason));
        } else if (proposed.action === 'speed-up' && !isManual(ref.item, 'motion')) {
            const before = currentSpeed(ref.item);
            const after = setSpeed(ref.item, before * 1.15);
            repairs.push(repairRecord('vision_motion_sped_up', ref, before, after, reason));
        } else if (proposed.action === 'slow-down' && !isManual(ref.item, 'motion')) {
            const before = currentSpeed(ref.item);
            const after = setSpeed(ref.item, before * 0.85);
            repairs.push(repairRecord('vision_motion_slowed_down', ref, before, after, reason));
        } else if (proposed.action === 'move' && !isManual(ref.item, 'position')) {
            const before = safeZoneOf(ref.item, ref.kind);
            const requested = SAFE_ZONES.has(token(proposed.value)) ? token(proposed.value) : (MOVE_FALLBACK[before] || 'bottom-left');
            const after = setSafeZone(ref.item, requested);
            repairs.push(repairRecord('vision_overlay_moved', ref, before, after, reason));
        } else if (proposed.action === 'extend-hold' && !isManual(ref.item, 'timing')) {
            const ownerWindow = ref.owner ? itemWindow(ref.owner, plan.totalDuration || ref.end) : null;
            const total = Math.max(ref.end, numeric(plan.totalDuration, ref.end));
            const requested = clamp(numeric(proposed.value, 0.8), 0.25, 2);
            const maxEnd = Math.min(total, ownerWindow ? ownerWindow.end : total);
            const nextEnd = Math.min(maxEnd, ref.end + requested);
            if (nextEnd > ref.end + 0.04) {
                setTiming(ref.item, ref.start, nextEnd, fps);
                repairs.push(repairRecord('vision_hold_extended', ref, ref.duration, nextEnd - ref.start, reason));
            }
        }
    }
    return repairs;
}

function commandSummary(result) {
    return {
        ok: Boolean(result?.ok),
        code: result?.code ?? null,
        unavailable: Boolean(result?.unavailable),
        timedOut: Boolean(result?.timedOut),
        error: result?.ok ? '' : compactText(result?.stderr || result?.stdout, 400),
    };
}

async function runDiagnostics({
    project,
    appRoot,
    quick,
    browserPath,
    onProcess,
    isCancelled,
    runVision,
}) {
    const cli = resolveHyperframesCli(appRoot);
    const cliEnv = browserPath ? {
        HYPERFRAMES_BROWSER_PATH: browserPath,
        PRODUCER_HEADLESS_SHELL_PATH: browserPath,
    } : {};
    const lint = await runCli({
        cli,
        command: 'lint',
        args: [project.projectDir, '--json'],
        cwd: appRoot,
        env: cliEnv,
        timeoutMs: 90_000,
        onProcess,
        isCancelled,
    });
    if (lint.cancelled) throw new Error('Cancelled');

    const keyframes = await runCli({
        cli,
        command: 'keyframes',
        args: [project.projectDir, '--json', '--runtime', 'all'],
        cwd: appRoot,
        env: cliEnv,
        timeoutMs: 120_000,
        onProcess,
        isCancelled,
    });
    if (keyframes.cancelled) throw new Error('Cancelled');

    const check = await runCli({
        cli,
        command: 'check',
        args: [
            project.projectDir,
            '--json',
            '--samples', quick ? '3' : String(clamp(numeric(process.env.HF_MOTION_QA_SAMPLES, 5), 3, 9)),
            '--at-transitions',
            '--max-transition-samples', quick ? '8' : '24',
            '--no-contrast',
        ],
        cwd: appRoot,
        env: cliEnv,
        timeoutMs: quick ? 120_000 : 240_000,
        onProcess,
        isCancelled,
    });
    if (check.cancelled) throw new Error('Cancelled');

    const manifest = readJson(path.join(project.projectDir, 'hyperframes-motion-manifest.json'), {});
    const timingReport = readJson(path.join(project.projectDir, 'hyperframes-timing-report.json'), {});
    const visualReport = readJson(path.join(project.projectDir, 'hyperframes-visual-report.json'), {});
    let snapshots = { proof: [], files: [], result: null };
    let vision = { status: 'skipped', repairs: [], reason: quick ? 'quick-render' : 'disabled' };
    if (!quick && runVision) {
        snapshots = await captureProofSnapshots({
            cli,
            projectDir: project.projectDir,
            appRoot,
            manifest,
            browserPath,
            onProcess,
            isCancelled,
        });
        if (snapshots.result?.cancelled) throw new Error('Cancelled');
        vision = await visionReviewSnapshots(snapshots.files, manifest);
    }
    const findings = collectCliFindings({ lint, keyframes, check });
    if (snapshots.result && !snapshots.result.ok && !snapshots.files.length) {
        findings.push({
            severity: 'warn',
            code: 'motion_proof_snapshot_failed',
            section: 'snapshot',
            message: compactText(
                snapshots.result.stderr || snapshots.result.stdout || 'HyperFrames proof-frame capture failed.',
                260
            ),
        });
    }
    for (const issue of visualReport?.unsupported || []) {
        findings.push({
            severity: 'error',
            code: 'unsupported_visual_type',
            section: 'bridge',
            message: `Unsupported HyperFrames visual type: ${issue.type || 'unknown'}.`,
        });
    }
    for (const issue of visualReport?.missingMapAssets || []) {
        findings.push({
            severity: 'warn',
            code: 'missing_map_asset',
            section: 'bridge',
            message: `Map scene ${issue.sceneIndex ?? '?'} is missing its preferred map asset; fallback rendering is active.`,
        });
    }
    for (const issue of visualReport?.missingTemplateMedia || []) {
        findings.push({
            severity: 'warn',
            code: 'missing_template_media',
            section: 'bridge',
            message: `${issue.type || 'Template'} is missing preferred media; designed fallback rendering is active.`,
        });
    }
    return {
        raw: { lint, keyframes, check },
        manifest,
        timingReport,
        visualReport,
        snapshots,
        vision,
        findings,
        summary: {
            lint: commandSummary(lint),
            keyframes: commandSummary(keyframes),
            check: commandSummary(check),
            keyframeCoverage: keyframeSummary(keyframes.json, manifest),
            bridge: {
                timingClamped: Array.isArray(timingReport?.clamped) ? timingReport.clamped.length : 0,
                unsupported: Array.isArray(visualReport?.unsupported) ? visualReport.unsupported.length : 0,
                missingMapAssets: Array.isArray(visualReport?.missingMapAssets) ? visualReport.missingMapAssets.length : 0,
                missingTemplateMedia: Array.isArray(visualReport?.missingTemplateMedia) ? visualReport.missingTemplateMedia.length : 0,
                fallbacks: Array.isArray(visualReport?.fallbacks) ? visualReport.fallbacks.length : 0,
            },
            proofFrames: snapshots.files.map((entry) => ({
                file: path.relative(project.projectDir, entry.file),
                id: entry.id,
                phase: entry.phase,
                time: entry.time,
            })),
            vision: {
                status: vision.status,
                reason: vision.reason || '',
                proposedRepairs: vision.repairs || [],
            },
        },
    };
}

function rollupStatus(findings) {
    if ((findings || []).some((finding) => finding.severity === 'error')) return 'fail';
    if ((findings || []).some((finding) => finding.severity === 'warn')) return 'warn';
    return 'pass';
}

function writeMotionQaReport(report, directories) {
    for (const directory of directories.filter(Boolean)) {
        try {
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(path.join(directory, 'motion-qa-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
        } catch (_) { /* reporting must never destroy an otherwise valid render */ }
    }
}

/**
 * Full bounded repair loop. generateProject(plan, pass) must return the normal
 * HyperFrames project descriptor.
 */
async function runMotionQa({
    plan,
    generateProject,
    appRoot,
    reportDir,
    browserPath,
    quick = false,
    log = console.log,
    onProgress,
    onProcess,
    isCancelled,
} = {}) {
    if (typeof generateProject !== 'function') throw new Error('Motion QA requires a HyperFrames project generator callback');
    const logFn = typeof log === 'function' ? log : () => {};
    const progress = typeof onProgress === 'function' ? onProgress : () => {};
    const startedAt = new Date().toISOString();

    if (!enabled()) {
        const project = await generateProject(plan, 1);
        const report = {
            version: VERSION,
            status: 'skipped',
            agentic: true,
            reason: 'HF_MOTION_QA=0',
            generatedAt: startedAt,
            repairCount: 0,
            passes: [],
        };
        plan.motionQa = { version: VERSION, status: 'skipped', repairCount: 0 };
        writeMotionQaReport(report, [reportDir, project?.projectDir]);
        return { project, report, changed: false, hardFail: false };
    }

    progress(10, '[Motion QA] Inspecting animation timing and readability...');
    let preflight = prepareMotionPlan(plan, { log: logFn });
    const allRepairs = [...preflight.repairs];
    const passes = [];
    const maxPasses = quick ? 1 : clamp(numeric(process.env.HF_MOTION_QA_PASSES, 2), 1, 2);
    let project = null;
    let finalFindings = [...preflight.findings];

    for (let pass = 1; pass <= maxPasses; pass++) {
        if (typeof isCancelled === 'function' && isCancelled()) throw new Error('Cancelled');
        progress(pass === 1 ? 12 : 15, pass === 1
            ? '[Motion QA] Generating proof composition...'
            : '[Motion QA] Regenerating after automatic repairs...');
        project = await generateProject(plan, pass);
        progress(pass === 1 ? 14 : 16, `[Motion QA] HyperFrames verification pass ${pass}/${maxPasses}...`);

        const diagnostics = await runDiagnostics({
            project,
            appRoot,
            quick,
            browserPath,
            onProcess,
            isCancelled,
            runVision: pass === 1,
        });
        finalFindings = [...preflight.findings, ...diagnostics.findings];
        const passReport = {
            pass,
            projectDir: project.projectDir,
            findings: diagnostics.findings,
            diagnostics: diagnostics.summary,
            repairs: [],
        };

        if (pass < maxPasses) {
            const repairs = [
                ...applyManifestTimingRepairs(plan, diagnostics.manifest),
                ...applyDiagnosticRepairs(plan, diagnostics.manifest, diagnostics.findings),
                ...applyVisionRepairs(plan, diagnostics.manifest, diagnostics.vision),
            ];
            if (repairs.length) {
                // Re-run the semantic guard after pixel/vision changes so a
                // fallback or speed/layout repair cannot introduce a fresh
                // short hold or same-zone collision.
                const followupPreflight = prepareMotionPlan(plan, { log: logFn });
                repairs.push(...(followupPreflight.repairs || []));
                preflight = followupPreflight;
            }
            const unique = [];
            const seen = new Set();
            for (const repair of repairs) {
                const key = `${repair.code}:${repair.target}:${JSON.stringify(repair.after)}`;
                if (seen.has(key)) continue;
                seen.add(key);
                unique.push(repair);
            }
            passReport.repairs = unique;
            allRepairs.push(...unique);
            passes.push(passReport);
            if (!unique.length) break;
            logFn(`[Motion QA] Pass ${pass} repaired ${unique.length} issue(s); verifying again.`);
            progress(15, `[Motion QA] Repaired ${unique.length} issue(s); verifying the corrected motion...`);
            continue;
        }
        passes.push(passReport);
    }

    const status = rollupStatus(finalFindings);
    const strict = !flagOff('HF_MOTION_QA_STRICT');
    const hardFail = status === 'fail' && strict;
    const report = {
        version: VERSION,
        status,
        agentic: true,
        strict,
        quick,
        generatedAt: startedAt,
        completedAt: new Date().toISOString(),
        checkedVisuals: preflight.checked || 0,
        repairCount: allRepairs.length,
        repairs: allRepairs,
        findings: finalFindings,
        passes,
    };
    plan.motionQa = {
        version: VERSION,
        status,
        agentic: true,
        strict,
        repairCount: allRepairs.length,
        findingCount: finalFindings.length,
        generatedAt: report.completedAt,
    };
    writeMotionQaReport(report, [reportDir, project?.projectDir]);
    const icon = status === 'pass' ? 'PASS' : status === 'warn' ? 'WARN' : 'FAIL';
    logFn(`[Motion QA] ${icon}: ${preflight.checked || 0} visual(s), ${allRepairs.length} repair(s), ${finalFindings.length} finding(s).`);
    return {
        project,
        report,
        changed: allRepairs.length > 0,
        hardFail,
    };
}

module.exports = {
    VERSION,
    applyDiagnosticRepairs,
    applyManifestTimingRepairs,
    applyVisionRepairs,
    captureProofSnapshots,
    collectVisualRefs,
    listSnapshotFrameNames,
    prepareMotionPlan,
    proofTimesFromManifest,
    resolveHyperframesCli,
    runMotionQa,
};
