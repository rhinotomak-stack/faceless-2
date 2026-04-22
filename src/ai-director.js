/**
 * AI Director Module — Step 3 of the pipeline
 *
 * Replaces ai-scenes.js + ai-context.js with a single, richer AI call.
 * Reads the full narration script and:
 *   1. Analyzes content (summary, theme, mood, pacing, entities)
 *   2. Detects format (documentary vs listicle)
 *   3. Detects CTA/sign-off and hook boundary
 *   4. Splits into meaningful scenes with word-level timestamps
 *
 * Uses shared ai-provider.js for all AI calls.
 *
 * Exports:
 *   analyzeAndCreateScenes(transcription, directorsBrief) → { scenes, scriptContext }
 */

const axios = require('axios');
const config = require('./config');
const { callAI } = require('./ai-provider');
const { pickNicheFromContent, getNiche } = require('./niches');
const { getTheme, TRANSITION_LIBRARY } = require('./themes');
const { searchWeb, hasAnyWebSearchCredentials } = require('./web-search-client');

// ============================================================
// PROMPT BUILDER
// ============================================================

/**
 * Build the AI prompt for scene splitting + context analysis.
 * Prompt is in its own function so it can be tweaked independently.
 */
function buildDirectorPrompt(fullScript, audioDuration, directorsBrief, webContext = null) {
    const { freeInstructions, format, qualityTier, audienceHint, tier, styleBlock, styleProfile } = directorsBrief;
    const baseDensity = tier.sceneDensity || 3;

    // The AI will adjust this based on detected pacing
    // Fast-paced (news, action, urgent) → more scenes
    // Slow-paced (documentary, emotional) → fewer scenes
    // For short videos, ensure minimum of 4 scenes (faceless videos need frequent cuts)
    const targetScenes = Math.max(4, Math.round((audioDuration / 60) * baseDensity));

    let prompt = `You are a professional video editor for FACELESS VIDEOS. This is NOT a talking-head video — it's a faceless video where EVERY sentence needs B-ROLL footage to illustrate the narration.

CRITICAL CONTEXT: In faceless videos, the viewer NEVER sees the narrator. Instead, they see:
- Stock footage (clips of the events described)
- Images (photos, charts, maps, screenshots)
- Motion graphics (text overlays, stats, titles)

This means you MUST cut to a new visual frequently — every 3-7 seconds — to keep the viewer engaged. If you keep the same shot for 10+ seconds, viewers will get bored and leave.

Read this narration script and do TWO things:
1. ANALYZE the content deeply (topic, theme, mood, format, structure)
2. SPLIT the script into SCENES — each scene = one visual moment that needs specific B-ROLL footage

SCRIPT:
"${fullScript}"

AUDIO DURATION: ${audioDuration.toFixed(1)} seconds
TARGET SCENE COUNT: approximately ${targetScenes} scenes (${baseDensity} scenes per minute)`;

    // Video title from UI — strongest topic signal
    const videoTitle = (process.env.VIDEO_TITLE || '').trim();
    if (videoTitle) {
        prompt += `\n\nVIDEO TITLE: "${videoTitle}"\nUse this title to understand the video's subject and intent. It helps distinguish between NEWS (breaking events, launches) and EXPLAINER (how things work, deep-dives).`;
    }

    if (webContext) {
        prompt += `\n\nREAL-WORLD CONTEXT (from web search):
${webContext}

Use this context to understand the story better. If this is a real event, treat it with appropriate gravity and split scenes to show key moments (discovery, investigation steps, evidence, etc.).`;
    }

    if (freeInstructions) {
        prompt += `\n\nUSER INSTRUCTIONS (follow these closely, they override defaults):
${freeInstructions}`;
    }

    // Reference style profile (highest priority — overrides niche defaults and AI detection)
    if (styleBlock) {
        prompt += `\n\n${styleBlock}\n\nNOTE: The style inspiration above is a GUIDE, not an override. Use it to inform your pacing feel and shot variety. Your niche rules and format settings still take priority for scene density and structure.`;
        console.log(`   🎨 [Director] Style inspiration injected: "${styleProfile?.name || 'unnamed'}" (${styleBlock.length} chars)`);
    }

    if (audienceHint) {
        prompt += `\nTARGET AUDIENCE: ${audienceHint}`;
    }

    if (format !== 'auto') {
        prompt += `\nFORMAT: This is a ${format} video.`;
    }

    prompt += `

ANALYSIS RULES:
- FORMAT: Is this a "documentary" (flowing narrative) or "listicle" (numbered items, "first... second... third...", "number one...", "top 5...")?
- If listicle, identify the SECTIONS (each numbered item is a section).
- HOOK: The first 15-30 seconds is usually the hook/intro. Identify where the main content begins.
- CTA: Does the script end with a call-to-action? ("subscribe", "like and share", "thanks for watching", "let me know in the comments"). If yes, when does it start?
- BACKGROUND: What visual canvas fits behind the footage? Pick based on theme:
  crime/mystery/horror → dark | technology/science/data → tech | nature/travel/wildlife → nature | business/finance/lifestyle → warm | general/education → neutral
- PACING: Determine if this content is "fast" (urgent news, action, breaking stories), "moderate" (standard documentary), or "slow" (emotional, deep dive, mystery).
  This affects scene density:
  • Fast pacing → 3.5-4 scenes per minute (quick cuts, energetic)
  • Moderate pacing → 3 scenes per minute (standard)
  • Slow pacing → 2.5 scenes per minute (cinematic, breathing room)

TASK: Analyze the content ONLY. Do NOT split scenes — scene splitting is handled separately.

Reply in EXACTLY this format:
summary: <1 sentence, max 20 words>
eventType: <real-past|real-ongoing|speculative|educational|fictional>
theme: <technology|history|finance|science|health|travel|politics|entertainment|education|sports|nature|business|lifestyle|motivation|crime|mystery>
tone: <informative|dramatic|casual|urgent|inspirational|educational|serious|lighthearted|emotional|suspenseful>
mood: <dark|uplifting|tense|calm|energetic|nostalgic|hopeful|mysterious|intense|playful>
pacing: <fast|moderate|slow>
visualStyle: <cinematic|documentary|corporate|lifestyle|abstract|nature|urban|tech|vintage|minimalist>
entities: <comma-separated, each tagged with type: "Name [person]", "Name [place]", "Name [org]", "Name [event]", or "none". Example: "King Khalid [person], Strait of Hormuz [place], Saudi Aramco [org]">
stats: <comma-separated key numbers/statistics, or "none">
format: <documentary|listicle>
sections: <comma-separated section titles if listicle, or "none">
hookEnd: <approximate seconds where the hook/intro ends, e.g. "18">
ctaStart: <approximate seconds where CTA/sign-off begins, or "none">
background: <dark|tech|nature|warm|neutral>`;

    return prompt;
}

// ============================================================
// RESPONSE PARSING
// ============================================================

/**
 * Parse the context section of the AI response.
 * Extracts both legacy fields (summary, theme, etc.) and new fields (format, CTA, hook, etc.)
 */
function parseDirectorContext(contextText) {
    const result = {
        // Legacy fields (same as ai-context.js)
        summary: '',
        theme: '',
        tone: '',
        mood: '',
        pacing: '',
        visualStyle: '',
        entities: [],
        keyStats: [],
        mainPoints: [],
        targetAudience: '',
        emotionalArc: '',
        // New fields
        format: 'documentary',
        sections: [],
        ctaDetected: false,
        ctaStartTime: null,
        hookEndTime: null,
        densityTarget: 3,
        nicheId: 'general',  // Content strategy (MG types, footage priority, pacing)
        themeId: 'standard'   // Visual system (colors, fonts, transitions, overlays)
    };

    const lines = contextText.trim().split('\n');

    for (const line of lines) {
        const lower = line.toLowerCase().trim()
            .replace(/^\*+/, '').replace(/\*+$/, '')
            .replace(/^-\s*/, '')
            .trim();

        const extractValue = () => line.substring(line.indexOf(':') + 1).trim().replace(/^["'*]+|["'*]+$/g, '');

        // Legacy fields
        if (lower.startsWith('summary:')) {
            result.summary = extractValue();
            if (result.summary.length > 120) result.summary = result.summary.substring(0, 120);
        }
        if (lower.startsWith('eventtype:') || lower.startsWith('event type:') || lower.startsWith('event_type:')) {
            const val = extractValue().toLowerCase();
            if (['real-past', 'real-ongoing', 'speculative', 'educational', 'fictional'].includes(val)) {
                result.eventType = val;
            }
        }
        if (lower.startsWith('theme:')) result.theme = extractValue().toLowerCase();
        if (lower.startsWith('tone:')) result.tone = extractValue().toLowerCase();
        if (lower.startsWith('mood:')) result.mood = extractValue().toLowerCase();
        if (lower.startsWith('pacing:')) result.pacing = extractValue().toLowerCase();
        if (lower.startsWith('visualstyle:') || lower.startsWith('visual style:') || lower.startsWith('visual_style:')) {
            result.visualStyle = extractValue().toLowerCase();
        }
        if (lower.startsWith('entities:')) {
            const val = extractValue();
            if (val.toLowerCase() !== 'none') {
                const raw = val.split(',').map(s => s.trim()).filter(Boolean);
                result.entities = [];
                result.entityTypes = {}; // name → 'person'|'place'|'org'|'event'
                for (const entry of raw) {
                    const tagMatch = entry.match(/^(.+?)\s*\[(person|place|org|event|organization|location)\]\s*$/i);
                    if (tagMatch) {
                        const name = tagMatch[1].trim();
                        let type = tagMatch[2].toLowerCase();
                        if (type === 'organization') type = 'org';
                        if (type === 'location') type = 'place';
                        result.entities.push(name);
                        result.entityTypes[name.toLowerCase()] = type;
                    } else {
                        result.entities.push(entry);
                    }
                }
            }
        }
        if (lower.startsWith('stats:')) {
            const val = extractValue();
            if (val.toLowerCase() !== 'none') {
                result.keyStats = val.split(',').map(s => s.trim()).filter(Boolean);
            }
        }
        if (lower.startsWith('points:')) {
            const val = extractValue();
            result.mainPoints = val.split(',').map(s => s.trim()).filter(Boolean);
        }
        if (lower.startsWith('audience:')) result.targetAudience = extractValue();
        if (lower.startsWith('arc:')) result.emotionalArc = extractValue();

        // New fields
        if (lower.startsWith('format:')) {
            const val = extractValue().toLowerCase();
            if (val === 'listicle' || val === 'documentary') result.format = val;
        }
        if (lower.startsWith('sections:')) {
            const val = extractValue();
            if (val.toLowerCase() !== 'none') {
                result.sections = val.split(',').map(s => s.trim()).filter(Boolean);
            }
        }
        if (lower.startsWith('hookend:') || lower.startsWith('hook end:') || lower.startsWith('hook_end:')) {
            const val = extractValue().replace(/[^0-9.]/g, '');
            const num = parseFloat(val);
            if (!isNaN(num) && num > 0) result.hookEndTime = num;
        }
        if (lower.startsWith('ctastart:') || lower.startsWith('cta start:') || lower.startsWith('cta_start:')) {
            const val = extractValue().toLowerCase();
            if (val !== 'none' && val !== 'n/a') {
                const num = parseFloat(val.replace(/[^0-9.]/g, ''));
                if (!isNaN(num) && num > 0) {
                    result.ctaDetected = true;
                    result.ctaStartTime = num;
                }
            }
        }
        // NOTE: backgroundCanvas removed — now using unified theme system (themeId)
    }

    return result;
}

// ============================================================
// WORD MATCHING (preserved from ai-scenes.js)
// ============================================================

function normalize(text) {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Find the index in allWords where the anchor text starts.
 * Uses sliding window matching with fuzzy tolerance.
 */
function findWordIndex(anchorText, allWords, searchFrom) {
    const anchorParts = normalize(anchorText).split(/\s+/).filter(Boolean);
    if (anchorParts.length === 0) return -1;

    let bestIndex = -1;
    let bestScore = 0;
    const windowSize = anchorParts.length;

    for (let i = searchFrom; i <= allWords.length - Math.min(windowSize, 2); i++) {
        let matchCount = 0;
        const maxCheck = Math.min(windowSize, allWords.length - i);

        for (let j = 0; j < maxCheck; j++) {
            const wordNorm = normalize(allWords[i + j].word);
            const anchorNorm = anchorParts[j];
            if (wordNorm === anchorNorm) {
                matchCount++;
            } else if (wordNorm.includes(anchorNorm) || anchorNorm.includes(wordNorm)) {
                matchCount += 0.7;
            }
        }

        const score = matchCount / anchorParts.length;
        if (score > bestScore) {
            bestScore = score;
            bestIndex = i;
        }

        if (score >= 0.85) break;
    }

    return bestScore >= 0.5 ? bestIndex : -1;
}

// ============================================================
// SCENE BUILDING (preserved from ai-scenes.js)
// ============================================================

/**
 * Parse scene boundaries from AI output and map to word timestamps.
 */
function buildScenesFromAnchors(sceneAnchors, allWords, audioDuration, fps) {
    const mapped = [];
    let searchFrom = 0;

    for (let i = 0; i < sceneAnchors.length; i++) {
        const anchor = sceneAnchors[i];
        const wordIdx = findWordIndex(anchor, allWords, searchFrom);

        if (wordIdx >= 0) {
            mapped.push({ wordIndex: wordIdx, anchor });
            searchFrom = wordIdx + 1;
            console.log(`   ✅ Scene ${i}: "${anchor}" → word #${wordIdx} @${allWords[wordIdx].start.toFixed(2)}s`);
        } else {
            console.log(`   ⚠️ Scene ${i}: "${anchor}" → no match, will interpolate`);
            mapped.push({ wordIndex: -1, anchor });
        }
    }

    // Fix unmatched scenes by interpolation
    for (let i = 0; i < mapped.length; i++) {
        if (mapped[i].wordIndex === -1) {
            const prevIdx = i > 0 ? mapped[i - 1].wordIndex : 0;
            let nextIdx = allWords.length - 1;
            for (let j = i + 1; j < mapped.length; j++) {
                if (mapped[j].wordIndex >= 0) { nextIdx = mapped[j].wordIndex; break; }
            }
            let unmatchedCount = 0;
            for (let j = i; j < mapped.length && mapped[j].wordIndex === -1; j++) unmatchedCount++;

            const step = Math.floor((nextIdx - prevIdx) / (unmatchedCount + 1));
            mapped[i].wordIndex = Math.min(prevIdx + step, allWords.length - 1);
            console.log(`   🔧 Interpolated Scene ${i} → word #${mapped[i].wordIndex} @${allWords[mapped[i].wordIndex].start.toFixed(2)}s`);
        }
    }

    // Build final scene objects
    const scenes = [];
    for (let i = 0; i < mapped.length; i++) {
        const startWordIdx = mapped[i].wordIndex;
        const endWordIdx = i < mapped.length - 1 ? mapped[i + 1].wordIndex : allWords.length;

        const startTime = allWords[startWordIdx].start;
        const endTime = i < mapped.length - 1
            ? allWords[mapped[i + 1].wordIndex].start
            : audioDuration;

        const sceneWords = allWords.slice(startWordIdx, endWordIdx);
        const text = sceneWords.map(w => w.word).join(' ').trim();

        scenes.push({
            index: i,
            text,
            startTime,
            endTime,
            duration: Math.round((endTime - startTime) * fps),
            words: sceneWords
        });
    }

    // Ensure last scene extends to audio end
    if (scenes.length > 0) {
        const last = scenes[scenes.length - 1];
        if (audioDuration > last.endTime + 0.3) {
            last.endTime = audioDuration;
            last.duration = Math.round((last.endTime - last.startTime) * fps);
        }
    }

    return scenes;
}

// ============================================================
// POST-PROCESSING: AUTO-SPLIT LONG SCENES
// ============================================================

/**
 * Automatically split scenes that are longer than maxDuration.
 * Finds natural sentence breaks (words after punctuation or pauses).
 *
 * This is a safety net for when AI ignores scene count rules.
 *
 * @param {Array} scenes - Scene array
 * @param {Array} allWords - Word-level timestamps
 * @param {number} audioDuration - Total audio duration
 * @param {number} fps - Frames per second
 * @param {number} maxDuration - Maximum scene duration in seconds
 * @returns {Array} New scene array with long scenes split
 */
/**
 * Merge scenes shorter than minDuration into their neighbors.
 * Short scenes get merged into whichever neighbor is shorter (to balance lengths).
 */
function _mergeTinyScenes(scenes, minDuration = 3.0, hookEndTime = 0, hookMinDuration = 1.5, opts = {}) {
    if (scenes.length <= 1) return scenes;

    // Zone-aware floors. When opts.zoneBands is provided (from nicheCfg), each
    // zone's lower band bound becomes the effective floor — this works for ALL
    // niches because getNicheSplitConfig() always returns a valid config
    // (falling back to DEFAULT_SCENE_SPLIT when the niche is unknown).
    //
    // This is what stops the recurring "3.1s body scene next to the map"
    // problem: the optimizer's band-violation penalty flags these spans, and
    // this pass finishes the job by absorbing them into their SHORTER
    // neighbor (balances durations instead of always dumping into prev).
    const zoneBands = opts.zoneBands || null;
    const ctaStartTime = parseFloat(opts.ctaStartTime);
    const zoneOf = (scene) => {
        const mid = ((scene.startTime || 0) + (scene.endTime || 0)) / 2;
        if (hookEndTime > 0 && mid < hookEndTime) return 'hook';
        if (!isNaN(ctaStartTime) && mid >= ctaStartTime) return 'cta';
        return 'body';
    };
    const floorFor = (scene) => {
        const zone = zoneOf(scene);
        if (zoneBands && zoneBands[zone]) return zoneBands[zone][0];
        if (zone === 'hook') return hookMinDuration;
        return minDuration;
    };

    let merged = [...scenes];
    let mergeCount = 0;
    const mergeReasons = { hook: 0, body: 0, cta: 0 };

    // Keep merging until no tiny scenes remain
    let changed = true;
    while (changed) {
        changed = false;
        const next = [];
        for (let i = 0; i < merged.length; i++) {
            const scene = merged[i];
            const duration = (scene.endTime || 0) - (scene.startTime || 0);
            const effectiveMin = floorFor(scene);

            if (duration >= effectiveMin) {
                next.push(scene);
                continue;
            }

            const prev = next.length > 0 ? next[next.length - 1] : null;
            const nxt = i + 1 < merged.length ? merged[i + 1] : null;
            const prevDur = prev ? (prev.endTime - prev.startTime) : Infinity;
            const nxtDur  = nxt  ? (nxt.endTime  - nxt.startTime)  : Infinity;

            // Absorb into SHORTER neighbor so durations stay balanced.
            if (prev && prevDur <= nxtDur) {
                prev.endTime = scene.endTime;
                prev.endFrame = scene.endFrame;
                prev.text = (prev.text || '') + ' ' + (scene.text || '');
                if (scene.words) prev.words = [...(prev.words || []), ...scene.words];
                mergeCount++;
                mergeReasons[zoneOf(scene)]++;
                changed = true;
            } else if (nxt) {
                nxt.startTime = scene.startTime;
                nxt.startFrame = scene.startFrame;
                nxt.text = (scene.text || '') + ' ' + (nxt.text || '');
                if (scene.words) nxt.words = [...(scene.words || []), ...(nxt.words || [])];
                mergeCount++;
                mergeReasons[zoneOf(scene)]++;
                changed = true;
            } else {
                next.push(scene);
            }
        }
        merged = next;
    }

    // Re-index
    merged.forEach((s, i) => { s.index = i; });

    if (mergeCount > 0) {
        if (zoneBands) {
            console.log(`   🔀 Merged ${mergeCount} tiny scenes (hook<${zoneBands.hook[0]}s body<${zoneBands.body[0]}s cta<${zoneBands.cta[0]}s) → ${merged.length} scenes [by zone: hook=${mergeReasons.hook} body=${mergeReasons.body} cta=${mergeReasons.cta}]`);
        } else {
            console.log(`   🔀 Merged ${mergeCount} tiny scenes (< ${minDuration}s) → ${merged.length} scenes`);
        }
    }

    return merged;
}

// ============================================================
// WHISPER FALLBACK
// ============================================================

function createScenesFromWhisper(transcription) {
    const fps = config.video.fps;
    const segments = transcription.segments || [];
    const audioDuration = transcription.duration || (segments.length > 0 ? segments[segments.length - 1].end : 0);

    const scenes = segments.map((segment, index) => ({
        index,
        text: segment.text,
        startTime: segment.start,
        endTime: segment.end,
        duration: Math.round((segment.end - segment.start) * fps),
        words: segment.words || []
    }));

    if (scenes.length > 0) {
        const lastSegEnd = segments[segments.length - 1].end;
        if (audioDuration > lastSegEnd + 0.5) {
            scenes[scenes.length - 1].endTime = audioDuration;
            scenes[scenes.length - 1].duration = Math.round((audioDuration - scenes[scenes.length - 1].startTime) * fps);
        }
    }

    return scenes;
}

// ============================================================
// CTA DETECTION + PUNCTUATION MICRO-SPLITTER
// ============================================================

// Lexical sign-off cues for CTA fallback detection. Order matters only for
// logging; the earliest match in the search window wins.
const CTA_CUE_PATTERNS = [
    /\bsubscribe\b/i,
    /\bthanks\s+for\s+watching\b/i,
    /\bthank\s+you\s+for\s+watching\b/i,
    /\blet\s+me\s+know\b/i,
    /\bin\s+the\s+comments?\b/i,
    /\bif\s+you\s+(enjoyed|liked|found)\b/i,
    /\blike\s+and\s+subscribe\b/i,
    /\bhit\s+the\s+(bell|like)\b/i,
    /\bsee\s+you\s+(next|in\s+the\s+next)\b/i,
    /\bcatch\s+you\s+(next|in\s+the\s+next)\b/i,
    /\buntil\s+next\s+time\b/i,
    /\btake\s+care\b/i,
    /\bshare\s+this\s+(video|channel)\b/i,
];

/**
 * Fill scriptContext.ctaStartTime when the AI Director didn't tag one.
 *
 * Strategy: scan the last 30% of the script for a lexical sign-off cue via
 * word-level timestamps from the Whisper transcription. If found, set
 * ctaStartTime to the earliest cue's word start. Never overrides an existing
 * value. Returns a short source string for logging:
 *   'from AI Director'  — value was already present
 *   'lexical fallback'  — this helper set it
 *   'not detected'      — no AI value and no cue found
 */
function _ensureCtaStartTime(scriptContext, transcription, audioDuration) {
    if (scriptContext.ctaStartTime != null && !isNaN(parseFloat(scriptContext.ctaStartTime))) {
        return 'from AI Director';
    }
    if (!transcription || !Array.isArray(transcription.segments)) return 'not detected';

    // Flatten words with timestamps — CTA cues are usually 2+ words, so we
    // stitch a rolling window of ~8 words and regex-match against it.
    const words = [];
    for (const seg of transcription.segments) {
        if (!seg || !seg.words) continue;
        for (const w of seg.words) {
            if (w && typeof w.start === 'number' && w.word) {
                words.push({ word: String(w.word).trim(), start: w.start });
            }
        }
    }
    if (!words.length) return 'not detected';

    const searchFromTime = Math.max(0, audioDuration * 0.70);
    let earliestMatch = null;

    for (let i = 0; i < words.length; i++) {
        if (words[i].start < searchFromTime) continue;
        const windowText = words.slice(i, i + 8).map(w => w.word).join(' ');
        for (const re of CTA_CUE_PATTERNS) {
            if (re.test(windowText)) {
                if (earliestMatch === null || words[i].start < earliestMatch) {
                    earliestMatch = words[i].start;
                }
                break;
            }
        }
    }

    if (earliestMatch != null) {
        scriptContext.ctaStartTime = earliestMatch;
        scriptContext.ctaDetected = true;
        return 'lexical fallback';
    }
    return 'not detected';
}

// Punctuation micro-splitter — retained as a utility for the Style Studio
// "plan scenes" chat command. The main build pipeline uses the deterministic
// smart splitter (speech-units → boundary-scorer → optimizer) instead.
function _splitAtPunctuation(allWords, audioDuration, fps) {
    const scenes = [];
    let currentWords = [];

    for (let i = 0; i < allWords.length; i++) {
        const word = allWords[i];
        currentWords.push(word);

        const text = word.word.trim();
        const isPunctuation = /[.!?,;:]$/.test(text);
        const isLastWord = i === allWords.length - 1;

        if ((isPunctuation || isLastWord) && currentWords.length > 0) {
            const startTime = currentWords[0].start;
            const endTime = (i + 1 < allWords.length) ? allWords[i + 1].start : audioDuration;

            scenes.push({
                index: scenes.length,
                text: currentWords.map(w => w.word).join(' ').trim(),
                startTime,
                endTime,
                duration: Math.round((endTime - startTime) * fps),
                words: [...currentWords]
            });
            currentWords = [];
        }
    }

    return scenes;
}


// ============================================================
// WEB SEARCH FOR CONTEXT (Gemini Search Grounding)
// ============================================================

/**
 * Search the web for context about the story using Gemini Search Grounding.
 * This helps the AI understand if this is a real event vs fictional story.
 *
 * @param {string} fullScript - The narration text
 * @returns {Promise<string|null>} Search results summary or null
 */
async function searchWebContext(fullScript) {
    // Feed AI a large window so it can skip intros and find the real topic
    const preview = fullScript.substring(0, 1500).trim();

    try {
        console.log('   🔍 Extracting search query from script...');

        // Step 0: Use AI to extract a focused 3-5 word search query from the script
        // This avoids the "generic intro" problem where first 100 chars are just "hey everyone welcome back"
        let queryText = '';
        try {
            const aiQuery = await callAI(
                `Extract the CORE FACTUAL SUBJECT from this video script into a web search query.

Script excerpt:
"${preview}"

Rules:
- IGNORE generic YouTube intros, greetings, hooks, subscribe requests, or filler phrases
- Read deep enough to find the ACTUAL topic, noun, event, or subject
- Output ONLY a 3-5 word search query — nothing else
- Focus on proper nouns, specific events, or concrete subjects
- Examples: "Gene Hackman disappearance 2024", "deep sea mining environmental impact", "Tesla Cybertruck recall"
- If the script is about a person, include their full name
- If it's about an event, include what happened and when`,
                { maxTokens: 30, systemPrompt: 'You extract search queries. Output ONLY the query, no explanation.', provider: 'gemini' }
            );
            if (aiQuery && aiQuery.trim().length > 3) {
                queryText = aiQuery.trim()
                    .replace(/^["']+|["']+$/g, '')  // strip quotes
                    .replace(/[^\w\s'-]/g, ' ')
                    .replace(/\s+/g, ' ')
                    .trim()
                    .substring(0, 80);
                console.log(`   ✅ AI extracted query: "${queryText}"`);
            }
        } catch (err) {
            console.log(`   ⚠️ AI query extraction failed: ${err.message} — falling back to raw text`);
        }

        // Fallback: raw substring if AI extraction failed
        if (!queryText) {
            queryText = preview.substring(0, 120)
                .replace(/[^\w\s'-]/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .substring(0, 80);
        }
        let searchSnippets = '';

        // Scale results by script length: base 10, up to 20 for long scripts
        const scriptWords = fullScript.split(/\s+/).length;
        const numResults = Math.min(20, Math.max(10, Math.round(10 + (scriptWords - 200) / 80)));

        // API-first web search (Tavily -> Google CSE fallback)
        if (hasAnyWebSearchCredentials()) {
            try {
                if (!queryText) {
                    throw new Error('query became empty after normalization');
                }
                const { items, provider, errors } = await searchWeb(queryText, {
                    num: numResults,
                    timeout: 10000,
                    providerOrder: ['tavily', 'googleCSE'],
                });
                if (items.length > 0) {
                    searchSnippets = items.map((it) => `- ${it.title}: ${it.snippet || ''}`).join('\n');
                    console.log(`   ✅ ${provider}: found ${items.length} results`);
                } else if (errors.length > 0) {
                    console.log(`   ⚠️ Web search providers skipped: ${errors.join(' | ')}`);
                }
            } catch (err) {
                console.log(`   ⚠️ Web search skipped: ${err.message}`);
            }
        }

        // Fallback to Wikipedia + DuckDuckGo if no API provider results
        if (!searchSnippets) {
            const [wikiResults, ddgResults] = await Promise.all([
                _searchWikipedia(queryText),
                _searchDDGInstant(queryText)
            ]);
            searchSnippets = [wikiResults, ddgResults].filter(Boolean).join('\n');
        }

        if (!searchSnippets) {
            console.log('   ℹ️ No web search results found\n');
            return null;
        }

        // Step 2: Use Gemini to analyze search results + script (critical context for Director)
        const summary = await callAI(
            `You are analyzing a video narration and web search results to extract context that will help an AI plan visual scenes.

Narration preview: "${preview}..."

Web search results:
${searchSnippets}

Provide a brief analysis (3-5 sentences) covering:
1. What is the main topic/subject? If it mentions real people, places, organizations, ships, or military units — it is a REAL EVENT, not fiction.
2. Key entities: people, places, organizations, objects mentioned
3. Visual context: what real-world imagery, locations, or scenes are associated with this topic?
4. Time period and setting: when and where does this take place?

CRITICAL: If the narration references real-world entities (named ships, real military units, real places, real people), ALWAYS treat it as a REAL EVENT. Do NOT call it "fictional" or "speculative" just because it describes events you haven't heard of — news happens after your training cutoff. Only call something fictional if it involves clearly made-up entities (aliens, magic, fictional countries, etc.).

Return ONLY the analysis, no disclaimers.`,
            { maxTokens: 400, systemPrompt: 'You are a media research assistant for video production. Extract actionable visual context from any topic.', provider: 'gemini' }
        );

        if (summary && summary.trim().length > 10) {
            console.log(`   ✅ Web context analyzed:\n`);
            console.log(`   ${summary.trim()}\n`);
            return { text: summary.trim(), searchQuery: queryText };
        }

        console.log('   ℹ️ Could not extract useful context\n');
        return null;

    } catch (error) {
        console.log(`   ⚠️ Web search failed: ${error.message}`);
        return null;
    }
}

/**
 * Search Wikipedia API (free, no API key, no rate limits, no blocks)
 * Great for finding context about real events, people, and topics
 */
async function _searchWikipedia(query) {
    try {
        const resp = await axios.get('https://en.wikipedia.org/w/api.php', {
            params: {
                action: 'query',
                list: 'search',
                srsearch: query,
                srlimit: 5,
                srprop: 'snippet',
                format: 'json'
            },
            headers: { 'User-Agent': 'FacelessVideoGenerator/1.0' },
            timeout: 10000
        });

        const items = resp.data?.query?.search || [];
        if (items.length > 0) {
            const results = items.map(it => {
                const snippet = it.snippet.replace(/<[^>]+>/g, '').trim();
                return `- ${it.title}: ${snippet}`;
            });
            console.log(`   ✅ Wikipedia: found ${results.length} results`);
            return results.join('\n');
        }

        return null;
    } catch (err) {
        console.log(`   ⚠️ Wikipedia search error: ${err.message}`);
        return null;
    }
}

/**
 * Search DuckDuckGo Instant Answer API (free, no key)
 * Returns topic summaries — good complement to Wikipedia
 */
async function _searchDDGInstant(query) {
    try {
        const resp = await axios.get('https://api.duckduckgo.com/', {
            params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
            timeout: 8000
        });

        const data = resp.data;
        const results = [];

        if (data.AbstractText) {
            results.push(`- ${data.AbstractSource || 'Summary'}: ${data.AbstractText}`);
        }
        if (data.RelatedTopics) {
            for (const topic of data.RelatedTopics.slice(0, 3)) {
                if (topic.Text) results.push(`- ${topic.Text}`);
            }
        }

        if (results.length > 0) {
            console.log(`   ✅ DuckDuckGo: found ${results.length} results`);
            return results.join('\n');
        }

        return null;
    } catch (err) {
        return null;
    }
}

// ============================================================
// MAIN ENTRY POINT
// ============================================================

/**
 * Analyze script and create scenes. Single AI call does both.
 *
 * @param {Object} transcription - Whisper output: { text, duration, segments }
 * @param {Object} directorsBrief - From directors-brief.js
 * @returns {{ scenes: Array, scriptContext: Object }}
 */
async function analyzeAndCreateScenes(transcription, directorsBrief) {
    const fps = config.video.fps;
    const segments = transcription.segments || [];
    const audioDuration = transcription.duration || (segments.length > 0 ? segments[segments.length - 1].end : 0);

    // Collect all words with timestamps
    const allWords = [];
    for (const seg of segments) {
        if (seg.words && seg.words.length > 0) {
            allWords.push(...seg.words);
        }
    }

    const fullScript = allWords.length > 0
        ? allWords.map(w => w.word).join(' ').trim()
        : segments.map(s => s.text).join(' ').trim();

    console.log(`\n🎬 AI Director — Step 3`);
    console.log(`📡 Provider: ${config.aiProvider.toUpperCase()}`);
    console.log(`📝 Script: ${fullScript.length} chars, ${audioDuration.toFixed(1)}s, ${allWords.length} words`);
    console.log(`🎯 Quality: ${directorsBrief.qualityTier} | Format: ${directorsBrief.format}`);
    if (directorsBrief.freeInstructions) console.log(`📝 Instructions: "${directorsBrief.freeInstructions}"`);
    console.log('');

    // No word-level timestamps → fallback
    if (allWords.length === 0) {
        console.log('   ⚠️ No word-level timestamps — falling back to Whisper segments');
        return {
            scenes: createScenesFromWhisper(transcription),
            scriptContext: _defaultContext(fullScript)
        };
    }

    try {
        // Search web for real-world context (if Gemini key available)
        const webResult = await searchWebContext(fullScript);
        const webContext = webResult?.text || null;
        const webSearchQuery = webResult?.searchQuery || null;

        if (webContext) {
            console.log(`   💡 AI will use this context to understand the story.\n`);
        }

        // Step A: AI analyzes content (context only, no scene splitting)
        const prompt = buildDirectorPrompt(fullScript, audioDuration, directorsBrief, webContext);
        console.log(`   🧠 Director forced to Gemini (critical step — context analysis)`);
        const rawText = await callAI(prompt, { maxTokens: 1000, provider: 'gemini' });

        if (!rawText) throw new Error('Empty AI response');

        // Parse context — no --- separator needed (no scene section)
        const contextPart = rawText.split('---')[0] || rawText;

        // Parse context (legacy + new fields)
        const scriptContext = parseDirectorContext(contextPart);

        // Store video title from UI (strong signal for niche detection + keyword guidance)
        const videoTitle = (process.env.VIDEO_TITLE || '').trim();
        if (videoTitle) {
            scriptContext.videoTitle = videoTitle;
        }

        // Store web research context so Visual Planner can use it
        if (webContext) {
            scriptContext.webContext = webContext;
        }
        if (webSearchQuery) {
            scriptContext.eventAnchor = webSearchQuery;
        }

        // Override format if user specified
        if (directorsBrief.format !== 'auto') {
            scriptContext.format = directorsBrief.format;
        }

        // Store density used
        scriptContext.densityTarget = directorsBrief.tier.sceneDensity;

        // Pick niche (content strategy): user override > AI detection
        const nicheSource = (directorsBrief.nicheOverride && directorsBrief.nicheOverride !== 'auto') ? 'preset' : 'auto-detect';
        if (nicheSource === 'preset') {
            scriptContext.nicheId = directorsBrief.nicheOverride;
        } else {
            // Pass fullScript + audioDuration so the politics resolver can
            // score documentary-vs-breaking across the entire narration.
            scriptContext.nicheId = pickNicheFromContent(scriptContext, {
                fullScript,
                audioDuration,
            });
        }
        const niche = getNiche(scriptContext.nicheId);

        // Apply preset pacing hint if AI didn't detect one or user specified a preset
        const aiPacing = scriptContext.pacing || 'moderate';
        if (directorsBrief.presetPacing && (!scriptContext.pacing || scriptContext.pacing === 'moderate')) {
            scriptContext.pacing = directorsBrief.presetPacing;
        }
        const pacingSource = directorsBrief.presetPacing && scriptContext.pacing === directorsBrief.presetPacing ? 'preset' : 'ai';

        // Pick theme (visual system): user override > niche default
        const themeSource = (directorsBrief.themeOverride && directorsBrief.themeOverride !== 'auto') ? 'user' : 'niche-default';
        if (themeSource === 'user') {
            scriptContext.themeId = directorsBrief.themeOverride;
        } else {
            scriptContext.themeId = niche.defaultTheme;
        }

        // Log resolution chain
        const category = scriptContext.nicheId.startsWith('news') ? 'NEWS (breaking)' : scriptContext.nicheId.startsWith('explainer') ? 'EXPLAINER (educational)' : 'GENERAL';
        console.log(`\n   🔗 Resolution chain:`);
        console.log(`      Category: ${category}`);
        console.log(`      Niche: ${scriptContext.nicheId} (${nicheSource}${nicheSource === 'auto-detect' ? `, AI theme="${scriptContext.theme || '?'}"` : ''})`);
        console.log(`      Theme: ${scriptContext.themeId} (${themeSource}${themeSource === 'niche-default' ? `, niche.defaultTheme="${niche.defaultTheme}"` : ''})`);
        console.log(`      Pacing: ${scriptContext.pacing} (${pacingSource}${pacingSource === 'preset' ? `, AI was="${aiPacing}"` : ''})`);
        if (niche.footagePriority?.video) {
            console.log(`      Video sources: ${niche.footagePriority.video.join(' → ')}`);
        }
        if (niche.allowedMGs) {
            console.log(`      Allowed MGs: ${niche.allowedMGs.join(', ')}`);
        }

        // Step B+C: Scene splitting — deterministic smart splitter.
        //   speech-units.js → scene-boundary-scorer.js → scene-optimizer.js
        //   Pause/VAD-like units + weighted boundary scoring + DP span optimization.
        //   No punctuation splitting, no AI merge, no word-boundary force-chopping.
        const { buildSpeechUnits }    = require('./speech-units');
        const { scoreBoundaries }     = require('./scene-boundary-scorer');
        const { optimizeScenes }      = require('./scene-optimizer');
        const { getNicheSplitConfig } = require('./niches');

        const styleProfile = directorsBrief.styleProfile || null;
        const nicheCfg     = getNicheSplitConfig(scriptContext.nicheId);

        // CTA detection fallback: if AI Director didn't tag ctaStartTime,
        // scan the LAST 30% of the script for lexical sign-off cues and
        // set it to the earliest cue found. Only affects zoneAlignment/
        // ctaBand — never rewrites AI-provided values.
        const ctaSource = _ensureCtaStartTime(scriptContext, transcription, audioDuration);
        console.log(`   🎚️  SmartSplit config: niche=${scriptContext.nicheId || 'default'} hookBand=[${nicheCfg.hookBand.join(',')}] bodyBand=[${nicheCfg.bodyBand.join(',')}] ctaBand=[${nicheCfg.ctaBand.join(',')}] pauseSens=${nicheCfg.pauseSensitivity} styleProfile=${styleProfile ? 'YES' : 'no'} entities=${(scriptContext.entities||[]).length} ctaStart=${scriptContext.ctaStartTime != null ? scriptContext.ctaStartTime.toFixed(1)+'s' : 'none'} (${ctaSource})`);

        const units      = buildSpeechUnits(transcription, scriptContext, fps, nicheCfg);
        const boundaries = scoreBoundaries(units, scriptContext, styleProfile, nicheCfg, audioDuration);
        let scenes       = optimizeScenes(units, boundaries, scriptContext, styleProfile, nicheCfg, fps, audioDuration);
        console.log(`   ✅ Smart splitter: ${units.length} units → ${scenes.length} scenes (niche=${scriptContext.nicheId || 'default'})`);

        if (scenes.length === 0) throw new Error('Smart splitter returned no scenes');

        // Idea-driven: no max-scene-duration cap. AI decides scene lengths from narrative/niche.
        // Only keep a tiny-scene floor so single-word orphans get merged into neighbors.
        const pacing = scriptContext.pacing || 'moderate';
        const minSceneDur = pacing === 'fast' ? 1.8 : pacing === 'slow' ? 3.0 : 2.2;
        const hookMinDur = 1.5;
        console.log(`   ⚙️ Min-scene floor only (${pacing}): min=${minSceneDur}s, hookMin=${hookMinDur}s — no max cap (idea-driven)`);

        // Merge only — trust AI's idea-bound scene lengths, no force-splitting.
        // Zone-aware floor pulled from niche split config (works for all niches;
        // DEFAULT_SCENE_SPLIT covers unknown niches). This absorbs sub-band
        // body scenes into their shorter neighbor so short stubs next to maps
        // and other overlays stop appearing on the timeline.
        const mergeHookEnd = parseFloat(scriptContext.hookEndTime) || Math.min(25, audioDuration * 0.12);
        const beforeMerge = scenes.length;
        let zoneBandsForMerge = null;
        try {
            const { getNicheSplitConfig } = require('./niches');
            const mergeCfg = getNicheSplitConfig(scriptContext.nicheId);
            zoneBandsForMerge = {
                hook: mergeCfg.hookBand,
                body: mergeCfg.bodyBand,
                cta:  mergeCfg.ctaBand,
            };
        } catch (_) { /* fall back to scalar floors if niches module unavailable */ }
        scenes = _mergeTinyScenes(scenes, minSceneDur, mergeHookEnd, hookMinDur, {
            zoneBands: zoneBandsForMerge,
            ctaStartTime: scriptContext.ctaStartTime,
        });
        if (scenes.length !== beforeMerge) {
            console.log(`   🛡️  Orphan guard: ${beforeMerge} → ${scenes.length} scenes (absorbed ${beforeMerge - scenes.length} tiny scene${beforeMerge - scenes.length === 1 ? '' : 's'})`);
        }

        // Attach style profile early so assignTransitions can use it
        // (build-video.js also attaches it later, but transitions happen here inside the Director)
        if (directorsBrief.styleProfile) {
            scriptContext.styleProfile = directorsBrief.styleProfile;
        }

        // Assign transitions between scenes
        assignTransitions(scenes, scriptContext);

        // Map listicle sections to scene indices
        if (scriptContext.format === 'listicle' && scriptContext.sections.length > 0) {
            scriptContext.sections = _mapSectionsToScenes(scriptContext.sections, scenes);
        }

        // Listicle format: build rich item map, override hook, apply transitions
        if (scriptContext.format === 'listicle') {
            const listicle = require('./listicle-format');

            // Override hookEndTime with listicle-specific detection
            const hookResult = listicle.detectListicleHookEnd(scenes, scriptContext);
            if (hookResult.hookEndTime) {
                scriptContext.hookEndTime = hookResult.hookEndTime;
                console.log(`      [Listicle] Hook ends at ${hookResult.hookEndTime.toFixed(1)}s (${hookResult.hookSceneIndices.length} hook scenes)`);
            }

            // Hook tightening is handled inside scene-optimizer.js via the niche's
            // hookBand. Tag hook scenes with preferred media/transition for the renderer.
            const hookPacing = listicle.getListicleHookPacing();
            scriptContext.listicleHookPacing = hookPacing;
            if (hookResult.hookSceneIndices.length > 0) {
                for (const s of scenes) {
                    if (s.endTime <= (hookResult.hookEndTime || 0)) {
                        s.isListicleHook = true;
                        s.preferredMediaType = hookPacing.preferredMediaType;
                        s.transitionStyle = hookPacing.transitionStyle;
                    }
                }
            }

            // Build rich item map
            const items = listicle.buildListicleItemMap(scenes, scriptContext);
            scriptContext.listicleItems = items;
            if (items.length > 0) {
                console.log(`      [Listicle] Detected ${items.length} items: ${items.map(it => `#${it.itemNumber}`).join(', ')}`);
            }

            // Apply listicle transition rules
            for (let i = 1; i < scenes.length; i++) {
                const rule = listicle.getListicleTransitionRules(i, items, scriptContext);
                if (rule) {
                    scenes[i].transition = rule;
                }
            }
        }

        // Log results
        _logResults(scriptContext, scenes);

        return { scenes, scriptContext };

    } catch (error) {
        console.log(`   ❌ AI Director failed: ${error.message}`);
        console.log('   ↩️ Falling back to Whisper segments...\n');

        const fallbackScenes = createScenesFromWhisper(transcription);
        assignTransitions(fallbackScenes, _defaultContext(fullScript));
        return {
            scenes: fallbackScenes,
            scriptContext: _defaultContext(fullScript)
        };
    }
}

// ============================================================
// TRANSITION ASSIGNMENT
// ============================================================

/**
 * Assign transitions between scenes.
 * Types: "cut" (hard cut), "crossfade", "flash", "fade_to_black"
 *
 * Rules:
 *  - Scene 0 (first scene): always "cut" (no intro transition)
 *  - Last scene: "fade_to_black" (natural ending)
 *  - After a long pause (>0.5s gap between scenes): "fade_to_black"
 *  - Fast pacing / short scenes (<3s): prefer "cut" (70%) or "flash" (30%)
 *  - Topic change (different keywords): prefer "crossfade"
 *  - Default mix: 50% cut, 30% crossfade, 15% flash, 5% fade_to_black
 */
function assignTransitions(scenes, scriptContext) {
    if (!scenes || scenes.length === 0) return;

    const pacing = (scriptContext && scriptContext.pacing) || 'moderate';
    const isFast = pacing === 'fast' || pacing === 'rapid';
    const isSlow = pacing === 'slow' || pacing === 'relaxed';
    const themeId = (scriptContext && scriptContext.themeId) || 'standard';
    const theme = getTheme(themeId);

    // Theme-driven transition pools
    const primaryPool = theme.transitions.primary || ['crossfade'];
    const secondaryPool = theme.transitions.secondary || ['fade'];
    const avoidSet = new Set(theme.transitions.avoid || []);

    // Pacing-driven duration multiplier — fast = snappy, slow = smooth
    let durScale = isFast ? 0.4 : isSlow ? 1.5 : 1.0;

    // Cut ratio: how often to use hard cuts (pacing-driven)
    // Fast = lots of cuts, slow = very few, moderate = some
    let cutRatio = isFast ? 0.50 : isSlow ? 0.08 : 0.25;

    // Reference style inspiration — nudge toward reference's cut/crossfade ratio (50% blend, not full override)
    const styleTransitions = scriptContext && scriptContext.styleProfile && scriptContext.styleProfile.transitions;
    if (styleTransitions) {
        const nudges = [];
        if (typeof styleTransitions.cutRatio === 'number' && styleTransitions.cutRatio >= 0 && styleTransitions.cutRatio <= 1) {
            const before = cutRatio;
            cutRatio = +(cutRatio * 0.5 + styleTransitions.cutRatio * 0.5).toFixed(2); // 50/50 blend
            nudges.push(`cutRatio ${before.toFixed(2)} → ${cutRatio.toFixed(2)} (ref: ${styleTransitions.cutRatio.toFixed(2)})`);
        }
        if (typeof styleTransitions.avgTransitionDuration === 'number' && styleTransitions.avgTransitionDuration > 0) {
            const before = durScale;
            const refScale = +(styleTransitions.avgTransitionDuration / 0.5).toFixed(2);
            durScale = +(durScale * 0.5 + refScale * 0.5).toFixed(2); // 50/50 blend
            nudges.push(`durScale ${before}x → ${durScale}x (ref: ${refScale}x)`);
        }
        if (nudges.length) {
            console.log(`   🎨 [Transitions] Style inspiration nudge: ${nudges.join(', ')}`);
        }
    }

    // Get duration for a transition type from TRANSITION_LIBRARY, scaled by pacing
    function getDuration(type) {
        const libEntry = TRANSITION_LIBRARY[type];
        const baseDur = libEntry ? libEntry.duration / 1000 : 0.5; // ms → seconds
        return +(baseDur * durScale).toFixed(2);
    }

    // Pick a random transition from theme pools
    // 70% primary pool, 30% secondary pool (gives variety while staying on-theme)
    function pickThemeTransition() {
        const pool = Math.random() < 0.7 ? primaryPool : secondaryPool;
        return pool[Math.floor(Math.random() * pool.length)];
    }

    // Track recent transitions to avoid too many repeats
    const recentTypes = [];

    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];

        // First scene — no transition in
        if (i === 0) {
            scene.transition = { type: 'cut', duration: 0 };
            continue;
        }

        // Last scene — fade out
        if (i === scenes.length - 1) {
            scene.transition = { type: 'fade_to_black', duration: getDuration('fade_to_black') || +(0.4 * durScale).toFixed(2) };
            continue;
        }

        const prev = scenes[i - 1];
        const gap = scene.startTime - prev.endTime;
        const sceneDuration = scene.endTime - scene.startTime;

        // Gap between scenes — natural pause = fade to black
        if (gap > 0.5) {
            scene.transition = { type: 'fade_to_black', duration: getDuration('fade_to_black') || +(0.4 * durScale).toFixed(2) };
            continue;
        }

        // Very short scene — hard cut (transitions look bad on <2s scenes)
        if (sceneDuration < 2) {
            scene.transition = { type: 'cut', duration: 0 };
            continue;
        }

        // Roll for cut vs themed transition
        if (Math.random() < cutRatio) {
            scene.transition = { type: 'cut', duration: 0 };
            continue;
        }

        // Pick from theme pools, avoid repeating the same type 3x in a row
        let type = pickThemeTransition();
        let attempts = 0;
        while (attempts < 5 && recentTypes.length >= 2 &&
               recentTypes[recentTypes.length - 1] === type &&
               recentTypes[recentTypes.length - 2] === type) {
            type = pickThemeTransition();
            attempts++;
        }

        // Safety: if somehow picked an avoided transition, re-pick
        if (avoidSet.has(type)) {
            type = primaryPool[Math.floor(Math.random() * primaryPool.length)];
        }

        scene.transition = { type, duration: getDuration(type) };
        recentTypes.push(type);
        if (recentTypes.length > 4) recentTypes.shift();
    }

    const counts = {};
    scenes.forEach(s => {
        const t = s.transition?.type || 'cut';
        counts[t] = (counts[t] || 0) + 1;
    });
    console.log(`   🎬 Transitions (theme: ${themeId}, pacing: ${pacing}, speed: ${durScale}x): ${Object.entries(counts).map(([k,v]) => `${k}=${v}`).join(', ')}`);
}

// ============================================================
// HELPERS
// ============================================================

function _defaultContext(fullScript) {
    return {
        summary: fullScript.substring(0, 80).trim(),
        theme: '', tone: '', mood: '', pacing: 'moderate', visualStyle: 'cinematic',
        entities: [], keyStats: [], mainPoints: [], targetAudience: '', emotionalArc: '',
        format: 'documentary', sections: [],
        ctaDetected: false, ctaStartTime: null, hookEndTime: null,
        densityTarget: 3, nicheId: 'general', themeId: 'standard'
    };
}

/**
 * Map section titles to scene indices by fuzzy matching section names to scene text.
 */
function _mapSectionsToScenes(sectionTitles, scenes) {
    const mapped = [];
    for (const title of sectionTitles) {
        const titleLower = normalize(title);
        let bestScene = 0;
        let bestScore = 0;
        for (let i = 0; i < scenes.length; i++) {
            const sceneLower = normalize(scenes[i].text);
            // Check if section title words appear in scene text
            const titleWords = titleLower.split(/\s+/);
            let matches = 0;
            for (const tw of titleWords) {
                if (sceneLower.includes(tw)) matches++;
            }
            const score = matches / titleWords.length;
            if (score > bestScore) {
                bestScore = score;
                bestScene = i;
            }
        }
        mapped.push({ title, startSceneIndex: bestScene });
    }
    return mapped;
}

function _logResults(ctx, scenes) {
    console.log(`\n   📌 Director's Analysis:`);
    console.log(`      Summary: "${ctx.summary || 'unknown'}"`);
    console.log(`      Theme: ${ctx.theme || '?'} | Tone: ${ctx.tone || '?'} | Mood: ${ctx.mood || '?'}`);
    console.log(`      Pacing: ${ctx.pacing || '?'} | Style: ${ctx.visualStyle || '?'}`);
    console.log(`      Format: ${ctx.format} | Niche: ${ctx.nicheId || 'general'} | Theme: ${ctx.themeId || 'standard'}`);
    if (ctx.entities.length > 0) console.log(`      Entities: ${ctx.entities.join(', ')}`);
    if (ctx.hookEndTime) console.log(`      Hook ends: ~${ctx.hookEndTime}s`);
    if (ctx.ctaDetected) console.log(`      CTA detected: ~${ctx.ctaStartTime}s`);
    if (ctx.sections.length > 0) console.log(`      Sections: ${ctx.sections.map(s => s.title || s).join(' | ')}`);

    console.log(`\n   🎬 Scenes: ${scenes.length}`);
    for (const s of scenes) {
        const dur = (s.endTime - s.startTime).toFixed(1);
        console.log(`      Scene ${s.index}: ${s.startTime.toFixed(2)}s → ${s.endTime.toFixed(2)}s (${dur}s) "${s.text.substring(0, 50)}..."`);
    }
    console.log('');
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    analyzeAndCreateScenes,
    buildDirectorPrompt,
    parseDirectorContext,
    buildScenesFromAnchors,
    findWordIndex,
    normalize,
    createScenesFromWhisper,
    assignTransitions,
    // Exposed for Style Studio chat-driven scene planning
    _splitAtPunctuation
};
