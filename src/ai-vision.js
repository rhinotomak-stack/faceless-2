const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('./config');
const { callVisionAI } = require('./ai-provider');

/**
 * Vision AI analysis module.
 * Extracts a frame from each downloaded video (or reads images directly),
 * sends to a vision-capable AI, and returns visual descriptions + suitability assessments.
 */

// ============ FRAME EXTRACTION ============

let ffmpegAvailable = null;

function checkFfmpegAvailable() {
    if (ffmpegAvailable !== null) return ffmpegAvailable;

    try {
        const ffmpegPath = require('ffmpeg-static');
        if (fs.existsSync(ffmpegPath)) {
            ffmpegAvailable = ffmpegPath;
            return ffmpegPath;
        }
    } catch (e) { /* ffmpeg-static not installed */ }

    console.log('  ⚠️ ffmpeg binary not found. Vision analysis for videos will be skipped.');
    console.log('  💡 If using Windows, add a Defender exclusion for node_modules');
    ffmpegAvailable = false;
    return false;
}

/**
 * Extract a single frame from a video at the midpoint.
 * @returns {Promise<string|null>} path to extracted JPEG frame, or null on failure
 */
async function extractFrame(videoPath, outputPath, durationSec) {
    const ffmpegPath = checkFfmpegAvailable();
    if (!ffmpegPath) return null;

    try {
        const midpoint = Math.max(0.5, durationSec / 2);
        await new Promise((resolve, reject) => {
            execFile(ffmpegPath, [
                '-ss', midpoint.toFixed(2),
                '-i', videoPath,
                '-vf', 'scale=1024:-1',
                '-frames:v', '1',
                '-q:v', '2',
                '-y', outputPath
            ], { timeout: 15000, windowsHide: true }, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
        return outputPath;
    } catch (e) {
        return null;
    }
}

/**
 * Get a base64-encoded frame for a scene.
 * For videos: extract mid-point frame. For images: read directly.
 */
async function getSceneFrame(scene, index) {
    const tempDir = config.paths.temp;
    const ext = scene.mediaExtension || '.mp4';
    const mediaPath = scene.mediaFile || path.join(tempDir, `scene-${index}${ext}`);

    if (!fs.existsSync(mediaPath)) return null;

    const isVideo = ext === '.mp4' || ext === '.webm' || ext === '.mov';
    let imagePath;

    if (isVideo) {
        imagePath = path.join(tempDir, `frame-${index}.jpg`);
        const duration = scene.endTime - scene.startTime;
        const result = await extractFrame(mediaPath, imagePath, duration);
        if (!result) return null;
    } else {
        imagePath = mediaPath;
    }

    try {
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        const fileExt = path.extname(imagePath).toLowerCase();
        const mimeType = fileExt === '.png' ? 'image/png'
            : fileExt === '.webp' ? 'image/webp'
            : 'image/jpeg';
        return { base64, mimeType };
    } catch (e) {
        return null;
    }
}

// ============ VISION PROMPT ============

function buildVisionPrompt(sceneText, videoSummary) {
    return `You are analyzing a frame from stock footage used in a video about: ${videoSummary || 'unknown topic'}

This frame accompanies the narration: "${sceneText}"

Analyze the image and respond in EXACTLY this format (one value per line):
description: <what is visually shown, 1 sentence max 15 words>
suitability: <good, fair, or poor - how well this footage matches the narration>
reason: <why this suitability rating, max 10 words>
colors: <dominant color palette, max 5 words>
mood: <one word: energetic, calm, dark, bright, neutral, dramatic, warm, cool>
hasText: <yes or no - does the image contain visible text or words>
mgPosition: <where to avoid placing text overlays: avoid-center, avoid-top, avoid-bottom, or clear>`;
}

// ============ RESPONSE PARSING ============
// NOTE: Vision AI providers moved to shared ai-provider.js module

function parseVisionResponse(text, sceneIndex) {
    const result = createDefaultAnalysis(sceneIndex);
    const lines = text.trim().split('\n');

    for (const line of lines) {
        const lower = line.toLowerCase().trim();

        if (lower.startsWith('description:')) {
            result.description = line.substring(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
        }
        if (lower.startsWith('suitability:')) {
            const val = lower.substring(lower.indexOf(':') + 1).trim();
            if (['good', 'fair', 'poor'].includes(val)) {
                result.suitability = val;
            }
        }
        if (lower.startsWith('reason:')) {
            result.suitabilityReason = line.substring(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
        }
        if (lower.startsWith('colors:')) {
            result.dominantColors = line.substring(line.indexOf(':') + 1).trim().replace(/^["']|["']$/g, '');
        }
        if (lower.startsWith('mood:')) {
            result.mood = line.substring(line.indexOf(':') + 1).trim().toLowerCase().replace(/^["']|["']$/g, '');
        }
        if (lower.startsWith('hastext:')) {
            const val = lower.substring(lower.indexOf(':') + 1).trim();
            result.hasText = val === 'yes' || val === 'true';
        }
        if (lower.startsWith('mgposition:')) {
            const val = line.substring(line.indexOf(':') + 1).trim().toLowerCase();
            if (['avoid-center', 'avoid-top', 'avoid-bottom', 'clear'].includes(val)) {
                result.suggestedMGPosition = val;
            }
        }
    }

    return result;
}

function createDefaultAnalysis(sceneIndex) {
    return {
        sceneIndex,
        description: 'No visual analysis available',
        suitability: 'fair',
        suitabilityReason: 'Vision analysis skipped',
        dominantColors: 'unknown',
        mood: 'neutral',
        hasText: false,
        suggestedMGPosition: 'clear'
    };
}

// ============ ARTICLE HIGHLIGHT BOUNDING BOXES ============

// Gemini native box_2d prompt (0-1000 scale, most accurate)
function buildGeminiArticlePrompt() {
    return `Look at this news article. Find the main headline text.
Pick the 2-3 most important phrases from that headline (1-3 words each, words that carry the most meaning).
Return their bounding boxes as JSON. Use box_2d format with 0-1000 coordinates [ymin, xmin, ymax, xmax].
Return ONLY the JSON array, nothing else.
Example format: [{"label": "trade deficit", "box_2d": [250, 100, 290, 350]}, {"label": "record high", "box_2d": [250, 400, 290, 600]}]`;
}

// Generic prompt for non-Gemini providers (percentage-based)
function buildGenericArticlePrompt() {
    return `You are looking at a news article screenshot. Your task: find the ARTICLE HEADLINE and output bounding boxes for its key phrases.

STEP 1 — Identify the page structure:
- What is the site name/logo at the top? (e.g. "Yahoo Finance", "Bloomberg", "BBC") — this is the PAGE HEADER, ignore it entirely.
- What navigation tabs or menu items appear? (e.g. "Markets", "Finance", "Politics") — PAGE NAV, ignore.
- What is the main bold article title below the header? THIS is the headline you want.

STEP 2 — The article headline has these characteristics:
- It describes a specific news event or story in a sentence or phrase
- It appears BELOW the site logo and navigation area
- It is the largest/boldest text in the article body (not the site name)
- Examples: "Saudi East-West pipeline hits 7 mln bpd amid Hormuz disruption", "King Khalid orders construction of new oil pipeline", "Iran seizes tanker in Gulf of Oman"

STEP 3 — From the headline you identified, pick 2-3 key phrases (1-4 words each, most newsworthy/specific words).
For each phrase, estimate its bounding box as percentages (0-100) of the full image dimensions.
x = left edge %, y = top edge %, w = width %, h = height %

Output ONLY a JSON array. If the page shows no article headline (only login walls, error pages, dashboards, or pure nav), output [].
Example: [{"label": "pipeline hits", "x": 8, "y": 38, "w": 20, "h": 4}, {"label": "7 mln bpd", "x": 8, "y": 43, "w": 16, "h": 4}]`;
}

function parseArticleVisionResponse(rawText, isBoxFormat) {
    const cleaned = rawText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    try {
        const items = JSON.parse(jsonMatch[0]);
        const boxes = [];
        for (const item of items) {
            if (!item.label) continue;
            let x, y, w, h;

            if (isBoxFormat && item.box_2d && item.box_2d.length === 4) {
                // Gemini box_2d: [ymin, xmin, ymax, xmax] on 0-1000 scale
                const [ymin, xmin, ymax, xmax] = item.box_2d;
                x = xmin / 10;
                y = ymin / 10;
                w = (xmax - xmin) / 10;
                h = (ymax - ymin) / 10;
            } else if (item.x !== undefined && item.y !== undefined) {
                // Generic percentage format
                x = item.x;
                y = item.y;
                w = item.w || 15;
                h = item.h || 4;
            } else {
                continue;
            }

            // Sanity check only — no hardcoded positional filter.
            // The AI prompt instructs it to skip headers/nav/logos semantically.
            if (x >= 0 && x <= 100 && y >= 0 && y <= 100 && w > 0 && w <= 80 && h > 0 && h <= 30) {
                boxes.push({ text: item.label, x, y, w, h });
            }
        }
        return boxes;
    } catch (err) {
        console.log(`   ⚠️ Failed to parse vision JSON: ${err.message}`);
        return [];
    }
}

/**
 * Analyze an article image to find headline key phrases for highlighting.
 * Uses Gemini native box_2d format when available (most accurate),
 * falls back to generic percentage prompt for other providers.
 * @param {string} imagePath - path to the article image
 * @returns {Array<{text, x, y, w, h}>} bounding boxes as percentages
 */
async function analyzeArticleHighlights(imagePath) {
    if (!fs.existsSync(imagePath)) return [];

    try {
        const imageBuffer = fs.readFileSync(imagePath);
        const base64 = imageBuffer.toString('base64');
        const ext = path.extname(imagePath).toLowerCase();
        const mimeType = ext === '.png' ? 'image/png'
            : ext === '.webp' ? 'image/webp'
            : 'image/jpeg';

        console.log(`   🔍 Asking Vision AI to find headline key phrases...`);

        // Use the shared vision AI dispatcher — same for ALL providers
        const prompt = buildGenericArticlePrompt();
        const rawText = await callVisionAI(prompt, base64, mimeType);

        const boxes = parseArticleVisionResponse(rawText, false);

        if (boxes.length > 0) {
            console.log(`   ✅ Headline highlights: ${boxes.map(b => `"${b.text}"`).join(', ')}`);
            boxes.forEach(b => console.log(`      📍 x:${b.x.toFixed(1)}% y:${b.y.toFixed(1)}% w:${b.w.toFixed(1)}% h:${b.h.toFixed(1)}%`));
        } else {
            console.log(`   ⚠️ Could not locate headline in article image`);
        }

        return boxes;
    } catch (err) {
        console.log(`   ⚠️ Article vision analysis failed: ${err.message}`);
        return [];
    }
}

// ============ VIDEO FRAME SCORING ============

/**
 * Score how well a single video frame matches a keyword.
 * Used by ALL video providers (YouTube, News, future) via smart-segment.js.
 *
 * Scoring Rules:
 * - LITERAL visual matching only (not symbolic/metaphorical)
 * - Penalize: news anchors, talking heads, studio desks, text-heavy screens
 * - Penalize: channel logos, watermarks, AI-generated artifacts
 * - Reward: real-world footage, specific subjects, clean visuals
 *
 * @param {string} base64Image - base64-encoded frame image
 * @param {string} mimeType - image MIME type
 * @param {string} keyword - the search keyword to match against
 * @param {object} context - { sceneText, niche, videoTopic, theme, tone, entities }
 * @returns {{ score: number, description: string }} score 1-10, or 0 on failure
 */
async function scoreVideoFrame(base64Image, mimeType, keyword, context) {
    try {
        const contextBlock = context
            ? `${context.videoTopic ? `\nVideo topic: "${context.videoTopic}"` : ''}${context.sceneText ? `\nScene narration: "${context.sceneText}"` : ''}${context.niche ? `\nContent niche: ${context.niche}` : ''}${context.theme ? `\nVisual theme: ${context.theme}` : ''}${context.tone ? `\nTone: ${context.tone}` : ''}${context.entities?.length ? `\nKey entities: ${context.entities.slice(0, 5).join(', ')}` : ''}`
            : '';

        const prompt = `Analyze this image/frame for use in a faceless YouTube video about: "${keyword}"${contextBlock}

IMPORTANT: Score based on what is LITERALLY visible in the image, NOT symbolic or metaphorical interpretations.
For example: a circuit board does NOT match "underwater drone" even if drones contain circuits. An actual underwater drone/submersible WOULD match.

Describe what you LITERALLY see in ONE short sentence (10-15 words max). Note any problems.

CONTEXT-AWARE SCORING: Consider the FULL context (keyword + scene narration + video topic) together.
The image does NOT need to match the keyword literally — it needs to be USABLE as B-roll footage while the narration plays.
Ask yourself: "Would a video editor use this clip in a video about THIS SPECIFIC TOPIC?" If yes, score 6+.

VIDEO TOPIC RELEVANCE (CRITICAL): The footage must make sense within the VIDEO'S TOPIC, not just the keyword in isolation.
If the video topic is "monolithic dome homes" and the keyword is "wind tunnel aerodynamics", a dome or building in a wind tunnel = 8, but a spaceship or airplane in a wind tunnel = 2 (wrong subject entirely).
If the video topic is "oil pipeline crisis" and the keyword is "explosion aftermath", an oil facility explosion = 8, but a war zone explosion = 3 (different context).
ALWAYS ask: "Does this footage belong in a video about [video topic]?" If NO → MAX score 3 regardless of keyword match.

Examples of GOOD contextual matches (score 6-8):
- Video topic "Iran oil conflict", keyword "Strait of Hormuz" → cargo ship or oil tanker at sea = 7 (relevant maritime footage)
- Video topic "Saudi energy", keyword "oil pipeline" → oil refinery or desert industrial facility = 7 (relevant energy infrastructure)
- Video topic "global trade war", keyword "economic sanctions" → busy trading floor or currency exchange = 6 (contextually relevant)
- Video topic "9/11 attacks", keyword "Twin Towers" → actual Twin Towers footage or Ground Zero = 10 (exact event match)

Examples of BAD matches (score 1-4):
- Video topic "dome construction", keyword "wind tunnel test" → airplane wind tunnel = 2 (wrong subject for the video)
- Video topic "oil crisis", keyword "explosion" → fireworks display = 2 (wrong context)
- Keyword "Iran Strait of Hormuz" → a cat video = 1 (completely unrelated)
- Keyword "economic policy" → news anchor at desk reading teleprompter = 3 (studio talking head)

SPECIFIC EVENT/PERSON RULE: When the keyword references a SPECIFIC identifiable event (e.g. "9/11 towers attack", "Fukushima explosion", "Capitol riot") or a SPECIFIC person (leader, politician, celebrity), demand footage of THAT actual event/person — score 9-10 for exact match, 4-5 for generic related footage.

PERSON KEYWORDS: If the keyword contains a person's name, a photo or portrait of that person IS the correct match — score 7-9. If the keyword is a name and the image shows a person matching the described context (e.g. "King Khalid Saudi Arabia" → man in Saudi royal attire), give benefit of the doubt and score 7+. This is NOT a "talking head" penalty — talking head penalty only applies to NEWS ANCHORS/PRESENTERS.

AUTOMATIC PENALTIES (hard caps, override all other scoring):
- News anchor / presenter reading news at a studio desk → MAX score 3 (unusable for faceless video)
- YouTuber/presenter talking to camera or standing in front of subject → MAX score 5 (this is a FACELESS video — no visible presenters)
- Studio set with desk, microphones, teleprompter → MAX score 3
- Text-heavy screen (headlines, tickers, lower thirds filling >30% of frame) → MAX score 3
- Any visible watermark, channel logo, or agency stamp (e.g., IRNA, AFP, Getty, Reuters logo) → MAX score 3
- Foreign-language text overlay or subtitle burned into the image → MAX score 3
- Still photo with "Ken Burns" border/frame → -2 from base score
- AI-generated or illustrated content when real footage is needed → MAX score 2

SCORING RUBRIC:
- 9-10: Shows exactly what the keyword/event describes OR the specific person named. Clean real-world footage. Clearly belongs in this video.
- 7-8: Real footage that directly fits BOTH the keyword AND the video topic (e.g. ships for maritime topic, domes for construction topic). Person photo matching a person keyword.
- 5-6: Real footage related to the video topic but not a strong keyword match. Usable as B-roll. Minor issues.
- 3-4: News anchor/studio shot, OR footage that matches the keyword superficially but NOT the video topic (wrong subject/context).
- 1-2: Completely unrelated to video topic, heavy watermarks/logos, or AI-generated.

Reply format (exactly 2 lines):
[your one-sentence description]
[score number]`;

        const response = await callVisionAI(prompt, base64Image, mimeType);
        const lines = response.trim().split('\n').filter(l => l.trim());
        let description = '';
        let score = 0;

        // Parse: last line with a number is the score, everything before is description
        for (let i = lines.length - 1; i >= 0; i--) {
            const numMatch = lines[i].trim().match(/^(\d+)$/);
            if (numMatch) {
                score = Math.min(10, Math.max(1, parseInt(numMatch[1])));
                description = lines.slice(0, i).join(' ').trim();
                break;
            }
        }

        // Fallback: find any number in response
        if (score === 0) {
            const anyNum = response.match(/(\d+)\s*(?:\/\s*10)?/);
            if (anyNum) score = Math.min(10, Math.max(1, parseInt(anyNum[1])));
            description = lines[0] || '';
        }

        return { score, description };
    } catch (err) {
        return { score: 0, description: 'Vision AI error' };
    }
}

/**
 * Check if vision AI is configured and available for the current provider.
 */
function isVisionAvailable() {
    const provider = config.aiProvider;
    switch (provider) {
        case 'ollama':   return true; // Always available locally
        case 'claude':   return !!config.claude?.apiKey;
        case 'openai':   return !!config.openai?.apiKey;
        case 'deepseek': return !!config.deepseek?.apiKey;
        case 'qwen':     return !!config.qwen?.apiKey;
        case 'gemini':   return !!config.gemini?.apiKey;
        case 'nvidia':   return !!config.nvidia?.apiKey;
        case 'groq':     return !!config.groq?.apiKey;
        default:         return true;
    }
}

// ============ MAIN EXPORT ============

async function analyzeSceneVisuals(scenes, scriptContext) {
    console.log('\n👁️ Analyzing downloaded footage with Vision AI...');
    console.log(`📡 Using: ${config.aiProvider.toUpperCase()}\n`);

    const results = [];

    for (let i = 0; i < scenes.length; i++) {
        const scene = scenes[i];
        const shortText = scene.text ? scene.text.substring(0, 40) : '';
        console.log(`  Scene ${i}: "${shortText}..."`);

        try {
            const frame = await getSceneFrame(scene, i);
            if (!frame) {
                console.log('    ⚠️ No frame to analyze (skipped)');
                results.push(createDefaultAnalysis(i));
                continue;
            }

            const prompt = buildVisionPrompt(scene.text, scriptContext ? scriptContext.summary : '');
            const rawText = await callVisionAI(prompt, frame.base64, frame.mimeType);
            const analysis = parseVisionResponse(rawText, i);

            const icon = analysis.suitability === 'good' ? '✅' : analysis.suitability === 'poor' ? '❌' : '⚠️';
            console.log(`    ${icon} ${analysis.suitability}: "${analysis.description.substring(0, 50)}"`);
            results.push(analysis);
        } catch (error) {
            console.log(`    ⚠️ Vision failed: ${error.message}`);
            results.push(createDefaultAnalysis(i));
        }
    }

    const analyzed = results.filter(r => r.description !== 'No visual analysis available').length;
    const poor = results.filter(r => r.suitability === 'poor').length;
    console.log(`\n📊 Vision analysis: ${analyzed}/${scenes.length} analyzed`);
    if (poor > 0) {
        console.log(`   ⚠️ ${poor} scene(s) with poor footage match`);
    }
    console.log('');

    return results;
}

/**
 * Analyze a single scene's footage with Vision AI.
 * Used by the retry step to re-score replacement footage.
 * @param {Object} scene - Scene object with mediaFile, mediaExtension, text, startTime, endTime
 * @param {number} sceneIndex - Scene index
 * @param {Object} scriptContext - Script context with summary
 * @returns {Object} Vision analysis result
 */
async function analyzeSingleScene(scene, sceneIndex, scriptContext) {
    try {
        const frame = await getSceneFrame(scene, sceneIndex);
        if (!frame) return createDefaultAnalysis(sceneIndex);

        const prompt = buildVisionPrompt(scene.text, scriptContext ? scriptContext.summary : '');
        const rawText = await callVisionAI(prompt, frame.base64, frame.mimeType);
        return parseVisionResponse(rawText, sceneIndex);
    } catch (error) {
        return createDefaultAnalysis(sceneIndex);
    }
}

module.exports = { analyzeSceneVisuals, analyzeSingleScene, createDefaultAnalysis, analyzeArticleHighlights, scoreVideoFrame, isVisionAvailable, checkFfmpegAvailable };
