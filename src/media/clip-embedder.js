/**
 * clip-embedder.js — optional CLIP embeddings + MMR visual-diversity logic
 * (OPENMONTAGE-BORROW-PLAN #20). Clean-room from OpenMontage (AGPLv3) — ours.
 *
 * The embedder LAZILY loads @xenova/transformers (an OPTIONAL dependency). If the
 * package or its weights are absent it disables itself with one log line and
 * everything degrades to today's byte/id dedup — NEVER throws. Uses the CLIP
 * *projection* heads (comparable 512-d image+text vectors), NOT pipeline().
 *
 * The MMR helpers (cosine / fusedSim / planAdjacentSwaps) are PURE and dep-free,
 * so the diversity logic is unit-testable with mock vectors. OPT-IN via the
 * caller's CLIP_VISUAL_DIVERSITY flag.
 */
'use strict';

const MODEL = 'Xenova/clip-vit-base-patch32';
let _loading = null;
let _loadFailed = false;
let _parts = null; // { AutoProcessor, RawImage, vis, tok, txt }
let _loggedOff = false;

function _logOnce(msg) { if (!_loggedOff) { _loggedOff = true; try { console.log(msg); } catch (_) {} } }

async function isAvailable() {
    if (_loadFailed) return false;
    if (_parts) return true;
    if (!_loading) {
        _loading = (async () => {
            let X;
            try { X = require('@xenova/transformers'); }
            catch (_) { _loadFailed = true; _logOnce('[CLIP] @xenova/transformers not installed — visual diversity disabled (byte/id dedup unchanged)'); return false; }
            try {
                const { AutoProcessor, AutoTokenizer, CLIPVisionModelWithProjection, CLIPTextModelWithProjection, RawImage } = X;
                const opts = { quantized: true };
                const [proc, vis, tok, txt] = await Promise.all([
                    AutoProcessor.from_pretrained(MODEL),
                    CLIPVisionModelWithProjection.from_pretrained(MODEL, opts),
                    AutoTokenizer.from_pretrained(MODEL),
                    CLIPTextModelWithProjection.from_pretrained(MODEL, opts),
                ]);
                _parts = { proc, vis, tok, txt, RawImage };
                console.log('[CLIP] model loaded (clip-vit-base-patch32, 512-d projection heads)');
                return true;
            } catch (e) {
                _loadFailed = true;
                _logOnce(`[CLIP] weight/load failed (offline?) — disabled: ${String(e.message || e).slice(0, 80)}`);
                return false;
            }
        })();
    }
    return _loading;
}

function _l2(arr) {
    let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i] * arr[i];
    const n = Math.sqrt(s) || 1; const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[i] / n;
    return out;
}

/** Mean-pool per-frame image embeddings → one L2-normalised 512-d vector, or null. */
async function embedImageBase64List(base64Frames) {
    if (!(await isAvailable()) || !Array.isArray(base64Frames) || !base64Frames.length) return null;
    try {
        const { proc, vis, RawImage } = _parts;
        const acc = new Float64Array(512);
        let n = 0;
        for (const b64 of base64Frames) {
            const img = await RawImage.read('data:image/jpeg;base64,' + String(b64).replace(/^data:[^,]+,/, ''));
            const inputs = await proc(img);
            const out = await vis(inputs);
            const vec = out.image_embeds.data;
            if (vec.length !== 512) { console.log(`[CLIP] unexpected embed dim ${vec.length} — skipping frame`); continue; }
            for (let i = 0; i < 512; i++) acc[i] += vec[i];
            n++;
        }
        if (!n) return null;
        for (let i = 0; i < 512; i++) acc[i] /= n;
        return _l2(acc);
    } catch (e) { _logOnce(`[CLIP] image embed failed — disabled: ${String(e.message || e).slice(0, 80)}`); _loadFailed = true; return null; }
}

/** L2-normalised 512-d text embedding, or null. */
async function embedText(str) {
    if (!(await isAvailable())) return null;
    try {
        const { tok, txt } = _parts;
        const inputs = await tok([String(str || 'untitled')], { padding: true, truncation: true });
        const out = await txt(inputs);
        const vec = out.text_embeds.data;
        if (vec.length !== 512) return null;
        return _l2(vec);
    } catch (_) { return null; }
}

// ── Pure MMR helpers (dep-free, unit-testable) ──────────────────────────────
function cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s; // inputs are pre-normalised
}

/** Fused similarity: 0.7 visual + 0.3 tag (falls back to whichever vec exists). */
function fusedSim(a, b) {
    const v = (a._clipVisualVec && b._clipVisualVec) ? cosine(a._clipVisualVec, b._clipVisualVec) : null;
    const t = (a._clipTagVec && b._clipTagVec) ? cosine(a._clipTagVec, b._clipTagVec) : null;
    if (v == null && t == null) return null;
    if (v == null) return t;
    if (t == null) return v;
    return 0.7 * v + 0.3 * t;
}

const _orient = (s) => { const w = Number(s.mediaWidth) || 0, h = Number(s.mediaHeight) || 0; return !w || !h ? 'u' : (w >= h ? 'l' : 'p'); };

/**
 * Bounded adjacent detect-and-swap: when two neighbours are near-duplicates
 * (fusedSim ≥ simMax), find a nearby (≤window) scene that is dissimilar to BOTH
 * neighbours, same mediaType + orientation, and whose move creates no new
 * collision. Returns [{i, j}] index pairs to swap (media fields only).
 */
function planAdjacentSwaps(scenes, { simMax = 0.92, window = 3 } = {}) {
    const swaps = [];
    const n = scenes.length;
    for (let i = 1; i < n; i++) {
        const a = scenes[i - 1], b = scenes[i];
        const sim = fusedSim(a, b);
        if (sim == null || sim < simMax) continue;
        for (let j = i + 1; j <= Math.min(n - 1, i + window); j++) {
            const cand = scenes[j];
            if (cand.mediaType !== b.mediaType || _orient(cand) !== _orient(b)) continue;
            const sPrev = fusedSim(a, cand);
            if (sPrev != null && sPrev >= simMax) continue;              // still dup vs i-1
            const sNext = (j + 1 < n) ? fusedSim(cand, scenes[j + 1]) : null; // don't just move the dup down
            const bAtJ = (j + 1 < n) ? fusedSim(b, scenes[j + 1]) : null;
            if ((sNext != null && sNext >= simMax) || (bAtJ != null && bAtJ >= simMax)) continue;
            swaps.push({ i, j });
            break;
        }
    }
    return swaps;
}

module.exports = { isAvailable, embedImageBase64List, embedText, cosine, fusedSim, planAdjacentSwaps };
