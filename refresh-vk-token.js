#!/usr/bin/env node
// ─── VK Token Refresh ──────────────────────────────────────────────
// Gets a VK access token with video scope (~24h validity).
// VK Mini-apps don't support offline scope, so tokens expire.
// Re-run this script whenever the token expires.
//
// Usage:
//   node refresh-vk-token.js              (uses VK_APP_ID from .env)
//   node refresh-vk-token.js 12345678     (pass app ID directly)
//
// Steps:
//   1. Opens VK OAuth page in your browser
//   2. You log in and click "Allow"
//   3. VK redirects to blank.html with token in the URL bar
//   4. You paste that URL here → token saved to .env
// ────────────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const readline = require('readline');

const ENV_PATH = path.join(__dirname, '.env');
const REDIRECT_URI = 'https://oauth.vk.com/blank.html';

// ─── Load .env manually ─────────────────────────────────────────────
function loadEnv() {
    const vars = {};
    if (fs.existsSync(ENV_PATH)) {
        const lines = fs.readFileSync(ENV_PATH, 'utf-8').split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx > 0) {
                vars[trimmed.substring(0, eqIdx).trim()] = trimmed.substring(eqIdx + 1).trim();
            }
        }
    }
    return vars;
}

// ─── Save token to .env ─────────────────────────────────────────────
function saveTokenToEnv(newToken) {
    if (!fs.existsSync(ENV_PATH)) {
        fs.writeFileSync(ENV_PATH, `VK_ACCESS_TOKEN=${newToken}\n`, 'utf-8');
        return;
    }

    let content = fs.readFileSync(ENV_PATH, 'utf-8');
    const regex = /^VK_ACCESS_TOKEN=.*$/m;
    if (regex.test(content)) {
        content = content.replace(regex, `VK_ACCESS_TOKEN=${newToken}`);
    } else {
        content = content.trimEnd() + `\nVK_ACCESS_TOKEN=${newToken}\n`;
    }
    fs.writeFileSync(ENV_PATH, content, 'utf-8');
}

// ─── Extract token from redirect URL ────────────────────────────────
function extractToken(url) {
    // URL looks like: https://oauth.vk.com/blank.html#access_token=vk1.a.xxx&expires_in=0&user_id=123
    const hashIdx = url.indexOf('#');
    if (hashIdx < 0) return null;
    const fragment = url.substring(hashIdx + 1);
    const params = new URLSearchParams(fragment);
    return params.get('access_token') || null;
}

// ─── Open URL in default browser ────────────────────────────────────
function openBrowser(url) {
    const cmd = process.platform === 'win32' ? `start "" "${url}"`
        : process.platform === 'darwin' ? `open "${url}"`
        : `xdg-open "${url}"`;
    exec(cmd, (err) => {
        if (err) {
            console.log('\n  Could not open browser automatically.');
            console.log('  Open this URL manually:\n');
            console.log(`  ${url}\n`);
        }
    });
}

// ─── Main ───────────────────────────────────────────────────────────
function main() {
    const envVars = loadEnv();
    const appId = process.argv[2] || envVars.VK_APP_ID;

    if (!appId) {
        console.log('');
        console.log('  ERROR: No VK App ID found.');
        console.log('');
        console.log('  Either:');
        console.log('    1. Add VK_APP_ID=your_id to .env');
        console.log('    2. Or run: node refresh-vk-token.js YOUR_APP_ID');
        console.log('');
        console.log('  To create a VK app:');
        console.log('    1. Go to https://dev.vk.com/ → My Apps → Create App');
        console.log('    2. Copy the App ID');
        console.log('');
        process.exit(1);
    }

    // VK implicit flow — scope: video + offline (permanent token)
    // Using blank.html redirect — works with any app type
    // scope=video as string + v=5.131 — this combo works for Mini-apps
    // Token lasts ~24h, re-run this script to refresh
    const authUrl = `https://oauth.vk.com/authorize?client_id=${appId}&display=page&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=video&response_type=token&v=5.131`;

    console.log('');
    console.log('  ╔═══════════════════════════════════════════════╗');
    console.log('  ║       VK Token Refresh (offline scope)        ║');
    console.log('  ╠═══════════════════════════════════════════════╣');
    console.log(`  ║  App ID: ${appId.toString().padEnd(37)}║`);
    console.log('  ║  Scope: video (~24h token)                     ║');
    console.log('  ╚═══════════════════════════════════════════════╝');
    console.log('');
    console.log('  Opening browser for VK authorization...');
    console.log('  1. Log in and click "Allow"');
    console.log('  2. You\'ll be redirected to a blank page');
    console.log('  3. Copy the ENTIRE URL from your browser\'s address bar');
    console.log('  4. Paste it here and press Enter');
    console.log('');

    openBrowser(authUrl);

    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    rl.question('  Paste the redirect URL here: ', (answer) => {
        rl.close();

        const url = answer.trim();
        if (!url) {
            console.log('\n  No URL provided. Exiting.\n');
            process.exit(1);
        }

        // Handle case where user pastes just the token
        if (url.startsWith('vk1.')) {
            try {
                saveTokenToEnv(url);
                console.log('');
                console.log('  Token saved to .env successfully!');
                console.log(`  Token: ${url.substring(0, 20)}...${url.substring(url.length - 10)}`);
                console.log('  Scope: video (~24h — re-run "npm run vk-token" when it expires)');
                console.log('');
                process.exit(0);
            } catch (e) {
                console.log(`\n  Error saving token: ${e.message}\n`);
                process.exit(1);
            }
        }

        const token = extractToken(url);
        if (!token) {
            console.log('');
            console.log('  Could not find access_token in that URL.');
            console.log('  Expected URL like: https://oauth.vk.com/blank.html#access_token=vk1.a.xxx&...');
            console.log('');
            // Check for error in URL
            const hashIdx = url.indexOf('#');
            if (hashIdx >= 0) {
                const params = new URLSearchParams(url.substring(hashIdx + 1));
                const err = params.get('error_description') || params.get('error');
                if (err) console.log(`  VK error: ${err}\n`);
            }
            process.exit(1);
        }

        try {
            saveTokenToEnv(token);
            console.log('');
            console.log('  Token saved to .env successfully!');
            console.log(`  Token: ${token.substring(0, 20)}...${token.substring(token.length - 10)}`);
            console.log('  Scope: video (~24h — re-run "npm run vk-token" when it expires)');
            console.log('');
        } catch (e) {
            console.log(`\n  Error saving token: ${e.message}\n`);
            process.exit(1);
        }
    });
}

main();
