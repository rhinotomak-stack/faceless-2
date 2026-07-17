/**
 * vision-box.js — start/stop the self-hosted vision GPU box (AWS EC2) on demand.
 *
 * Used so a per-scene Retry can wake the box, run, and stop it again — no idle billing.
 * Reuses the Bedrock IAM credentials (config.bedrock.*) — that IAM user just needs
 * ec2:StartInstances / StopInstances / DescribeInstances added. Instance id from
 * VISION_BOX_INSTANCE_ID; readiness is probed against QWEN_BASE_URL (the vLLM endpoint).
 *
 * All functions are no-ops (return { ok:false, reason }) when not configured, so the app
 * degrades gracefully — the user can still run the box manually.
 */

'use strict';

const axios = require('axios');
const config = require('../settings/config');

let _EC2 = null;
function _ec2lib() {
    if (!_EC2) _EC2 = require('@aws-sdk/client-ec2');
    return _EC2;
}

function _instanceId() {
    return (process.env.VISION_BOX_INSTANCE_ID || '').trim();
}
function _region() {
    return process.env.VISION_BOX_REGION || config.bedrock?.region || 'us-east-1';
}
function _creds() {
    const accessKeyId = process.env.VISION_BOX_ACCESS_KEY_ID || config.bedrock?.accessKeyId || '';
    const secretAccessKey = process.env.VISION_BOX_SECRET_ACCESS_KEY || config.bedrock?.secretAccessKey || '';
    return accessKeyId && secretAccessKey ? { accessKeyId, secretAccessKey } : null;
}
function _visionUrl() {
    return String(process.env.QWEN_BASE_URL || config.qwen?.baseUrl || '').replace(/\/+$/, '');
}
function isConfigured() {
    // EC2 start/stop only applies to the self-hosted AWS box. On Lightning (serverless) or
    // Bedrock there's no EC2 instance to control.
    if (String(process.env.VISION_BACKEND || 'aws').toLowerCase() !== 'aws') return false;
    return !!(_instanceId() && _creds() && _visionUrl());
}
function _client() {
    const { EC2Client } = _ec2lib();
    return new EC2Client({ region: _region(), credentials: _creds() });
}
const _sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Is the vLLM endpoint answering right now? (independent of EC2 state) */
async function isVisionReady(timeoutMs = 4000) {
    const url = _visionUrl();
    if (!url) return false;
    try {
        // Force Node.js http adapter (not the renderer's XHR) so neither CSP nor CORS
        // can block the probe to the plain-http vLLM endpoint.
        const res = await axios.get(`${url}/models`, { timeout: timeoutMs, adapter: 'http' });
        return Array.isArray(res.data?.data) && res.data.data.length > 0;
    } catch (_) {
        return false;
    }
}

/** EC2 instance state: running | stopped | pending | stopping | ... */
async function getInstanceState() {
    if (!_instanceId()) return { ok: false, reason: 'VISION_BOX_INSTANCE_ID not set' };
    if (!_creds()) return { ok: false, reason: 'no AWS credentials (BEDROCK_ACCESS_KEY_ID / VISION_BOX_ACCESS_KEY_ID)' };
    try {
        const { DescribeInstancesCommand } = _ec2lib();
        const r = await _client().send(new DescribeInstancesCommand({ InstanceIds: [_instanceId()] }));
        const state = r.Reservations?.[0]?.Instances?.[0]?.State?.Name || 'unknown';
        return { ok: true, state };
    } catch (err) {
        return { ok: false, reason: err?.message || String(err) };
    }
}

/** Combined status for the UI. */
async function status() {
    const ready = await isVisionReady();
    const inst = await getInstanceState();
    return { configured: isConfigured(), ready, instanceState: inst.ok ? inst.state : 'unknown', reason: inst.reason };
}

/**
 * Ensure the box is up AND the vLLM endpoint answers. Starts the instance if stopped,
 * then polls readiness. Returns { ok, alreadyReady?, waitedMs?, reason? }.
 */
async function ensureReady({ onProgress, maxWaitMs = 300000 } = {}) {
    const log = onProgress || (() => {});
    if (!isConfigured()) return { ok: false, reason: 'vision box auto-control not configured (set VISION_BOX_INSTANCE_ID + EC2 perms on the AWS key)' };

    if (await isVisionReady()) { log('Vision box already ready ✓'); return { ok: true, alreadyReady: true }; }

    const st = await getInstanceState();
    if (!st.ok) return { ok: false, reason: st.reason };
    if (st.state !== 'running' && st.state !== 'pending') {
        log('Starting vision box (~2-3 min to boot + load model)…');
        try {
            const { StartInstancesCommand } = _ec2lib();
            await _client().send(new StartInstancesCommand({ InstanceIds: [_instanceId()] }));
        } catch (err) {
            return { ok: false, reason: `start failed: ${err?.message || err}` };
        }
    } else {
        log('Vision box booting — waiting for the model…');
    }

    const t0 = Date.now();
    while (Date.now() - t0 < maxWaitMs) {
        await _sleep(8000);
        if (await isVisionReady()) {
            log(`Vision box ready ✓ (${Math.round((Date.now() - t0) / 1000)}s)`);
            return { ok: true, waitedMs: Date.now() - t0 };
        }
        log(`Waiting for vision box… ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    return { ok: false, reason: `vision box not ready after ${Math.round(maxWaitMs / 1000)}s` };
}

/** Stop the instance (idempotent). */
async function stop({ onProgress } = {}) {
    const log = onProgress || (() => {});
    if (!_instanceId() || !_creds()) return { ok: false, reason: 'not configured' };
    try {
        const { StopInstancesCommand } = _ec2lib();
        await _client().send(new StopInstancesCommand({ InstanceIds: [_instanceId()] }));
        log('Vision box stopping ✓ (billing stops)');
        return { ok: true };
    } catch (err) {
        return { ok: false, reason: err?.message || String(err) };
    }
}

module.exports = { isConfigured, isVisionReady, getInstanceState, status, ensureReady, stop };
