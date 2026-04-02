const { execFile, execFileSync } = require('child_process');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const { callAI } = require('../ai-provider');
const BaseProvider = require('./base-provider');

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
];

// ─── Curated Telegram channels per niche ───────────────────────────────
// ─── Channel registry: { id, lang } ─────────────────────────────────
// lang: 'en' = English, 'ar' = Arabic, etc. Used to translate search queries.
const CHANNEL = (id, lang = 'en') => ({ id, lang });

const NICHE_CHANNELS = {
    _default: [
        CHANNEL('Arabmiltary', 'ar'),
    ],
    news: [
        CHANNEL('Arabmiltary', 'ar'),
    ],
    politics: [
        CHANNEL('Arabmiltary', 'ar'),
        CHANNEL('RoaaMedia', 'ar'),
        CHANNEL('NewsWorld_23'),
    ],
    celebrity: [],
    economy: [],
    tech: [],
    finance: [],
    business: [],
    crime: [],
    military: [
        CHANNEL('Arabmiltary', 'ar'),
        CHANNEL('RoaaMedia', 'ar'),
        CHANNEL('NewsWorld_23'),
    ],
    war: [
        CHANNEL('Arabmiltary', 'ar'),
    ],
    nature: [],
    sports: [],
    documentary: [],
    history: [],
    entertainment: [],
};

// Title patterns to reject (non-footage)
const REJECT_PATTERNS = [
    'podcast', 'live stream', 'asmr', 'giveaway', 'subscribe',
    'join channel', 'forward from',
];

class TelegramVideoProvider extends BaseProvider {
    constructor() {
        super('Telegram Videos', 'video');
        this._ytdlpPath = null;
        this._ytdlpChecked = false;
        this._ytdlpAvailable = false;
        this._scriptContext = null;
        this._requestCount = 0;
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
                    console.log(`  [Telegram] yt-dlp found: ${candidate}`);
                    break;
                } catch (e) { /* try next */ }
            }

            if (!this._ytdlpAvailable) {
                console.log('  [Telegram] yt-dlp not found — direct embed scraping will be used');
            }
        }
        // Always available: embed scraping fallback works without yt-dlp
        return true;
    }

    /**
     * Get channels to search based on niche/theme context.
     */
    _getChannels() {
        const rawNiche = (this._scriptContext?.nicheId || this._scriptContext?.theme || '').toLowerCase();
        // nicheId uses dot notation (e.g. "news.politics") — try full match, then sub-niche, then prefix
        const channels = NICHE_CHANNELS[rawNiche]
            || NICHE_CHANNELS[rawNiche.split('.').pop()]   // "news.politics" → "politics"
            || NICHE_CHANNELS[rawNiche.split('.')[0]]      // "news.politics" → "news" (would need entry)
            || NICHE_CHANNELS._default;
        return channels;
    }

    /**
     * Simplify keyword for Telegram's basic text search.
     * Telegram ?q= does simple word matching — long phrases fail.
     * Strategy: try full keyword first, then progressively simpler queries.
     * Returns array of queries to try (most specific first).
     */
    /**
     * AI-powered: generate optimal Telegram search queries from scene keyword + context.
     * Generates queries per language (English + any other languages needed).
     * Returns Map<lang, string[]> — e.g. { en: ["Hormuz Strait", ...], ar: ["مضيق هرمز", ...] }
     */
    async _getSearchQueries(keyword, languages) {
        const uniqueLangs = [...new Set(languages)];

        const langNames = { en: 'English', ar: 'Arabic', ru: 'Russian', fr: 'French', es: 'Spanish', de: 'German', tr: 'Turkish', fa: 'Persian', zh: 'Chinese', pt: 'Portuguese', hi: 'Hindi' };
        const langBlock = uniqueLangs.map(l => `- ${langNames[l] || l}: 3 queries`).join('\n');

        // Topic anchoring — inject video topic to keep searches on-topic
        // Without this, searching "oil pipeline" in a military channel returns random war footage
        const videoTopic = this._scriptContext?.summary || '';
        const topicAnchor = videoTopic ? `\nVIDEO TOPIC: "${videoTopic}"\nIMPORTANT: All queries MUST stay relevant to this specific topic. Include the key subject/country/entity in at least the first query to avoid getting unrelated results.` : '';

        try {
            const prompt = `Translate this keyword into ${langBlock} for Telegram search. Generate 3 queries that get PROGRESSIVELY SHORTER.

Keyword: "${keyword}"${topicAnchor}

RULES:
- Query 1: 2-3 words (core concept + topic anchor — e.g. country or key entity)
- Query 2: 2 words (the core concept)
- Query 3: 1 single word (the most important noun from the keyword, NOT a generic word)
- Keep queries ON-TOPIC — if the video is about Saudi oil, don't let queries drift to generic "oil" or "war"
- Native spelling, not transliteration
- NO dates, NO "footage/news/video" filler words
- Example: keyword "Iran-Iraq War tanker attacks" (topic: Saudi oil pipeline) →
  حرب الناقلات إيران
  حرب الناقلات
  الناقلات

Reply ONLY with the queries, one per line.`;

            const raw = await callAI(prompt, { maxTokens: 150, temperature: 0.3 });
            if (raw) {
                console.log(`  [Telegram] AI raw: ${raw.trim().replace(/\n/g, ' | ')}`);
                const result = new Map();
                let currentLang = null;
                for (const line of raw.trim().split('\n')) {
                    const trimmed = line.trim();
                    // Match [en], [ar], etc — flexible: allow spaces, brackets
                    const langMatch = trimmed.match(/^\[?\s*(\w{2,3})\s*\]?\s*:?\s*$/);
                    if (langMatch && langNames[langMatch[1]]) {
                        currentLang = langMatch[1];
                        result.set(currentLang, []);
                        continue;
                    }
                    if (currentLang) {
                        const clean = trimmed.replace(/^[\d\.\-\*\)]+\s*/, '').replace(/["']/g, '').trim();
                        if (clean.length > 1 && clean.length < 50 && !clean.startsWith('[')) {
                            result.get(currentLang).push(clean);
                        }
                    }
                }
                // If AI didn't follow format, try to split into langs by heuristic
                if (result.size === 0) {
                    // Treat all lines as English, but check for Arabic chars
                    const lines = raw.trim().split('\n')
                        .map(l => l.replace(/^[\d\.\-\*\)]+\s*/, '').replace(/["']/g, '').trim())
                        .filter(l => l.length > 1 && l.length < 50);
                    for (const lang of uniqueLangs) {
                        if (lang === 'ar') {
                            const arLines = lines.filter(l => /[\u0600-\u06FF]/.test(l));
                            if (arLines.length > 0) result.set('ar', arLines.slice(0, 3));
                        } else {
                            const enLines = lines.filter(l => !/[\u0600-\u06FF]/.test(l));
                            if (enLines.length > 0) result.set(lang, enLines.slice(0, 3));
                        }
                    }
                }
                // Ensure English queries always exist (AI may skip translating English→English)
                if (uniqueLangs.includes('en') && (!result.has('en') || result.get('en').length === 0)) {
                    result.set('en', this._fallbackQueries(keyword));
                }
                // Log what AI generated
                for (const [lang, queries] of result) {
                    if (queries.length > 0) {
                        console.log(`  [Telegram] AI queries (${lang}): ${queries.join(' | ')}`);
                    }
                }
                if (result.size > 0) return result;
            }
        } catch (e) {
            console.log(`  [Telegram] AI query generation failed: ${e.message}`);
        }

        // Fallback: English-only basic extraction
        const fallback = new Map();
        const fb = this._fallbackQueries(keyword);
        for (const lang of uniqueLangs) {
            fallback.set(lang, fb); // same English queries for all — best we can do without AI
        }
        return fallback;
    }

    /** Basic fallback when AI is unavailable */
    _fallbackQueries(keyword) {
        const queries = [];
        const clean = keyword.replace(/\b(photo|footage|video|news|report|image|map|chart|graph)\b/gi, '').trim();
        const words = clean.split(/\s+/).filter(w => w.length > 2);
        const STOP = new Set(['the','and','for','with','from','that','this','has','have','was','were','are',
            'been','will','would','could','not','but','its','his','her','their','who','what','when','where',
            'how','why','over','into','about','after','before','against','loses','lost','wins','gets','takes',
            'makes','says','said','shows','finds','control','situation','issue','problem','impact','effect',
            'major','massive','huge','new','old','latest','recent','breaking','update','crisis','response']);
        const meaningful = words.filter(w => !STOP.has(w.toLowerCase()));
        const use = meaningful.length > 0 ? meaningful : words;

        if (use.length <= 3) queries.push(use.join(' '));
        if (use.length >= 2) queries.push(use.slice(0, 2).join(' '));
        if (use.length >= 1) {
            const proper = use.filter(w => /^[A-Z]/.test(w));
            const pool = proper.length > 0 ? proper : use;
            queries.push([...pool].sort((a, b) => b.length - a.length)[0]);
        }
        return [...new Set(queries.filter(q => q.length > 2))];
    }

    /**
     * Search Telegram public channels for videos matching keyword.
     * Uses t.me/s/channelname?q=keyword — the public web preview with search.
     * Tries progressively simpler queries if full keyword returns nothing.
     */
    async search(keyword) {
        const channelObjs = this._getChannels();
        if (channelObjs.length === 0) return [];

        // Group channels by language
        const langGroups = new Map(); // lang → [channelId, ...]
        for (const ch of channelObjs) {
            const lang = ch.lang || 'en';
            if (!langGroups.has(lang)) langGroups.set(lang, []);
            langGroups.get(lang).push(ch.id);
        }

        // AI generates queries per language (single call)
        const queryMap = await this._getSearchQueries(keyword, [...langGroups.keys()]);
        const allResults = [];

        // Search each language group with ALL its translated queries (collect diverse results)
        // IMPORTANT: every language group must be searched — don't let Arabic results skip English channels
        for (const [lang, channels] of langGroups) {
            const queries = queryMap.get(lang) || queryMap.get('en') || [];
            if (queries.length === 0) continue;

            let langResults = 0;
            for (const query of queries) {
                if (langResults >= 10) break; // per-language limit, not global

                const batchSize = 4;
                for (let i = 0; i < channels.length && langResults < 12; i += batchSize) {
                    const batch = channels.slice(i, i + batchSize);
                    const promises = batch.map(ch => this._searchChannel(ch, query).catch(() => []));
                    const batchResults = await Promise.all(promises);
                    for (const results of batchResults) {
                        allResults.push(...results);
                        langResults += results.length;
                    }
                }

                if (langResults > 0) {
                    console.log(`  [Telegram] Query "${query}" found ${langResults} results (${lang})`);
                }
            }
        }

        // Deduplicate by post ID
        const seen = new Set();
        const unique = allResults.filter(r => {
            if (seen.has(r.id)) return false;
            seen.add(r.id);
            return true;
        });

        // Skip title relevance filter — Telegram's own ?q= search already filtered,
        // and translated queries mean English keyword won't match Arabic post titles.
        const relevant = unique;

        // Apply reject patterns
        const filtered = relevant.filter(r => {
            const lower = (r.title || '').toLowerCase();
            return !REJECT_PATTERNS.some(p => lower.includes(p));
        });

        if (filtered.length > 0) {
            console.log(`  [Telegram] ${filtered.length} videos found for "${keyword}" across ${channelObjs.length} channels`);
        } else {
            console.log(`  [Telegram] No videos for "${keyword}" (searched ${channelObjs.length} channels)`);
        }

        return filtered.slice(0, 10);
    }

    /**
     * Search a single Telegram channel's public web preview.
     * Parses the HTML for video posts matching the keyword.
     */
    async _searchChannel(channel, keyword) {
        const ua = USER_AGENTS[this._requestCount++ % USER_AGENTS.length];
        const url = `https://t.me/s/${channel}?q=${encodeURIComponent(keyword)}`;

        let html;
        try {
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': ua,
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'en-US,en;q=0.9',
                },
                timeout: 12000,
                maxRedirects: 3,
            });
            html = response.data;
        } catch (e) {
            return [];
        }

        if (!html || html.length < 500) return [];

        // Only consider posts that ACTUALLY have a video player element
        // The key class is "tgme_widget_message_video_player" — this is only on real video posts
        if (!html.includes('tgme_widget_message_video_player')) return [];

        const results = [];

        // Split HTML into message blocks by data-post attribute
        // Each message starts with data-post="channel/id"
        const postRe = /data-post="([^"]+)"/g;
        const postPositions = [];
        let pm;
        while ((pm = postRe.exec(html)) !== null) {
            postPositions.push({ dataPost: pm[1], index: pm.index });
        }

        for (let i = 0; i < postPositions.length; i++) {
            const { dataPost, index: startIdx } = postPositions[i];
            const endIdx = i + 1 < postPositions.length ? postPositions[i + 1].index : html.length;
            const block = html.substring(startIdx, endIdx);

            // STRICT check: must contain the actual video player class
            if (!block.includes('tgme_widget_message_video_player')) continue;

            const [ch, postId] = dataPost.split('/');
            if (!postId) continue;

            // Extract post text
            const textMatch = block.match(/tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/);
            const postText = textMatch ? textMatch[1].replace(/<[^>]+>/g, '').trim() : '';

            results.push({
                id: `tg-${ch}-${postId}`,
                url: `https://t.me/${ch}/${postId}`,
                title: postText.substring(0, 200),
                width: 1920,
                height: 1080,
                _channel: ch,
                _postId: postId,
            });

            if (results.length >= 5) break;
        }

        if (results.length > 0) {
            console.log(`  [Telegram] ${channel}: ${results.length} video posts for "${keyword}"`);
        }

        return results;
    }

    // Resolve direct stream URL (for smart trim frame extraction)
    async getStreamUrl(url) {
        if (!this._ytdlpPath) return null;
        try {
            const args = [url, '--get-url', '-f', 'bestvideo[height<=720][ext=mp4]/best[height<=720][ext=mp4]/best[height<=720]', '--no-playlist', '--no-warnings', '--no-check-certificates'];
            const result = execFileSync(this._ytdlpPath, args, { timeout: 15000, windowsHide: true, encoding: 'utf8' });
            const streamUrl = (result || '').trim().split('\n')[0];
            if (streamUrl && streamUrl.startsWith('http')) return streamUrl;
        } catch (e) {
            console.log(`  [Telegram] getStreamUrl failed: ${e.message?.substring(0, 80)}`);
        }
        return null;
    }

    /**
     * Download a Telegram video via yt-dlp, with direct embed scraping fallback.
     */
    async download(url, outputPath, options = {}) {
        const duration = options.duration || 10;
        const maxHeight = config.youtube?.maxHeight || 720;

        // First get metadata — if yt-dlp can't even parse the post, skip immediately
        const metadata = await this._getVideoMetadata(url);

        if (!metadata) {
            // yt-dlp failed to get metadata — try direct embed scraping immediately
            console.log(`  [Telegram] yt-dlp metadata failed, trying direct embed scraping...`);
            return this._downloadViaEmbed(url, outputPath, duration);
        }

        // Reject vertical videos
        if (metadata.width && metadata.height && metadata.height > metadata.width) {
            console.log(`  [Telegram] Rejecting vertical video (${metadata.width}x${metadata.height})`);
            throw new Error('Vertical video (portrait aspect ratio)');
        }
        // Reject very short clips (< 3s)
        if (metadata.duration && metadata.duration < 3) {
            console.log(`  [Telegram] Rejecting too-short clip (${metadata.duration}s)`);
            throw new Error('Video too short (< 3s)');
        }

        const videoDuration = metadata?.duration || 30;
        const neededDuration = Math.ceil(duration) + 2;

        // Use Omni smart trim if available, otherwise dumb heuristic
        let startTime = 0;
        if (options._smartStartTime != null && options._smartStartTime >= 0) {
            startTime = options._smartStartTime;
            console.log(`  🎯 [Telegram] Using Omni smart trim start: ${Math.round(startTime)}s (video ${Math.round(videoDuration)}s)`);
        } else if (videoDuration > neededDuration + 5) {
            startTime = Math.min(5, Math.floor(videoDuration * 0.1));
            console.log(`  📐 [Telegram] Using dumb trim start: ${startTime}s (no smart trim available)`);
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

        // Trim if video is longer than needed
        if (videoDuration > neededDuration + 3) {
            const endTime = startTime + neededDuration;
            args.push('--download-sections', `*${startTime}-${endTime}`);
            console.log(`  [Telegram] Trimming to ${startTime}s-${endTime}s (video is ${Math.round(videoDuration)}s)`);
        }

        // Use ffmpeg-static if available
        try {
            const ffmpegPath = require('ffmpeg-static');
            if (ffmpegPath) {
                args.push('--ffmpeg-location', path.dirname(ffmpegPath));
            }
        } catch (e) { /* rely on system ffmpeg */ }

        try {
            const result = await new Promise((resolve, reject) => {
                // Clean up stale .part files from previous failed downloads
                try { if (fs.existsSync(outputPath + '.part')) fs.unlinkSync(outputPath + '.part'); } catch (e) {}
                try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}

                console.log(`  [Telegram] Downloading from ${url}`);

                execFile(this._ytdlpPath, args, {
                    timeout: 120000,
                    windowsHide: true,
                }, (error) => {
                    if (error) {
                        try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
                        try { if (fs.existsSync(outputPath + '.part')) fs.unlinkSync(outputPath + '.part'); } catch (e) {}
                        return reject(new Error(`yt-dlp download failed: ${error.message}`));
                    }

                    // yt-dlp --download-sections may append section suffix
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

                    console.log(`  [Telegram] Downloaded: ${path.basename(outputPath)}`);
                    resolve(outputPath);
                });
            });
            return result;
        } catch (ytdlpError) {
            // yt-dlp failed — fall back to direct embed scraping immediately
            console.log(`  [Telegram] yt-dlp failed: ${ytdlpError.message}`);
            console.log(`  [Telegram] Falling back to direct embed scraping...`);
            return this._downloadViaEmbed(url, outputPath, duration);
        }
    }

    // ─── Direct Embed Scraping Fallback ─────────────────────────────────

    /**
     * Scrape the Telegram embed page to extract the direct video URL,
     * then download using ffmpeg (with trim) or axios (full file).
     * This works when yt-dlp fails (blocked, broken extractor, etc.)
     *
     * Telegram embeds have: <video src="https://cdn4.telesco.pe/file/HASH.mp4?token=TOKEN">
     * and duration in: <time class="message_video_duration ...">M:SS</time>
     */
    async _downloadViaEmbed(url, outputPath, neededDuration) {
        // Parse channel/postId from URL: https://t.me/channel/12345
        const urlMatch = url.match(/t\.me\/([^/]+)\/(\d+)/);
        if (!urlMatch) throw new Error('Cannot parse Telegram URL');

        const [, channel, postId] = urlMatch;
        const embedUrl = `https://t.me/${channel}/${postId}?embed=1&mode=tme`;

        console.log(`  [Telegram] Fetching embed page: ${embedUrl}`);

        const ua = USER_AGENTS[this._requestCount++ % USER_AGENTS.length];
        let html;
        try {
            const response = await axios.get(embedUrl, {
                headers: {
                    'User-Agent': ua,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Referer': `https://t.me/${channel}/${postId}`,
                },
                timeout: 15000,
                maxRedirects: 3,
            });
            html = response.data;
        } catch (e) {
            throw new Error(`Embed page fetch failed: ${e.message}`);
        }

        if (!html || typeof html !== 'string') {
            throw new Error('Empty embed page response');
        }

        // Extract direct video URL from <video src="...">
        const videoMatch = html.match(/<video[^>]+src=["']([^"']+)["']/i);
        if (!videoMatch) {
            throw new Error('No <video src> found in embed page');
        }
        const videoUrl = videoMatch[1];
        console.log(`  [Telegram] Found direct video URL: ${videoUrl.substring(0, 100)}...`);

        // Extract duration from <time class="message_video_duration ...">M:SS</time>
        let videoDuration = 30; // default fallback
        const durationMatch = html.match(/<time[^>]*message_video_duration[^>]*>([^<]+)<\/time>/i);
        if (durationMatch) {
            const timeStr = durationMatch[1].trim();
            const parts = timeStr.split(':').map(Number);
            if (parts.length === 2) {
                videoDuration = parts[0] * 60 + parts[1];
            } else if (parts.length === 3) {
                videoDuration = parts[0] * 3600 + parts[1] * 60 + parts[2];
            } else if (parts.length === 1 && !isNaN(parts[0])) {
                videoDuration = parts[0];
            }
            console.log(`  [Telegram] Video duration: ${videoDuration}s`);
        }

        // Detect aspect ratio from style (width:NNNpx;padding-top:NN.NN%)
        // padding-top percentage = height/width * 100
        const styleMatch = html.match(/tgme_widget_message_video_wrap[^>]+style="[^"]*width:\s*(\d+)px[^"]*padding-top:\s*([\d.]+)%/i);
        if (styleMatch) {
            const cssWidth = parseInt(styleMatch[1]);
            const paddingPct = parseFloat(styleMatch[2]);
            const aspectHeight = Math.round(cssWidth * paddingPct / 100);
            // Check for vertical (portrait)
            if (aspectHeight > cssWidth) {
                console.log(`  [Telegram] Rejecting vertical video (aspect ${cssWidth}x${aspectHeight})`);
                throw new Error('Vertical video (portrait aspect ratio)');
            }
        }

        // Reject very short clips
        if (videoDuration < 3) {
            throw new Error('Video too short (< 3s)');
        }

        const clipDuration = Math.ceil(neededDuration) + 2;

        // Use Omni smart trim if available, otherwise dumb heuristic
        let startTime = 0;
        if (options._smartStartTime != null && options._smartStartTime >= 0) {
            startTime = options._smartStartTime;
            console.log(`  🎯 [Telegram] Direct path: using Omni smart trim start: ${Math.round(startTime)}s`);
        } else if (videoDuration > clipDuration + 5) {
            startTime = Math.min(5, Math.floor(videoDuration * 0.1));
            console.log(`  📐 [Telegram] Direct path: using dumb trim start: ${startTime}s`);
        }

        // Download with ffmpeg (preferred — supports seeking/trimming from remote URL)
        let ffmpegPath = null;
        try { ffmpegPath = require('ffmpeg-static'); } catch (e) {}
        if (!ffmpegPath) {
            ffmpegPath = process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg';
        }

        // Try ffmpeg with seek + trim
        try {
            await new Promise((resolve, reject) => {
                const ffArgs = [
                    '-ss', String(startTime),
                    '-i', videoUrl,
                    '-t', String(clipDuration),
                    '-c', 'copy',
                    '-y',
                    outputPath,
                ];
                console.log(`  [Telegram] Direct download via ffmpeg (${startTime}s-${startTime + clipDuration}s)...`);

                execFile(ffmpegPath, ffArgs, {
                    timeout: 60000,
                    windowsHide: true,
                }, (error) => {
                    if (error) return reject(error);
                    resolve();
                });
            });

            if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
                console.log(`  [Telegram] Downloaded (direct): ${path.basename(outputPath)}`);
                return outputPath;
            }
        } catch (ffErr) {
            console.log(`  [Telegram] ffmpeg with seek failed: ${ffErr.message}, retrying without seek...`);
        }

        // Retry ffmpeg without -ss (some CDN URLs don't support seeking)
        try {
            await new Promise((resolve, reject) => {
                const ffArgs = [
                    '-i', videoUrl,
                    '-t', String(clipDuration + 5),
                    '-c', 'copy',
                    '-y',
                    outputPath,
                ];
                execFile(ffmpegPath, ffArgs, {
                    timeout: 60000,
                    windowsHide: true,
                }, (error) => {
                    if (error) return reject(error);
                    resolve();
                });
            });

            if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
                console.log(`  [Telegram] Downloaded (direct, no seek): ${path.basename(outputPath)}`);
                return outputPath;
            }
        } catch (ffErr2) {
            console.log(`  [Telegram] ffmpeg download failed: ${ffErr2.message}, trying axios...`);
        }

        // Last resort: download full file with axios
        const response = await axios.get(videoUrl, {
            responseType: 'stream',
            timeout: 60000,
            maxContentLength: 50 * 1024 * 1024,
            headers: {
                'User-Agent': ua,
                'Referer': embedUrl,
            },
        });

        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size < 1000) {
                    return reject(new Error('Downloaded file too small'));
                }
                console.log(`  [Telegram] Downloaded (axios): ${path.basename(outputPath)}`);
                resolve(outputPath);
            });
            writer.on('error', reject);
        });
    }

    /**
     * Get video metadata via yt-dlp --dump-json.
     * Returns null if yt-dlp is not available — caller falls back to embed scraping.
     */
    async _getVideoMetadata(url) {
        if (!this._ytdlpPath) return null; // yt-dlp not available, skip to embed fallback

        return new Promise((resolve) => {
            const args = [
                url,
                '--dump-json',
                '--no-download',
                '--no-warnings',
                '--no-check-certificates',
            ];

            execFile(this._ytdlpPath, args, {
                timeout: 25000,
                windowsHide: true,
                maxBuffer: 5 * 1024 * 1024,
            }, (error, stdout) => {
                if (error) return resolve(null);
                try {
                    const data = JSON.parse(stdout);
                    return resolve({
                        duration: data.duration || 0,
                        title: data.title || data.description || '',
                        width: data.width || 0,
                        height: data.height || 0,
                    });
                } catch (e) {
                    return resolve(null);
                }
            });
        });
    }
}

module.exports = TelegramVideoProvider;
