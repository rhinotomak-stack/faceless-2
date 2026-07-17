/**
 * Editor Agent — global framing strategy.
 *
 * This is intentionally a build-level editorial pass, not a rule table. The
 * old per-scene framing worker saw every scene in isolation and overused
 * floating cards because each individual clip could be justified that way.
 * This pass gives the system rhythm: it decides which scenes actually deserve
 * special framing before any expensive per-frame vision call is made.
 */

const { callAI } = require('../../brain/ai-provider');
let renderDirectivesBlock = () => '';
try { ({ renderDirectivesBlock } = require('../../directives/directive-compiler')); } catch (_) { /* optional */ }

function _clean(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function _short(value, n = 140) {
    const text = _clean(value);
    return text.length > n ? `${text.slice(0, n - 1)}...` : text;
}

function _ratio(scene) {
    const w = Number(scene?.mediaWidth || 0);
    const h = Number(scene?.mediaHeight || 0);
    return w > 0 && h > 0 ? Math.round((w / h) * 100) / 100 : null;
}

function _duration(scene) {
    const d = (Number(scene?.endTime) || 0) - (Number(scene?.startTime) || 0);
    return Number.isFinite(d) ? Math.round(d * 10) / 10 : 0;
}

function _clipSummary(scene) {
    const a = scene?._clipAnalysis || scene?.clipAnalysis || null;
    if (!a) return '';
    const issues = Array.isArray(a.issues) ? a.issues.slice(0, 3).join(', ') : '';
    return _short([
        a.description ? `desc=${a.description}` : '',
        a.motion ? `motion=${a.motion}` : '',
        issues ? `issues=${issues}` : '',
    ].filter(Boolean).join(' | '), 180);
}

function _sceneRow(scene) {
    return {
        index: scene.index ?? null,
        dur: _duration(scene),
        source: scene.sourceHint || scene.source || null,
        media: scene.mediaType || null,
        aspect: _ratio(scene),
        score: Number(scene.visionScore || scene?._clipAnalysis?.score || scene?.clipAnalysis?.score || 0) || null,
        role: scene.role || scene._sceneClass || null,
        hasMG: !!scene.mgHint,
        fullscreenMG: !!scene.fullscreenMG,
        template: !!(scene.template || scene._template || scene.templateHint || scene.need === 'template-only'),
        currentFraming: scene.framing || null,
        visual: _short(scene.visualIntent || scene.searchKeyword || scene.keyword || '', 120),
        text: _short(scene.text || scene.transcript || '', 120),
        clip: _clipSummary(scene),
    };
}

function _safeJSON(text) {
    try {
        const match = String(text || '').match(/\{[\s\S]*\}/);
        return match ? JSON.parse(match[0]) : null;
    } catch (_) {
        return null;
    }
}

function _normalizeAction(value) {
    const v = String(value || '').toLowerCase().trim();
    if (['vision-review', 'review', 'inspect', 'ai', 'vision'].includes(v)) return 'vision-review';
    if (['force', 'set', 'lock'].includes(v)) return 'force';
    return 'default';
}

function _normalizeFraming(value) {
    const v = String(value || '').toLowerCase().trim();
    return ['fullscreen', 'cinematic', 'floating'].includes(v) ? v : '';
}

function _fallbackStrategy(scenes, reason) {
    return {
        styleIntent: 'Use existing planner framing and avoid restyling the build when strategy planning is unavailable.',
        reason,
        defaultFraming: 'fullscreen',
        scenes: (scenes || [])
            .filter(s => s?.mediaFile && !s.fullscreenMG)
            .map(s => ({
                index: s.index,
                action: 'default',
                framing: _normalizeFraming(s.framing) || 'fullscreen',
                reason: 'strategy fallback',
            })),
    };
}

function _normalizeStrategy(raw, scenes) {
    const parsed = raw && typeof raw === 'object' ? raw : {};
    const knownIndexes = new Set((scenes || []).map(s => Number(s?.index)).filter(Number.isFinite));
    const out = {
        styleIntent: _short(parsed.styleIntent || parsed.intent || '', 260),
        defaultFraming: _normalizeFraming(parsed.defaultFraming) || 'fullscreen',
        scenes: [],
    };
    const rows = Array.isArray(parsed.scenes) ? parsed.scenes : [];
    for (const row of rows) {
        const index = Number(row?.index);
        if (!Number.isFinite(index) || !knownIndexes.has(index)) continue;
        const action = _normalizeAction(row?.action);
        const framing = _normalizeFraming(row?.framing) || (action === 'vision-review' ? '' : out.defaultFraming);
        out.scenes.push({
            index,
            action,
            framing,
            background: _clean(row?.background || ''),
            reason: _short(row?.reason || '', 180),
        });
    }
    return out;
}

function _strategyPrompt(rows, scriptContext) {
    return `You are the global framing strategist for a documentary edit.

Your job is NOT to frame every clip. Your job is to create rhythm for the whole video before the per-scene vision worker runs.

Think like an editor:
- Most strong real footage should stay fullscreen so the video feels active and not like a slideshow.
- Use cinematic/floating only when it is editorially valuable for this scene in the larger sequence.
- Send a scene to "vision-review" only when the actual frame composition must be inspected before deciding.
- If a scene already has templates/MGs/overlays, avoid changing the media into a tiny card unless there is a strong reason.
- Do not use fixed quotas. Decide from the content, pacing, footage quality, and scene roles.
- You do not need to list every scene. Omitted scenes inherit defaultFraming.
${renderDirectivesBlock(scriptContext?._directives, 'framing')}
VIDEO CONTEXT:
${JSON.stringify({
        niche: scriptContext?.nicheId || scriptContext?.niche || null,
        theme: scriptContext?.themeId || scriptContext?.theme || null,
        tone: scriptContext?.tone || null,
        pacing: scriptContext?.pacing || null,
        summary: _short(scriptContext?.summary || scriptContext?.videoTopic || '', 500),
    }, null, 2)}

SCENES:
${JSON.stringify(rows, null, 2)}

Return strict JSON only:
{
  "styleIntent": "one sentence describing the framing rhythm",
  "defaultFraming": "fullscreen" | "cinematic" | "floating",
  "scenes": [
    {
      "index": 0,
      "action": "default" | "force" | "vision-review",
      "framing": "fullscreen" | "cinematic" | "floating" | "",
      "background": "none" | "blur" | "soft-beige" | "soft-gray" | "soft-navy" | "gradient:dark" | "gradient:warm" | "",
      "reason": "short editorial reason"
    }
  ],
  "_note": "scenes may contain only exceptions/review picks; omitted scenes use defaultFraming"
}`;
}

async function planFramingStrategy(scenes, scriptContext = {}, opts = {}) {
    const editable = (Array.isArray(scenes) ? scenes : []).filter(s => s?.mediaFile && !s.fullscreenMG);
    if (!editable.length) return _fallbackStrategy(scenes, 'no editable media scenes');

    // Creator authority: an explicit framing directive forces the whole video to
    // one framing deterministically — no AI call, no per-scene variance.
    const _force = scriptContext?._directives?.framing?.force;
    if (_force && ['fullscreen', 'cinematic', 'floating'].includes(_force)) {
        return {
            styleIntent: `Creator directive: every scene framed ${_force}.`,
            reason: 'creator framing directive',
            defaultFraming: _force,
            scenes: editable.map(s => ({ index: s.index, action: 'force', framing: _force, reason: 'creator directive' })),
        };
    }

    const rows = editable.map(_sceneRow);
    const prompt = _strategyPrompt(rows, scriptContext);
    try {
        const raw = await callAI(prompt, {
            taskType: 'planner-small',
            maxTokens: Math.max(1200, Math.min(5000, Number(opts.maxTokens || process.env.EDITOR_AGENT_FRAMING_STRATEGY_MAX_TOKENS || 3600) || 3600)),
        });
        const parsed = _safeJSON(raw);
        if (!parsed) throw new Error('unparseable framing strategy JSON');
        return _lockFraming(_normalizeStrategy(parsed, scenes), scenes);
    } catch (err) {
        return _lockFraming(_fallbackStrategy(scenes, `strategy AI failed: ${err.message}`), scenes);
    }
}

// Per-scene directive lock: any scene whose framing the creator set via a
// per-scene/time directive (scene._directiveLock includes 'framing') is FORCED
// to that framing, overriding the strategist. (Global force is handled above.)
function _lockFraming(strategy, scenes) {
    const locked = (Array.isArray(scenes) ? scenes : []).filter(s => Array.isArray(s?._directiveLock) && s._directiveLock.includes('framing') && s.framing);
    if (!locked.length || !strategy) return strategy;
    const byIndex = new Map((strategy.scenes || []).map(r => [Number(r.index), r]));
    for (const s of locked) {
        byIndex.set(Number(s.index), { index: s.index, action: 'force', framing: s.framing, reason: 'creator per-scene directive' });
    }
    strategy.scenes = [...byIndex.values()];
    return strategy;
}

function strategyMap(strategy) {
    const map = new Map();
    for (const row of strategy?.scenes || []) {
        map.set(Number(row.index), row);
    }
    return map;
}

module.exports = {
    planFramingStrategy,
    strategyMap,
};
