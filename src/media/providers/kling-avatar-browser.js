/**
 * Kling AI-Human (Avatar) — BROWSER BRIDGE.
 *
 * Drives the Kling AI web UI (kling.ai / app.klingai.com "AI Human" tool) headless
 * with a saved login session and turns it into a pseudo-API:
 *
 *     generateAvatarClip({ imageFile, audioFile, outFile }) -> outFile
 *
 * i.e. presenter photo + a narration audio slice -> a lip-synced talking-avatar
 * MP4, spending the credits on the logged-in consumer account (no paid API key).
 *
 * Same puppeteer-core + saved-cookie pattern as src/providers/storyblocks-video.js.
 * Session cookies come from `npm run kling-cookies` (.kling-cookies.json).
 *
 * IMPORTANT — this automates a third-party web UI I can't see the live DOM of, so
 * the selectors are best-effort with MULTIPLE fallbacks + heavy logging. First run:
 *     KLING_DEBUG=1 node src/providers/kling-avatar-browser.js <image> <audio> <out.mp4>
 * runs HEADED, dumps the page's file-inputs/buttons, and screenshots each step to
 * temp/.kling-avatar/debug-*.png so we can tune the selectors together in 2-3 passes.
 *
 * Flags:
 *   KLING_COOKIE_FILE   path to cookies (default .kling-cookies.json)
 *   KLING_AVATAR_URL    the AI-Human page (default app.klingai.com/global/ai-human)
 *   KLING_DEBUG=1       headed + screenshots + verbose DOM inventory
 *   KLING_GEN_TIMEOUT_MS generation wait cap (default 480000 = 8 min)
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createByteLimitTransform, requestSafeStream } = require('../../security/safe-download');

const COOKIE_FILE = () => process.env.KLING_COOKIE_FILE || path.join(process.cwd(), '.kling-cookies.json');
const AVATAR_URL = () => process.env.KLING_AVATAR_URL || 'https://kling.ai/app/ai-human/new';
const GEN_TIMEOUT_MS = () => Math.max(60_000, parseInt(process.env.KLING_GEN_TIMEOUT_MS || '480000', 10) || 480_000);
const WORK_DIR = () => path.join(process.env.PROJECT_DIR ? path.resolve(process.env.PROJECT_DIR) : process.cwd(), 'temp', '.kling-avatar');
const RESOLUTION = () => (process.env.KLING_RESOLUTION || '1080p').trim();   // creator default: 1080p
const PROMPT = () => (process.env.KLING_AVATAR_PROMPT || '').trim();          // optional delivery-style prompt

function _findChrome() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) return process.env.PUPPETEER_EXECUTABLE_PATH;
    const PF = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const PF86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const LOCAL = process.env['LOCALAPPDATA'] || '';
    const cands = process.platform === 'win32' ? [
        path.join(PF, 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(PF86, 'Google\\Chrome\\Application\\chrome.exe'),
        LOCAL && path.join(LOCAL, 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(PF, 'Microsoft\\Edge\\Application\\msedge.exe'),
    ].filter(Boolean) : process.platform === 'darwin' ? [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/microsoft-edge'];
    return cands.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } }) || null;
}

function _loadCookiesRaw() {
    const f = COOKIE_FILE();
    if (!fs.existsSync(f)) return null;
    try {
        const c = JSON.parse(fs.readFileSync(f, 'utf8'));
        return Array.isArray(c) && c.length ? c : null;
    } catch (_) { return null; }
}

function cookiesPresent() { return !!_loadCookiesRaw(); }

function _cookieHeader() {
    const raw = _loadCookiesRaw() || [];
    return raw.filter(c => c && c.name && c.value !== undefined).map(c => `${c.name}=${c.value}`).join('; ');
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── DOM helpers (run in-page). Kept defensive: multiple strategies + logging. ──
async function _inventory(page) {
    // Dump what the page actually exposes so selector tuning is data-driven.
    try {
        return await page.evaluate(() => {
            const fileInputs = Array.from(document.querySelectorAll('input[type=file]')).map((el, i) => ({
                i, accept: el.accept || '', name: el.name || '', id: el.id || '',
                visible: !!(el.offsetParent || el.getClientRects().length),
            }));
            const buttons = Array.from(document.querySelectorAll('button, [role=button], a')).map(b => (b.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 60);
            const videos = Array.from(document.querySelectorAll('video')).map(v => v.currentSrc || v.src || '').filter(Boolean);
            return { fileInputs, buttons, videos, url: location.href };
        });
    } catch (e) { return { error: e.message }; }
}

async function _clickByText(page, patterns) {
    // Click the first button/role=button/a whose visible text matches any pattern.
    return page.evaluate((pats) => {
        const res = pats.map(p => new RegExp(p, 'i'));
        const els = Array.from(document.querySelectorAll('button, [role=button], a, span'));
        for (const el of els) {
            const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
            if (t && res.some(r => r.test(t)) && (el.offsetParent || el.getClientRects().length)) {
                (el.closest('button,[role=button],a') || el).click();
                return t;
            }
        }
        return null;
    }, patterns);
}

// Click the REAL green ENABLED action button ("20 Generate"), NOT the sidebar nav
// "Generate". Uses a real puppeteer element-click (dispatches proper mouse events →
// triggers React) on the handle, so a disabled/covered button can't be mis-clicked.
async function _clickGenerate(page) {
    const handle = await page.evaluateHandle(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const vis = (b) => !!(b.offsetParent || b.getClientRects().length);
        const enabled = (b) => !(b.disabled || b.getAttribute('aria-disabled') === 'true' || /disabled/i.test(b.className));
        const all = Array.from(document.querySelectorAll('button, [role=button]'));
        // 1st choice: an enabled, visible "N Generate" (the green credit-cost action button).
        let win = all.find((b) => vis(b) && enabled(b) && /\d+\s*generate/i.test(norm(b.textContent)));
        // 2nd: an enabled short "Generate" button that is NOT the sidebar nav item.
        if (!win) win = all.find((b) => b.tagName === 'BUTTON' && vis(b) && enabled(b) && /^\W*generate\W*$/i.test(norm(b.textContent)));
        return win || null;
    });
    const el = handle.asElement();
    if (!el) { try { await handle.dispose(); } catch (_) {} return null; }
    const label = await page.evaluate((b) => (b.textContent || '').replace(/\s+/g, ' ').trim(), el).catch(() => 'Generate');
    try { await el.click({ delay: 30 }); }
    catch (_) { try { await page.evaluate((b) => b.click(), el); } catch (__) {} }
    try { await handle.dispose(); } catch (_) {}
    return label;
}

async function _pickFileInput(page, kind /* 'image'|'audio' */) {
    // Return an ElementHandle for a file input that accepts this media kind.
    const handles = await page.$$('input[type=file]');
    for (const h of handles) {
        const accept = (await page.evaluate(el => el.accept || '', h)).toLowerCase();
        if (kind === 'image' && (accept.includes('image') || accept.includes('png') || accept.includes('jpg') || accept.includes('jpeg'))) return h;
        if (kind === 'audio' && (accept.includes('audio') || accept.includes('mp3') || accept.includes('wav') || accept.includes('.m4a'))) return h;
    }
    // No accept attr → fall back to positional (image inputs usually precede audio).
    if (handles.length) {
        if (kind === 'image') return handles[0];
        if (kind === 'audio') return handles[handles.length - 1];
    }
    return null;
}

async function _screenshot(page, tag, log) {
    if (!/^(1|true|on|yes)$/i.test(String(process.env.KLING_DEBUG || ''))) return;
    try {
        fs.mkdirSync(WORK_DIR(), { recursive: true });
        const p = path.join(WORK_DIR(), `debug-${tag}-${Date.now()}.png`);
        await page.screenshot({ path: p, fullPage: false });
        log(`  [Kling] debug screenshot → ${p}`);
    } catch (_) {}
}

async function _downloadWithCookies(url, outFile, timeoutMs = 120_000) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8',
        'Referer': 'https://app.klingai.com/',
    };
    const ck = _cookieHeader();
    if (ck) headers['Cookie'] = ck;
    const maxBytes = 2 * 1024 * 1024 * 1024;
    const res = await requestSafeStream(url, {
        method: 'GET',
        adapter: 'http',
        timeout: timeoutMs,
        headers,
    }, { maxRedirects: 10, maxBytes });
    const ct = res.headers['content-type'] || '';
    if (ct.includes('text/html') || ct.includes('application/json')) throw new Error(`result URL returned ${ct}, not video`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const writer = fs.createWriteStream(outFile);
    const limiter = createByteLimitTransform(maxBytes);
    res.data.pipe(limiter).pipe(writer);
    limiter.on('error', (error) => writer.destroy(error));
    await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
    const st = fs.statSync(outFile);
    if (st.size < 10_000) { try { fs.unlinkSync(outFile); } catch (_) {} throw new Error(`downloaded clip too small (${st.size}B)`); }
    return outFile;
}

function _ffmpeg() {
    try { return require('ffmpeg-static'); } catch (_) { return process.env.FFMPEG_PATH || 'ffmpeg'; }
}
function _imageDims(ff, f) {
    try {
        const out = require('child_process').execFileSync(ff, ['-hide_banner', '-i', f], { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
        const m = out.match(/(\d{2,5})x(\d{2,5})/); return m ? [+m[1], +m[2]] : null;
    } catch (e) {
        const m = String(e.stderr || '').match(/(\d{2,5})x(\d{2,5})/); return m ? [+m[1], +m[2]] : null;
    }
}
// Kling AI-Human rejects images whose SHORT side ≤ 300px ("Short side must exceed
// 300 pixels"). Upscale (lanczos) so the short side clears that with margin, letting
// a low-res presenter photo pass. No-op when the image is already big enough.
function _ensureMinSize(imageFile, log) {
    const MIN = 512, THRESH = 320;
    const ff = _ffmpeg();
    const dims = _imageDims(ff, imageFile);
    if (!dims) { log('  [Kling] (could not probe image dims; using as-is)'); return imageFile; }
    const [w, h] = dims;
    if (Math.min(w, h) >= THRESH) return imageFile;
    const scale = MIN / Math.min(w, h);
    const nw = Math.round(w * scale / 2) * 2, nh = Math.round(h * scale / 2) * 2;
    const out = path.join(WORK_DIR(), `presenter-upscaled-${nw}x${nh}.jpg`);
    try {
        fs.mkdirSync(WORK_DIR(), { recursive: true });
        require('child_process').execFileSync(ff, ['-y', '-i', imageFile, '-vf', `scale=${nw}:${nh}:flags=lanczos`, '-q:v', '2', out], { stdio: 'ignore', timeout: 60_000 });
        if (fs.existsSync(out) && fs.statSync(out).size > 2000) { log(`  [Kling] upscaled presenter ${w}x${h} → ${nw}x${nh} (Kling needs short side >300px)`); return out; }
    } catch (e) { log(`  [Kling] upscale failed (${e.message}); using original`); }
    return imageFile;
}

async function _dismissModals(page, log) {
    // Kling shows promo modals ("Meet MCP & CLI", "Daily Free Credits"). Dismiss ONLY
    // clear promo buttons — NOT arbitrary "close"-class icons (those can collapse the
    // tool panel and hide the Generate button).
    try { await page.keyboard.press('Escape'); } catch (_) {}
    await sleep(250);
    try {
        const n = await page.evaluate(() => {
            let clicked = 0;
            for (const el of Array.from(document.querySelectorAll('button, [role=button], span, div'))) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (/^(got it|close|skip|maybe later|no thanks|dismiss|×|✕|✖|x)$/i.test(t) && (el.offsetParent || el.getClientRects().length)) {
                    try { (el.closest('button,[role=button]') || el).click(); clicked++; } catch (_) {}
                }
            }
            return clicked;
        });
        if (n && log) log(`  [Kling] dismissed ${n} promo(s)`);
    } catch (_) {}
    await sleep(250);
}

async function _waitHydrated(page, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const ready = await page.evaluate(() => {
            if (document.querySelector('input[type=file]')) return true;
            const t = document.body ? (document.body.innerText || '') : '';
            return /upload image|add facial|avatar library|input the text/i.test(t);
        }).catch(() => false);
        if (ready) return true;
        await sleep(1000);
    }
    return false;
}

// Audio upload to Kling's server takes seconds; Generate stays DISABLED until it
// finishes ("Uploading…" spinner → "Replace Audio" + a 0:0X duration once done).
async function _waitAudioReady(page, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const st = await page.evaluate(() => {
            const t = document.body ? (document.body.innerText || '') : '';
            return {
                uploading: /uploading/i.test(t),
                ready: /replace audio/i.test(t) || !!document.querySelector('audio') || /\b\d:\d\d\b/.test(t),
            };
        }).catch(() => ({ uploading: true, ready: false }));
        if (!st.uploading && st.ready) return true;
        await sleep(1000);
    }
    return false;
}

// Poll until the green "N Generate" ACTION button is present AND enabled (not the
// greyed placeholder shown while inputs are still processing).
async function _waitGenerateEnabled(page, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const en = await page.evaluate(() => {
            for (const b of Array.from(document.querySelectorAll('button, [role=button]'))) {
                const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
                if (!/\d+\s*generate/i.test(t)) continue;                  // the credit-cost action button
                const vis = !!(b.offsetParent || b.getClientRects().length);
                const disabled = b.disabled || b.getAttribute('aria-disabled') === 'true' || /disabled/i.test(b.className);
                if (vis && !disabled) return true;
            }
            return false;
        }).catch(() => false);
        if (en) return true;
        await sleep(1000);
    }
    return false;
}

// Did the generation actually start after we clicked? (progress text, or the
// action button becoming disabled/gone). Used to retry a click that didn't register.
async function _genStarted(page) {
    return page.evaluate(() => {
        const t = document.body ? (document.body.innerText || '') : '';
        if (/generating|in queue|queuing|processing|creating|rendering|%|estimated/i.test(t)) return true;
        const b = Array.from(document.querySelectorAll('button, [role=button]')).find(x => /\d+\s*generate/i.test((x.textContent || '')));
        if (!b) return true;
        return b.disabled || b.getAttribute('aria-disabled') === 'true';
    }).catch(() => false);
}

// Fill the "Avatar Prompt (Optional)" delivery-style field. Best-effort + NON-FATAL,
// and it will NEVER touch the "type what the character says" TTS box (that would make
// Kling use a synthetic voice instead of the uploaded narration).
async function _setPrompt(page, prompt, log) {
    if (!prompt) return;
    try {
        const ok = await page.evaluate((txt) => {
            const inputs = Array.from(document.querySelectorAll('textarea, input[type=text]'));
            const field = inputs.find((el) => {
                const hint = ((el.placeholder || '') + ' ' + (el.getAttribute('aria-label') || '')).toLowerCase();
                if (/character to say|text you'?d like|speech|\bsay\b/.test(hint)) return false; // TTS box — never touch
                return /prompt|describe|style|deliver|gesture|expression|emotion|optional/.test(hint);
            });
            if (!field) return false;
            const proto = field.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
            Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, txt);
            field.dispatchEvent(new Event('input', { bubbles: true }));
            field.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        }, prompt);
        log(ok ? '  [Kling] set delivery prompt' : '  [Kling] (avatar-prompt field not found — skipping, non-fatal)');
    } catch (_) {}
}

// Pick the resolution from the "720p + 30FPS · 1" dropdown (creator default 1080p).
// Best-effort + NON-FATAL; always Escape after so a stuck-open dropdown can't block Generate.
async function _setResolution(page, res, log) {
    const target = /1080/.test(res) ? '1080' : (/720/.test(res) ? '720' : null);
    if (!target) return;
    try {
        const opened = await page.evaluate(() => {
            const el = Array.from(document.querySelectorAll('button, [role=button], div, span')).find((x) => {
                const t = (x.textContent || '').replace(/\s+/g, ' ').trim();
                return /\d{3,4}p\b.*\bfps/i.test(t) && t.length < 40 && (x.offsetParent || x.getClientRects().length);
            });
            if (el) { (el.closest('button,[role=button]') || el).click(); return true; }
            return false;
        });
        if (!opened) { log('  [Kling] (resolution dropdown not found — using Kling default)'); return; }
        await sleep(700);
        const picked = await page.evaluate((tp) => {
            const re = new RegExp('^\\s*' + tp + 'p\\b', 'i');
            const opt = Array.from(document.querySelectorAll('li, [role=option], div, span, button')).find((x) => {
                const t = (x.textContent || '').replace(/\s+/g, ' ').trim();
                return t.length < 24 && re.test(t) && (x.offsetParent || x.getClientRects().length);
            });
            if (opt) { (opt.closest('li,[role=option],button') || opt).click(); return true; }
            return false;
        }, target);
        log(picked ? `  [Kling] resolution → ${target}p` : `  [Kling] (${target}p option not found — using default)`);
        await sleep(400);
    } catch (_) {}
    try { await page.keyboard.press('Escape'); } catch (_) {}
    await sleep(200);
}

/**
 * Generate ONE lip-synced avatar clip. Throws on any failure (caller falls back
 * to the static presenter image, so a build never breaks).
 */
async function generateAvatarClip({ imageFile, audioFile, outFile, log } = {}) {
    log = typeof log === 'function' ? log : (m) => console.log(m);
    if (!imageFile || !fs.existsSync(imageFile)) throw new Error(`presenter image missing: ${imageFile}`);
    if (!audioFile || !fs.existsSync(audioFile)) throw new Error(`audio slice missing: ${audioFile}`);
    if (!cookiesPresent()) throw new Error('no Kling cookies — run `npm run kling-cookies` first');

    // Kling requires the image short side >300px — auto-upscale a low-res photo.
    const preparedImage = _ensureMinSize(path.resolve(imageFile), log);

    const exe = _findChrome();
    if (!exe) throw new Error('no system Chrome/Edge found for the Kling bridge');
    const puppeteer = require('puppeteer-core');
    const headed = /^(1|true|on|yes)$/i.test(String(process.env.KLING_DEBUG || ''));

    const browser = await puppeteer.launch({
        executablePath: exe,
        headless: headed ? false : 'new',
        defaultViewport: headed ? null : { width: 1440, height: 1000 },
        args: ['--disable-blink-features=AutomationControlled', '--lang=en-US,en', headed ? '--start-maximized' : ''].filter(Boolean),
    });

    let resultUrl = null;
    let genClicked = false;      // only trust captures AFTER we click Generate
    let genAt = 0;               // timestamp of the Generate click
    const seenMp4 = new Set();   // kling mp4s present BEFORE our gen (history/previews) — never our result
    const MIN_WAIT_MS = Math.max(15_000, parseInt(process.env.KLING_MIN_WAIT_MS || '25000', 10) || 25_000);
    try {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        // Set cookies for every Kling domain we captured.
        const raw = _loadCookiesRaw() || [];
        try { await page.setCookie(...raw.map(c => ({ ...c }))); } catch (e) { log(`  [Kling] setCookie warn: ${e.message}`); }

        // Capture any generated-video URL that flies by on the network (most
        // reliable "done" signal + the URL we then download with cookies).
        const RESULT_RE = /\.(?:mp4|mov)(?:\?|$)/i;
        const _isKlingMp4 = (u, ct) => (RESULT_RE.test(u) || (ct || '').includes('video/mp4')) && /kling|klingai|kwai|kuaishou|cdn/i.test(u);
        page.on('response', (res) => {
            try {
                const u = res.url();
                if (!_isKlingMp4(u, (res.headers()['content-type'] || '').toLowerCase())) return;
                const base = u.split('?')[0];
                if (!genClicked) { seenMp4.add(base); return; }      // pre-gen asset — remember, never use
                if (seenMp4.has(base)) return;                        // pre-existing video, not our result
                if (Date.now() - genAt < MIN_WAIT_MS) return;         // too soon — a real generation takes longer
                if (!resultUrl) { resultUrl = u; log(`  [Kling] captured NEW result URL: ${u.slice(0, 120)}…`); }
            } catch (_) {}
        });

        log(`  [Kling] opening ${AVATAR_URL()} …`);
        await page.goto(AVATAR_URL(), { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
        await sleep(1500);
        await _dismissModals(page, log);                 // close the "Meet MCP & CLI" promo modal
        const hydrated = await _waitHydrated(page, 30_000); // WAIT for the SPA to mount (page is black for a few s)
        if (!hydrated) log('  [Kling] page did not fully hydrate in 30s — proceeding anyway');
        await _dismissModals(page, log);
        await _screenshot(page, '1-loaded', log);

        if (headed) log(`  [Kling] page inventory: ${JSON.stringify(await _inventory(page)).slice(0, 800)}`);

        // Guard: if we got bounced to a login screen, cookies are stale.
        const url0 = page.url();
        if (/\/(login|sign-?in|passport)/i.test(url0)) throw new Error('bounced to login — cookies stale, re-run `npm run kling-cookies`');

        // 1) Upload presenter image.
        let imgInput = await _pickFileInput(page, 'image');
        if (!imgInput) {
            // Some UIs only mount the input after clicking an "Upload Image" affordance.
            await _clickByText(page, ['upload image', 'add.*image', 'add facial', 'upload photo']);
            await sleep(1200);
            imgInput = await _pickFileInput(page, 'image');
        }
        if (!imgInput) throw new Error('could not find the image upload input (selector tuning needed — run with KLING_DEBUG=1)');
        await imgInput.uploadFile(preparedImage);
        log('  [Kling] uploaded presenter image');
        await sleep(3000);
        await _screenshot(page, '2-image', log);
        // Fail fast if Kling rejected the image (size/format) — don't waste a Generate credit.
        const imgErr = await page.evaluate(() => {
            const t = document.body ? (document.body.innerText || '') : '';
            const m = t.match(/upload failed[^\n]{0,80}|short side[^\n]{0,60}|exceed \d+ pixels[^\n]{0,40}|not supported[^\n]{0,40}/i);
            return m ? m[0] : null;
        }).catch(() => null);
        if (imgErr) throw new Error(`Kling rejected the presenter image: "${imgErr.trim()}"`);

        // 2) Upload audio (reveal the audio input first if needed).
        await _clickByText(page, ['upload audio', 'local audio', 'add audio', 'voiceover', 'upload voice']);
        await sleep(1200);
        let audInput = await _pickFileInput(page, 'audio');
        if (!audInput) { await sleep(1500); audInput = await _pickFileInput(page, 'audio'); }
        if (!audInput) throw new Error('could not find the audio upload input (selector tuning needed — run with KLING_DEBUG=1)');
        await audInput.uploadFile(path.resolve(audioFile));
        log('  [Kling] uploaded narration audio');
        await sleep(3000);
        await _screenshot(page, '3-audio', log);

        // Creator controls: resolution (default 1080p) + optional delivery prompt.
        await _setResolution(page, RESOLUTION(), log);
        await _setPrompt(page, PROMPT(), log);

        // The green "N Generate" button only ENABLES when the image AND audio are BOTH
        // fully processed — so it's our single readiness gate (audio upload can take
        // ~15-30s; the "Uploading…" spinner clears when done). Dismiss promos first
        // (they overlay the button), then wait up to 2 min for it to light up.
        await _dismissModals(page, log);
        log('  [Kling] waiting for the Generate button to enable (image + audio processing)…');
        const genEnabled = await _waitGenerateEnabled(page, 120_000);
        if (!genEnabled) throw new Error('the Generate button never enabled in 120s — image/audio not accepted (run KLING_DEBUG=1 to inspect)');
        await _dismissModals(page, log);
        await _screenshot(page, '3b-ready', log);
        try {
            const pre = await page.evaluate(() => Array.from(document.querySelectorAll('video')).map(v => (v.currentSrc || v.src || '').split('?')[0]).filter(Boolean));
            pre.forEach(s => seenMp4.add(s));
        } catch (_) {}

        // 3) Click the REAL green "N Generate" action button (not the sidebar nav).
        let gen = await _clickGenerate(page);
        if (!gen) throw new Error('could not find the Generate action button (selector tuning needed — run with KLING_DEBUG=1)');
        genClicked = true; genAt = Date.now(); // from here, a NEW kling .mp4 after MIN_WAIT is our result
        // Confirm the click registered; if the button is still sitting there, click once more.
        await sleep(4000);
        if (!(await _genStarted(page))) {
            log('  [Kling] Generate did not register — dismissing overlays + retrying click');
            await _dismissModals(page, log);
            const gen2 = await _clickGenerate(page);
            if (gen2) gen = gen2;
            genAt = Date.now();
            await sleep(3000);
        }
        log(`  [Kling] clicked "${gen}" — waiting for generation (up to ${Math.round(GEN_TIMEOUT_MS() / 1000)}s)…`);
        await _screenshot(page, '4-generating', log);

        // 4) Poll for the result: captured network URL, or a <video> src in the DOM.
        const deadline = Date.now() + GEN_TIMEOUT_MS();
        let lastLog = 0;
        while (Date.now() < deadline) {
            if (resultUrl) break;
            if (Date.now() - genAt >= MIN_WAIT_MS) {   // a real generation can't finish instantly
                try {
                    const domVid = await page.evaluate((seen) => {
                        const vids = Array.from(document.querySelectorAll('video')).map(x => x.currentSrc || x.src || '').filter(s => /\.(mp4|mov)(\?|$)/i.test(s));
                        return vids.find(s => !seen.includes(s.split('?')[0])) || null;   // only a NEW one
                    }, [...seenMp4]);
                    if (domVid) { resultUrl = domVid; log(`  [Kling] result video appeared in DOM: ${domVid.slice(0, 120)}…`); break; }
                } catch (_) {}
            }
            if (Date.now() - lastLog > 20_000) { lastLog = Date.now(); log(`  [Kling] …still generating (${Math.round((deadline - Date.now()) / 1000)}s left)`); }
            await sleep(3000);
        }
        await _screenshot(page, '5-done', log);
        if (!resultUrl) throw new Error(`generation timed out after ${Math.round(GEN_TIMEOUT_MS() / 1000)}s (no result video appeared)`);

        // 5) Download the result with the session cookies.
        log('  [Kling] downloading result clip…');
        await _downloadWithCookies(resultUrl, outFile, Math.min(180_000, GEN_TIMEOUT_MS()));
        const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
        log(`  [Kling] ✅ avatar clip saved (${mb} MB) → ${outFile}`);
        return outFile;
    } finally {
        try { await browser.close(); } catch (_) {}
    }
}

module.exports = { generateAvatarClip, cookiesPresent };

// ── Standalone CLI for iterative testing ──
//   node src/providers/kling-avatar-browser.js <image> <audio> <out.mp4>
//   KLING_DEBUG=1 node src/providers/kling-avatar-browser.js ... (headed + screenshots)
if (require.main === module) {
    try { require('dotenv').config(); } catch (_) {}
    const [img, aud, out] = process.argv.slice(2);
    if (!img || !aud || !out) {
        console.error('Usage: node src/providers/kling-avatar-browser.js <imageFile> <audioFile> <outFile.mp4>');
        process.exit(1);
    }
    generateAvatarClip({ imageFile: img, audioFile: aud, outFile: out })
        .then((p) => { console.log('OK →', p); process.exit(0); })
        .catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}
