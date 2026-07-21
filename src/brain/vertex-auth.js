/**
 * Vertex AI Authentication & Helpers
 *
 * Two auth modes:
 *   1. API Key (simple): Get key from Vertex AI Studio → set GEMINI_API_KEY
 *      Uses ?key= parameter on Vertex endpoints. No service account needed.
 *   2. Service Account (advanced): Download JSON key → set GOOGLE_APPLICATION_CREDENTIALS
 *      Uses OAuth2 Bearer token. Required for GCS uploads (large video files).
 *
 * Setup (API Key — recommended):
 *   1. Go to Vertex AI Studio → Settings → API Keys → Create API Key
 *   2. Set in .env:
 *        GEMINI_USE_VERTEX=true
 *        VERTEX_PROJECT_ID=your-project-id
 *        VERTEX_LOCATION=us-central1
 *        GEMINI_API_KEY=AQ.your-vertex-api-key
 *
 * Setup (Service Account — for GCS uploads):
 *   1. IAM → Service Accounts → Create → Grant "Vertex AI User" + "Storage Object Admin"
 *   2. Create & download JSON key
 *   3. Set GOOGLE_APPLICATION_CREDENTIALS=C:\path\to\key.json in .env
 */

'use strict';

const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const axios  = require('axios');
const config = require('../settings/config');

// ============ STATE ============

let _serviceAccount = null;   // parsed JSON key (service account mode only)
let _cachedToken    = null;   // { access_token, expiry }
let _bucketVerified = false;  // true once we confirmed the GCS bucket exists

// ============ REGION ROTATION ============
//
// VERTEX_LOCATION can be a single region OR a comma-separated fallback list.
// On 429/503, callers call markRegionThrottled() to move the current region
// into cooldown; getLocation() then returns the next healthy region.
//
// Example: VERTEX_LOCATION=global,us-east5,us-east4,us-east1
//   → primary 'global', falls back through the list on throttle/outage.

let _regionIdx         = 0;                     // pointer into _regions
let _regionCooldowns   = new Map();             // region → cooldownUntilMs
const COOLDOWN_MS      = 60_000;                // 1min default cooldown
const COOLDOWN_MAX_MS  = 600_000;               // 10min max exponential cap

function _getRegions() {
    const raw = config.gemini?.vertexLocation || 'us-central1';
    // Support array or CSV string. Trim + dedupe + lowercase.
    const arr = Array.isArray(raw) ? raw : String(raw).split(',');
    const cleaned = arr.map(s => String(s || '').trim().toLowerCase()).filter(Boolean);
    return cleaned.length > 0 ? Array.from(new Set(cleaned)) : ['us-central1'];
}

function _isRegionCool(region) {
    const until = _regionCooldowns.get(region) || 0;
    return until <= Date.now();
}

/**
 * Return the currently active region, advancing past any cooling regions.
 * If ALL regions are cooling, returns the one with the soonest expiry.
 */
function getLocation() {
    const regions = _getRegions();
    if (regions.length === 1) return regions[0];

    // Clamp pointer
    if (_regionIdx < 0 || _regionIdx >= regions.length) _regionIdx = 0;

    // Scan for a healthy region, starting from current pointer.
    for (let i = 0; i < regions.length; i++) {
        const idx = (_regionIdx + i) % regions.length;
        const r = regions[idx];
        if (_isRegionCool(r)) {
            if (idx !== _regionIdx) _regionIdx = idx;
            return r;
        }
    }

    // All cooling — pick the one that expires soonest and use it anyway.
    let soonest = regions[0];
    let soonestAt = _regionCooldowns.get(soonest) || 0;
    for (const r of regions) {
        const t = _regionCooldowns.get(r) || 0;
        if (t < soonestAt) { soonest = r; soonestAt = t; }
    }
    return soonest;
}

function getAllRegions() {
    return _getRegions().slice();
}

function getRegionCount() {
    return _getRegions().length;
}

/**
 * Pick a region suitable for creating cachedContents. The `global` endpoint
 * load-balances to different regional backends — a cache created via one
 * call can land on a different backend than the follow-up generateContent,
 * which makes the cache unfindable (400/404 on reference). Returns the first
 * non-`global` healthy region, or null if only `global` is configured.
 */
function getCacheableLocation() {
    const regions = _getRegions().filter(r => r !== 'global');
    if (regions.length === 0) return null;
    // Prefer the first healthy non-global region, honoring cooldowns.
    for (const r of regions) {
        if (_isRegionCool(r)) return r;
    }
    // All cooling — pick the one expiring soonest.
    let soonest = regions[0];
    let soonestAt = _regionCooldowns.get(soonest) || 0;
    for (const r of regions) {
        const t = _regionCooldowns.get(r) || 0;
        if (t < soonestAt) { soonest = r; soonestAt = t; }
    }
    return soonest;
}

/**
 * Mark a region as throttled and rotate to the next healthy one.
 * retryAfterMs — optional hint from server (Retry-After / retryDelay); clamped.
 * Returns true if a different healthy region was selected, false if none available.
 */
function markRegionThrottled(region, retryAfterMs) {
    const regions = _getRegions();
    if (regions.length <= 1) return false;

    const norm = String(region || '').trim().toLowerCase();
    // Exponential: if already cooling, extend it.
    const prevUntil = _regionCooldowns.get(norm) || 0;
    const prevRemaining = Math.max(0, prevUntil - Date.now());
    let coolMs = retryAfterMs && retryAfterMs > 0
        ? Math.min(Math.max(retryAfterMs, COOLDOWN_MS), COOLDOWN_MAX_MS)
        : Math.min(Math.max(prevRemaining * 2 || COOLDOWN_MS, COOLDOWN_MS), COOLDOWN_MAX_MS);

    _regionCooldowns.set(norm, Date.now() + coolMs);

    // Advance pointer if the throttled region is the current one.
    const currentIdx = regions.indexOf(norm);
    if (currentIdx === _regionIdx) {
        for (let i = 1; i <= regions.length; i++) {
            const idx = (_regionIdx + i) % regions.length;
            if (_isRegionCool(regions[idx])) {
                _regionIdx = idx;
                console.log(`  🌐 [Vertex] Region ${norm} throttled (cool ${Math.round(coolMs/1000)}s) → rotating to ${regions[idx]}`);
                return true;
            }
        }
        console.log(`  ⚠️ [Vertex] All ${regions.length} regions throttled — next call will use soonest-available region`);
        return false;
    }

    // Region wasn't current (probably already rotated past it) — just record cooldown.
    return true;
}

function getRegionCooldownStatus() {
    const now = Date.now();
    const out = {};
    for (const r of _getRegions()) {
        const until = _regionCooldowns.get(r) || 0;
        out[r] = until > now ? Math.ceil((until - now) / 1000) : 0;
    }
    return out;
}

function isVertexEnabled() {
    return config.gemini?.useVertex === true;
}

function getProjectId() {
    return config.gemini?.vertexProject || '';
}

/**
 * Check if we have a service account configured (for GCS uploads).
 */
function hasServiceAccount() {
    return !!(process.env.GOOGLE_APPLICATION_CREDENTIALS || '').trim();
}

/**
 * Get the Vertex AI API key from the Gemini key config.
 */
function _getApiKey() {
    const keys = config.gemini?.apiKeys || [];
    return keys[0] || config.gemini?.apiKey || '';
}

/**
 * Build the Vertex AI generateContent endpoint URL for a given model.
 * If forcedLoc is provided, that region is used (bypasses rotation) — needed
 * when calling generateContent with a cachedContent handle, since caches are
 * regionally bound and must be accessed from the region they were created in.
 */
function getVertexEndpoint(model, action = 'generateContent', forcedLoc = null) {
    const loc = forcedLoc || getLocation();
    const proj = getProjectId();
    const host = loc === 'global'
        ? 'https://aiplatform.googleapis.com'
        : `https://${loc}-aiplatform.googleapis.com`;
    return `${host}/v1/projects/${proj}/locations/${loc}/publishers/google/models/${model}:${action}`;
}

/**
 * Get the full URL + headers for a Vertex AI native API call.
 * API Key mode: appends ?key= to URL
 * Service Account mode: uses Bearer token header
 * forcedLoc: optional — pin the call to a specific region (used when a
 * regional cachedContent handle is attached).
 */
async function getVertexAuth(model, action = 'generateContent', forcedLoc = null) {
    const region = forcedLoc || getLocation();
    const baseUrl = getVertexEndpoint(model, action, region);

    if (hasServiceAccount()) {
        const token = await getAccessToken();
        return {
            url: baseUrl,
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            region,
        };
    }

    // API Key mode — simpler, no service account needed
    const apiKey = _getApiKey();
    if (!apiKey) throw new Error('[Vertex] No API key configured (set GEMINI_API_KEY in .env)');

    return {
        url: `${baseUrl}?key=${apiKey}`,
        headers: { 'Content-Type': 'application/json' },
        region,
    };
}

// ============ SERVICE ACCOUNT LOADING ============

function _loadServiceAccount() {
    if (_serviceAccount) return _serviceAccount;

    const credPath = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
    if (!credPath) {
        throw new Error('[Vertex] GOOGLE_APPLICATION_CREDENTIALS not set');
    }

    const resolved = path.isAbsolute(credPath) ? credPath : path.resolve(credPath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`[Vertex] Service account file not found: ${resolved}`);
    }

    try {
        _serviceAccount = JSON.parse(fs.readFileSync(resolved, 'utf8'));
    } catch (e) {
        throw new Error(`[Vertex] Failed to parse service account JSON: ${e.message}`);
    }

    if (!_serviceAccount.client_email || !_serviceAccount.private_key) {
        throw new Error('[Vertex] Service account JSON missing client_email or private_key');
    }

    return _serviceAccount;
}

// ============ JWT + ACCESS TOKEN (service account mode only) ============

function _createJWT(sa) {
    const now = Math.floor(Date.now() / 1000);

    const header = Buffer.from(JSON.stringify({
        alg: 'RS256',
        typ: 'JWT',
    })).toString('base64url');

    const payload = Buffer.from(JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/cloud-platform',
        aud: sa.token_uri || 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
    })).toString('base64url');

    const signInput = `${header}.${payload}`;
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signInput);
    const signature = sign.sign(sa.private_key, 'base64url');

    return `${signInput}.${signature}`;
}

/**
 * Exchange JWT for an OAuth2 access token (service account mode only).
 * Caches the token and refreshes 5 minutes before expiry.
 */
async function getAccessToken() {
    if (_cachedToken && _cachedToken.expiry > Date.now() + 300_000) {
        return _cachedToken.access_token;
    }

    const sa = _loadServiceAccount();
    const jwt = _createJWT(sa);
    const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';

    const resp = await axios.post(tokenUri, new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
    }).toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000,
    });

    if (!resp.data?.access_token) {
        throw new Error('[Vertex] Token exchange failed — no access_token in response');
    }

    _cachedToken = {
        access_token: resp.data.access_token,
        expiry: Date.now() + (resp.data.expires_in || 3600) * 1000,
    };

    return _cachedToken.access_token;
}

// ============ GCS HELPERS (requires service account) ============

const GCS_BUCKET_SUFFIX = '-gemini-temp';

function _getBucketName() {
    return `${getProjectId()}${GCS_BUCKET_SUFFIX}`;
}

function _getBucketLocation() {
    const loc = getLocation();
    // Global Gemini endpoints don't imply a valid GCS bucket location. Keep uploads in the
    // same US multi-region bucket choice we already derive for US regional endpoints.
    if (loc === 'global') return 'US';
    return loc.toUpperCase().split('-')[0];
}

async function _ensureBucket() {
    if (_bucketVerified) return;

    const token = await getAccessToken();
    const bucket = _getBucketName();

    try {
        await axios.get(`https://storage.googleapis.com/storage/v1/b/${bucket}`, {
            headers: { Authorization: `Bearer ${token}` },
            timeout: 10000,
        });
        _bucketVerified = true;
    } catch (err) {
        if (err.response?.status === 403) {
            // Storage Object Admin can upload/delete but can't check bucket metadata.
            // Assume the bucket exists (user created it manually) and proceed.
            console.log(`[Vertex] Bucket ${bucket} — 403 on verify (insufficient role for buckets.get). Assuming it exists.`);
            _bucketVerified = true;
        } else if (err.response?.status === 404) {
            console.log(`[Vertex] Creating GCS bucket: ${bucket}`);
            try {
                await axios.post(
                        `https://storage.googleapis.com/storage/v1/b?project=${getProjectId()}`,
                        {
                            name: bucket,
                            location: _getBucketLocation(),
                            storageClass: 'STANDARD',
                            lifecycle: {
                                rule: [{ action: { type: 'Delete' }, condition: { age: 1 } }],
                        },
                    },
                    {
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                        timeout: 15000,
                    }
                );
                _bucketVerified = true;
                console.log(`[Vertex] Bucket created: ${bucket} (auto-deletes files after 1 day)`);
            } catch (createErr) {
                if (createErr.response?.status === 403 || createErr.response?.status === 409) {
                    // 403 = no permission to create, 409 = already exists
                    console.log(`[Vertex] Bucket create returned ${createErr.response.status} — assuming it exists.`);
                    _bucketVerified = true;
                } else {
                    throw createErr;
                }
            }
        } else {
            throw new Error(`[Vertex] Failed to verify GCS bucket: ${err.message}`);
        }
    }
}

async function uploadToGCS(filePath, mimeType) {
    if (!hasServiceAccount()) {
        throw new Error('[Vertex] GCS upload requires a service account (set GOOGLE_APPLICATION_CREDENTIALS)');
    }

    await _ensureBucket();
    const token = await getAccessToken();
    const bucket = _getBucketName();
    const ext = path.extname(filePath).toLowerCase();
    if (!mimeType) {
        const mimeMap = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo' };
        mimeType = mimeMap[ext] || 'application/octet-stream';
    }

    const objectName = `gemini-upload-${Date.now()}-${path.basename(filePath)}`;
    const fileData = fs.readFileSync(filePath);
    const sizeMB = (fileData.length / 1024 / 1024).toFixed(1);

    const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
    console.log(`[Vertex] Uploading ${objectName} (${sizeMB}MB) to gs://${bucket}/...`);
    try {
        await axios.post(uploadUrl, fileData, {
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': mimeType,
                'Content-Length': fileData.length,
            },
            timeout: 300000,
            maxBodyLength: 2 * 1024 * 1024 * 1024,
            maxContentLength: 2 * 1024 * 1024 * 1024,
        });
    } catch (uploadErr) {
        // Don't dump the entire video buffer into the error log
        const status = uploadErr.response?.status || '?';
        const msg = uploadErr.response?.data?.error?.message || uploadErr.response?.statusText || uploadErr.message;
        throw new Error(`[Vertex] GCS upload failed (HTTP ${status}): ${msg}`);
    }

    console.log(`[Vertex] Upload complete: gs://${bucket}/${objectName}`);
    return { gsUri: `gs://${bucket}/${objectName}`, objectName, mimeType };
}

async function deleteFromGCS(objectName) {
    if (!hasServiceAccount()) return; // can't delete without service account
    try {
        const token = await getAccessToken();
        const bucket = _getBucketName();
        await axios.delete(
            `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(objectName)}`,
            { headers: { Authorization: `Bearer ${token}` }, timeout: 10000 }
        );
    } catch (e) {
        console.log(`[Vertex] Could not delete GCS object ${objectName}: ${e.message}`);
    }
}

// ============ CONTEXT CACHING (Vertex) ============
//
// Big reference videos get re-billed as input tokens on every chat turn if we keep
// sending their file_data with `contents`. Vertex `cachedContents` lets us pay the
// video tokens ONCE, store a handle, and reference it on subsequent calls at ~25%
// of the normal rate. A 15-min video = ~270k tokens; a 150-turn session drops from
// ~40M to ~10M input tokens.

function _cachedContentsEndpoint(resourceName = '', forcedLoc = null) {
    // If a resourceName is a full path it already encodes the region — pull
    // the region from it so the host matches. Otherwise use forcedLoc or the
    // current rotating region.
    let loc = forcedLoc || getLocation();
    if (resourceName && resourceName.startsWith('projects/')) {
        const m = resourceName.match(/\/locations\/([^/]+)\//);
        if (m) loc = m[1];
    }
    const proj = getProjectId();
    const host = loc === 'global'
        ? 'https://aiplatform.googleapis.com'
        : `https://${loc}-aiplatform.googleapis.com`;
    const base = `${host}/v1beta1/projects/${proj}/locations/${loc}/cachedContents`;
    // resourceName is the full "projects/.../cachedContents/<id>" returned by create,
    // OR just the bare id. Normalize.
    if (!resourceName) return base;
    if (resourceName.startsWith('projects/')) {
        return `${host}/v1beta1/${resourceName}`;
    }
    return `${base}/${resourceName}`;
}

async function _cachedContentsAuth(resourceName = '', method = 'POST', forcedLoc = null) {
    const url = _cachedContentsEndpoint(resourceName, forcedLoc);
    if (hasServiceAccount()) {
        const token = await getAccessToken();
        return {
            url,
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        };
    }
    const apiKey = _getApiKey();
    if (!apiKey) throw new Error('[Vertex] No API key configured (set GEMINI_API_KEY in .env)');
    return {
        url: `${url}?key=${apiKey}`,
        headers: { 'Content-Type': 'application/json' },
    };
}

/**
 * Create a context cache for Gemini on Vertex.
 *
 * @param {Object} opts
 * @param {string} opts.model       Bare model id (e.g. 'gemini-3.1-pro-preview').
 * @param {Array}  opts.contents    Array of { role, parts } — the content to cache
 *                                  (typically a user turn with file_data parts).
 * @param {Object} [opts.systemInstruction] Optional {parts:[{text}]}.
 * @param {number} [opts.ttlSeconds=3600] Cache TTL in seconds. Default 1h.
 * @returns {Promise<{name:string, model:string, expireTime:string, tokenCount:number}>}
 */
async function createCache({ model, contents, systemInstruction, tools, ttlSeconds = 3600 }) {
    if (!model) throw new Error('[Vertex] createCache: model required');
    if (!Array.isArray(contents) || contents.length === 0) {
        throw new Error('[Vertex] createCache: contents required');
    }

    // Pin the region. `global` load-balances across backends and breaks cache
    // lookups, so always use a specific regional endpoint for cachedContents.
    const loc = getCacheableLocation();
    if (!loc) {
        throw new Error('[Vertex] createCache: no non-global region configured (set VERTEX_LOCATION to include at least one regional endpoint, e.g., us-east5)');
    }
    const { url, headers } = await _cachedContentsAuth('', 'POST', loc);
    const proj = getProjectId();
    const fullModel = model.startsWith('projects/')
        ? model
        : `projects/${proj}/locations/${loc}/publishers/google/models/${model}`;

    const body = {
        model: fullModel,
        contents,
        ttl: `${Math.max(60, ttlSeconds)}s`,
    };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (Array.isArray(tools) && tools.length > 0) body.tools = tools;

    // Cache ingestion is server-side video tokenization. For long videos at
    // high fps (e.g., 8-min clip at fps=5 ≈ 685k tokens) Vertex can take
    // 3-5 minutes. Budget 10 min so creation actually completes instead of
    // timing out every turn and falling back to per-turn billing.
    const resp = await axios.post(url, body, {
        headers,
        timeout: 600000,
        maxBodyLength: 2 * 1024 * 1024 * 1024,
        maxContentLength: 2 * 1024 * 1024 * 1024,
    });

    const name = resp.data?.name;
    if (!name) throw new Error('[Vertex] createCache: no name in response');
    return {
        name,
        model: resp.data.model || fullModel,
        expireTime: resp.data.expireTime || null,
        tokenCount: resp.data.usageMetadata?.totalTokenCount || 0,
        region: loc,
    };
}

/**
 * Refresh a context cache's TTL. Pass the full resource name returned by createCache.
 */
async function refreshCache(resourceName, ttlSeconds = 3600) {
    if (!resourceName) throw new Error('[Vertex] refreshCache: resourceName required');
    const { url, headers } = await _cachedContentsAuth(resourceName, 'PATCH');
    const patchUrl = url.includes('?')
        ? `${url}&updateMask=ttl`
        : `${url}?updateMask=ttl`;
    const resp = await axios.patch(patchUrl, {
        ttl: `${Math.max(60, ttlSeconds)}s`,
    }, { headers, timeout: 30000 });
    return {
        name: resp.data?.name || resourceName,
        expireTime: resp.data?.expireTime || null,
    };
}

/**
 * Delete a context cache. Best-effort — swallows errors.
 */
async function deleteCache(resourceName) {
    if (!resourceName) return;
    try {
        const { url, headers } = await _cachedContentsAuth(resourceName, 'DELETE');
        await axios.delete(url, { headers, timeout: 15000 });
    } catch (e) {
        // Don't throw — cache may have already expired server-side
    }
}

// ============ EXPORTS ============

module.exports = {
    isVertexEnabled,
    getProjectId,
    getLocation,
    getAllRegions,
    getRegionCount,
    markRegionThrottled,
    getRegionCooldownStatus,
    hasServiceAccount,
    getAccessToken,
    getVertexEndpoint,
    getVertexAuth,
    uploadToGCS,
    deleteFromGCS,
    createCache,
    refreshCache,
    deleteCache,
};
