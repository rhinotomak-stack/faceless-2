const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// In Electron renderer/preload context axios auto-picks the XHR adapter (XMLHttpRequest is defined),
// which returns ArrayBuffer instead of a Node.js stream — .pipe() fails and User-Agent/Referer are blocked.
// Force the Node.js http adapter so downloads always stream correctly regardless of which process calls us.
// axios v1.x accepts the adapter name as a string ('http' | 'xhr' | 'fetch').
const _HTTP_ADAPTER = 'http';

// Domains known to serve watermarked preview images
const WATERMARK_DOMAINS = [
    'shutterstock.com', 'gettyimages.com', 'istockphoto.com', 'dreamstime.com',
    '123rf.com', 'depositphotos.com', 'alamy.com', 'bigstockphoto.com',
    'stock.adobe.com', 'vectorstock.com', 'canstockphoto.com',
    'photodune.net', 'pond5.com', 'dissolve.com', 'storyblocks.com',
];

// URL path fragments indicating watermarked/preview versions
const WATERMARK_URL_PATTERNS = [
    'watermark', '/preview/', '/comp/', '/sample/', '/wm_', '/_wm',
    '/thumb/', 'stock-photo-', '/editorial-',
];

// Minimum acceptable image dimensions for 1080p video
const MIN_IMAGE_WIDTH = 800;
const MIN_IMAGE_HEIGHT = 450;

class BaseProvider {
    constructor(name, mediaType) {
        this.name = name;
        this.mediaType = mediaType; // 'video' or 'image'
        this.downloadedIds = new Set();
    }

    /**
     * Check if this provider is available (e.g., API key configured)
     * Override in subclasses
     */
    isAvailable() {
        return true;
    }

    /**
     * Search for media matching keyword
     * Override in subclasses
     * @returns {Array<{id: string, url: string, width?: number, height?: number}>}
     */
    async search(keyword) {
        return [];
    }

    /**
     * Pick first result not already downloaded (dedup by both ID and URL)
     */
    /**
     * Pick first result not already downloaded (dedup by both ID and URL).
     * @param {Array} results - search results
     * @param {Function} [isOverused] - optional callback(url) → boolean, checks global reuse count
     */
    pickUnused(results, isOverused) {
        // Pass 1: find truly unused result
        for (const result of results) {
            const urlKey = result.url ? result.url.split('?')[0] : '';
            if (!this.downloadedIds.has(result.id) && !this.downloadedIds.has(urlKey)) {
                this.downloadedIds.add(result.id);
                if (urlKey) this.downloadedIds.add(urlKey);
                return result;
            }
        }
        // Pass 2: all locally used — find one that's NOT globally overused
        if (isOverused) {
            for (const result of results) {
                const url = result._directVideoUrl || result.url;
                if (!isOverused(url)) {
                    return result;
                }
            }
        }
        // Pass 3: everything is used and overused — last resort
        if (results.length > 0) {
            console.log(`  ⚠️ [${this.name}] All results used & overused, reusing least recent`);
            return results[results.length - 1]; // pick last (least likely to be the repeated one)
        }
        return null;
    }

    /**
     * Download a file from URL to outputPath
     */
    async download(url, outputPath, opts = {}) {
        const abortSignal = opts.abortSignal || null;
        if (abortSignal?.aborted) {
            throw new Error('aborted before request');
        }
        const response = await axios({
            url,
            method: 'GET',
            responseType: 'stream',
            adapter: _HTTP_ADAPTER, // force Node.js http adapter (avoids XHR adapter in Electron renderer)
            timeout: 30000,
            signal: abortSignal || undefined,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'image/*,video/*,*/*;q=0.8',
                'Referer': 'https://www.google.com/'
            },
            maxRedirects: 5
        });

        // Check content-type — reject HTML error pages
        const contentType = response.headers['content-type'] || '';
        if (contentType.includes('text/html') || contentType.includes('application/json')) {
            throw new Error(`Server returned ${contentType} instead of media`);
        }

        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);

        // If the caller aborts mid-stream, tear the stream down and delete the partial file.
        const onAbort = () => {
            try { response.data.destroy(new Error('aborted mid-stream')); } catch (_) {}
            try { writer.destroy(new Error('aborted mid-stream')); } catch (_) {}
            try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
        };
        if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });

        return new Promise((resolve, reject) => {
            const cleanup = () => {
                if (abortSignal) abortSignal.removeEventListener('abort', onAbort);
            };
            writer.on('finish', () => {
                cleanup();
                if (abortSignal?.aborted) {
                    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
                    reject(new Error('aborted'));
                    return;
                }
                // Validate file size — reject tiny/empty files
                const stat = fs.statSync(outputPath);
                if (stat.size < 5000) {
                    fs.unlinkSync(outputPath);
                    reject(new Error(`Downloaded file too small (${stat.size} bytes), likely not a valid media file`));
                } else {
                    // Sanitize images to PNG via ffmpeg
                    const finalPath = this._sanitizeImage(outputPath);
                    resolve(finalPath);
                }
            });
            writer.on('error', (err) => { cleanup(); reject(err); });
        });
    }

    /**
     * Sanitize web images to PNG using ffmpeg.
     * Web images (especially from Google/Bing) are often WebP disguised as .jpg,
     * or have broken headers. This re-encodes everything as proper PNG.
     * Returns the final file path (may differ from input if extension changed).
     */
    _sanitizeImage(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        if (!['.jpg', '.jpeg', '.png', '.webp', '.bmp'].includes(ext)) return filePath;

        const ffmpeg = process.env.FFMPEG_PATH || (process.platform === 'win32' ? 'C:\\ffmg\\bin\\ffmpeg.exe' : 'ffmpeg');
        if (!fs.existsSync(ffmpeg)) return filePath;

        const tmpPath = filePath + '.sanitize.png';

        try {
            execSync(`"${ffmpeg}" -y -i "${filePath}" -frames:v 1 "${tmpPath}"`, {
                stdio: 'pipe', timeout: 15000
            });

            if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 1000) {
                const finalPath = filePath.replace(/\.[^.]+$/, '.png');
                fs.copyFileSync(tmpPath, finalPath);
                fs.unlinkSync(tmpPath);
                if (finalPath !== filePath && fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
                console.log(`  🔧 Sanitized to PNG: ${path.basename(finalPath)}`);
                return finalPath;
            } else {
                if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                return filePath;
            }
        } catch (e) {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
            return filePath;
        }
    }

    /**
     * Check if a URL likely points to a watermarked image from a stock site
     */
    isWatermarked(url) {
        if (!url) return false;
        const lower = url.toLowerCase();
        for (const domain of WATERMARK_DOMAINS) {
            if (lower.includes(domain)) return true;
        }
        for (const pattern of WATERMARK_URL_PATTERNS) {
            if (lower.includes(pattern)) return true;
        }
        return false;
    }

    /**
     * Check if an image result is too small for 1080p video use
     */
    isTooSmall(result) {
        if (this.mediaType !== 'image') return false;
        if (!result.width || !result.height) return false; // unknown size, let it through
        return result.width < MIN_IMAGE_WIDTH || result.height < MIN_IMAGE_HEIGHT;
    }

    /**
     * Filter out low-quality results (watermarked, too small)
     * Called by footage-manager after search()
     */
    filterResults(results) {
        return results.filter(r => {
            if (this.isWatermarked(r.url)) return false;
            if (this.isTooSmall(r)) return false;
            return true;
        });
    }

    /**
     * Reset the downloaded IDs tracker
     */
    reset() {
        this.downloadedIds.clear();
    }
}

module.exports = BaseProvider;
