// src/providers/veo-video.js
// ============================================================================
// Veo 3.1 AI-VIDEO provider — OPT-IN, DORMANT BY DEFAULT.
// ----------------------------------------------------------------------------
// Generates a short B-roll clip from a text prompt (optionally image-conditioned)
// through a HOSTED Veo API. This is deliberately NOT a browser bridge: driving
// Google/Gemini's web UI with saved cookies risks an account ban, so AI-video
// goes through a proper API key instead (unlike the Kling *presenter* bridge,
// which the user explicitly opted into for their credit-only account).
//
// ACTIVATION (both required, else fully inert):
//   VEO_AI_VIDEO=1        -> feature turned on
//   VEO_API_KEY=<key>     -> a real key for the chosen backend
// With no key: isEnabled() === false, generateVeoClip() returns null, and the
// media layer falls straight through to the normal stock/youtube gauntlet.
// A keyless build is byte-identical to today.
//
// BACKENDS (VEO_BACKEND):
//   'fal'    (default) — fal.ai queue API. Key = a fal.ai key. Simplest
//                        pay-as-you-go path; recommended for the user's setup.
//   'gemini'           — Google Gemini API (generativelanguage predictLongRunning).
//                        Key = a Gemini API key with Veo access + billing enabled.
//                        NOTE: this path is coded to the documented shape but is
//                        UNVERIFIED here (no key on hand). fal is the safe default.
//
// COST WARNING: Veo bills PER SECOND of generated video (real money, unlike
// Kling credits). Keep clips short. Resolution + duration are clamped.
// ============================================================================

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { createByteLimitTransform, requestSafeStream } = require('../../security/safe-download');

// Force the Node http adapter (same reason as base-provider.js): in an Electron
// renderer/preload context axios would otherwise pick the XHR adapter and break
// streamed downloads.
const _HTTP_ADAPTER = 'http';

const FAL_QUEUE_BASE = 'https://queue.fal.run';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// -------- env accessors (read live so UI/build env changes are honored) -------
function _backend() {
    const b = String(process.env.VEO_BACKEND || 'fal').trim().toLowerCase();
    return b === 'gemini' ? 'gemini' : 'fal';
}
function _apiKey() {
    return String(process.env.VEO_API_KEY || '').trim();
}
function _model() {
    const m = String(process.env.VEO_MODEL || '').trim();
    if (m) return m;
    // Cheapest sensible default per backend.
    return _backend() === 'gemini'
        ? 'veo-3.1-fast-generate-preview'
        : 'fal-ai/veo3.1/fast';
}
function _resolution() {
    const r = String(process.env.VEO_RESOLUTION || '720p').trim().toLowerCase();
    return r === '1080p' ? '1080p' : '720p';
}
function _pollTimeoutMs() {
    const n = parseInt(process.env.VEO_POLL_TIMEOUT_MS || '', 10);
    return Number.isFinite(n) && n > 0 ? n : 6 * 60 * 1000; // 6 min
}

function keyPresent() {
    return !!_apiKey();
}

// Feature is active only when explicitly enabled AND a key exists.
function isEnabled() {
    const flag = String(process.env.VEO_AI_VIDEO || '').trim().toLowerCase();
    const on = flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on';
    return on && keyPresent();
}

function _sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new Error('aborted'));
        const t = setTimeout(resolve, ms);
        if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
    });
}

// Veo emits fixed-length clips; clamp scene-derived duration to the supported set.
function _clampDuration(durationSec) {
    const d = Number(durationSec) || 6;
    if (d <= 4) return 4;
    if (d >= 8) return 8;
    return 6;
}

// Stream a finished video URL to disk. Throws on any non-2xx / write error.
async function _downloadTo(url, outFile, signal) {
    const dir = path.dirname(outFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const maxBytes = 2 * 1024 * 1024 * 1024;
    const res = await requestSafeStream(url, {
        adapter: _HTTP_ADAPTER,
        timeout: 120000,
        signal,
    }, { maxRedirects: 5, maxBytes });
    await new Promise((resolve, reject) => {
        const w = fs.createWriteStream(outFile);
        const limiter = createByteLimitTransform(maxBytes);
        res.data.pipe(limiter).pipe(w);
        limiter.on('error', reject);
        w.on('finish', resolve);
        w.on('error', reject);
        res.data.on('error', reject);
    });
    const size = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;
    if (size < 10000) {
        try { fs.unlinkSync(outFile); } catch (_) {}
        throw new Error(`downloaded Veo clip too small (${size} bytes)`);
    }
    return outFile;
}

// -------------------------------- fal.ai path --------------------------------
async function _generateFal({ prompt, outFile, durationSec, aspectRatio, resolution, signal, log }) {
    const key = _apiKey();
    const model = _model();
    const submitUrl = `${FAL_QUEUE_BASE}/${model}`;
    const headers = { Authorization: `Key ${key}`, 'Content-Type': 'application/json' };

    const body = {
        prompt,
        aspect_ratio: aspectRatio || '16:9',
        duration: `${_clampDuration(durationSec)}s`,
        resolution: resolution || _resolution(),
        generate_audio: false,
    };

    log?.(`[Veo/fal] submit ${model} (${body.resolution}, ${body.duration}, ${body.aspect_ratio})`);
    const submit = await axios.post(submitUrl, body, { headers, adapter: _HTTP_ADAPTER, timeout: 30000, signal });
    const reqId = submit.data?.request_id;
    let statusUrl = submit.data?.status_url;
    let responseUrl = submit.data?.response_url;
    if (!reqId && !responseUrl) throw new Error('fal submit returned no request_id');
    if (!statusUrl) statusUrl = `${FAL_QUEUE_BASE}/${model}/requests/${reqId}/status`;
    if (!responseUrl) responseUrl = `${FAL_QUEUE_BASE}/${model}/requests/${reqId}`;

    const deadline = _pollTimeoutMs();
    const started = Date.now();
    // Date.now() is fine at runtime (this is not a Workflow script).
    while (Date.now() - started < deadline) {
        await _sleep(6000, signal);
        let st;
        try {
            st = await axios.get(statusUrl, { headers, adapter: _HTTP_ADAPTER, timeout: 20000, signal });
        } catch (e) {
            if (e?.message === 'aborted') throw e;
            continue; // transient poll error — keep waiting
        }
        const status = String(st.data?.status || '').toUpperCase();
        if (status === 'COMPLETED') break;
        if (status === 'FAILED' || status === 'ERROR') throw new Error(`fal generation ${status}`);
    }
    if (Date.now() - started >= deadline) throw new Error('fal generation timed out');

    const result = await axios.get(responseUrl, { headers, adapter: _HTTP_ADAPTER, timeout: 30000, signal });
    const data = result.data || {};
    const videoUrl = data.video?.url || (Array.isArray(data.videos) ? data.videos[0]?.url : null) || data.url;
    if (!videoUrl) throw new Error('fal result missing video url');
    log?.(`[Veo/fal] downloading clip`);
    return _downloadTo(videoUrl, outFile, signal);
}

// -------------------------------- gemini path --------------------------------
// Documented shape (predictLongRunning). UNVERIFIED — fal is the default.
async function _generateGemini({ prompt, outFile, aspectRatio, signal, log }) {
    const key = _apiKey();
    const model = _model();
    const submitUrl = `${GEMINI_BASE}/models/${model}:predictLongRunning?key=${encodeURIComponent(key)}`;
    const body = {
        instances: [{ prompt }],
        parameters: { aspectRatio: aspectRatio || '16:9', personGeneration: 'allow_adult' },
    };
    log?.(`[Veo/gemini] submit ${model}`);
    const submit = await axios.post(submitUrl, body, { adapter: _HTTP_ADAPTER, timeout: 30000, signal });
    const opName = submit.data?.name;
    if (!opName) throw new Error('gemini submit returned no operation name');

    const opUrl = `${GEMINI_BASE}/${opName}?key=${encodeURIComponent(key)}`;
    const deadline = _pollTimeoutMs();
    const started = Date.now();
    let done = null;
    while (Date.now() - started < deadline) {
        await _sleep(8000, signal);
        let op;
        try {
            op = await axios.get(opUrl, { adapter: _HTTP_ADAPTER, timeout: 20000, signal });
        } catch (e) {
            if (e?.message === 'aborted') throw e;
            continue;
        }
        if (op.data?.done) { done = op.data; break; }
        if (op.data?.error) throw new Error(`gemini op error: ${op.data.error?.message || 'unknown'}`);
    }
    if (!done) throw new Error('gemini generation timed out');

    const sample = done.response?.generateVideoResponse?.generatedSamples?.[0]
        || done.response?.generatedSamples?.[0];
    let uri = sample?.video?.uri || sample?.video?.url;
    if (!uri) throw new Error('gemini result missing video uri');
    // Gemini file URIs need the key appended to download.
    if (uri.includes('generativelanguage.googleapis.com') && !uri.includes('key=')) {
        uri += (uri.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(key);
    }
    log?.(`[Veo/gemini] downloading clip`);
    return _downloadTo(uri, outFile, signal);
}

/**
 * Generate a single AI B-roll clip.
 * @returns {Promise<string|null>} absolute path to the written .mp4, or null if
 *          the feature is inert (no key / disabled). Throws on genuine failures
 *          so the caller can log the reason and fall back to stock.
 */
async function generateVeoClip({ prompt, outFile, durationSec, aspectRatio, resolution, signal, log } = {}) {
    if (!isEnabled()) return null;
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) throw new Error('Veo: empty prompt');
    if (!outFile) throw new Error('Veo: no outFile');

    // Reuse a cached clip if one already exists for this scene (resume-friendly).
    if (fs.existsSync(outFile) && fs.statSync(outFile).size > 10000) {
        log?.(`[Veo] reuse cached clip ${path.basename(outFile)}`);
        return outFile;
    }

    const opts = { prompt: cleanPrompt, outFile, durationSec, aspectRatio, resolution, signal, log };
    return _backend() === 'gemini' ? _generateGemini(opts) : _generateFal(opts);
}

module.exports = { generateVeoClip, isEnabled, keyPresent };
