/**
 * Transition Director Worker
 *
 * The agentic half of the transition system: ONE batch reasoning call that
 * reads the video's full visual sequence (footage scenes AND the templates/
 * maps/fullscreen graphics between them) and assigns a motivated transition
 * to every footage boundary from the bridge's canonical vocabulary. The agent
 * reasons editorially ("location jump → whip-pan", "energy spike → zoom
 * punch", "chapter break → dip to black"); the bridge runtime renders the
 * choreography with hand-tuned GSAP — the agent never writes animation code.
 *
 * Output lands on scene.transition = { type, duration } — the exact contract
 * the algorithmic assignTransitions pass writes — so the HF bridge, UI chips
 * and FFmpeg renderer all consume it unchanged. The algorithmic pass remains
 * the graceful-degradation floor: the director only OVERRIDES on success.
 *
 * Flag: HF_TRANSITION_DIRECTOR=0 disables. Cost: 1 AI call per build,
 * disk-cached (.hf-tx-cache.json) like the FX director.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { callAI } = require('../../brain/ai-provider');
let renderDirectivesBlock = () => '';
try { ({ renderDirectivesBlock } = require('../../directives/directive-compiler')); } catch (_) { /* optional */ }

// Must mirror MOTION_TRANSITION_TYPES + OVERLAY_TRANSITION_TYPES in
// hyperframes-bridge.js — the runtime implements exactly these.
const TRANSITION_VOCAB = [
    'cut', 'crossfade', 'blur-dissolve',
    'push-left', 'push-right', 'push-up',
    'wipe-left', 'wipe-right', 'wipe-up',
    'whip-left', 'whip-right',
    'zoom-punch', 'zoom-pull', 'spin-settle',
    'flash-white', 'dip-black', 'light-sweep', 'glitch',
    'fire-burn', 'lens-flare',
];

function isDisabled() {
    return /^(0|false|off|no)$/i.test(String(process.env.HF_TRANSITION_DIRECTOR || '').trim());
}

function toSec(v, d = 0) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/** Ordered list of everything the viewer SEES, footage and graphics alike. */
function visualUnits(plan) {
    const units = [];
    for (const s of (plan.scenes || [])) {
        if (!s || s.disabled || s.isMGScene || !s.mediaFile) continue;
        units.push({
            kind: 'footage', sceneIndex: s.index,
            start: toSec(s.startTime), end: toSec(s.endTime),
            text: String(s.text || '').replace(/\s+/g, ' ').slice(0, 100),
            framing: s.framing || 'fullscreen',
            isImage: /\.(jpe?g|png|webp|gif)$/i.test(String(s.mediaFile || '')),
            sceneClass: s.sceneClass || '',
        });
    }
    const pushGraphic = (mg, kind) => {
        if (!mg || mg.disabled) return;
        units.push({
            kind, type: String(mg.type || mg.templateType || kind),
            start: toSec(mg.startTime), end: toSec(mg.endTime),
            text: String(mg.templateText || mg.text || '').replace(/\s+/g, ' ').slice(0, 80),
        });
    };
    (plan.templateScenes || []).forEach(mg => pushGraphic(mg, 'template'));
    (plan.mgScenes || []).forEach(mg => pushGraphic(mg, String(mg.type || '').toLowerCase().includes('map') ? 'map' : 'graphic'));
    return units.sort((a, b) => a.start - b.start);
}

function buildPrompt(units, boundaries, themeId, nicheId, pacing, directives) {
    const directivesBlock = renderDirectivesBlock(directives, 'transitions');
    const seq = units.map((u, i) => u.kind === 'footage'
        ? `  ${i}. [FOOTAGE #${u.sceneIndex} ${u.start.toFixed(1)}-${u.end.toFixed(1)}s, ${u.isImage ? 'still' : 'video'}, ${u.framing}${u.sceneClass ? ', ' + u.sceneClass : ''}] "${u.text}"`
        : `  ${i}. [${u.kind.toUpperCase()} ${u.start.toFixed(1)}-${u.end.toFixed(1)}s ${u.type}] "${u.text}"`
    ).join('\n');
    const bLines = boundaries.map(b =>
        `  B${b.sceneIndex}: ${b.prev ? `after ${b.prev.kind}${b.prev.kind === 'footage' ? '' : ` (${b.prev.type})`} "${(b.prev.text || '').slice(0, 60)}"` : 'video opening'} → footage "${b.unit.text}"${b.adjacentFootage ? '' : ' [no adjacent outgoing footage — incoming-only motion]'}`
    ).join('\n');
    return `You are the cut/transition editor for a faceless YouTube video (theme "${themeId}", niche "${nicheId}", pacing "${pacing}").
You see the FULL visual sequence, then decide the transition INTO each footage scene listed under BOUNDARIES.

VISUAL SEQUENCE:
${seq}

TRANSITION VOCABULARY (use these exactly — the renderer implements EVERY one of these):
cut | crossfade | blur-dissolve | push-left | push-right | push-up | wipe-left | wipe-right | wipe-up | whip-left | whip-right | zoom-punch | zoom-pull | spin-settle | flash-white | dip-black | light-sweep | fire-burn | lens-flare | glitch

EDITORIAL RULES (how a human editor cuts):
- CUT is the default and the backbone. A visible transition must be EARNED by the story — aim for visible transitions on ~30-40% of boundaries.
- Location/place jump in the narration → whip-left/whip-right or a push (movement says "we traveled").
- Time jump, flashback, "meanwhile" → blur-dissolve or crossfade (soft = time passing).
- Energy spike, shock stat, reveal → zoom-punch (rare: flash-white, max 1-2 per video, only on bright/loud beats).
- Returning to footage after a graphics/map block → zoom-pull or blur-dissolve (let the video breathe).
- Hard chapter/act break → dip-black (max 1-2 per video).
- Warm/emotional pivot, nostalgic or "golden" beat → light-sweep (hot warm-glow flare).
- Intense/dramatic beat — danger, heat, destruction, a hard emotional gut-punch, or a fierce reveal (crime/history/dramatic) → fire-burn (a fiery film-burn flare; sparingly, max 1-3).
- Sleek high-energy tech/modern pivot, product reveal, or a snappy "wow" beat → lens-flare (anamorphic light streak; sparingly, max 1-3).
- glitch only for tech/digital/hacking/corruption content.
- COVERAGE: you may use ANY move above — match the move to the beat AND the theme. Do NOT collapse the whole video to just cut + one move; a well-cut video draws from its full appropriate palette. But still keep a coherent SIGNATURE (2-4 core moves reused) with the rarer accents (flash/dip/fire/lens) used only on the beats that earn them.
- Pick a SIGNATURE SET: 2-4 transition types that fit this video's theme and reuse them consistently — a video that samples every transition looks amateur. Keep push/whip directions consistent (one travel direction per video).
- duration by TYPE (a whip must SNAP, a dissolve must BREATHE — never one flat number): whip 0.25-0.4 | lens-flare 0.25-0.4 | zoom-punch 0.3-0.45 | flash-white/light-sweep 0.3-0.45 | push/wipe 0.4-0.6 | spin-settle 0.4-0.6 | fire-burn 0.4-0.6 | zoom-pull 0.45-0.6 | crossfade/blur-dissolve 0.5-0.7 | dip-black 0.6-0.8. Nudge shorter for fast pacing, longer for calm.

${directivesBlock}
BOUNDARIES TO DECIDE:
${bLines}

Respond with ONLY a JSON object mapping boundary id to decision:
{"B3":{"t":"cut"},"B5":{"t":"whip-left","d":0.45,"why":"Persian Gulf → Red Sea location jump"}, ...}`;
}

function parseDecisions(text) {
    if (!text) return null;
    const t = String(text).replace(/```(?:json)?/gi, '').trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(t.slice(start, end + 1)); } catch (_) { return null; }
}

/**
 * Assign transitions for every footage boundary (mutates scene.transition).
 * Returns { decided, cached?, failed? }.
 */
async function directTransitions(plan, opts = {}) {
    if (!plan || isDisabled()) return { decided: 0, skipped: true };
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    const units = visualUnits(plan);
    const footage = units.filter(u => u.kind === 'footage');
    if (footage.length < 2 && units.length < 3) return { decided: 0 };

    const sceneByIndex = new Map((plan.scenes || []).filter(s => s && !s.isMGScene).map(s => [s.index, s]));

    // Boundaries: every footage unit that doesn't open the video.
    const boundaries = [];
    units.forEach((u, i) => {
        if (u.kind !== 'footage' || u.start <= 0.05) return;
        const prev = i > 0 ? units[i - 1] : null;
        boundaries.push({
            sceneIndex: u.sceneIndex, unit: u, prev,
            adjacentFootage: Boolean(prev && prev.kind === 'footage' && Math.abs(prev.end - u.start) < 0.35),
        });
    });
    if (!boundaries.length) return { decided: 0 };

    // Saved-project reuse: every boundary already carries a directed
    // transition from the save → opens cost nothing.
    if (boundaries.every(b => sceneByIndex.get(b.sceneIndex)?._txDirected)) {
        log(`  ✂️ [Transition Director] ${boundaries.length} boundaries reused from the saved project (0 AI calls)`);
        return { decided: boundaries.length, cached: true };
    }

    const txHash = crypto.createHash('sha1')
        .update(JSON.stringify(units.map(u => [u.kind, u.start.toFixed(1), (u.text || '').slice(0, 60)])))
        .digest('hex').slice(0, 16);
    const cachePath = opts.projectDir ? path.join(opts.projectDir, '.hf-tx-cache.json') : null;
    // Per-type duration bands [min, max, default] — a whip that renders at the
    // flat 0.5s reads as a sluggish blur-drift; a dissolve at 0.35s barely
    // registers. Clamp each decision into the band for its type so the motion
    // has the right snap/breath even when the model returns a generic number.
    const TX_BANDS = {
        'cut': [0, 0, 0],
        'whip-left': [0.25, 0.4, 0.32], 'whip-right': [0.25, 0.4, 0.32],
        'zoom-punch': [0.3, 0.45, 0.4], 'flash-white': [0.3, 0.45, 0.38], 'light-sweep': [0.3, 0.45, 0.4],
        'push-left': [0.4, 0.6, 0.5], 'push-right': [0.4, 0.6, 0.5], 'push-up': [0.4, 0.6, 0.5],
        'wipe-left': [0.4, 0.6, 0.5], 'wipe-right': [0.4, 0.6, 0.5], 'wipe-up': [0.4, 0.6, 0.5],
        'spin-settle': [0.4, 0.6, 0.5], 'zoom-pull': [0.45, 0.6, 0.5],
        'fire-burn': [0.4, 0.6, 0.5], 'lens-flare': [0.25, 0.4, 0.32],
        'crossfade': [0.5, 0.7, 0.6], 'blur-dissolve': [0.5, 0.7, 0.6], 'dip-black': [0.6, 0.8, 0.7], 'glitch': [0.3, 0.5, 0.4],
    };
    // Normalize near-miss type names (model sometimes returns "whip"/"push"/
    // "zoom"/"dissolve" without the canonical suffix) so a good decision isn't
    // silently dropped back to the algorithmic floor.
    const normalizeTxType = (t) => {
        const raw = String(t || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
        if (TRANSITION_VOCAB.includes(raw)) return raw;
        const dir = raw.includes('right') ? 'right' : (raw.includes('up') || raw.includes('down')) ? 'up' : 'left';
        if (raw.includes('whip')) return `whip-${dir === 'up' ? 'left' : dir}`;
        if (raw.includes('wipe')) return `wipe-${dir}`;
        if (raw.includes('push') || raw.includes('pan') || raw.includes('slide')) return `push-${dir}`;
        if (raw.includes('zoom')) return (raw.includes('out') || raw.includes('pull')) ? 'zoom-pull' : 'zoom-punch';
        if (raw.includes('spin') || raw.includes('rotate')) return 'spin-settle';
        if (raw.includes('blur') || raw.includes('luma')) return 'blur-dissolve';
        if (raw.includes('glitch')) return 'glitch';
        if (raw.includes('flash') || raw.includes('white')) return 'flash-white';
        if (raw.includes('dip') || raw.includes('black')) return 'dip-black';
        if (raw.includes('lens') || raw.includes('anamorphic') || raw.includes('streak')) return 'lens-flare';
        if (raw.includes('fire') || raw.includes('flame') || raw.includes('burn') || raw.includes('ember')) return 'fire-burn';
        if (raw.includes('sweep') || raw.includes('leak') || raw.includes('light')) return 'light-sweep';
        if (raw.includes('fade') || raw.includes('cross') || raw.includes('dissolve')) return 'crossfade';
        if (raw.includes('cut') || raw.includes('hard') || raw === 'none') return 'cut';
        return raw;
    };
    const apply = (decisions) => {
        let applied = 0;
        for (const b of boundaries) {
            const d = decisions[`B${b.sceneIndex}`];
            if (d) d.t = normalizeTxType(d.t);
            if (!d || !TRANSITION_VOCAB.includes(d.t)) continue;
            const scene = sceneByIndex.get(b.sceneIndex);
            if (!scene) continue;
            if (Array.isArray(scene._directiveLock) && scene._directiveLock.includes('transition')) continue; // creator per-scene lock wins
            const band = TX_BANDS[d.t] || [0.3, 0.85, 0.5];
            const requested = Number(d.d);
            const dur = Number.isFinite(requested) ? Math.max(band[0], Math.min(band[1], requested)) : band[2];
            scene.transition = {
                type: d.t,
                duration: dur,
                ...(d.why ? { reason: String(d.why).slice(0, 120) } : {}),
            };
            scene._txDirected = true;
            applied++;
        }
        return applied;
    };

    // Creator authority: a "hard cuts only" directive forces every boundary to a
    // straight cut deterministically — no AI call, and it wins over any cache.
    const _txDir = (plan.scriptContext || {})._directives?.transitions || null;
    if (_txDir && _txDir.style === 'hard-cuts') {
        const decisions = {};
        for (const b of boundaries) {
            const s = sceneByIndex.get(b.sceneIndex);
            if (s && Array.isArray(s._directiveLock) && s._directiveLock.includes('transition')) continue; // a per-scene transition order beats global hard-cuts
            decisions[`B${b.sceneIndex}`] = { t: 'cut' };
        }
        const applied = apply(decisions);
        log(`  ✂️ [Transition Director] "hard cuts only" directive → ${applied} boundaries forced to cut (0 AI calls)`);
        return { decided: applied, directive: 'hard-cuts' };
    }

    if (cachePath && fs.existsSync(cachePath)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (cached && cached.hash === txHash && cached.decisions) {
                const applied = apply(cached.decisions);
                if (applied > 0) {
                    log(`  ✂️ [Transition Director] decisions loaded from cache (${applied} boundaries, 0 AI calls)`);
                    return { decided: applied, cached: true };
                }
            }
        } catch (_) { /* stale cache — fall through */ }
    }

    const sc = plan.scriptContext || {};
    let parsed = null;
    try {
        const text = await callAI(
            buildPrompt(units, boundaries, sc.themeId || plan.themeId || 'standard', sc.nicheId || '', sc.pacing || 'normal', sc._directives || null),
            { maxTokens: 2200, temperature: 0.4, taskType: 'brain' }
        );
        parsed = parseDecisions(text);
    } catch (e) {
        log(`  ⚠️ [Transition Director] AI call failed: ${String(e.message || e).slice(0, 110)} — keeping algorithmic transitions`);
        return { decided: 0, failed: true };
    }
    if (!parsed) {
        log('  ⚠️ [Transition Director] unparseable response — keeping algorithmic transitions');
        return { decided: 0, failed: true };
    }

    const decided = apply(parsed);
    if (cachePath && decided > 0) {
        try { fs.writeFileSync(cachePath, JSON.stringify({ hash: txHash, decisions: parsed })); } catch (_) { /* non-fatal */ }
    }
    const visible = boundaries.filter(b => sceneByIndex.get(b.sceneIndex)?._txDirected && sceneByIndex.get(b.sceneIndex)?.transition?.type !== 'cut').length;
    log(`  ✂️ [Transition Director] ${decided}/${boundaries.length} boundaries decided (${visible} visible transitions, 1 AI call)`);
    return { decided };
}

module.exports = { directTransitions, TRANSITION_VOCAB };
