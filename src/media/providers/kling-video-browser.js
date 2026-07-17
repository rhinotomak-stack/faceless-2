/**
 * Kling AI VIDEO (text-to-video / image-to-video) — BROWSER BRIDGE.
 *
 * Drives the Kling AI web app's regular video-generation tool headless with the
 * saved login session and turns it into a pseudo-API:
 *
 *     generateVideoClip({ prompt, imageFile?, outFile }) -> outFile
 *
 * i.e. a text prompt (+ optional still for image-to-video) -> a generated B-roll
 * MP4, spending the credits on the logged-in consumer account (NO paid API key).
 *
 * This is the SAFE no-key AI-video path: Kling (Kuaishou) is a siloed, disposable
 * account — unlike a Google/Veo bridge, a flagged Kling login costs you a throwaway
 * account, not your YouTube channel. Same puppeteer-core + saved-cookie pattern as
 * the AI-Human avatar bridge (src/providers/kling-avatar-browser.js); it reuses the
 * SAME cookie file (.kling-cookies.json from `npm run kling-cookies`).
 *
 * IMPORTANT — this automates a third-party web UI whose live DOM I can't see, so the
 * selectors are best-effort with multiple fallbacks + heavy logging. First run:
 *     KLING_DEBUG=1 node src/providers/kling-video-browser.js "a prompt" "" out.mp4
 * runs HEADED, dumps the page's inputs/buttons, and screenshots each step to
 * temp/.kling-video/debug-*.png so we can tune the selectors together in 2-3 passes.
 *
 * URLs confirmed (July 2026): the route pattern is kling.ai/app/{tool}/new, same
 * as the avatar tool. Text-to-video = /app/text-to-video/new; image-to-video =
 * /app/image-to-video/frame-mode/new. Controls: prompt textarea, 5s/10s duration,
 * Standard/Pro mode, 16:9/9:16/1:1 aspect, a "{cost} Generate" button.
 *
 * CREDIT CAVEATS (Kling consumer UI, unlike the paid API):
 *   - A FAILED generation still consumes credits — so each debug/tuning gen costs.
 *   - Standard 5s ≈ 10 credits, Standard 10s ≈ 20; Pro ≈ 2×. Default = std/5s (cheapest).
 *   - FREE-tier output is 720p + WATERMARKED. Watermarked clips look bad and our
 *     media-quality filter normally rejects them — use a paid/credit tier for clean
 *     1080p output. (This lane writes the clip directly, bypassing that filter, so a
 *     watermarked clip won't crash the build — it just won't look good.)
 *
 * Flags:
 *   KLING_COOKIE_FILE       cookies path (default .kling-cookies.json — shared w/ avatar)
 *   KLING_VIDEO_URL         text-to-video page (default kling.ai/app/text-to-video/new)
 *   KLING_IMG_VIDEO_URL     image-to-video page (default .../image-to-video/frame-mode/new)
 *   KLING_VIDEO_RESOLUTION  720p | 1080p (default 1080p)
 *   KLING_VIDEO_MODE        std | pro (default std — cheaper)
 *   KLING_VIDEO_DURATION    5 | 10 (seconds; default derived from scene, else 5)
 *   KLING_DEBUG=1           headed + screenshots + verbose DOM inventory
 *   KLING_GEN_TIMEOUT_MS    generation wait cap (default 480000 = 8 min)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const COOKIE_FILE = () => process.env.KLING_COOKIE_FILE || path.join(process.cwd(), '.kling-cookies.json');
// Kling's regular video tool. Overridable because the exact path moves between UI
// revisions; the avatar tool lives at kling.ai/app/ai-human/new, video is a sibling.
const VIDEO_URL = () => process.env.KLING_VIDEO_URL || 'https://kling.ai/app/text-to-video/new';
const IMG_VIDEO_URL = () => process.env.KLING_IMG_VIDEO_URL || 'https://kling.ai/app/image-to-video/frame-mode/new';
const GEN_TIMEOUT_MS = () => Math.max(60_000, parseInt(process.env.KLING_GEN_TIMEOUT_MS || '480000', 10) || 480_000);
const WORK_DIR = () => path.join(process.env.PROJECT_DIR ? path.resolve(process.env.PROJECT_DIR) : process.cwd(), 'temp', '.kling-video');
const RESOLUTION = () => (process.env.KLING_VIDEO_RESOLUTION || '1080p').trim();
const MODE = () => (process.env.KLING_VIDEO_MODE || 'std').trim().toLowerCase();
const MODEL = () => (process.env.KLING_MODEL || '').trim(); // e.g. "2.1" / "1.6" — empty = keep Kling's default

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

// Enabled = the bridge can actually run (a saved session exists). No API key needed.
function isEnabled() { return cookiesPresent(); }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function _inventory(page) {
    try {
        return await page.evaluate(() => {
            const fileInputs = Array.from(document.querySelectorAll('input[type=file]')).map((el, i) => ({
                i, accept: el.accept || '', name: el.name || '', id: el.id || '',
                visible: !!(el.offsetParent || el.getClientRects().length),
            }));
            const textareas = Array.from(document.querySelectorAll('textarea, input[type=text]')).map((el, i) => ({
                i, placeholder: el.placeholder || '', ariaLabel: el.getAttribute('aria-label') || '',
                visible: !!(el.offsetParent || el.getClientRects().length),
            }));
            const buttons = Array.from(document.querySelectorAll('button, [role=button], a')).map(b => (b.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 60);
            return { fileInputs, textareas, buttons, url: location.href };
        });
    } catch (e) { return { error: e.message }; }
}

async function _clickByText(page, patterns) {
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

// Find + click the REAL action button ("N Generate" / "Generate"), NOT the left-nav
// "Generate" icon. The action button is full-width at the bottom of the create panel,
// so we prefer the "N Generate" (credit-cost) one, else the WIDEST visible "Generate"
// outside the nav rail (x>90). The `enabled` heuristic is only a TIE-BREAKER, never a
// hard filter (React buttons are often clickable while my heuristic mis-flags them).
// dryRun=true reports what it WOULD click without clicking (0 credits) — so the dry
// run exercises the exact same detection as the real click.
async function _clickGenerate(page, dryRun = false) {
    const debug = /^(1|true|on|yes)$/i.test(String(process.env.KLING_DEBUG || ''));
    // Pick the best generate button and return its center coords + label. We rank by
    // "has credit cost" then on-screen area — no brittle vis/x hard-filter (the action
    // button can be fixed-position with a null offsetParent). Click via mouse coords.
    const pick = await page.evaluate(() => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        const all = Array.from(document.querySelectorAll('button, [role=button]'));
        const cands = [];
        for (const b of all) {
            const t = norm(b.textContent);
            const hasCost = /\d+\s*generate/i.test(t);
            if (!hasCost && !/^generate$/i.test(t)) continue;
            const r = b.getBoundingClientRect();
            if (r.width < 2 || r.height < 2) continue;         // truly zero-size = not real
            cands.push({ t, hasCost, x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 });
        }
        // Rank: credit-cost button first, then largest area (the full-width action btn).
        cands.sort((a, b) => (b.hasCost - a.hasCost) || (b.w * b.h - a.w * a.h));
        return { best: cands[0] || null, all: cands };
    });
    if (debug) console.log(`     [KlingVid] generate candidates = ${JSON.stringify(pick.all)}`);
    if (!pick.best) return null;
    const b = pick.best;
    if (dryRun) return b.t;
    // Click at the button's center coordinate (works for fixed-position elements).
    try { await page.mouse.click(b.cx, b.cy, { delay: 30 }); }
    catch (_) {
        // Fallback: DOM click on the matching element.
        try {
            await page.evaluate((label) => {
                const el = Array.from(document.querySelectorAll('button, [role=button]')).find(x => (x.textContent || '').replace(/\s+/g, ' ').trim() === label);
                if (el) (el.closest('button,[role=button]') || el).click();
            }, b.t);
        } catch (__) {}
    }
    return b.t;
}

// Turn OFF "Native Audio" if it's on — B-roll doesn't need Kling's generated audio
// (we add our own narration), and native audio costs ~50% more credits per second.
// Best-effort + non-fatal; only clicks when it can confirm the toggle is currently ON.
async function _disableNativeAudio(page, log) {
    // Read the credit-cost off the Generate button to confirm the toggle had an effect.
    const cost = () => page.evaluate(() => {
        const b = Array.from(document.querySelectorAll('button, [role=button]')).find(x => /\d+\s*generate/i.test((x.textContent || '')));
        const m = b ? (b.textContent || '').match(/(\d+)\s*generate/i) : null;
        return m ? parseInt(m[1], 10) : null;
    }).catch(() => null);

    const before = await cost();
    // Click the "Native Audio" control up to twice, checking the cost drops.
    for (let attempt = 0; attempt < 2; attempt++) {
        const clicked = await page.evaluate(() => {
            const el = Array.from(document.querySelectorAll('button, [role=switch], [role=checkbox], label, div, span')).find((x) => {
                const t = (x.textContent || '').replace(/\s+/g, ' ').trim();
                return /^native audio$/i.test(t) && (x.offsetParent || x.getClientRects().length);
            });
            if (!el) return false;
            (el.closest('button, [role=switch], [role=checkbox], label') || el).click();
            return true;
        }).catch(() => false);
        if (!clicked) { log('  [KlingVid] (Native Audio toggle not found — skipping)'); return; }
        await sleep(700); // let the cost recompute
        const after = await cost();
        if (before == null || after == null || after < before) {
            log(`  [KlingVid] Native Audio toggled${before != null && after != null ? ` (cost ${before}→${after})` : ''}`);
            // If cost went DOWN we turned it off — done. If it went UP we just turned it
            // ON by mistake; loop clicks again to turn it back off.
            if (before == null || after == null || after <= before) return;
        } else if (after > before) {
            log(`  [KlingVid] Native Audio click raised cost ${before}→${after} — toggling back`);
            // continue loop to click again (turn off)
        }
    }
    await sleep(150);
}

async function _pickImageInput(page) {
    const handles = await page.$$('input[type=file]');
    for (const h of handles) {
        const accept = (await page.evaluate(el => el.accept || '', h)).toLowerCase();
        if (accept.includes('image') || accept.includes('png') || accept.includes('jpg') || accept.includes('jpeg')) return h;
    }
    return handles.length ? handles[0] : null;
}

async function _screenshot(page, tag, log) {
    if (!/^(1|true|on|yes)$/i.test(String(process.env.KLING_DEBUG || ''))) return;
    try {
        fs.mkdirSync(WORK_DIR(), { recursive: true });
        const p = path.join(WORK_DIR(), `debug-${tag}-${Date.now()}.png`);
        await page.screenshot({ path: p, fullPage: false });
        log(`  [KlingVid] debug screenshot → ${p}`);
    } catch (_) {}
}

async function _downloadWithCookies(url, outFile, timeoutMs = 120_000) {
    const axios = require('axios');
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8',
        'Referer': 'https://kling.ai/',
    };
    const ck = _cookieHeader();
    if (ck) headers['Cookie'] = ck;
    const res = await axios({ url, method: 'GET', responseType: 'stream', adapter: 'http', timeout: timeoutMs, maxRedirects: 10, headers });
    const ct = res.headers['content-type'] || '';
    if (ct.includes('text/html') || ct.includes('application/json')) throw new Error(`result URL returned ${ct}, not video`);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const writer = fs.createWriteStream(outFile);
    res.data.pipe(writer);
    await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
    const st = fs.statSync(outFile);
    if (st.size < 10_000) { try { fs.unlinkSync(outFile); } catch (_) {} throw new Error(`downloaded clip too small (${st.size}B)`); }
    return outFile;
}

async function _dismissModals(page, log) {
    // Dismiss ONLY clear promo buttons — never arbitrary close icons (those can
    // collapse the tool panel and hide Generate).
    try { await page.keyboard.press('Escape'); } catch (_) {}
    await sleep(250);
    try {
        const n = await page.evaluate(() => {
            let clicked = 0;
            // ONLY explicit promo CTAs — never bare ×/close icons, which can also be
            // the panel's own close buttons and would collapse the create UI.
            for (const el of Array.from(document.querySelectorAll('button, [role=button]'))) {
                const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (/^(got it|maybe later|no thanks|skip( for now)?|dismiss|not now)$/i.test(t) && (el.offsetParent || el.getClientRects().length)) {
                    try { (el.closest('button,[role=button]') || el).click(); clicked++; } catch (_) {}
                }
            }
            return clicked;
        });
        if (n && log) log(`  [KlingVid] dismissed ${n} promo(s)`);
    } catch (_) {}
    await sleep(250);
}

async function _waitHydrated(page, ms) {
    // The kling.ai SPA (and the /text-to-video → /app/video redirect) can take
    // 30-45s to mount the logged-in create UI; before that it shows a "Sign In"
    // shell. The prompt box is a contenteditable div (not a <textarea>), so poll
    // for a VISIBLE contenteditable/textarea, not just any textarea.
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const ready = await page.evaluate(() => {
            const vis = (el) => !!(el.offsetParent || el.getClientRects().length);
            const ce = Array.from(document.querySelectorAll('[contenteditable=true], textarea')).some(vis);
            if (ce) return true;
            const t = document.body ? (document.body.innerText || '') : '';
            return /add start and end frames|video generation|describe|type your idea/i.test(t);
        }).catch(() => false);
        if (ready) return true;
        await sleep(1000);
    }
    return false;
}

// Poll until the green "N Generate" action button is present AND enabled.
async function _waitGenerateEnabled(page, ms) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
        const en = await page.evaluate(() => {
            for (const b of Array.from(document.querySelectorAll('button, [role=button]'))) {
                const t = (b.textContent || '').replace(/\s+/g, ' ').trim();
                if (!/\d+\s*generate/i.test(t) && !/^\W*generate\W*$/i.test(t)) continue;
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

async function _genStarted(page) {
    return page.evaluate(() => {
        const t = document.body ? (document.body.innerText || '') : '';
        if (/generating|in queue|queuing|processing|creating|rendering|%|estimated/i.test(t)) return true;
        const b = Array.from(document.querySelectorAll('button, [role=button]')).find(x => /\d+\s*generate/i.test((x.textContent || '')));
        if (!b) return true;
        return b.disabled || b.getAttribute('aria-disabled') === 'true';
    }).catch(() => false);
}

// Fill the MAIN prompt box. REQUIRED. The kling.ai prompt field is a rich editor
// (contenteditable/textarea), and there can be a hidden mirror textarea that a naive
// selector picks by mistake — so we TRY each VISIBLE editable in the create panel,
// click it at its on-screen coordinates, type, and VERIFY the text actually landed
// (read-back), moving to the next candidate until one sticks. Types like a human so
// rich editors capture it. Returns true on success.
async function _setMainPrompt(page, prompt, log) {
    const probe = prompt.slice(0, 12).toLowerCase();
    const debug = /^(1|true|on|yes)$/i.test(String(process.env.KLING_DEBUG || ''));
    // Broad selector — rich editors use contenteditable (any value) or role=textbox.
    const handles = await page.$$('textarea, [contenteditable], [contenteditable=true], [role=textbox]');
    const cands = [];
    for (const h of handles) {
        const meta = await page.evaluate((el) => {
            const r = el.getBoundingClientRect();
            const ph = ((el.placeholder || '') + ' ' + (el.getAttribute('data-placeholder') || '') + ' ' + (el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).toLowerCase();
            const ce = el.getAttribute('contenteditable');
            return {
                tag: el.tagName.toLowerCase(),
                vis: !!(el.offsetParent || el.getClientRects().length),
                x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
                ph: ph.slice(0, 60),
                editable: el.tagName === 'TEXTAREA' || (ce !== null && ce !== 'false') || el.getAttribute('role') === 'textbox',
            };
        }, h).catch(() => null);
        if (meta) cands.push({ h, meta });
    }
    if (debug) log(`  [KlingVid] prompt candidates: ${JSON.stringify(cands.map(c => c.meta))}`);

    // Rank: prefer boxes whose placeholder/help text matches the known prompt hint,
    // then the largest visible editable in the left create panel.
    const ranked = cands
        .filter(c => c.meta.vis && c.meta.editable && c.meta.w > 150 && c.meta.x < 720 && !/feedback|why you like/.test(c.meta.ph))
        .sort((a, b) => {
            const ha = /quotation|speaking|singing|describe|type your idea|creativity|prompt/.test(a.meta.ph) ? 1 : 0;
            const hb = /quotation|speaking|singing|describe|type your idea|creativity|prompt/.test(b.meta.ph) ? 1 : 0;
            if (ha !== hb) return hb - ha;
            return (b.meta.w * b.meta.h) - (a.meta.w * a.meta.h);
        });

    const landed = async () => {
        const bodyHas = await page.evaluate((p) => (document.body.innerText || '').toLowerCase().includes(p), probe).catch(() => false);
        return bodyHas;
    };
    let ok = false;
    for (const c of ranked) {
        // Try several insertion methods; contenteditable editors (Lexical/ProseMirror)
        // often ignore mouse-click+type but honor focus()+execCommand('insertText').
        for (const method of ['focus-exec', 'focus-type', 'click-type']) {
            try {
                await page.evaluate((el) => { try { el.focus(); } catch (_) {} }, c.h);
                await sleep(80);
                if (method === 'click-type') {
                    const box = await c.h.boundingBox();
                    if (box) await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 28));
                }
                // Clear any existing content.
                await page.keyboard.down('Control'); await page.keyboard.press('KeyA'); await page.keyboard.up('Control');
                await page.keyboard.press('Backspace');
                await sleep(60);
                if (method === 'focus-exec') {
                    await page.evaluate((el, txt) => { el.focus(); document.execCommand('insertText', false, txt); }, c.h, prompt);
                } else {
                    await page.keyboard.type(prompt, { delay: 10 });
                }
                await sleep(300);
                if (await landed()) {
                    log(`  [KlingVid] prompt entered into ${c.meta.tag} (${c.meta.w}×${c.meta.h}) via ${method}`);
                    ok = true;
                    break;
                }
            } catch (_) { /* try next method */ }
        }
        if (ok) break;
    }
    for (const c of cands) { try { await c.h.dispose(); } catch (_) {} }
    if (!ok) log('  [KlingVid] could not type the prompt into any visible field');
    return ok;
}

// Best-effort resolution + mode + duration pickers. All NON-FATAL — Kling defaults
// are fine; we Escape after each so a stuck dropdown can't block Generate.
async function _setResolution(page, res, log) {
    const target = /1080/.test(res) ? '1080' : (/720/.test(res) ? '720' : null);
    if (!target) return;
    try {
        const opened = await page.evaluate(() => {
            const el = Array.from(document.querySelectorAll('button, [role=button], div, span')).find((x) => {
                const t = (x.textContent || '').replace(/\s+/g, ' ').trim();
                return /\d{3,4}p\b/i.test(t) && t.length < 40 && (x.offsetParent || x.getClientRects().length);
            });
            if (el) { (el.closest('button,[role=button]') || el).click(); return true; }
            return false;
        });
        if (!opened) { log('  [KlingVid] (resolution control not found — using default)'); return; }
        await sleep(600);
        const picked = await page.evaluate((tp) => {
            const re = new RegExp('^\\s*' + tp + 'p\\b', 'i');
            const opt = Array.from(document.querySelectorAll('li, [role=option], div, span, button')).find((x) => {
                const t = (x.textContent || '').replace(/\s+/g, ' ').trim();
                return t.length < 24 && re.test(t) && (x.offsetParent || x.getClientRects().length);
            });
            if (opt) { (opt.closest('li,[role=option],button') || opt).click(); return true; }
            return false;
        }, target);
        log(picked ? `  [KlingVid] resolution → ${target}p` : `  [KlingVid] (${target}p option not found — default)`);
    } catch (_) {}
    try { await page.keyboard.press('Escape'); } catch (_) {}
    await sleep(200);
}

// Pick a cheaper model version to cut credit cost (VIDEO 3.0 ≈ 40 cr for 5s; older
// Standard models ≈ 10 cr). Opens the model selector, dumps options under KLING_DEBUG,
// and selects KLING_MODEL (default tries an older version). Best-effort + non-fatal.
async function _setModel(page, target, log) {
    const debug = /^(1|true|on|yes)$/i.test(String(process.env.KLING_DEBUG || ''));
    try {
        const opened = await page.evaluate(() => {
            const el = Array.from(document.querySelectorAll('button, [role=button], div, span')).find((x) => {
                const t = (x.textContent || '').replace(/\s+/g, ' ').trim();
                return /(video\s*[0-9]\.[0-9]|kling\s*(ai\s*)?[0-9]\.[0-9])/i.test(t) && t.length < 80 && (x.offsetParent || x.getClientRects().length);
            });
            if (el) { (el.closest('button,[role=button]') || el).click(); return true; }
            return false;
        });
        if (!opened) { log('  [KlingVid] (model selector not found — using default model)'); return; }
        await sleep(800);
        if (debug) {
            const opts = await page.evaluate(() => {
                const seen = new Set();
                return Array.from(document.querySelectorAll('li, [role=option], [role=menuitem], div, span, button'))
                    .map(x => (x.textContent || '').replace(/\s+/g, ' ').trim())
                    .filter(t => t && t.length < 50 && /(kling|video)\s*[0-9]\.[0-9]|standard|professional|\bpro\b|\bstd\b/i.test(t))
                    .filter(t => (seen.has(t) ? false : seen.add(t)));
            }).catch(() => []);
            log(`  [KlingVid] model menu options: ${JSON.stringify(opts)}`);
        }
        if (target) {
            const picked = await page.evaluate((tv) => {
                const re = new RegExp(tv.replace(/\./g, '\\.'), 'i');
                const opt = Array.from(document.querySelectorAll('li, [role=option], [role=menuitem], div, span, button')).find((x) => {
                    const t = (x.textContent || '').replace(/\s+/g, ' ').trim();
                    return re.test(t) && t.length < 40 && (x.offsetParent || x.getClientRects().length);
                });
                if (opt) { (opt.closest('li,[role=option],[role=menuitem],button') || opt).click(); return (opt.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40); }
                return null;
            }, target);
            log(picked ? `  [KlingVid] model → ${picked}` : `  [KlingVid] (target model "${target}" not in menu — kept default)`);
        }
    } catch (_) {}
    try { await page.keyboard.press('Escape'); } catch (_) {}
    await sleep(250);
}

async function _setDuration(page, seconds, log) {
    const target = seconds >= 8 ? '10' : '5';
    try {
        const picked = await page.evaluate((tp) => {
            const re = new RegExp('^\\s*' + tp + '\\s*s\\b', 'i');
            const el = Array.from(document.querySelectorAll('button, [role=button], li, [role=option], div, span')).find((x) => {
                const t = (x.textContent || '').replace(/\s+/g, ' ').trim();
                return re.test(t) && t.length < 16 && (x.offsetParent || x.getClientRects().length);
            });
            if (el) { (el.closest('button,[role=button],li,[role=option]') || el).click(); return true; }
            return false;
        }, target);
        if (picked) log(`  [KlingVid] duration → ${target}s`);
    } catch (_) {}
    await sleep(200);
}

/**
 * Generate ONE AI video clip (text-to-video, or image-to-video if imageFile given).
 * Throws on any failure (the caller falls back to stock footage, so a build never
 * breaks). Returns the written outFile path on success.
 */
async function generateVideoClip({ prompt, imageFile, outFile, durationSec, aspectRatio, log } = {}) {
    log = typeof log === 'function' ? log : (m) => console.log(m);
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) throw new Error('Kling video: empty prompt');
    if (!outFile) throw new Error('Kling video: no outFile');
    if (!cookiesPresent()) throw new Error('no Kling cookies — run `npm run kling-cookies` first');
    if (imageFile && !fs.existsSync(imageFile)) { log(`  [KlingVid] image ${imageFile} missing — text-to-video instead`); imageFile = null; }

    const exe = _findChrome();
    if (!exe) throw new Error('no system Chrome/Edge found for the Kling bridge');
    const puppeteer = require('puppeteer-core');
    const headed = /^(1|true|on|yes)$/i.test(String(process.env.KLING_DEBUG || ''));

    const browser = await puppeteer.launch({
        executablePath: exe,
        headless: headed ? false : 'new',
        defaultViewport: headed ? null : { width: 1440, height: 1000 },
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--lang=en-US,en', headed ? '--start-maximized' : ''].filter(Boolean),
    });

    let resultUrl = null;
    let genClicked = false;
    let genAt = 0;
    const seenMp4 = new Set();
    const MIN_WAIT_MS = Math.max(15_000, parseInt(process.env.KLING_MIN_WAIT_MS || '25000', 10) || 25_000);
    const durSec = Number(durationSec) || parseInt(process.env.KLING_VIDEO_DURATION || '', 10) || 5;
    try {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); });
        const raw = _loadCookiesRaw() || [];
        try { await page.setCookie(...raw.map(c => ({ ...c }))); } catch (e) { log(`  [KlingVid] setCookie warn: ${e.message}`); }

        const RESULT_RE = /\.(?:mp4|mov)(?:\?|$)/i;
        const _isKlingMp4 = (u, ct) => (RESULT_RE.test(u) || (ct || '').includes('video/mp4')) && /kling|klingai|kwai|kuaishou|cdn/i.test(u);
        page.on('response', (res) => {
            try {
                const u = res.url();
                if (!_isKlingMp4(u, (res.headers()['content-type'] || '').toLowerCase())) return;
                const base = u.split('?')[0];
                if (!genClicked) { seenMp4.add(base); return; }
                if (seenMp4.has(base)) return;
                if (Date.now() - genAt < MIN_WAIT_MS) return;
                if (!resultUrl) { resultUrl = u; log(`  [KlingVid] captured NEW result URL: ${u.slice(0, 120)}…`); }
            } catch (_) {}
        });

        // Image-to-video lives on its own page; text-to-video on another.
        const pageUrl = imageFile ? IMG_VIDEO_URL() : VIDEO_URL();
        log(`  [KlingVid] opening ${pageUrl} …`);
        await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
        await sleep(1500);
        await _dismissModals(page, log);
        const hydrated = await _waitHydrated(page, 60_000);
        if (!hydrated) log('  [KlingVid] page did not fully hydrate in 60s — proceeding anyway');
        await _dismissModals(page, log);
        await _screenshot(page, '1-loaded', log);
        if (headed) log(`  [KlingVid] page inventory: ${JSON.stringify(await _inventory(page)).slice(0, 900)}`);

        if (/\/(login|sign-?in|passport)/i.test(page.url())) throw new Error('bounced to login — cookies stale, re-run `npm run kling-cookies`');

        // 1) Optional: image-to-video — upload the still first.
        if (imageFile) {
            let imgInput = await _pickImageInput(page);
            if (!imgInput) { await _clickByText(page, ['upload image', 'add.*image', 'upload photo', 'image to video']); await sleep(1200); imgInput = await _pickImageInput(page); }
            if (imgInput) {
                await imgInput.uploadFile(path.resolve(imageFile));
                log('  [KlingVid] uploaded conditioning image (image-to-video)');
                await sleep(3000);
                const imgErr = await page.evaluate(() => {
                    const t = document.body ? (document.body.innerText || '') : '';
                    const m = t.match(/upload failed[^\n]{0,80}|short side[^\n]{0,60}|not supported[^\n]{0,40}/i);
                    return m ? m[0] : null;
                }).catch(() => null);
                if (imgErr) { log(`  [KlingVid] image rejected ("${imgErr.trim()}") — continuing text-to-video`); }
            } else { log('  [KlingVid] no image input found — continuing text-to-video'); }
        }

        // 2) Fill the main prompt (REQUIRED).
        const promptOk = await _setMainPrompt(page, cleanPrompt, log);
        if (!promptOk) throw new Error('could not find the prompt textarea (selector tuning needed — run with KLING_DEBUG=1)');
        await sleep(800);
        await _screenshot(page, '2-prompt', log);

        // 3) Controls (all best-effort / non-fatal). Model first — switching versions
        // can reset resolution/duration, so set it before those.
        await _setModel(page, MODEL(), log);
        await _setResolution(page, RESOLUTION(), log);
        await _setDuration(page, durSec, log);
        await _disableNativeAudio(page, log);

        // 4) Wait for Generate to enable, dismiss overlays, click it.
        await _dismissModals(page, log);
        const genEnabled = await _waitGenerateEnabled(page, 60_000);
        if (!genEnabled) log('  [KlingVid] Generate did not visibly enable in 60s — attempting click anyway');
        await _dismissModals(page, log);
        await _screenshot(page, '3-ready', log);
        try {
            const pre = await page.evaluate(() => Array.from(document.querySelectorAll('video')).map(v => (v.currentSrc || v.src || '').split('?')[0]).filter(Boolean));
            pre.forEach(s => seenMp4.add(s));
        } catch (_) {}

        // Dry run: confirm everything is staged (prompt typed, credit-cost button
        // present) WITHOUT clicking Generate — spends zero credits. For selector tuning.
        if (/^(1|true|on|yes)$/i.test(String(process.env.KLING_DRY_RUN || ''))) {
            const label = await _clickGenerate(page, true); // detect only, no click
            log(`  [KlingVid] DRY RUN — staged OK. Generate button _clickGenerate would hit = ${label ? `"${label}"` : '(NOT FOUND — check screenshot)'}. Stopping before spending credits.`);
            await _screenshot(page, '3c-dryrun', log);
            return '__DRY_RUN__';
        }

        let gen = await _clickGenerate(page);
        if (!gen) throw new Error('could not find the Generate action button (selector tuning needed — run with KLING_DEBUG=1)');
        genClicked = true; genAt = Date.now();
        await sleep(4000);
        if (!(await _genStarted(page))) {
            log('  [KlingVid] Generate did not register — dismissing overlays + retrying click');
            await _dismissModals(page, log);
            const gen2 = await _clickGenerate(page);
            if (gen2) gen = gen2;
            genAt = Date.now();
            await sleep(3000);
        }
        log(`  [KlingVid] clicked "${gen}" — waiting for generation (up to ${Math.round(GEN_TIMEOUT_MS() / 1000)}s)…`);
        await _screenshot(page, '4-generating', log);

        // 5) Poll for the result: captured network URL, or a NEW <video> src in the DOM.
        const deadline = Date.now() + GEN_TIMEOUT_MS();
        let lastLog = 0;
        while (Date.now() < deadline) {
            if (resultUrl) break;
            if (Date.now() - genAt >= MIN_WAIT_MS) {
                try {
                    const domVid = await page.evaluate((seen) => {
                        const vids = Array.from(document.querySelectorAll('video')).map(x => x.currentSrc || x.src || '').filter(s => /\.(mp4|mov)(\?|$)/i.test(s));
                        return vids.find(s => !seen.includes(s.split('?')[0])) || null;
                    }, [...seenMp4]);
                    if (domVid) { resultUrl = domVid; log(`  [KlingVid] result video appeared in DOM: ${domVid.slice(0, 120)}…`); break; }
                } catch (_) {}
            }
            if (Date.now() - lastLog > 20_000) { lastLog = Date.now(); log(`  [KlingVid] …still generating (${Math.round((deadline - Date.now()) / 1000)}s left)`); }
            await sleep(3000);
        }
        await _screenshot(page, '5-done', log);
        if (!resultUrl) throw new Error(`generation timed out after ${Math.round(GEN_TIMEOUT_MS() / 1000)}s (no result video appeared)`);

        // 6) Download the result with session cookies.
        log('  [KlingVid] downloading result clip…');
        await _downloadWithCookies(resultUrl, outFile, Math.min(180_000, GEN_TIMEOUT_MS()));
        const mb = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
        log(`  [KlingVid] ✅ AI video saved (${mb} MB) → ${outFile}`);
        return outFile;
    } finally {
        try { await browser.close(); } catch (_) {}
    }
}

module.exports = { generateVideoClip, cookiesPresent, isEnabled };

// ── Standalone CLI for iterative selector tuning ──
//   node src/providers/kling-video-browser.js "<prompt>" "<imageFile|>" <out.mp4>
//   KLING_DEBUG=1 node src/providers/kling-video-browser.js "a calm ocean at dawn" "" out.mp4
if (require.main === module) {
    try { require('dotenv').config(); } catch (_) {}
    const [prompt, img, out] = process.argv.slice(2);
    if (!prompt || !out) {
        console.error('Usage: node src/providers/kling-video-browser.js "<prompt>" "<imageFile|empty>" <outFile.mp4>');
        process.exit(1);
    }
    generateVideoClip({ prompt, imageFile: img || null, outFile: out })
        .then((p) => { console.log('OK →', p); process.exit(0); })
        .catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
}
