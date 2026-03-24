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
    return `Look at this news article screenshot. Find the main headline text.
Pick the 2-3 most important phrases from that headline (1-3 words each, words that carry the most meaning).
For each phrase, estimate where it appears in the image as percentages (0-100) of the image dimensions.
x = left edge %, y = top edge %, w = width %, h = height %.
Return ONLY a JSON array, nothing else.
Example: [{"label": "trade deficit", "x": 10, "y": 25, "w": 18, "h": 4}, {"label": "record high", "x": 40, "y": 25, "w": 15, "h": 4}]`;
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

            // Sanity check
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

PERSON KEYWORDS: If the keyword contains a person's name (leader, politician, celebrity, historical figure), a photo or portrait of that person IS the correct match — score it HIGH (7-9). You may not recognize every person, so if the keyword is a name and the image shows a person matching the described context (e.g. "King Khalid Saudi Arabia" → man in Saudi royal attire), give benefit of the doubt and score 7+. This is NOT a "talking head" penalty — talking head penalty only applies to NEWS ANCHORS/PRESENTERS reading from a teleprompter, not to photos of the actual subject.

AUTOMATIC PENALTIES (subtract from score):
- News anchor / presenter reading news at a studio desk → MAX score 3 (unusable for faceless video)
- Studio set with desk, microphones, teleprompter → MAX score 3
- Text-heavy screen (headlines, tickers, lower thirds filling >30% of frame) → MAX score 4
- Channel logo or large watermark covering content → MAX score 3
- Still photo with "Ken Burns" border/frame → -2 from base score
- AI-generated or illustrated content when real footage is needed → MAX score 2

SCORING RUBRIC:
- 9-10: Shows exactly what the topic describes, clean real-world footage, no watermarks
- 7-8: Closely related real footage, minor issues (small logo, slight mismatch). Person photo matching a person keyword.
- 5-6: Loosely related or too generic (e.g. generic cityscape instead of specific building)
- 3-4: Wrong subject but same general category, OR news anchor/studio shot
- 1-2: Completely unrelated, heavy watermarks/logos, or AI-generated

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
