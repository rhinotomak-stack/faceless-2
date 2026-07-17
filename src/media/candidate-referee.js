/**
 * Candidate Referee
 *
 * Final AI editor pass over candidates that already passed download + vision.
 * This does not search or score raw media. It compares the shortlist using the
 * scene contract, prior vision descriptions, deep analysis, and metadata, then
 * picks the clip/image that best serves the edit.
 */

const { callAI } = require('../brain/ai-provider');

const DEFAULT_TIMEOUT_MS = Math.max(5_000, Math.min(45_000, parseInt(process.env.FOOTAGE_AI_REFEREE_TIMEOUT_MS || '18000', 10)));
const DEFAULT_MAX_CANDIDATES = Math.max(2, Math.min(10, parseInt(process.env.FOOTAGE_AI_REFEREE_MAX_CANDIDATES || '6', 10)));
const QUALITY_OVERRIDE_GAP = Math.max(40, Math.min(400, parseInt(process.env.FOOTAGE_AI_REFEREE_QUALITY_OVERRIDE_GAP || '120', 10) || 120));
const QUALITY_OVERRIDE_MIN_CONFIDENCE = Math.max(6, Math.min(10, parseInt(process.env.FOOTAGE_AI_REFEREE_QUALITY_OVERRIDE_MIN_CONFIDENCE || '8', 10) || 8));
const TEXT_TASK_FALLBACKS = ['utility', 'classifier', 'planner-small', 'general'];

function _short(value, max = 180) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function _num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

function _candidateTitle(value) {
    const c = value?._candidate || value?.candidate || value?.selected || {};
    return _short(
        c.title
        || c._cachedMeta?.title
        || c._meta?.title
        || value?.description
        || c.url
        || value?.path
        || '',
        160
    );
}

function _candidateUrl(value) {
    const c = value?._candidate || value?.candidate || value?.selected || {};
    return String(
        value?.dlUrl
        || c.url
        || c._cachedMeta?.url
        || c._meta?.url
        || c._directVideoUrl
        || c._fallbackUrl
        || ''
    ).trim();
}

function _quality(value) {
    const c = value?._candidate || value?.candidate || value?.selected || {};
    const baseScore = _num(value?.score);
    const postScore = _num(value?.postScore);
    const deepScore = _num(value?.deepScore || value?.clipAnalysis?.score);
    const finalistScore = _num(c?._candidateFinalistScore || value?.selected?._candidateFinalistScore);
    const mediaScoutScore = _num(c?._mediaScoutScore || value?.selected?._mediaScoutScore);
    const previewScore = _num(c?._previewScoutScore || value?.selected?._previewScoutScore);
    const thumbnailBonus = (c?._thumbnailVisionPassed === true || value?.selected?._thumbnailVisionPassed === true) ? 1 : 0;

    return (baseScore * 100)
        + (deepScore * 8)
        + (postScore * 5)
        + (finalistScore * 4)
        + (mediaScoutScore * 1.5)
        + (previewScore * 3)
        + (thumbnailBonus * 6);
}

function _buildPrompt(candidates, context = {}) {
    const scene = context.scene || {};
    const agent = context.mediaAgent || {};
    const hunter = context.mediaHunter || {};
    const contract = context.visualContract || {};
    const mustShow = []
        .concat(Array.isArray(agent.mustShow) ? agent.mustShow : [])
        .concat(Array.isArray(contract.mustShow) ? contract.mustShow : [])
        .filter(Boolean)
        .slice(0, 10)
        .join(', ') || '(none)';
    const mustAvoid = []
        .concat(Array.isArray(agent.mustAvoid) ? agent.mustAvoid : [])
        .concat(Array.isArray(contract.mustNotShow) ? contract.mustNotShow : [])
        .filter(Boolean)
        .slice(0, 10)
        .join(', ') || '(none)';

    const rows = candidates.map((candidate, idx) => {
        const clip = candidate.clipAnalysis || {};
        const selected = candidate.selected || candidate._candidate || {};
        const bits = [
            `C${idx + 1}`,
            `title="${_candidateTitle(candidate)}"`,
            `provider="${candidate.providerName || context.providerName || ''}"`,
            `quality=${_quality(candidate).toFixed(1)}`,
            `score=${_num(candidate.score)}/10`,
            `post=${_num(candidate.postScore)}/10`,
            candidate.deepScore != null ? `deep=${_num(candidate.deepScore)}/10` : '',
            selected._candidateFinalistScore != null ? `finalist=${_num(selected._candidateFinalistScore)}/10` : '',
            selected._mediaScoutScore != null ? `mediaScout=${_num(selected._mediaScoutScore)}` : '',
            selected._previewScoutScore != null ? `previewScout=${_num(selected._previewScoutScore)}/10` : '',
            selected.duration ? `duration=${Math.round(Number(selected.duration) || 0)}s` : '',
            selected.width && selected.height ? `size=${selected.width}x${selected.height}` : '',
            `vision="${_short(candidate.description || '', 260)}"`,
            clip.description ? `deepDesc="${_short(clip.description, 260)}"` : '',
            clip.motion ? `motion="${_short(clip.motion, 80)}"` : '',
            Array.isArray(clip.issues) && clip.issues.length ? `issues="${_short(clip.issues.join(', '), 160)}"` : '',
            selected._candidateFinalistReason ? `finalistReason="${_short(selected._candidateFinalistReason, 120)}"` : '',
            _candidateUrl(candidate) ? `url="${_short(_candidateUrl(candidate), 180)}"` : '',
        ].filter(Boolean);
        return bits.join(' | ');
    }).join('\n');

    return `You are the final media referee for an automated documentary editor.

You only compare candidates that already passed download and vision checks.
Pick the candidate that is best for this exact scene, not just the highest numeric score.

SCENE NARRATION: "${_short(scene.text || scene.transcript || '', 520)}"
SCENE KEYWORD: "${_short(context.keyword || scene.searchKeyword || scene.keyword || '', 160)}"
VISUAL INTENT: "${_short(scene.visualIntent || '', 360)}"
MEDIA TYPE: ${context.mediaType || scene.mediaType || 'video'}
ROLE: ${agent.role || hunter.mode || 'footage'}
VIEWER NEED: "${_short(agent.viewerNeed || agent.need || agent.mission || '', 260)}"
TARGET: "${_short(contract.target || hunter.target || hunter.targetDescription || '', 320)}"
ACCEPTANCE TEST: "${_short(agent.acceptanceTest || contract.acceptanceTest || '', 260)}"
MUST SHOW: ${mustShow}
MUST AVOID: ${mustAvoid}

EDITORIAL POLICY:
- HARD DEFECT RULE (overrides subject match): a candidate whose notes mention burned-in news graphics, banners, tickers, channel logos/bugs, captions, headline text, or any broadcast packaging is DEFECTIVE. Any clean candidate beats a defective one — even when the defective clip matches the subject more literally. Pick a defective candidate ONLY if every candidate is defective.
- If the scene is a template/background/card, prefer clean, wide, stable footage that supports readable graphics.
- If the scene needs a real named entity or product, prefer the candidate that visibly shows that entity.
- If two candidates score similarly, choose the one with more direct scene anchors and fewer distractions.
- Penalize presenter-heavy, tutorial/review packaging, large text overlays, watermarks, wrong subdomain, or clips where the key visual only appears briefly.
- Treat the numeric quality value as strong evidence. Pick a lower-quality candidate only when it clearly satisfies the listed MUST SHOW items better.
- Never call something a MUST SHOW unless it appears in the MUST SHOW line above.
- Do not invent requirements from the full video. Judge only this scene.
- If every candidate is secretly wrong despite passing vision, return choice 0.

CANDIDATES:
${rows}

Return only JSON:
{"choice":<0-${candidates.length}>,"confidence":<0-10>,"reason":"short editor reason"}`;
}

function _parseJson(text) {
    const raw = String(text || '').trim();
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first < 0 || last <= first) return null;
    try {
        return JSON.parse(raw.slice(first, last + 1));
    } catch (_) {
        return null;
    }
}

function _withTimeout(promise, timeoutMs) {
    if (!timeoutMs || timeoutMs <= 0) return promise;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`AI referee timeout (${Math.round(timeoutMs / 1000)}s)`)), timeoutMs);
        Promise.resolve(promise)
            .then((value) => {
                clearTimeout(timer);
                resolve(value);
            })
            .catch((err) => {
                clearTimeout(timer);
                reject(err);
            });
    });
}

async function _callRefereeAI(prompt, options = {}) {
    const errors = [];
    for (const taskType of TEXT_TASK_FALLBACKS) {
        try {
            return await _withTimeout(callAI(prompt, { ...options, taskType }), DEFAULT_TIMEOUT_MS);
        } catch (e) {
            errors.push(`${taskType}: ${String(e?.message || e).slice(0, 120)}`);
        }
    }
    throw new Error(errors.join(' | '));
}

async function refereeAcceptedCandidates(candidates, context = {}) {
    const pool = Array.isArray(candidates) ? candidates.filter(Boolean).slice(0, DEFAULT_MAX_CANDIDATES) : [];
    if (pool.length < 2) {
        const winner = pool[0] || null;
        return {
            winner,
            skipped: true,
            reason: winner ? 'single accepted candidate' : 'no accepted candidates',
            confidence: winner ? 5 : 0,
            compared: pool.length,
        };
    }

    if (process.env.FOOTAGE_AI_REFEREE === 'false') {
        const sorted = pool.slice().sort((a, b) => (_quality(b) - _quality(a)));
        return {
            winner: sorted[0] || null,
            skipped: true,
            reason: 'AI referee disabled',
            confidence: 0,
            compared: pool.length,
        };
    }

    const prompt = _buildPrompt(pool, context);
    const raw = await _callRefereeAI(prompt, {
        maxTokens: 360,
        temperature: 0,
    });
    const parsed = _parseJson(raw);
    const choice = Number(parsed?.choice);
    const confidence = Math.max(0, Math.min(10, Number(parsed?.confidence || 0)));
    const reason = _short(parsed?.reason || 'AI referee chose best editorial fit', 180);

    if (Number.isFinite(choice) && choice === 0) {
        return {
            winner: null,
            rejectAll: true,
            reason: reason || 'AI referee rejected shortlist',
            confidence,
            compared: pool.length,
            raw: _short(raw, 500),
        };
    }
    if (!Number.isFinite(choice) || choice < 1 || choice > pool.length) {
        const sorted = pool.slice().sort((a, b) => (_quality(b) - _quality(a)));
        return {
            winner: sorted[0] || null,
            fallback: true,
            reason: 'AI referee returned invalid choice; used score fallback',
            confidence: 0,
            compared: pool.length,
            raw: _short(raw, 500),
        };
    }

    const picked = pool[choice - 1];
    const qualitySorted = pool
        .map((candidate, index) => ({ candidate, index, quality: _quality(candidate) }))
        .sort((a, b) => b.quality - a.quality);
    const qualityLeader = qualitySorted[0] || null;
    const pickedQuality = _quality(picked);
    const qualityGap = qualityLeader && qualityLeader.candidate !== picked
        ? qualityLeader.quality - pickedQuality
        : 0;
    if (qualityLeader && qualityGap >= QUALITY_OVERRIDE_GAP && confidence < QUALITY_OVERRIDE_MIN_CONFIDENCE) {
        return {
            winner: qualityLeader.candidate,
            choice: qualityLeader.index + 1,
            fallback: true,
            reason: `AI referee picked lower-quality C${choice} with confidence ${confidence}/10; used quality leader C${qualityLeader.index + 1} (gap ${qualityGap.toFixed(1)})`,
            confidence,
            compared: pool.length,
            raw: _short(raw, 500),
        };
    }

    return {
        winner: picked,
        choice,
        reason,
        confidence,
        compared: pool.length,
        raw: _short(raw, 500),
    };
}

module.exports = {
    refereeAcceptedCandidates,
};
