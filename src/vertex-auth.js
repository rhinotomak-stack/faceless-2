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
const config = require('./config');

// ============ STATE ============

let _serviceAccount = null;   // parsed JSON key (service account mode only)
let _cachedToken    = null;   // { access_token, expiry }
let _bucketVerified = false;  // true once we confirmed the GCS bucket exists

// ============ CONFIG HELPERS ============

function isVertexEnabled() {
    return config.gemini?.useVertex === true;
}

function getProjectId() {
    return config.gemini?.vertexProject || '';
}

function getLocation() {
    return config.gemini?.vertexLocation || 'us-central1';
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
 */
function getVertexEndpoint(model, action = 'generateContent') {
    const loc = getLocation();
    const proj = getProjectId();
    return `https://${loc}-aiplatform.googleapis.com/v1/projects/${proj}/locations/${loc}/publishers/google/models/${model}:${action}`;
}

/**
 * Get the full URL + headers for a Vertex AI native API call.
 * API Key mode: appends ?key= to URL
 * Service Account mode: uses Bearer token header
 */
async function getVertexAuth(model, action = 'generateContent') {
    const baseUrl = getVertexEndpoint(model, action);

    if (hasServiceAccount()) {
        const token = await getAccessToken();
        return {
            url: baseUrl,
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        };
    }

    // API Key mode — simpler, no service account needed
    const apiKey = _getApiKey();
    if (!apiKey) throw new Error('[Vertex] No API key configured (set GEMINI_API_KEY in .env)');

    return {
        url: `${baseUrl}?key=${apiKey}`,
        headers: { 'Content-Type': 'application/json' },
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
        if (err.response?.status === 404) {
            console.log(`[Vertex] Creating GCS bucket: ${bucket}`);
            await axios.post(
                `https://storage.googleapis.com/storage/v1/b?project=${getProjectId()}`,
                {
                    name: bucket,
                    location: getLocation().toUpperCase().split('-')[0],
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

    const uploadUrl = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
    await axios.post(uploadUrl, fileData, {
        headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': mimeType,
            'Content-Length': fileData.length,
        },
        timeout: 300000,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
    });

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

// ============ EXPORTS ============

module.exports = {
    isVertexEnabled,
    getProjectId,
    getLocation,
    hasServiceAccount,
    getAccessToken,
    getVertexEndpoint,
    getVertexAuth,
    uploadToGCS,
    deleteFromGCS,
};
