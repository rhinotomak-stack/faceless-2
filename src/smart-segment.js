/**
 * Smart Segment Selection — Universal Video Segment Scoring
 *
 * Shared module used by ALL video providers (YouTube, News, future providers)
 * and by footage-manager as a post-download safety net.
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  RULES — When & How Smart Segment Scoring Applies
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  1. MINIMUM DURATION
 *     - Pre-download (URL scoring):  video must be >= minDuration (default 20s)
 *     - Post-download (file scoring): video must be >= 15s
 *     - Videos shorter than this are already concise — no scoring needed.
 *
 *  2. FRAME SAMPLING
 *     - Default: 4 frames spread evenly across the safe zone
 *     - YouTube: 6 frames (longer videos, more variety)
 *     - Safe zone: skip first/last margins (default 8% start, 10% end)
 *     - Frames extracted in parallel batches (default batch size: 3)
 *
 *  3. WHAT TO PENALIZE (handled by Vision AI prompt in ai-vision.js)
 *     - News anchors / talking heads in studio
 *     - Text-heavy screens (headlines, tickers, lower thirds)
 *     - Studio/desk shots with minimal visual content
 *     - Watermarks, logos, AI-generated artifacts
 *     - Generic stock footage that doesn't match the topic
 *
 *  4. SCORING THRESHOLD
 *     - Frames scoring <= 2 are rejected as unusable
 *     - If ALL frames score <= 2, return null (use heuristic fallback)
 *     - Fast-fail: if first frame scores 0, Vision AI is broken — skip rest
 *
 *  5. FALLBACK CHAIN
 *     - Vision AI scoring → chapter-based selection (YouTube only) → percentage heuristic
 *     - If Vision AI unavailable: return null immediately (caller uses heuristic)
 *     - If ffmpeg unavailable: return null immediately
 *
 *  6. PROVIDER INTEGRATION
 *     - YouTube: calls selectBestSegment() with streamUrl before download
 *     - News: calls selectBestSegment() with direct/HLS URL before download
 *     - Footage Manager: calls scoreDownloadedVideo() AFTER download as safety net
 *     - Future providers: import and call selectBestSegment() with any video URL
 *
 *  7. CONTEXT PASSING
 *     - Always pass keyword, sceneText, niche, videoTopic, theme, entities
 *     - More context = better scoring accuracy
 *     - Vision AI uses literal visual matching (not symbolic/metaphorical)
 *
 * ═══════════════════════════════════════════════════════════════════════
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const config = require('./config');

// ─── Constants ───────────────────────────────────────────────────────

const DEFAULTS = {
    numSamples: 4,          // frames to extract
    batchSize: 3,           // parallel frame extractions
    minDuration: 20,        // minimum video seconds to bother scoring
    startMargin: 0.08,      // skip first 8% of video
    endMargin: 0.10,        // skip last 10% of video
    startMarginSec: 3,      // absolute minimum seconds to skip at start
    endMarginSec: 3,        // absolute minimum seconds to skip at end
    frameTimeout: 15000,    // ms timeout per frame extraction
    probeTimeout: 15000,    // ms timeout for duration probe
    scoreThreshold: 2,      // minimum acceptable score
    frameScale: 512,        // downscale frames to this width (saves bandwidth)
    frameQuality: 3,        // JPEG quality (1=best, 31=worst)
};

// ─── Core: Select Best Segment ───────────────────────────────────────

/**
 * Score frames from a video URL and pick the best segment to download.
 * Works with any video URL: direct mp4, HLS, YouTube stream, etc.
 *
 * @param {string} videoUrl - URL to the video (mp4, m3u8, or stream URL)
 * @param {object} opts
 * @param {number} opts.neededDuration - how many seconds of video we need
 * @param {string} opts.keyword - search keyword for relevance scoring
 * @param {object} [opts.context] - { sceneText, niche, videoTopic, theme, entities, tone, mood }
 * @param {number} [opts.totalDuration] - if known, skip probing
 * @param {number} [opts.numSamples] - override frame count (default 4)
 * @param {number} [opts.batchSize] - override parallel batch size (default 3)
 * @param {number} [opts.minDuration] - override minimum duration (default 20)
 * @param {number} [opts.startMargin] - override start margin % (default 0.08)
 * @param {number} [opts.endMargin] - override end margin % (default 0.10)
 * @param {string} [opts.providerTag] - log prefix e.g. "YouTube", "News" (default "SmartSeg")
 * @returns {Promise<number|null>} best start time in seconds, or null
 */
async function selectBestSegment(videoUrl, opts = {}) {
    const tag = opts.providerTag || 'SmartSeg';

    try {
        // 1. Check vision + ffmpeg availability
        let scoreVideoFrame, isVisionAvailable, checkFfmpegAvailable;
        try {
            ({ scoreVideoFrame, isVisionAvailable, checkFfmpegAvailable } = require('./ai-vision'));
        } catch (e) {
            return null;
        }

        if (!isVisionAvailable()) {
            console.log(`  🎯 [${tag}] Vision AI not available — skipping segment scoring`);
            return null;
        }

        const ffmpegPath = checkFfmpegAvailable();
        if (!ffmpegPath) {
            console.log(`  🎯 [${tag}] ffmpeg not available — skipping segment scoring`);
            return null;
        }

        // 2. Determine total duration
        const minDuration = opts.minDuration ?? DEFAULTS.minDuration;
        let totalDuration = opts.totalDuration || null;

        if (!totalDuration) {
            totalDuration = await probeDuration(ffmpegPath, videoUrl);
        }

        if (!totalDuration || totalDuration < minDuration) {
            if (totalDuration) {
                console.log(`  🎯 [${tag}] Video too short (${Math.round(totalDuration)}s < ${minDuration}s) — skipping scoring`);
            } else {
                console.log(`  🎯 [${tag}] Could not determine video duration — skipping scoring`);
            }
            return null;
        }

        // 3. Calculate sample timestamps
        const numSamples = opts.numSamples ?? DEFAULTS.numSamples;
        const batchSize = opts.batchSize ?? DEFAULTS.batchSize;
        const neededDuration = opts.neededDuration || 10;

        const startMargin = opts.startMargin ?? DEFAULTS.startMargin;
        const endMargin = opts.endMargin ?? DEFAULTS.endMargin;

        const safeStart = Math.max(DEFAULTS.startMarginSec, Math.floor(totalDuration * startMargin));
        const safeEnd = Math.max(safeStart + neededDuration, totalDuration - Math.max(DEFAULTS.endMarginSec, Math.floor(totalDuration * endMargin)));
        const range = safeEnd - safeStart;

        if (range <= 0) return null;

        const timestamps = [];
        for (let i = 0; i < numSamples; i++) {
            timestamps.push(Math.floor(safeStart + (range * i) / Math.max(1, numSamples - 1)));
        }

        console.log(`  🎯 [${tag}] Smart segment: scoring ${numSamples} frames at ${timestamps.map(t => t + 's').join(', ')} (total: ${Math.round(totalDuration)}s)`);

        // 4. Extract frames in batches
        const tempDir = config.paths?.temp || path.join(__dirname, '..', 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const uid = Date.now().toString(36);
        const framePaths = [];

        for (let batch = 0; batch < numSamples; batch += batchSize) {
            const batchPromises = [];
            for (let j = batch; j < Math.min(batch + batchSize, numSamples); j++) {
                const framePath = path.join(tempDir, `_seg_frame_${uid}_${j}.jpg`);
                framePaths.push(framePath);
                batchPromises.push(extractFrame(ffmpegPath, videoUrl, timestamps[j], framePath));
            }
            await Promise.all(batchPromises);
        }

        // 5. Read valid frames
        const validFrames = [];
        for (let i = 0; i < framePaths.length; i++) {
            if (!framePaths[i] || !fs.existsSync(framePaths[i])) continue;
            try {
                const stat = fs.statSync(framePaths[i]);
                if (stat.size < 500) continue; // corrupt/empty
                validFrames.push({
                    idx: i,
                    base64: fs.readFileSync(framePaths[i]).toString('base64'),
                });
            } catch (e) {}
        }

        if (validFrames.length < 2) {
            console.log(`  🎯 [${tag}] Too few frames extracted (${validFrames.length}) — skipping scoring`);
            _cleanupFrames(framePaths);
            return null;
        }

        // 6. Score frames sequentially (fast-fail on broken vision)
        const keyword = opts.keyword || '';
        const context = opts.context || {};
        const scores = [];
        const validIndices = [];

        for (const frame of validFrames) {
            const result = await scoreVideoFrame(frame.base64, 'image/jpeg', keyword, context);
            scores.push(result.score);
            validIndices.push(frame.idx);

            const desc = result.description ? ` → ${result.description}` : '';
            console.log(`    Frame ${frame.idx + 1} (${timestamps[frame.idx]}s): ${result.score}/10${desc}`);

            // Fast-fail: vision returned 0 on first frame = likely broken
            if (scores.length === 1 && result.score === 0) {
                console.log(`  🎯 [${tag}] Vision returned 0 on first frame — aborting`);
                _cleanupFrames(framePaths);
                return null;
            }
        }

        _cleanupFrames(framePaths);

        // 7. Pick best scoring frame
        let bestIdx = 0;
        let bestScore = 0;
        for (let i = 0; i < scores.length; i++) {
            if (scores[i] > bestScore) {
                bestScore = scores[i];
                bestIdx = validIndices[i];
            }
        }

        if (bestScore <= DEFAULTS.scoreThreshold) {
            console.log(`  🎯 [${tag}] All frames scored poorly (best: ${bestScore}/10) — using fallback`);
            return null;
        }

        const bestTime = timestamps[bestIdx];
        const maxStart = totalDuration - neededDuration - 2;
        const startTime = Math.min(bestTime, Math.max(0, maxStart));
        console.log(`  🎯 [${tag}] Best: frame ${bestIdx + 1} at ${bestTime}s (score: ${bestScore}/10) → start at ${startTime}s`);
        return startTime;

    } catch (err) {
        console.log(`  🎯 [${opts.providerTag || 'SmartSeg'}] Segment scoring failed: ${err.message}`);
        return null;
    }
}


// ─── Post-Download Segment Scoring ───────────────────────────────────

/**
 * Score a video FILE that's already been downloaded.
 * If the video is long enough and the current segment is poor,
 * returns the best start time for re-extraction.
 *
 * Used by footage-manager as a safety net for ANY provider.
 *
 * @param {string} filePath - path to downloaded video file
 * @param {object} opts - same as selectBestSegment opts
 * @returns {Promise<{shouldRetrim: boolean, startTime: number|null, bestScore: number}>}
 */
async function scoreDownloadedVideo(filePath, opts = {}) {
    const tag = opts.providerTag || 'PostScore';

    try {
        let scoreVideoFrame, isVisionAvailable, checkFfmpegAvailable;
        try {
            ({ scoreVideoFrame, isVisionAvailable, checkFfmpegAvailable } = require('./ai-vision'));
        } catch (e) {
            return { shouldRetrim: false, startTime: null, bestScore: 0 };
        }

        if (!isVisionAvailable()) return { shouldRetrim: false, startTime: null, bestScore: 0 };

        const ffmpegPath = checkFfmpegAvailable();
        if (!ffmpegPath) return { shouldRetrim: false, startTime: null, bestScore: 0 };

        // Probe downloaded file duration
        const totalDuration = await probeDuration(ffmpegPath, filePath);
        if (!totalDuration || totalDuration < 15) {
            return { shouldRetrim: false, startTime: null, bestScore: 0 };
        }

        // Score just 1 frame from the current clip (at 25% mark)
        const sampleTime = Math.floor(totalDuration * 0.25);
        const tempDir = config.paths?.temp || path.join(__dirname, '..', 'temp');
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        const framePath = path.join(tempDir, `_postscore_${Date.now().toString(36)}.jpg`);

        const extracted = await extractFrame(ffmpegPath, filePath, sampleTime, framePath);
        if (!extracted || !fs.existsSync(framePath)) {
            return { shouldRetrim: false, startTime: null, bestScore: 0 };
        }

        try {
            const stat = fs.statSync(framePath);
            if (stat.size < 500) {
                _cleanupFrames([framePath]);
                return { shouldRetrim: false, startTime: null, bestScore: 0 };
            }

            const base64 = fs.readFileSync(framePath).toString('base64');
            const keyword = opts.keyword || '';
            const context = opts.context || {};
            const result = await scoreVideoFrame(base64, 'image/jpeg', keyword, context);

            console.log(`  🎯 [${tag}] Post-download score: ${result.score}/10 → ${result.description || 'no description'}`);

            _cleanupFrames([framePath]);

            // If score is acceptable, no need to retrim
            if (result.score > 3) {
                return { shouldRetrim: false, startTime: null, bestScore: result.score };
            }

            // Score is poor — but we can only suggest retrimming, not do it
            // (the original source URL may no longer be available)
            console.log(`  🎯 [${tag}] Low score (${result.score}/10) — flagging for potential retry`);
            return { shouldRetrim: true, startTime: null, bestScore: result.score };

        } catch (e) {
            _cleanupFrames([framePath]);
            return { shouldRetrim: false, startTime: null, bestScore: 0 };
        }

    } catch (err) {
        return { shouldRetrim: false, startTime: null, bestScore: 0 };
    }
}


// ─── Shared Utilities ────────────────────────────────────────────────

/**
 * Extract a single frame from a video URL or file at a given timestamp.
 * @param {string} ffmpegPath
 * @param {string} source - URL or local file path
 * @param {number} timestamp - seconds
 * @param {string} outputPath - where to write the JPEG
 * @returns {Promise<boolean>} true if frame extracted successfully
 */
function extractFrame(ffmpegPath, source, timestamp, outputPath) {
    return new Promise((resolve) => {
        execFile(ffmpegPath, [
            '-ss', String(timestamp),
            '-i', source,
            '-vf', `scale=${DEFAULTS.frameScale}:-1`,
            '-frames:v', '1',
            '-q:v', String(DEFAULTS.frameQuality),
            '-y', outputPath,
        ], {
            timeout: DEFAULTS.frameTimeout,
            windowsHide: true,
        }, (error) => {
            resolve(!error && fs.existsSync(outputPath));
        });
    });
}

/**
 * Probe the duration of a video URL or local file using ffprobe (or ffmpeg fallback).
 * Handles HLS manifests, direct mp4s, and local files.
 * @param {string} ffmpegPath
 * @param {string} source - URL or local file path
 * @returns {Promise<number|null>} duration in seconds, or null
 */
function probeDuration(ffmpegPath, source) {
    const isRemote = source.startsWith('http');
    // HLS/remote URLs need more time to fetch and parse the manifest
    const timeout = isRemote ? 25000 : DEFAULTS.probeTimeout;

    return new Promise((resolve) => {
        const ffprobePath = ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

        // Method 1: ffprobe (most reliable)
        execFile(ffprobePath, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            source,
        ], {
            timeout,
            windowsHide: true,
        }, (error, stdout) => {
            if (!error && stdout) {
                const dur = parseFloat(stdout.trim());
                if (dur > 0) return resolve(dur);
            }

            // Method 2: ffmpeg -i (parse "Duration: HH:MM:SS.ms" from stderr)
            execFile(ffmpegPath, [
                '-i', source,
                '-f', 'null', '-',
            ], {
                timeout,
                windowsHide: true,
            }, (error2, stdout2, stderr2) => {
                // ffmpeg always "errors" with -f null, but stderr has duration info
                const combined = (stderr2 || '') + (stdout2 || '');
                const durMatch = combined.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
                if (durMatch) {
                    const dur = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]) + parseInt(durMatch[4]) / 100;
                    if (dur > 0) return resolve(dur);
                }

                // Method 3: Binary probe — try extracting a frame at 60s.
                // If it succeeds, we know the video is at least 60s long.
                // This is a last resort for HLS streams where duration is unknown.
                if (isRemote) {
                    const probePath = path.join(config.paths?.temp || path.join(__dirname, '..', 'temp'), `_probe_${Date.now().toString(36)}.jpg`);
                    execFile(ffmpegPath, [
                        '-ss', '60',
                        '-i', source,
                        '-frames:v', '1',
                        '-q:v', '10',
                        '-y', probePath,
                    ], {
                        timeout,
                        windowsHide: true,
                    }, (error3) => {
                        try { if (fs.existsSync(probePath)) fs.unlinkSync(probePath); } catch (e) {}
                        if (!error3) {
                            // Frame at 60s extracted → video is at least 60s+ (estimate 120s)
                            return resolve(120);
                        }
                        // Try at 20s
                        const probePath2 = probePath + '2.jpg';
                        execFile(ffmpegPath, [
                            '-ss', '20',
                            '-i', source,
                            '-frames:v', '1',
                            '-q:v', '10',
                            '-y', probePath2,
                        ], {
                            timeout,
                            windowsHide: true,
                        }, (error4) => {
                            try { if (fs.existsSync(probePath2)) fs.unlinkSync(probePath2); } catch (e) {}
                            if (!error4) {
                                // Frame at 20s → video is at least 20s+ (estimate 60s)
                                return resolve(60);
                            }
                            resolve(null);
                        });
                    });
                } else {
                    resolve(null);
                }
            });
        });
    });
}

/**
 * Clean up temporary frame files.
 */
function _cleanupFrames(framePaths) {
    for (const f of framePaths) {
        try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch (e) {}
    }
}


// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
    selectBestSegment,
    scoreDownloadedVideo,
    extractFrame,
    probeDuration,
    DEFAULTS,
};
