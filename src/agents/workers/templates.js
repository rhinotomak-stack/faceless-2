/**
 * Templates Worker
 *
 * Owns template rhythm for the Editor Agent workflow:
 *   1. Pre-media rhythm review demotes weak/repetitive VP template roles before
 *      downloads, so demoted scenes get real footage.
 *   2. Final template placement still delegates to ai-templates.js.
 */

const { processTemplates } = require('../ai-templates');
const { callAI } = require('../../brain/ai-provider');

const VALID_SOURCE_HINTS = new Set(['stock', 'youtube', 'web-image', 'reddit']);
const VALID_MEDIA_TYPES = new Set(['video', 'image']);
const VALID_OVERLAY_TYPES = new Set([
    'focusWord',
    'kineticText',
    'headline',
    'callout',
    'statCounter',
    'lowerThird',
    'dataBar',
    'percentageCircle',
    'typographyReveal',
]);
const TEMPLATE_TYPES = new Set([
    'chapterCard',
    'locationCard',
    'quoteCard',
    'keyTakeaway',
    'comparisonCard',
    'timelineCard',
    'factCard',
    'imageShowcase',
    'statCard',
    'personIntro',
    'splitScreen',
    'infographic',
]);

function _clean(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function _short(value, max = 140) {
    const text = _clean(value);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function _usable(value) {
    const text = _clean(value);
    return !!text && !['none', 'null', 'undefined', 'n/a'].includes(text.toLowerCase());
}

function _envFlagEnabled(name, defaultValue = true) {
    const raw = process.env[name];
    if (raw == null) return defaultValue;
    const value = String(raw).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(value)) return true;
    if (['0', 'false', 'no', 'off'].includes(value)) return false;
    return defaultValue;
}

function _parseTemplateHint(templateHint) {
    if (!_usable(templateHint)) return { type: null, content: '' };
    const text = _clean(templateHint);
    const colonIdx = text.indexOf(':');
    const type = colonIdx > 0 ? text.slice(0, colonIdx).trim() : text.trim();
    const content = colonIdx > 0 ? text.slice(colonIdx + 1).trim() : '';
    return { type, content };
}

function _time(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function _sceneEnd(scene) {
    const start = _time(scene?.startTime, 0);
    return _time(scene?.endTime, start + _time(scene?.duration, 3));
}

function _sourceHint(value) {
    const raw = _clean(value).toLowerCase();
    if (!raw) return null;
    if (raw === 'pexels' || raw === 'pixabay' || raw === 'unsplash') return 'stock';
    if (raw === 'web' || raw === 'image' || raw === 'google') return 'web-image';
    return VALID_SOURCE_HINTS.has(raw) ? raw : null;
}

function _mediaType(value, sourceHint) {
    const raw = _clean(value).toLowerCase();
    if (VALID_MEDIA_TYPES.has(raw)) return raw;
    return sourceHint === 'web-image' ? 'image' : 'video';
}

function _overlayHint(value) {
    const text = _clean(value);
    if (!text || text.toLowerCase() === 'none') return null;
    const colonIdx = text.indexOf(':');
    const type = colonIdx > 0 ? text.slice(0, colonIdx).trim() : text.trim();
    const payload = colonIdx > 0 ? text.slice(colonIdx + 1).trim() : '';
    if (!VALID_OVERLAY_TYPES.has(type)) return null;
    if (!payload) return null;
    return `${type}: ${_short(payload, 90)}`;
}

function _compactQuery(value) {
    const stop = new Set([
        'the', 'and', 'for', 'that', 'this', 'with', 'from', 'into', 'onto', 'your',
        'their', 'they', 'them', 'there', 'about', 'because', 'which', 'what',
        'when', 'where', 'will', 'would', 'could', 'should', 'have', 'has', 'had',
        'than', 'then', 'just', 'more', 'less', 'very', 'really', 'template',
        'keytakeaway', 'locationcard', 'quotecard', 'chaptercard', 'factcard',
    ]);
    const words = _clean(value)
        .replace(/^[a-zA-Z]+Card\s*:/, '')
        .replace(/[^a-zA-Z0-9%+\-\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !stop.has(w.toLowerCase()));
    const picked = [];
    for (const word of words) {
        const lower = word.toLowerCase();
        if (picked.some(p => p.toLowerCase() === lower)) continue;
        picked.push(word);
        if (picked.length >= 6) break;
    }
    return picked.join(' ');
}

function _defaultFootageQuery(scene, candidate, decision) {
    const chosen = _compactQuery(decision?.footageQuery);
    if (_usable(chosen)) return chosen;
    const existing = [
        scene?.templateBgQuery,
        scene?.bgQuery,
        candidate?.bgQuery,
        scene?.keyword,
        scene?.stockQuery,
        scene?.webQuery,
        scene?.visualIntent,
        scene?.text,
        candidate?.content,
    ].find(_usable);
    const query = _compactQuery(existing);
    return _usable(query) ? query : 'hands repairing workshop';
}

function _buildTemplateCandidates(scenes = []) {
    return (scenes || [])
        .map((scene, ordinal) => {
            if (!scene || scene.fullscreenMG || !_usable(scene.templateHint)) return null;
            const { type, content } = _parseTemplateHint(scene.templateHint);
            if (!TEMPLATE_TYPES.has(type) || type === 'listicleGrid') return null;
            const start = _time(scene.startTime, 0);
            const end = _sceneEnd(scene);
            return {
                scene,
                ordinal,
                index: scene.index ?? ordinal,
                type,
                content,
                start,
                end,
                duration: Math.max(0, end - start),
                text: _clean(scene.text),
                bgQuery: scene.templateBgQuery || scene.bgQuery || scene.keyword || null,
                sourceHint: scene.sourceHint || null,
                mediaType: scene.mediaType || null,
                mgHint: scene.mgHint || null,
            };
        })
        .filter(Boolean)
        .sort((a, b) => a.start - b.start || a.index - b.index);
}

function _diagnoseRhythm(candidates = [], totalDuration = 0) {
    const byType = {};
    for (const c of candidates) byType[c.type] = (byType[c.type] || 0) + 1;

    const runs = [];
    let current = [];
    for (const c of candidates) {
        const prev = current[current.length - 1];
        if (!prev || c.start <= prev.end + 0.35) {
            current.push(c);
        } else {
            runs.push(current);
            current = [c];
        }
    }
    if (current.length) runs.push(current);

    const minuteBuckets = [];
    const duration = Math.max(
        Number(totalDuration) || 0,
        ...candidates.map(c => c.end),
        0
    );
    for (let m = 0; m < Math.ceil(duration / 60); m++) {
        const start = m * 60;
        const end = start + 60;
        const seconds = candidates.reduce((sum, c) => {
            return sum + Math.max(0, Math.min(end, c.end) - Math.max(start, c.start));
        }, 0);
        const count = candidates.filter(c => c.start < end && c.end > start).length;
        if (count || seconds > 0) {
            minuteBuckets.push({
                minute: m,
                count,
                seconds: Math.round(seconds * 10) / 10,
                pct: Math.round((seconds / 60) * 1000) / 10,
            });
        }
    }

    const longRuns = runs
        .filter(run => run.length >= 3)
        .sort((a, b) => b.length - a.length || (b[b.length - 1].end - b[0].start) - (a[a.length - 1].end - a[0].start))
        .slice(0, 8)
        .map(run => ({
            count: run.length,
            start: Math.round(run[0].start * 100) / 100,
            end: Math.round(run[run.length - 1].end * 100) / 100,
            types: run.map(c => c.type),
            sceneIndexes: run.map(c => c.index),
        }));

    return {
        totalCandidates: candidates.length,
        byType,
        runCount: runs.length,
        longRuns,
        minuteBuckets,
    };
}

function _candidateRows(candidates, scenes) {
    return candidates.map(c => {
        const prev = scenes[c.ordinal - 1];
        const next = scenes[c.ordinal + 1];
        const parts = [
            `S${c.index}`,
            `${c.start.toFixed(1)}-${c.end.toFixed(1)}s`,
            `type=${c.type}`,
            `content="${_short(c.content || c.text, 90)}"`,
            `narration="${_short(c.text, 120)}"`,
            `bg="${_short(c.bgQuery || '', 60)}"`,
            prev ? `prev="${_short(prev.text, 55)}"` : null,
            next ? `next="${_short(next.text, 55)}"` : null,
        ].filter(Boolean);
        return parts.join(' | ');
    }).join('\n');
}

function _buildRhythmPrompt(candidates, scenes, scriptContext, diagnostics, aiInstructions, retryNote = '') {
    const totalDuration = Number(scriptContext?.totalDuration)
        || Number(scriptContext?.duration)
        || (scenes.length ? _sceneEnd(scenes[scenes.length - 1]) : 0);
    const title = scriptContext?.videoTitle || scriptContext?.title || scriptContext?.summary || 'video';
    const niche = scriptContext?.nicheId || scriptContext?.niche || 'general';
    const theme = scriptContext?.themeId || 'standard';
    const language = scriptContext?.language || scriptContext?.buildLanguage || 'en';

    return `You are the Editor Agent CEO's Template Rhythm worker.

Your job: review the full timeline BEFORE media download and decide which Visual Planner template cards deserve to remain full-screen templates, and which should be demoted back to real footage with a small overlay.

This app is moving toward agentic editing. Do not use a blind numeric quota. Think like a human editor:
- Real footage should carry the video.
- Templates are high-impact punctuation: direct quote, real stat, true section break, major verdict, explicit comparison/list.
- Repeated locationCard/keyTakeaway beats usually feel like card spam unless they form a deliberate designed sequence.
- When a template is demoted, preserve the idea with footageQuery and optional overlayHint.
- Favor hands-on, camera-visible, concrete footage queries. No abstract words like "concept", "analysis", "documentary", "background".
- Keep intentional template sequences only when the rhythm genuinely benefits.

Video:
title="${_short(title, 160)}"
niche=${niche}
theme=${theme}
language=${language}
duration=${Math.round(totalDuration)}s

Current template rhythm diagnostics:
${JSON.stringify(diagnostics, null, 2)}

Template candidates:
${_candidateRows(candidates, scenes)}

${aiInstructions ? `User/build instructions to respect:\n${aiInstructions}\n` : ''}
${retryNote ? `Previous response failed validation:\n${retryNote}\n` : ''}

Return STRICT JSON only. No markdown. Schema:
{
  "summary": "one sentence",
  "decisions": [
    {
      "sceneIndex": 12,
      "action": "keep" | "demote",
      "reason": "short editorial reason",
      "footageQuery": "3-7 concrete searchable words, required when demote",
      "sourceHint": "stock" | "youtube" | "web-image" | "reddit",
      "mediaType": "video" | "image",
      "overlayHint": "none OR one overlay like kineticText: Short Phrase"
    }
  ]
}

Rules:
- Include one decision for every candidate scene index listed above.
- For keep: footageQuery/sourceHint/mediaType/overlayHint can be "none".
- For demote: footageQuery must be concrete and sourceHint/mediaType must be usable.
- overlayHint type must be one of: ${Array.from(VALID_OVERLAY_TYPES).join(', ')}.
- Do not invent new template types.`;
}

function _extractJsonObject(response) {
    const text = _clean(response).replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) throw new Error('no JSON object found');
    return JSON.parse(text.slice(start, end + 1));
}

function _parseRhythmDecisionResponse(response, candidateIndexes) {
    const data = _extractJsonObject(response);
    if (!Array.isArray(data.decisions)) throw new Error('decisions must be an array');
    const wanted = new Set(candidateIndexes.map(Number));
    const decisions = [];
    for (const raw of data.decisions) {
        const sceneIndex = Number(raw?.sceneIndex);
        if (!Number.isFinite(sceneIndex) || !wanted.has(sceneIndex)) continue;
        const actionRaw = _clean(raw.action).toLowerCase();
        const action = actionRaw === 'demote' ? 'demote' : 'keep';
        decisions.push({
            sceneIndex,
            action,
            reason: _short(raw.reason || (action === 'demote' ? 'rhythm demotion' : 'earned template'), 140),
            footageQuery: _short(raw.footageQuery || '', 90),
            sourceHint: _sourceHint(raw.sourceHint),
            mediaType: _mediaType(raw.mediaType, _sourceHint(raw.sourceHint)),
            overlayHint: _overlayHint(raw.overlayHint),
        });
    }
    if (decisions.length === 0) throw new Error('no usable decisions for candidate scene indexes');
    return {
        summary: _short(data.summary || '', 220),
        decisions,
    };
}

async function _askTemplateRhythmAI(candidates, scenes, scriptContext, diagnostics, aiInstructions) {
    const candidateIndexes = candidates.map(c => c.index);
    let lastError = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
        const prompt = _buildRhythmPrompt(candidates, scenes, scriptContext, diagnostics, aiInstructions, lastError);
        const maxTokens = Math.min(7000, Math.max(1800, 900 + candidates.length * 85));
        const response = await callAI(prompt, {
            temperature: attempt === 1 ? 0.2 : 0.05,
            maxTokens,
            taskType: 'template',
        });
        try {
            return _parseRhythmDecisionResponse(response, candidateIndexes);
        } catch (error) {
            lastError = error.message;
        }
    }
    throw new Error(lastError || 'Template Rhythm AI returned invalid JSON');
}

function _applyDemotion(scene, candidate, decision) {
    const original = {
        templateHint: scene.templateHint || null,
        templateBgQuery: scene.templateBgQuery || null,
        bgQuery: scene.bgQuery || null,
        keyword: scene.keyword || null,
        stockQuery: scene.stockQuery || null,
        webQuery: scene.webQuery || null,
        sourceHint: scene.sourceHint || null,
        mediaType: scene.mediaType || null,
        mgHint: scene.mgHint || null,
        mediaIntent: scene.mediaIntent || null,
    };

    const sourceHint = decision.sourceHint
        || _sourceHint(scene.sourceHint)
        || _sourceHint(candidate.sourceHint)
        || 'stock';
    const mediaType = _mediaType(decision.mediaType, sourceHint);
    const query = _defaultFootageQuery(scene, candidate, decision);

    scene._templateRhythmOriginal = original;
    scene._templateRhythm = {
        action: 'demote',
        reason: decision.reason,
        fromTemplateType: candidate.type,
        fromTemplateHint: original.templateHint,
        footageQuery: query,
        sourceHint,
        mediaType,
        overlayHint: decision.overlayHint || null,
    };

    scene.templateHint = null;
    scene.templateType = null;
    scene.isListicleOverview = false;
    scene.keyword = query;
    scene.stockQuery = query;
    scene.webQuery = query;
    scene.sourceHint = sourceHint;
    scene.mediaType = mediaType;
    scene.fullscreenMG = null;
    scene._templateBackupFootage = false;
    scene._templateMediaFootage = false;
    scene._templateBackgroundOptional = false;

    if (decision.overlayHint) {
        scene.mgHint = decision.overlayHint;
    }
    if (!_usable(scene.visualIntent)) {
        scene.visualIntent = `Real footage of ${query}`;
    }
    scene.mediaIntent = {
        lane: 'footage',
        strength: 'hard',
        reason: `Template Rhythm AI demoted ${candidate.type}: ${decision.reason}`,
        mediaType,
        sourceHint,
        policy: {
            download: 'normal',
            mediaType,
            sourceHint,
            allowTypeFallback: true,
            allowProviderFallback: true,
            allowStockFallback: true,
            allowedMediaTypes: null,
            allowedSources: null,
        },
    };
}

/**
 * Pre-media AI rhythm pass. Mutates scenes in-place so Step 5 downloads real
 * footage for demoted template beats.
 */
async function runTemplateRhythmWorker(scenes, scriptContext, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    const startedAt = Date.now();

    if (!_envFlagEnabled('EDITOR_AGENT_TEMPLATE_RHYTHM', true)) {
        log('  🎴 [Template Rhythm] disabled by EDITOR_AGENT_TEMPLATE_RHYTHM');
        return { ok: true, skipped: true, changed: 0, kept: 0, demoted: 0 };
    }

    const candidates = _buildTemplateCandidates(scenes);
    if (candidates.length === 0) {
        log('  🎴 [Template Rhythm] no VP template roles to review');
        return { ok: true, changed: 0, kept: 0, demoted: 0 };
    }

    const totalDuration = Number(scriptContext?.totalDuration)
        || Number(scriptContext?.duration)
        || (scenes?.length ? _sceneEnd(scenes[scenes.length - 1]) : 0);
    const diagnostics = _diagnoseRhythm(candidates, totalDuration);
    log(`  🎴 [Template Rhythm] AI reviewing ${candidates.length} VP template role(s), longRuns=${diagnostics.longRuns.length}`);

    let review;
    try {
        review = await _askTemplateRhythmAI(
            candidates,
            scenes || [],
            scriptContext || {},
            diagnostics,
            opts.aiInstructions || ''
        );
    } catch (error) {
        log(`  ⚠️ [Template Rhythm] AI review failed — ${error.message}. Leaving VP template roles unchanged.`);
        return { ok: false, error: error.message, changed: 0, kept: candidates.length, demoted: 0, diagnostics };
    }

    const decisions = new Map(review.decisions.map(d => [Number(d.sceneIndex), d]));
    let kept = 0;
    let demoted = 0;
    let noDecisionKept = 0;
    const applied = [];

    for (const candidate of candidates) {
        const decision = decisions.get(Number(candidate.index));
        if (!decision) {
            noDecisionKept++;
            kept++;
            candidate.scene._templateRhythm = {
                action: 'keep',
                reason: 'AI omitted this candidate; preserved safely',
                fromTemplateType: candidate.type,
            };
            continue;
        }

        // Creator authority: a per-scene directive that PINNED this template
        // (scene._directiveLock includes 'templateHint') must never be demoted by
        // the rhythm worker — the user's explicit order beats the rhythm AI.
        if (decision.action === 'demote' && Array.isArray(candidate.scene._directiveLock) && candidate.scene._directiveLock.includes('templateHint')) {
            kept++;
            candidate.scene._templateRhythm = { action: 'keep', reason: 'creator per-scene directive (locked)', fromTemplateType: candidate.type };
            log(`     keep S${candidate.index} ${candidate.type} (creator directive — overrides rhythm demotion)`);
            continue;
        }

        if (decision.action === 'demote') {
            _applyDemotion(candidate.scene, candidate, decision);
            demoted++;
            applied.push({ ...decision, templateType: candidate.type });
            log(`     demote S${candidate.index} ${candidate.type} → ${candidate.scene.sourceHint}/${candidate.scene.mediaType} "${candidate.scene.keyword}"${decision.overlayHint ? ` + ${decision.overlayHint}` : ''} (${decision.reason})`);
        } else {
            kept++;
            candidate.scene._templateRhythm = {
                action: 'keep',
                reason: decision.reason,
                fromTemplateType: candidate.type,
            };
            log(`     keep S${candidate.index} ${candidate.type} (${decision.reason})`);
        }
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    scriptContext._editorAgent = scriptContext._editorAgent || {};
    scriptContext._editorAgent.templateRhythm = {
        ok: true,
        summary: review.summary || '',
        candidates: candidates.length,
        kept,
        demoted,
        noDecisionKept,
        diagnostics,
        applied,
        elapsedSec: Number(elapsed),
    };

    log(`  ✅ [Template Rhythm] done in ${elapsed}s → kept=${kept}, demoted=${demoted}${noDecisionKept ? `, noDecisionKept=${noDecisionKept}` : ''}`);
    if (review.summary) log(`     summary: ${review.summary}`);
    return {
        ok: true,
        changed: demoted,
        kept,
        demoted,
        noDecisionKept,
        diagnostics,
        summary: review.summary || '',
    };
}

async function runTemplatesWorker(scenes, scriptContext, mgScenes, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    const startedAt = Date.now();
    log(`  🎴 [Templates Worker] dispatching ${scenes.length} scenes to processTemplates (${(mgScenes || []).length} MGs in context)`);

    let result = null;
    try {
        result = await processTemplates(scenes, scriptContext, mgScenes || null, opts.aiInstructions || null);
    } catch (e) {
        log(`  ⚠️ [Templates Worker] processTemplates threw — ${e.message?.slice(0, 120)}`);
        return { ok: false, error: e?.message || String(e), result: null };
    }

    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    const tplCount = Array.isArray(result?.templateScenes)
        ? result.templateScenes.length
        : (Array.isArray(result?.templates) ? result.templates.length : 0);
    log(`  ✅ [Templates Worker] done in ${elapsed}s → ${tplCount} templates assigned`);
    return { ok: true, result };
}

module.exports = {
    runTemplatesWorker,
    runTemplateRhythmWorker,
};
