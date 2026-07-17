/**
 * lightning-box.js — start/stop the Lightning.ai vision Studio on demand, the Lightning
 * counterpart to vision-box.js (which controls the AWS EC2 GPU box).
 *
 * Lightning's control SDK is Python, so this shells out to src/lightning-control.py
 * (spawns `python lightning-control.py <start|stop|status>`), which uses lightning_sdk to
 * start the Studio, launch vLLM + a cloudflared tunnel on it, and return the public URL.
 *
 * MULTI-ACCOUNT: when lightning-accounts.json exists (see lightning-rotation.js), ensureReady()
 * rotates across the account pool — picking a viable account, injecting ITS creds into the
 * Python helper's env, and on a start failure cooling that account down and trying the next.
 * Usage (Studio start→stop seconds) is billed back to the rotation manager so it can exhaust
 * accounts as they burn their free credit. With no pool file it falls back to the single
 * LIGHTNING_* account from .env (legacy behavior).
 *
 * Lightning's tunnel URL is EPHEMERAL — known only after the Studio boots — so ensureReady()
 * captures the URL the helper reports and repoints the vision endpoint (process.env +
 * config.qwen.baseUrl + .env) at it.
 */

'use strict';

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const axios = require('axios');
const config = require('../settings/config');
const rotation = require('./lightning-rotation');

// Tracks the account whose Studio we currently have running, so stop() can bill its usage.
let _activeSession = null; // { account, startedAt }

function _python() {
    return process.env.LIGHTNING_PYTHON || 'python';
}
function _script() {
    return path.join(__dirname, 'lightning-control.py');
}
function _visionUrl() {
    return String(process.env.LIGHTNING_VISION_URL || process.env.QWEN_BASE_URL || '').replace(/\/+$/, '');
}

/** Build a per-account env for the Python helper from a rotation account object. */
function _accountEnv(acct) {
    return {
        ...process.env,
        LIGHTNING_USER_ID: acct.userId,
        LIGHTNING_API_KEY: acct.apiKey,
        LIGHTNING_STUDIO_NAME: acct.studioName,
        LIGHTNING_TEAMSPACE: acct.teamspace || '',
        LIGHTNING_USER: acct.user || '',
        LIGHTNING_ORG: acct.org || '',
        LIGHTNING_MACHINE: acct.machine || process.env.LIGHTNING_MACHINE || 'L4',
    };
}

function isConfigured() {
    if (String(process.env.VISION_BACKEND || '').toLowerCase() !== 'lightning') return false;
    // Pooled: configured if the pool has at least one account.
    if (rotation.isEnabled()) return rotation.loadAccounts().length > 0;
    // Single-account fallback.
    return !!(process.env.LIGHTNING_API_KEY && process.env.LIGHTNING_USER_ID && process.env.LIGHTNING_STUDIO_NAME);
}

const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is the vLLM endpoint answering right now? */
async function isVisionReady(timeoutMs = 4000) {
    const url = _visionUrl();
    if (!url) return false;
    try {
        const res = await axios.get(`${url}/models`, { timeout: timeoutMs, adapter: 'http' });
        return Array.isArray(res.data?.data) && res.data.data.length > 0;
    } catch (_) {
        return false;
    }
}

/** Spawn the Python control helper for one subcommand; resolve its JSON result. */
function _runPy(cmd, { timeoutMs = 360000, onProgress, env } = {}) {
    return new Promise((resolve) => {
        let stdout = '';
        let proc;
        try {
            proc = spawn(_python(), [_script(), cmd], { env: { ...(env || process.env), PYTHONIOENCODING: 'utf-8' } });
        } catch (e) {
            return resolve({ ok: false, error: `spawn failed: ${e.message}` });
        }
        const killer = setTimeout(() => {
            try { proc.kill(); } catch (_) {}
            resolve({ ok: false, error: `python timeout after ${Math.round(timeoutMs / 1000)}s` });
        }, timeoutMs);
        proc.stdout.on('data', (d) => { stdout += d.toString(); });
        proc.stderr.on('data', (d) => {
            const line = d.toString().trim();
            if (line && onProgress) onProgress(line.split(/\r?\n/).filter(Boolean).pop());
        });
        proc.on('error', (e) => { clearTimeout(killer); resolve({ ok: false, error: e.message }); });
        proc.on('close', () => {
            clearTimeout(killer);
            const last = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || '';
            try { resolve(JSON.parse(last)); }
            catch (_) { resolve({ ok: false, error: `bad helper output: ${(last || 'empty').slice(0, 200)}` }); }
        });
    });
}

/** Studio state via the SDK (running | stopped | ...). */
async function getInstanceState() {
    if (!isConfigured()) return { ok: false, reason: 'not configured' };
    const env = _activeSession ? _accountEnv(_activeSession.account) : process.env;
    const r = await _runPy('status', { timeoutMs: 90000, env });
    return r.ok ? { ok: true, state: String(r.state || 'unknown') } : { ok: false, reason: r.error };
}

/** Persist the captured tunnel URL into .env so retries/restart reuse it. */
function _persistVisionUrl(url) {
    try {
        const envPath = path.join(process.env.PROJECT_DIR || process.cwd(), '.env');
        let txt = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
        if (/^LIGHTNING_VISION_URL=.*$/m.test(txt)) {
            txt = txt.replace(/^LIGHTNING_VISION_URL=.*$/m, `LIGHTNING_VISION_URL=${url}`);
        } else {
            txt += `${txt.endsWith('\n') || txt === '' ? '' : '\n'}LIGHTNING_VISION_URL=${url}\n`;
        }
        fs.writeFileSync(envPath, txt);
    } catch (_) { /* best-effort */ }
}

/** Repoint the vision endpoint at the freshly captured tunnel URL. */
function _applyUrl(rawUrl, log) {
    const full = /\/v1\/?$/.test(rawUrl) ? rawUrl.replace(/\/+$/, '') : `${rawUrl.replace(/\/+$/, '')}/v1`;
    process.env.LIGHTNING_VISION_URL = full;
    try { config.resolveVisionBackend(); } catch (_) {}
    // The vision call sites read config.qwen.baseUrl (cached object), NOT process.env at call
    // time — push the live URL into the config object or scoring hits the stale endpoint.
    try { if (config.qwen) config.qwen.baseUrl = process.env.QWEN_BASE_URL; } catch (_) {}
    _persistVisionUrl(full);
    if (log) log(`Lightning endpoint: ${full}`);
}

/** Poll the public tunnel URL directly until the model finishes loading. */
async function _waitModel(log) {
    const modelTimeoutMs = Number(process.env.LIGHTNING_MODEL_TIMEOUT_MS || 480000); // 8 min
    const t0 = Date.now();
    let ticks = 0;
    while (Date.now() - t0 < modelTimeoutMs) {
        if (await isVisionReady()) { log(`Lightning vision ready ✓ (${Math.round((Date.now() - t0) / 1000)}s)`); return true; }
        if (++ticks % 4 === 0) log(`Model loading… ${Math.round((Date.now() - t0) / 1000)}s`);
        await _sleep(5000);
    }
    return false;
}

/** One start attempt for a specific env (account or single .env). Returns { ok, reason }. */
async function _startWith(env, log) {
    const r = await _runPy('start', { timeoutMs: 420000, onProgress: log, env });
    if (!r.ok) return { ok: false, reason: r.error || 'start failed' };
    if (!r.url) return { ok: false, reason: 'no tunnel URL captured' };
    _applyUrl(r.url, log);
    const ready = await _waitModel(log);
    return ready ? { ok: true } : { ok: false, reason: 'model not ready in time' };
}

/**
 * Ensure a Lightning vision endpoint is up and answering. Rotates the account pool when one is
 * configured; otherwise uses the single .env account. Captures + repoints the tunnel URL.
 */
async function ensureReady({ onProgress } = {}) {
    const log = onProgress || (() => {});
    if (!isConfigured()) {
        return { ok: false, reason: 'Lightning not configured (need an account pool or LIGHTNING_API_KEY/USER_ID/STUDIO_NAME)' };
    }

    // ── Pooled rotation ──
    if (rotation.isEnabled()) {
        const tried = new Set();
        let acct = rotation.pickAccount();
        if (!acct) return { ok: false, reason: 'all Lightning accounts are exhausted or cooling down' };
        while (acct && !tried.has(acct.id)) {
            tried.add(acct.id);
            const st = rotation.status().find((s) => s.id === acct.id);
            log(`Account: ${acct.label || acct.id} (${st ? st.usedHours : 0}/${acct.monthlyBudgetHours}h used)`);
            const res = await _startWith(_accountEnv(acct), log);
            if (res.ok) {
                rotation.markHealthy(acct);
                rotation.beginSession(acct);
                _activeSession = { account: acct, startedAt: Date.now() };
                return { ok: true, account: acct.id };
            }
            log(`Account ${acct.label || acct.id} unavailable (${res.reason}) — rotating to next`);
            rotation.markFailure(acct, res.reason);
            acct = rotation.pickAccount();
        }
        return { ok: false, reason: 'no Lightning account could be brought up' };
    }

    // ── Single-account (.env) fallback ──
    if (await isVisionReady()) { log('Lightning vision already ready ✓'); return { ok: true, alreadyReady: true }; }
    log('Starting Lightning Studio + vLLM…');
    const res = await _startWith(process.env, log);
    if (res.ok) { _activeSession = null; return { ok: true }; }
    return { ok: false, reason: res.reason };
}

/** Stop the active Studio (idempotent) and bill its usage back to the rotation manager. */
async function stop({ onProgress } = {}) {
    const log = onProgress || (() => {});
    if (!isConfigured()) return { ok: false, reason: 'not configured' };
    let env = process.env;
    if (_activeSession) {
        const seconds = Math.round((Date.now() - _activeSession.startedAt) / 1000);
        try { rotation.endSession(_activeSession.account, seconds); } catch (_) {}
        env = _accountEnv(_activeSession.account);
        log(`Billing ${Math.round(seconds / 60)}m to ${_activeSession.account.label || _activeSession.account.id}`);
    }
    const r = await _runPy('stop', { timeoutMs: 120000, env });
    _activeSession = null;
    if (r.ok) log('Lightning Studio stopping ✓ (billing stops)');
    return r.ok ? { ok: true } : { ok: false, reason: r.error };
}

/** Combined status for the UI (matches vision-box.status shape). */
async function status() {
    const ready = await isVisionReady();
    let state = 'unknown';
    if (isConfigured()) {
        const st = await getInstanceState();
        if (st.ok) state = st.state;
    }
    return { configured: isConfigured(), ready, instanceState: state, pool: rotation.isEnabled() ? rotation.status() : null };
}

module.exports = { isConfigured, isVisionReady, getInstanceState, status, ensureReady, stop };
