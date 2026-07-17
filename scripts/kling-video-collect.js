// scripts/kling-video-collect.js
// Recover an ALREADY-generated Kling clip — spends NO credits. Opens the account's
// creations, loads the newest finished video, and downloads it with the session
// cookies. Use when a generation's queue outlasted the bridge's wait window
// (Kling free/standard queues can be 30-40 min), or to re-fetch any past clip.
//   node scripts/kling-video-collect.js <outFile.mp4>
//   KLING_DEBUG=1 node scripts/kling-video-collect.js <outFile.mp4>   (headed)
'use strict';
const fs = require('fs');
const path = require('path');
try { require('dotenv').config(); } catch (_) {}

const COOKIE_FILE = process.env.KLING_COOKIE_FILE || path.join(process.cwd(), '.kling-cookies.json');
const URL = process.env.KLING_VIDEO_URL || 'https://kling.ai/app/text-to-video/new';
const TIMEOUT = Math.max(30_000, parseInt(process.env.KLING_COLLECT_TIMEOUT_MS || '180000', 10) || 180_000);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function findChrome() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) return process.env.PUPPETEER_EXECUTABLE_PATH;
    const c = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', (process.env.LOCALAPPDATA || '') + '/Google/Chrome/Application/chrome.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'];
    return c.find(x => { try { return fs.existsSync(x); } catch (_) { return false; } });
}
function loadCookies() { return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8')); }
function cookieHeader(raw) { return raw.filter(c => c && c.name && c.value !== undefined).map(c => `${c.name}=${c.value}`).join('; '); }

async function download(url, outFile, ck) {
    const axios = require('axios');
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36', 'Accept': 'video/mp4,video/*;q=0.9,*/*;q=0.8', 'Referer': 'https://kling.ai/' };
    if (ck) headers['Cookie'] = ck;
    const res = await axios({ url, method: 'GET', responseType: 'stream', adapter: 'http', timeout: 180000, maxRedirects: 10, headers });
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    const w = fs.createWriteStream(outFile);
    res.data.pipe(w);
    await new Promise((resolve, reject) => { w.on('finish', resolve); w.on('error', reject); });
    const sz = fs.statSync(outFile).size;
    if (sz < 10000) { try { fs.unlinkSync(outFile); } catch (_) {} throw new Error(`clip too small (${sz}B) — not ready?`); }
    return sz;
}

(async () => {
    const outFile = process.argv[2];
    if (!outFile) { console.error('Usage: node scripts/kling-video-collect.js <outFile.mp4>'); process.exit(1); }
    const raw = loadCookies();
    const ck = cookieHeader(raw);
    const headed = /^(1|true|on|yes)$/i.test(String(process.env.KLING_DEBUG || ''));
    const puppeteer = require('puppeteer-core');
    const browser = await puppeteer.launch({ executablePath: findChrome(), headless: headed ? false : 'new', defaultViewport: headed ? null : { width: 1440, height: 1000 }, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--lang=en-US,en', headed ? '--start-maximized' : ''].filter(Boolean) });
    let resultUrl = null;
    try {
        const page = await browser.newPage();
        await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
        await page.setCookie(...raw.map(c => ({ ...c })));
        const RESULT_RE = /\.(?:mp4|mov)(?:\?|$)/i;
        page.on('response', (res) => {
            try {
                const u = res.url();
                if ((RESULT_RE.test(u) || (res.headers()['content-type'] || '').includes('video/mp4')) && /kling|klingai|kwai|kuaishou|cdn/i.test(u)) {
                    if (!resultUrl) { resultUrl = u; console.log(`captured clip URL: ${u.slice(0, 110)}…`); }
                }
            } catch (_) {}
        });
        console.log(`opening ${URL} …`);
        await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        // Wait for the creations panel to mount.
        for (let i = 0; i < 45; i++) { if (await page.evaluate(() => !!document.querySelector('video, [class*=card], [class*=creation]')).catch(() => false)) break; await sleep(1000); }
        await sleep(2000);

        const deadline = Date.now() + TIMEOUT;
        let lastLog = 0;
        while (Date.now() < deadline && !resultUrl) {
            // Try to find a finished <video> with a real mp4 src (newest completed clip).
            const domVid = await page.evaluate(() => {
                const v = Array.from(document.querySelectorAll('video')).map(x => x.currentSrc || x.src || '').find(s => /\.(mp4|mov)(\?|$)/i.test(s));
                return v || null;
            }).catch(() => null);
            if (domVid) { resultUrl = domVid; console.log(`found clip in DOM: ${domVid.slice(0, 110)}…`); break; }
            // Nudge the newest creation to load its video (click its thumbnail/play).
            await page.evaluate(() => {
                const card = document.querySelector('video, [class*=creation] *, [class*=card] *');
                if (card) { try { card.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })); card.click && card.click(); } catch (_) {} }
            }).catch(() => {});
            if (Date.now() - lastLog > 15000) { lastLog = Date.now(); console.log(`…waiting for a finished clip (${Math.round((deadline - Date.now()) / 1000)}s left). If it's still queued, run this again later.`); }
            await sleep(3000);
        }
        if (!resultUrl) throw new Error('no finished clip found — it may still be in the Kling queue; run again in a few minutes.');
        console.log('downloading…');
        const sz = await download(resultUrl, outFile, ck);
        console.log(`✅ saved ${(sz / 1024 / 1024).toFixed(1)} MB → ${outFile}`);
    } finally { try { await browser.close(); } catch (_) {} }
})().catch(e => { console.error('COLLECT FAILED:', e.message); process.exit(1); });
