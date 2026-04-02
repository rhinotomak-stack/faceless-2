const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { execFile, execFileSync } = require('child_process');
const BaseProvider = require('./base-provider');
const config = require('../config');

// ─── Reddit Video Provider ──────────────────────────────────────────
// Uses Reddit's public JSON API (no keys needed).
// Self-throttles to ~1 request per 4 seconds to stay under rate limits.
// Strategy: ONE global search per keyword, NO subreddit fallback (saves requests).

// Domains yt-dlp can download from (found in Reddit posts)
const VIDEO_DOMAINS = new Set([
    'youtube.com', 'youtu.be', 'streamable.com', 'gfycat.com',
    'v.redd.it', 'clips.twitch.tv', 'vimeo.com', 'dailymotion.com',
]);

const REJECT_PATTERNS = [
    'meme', 'shitpost', 'upvote', 'karma', 'subscribe',
    'join my', 'onlyfans', 'giveaway', '[oc]', 'eli5',
    'unpopular opinion', 'change my view', 'starter pack',
];

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
];

class RedditVideoProvider extends BaseProvider {
    constructor() {
        super('Reddit Videos', 'video');
        this._ytdlpPath = null;
        this._ytdlpChecked = false;
        this._ytdlpAvailable = false;
        this._scriptContext = null;
        this._requestCount = 0;
        // Strict rate limiting — 1 request per 4 seconds = 15/min (under Reddit's ~30/min limit)
        this._lastRequestTime = 0;
        this._minRequestGap = 4000;
        this._rateLimited = false;
        this._rateLimitUntil = 0;
    }

    setContext(scriptContext) {
        this._scriptContext = scriptContext;
    }

    isAvailable() {
        if (!this._ytdlpChecked) {
            this._ytdlpChecked = true;
            this._ytdlpAvailable = false;

            const projectRoot = path.join(__dirname, '..', '..');
            const isWin = process.platform === 'win32';
            const bin = isWin ? 'yt-dlp.exe' : 'yt-dlp';
            const candidates = [
                config.youtube?.ytdlpPath || null,
                path.join(projectRoot, 'yt-dlp', bin),
                path.join(projectRoot, bin),
                'yt-dlp',
            ].filter(Boolean);

            for (const candidate of candidates) {
                try {
                    execFileSync(candidate, ['--version'], {
                        timeout: 5000,
                        stdio: ['pipe', 'pipe', 'pipe'],
                        windowsHide: true
                    });
                    this._ytdlpPath = candidate;
                    this._ytdlpAvailable = true;
                    break;
                } catch (e) { /* try next */ }
            }
        }
        return this._ytdlpAvailable;
    }

    // ─── Rate limiting ──────────────────────────────────────────────────

    async _throttle() {
        // If in cooldown from a 429, check if expired
        if (this._rateLimited) {
            if (Date.now() < this._rateLimitUntil) {
                return false; // still in cooldown
            }
            this._rateLimited = false;
            this._minRequestGap = 6000; // after 429, use 6s gap going forward
            console.log(`  [Reddit] Cooldown expired, resuming with ${this._minRequestGap / 1000}s gap`);
        }

        // Enforce gap between requests
        const elapsed = Date.now() - this._lastRequestTime;
        if (elapsed < this._minRequestGap) {
            await new Promise(r => setTimeout(r, this._minRequestGap - elapsed));
        }
        this._lastRequestTime = Date.now();
        return true;
    }

    _onRateLimited() {
        // 60s cooldown on 429, then resume with wider gap
        this._rateLimited = true;
        this._rateLimitUntil = Date.now() + 60000;
        this._minRequestGap = Math.min(8000, this._minRequestGap + 2000);
        console.log(`  [Reddit] 429 rate limited — 60s cooldown, gap now ${this._minRequestGap / 1000}s`);
    }

    // ─── Search ─────────────────────────────────────────────────────────

    /**
     * Single global search — ONE request per keyword. No subreddit fallback.
     * This keeps request count at exactly 1 per scene.
     */
    async search(keyword) {
        const canProceed = await this._throttle();
        if (!canProceed) {
            console.log(`  [Reddit] Skipping search — in cooldown`);
            return [];
        }

        const ua = USER_AGENTS[this._requestCount++ % USER_AGENTS.length];
        const url = `https://www.reddit.com/search.json`;

        let data;
        try {
            const response = await axios.get(url, {
                params: {
                    q: keyword,
                    sort: 'relevance',
                    t: 'all',
                    type: 'link',
                    limit: 100,  // max allowed — get as many as possible in 1 request
                },
                headers: {
                    'User-Agent': ua,
                    'Accept': 'application/json',
                },
                timeout: 12000,
                maxRedirects: 3,
            });
            data = response.data;
        } catch (e) {
            if (e.response?.status === 429) {
                this._onRateLimited();
            } else {
                console.log(`  [Reddit] Search error: ${e.message}`);
            }
            return [];
        }

        const children = data?.data?.children || [];
        if (children.length === 0) {
            console.log(`  [Reddit] No posts for "${keyword}"`);
            return [];
        }

        // Parse — extract videos from all posts
        const allResults = this._parseResults(children);

        // Apply reject patterns
        const afterReject = allResults.filter(r => {
            const lower = (r.title || '').toLowerCase();
            return !REJECT_PATTERNS.some(p => lower.includes(p));
        });

        // Relevance scoring
        const filtered = this._scoreAndFilterByRelevance(afterReject, keyword);

        if (filtered.length > 0) {
            console.log(`  [Reddit] ${filtered.length} videos from ${children.length} posts for "${keyword}"`);
        } else {
            // Debug: show what posts we got but couldn't use
            const videoCount = allResults.length;
            const sample = children.slice(0, 3).map(c => {
                const d = c.data;
                return `[${d.is_video ? 'VIDEO' : d.post_hint || d.domain || 'text'}] "${(d.title || '').substring(0, 40)}"`;
            });
            console.log(`  [Reddit] ${children.length} posts, ${videoCount} videos, 0 relevant for "${keyword}" | ${sample.join(', ')}`);
        }

        return filtered.slice(0, 10);
    }

    // ─── Parse & filter ─────────────────────────────────────────────────

    _parseResults(children) {
        const results = [];
        let verticalCount = 0;

        for (const child of children) {
            const d = child.data || child;
            if (!d) continue;

            // Detect video posts: Reddit-hosted, external video domains, or rich:video hint
            const isRedditVideo = d.is_video && d.media?.reddit_video?.fallback_url;
            const isExternalVideo = d.post_hint === 'rich:video'
                || VIDEO_DOMAINS.has(d.domain)
                || (d.url && d.url.includes('v.redd.it'));

            if (!isRedditVideo && !isExternalVideo) continue;

            // Skip NSFW
            if (d.over_18) continue;

            // Skip very low-engagement posts
            if ((d.ups || 0) < 3) continue;

            // Always prefer the Reddit permalink for Reddit-hosted videos —
            // bare v.redd.it URLs return 403 to yt-dlp.
            // For external videos (YouTube etc.), use the direct URL but fix HTML entities.
            let videoUrl = d.url;
            if (videoUrl) videoUrl = videoUrl.replace(/&amp;/g, '&');
            let duration = 0;
            let width = 0;
            let height = 0;

            if (isRedditVideo || (d.url && d.url.includes('v.redd.it'))) {
                // Always use permalink for Reddit-hosted video — v.redd.it direct links get 403
                videoUrl = `https://www.reddit.com${d.permalink}`;
                const rv = d.media?.reddit_video || {};
                duration = rv.duration || 0;
                width = rv.width || 0;
                height = rv.height || 0;

                // Allow vertical videos — renderer can crop/zoom to fit
                // Just track count for sorting preference (landscape first)
                if (width && height && height > width) {
                    verticalCount++;
                }
                // Skip very short clips
                if (duration && duration < 3) continue;
            }

            // Store fallback_url for direct download when yt-dlp merge fails
            const fallbackUrl = d.media?.reddit_video?.fallback_url || null;

            results.push({
                id: `reddit-${d.id}`,
                url: videoUrl,
                title: (d.title || '').substring(0, 200),
                width: width || 1920,
                height: height || 1080,
                duration: duration || 0,
                _duration: duration,
                _subreddit: d.subreddit || '',
                _score: d.ups || 0,
                _isRedditHosted: isRedditVideo,
                _permalink: d.permalink,
                _fallbackUrl: fallbackUrl,
                _cachedMeta: (width && height && duration) ? { duration, width, height, title: (d.title || ''), _fallbackUrl: fallbackUrl } : null,
            });

            if (results.length >= 12) break;
        }

        return results;
    }

    _scoreAndFilterByRelevance(results, keyword) {
        const STOP_WORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for', 'of', 'and', 'or', 'but', 'with', 'from', 'by', 'this', 'that', 'it', 'its', 'as', 'be', 'has', 'had', 'have', 'been', 'will', 'would', 'could', 'should', 'not', 'no', 'so', 'if', 'just', 'about', 'up', 'out', 'all', 'one', 'two', 'how', 'why', 'what', 'when', 'who', 'which', 'do', 'does', 'did', 'can', 'new']);

        const extractWords = (text) => {
            return (text || '').toLowerCase()
                .replace(/[^a-z0-9\s]/g, ' ')
                .split(/\s+/)
                .filter(w => w.length > 2 && !STOP_WORDS.has(w));
        };

        const keywordWords = new Set(extractWords(keyword));
        const topicWords = new Set(extractWords(this._scriptContext?.summary || ''));
        const entityWords = new Set();
        for (const entity of (this._scriptContext?.entities || [])) {
            for (const w of extractWords(entity)) entityWords.add(w);
        }

        const scored = results.map(r => {
            const titleWords = extractWords(r.title);
            let relevance = 0;

            for (const word of titleWords) {
                if (keywordWords.has(word)) relevance += 3;
                else if (entityWords.has(word)) relevance += 2;
                else if (topicWords.has(word)) relevance += 1;
            }

            const engagementBonus = Math.min(2, Math.log10(Math.max(1, r._score || 0)));
            return { ...r, _relevance: relevance + engagementBonus };
        });

        const relevant = scored.filter(r => r._relevance > 0);
        const dropped = scored.length - relevant.length;
        if (dropped > 0) {
            console.log(`  [Reddit] Filtered ${dropped} irrelevant results (no title match)`);
        }

        relevant.sort((a, b) => (b._relevance - a._relevance) || (b._score - a._score));
        return relevant;
    }

    // ─── Download ───────────────────────────────────────────────────────

    async download(url, outputPath, options = {}) {
        const duration = options.duration || 10;
        const maxHeight = config.youtube?.maxHeight || 720;

        const metadata = options._cachedMeta || await this._getVideoMetadata(url);

        if (metadata) {
            // Allow vertical videos — renderer crops/zooms to fit landscape output
            if (metadata.duration && metadata.duration < 3) {
                throw new Error('Video too short (< 3s)');
            }
        }

        const videoDuration = metadata?.duration || 30;
        const neededDuration = Math.ceil(duration) + 2;

        // Use Omni smart trim if available, otherwise dumb heuristic
        let startTime = 0;
        if (options._smartStartTime != null && options._smartStartTime >= 0) {
            startTime = options._smartStartTime;
            console.log(`  🎯 [Reddit] Using Omni smart trim start: ${Math.round(startTime)}s (video ${Math.round(videoDuration)}s)`);
        } else if (videoDuration > neededDuration + 5) {
            startTime = Math.min(5, Math.floor(videoDuration * 0.1));
            console.log(`  📐 [Reddit] Using dumb trim start: ${startTime}s (no smart trim available)`);
        }

        const args = [
            url,
            '-f', `bestvideo[height<=${maxHeight}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${maxHeight}][ext=mp4]/best[height<=${maxHeight}]/best`,
            '--merge-output-format', 'mp4',
            '--no-playlist',
            '--no-warnings',
            '--no-check-certificates',
            '-o', outputPath,
            '--force-overwrites',
            '--max-filesize', '50M',
        ];

        if (videoDuration > neededDuration + 3) {
            const endTime = startTime + neededDuration;
            args.push('--download-sections', `*${startTime}-${endTime}`);
            console.log(`  [Reddit] Trimming to ${startTime}s-${endTime}s (video is ${Math.round(videoDuration)}s)`);
        }

        try {
            const ffmpegPath = require('ffmpeg-static');
            if (ffmpegPath) {
                args.push('--ffmpeg-location', path.dirname(ffmpegPath));
            }
        } catch (e) {}

        return new Promise((resolve, reject) => {
            try { if (fs.existsSync(outputPath + '.part')) fs.unlinkSync(outputPath + '.part'); } catch (e) {}
            try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}

            console.log(`  [Reddit] Downloading from ${url}`);

            execFile(this._ytdlpPath, args, {
                timeout: 120000,
                windowsHide: true,
            }, (error) => {
                if (error) {
                    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
                    try { if (fs.existsSync(outputPath + '.part')) fs.unlinkSync(outputPath + '.part'); } catch (e) {}
                    return reject(new Error(`yt-dlp download failed: ${error.message}`));
                }

                if (!fs.existsSync(outputPath)) {
                    const dir = path.dirname(outputPath);
                    const base = path.basename(outputPath, '.mp4');
                    try {
                        const files = fs.readdirSync(dir).filter(f => f.startsWith(base) && f.endsWith('.mp4'));
                        if (files.length > 0) {
                            fs.renameSync(path.join(dir, files[0]), outputPath);
                        }
                    } catch (e) {}
                }

                if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
                    return reject(new Error('yt-dlp produced empty or missing file'));
                }

                // Verify the file has a video stream (not audio-only)
                // Reddit sometimes serves audio-only when video+audio merge fails
                const hasVideo = this._checkHasVideoStream(outputPath);
                if (hasVideo === false) {
                    console.log(`  [Reddit] Audio-only file detected — trying fallback methods`);
                    try { fs.unlinkSync(outputPath); } catch (e) {}

                    // Fallback chain for audio-only files:
                    // 1. Direct fallback_url download (Reddit's raw DASH video stream)
                    // 2. yt-dlp video-only format
                    this._downloadFallback(url, outputPath, maxHeight, startTime, neededDuration, videoDuration, options)
                        .then(() => {
                            console.log(`  [Reddit] Downloaded (fallback): ${path.basename(outputPath)}`);
                            resolve(outputPath);
                        })
                        .catch((fallbackErr) => {
                            try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
                            reject(new Error(`All download methods failed: ${fallbackErr.message}`));
                        });
                    return;
                }

                console.log(`  [Reddit] Downloaded: ${path.basename(outputPath)}`);
                resolve(outputPath);
            });
        });
    }

    /**
     * Fallback download chain when yt-dlp merge produces audio-only.
     * 1. Direct axios download of Reddit's fallback_url (DASH video stream)
     * 2. yt-dlp with video-only format selector
     */
    async _downloadFallback(url, outputPath, maxHeight, startTime, neededDuration, videoDuration, options) {
        // Method 1: Direct download of Reddit's DASH video URL (fallback_url)
        // This is the raw video stream — no merge needed, no yt-dlp needed
        const fallbackUrl = options._fallbackUrl || options._cachedMeta?._fallbackUrl;
        if (fallbackUrl) {
            console.log(`  [Reddit] Trying direct DASH download: ${fallbackUrl.substring(0, 80)}...`);
            try {
                await this._downloadDirect(fallbackUrl, outputPath);
                if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 5000) {
                    const hasVid = this._checkHasVideoStream(outputPath);
                    if (hasVid !== false) {
                        // Got a valid video file — trim with ffmpeg if needed
                        if (videoDuration > neededDuration + 3) {
                            await this._trimWithFfmpeg(outputPath, startTime, neededDuration);
                        }
                        return;
                    }
                }
                try { fs.unlinkSync(outputPath); } catch (e) {}
            } catch (e) {
                console.log(`  [Reddit] Direct download failed: ${e.message}`);
                try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e2) {}
            }
        }

        // Method 2: yt-dlp with video-only format (no audio merge)
        console.log(`  [Reddit] Trying yt-dlp video-only format`);
        return new Promise((resolve, reject) => {
            const videoOnlyArgs = [
                url,
                '-f', `bestvideo[height<=${maxHeight}][ext=mp4]/bestvideo[height<=${maxHeight}]/bestvideo`,
                '--no-playlist',
                '--no-warnings',
                '--no-check-certificates',
                '-o', outputPath,
                '--force-overwrites',
            ];
            if (videoDuration > neededDuration + 3) {
                videoOnlyArgs.push('--download-sections', `*${startTime}-${startTime + neededDuration}`);
            }
            try {
                const ffmpegPath = require('ffmpeg-static');
                if (ffmpegPath) videoOnlyArgs.push('--ffmpeg-location', path.dirname(ffmpegPath));
            } catch (e) {}

            execFile(this._ytdlpPath, videoOnlyArgs, {
                timeout: 120000,
                windowsHide: true,
            }, (error) => {
                if (error || !fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
                    return reject(new Error('video-only yt-dlp failed'));
                }
                const hasVid = this._checkHasVideoStream(outputPath);
                if (hasVid === false) {
                    try { fs.unlinkSync(outputPath); } catch (e) {}
                    return reject(new Error('video-only still produced audio-only'));
                }
                resolve();
            });
        });
    }

    /**
     * Direct HTTP download of a video URL via axios (no yt-dlp).
     * Used for Reddit's fallback_url (raw DASH video streams).
     */
    async _downloadDirect(url, outputPath) {
        const response = await axios({
            method: 'get',
            url: url,
            responseType: 'stream',
            timeout: 60000,
            headers: {
                'User-Agent': USER_AGENTS[0],
            },
        });

        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });
    }

    /**
     * Trim a video file in-place using ffmpeg.
     */
    async _trimWithFfmpeg(filePath, startTime, duration) {
        const tmpPath = filePath + '.trim.mp4';
        const ffmpegCandidates = ['C:\\ffmg\\bin\\ffmpeg.exe', 'ffmpeg'];
        try {
            const ffmpegStatic = require('ffmpeg-static');
            if (ffmpegStatic) ffmpegCandidates.unshift(ffmpegStatic);
        } catch (e) {}

        for (const ffmpeg of ffmpegCandidates) {
            try {
                execFileSync(ffmpeg, [
                    '-y', '-ss', String(startTime), '-i', filePath,
                    '-t', String(duration), '-c', 'copy', tmpPath
                ], { timeout: 30000, windowsHide: true });
                if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 1000) {
                    fs.unlinkSync(filePath);
                    fs.renameSync(tmpPath, filePath);
                    return;
                }
            } catch (e) { continue; }
        }
        // Trim failed — keep original (untrimmed but still valid)
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (e) {}
    }

    /**
     * Check if a downloaded file contains a video stream.
     * Returns true (has video), false (audio-only), or null (ffprobe unavailable).
     */
    _checkHasVideoStream(filePath) {
        const probeCandidates = [
            'C:\\ffmg\\bin\\ffprobe.exe',
            'ffprobe',
        ];
        try {
            const ffmpegStatic = require('ffmpeg-static');
            if (ffmpegStatic) {
                probeCandidates.unshift(
                    path.join(path.dirname(ffmpegStatic), 'ffprobe' + (process.platform === 'win32' ? '.exe' : ''))
                );
            }
        } catch (e) {}

        for (const probe of probeCandidates) {
            try {
                const result = execFileSync(probe, [
                    '-v', 'error', '-select_streams', 'v:0',
                    '-show_entries', 'stream=codec_type',
                    '-of', 'csv=p=0', filePath
                ], { timeout: 5000, windowsHide: true, encoding: 'utf8' });
                return result.trim().includes('video');
            } catch (e) { continue; }
        }
        return null; // ffprobe not available
    }

    async _getVideoMetadata(url) {
        if (!this._ytdlpPath) return null;

        try {
            const result = await new Promise((resolve, reject) => {
                execFile(this._ytdlpPath, [
                    url,
                    '--dump-json',
                    '--no-download',
                    '--no-warnings',
                    '--no-check-certificates',
                    '--no-playlist',
                ], {
                    timeout: 15000,
                    windowsHide: true,
                    maxBuffer: 5 * 1024 * 1024,
                }, (error, stdout) => {
                    if (error) return reject(error);
                    try {
                        resolve(JSON.parse(stdout));
                    } catch (e) {
                        reject(new Error('Failed to parse metadata JSON'));
                    }
                });
            });

            return {
                duration: result.duration || 0,
                width: result.width || 0,
                height: result.height || 0,
                title: result.title || '',
            };
        } catch (e) {
            console.log(`  [Reddit] Metadata fetch failed: ${e.message}`);
            return null;
        }
    }
}

module.exports = RedditVideoProvider;
