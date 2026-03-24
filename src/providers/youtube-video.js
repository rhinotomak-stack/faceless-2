const { execFile, execFileSync } = require('child_process');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const BaseProvider = require('./base-provider');
const { selectBestSegment } = require('../smart-segment');

// Chapter titles that indicate intro/outro segments to skip
const SKIP_CHAPTER_PATTERNS = [
    'intro', 'introduction', 'opening', 'welcome', 'sponsor',
    'outro', 'end screen', 'credits', 'subscribe', 'like and subscribe',
    'disclaimer', 'teaser', 'preview', 'bumper',
];

// Title patterns that indicate non-footage content (music, lyrics, etc.)
const REJECT_TITLE_PATTERNS = [
    'official music video', 'official video', 'lyrics', 'lyric video',
    'karaoke', 'full album', 'audio only', 'official audio',
    'sing along', 'instrumental', 'remix', 'live performance',
    'reaction video', 'unboxing', 'asmr',
    '#shorts', '#short',
];

// Theme-specific query strategies for YouTube
const QUERY_STRATEGIES = {
    politics:      (kw) => [`${kw} news report`, `${kw} press conference`, `${kw} footage`],
    finance:       (kw) => [`${kw} news report`, `${kw} market analysis`, `${kw} footage`],
    business:      (kw) => [`${kw} news`, `${kw} corporate`, `${kw} footage`],
    technology:    (kw) => [`${kw} demo`, `${kw} tech review`, `${kw} footage`],
    history:       (kw) => [`${kw} documentary`, `${kw} historical footage`, `${kw} archive`],
    entertainment: (kw) => [`${kw} clip`, `${kw} highlights`, `${kw} footage`],
    sports:        (kw) => [`${kw} highlights`, `${kw} game footage`, `${kw} sports`],
    nature:        (kw) => [`${kw} nature documentary`, `${kw} wildlife`, `${kw} stock footage`],
    travel:        (kw) => [`${kw} travel`, `${kw} aerial`, `${kw} stock footage`],
    science:       (kw) => [`${kw} explained`, `${kw} experiment`, `${kw} documentary`],
    health:        (kw) => [`${kw} medical`, `${kw} health report`, `${kw} footage`],
    education:     (kw) => [`${kw} explained`, `${kw} lecture`, `${kw} educational`],
    crime:         (kw) => [`${kw} crime report`, `${kw} investigation`, `${kw} footage`],
    documentary:   (kw) => [`${kw} documentary`, `${kw} real footage`, `${kw} investigation`],
    motivation:    (kw) => [`${kw} motivational`, `${kw} inspirational`, `${kw} stock footage`],
};

class YouTubeVideoProvider extends BaseProvider {
    constructor() {
        super('YouTube Videos', 'video');
        this._ytdlpPath = null;
        this._ytdlpChecked = false;
        this._ytdlpAvailable = false;
        this._scriptContext = null;
    }

    /**
     * Set script context for theme-aware search queries
     */
    setContext(scriptContext) {
        this._scriptContext = scriptContext;
    }

    isAvailable() {
        if (!this._ytdlpChecked) {
            this._ytdlpChecked = true;
            this._ytdlpAvailable = false;

            // Check: configured path, project-local yt-dlp folder, then system PATH
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
                    console.log(`  [YouTube] yt-dlp found: ${candidate}`);
                    break;
                } catch (e) {
                    // try next candidate
                }
            }

            if (!this._ytdlpAvailable) {
                console.log('  [YouTube] yt-dlp not found. Install from: https://github.com/yt-dlp/yt-dlp/releases');
            }
        }
        return this._ytdlpAvailable;
    }

    /**
     * Build context-aware search queries based on video theme
     */
    _buildSearchQueries(keyword) {
        const queries = [];
        const words = keyword.trim().split(/\s+/);
        const isSpecific = words.length >= 4; // 4+ words = already specific, don't pollute

        // Specific queries (entities, proper nouns, long phrases): raw keyword first
        if (isSpecific) {
            queries.push(keyword);
        }

        const theme = (this._scriptContext?.theme || '').toLowerCase();

        // Use theme-specific strategies if available (skip for specific queries)
        if (!isSpecific && theme && QUERY_STRATEGIES[theme]) {
            queries.push(...QUERY_STRATEGIES[theme](keyword));
        }

        // Tone-based additions (skip for specific queries)
        const tone = (this._scriptContext?.tone || '').toLowerCase();
        if (!isSpecific && (tone === 'urgent' || tone === 'dramatic' || tone === 'serious')) {
            queries.push(`${keyword} breaking news`);
        }

        // Generic fallbacks
        if (!isSpecific) {
            queries.push(`${keyword} stock footage`);
        }
        queries.push(keyword); // raw keyword always included

        // Deduplicate while preserving order
        return [...new Set(queries)];
    }

    /**
     * Filter out non-footage results (music videos, lyrics, etc.)
     */
    _filterByTitle(results) {
        return results.filter(r => {
            // Reject YouTube Shorts URLs (vertical video, unusable for 1920x1080 canvas)
            if (r.url && r.url.includes('/shorts/')) return false;

            if (!r.title) return true; // no title info, let it through
            const lower = r.title.toLowerCase();
            for (const pattern of REJECT_TITLE_PATTERNS) {
                if (lower.includes(pattern)) return false;
            }
            return true;
        });
    }

    /**
     * Fetch video metadata (duration, chapters) via yt-dlp --dump-json
     */
    async _getVideoMetadata(url) {
        return new Promise((resolve) => {
            const args = [
                url,
                '--dump-json',
                '--no-download',
                '--no-warnings',
                '--no-check-certificates',
            ];

            execFile(this._ytdlpPath, args, {
                timeout: 20000,
                windowsHide: true,
                maxBuffer: 5 * 1024 * 1024, // 5MB buffer for large JSON
            }, (error, stdout) => {
                if (error) {
                    console.log(`  [YouTube] Metadata fetch failed: ${error.message}`);
                    return resolve(null);
                }

                try {
                    const data = JSON.parse(stdout);
                    return resolve({
                        duration: data.duration || 0,
                        chapters: data.chapters || [],
                        title: data.title || '',
                        description: data.description || '',
                        width: data.width || 0,
                        height: data.height || 0,
                    });
                } catch (e) {
                    console.log(`  [YouTube] Failed to parse metadata JSON`);
                    return resolve(null);
                }
            });
        });
    }

    /**
     * Calculate the best start time to skip intros/logos.
     * Uses chapters if available, otherwise skips a percentage of the video.
     */
    _calculateBestStartTime(metadata, neededDuration) {
        if (!metadata || !metadata.duration) {
            // No metadata — skip a fixed 15s to avoid most intros
            return 15;
        }

        const totalDuration = metadata.duration;

        // Very short video (< 30s) — don't skip, it's already concise
        if (totalDuration < 30) {
            return 0;
        }

        // Short video (30-60s) — skip just a few seconds
        if (totalDuration < 60) {
            return Math.min(5, Math.floor(totalDuration * 0.1));
        }

        // Try chapter-based selection first
        if (metadata.chapters && metadata.chapters.length > 1) {
            const startTime = this._pickChapterStartTime(metadata.chapters, neededDuration, totalDuration);
            if (startTime !== null) {
                return startTime;
            }
        }

        // No usable chapters — skip intro percentage
        // Skip 15-20% of video, minimum 10s, maximum 90s
        const skipPercent = 0.15;
        let skipSeconds = Math.floor(totalDuration * skipPercent);
        skipSeconds = Math.max(10, Math.min(skipSeconds, 90));

        // Make sure we don't overshoot — leave room for our clip
        const maxStart = totalDuration - neededDuration - 2;
        if (maxStart <= 0) return 0;

        return Math.min(skipSeconds, maxStart);
    }

    /**
     * Pick the best chapter start time, skipping intro/outro chapters.
     */
    _pickChapterStartTime(chapters, neededDuration, totalDuration) {
        // Find content chapters (not intro/outro)
        const contentChapters = chapters.filter(ch => {
            const title = (ch.title || '').toLowerCase();
            for (const pattern of SKIP_CHAPTER_PATTERNS) {
                if (title.includes(pattern)) return false;
            }
            return true;
        });

        if (contentChapters.length === 0) return null;

        // Pick the first content chapter that's long enough for our clip
        for (const ch of contentChapters) {
            const chStart = ch.start_time || 0;
            const chEnd = ch.end_time || totalDuration;
            const chDuration = chEnd - chStart;

            if (chDuration >= neededDuration) {
                // Start a few seconds into the chapter (skip chapter title cards)
                const offset = Math.min(3, Math.floor(chDuration * 0.1));
                const startTime = chStart + offset;
                // Ensure we have room
                if (startTime + neededDuration <= totalDuration) {
                    console.log(`  [YouTube] Using chapter "${ch.title}" starting at ${Math.round(startTime)}s`);
                    return Math.floor(startTime);
                }
            }
        }

        // No chapter long enough, just use the first content chapter's start
        const first = contentChapters[0];
        const startTime = first.start_time || 0;
        if (startTime + neededDuration <= totalDuration) {
            console.log(`  [YouTube] Using chapter "${first.title}" starting at ${Math.round(startTime)}s`);
            return Math.floor(startTime);
        }

        return null;
    }

    /**
     * Resolve the direct stream URL for a YouTube video using yt-dlp.
     * Returns the URL that ffmpeg can seek into directly (no full download needed).
     */
    async _resolveStreamUrl(url) {
        return new Promise((resolve, reject) => {
            const args = [
                url,
                '-f', 'worst[ext=mp4]/worst[vcodec!=none]/worstvideo/worst',
                '--get-url',
                '--no-playlist',
                '--no-warnings',
                '--no-check-certificates',
            ];

            execFile(this._ytdlpPath, args, {
                timeout: 20000,
                windowsHide: true,
            }, (error, stdout) => {
                if (error) return reject(error);
                const streamUrl = stdout.trim().split('\n')[0];
                if (!streamUrl || !streamUrl.startsWith('http')) {
                    return reject(new Error('No valid stream URL returned'));
                }
                resolve(streamUrl);
            });
        });
    }

    /**
     * Find the best segment of a video by sampling frames and scoring with vision AI.
     * Resolves YouTube stream URL first, then delegates to shared smart-segment module.
     * @returns {number|null} best start time in seconds, or null if analysis fails
     */
    async _findBestSegment(url, keyword, metadata, neededDuration, context = {}) {
        const totalDuration = metadata.duration;
        if (totalDuration < 60) return null; // Too short, heuristic is fine

        // Resolve direct stream URL so smart-segment can seek without full download
        let streamUrl;
        try {
            console.log(`  [YouTube] Resolving stream URL for frame sampling...`);
            streamUrl = await this._resolveStreamUrl(url);
        } catch (e) {
            console.log(`  [YouTube] Could not resolve stream URL: ${e.message}, using heuristic`);
            return null;
        }

        // Delegate to shared smart-segment module
        return selectBestSegment(streamUrl, {
            neededDuration,
            keyword,
            context,
            totalDuration,
            numSamples: 6,       // YouTube: more samples (longer videos)
            batchSize: 3,
            minDuration: 60,     // YouTube: only score 60s+ videos
            providerTag: 'YouTube',
        });
    }

    async search(keyword) {
        const queries = this._buildSearchQueries(keyword);

        for (const query of queries) {
            // Try YouTube Data API v3 first (if API key available)
            if (config.youtube?.apiKey) {
                try {
                    const results = await this._searchAPI(query);
                    const filtered = this._filterByTitle(results);
                    if (filtered.length > 0) return filtered;
                } catch (error) {
                    console.log(`  [YouTube] API search failed for "${query}": ${error.message}`);
                }
            }

            // Fallback: yt-dlp search (no API key needed)
            try {
                const results = await this._searchYtdlp(query);
                const filtered = this._filterByTitle(results);
                if (filtered.length > 0) return filtered;
            } catch (error) {
                console.log(`  [YouTube] yt-dlp search failed for "${query}": ${error.message}`);
            }

            console.log(`  [YouTube] No good results for "${query}", trying next query...`);
        }

        return [];
    }

    async _searchAPI(keyword) {
        const params = {
            part: 'snippet',
            type: 'video',
            q: keyword,
            key: config.youtube.apiKey,
            maxResults: 10,
            videoEmbeddable: 'true',
            order: 'relevance',
        };

        if (config.youtube?.creativeCommonsOnly) {
            params.videoLicense = 'creativeCommon';
        }

        const response = await axios.get(
            'https://www.googleapis.com/youtube/v3/search',
            { params, timeout: 15000 }
        );

        if (!response.data.items || response.data.items.length === 0) {
            return [];
        }

        const items = response.data.items;

        // Fetch view counts for quality-based sorting (1 extra API call)
        let viewCounts = {};
        try {
            const ids = items.map(i => i.id.videoId).join(',');
            const statsResponse = await axios.get(
                'https://www.googleapis.com/youtube/v3/videos',
                {
                    params: { part: 'statistics', id: ids, key: config.youtube.apiKey },
                    timeout: 10000
                }
            );
            for (const vid of (statsResponse.data.items || [])) {
                viewCounts[vid.id] = parseInt(vid.statistics.viewCount || '0');
            }
        } catch (e) {
            // Non-critical — continue without view counts
        }

        return items
            .map(item => ({
                id: item.id.videoId,
                url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
                title: item.snippet.title,
                width: 1920,
                height: 1080,
                viewCount: viewCounts[item.id.videoId] || 0,
            }))
            .sort((a, b) => b.viewCount - a.viewCount); // Prefer higher view count
    }

    async _searchYtdlp(keyword) {
        return new Promise((resolve) => {
            const args = [
                `ytsearch10:${keyword}`,
                '--get-id',
                '--get-title',
                '--no-download',
                '--no-warnings',
                '--flat-playlist',
            ];

            // Try with duration filter (newer yt-dlp versions)
            // 60s minimum to avoid Shorts/intros, 600s max (10 min)
            args.push('--match-filter', 'duration > 10 & duration < 600');

            execFile(this._ytdlpPath, args, {
                timeout: 30000,
                windowsHide: true,
            }, (error, stdout) => {
                if (error) {
                    // If --match-filter caused error, retry without it
                    if (error.message && error.message.includes('match-filter')) {
                        const fallbackArgs = args.filter(a => a !== '--match-filter' && a !== 'duration > 10 & duration < 600');
                        return execFile(this._ytdlpPath, fallbackArgs, {
                            timeout: 30000,
                            windowsHide: true,
                        }, (err2, stdout2) => {
                            if (err2) return resolve([]);
                            resolve(this._parseYtdlpOutput(stdout2));
                        });
                    }
                    console.log(`  [YouTube] yt-dlp search error: ${error.message}`);
                    return resolve([]);
                }

                resolve(this._parseYtdlpOutput(stdout));
            });
        });
    }

    /**
     * Parse yt-dlp search output (alternating title/id lines)
     */
    _parseYtdlpOutput(stdout) {
        const lines = stdout.trim().split('\n').filter(l => l.trim());
        const results = [];
        // yt-dlp outputs alternating: title, id, title, id, ...
        for (let i = 0; i < lines.length - 1; i += 2) {
            const title = lines[i].trim();
            const videoId = lines[i + 1].trim();
            if (videoId && videoId.length === 11) {
                results.push({
                    id: videoId,
                    url: `https://www.youtube.com/watch?v=${videoId}`,
                    title: title,
                    width: 1920,
                    height: 1080,
                });
            }
        }
        return results;
    }

    async download(url, outputPath, options = {}) {
        const duration = options.duration || 10;
        const downloadDuration = Math.ceil(duration) + 2;
        const maxHeight = config.youtube?.maxHeight || 720;
        const keyword = options.keyword || '';

        // Fetch metadata to find the best start time (skip intros/logos)
        console.log(`  [YouTube] Fetching metadata for smart clip selection...`);
        const metadata = await this._getVideoMetadata(url);

        // Reject vertical videos (Shorts, phone recordings) — unusable on 1920x1080 canvas
        if (metadata && metadata.width && metadata.height && metadata.height > metadata.width) {
            console.log(`  [YouTube] Rejecting vertical video (${metadata.width}x${metadata.height})`);
            throw new Error('Vertical video (portrait aspect ratio)');
        }

        let startTime = null;

        // Try vision-based segment selection (most accurate)
        if (keyword && metadata && metadata.duration >= 60) {
            startTime = await this._findBestSegment(url, keyword, metadata, downloadDuration, { sceneText: options.sceneText || '', niche: options.niche || '', videoTopic: options.videoTopic || '' });
        }

        // Fall back to chapter/percentage-based heuristic
        if (startTime === null) {
            startTime = this._calculateBestStartTime(metadata, downloadDuration);
        }

        const endTime = startTime + downloadDuration;

        if (metadata) {
            console.log(`  [YouTube] Video duration: ${Math.round(metadata.duration)}s → Extracting ${startTime}s-${endTime}s`);
        }

        const args = [
            url,
            '-f', `bestvideo[height<=${maxHeight}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${maxHeight}][ext=mp4]/best[height<=${maxHeight}]`,
            '--download-sections', `*${startTime}-${endTime}`,
            '--merge-output-format', 'mp4',
            '--no-playlist',
            '--no-warnings',
            '--no-check-certificates',
            '-o', outputPath,
            '--force-overwrites',
            '--max-filesize', '50M',
        ];

        // Use ffmpeg-static if available (so yt-dlp can merge streams)
        try {
            const ffmpegPath = require('ffmpeg-static');
            if (ffmpegPath) {
                args.push('--ffmpeg-location', path.dirname(ffmpegPath));
            }
        } catch (e) {
            // ffmpeg-static not available, rely on system ffmpeg
        }

        return new Promise((resolve, reject) => {
            console.log(`  [YouTube] Downloading ${downloadDuration}s clip from ${url} [${startTime}s-${endTime}s]`);

            execFile(this._ytdlpPath, args, {
                timeout: 120000,
                windowsHide: true,
            }, (error) => {
                if (error) {
                    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
                    return reject(new Error(`yt-dlp download failed: ${error.message}`));
                }

                // yt-dlp --download-sections may append section suffix to filename
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

                console.log(`  [YouTube] Downloaded: ${path.basename(outputPath)} (from ${startTime}s)`);
                resolve(outputPath);
            });
        });
    }
}

module.exports = YouTubeVideoProvider;
