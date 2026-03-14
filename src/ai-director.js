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
const { searchWeb, hasAnyWebSearchCredentials } = require('./web-search-client');

// ============================================================
// PROMPT BUILDER
// ============================================================

/**
 * Build the AI prompt for scene splitting + context analysis.
 * Prompt is in its own function so it can be tweaked independently.
 */
function buildDirectorPrompt(fullScript, audioDuration, directorsBrief, webContext = null) {
    const { freeInstructions, format, qualityTier, audienceHint, tier } = directorsBrief;
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

    if (webContext) {
        prompt += `\n\nREAL-WORLD CONTEXT (from web search):
${webContext}

Use this context to understand the story better. If this is a real event, treat it with appropriate gravity and split scenes to show key moments (discovery, investigation steps, evidence, etc.).`;
    }

    if (freeInstructions) {
        prompt += `\n\nUSER INSTRUCTIONS (follow these closely, they override defaults):
${freeInstructions}`;
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

SCENE SPLITTING RULES (MANDATORY — DO NOT IGNORE):

⚠️ CRITICAL: This is a FACELESS VIDEO. Split based on IDEAS, not on sentences or time intervals.

1. WHAT IS A SCENE?
   A scene = ONE complete visual idea or piece of information. Ask yourself:
   "What would the viewer SEE on screen for this part?"
   If the answer is the SAME visual → it's ONE scene, even if it spans multiple sentences.
   If the answer CHANGES → that's a new scene.

   GOOD splitting (by idea):
   - "The drone descended 5000 meters into total darkness. No sunlight. No life." → 1 scene (one visual: drone descending into dark water)
   - "Then it found something. On the seafloor, oxygen was being produced." → 1 scene (one visual: discovery on seafloor)

   BAD splitting (by sentence):
   - "A joint research" → Scene 8 (0.7 seconds — meaningless fragment!)
   - "effort involving institutions across continents" → Scene 9 (this is the SAME idea as Scene 8!)

2. TARGET: approximately ${targetScenes} scenes for ${audioDuration.toFixed(1)}s of audio.
   - Ideal scene length: 5-10 seconds (gives each visual time to land)
   - Minimum scene length: 3 seconds (anything shorter is a jarring cut)
   - Maximum scene length: 15 seconds (split if it gets longer)
   - NEVER create scenes under 2 seconds — merge short fragments with adjacent scenes

3. SPLITTING TRIGGERS (when to start a new scene):
   - The TOPIC changes (new subject, new entity, new location)
   - The VISUAL changes (what you'd show on screen is different)
   - A new SECTION begins (listicle item, new chapter, new argument)
   - The MOOD shifts (dramatic reveal, tone change, climax)

   DO NOT split just because:
   - A new sentence started (sentences within the same idea = same scene)
   - You reached 5 seconds (time alone is not a reason to split)
   - A comma or pause exists (natural speech pauses are not scene breaks)

4. HARD RULES:
   - Each scene MUST be at least 3 seconds long
   - Boundaries at sentence/clause breaks only (never mid-word)
   - First scene starts at 0s, last scene ends at ${audioDuration.toFixed(1)}s
   - NO GAPS between scenes
   - Group related sentences into ONE scene when they describe the same visual

5. OUTPUT FORMAT:
   For each scene, write the EXACT first 5-6 words from the script (must match transcript exactly)

Reply in EXACTLY this format:
summary: <1 sentence, max 20 words>
theme: <technology|history|finance|science|health|travel|politics|entertainment|education|sports|nature|business|lifestyle|motivation|crime|mystery>
tone: <informative|dramatic|casual|urgent|inspirational|educational|serious|lighthearted|emotional|suspenseful>
mood: <dark|uplifting|tense|calm|energetic|nostalgic|hopeful|mysterious|intense|playful>
pacing: <fast|moderate|slow>
visualStyle: <cinematic|documentary|corporate|lifestyle|abstract|nature|urban|tech|vintage|minimalist>
entities: <comma-separated key people, companies, places, or "none">
stats: <comma-separated key numbers/statistics, or "none">
format: <documentary|listicle>
sections: <comma-separated section titles if listicle, or "none">
hookEnd: <approximate seconds where the hook/intro ends, e.g. "18">
ctaStart: <approximate seconds where CTA/sign-off begins, or "none">
background: <dark|tech|nature|warm|neutral>
scenes: <total number of scenes>
---
SCENE 1: <exact first 5-6 words from the script>
SCENE 2: <exact first 5-6 words from the script>
SCENE 3: <exact first 5-6 words from the script>
...`;

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
        themeId: 'neutral'   // Visual system (colors, fonts, transitions, overlays)
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
                result.entities = val.split(',').map(s => s.trim()).filter(Boolean);
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
function _mergeTinyScenes(scenes, minDuration = 3.0) {
    if (scenes.length <= 1) return scenes;

    let merged = [...scenes];
    let mergeCount = 0;

    // Keep merging until no tiny scenes remain
    let changed = true;
    while (changed) {
        changed = false;
        const next = [];
        for (let i = 0; i < merged.length; i++) {
            const scene = merged[i];
            const duration = (scene.endTime || 0) - (scene.startTime || 0);

            if (duration < minDuration && next.length > 0) {
                // Merge into previous scene
                const prev = next[next.length - 1];
                prev.endTime = scene.endTime;
                prev.endFrame = scene.endFrame;
                prev.text = (prev.text || '') + ' ' + (scene.text || '');
                if (scene.words) prev.words = [...(prev.words || []), ...scene.words];
                mergeCount++;
                changed = true;
            } else if (duration < minDuration && i + 1 < merged.length) {
                // First scene is tiny — merge into next
                const nextScene = merged[i + 1];
                nextScene.startTime = scene.startTime;
                nextScene.startFrame = scene.startFrame;
                nextScene.text = (scene.text || '') + ' ' + (nextScene.text || '');
                if (scene.words) nextScene.words = [...(scene.words || []), ...(nextScene.words || [])];
                mergeCount++;
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
        console.log(`   🔀 Merged ${mergeCount} tiny scenes (< ${minDuration}s) → ${merged.length} scenes`);
    }

    return merged;
}

function autoSplitLongScenes(scenes, allWords, audioDuration, fps, maxDuration = 8.0) {
    const newScenes = [];
    let splitCount = 0;

    for (const scene of scenes) {
        const duration = scene.endTime - scene.startTime;

        if (duration <= maxDuration) {
            newScenes.push(scene);
            continue;
        }

        // Scene is too long — split it
        console.log(`   ✂️ Auto-splitting long scene ${scene.index} (${duration.toFixed(1)}s > ${maxDuration}s)`);

        const targetChunks = Math.ceil(duration / maxDuration);
        const targetChunkDuration = duration / targetChunks;

        // Find natural break points (sentence boundaries or pauses)
        const sceneWords = scene.words || [];
        const breakPoints = [0]; // Start index

        if (sceneWords.length > 0) {
            for (let i = 1; i < sceneWords.length - 1; i++) {
                const word = sceneWords[i];
                const timeSinceStart = word.start - scene.startTime;

                // Is this close to a target break point?
                const nearestChunk = Math.round(timeSinceStart / targetChunkDuration);
                const targetTime = nearestChunk * targetChunkDuration;
                const timeError = Math.abs(timeSinceStart - targetTime);

                // If within 1.5s of target AND it's a sentence boundary, mark it
                if (timeError < 1.5 && _isSentenceBoundary(word)) {
                    const lastBreak = breakPoints[breakPoints.length - 1];
                    const wordsSinceBreak = i - lastBreak;

                    // Don't create tiny chunks (need at least 3 words)
                    if (wordsSinceBreak >= 3) {
                        breakPoints.push(i);
                    }
                }
            }

            // Fallback: if no natural breaks found, force split at nearest word to target times
            if (breakPoints.length === 1 && targetChunks > 1) {
                console.log(`      ⚠️ No sentence boundaries found — forcing split at nearest words`);
                for (let chunk = 1; chunk < targetChunks; chunk++) {
                    const targetTime = chunk * targetChunkDuration;
                    let bestIdx = -1;
                    let bestDist = Infinity;
                    for (let i = 1; i < sceneWords.length - 1; i++) {
                        const dist = Math.abs((sceneWords[i].start - scene.startTime) - targetTime);
                        if (dist < bestDist) {
                            bestDist = dist;
                            bestIdx = i;
                        }
                    }
                    if (bestIdx > 0) {
                        const lastBreak = breakPoints[breakPoints.length - 1];
                        if (bestIdx - lastBreak >= 3) {
                            breakPoints.push(bestIdx);
                        }
                    }
                }
            }
        }

        breakPoints.push(sceneWords.length); // End index

        // If still only 1 chunk (no words or no valid splits), do time-based split
        if (breakPoints.length <= 2 && targetChunks > 1) {
            console.log(`      ⚠️ No word-based splits possible — splitting by time`);
            const timeSplits = [];
            for (let chunk = 0; chunk < targetChunks; chunk++) {
                const chunkStart = scene.startTime + chunk * targetChunkDuration;
                const chunkEnd = chunk < targetChunks - 1
                    ? scene.startTime + (chunk + 1) * targetChunkDuration
                    : scene.endTime;
                timeSplits.push({
                    index: newScenes.length + chunk,
                    text: scene.text ? scene.text.substring(
                        Math.floor(chunk * scene.text.length / targetChunks),
                        Math.floor((chunk + 1) * scene.text.length / targetChunks)
                    ).trim() : '',
                    startTime: chunkStart,
                    endTime: chunkEnd,
                    duration: Math.round((chunkEnd - chunkStart) * fps),
                    words: []
                });
                splitCount++;
            }
            newScenes.push(...timeSplits);
            continue; // Skip normal sub-scene creation
        }

        // Create sub-scenes
        for (let i = 0; i < breakPoints.length - 1; i++) {
            const startIdx = breakPoints[i];
            const endIdx = breakPoints[i + 1];
            const chunk = sceneWords.slice(startIdx, endIdx);

            if (chunk.length === 0) continue; // Skip empty chunks

            const chunkStart = chunk[0].start;
            const chunkEnd = i < breakPoints.length - 2
                ? sceneWords[endIdx].start
                : scene.endTime;

            newScenes.push({
                index: newScenes.length,
                text: chunk.map(w => w.word).join(' ').trim(),
                startTime: chunkStart,
                endTime: chunkEnd,
                duration: Math.round((chunkEnd - chunkStart) * fps),
                words: chunk
            });

            splitCount++;
        }
    }

    // Reindex all scenes
    newScenes.forEach((s, i) => s.index = i);

    if (splitCount > 0) {
        console.log(`   ✅ Auto-split ${splitCount} long scene(s) → ${newScenes.length} total scenes\n`);
    }

    return newScenes;
}

/**
 * Check if a word is at a sentence boundary (after punctuation or pause).
 */
function _isSentenceBoundary(word) {
    const text = word.word.trim();
    const prevText = text.toLowerCase();

    // Ends with punctuation
    if (/[.!?,;:]$/.test(text)) return true;

    // Starts with capital letter (new sentence)
    if (/^[A-Z]/.test(text)) return true;

    // Common sentence starters
    if (['and', 'but', 'so', 'then', 'now', 'after', 'when', 'while', 'before'].includes(prevText)) {
        return true;
    }

    return false;
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
                { maxTokens: 30, systemPrompt: 'You extract search queries. Output ONLY the query, no explanation.' }
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

        // Step 2: Use the selected AI provider to analyze search results + script
        const summary = await callAI(
            `You are analyzing a video narration and web search results to extract context that will help an AI plan visual scenes.

Narration preview: "${preview}..."

Web search results:
${searchSnippets}

Provide a brief analysis (3-5 sentences) covering:
1. What is the main topic/subject? (real event, scientific topic, trending story, fictional scenario, etc.)
2. Key entities: people, places, organizations, objects mentioned
3. Visual context: what real-world imagery, locations, or scenes are associated with this topic?
4. Time period and setting: when and where does this take place?

Always provide useful context — even if the topic is speculative or fictional, describe the real-world elements it references (real locations, real technology, real phenomena, etc.) that would help find relevant footage.

Return ONLY the analysis, no disclaimers.`,
            { maxTokens: 400, systemPrompt: 'You are a media research assistant for video production. Extract actionable visual context from any topic.' }
        );

        if (summary && summary.trim().length > 10) {
            console.log(`   ✅ Web context analyzed:\n`);
            console.log(`   ${summary.trim()}\n`);
            return summary.trim();
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
        const webContext = await searchWebContext(fullScript);

        if (webContext) {
            console.log(`   💡 AI will use this context to understand the story and split scenes intelligently.\n`);
        }

        const prompt = buildDirectorPrompt(fullScript, audioDuration, directorsBrief, webContext);
        const rawText = await callAI(prompt, { maxTokens: 1500 });

        if (!rawText) throw new Error('Empty AI response');

        // Split on --- separator
        const parts = rawText.split('---');
        const contextPart = parts[0] || '';
        const scenesPart = parts[1] || '';

        // Parse context (legacy + new fields)
        const scriptContext = parseDirectorContext(contextPart);

        // Store web research context so Visual Planner can use it
        if (webContext) {
            scriptContext.webContext = webContext;
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
            scriptContext.nicheId = pickNicheFromContent(scriptContext);
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
        console.log(`\n   🔗 Resolution chain:`);
        console.log(`      Niche: ${scriptContext.nicheId} (${nicheSource}${nicheSource === 'auto-detect' ? `, AI theme="${scriptContext.theme || '?'}"` : ''})`);
        console.log(`      Theme: ${scriptContext.themeId} (${themeSource}${themeSource === 'niche-default' ? `, niche.defaultTheme="${niche.defaultTheme}"` : ''})`);
        console.log(`      Pacing: ${scriptContext.pacing} (${pacingSource}${pacingSource === 'preset' ? `, AI was="${aiPacing}"` : ''})`);

        // Parse scene anchors
        const sceneLines = scenesPart.trim().split('\n').filter(line => {
            const lower = line.toLowerCase().trim();
            return lower.startsWith('scene ') && lower.includes(':');
        });

        if (sceneLines.length === 0) throw new Error('AI returned no scene boundaries');

        const sceneAnchors = sceneLines.map(line => {
            const colonIndex = line.indexOf(':');
            return colonIndex >= 0 ? line.substring(colonIndex + 1).trim() : '';
        }).filter(Boolean);

        console.log(`   📊 AI planned ${sceneAnchors.length} scenes`);

        // Build scenes from anchors
        let scenes = buildScenesFromAnchors(sceneAnchors, allWords, audioDuration, fps);

        if (scenes.length === 0) throw new Error('No valid scenes after mapping');

        // Post-processing: Auto-split scenes longer than 12 seconds
        scenes = autoSplitLongScenes(scenes, allWords, audioDuration, fps, 12.0);

        // Post-processing: Merge scenes shorter than 3 seconds into neighbors
        scenes = _mergeTinyScenes(scenes, 3.0);

        // Assign transitions between scenes
        assignTransitions(scenes, scriptContext);

        // Map listicle sections to scene indices
        if (scriptContext.format === 'listicle' && scriptContext.sections.length > 0) {
            scriptContext.sections = _mapSectionsToScenes(scriptContext.sections, scenes);
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

    // Pacing-driven duration multiplier — fast = snappy, slow = smooth
    const durScale = isFast ? 0.4 : isSlow ? 1.5 : 1.0;

    // Base durations (moderate pacing) — scaled by durScale
    const dur = {
        crossfade:     +(0.5 * durScale).toFixed(2),   // fast: 0.2s, moderate: 0.5s, slow: 0.75s
        flash:         +(0.15 * durScale).toFixed(2),   // fast: 0.06s, moderate: 0.15s, slow: 0.23s
        fade_to_black: +(0.4 * durScale).toFixed(2),    // fast: 0.16s, moderate: 0.4s, slow: 0.6s
        slide:         +(0.35 * durScale).toFixed(2),    // fast: 0.14s, moderate: 0.35s, slow: 0.53s
        wipe:          +(0.4 * durScale).toFixed(2),     // fast: 0.16s, moderate: 0.4s, slow: 0.6s
        zoom:          +(0.35 * durScale).toFixed(2),    // fast: 0.14s, moderate: 0.35s, slow: 0.53s
        blur:          +(0.4 * durScale).toFixed(2),     // fast: 0.16s, moderate: 0.4s, slow: 0.6s
        dissolve:      +(0.5 * durScale).toFixed(2),     // fast: 0.2s, moderate: 0.5s, slow: 0.75s
    };

    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];

        // First scene — no transition in
        if (i === 0) {
            scene.transition = { type: 'cut', duration: 0 };
            continue;
        }

        // Last scene — fade out
        if (i === scenes.length - 1) {
            scene.transition = { type: 'fade_to_black', duration: dur.fade_to_black };
            continue;
        }

        const prev = scenes[i - 1];
        const gap = scene.startTime - prev.endTime;
        const sceneDuration = scene.endTime - scene.startTime;

        // Gap between scenes — natural pause = fade to black
        if (gap > 0.5) {
            scene.transition = { type: 'fade_to_black', duration: dur.fade_to_black };
            continue;
        }

        // Very short scene or fast pacing — hard cut or flash
        if (isFast || sceneDuration < 3) {
            const r = Math.random();
            scene.transition = r < 0.7
                ? { type: 'cut', duration: 0 }
                : { type: 'flash', duration: dur.flash };
            continue;
        }

        // Slow pacing — more crossfades and dissolves, fewer cuts
        if (isSlow) {
            const r = Math.random();
            if (r < 0.15) {
                scene.transition = { type: 'cut', duration: 0 };
            } else if (r < 0.55) {
                scene.transition = { type: 'crossfade', duration: dur.crossfade };
            } else if (r < 0.75) {
                scene.transition = { type: 'dissolve', duration: dur.dissolve };
            } else if (r < 0.90) {
                scene.transition = { type: 'blur', duration: dur.blur };
            } else {
                scene.transition = { type: 'fade_to_black', duration: dur.fade_to_black };
            }
            continue;
        }

        // Default (moderate): weighted random
        const r = Math.random();
        if (r < 0.45) {
            scene.transition = { type: 'cut', duration: 0 };
        } else if (r < 0.80) {
            scene.transition = { type: 'crossfade', duration: dur.crossfade };
        } else if (r < 0.93) {
            scene.transition = { type: 'flash', duration: dur.flash };
        } else {
            scene.transition = { type: 'fade_to_black', duration: dur.fade_to_black };
        }
    }

    const counts = {};
    scenes.forEach(s => {
        const t = s.transition?.type || 'cut';
        counts[t] = (counts[t] || 0) + 1;
    });
    console.log(`   🎬 Transitions (pacing: ${pacing}, speed: ${durScale}x): ${Object.entries(counts).map(([k,v]) => `${k}=${v}`).join(', ')}`);
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
        densityTarget: 3, nicheId: 'general', themeId: 'neutral'
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
    console.log(`      Format: ${ctx.format} | Niche: ${ctx.nicheId || 'general'} | Theme: ${ctx.themeId || 'neutral'}`);
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
    assignTransitions
};
