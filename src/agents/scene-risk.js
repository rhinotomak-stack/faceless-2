/**
 * scene-risk.js — slideshow / monotony risk scorer (OPENMONTAGE-BORROW-PLAN #10).
 *
 * A video can pass motion-ratio (#9) yet still feel like a slideshow because
 * everything is treated the SAME. This scores structural monotony over the
 * assembled plan. Pure, deterministic, no ffmpeg/AI. ADVISORY (never re-plans).
 *
 * IMPORTANT — what NOT to score: this app applies ONE effect grade and mostly
 * fullscreen framing to every scene BY DESIGN (one era/grade per video; footage
 * is fullscreen). Scoring "same effects" or "all fullscreen" would false-alarm
 * on every build. We only score things that are SUPPOSED to vary:
 *   - long runs of consecutive still images (the actual "slideshow" stretch)
 *   - too-high fraction of fullscreen graphic/template cards vs footage
 *   - over-reliance on a single overlay-MG type
 *   - long runs of the identical NON-cut transition (cut is the intended backbone)
 *   - marketing-fluff words in search KEYWORDS (not narration — that's the user's script)
 */
'use strict';

let classifyScene = null;
try { ({ classifyScene } = require('../util/promise')); } catch (_) { /* optional */ }

const IMAGE_RE = /\.(png|jpe?g|webp|gif|avif)$/i;
const FLUFF = [
    'sleek', 'cutting-edge', 'cutting edge', 'game-changing', 'game changer', 'next-level',
    'state-of-the-art', 'revolutionary', 'seamless', 'world-class', 'best-in-class',
    'unleash', 'supercharge', 'paradigm shift', 'synergy', 'disruptive', 'bleeding-edge',
];

const isStill = (s) => (s.mediaType === 'image') || IMAGE_RE.test(String(s.mediaExtension || s.mediaFile || ''));
const isCard = (s) => !!(s.templateType || s.fullscreenMG || s.isTemplate);
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

function scoreSlideshowRisk(plan) {
    const findings = [];
    const metrics = {};
    let score = 0;
    const scenes = (plan && Array.isArray(plan.scenes)) ? plan.scenes : [];
    const base = scenes
        .filter((s) => s && (!s.trackId || s.trackId === 'video-track-1'))
        .slice()
        .sort((a, b) => num(a.startTime) - num(b.startTime));
    const mgs = (plan && Array.isArray(plan.motionGraphics)) ? plan.motionGraphics : [];

    if (base.length < 6) return { score: 0, level: 'ok', findings, metrics: { scenes: base.length, note: 'too short to score' } };

    // (1) longest run of consecutive still images with no icon/MG activity
    const mgSceneIdx = new Set(mgs.map((m) => num(m.sceneIndex, -1)));
    let run = 0, longestStillRun = 0;
    for (const s of base) {
        const activity = (Array.isArray(s._iconMoments) && s._iconMoments.length) || mgSceneIdx.has(num(s.index, -2));
        if (isStill(s) && !isCard(s) && !activity) { run++; longestStillRun = Math.max(longestStillRun, run); }
        else run = 0;
    }
    metrics.longestStillRun = longestStillRun;
    if (longestStillRun >= 6) {
        score += longestStillRun >= 10 ? 2 : 1;
        findings.push({ severity: longestStillRun >= 10 ? 'fail' : 'warn', code: 'still_run',
            message: `${longestStillRun} still images play back-to-back with no motion graphic or icon — a slideshow stretch. Break it up with footage, an icon, or a card.` });
    }

    // (2) fullscreen graphic/template card fraction (the "inverted editing" problem)
    const cards = base.filter(isCard).length;
    const cardFrac = base.length ? cards / base.length : 0;
    metrics.cardFraction = Math.round(cardFrac * 1000) / 1000;
    if (cardFrac > 0.5) {
        score += cardFrac > 0.65 ? 2 : 1;
        findings.push({ severity: cardFrac > 0.65 ? 'fail' : 'warn', code: 'card_heavy',
            message: `${(cardFrac * 100).toFixed(0)}% of scenes are fullscreen graphic/template cards — footage should be the backbone, cards should earn their slots.` });
    }

    // (3) over-reliance on a single overlay-MG type
    if (mgs.length >= 5) {
        const byType = {};
        for (const m of mgs) { const t = String(m.type || 'unknown'); byType[t] = (byType[t] || 0) + 1; }
        const [topType, topCount] = Object.entries(byType).sort((a, b) => b[1] - a[1])[0];
        const frac = topCount / mgs.length;
        metrics.dominantMg = { type: topType, fraction: Math.round(frac * 1000) / 1000 };
        if (frac > 0.6) {
            score += 1;
            findings.push({ severity: 'warn', code: 'mg_type_dominant',
                message: `${(frac * 100).toFixed(0)}% of motion graphics are "${topType}" (${topCount}/${mgs.length}) — vary the overlay vocabulary.` });
        }
    }

    // (4) longest run of the identical NON-cut transition (cut is the intended default)
    let tRun = 0, tPrev = null, longestTxRun = 0, txRunType = null;
    for (const s of base) {
        const t = s.transition && s.transition.type;
        if (t && t !== 'cut' && t === tPrev) { tRun++; if (tRun > longestTxRun) { longestTxRun = tRun; txRunType = t; } }
        else tRun = (t && t !== 'cut') ? 1 : 0;
        tPrev = t;
    }
    metrics.longestNonCutTransitionRun = longestTxRun;
    if (longestTxRun >= 4) {
        score += 1;
        findings.push({ severity: 'warn', code: 'transition_repeat',
            message: `The "${txRunType}" transition repeats ${longestTxRun + 1}× in a row — repetitive; let transitions be motivated per boundary.` });
    }

    // (5) marketing-fluff words in search keywords (NOT narration/captions)
    const fluffHits = new Set();
    for (const s of base) {
        const hay = [s.keyword, s.stockQuery, s.webQuery, s.searchKeyword].filter(Boolean).join(' ').toLowerCase();
        for (const f of FLUFF) if (hay.includes(f)) fluffHits.add(f);
    }
    if (fluffHits.size) {
        metrics.fluffWords = [...fluffHits];
        findings.push({ severity: 'warn', code: 'fluff_keywords',
            message: `Generic marketing words in footage queries (${[...fluffHits].join(', ')}) — these return stocky, on-the-nose results; describe what the CAMERA sees instead.` });
    }

    const level = score >= 4 ? 'high' : (score >= 2 ? 'elevated' : 'ok');
    metrics.riskScore = score;
    return { score, level, findings, metrics };
}

module.exports = { scoreSlideshowRisk };
