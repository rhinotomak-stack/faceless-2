const { execFile, execFileSync } = require('child_process');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const config = require('../config');
const BaseProvider = require('./base-provider');

// ─── VK Video Provider ──────────────────────────────────────────────
// Uses VK API for search + yt-dlp for download.
// Requires VK_ACCESS_TOKEN in .env (user token with video scope).

const VK_API_URL = 'https://api.vk.com/method';
const VK_API_VERSION = '5.199';

const REJECT_TITLE_PATTERNS = [
    'podcast', 'live stream', 'прямой эфир', 'стрим',
    'reaction', 'реакция', 'asmr', 'giveaway',
    '#shorts', 'interview', 'интервью',
];

class VKVideoProvider extends BaseProvider {
    constructor() {
        super('VK Video', 'video');
        this._ytdlpPath = null;
        this._ytdlpChecked = false;
        this._ytdlpAvailable = false;
        this._scriptContext = null;
        this._requestCount = 0;
        this._tokenExpired = false;
    }

    setContext(scriptContext) {
        this._scriptContext = scriptContext;
    }

    isAvailable() {
        if (this._tokenExpired) return false;

        const token = process.env.VK_ACCESS_TOKEN;
        if (!token) {
            if (!this._warnedNoToken) {
                console.log('  [VK Video] VK_ACCESS_TOKEN not set — provider disabled');
                this._warnedNoToken = true;
            }
            return false;
        }

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
                        windowsHide: true,
                    });
                    this._ytdlpPath = candidate;
                    this._ytdlpAvailable = true;
                    console.log(`  [VK Video] yt-dlp found: ${candidate}`);
                    break;
                } catch (e) {}
            }

            if (!this._ytdlpAvailable) {
                console.log('  [VK Video] yt-dlp not found — download disabled');
            }
        }
        return this._ytdlpAvailable;
    }

    // ─── Token validation (called once per build) ─────────────────────

    async _validateToken() {
        if (this._tokenValidated) return this._tokenValid;
        this._tokenValidated = true;
        this._tokenValid = false;

        const token = process.env.VK_ACCESS_TOKEN;
        if (!token) return false;

        try {
            const resp = await axios.get(`${VK_API_URL}/users.get`, {
                params: { access_token: token, v: VK_API_VERSION },
                timeout: 8000,
            });
            if (resp.data.error) {
                const code = resp.data.error.error_code;
                if (code === 5) {
                    this._tokenExpired = true;
                    console.log('  [VK Video] Token expired — run "npm run vk-token" to refresh');
                    return false;
                }
            }
            this._tokenValid = true;
            return true;
        } catch (e) {
            // Network error — don't disable, let search try
            this._tokenValid = true;
            return true;
        }
    }

    // ─── Search ──────────────────────────────────────────────────────

    async search(keyword) {
        const token = process.env.VK_ACCESS_TOKEN;
        if (!token) return [];

        // Quick token check on first call
        if (!this._tokenValidated) {
            const valid = await this._validateToken();
            if (!valid) return [];
        }

        // Simplify keyword: first 5 meaningful words
        let simpleKw = keyword.split(/\s+/).filter(w => w.length > 2).slice(0, 5).join(' ');
        // Topic anchoring — append core topic entity to short queries so VK search stays relevant
        if (this._scriptContext?.summary && simpleKw.split(/\s+/).length <= 3) {
            const topicWords = (this._scriptContext.summary || '').split(/\s+/).slice(0, 3).join(' ');
            if (topicWords && !simpleKw.toLowerCase().includes(topicWords.split(/\s+/)[0].toLowerCase())) {
                simpleKw = `${simpleKw} ${topicWords}`;
            }
        }
        console.log(`  [VK Video] Searching: "${simpleKw}"`);

        try {
            const params = {
                q: simpleKw,
                count: 30,
                sort: 2,        // by relevance
                hd: 1,          // HD quality only
                filters: 'vk',  // VK-hosted only (not YouTube embeds)
                longer: 10,     // min 10 seconds (skip ultra-short clips)
                shorter: 300,   // max 5 minutes
                adult: 0,
                access_token: token,
                v: VK_API_VERSION,
            };

            const resp = await axios.get(`${VK_API_URL}/video.search`, {
                params,
                timeout: 15000,
            });

            if (resp.data.error) {
                const errCode = resp.data.error.error_code;
                const errMsg = resp.data.error.error_msg || 'Unknown error';
                // Error 5 = token expired/invalid, Error 28 = app disabled
                if (errCode === 5 || errCode === 28) {
                    this._tokenExpired = true;
                    console.log(`  [VK Video] ⛔ Token expired or invalid (code ${errCode}): ${errMsg}`);
                    console.log(`  [VK Video] Run "node refresh-vk-token.js" to get a new permanent token`);
                    console.log(`  [VK Video] Provider disabled for remainder of this build`);
                    return [];
                }
                console.log(`  [VK Video] API error (${errCode}): ${errMsg}`);
                return [];
            }

            const items = resp.data.response?.items || [];
            if (items.length === 0) {
                console.log(`  [VK Video] No results for "${simpleKw}"`);
                return [];
            }

            const results = [];
            for (const item of items) {
                if (results.length >= 8) break;

                // Skip live streams
                if (item.live || item.upcoming) continue;

                // Skip by title patterns
                const title = (item.title || '').toLowerCase();
                if (REJECT_TITLE_PATTERNS.some(p => title.includes(p))) continue;

                // Skip vertical (if dimensions available)
                if (item.width && item.height && item.height > item.width) continue;

                // Skip too short
                if (item.duration && item.duration < 10) continue;

                // Skip low-view junk uploads (likely irrelevant re-uploads)
                if (item.views !== undefined && item.views < 50) continue;

                const videoUrl = `https://vkvideo.ru/video${item.owner_id}_${item.id}`;

                results.push({
                    id: `vk-${item.owner_id}_${item.id}`,
                    url: videoUrl,
                    title: (item.title || '').substring(0, 200),
                    width: item.width || 1280,
                    height: item.height || 720,
                    duration: item.duration || 0,
                    thumbnail: item.photo_800 || item.photo_640 || item.photo_320 || '',
                });
            }

            if (results.length > 0) {
                console.log(`  [VK Video] Found ${results.length} videos for "${simpleKw}"`);
            } else {
                console.log(`  [VK Video] ${items.length} results but none passed filters for "${simpleKw}"`);
            }
            return results;
        } catch (e) {
            console.log(`  [VK Video] Search error: ${e.message}`);
            return [];
        }
    }

    // ─── Resolve direct stream URL (for smart trim frame extraction) ──

    async getStreamUrl(url) {
        if (!this._ytdlpPath) return null;
        try {
            const args = [url, '--get-url', '-f', 'bestvideo[height<=720][ext=mp4]/best[height<=720][ext=mp4]/best[height<=720]', '--no-playlist', '--no-warnings', '--no-check-certificates'];
            const result = execFileSync(this._ytdlpPath, args, { timeout: 15000, windowsHide: true, encoding: 'utf8' });
            const streamUrl = (result || '').trim().split('\n')[0];
            if (streamUrl && streamUrl.startsWith('http')) {
                return streamUrl;
            }
        } catch (e) {
            console.log(`  [VK Video] getStreamUrl failed: ${e.message?.substring(0, 80)}`);
        }
        return null;
    }

    // ─── Download ────────────────────────────────────────────────────

    async download(url, outputPath, options = {}) {
        const duration = options.duration || 10;
        const downloadDuration = Math.ceil(duration) + 2;
        const maxHeight = 720;

        // Get metadata for duration info
        let videoDuration = options._cachedMeta?.duration || 0;
        if (!videoDuration) {
            try {
                const meta = await this._getMetadata(url);
                if (meta) videoDuration = meta.duration;
            } catch (e) {}
        }

        // Use Omni smart trim if available, otherwise skip VK intros/watermarks
        let startTime = 3;
        if (options._smartStartTime != null && options._smartStartTime >= 0) {
            startTime = options._smartStartTime;
            console.log(`  🎯 [VK Video] Using Omni smart trim start: ${Math.round(startTime)}s (video ${Math.round(videoDuration)}s)`);
        } else if (videoDuration > downloadDuration + 15) {
            startTime = Math.max(5, Math.floor(videoDuration * 0.15));
        } else if (videoDuration > 0 && videoDuration <= downloadDuration + 5) {
            // Video barely long enough — can't skip much
            startTime = Math.min(2, Math.floor(videoDuration * 0.1));
        }
        const endTime = startTime + downloadDuration;

        if (videoDuration > 0) {
            console.log(`  [VK Video] Video duration: ${Math.round(videoDuration)}s → Extracting ${startTime}s-${endTime}s`);
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

        // Use ffmpeg-static if available
        try {
            const ffmpegPath = require('ffmpeg-static');
            if (ffmpegPath) {
                args.push('--ffmpeg-location', path.dirname(ffmpegPath));
            }
        } catch (e) {}

        return new Promise((resolve, reject) => {
            // Clean up stale .part files from previous failed downloads
            try { if (fs.existsSync(outputPath + '.part')) fs.unlinkSync(outputPath + '.part'); } catch (e) {}
            try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}

            console.log(`  [VK Video] Downloading ${downloadDuration}s clip from ${url}`);

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

                if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 1000) {
                    console.log(`  [VK Video] Downloaded: ${path.basename(outputPath)}`);
                    resolve(outputPath);
                } else {
                    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
                    reject(new Error('Download produced empty file'));
                }
            });
        });
    }

    async _getMetadata(url) {
        return new Promise((resolve) => {
            const args = [
                url,
                '--dump-json',
                '--no-download',
                '--no-playlist',
                '--no-warnings',
                '--no-check-certificates',
            ];

            execFile(this._ytdlpPath, args, {
                timeout: 30000,
                windowsHide: true,
                maxBuffer: 5 * 1024 * 1024,
            }, (error, stdout) => {
                if (error || !stdout) return resolve(null);
                try {
                    const data = JSON.parse(stdout);
                    resolve({
                        duration: data.duration || 0,
                        width: data.width || 0,
                        height: data.height || 0,
                        title: data.title || '',
                    });
                } catch (e) {
                    resolve(null);
                }
            });
        });
    }
}

module.exports = VKVideoProvider;
