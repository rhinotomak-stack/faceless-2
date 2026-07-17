/**
 * clip-bytes-cache.js — persistent clip-bytes cache (OPENMONTAGE-BORROW-PLAN #20).
 * Clean-room port of OpenMontage's clip_cache technique (AGPLv3) — code is ours.
 *
 * Caches downloaded clip files by provider+id so the SAME clip isn't re-downloaded
 * across builds. Uses hardlinks (fs.linkSync) with a cross-drive copy fallback, an
 * LRU eviction to a size cap, and an atomic JSON manifest under an O_EXCL lock.
 * NO ML dependency — works regardless of @xenova. OPT-IN: CLIP_BYTES_CACHE=1.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_DIR = process.env.CLIP_CACHE_DIR || path.join(os.homedir(), '.yta-empire', 'clips_cache');
const MANIFEST = path.join(CACHE_DIR, 'cache_manifest.json');
const LOCK = path.join(CACHE_DIR, '.lock');
const MAX_BYTES = Math.max(1, Number(process.env.CLIP_CACHE_MAX_GB || 20)) * 1024 * 1024 * 1024;

function enabled() { return /^(1|true|on|yes)$/i.test(String(process.env.CLIP_BYTES_CACHE || '').trim()); }
function _now() { return Date.now(); }
function _ensureDir() { try { if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {} }
function _safeId(id) { return String(id || '').replace(/[^a-z0-9._-]/gi, '_').slice(0, 120); }

function _withLock(fn) {
    _ensureDir();
    let fd = null;
    for (let i = 0; i < 50; i++) {
        try { fd = fs.openSync(LOCK, 'wx'); break; } catch (_) {
            try { const age = _now() - fs.statSync(LOCK).mtimeMs; if (age > 30_000) { fs.unlinkSync(LOCK); continue; } } catch (_) {}
            const until = _now() + 40; while (_now() < until) { /* brief spin */ }
        }
    }
    try { return fn(); } finally { try { if (fd != null) { fs.closeSync(fd); fs.unlinkSync(LOCK); } } catch (_) {} }
}

function _readManifest() { try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) || {}; } catch (_) { return {}; } }
function _writeManifest(m) { const tmp = MANIFEST + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(m)); fs.renameSync(tmp, MANIFEST); }

function _linkOrCopy(src, dst) {
    try { fs.linkSync(src, dst); return 'hardlink'; }
    catch (e) { if (e.code === 'EXDEV' || e.code === 'EPERM') { fs.copyFileSync(src, dst); return 'copy'; } throw e; }
}

/** Try to satisfy a needed clip from cache by linking it into destPath. */
function tryLink(clipId, destPath) {
    if (!enabled()) return false;
    const id = _safeId(clipId);
    try {
        return _withLock(() => {
            const m = _readManifest();
            const row = m[id];
            if (!row) return false;
            const blob = path.join(CACHE_DIR, row.file);
            if (!fs.existsSync(blob)) { delete m[id]; _writeManifest(m); return false; }
            try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (_) {}
            _linkOrCopy(blob, destPath);
            row.lastAccessAt = _now();
            _writeManifest(m);
            return true;
        });
    } catch (_) { return false; }
}

/** Ingest a freshly-downloaded clip into the cache (LRU-evicting to the cap). */
function ingest(clipId, srcPath, meta = {}) {
    if (!enabled() || !clipId || !srcPath) return { ok: false };
    const id = _safeId(clipId);
    try {
        let bytes = 0;
        try { bytes = fs.statSync(srcPath).size; } catch (_) { return { ok: false }; }
        if (bytes < 1024) return { ok: false, reason: 'too small' };
        return _withLock(() => {
            const m = _readManifest();
            if (m[id] && fs.existsSync(path.join(CACHE_DIR, m[id].file))) { m[id].lastAccessAt = _now(); _writeManifest(m); return { ok: true, cached: true }; }
            // Evict LRU until this fits.
            let total = Object.values(m).reduce((a, r) => a + (r.bytes || 0), 0);
            const lru = Object.entries(m).sort((a, b) => (a[1].lastAccessAt || 0) - (b[1].lastAccessAt || 0));
            let evicted = 0;
            while (total + bytes > MAX_BYTES && lru.length) {
                const [eid, erow] = lru.shift();
                try { fs.unlinkSync(path.join(CACHE_DIR, erow.file)); } catch (_) {}
                total -= (erow.bytes || 0); delete m[eid]; evicted++;
            }
            const ext = (path.extname(srcPath) || '.mp4').slice(0, 8);
            const file = `${id}${ext}`;
            const how = _linkOrCopy(srcPath, path.join(CACHE_DIR, file));
            m[id] = { file, bytes, lastAccessAt: _now(), provider: meta.provider || '', how };
            _writeManifest(m);
            return { ok: true, bytes, evicted, how };
        });
    } catch (_) { return { ok: false }; }
}

module.exports = { enabled, tryLink, ingest, CACHE_DIR };
