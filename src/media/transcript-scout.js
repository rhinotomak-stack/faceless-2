/**
 * transcript-scout.js
 *
 * Semantic SEGMENT LOCATOR for speech-bearing video candidates (YouTube/archival).
 * For a long video that HAS captions, it finds WHERE in the clip the scene's subject is
 * actually discussed — by embedding the scene line and the caption segments and taking the
 * best cosine match — and returns that timecode. This complements (never replaces) vision:
 * the transcript LOCATES the moment (richer + cheaper than title-matching or blind frame
 * sampling); vision still CONFIRMS the frames actually show it (a narrator saying "tap
 * dance" over a talking head is the wrong footage).
 *
 *   locateSegment(sceneLine, videoId, opts) -> { startTime, endTime, score, text } | null
 *
 * NOTHING here is niche-specific — it's pure semantic similarity for any topic. Graceful:
 * no captions, no embeddings key, or any error -> returns null and the caller falls back to
 * vision smart-trim. Disable with TRANSCRIPT_SCOUT=off. Embeddings via the DashScope
 * (Qwen) OpenAI-compatible endpoint using the existing Qwen key.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const axios = require('axios');
const { execFile } = require('child_process');
const config = require('../settings/config');

function isDisabled() {
    return /^(0|false|off|no)$/i.test(String(process.env.TRANSCRIPT_SCOUT || '').trim());
}

function _embedKey() {
    return String(process.env.QWEN_VISION_API_KEY || process.env.QWEN_API_KEY || config.qwen?.apiKey || '')
        .split(',')[0].trim();
}
function _embedUrl() {
    const base = process.env.QWEN_BASE_URL || config.qwen?.baseUrl || 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
    return base.replace(/\/+$/, '') + '/embeddings';
}

async function _embed(texts, key) {
    const out = [];
    for (let i = 0; i < texts.length; i += 10) {
        const batch = texts.slice(i, i + 10).map(t => String(t || '').slice(0, 2000));
        const r = await axios.post(
            _embedUrl(),
            { model: process.env.TRANSCRIPT_EMBED_MODEL || 'text-embedding-v3', input: batch },
            { headers: { Authorization: `Bearer ${key}` }, timeout: 30000 }
        );
        out.push(...r.data.data.map(d => d.embedding));
    }
    return out;
}

function _cos(a, b) {
    let d = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return d / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}

function _vttToSeconds(hms) {
    const m = /(\d{2}):(\d{2}):(\d{2})/.exec(hms);
    if (!m) return 0;
    return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

// Parse a WebVTT caption file into ~8s merged windows, de-duping YouTube's rolling repeats.
function _parseVtt(txt) {
    const cues = [];
    let cur = null;
    for (const ln of String(txt).split('\n')) {
        const m = /(\d{2}:\d{2}:\d{2})\.\d{3}\s*-->\s*(\d{2}:\d{2}:\d{2})/.exec(ln);
        if (m) { cur = { start: m[1], end: m[2], text: '' }; cues.push(cur); }
        else if (cur && ln.trim() && !ln.includes('-->')) {
            // strip inline tags AND sound annotations ([Music], [Applause], [Laughter]…) so a
            // music/performance clip whose only "captions" are those doesn't fake a match.
            const clean = ln.replace(/<[^>]+>/g, '').replace(/\[[^\]]*\]/g, '').replace(/♪/g, '').trim();
            if (clean) cur.text += ' ' + clean;
        }
    }
    const merged = [];
    let buf = null;
    for (const c of cues) {
        const t = c.text.replace(/\s+/g, ' ').trim();
        if (!t || !/[a-z]{3,}/i.test(t)) continue; // require real words, not symbols/music only
        if (!buf) buf = { start: c.start, end: c.end, text: t };
        else if (buf.text.length < 220) { buf.text += ' ' + t; buf.end = c.end; }
        else { merged.push(buf); buf = { start: c.start, end: c.end, text: t }; }
    }
    if (buf) merged.push(buf);
    const seen = new Set();
    return merged.filter(s => { const k = s.text.slice(0, 40).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}

function _fetchCaptions(videoId, ytdlpPath, signal) {
    return new Promise((resolve) => {
        let tmpDir;
        try { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tscout-')); } catch (_) { return resolve(null); }
        const outBase = path.join(tmpDir, videoId);
        const args = [
            '--skip-download', '--write-auto-sub', '--write-sub', '--sub-lang', 'en.*', '--sub-format', 'vtt',
            '--extractor-args', 'youtube:player_client=default', '--no-warnings', '-o', outBase,
            `https://www.youtube.com/watch?v=${videoId}`,
        ];
        execFile(ytdlpPath || 'yt-dlp', args, { timeout: 45000, windowsHide: true, signal }, () => {
            let segs = null;
            try {
                const file = fs.readdirSync(tmpDir).find(f => /\.vtt$/i.test(f));
                if (file) segs = _parseVtt(fs.readFileSync(path.join(tmpDir, file), 'utf8'));
            } catch (_) { /* none */ }
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
            resolve(segs && segs.length ? segs : null);
        });
    });
}

/**
 * Find the timecode in `videoId` where `sceneLine` is most semantically discussed.
 * @returns {Promise<{startTime:number,endTime:number,score:number,text:string}|null>}
 */
async function locateSegment(sceneLine, videoId, opts = {}) {
    if (isDisabled()) return null;
    const line = String(sceneLine || '').replace(/\s+/g, ' ').trim();
    if (!line || !videoId) return null;
    const key = _embedKey();
    if (!key) return null;
    try {
        const segs = await _fetchCaptions(videoId, opts.ytdlpPath, opts.signal);
        if (!segs || segs.length < 2) return null; // no usable speech track
        const vecs = await _embed([line, ...segs.map(s => s.text)], key);
        const lineVec = vecs[0];
        let best = null;
        for (let i = 0; i < segs.length; i++) {
            const score = _cos(lineVec, vecs[i + 1]);
            if (!best || score > best.score) best = { ...segs[i], score };
        }
        const minScore = Number(process.env.TRANSCRIPT_SCOUT_MIN_SCORE) || 0.45;
        if (!best || best.score < minScore) return null;
        return {
            startTime: _vttToSeconds(best.start),
            endTime: _vttToSeconds(best.end),
            score: Number(best.score.toFixed(3)),
            text: best.text.slice(0, 160),
        };
    } catch (_) {
        return null; // any failure → caller falls back to vision smart-trim
    }
}

module.exports = { locateSegment };
