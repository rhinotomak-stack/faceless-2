#!/usr/bin/env node
// ─── Storyblocks Cookie Refresh ────────────────────────────────────
// Storyblocks runs invisible reCAPTCHA v3 on /api/login, which scores
// any headless browser as a bot and returns 403. The workaround is the
// same trick we use for VK: open a real (visible) Chrome window, let
// the user log in MANUALLY (real human → passes reCAPTCHA), then dump
// the session cookies to .storyblocks-cookies.json. The provider's
// _loadCookies() picks those up on the next build.
//
// Usage:
//   npm run storyblocks-cookies
//
// Steps:
//   1. A Chrome window opens at https://www.storyblocks.com/login
//   2. You log in manually (type email + password, tick agreement, click Login)
//   3. Script polls every 2s, detects when you've left /login
//   4. Cookies are written to .storyblocks-cookies.json
//   5. Window closes automatically
// ────────────────────────────────────────────────────────────────────

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const COOKIE_FILE = process.env.STORYBLOCKS_COOKIE_FILE
    || path.join(process.cwd(), '.storyblocks-cookies.json');

function findChrome() {
    if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
        return process.env.PUPPETEER_EXECUTABLE_PATH;
    }
    const PF = process.env['PROGRAMFILES'] || 'C:\\Program Files';
    const PF86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const LOCAL = process.env['LOCALAPPDATA'] || '';
    const cands = [
        path.join(PF, 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(PF86, 'Google\\Chrome\\Application\\chrome.exe'),
        LOCAL && path.join(LOCAL, 'Google\\Chrome\\Application\\chrome.exe'),
        path.join(PF, 'Microsoft\\Edge\\Application\\msedge.exe'),
        path.join(PF86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    ].filter(Boolean);
    return cands.find(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
}

(async () => {
    const puppeteer = require('puppeteer-core');
    const exe = findChrome();
    if (!exe) {
        console.error('\n  ❌ No Chrome/Edge found. Install Chrome or set PUPPETEER_EXECUTABLE_PATH in .env.\n');
        process.exit(1);
    }

    console.log('');
    console.log('  ╔═══════════════════════════════════════════════════╗');
    console.log('  ║   Storyblocks Cookie Refresh (manual login flow)  ║');
    console.log('  ╠═══════════════════════════════════════════════════╣');
    console.log('  ║  A Chrome window will open.                        ║');
    console.log('  ║  Log in manually — that bypasses reCAPTCHA.        ║');
    console.log('  ║  Cookies will save automatically once you\'re in.   ║');
    console.log('  ╚═══════════════════════════════════════════════════╝');
    console.log('');

    const browser = await puppeteer.launch({
        executablePath: exe,
        headless: false,
        defaultViewport: null,
        args: [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--lang=en-US,en',
            '--start-maximized',
        ],
    });

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();

    // Light stealth so reCAPTCHA scoring isn't immediately tripped on first paint.
    await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    });

    console.log('  Opening https://www.storyblocks.com/login …');
    console.log('  → Pre-fill credentials if you like, but ALL clicks/types must be done by you.');
    console.log('');

    try {
        await page.goto('https://www.storyblocks.com/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (e) {
        console.log(`  goto warning: ${e.message}`);
    }

    // Optional convenience: if creds are in .env, pre-fill them (user still has to click Login).
    if (process.env.STORYBLOCKS_EMAIL && process.env.STORYBLOCKS_PASSWORD) {
        await new Promise(r => setTimeout(r, 1500));
        try {
            await page.evaluate((em, pw) => {
                const setNative = (el, val) => {
                    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                    setter.call(el, val);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    el.dispatchEvent(new Event('blur', { bubbles: true }));
                };
                const email = document.querySelector('input[type="email"]');
                const pass = document.querySelector('input[type="password"]');
                if (email) setNative(email, em);
                if (pass) setNative(pass, pw);
            }, process.env.STORYBLOCKS_EMAIL, process.env.STORYBLOCKS_PASSWORD);
            console.log('  ✓ Pre-filled email/password from .env — now tick the agreement and click Login.');
        } catch (_) {}
    } else {
        console.log('  No STORYBLOCKS_EMAIL/PASSWORD in .env — type them in manually.');
    }
    console.log('');
    console.log('  Waiting for you to finish logging in (up to 5 minutes) …');
    console.log('');

    // Poll up to 5 min for the URL to leave /login OR for a clear logged-in marker.
    const startedAt = Date.now();
    const TIMEOUT_MS = 5 * 60 * 1000;
    let success = false;

    while (Date.now() - startedAt < TIMEOUT_MS) {
        await new Promise(r => setTimeout(r, 2000));
        let state;
        try {
            state = await page.evaluate(() => ({
                url: location.href,
                hasSignOut: /sign\s*out|log\s*out/i.test(document.body ? document.body.innerText : ''),
                hasAccountLink: !!document.querySelector('a[href*="/account"], a[href*="/signout"], [class*="UserMenu"]'),
            }));
        } catch (_) { continue; }

        const offLoginPage = !/\/(login|signin|sign-in)(\?|#|$)/.test(state.url);
        if (offLoginPage || state.hasSignOut || state.hasAccountLink) {
            success = true;
            break;
        }
    }

    if (!success) {
        console.log('\n  ❌ Timed out waiting for login. Close the window and try again.');
        await browser.close();
        process.exit(1);
    }

    // Give Storyblocks a moment to set any post-login cookies, then visit /video so
    // the site issues any subscriber-only cookies before we dump them.
    try {
        await page.goto('https://www.storyblocks.com/video', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));
    } catch (_) {}

    let cookies = [];
    try {
        cookies = await page.cookies(
            'https://www.storyblocks.com',
            'https://storyblocks.com',
            'https://www.storyblocks.com/video',
        );
    } catch (e) {
        try { cookies = await page.cookies(); } catch (_) {}
    }

    if (!cookies || cookies.length === 0) {
        console.log('\n  ❌ No cookies captured. Something went wrong — try again.');
        await browser.close();
        process.exit(1);
    }

    fs.writeFileSync(COOKIE_FILE, JSON.stringify(cookies, null, 2), 'utf8');
    console.log('');
    console.log(`  ✅ Saved ${cookies.length} cookies → ${COOKIE_FILE}`);
    console.log('');
    console.log('  Next: run "node scripts/storyblocks-subscribed-recon.js" to verify.');
    console.log('  If you ever get logged out / cookies expire, just re-run this script.');
    console.log('');

    await browser.close();
    process.exit(0);
})().catch(err => {
    console.error('\n  ❌ Error:', err.message);
    process.exit(1);
});
