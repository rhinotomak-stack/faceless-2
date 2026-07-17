/**
 * hf-template-author.js — Agent-authored HyperFrames compositions.
 *
 * The editor agent's "use the skill and build a template for this scene" loop,
 * internalized: for each template / fullscreen-MG scene the AI authors a
 * bespoke { html, css, timeline } composition guided by the skill pack
 * (skills/hyperframes-template/SKILL.md + house-style.md) and the project's
 * DESIGN doc (hf-design-doc.js). Output passes a strict linter before it is
 * allowed anywhere near the render path; on failure we run ONE repair round,
 * then fall back to the fixed-template renderer (graceful degradation — a
 * scene never ships empty).
 *
 *   authorComposition(brief)            — one scene -> validated composition | null
 *   authorCompositions(scenes, ctx)     — batch with cache
 *   validateComposition(raw, ns, dur)   — the linter (exported for tests)
 *
 * Caching: .hf-authored-cache.json in the project dir, keyed by a content
 * hash of the brief — rebuilds don't re-pay AI calls unless the scene changed.
 * Flags: HF_TEMPLATE_AUTHOR=0 disables. HF_AUTHOR_TASKTYPE routes the model.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { callAI } = require('../brain/ai-provider');
const { generateDesignDoc } = require('./hf-design-doc');
let renderDirectivesBlock = () => '';
try { ({ renderDirectivesBlock } = require('../directives/directive-compiler')); } catch (_) { /* optional */ }

// Film-FX vocabulary, so the Composition Author chooses a scene's cinematic finish as
// part of the SAME creative act as its layout + motion (one human-editor decision). The
// footage FX director still owns real-clip scenes; the author owns its authored comps.
let EFFECT_IDS = [], GRADE_IDS = [];
try { ({ EFFECT_IDS, GRADE_IDS } = require('./hf-effects')); } catch (_) { /* registry optional */ }

const SKILL_DIR = path.join(__dirname, '..', '..', 'skills', 'hyperframes-template');

let _skillCache = null;
function loadSkill() {
    if (_skillCache) return _skillCache;
    const read = (f) => { try { return fs.readFileSync(path.join(SKILL_DIR, f), 'utf8'); } catch (_) { return ''; } };
    _skillCache = { skill: read('SKILL.md'), houseStyle: read('house-style.md') };
    return _skillCache;
}

function isDisabled() {
    return /^(0|false|off|no)$/i.test(String(process.env.HF_TEMPLATE_AUTHOR || '').trim());
}

// ── Validator (the load-bearing part) ──────────────────────────────────────

const FORBIDDEN_JS = /\b(setTimeout|setInterval|requestAnimationFrame|fetch|XMLHttpRequest|WebSocket|eval|Function\s*\(|import\s|document\.write|innerHTML|outerHTML|location|window\s*\.|globalThis|addEventListener|onComplete|onUpdate|onStart|ScrollTrigger|Math\.random|Date\.now|new\s+Date)\b/;
const FORBIDDEN_HTML_TAGS = /<\s*(script|style|link|iframe|object|embed|form|input|button|video|audio|source)\b/i;
const EVENT_ATTR = /\son[a-z]+\s*=/i;

function validateComposition(raw, ns, duration, assets = [], brief = null) {
    const errors = [];
    // assets may be strings (legacy) or {token,path,kind,desc} objects (v9
    // asset pipe) — the allowed src/url values are the tokens.
    assets = (assets || []).map(a => (a && typeof a === 'object') ? String(a.token || '') : String(a)).filter(Boolean);
    if (!raw || typeof raw !== 'object') return { ok: false, errors: ['output is not a JSON object'] };
    const html = String(raw.html || '');
    const css = String(raw.css || '');
    const timeline = String(raw.timeline || '');

    if (!html.trim()) errors.push('html is empty');
    if (!timeline.trim()) errors.push('timeline is empty');
    if (html.length > 10000) errors.push(`html too large (${html.length} > 10000)`);
    if (css.length > 9000) errors.push(`css too large (${css.length} > 9000)`);
    if (timeline.length > 9000) errors.push(`timeline too large (${timeline.length} > 9000)`);

    // HTML rules
    if (FORBIDDEN_HTML_TAGS.test(html)) errors.push('html contains a forbidden tag (script/style/link/iframe/media/form)');
    if (EVENT_ATTR.test(html)) errors.push('html contains an inline event handler attribute');
    if (/<\s*(html|head|body)\b/i.test(html)) errors.push('html must be a fragment (no html/head/body)');
    // every id= must be namespaced
    for (const m of html.matchAll(/\bid\s*=\s*"([^"]*)"/g)) {
        if (!m[1].startsWith(ns)) errors.push(`id "${m[1]}" not namespaced (must start with "${ns}")`);
    }
    // img src whitelist
    for (const m of html.matchAll(/<img[^>]*\bsrc\s*=\s*"([^"]*)"/gi)) {
        if (!assets.includes(m[1])) errors.push(`img src "${m[1]}" is not a provided asset`);
    }
    // External-URL check — but XML namespace declarations are NOT network
    // fetches: <svg xmlns="http://www.w3.org/2000/svg"> is mandatory SVG
    // syntax (and the skill encourages SVG accents). Strip xmlns attributes
    // before testing.
    const htmlNoXmlns = html.replace(/\bxmlns(?::[\w-]+)?\s*=\s*("[^"]*"|'[^']*')/gi, '');
    if (/https?:\/\//i.test(htmlNoXmlns)) errors.push('html references an external URL');

    // CSS rules
    if (/@import/i.test(css)) errors.push('css uses @import');
    for (const m of css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/gi)) {
        const u = m[1].trim();
        if (!assets.includes(u) && !u.startsWith('data:')) errors.push(`css url(${u}) is not a provided asset`);
    }
    if (/https?:\/\//i.test(css)) errors.push('css references an external URL');
    // every rule's selectors must be namespaced
    const cssNoBody = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of cssNoBody.matchAll(/(^|\})\s*([^{}@]+)\{/g)) {
        const sels = m[2].split(',').map(s => s.trim()).filter(Boolean);
        for (const sel of sels) {
            if (!sel.includes(ns)) { errors.push(`css selector "${sel.slice(0, 60)}" not scoped to namespace`); break; }
        }
    }

    // Timeline rules.
    // IMPORTANT: strip comments AND string literals BEFORE the forbidden-API
    // test. Selector strings legitimately contain banned substrings — e.g. a
    // "location-card" scene's namespace is `auth13-location-card`, which made
    // \blocation\b match inside every selector and permanently reject the
    // composition (re-authored on every project open, failing forever).
    const jsStripped = timeline
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/\/\/[^\n]*/g, ' ')
        .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
    if (FORBIDDEN_JS.test(jsStripped)) {
        const hit = jsStripped.match(FORBIDDEN_JS);
        errors.push(`timeline contains forbidden API: ${hit && hit[0]}`);
    }
    // Call-pattern whitelist: every `name(` or `obj.method(` occurrence must
    // be tl.to/tl.fromTo/tl.set/gsap.set. Robust to multi-line formatting and
    // blocks any function invocation the runtime contract doesn't allow.
    const ALLOWED_CALLS = new Set(['tl.to', 'tl.fromTo', 'tl.set', 'gsap.set']);
    for (const m of jsStripped.matchAll(/([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g)) {
        const callee = m[1].replace(/\s+/g, '');
        if (!ALLOWED_CALLS.has(callee)) {
            errors.push(`timeline calls non-whitelisted function: ${callee}()`);
            break;
        }
    }
    // selectors in timeline must be namespaced
    for (const m of timeline.matchAll(/["'](#[^"']+|\.[^"']+)["']/g)) {
        const sel = m[1];
        if (/^[#.]/.test(sel) && !sel.slice(1).startsWith(ns)) {
            errors.push(`timeline selector "${sel.slice(0, 50)}" not namespaced`);
            break;
        }
    }
    // The timeline must PARSE — a fragment with a syntax error (typically a
    // truncated response) would kill the entire page <script>, taking the
    // master timeline down with it. vm.Script compiles without executing.
    try {
        // eslint-disable-next-line global-require
        new (require('vm').Script)(`(function(tl, gsap){\n${timeline}\n})`);
    } catch (e) {
        errors.push(`timeline has a JavaScript syntax error: ${String(e.message).slice(0, 80)} (output may be truncated — make the timeline shorter)`);
    }

    // Meta-label guard (human-not-AI, ENFORCED): printing the upstream type
    // tag as visible text ("KEY TAKEAWAY" eyebrow above the headline) is the
    // #1 AI-design tell. Generic for every type — only multi-word tags are
    // checked so single common words ("counter", "quote") can't false-match.
    if (brief && brief.type) {
        const typePhrase = String(brief.type).replace(/-/g, ' ').trim().toLowerCase();
        if (typePhrase.includes(' ')) {
            const visText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').toLowerCase();
            if (visText.includes(typePhrase)) {
                errors.push(`on-screen text contains the internal type tag "${typePhrase}" — category/meta labels are forbidden; show only story content (see LOOK HUMAN rule)`);
            }
        }
    }

    // Numeric whitelist (factual safety, ENFORCED): every number displayed in
    // the html must come from the brief (narration/text/items). The
    // prompt rule alone was violated in production — the agent shipped
    // "193KM", "opened 1869", "~50 ships/day" from model knowledge. Small
    // integers (≤12: list counts, ordinals) are exempt.
    if (brief) {
        const allowedPool = [brief.text, brief.subtext, brief.narration,
            ...(brief.items || []).map(i => `${i.label || ''} ${i.value || ''}`)].join(' ');
        const allowedNums = new Set((allowedPool.match(/\d[\d,.]*/g) || []).map(n => n.replace(/[,.]+$/, '')));
        const htmlText = html.replace(/<[^>]+>/g, ' ');
        for (const m of (htmlText.match(/\d[\d,.]*/g) || [])) {
            const num = m.replace(/[,.]+$/, '');
            const plain = num.replace(/,/g, '');
            if (Number(plain) <= 12 && !plain.includes('.')) continue;
            if (allowedNums.has(num) || allowedNums.has(plain) || [...allowedNums].some(a => a.replace(/,/g, '') === plain)) continue;
            errors.push(`number "${m}" does not appear in the scene brief — facts must come from the narration, never your own knowledge (remove it or use a brief-sourced fact)`);
            break;
        }
    }

    return { ok: errors.length === 0, errors, html, css, timeline, notes: String(raw.notes || '') };
}

// ── Prompt assembly ────────────────────────────────────────────────────────

function buildPrompt(brief, design, repairErrors = null, prevOutput = null, ledger = null) {
    const { skill, houseStyle } = loadSkill();
    const assets = brief.assets || [];
    const parts = [
        skill,
        '\n---\n',
        houseStyle,
        '\n---\n',
        design,
        // Style ledger: what the OTHER compositions in this video already look
        // like. The single biggest AI tell is every graphic sharing one safe
        // silhouette — the ledger lets the author vary structure deliberately
        // while keeping the palette coherent.
        ledger && ledger.length
            ? `\n---\n# TREATMENTS ALREADY AUTHORED IN THIS VIDEO\nVary the look: do NOT repeat the same silhouette/plate construction as these. Keep the PALETTE consistent; vary STRUCTURE, anchor and motion. If two or more of these already sit on a filled rectangular plate, your composition MUST use a different construction (bare shadow-text + underline, frosted glass, leader line, oversized numeral, ticker strip, bracket frame, …).\n${ledger.slice(-10).map(l => `  - ${l}`).join('\n')}`
            : '',
        '\n---\n# SCENE BRIEF\n',
        `NAMESPACE: ${brief.ns}`,
        `DURATION: ${brief.duration.toFixed(2)} seconds`,
        `SCENE ROLE: ${brief.kind === 'overlay'
        ? 'OVERLAY floating on LIVE FOOTAGE — the footage stays visible and is the star; you annotate it, never replace it. OVERLAY MODE rules apply (transparent stage, coverage budget).'
        : brief.kind === 'fullscreen' ? 'full-screen graphic moment (replaces footage entirely)' : 'standalone full-screen editorial beat'}`,
        brief.kind === 'overlay' && brief.position ? `POSITION: anchor the content in the "${brief.position}" zone of the 1920x1080 frame.` : '',
        brief.chainPrev ? `CHAIN CONTINUITY (IN): this graphic appears the INSTANT the previous graphic ("${brief.chainPrev.text}") ends — there is NO cut and the container does not animate. Design this as the NEXT PAGE of the same design system: a calm full-frame background built from the DESIGN base colors (no loud novel background construction), so the canvas appears continuous; let your CONTENT entrance carry the change. Skip heavy full-canvas entrance moves.` : '',
        brief.chainNext ? `CHAIN CONTINUITY (OUT): another graphic follows this one immediately with no cut. Exit your CONTENT cleanly by the end, but keep the background calm and full-frame to the last frame (built from DESIGN base colors) — the next page lands on it.` : '',
        renderDirectivesBlock(brief.directives, 'composition'),
        brief.type ? `UPSTREAM SUGGESTION (non-binding, INTERNAL — never render this tag or any category label as on-screen text): the selector tagged this "${brief.type}" — treat it as a hint about the content's nature, NOT a layout to follow. YOU decide the treatment from the narration and data.` : '',
        `HEADLINE / TEXT: ${brief.text || '(none — derive from narration)'}`,
        brief.subtext ? `SUPPORTING TEXT: ${brief.subtext}` : '',
        brief.items && brief.items.length
            ? `DATA ITEMS:\n${brief.items.map(it => `  - ${it.label || ''}${it.value ? ` = ${it.value}` : ''}`).join('\n')}`
            : '',
        brief.narration ? `NARRATION (what the voiceover says during this scene): ${brief.narration}` : '',
        assets.length
            ? `ASSETS — real local images you MAY place in the composition. Use the token EXACTLY as the src/url value (the system substitutes the real file at render). Always cover-fit (object-fit:cover or background-size:cover), never stretch; put a darkening scrim under any text that sits on a photo:\n${assets.map(a => (a && typeof a === 'object') ? `  - ${a.token} (${a.kind}): ${a.desc || 'scene media'}` : `  - ${a}`).join('\n')}`
            : 'ASSETS: none — build a designed CSS background.',
        // FILM FINISH — same creative act as layout + motion. The author picks the cinematic
        // grade/texture for THIS scene from the engine's hand-tuned registry (it never writes
        // FX CSS itself — it prescribes ids the renderer realizes), so a scene's look is one
        // coherent decision instead of layout-then-bolt-on-grade.
        EFFECT_IDS.length
            ? `\n# FILM FINISH (you also choose this scene's cinematic look — one creative act with the layout + motion above)
Prescribe 0-3 texture/light effects + optionally ONE color grade that serve THIS scene's MOOD and the theme. Less is more — clean (none) is valid for crisp data beats; match the video's palette, don't make every scene loud. Use ids EXACTLY.
EFFECT ids: ${EFFECT_IDS.join(', ')}
GRADE ids (at most one): ${GRADE_IDS.join(', ')}
ERA looks (vintageFrame, filmScratches, oldTv, vhs, staticNoise) ONLY for past/archival/flashback content; at most one era family across the whole video. intensity 0.15-0.45 for a base look, 0.5-0.8 only for a deliberate dramatic beat.`
            : '',
        '\nRespond in EXACTLY this delimited format (no markdown fences, no JSON except the EFFECTS array):',
        `===HTML===\n(the html fragment)\n===CSS===\n(the css)\n===TIMELINE===\n(the gsap tween calls)${EFFECT_IDS.length ? '\n===EFFECTS===\n(a JSON array of {"id","intensity"} entries + optional {"id":"<grade>"}, e.g. [{"id":"grain","intensity":0.3},{"id":"teal-orange"}] — or [] for a clean finish)' : ''}\n===NOTES===\n(your 2-4 sentence design reasoning)`,
    ];
    if (repairErrors) {
        parts.push('\n# REPAIR ROUND\nYour previous output was rejected by the linter. Fix ONLY these violations and resend the FULL corrected output in the same ===SECTION=== format:');
        parts.push(repairErrors.map(e => `  - ${e}`).join('\n'));
        if (prevOutput) parts.push(`\nYour previous output (truncated):\n${JSON.stringify(prevOutput).slice(0, 3000)}`);
    }
    return parts.filter(Boolean).join('\n');
}

// Parse + validate the author's prescribed film-FX recipe against the registry vocabulary
// (same shape the FX director produces for footage scenes). Unknown ids dropped; never throws.
function _parseAuthoredEffects(raw) {
    if (!raw) return [];
    let t = String(raw).replace(/```(?:json)?/gi, '').trim();
    const start = t.indexOf('['); const end = t.lastIndexOf(']');
    if (start < 0 || end <= start) return [];
    let arr;
    try { arr = JSON.parse(t.slice(start, end + 1)); } catch (_) { return []; }
    if (!Array.isArray(arr)) return [];
    const valid = new Set([...(EFFECT_IDS || []), ...(GRADE_IDS || [])]);
    const clamp01 = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.4; };
    return arr
        .filter(e => e && valid.has(e.id))
        .slice(0, 4)
        .map(e => ({
            id: e.id,
            ...((GRADE_IDS || []).includes(e.id) ? {} : { intensity: clamp01(e.intensity) }),
            ...(e.warmth != null ? { warmth: clamp01(e.warmth) } : {}),
            ...(e.radius != null ? { radius: clamp01(e.radius) } : {}),
        }));
}

function parseAuthorResponse(text) {
    if (!text) return null;
    let t = String(text).trim();
    // Primary protocol: ===SECTION=== delimited blocks. Code-heavy payloads
    // break JSON escaping constantly (raw newlines/quotes inside html/css
    // strings) — delimited sections sidestep the whole failure class.
    const grab = (name) => {
        const re = new RegExp(`===\\s*${name}\\s*===\\s*([\\s\\S]*?)(?====\\s*[A-Z]+\\s*===|$)`, 'i');
        const m = t.match(re);
        if (!m) return null;
        // strip accidental code fences inside a section
        return m[1].replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/i, '').trim();
    };
    const html = grab('HTML');
    const css = grab('CSS');
    const timeline = grab('TIMELINE');
    if (html != null && timeline != null) {
        return { html, css: css || '', timeline, notes: grab('NOTES') || '', effects: _parseAuthoredEffects(grab('EFFECTS')) };
    }
    // Legacy fallback: a single JSON object.
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '');
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try { return JSON.parse(t.slice(start, end + 1)); } catch (_) { /* try repair */ }
    try { return JSON.parse(t.slice(start, end + 1).replace(/\r?\n/g, '\\n')); } catch (_) { return null; }
}

// ── Cache ──────────────────────────────────────────────────────────────────

// Bump when SKILL.md / house-style.md / prompt structure / routing changes —
// invalidates cached compositions authored under the old playbook.
// NOTE: the v5→lint-fix change (strip strings before forbidden-API test) is
// purely more permissive — previously-cached good compositions remain valid,
// so the version is intentionally NOT bumped (a bump would re-author all 18
// scenes for nothing). Bump only when prompt/skill/output contract changes.
// v8: LOOK HUMAN rule — eyebrow/category labels banned (skill + lint), kicker
// field removed from briefs. Bump forces re-author of all cached comps.
// v9: media asset pipe — briefs carry __HF_ASSET_i__ image tokens (subject
// photos / nearby footage frames); skill gains media-treatment playbook.
// v10: entrance guard — timelines must open with gsap.set initial states
// (frame 0 = entrance start, not finished layout); visual lint measures t=0.
// v11: variety — style ledger in prompt (siblings' treatments), VARIETY
// skill rules + overlay treatment repertoire. Same-silhouette = failure mode.
// v12: perfectionist — vision art-director reviews the rendered hero frame
// (APPROVE / ≤3 concrete visual fixes), one refine round, no regression.
// v13: author-fx — the author also prescribes the scene's film finish (FX recipe +
// grade) as one creative act with layout + motion; ===EFFECTS=== section added.
const AUTHOR_VERSION = 'v13-author-fx';

function briefHash(brief, design) {
    const key = JSON.stringify({
        v: AUTHOR_VERSION,
        ns: brief.ns, d: Math.round(brief.duration * 10), t: brief.text, s: brief.subtext,
        i: brief.items, k: brief.kind, ty: brief.type, n: brief.narration, a: brief.assets, dg: design.length,
        p: brief.position || '',
        co: `${brief.chainPrev ? 'p' : ''}${brief.chainNext ? 'n' : ''}`,
        // Creator directives change the composition prompt → must bust the cache.
        dir: brief.directives ? (renderDirectivesBlock(brief.directives, 'composition') || '') : '',
    });
    return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

function loadCache(projectDir) {
    try { return JSON.parse(fs.readFileSync(path.join(projectDir, '.hf-authored-cache.json'), 'utf8')); } catch (_) { return {}; }
}
function saveCache(projectDir, cache) {
    try { fs.writeFileSync(path.join(projectDir, '.hf-authored-cache.json'), JSON.stringify(cache)); } catch (_) { /* non-fatal */ }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Author one composition. brief = { ns, duration, kind, type, text, subtext,
 * items, narration, assets, themeId, nicheId, styleProfile }.
 * Returns { html, css, timeline, notes, authored:true } or null (caller falls
 * back to the fixed renderer).
 */
async function authorComposition(brief, opts = {}) {
    if (isDisabled()) return null;
    const log = typeof opts.log === 'function' ? opts.log : (m) => console.log(m);
    const design = generateDesignDoc({ themeId: brief.themeId, styleProfile: brief.styleProfile, nicheId: brief.nicheId });
    // 'brain' routes to the reasoning model (plannerTaskTypes → bedrock
    // plannerModel, currently Claude Sonnet). Composition design is a
    // reasoning task first, codegen second — don't send it to the workhorse.
    const taskType = process.env.HF_AUTHOR_TASKTYPE || 'brain';
    const ledger = Array.isArray(opts.ledger) ? opts.ledger : null;

    let prompt = buildPrompt(brief, design, null, null, ledger);
    let parsed = null;
    let result = null;
    for (let round = 0; round < 2; round++) {
        let text;
        try {
            text = await callAI(prompt, { maxTokens: 8000, temperature: 0.5, taskType });
        } catch (e) {
            log(`  ⚠️ [Author] AI call failed (${brief.ns}): ${String(e.message || e).slice(0, 120)}`);
            return null;
        }
        parsed = parseAuthorResponse(text);
        if (!parsed) {
            log(`  ⚠️ [Author] unparseable response (${brief.ns}, round ${round + 1})`);
            prompt = buildPrompt(brief, design, ['response was not in the required ===SECTION=== format'], null, ledger);
            continue;
        }
        result = validateComposition(parsed, brief.ns, brief.duration, brief.assets || [], brief);
        if (result.ok) {
            // Textual lint passed — now MEASURE the rendered pixels. Frame
            // overflow, text collisions, and invisible-at-hero-frame elements
            // come back as concrete errors the repair round can act on.
            try {
                const { visualLint } = require('./hf-visual-lint');
                const vis = await visualLint({ html: result.html, css: result.css, timeline: result.timeline }, brief.ns, brief.duration, { kind: brief.kind });
                if (!vis.ok) {
                    log(`  📐 [Author] visual lint rejected ${brief.ns} (round ${round + 1}): ${vis.errors[0]}`);
                    prompt = buildPrompt(brief, design, vis.errors, parsed, ledger);
                    result = null;
                    continue;
                }
            } catch (vErr) {
                log(`  📐 [Author] visual lint unavailable (${String(vErr.message).slice(0, 60)}) — textual lint only`);
            }
            break;
        }
        log(`  🛠️ [Author] lint rejected ${brief.ns} (round ${round + 1}): ${result.errors.slice(0, 3).join(' | ')}`);
        prompt = buildPrompt(brief, design, result.errors.slice(0, 8), parsed, ledger);
        result = null;
    }
    // Lint-rejected after the repair round = deterministic failure for this
    // brief — return a marker the batch layer CACHES, so reopening the project
    // doesn't re-burn AI calls on a scene that will fail the same way again.
    // (AI-call errors return null above and are NOT cached — those are
    // transient.) Cache invalidates via AUTHOR_VERSION when the linter/prompt
    // changes.
    if (!result || !result.ok) return { failed: true };

    // ── Perfectionist pass (HF_AUTHOR_PERFECTIONIST=0 disables) ──
    // Lints catch violations; they can't catch "passes every rule but looks
    // mediocre". Render the hero frame, have the VISION chain review it like
    // an art director, and give the author ONE refine round on the critique.
    // The refined version must re-pass every lint or we keep the original —
    // perfectionism never regresses a valid comp.
    if (!/^(0|false|off|no)$/i.test(String(process.env.HF_AUTHOR_PERFECTIONIST || '').trim())) {
        try {
            const { captureHeroFrame, visualLint } = require('./hf-visual-lint');
            const frame = await captureHeroFrame(result, brief.ns, brief.duration);
            if (!frame) {
                log(`  🎭 [Author] perfectionist pass skipped for ${brief.ns} — hero frame capture unavailable`);
                result._review = 'skipped';
            }
            if (frame) {
                const { callVisionAI } = require('../brain/ai-provider');
                const critique = await callVisionAI(
                    `You are a broadcast art director reviewing ONE frame of a motion graphic (the "hero frame" of a ${brief.duration.toFixed(1)}s ${brief.kind} scene for a YouTube video).\n`
                    + `The scene's content: "${String(brief.text || brief.narration || '').slice(0, 140)}"\n\n`
                    + `Judge ONLY the visual craft: hierarchy (one dominant element?), balance and dead space, alignment rhythm, type sizing/contrast, whether it looks human-designed or AI-generated (category labels, generic centered box, cramped or floating-in-void layouts).\n`
                    + `Do NOT question the facts or the copy. Do NOT request new content.\n\n`
                    + `Critique discipline: each fix must NAME the exact element it applies to ("the headline", "the stat number", "the left panel"), never a vague whole-frame complaint; each fix must be a concrete actionable visual change. If you cannot state a concrete fix, reply APPROVE — do not block on vague dissatisfaction or mere polish.\n\n`
                    + `Reply EXACTLY one of:\n`
                    + `APPROVE\n`
                    + `REVISE: <up to 3 short, concrete, purely visual fixes — e.g. "headline 20% larger", "left-align the stack, kill the centered box", "supporting line too close to headline, double the gap">`,
                    frame, 'image/jpeg', { maxTokens: 160 }
                );
                const verdict = String(critique || '').trim();
                if (/^REVISE\s*:/i.test(verdict)) {
                    const notes = verdict.replace(/^REVISE\s*:/i, '').trim().slice(0, 400);
                    log(`  🎭 [Author] art director on ${brief.ns}: REVISE — ${notes.slice(0, 90)}`);
                    const refinePrompt = buildPrompt(brief, design, [
                        `ART DIRECTOR REVIEW of your rendered composition (visual critique of the actual frame — apply these, change nothing else): ${notes}`,
                    ], { html: result.html, css: result.css, timeline: result.timeline }, ledger);
                    try {
                        const text2 = await callAI(refinePrompt, { maxTokens: 8000, temperature: 0.4, taskType });
                        const parsed2 = parseAuthorResponse(text2);
                        if (parsed2) {
                            const refined = validateComposition(parsed2, brief.ns, brief.duration, brief.assets || [], brief);
                            if (refined.ok) {
                                const vis2 = await visualLint({ html: refined.html, css: refined.css, timeline: refined.timeline }, brief.ns, brief.duration, { kind: brief.kind });
                                if (vis2.ok) {
                                    log(`  🎭 [Author] ${brief.ns} refined per art-director notes`);
                                    return { html: refined.html, css: refined.css, timeline: refined.timeline, notes: refined.notes || result.notes, effects: Array.isArray(parsed2.effects) ? parsed2.effects : (parsed.effects || []), authored: true, review: 'revised' };
                                }
                            }
                        }
                        log(`  🎭 [Author] ${brief.ns} refinement failed lint — keeping the original (no regression)`);
                        result._review = 'kept-original';
                    } catch (e2) {
                        log(`  🎭 [Author] refine call failed (${String(e2.message || e2).slice(0, 80)}) — keeping the original`);
                        result._review = 'kept-original';
                    }
                } else if (verdict) {
                    log(`  🎭 [Author] art director on ${brief.ns}: APPROVED`);
                    result._review = 'approved';
                }
            }
        } catch (e) {
            log(`  🎭 [Author] perfectionist pass skipped (${String(e.message || e).slice(0, 70)})`);
            result._review = 'skipped';
        }
    }

    return { html: result.html, css: result.css, timeline: result.timeline, notes: result.notes, effects: Array.isArray(parsed?.effects) ? parsed.effects : [], authored: true, review: result._review || 'skipped' };
}

/**
 * Batch author with cache. Uncached briefs run with limited concurrency
 * (HF_AUTHOR_CONCURRENCY, default 3) — 18-scene builds finish in minutes,
 * not a serial half hour.
 */
async function authorCompositions(briefs, { projectDir, log, openMode = false } = {}) {
    const logFn = typeof log === 'function' ? log : (m) => console.log(m);
    const cache = projectDir ? loadCache(projectDir) : {};
    const out = new Array(briefs.length);
    const pending = [];
    // Style ledger (variety): a one-line fingerprint of every comp already
    // authored for this video — later briefs see it and avoid repeating the
    // same silhouette. Seeded from cache hits, grows as the batch lands.
    const ledger = [];
    const fingerprint = (brief, comp) =>
        `${brief.kind}/${brief.type || 'comp'} ("${String(brief.text || '').slice(0, 30)}"): ${String(comp.notes || '').replace(/\s+/g, ' ').slice(0, 110)}`;
    briefs.forEach((brief, i) => {
        const design = generateDesignDoc({ themeId: brief.themeId, styleProfile: brief.styleProfile, nicheId: brief.nicheId });
        const hash = briefHash(brief, design);
        if (cache[hash]) {
            // Cached failure marker → known-bad brief, skip silently (fixed
            // template renders). Cached composition → reuse.
            const cachedComp = cache[hash].failed ? null : cache[hash];
            out[i] = { brief, composition: cachedComp, cached: true };
            if (cachedComp) ledger.push(fingerprint(brief, cachedComp));
        } else if (openMode) {
            // OPEN MODE (project open / refresh): NEVER author — opening a
            // saved project must cost zero AI calls no matter what prompts/
            // themes/versions changed since the save. On a hash miss, reuse
            // the newest cached comp for the same content-stable ns (the
            // look survives); if none exists, the fixed renderer covers it
            // until the next BUILD re-authors fresh.
            const stale = Object.values(cache).filter(v => v && !v.failed && v.ns === brief.ns).pop() || null;
            out[i] = { brief, composition: stale, cached: true, stale: Boolean(stale) };
            if (stale) ledger.push(fingerprint(brief, stale));
        } else {
            pending.push({ brief, hash, i });
        }
    });
    if (openMode) {
        const reusedStale = out.filter(o => o && o.stale).length;
        const missing = out.filter(o => o && !o.composition).length;
        logFn(`  ♻️ [Author] open mode: cache-only (${out.filter(o => o && o.composition).length} reused${reusedStale ? `, ${reusedStale} from previous version` : ''}${missing ? `, ${missing} on fixed renderer until next build` : ''}, 0 AI calls)`);
    }

    let aiCalls = 0;
    let done = 0;
    const concurrency = Math.max(1, Math.min(6, parseInt(process.env.HF_AUTHOR_CONCURRENCY || '3', 10) || 3));
    let cursor = 0;
    async function runner() {
        while (cursor < pending.length) {
            const job = pending[cursor++];
            const comp = await authorComposition(job.brief, { log: logFn, ledger: ledger.slice() });
            aiCalls++;
            done++;
            if (comp) cache[job.hash] = { ...comp, ns: job.brief.ns }; // ns enables open-mode stale reuse
            const usable = comp && !comp.failed ? comp : null;
            if (usable) ledger.push(fingerprint(job.brief, usable));
            out[job.i] = { brief: job.brief, composition: usable, cached: false };
            logFn(`  🎨 [Author] ${done}/${pending.length} authored (${job.brief.ns}${usable ? '' : ' — FELL BACK'})`);
        }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, runner));
    try { await require('./hf-visual-lint').closeVisualLint(); } catch (_) { /* noop */ }

    if (projectDir) saveCache(projectDir, cache);
    const okCount = out.filter(o => o && o.composition).length;
    logFn(`  🎨 [Author] ${okCount}/${briefs.length} compositions authored (${aiCalls} AI calls, ${out.filter(o => o && o.cached).length} cached)`);
    // Art-director scorecard for the build log (fresh comps only — cached
    // comps were reviewed when first authored).
    const reviews = out.filter(o => o && o.composition && !o.cached).map(o => o.composition.review || 'skipped');
    if (reviews.length) {
        const n = (k) => reviews.filter(r => r === k).length;
        logFn(`  🎭 [Author] art director: ${n('approved')} approved, ${n('revised')} revised, ${n('kept-original')} kept original, ${n('skipped')} unreviewed`);
    }
    return out;
}

module.exports = { authorComposition, authorCompositions, validateComposition, generateBriefHash: briefHash };
