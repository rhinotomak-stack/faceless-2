/**
 * QA Chat Agent — Developer chat interface to test the QA agent's niche knowledge.
 *
 * Sends text-only messages to Gemini with the full niche system injected as
 * a system instruction. Used to verify the agent's understanding of:
 *   - Niche-specific rules (what footage is acceptable, what to flag)
 *   - Allowed MGs per category
 *   - Replacement source guidance
 *   - Keyword strategy per niche
 *
 * No video input — pure text conversation.
 */

'use strict';

const axios  = require('axios');
const config = require('./config');
const vertex = require('./vertex-auth');
const { getNiche, NICHES, NICHE_PRESETS, getNicheIds } = require('./niches');

// ============ GEMINI ============

function _getGeminiKey() {
    const keys = config.gemini?.apiKeys || (config.gemini?.apiKey ? [config.gemini.apiKey] : []);
    if (!keys.length) throw new Error('No Gemini API key configured');
    return keys[0];
}

function _getModel() {
    return config.gemini?.visionModel || 'gemini-2.0-flash';
}

// ============ SYSTEM PROMPT ============

/**
 * Build a comprehensive system prompt with ALL niche knowledge compiled in.
 * The user can ask about any niche and the agent will answer from this context.
 *
 * @param {string|null} focusNicheId  - If set, this niche gets a full detail block at the top
 * @returns {string}
 */
function buildSystemPrompt(focusNicheId) {
    const parts = [];

    parts.push(`You are the QA Studio AI agent for YTA Empire — a faceless YouTube video generator.
Your job is to analyze rendered video clips and flag issues. You are being tested by the developer to verify your knowledge.
Answer concisely and accurately. If you are unsure, say so clearly.`);

    // ── App overview ──
    parts.push(`
APP OVERVIEW:
- This app generates faceless YouTube videos from narration audio.
- Pipeline: AI Director → AI Visual Planner → footage download → Motion Graphics compositing → WebGL2 render.
- Videos are FACELESS — no host/presenter. If you see someone talking directly to camera = reject.
- There are two content categories: EXPLAINER (educational/documentary) and NEWS (breaking events).
- Niche IDs use dot-notation: explainer.crime, news.military, etc.`);

    // ── MG rules ──
    parts.push(`
MOTION GRAPHICS (MG) RULES:
- EXPLAINER category: rich overlay MG usage is allowed by default, but some explainer sub-niches narrow the list. Always check each niche's resolved allowedMGs below.
- NEWS category: overlay MGs stay minimal/footage-first. Some news sub-niches may expand slightly (for example map-heavy or infographic-heavy niches), so check the resolved niche config below.
- Templates (statCard, factCard, personIntro, etc.) are FULLSCREEN designed screens, separate from overlay MGs.`);

    // ── Provider rules ──
    parts.push(`
FOOTAGE SOURCE RULES:
- Provider access is niche-specific. Most explainer niches avoid Telegram/vkVideo, but some documentary explainers may allow them when the resolved niche config says so.
- NEWS niches usually have broader source access. Use the resolved niche data below for exact exclusions and footage priority.
- Stock providers (Pexels, Pixabay): clean B-roll, generic footage.
- YouTube: documentaries, archival footage, product demos, real-world events.
- Telegram/VK: raw war footage, press briefings, regional government events.`);

    // ── QA scoring ──
    parts.push(`
QA SCORING:
9-10: Perfect — no issues
7-8: Good — minor imperfections, publishable
5-6: Acceptable — notable issue but usable
3-4: Poor — edge watermark croppable, or minor context mismatch
1-2: Reject — center watermark, presenter face, totally wrong content, black frames

VERDICT: pass | review | reject
FIX_STRATEGY: scale (crop+zoom) | floating (switch to float card) | caption_shift (crop caption bar) | flag (replace footage)`);

    // ── All niches compiled ──
    parts.push(`\n${'='.repeat(60)}\nALL NICHES — COMPLETE REFERENCE\n${'='.repeat(60)}`);

    for (const [nicheKey, nicheRaw] of Object.entries(NICHES)) {
        if (nicheKey === 'general') continue;
        const niche = getNiche(nicheKey); // get resolved (with category enforcement)
        const isNews = nicheKey.startsWith('news');
        const isExplainer = nicheKey.startsWith('explainer') || nicheKey === 'explainer';
        const category = isNews ? 'NEWS' : isExplainer ? 'EXPLAINER' : 'GENERAL';

        // Dump the full niche object so the agent automatically knows about any
        // new fields we add (mgRules, templates, search policies, etc.)
        // Strip internal fields (_parent) and large arrays (keywords) to save tokens.
        const { _parent, keywords, ...nicheClean } = niche;
        parts.push(`\n── ${nicheKey} [${category}] ──\n${JSON.stringify(nicheClean, null, 1)}`);
    }

    // General niche
    const gen = getNiche('general');
    const { _parent: _gp, keywords: _gk, ...genClean } = gen;
    parts.push(`\n── general [GENERAL] ──\n${JSON.stringify(genClean, null, 1)}`);

    // ── Focus niche detail (if specified) ──
    if (focusNicheId && NICHES[focusNicheId]) {
        const fn = getNiche(focusNicheId);
        parts.push(`\n${'='.repeat(60)}\nCURRENTLY FOCUSED NICHE: ${focusNicheId}\n${'='.repeat(60)}`);
        parts.push(`This is the niche currently selected in the chat. When the developer asks "what would you do" or "how would you evaluate", answer specifically for this niche.`);
        parts.push(`Full niche data for ${focusNicheId}:\n${JSON.stringify(fn, null, 2)}`);
    }

    parts.push(`\nYou have complete knowledge of all the above. Answer the developer's questions accurately and directly.`);

    return parts.join('\n');
}

// ============ CHAT ============

/**
 * Send a message in a multi-turn conversation.
 *
 * @param {Array<{role:'user'|'model', text:string}>} history - Full conversation so far
 * @param {string} focusNicheId - Currently selected niche (for system context)
 * @returns {Promise<string>} Agent's reply text
 */
async function sendMessage(history, focusNicheId) {
    const model  = _getModel();
    const systemPrompt = buildSystemPrompt(focusNicheId);

    const contents = history.map(m => ({
        role: m.role,
        parts: [{ text: m.text }],
    }));

    const body = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 1500, temperature: 0.3 },
    };

    let url, headers;
    if (vertex.isVertexEnabled()) {
        const auth = await vertex.getVertexAuth(model);
        url = auth.url;
        headers = auth.headers;
    } else {
        const apiKey = _getGeminiKey();
        url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        headers = { 'Content-Type': 'application/json' };
    }

    const RETRYABLE = new Set([429, 500, 502, 503, 504]);
    const delays = [3000, 8000];
    let lastErr;

    for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
            const resp = await axios.post(url, body, { headers, timeout: 60000 });
            return resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '(no response)';
        } catch (err) {
            const status = err.response?.status;
            if (RETRYABLE.has(status) && attempt < delays.length) {
                await new Promise(r => setTimeout(r, delays[attempt]));
                lastErr = err;
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}

/**
 * Get all available niche IDs grouped by category (for the UI dropdown).
 */
function getNicheList() {
    const explainer = [], news = [], other = [];
    for (const key of Object.keys(NICHES)) {
        if (key.startsWith('explainer')) explainer.push(key);
        else if (key.startsWith('news')) news.push(key);
        else other.push(key);
    }
    return { explainer, news, other };
}

// ============ PROJECT-AWARE CHAT ============

/**
 * Build a block describing the current project + QA results for the system prompt.
 * @param {Object} projectContext
 * @param {string} projectContext.title
 * @param {string} projectContext.nicheId
 * @param {string} projectContext.format
 * @param {string} projectContext.themeId
 * @param {string[]} projectContext.entities
 * @param {Array}   projectContext.qaResults  — array of result objects from state.results
 */
function buildProjectPrompt(projectContext) {
    if (!projectContext) return '';
    const parts = [];

    parts.push(`\n${'='.repeat(60)}\nCURRENT PROJECT CONTEXT\n${'='.repeat(60)}`);

    if (projectContext.title)   parts.push(`Title    : "${projectContext.title}"`);
    if (projectContext.nicheId) parts.push(`Niche    : ${projectContext.nicheId}`);
    if (projectContext.format)  parts.push(`Format   : ${projectContext.format}`);
    if (projectContext.themeId) parts.push(`Theme    : ${projectContext.themeId}`);
    if (projectContext.language) parts.push(`Language : ${projectContext.language}`);
    if (projectContext.totalScenes) parts.push(`Scenes   : ${projectContext.totalScenes} total`);
    if (projectContext.totalDuration) {
        const mins = Math.floor(projectContext.totalDuration / 60);
        const secs = Math.round(projectContext.totalDuration % 60);
        parts.push(`Duration : ${mins}m ${secs}s`);
    }
    if (projectContext.entities?.length) {
        parts.push(`Entities : ${projectContext.entities.join(', ')}`);
    }

    // Scene list — compact table so the agent knows every scene
    if (projectContext.sceneList?.length) {
        parts.push(`\nALL SCENES (${projectContext.sceneList.length}):`);
        for (const s of projectContext.sceneList) {
            parts.push(`  #${s.i} [${s.type}] "${s.keyword}" (${s.dur})`);
        }
    }

    const qaResults = projectContext.qaResults || [];
    if (qaResults.length > 0) {
        let pass = 0, review = 0, reject = 0, errors = 0;
        const issueCounts = {};
        const sceneLines = [];

        for (const r of qaResults) {
            if (r.verdict === 'pass')        pass++;
            else if (r.verdict === 'review') review++;
            else if (r.verdict === 'reject') reject++;
            else if (r.verdict === 'error')  errors++;
            for (const issue of (r.issues || [])) {
                issueCounts[issue] = (issueCounts[issue] || 0) + 1;
            }
            const issueStr = r.issues?.length ? ` issues=[${r.issues.join(',')}]` : '';
            const fixStr   = r.cropFix ? ` fix=${r.cropFix}` : (r.fixStrategy ? ` fix=${r.fixStrategy}` : '');
            sceneLines.push(
                `  Scene ${r.sceneIndex} "${r.keyword || '?'}": score=${r.score ?? '?'} verdict=${r.verdict}${issueStr}${fixStr}`
            );
        }

        parts.push(`\nQA RUN — ${qaResults.length} scenes analyzed:`);
        parts.push(`  Pass=${pass}  Review=${review}  Reject=${reject}${errors ? `  Errors=${errors}` : ''}`);
        if (Object.keys(issueCounts).length) {
            const breakdown = Object.entries(issueCounts)
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');
            parts.push(`  Issue breakdown: ${breakdown}`);
        }
        parts.push(`\nPer-scene breakdown:`);
        parts.push(sceneLines.join('\n'));
    } else {
        parts.push(`\nQA results: not yet run (no scenes analyzed).`);
    }

    parts.push(`\nUse this project context when the developer asks about "this video", "current project", "these scenes", etc.`);
    return parts.join('\n');
}

/**
 * Send a message in the QA Studio embedded chat.
 * Has full niche knowledge + current project/QA results injected.
 *
 * @param {Array<{role:'user'|'model', text:string}>} history
 * @param {Object} projectContext  — { title, nicheId, format, themeId, entities, qaResults }
 */
async function sendMessageWithProject(history, projectContext) {
    const model  = _getModel();

    const nicheId = projectContext?.nicheId || null;
    const systemPrompt = buildSystemPrompt(nicheId) + buildProjectPrompt(projectContext);

    const contents = history.map(m => ({
        role: m.role,
        parts: [{ text: m.text }],
    }));

    const body = {
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { maxOutputTokens: 1500, temperature: 0.3 },
    };

    let url, headers;
    if (vertex.isVertexEnabled()) {
        const auth = await vertex.getVertexAuth(model);
        url = auth.url;
        headers = auth.headers;
    } else {
        const apiKey = _getGeminiKey();
        url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
        headers = { 'Content-Type': 'application/json' };
    }

    const RETRYABLE = new Set([429, 500, 502, 503, 504]);
    const delays = [3000, 8000];
    let lastErr;

    for (let attempt = 0; attempt <= delays.length; attempt++) {
        try {
            const resp = await axios.post(url, body, { headers, timeout: 60000 });
            return resp.data?.candidates?.[0]?.content?.parts?.[0]?.text || '(no response)';
        } catch (err) {
            const status = err.response?.status;
            if (RETRYABLE.has(status) && attempt < delays.length) {
                await new Promise(r => setTimeout(r, delays[attempt]));
                lastErr = err;
                continue;
            }
            throw err;
        }
    }
    throw lastErr;
}

module.exports = { sendMessage, sendMessageWithProject, buildSystemPrompt, buildProjectPrompt, getNicheList };
