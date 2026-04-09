/**
 * Clip Analyzer — Video Understanding via Omni Multimodal Models
 *
 * Uses Qwen Omni (or Gemini fallback) to analyze entire video clips,
 * not just single frame thumbnails. Sends multiple frames as a sequence
 * for holistic video understanding.
 *
 * Two modes:
 *  1. analyzeClip()        — Post-download: score + describe a downloaded clip
 *  2. findBestSegment()    — Pre-download: find the best segment in a long video
 *
 * Both use callVideoAI() which sends multiple frames to the Omni model.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { callVideoAI } = require('./ai-provider');
const config = require('./config');

// ============ CONFIG ============

const DEFAULTS = {
    // Frame extraction
    framesPerClip: 3,          // frames to extract from a clip (3 is enough for a 3-6s clip)
    frameScale: 512,           // scale frames to this width (lower = fewer tokens)
    frameQuality: 4,           // JPEG quality (2=best, 5=decent, higher=worse)
    frameTimeout: 10000,       // ms per frame extraction

    // Analysis
    maxTokens: 400,            // max response tokens
    timeout: 90000,            // ms for the AI call

    // Smart segment
    segmentFrames: 3,          // frames for segment analysis (3 is fast; 6 was too slow for 150+ scene builds)
    segmentMinDuration: 60,    // minimum video duration to bother with segment analysis (skip short clips)

    // Cost control
    enabled: true,             // master switch
    maxFramesPerBuild: 200,    // max total frames sent across all clips in one build
};

// Track frame budgets across a build session
// Omni budget = for findBestSegment (smart trim) — the expensive multi-frame calls
// Clip analysis (VL single-frame scoring) has its own separate counter — doesn't eat Omni budget
let _omniBudget = DEFAULTS.maxFramesPerBuild;
let _omniFramesSent = 0;
let _clipAnalysisFrames = 0; // tracked for stats only, no budget limit

/**
 * Reset frame budget (call at start of each build).
 */
function resetBudget(maxFrames) {
    _omniBudget = maxFrames || DEFAULTS.maxFramesPerBuild;
    _omniFramesSent = 0;
    _clipAnalysisFrames = 0;
}

/**
 * Check if clip analysis is available and within budget.
 */
function isAvailable() {
    if (config.clipAnalyzer?.enabled === false) return false;
    if (!DEFAULTS.enabled) return false;
    if (!config.qwen?.apiKey && !config.gemini?.apiKey) return false;
    if (_omniFramesSent >= _omniBudget) return false;
    return true;
}

// ============ FRAME EXTRACTION ============

let _ffmpegPath = null;

function _getFfmpeg() {
    if (_ffmpegPath !== null) return _ffmpegPath;
    try {
        const p = require('ffmpeg-static');
        if (fs.existsSync(p)) { _ffmpegPath = p; return p; }
    } catch {}
    _ffmpegPath = false;
    return false;
}

/**
 * Extract multiple frames from a video file at evenly-spaced timestamps.
 * @param {string} videoPath - Path to video file
 * @param {number} duration - Video duration in seconds
 * @param {number} numFrames - Number of frames to extract
 * @param {Object} [opts] - { startTime, endTime, scale }
 * @returns {Promise<Array<{base64: string, mimeType: string, timestamp: number}>>}
 */
async function extractFrames(videoPath, duration, numFrames, opts = {}) {
    const ffmpeg = _getFfmpeg();
    if (!ffmpeg) return [];

    const startTime = opts.startTime || 0;
    const endTime = opts.endTime || duration;
    const effectiveDur = endTime - startTime;
    const scale = opts.scale || DEFAULTS.frameScale;

    // Calculate timestamps spread evenly across the clip
    const timestamps = [];
    for (let i = 0; i < numFrames; i++) {
        const t = startTime + (effectiveDur * (i + 0.5)) / numFrames;
        timestamps.push(Math.min(t, endTime - 0.1));
    }

    const tempDir = config.paths?.temp || require('os').tmpdir();
    const frames = [];

    // Extract in parallel batches of 4
    const batchSize = 4;
    for (let b = 0; b < timestamps.length; b += batchSize) {
        const batch = timestamps.slice(b, b + batchSize);
        const results = await Promise.all(batch.map(async (ts, bi) => {
            const framePath = path.join(tempDir, `clip-analyzer-${Date.now()}-${b + bi}.jpg`);
            try {
                await new Promise((resolve, reject) => {
                    execFile(ffmpeg, [
                        '-ss', ts.toFixed(2),
                        '-i', videoPath,
                        '-vf', `scale=${scale}:-1`,
                        '-frames:v', '1',
                        '-q:v', String(DEFAULTS.frameQuality),
                        '-y', framePath,
                    ], { timeout: DEFAULTS.frameTimeout, windowsHide: true }, (err) => {
                        if (err) reject(err); else resolve();
                    });
                });

                if (fs.existsSync(framePath)) {
                    const buffer = fs.readFileSync(framePath);
                    const base64 = buffer.toString('base64');
                    fs.unlinkSync(framePath); // cleanup
                    return { base64, mimeType: 'image/jpeg', timestamp: ts };
                }
            } catch {
                try { fs.unlinkSync(framePath); } catch {}
            }
            return null;
        }));

        frames.push(...results.filter(Boolean));
    }

    return frames;
}

/**
 * Extract frames from a remote URL (for pre-download segment analysis).
 */
async function extractFramesFromUrl(url, duration, numFrames, opts = {}) {
    const ffmpeg = _getFfmpeg();
    if (!ffmpeg) return [];

    const startTime = opts.startTime || 0;
    const endTime = opts.endTime || duration;
    const effectiveDur = endTime - startTime;
    const scale = opts.scale || DEFAULTS.frameScale;

    const timestamps = [];
    for (let i = 0; i < numFrames; i++) {
        const t = startTime + (effectiveDur * (i + 0.5)) / numFrames;
        timestamps.push(Math.min(t, endTime - 0.1));
    }

    const tempDir = config.paths?.temp || require('os').tmpdir();
    const frames = [];

    // Extract sequentially for remote URLs (parallel can overwhelm)
    for (let i = 0; i < timestamps.length; i++) {
        const ts = timestamps[i];
        const framePath = path.join(tempDir, `clip-analyzer-url-${Date.now()}-${i}.jpg`);
        try {
            await new Promise((resolve, reject) => {
                execFile(ffmpeg, [
                    '-ss', ts.toFixed(2),
                    '-i', url,
                    '-vf', `scale=${scale}:-1`,
                    '-frames:v', '1',
                    '-q:v', String(DEFAULTS.frameQuality),
                    '-y', framePath,
                ], { timeout: 20000, windowsHide: true }, (err) => {
                    if (err) reject(err); else resolve();
                });
            });

            if (fs.existsSync(framePath)) {
                const buffer = fs.readFileSync(framePath);
                frames.push({ base64: buffer.toString('base64'), mimeType: 'image/jpeg', timestamp: ts });
                fs.unlinkSync(framePath);
            }
        } catch {
            try { fs.unlinkSync(framePath); } catch {}
        }
    }

    return frames;
}

// ============ CLIP ANALYSIS (POST-DOWNLOAD) ============

/**
 * Analyze a downloaded video clip using Omni video understanding.
 * Returns a comprehensive analysis: score, description, issues, quality metrics.
 *
 * @param {string} filePath - Path to downloaded video
 * @param {number} duration - Clip duration in seconds
 * @param {string} keyword - What the clip should show
 * @param {Object} [context] - { sceneText, niche, videoTopic, entities }
 * @returns {Promise<{score: number, description: string, issues: string[], quality: Object}|null>}
 */
async function analyzeClip(filePath, duration, keyword, context = {}) {
    if (!isAvailable()) return null;
    if (!fs.existsSync(filePath)) return null;

    const maxFrames = config.clipAnalyzer?.framesPerClip || DEFAULTS.framesPerClip;
    const numFrames = Math.min(maxFrames, Math.ceil(duration * 2)); // ~2fps, capped
    const frames = await extractFrames(filePath, duration, numFrames);
    if (frames.length < 2) return null;

    _clipAnalysisFrames += frames.length; // clip analysis uses VL, separate from Omni budget

    const contextBlock = [
        context.videoTopic ? `Video topic: "${context.videoTopic}"` : '',
        context.sceneText ? `Scene narration: "${context.sceneText}"` : '',
        context.niche ? `Niche: ${context.niche}` : '',
        context.entities?.length ? `Key entities: ${context.entities.slice(0, 5).join(', ')}` : '',
    ].filter(Boolean).join('\n');

    const prompt = `You are analyzing a ${duration.toFixed(1)}s video clip for use in a faceless YouTube video.
These ${frames.length} frames are sequential snapshots from the clip (every ~${(duration / frames.length).toFixed(1)}s).

SEARCH KEYWORD: "${keyword}"
${contextBlock ? `\nCONTEXT:\n${contextBlock}` : ''}

Analyze the ENTIRE clip sequence and report:

1. CONTENT: What does this clip actually show? Describe the visual content across all frames (1-2 sentences).

2. RELEVANCE: How well does this clip match the keyword and context? Consider it as B-roll over narration.

3. ISSUES: Check for ANY of these problems:
   - Watermarks, logos, or channel branding visible
   - Text overlays, lower thirds, or news tickers
   - News anchor / studio talking head
   - Shaky or blurry footage
   - Very dark or overexposed
   - Jump cuts or scene changes within the clip (inconsistent content)
   - AI-generated or illustrated content
   - Still photo with zoom (Ken Burns effect)

4. MOTION: Is there good motion/movement, or mostly static?

5. TRIM SUGGESTION: If the clip has a better segment, which frames (by number) are best?

Reply in this EXACT format (6 lines):
CONTENT: <1-2 sentence description>
RELEVANCE: <1 sentence about match quality>
ISSUES: <comma-separated list, or "none">
MOTION: <good/moderate/static>
TRIM: <"all good" or "frames N-M are best">
SCORE: <1-10 number>`;

    try {
        const response = await callVideoAI(prompt, frames, { maxTokens: DEFAULTS.maxTokens });
        return _parseClipAnalysis(response);
    } catch (err) {
        console.log(`  ⚠️ [clip-analyzer] Analysis failed: ${err.message}`);
        return null;
    }
}

/**
 * Parse the structured analysis response.
 */
function _parseClipAnalysis(response) {
    if (!response) return null;

    const lines = response.trim().split('\n');
    const result = {
        score: 0,
        description: '',
        relevance: '',
        issues: [],
        motion: 'unknown',
        trimSuggestion: null,
        raw: response,
    };

    for (const line of lines) {
        const lower = line.toLowerCase().trim();
        if (lower.startsWith('content:')) {
            result.description = line.substring(line.indexOf(':') + 1).trim();
        } else if (lower.startsWith('relevance:')) {
            result.relevance = line.substring(line.indexOf(':') + 1).trim();
        } else if (lower.startsWith('issues:')) {
            const issueStr = line.substring(line.indexOf(':') + 1).trim();
            if (issueStr.toLowerCase() !== 'none') {
                result.issues = issueStr.split(',').map(s => s.trim()).filter(Boolean);
            }
        } else if (lower.startsWith('motion:')) {
            result.motion = line.substring(line.indexOf(':') + 1).trim().toLowerCase();
        } else if (lower.startsWith('trim:')) {
            const trimStr = line.substring(line.indexOf(':') + 1).trim();
            if (!trimStr.toLowerCase().includes('all good')) {
                result.trimSuggestion = trimStr;
            }
        } else if (lower.startsWith('score:')) {
            const numMatch = line.match(/(\d+)/);
            if (numMatch) result.score = Math.min(10, Math.max(1, parseInt(numMatch[1])));
        }
    }

    // Fallback score extraction
    if (result.score === 0) {
        const anyNum = response.match(/(\d+)\s*(?:\/\s*10)?/);
        if (anyNum) result.score = Math.min(10, Math.max(1, parseInt(anyNum[1])));
    }

    return result;
}

// ============ NICHE-AWARE SEGMENT RULES ============

/**
 * Returns niche-specific disqualifier + preference rules for the segment prompt.
 * News niches are strict about broadcasts; creative niches are more relaxed.
 */
function _getNicheSegmentRules(niche) {
    const n = (niche || '').toLowerCase();

    // ── News niches: strict anti-broadcast rules ──
    if (n.startsWith('news') || n === 'general') {
        return `NICHE RULES (${n} — strict):
DISQUALIFIERS for this niche:
- News anchor / presenter at a studio desk (talking head in studio setting)
- News broadcast graphics: breaking news banners, tickers, lower thirds, bullet-point lists
- Text-heavy screens where text fills >30% of the frame (headlines, infographics, list graphics)
- Still photo with zoom effect (Ken Burns) — not real footage
- Press conference podium shots with just a speaker talking

GOOD FOOTAGE for this niche:
- Real-world event footage: protests, military, ships, aircraft, vehicles in motion
- Aerial/drone shots of relevant locations, cities, conflict zones
- Industrial footage: oil facilities, pipelines, factories, ports, infrastructure
- Raw footage from the ground: streets, crowds, real situations
- Maps and satellite imagery (real, not broadcast graphics)`;
    }

    // ── Crime niche ──
    if (n === 'crime') {
        return `NICHE RULES (crime — strict):
DISQUALIFIERS for this niche:
- News anchor / presenter at a studio desk
- News broadcast graphics: banners, tickers, lower thirds
- Text-heavy screens (>30% text)
- Bright, cheerful footage unrelated to the topic

GOOD FOOTAGE for this niche:
- Surveillance/CCTV footage, dashcam footage
- Police activity, crime scenes, courtrooms, prison exteriors
- Dark/moody urban footage: alleys, streets at night, city skylines
- Evidence photos, forensic scenes, investigation footage
- Aerial footage of locations mentioned in narration`;
    }

    // ── History niche ──
    if (n === 'history') {
        return `NICHE RULES (history — moderate):
DISQUALIFIERS for this niche:
- Modern news broadcasts or studio settings
- Visible modern watermarks or channel logos
- AI-generated or illustrated content

GOOD FOOTAGE for this niche:
- Archival/historical footage (even if grainy or black-and-white — that's GOOD)
- Documentary footage of historical locations, monuments, battlefields
- Maps, old photographs, museum artifacts (text overlays OK if period-appropriate)
- Re-enactment footage of historical events
- Aerial shots of historical sites`;
    }

    // ── Nature niche ──
    if (n === 'nature') {
        return `NICHE RULES (nature — relaxed):
DISQUALIFIERS for this niche:
- Studio/indoor footage unrelated to nature
- News broadcasts or talking heads
- Urban/industrial footage (unless topic is environmental)

GOOD FOOTAGE for this niche:
- Wildlife in natural habitats, animal behavior
- Landscapes: mountains, oceans, forests, deserts, rivers
- Aerial/drone shots of natural environments
- Macro nature details: insects, leaves, water, flowers
- Golden hour, blue hour, slow-motion nature footage
- Underwater footage, storm footage, natural phenomena`;
    }

    // ── Explainer / Education / Science niche ──
    if (n === 'education' || n === 'explainer') {
        return `NICHE RULES (explainer — clean B-roll, NO presenters):
DISQUALIFIERS for this niche (REJECT these):
- YouTuber/presenter talking to camera (this is for FACELESS video — no faces)
- Person standing in front of subject explaining (talking head)
- News anchor / studio talking head
- Visible watermarks or channel logos
- Comedy/meme/entertainment clips

GOOD FOOTAGE for this niche:
- Clean B-roll: close-ups of materials, cross-sections, aerial views of structures
- Diagrams, infographics, educational charts (text is OK if educational)
- Process footage: construction, assembly, manufacturing (hands OK, faces NOT OK)
- Laboratory footage, experiments, scientific equipment
- Documentary-style footage without visible presenter
- Architectural/engineering footage, interiors, exteriors
- Macro close-ups of textures, mechanisms, materials`;
    }

    // ── Business / Economy niche ──
    if (n === 'business') {
        return `NICHE RULES (business — moderate):
DISQUALIFIERS for this niche:
- News anchor at studio desk reading teleprompter
- News broadcast banners and tickers
- Still photos with heavy zoom effect

GOOD FOOTAGE for this niche:
- Corporate offices, board rooms, business meetings
- Stock exchange floors, trading screens, financial districts
- Factory floors, warehouses, logistics, shipping
- City skylines, business districts, modern architecture
- Product shots, technology demonstrations, press events`;
    }

    // ── Motivation niche ──
    if (n === 'motivation') {
        return `NICHE RULES (motivation — relaxed):
DISQUALIFIERS for this niche:
- News broadcasts or studio settings
- Visible watermarks or channel logos
- Dark/violent/disturbing content

GOOD FOOTAGE for this niche:
- People exercising, training, achieving goals
- Sunrise/sunset, mountain peaks, open roads, epic landscapes
- Crowd celebrations, sports victories, graduation ceremonies
- Cinematic slow-motion of determination, effort, success
- Urban energy: busy streets, city lights, people walking with purpose`;
    }

    // ── Sport niche ──
    if (n === 'sport') {
        return `NICHE RULES (sport — relaxed):
DISQUALIFIERS for this niche:
- News anchor at studio desk
- Completely unrelated non-sports content

GOOD FOOTAGE for this niche:
- Game/match footage, highlights, replays
- Athletes training, warming up, competing
- Stadium/arena shots, crowds cheering
- Sports equipment, fields, courts in action
- Victory celebrations, medal ceremonies
- Minor broadcast overlays (score tickers) are ACCEPTABLE in sports`;
    }

    // ── Food / Health niche ──
    if (n === 'food') {
        return `NICHE RULES (food — relaxed):
DISQUALIFIERS for this niche:
- News broadcasts or political content
- Visible watermarks or channel logos

GOOD FOOTAGE for this niche:
- Cooking processes, food preparation, kitchen footage
- Beautiful plated dishes, restaurant interiors
- Markets, grocery stores, farms, food production
- Close-up food shots, ingredients, spices
- People eating, dining experiences, food culture`;
    }

    // ── DIY niche ──
    if (n === 'diy') {
        return `NICHE RULES (diy — relaxed):
DISQUALIFIERS for this niche:
- News broadcasts or talking heads
- Visible watermarks or channel logos

GOOD FOOTAGE for this niche:
- Hands working on projects, tools in use, crafting
- Workshop/garage footage, materials being assembled
- Before/after transformation shots
- Close-up detail work, measuring, cutting, building
- Finished project reveals`;
    }

    // ── Luxury niche ──
    if (n === 'luxury') {
        return `NICHE RULES (luxury — moderate):
DISQUALIFIERS for this niche:
- News broadcasts or studio settings
- Low-quality or grainy footage
- Visible watermarks or channel logos

GOOD FOOTAGE for this niche:
- High-end cars, yachts, private jets, mansions
- Luxury fashion, watches, jewelry close-ups
- Five-star hotels, resorts, exclusive venues
- Cinematic city shots: Dubai, Monaco, Beverly Hills
- Elegant interiors, fine dining, champagne`;
    }

    // ── Default (unknown niche) — moderate rules ──
    return `NICHE RULES (general — moderate):
DISQUALIFIERS for this niche:
- News anchor / presenter at a studio desk
- News broadcast graphics: breaking news banners, tickers, lower thirds
- Text-heavy screens where text fills >30% of the frame
- Still photo with zoom effect (Ken Burns) — not real footage

GOOD FOOTAGE for this niche:
- Real-world footage relevant to the keyword
- Outdoor/location footage: cities, landscapes, buildings, facilities
- Aerial/drone shots, event footage, people in real settings
- Clean footage without heavy overlays or studio elements`;
}

// ============ SMART SEGMENT (PRE-DOWNLOAD) ============

/**
 * Find the best segment in a long video using Omni video understanding.
 * Extracts frames across the entire video, sends them all to the model,
 * and asks it to identify the best segment.
 *
 * @param {string} streamUrl - Direct video stream URL
 * @param {number} totalDuration - Total video duration
 * @param {number} neededDuration - How many seconds we need
 * @param {string} keyword - What we're looking for
 * @param {Object} [context] - { sceneText, niche, videoTopic }
 * @returns {Promise<{startTime: number, confidence: number, reason: string}|null>}
 */
async function findBestSegment(streamUrl, totalDuration, neededDuration, keyword, context = {}) {
    if (!isAvailable()) {
        console.log(`  🔍 [clip-analyzer] findBestSegment: not available (no Omni provider)`);
        return null;
    }
    if (totalDuration < DEFAULTS.segmentMinDuration) {
        console.log(`  🔍 [clip-analyzer] findBestSegment: video too short (${Math.round(totalDuration)}s < ${DEFAULTS.segmentMinDuration}s min)`);
        return null;
    }

    console.log(`  🔍 [clip-analyzer] findBestSegment: ${Math.round(totalDuration)}s video, need ${Math.round(neededDuration)}s, keyword="${keyword}"`);
    console.log(`  🔍 [clip-analyzer] Omni budget: ${_omniFramesSent}/${_omniBudget} frames used`);

    // Skip first 8% and last 10% (intro/outro)
    const safeStart = Math.max(3, Math.floor(totalDuration * 0.08));
    const safeEnd = Math.max(safeStart + neededDuration, totalDuration - Math.max(3, Math.floor(totalDuration * 0.10)));

    console.log(`  🔍 [clip-analyzer] Extracting ${DEFAULTS.segmentFrames} frames from ${safeStart}s-${safeEnd}s (safe zone)...`);
    const frames = await extractFramesFromUrl(streamUrl, totalDuration, DEFAULTS.segmentFrames, {
        startTime: safeStart,
        endTime: safeEnd,
    });

    if (frames.length < 3) {
        console.log(`  ⚠️ [clip-analyzer] Only extracted ${frames.length} frames (need 3+) — skipping segment analysis`);
        return null;
    }

    _omniFramesSent += frames.length;
    console.log(`  🔍 [clip-analyzer] Extracted ${frames.length} frames → sending to Omni (callVideoAI) | budget now ${_omniFramesSent}/${_omniBudget}`);

    const timestamps = frames.map(f => f.timestamp);
    const frameList = frames.map((f, i) => `Frame ${i + 1} (at ${f.timestamp.toFixed(0)}s)`).join(', ');

    const contextBlock = [
        context.videoTopic ? `Video topic: "${context.videoTopic}"` : '',
        context.sceneText ? `Scene narration: "${context.sceneText}"` : '',
        context.niche ? `Niche: ${context.niche}` : '',
    ].filter(Boolean).join('\n');

    const nicheRules = _getNicheSegmentRules(context.niche || '');

    const prompt = `You are selecting the best ${neededDuration}s segment from a ${totalDuration.toFixed(0)}s video for a FACELESS YouTube video.
These ${frames.length} frames are sampled across the video:
${frameList}

SEARCH KEYWORD: "${keyword}"
${contextBlock ? `\nCONTEXT:\n${contextBlock}` : ''}

This footage will play as B-roll while narration plays over it.

KEYWORD MATCHING (CRITICAL — be STRICT):
Read the keyword carefully. Every word matters. The footage must match the SPECIFIC thing described, not just the general category.
- "wooden frame house construction" → MUST show wooden framing/timber of a HOUSE. Road work, concrete pouring, street construction = REJECT (-1).
- "monolithic dome interior concrete" → MUST show the INSIDE of a dome. Exterior shots of domes = REJECT (-1).
- "solar panel rooftop installation" → MUST show panels on a ROOF. Ground-mounted solar farm = poor match.
- If the keyword says "interior" → exterior is WRONG. If keyword says "aerial" → ground-level is WRONG.
ASK: "Does this frame show the SPECIFIC thing the keyword describes?" If it only matches the GENERAL CATEGORY (e.g. 'construction' when keyword says 'wooden frame house'), return START_AT: -1.

TOPIC RELEVANCE (CRITICAL):
The footage MUST make sense in a video about the stated topic. Judge every frame against the VIDEO TOPIC, not just the keyword.
${context.videoTopic ? `This video is about: "${context.videoTopic}". If a frame shows something unrelated to this topic, it is UNUSABLE even if it superficially matches the keyword.` : ''}
Example: keyword "wind tunnel test" in a video about dome construction → a dome in a wind tunnel = GOOD, a spaceship in a wind tunnel = UNUSABLE (wrong topic).
Example: keyword "hurricane aftermath" in a video about dome homes → destroyed buildings/houses = GOOD, forest fire or war zone = UNUSABLE (wrong event type).

UNIVERSAL DISQUALIFIERS — frames with ANY of these are ALWAYS unusable:
- Content that does NOT belong in a video about the stated topic (wrong subject matter)
- Content that matches the general CATEGORY but not the SPECIFIC keyword (e.g. road construction for "house construction")
- Visible watermarks, channel logos, or agency stamps (Reuters, AFP, CNN, BBC, Getty etc.)
- Foreign-language subtitle or text overlay burned into the footage
- AI-generated or illustrated content when real footage exists
- Completely unrelated content (e.g. cat video for a politics keyword)
- Comedy/meme/entertainment clips when serious footage is needed

${nicheRules}

Analyze ALL ${frames.length} frames. For each, note if it has any disqualifier.
Then pick the best frame that has NO disqualifiers AND specifically matches the KEYWORD (not just the general topic).
If NO frame specifically matches what the keyword describes, you MUST reply START_AT: -1. Do NOT pick the "least bad" frame — reject the whole video instead.

Reply in this EXACT format (3 lines):
BEST_FRAME: <frame number> at <timestamp>s — <what it shows and why it's best>
AVOID: <frame numbers with disqualifiers and why, or "none">
START_AT: <recommended start timestamp in seconds, or -1 if all frames are unusable>`;

    try {
        console.log(`  🔍 [clip-analyzer] Calling Omni (callVideoAI) with ${frames.length} frames...`);
        const response = await callVideoAI(prompt, frames, { maxTokens: 300 });
        console.log(`  🔍 [clip-analyzer] Omni response: ${(response || '').substring(0, 200)}`);
        const result = _parseSegmentResponse(response, timestamps, neededDuration, safeEnd);
        if (result) {
            console.log(`  ✅ [clip-analyzer] Segment selected: startTime=${Math.round(result.startTime)}s | reason: ${result.reason || 'N/A'}`);
        } else {
            console.log(`  ⚠️ [clip-analyzer] Could not parse segment from Omni response`);
        }
        return result;
    } catch (err) {
        console.log(`  ⚠️ [clip-analyzer] Segment analysis failed: ${err.message}`);
        return null;
    }
}

/**
 * Parse the segment selection response.
 */
function _parseSegmentResponse(response, timestamps, neededDuration, maxEnd) {
    if (!response) return null;

    const result = { startTime: null, confidence: 0.7, reason: '' };

    for (const line of response.split('\n')) {
        const lower = line.toLowerCase().trim();
        if (lower.startsWith('start_at:')) {
            // Check for -1 (all frames unusable)
            if (lower.includes('-1')) {
                console.log(`  ⚠️ [clip-analyzer] Omni rejected ALL frames as off-topic/unusable`);
                return null;
            }
            const numMatch = line.match(/(\d+(?:\.\d+)?)/);
            if (numMatch) {
                result.startTime = parseFloat(numMatch[1]);
            }
        } else if (lower.startsWith('best_frame:')) {
            result.reason = line.substring(line.indexOf(':') + 1).trim();
            // Extract frame number for confidence
            const frameNum = line.match(/frame\s+(\d+)/i);
            if (frameNum) result.confidence = 0.85;
        }
    }

    if (result.startTime === null) return null;

    // Clamp to safe range
    const maxStart = maxEnd - neededDuration;
    result.startTime = Math.max(0, Math.min(result.startTime, maxStart));

    return result;
}

// ============ STATS ============

/**
 * Get usage stats for the current build session.
 */
function getStats() {
    return {
        totalFramesSent: _omniFramesSent + _clipAnalysisFrames,
        omniFrames: _omniFramesSent,
        clipAnalysisFrames: _clipAnalysisFrames,
        omniBudget: _omniBudget,
        omniRemaining: Math.max(0, _omniBudget - _omniFramesSent),
        available: isAvailable(),
    };
}

// ============ EXPORTS ============

module.exports = {
    analyzeClip,
    findBestSegment,
    extractFrames,
    extractFramesFromUrl,
    resetBudget,
    isAvailable,
    getStats,
    DEFAULTS,
};
