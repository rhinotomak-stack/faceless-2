'use strict';
/**
 * presenter-director.js — the AGENTIC owner of talking-head presenter placement.
 *
 * Same shape as effects-director / sound-designer / transition-director: ONE cached
 * brain call, disk-cached (.hf-presenter-cache.json), graceful fallback to the
 * deterministic floor (presenter-assignment.js) when disabled/fails.
 *
 * The agent decides — from the SCRIPT, with DOCTRINE, NOT caps — which moments show
 * the on-camera presenter, HOW LONG each hold runs (a SPAN across consecutive beats),
 * the LOOK (fullframe / framed), and HOW HEAVILY to decorate the hold with graphics.
 * The number and length of holds emerge from the content; there is no fixed budget.
 *
 * Flag: HF_PRESENTER_DIRECTOR=0 disables → deterministic floor. Runs at Step 3.4
 * (before the Visual Planner) so maps yield and footage is skipped on presenter beats.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { callAI } = require('../../brain/ai-provider');

function isDisabled() {
    return /^(0|false|off|no)$/i.test(String(process.env.HF_PRESENTER_DIRECTOR || '').trim());
}
const PIP_ENABLED = /^(1|true|on|yes)$/i.test(String(process.env.HF_PRESENTER_PIP || '').trim());

const LAYOUTS = new Set(['framed', 'split', 'pip', 'fullframe']);
const DECOR = new Set(['light', 'normal', 'heavy']);
const SIDES = new Set(['left', 'right']);

function _zone(scene, sc) {
    const mid = ((scene.startTime || 0) + (scene.endTime || scene.startTime || 0)) / 2;
    if (mid <= (sc.hookEndTime || 0)) return 'hook';
    if (mid >= (sc.ctaStartTime || Infinity)) return 'cta';
    return 'body';
}

function buildPrompt(scenes, sc) {
    const total = scenes.length ? Number(scenes[scenes.length - 1].endTime || 0) : 0;
    const lines = scenes.map(s => {
        const dur = Math.max(0, Number(s.endTime || 0) - Number(s.startTime || 0));
        const txt = String(s.text || '').replace(/\s+/g, ' ').trim().slice(0, 120);
        return `#${s.index} t=${Number(s.startTime || 0).toFixed(0)}s dur=${dur.toFixed(1)}s zone=${_zone(s, sc)} class=${s.sceneClass || '-'} | ${txt}`;
    }).join('\n');

    return `You are the PRESENTER DIRECTOR for a talking-head YouTube video (theme "${sc.themeId || 'standard'}", niche "${sc.nicheId || 'general'}", ~${Math.round(total)}s, ${scenes.length} beats).

There is ONE recurring on-camera presenter (a person). Your ONLY job: decide WHERE the presenter appears, for HOW LONG, and HOW it looks — like a real human documentary/YouTube editor.

DOCTRINE (follow like a seasoned editor — these are instructions, NOT quotas):
• The video is B-ROLL-DOMINANT. The presenter is the EXCEPTION, not the default. MOST beats stay pure B-roll.
• Bring the presenter in ONLY where a person on camera genuinely adds weight: the hook/intro, a strong opinion or claim, a memorable quote, an emotional turn, the CTA/outro.
• NEVER put the presenter on routine explanatory B-roll (a place, an object, a process shot).
• A presenter appearance is a HOLD, not a blink: it usually SPANS several consecutive beats (~6–15s) so the host can actually say something, while graphics/B-roll cut in over them. Prefer a few meaningful HOLDS over many one-beat flashes.
• Choose the LOOK per hold:
   - "framed" (default) = the presenter in a tasteful card on a themed background (NEVER full-screen; a flat full-frame photo isn't right). Best when the presenter is the focus (hook, opinion, quote, CTA).
   - "split" = SPLIT SCREEN: presenter on one side, relevant B-roll on the other — perfect for "explaining X while SHOWING X" (a statistic, a place, an object, a process). Use split when there's a concrete thing to show alongside the talk. Optionally set "side":"left"|"right" for the presenter.${PIP_ENABLED ? '\n   - "pip" = host small in a corner over B-roll for a quick aside (rare).' : ''}
• DECORATE the hold so it never sits dead: "heavy" = layer lots of word-synced icons/photos/lower-thirds over the host (dynamic, modern); "normal" = some; "light" = mostly clean. Longer holds → decorate heavier.
• There is NO limit on how many holds — decide from the CONTENT. A tight 3-min video might have 2 holds; a rich 12-min one might have 8. Trust the script.
• Do NOT overlap spans. Keep holds spread out (don't stack two back-to-back).

BEATS:
${lines}

Return ONLY JSON:
{"spans":[{"start":<beat#>,"end":<beat#>,"layout":"framed|split${PIP_ENABLED ? '|pip' : ''}","side":"left|right","decorate":"light|normal|heavy","reason":"why a person on camera earns this moment"}]}
("side" is optional and only used for split.)
start/end are beat numbers (end>=start; a hold of several beats reads as one continuous shot). Empty spans [] is valid if the presenter genuinely shouldn't appear.`;
}

function parse(text, scenes) {
    if (typeof text !== 'string') return null;
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    if (s < 0 || e <= s) return null;
    let obj;
    try { obj = JSON.parse(text.slice(s, e + 1)); } catch (_) { return null; }
    if (!obj || !Array.isArray(obj.spans)) return null;

    const idxSet = new Set(scenes.map(s => s.index));
    const byIdx = new Map(scenes.map(s => [s.index, s]));
    const minIdx = Math.min(...scenes.map(s => s.index));
    const maxIdx = Math.max(...scenes.map(s => s.index));
    const MAX_HOLD_SECONDS = 20; // a hold longer than this is almost certainly a hallucinated end
    const out = [];
    for (const sp of obj.spans) {
        let start = Math.round(Number(sp.start));
        let end = Math.round(Number(sp.end));
        if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
        if (end < start) [start, end] = [end, start];
        start = Math.max(minIdx, start);
        end = Math.min(maxIdx, end);
        // require at least the start index to be a real beat
        if (!idxSet.has(start)) continue;
        // Clamp hold LENGTH: an oversized/hallucinated end (e.g. {start:2,end:999}) must
        // NOT silently become "the rest of the video". Cap the hold to ~20s wall-clock
        // from the start beat (mirrors the floor's holdSeconds ceiling).
        const _startScene = byIdx.get(start);
        if (_startScene) {
            const _s0 = Number(_startScene.startTime || 0);
            while (end > start) {
                const _endScene = byIdx.get(end);
                if (_endScene && (Number(_endScene.endTime || _endScene.startTime || 0) - _s0) > MAX_HOLD_SECONDS) end--;
                else break;
            }
        }
        let layout = String(sp.layout || 'framed').toLowerCase();
        if (!LAYOUTS.has(layout)) layout = 'framed';
        if (layout === 'fullframe') layout = 'framed'; // fullscreen presenter removed — always framed
        if (layout === 'pip' && !PIP_ENABLED) layout = 'framed';
        let decorate = String(sp.decorate || 'normal').toLowerCase();
        if (!DECOR.has(decorate)) decorate = 'normal';
        const side = SIDES.has(String(sp.side || '').toLowerCase()) ? String(sp.side).toLowerCase() : undefined;
        out.push({ startSceneIndex: start, endSceneIndex: end, layout, side, decorate, reason: String(sp.reason || '').slice(0, 140) });
    }
    if (!out.length) return [];
    // sort + drop overlaps (keep earliest; presenter spans must not overlap)
    out.sort((a, b) => a.startSceneIndex - b.startSceneIndex);
    const clean = [];
    let lastEnd = -Infinity;
    for (const sp of out) {
        if (sp.startSceneIndex <= lastEnd) continue; // overlaps previous → drop
        clean.push(sp);
        lastEnd = sp.endSceneIndex;
    }
    return clean;
}

/**
 * @returns {Promise<Array|null>} presenter spans (agentic), or null → caller uses the floor.
 */
async function directPresenter(scenes, scriptContext, opts = {}) {
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    if (isDisabled()) return null;
    if (!Array.isArray(scenes) || scenes.length < 2) return null;
    if (!scriptContext || scriptContext.productionMode !== 'talkingHead') return null;
    if (!scriptContext.presenter || !scriptContext.presenter.imageFile) return null;

    const hash = crypto.createHash('sha1')
        .update(JSON.stringify(scenes.map(s => [s.index, String(s.text || '').slice(0, 100), s.sceneClass || ''])) + '|' + PIP_ENABLED)
        .digest('hex').slice(0, 16);
    const cachePath = opts.projectDir ? path.join(opts.projectDir, '.hf-presenter-cache.json') : null;
    if (cachePath && fs.existsSync(cachePath)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (cached && cached.hash === hash && Array.isArray(cached.spans)) {
                log(`  🎤 [Presenter Director] ${cached.spans.length} hold(s) from cache (0 AI calls)`);
                return cached.spans;
            }
        } catch (_) { /* stale */ }
    }

    let spans = null;
    try {
        const text = await callAI(buildPrompt(scenes, scriptContext), { maxTokens: 1800, temperature: 0.6, taskType: 'brain' });
        spans = parse(text, scenes);
    } catch (e) {
        log(`  ⚠️ [Presenter Director] AI call failed: ${String(e.message || e).slice(0, 110)} — using deterministic floor`);
        return null;
    }
    if (spans === null) { log('  ⚠️ [Presenter Director] unparseable response — using deterministic floor'); return null; }

    if (cachePath) { try { fs.writeFileSync(cachePath, JSON.stringify({ hash, spans })); } catch (_) { /* non-fatal */ } }
    const beats = spans.reduce((n, s) => n + (s.endSceneIndex - s.startSceneIndex + 1), 0);
    log(`  🎤 [Presenter Director] ${spans.length} presenter hold(s) across ${beats} beat(s) (1 AI call)`);
    return spans;
}

module.exports = { directPresenter, isDisabled, parse, buildPrompt };
