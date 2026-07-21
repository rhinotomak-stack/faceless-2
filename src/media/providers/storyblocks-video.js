/**
 * Storyblocks Video Provider
 *
 * Browser-driven (Puppeteer) provider for Storyblocks stock footage.
 *
 * MODES:
 *   - PREVIEW mode (default, no subscription needed):
 *       Hits the public "Download Watermarked" CloudFront URL. Useful for
 *       validating the full automation pipeline before paying. Clips have
 *       a visible Storyblocks watermark and are 360p.
 *   - SUBSCRIBED mode (env: STORYBLOCKS_SUBSCRIBED=1):
 *       Same flow but logs in with STORYBLOCKS_EMAIL/STORYBLOCKS_PASSWORD,
 *       clicks the clean Download button, and grabs the unwatermarked URL.
 *       NOT IMPLEMENTED YET — placeholder until user subscribes.
 *
 * AUTOMATION NOTES:
 *   - Storyblocks search/clip pages are Cloudflare-protected (HTTP 202 + JS
 *     challenge). We bypass via stealth tweaks on a real Chrome process,
 *     same pattern as thumbnail-vision.js.
 *   - Search results are SSR'd in plain HTML (no __NEXT_DATA__).
 *     Selector: a[href*="/video/stock/"], deduped by href.
 *   - Watermarked download URL is unauthenticated CloudFront — we discover
 *     it by clicking the "Download Watermarked" button and intercepting the
 *     resulting .mp4 request.
 *   - Browser is lazy-initialized and idle-closed after 5min, just like
 *     thumbnail-vision.js (separate instance, intentional — keeps lifecycles
 *     independent).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createByteLimitTransform, requestSafeStream } = require('../../security/safe-download');
const BaseProvider = require('./base-provider');

const SEARCH_URL_BASE = 'https://www.storyblocks.com/all-video/search/';
const LOGIN_URL = 'https://www.storyblocks.com/login';
const SEARCH_RESULTS_TIMEOUT_MS = 90_000;
const CHALLENGE_RESOLVE_MAX_MS = 60_000;       // cold-start CF challenge can take ~30-40s
const CHALLENGE_RESOLVE_WARM_MS = 20_000;      // once warmed (cookies set), much faster
const CLIP_PAGE_TIMEOUT_MS = 60_000;
const PER_CLIP_CAPTURE_MS = 12_000;            // subscribed flow waits for click→download; preview is faster
const BROWSER_DOWNLOAD_WAIT_MS = Math.max(8_000, Math.min(240_000, parseInt(process.env.STORYBLOCKS_BROWSER_DOWNLOAD_WAIT_MS || '90000', 10) || 90_000));
// Hard wall-clock cap on a single subscribed clip-page download attempt
// (goto + CF + click capture + stream). Far below the scene budget so one
// slow clip can't blow the whole scene deadline silently.
const PER_CLIP_HARD_CAP_MS = 45_000;
const LOGIN_TIMEOUT_MS = 30_000;
const MAX_PREVIEW_CLIPS_PER_SEARCH = 6;          // preview mode cracks open clip pages
const MAX_SUBSCRIBED_RESULTS_PER_SEARCH = Math.max(12, parseInt(process.env.STORYBLOCKS_SEARCH_RESULTS || '36', 10) || 36);
const MAX_SEARCH_RESULTS_TO_CONSIDER = Math.max(36, MAX_SUBSCRIBED_RESULTS_PER_SEARCH); // matches/extends page-1 grid size
const COOKIE_FILE = process.env.STORYBLOCKS_COOKIE_FILE
    || path.join(process.cwd(), '.storyblocks-cookies.json');
const PROJECT_WORK_DIR = process.env.STORYBLOCKS_WORK_DIR
    || path.join(process.env.PROJECT_DIR ? path.resolve(process.env.PROJECT_DIR) : process.cwd(), 'temp', '.storyblocks');
const BROWSER_DOWNLOAD_DIR = path.join(PROJECT_WORK_DIR, 'downloads');
const BROWSER_PROFILE_DIR = path.join(PROJECT_WORK_DIR, 'browser-profile');
const DOWNLOAD_MANIFEST_FILE = path.join(PROJECT_WORK_DIR, 'native-downloads.json');
// The OS default Downloads folder — where Chrome leaks downloads when the CDP
// redirect doesn't take (popup/new-target downloads). We sweep Storyblocks-
// signature files out of it so nothing piles up in the user's Downloads.
const OS_DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');
// Storyblocks names its files with an unambiguous "SBV-<digits>" id — safe to
// match for cleanup (won't touch unrelated user downloads).
const SB_FILE_SIGNATURE = /SBV-?\d{4,}/i;
const _nativeDownloadNames = new Set();
const _nativeDownloadPrefixes = new Set();
let _browserLaunchedAt = 0;

function _readDownloadManifest() {
    try {
        if (!fs.existsSync(DOWNLOAD_MANIFEST_FILE)) return {};
        const data = JSON.parse(fs.readFileSync(DOWNLOAD_MANIFEST_FILE, 'utf8'));
        return data && typeof data === 'object' ? data : {};
    } catch (_) {
        return {};
    }
}

function _writeDownloadManifest() {
    try {
        fs.mkdirSync(PROJECT_WORK_DIR, { recursive: true });
        const prev = _readDownloadManifest();
        const names = new Set([...(prev.names || []), ..._nativeDownloadNames]);
        const prefixes = new Set([...(prev.prefixes || []), ..._nativeDownloadPrefixes]);
        fs.writeFileSync(DOWNLOAD_MANIFEST_FILE, JSON.stringify({
            startedAt: Number(prev.startedAt || _browserLaunchedAt || Date.now()),
            names: [...names].slice(-300),
            prefixes: [...prefixes].slice(-300),
        }, null, 2), 'utf8');
    } catch (_) {}
}

function _slugFromStoryblocksUrl(value) {
    try {
        const u = new URL(String(value || ''));
        const last = (u.pathname.split('/').filter(Boolean).pop() || '').toLowerCase();
        return last.replace(/-\d{4,}$/, '').replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
    } catch (_) {
        return '';
    }
}

function _rememberNativeDownloadCandidate(value) {
    const raw = String(value || '').trim();
    if (!raw) return;
    let name = raw;
    try {
        if (/^https?:|^blob:/i.test(raw)) {
            name = decodeURIComponent(new URL(raw).pathname.split('/').pop() || '');
        }
    } catch (_) {}
    name = path.basename(name).toLowerCase();
    if (name && /\.(?:mp4|mov|webm|mkv|m4v|crdownload)$/i.test(name)) {
        _nativeDownloadNames.add(name);
        _nativeDownloadNames.add(name.replace(/\.crdownload$/i, ''));
    }
    const slug = _slugFromStoryblocksUrl(raw);
    if (slug && slug.length >= 12) _nativeDownloadPrefixes.add(slug.slice(0, 80));
    _writeDownloadManifest();
}

function _rememberClipPageDownloadCandidate(clipUrl) {
    const slug = _slugFromStoryblocksUrl(clipUrl);
    if (!slug || slug.length < 12) return;
    _nativeDownloadPrefixes.add(slug.slice(0, 80));
    _nativeDownloadNames.add(`${slug}.mp4`);
    _nativeDownloadNames.add(`${slug}.mov`);
    _writeDownloadManifest();
}

function _matchesRememberedDownload(name, manifest = {}) {
    const lower = String(name || '').toLowerCase();
    const base = lower.replace(/\.(?:mp4|mov|webm|mkv|m4v|crdownload)$/i, '');
    const names = new Set([...(manifest.names || []), ..._nativeDownloadNames].map(v => String(v || '').toLowerCase()));
    if (names.has(lower) || names.has(lower.replace(/\.crdownload$/i, ''))) return true;
    const prefixes = [...new Set([...(manifest.prefixes || []), ..._nativeDownloadPrefixes])]
        .map(v => String(v || '').toLowerCase())
        .filter(v => v.length >= 12);
    return prefixes.some(prefix => base.startsWith(prefix.slice(0, Math.min(prefix.length, 48))));
}

/**
 * Delete Storyblocks-signature leftovers from the private workspace AND the OS
 * Downloads folder. Tightly scoped: only files whose name carries the SBV-<id>
 * signature, and (for the user's Downloads) only ones created during this
 * session so we never touch pre-existing files.
 */
function purgeStoryblocksDownloadLeaks(sinceMs = 0) {
    let removed = 0;
    const manifest = _readDownloadManifest();
    const effectiveSince = sinceMs || Number(manifest.startedAt || 0) || _browserLaunchedAt || 0;
    const sweep = (dir, requireRecent) => {
        try {
            if (!dir || !fs.existsSync(dir)) return;
            for (const name of fs.readdirSync(dir)) {
                if (!/\.(?:mp4|mov|webm|mkv|m4v|crdownload)$/i.test(name)) continue;
                if (!SB_FILE_SIGNATURE.test(name) && !_matchesRememberedDownload(name, manifest)) continue;
                const fp = path.join(dir, name);
                try {
                    if (requireRecent && effectiveSince > 0) {
                        const st = fs.statSync(fp);
                        if (st.mtimeMs < effectiveSince - 5_000) continue;
                    }
                    fs.unlinkSync(fp);
                    removed += 1;
                } catch (_) {}
            }
        } catch (_) {}
    };
    sweep(BROWSER_DOWNLOAD_DIR, false);          // private workspace — clear all SB files
    sweep(OS_DOWNLOADS_DIR, true);               // user's Downloads — only this session's
    if (removed > 0) console.log(`  [Storyblocks] cleaned up ${removed} leftover download(s)`);
    return removed;
}
let _cloudflareWarm = false;             // flips true after first successful page resolve
let _loggedIn = false;                   // flips true after successful login (or cookie restore)
let _loginPromise = null;                // single-flight cookie/session validation
// Session-level kill switch: once ANY download trips the "not logged in"
// auth wall, we disable Storyblocks for the rest of the build. Avoids
// burning 16+ seconds per scene re-discovering that cookies are dead.
// Cleared on next process start (cookie refresh requires a restart anyway).
let _authDead = false;
let _authDeadReason = '';
let _authWallHits = 0;
const AUTH_WALL_STRIKE_LIMIT = 2;
// Global cap on concurrent Storyblocks clip-page downloads (one shared browser).
// Default raised 1→2 (2026-05-30) to relieve the single-slot serialization that
// bottlenecked the candidate race: 4 scenes × 4 soldiers all funnel through this
// semaphore, so at 1 every Storyblocks download ran strictly one-at-a-time and
// ate per-scene deadlines. 2 roughly halves that stall while staying conservative
// on the Cloudflare/auth-wall false-positive risk that parallel clip pages carry
// (see _noteStoryblocksAuthWall). Tune via STORYBLOCKS_PARALLEL_DOWNLOADS (max 4);
// drop back to 1 if 2 concurrent pages start tripping the logged-out wall.
const STORYBLOCKS_PARALLEL_DOWNLOADS = Math.max(
    1,
    Math.min(4, parseInt(process.env.STORYBLOCKS_PARALLEL_DOWNLOADS || '2', 10) || 2)
);
let _downloadSlotsActive = 0;
const _downloadSlotQueue = [];

function _isAbortSignalLike(signal) {
    return !!signal
        && typeof signal === 'object'
        && typeof signal.addEventListener === 'function'
        && typeof signal.removeEventListener === 'function'
        && 'aborted' in signal;
}

// Pretty short labels for log output.
//   _clipLabel("https://.../video/stock/big-cargo-ship-sailing-348375180")
//     → "SBV-348375180 (big cargo ship sailing)"
//   _shortHost("https://d2j2....cloudfront.net/content/x/file.mp4")
//     → "cloudfront.net/...file.mp4"
function _clipLabel(clipUrl) {
    if (!clipUrl) return '';
    try {
        const u = String(clipUrl);
        // Strip query & fragment, then take the last URL segment.
        const slug = u.split(/[?#]/)[0].split('/').filter(Boolean).pop() || '';
        // Trailing run of digits is the Storyblocks numeric ID.
        const m = slug.match(/^(.*?)-(\d{6,})$/);
        if (m) {
            const title = m[1].replace(/-+/g, ' ').trim();
            const id = `SBV-${m[2]}`;
            const display = title.length > 50 ? title.slice(0, 47) + '…' : title;
            return display ? `${id} (${display})` : id;
        }
        return slug.length > 60 ? slug.slice(0, 57) + '…' : slug;
    } catch (_) {
        return String(clipUrl).slice(-60);
    }
}

function _shortHost(url) {
    if (!url) return '';
    try {
        const u = new URL(url);
        const host = u.hostname.replace(/^d[0-9a-z]+\./, '').replace(/^www\./, '');
        const file = (u.pathname.split('/').pop() || '').split('.').slice(0, 2).join('.');
        return file ? `${host}/${file}` : host;
    } catch (_) {
        return String(url).slice(0, 60);
    }
}

function _acquireStoryblocksDownloadSlot(label = '') {
    return new Promise((resolve) => {
        const grant = () => {
            _downloadSlotsActive += 1;
            const release = () => {
                _downloadSlotsActive = Math.max(0, _downloadSlotsActive - 1);
                const next = _downloadSlotQueue.shift();
                if (next) setImmediate(next);
            };
            resolve(release);
        };
        if (_downloadSlotsActive < STORYBLOCKS_PARALLEL_DOWNLOADS) {
            grant();
            return;
        }
        const shortLabel = _clipLabel(label);
        console.log(`  [Storyblocks] queue ▶ slot ${_downloadSlotsActive}/${STORYBLOCKS_PARALLEL_DOWNLOADS}${shortLabel ? ` · ${shortLabel}` : ''}`);
        _downloadSlotQueue.push(grant);
    });
}

async function _withStoryblocksDownloadSlot(label, fn) {
    const wasQueued = _downloadSlotsActive >= STORYBLOCKS_PARALLEL_DOWNLOADS;
    const release = await _acquireStoryblocksDownloadSlot(label);
    const shortLabel = _clipLabel(label);
    console.log(`  [Storyblocks] start  ▶ slot ${_downloadSlotsActive}/${STORYBLOCKS_PARALLEL_DOWNLOADS}${wasQueued ? ' (after wait)' : ''}${shortLabel ? ` · ${shortLabel}` : ''}`);
    try {
        return await fn();
    } finally {
        release();
    }
}

function _markStoryblocksAuthDead(reason) {
    if (_authDead) return;
    _authDead = true;
    _authDeadReason = String(reason || 'Storyblocks not logged in').slice(0, 200);
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════════════════╗');
    console.log('  ║  ⛔ STORYBLOCKS COOKIES EXPIRED — disabling for this build   ║');
    console.log('  ╠══════════════════════════════════════════════════════════════╣');
    console.log('  ║  Run: npm run storyblocks-cookies                             ║');
    console.log('  ║  Then restart the build. Other providers will be tried.       ║');
    console.log('  ╚══════════════════════════════════════════════════════════════╝');
    console.log('');
}

function isStoryblocksAuthDead() { return _authDead; }
function getStoryblocksAuthDeadReason() { return _authDeadReason; }

function _noteStoryblocksAuthWall(label) {
    _authWallHits += 1;
    const reason = `auth wall detected${label ? ` — label "${String(label).slice(0, 80)}"` : ''}`;
    if (_authWallHits >= AUTH_WALL_STRIKE_LIMIT) {
        _markStoryblocksAuthDead(reason);
        return true;
    }
    console.log(`  [Storyblocks] ${reason}; strike ${_authWallHits}/${AUTH_WALL_STRIKE_LIMIT} (not disabling yet; parallel pages can false-positive during hydration)`);
    return false;
}

// ───── Browser lifecycle (lazy, reused, idle-closed) ─────

let _browserPromise = null;
let _puppeteer = null;
let _lastUseAt = 0;
const _BROWSER_IDLE_MS = 5 * 60 * 1000;

function _findSystemBrowser() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    const candidates = [];
    if (process.platform === 'win32') {
        const PF = process.env['PROGRAMFILES'] || 'C:\\Program Files';
        const PF86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
        const LOCAL = process.env['LOCALAPPDATA'] || '';
        candidates.push(
            path.join(PF, 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(PF86, 'Google\\Chrome\\Application\\chrome.exe'),
            LOCAL && path.join(LOCAL, 'Google\\Chrome\\Application\\chrome.exe'),
            path.join(PF, 'Microsoft\\Edge\\Application\\msedge.exe'),
            path.join(PF86, 'Microsoft\\Edge\\Application\\msedge.exe'),
        );
    } else if (process.platform === 'darwin') {
        candidates.push(
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        );
    } else {
        candidates.push('/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge');
    }
    for (const p of candidates.filter(Boolean)) {
        try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
    return null;
}

async function _getBrowser() {
    if (!_puppeteer) {
        try { _puppeteer = require('puppeteer-core'); }
        catch (e) { throw new Error(`puppeteer-core not installed: ${e.message}`); }
    }
    if (_browserPromise) {
        _lastUseAt = Date.now();
        return _browserPromise;
    }
    const exe = _findSystemBrowser();
    if (!exe) throw new Error('No system Chrome/Edge found for Storyblocks provider');
    fs.mkdirSync(BROWSER_DOWNLOAD_DIR, { recursive: true });
    fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
    _browserPromise = _puppeteer.launch({
        executablePath: exe,
        headless: 'new',
        userDataDir: BROWSER_PROFILE_DIR,
        args: [
            '--disable-blink-features=AutomationControlled',
            '--lang=en-US,en',
        ],
        defaultViewport: { width: 1440, height: 2000 },
    }).then(async b => {
        _lastUseAt = Date.now();
        _browserLaunchedAt = Date.now();
        _writeDownloadManifest();
        b.on('disconnected', () => { _browserPromise = null; });
        // Redirect downloads on EVERY new target/popup too — popup downloads are the
        // ones that bypass the per-page redirect and leak to the user's Downloads.
        try {
            b.on('targetcreated', async (target) => {
                try {
                    if (typeof target.type === 'function' && target.type() !== 'page') return;
                    const client = await target.createCDPSession();
                    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: BROWSER_DOWNLOAD_DIR });
                } catch (_) {}
            });
        } catch (_) {}
        // Redirect downloads at the BROWSER level so EVERY page, popup, and future
        // target lands in our private workspace folder — never the user's Downloads.
        // Per-page CDP (in _applyStealth) misses downloads triggered on popups/new
        // targets that didn't go through stealth setup; that's the leak where Chrome
        // falls back to its default Downloads dir with the stock title as filename.
        try {
            fs.mkdirSync(BROWSER_DOWNLOAD_DIR, { recursive: true });
            const bctx = await b.target().createCDPSession();
            await bctx.send('Browser.setDownloadBehavior', {
                behavior: 'allowAndName',
                downloadPath: BROWSER_DOWNLOAD_DIR,
                eventsEnabled: true,
            });
        } catch (_) { /* older Chromium without Browser.* CDP — per-page fallback applies */ }
        return b;
    }).catch(err => {
        _browserPromise = null;
        throw err;
    });
    return _browserPromise;
}

async function closeStoryblocksBrowser() {
    if (!_browserPromise) return;
    try {
        const b = await _browserPromise;
        await b.close();
    } catch (_) {}
    _browserPromise = null;
    // Sweep any leftover Storyblocks downloads (private workspace + any that
    // leaked into the user's Downloads this session) once the browser is gone.
    try { purgeStoryblocksDownloadLeaks(_browserLaunchedAt); } catch (_) {}
}

// Idle timer — close after 5 min of disuse
setInterval(() => {
    if (!_browserPromise) return;
    if (Date.now() - _lastUseAt > _BROWSER_IDLE_MS) closeStoryblocksBrowser();
}, 60_000).unref?.();

// ───── Stealth + Cloudflare-resolve helpers ─────

async function _applyStealth(page, downloadDir = BROWSER_DOWNLOAD_DIR) {
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
        window.chrome = window.chrome || { runtime: {} };
    });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
    });
    // Keep native browser downloads away from the user's Downloads folder.
    // Important: using "deny" can suppress the very download request we need
    // to observe. We allow Chrome's download manager, but redirect it into a
    // private workspace folder while our own axios stream writes the real
    // scene file.
    try {
        fs.mkdirSync(downloadDir, { recursive: true });
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: downloadDir,
        });
        // Browser.setDownloadBehavior with eventsEnabled=true emits
        // Browser.downloadWillBegin / Browser.downloadProgress, which fire even
        // for popup/blob downloads that don't surface a URL on the request bus.
        // This is the single most reliable signal that an MP4 is actually
        // being fetched — we use it as the primary "we won" indicator below.
        try {
            await client.send('Browser.setDownloadBehavior', {
                behavior: 'allowAndName',
                downloadPath: downloadDir,
                eventsEnabled: true,
            });
        } catch (_) { /* Browser.* CDP API not in this Chromium build */ }
        // Stash the CDP session on the page so _captureCleanDownloadUrl can
        // subscribe to download events without re-creating the session.
        page._sbCdpClient = client;
    } catch (_) { /* CDP unavailable on this puppeteer build — best effort */ }
}

function _listRecentVideoDownloads(downloadDir, sinceMs) {
    try {
        if (!downloadDir || !fs.existsSync(downloadDir)) return [];
        const VIDEO_FILE = /\.(?:mp4|mov|webm|mkv|m4v)$/i;
        return fs.readdirSync(downloadDir, { withFileTypes: true })
            .filter(d => d.isFile())
            .map(d => {
                const filePath = path.join(downloadDir, d.name);
                let stat = null;
                try { stat = fs.statSync(filePath); } catch (_) {}
                return { filePath, name: d.name, stat };
            })
            .filter(item => item.stat && VIDEO_FILE.test(item.name))
            .filter(item => item.stat.mtimeMs >= sinceMs - 2_000 && item.stat.size > 5_000)
            .filter(item => !fs.existsSync(`${item.filePath}.crdownload`))
            .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    } catch (_) {
        return [];
    }
}

async function _waitForBrowserDownload(downloadDir, sinceMs, maxWaitMs = 8_000, abortSignal = null) {
    const deadline = Date.now() + Math.max(500, maxWaitMs);
    let lastPath = '';
    let lastSize = -1;
    let stableHits = 0;
    while (Date.now() < deadline) {
        if (abortSignal?.aborted) return null;
        const [candidate] = _listRecentVideoDownloads(downloadDir, sinceMs);
        if (candidate) {
            if (candidate.filePath === lastPath && candidate.stat.size === lastSize) {
                stableHits += 1;
                if (stableHits >= 2) return candidate.filePath;
            } else {
                lastPath = candidate.filePath;
                lastSize = candidate.stat.size;
                stableHits = 0;
            }
        }
        await new Promise(r => setTimeout(r, 500));
    }
    return null;
}

async function _waitForRealPage(page, maxMs, abortSignal) {
    // First call after browser launch needs the full cold-start budget; later
    // calls reuse Cloudflare cookies and resolve much faster.
    const budget = Number.isFinite(maxMs)
        ? maxMs
        : (_cloudflareWarm ? CHALLENGE_RESOLVE_WARM_MS : CHALLENGE_RESOLVE_MAX_MS);
    const t0 = Date.now();
    while (Date.now() - t0 < budget) {
        if (abortSignal?.aborted) return false;
        await new Promise(r => setTimeout(r, 1200));
        if (abortSignal?.aborted) return false;
        try {
            const status = await page.evaluate(() => ({
                bodyLen: document.body ? document.body.innerText.length : 0,
                hasChallenge: !!document.querySelector('#challenge-running, #cf-challenge-running, #challenge-form'),
            }));
            if (!status.hasChallenge && status.bodyLen > 500) {
                _cloudflareWarm = true;
                return true;
            }
        } catch (_) { /* context destroyed mid-navigation; retry */ }
    }
    return false;
}

/**
 * Pre-warm: launch the browser and resolve Cloudflare's JS challenge against
 * the search index once, so the first real scene search isn't blocked by a
 * ~30-40s cold-start. Safe to call multiple times; no-op if already warm.
 */
async function prewarmStoryblocksBrowser() {
    const subscribed = process.env.STORYBLOCKS_SUBSCRIBED === '1';
    if (_cloudflareWarm && _browserPromise && (!subscribed || _loggedIn)) return true;
    let page;
    try {
        const browser = await _getBrowser();
        page = await browser.newPage();
        await _applyStealth(page);

        if (subscribed) {
            // _loginIfNeeded handles CF resolve + cookie restore + form submission.
            const ok = await _ensureLoginSingleFlight(page);
            if (ok) {
                console.log('  [Storyblocks] browser pre-warmed (subscribed, authenticated)');
                return true;
            }
            console.log('  [Storyblocks] subscribed pre-warm failed; falling back to anonymous preview pre-warm');
            // Fall through to anonymous warm-up so preview mode still works.
        }

        try {
            await page.goto('https://www.storyblocks.com/video', { waitUntil: 'domcontentloaded', timeout: SEARCH_RESULTS_TIMEOUT_MS });
        } catch (_) { /* CF will interrupt; wait below */ }
        const ok = await _waitForRealPage(page);
        if (ok) {
            console.log('  [Storyblocks] browser pre-warmed (CF cookies established)');
        } else {
            console.log('  [Storyblocks] pre-warm failed to resolve CF challenge; will retry on first search');
        }
        return ok;
    } catch (e) {
        console.log(`  [Storyblocks] pre-warm error: ${e.message}`);
        return false;
    } finally {
        try { await page?.close(); } catch (_) {}
    }
}

// ───── Cookie persistence (subscribed mode) ─────

async function _loadCookies(page) {
    try {
        if (!fs.existsSync(COOKIE_FILE)) return false;
        const raw = fs.readFileSync(COOKIE_FILE, 'utf8');
        const cookies = JSON.parse(raw);
        if (!Array.isArray(cookies) || cookies.length === 0) return false;
        await page.setCookie(...cookies);
        return true;
    } catch (e) {
        console.log(`  [Storyblocks] cookie load failed: ${e.message}`);
        return false;
    }
}

async function _saveCookies(page) {
    try {
        const cookies = await page.cookies();
        fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2), 'utf8');
    } catch (e) {
        console.log(`  [Storyblocks] cookie save failed: ${e.message}`);
    }
}

async function _isLoggedIn(page) {
    try {
        return await page.evaluate(() => {
            // 1) If we got bounced back to a login URL, we're not logged in.
            if (/\/(login|signin|sign-in)(\?|#|\/|$)/i.test(location.href)) return false;

            // 2) If the page is rendering a login form right now, we're not logged in.
            //    (A logged-in user landing on /video never sees email+password inputs.)
            const hasEmailInput = !!document.querySelector('input[type="email"]');
            const hasPwInput = !!document.querySelector('input[type="password"]');
            if (hasEmailInput && hasPwInput) return false;

            // 3) Positive signal: an account/signout link/menu exists in DOM.
            //    href-based selectors are language-agnostic. Storyblocks ships
            //    /account, /signout, /logout regardless of UI locale.
            const hasAccount = !!document.querySelector(
                'a[href*="/account"], a[href*="/signout"], a[href*="/sign-out"], ' +
                'a[href*="/logout"], a[href*="/log-out"], ' +
                '[data-testid*="account"], [data-testid*="user-menu"], ' +
                '[class*="UserMenu"], [class*="user-menu"], [class*="AccountMenu"], ' +
                '[class*="Avatar"], [class*="avatar"]'
            );
            if (hasAccount) return true;

            // 4) Multilingual text fallback (EN/FR/ES/DE/IT/PT/KO) for "sign out".
            const text = document.body ? (document.body.innerText || '') : '';
            const SIGN_OUT_PATTERNS = /sign\s*out|log\s*out|se\s*déconnecter|déconnexion|cerrar\s*sesión|abmelden|esci|sair|로그아웃/i;
            if (SIGN_OUT_PATTERNS.test(text)) return true;

            return false;
        });
    } catch (_) { return false; }
}

/**
 * Programmatic login. Loads saved cookies first; if not authenticated,
 * navigates to /login and fills the email/password form. Stores cookies on
 * success. Idempotent — safe to call multiple times.
 */
async function _loginIfNeeded(page) {
    if (_loggedIn) return true;

    // Try saved cookies first.
    // We deliberately skip DOM-based "is logged in" detection here. In
    // headless mode the user-menu React component sometimes never hydrates
    // (Cloudflare/anti-bot delays), so DOM checks produce false negatives
    // even when cookies are perfectly valid. The reliable signal is whether
    // Storyblocks bounces us back to /login after navigation — if it doesn't,
    // the session cookie is being honoured. Final ground truth comes from
    // download URLs (clean vs /watermarks/), checked downstream.
    const restored = await _loadCookies(page);
    if (restored) {
        try {
            await page.goto('https://www.storyblocks.com/video', { waitUntil: 'domcontentloaded', timeout: SEARCH_RESULTS_TIMEOUT_MS });
        } catch (_) {}
        await _waitForRealPage(page);

        let currentUrl = '';
        try { currentUrl = await page.evaluate(() => location.href); } catch (_) {}
        const bouncedToLogin = /\/(login|signin|sign-in)(\?|#|\/|$)/i.test(currentUrl);

        if (!bouncedToLogin) {
            console.log('  [Storyblocks] cookie-restored session accepted (no /login bounce)');
            _loggedIn = true;
            _authWallHits = 0;
            return true;
        }
        console.log('  [Storyblocks] saved cookies rejected (bounced to /login) — re-logging in');
    }

    const email = process.env.STORYBLOCKS_EMAIL;
    const password = process.env.STORYBLOCKS_PASSWORD;
    if (!email || !password) {
        console.log('  [Storyblocks] STORYBLOCKS_EMAIL/PASSWORD not set; cannot enter subscribed mode');
        return false;
    }

    try {
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: LOGIN_TIMEOUT_MS });
    } catch (_) { /* CF may interrupt */ }

    // Login page body is intentionally minimal (~266 chars), so the generic
    // _waitForRealPage 500-char heuristic rejects it. Wait specifically for
    // the form inputs to appear instead.
    const formReady = await (async () => {
        const t0 = Date.now();
        while (Date.now() - t0 < LOGIN_TIMEOUT_MS) {
            await new Promise(r => setTimeout(r, 800));
            try {
                const ready = await page.evaluate(() => !!document.querySelector('input[type="email"], input[name="email"]')
                    && !!document.querySelector('input[type="password"], input[name="password"]')
                    && !document.querySelector('#challenge-running, #cf-challenge-running'));
                if (ready) { _cloudflareWarm = true; return true; }
            } catch (_) {}
        }
        return false;
    })();
    if (!formReady) {
        console.log('  [Storyblocks] login form never appeared (CF challenge or selector drift)');
        return false;
    }

    // Defensive selectors — Storyblocks may rename inputs between releases.
    const filled = await page.evaluate((em, pw) => {
        const findInput = (typeHints, nameHints) => {
            for (const sel of typeHints) {
                const el = document.querySelector(sel);
                if (el) return el;
            }
            for (const inp of Array.from(document.querySelectorAll('input'))) {
                const n = (inp.name || '') + ' ' + (inp.id || '') + ' ' + (inp.placeholder || '');
                if (nameHints.some(h => new RegExp(h, 'i').test(n))) return inp;
            }
            return null;
        };
        const emailInput = findInput(
            ['input[type="email"]', 'input[name="email"]', '#email'],
            ['email', 'user']
        );
        const passInput = findInput(
            ['input[type="password"]', 'input[name="password"]', '#password'],
            ['pass']
        );
        if (!emailInput || !passInput) return false;
        const setNative = (el, val) => {
            const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            setter.call(el, val);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        };
        setNative(emailInput, em);
        setNative(passInput, pw);
        return true;
    }, email, password);

    if (!filled) {
        console.log('  [Storyblocks] login form inputs not found — selectors may have changed');
        return false;
    }

    // Watch for the /api/login response — Storyblocks uses invisible
    // reCAPTCHA v3, which scores headless browsers as bots and returns 403.
    // Detect this immediately and bail rather than waiting for nav timeout.
    let loginApiStatus = null;
    const apiListener = (res) => {
        try {
            const u = res.url();
            if (/\/api\/login(?:[/?]|$)/i.test(u)) loginApiStatus = res.status();
        } catch (_) {}
    };
    page.on('response', apiListener);

    // Tick the Terms of Service / License Agreement checkbox if present —
    // login form rejects submit without it.
    try {
        await page.evaluate(() => {
            const cb = document.querySelector('#agreement-checkbox, input[name="agreement-checkbox"], input[type="checkbox"]');
            if (cb && !cb.checked) {
                cb.click();
            }
        });
    } catch (_) {}

    // Submit — prefer clicking the actual Login button (more reliable than Enter
    // when the form has a checkbox between password and submit).
    try {
        await page.evaluate(() => {
            const btn = Array.from(document.querySelectorAll('button')).find(b => /^login$|^log in$|^sign in$/i.test((b.textContent || '').trim()))
                || document.querySelector('button[type="submit"], form button[type="submit"]');
            if (btn) btn.click();
        });
    } catch (_) {
        try {
            await page.focus('input[type="password"], input[name="password"]');
            await page.keyboard.press('Enter');
        } catch (_) {}
    }

    // Wait for nav away from /login OR /api/login response, whichever first
    const t0 = Date.now();
    while (Date.now() - t0 < LOGIN_TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 500));
        if (loginApiStatus !== null) break;
        try {
            const url = page.url();
            if (!/\/login|\/signin/i.test(url)) break;
        } catch (_) {}
    }
    page.off('response', apiListener);

    if (loginApiStatus && loginApiStatus >= 400) {
        // 403 = reCAPTCHA v3 scored us as a bot; 401 = bad credentials.
        // Either way, form-based login is not going to work from this browser.
        if (loginApiStatus === 403) {
            console.log('  [Storyblocks] /api/login returned 403 — invisible reCAPTCHA blocks headless login.');
            console.log('  [Storyblocks] Run "npm run storyblocks-cookies" to capture cookies from a manual login.');
        } else {
            console.log(`  [Storyblocks] /api/login returned ${loginApiStatus} — credentials likely wrong.`);
        }
        return false;
    }

    await _waitForRealPage(page);
    if (await _isLoggedIn(page)) {
        console.log('  [Storyblocks] logged in successfully (credentials)');
        await _saveCookies(page);
        _loggedIn = true;
        _authWallHits = 0;
        return true;
    }

    console.log('  [Storyblocks] login submission did not authenticate (captcha or MFA?)');
    return false;
}

async function _ensureLoginSingleFlight(page) {
    if (_loggedIn) return true;
    if (!_loginPromise) {
        _loginPromise = _loginIfNeeded(page).finally(() => {
            _loginPromise = null;
        });
    }
    return _loginPromise;
}

function _buildSearchUrl(keyword) {
    const q = String(keyword || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\s/g, '-');
    return `${SEARCH_URL_BASE}${q}`;
}

// ───── Provider class ─────

class StoryblocksVideoProvider extends BaseProvider {
    constructor() {
        super('Storyblocks Videos', 'video');
        this._scriptContext = null;
        this._subscribed = process.env.STORYBLOCKS_SUBSCRIBED === '1';
    }

    setContext(scriptContext) {
        this._scriptContext = scriptContext;
    }

    /**
     * Available unless cookies died mid-build. Once the auth wall has been
     * detected, isAvailable() returns false so the per-provider loop skips
     * Storyblocks entirely on the remaining scenes (instead of wasting 16+s
     * per scene re-discovering the same auth failure).
     */
    isAvailable() {
        if (_authDead) return false;
        return true;
    }

    /**
     * Override base watermark check. In PREVIEW mode our URLs intentionally
     * contain "/watermarks/" — base would reject them. Skip the check; we
     * mark results with _isPreview so callers know.
     */
    isWatermarked(_url) {
        return false;
    }

    /**
     * Subscribed-mode downloads have two failure modes if we capture MP4 URLs
     * during search and use them later:
     *   1) Session-gated CDN — needs cookies + Referer (or it 403s).
     *   2) Signed-URL TTL — captured URL goes stale within ~60s, so by the
     *      time the footage-manager picks the 3rd/4th result it 403s.
     *
     * Fix: when the URL we get is a clip *page* URL (not an MP4), open the
     * page fresh, click Download, intercept the MP4 in-flight, then
     * stream-download with cookies — all within seconds. URL is never stale.
     */
    async _downloadOnce(url, outputPath, opts = {}) {
        const isClipPage = /storyblocks\.com\/(?:all-video|video)\/[^?#]*-\d{4,}(?:\/|$|\?)/i.test(url);
        if (this._subscribed && isClipPage) {
            return this._downloadFromClipPage(url, outputPath, opts);
        }
        const isStoryblocksHost = /storyblocks\.com|storyblockscdn\.com|cloudfront\.net/i.test(url);
        if (!this._subscribed || !isStoryblocksHost) {
            return super._downloadOnce(url, outputPath, opts);
        }
        return this._cookieAxiosDownload(url, outputPath, opts);
    }

    async _downloadFromClipPage(clipPageUrl, outputPath, opts = {}) {
        return _withStoryblocksDownloadSlot(clipPageUrl, async () => {
        _rememberClipPageDownloadCandidate(clipPageUrl);
        if (_authDead) {
            throw new Error(`Storyblocks auth dead: ${_authDeadReason || 'refresh cookies via `npm run storyblocks-cookies`'}`);
        }
        const abortSignal = _isAbortSignalLike(opts.abortSignal) ? opts.abortSignal : null;
        const hardCapMs = Math.max(15_000, Number(opts.clipHardCapMs) || PER_CLIP_HARD_CAP_MS);
        const clipDeadline = Date.now() + hardCapMs;
        const startedAt = Date.now();
        const isDead = () => abortSignal?.aborted || Date.now() >= clipDeadline;
        const remainingMs = () => Math.max(0, clipDeadline - Date.now());
        const failHardCap = (stage) => {
            const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
            const reason = abortSignal?.aborted
                ? `scene aborted at ${stage} (${elapsed}s)`
                : `clip hard-cap ${Math.round(hardCapMs / 1000)}s exceeded at ${stage} (${elapsed}s)`;
            console.log(`  [Storyblocks] ${reason} → skipping ${_clipLabel(clipPageUrl)}`);
            throw new Error(reason);
        };

        if (isDead()) failHardCap('clip-page open');

        const browser = await _getBrowser();
        const page = await browser.newPage();
        const privateDownloadDir = path.join(
            BROWSER_DOWNLOAD_DIR,
            `clip-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        );
        try {
            await _applyStealth(page, privateDownloadDir);
            if (isDead()) failHardCap('stealth setup');
            const ok = await _ensureLoginSingleFlight(page);
            if (!ok) {
                const disabled = _noteStoryblocksAuthWall('login unavailable');
                throw new Error(disabled
                    ? 'Storyblocks not logged in - refresh cookies via `npm run storyblocks-cookies`'
                    : 'Storyblocks login unavailable');
            }
            if (isDead()) failHardCap('post-login');
            // Capture the clean MP4. A single attempt occasionally "misses" —
            // the Download click fired but the CDN was slow, a Cloudflare
            // re-challenge ate the capture window, or the button wasn't hydrated
            // yet. These are transient and usually succeed on a reload+re-click.
            // For long videos (many scene downloads) those misses compound, so we
            // retry within the per-clip deadline instead of burning the candidate.
            // Bounded (default 2 attempts) and gated on having budget left for
            // another goto+capture (~15s), so it never blows the scene deadline.
            const maxCaptureAttempts = Math.max(1, Math.min(3,
                parseInt(process.env.STORYBLOCKS_CAPTURE_ATTEMPTS || '2', 10) || 2));
            let captured = null;
            for (let attempt = 1; attempt <= maxCaptureAttempts; attempt++) {
                captured = await this._captureCleanDownloadUrl(page, clipPageUrl, {
                    abortSignal,
                    deadlineAt: clipDeadline,
                    downloadDir: privateDownloadDir,
                });
                if (captured && (captured.url || captured.browserFile)) break; // got it
                if (captured?.authWall) break;     // auth wall won't fix on retry
                if (isDead()) break;               // aborted or out of clip budget
                if (attempt < maxCaptureAttempts && remainingMs() > 15_000) {
                    console.log(`  [Storyblocks] capture miss — retrying clip (attempt ${attempt + 1}/${maxCaptureAttempts}) · ${_clipLabel(clipPageUrl)}`);
                    continue;
                }
                break;
            }
            // Path A: browser triggered a real download and we observed the file
            // in the per-clip download dir. Copy it out and return — no URL needed.
            if (captured?.browserFile) {
                fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                fs.copyFileSync(captured.browserFile, outputPath);
                const stat = fs.statSync(outputPath);
                if (stat.size >= 5_000) {
                    console.log(`  [Storyblocks] using browser-downloaded asset (${path.basename(captured.browserFile)}, ${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
                    try { fs.unlinkSync(captured.browserFile); } catch (_) {}  // don't leave the temp copy behind
                    return outputPath;
                }
                try { fs.unlinkSync(outputPath); } catch (_) {}
            }
            if (!captured || (!captured.url && !captured.browserFile)) {
                if (captured?.authWall) {
                    const disabled = _noteStoryblocksAuthWall(captured.label || '');
                    if (disabled) {
                        throw new Error('Storyblocks not logged in — refresh cookies via `npm run storyblocks-cookies`');
                    }
                    throw new Error('Storyblocks auth wall suspected on clip page');
                }
                // Last-ditch salvage: keep watching the download dir for a short
                // tail in case the browser is still writing the file after the
                // capture loop exited.
                const salvageBudget = Math.min(BROWSER_DOWNLOAD_WAIT_MS, Math.max(500, remainingMs()));
                const browserFile = await _waitForBrowserDownload(privateDownloadDir, startedAt, salvageBudget, abortSignal);
                if (browserFile) {
                    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
                    fs.copyFileSync(browserFile, outputPath);
                    const stat = fs.statSync(outputPath);
                    if (stat.size >= 5_000) {
                        console.log(`  [Storyblocks] recovered browser-downloaded asset (${path.basename(browserFile)}, ${(stat.size / 1024 / 1024).toFixed(1)} MB)`);
                        try { fs.unlinkSync(browserFile); } catch (_) {}  // don't leave the temp copy behind
                        return outputPath;
                    }
                    try { fs.unlinkSync(outputPath); } catch (_) {}
                }
                throw new Error('Failed to capture clean MP4 URL');
            }
            if (isDead()) failHardCap('pre-stream');
            const dlTimeoutMs = Math.max(8_000, Math.min(opts.timeoutMs || 120_000, remainingMs()));
            return await this._cookieAxiosDownload(captured.url, outputPath, { ...opts, timeoutMs: dlTimeoutMs });
        } finally {
            try { await page.close(); } catch (_) {}
            try { purgeStoryblocksDownloadLeaks(_browserLaunchedAt || startedAt); } catch (_) {}
        }
        });
    }

    async _cookieAxiosDownload(url, outputPath, opts = {}) {
        let cookieHeader = '';
        try {
            if (fs.existsSync(COOKIE_FILE)) {
                const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
                if (Array.isArray(raw) && raw.length) {
                    cookieHeader = raw
                        .filter(c => c && c.name && c.value !== undefined)
                        .map(c => `${c.name}=${c.value}`)
                        .join('; ');
                }
            }
        } catch (_) { /* no cookies — base path will likely 403 too, but try */ }

        const abortSignal = _isAbortSignalLike(opts.abortSignal) ? opts.abortSignal : null;
        if (abortSignal?.aborted) throw new Error('aborted before request');
        const timeoutMs = Math.max(15_000, Number(opts.timeoutMs || 120_000));
        const headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8',
            'Referer': 'https://www.storyblocks.com/',
            'Origin': 'https://www.storyblocks.com',
        };
        if (cookieHeader) headers['Cookie'] = cookieHeader;
        const maxBytes = 2 * 1024 * 1024 * 1024;
        const response = await requestSafeStream(url, {
            method: 'GET', adapter: 'http',
            timeout: timeoutMs, signal: abortSignal || undefined,
            headers,
        }, { maxRedirects: 10, maxBytes });
        const ct = response.headers['content-type'] || '';
        if (ct.includes('text/html') || ct.includes('application/json')) {
            throw new Error(`Server returned ${ct} instead of media`);
        }
        const writer = fs.createWriteStream(outputPath);
        const limiter = createByteLimitTransform(maxBytes);
        response.data.pipe(limiter).pipe(writer);
        limiter.on('error', (error) => writer.destroy(error));
        const onAbort = () => {
            try { response.data.destroy(new Error('aborted mid-stream')); } catch (_) {}
            try { writer.destroy(new Error('aborted mid-stream')); } catch (_) {}
            try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
        };
        if (abortSignal) abortSignal.addEventListener('abort', onAbort, { once: true });
        return new Promise((resolve, reject) => {
            const cleanup = () => { if (abortSignal) abortSignal.removeEventListener('abort', onAbort); };
            writer.on('finish', () => {
                cleanup();
                if (abortSignal?.aborted) {
                    try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (_) {}
                    return reject(new Error('aborted'));
                }
                const stat = fs.statSync(outputPath);
                if (stat.size < 5000) {
                    fs.unlinkSync(outputPath);
                    return reject(new Error(`Downloaded file too small (${stat.size} bytes)`));
                }
                resolve(outputPath);
            });
            writer.on('error', (err) => { cleanup(); reject(err); });
        });
    }

    async search(keyword) {
        if (_authDead) {
            console.log(`  [Storyblocks] skipped search for "${keyword}" - auth marked dead (${_authDeadReason || 'refresh cookies'})`);
            return [];
        }
        return this._searchPage(keyword);
    }

    async _searchPage(keyword) {
        const browser = await _getBrowser();
        const page = await browser.newPage();
        await _applyStealth(page);

        // Subscribed: ensure logged in before collecting clip URLs. If login
        // fails for any reason, gracefully fall back to preview flow so the
        // build doesn't stall.
        let useSubscribed = false;
        if (this._subscribed) {
            useSubscribed = await _ensureLoginSingleFlight(page);
            if (!useSubscribed) {
                console.log('  [Storyblocks] subscribed login unavailable, falling back to preview clips for this scene');
            }
        }

        try {
            // PHASE 1: search page → collect clip URLs
            const searchUrl = _buildSearchUrl(keyword);
            try {
                await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: SEARCH_RESULTS_TIMEOUT_MS });
            } catch (e) {
                // domcontentloaded may resolve before CF challenge; that's fine, we wait below
            }
            const ok = await _waitForRealPage(page);
            if (!ok) {
                console.log(`  [Storyblocks] CF challenge did not resolve for "${keyword}"`);
                return [];
            }

            // Storyblocks lazy-loads the result grid. A quick scroll lets the
            // provider see the same deeper result pool that appears in the
            // normal browser UI instead of only the first row.
            try {
                await page.waitForSelector('a[href*="/video/"], a[href*="/all-video/"]', { timeout: 10_000 });
                await page.evaluate(async (targetCount) => {
                    const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
                    let lastCount = 0;
                    let stableRounds = 0;
                    for (let i = 0; i < 8; i++) {
                        const count = document.querySelectorAll('a[href*="/video/"], a[href*="/all-video/"]').length;
                        if (count >= targetCount) break;
                        stableRounds = count <= lastCount ? stableRounds + 1 : 0;
                        if (stableRounds >= 3) break;
                        lastCount = count;
                        window.scrollBy(0, Math.max(700, Math.floor(window.innerHeight * 0.85)));
                        await sleep(550);
                    }
                    window.scrollTo(0, 0);
                    await sleep(250);
                }, MAX_SEARCH_RESULTS_TO_CONSIDER);
            } catch (_) {}

            const clipLinks = await page.evaluate((max) => {
                // Storyblocks clip URLs have evolved over time:
                //   /video/stock/<slug>-<id>         (legacy)
                //   /video/<slug>-<id>               (current)
                //   /all-video/<slug>-<id>           (some search variants)
                // We accept any anchor that ends with a numeric ID (Storyblocks
                // appends a numeric suffix to every clip slug) and is under the
                // /video/ or /all-video/ namespace, while excluding non-clip
                // routes like /search/, /category/, /collections/, /pricing/.
                const NON_CLIP = /\/(search|category|categories|collections|collection|pricing|plans|tags|tag|popular|trending|new|browse|filters?)\b/i;
                const CLIP_ID_TAIL = /-(\d{4,})(\/|$|\?)/;
                const CLIP_NS = /\/(all-video|video)\//i;

                const anchors = Array.from(document.querySelectorAll('a[href]'));
                const seen = new Set();
                const out = [];
                const cleanTitle = (value) => String(value || '')
                    .replace(/\s+/g, ' ')
                    .replace(/^go to video details for\s+/i, '')
                    .replace(/\s+-\s+storyblocks\b.*$/i, '')
                    .trim();
                const absUrl = (value) => {
                    const raw = String(value || '').trim();
                    if (!raw || /^(?:data|blob):/i.test(raw)) return '';
                    try { return new URL(raw, location.href).href; }
                    catch (_) { return ''; }
                };
                const fromSrcset = (value) => {
                    const parts = String(value || '')
                        .split(',')
                        .map(part => part.trim().split(/\s+/)[0])
                        .filter(Boolean);
                    return parts.length ? parts[parts.length - 1] : '';
                };
                const bgUrl = (value) => {
                    const m = String(value || '').match(/url\((['"]?)(.*?)\1\)/i);
                    return m ? m[2] : '';
                };
                const imageUrlFrom = (el) => {
                    if (!el) return '';
                    const tag = String(el.tagName || '').toLowerCase();
                    const candidates = [];
                    if (tag === 'img') {
                        candidates.push(
                            el.currentSrc,
                            el.getAttribute('src'),
                            el.getAttribute('data-src'),
                            el.getAttribute('data-lazy-src'),
                            el.getAttribute('data-original'),
                            el.getAttribute('data-testid-src'),
                            fromSrcset(el.getAttribute('srcset')),
                        );
                    } else if (tag === 'source') {
                        candidates.push(el.getAttribute('src'), fromSrcset(el.getAttribute('srcset')));
                    } else if (tag === 'video') {
                        candidates.push(el.getAttribute('poster'));
                    }
                    try {
                        const style = getComputedStyle(el);
                        candidates.push(bgUrl(style.backgroundImage), bgUrl(el.getAttribute('style')));
                    } catch (_) {}
                    for (const candidate of candidates) {
                        const url = absUrl(candidate);
                        if (!url) continue;
                        if (/\.(?:svg)(?:\?|$)/i.test(url)) continue;
                        if (/sprite|placeholder|avatar|logo/i.test(url)) continue;
                        return url;
                    }
                    return '';
                };
                const findThumbUrl = (a) => {
                    const scopes = [];
                    let node = a;
                    for (let depth = 0; node && depth < 5; depth++) {
                        scopes.push(node);
                        node = node.parentElement;
                    }
                    for (const scope of scopes) {
                        const direct = imageUrlFrom(scope);
                        if (direct) return direct;
                        const media = scope.querySelector?.('img, picture source, video[poster], [style*="background-image"]');
                        const nested = imageUrlFrom(media);
                        if (nested) return nested;
                    }
                    return '';
                };
                for (const a of anchors) {
                    if (out.length >= max) break;
                    const href = a.href || '';
                    if (!href) continue;
                    if (!CLIP_NS.test(href)) continue;
                    if (NON_CLIP.test(href)) continue;
                    const idMatch = href.match(CLIP_ID_TAIL);
                    if (!idMatch) continue;
                    if (seen.has(href)) continue;
                    seen.add(href);
                    // Pull a usable title from aria-label / nearby img alt /
                    // anchor text — enough for downstream Title Sanity AI.
                    let title = a.getAttribute('aria-label') || '';
                    if (!title) {
                        const img = a.querySelector('img');
                        title = (img && (img.getAttribute('alt') || img.getAttribute('title'))) || '';
                    }
                    if (!title) {
                        title = (a.textContent || '').replace(/\s+/g, ' ').trim();
                    }
                    title = cleanTitle(title);
                    const thumbUrl = findThumbUrl(a);
                    out.push({
                        href,
                        ariaLabel: a.getAttribute('aria-label') || null,
                        title: (title || '').slice(0, 200),
                        stockId: `SBV-${idMatch[1]}`,
                        thumbUrl,
                    });
                }
                return out;
            }, MAX_SEARCH_RESULTS_TO_CONSIDER);

            if (clipLinks.length === 0) {
                // Surface this for diagnosis — search loaded but no clip anchors matched.
                try {
                    const diag = await page.evaluate(() => ({
                        url: location.href,
                        anchorCount: document.querySelectorAll('a[href]').length,
                        videoNsCount: document.querySelectorAll('a[href*="/video/"], a[href*="/all-video/"]').length,
                        firstAnchorHrefs: Array.from(document.querySelectorAll('a[href*="/video/"], a[href*="/all-video/"]')).slice(0, 5).map(a => a.href),
                        title: document.title,
                    }));
                    const sampleSlugs = (diag.firstAnchorHrefs || []).slice(0, 3).map(_clipLabel).filter(Boolean).join(', ');
                    console.log(`  [Storyblocks] no clips matched ▶ ${diag.anchorCount} anchors, ${diag.videoNsCount} in /video/ ns${sampleSlugs ? ` · sample: ${sampleSlugs}` : ''}`);
                } catch (_) {}
                return [];
            }

            // PHASE 2 (subscribed): return clip page URLs directly. Download
            // captures the fresh MP4 URL at download time — never stale.
            if (useSubscribed) {
                const picked = clipLinks.slice(0, MAX_SUBSCRIBED_RESULTS_PER_SEARCH);
                console.log(`  [Storyblocks] search ▶ ${clipLinks.length} hits → ${picked.length} usable`);
                return picked.map(link => ({
                    id: link.stockId || link.href.split('/').pop().slice(0, 64),
                    url: link.href,           // clip page URL — _downloadOnce captures MP4 on demand
                    width: 1920,
                    height: 1080,
                    title: link.title || link.ariaLabel || '',
                    thumbUrl: link.thumbUrl || '',
                    _thumbUrl: link.thumbUrl || '',
                    _sourcePage: link.href,
                    _provider: 'storyblocks',
                }));
            }

            // PHASE 2 (preview fallback): visit top N clip pages, capture
            // watermarked download URL. Sequential — Cloudflare may rate-limit
            // parallel page loads.
            const results = [];
            const toCheck = clipLinks.slice(0, MAX_PREVIEW_CLIPS_PER_SEARCH);
            for (const link of toCheck) {
                try {
                    const captured = await this._captureWatermarkedUrl(page, link.href);
                    if (captured) {
                        captured.thumbUrl = link.thumbUrl || '';
                        captured._thumbUrl = link.thumbUrl || '';
                        results.push(captured);
                    }
                } catch (e) {
                    // Per-clip failure → continue
                }
            }

            return results;
        } finally {
            try { await page.close(); } catch (_) {}
        }
    }

    /**
     * Visit a clip page, click "Download Watermarked", capture the resulting
     * CloudFront MP4 URL. Returns a result object or null.
     */
    async _captureWatermarkedUrl(page, clipUrl) {
        let intercepted = null;
        let captureArmed = false;
        const onReq = (req) => {
            const u = req.url();
            if (intercepted) return;
            if (!captureArmed) return;
            if (/\.mp4(\?|$)/i.test(u) && /watermark/i.test(u)) {
                intercepted = u;
            }
        };
        page.on('request', onReq);
        try {
            try {
                await page.goto(clipUrl, { waitUntil: 'domcontentloaded', timeout: CLIP_PAGE_TIMEOUT_MS });
            } catch (_) { /* CF may interrupt; wait below */ }
            const ok = await _waitForRealPage(page);
            if (!ok) return null;

            // Some clip pages preload the preview MP4 on page load — give it a
            // chance to surface before we resort to clicking.
            await new Promise(r => setTimeout(r, 1500));

            if (!intercepted) {
                // Click "Download Watermarked" button to trigger the download URL
                try {
                    captureArmed = true;
                    await page.evaluate(() => {
                        const all = Array.from(document.querySelectorAll('a, button'));
                        const wm = all.find(el => /download.*watermark/i.test((el.textContent || '').replace(/\s+/g, ' ')))
                            || all.find(el => /watermark/i.test(el.textContent || ''));
                        if (wm) wm.click();
                    });
                } catch (_) {}
                // Wait for the network request to fire
                const t0 = Date.now();
                while (!intercepted && Date.now() - t0 < PER_CLIP_CAPTURE_MS) {
                    await new Promise(r => setTimeout(r, 250));
                }
            }

            if (!intercepted) return null;

            const meta = await page.evaluate(() => {
                const title = (document.querySelector('h1')?.textContent || '').trim();
                const idMatch = (document.body.innerText.match(/SBV-\d+/) || [])[0] || null;
                return { title, stockId: idMatch };
            });

            return {
                id: meta.stockId || clipUrl.split('/').pop().slice(0, 64),
                url: intercepted,
                width: 640,
                height: 360,
                title: meta.title,
                _isPreview: true,           // marker — watermarked 360p preview, not for production
                _sourcePage: clipUrl,
                _provider: 'storyblocks',
            };
        } finally {
            page.off('request', onReq);
        }
    }

    /**
     * Subscribed flow: visit a clip page, click the clean Download button
     * (HD MP4), capture the resulting unwatermarked CDN URL. Returns a result
     * object or null.
     */
    async _captureCleanDownloadUrl(page, clipUrl, capOpts = {}) {
        const abortSignal = capOpts.abortSignal || null;
        const deadlineAt = Number.isFinite(capOpts.deadlineAt) ? capOpts.deadlineAt : Infinity;
        const isDead = () => abortSignal?.aborted || Date.now() >= deadlineAt;
        const remainingMs = () => Math.max(0, deadlineAt - Date.now());
        // Private download dir for this clip — used for parallel browser-download
        // watching so a click that triggers a real browser download still produces
        // a usable file even if no URL is intercepted on the page.
        const watchDownloadDir = capOpts.downloadDir || null;
        const watchStartedMs = Date.now();

        let intercepted = null;
        let interceptedVia = null; // 'request' | 'response' | 'popup' | 'header'
        let browserFileWinner = null; // if browser file beats URL interception
        let captureArmed = false;

        // Whitelist of Storyblocks-affiliated hosts. Required for ANY capture
        // path — otherwise 3rd-party trackers (doubleclick, GA, etc.) that set
        // Content-Disposition: attachment will hijack the interceptor.
        // Widened May 2026: Storyblocks now serves clean MP4s through multiple
        // CDNs — cloudfront aliases (d1xxx.cloudfront.net), direct S3 buckets
        // (videoblocks-prod.s3, sb-video.s3), Fastly edge, and Akamai. The
        // BAD_PATH/VIDEO_EXT/BUCKET filters below still reject thumbnails and
        // tracker pixels, so widening the host whitelist is safe.
        const HOST_OK = /(?:storyblocks\.com|storyblockscdn|videoblocks|cloudfront\.net|fastly\.net|akamaized\.net|akamaihd\.net|sb-video|s3[.-][a-z0-9-]*amazonaws\.com|amazonaws\.com\/videoblocks)/i;

        // Match the clean asset. STRICT rules:
        //  - must be on a Storyblocks-affiliated host
        //  - must NOT be in /watermarks/, /thumbnails/, /preview/, etc.
        //  - must end in a real video extension (.mp4 / .mov / .webm / .mkv
        //    / .m4v), with optional querystring token
        //  - OR hit an explicit /api/.../download endpoint
        //  - OR live in a known Storyblocks video bucket
        // Broad path matches like /assets/ or /video/ are NOT enough — they
        // catch thumbnails (S7 attempt 1) and webpack code-split chunks
        // (S7 attempt 2). When in doubt, miss; the diagnostic log + popup
        // counter will tell us what to widen.
        const VIDEO_EXT = /\.(?:mp4|mov|webm|mkv|m4v)(?:\?|#|$)/i;
        const ASSET_EXT = /\.(?:jpe?g|png|webp|gif|svg|ico|css|js|mjs|json|map|woff2?|ttf|otf|html?)(?:\?|#|$)/i;
        const BAD_PATH = /\/(?:watermarks?|thumbnails?|previews?|posters?|stills?|sprites?|assets?\/build|static\/build|chunks?)\//i;
        const VIDEO_BUCKET = /(?:videoblocks-public|sb-video|videoblocks-prod)/i;
        const DOWNLOAD_ENDPOINT = /\/api\/[^?]*\/download(?:\b|\/)/i;
        const DOWNLOAD_HINT = /(?:download|dl=|response-content-disposition=attachment)/i;
        const looksLikeClean = (u) => {
            if (!u) return false;
            if (!HOST_OK.test(u)) return false;
            if (BAD_PATH.test(u)) return false;
            if (ASSET_EXT.test(u)) return false;
            if (VIDEO_EXT.test(u)) return true;
            if (VIDEO_BUCKET.test(u)) return true;
            if (DOWNLOAD_ENDPOINT.test(u)) return true;
            return false;
        };
        const looksLikeExplicitDownload = (u, anchor = {}) => {
            if (!looksLikeClean(u)) return false;
            const text = String(`${anchor.text || ''} ${anchor.attrs || ''}`).toLowerCase();
            if (DOWNLOAD_ENDPOINT.test(u)) return true;
            if (DOWNLOAD_HINT.test(u)) return true;
            if (anchor.download === true) return true;
            if (/\bdownload\b|t(?:e|é)l(?:e|é)charger|descargar|herunterladen|scarica|baixar/i.test(text)) return true;
            return false;
        };
        const looksLikeAttachmentResponse = (u, headers = {}) => {
            if (!looksLikeClean(u)) return false;
            const ct = String(headers['content-type'] || '').toLowerCase();
            const cd = String(headers['content-disposition'] || '').toLowerCase();
            if (/^(?:text|image|application\/(?:javascript|json|xml|x-www|wasm))/.test(ct)) return false;
            if (/attachment/.test(cd)) return true;
            if (DOWNLOAD_ENDPOINT.test(u)) return true;
            return false;
        };
        const findDirectCleanUrl = async (stage) => {
            if (intercepted) return true;
            try {
                const anchors = await page.evaluate(() => {
                    const absUrl = (value) => {
                        const raw = String(value || '').trim();
                        if (!raw || /^(?:data|blob):/i.test(raw)) return '';
                        try { return new URL(raw, location.href).href; }
                        catch (_) { return ''; }
                    };
                    const values = [];
                    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
                        const href = absUrl(a.href || a.getAttribute('href'));
                        if (!href) continue;
                        values.push({
                            href,
                            text: String(a.textContent || '').replace(/\s+/g, ' ').trim(),
                            attrs: [
                                a.getAttribute('aria-label'),
                                a.getAttribute('data-testid'),
                                a.getAttribute('download'),
                            ].filter(Boolean).join(' '),
                            download: a.hasAttribute('download'),
                        });
                    }
                    return values;
                });
                const found = (anchors || []).find(item => looksLikeExplicitDownload(item.href, item));
                if (found?.href) {
                    intercepted = found.href;
                    interceptedVia = stage;
                    return true;
                }
            } catch (_) {}
            return false;
        };

        const onReq = (req) => {
            if (intercepted || !captureArmed) return;
            const u = req.url();
            if (looksLikeExplicitDownload(u)) { intercepted = u; interceptedVia = 'request-download'; }
        };
        const onResp = (res) => {
            if (intercepted || !captureArmed) return;
            try {
                const u = res.url();
                // Some flows return the file from a non-mp4 URL but flag it via
                // Content-Disposition: attachment. Do not accept plain video/*
                // CDN responses here; those are frequently preview/autoplay
                // requests unrelated to the clip this worker is downloading.
                const h = res.headers() || {};
                if (looksLikeAttachmentResponse(u, h)) {
                    intercepted = u;
                    interceptedVia = /attachment/i.test(String(h['content-disposition'] || ''))
                        ? 'attachment'
                        : 'response-download';
                }
            } catch (_) {}
        };

        // Some clips trigger a download via popup/new tab. Attach listeners
        // only to popups opened by this page, so four parallel workers do not
        // accidentally steal each other's clean URLs.
        const popupPages = [];
        const browser = (typeof page.browser === 'function') ? page.browser() : null;
        const attachPopup = (popup) => {
            if (!popup) return;
            popupPages.push(popup);
            popup.on('request', onReq);
            popup.on('response', onResp);
        };
        const onPopup = (popup) => {
            try { attachPopup(popup); } catch (_) {}
        };
        const onTarget = async (target) => {
            if (intercepted) return;
            try {
                if (target.type && target.type() !== 'page') return;
                if (typeof target.opener === 'function') {
                    const opener = target.opener();
                    if (opener && opener !== page.target()) return;
                }
                const popup = await target.page();
                if (!popup) return;
                attachPopup(popup);
            } catch (_) {}
        };

        page.on('request', onReq);
        page.on('response', onResp);
        if (typeof page.on === 'function') page.on('popup', onPopup);
        if (browser && typeof browser.on === 'function') browser.on('targetcreated', onTarget);

        // CDP Browser.downloadWillBegin — fires the moment Chromium decides to
        // download a file, even for blob:/popup downloads. Most reliable
        // capture signal we have. We pull the URL right off the event payload.
        let cdpDownloadInfo = null;
        const onDownloadWillBegin = (event) => {
            if (intercepted || browserFileWinner) return;
            try {
                const u = event?.url || '';
                _rememberNativeDownloadCandidate(event?.suggestedFilename || '');
                _rememberNativeDownloadCandidate(u);
                if (!u) return;
                if (looksLikeClean(u)) {
                    intercepted = u;
                    interceptedVia = 'cdp-download-event';
                    return;
                }
                // Even if the URL doesn't pass the looksLikeClean filter (some
                // events report blob: or signed redirector URLs), record that
                // a download is in flight so the dir watcher upgrades it.
                cdpDownloadInfo = { url: u, guid: event?.guid, suggested: event?.suggestedFilename };
            } catch (_) {}
        };
        const cdpClient = page._sbCdpClient || null;
        if (cdpClient && typeof cdpClient.on === 'function') {
            try { cdpClient.on('Browser.downloadWillBegin', onDownloadWillBegin); } catch (_) {}
            try { cdpClient.on('Page.downloadWillBegin', onDownloadWillBegin); } catch (_) {}
        }

        try {
            if (isDead()) return null;
            const gotoTimeout = Math.min(CLIP_PAGE_TIMEOUT_MS, Math.max(2_000, remainingMs()));
            try {
                await page.goto(clipUrl, { waitUntil: 'domcontentloaded', timeout: gotoTimeout });
            } catch (_) { /* CF may interrupt; wait below */ }
            if (isDead()) return null;
            const cfBudget = Math.min(
                _cloudflareWarm ? CHALLENGE_RESOLVE_WARM_MS : CHALLENGE_RESOLVE_MAX_MS,
                Math.max(1_500, remainingMs()),
            );
            const ok = await _waitForRealPage(page, cfBudget, abortSignal);
            if (!ok) return null;
            if (isDead()) return null;
            await findDirectCleanUrl('dom');
            if (intercepted) {
                console.log(`  [Storyblocks] found ▶ DOM anchor · ${_shortHost(intercepted)}`);
            }

            // Click the clean Download button. Storyblocks subscribed UI labels
            // vary by locale (EN: "Download", FR: "Télécharger", ES: "Descargar",
            // DE: "Herunterladen", IT: "Scarica", PT: "Baixar"), so we match on
            // multilingual verbs and explicit data-test hooks before falling back
            // to resolution/MP4 hints.
            captureArmed = true;
            const clickResult = intercepted ? { clicked: false, via: 'dom-direct' } : await page.evaluate(() => {
                const all = Array.from(document.querySelectorAll('a, button, [role="button"]'));
                const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
                const VERB = /download|télécharger|telecharger|descargar|herunterladen|scarica|baixar|다운로드/i;
                const RES_HINT = /\b(hd|4k|1080p?|720p?|mp4)\b/i;
                const BAD = /watermark|filigrane|marca de agua|wasserzeichen|sign\s*up|sign\s*in|log\s*in|create\s*account|free\s*trial|subscribe|start\s*now|get\s*started|upgrade/i;
                const AUTH_BAD = /sign\s*up|sign\s*in|log\s*in|create\s*account|free\s*trial|subscribe|start\s*now|get\s*started|upgrade/i;
                // Rejects icon-only download menu triggers, share dropdowns,
                // favorites, project bins, cart, and CSV/Aftereffects/preview
                // export buttons that all carry "download" in their data-testid
                // but never deliver an MP4 when clicked.
                const ATTR_REJECT = /menu|dropdown|trigger|toggle|opener|wishlist|favorite|favourites?|bin|cart|share|save|copy|csv|after\s*effects?|premiere|preview|thumb|sprite|filter|email|invite|collab|comment|sidebar|popover|tooltip|history|recent|all\b|export\s*all/i;

                const candidates = all
                    .filter(el => !el.disabled && el.offsetParent !== null)
                    .map(el => ({
                        el,
                        txt: norm(el.textContent),
                        aria: norm(el.getAttribute('aria-label') || ''),
                        testid: norm(el.getAttribute('data-testid') || ''),
                        attrs: (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-testid') || ''),
                        rect: (() => { try { return el.getBoundingClientRect(); } catch (_) { return null; } })(),
                    }))
                    .map(c => ({
                        ...c,
                        // Effective label: prefer visible text, else aria-label, else NULL
                        effLabel: c.txt || c.aria || '',
                        size: c.rect ? Math.round(c.rect.width * c.rect.height) : 0,
                    }))
                    // Hide off-screen elements; the real button is always visible.
                    .filter(c => !c.rect || (c.rect.width > 0 && c.rect.height > 0));

                // ── PRIORITY 1: explicit "Download HD MP4" / "HD 1080" verb+res in TEXT
                const hdMp4 = candidates.find(c => VERB.test(c.txt) && RES_HINT.test(c.txt) && !BAD.test(c.txt));
                if (hdMp4) { hdMp4.el.click(); return { clicked: true, via: 'verb+res', label: hdMp4.txt.slice(0, 80) }; }

                // ── PRIORITY 2: EXACT known good data-testid (no menu/dropdown/share variants)
                // Storyblocks has historically used: download-button, download-link,
                // download-mp4-button, cta-download, hd-download, primary-download, etc.
                const KNOWN_GOOD_TESTID = /^(?:download(?:-(?:button|link|cta|mp4|hd|primary|main|action))?|hd-download|cta-download|primary-download)$/i;
                const exactTestid = candidates.find(c =>
                    KNOWN_GOOD_TESTID.test(c.testid)
                    && !BAD.test(c.attrs) && !BAD.test(c.txt)
                    && !ATTR_REJECT.test(c.testid)
                );
                if (exactTestid) {
                    exactTestid.el.click();
                    return { clicked: true, via: 'testid-exact', label: exactTestid.effLabel.slice(0, 80) || `[${exactTestid.testid}]` };
                }

                // ── PRIORITY 3: plain VERB in visible text (must have non-empty text)
                const verb = candidates.find(c => c.txt && VERB.test(c.txt) && !BAD.test(c.txt) && !AUTH_BAD.test(c.txt));
                if (verb) { verb.el.click(); return { clicked: true, via: 'verb-only', label: verb.txt.slice(0, 80) }; }

                // ── PRIORITY 4: aria-label match (icon buttons with proper labelling)
                const ariaMatch = candidates.find(c =>
                    c.aria
                    && VERB.test(c.aria)
                    && !BAD.test(c.aria)
                    && !AUTH_BAD.test(c.aria)
                    && !ATTR_REJECT.test(c.aria)
                    && !ATTR_REJECT.test(c.testid)
                );
                if (ariaMatch) {
                    ariaMatch.el.click();
                    return { clicked: true, via: 'aria-label', label: ariaMatch.aria.slice(0, 80) };
                }

                // ── PRIORITY 5: loose data-testid (broad "download" anywhere)
                // BUT reject menu/dropdown/share/etc — these are the
                // empty-label icon buttons that fail in production.
                const looseTestid = candidates.find(c =>
                    /download/i.test(c.testid)
                    && !ATTR_REJECT.test(c.testid)
                    && !BAD.test(c.attrs)
                    && !BAD.test(c.txt)
                );
                if (looseTestid) {
                    looseTestid.el.click();
                    return { clicked: true, via: 'testid-loose', label: looseTestid.effLabel.slice(0, 80) || `[${looseTestid.testid}]` };
                }

                // ── Detect logged-out CTA so caller surfaces a "refresh cookies" hint
                const authCta = candidates.find(c => {
                    const label = `${c.txt} ${c.attrs}`;
                    return AUTH_BAD.test(label) && VERB.test(label);
                });
                if (authCta) {
                    return {
                        clicked: false,
                        authWall: true,
                        label: authCta.txt.slice(0, 60),
                        sample: candidates.slice(0, 8).map(c => c.txt).filter(Boolean).slice(0, 8),
                    };
                }

                return {
                    clicked: false,
                    sample: candidates
                        .filter(c => VERB.test(`${c.txt} ${c.attrs}`))
                        .slice(0, 8)
                        .map(c => `${c.txt || '∅'}|${c.testid || c.aria || ''}`)
                        .filter(Boolean),
                };
            }).catch(() => ({ clicked: false, sample: ['evaluate-threw'] }));
            const primaryClicked = !!clickResult?.clicked;
            if (!primaryClicked && !intercepted) captureArmed = false;
            if (!intercepted) {
                await new Promise(r => setTimeout(r, primaryClicked ? 900 : 150));
                await findDirectCleanUrl('dom-after-primary-click');
            }

            // Subscribed downloads may open a small modal asking for resolution
            // — wait, then click the highest available option.
            const modalTry = async () => {
                return await page.evaluate(() => {
                    const buttons = Array.from(document.querySelectorAll('button, a, [role="button"]'));
                    const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
                    const VERB = /download|télécharger|telecharger|descargar|herunterladen|scarica|baixar|다운로드/i;
                    const BAD = /watermark|filigrane|marca de agua|wasserzeichen|sign\s*up|sign\s*in|log\s*in|create\s*account|free\s*trial|subscribe|start\s*now|get\s*started|upgrade/i;
                    const visible = buttons.filter(b => !b.disabled && b.offsetParent !== null);
                    const scoreResolution = (text) => {
                        const t = String(text || '').toLowerCase();
                        if (/hd\s*mp4|h\.?264|h264|1080|720/.test(t)) return 5;
                        if (/4k\s*mp4/.test(t) && !/mov|prores/.test(t)) return 4;
                        if (/\bmp4\b/.test(t)) return 3;
                        if (/hd|4k/.test(t)) return 2;
                        return 0;
                    };
                    const resPick = visible
                        .map(el => ({ el, txt: norm(el.textContent), score: scoreResolution(norm(el.textContent)) }))
                        .filter(c => c.score > 0 && !VERB.test(c.txt) && !BAD.test(c.txt))
                        .sort((a, b) => b.score - a.score)[0];
                    if (resPick) {
                        try { resPick.el.click(); } catch (_) {}
                    }
                    const downloadPick = visible.find(b => {
                        const t = norm(b.textContent);
                        return VERB.test(t) && !BAD.test(t);
                    });
                    const pick = downloadPick || resPick?.el || null;
                    if (pick) { pick.click(); return { clicked: true, label: norm(pick.textContent).slice(0, 60), selected: resPick?.txt || '' }; }
                    return { clicked: false };
                }).catch(() => ({ clicked: false }));
            };
            // Multi-stage modal probe: Storyblocks modal often lags 1-3s after
            // the primary click. We probe at 800ms / 1.8s / 3s / 4.5s so a slow
            // render doesn't make us bail before the resolution chooser appears.
            let modalResult = null;
            const MODAL_PROBE_DELAYS = [800, 1000, 1200, 1500];
            for (let i = 0; i < MODAL_PROBE_DELAYS.length && !intercepted; i++) {
                await new Promise(r => setTimeout(r, MODAL_PROBE_DELAYS[i]));
                if (isDead()) return null;
                if (intercepted) break;
                captureArmed = true;
                const r = await modalTry();
                if (r?.clicked) {
                    modalResult = r;
                    // Some resolution pickers need a second click on a confirm CTA.
                    await new Promise(rr => setTimeout(rr, 400));
                    if (intercepted) break;
                    const confirmResult = await page.evaluate(() => {
                        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
                        const VERB = /download|telecharger|descargar|herunterladen|scarica|baixar/i;
                        const BAD = /watermark|filigrane|marca de agua|wasserzeichen|sign\s*up|sign\s*in|log\s*in|create\s*account|free\s*trial|subscribe|start\s*now|get\s*started|upgrade/i;
                        const controls = Array.from(document.querySelectorAll('button, a, [role="button"]'))
                            .filter(el => !el.disabled && el.offsetParent !== null)
                            .map(el => ({ el, txt: norm(el.textContent), attrs: (el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('data-testid') || '') }));
                        const pick = controls.find(c => VERB.test(`${c.txt} ${c.attrs}`) && !BAD.test(`${c.txt} ${c.attrs}`));
                        if (!pick) return { clicked: false };
                        pick.el.click();
                        return { clicked: true, label: pick.txt.slice(0, 60) };
                    }).catch(() => ({ clicked: false }));
                    if (confirmResult?.clicked) modalResult.confirm = confirmResult;
                    break;
                }
                // Re-probe the page DOM for direct download anchors that may have
                // been injected after primary click.
                await findDirectCleanUrl(`dom-probe-${i}`);
            }
            if (!modalResult?.clicked && !intercepted && !primaryClicked) captureArmed = false;
            if (!intercepted) await findDirectCleanUrl('dom-after-modal-click');

            const captureBudget = Math.min(PER_CLIP_CAPTURE_MS, Math.max(500, remainingMs()));
            const t0 = Date.now();
            let lastDomProbeAt = 0;
            let lastDownloadProbeAt = 0;
            while (!intercepted && !browserFileWinner && Date.now() - t0 < captureBudget) {
                if (isDead()) return null;
                if (Date.now() - lastDomProbeAt > 1_000) {
                    lastDomProbeAt = Date.now();
                    await findDirectCleanUrl('dom-capture-loop');
                }
                // Parallel browser-download watcher: catch downloads that fire
                // via blob:/popup that we can't read URLs from. The download
                // dir is per-clip so we never collide with sibling workers.
                if (watchDownloadDir && Date.now() - lastDownloadProbeAt > 500) {
                    lastDownloadProbeAt = Date.now();
                    try {
                        const files = _listRecentVideoDownloads(watchDownloadDir, watchStartedMs);
                        if (files.length && !fs.existsSync(`${files[0].filePath}.crdownload`)) {
                            browserFileWinner = files[0].filePath;
                            break;
                        }
                    } catch (_) {}
                }
                await new Promise(r => setTimeout(r, 250));
            }

            if (browserFileWinner) {
                console.log(`  [Storyblocks] won ▶ browser-dl · ${path.basename(browserFileWinner)}`);
                _authWallHits = 0;
                const meta = await page.evaluate(() => {
                    const title = (document.querySelector('h1')?.textContent || '').trim();
                    const idMatch = (document.body.innerText.match(/SBV-\d+/) || [])[0] || null;
                    return { title, stockId: idMatch };
                }).catch(() => ({ title: '', stockId: null }));
                return {
                    id: meta.stockId || clipUrl.split('/').pop().slice(0, 64),
                    url: null,
                    browserFile: browserFileWinner,
                    width: 1920,
                    height: 1080,
                    title: meta.title,
                    _sourcePage: clipUrl,
                    _provider: 'storyblocks',
                };
            }

            if (!intercepted) {
                // Human-readable diagnostic. Tells us exactly which click path
                // ran, what label was clicked, whether a modal opened, and how
                // many popups appeared — without dumping raw JSON.
                const parts = [];
                if (clickResult?.clicked) {
                    const lbl = clickResult.label || '(no label)';
                    parts.push(`primary click via ${clickResult.via} → "${lbl}"`);
                } else {
                    parts.push('no primary click');
                }
                if (modalResult?.clicked) {
                    const lbl = modalResult.label || '(no label)';
                    parts.push(`modal click → "${lbl}"`);
                    if (modalResult.selected) parts.push(`picked res "${modalResult.selected}"`);
                    if (modalResult.confirm?.clicked) parts.push(`confirm → "${modalResult.confirm.label}"`);
                } else {
                    parts.push('no modal');
                }
                if (popupPages.length) parts.push(`${popupPages.length} popup(s)`);
                console.log(`  [Storyblocks] miss   ▶ ${_clipLabel(clipUrl)} · ${parts.join(' · ')}`);
                if (clickResult?.authWall) {
                    return { url: null, authWall: true, label: clickResult.label || '' };
                }
                return null;
            }
            console.log(`  [Storyblocks] won ▶ ${interceptedVia} · ${_shortHost(intercepted)}`);
            _authWallHits = 0;

            const meta = await page.evaluate(() => {
                const title = (document.querySelector('h1')?.textContent || '').trim();
                const idMatch = (document.body.innerText.match(/SBV-\d+/) || [])[0] || null;
                return { title, stockId: idMatch };
            });

            return {
                id: meta.stockId || clipUrl.split('/').pop().slice(0, 64),
                url: intercepted,
                width: 1920,                // assume HD; downstream probes the real file anyway
                height: 1080,
                title: meta.title,
                _sourcePage: clipUrl,
                _provider: 'storyblocks',
                // NB: no _isPreview flag — vision scoring re-engages on these clips
            };
        } finally {
            try { page.off('request', onReq); } catch (_) {}
            try { page.off('response', onResp); } catch (_) {}
            try { page.off('popup', onPopup); } catch (_) {}
            if (browser && typeof browser.off === 'function') {
                try { browser.off('targetcreated', onTarget); } catch (_) {}
            }
            if (cdpClient && typeof cdpClient.off === 'function') {
                try { cdpClient.off('Browser.downloadWillBegin', onDownloadWillBegin); } catch (_) {}
                try { cdpClient.off('Page.downloadWillBegin', onDownloadWillBegin); } catch (_) {}
            }
            for (const p of popupPages) {
                try { p.off('request', onReq); } catch (_) {}
                try { p.off('response', onResp); } catch (_) {}
                try { await p.close({ runBeforeUnload: false }); } catch (_) {}
            }
        }
    }
}

module.exports = StoryblocksVideoProvider;
module.exports.closeStoryblocksBrowser = closeStoryblocksBrowser;
module.exports.purgeStoryblocksDownloadLeaks = purgeStoryblocksDownloadLeaks;
module.exports.prewarmStoryblocksBrowser = prewarmStoryblocksBrowser;
module.exports.isStoryblocksAuthDead = isStoryblocksAuthDead;
module.exports.getStoryblocksAuthDeadReason = getStoryblocksAuthDeadReason;
