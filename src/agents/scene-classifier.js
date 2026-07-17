/**
 * scene-classifier.js
 *
 * Batch classifier that tags each scene with an editorial CLASS from the
 * fixed 8-class taxonomy in class-treatment-map.js.
 *
 * Output per scene:
 *   { index, sceneClass, classSubSignal, confidence }
 *
 * The Director then merges those tags onto the scene objects and derives
 * retrievability + fallbackLadder via class-treatment-map helpers.
 *
 * Flag-gated: only called when USE_SCENE_CLASSES=true.
 *
 * Fails SOFT: on AI error or parse failure, returns a heuristic fallback
 * classification so the pipeline never breaks. Legacy VP path still runs.
 */

const { callAI } = require('../brain/ai-provider');
const { CLASS_LIST } = require('../data/class-treatment-map');

const MAX_BATCH_SIZE = 50; // scenes per AI call

// ─────────────────────────────────────────────────────────────
// Heuristic fallback — pattern-matches scene text when AI fails.
// Conservative: returns 'object-scene' with 'medium' confidence
// rather than inventing an exotic class.
// ─────────────────────────────────────────────────────────────
const HEURISTIC_PATTERNS = [
    // data-claim: digits, percentages, years, money
    { cls: 'data-claim',      re: /\b\d{1,3}(?:,\d{3})*(?:\.\d+)?\s*(?:%|percent|million|billion|trillion|thousand|dollars?|\$|€|£|¥)\b/i },
    { cls: 'data-claim',      re: /\b(?:19|20)\d{2}\b/ },
    { cls: 'data-claim',      re: /\b\d+(?:\.\d+)?\s*(?:km|miles|tons?|knots?|kilometers?|kph|mph)\b/i },
    // quote-callout: starts with quote char or reporting verb
    { cls: 'quote-callout',   re: /"[^"]{12,}"/ },
    { cls: 'quote-callout',   re: /\b(?:said|stated|declared|warned|announced)\s+[A-Z]/ },
    // hook-tease: opener cues
    { cls: 'hook-tease',      re: /\b(?:what if|imagine|picture this|here'?s what|you won'?t believe)\b/i },
    // transition-bridge: connectors
    { cls: 'transition-bridge', re: /^(?:but|however|meanwhile|then|now|and so|in short|that'?s why)\b/i },
    // concept-metaphor: analogy markers
    { cls: 'concept-metaphor', re: /\b(?:like a|as if|metaphor|symbolism|represents?|imagine a)\b/i },
];

function heuristicClassify(scene, hookEndTime, ctaStartTime) {
    const text = String(scene.text || '').trim();
    if (!text) {
        return { index: scene.index, sceneClass: 'object-scene', classSubSignal: '', confidence: 0.3 };
    }

    // Hook zone gets hook-tease bias unless text looks purely factual
    const inHook = hookEndTime != null && scene.endTime <= hookEndTime;
    const inCta  = ctaStartTime != null && scene.startTime >= ctaStartTime;

    for (const { cls, re } of HEURISTIC_PATTERNS) {
        if (re.test(text)) {
            return { index: scene.index, sceneClass: cls, classSubSignal: 'heuristic-match', confidence: 0.55 };
        }
    }

    if (inHook) return { index: scene.index, sceneClass: 'hook-tease', classSubSignal: 'in-hook-zone', confidence: 0.5 };
    if (inCta)  return { index: scene.index, sceneClass: 'transition-bridge', classSubSignal: 'in-cta-zone', confidence: 0.4 };

    // No signal → object-scene (safest; treatment = footage/stock)
    return { index: scene.index, sceneClass: 'object-scene', classSubSignal: '', confidence: 0.4 };
}

function heuristicClassifyAll(scenes, scriptContext) {
    const hookEndTime = scriptContext && scriptContext.hookEndTime;
    const ctaStartTime = scriptContext && scriptContext.ctaStartTime;
    return scenes.map(s => heuristicClassify(s, hookEndTime, ctaStartTime));
}

// ─────────────────────────────────────────────────────────────
// Prompt builder
// ─────────────────────────────────────────────────────────────
function buildClassifierPrompt(scenes, scriptContext) {
    const entities = (scriptContext && scriptContext.entities) || [];
    const summary = (scriptContext && scriptContext.summary) || '';
    const niche = (scriptContext && scriptContext.nicheId) || 'general';

    const sceneLines = scenes.map(s => {
        const t = String(s.text || '').replace(/\s+/g, ' ').trim().substring(0, 240);
        const dur = (s.endTime - s.startTime).toFixed(1);
        return `SCENE ${s.index} (${dur}s): "${t}"`;
    }).join('\n');

    return `You are classifying scenes for a video production pipeline.

CLASSES (pick EXACTLY ONE per scene):
  actor-event       Named person/org/country doing something real (e.g. "Iran navy patrols strait")
  location-event    Named place + what's happening there (e.g. "Strait of Hormuz closed")
  object-scene      Concrete physical subject/thing (e.g. "cargo ship deck at night")
  data-claim        Numbers, stats, percentages, dates, monetary figures
  quote-callout     Direct quote OR sharp rhetorical line worth isolating
  concept-metaphor  Abstract idea / analogy / symbolism with NO concrete referent
  transition-bridge Connecting narration linking ideas (short, bridging)
  hook-tease        Opener / provocation / "what if" beat / attention grabber

VIDEO CONTEXT:
  Niche: ${niche}
  Summary: ${summary || 'none'}
  Entities: ${entities.slice(0, 10).join(', ') || 'none'}

SCENES:
${sceneLines}

OUTPUT — one line per scene, NO commentary:
SCENE <idx>: class=<one-of-the-8> | sub=<short-signal-or-empty> | conf=<0.0-1.0>

RULES:
- Pick the DOMINANT signal. If a scene mixes (e.g. named actor + stat), pick the one the visual should lead with.
- "sub" is a short lowercase tag the downstream system uses to bias retrievability:
    public-figure, named-actor, known-location, iconic, major-city, headline-event, recent-news,
    niche, obscure, unreported, rumor, speculation, metaphor, abstract, hypothetical, analogy, symbolism
  Leave empty if no strong signal.
- "conf" is your confidence this is the right class (0.0-1.0).
- Output EXACTLY one line per input scene. Do not skip, do not merge, do not add extras.`;
}

// ─────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────
function parseClassifierResponse(rawText, scenes) {
    const results = {};
    const validClasses = new Set(CLASS_LIST);
    const lines = String(rawText || '').split(/\r?\n/);

    for (const line of lines) {
        const m = line.match(/^SCENE\s+(\d+)\s*:\s*(.+)$/i);
        if (!m) continue;
        const idx = parseInt(m[1], 10);
        const body = m[2];

        const classMatch = body.match(/\bclass\s*=\s*([a-z-]+)/i);
        const subMatch   = body.match(/\bsub\s*=\s*([^|]*)/i);
        const confMatch  = body.match(/\bconf\s*=\s*([0-9.]+)/i);

        const rawClass = classMatch ? classMatch[1].toLowerCase().trim() : '';
        const sceneClass = validClasses.has(rawClass) ? rawClass : null;
        if (!sceneClass) continue;

        const classSubSignal = subMatch ? subMatch[1].toLowerCase().trim() : '';
        const confidence = confMatch ? Math.max(0, Math.min(1, parseFloat(confMatch[1]))) : 0.7;

        results[idx] = { index: idx, sceneClass, classSubSignal, confidence };
    }

    // Fill any missing scenes with heuristic fallback
    const out = [];
    for (const s of scenes) {
        if (results[s.index]) {
            out.push(results[s.index]);
        } else {
            out.push(heuristicClassify(s));
        }
    }
    return out;
}

// ─────────────────────────────────────────────────────────────
// classifyScenes(scenes, scriptContext) → Classification[]
// ─────────────────────────────────────────────────────────────
async function classifyScenes(scenes, scriptContext) {
    if (!Array.isArray(scenes) || scenes.length === 0) return [];

    // Split into batches if needed
    const batches = [];
    for (let i = 0; i < scenes.length; i += MAX_BATCH_SIZE) {
        batches.push(scenes.slice(i, i + MAX_BATCH_SIZE));
    }

    const all = [];
    for (let b = 0; b < batches.length; b++) {
        const batch = batches[b];
        const prompt = buildClassifierPrompt(batch, scriptContext);
        try {
            const rawText = await callAI(prompt, { maxTokens: Math.min(4096, 80 * batch.length), taskType: 'classifier' });
            const parsed = parseClassifierResponse(rawText, batch);
            all.push(...parsed);
        } catch (err) {
            console.warn(`   ⚠️  Scene classifier batch ${b + 1}/${batches.length} failed: ${err.message} — heuristic fallback for ${batch.length} scenes`);
            all.push(...heuristicClassifyAll(batch, scriptContext));
        }
    }

    // Summary log
    const counts = {};
    for (const r of all) counts[r.sceneClass] = (counts[r.sceneClass] || 0) + 1;
    const dist = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(' ');
    console.log(`   🏷️  [Classifier] ${all.length} scenes tagged — ${dist}`);

    return all;
}

module.exports = {
    classifyScenes,
    heuristicClassifyAll,
    buildClassifierPrompt,
    parseClassifierResponse,
};
