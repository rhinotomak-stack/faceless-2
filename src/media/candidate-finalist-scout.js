/**
 * Candidate Finalist Scout
 *
 * Cheap text-only ranking before full download/vision. This is the "many scouts,
 * one editor" layer: rank the candidate pool by the scene's actual visual need,
 * then spend expensive download/vision budget on the best few.
 */

const { callAI } = require('../brain/ai-provider');
const { normalizeUrlForDedup } = require('../util/url-utils');

const _cache = new Map();
const PROMPT_VERSION = 'direct-anchor-v2';
const MAX_RESULTS = Math.max(4, Math.min(30, parseInt(process.env.MEDIA_FINALIST_SCOUT_MAX || '24', 10) || 24));
const MAX_REASON_LEN = 120;
const TEXT_TASK_FALLBACKS = ['utility', 'classifier', 'planner-small', 'general'];

function _sceneKey(scene) {
    if (scene?.index != null) return `s${scene.index}`;
    if (scene?.sceneIndex != null) return `s${scene.sceneIndex}`;
    const txt = String(scene?.text || scene?.transcript || '').slice(0, 100);
    let h = 0;
    for (let i = 0; i < txt.length; i++) h = ((h << 5) - h + txt.charCodeAt(i)) | 0;
    return `h${h}`;
}

function _resultTitle(result) {
    return String(
        result?.title
        || result?._cachedMeta?.title
        || result?._meta?.title
        || result?.url
        || ''
    ).replace(/\s+/g, ' ').trim();
}

function _resultUrlKey(result) {
    const url = result?._directVideoUrl
        || result?._fallbackUrl
        || result?._cachedMeta?._fallbackUrl
        || result?.url
        || '';
    return normalizeUrlForDedup(url) || '';
}

function _short(value, max = 140) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function _buildPrompt(results, scene, contract, opts = {}) {
    const sceneText = _short(scene?.text || scene?.transcript || '', 420);
    const target = _short(contract?.target || opts.hunterProfile?.targetDescription || '', 260);
    const acceptance = _short(contract?.acceptanceTest || '', 220);
    const mustShow = (contract?.mustShow || opts.mediaAgent?.mustShow || []).slice(0, 10).join(', ') || '(any)';
    const mustAvoid = (contract?.mustNotShow || opts.mediaAgent?.mustAvoid || []).slice(0, 8).join(', ') || '(none)';
    const agentNeed = _short(opts.mediaAgent?.need || opts.mediaAgent?.mission || opts.mediaAgent?.brief || '', 260);
    const hunterTarget = _short(opts.hunterProfile?.targetDescription || '', 240);
    const role = String(opts.mediaAgent?.role || opts.hunterProfile?.mode || '').trim() || 'footage';
    const providerName = opts.providerName || opts.providerKey || 'provider';
    const query = opts.query ? `SEARCH QUERY: "${_short(opts.query, 120)}"\n` : '';
    const rows = results.map((result, idx) => {
        const title = _resultTitle(result);
        const duration = Number(result?.duration || result?._cachedMeta?.duration || result?._meta?.duration || 0);
        const scout = Number(result?._mediaScoutScore || 0);
        const thumb = result?._thumbnailVisionPassed === true ? 'thumbnail-kept' : '';
        const reasons = Array.isArray(result?._mediaScoutReasons) ? result._mediaScoutReasons.slice(0, 4).join(', ') : '';
        const meta = [
            duration > 0 ? `${Math.round(duration)}s` : '',
            scout ? `mediaScout=${scout}` : '',
            thumb,
            reasons ? `signals=${reasons}` : '',
        ].filter(Boolean).join('; ');
        return `${idx + 1}. "${title}"${meta ? ` (${meta})` : ''}`;
    }).join('\n');

    return `You are the media finalist scout for an automated documentary editor.

Your job is NOT to decide final acceptance. Your job is to rank which candidates deserve expensive download + vision scoring FIRST.

SCENE NARRATION: "${sceneText}"
ROLE: ${role}
PROVIDER: ${providerName}
${query}TARGET FOOTAGE: ${target}
${hunterTarget ? `HUNTER TARGET: ${hunterTarget}\n` : ''}${agentNeed ? `MEDIA AGENT NEED: ${agentNeed}\n` : ''}${acceptance ? `EDITOR ACCEPTANCE TEST: ${acceptance}\n` : ''}MUST SHOW: ${mustShow}
MUST AVOID: ${mustAvoid}

EDITORIAL RANKING POLICY:
- Prefer footage that would visually help the audience understand this exact narration.
- Prefer active visual evidence: making, assembling, testing, using, displaying, inspecting, or operating the subject.
- For template/background scenes, prefer clean useful B-roll that supports the card, not merely an atmospheric place that barely relates.
- For template/background scenes, rank by DIRECT SCENE ANCHOR coverage first. Direct anchors are the concrete things/settings in TARGET FOOTAGE, MEDIA AGENT NEED, and MUST SHOW.
- Score 9-10 only when the title/metadata clearly contains the main setting plus at least one concrete object/action from the scene anchors.
- Score broad same-family mood clips lower. Example: if the scene asks for workshop/tools/workbench/brand-product context, a generic foundry/factory process can be usable but should not beat a workshop, tools, product shelf, assembly bench, repair bench, or branded product context.
- If a candidate changes the visual subdomain while staying vaguely thematic (factory instead of workshop, logistics instead of retail aisle, exterior instead of aisle/interior), cap its priority around 6-7 unless no direct-anchor candidates exist.
- If many candidates exist, do not rank a merely "okay mood" clip above a clip that shows the requested action/object more directly.
- Keep the scene-local requirements only. Do not invent mandatory brands/entities from the full video.
- Penalize presenter/talking-head/graphic/review thumbnails unless the scene explicitly needs that.
- Penalize titles that describe people leaving, posing, talking, or standing around when another candidate shows the thing being built/used.
- Do not hard-reject broad stock B-roll when it is genuinely the best visual support; just score it lower than a direct visual match.

CANDIDATES:
${rows}

Score each candidate 0-10 for "download priority".
Use 9-10 for obvious best visual match, 7-8 for good usable candidates, 5-6 for weak but possible, 0-4 for likely waste.

Output exactly one line per candidate:
N|<score 0-10>|<short reason <=10 words>`;
}

function _parse(text, count) {
    const out = new Map();
    for (const raw of String(text || '').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line) continue;
        const m = line.match(/^(\d+)\s*[|:\-]\s*(\d+(?:\.\d+)?)\s*[|:\-]\s*(.*)$/);
        if (!m) continue;
        const index = Number(m[1]);
        const score = Math.max(0, Math.min(10, Number(m[2])));
        if (!Number.isFinite(index) || index < 1 || index > count || !Number.isFinite(score)) continue;
        const reason = String(m[3] || '').replace(/\s+/g, ' ').trim().slice(0, MAX_REASON_LEN) || 'ranked';
        if (!out.has(index)) out.set(index, { score, reason });
    }
    return out;
}

async function _callTextWithFallback(prompt, options = {}) {
    const errors = [];
    for (const taskType of TEXT_TASK_FALLBACKS) {
        try {
            return await callAI(prompt, { ...options, taskType });
        } catch (e) {
            errors.push(`${taskType}: ${String(e?.message || e).slice(0, 120)}`);
        }
    }
    throw new Error(errors.join(' | '));
}

async function rankCandidateFinalists(results, scene, contract, opts = {}) {
    if (!Array.isArray(results) || results.length < 3) {
        return { results: results || [], ranked: [], log: '' };
    }
    if (opts.enabled === false) {
        return { results, ranked: [], log: '' };
    }

    const limit = Math.min(MAX_RESULTS, results.length);
    const head = results.slice(0, limit);
    const tail = results.slice(limit);
    const sceneKey = _sceneKey(scene);
    const providerKey = String(opts.providerKey || opts.providerName || 'provider').toLowerCase();
    const pending = [];
    const scored = new Map();

    for (let i = 0; i < head.length; i++) {
        const result = head[i];
        const urlKey = _resultUrlKey(result) || `title:${_resultTitle(result).toLowerCase().slice(0, 100)}`;
        const cacheKey = `${PROMPT_VERSION}|${sceneKey}|${providerKey}|${urlKey}`;
        if (_cache.has(cacheKey)) {
            scored.set(result, _cache.get(cacheKey));
        } else {
            pending.push({ result, index: i, cacheKey });
        }
    }

    if (pending.length > 0) {
        const prompt = _buildPrompt(head, scene, contract, opts);
        try {
            const raw = await _callTextWithFallback(prompt, {
                maxTokens: 100 + head.length * 36,
                temperature: 0,
            });
            const parsed = _parse(raw, head.length);
            for (let i = 0; i < head.length; i++) {
                const verdict = parsed.get(i + 1);
                if (!verdict) continue;
                const item = pending.find(p => p.index === i);
                if (item) _cache.set(item.cacheKey, verdict);
                scored.set(head[i], verdict);
            }
        } catch (e) {
            return { results, ranked: [], log: `Candidate Finalist Scout skipped (${e.message})` };
        }
    }

    const rankedHead = head.map((result, index) => {
        const verdict = scored.get(result);
        const score = Number(verdict?.score);
        const fallback = Number(result?._mediaScoutScore || 0);
        const finalScore = Number.isFinite(score) ? score : Math.min(6, Math.max(0, fallback));
        return {
            result: {
                ...result,
                _candidateFinalistScore: finalScore,
                _candidateFinalistReason: verdict?.reason || (fallback ? 'media scout fallback' : 'unscored'),
            },
            index,
            score: finalScore,
            reason: verdict?.reason || '',
        };
    });

    rankedHead.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    const moved = rankedHead.some((item, idx) => item.index !== idx);
    const rankedResults = [...rankedHead.map(item => item.result), ...tail];
    const providerName = opts.providerName || opts.providerKey || 'provider';
    const top = rankedHead[0];
    const topTitle = top ? _short(_resultTitle(top.result), 90) : '';
    const log = moved && top
        ? `Candidate Finalist Scout: [${providerName}] ranked "${topTitle}" first (${top.score}/10: ${top.reason || top.result._candidateFinalistReason || 'best finalist'})`
        : `Candidate Finalist Scout: [${providerName}] scored ${rankedHead.length} candidate(s)${top ? `; top "${topTitle}" (${top.score}/10)` : ''}`;

    return {
        results: rankedResults,
        ranked: rankedHead.map(item => item.result),
        log,
    };
}

function resetCandidateFinalistScoutCache() {
    _cache.clear();
}

module.exports = {
    rankCandidateFinalists,
    resetCandidateFinalistScoutCache,
};
