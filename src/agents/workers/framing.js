/**
 * Framing Worker
 *
 * Decides how a downloaded clip is presented on the 1920×1080 canvas.
 *
 * Inputs (passed by the CEO):
 *   - sceneContext: rich JSON snapshot (see scene-context.js)
 *   - frame: { base64, mimeType } — 1 representative JPEG of the clip
 *   - ceoPlan (optional): directives from the CEO, e.g. forced framing
 *
 * Output:
 *   { framing, background, scale, posX, posY, borderRadius, shadow,
 *     floatingAnim, floatingAnimDuration, effects, reason }
 *
 * Decision philosophy (NOT ratio-only):
 *   The worker thinks like an editor. It looks at the actual frame to
 *   understand composition, considers what overlays will sit on top
 *   (mgHint, isFullscreenMG, template), looks at the narration pace,
 *   and avoids repeating the same framing as the neighbours.
 *
 * Ratio is ONLY used as a structural constraint:
 *   - Vertical (ratio < 0.7) → contain + blur (we physically cannot
 *     fullscreen a portrait clip on a 16:9 canvas without losing 40%
 *     of the frame). This is the only ratio-driven rule.
 *
 * For ratio ≥ 0.7, the AI sees the frame and decides.
 */

const { callVisionAI } = require('../../brain/ai-provider');

const FLOATING_ANIMS = ['slideRight', 'slideLeft', 'slideUp', 'fadeScale'];

function _num(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function _safeJSON(text) {
    try {
        const m = String(text || '').match(/\{[\s\S]*\}/);
        return m ? JSON.parse(m[0]) : null;
    } catch (_) {
        return null;
    }
}

function _validFraming(value) {
    const v = String(value || '').toLowerCase().trim();
    return ['fullscreen', 'cinematic', 'floating'].includes(v) ? v : '';
}

function _verticalFallback() {
    return {
        framing: 'fullscreen',
        fitMode: 'contain',
        background: 'blur',
        scale: 1,
        posX: 0,
        posY: 0,
        reason: 'vertical clip — contain with blur background',
    };
}

function _buildPrompt(sceneContext, strategy = null, globalStrategy = null) {
    const s = sceneContext.scene;
    const m = sceneContext.media;
    const c = sceneContext.clipAnalysis;
    const n = sceneContext.neighbours;
    const sc = sceneContext.script;

    const recentFraming = [n.prev?.framing, n.next?.framing].filter(Boolean).join(', ') || '(none)';
    const strategyBlock = (strategy || globalStrategy)
        ? [
            '',
            'GLOBAL FRAMING STRATEGY',
            `Build intent: ${globalStrategy?.styleIntent || globalStrategy?.reason || '(none)'}`,
            `Default framing for this build: ${globalStrategy?.defaultFraming || 'fullscreen'}`,
            `This scene directive: ${JSON.stringify(strategy || {}, null, 2)}`,
            '',
            'Refine the strategy with the actual frame; do not invent a new visual language from scratch.',
            'Use floating only when this specific frame clearly benefits from being carded on canvas.',
        ].join('\n')
        : '';

    return `You are the FRAMING editor for one scene of an automated documentary.

You see ONE representative frame from the actual clip. Decide how this clip should be presented on a 1920×1080 (16:9) canvas.

═══ SCENE ═══
Index: ${s.index} (${s.startTime} → ${s.endTime}, ${s.duration})
Narration: "${s.text}"
Visual intent: ${s.visualIntent || '(none)'}
Role: ${s.role || '(unclassified)'}
Search keyword: ${s.searchKeyword}
Existing framing hint from upstream planner: ${s.framingHint || '(none)'}
MG hint: ${s.mgHint || '(none)'}
Fullscreen MG covers entire scene: ${s.isFullscreenMG ? 'YES' : 'no'}

═══ THE CLIP (you see one frame above) ═══
Dimensions: ${m.width}×${m.height} (aspect ${m.aspectRatio})
Vision score: ${m.visionScore || 'n/a'}/10
${c ? `Description (multi-frame analysis): "${c.description}" | motion: ${c.motion} | issues: ${c.issues.join(', ') || 'none'}` : ''}

═══ VIDEO CONTEXT ═══
Niche: ${sc.niche || 'unknown'}
Theme: ${sc.theme || 'unknown'}
Pacing: ${sc.pacing || 'moderate'}
Tone: ${sc.tone || 'neutral'}
Summary: "${sc.summary}"
${strategyBlock}

═══ NEIGHBOURING SCENES ═══
Recent framing choices: ${recentFraming}
${n.prev ? `Previous: framing=${n.prev.framing || 'fullscreen'}, background=${n.prev.background || 'none'}` : ''}
${n.next ? `Next: framing=${n.next.framing || 'fullscreen'}, background=${n.next.background || 'none'}` : ''}

═══ FRAMING OPTIONS ═══
- "fullscreen": clip fills the entire 1920×1080. Use for strong clips that ARE the moment.
- "cinematic": clip pulled back to 0.75–1.0 scale with a backdrop. Use for wide clips that need breathing room.
- "floating": clip at 0.45–0.55 scale, rounded corners + shadow + slide animation, backdrop visible around it. Use for borderline clips, calm exposition, or when you want a "card on canvas" rhythm.

═══ BACKGROUND OPTIONS ═══
- "blur": blurred copy of the clip itself (default for cinematic/floating).
- "soft-beige" / "soft-gray" / "soft-navy": flat tinted backgrounds (suit explainer/calm scenes).
- "gradient:dark" / "gradient:warm": gradient backdrops.
- "none": only valid for fullscreen.

═══ FLOATING ANIMATIONS (only if framing=floating) ═══
- "slideRight" / "slideLeft" / "slideUp" / "fadeScale"

═══ DECISION RULES (think like an editor, NOT a ratio dispatcher) ═══
1. If the frame shows the subject clearly centered and filling space → fullscreen wins.
2. If the frame is busy, off-center, or has lots of negative space → floating frames the eye on the clip.
3. If a fullscreen MG sits over this scene → fullscreen (the MG covers everything; framing is moot but fullscreen is cleanest).
4. If pacing is "fast" → prefer fullscreen for energy. If "slow"/"moderate" → floating cards are fine.
5. If recent framing was the SAME for 2+ scenes in a row → switch it up for rhythm.
6. Aspect ratio is NOT a decision input here — you are looking at the actual frame.

═══ OUTPUT (strict JSON, no prose) ═══
{
  "framing": "fullscreen" | "cinematic" | "floating",
  "background": "blur" | "soft-beige" | "soft-gray" | "soft-navy" | "gradient:dark" | "gradient:warm" | "none",
  "floatingAnim": "slideRight" | "slideLeft" | "slideUp" | "fadeScale" | null,
  "scale": number 0.45-1.0,
  "reason": "one short sentence explaining the choice"
}`;
}

function _applyCanonicalDefaults(decision, sceneContext) {
    const m = sceneContext.media;
    const ratio = Number(m.aspectRatio) || 0;
    const out = {
        framing: 'fullscreen',
        fitMode: 'cover',
        background: 'none',
        scale: 1,
        posX: 0,
        posY: 0,
        borderRadius: 0,
        shadow: 0,
        floatingAnim: null,
        floatingAnimDuration: null,
        effects: [],
        reason: '',
    };
    const framing = String(decision?.framing || '').toLowerCase();
    if (framing === 'floating') {
        // Compute floating scale from frame ratio (0.45–0.55 range)
        const targetRatio = 1920 / 1080;
        const fillFactor = Math.min(1, Math.max(0, (ratio - 1.0) / (targetRatio - 1.0)));
        const aiScale = _num(decision?.scale, 0);
        const floatingScale = aiScale >= 0.4 && aiScale <= 0.6
            ? aiScale
            : Math.round((0.45 + fillFactor * 0.10) * 100) / 100;
        out.framing = 'floating';
        out.fitMode = 'cover';
        out.scale = floatingScale;
        out.background = String(decision?.background || '').trim() || 'blur';
        out.borderRadius = 4;
        out.shadow = 0.5;
        const anim = String(decision?.floatingAnim || '').trim();
        out.floatingAnim = FLOATING_ANIMS.includes(anim) ? anim : 'slideRight';
        // Animation duration shaped by pacing + scene duration (matches legacy)
        const pacing = sceneContext.script?.pacing || 'moderate';
        const pacingBase = pacing === 'fast' ? 0.3 : pacing === 'slow' ? 0.7 : 0.5;
        const dur = parseFloat(sceneContext.scene?.duration) || 0;
        const adjust = dur < 4 ? -0.1 : dur > 7 ? 0.15 : 0;
        out.floatingAnimDuration = Math.round((pacingBase + adjust) * 100) / 100;
    } else if (framing === 'cinematic') {
        const targetRatio = 1920 / 1080;
        const fillFactor = Math.min(1, Math.max(0, (ratio - 1.0) / (targetRatio - 1.0)));
        const aiScale = _num(decision?.scale, 0);
        const cinematicScale = aiScale >= 0.7 && aiScale <= 1.0
            ? aiScale
            : Math.round((0.75 + fillFactor * 0.25) * 100) / 100;
        out.framing = 'cinematic';
        out.fitMode = 'cover';
        out.scale = cinematicScale;
        out.background = String(decision?.background || '').trim() || 'blur';
    } else {
        out.framing = 'fullscreen';
        out.fitMode = 'cover';
        out.scale = 1;
        out.background = String(decision?.background || 'none').trim();
        // "none" + fullscreen is the canonical default
        if (out.background === 'blur' || out.background === 'none') out.background = 'none';
    }
    out.reason = String(decision?.reason || '').slice(0, 200);
    return out;
}

async function decideFraming(sceneContext, frame, opts = {}) {
    if (!sceneContext) return null;
    const strategy = opts.strategy || {};
    const globalStrategy = opts.globalStrategy || {};
    const strategyFraming = _validFraming(strategy.framing) || _validFraming(globalStrategy.defaultFraming) || _validFraming(sceneContext.scene?.framingHint) || 'fullscreen';
    const strategyDecision = {
        framing: strategyFraming,
        background: strategy.background || (strategyFraming === 'fullscreen' ? 'none' : 'blur'),
        scale: strategy.scale,
        floatingAnim: strategy.floatingAnim || null,
        reason: strategy.reason ? `strategy: ${strategy.reason}` : 'global framing strategy',
    };
    const ratio = Number(sceneContext.media?.aspectRatio) || 0;
    // Hard structural rule: vertical (ratio < 0.7) cannot fullscreen on 16:9.
    // The Editor Agent doesn't decide here — it's a canvas constraint.
    if (ratio > 0 && ratio < 0.7) {
        return _verticalFallback();
    }

    if (opts.noVision || strategy.action === 'force' || strategy.action === 'default') {
        return _applyCanonicalDefaults(strategyDecision, sceneContext);
    }

    if (!frame?.base64 || !frame?.mimeType) {
        // No frame to look at — default fullscreen (the CEO will log this).
        return _applyCanonicalDefaults({ ...strategyDecision, reason: 'no frame available; used strategy framing' }, sceneContext);
    }

    const prompt = _buildPrompt(sceneContext, strategy, globalStrategy);
    let raw = '';
    try {
        raw = await callVisionAI(prompt, frame.base64, frame.mimeType);
    } catch (e) {
        const reason = `vision call failed: ${e?.message?.slice(0, 120) || 'unknown'}`;
        return _applyCanonicalDefaults({ ...strategyDecision, reason }, sceneContext);
    }

    const parsed = _safeJSON(raw);
    if (!parsed) {
        return _applyCanonicalDefaults({ ...strategyDecision, reason: 'unparseable AI response; used strategy framing' }, sceneContext);
    }
    return _applyCanonicalDefaults(parsed, sceneContext);
}

// ── Multi-frame focus smoothing (OPENMONTAGE-BORROW-PLAN #16) ──────────────
// Pure, deterministic. Turns a subject-focus trajectory (per-frame focus points
// across a clip) into a LOCK (static focus) or a gentle PAN (animated crop).
const _clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0));

function _movingAverage(values, window = 3) {
    if (!Array.isArray(values) || values.length <= 2) return values.slice();
    const half = Math.floor(window / 2);
    return values.map((_, i) => {
        let sum = 0, n = 0;
        for (let k = i - half; k <= i + half; k++) { if (k >= 0 && k < values.length) { sum += values[k]; n++; } }
        return n ? sum / n : values[i];
    });
}

/**
 * @param {Array<{focusX:number,focusY:number,ok:boolean}>} samples time-ordered
 * @returns {{mode:'lock',focusX,focusY}|{mode:'pan',fromX,fromY,toX,toY}|null}
 *   null → caller falls back to the single-frame anchor (unchanged behavior).
 */
function _focusTrajectoryDecision(samples, opts = {}) {
    const pts = (samples || []).filter((s) => s && s.ok).map((s) => ({ x: _clamp01(s.focusX), y: _clamp01(s.focusY) }));
    if (pts.length < 2) return null;
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
    const xRange = Math.max(...xs) - Math.min(...xs);
    const yRange = Math.max(...ys) - Math.min(...ys);
    const STILL = Number(opts.stillGate ?? 0.10);      // < this movement → subject held still → LOCK
    const DEAD = Number(opts.deadband ?? 0.04);        // tiny travel → not worth a pan
    const MAX_TRAVEL = Number(opts.maxTravel ?? 0.25); // clamp hallucinated whip-pans
    if (xRange < STILL && yRange < STILL) {
        return { mode: 'lock', focusX: +mean(xs).toFixed(3), focusY: +mean(ys).toFixed(3) };
    }
    const sx = _movingAverage(xs), sy = _movingAverage(ys);
    const fromX = _clamp01(sx[0]), fromY = _clamp01(sy[0]);
    const cap = (from, to) => { const d = to - from; return Math.abs(d) > MAX_TRAVEL ? from + Math.sign(d) * MAX_TRAVEL : to; };
    const toX = _clamp01(cap(fromX, _clamp01(sx[sx.length - 1])));
    const toY = _clamp01(cap(fromY, _clamp01(sy[sy.length - 1])));
    const travel = Math.hypot(toX - fromX, toY - fromY);
    if (travel < DEAD) {
        return { mode: 'lock', focusX: +mean(xs).toFixed(3), focusY: +mean(ys).toFixed(3) };
    }
    return { mode: 'pan', fromX: +fromX.toFixed(3), fromY: +fromY.toFixed(3), toX: +toX.toFixed(3), toY: +toY.toFixed(3) };
}

module.exports = { decideFraming, _movingAverage, _focusTrajectoryDecision };
