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
const { pickThemeFromContent } = require('./themes');
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

⚠️ CRITICAL: This is a FACELESS VIDEO. You MUST create frequent scene changes (every 3-7 seconds).
   If scenes are too long (10+ seconds), viewers will lose interest and leave.

1. TARGET: YOU MUST CREATE ${targetScenes} SCENES (minimum).
   - Audio duration: ${audioDuration.toFixed(1)}s
   - Base density: ${baseDensity} scenes/min
   - Adjust for pacing:
     • Fast pacing → ${Math.round(targetScenes * 1.2)}-${Math.round(targetScenes * 1.4)} scenes (quick cuts, 3-5s each)
     • Moderate pacing → ${targetScenes}-${Math.round(targetScenes * 1.2)} scenes (4-7s each)
     • Slow pacing → ${Math.round(targetScenes * 0.9)}-${Math.round(targetScenes * 1.1)} scenes (5-8s each)

2. EXAMPLE: For a 40-second video at 4 scenes/min:
   - Target: (40/60) × 4 = 2.67 → minimum 4 scenes
   - Split like this:
     SCENE 1: 0-7s   (hook, opening statement)
     SCENE 2: 7-14s  (first key point)
     SCENE 3: 14-24s (second key point)
     SCENE 4: 24-30s (third detail)
     SCENE 5: 30-37s (conclusion)
     SCENE 6: 37-40s (final thought)
   - Result: 6 scenes, average 6.7s each ✓

3. SPLITTING LOGIC:
   - Cut when the topic shifts (new person, event, location, idea)
   - Cut when a new sentence begins (after 4-5 seconds)
   - Cut when transitioning from setup → detail → conclusion
   - NEVER keep the same shot for 10+ seconds

4. HARD RULES:
   - MINIMUM ${targetScenes} scenes, NO EXCEPTIONS
   - MAXIMUM 10 seconds per scene
   - Each scene = ONE visual idea
   - Boundaries at sentence/clause breaks only (never mid-word)
   - First scene starts at 0s, last scene ends at ${audioDuration.toFixed(1)}s
   - NO GAPS between scenes

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
        themeId: 'neutral' // Unified theme system (replaces backgroundCanvas)
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
        const sceneWords = scene.words;
        const breakPoints = [0]; // Start index

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

        breakPoints.push(sceneWords.length); // End index

        // Create sub-scenes
        for (let i = 0; i < breakPoints.length - 1; i++) {
            const startIdx = breakPoints[i];
            const endIdx = breakPoints[i + 1];
            const chunk = sceneWords.slice(startIdx, endIdx);

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
    const preview = fullScript.substring(0, 300).trim();

    try {
        console.log('   🔍 Searching web for context...');

        // Step 1: Search for context
        // Clean query: keep only words, collapse whitespace, limit to ~80 chars for CSE
        const queryText = preview.substring(0, 120)
            .replace(/[^\w\s'-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .substring(0, 80);
        let searchSnippets = '';

        // API-first web search (Tavily -> Google CSE fallback)
        if (hasAnyWebSearchCredentials()) {
            try {
                if (!queryText) {
                    throw new Error('query became empty after normalization');
                }
                const { items, provider, errors } = await searchWeb(queryText, {
                    num: 5,
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

        // Step 2: Use the selected AI provider to summarize search results
        const summary = await callAI(
            `Based on these web search results about a video narration, provide a brief factual summary (2-3 sentences max):

Narration preview: "${preview}..."

Web search results:
${searchSnippets}

Answer these:
1. Is this about a REAL event/person or fictional?
2. If real, when did it happen? What year?
3. Key context: What is the full story?

Return ONLY a brief summary with the key facts. If nothing relevant was found, say "No real-world context found."`,
            { maxTokens: 300, systemPrompt: 'You are a research assistant. Be concise and factual.' }
        );

        if (summary && summary.trim().length > 10 && !summary.toLowerCase().includes('no real-world context')) {
            console.log(`   ✅ Web search found:\n`);
            console.log(`   ${summary.trim()}\n`);
            return summary.trim();
        }

        console.log('   ℹ️ No real-world context found (may be fictional)\n');
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

        console.log(`   [AI Response Preview]:\n${rawText.substring(0, 600)}${rawText.length > 600 ? '...' : ''}\n`);

        // Split on --- separator
        const parts = rawText.split('---');
        const contextPart = parts[0] || '';
        const scenesPart = parts[1] || '';

        // Parse context (legacy + new fields)
        const scriptContext = parseDirectorContext(contextPart);

        // Override format if user specified
        if (directorsBrief.format !== 'auto') {
            scriptContext.format = directorsBrief.format;
        }

        // Store density used
        scriptContext.densityTarget = directorsBrief.tier.sceneDensity;

        // Pick unified theme (user override or AI decision)
        if (directorsBrief.themeOverride && directorsBrief.themeOverride !== 'auto') {
            // User manually selected a theme
            scriptContext.themeId = directorsBrief.themeOverride;
        } else {
            // Let AI pick theme based on content analysis
            scriptContext.themeId = pickThemeFromContent(scriptContext);
        }

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

        // Post-processing: Auto-split scenes longer than 8 seconds
        scenes = autoSplitLongScenes(scenes, allWords, audioDuration, fps, 8.0);

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

    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];

        // First scene — no transition in
        if (i === 0) {
            scene.transition = { type: 'cut', duration: 0 };
            continue;
        }

        // Last scene — fade out
        if (i === scenes.length - 1) {
            scene.transition = { type: 'fade_to_black', duration: 0.5 };
            continue;
        }

        const prev = scenes[i - 1];
        const gap = scene.startTime - prev.endTime;
        const sceneDuration = scene.endTime - scene.startTime;

        // Gap between scenes — natural pause = fade to black
        if (gap > 0.5) {
            scene.transition = { type: 'fade_to_black', duration: 0.4 };
            continue;
        }

        // Very short scene or fast pacing — hard cut or flash
        if (isFast || sceneDuration < 3) {
            const r = Math.random();
            scene.transition = r < 0.7
                ? { type: 'cut', duration: 0 }
                : { type: 'flash', duration: 0.15 };
            continue;
        }

        // Default: weighted random
        const r = Math.random();
        if (r < 0.45) {
            scene.transition = { type: 'cut', duration: 0 };
        } else if (r < 0.80) {
            scene.transition = { type: 'crossfade', duration: 0.5 };
        } else if (r < 0.93) {
            scene.transition = { type: 'flash', duration: 0.15 };
        } else {
            scene.transition = { type: 'fade_to_black', duration: 0.4 };
        }
    }

    const counts = {};
    scenes.forEach(s => {
        const t = s.transition?.type || 'cut';
        counts[t] = (counts[t] || 0) + 1;
    });
    console.log(`   🎬 Transitions: ${Object.entries(counts).map(([k,v]) => `${k}=${v}`).join(', ')}`);
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
        densityTarget: 3, themeId: 'neutral' // Unified theme system
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
    console.log(`      Format: ${ctx.format} | ThemeID: ${ctx.themeId || 'neutral'}`);
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
