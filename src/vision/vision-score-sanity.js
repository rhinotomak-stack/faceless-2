const STOPWORDS = new Set([
    'about', 'above', 'after', 'again', 'against', 'all', 'also', 'and', 'any', 'are', 'around',
    'because', 'been', 'before', 'being', 'between', 'both', 'but', 'can', 'could', 'did', 'does',
    'done', 'each', 'for', 'from', 'has', 'have', 'having', 'here', 'into', 'its', 'just', 'like',
    'look', 'looks', 'made', 'make', 'many', 'more', 'most', 'next', 'not', 'now', 'off', 'only',
    'other', 'over', 'same', 'scene', 'show', 'showing', 'shows', 'that', 'the', 'their', 'them',
    'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'used', 'very', 'video',
    'visual', 'want', 'with', 'within', 'without', 'would', 'your',
]);

// Map/chart/diagram imagery with baked-in labels is the classic web-image
// defect: vision correctly zeroes it, then the anchor bump used to rescue it
// because the LABELS contain the scene keywords ("Persian Gulf shipping
// density map" matches anchors persian/gulf/shipping → 0/10 bumped to 6/10
// and a labeled heatmap shipped as scene footage). Keyword overlap on
// cartography is evidence AGAINST usability, not for it — never bump these.
const HARD_NEGATIVE_RE = /\b(unrelated|wrong subject|wrong video|does not show|doesn't show|not visible|not identifiable|instead of|rather than|presenter|host|talking head|webcam|picture[-\s]?in[-\s]?picture|studio desk|news anchor|editorial text overlay|watermark|large logo|ai[-\s]?generated|cartoon|clipart|illustration|slideshow|slide show|ken[-\s]?burns|\w* ?map\b|cartograph\w*|chart|diagram|infographic|heatmap|heat map|legend|labels?\b|labeled|labelled|annotat\w+|text overlay|overlaid text|on[-\s]?screen text|screenshot)\b/i;

const MANDATORY_GENERIC_TOKENS = new Set([
    'background', 'broll', 'clean', 'close', 'context', 'frame', 'footage', 'full',
    'fullscreen', 'generic', 'image', 'inside', 'literal', 'main', 'modern', 'object',
    'photo', 'real', 'scene', 'shot', 'show', 'showing', 'shows', 'simple', 'still',
    'subject', 'target', 'template', 'video', 'view', 'visible', 'wide',
]);

const NEGATION_WORDS = new Set([
    'without', 'lack', 'lacks', 'lacking', 'missing', 'absent', 'never',
]);

const NEGATION_SUPPORT_WORDS = new Set([
    'show', 'shows', 'shown', 'showing', 'display', 'displays', 'displayed',
    'visible', 'seen', 'present', 'include', 'includes', 'included',
    'contain', 'contains', 'contained', 'have', 'has', 'had',
]);

function _short(value, max = 120) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

function _tokenForm(value) {
    let token = String(value || '').toLowerCase().trim();
    token = token.replace(/^[-_]+|[-_]+$/g, '');
    if (!token || token.length < 3 || STOPWORDS.has(token)) return '';
    if (/^\d+$/.test(token)) return '';
    if (token.endsWith("'s")) token = token.slice(0, -2);
    if (token.endsWith('ies') && token.length > 5) token = `${token.slice(0, -3)}y`;
    else if (token.endsWith('s') && token.length > 4 && !token.endsWith('ss')) token = token.slice(0, -1);
    if (!token || token.length < 3 || STOPWORDS.has(token)) return '';
    return token;
}

function _expandedWords(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/\bdoesn['’]?t\b/g, 'does not')
        .replace(/\bdon['’]?t\b/g, 'do not')
        .replace(/\bdidn['’]?t\b/g, 'did not')
        .replace(/\bcan['’]?t\b/g, 'can not')
        .replace(/\bwon['’]?t\b/g, 'will not')
        .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
        .split(/\s+/)
        .map(word => word.replace(/^[-_']+|[-_']+$/g, ''))
        .filter(Boolean);
}

function _wordEntries(value) {
    return _expandedWords(value).map(raw => ({
        raw,
        form: _tokenForm(raw),
    }));
}

function _hasNegationBefore(entries, index) {
    const start = Math.max(0, index - 8);
    const before = entries.slice(start, index);
    const raws = before.map(entry => entry.raw);
    if (raws.some(word => NEGATION_WORDS.has(word))) return true;

    const noIndex = raws.lastIndexOf('no');
    if (noIndex >= 0 && raws.length - noIndex <= 4) {
        const afterNo = raws[noIndex + 1] || '';
        if (!/^(people|person|man|woman|men|women|one|body)$/.test(afterNo)) return true;
    }

    const notIndex = raws.lastIndexOf('not');
    if (notIndex >= 0) {
        const afterNot = raws.slice(notIndex + 1);
        const articleNegation = /^(a|an|the|this|that|from|in|of|part|related|relevant|matching|actually)$/.test(afterNot[0] || '');
        if (afterNot.length <= 6 && (afterNot.length === 0 || articleNegation || afterNot.some(word => NEGATION_SUPPORT_WORDS.has(word)))) {
            return true;
        }
    }

    return false;
}

function _hasNegationAfter(entries, index) {
    const after = entries.slice(index + 1, index + 7).map(entry => entry.raw);
    const text = after.join(' ');
    return /\b(not visible|not shown|not seen|not present|missing|absent|lacking)\b/.test(text);
}

function _termIsNegated(description, tokens, hits = []) {
    const relevant = hits.length ? hits : tokens;
    if (!relevant.length) return false;
    const wanted = new Set(relevant);
    const entries = _wordEntries(description);
    for (let i = 0; i < entries.length; i++) {
        if (!wanted.has(entries[i].form)) continue;
        if (_hasNegationBefore(entries, i) || _hasNegationAfter(entries, i)) return true;
    }
    return false;
}

function _tokens(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
        .split(/\s+/)
        .map(_tokenForm)
        .filter(Boolean);
}

function _mandatoryTokens(value) {
    return _tokens(value).filter(token => !MANDATORY_GENERIC_TOKENS.has(token));
}

function _pushParts(parts, value) {
    if (Array.isArray(value)) {
        for (const item of value) _pushParts(parts, item);
        return;
    }
    if (value !== undefined && value !== null && String(value).trim()) {
        parts.push(String(value));
    }
}

function _targetParts(keyword, context = {}) {
    const agent = context?.mediaAgent || {};
    const hunter = context?.mediaHunter || {};
    const parts = [];
    _pushParts(parts, keyword);
    _pushParts(parts, context?.visualIntent);
    _pushParts(parts, context?.literalRequiredObjects);
    _pushParts(parts, context?.subjectAnchors);
    _pushParts(parts, context?.mustShow);
    _pushParts(parts, context?.mandatoryVisible);
    _pushParts(parts, context?.mandatoryIdentity);
    _pushParts(parts, agent?.target);
    _pushParts(parts, agent?.viewerNeed);
    _pushParts(parts, agent?.literalRequiredObjects);
    _pushParts(parts, agent?.subjectAnchors);
    _pushParts(parts, agent?.mustShow);
    _pushParts(parts, agent?.mandatoryVisible);
    _pushParts(parts, agent?.mandatoryIdentity);
    _pushParts(parts, hunter?.targetDescription);
    _pushParts(parts, hunter?.prefer);
    return parts;
}

function _mandatoryParts(context = {}) {
    const agent = context?.mediaAgent || {};
    const hunter = context?.mediaHunter || {};
    const identityMode = String(agent?.identityEvidenceMode || hunter?.identityEvidenceMode || '').toLowerCase();
    const parts = [];
    _pushParts(parts, context?.mandatoryVisible);
    _pushParts(parts, agent?.mandatoryVisible);
    _pushParts(parts, hunter?.mandatoryVisible);
    if (!/source-proven/.test(identityMode)) {
        _pushParts(parts, context?.mandatoryIdentity);
        _pushParts(parts, agent?.mandatoryIdentity);
        _pushParts(parts, hunter?.mandatoryIdentity);
    }
    _pushParts(parts, context?.literalRequiredObjects);
    _pushParts(parts, context?.mustShow);
    _pushParts(parts, agent?.literalRequiredObjects);
    _pushParts(parts, agent?.mustShow);
    return parts;
}

function _hardMandatoryParts(context = {}) {
    const agent = context?.mediaAgent || {};
    const hunter = context?.mediaHunter || {};
    const parts = [];
    _pushParts(parts, context?.mandatoryVisible);
    _pushParts(parts, context?.mandatoryIdentity);
    _pushParts(parts, context?.literalRequiredObjects);
    _pushParts(parts, agent?.mandatoryVisible);
    _pushParts(parts, agent?.mandatoryIdentity);
    _pushParts(parts, agent?.literalRequiredObjects);
    _pushParts(parts, hunter?.mandatoryVisible);
    _pushParts(parts, hunter?.mandatoryIdentity);
    return parts;
}

function _hasNegatedHardMandatory(description, context = {}) {
    const descTokens = new Set(_tokens(description));
    for (const part of _hardMandatoryParts(context)) {
        const tokens = _mandatoryTokens(part);
        if (tokens.length < 2) continue;
        const hits = tokens.filter(token => descTokens.has(token));
        if (hits.length >= Math.min(2, tokens.length) && _termIsNegated(description, tokens, hits)) return true;
    }
    return false;
}

function _mandatoryCoverage(description, context = {}) {
    const parts = _mandatoryParts(context)
        .map(part => String(part || '').replace(/\s+/g, ' ').trim())
        .filter(part => part.length >= 3);
    if (parts.length === 0) return { ok: true, matched: [], required: [] };

    const descTokens = new Set(_tokens(description));
    const required = [];
    const matched = [];

    for (const part of parts) {
        const tokens = _mandatoryTokens(part);
        if (tokens.length < 2) continue;
        const hits = tokens.filter(token => descTokens.has(token));
        const need = tokens.length <= 3
            ? Math.min(2, tokens.length)
            : Math.min(4, Math.max(2, Math.ceil(tokens.length * 0.45)));
        const negated = hits.length > 0 && _termIsNegated(description, tokens, hits);
        required.push({ part, tokens, hits, need, negated });
        if (hits.length >= need && !negated) matched.push({ part, hits });
    }

    if (required.length === 0) return { ok: true, matched: [], required: [] };
    const primaryRequired = required.some(item => item.tokens.length >= 3)
        ? required.filter(item => item.tokens.length >= 3)
        : required;
    const primaryMatched = matched.filter(hit => primaryRequired.some(item => item.part.toLowerCase() === hit.part.toLowerCase()));
    return {
        ok: primaryMatched.length > 0,
        matched: primaryMatched,
        required: primaryRequired,
    };
}

function _uniqueTokens(parts) {
    const seen = new Set();
    const out = [];
    for (const part of parts) {
        for (const token of _tokens(part)) {
            if (seen.has(token)) continue;
            seen.add(token);
            out.push(token);
            if (out.length >= 36) return out;
        }
    }
    return out;
}

function _descriptionCoverage(description, keyword, context = {}) {
    const target = _uniqueTokens(_targetParts(keyword, context));
    const descTokens = new Set(_tokens(description));
    const matched = target.filter(token => descTokens.has(token));
    const ratio = target.length ? matched.length / Math.min(target.length, 10) : 0;
    return { target, matched, ratio };
}

function applyVisionScoreSanity(result, keyword, context = {}, options = {}) {
    if (!result) return result;
    const score = Number(result.score ?? result.bestScore ?? 0);
    const triggerScore = Number.isFinite(Number(options.triggerScore)) ? Number(options.triggerScore) : 2;
    const parseError = !!result.parseError || (!!result.errorMessage && /missing numeric score|parse/i.test(String(result.errorMessage)));
    if (!parseError && score > triggerScore) return result;

    const description = String(result.description || '').trim();
    if (description.length < 12) return result;
    if (HARD_NEGATIVE_RE.test(description)) return result;
    if (_hasNegatedHardMandatory(description, context)) return result;

    const mandatoryCoverage = _mandatoryCoverage(description, context);
    if (!mandatoryCoverage.ok) return result;

    const coverage = _descriptionCoverage(description, keyword, context);
    const enoughMatches = coverage.matched.length >= 3
        || (coverage.matched.length >= 2 && coverage.target.length <= 7)
        || coverage.ratio >= 0.35;
    if (!enoughMatches) return result;
    if (_termIsNegated(description, coverage.target, coverage.matched)) return result;

    const floor = Math.max(
        1,
        Math.min(10, Number.isFinite(Number(options.floor)) ? Number(options.floor) : 5)
    );
    const adjustedScore = Math.max(score || 0, floor);
    if (adjustedScore <= score) return result;

    const reason = `description matches scene anchors: ${coverage.matched.slice(0, 6).join(', ')}`;
    return {
        ...result,
        score: adjustedScore,
        bestScore: result.bestScore !== undefined ? adjustedScore : result.bestScore,
        rawScoreBeforeSanity: score || 0,
        scoreSanity: {
            adjusted: true,
            from: score || 0,
            to: adjustedScore,
            reason,
            matched: coverage.matched.slice(0, 10),
            target: coverage.target.slice(0, 12),
            parseError,
        },
        description: `${description} [score sanity: ${_short(reason, 100)}; ${score || 0}->${adjustedScore}]`,
    };
}

// ── Self-reported defect clamp ──
// The scoring rubric caps burned-in broadcast packaging (banners, tickers,
// channel logos, captions) at 3-4, but models routinely describe the defect
// IN THEIR OWN WORDS and still emit 7/10 ("missile launch with visible news
// graphics ('13' logo) — 7/10"). When the description admits the defect, the
// number is clamped deterministically. Global, all niches, zero AI cost.
const SELF_DEFECT_RE = /(?<!\bno )(?<!\bnot )(?<!\bwithout )(?<!\bfree of )\b(news[- ](?:graphics?|banner|ticker|bug|overlay|strap)|channel (?:logo|bug|branding)|station (?:logo|branding)|broadcast (?:graphics?|overlay|packaging)|lower[- ]third|news ticker|ticker tape|burned[- ]in (?:text|caption|subtitle|graphics?)|on[- ]?screen (?:text|caption|headline)|caption (?:bar|strip)|(?:arabic|foreign(?:[- ]language)?) (?:text|caption|subtitle)|(?:large|prominent|heavy|visible) watermark)\b/i;
const DEFECT_CAP = 4;

function clampSelfReportedDefects(result) {
    if (!result) return result;
    const score = Number(result.score ?? result.bestScore ?? 0);
    if (!(score > DEFECT_CAP)) return result;
    const description = String(result.description || '');
    const m = description.match(SELF_DEFECT_RE);
    if (!m) return result;
    return {
        ...result,
        score: DEFECT_CAP,
        bestScore: result.bestScore !== undefined ? DEFECT_CAP : result.bestScore,
        rawScoreBeforeSanity: score,
        scoreSanity: {
            adjusted: true,
            from: score,
            to: DEFECT_CAP,
            reason: `description self-reports broadcast packaging ("${m[0]}")`,
        },
        description: `${description} [defect clamp: "${m[0]}" → ${DEFECT_CAP}/10]`,
    };
}

module.exports = {
    applyVisionScoreSanity,
    clampSelfReportedDefects,
};
