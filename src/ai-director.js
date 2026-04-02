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
function _mergeTinyScenes(scenes, minDuration = 3.0, hookEndTime = 0, hookMinDuration = 1.5) {
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

            // Hook scenes can be shorter — fast cuts are intentional
            const isHook = hookEndTime > 0 && (scene.startTime || 0) < hookEndTime;
            const effectiveMin = isHook ? hookMinDuration : minDuration;

            if (duration < effectiveMin && next.length > 0) {
                // Merge into previous scene
                const prev = next[next.length - 1];
                prev.endTime = scene.endTime;
                prev.endFrame = scene.endFrame;
                prev.text = (prev.text || '') + ' ' + (scene.text || '');
                if (scene.words) prev.words = [...(prev.words || []), ...scene.words];
                mergeCount++;
                changed = true;
            } else if (duration < effectiveMin && i + 1 < merged.length) {
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
// PUNCTUATION-BASED SCENE SPLITTING
// ============================================================

/**
 * Split transcript into micro-scenes at every sentence/clause boundary (. , ! ? ; :).
 * This creates many small scenes that AI will merge in the next step.
 *
 * @param {Array} allWords - Word-level timestamps from Whisper
 * @param {number} audioDuration - Total audio duration in seconds
 * @param {number} fps - Frames per second
 * @returns {Array} Micro-scenes with text, startTime, endTime, words
 */
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

/**
 * AI reviews micro-scenes and returns merge instructions.
 * Groups related clauses into proper visual scenes.
 *
 * @param {Array} microScenes - Punctuation-split micro-scenes
 * @param {Object} scriptContext - Parsed context from Director
 * @param {number} audioDuration - Total audio duration
 * @param {Object} directorsBrief - Build settings
 * @returns {Array} Merged scenes
 */
async function _aiMergeScenes(microScenes, scriptContext, audioDuration, directorsBrief) {
    const { tier } = directorsBrief;
    const baseDensity = tier.sceneDensity || 3;
    const targetScenes = Math.max(4, Math.round((audioDuration / 60) * baseDensity));

    // Build rich context block so AI understands the topic deeply
    const contextLines = [];
    contextLines.push(`TOPIC: ${scriptContext.summary || 'unknown'}`);
    if (scriptContext.webContext) contextLines.push(`RESEARCH CONTEXT: ${scriptContext.webContext.substring(0, 500)}`);
    if (scriptContext.entities?.length > 0) contextLines.push(`KEY ENTITIES: ${scriptContext.entities.slice(0, 10).join(', ')}`);
    if (scriptContext.theme) contextLines.push(`THEME: ${scriptContext.theme}`);
    if (scriptContext.tone) contextLines.push(`TONE: ${scriptContext.tone}`);
    if (scriptContext.format) contextLines.push(`FORMAT: ${scriptContext.format}`);
    const contextBlock = contextLines.join('\n');

    // ── Detect pacing zones ──
    const pacing = scriptContext.pacing || 'moderate';
    const hookEnd = parseFloat(scriptContext.hookEndTime) || Math.min(25, audioDuration * 0.12);
    const ctaStart = parseFloat(scriptContext.ctaStartTime) || (audioDuration * 0.92);

    // ── Chunk micro-segments into batches of ~80 to avoid overwhelming AI ──
    const CHUNK_SIZE = 80;
    const allMergedScenes = [];

    for (let chunkStart = 0; chunkStart < microScenes.length; chunkStart += CHUNK_SIZE) {
        const chunkEnd = Math.min(chunkStart + CHUNK_SIZE, microScenes.length);
        const chunk = microScenes.slice(chunkStart, chunkEnd);
        const chunkStartTime = chunk[0].startTime || 0;
        const chunkEndTime = chunk[chunk.length - 1].endTime || 0;
        const chunkDuration = chunkEndTime - chunkStartTime;

        // Determine zone-aware density for this chunk
        const hookOverlap = Math.max(0, Math.min(hookEnd, chunkEndTime) - chunkStartTime);
        const ctaOverlap = Math.max(0, chunkEndTime - Math.max(ctaStart, chunkStartTime));
        const bodyOverlap = chunkDuration - hookOverlap - ctaOverlap;

        // Hook density scales with pacing, Body uses baseDensity, CTA breathes
        const hookDensity = pacing === 'fast' ? 7 : pacing === 'slow' ? 4 : 5.5;
        const ctaDensity = pacing === 'fast' ? 2.5 : 1.5;
        const hookScenes = Math.round((hookOverlap / 60) * hookDensity);
        const bodyScenes = Math.round((bodyOverlap / 60) * baseDensity);
        const ctaScenes = Math.round((ctaOverlap / 60) * ctaDensity);
        const chunkTarget = Math.max(2, hookScenes + bodyScenes + ctaScenes);

        const sceneList = chunk.map((s, i) =>
            `[${chunkStart + i}] (${s.startTime.toFixed(1)}s-${s.endTime.toFixed(1)}s) "${s.text}"`
        ).join('\n');

        // Build pacing zone instructions for this chunk
        let pacingZoneInstructions = '';
        const hookRange = pacing === 'fast' ? '2-3.5' : pacing === 'slow' ? '3-5' : '2-4';
        const bodyRange = pacing === 'fast' ? '3-7' : pacing === 'slow' ? '6-12' : '4-8';
        const ctaRange = pacing === 'fast' ? '5-8' : pacing === 'slow' ? '8-12' : '6-10';

        if (hookOverlap > 2) {
            pacingZoneInstructions += `\n🔥 HOOK ZONE (0s - ${hookEnd.toFixed(0)}s): This is the HOOK — viewer decides to stay or leave. Pacing: ${pacing}.
   - FAST CUTS: ${hookRange} seconds per scene. Every sentence or strong clause = new scene.
   - Each scene = a different visual. Rapid variety keeps the viewer hooked.
   - A bold claim, a stat, a question — each gets its OWN scene with its own footage.
   - Example: "This house can survive an EF5 tornado." = scene 1 (tornado damage footage)
             "It cuts energy bills by 75%." = scene 2 (energy/utility footage)
             "Yet less than 900 exist." = scene 3 (aerial suburban homes)
   - Do NOT merge hook segments into long scenes. Every idea = a CUT.`;
        }
        if (bodyOverlap > 2) {
            pacingZoneInstructions += `\n📖 BODY ZONE (${hookEnd.toFixed(0)}s - ${ctaStart.toFixed(0)}s): Main content. Pacing: ${pacing}.
   - ${bodyRange} seconds per scene. Merge related clauses about the SAME visual.
   - NEW scene when the SUBJECT changes (new person, place, concept, or visual).
   - One scene should need exactly ONE piece of B-roll footage.`;
        }
        if (ctaOverlap > 2) {
            pacingZoneInstructions += `\n🎬 CTA ZONE (${ctaStart.toFixed(0)}s+): Call-to-action / closing — let it breathe.
   - ${ctaRange} seconds per scene. Fewer cuts, let the message land.`;
        }

        const prompt = `You are a professional video editor cutting a FACELESS YouTube video. You think in VISUALS, not text.

For every group of segments, ask: "What FOOTAGE would I put on screen here?"
If the answer CHANGES → that's a CUT (new scene).
If the answer is the SAME → keep them together.

${contextBlock}
AUDIO: ${chunkStartTime.toFixed(1)}s - ${chunkEndTime.toFixed(1)}s (${chunkDuration.toFixed(1)}s)
TARGET: ~${chunkTarget} scenes for this section
${pacingZoneInstructions}

MICRO-SEGMENTS (split at every punctuation mark — most commas are NOT real scene breaks):
${sceneList}

VIDEO EDITING RULES:
1. Think FOOTAGE FIRST: "What clip would I search for?" If two segments need the SAME clip → merge.
2. Each scene = ONE search query for footage. "monolithic dome exterior" is one scene. "ancient Roman arch" is a different scene.
3. When the narration mentions a NEW entity, location, concept, or visual subject → NEW SCENE.
4. Commas inside a sentence are NOT cuts. "It saves 75%, reduces insurance by 90%, and lasts centuries" = ONE scene about cost benefits.
5. BUT: "It saves 75%. And the government hates it." = TWO scenes (cost savings visual → government/regulation visual).
6. Dramatic one-liners CAN be standalone: "This is called a monolithic dome." = its own scene (reveal moment).
7. MAXIMUM ${bodyRange.split('-')[1]}s per scene in body, ${hookRange.split('-')[1]}s in hook. If a merged scene would exceed this → split it.
8. EVERY segment index from ${chunkStart} to ${chunkEnd - 1} MUST appear in exactly one SCENE line.

OUTPUT — one line per scene, segment indices to merge:
SCENE 1: ${chunkStart},${chunkStart + 1}
SCENE 2: ${chunkStart + 2}
...

Output ONLY scene lines, nothing else. Cover ALL indices ${chunkStart} to ${chunkEnd - 1}.`;

        const chunkLabel = microScenes.length > CHUNK_SIZE
            ? ` (chunk ${Math.floor(chunkStart / CHUNK_SIZE) + 1}/${Math.ceil(microScenes.length / CHUNK_SIZE)}: segments ${chunkStart}-${chunkEnd - 1})`
            : '';
        console.log(`   🤖 AI reviewing ${chunk.length} segments → target ~${chunkTarget} scenes [hook:${hookScenes} body:${bodyScenes} cta:${ctaScenes}]${chunkLabel}...`);

        const rawText = await callAI(prompt, { maxTokens: 2500, provider: 'gemini' });

        if (!rawText) {
            console.log(`   ⚠️ AI merge returned empty for chunk — using fallback`);
            allMergedScenes.push(..._fallbackMergeChunk(chunk, chunkStart, chunkTarget));
            continue;
        }

        // Parse merge instructions
        const chunkMerged = _parseMergeResponse(rawText, microScenes, chunkStart, chunkEnd);

        if (chunkMerged.length === 0) {
            console.log(`   ⚠️ AI merge parse failed for chunk — using fallback`);
            allMergedScenes.push(..._fallbackMergeChunk(chunk, chunkStart, chunkTarget));
            continue;
        }

        // ── Coverage check: find any segments the AI skipped ──
        const covered = new Set();
        for (const scene of chunkMerged) {
            for (const idx of (scene._indices || [])) covered.add(idx);
        }
        const missing = [];
        for (let i = chunkStart; i < chunkEnd; i++) {
            if (!covered.has(i)) missing.push(i);
        }
        if (missing.length > 0) {
            console.log(`   ⚠️ AI skipped ${missing.length} segments — patching: [${missing.slice(0, 10).join(',')}${missing.length > 10 ? '...' : ''}]`);
            // Attach missing segments to nearest preceding scene
            for (const idx of missing) {
                const ms = microScenes[idx];
                // Find which merged scene should absorb this
                let bestScene = chunkMerged[chunkMerged.length - 1]; // default: last scene
                for (const scene of chunkMerged) {
                    if (scene.endTime <= ms.startTime || Math.abs(scene.endTime - ms.startTime) < 0.5) {
                        bestScene = scene;
                    }
                }
                bestScene.text += ' ' + (ms.text || '');
                bestScene.words.push(...(ms.words || []));
                if (ms.endTime > bestScene.endTime) bestScene.endTime = ms.endTime;
                bestScene.duration = Math.round((bestScene.endTime - bestScene.startTime) * config.video.fps);
            }
        }

        allMergedScenes.push(...chunkMerged);
        console.log(`   ✅ Chunk merged: ${chunk.length} segments → ${chunkMerged.length} scenes${missing.length > 0 ? ` (+${missing.length} patched)` : ''}`);
    }

    if (allMergedScenes.length === 0) {
        console.log(`   ⚠️ All AI merge chunks failed — full fallback`);
        return _fallbackMerge(microScenes, targetScenes, audioDuration);
    }

    // ── Hook enforcement: force-split long hook scenes (pacing-driven) ──
    const fps = config.video.fps;
    const hookMaxDur = pacing === 'fast' ? 3.5 : pacing === 'slow' ? 5.5 : 4.5;
    let hookSplitCount = 0;
    const enforced = [];
    for (const scene of allMergedScenes) {
        const dur = (scene.endTime || 0) - (scene.startTime || 0);
        if (scene.startTime < hookEnd && dur > hookMaxDur && scene.words && scene.words.length >= 4) {
            // Split at punctuation boundaries within the scene
            const subScenes = [];
            let subWords = [];
            let subStart = scene.startTime;
            for (let w = 0; w < scene.words.length; w++) {
                subWords.push(scene.words[w]);
                const wordText = scene.words[w].word.trim();
                const isBreak = /[.!?,;:]$/.test(wordText);
                const isLast = w === scene.words.length - 1;
                const subDur = (scene.words[w].start || 0) + 0.2 - subStart;

                if ((isBreak && subDur >= 2.0 && subWords.length >= 2) || isLast) {
                    const subEnd = isLast ? scene.endTime : (w + 1 < scene.words.length ? scene.words[w + 1].start : scene.endTime);
                    subScenes.push({
                        index: 0,
                        text: subWords.map(sw => sw.word).join(' ').trim(),
                        startTime: subStart,
                        endTime: subEnd,
                        duration: Math.round((subEnd - subStart) * fps),
                        words: [...subWords]
                    });
                    subWords = [];
                    subStart = subEnd;
                }
            }
            if (subScenes.length > 1) {
                hookSplitCount += subScenes.length - 1;
                enforced.push(...subScenes);
            } else {
                enforced.push(scene);
            }
        } else {
            enforced.push(scene);
        }
    }
    if (hookSplitCount > 0) {
        console.log(`   🔥 Hook enforcement: split ${hookSplitCount} extra scenes in hook zone (max ${hookMaxDur}s)`);
    }

    // Re-index and ensure last scene extends to audio end
    enforced.forEach((s, i) => { s.index = i; delete s._indices; });
    const last = enforced[enforced.length - 1];
    if (audioDuration > last.endTime + 0.3) {
        last.endTime = audioDuration;
        last.duration = Math.round((last.endTime - last.startTime) * fps);
    }

    console.log(`   ✅ AI merged ${microScenes.length} segments → ${enforced.length} scenes (target was ~${targetScenes})`);
    return enforced;
}

/**
 * Parse AI merge response into scene objects.
 */
function _parseMergeResponse(rawText, microScenes, chunkStart, chunkEnd) {
    const scenes = [];
    const lines = rawText.trim().split('\n').filter(l => l.trim().toLowerCase().startsWith('scene'));

    for (const line of lines) {
        const colonIdx = line.indexOf(':');
        if (colonIdx < 0) continue;

        const indicesStr = line.substring(colonIdx + 1).trim();
        const indices = indicesStr.split(/[,\s]+/).map(s => parseInt(s.trim())).filter(n => !isNaN(n) && n >= chunkStart && n < chunkEnd);

        if (indices.length === 0) continue;

        const mergedWords = [];
        let startTime = Infinity, endTime = 0;

        for (const idx of indices) {
            const ms = microScenes[idx];
            if (!ms) continue;
            mergedWords.push(...(ms.words || []));
            if (ms.startTime < startTime) startTime = ms.startTime;
            if (ms.endTime > endTime) endTime = ms.endTime;
        }

        if (mergedWords.length === 0) continue;

        scenes.push({
            index: scenes.length,
            text: mergedWords.map(w => w.word).join(' ').trim(),
            startTime,
            endTime,
            duration: Math.round((endTime - startTime) * config.video.fps),
            words: mergedWords,
            _indices: indices
        });
    }

    return scenes;
}

/**
 * Fallback merge for a single chunk when AI fails.
 */
function _fallbackMergeChunk(chunk, chunkStart, chunkTarget) {
    const chunkDuration = (chunk[chunk.length - 1].endTime || 0) - (chunk[0].startTime || 0);
    const targetDuration = chunkDuration / chunkTarget;
    const merged = [];
    let currentWords = [];
    let currentStart = 0;

    for (const ms of chunk) {
        if (currentWords.length === 0) currentStart = ms.startTime;
        currentWords.push(...(ms.words || []));

        const elapsed = ms.endTime - currentStart;
        if (elapsed >= targetDuration * 0.8) {
            merged.push({
                index: merged.length,
                text: currentWords.map(w => w.word).join(' ').trim(),
                startTime: currentStart,
                endTime: ms.endTime,
                duration: Math.round((ms.endTime - currentStart) * config.video.fps),
                words: [...currentWords]
            });
            currentWords = [];
        }
    }

    // Flush remaining
    if (currentWords.length > 0) {
        const endTime = chunk[chunk.length - 1].endTime;
        if (merged.length > 0 && (endTime - currentStart) < 2.5) {
            const last = merged[merged.length - 1];
            last.endTime = endTime;
            last.duration = Math.round((endTime - last.startTime) * config.video.fps);
            last.text += ' ' + currentWords.map(w => w.word).join(' ').trim();
            last.words.push(...currentWords);
        } else {
            merged.push({
                index: merged.length,
                text: currentWords.map(w => w.word).join(' ').trim(),
                startTime: currentStart,
                endTime,
                duration: Math.round((endTime - currentStart) * config.video.fps),
                words: currentWords
            });
        }
    }

    return merged;
}

/**
 * Fallback merge when AI fails — group micro-scenes by duration target.
 */
function _fallbackMerge(microScenes, targetScenes, audioDuration) {
    const targetDuration = audioDuration / targetScenes;
    const merged = [];
    let currentWords = [];
    let currentStart = 0;

    for (const ms of microScenes) {
        if (currentWords.length === 0) currentStart = ms.startTime;
        currentWords.push(...(ms.words || []));

        const elapsed = ms.endTime - currentStart;
        if (elapsed >= targetDuration * 0.8) {
            merged.push({
                index: merged.length,
                text: currentWords.map(w => w.word).join(' ').trim(),
                startTime: currentStart,
                endTime: ms.endTime,
                duration: Math.round((ms.endTime - currentStart) * config.video.fps),
                words: [...currentWords]
            });
            currentWords = [];
        }
    }

    // Flush remaining
    if (currentWords.length > 0) {
        const last = merged.length > 0 ? merged[merged.length - 1] : null;
        const endTime = audioDuration;
        if (last && (endTime - currentStart) < 2.5) {
            // Too short — merge into previous
            last.endTime = endTime;
            last.duration = Math.round((endTime - last.startTime) * config.video.fps);
            last.text += ' ' + currentWords.map(w => w.word).join(' ').trim();
            last.words.push(...currentWords);
        } else {
            merged.push({
                index: merged.length,
                text: currentWords.map(w => w.word).join(' ').trim(),
                startTime: currentStart,
                endTime,
                duration: Math.round((endTime - currentStart) * config.video.fps),
                words: currentWords
            });
        }
    }

    console.log(`   🔧 Fallback merged ${microScenes.length} segments → ${merged.length} scenes`);
    return merged;
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
        if (niche.footagePriority?.video) {
            console.log(`      Video sources: ${niche.footagePriority.video.join(' → ')}`);
        }
        if (niche.allowedMGs) {
            console.log(`      Allowed MGs: ${niche.allowedMGs.join(', ')}`);
        }

        // Step B: Split transcript at punctuation (deterministic)
        const microScenes = _splitAtPunctuation(allWords, audioDuration, fps);
        console.log(`   📊 Punctuation split: ${microScenes.length} micro-segments`);

        // Step C: AI merges related micro-scenes into proper visual scenes
        let scenes = await _aiMergeScenes(microScenes, scriptContext, audioDuration, directorsBrief);

        if (scenes.length === 0) throw new Error('No valid scenes after merge');

        // Pacing-driven limits — nothing hardcoded
        const pacing = scriptContext.pacing || 'moderate';
        const maxSceneDur = pacing === 'fast' ? 8 : pacing === 'slow' ? 14 : 10;
        const minSceneDur = pacing === 'fast' ? 2.0 : pacing === 'slow' ? 3.5 : 2.5;
        const hookMinDur = 1.5; // hook scenes can be very short regardless of pacing

        console.log(`   ⚙️ Pacing limits (${pacing}): max=${maxSceneDur}s, min=${minSceneDur}s, hookMin=${hookMinDur}s`);

        // Safety net: split scenes exceeding pacing-driven max
        scenes = autoSplitLongScenes(scenes, allWords, audioDuration, fps, maxSceneDur);

        // Safety net: merge scenes under pacing-driven min (hook scenes use hookMinDur)
        const mergeHookEnd = parseFloat(scriptContext.hookEndTime) || Math.min(25, audioDuration * 0.12);
        scenes = _mergeTinyScenes(scenes, minSceneDur, mergeHookEnd, hookMinDur);

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

            // Apply fast hook pacing — split long hook scenes for faster cuts
            const hookPacing = listicle.getListicleHookPacing();
            scriptContext.listicleHookPacing = hookPacing;
            if (hookResult.hookSceneIndices.length > 0) {
                // Re-split hook scenes with tighter max duration (faster cuts in intro)
                const hookMaxDuration = 12.0 / hookPacing.sceneDensityMultiplier; // ~9.2s vs normal 12s
                const hookScenes = hookResult.hookSceneIndices.map(hi => scenes[hi]).filter(Boolean);
                const splitHookScenes = autoSplitLongScenes(hookScenes, allWords, audioDuration, fps, hookMaxDuration);

                // Replace hook scenes in the main array if splits happened
                if (splitHookScenes.length > hookScenes.length) {
                    const hookEnd = hookResult.hookSceneIndices[hookResult.hookSceneIndices.length - 1] + 1;
                    const hookStart = hookResult.hookSceneIndices[0];
                    scenes.splice(hookStart, hookEnd - hookStart, ...splitHookScenes);
                    // Re-index all scenes
                    scenes.forEach((s, idx) => { s.index = idx; });
                    console.log(`      [Listicle] Hook split: ${hookScenes.length} → ${splitHookScenes.length} scenes (faster pacing)`);
                }

                // Tag all hook scenes
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
    const durScale = isFast ? 0.4 : isSlow ? 1.5 : 1.0;

    // Cut ratio: how often to use hard cuts (pacing-driven)
    // Fast = lots of cuts, slow = very few, moderate = some
    const cutRatio = isFast ? 0.50 : isSlow ? 0.08 : 0.25;

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
    assignTransitions
};
