/**
 * Directive Compiler — turns the creator's one free-text "AI Instructions"
 * order into a SINGLE structured `directives` object that every build stage
 * can read the same way.
 *
 * Today the free-text order is a raw string interpolated into a few prompts and
 * prepended (unstructured) to text-brain calls. ~4 of 6 "agentic" workers, the
 * framing pass, and the whole media/vision layer never see it, and it is never
 * persisted (a resume silently drops it). This module is the substrate that
 * fixes that: compile once → thread on scriptContext._directives → persist into
 * video-plan.json → each stage reads its slice via renderDirectivesBlock().
 *
 * Pattern mirrors the FX/Transition directors exactly:
 *   env-gate → callAI({taskType:'brain'}) → brace-slice JSON.parse →
 *   sha1 disk cache (.hf-directives-cache.json) → deterministic regex FLOOR.
 *
 * Authority model (locked): the creator's order WINS over niche/theme house
 * rules on creative/content/style choices — only technical safety floors
 * (watermark/broken-media rejection, render integrity) stay unoverridable. So
 * compiled directives always carry overrideHouseRules:true.
 *
 * Flags:
 *   DIRECTIVE_COMPILER=0        → whole feature off → returns null (OFF = today).
 *   AI_INSTRUCTIONS_GLOBAL=0    → also disables (shares the global kill-switch).
 *   DIRECTIVE_COMPILER_AI=0     → keep the feature, skip the AI call, use the
 *                                 deterministic regex floor (offline / fast builds).
 * Cost: 1 AI call per build, disk-cached; a cache hit is instant.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { callAI } = require('../brain/ai-provider');
const { resolveMGAlias } = require('./directive-util');

// Optional registries — validate compiled ids against the real vocabulary when
// available, but degrade gracefully if a registry is missing.
let GRADE_IDS = [];
try { ({ GRADE_IDS } = require('../render/hf-effects')); } catch (_) { /* registry optional */ }

const FRAMINGS = new Set(['fullscreen', 'cinematic', 'floating']);
const SOURCE_FAMILIES = new Set(['stock', 'youtube', 'web-image', 'reddit', 'ai-video']);
const TRANSITION_STYLES = new Set(['hard-cuts', 'motivated']);
const MAP_WANTS = new Set(['more', 'fewer', 'none']);
const PACING_SPEEDS = new Set(['fast', 'slow']);
// Per-scene / time-targeted directive vocabulary.
const WHEN_KINDS = new Set(['time', 'range', 'first', 'sceneIndex', 'sceneRange']);
const SETTABLE = new Set(['fullscreenMG', 'templateHint', 'framing', 'transition', 'mediaType', 'sourceHint', 'keyword', 'effect']);
const MEDIA_TYPES = new Set(['video', 'image']);
// Mirrors TRANSITION_VOCAB in transition-director.js / the bridge runtime.
const TRANSITION_TYPES = new Set(['cut', 'crossfade', 'blur-dissolve', 'push-left', 'push-right', 'push-up', 'wipe-left', 'wipe-right', 'wipe-up', 'whip-left', 'whip-right', 'zoom-punch', 'zoom-pull', 'spin-settle', 'flash-white', 'dip-black', 'light-sweep', 'glitch', 'fire-burn', 'lens-flare']);

function _off(v) { return /^(0|false|off|no)$/i.test(String(v || '').trim()); }

function isDisabled() {
    return _off(process.env.DIRECTIVE_COMPILER === undefined ? '' : process.env.DIRECTIVE_COMPILER)
        || _off(process.env.AI_INSTRUCTIONS_GLOBAL);
}
function _aiDisabled() {
    return _off(process.env.DIRECTIVE_COMPILER_AI === undefined ? '' : process.env.DIRECTIVE_COMPILER_AI);
}

function _boolish(re, lower) { return re.test(lower); }
function _uniq(arr) { return [...new Set((arr || []).filter(Boolean))]; }

// ── Deterministic FLOOR ──────────────────────────────────────────────────────
// Regex-derived structured directives. Runs when the AI is off/unreachable so
// the creator still gets structured steering (never a hard dependency on a
// brain call). Kept intentionally simple — it mirrors the intents the Visual
// Planner already parses in _parseVisualInstructionPrefs, mapped to our shape.
function directivesFloor(rawInstructions = '') {
    const raw = String(rawInstructions || '').trim();
    if (!raw) return null;
    const lower = raw.toLowerCase();
    const d = { raw, summary: raw.slice(0, 200), overrideHouseRules: true, _floor: true };

    // footage
    const footage = {};
    if (_boolish(/\b(?:no|avoid|without|don't use|dont use)\s+(?:any\s+)?stock\b/, lower)) footage.avoidStock = true;
    if (_boolish(/\b(?:real|raw|authentic)\s+(?:footage|video|clips?)\b/, lower) || /\bprefer real footage\b/.test(lower)) footage.preferReal = true;
    if (_boolish(/\b(?:use|prefer|more)\s+(?:images|photos|stills)\b/, lower)) footage.preferImages = true;
    if (_boolish(/\b(?:use|prefer|more)\s+(?:video|videos|footage|clips)\b/, lower)) footage.preferVideos = true;
    const banned = [], preferred = [];
    const srcPats = [
        { s: 'stock', ban: /\b(?:no|avoid|don't use|dont use)\s+stock\b/, pref: /\b(?:prefer|use|more)\s+stock\b/ },
        { s: 'youtube', ban: /\b(?:no|avoid|don't use|dont use)\s+youtube\b/, pref: /\b(?:prefer|use|more)\s+youtube\b/ },
        { s: 'web-image', ban: /\b(?:no|avoid|don't use|dont use)\s+(?:web[-\s]?images?|bing)\b/, pref: /\b(?:prefer|use|more)\s+(?:web[-\s]?images?|bing)\b/ },
        { s: 'reddit', ban: /\b(?:no|avoid|don't use|dont use)\s+reddit\b/, pref: /\b(?:prefer|use|more)\s+reddit\b/ },
    ];
    for (const p of srcPats) { if (p.ban.test(lower)) banned.push(p.s); if (p.pref.test(lower)) preferred.push(p.s); }
    if (footage.avoidStock && !banned.includes('stock')) banned.push('stock');
    if (banned.length) footage.bannedSources = _uniq(banned);
    if (preferred.length) footage.preferredSources = _uniq(preferred);
    if (Object.keys(footage).length) d.footage = footage;

    // effects
    const effects = {};
    if (_boolish(/\bno\s+(?:film\s+)?grain\b|\bno\s+texture\b|\bclean\s+(?:look|image|grade)\b|\bno\s+film\s+look\b/, lower)) effects.noGrain = true;
    if (Object.keys(effects).length) d.effects = effects;

    // transitions
    if (_boolish(/\b(?:hard\s+cuts?\s+only|only\s+hard\s+cuts?|cuts?\s+only|no\s+transitions?|no\s+(?:fancy\s+)?transitions?|straight\s+cuts?)\b/, lower)) {
        d.transitions = { style: 'hard-cuts' };
    }

    // framing
    let force = null;
    if (_boolish(/\b(?:use|prefer|mostly|keep(?:\s+everything)?)\s+fullscreen\b|\beverything\s+fullscreen\b|\ball\s+fullscreen\b/, lower)) force = 'fullscreen';
    else if (_boolish(/\b(?:use|prefer|more)\s+floating\b/, lower)) force = 'floating';
    else if (_boolish(/\b(?:use|prefer|more)\s+cinematic\b/, lower)) force = 'cinematic';
    if (force) d.framing = { force };

    // graphics
    const graphics = {};
    if (_boolish(/\b(?:use|prefer|more)\s+(?:templates?|infographics?|cards?)\b/, lower)) graphics.moreTemplates = true;
    if (_boolish(/\b(?:no|avoid|less|fewer|minimal)\s+(?:templates?|infographics?|cards?)\b/, lower)) graphics.fewerTemplates = true;
    if (_boolish(/\b(?:use|prefer|more)\s+(?:graphics|motion graphics|mgs?|overlays)\b/, lower)) graphics.moreMGs = true;
    if (_boolish(/\b(?:no|avoid|less|fewer|minimal)\s+(?:graphics|motion graphics|mgs?|overlays)\b/, lower)) graphics.fewerMGs = true;
    if (Object.keys(graphics).length) d.graphics = graphics;

    // icons — "no icons OVER faces" must NOT read as "no icons at all" (negative lookahead).
    const icons = {};
    if (_boolish(/\b(?:no|without|zero)\s+(?:explainer\s+)?icons?\b(?!\s+over)/, lower)) icons.allow = false;
    if (_boolish(/\b(?:no|avoid|never|keep)\s+icons?\s+(?:over|off)\s+(?:faces?|the\s+face|people)\b|\bicons?\s+off\s+(?:the\s+)?faces?\b/, lower)) icons.avoidOverFaces = true;
    if (Object.keys(icons).length) d.icons = icons;

    // maps
    if (_boolish(/\b(?:no|without|avoid)\s+maps?\b/, lower)) d.maps = { want: 'none' };
    else if (_boolish(/\b(?:use|prefer|more|lots of|add)\s+maps?\b|\bmap animation\b|\b(?:map[\s-]*charts?|route[\s-]*maps?|locator[\s-]*maps?)\b/, lower)) d.maps = { want: 'more' };
    else if (_boolish(/\b(?:less|fewer)\s+maps?\b/, lower)) d.maps = { want: 'fewer' };

    // pacing
    if (_boolish(/\b(?:fast|faster|snappy|quick|energetic)\s+(?:pacing|pace|edit|cuts?)\b|\bfast[-\s]?paced\b/, lower)) d.pacing = { speed: 'fast' };
    else if (_boolish(/\b(?:slow|slower|calm|relaxed)\s+(?:pacing|pace|edit)\b|\bslow[-\s]?paced\b/, lower)) d.pacing = { speed: 'slow' };

    return d;
}

// ── AI compile ───────────────────────────────────────────────────────────────
function _buildPrompt(raw, ctx) {
    const grades = (GRADE_IDS && GRADE_IDS.length) ? GRADE_IDS.join(', ') : '(theme default)';
    return `You are the PRODUCTION SUPERVISOR translating a video creator's free-text order into a structured control object for an automated faceless-video pipeline (current theme "${ctx.themeId || 'standard'}", niche "${ctx.nicheId || 'general'}", mode "${ctx.productionMode || 'faceless'}").

THE CREATOR'S ORDER (verbatim):
"""
${raw}
"""

Translate it into JSON. Populate ONLY the fields the creator actually spoke to — leave everything else out (an empty/absent field means "no opinion, use pipeline defaults"). Do NOT invent preferences. The creator's word overrides niche/theme defaults.

Controllable knobs and their allowed values:
- footage: { preferReal:bool, avoidStock:bool, preferImages:bool, preferVideos:bool, bannedSources:[...], preferredSources:[...] }  sources ∈ {stock, youtube, web-image, reddit}
- effects: { grade:one of [${grades}], noGrain:bool, era:string, notes:[short strings] }   (noGrain = keep the image clean, no film grain/texture)
- transitions: { style:"hard-cuts"|"motivated", banned:[transition names], notes:[...] }   ("hard-cuts" = only straight cuts, no crossfades/whips/zooms)
- framing: { force:"fullscreen"|"cinematic"|"floating", notes:[...] }   (force = make EVERY scene this framing)
- graphics: { moreTemplates:bool, fewerTemplates:bool, moreMGs:bool, fewerMGs:bool, bannedTypes:[type names], notes:[...] }
- icons: { allow:bool, avoidOverFaces:bool, notes:[...] }   (allow:false = no explainer icons/photos over footage at all)
- maps: { want:"more"|"fewer"|"none", notes:[...] }
- pacing: { speed:"fast"|"slow", notes:[...] }
- perScene: [{ when, set }]  — ONLY when the order names a specific TIME or SCENE ("in the first 10s", "at 0:30", "scene 5", "scenes 5-8", "from 0:20 to 0:40"). Omit entirely otherwise.
    when = { kind:"time", at:30 } | { kind:"range", from:20, to:40 } | { kind:"first", to:10 } | { kind:"sceneIndex", sceneFrom:5 } | { kind:"sceneRange", sceneFrom:5, sceneTo:8 }   (scene numbers are 1-based, as the user says them)
    set  = any of { fullscreenMG:"mapChart"|..., templateHint:"statCard"|..., framing:"fullscreen"|"cinematic"|"floating", transition:{type:"cut"}, mediaType:"video"|"image", sourceHint:"stock"|"youtube"|"web-image"|"reddit"|"ai-video", keyword:"...", effect:{noGrain:true,grade:"..."} }
    (use sourceHint:"ai-video" ONLY when the user explicitly asks to generate/AI-make that scene's footage)
    (e.g. "put a map at 0:30" → {"when":{"kind":"time","at":30},"set":{"fullscreenMG":"mapChart"}}; "hard cut on scene 3" → {"when":{"kind":"sceneIndex","sceneFrom":3},"set":{"transition":{"type":"cut"}}})
- summary: one short sentence restating the order in your own words (always include this).

Respond with ONLY the JSON object, e.g.:
{"summary":"Clean hard-cut edit, all fullscreen, no maps","transitions":{"style":"hard-cuts"},"framing":{"force":"fullscreen"},"effects":{"noGrain":true},"maps":{"want":"none"}}`;
}

function _parse(text) {
    if (!text) return null;
    const t = String(text).replace(/```(?:json)?/gi, '').trim();
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(t.slice(start, end + 1)); } catch (_) { return null; }
}

function _str(v, max = 200) { return v == null ? '' : String(v).slice(0, max); }
function _notes(v) { return Array.isArray(v) ? v.map(n => _str(n, 120)).filter(Boolean).slice(0, 6) : []; }
function _bool(v) { return v === true || /^(1|true|yes|on)$/i.test(String(v)); }

// ── Per-scene / time-targeted coercion ──────────────────────────────────────
function _coerceWhen(w) {
    if (!w || typeof w !== 'object' || !WHEN_KINDS.has(String(w.kind))) return null;
    const kind = String(w.kind);
    if (kind === 'time') { const at = Number(w.at); return Number.isFinite(at) ? { kind, at } : null; }
    if (kind === 'range') { const from = Number(w.from), to = Number(w.to); return (Number.isFinite(from) && Number.isFinite(to) && to > from) ? { kind, from, to } : null; }
    if (kind === 'first') { const to = Number(w.to != null ? w.to : w.at); return (Number.isFinite(to) && to > 0) ? { kind, to } : null; }
    if (kind === 'sceneIndex') { const n = parseInt(w.sceneFrom != null ? w.sceneFrom : w.at, 10); return (Number.isFinite(n) && n >= 1) ? { kind, sceneFrom: n } : null; }
    if (kind === 'sceneRange') { const a = parseInt(w.sceneFrom, 10), b = parseInt(w.sceneTo, 10); return (Number.isFinite(a) && Number.isFinite(b) && b >= a) ? { kind, sceneFrom: a, sceneTo: b } : null; }
    return null;
}

function _coerceSet(s) {
    if (!s || typeof s !== 'object') return null;
    const out = {};
    if (s.fullscreenMG) { const t = resolveMGAlias(s.fullscreenMG); if (t) out.fullscreenMG = t; }
    if (s.templateHint) { const t = resolveMGAlias(s.templateHint); if (t) out.templateHint = t; }
    if (s.framing && FRAMINGS.has(String(s.framing))) out.framing = String(s.framing);
    if (s.transition) {
        const raw = (typeof s.transition === 'string') ? s.transition : (s.transition.type || s.transition.t);
        const type = String(raw || '').trim().toLowerCase();
        if (TRANSITION_TYPES.has(type)) {
            const d = Number(typeof s.transition === 'object' ? s.transition.duration : NaN);
            out.transition = { type, duration: type === 'cut' ? 0 : (Number.isFinite(d) ? d : 0.5) };
        }
    }
    if (s.mediaType && MEDIA_TYPES.has(String(s.mediaType))) out.mediaType = String(s.mediaType);
    if (s.sourceHint && SOURCE_FAMILIES.has(String(s.sourceHint))) out.sourceHint = String(s.sourceHint);
    if (s.keyword) out.keyword = _str(s.keyword, 80);
    if (s.effect && typeof s.effect === 'object') {
        const e = {};
        if (_bool(s.effect.noGrain)) e.noGrain = true;
        if (s.effect.grade && (!GRADE_IDS.length || GRADE_IDS.includes(String(s.effect.grade)))) e.grade = String(s.effect.grade);
        if (Object.keys(e).length) out.effect = e;
    }
    return Object.keys(out).length ? out : null;
}

function _coerceRemove(r) {
    if (!r || typeof r !== 'object') return null;
    const fields = Object.keys(r).filter(k => SETTABLE.has(k));
    return fields.length ? fields : null;
}

function _coercePerScene(arr) {
    if (!Array.isArray(arr)) return null;
    const out = [];
    for (const entry of arr.slice(0, 40)) {
        if (!entry || typeof entry !== 'object') continue;
        const when = _coerceWhen(entry.when);
        if (!when) continue;
        const set = _coerceSet(entry.set);
        const remove = _coerceRemove(entry.remove);
        if (!set && !remove) continue;
        const e = { raw: _str(entry.raw, 120), when };
        if (set) e.set = set;
        if (remove) e.remove = remove;
        out.push(e);
    }
    return out.length ? out : null;
}

// Whitelist/coerce the model output into the strict contract. Authority
// (overrideHouseRules) is a fixed policy decision, not the model's to make.
function _coerce(obj, raw) {
    if (!obj || typeof obj !== 'object') return null;
    const out = { raw, summary: _str(obj.summary, 200) || raw.slice(0, 200), overrideHouseRules: true };

    if (obj.footage && typeof obj.footage === 'object') {
        const f = {};
        for (const k of ['preferReal', 'avoidStock', 'preferImages', 'preferVideos']) if (_bool(obj.footage[k])) f[k] = true;
        const bs = (Array.isArray(obj.footage.bannedSources) ? obj.footage.bannedSources : []).map(s => String(s).toLowerCase()).filter(s => SOURCE_FAMILIES.has(s));
        const ps = (Array.isArray(obj.footage.preferredSources) ? obj.footage.preferredSources : []).map(s => String(s).toLowerCase()).filter(s => SOURCE_FAMILIES.has(s));
        if (f.avoidStock && !bs.includes('stock')) bs.push('stock');
        if (bs.length) f.bannedSources = _uniq(bs);
        if (ps.length) f.preferredSources = _uniq(ps);
        if (Object.keys(f).length) out.footage = f;
    }
    if (obj.effects && typeof obj.effects === 'object') {
        const e = {};
        if (obj.effects.grade && (!GRADE_IDS.length || GRADE_IDS.includes(String(obj.effects.grade)))) e.grade = String(obj.effects.grade);
        if (_bool(obj.effects.noGrain)) e.noGrain = true;
        if (obj.effects.era) e.era = _str(obj.effects.era, 40);
        const n = _notes(obj.effects.notes); if (n.length) e.notes = n;
        if (Object.keys(e).length) out.effects = e;
    }
    if (obj.transitions && typeof obj.transitions === 'object') {
        const t = {};
        if (TRANSITION_STYLES.has(String(obj.transitions.style))) t.style = String(obj.transitions.style);
        if (Array.isArray(obj.transitions.banned)) { const b = obj.transitions.banned.map(x => _str(x, 24)).filter(Boolean).slice(0, 12); if (b.length) t.banned = b; }
        const n = _notes(obj.transitions.notes); if (n.length) t.notes = n;
        if (Object.keys(t).length) out.transitions = t;
    }
    if (obj.framing && typeof obj.framing === 'object') {
        const fr = {};
        if (FRAMINGS.has(String(obj.framing.force))) fr.force = String(obj.framing.force);
        const n = _notes(obj.framing.notes); if (n.length) fr.notes = n;
        if (Object.keys(fr).length) out.framing = fr;
    }
    if (obj.graphics && typeof obj.graphics === 'object') {
        const g = {};
        for (const k of ['moreTemplates', 'fewerTemplates', 'moreMGs', 'fewerMGs']) if (_bool(obj.graphics[k])) g[k] = true;
        if (Array.isArray(obj.graphics.bannedTypes)) { const b = obj.graphics.bannedTypes.map(x => _str(x, 32)).filter(Boolean).slice(0, 16); if (b.length) g.bannedTypes = b; }
        const n = _notes(obj.graphics.notes); if (n.length) g.notes = n;
        if (Object.keys(g).length) out.graphics = g;
    }
    if (obj.icons && typeof obj.icons === 'object') {
        const ic = {};
        if (obj.icons.allow === false || /^(0|false|no|off)$/i.test(String(obj.icons.allow))) ic.allow = false;
        if (_bool(obj.icons.avoidOverFaces)) ic.avoidOverFaces = true;
        const n = _notes(obj.icons.notes); if (n.length) ic.notes = n;
        if (Object.keys(ic).length) out.icons = ic;
    }
    if (obj.maps && typeof obj.maps === 'object' && MAP_WANTS.has(String(obj.maps.want))) {
        out.maps = { want: String(obj.maps.want) };
        const n = _notes(obj.maps.notes); if (n.length) out.maps.notes = n;
    }
    if (obj.pacing && typeof obj.pacing === 'object' && PACING_SPEEDS.has(String(obj.pacing.speed))) {
        out.pacing = { speed: String(obj.pacing.speed) };
        const n = _notes(obj.pacing.notes); if (n.length) out.pacing.notes = n;
    }
    // Per-scene / time-targeted directives — omitted entirely when the order
    // names no time/scene, so unrelated orders stay byte-identical.
    const ps = _coercePerScene(obj.perScene);
    if (ps) out.perScene = ps;
    return out;
}

/**
 * Compile the creator's free-text order into a structured `directives` object.
 * @returns {Promise<object|null>} directives, or null when off / no order.
 */
async function compileDirectives(directorsBrief, ctx = {}, opts = {}) {
    if (isDisabled()) return null;
    const raw = String(directorsBrief?.freeInstructions || process.env.AI_INSTRUCTIONS || '').trim();
    if (!raw) return null;
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);

    // AI sub-gate off → deterministic floor only (offline / fast builds).
    if (_aiDisabled()) {
        const floor = directivesFloor(raw);
        if (floor) log(`  🚦 [Directive Compiler] floor-only (AI off): ${floor.summary}`);
        return floor;
    }

    const cachePath = opts.projectDir ? path.join(opts.projectDir, '.hf-directives-cache.json') : null;
    const hash = crypto.createHash('sha1')
        .update(JSON.stringify(['v2', raw, ctx.themeId || '', ctx.nicheId || '', ctx.productionMode || '']))
        .digest('hex').slice(0, 16);
    if (cachePath && fs.existsSync(cachePath)) {
        try {
            const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
            if (cached && cached.hash === hash && cached.directives) {
                log(`  🚦 [Directive Compiler] "${cached.directives.summary || raw.slice(0, 60)}" (from cache, 0 AI calls)`);
                return cached.directives;
            }
        } catch (_) { /* stale — recompute */ }
    }

    let directives = null;
    try {
        const text = await callAI(_buildPrompt(raw, ctx), { maxTokens: 900, temperature: 0.2, taskType: 'brain' });
        directives = _coerce(_parse(text), raw);
    } catch (e) {
        log(`  ⚠️ [Directive Compiler] AI call failed: ${String(e.message || e).slice(0, 110)} — using deterministic floor`);
    }
    if (!directives) directives = directivesFloor(raw);
    if (!directives) return null;

    if (cachePath && !directives._floor) {
        try { fs.writeFileSync(cachePath, JSON.stringify({ hash, directives })); } catch (_) { /* non-fatal */ }
    }
    log(`  🚦 [Directive Compiler] "${directives.summary}" (${directives._floor ? 'floor' : '1 AI call'})`);
    return directives;
}

// ── Prompt block rendering ────────────────────────────────────────────────────
// Every stage calls this with its own key. Returns '' when there's nothing to
// say for that stage → OFF builds and unrelated orders stay byte-identical.
function renderDirectivesBlock(directives, stageKey) {
    if (!directives || typeof directives !== 'object') return '';
    const lines = [];
    const push = (s) => { if (s) lines.push(`- ${s}`); };

    switch (stageKey) {
        case 'effects': {
            const e = directives.effects || {};
            if (e.noGrain) push('Keep the image CLEAN — do NOT add film grain, texture, or a heavy film look.');
            if (e.grade) push(`Use the "${e.grade}" color grade.`);
            if (e.era) push(`Era look requested: ${e.era}.`);
            (e.notes || []).forEach(push);
            break;
        }
        case 'transitions': {
            const t = directives.transitions || {};
            if (t.style === 'hard-cuts') push('Use ONLY hard cuts — NO visible transitions (no crossfade, whip, zoom, wipe, flash, dip, flare). Every boundary = cut.');
            if (t.style === 'motivated') push('Use motivated transitions where the story earns them; cut otherwise.');
            if (Array.isArray(t.banned) && t.banned.length) push(`Never use these transitions: ${t.banned.join(', ')}.`);
            (t.notes || []).forEach(push);
            break;
        }
        case 'framing': {
            const f = directives.framing || {};
            if (f.force) push(`Frame EVERY scene as "${f.force}" — do not vary framing across the video.`);
            (f.notes || []).forEach(push);
            break;
        }
        case 'icons': {
            const ic = directives.icons || {};
            if (ic.allow === false) push('Do NOT place ANY explainer icons/photos over footage — none at all.');
            if (ic.avoidOverFaces) push("Never place an icon or photo over a person's face — keep faces clear.");
            (ic.notes || []).forEach(push);
            break;
        }
        case 'graphics':
        case 'composition': {
            const g = directives.graphics || {};
            if (g.fewerTemplates) push('Use FEWER template cards — keep them sparse.');
            if (g.moreTemplates) push('Lean into template cards more than usual.');
            if (g.fewerMGs) push('Use FEWER motion graphics/overlays — keep the screen clean.');
            if (g.moreMGs) push('Use more motion graphics/overlays.');
            if (Array.isArray(g.bannedTypes) && g.bannedTypes.length) push(`Never use these graphic types: ${g.bannedTypes.join(', ')}.`);
            (g.notes || []).forEach(push);
            break;
        }
        case 'footage': {
            const f = directives.footage || {};
            if (f.preferReal) push('Prefer real / authentic footage; avoid generic stocky clips.');
            if (f.avoidStock) push('Avoid stock footage.');
            if (f.preferImages) push('Prefer still images over video.');
            if (f.preferVideos) push('Prefer video clips over stills.');
            if (Array.isArray(f.bannedSources) && f.bannedSources.length) push(`Do NOT source footage from: ${f.bannedSources.join(', ')}.`);
            if (Array.isArray(f.preferredSources) && f.preferredSources.length) push(`Prefer footage from: ${f.preferredSources.join(', ')}.`);
            break;
        }
        default:
            return '';
    }

    if (!lines.length) return '';
    return `\n🚦 CREATOR DIRECTIVES (explicit orders for THIS video — HIGHEST authority, override defaults):\n${lines.join('\n')}\n`;
}

module.exports = { compileDirectives, renderDirectivesBlock, directivesFloor, isDisabled };
// Test-only surface (verify-directives.js). Not part of the public API.
module.exports.__test = { _coerce, _coercePerScene };
