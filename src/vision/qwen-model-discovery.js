const axios = require('axios');
const fs = require('fs');
const path = require('path');

const APP_ROOT = path.join(__dirname, '..', '..');
const ENV_PATH = path.join(APP_ROOT, '.env');
const DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1';
const DEFAULT_REGISTRY_PATH = process.env.QWEN_MODEL_REGISTRY_PATH || path.join(__dirname, '..', 'qwen-vision-generated-pools.json');

// Tiny valid PNG. The probe is intentionally trivial: support detection, not scoring quality.
const PROBE_IMAGE_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAADUlEQVR42mNk+M9QDwADhgF/6hKVngAAAABJRU5ErkJggg==';

function parseEnvList(raw) {
    return String(raw || '')
        .split(/[,\n;]/)
        .map(v => v.trim())
        .filter(Boolean);
}

function parseSimpleEnv(content) {
    const out = {};
    for (const line of String(content || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx <= 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        out[key] = value;
    }
    return out;
}

function readEnv() {
    let fileEnv = {};
    try {
        if (fs.existsSync(ENV_PATH)) fileEnv = parseSimpleEnv(fs.readFileSync(ENV_PATH, 'utf8'));
    } catch (_) {}
    return { ...process.env, ...fileEnv };
}

function unique(values) {
    return [...new Set((values || []).map(v => String(v || '').trim()).filter(Boolean))];
}

function getQwenKeys(env = readEnv()) {
    const shared = parseEnvList(env.QWEN_VISION_API_KEY);
    const image = parseEnvList(env.QWEN_IMAGE_API_KEY || env.QWEN_VL_API_KEY).length
        ? parseEnvList(env.QWEN_IMAGE_API_KEY || env.QWEN_VL_API_KEY)
        : shared;
    const omni = parseEnvList(env.QWEN_OMNI_API_KEY).length
        ? parseEnvList(env.QWEN_OMNI_API_KEY)
        : shared;
    return {
        shared: unique(shared),
        image: unique(image),
        omni: unique(omni),
    };
}

function modelIdOf(item) {
    if (typeof item === 'string') return item;
    return item?.id || item?.model || item?.name || item?.model_id || item?.modelName || '';
}

function extractModelIds(payload) {
    const roots = [
        payload?.data,
        payload?.models,
        payload?.Data?.Models,
        payload?.body?.data,
        payload,
    ];
    for (const root of roots) {
        if (Array.isArray(root)) {
            return unique(root.map(modelIdOf)).filter(Boolean);
        }
    }
    return [];
}

async function fetchDashScopeCatalog({ baseUrl = DEFAULT_BASE_URL, apiKey, timeoutMs = 15000 } = {}) {
    if (!apiKey) throw new Error('No Qwen key available for catalog discovery');
    const endpoint = `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/models`;
    const response = await axios.get(endpoint, {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: timeoutMs,
    });
    const models = extractModelIds(response.data);
    if (!models.length) {
        throw new Error('DashScope /models returned no model ids');
    }
    return { endpoint, models };
}

function isRejectedFamily(model) {
    const m = String(model || '').toLowerCase();
    return !m
        || m.includes('coder')
        || m.includes('mt-')
        || m.includes('-mt-')
        || m.startsWith('deepseek')
        || m.startsWith('glm-')
        || m.startsWith('wan')
        || m.includes('character');
}

function classifyQwenVisionCandidate(model) {
    const m = String(model || '').trim().toLowerCase();
    if (!m || isRejectedFamily(m)) return '';
    if (m.includes('omni') && m.includes('realtime')) return 'omniRealtime';
    if (m.includes('omni')) return 'omniHttp';
    if (m.startsWith('qwen3-vl-') || m.startsWith('qwen-vl-') || m.startsWith('qvq')) return 'image';
    if (/^qwen3\.(5|6|7)-/.test(m)) return 'image';
    return '';
}

function rankModel(model, lane) {
    const m = String(model || '').toLowerCase();
    let score = 10_000;
    if (lane === 'omniRealtime') score -= 2000;
    if (lane === 'omniHttp') score -= 1800;
    if (m.includes('235b')) score -= 1700;
    if (m.includes('qvq')) score -= 1650;
    if (m.includes('vl-plus')) score -= 1500;
    if (m.includes('vl-max')) score -= 1450;
    if (m.includes('qwen3.7')) score -= 1300;
    if (m.includes('qwen3.6')) score -= 1200;
    if (m.includes('qwen3.5')) score -= 1100;
    if (m.includes('plus')) score -= 250;
    if (m.includes('max')) score -= 240;
    if (m.includes('30b')) score -= 180;
    if (m.includes('8b')) score += 150;
    if (m.includes('flash')) score += 250;
    if (m.includes('ocr')) score += 500;
    if (m.includes('latest')) score -= 20;
    const date = m.match(/20\d{2}-\d{2}-\d{2}/)?.[0] || '';
    if (date) score -= Number(date.replace(/-/g, '').slice(4)) / 100000;
    return score;
}

function sortModels(models, lane) {
    return unique(models).sort((a, b) => {
        const diff = rankModel(a, lane) - rankModel(b, lane);
        return diff || String(a).localeCompare(String(b));
    });
}

function classifyCatalog(models) {
    const pools = { image: [], omniHttp: [], omniRealtime: [] };
    const rejected = [];
    for (const model of unique(models)) {
        const lane = classifyQwenVisionCandidate(model);
        if (!lane) {
            rejected.push({ model, reason: 'not-vision-family' });
            continue;
        }
        pools[lane].push(model);
    }
    pools.image = sortModels(pools.image, 'image');
    pools.omniHttp = sortModels(pools.omniHttp, 'omniHttp');
    pools.omniRealtime = sortModels(pools.omniRealtime, 'omniRealtime');
    return { pools, rejected };
}

function summarizeError(err) {
    const status = err?.response?.status;
    const data = err?.response?.data;
    const detail = typeof data === 'string' ? data : JSON.stringify(data || {});
    return `${status || err?.code || 'ERR'} ${String(detail || err?.message || '').slice(0, 220)}`.trim();
}

function isUnsupportedProbeError(err) {
    const status = err?.response?.status;
    const msg = summarizeError(err).toLowerCase();
    if (status === 404 || status === 410) return true;
    return /unsupported|does not support|not support|model not found|model.*not.*exist|invalid model|access_denied|no permission|not authorized/.test(msg)
        && !/quota|rate|throttl|too many|exhaust/.test(msg);
}

function isKeepableProbeError(err) {
    const msg = summarizeError(err).toLowerCase();
    return /quota|rate|throttl|too many|exhaust|timeout|timed out|econn|network/.test(msg);
}

async function probeVisionModel({ model, lane, apiKey, baseUrl, timeoutMs }) {
    if (lane === 'omniRealtime') {
        return { model, lane, status: 'candidate', keep: true, reason: 'websocket-runtime-probed' };
    }
    const body = {
        model,
        messages: [{
            role: 'user',
            content: [
                { type: 'text', text: 'Return exactly OK if you can inspect this image.' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${PROBE_IMAGE_BASE64}` } },
            ],
        }],
        max_tokens: 10,
    };
    if (String(model).toLowerCase().startsWith('qvq')) body.stream = true;

    try {
        const response = await axios.post(`${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`, body, {
            headers: {
                Authorization: `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            timeout: timeoutMs,
            responseType: body.stream ? 'text' : 'json',
        });
        const text = body.stream
            ? String(response.data || '')
            : String(response.data?.choices?.[0]?.message?.content || '');
        return { model, lane, status: text ? 'ok' : 'empty-ok', keep: true };
    } catch (err) {
        if (isUnsupportedProbeError(err)) {
            return { model, lane, status: 'unsupported', keep: false, reason: summarizeError(err) };
        }
        if (isKeepableProbeError(err)) {
            return { model, lane, status: 'transient-or-quota', keep: true, reason: summarizeError(err) };
        }
        return { model, lane, status: 'error-kept', keep: true, reason: summarizeError(err) };
    }
}

async function runLimited(tasks, concurrency) {
    const results = [];
    let next = 0;
    const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
        while (next < tasks.length) {
            const task = tasks[next++];
            results.push(await task());
        }
    });
    await Promise.all(workers);
    return results;
}

function registryFresh(file, intervalHours) {
    try {
        if (!fs.existsSync(file)) return false;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        const generatedAt = Date.parse(parsed.generatedAt || '');
        return Number.isFinite(generatedAt) && Date.now() - generatedAt < intervalHours * 3600_000;
    } catch (_) {
        return false;
    }
}

async function syncQwenVisionModelRegistry(options = {}) {
    const env = readEnv();
    const registryPath = options.registryPath || env.QWEN_MODEL_REGISTRY_PATH || DEFAULT_REGISTRY_PATH;
    const intervalHours = Math.max(1, Number(options.intervalHours || env.QWEN_MODEL_SYNC_INTERVAL_HOURS || 24) || 24);
    if (options.skipFresh !== false && !options.force && registryFresh(registryPath, intervalHours)) {
        const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        return { skipped: true, reason: 'fresh', registryPath, generatedAt: parsed.generatedAt, pools: parsed.pools || {} };
    }

    const baseUrl = options.baseUrl || env.QWEN_BASE_URL || DEFAULT_BASE_URL;
    const keys = getQwenKeys(env);
    const catalogKey = keys.image[0] || keys.omni[0] || keys.shared[0];
    const catalog = await fetchDashScopeCatalog({
        baseUrl,
        apiKey: catalogKey,
        timeoutMs: Number(options.catalogTimeoutMs || env.QWEN_MODEL_SYNC_CATALOG_TIMEOUT_MS || 15000) || 15000,
    });
    const classified = classifyCatalog(catalog.models);
    const probe = options.probe !== undefined
        ? Boolean(options.probe)
        : !['0', 'false', 'off', 'no'].includes(String(env.QWEN_MODEL_SYNC_PROBE || '1').toLowerCase());
    const timeoutMs = Math.max(3000, Number(options.timeoutMs || env.QWEN_MODEL_SYNC_PROBE_TIMEOUT_MS || 12000) || 12000);
    const concurrency = Math.max(1, Math.min(12, Number(options.concurrency || env.QWEN_MODEL_SYNC_CONCURRENCY || 4) || 4));
    const probeResults = [];

    let pools = {
        image: classified.pools.image.slice(),
        omniHttp: classified.pools.omniHttp.slice(),
        omniRealtime: classified.pools.omniRealtime.slice(),
    };

    if (probe) {
        const tasks = [];
        const imageKey = keys.image[0] || catalogKey;
        const omniKey = keys.omni[0] || catalogKey;
        for (const model of pools.image) tasks.push(() => probeVisionModel({ model, lane: 'image', apiKey: imageKey, baseUrl, timeoutMs }));
        for (const model of pools.omniHttp) tasks.push(() => probeVisionModel({ model, lane: 'omniHttp', apiKey: omniKey, baseUrl, timeoutMs }));
        probeResults.push(...await runLimited(tasks, concurrency));
        const keep = new Map(probeResults.map(r => [`${r.lane}:${r.model}`, r]));
        pools.image = pools.image.filter(model => keep.get(`image:${model}`)?.keep !== false);
        pools.omniHttp = pools.omniHttp.filter(model => keep.get(`omniHttp:${model}`)?.keep !== false);
    }

    pools.image = sortModels(pools.image, 'image');
    pools.omniHttp = sortModels(pools.omniHttp, 'omniHttp');
    pools.omniRealtime = sortModels(pools.omniRealtime, 'omniRealtime');
    if (!pools.image.length && !pools.omniHttp.length && !pools.omniRealtime.length) {
        throw new Error('Discovery produced an empty Qwen vision registry; keeping existing runtime pools');
    }

    const rejected = [
        ...classified.rejected,
        ...probeResults.filter(r => r.keep === false).map(r => ({ model: r.model, lane: r.lane, reason: r.status, detail: r.reason || '' })),
    ];
    const registry = {
        version: 1,
        generatedAt: new Date().toISOString(),
        source: {
            endpoint: catalog.endpoint,
            catalog: 'dashscope-openai-compatible-models',
            probed: probe,
            probeConcurrency: probe ? concurrency : 0,
        },
        catalogCount: catalog.models.length,
        pools,
        counts: {
            image: pools.image.length,
            omniHttp: pools.omniHttp.length,
            omniRealtime: pools.omniRealtime.length,
            rejected: rejected.length,
        },
        rejected,
        probeResults,
    };

    if (!options.dryRun) {
        fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
    }
    return { skipped: false, registryPath, registry };
}

module.exports = {
    classifyQwenVisionCandidate,
    classifyCatalog,
    fetchDashScopeCatalog,
    syncQwenVisionModelRegistry,
};
