'use strict';

const dns = require('dns').promises;
const fs = require('fs');
const net = require('net');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');
const axios = require('axios');

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

function _blockedIpv4(address) {
    const octets = address.split('.').map(Number);
    if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
        return true;
    }
    const [a, b, c] = octets;
    return a === 0
        || a === 10
        || a === 127
        || (a === 100 && b >= 64 && b <= 127)
        || (a === 169 && b === 254)
        || (a === 172 && b >= 16 && b <= 31)
        || (a === 192 && b === 0 && c === 0)
        || (a === 192 && b === 0 && c === 2)
        || (a === 192 && b === 168)
        || (a === 198 && (b === 18 || b === 19))
        || (a === 198 && b === 51 && c === 100)
        || (a === 203 && b === 0 && c === 113)
        || a >= 224;
}

function _blockedIpv6(address) {
    const normalized = address.toLowerCase().split('%')[0];
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith('ff')) return true;
    if (normalized.startsWith('2001:db8:')) return true;
    const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? _blockedIpv4(mapped[1]) : false;
}

function isPublicAddress(address) {
    const family = net.isIP(address);
    if (family === 4) return !_blockedIpv4(address);
    if (family === 6) return !_blockedIpv6(address);
    return false;
}

async function resolvePublicUrl(rawUrl) {
    const url = new URL(String(rawUrl || ''));
    if (!new Set(['http:', 'https:']).has(url.protocol)) {
        throw new Error(`Blocked download protocol: ${url.protocol || '(none)'}`);
    }
    if (url.username || url.password) throw new Error('Download URLs may not contain credentials');
    const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
    if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) {
        throw new Error('Blocked local download hostname');
    }

    let addresses;
    if (net.isIP(hostname)) {
        addresses = [{ address: hostname, family: net.isIP(hostname) }];
    } else {
        addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    }
    if (!addresses.length || addresses.some((entry) => !isPublicAddress(entry.address))) {
        throw new Error(`Blocked private or reserved download address for ${hostname}`);
    }
    return { url, addresses };
}

function _pinnedLookup(addresses) {
    return (_hostname, options, callback) => {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        const requestedFamily = Number(options?.family) || 0;
        const candidates = requestedFamily
            ? addresses.filter((entry) => entry.family === requestedFamily)
            : addresses;
        const selected = candidates[0] || addresses[0];
        if (options?.all) {
            callback(null, candidates.length ? candidates : addresses);
        } else {
            callback(null, selected.address, selected.family);
        }
    };
}

async function requestSafeStream(rawUrl, axiosOptions = {}, policy = {}) {
    const maxRedirects = Math.max(0, Math.min(10, Number(policy.maxRedirects ?? 5) || 0));
    const maxBytes = Math.max(1, Number(policy.maxBytes || 512 * 1024 * 1024));
    let currentUrl = String(rawUrl || '');

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
        const resolved = await resolvePublicUrl(currentUrl);
        const response = await axios({
            ...axiosOptions,
            url: resolved.url.href,
            method: axiosOptions.method || 'GET',
            responseType: 'stream',
            maxRedirects: 0,
            proxy: false,
            lookup: _pinnedLookup(resolved.addresses),
            validateStatus: (status) => status >= 200 && status < 400,
        });

        if (REDIRECT_STATUSES.has(response.status) && response.headers.location) {
            response.data.destroy();
            if (redirectCount >= maxRedirects) throw new Error('Too many media redirects');
            currentUrl = new URL(response.headers.location, resolved.url).href;
            continue;
        }

        const contentLength = Number(response.headers['content-length'] || 0);
        if (Number.isFinite(contentLength) && contentLength > maxBytes) {
            response.data.destroy();
            throw new Error(`Media download exceeds ${Math.ceil(maxBytes / (1024 * 1024))} MB limit`);
        }
        response.safeDownload = {
            finalUrl: resolved.url.href,
            maxBytes,
        };
        return response;
    }
    throw new Error('Too many media redirects');
}

async function requestSafeBuffer(rawUrl, axiosOptions = {}, policy = {}) {
    const maxRedirects = Math.max(0, Math.min(10, Number(policy.maxRedirects ?? 5) || 0));
    const maxBytes = Math.max(1, Number(policy.maxBytes || 80 * 1024 * 1024));
    let currentUrl = String(rawUrl || '');

    for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
        const resolved = await resolvePublicUrl(currentUrl);
        const response = await axios({
            ...axiosOptions,
            url: resolved.url.href,
            method: axiosOptions.method || 'GET',
            responseType: 'arraybuffer',
            maxContentLength: maxBytes,
            maxBodyLength: maxBytes,
            maxRedirects: 0,
            proxy: false,
            lookup: _pinnedLookup(resolved.addresses),
            validateStatus: (status) => status >= 200 && status < 400,
        });
        if (REDIRECT_STATUSES.has(response.status) && response.headers.location) {
            if (redirectCount >= maxRedirects) throw new Error('Too many media redirects');
            currentUrl = new URL(response.headers.location, resolved.url).href;
            continue;
        }
        if (response.data?.byteLength > maxBytes) {
            throw new Error(`Media response exceeds ${Math.ceil(maxBytes / (1024 * 1024))} MB limit`);
        }
        return response;
    }
    throw new Error('Too many media redirects');
}

function createByteLimitTransform(maxBytes) {
    let received = 0;
    return new Transform({
        transform(chunk, _encoding, callback) {
            received += chunk.length;
            if (received > maxBytes) {
                callback(new Error(`Media stream exceeded ${Math.ceil(maxBytes / (1024 * 1024))} MB limit`));
                return;
            }
            callback(null, chunk);
        },
    });
}

async function writeSafeStreamToFile(response, outputPath, options = {}) {
    const maxBytes = Math.max(1, Number(options.maxBytes || response?.safeDownload?.maxBytes || 512 * 1024 * 1024));
    const resolvedOutput = path.resolve(outputPath);
    fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
    const writer = fs.createWriteStream(resolvedOutput, { flags: 'wx' });
    try {
        await pipeline(response.data, createByteLimitTransform(maxBytes), writer);
    } catch (error) {
        try { fs.unlinkSync(resolvedOutput); } catch (_) { }
        throw error;
    }
    return resolvedOutput;
}

module.exports = {
    createByteLimitTransform,
    isPublicAddress,
    requestSafeBuffer,
    requestSafeStream,
    resolvePublicUrl,
    writeSafeStreamToFile,
};
